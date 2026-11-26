import type { PageMessage } from "./protocol.ts";

/**
 * Carries messages between the page layer and the panel. It only moves them:
 * what arrives is unchecked until `parsePageMessage` reads it.
 */
export interface PageTransport {
  send(message: PageMessage): void;
  /** Calls `receive` with each message that arrives; returns a function that stops. */
  listen(receive: (message: unknown) => void): () => void;
  /** Calls `listener` once the transport closes, from either end, such as when an extension port disconnects. */
  onClose(listener: () => void): () => void;
  /** Stops sending and receiving. */
  close(): void;
}

/** The listeners a transport calls once when it closes. */
function closeListeners() {
  const listeners = new Set<() => void>();
  return {
    add(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    run() {
      const all = [...listeners];
      listeners.clear();
      for (const listener of all) listener();
    },
  };
}

/**
 * Two ends in the same document, as when Critiqs is installed: a message is
 * handed straight to the other end's listeners, in the same call, with no
 * copying or serializing.
 */
export function directTransports(): [PageTransport, PageTransport] {
  const listeners: [Set<(message: unknown) => void>, Set<(message: unknown) => void>] = [new Set(), new Set()];
  const closed = { value: false };
  const closing = closeListeners();
  const end = (own: 0 | 1): PageTransport => ({
    send(message) {
      if (closed.value) return;
      for (const receive of [...listeners[own === 0 ? 1 : 0]]) receive(message);
    },
    listen(receive) {
      listeners[own].add(receive);
      return () => listeners[own].delete(receive);
    },
    onClose: closing.add,
    close() {
      if (closed.value) return;
      closed.value = true;
      listeners[0].clear();
      listeners[1].clear();
      closing.run();
    },
  });
  return [end(0), end(1)];
}

/** The parts of a window the postMessage transport uses, so tests can stand in for one. */
export interface WindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/**
 * Talks to another window, such as the prototype in a frame or the page
 * around it, with `postMessage`. Messages go only to `peerOrigin`, and only
 * messages from the `peer` window at exactly that origin are received, so
 * another site in the same tab can neither read nor send Critiqs messages.
 */
export function windowTransport({ self, peer, peerOrigin }: { self: WindowLike; peer: WindowLike; peerOrigin: string }): PageTransport {
  const origin = exactOrigin(peerOrigin);
  let closed = false;
  const stops = new Set<() => void>();
  const closing = closeListeners();
  return {
    send(message) {
      if (!closed) peer.postMessage(message, origin);
    },
    listen(receive) {
      const onMessage = (event: MessageEvent) => {
        if (closed || event.origin !== origin || event.source !== (peer as unknown)) return;
        receive(event.data);
      };
      self.addEventListener("message", onMessage);
      const stop = () => {
        self.removeEventListener("message", onMessage);
        stops.delete(stop);
      };
      stops.add(stop);
      return stop;
    },
    onClose: closing.add,
    close() {
      if (closed) return;
      closed = true;
      for (const stop of [...stops]) stop();
      closing.run();
    },
  };
}

/** An origin such as `https://app.example`, refusing `*` and anything with a path, which would send messages to any site. */
function exactOrigin(value: string): string {
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    // Reported below.
  }
  if (parsed === null || parsed.origin === "null" || parsed.origin !== value) {
    throw new Error(`Critiqs: the page layer's peer origin must be an exact origin such as https://app.example, not ${JSON.stringify(value)}.`);
  }
  return parsed.origin;
}

/**
 * The parts of a long-lived extension port (`chrome.runtime.Port`) the port
 * transport uses. Such ports carry JSON only, so the transport encodes images.
 */
export interface PortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
  disconnect(): void;
}

/** How an image travels through a JSON-only port. */
const BLOB_KEY = "$critiqs:blob";

/**
 * Talks through an extension port, such as one between a content script and
 * Chrome's side panel. Images (`Blob`s) are sent as base64 text and turned
 * back into images on arrival; messages keep their order even while an image
 * is being encoded. When the port disconnects, the transport closes.
 */
export function portTransport(port: PortLike): PageTransport {
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const receivers = new Set<(message: unknown) => void>();
  const closing = closeListeners();
  const onMessage = (message: unknown) => {
    if (closed) return;
    let decoded: unknown;
    try {
      decoded = decodeBlobs(message);
    } catch {
      // An image that isn't valid base64 can't come from Critiqs's page layer.
      return;
    }
    for (const receive of [...receivers]) receive(decoded);
  };
  const onDisconnect = () => close();
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  const close = () => {
    if (closed) return;
    closed = true;
    receivers.clear();
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    closing.run();
  };
  return {
    send(message) {
      if (closed) return;
      queue = queue
        .then(() => encodeBlobs(message))
        .then((encoded) => {
          if (!closed) port.postMessage(encoded);
        })
        .catch((error) => console.error("Critiqs: a page layer message couldn't be sent", error));
    },
    listen(receive) {
      receivers.add(receive);
      return () => receivers.delete(receive);
    },
    onClose: closing.add,
    close() {
      if (closed) return;
      close();
      port.disconnect();
    },
  };
}

async function encodeBlobs(value: unknown): Promise<unknown> {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return { [BLOB_KEY]: btoa(binary), type: value.type };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeBlobs));
  if (typeof value === "object" && value !== null) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await encodeBlobs(entry)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

function decodeBlobs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBlobs);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record[BLOB_KEY] === "string" && Object.keys(record).length === 2 && typeof record.type === "string") {
    const binary = atob(record[BLOB_KEY]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: record.type });
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeBlobs(entry)]));
}
