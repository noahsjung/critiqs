import { type PageTransport, portTransport } from "@critiqs/core";
import type { ChromeApi, MessageSender } from "../chrome.ts";
import { isPageMessage, isReplaced, PANEL_PORT } from "../config.ts";

/**
 * The side panel's line to the page layer in its tab. Each page the tab shows
 * runs its own content script, so the port to it ends when the tab loads
 * another page; this transport then connects again to the next page's page
 * layer as soon as it says it is listening. The panel sees one transport for
 * the tab, the way a review link's panel sees one frame: the new page layer
 * says it is ready, and the panel starts again with it.
 */
export interface TabConnection {
  transport: PageTransport;
  /** Whether a page layer in the tab is connected now. */
  connected(): boolean;
  /** Calls `listener` whenever the tab's page layer connects or goes away. */
  onChange(listener: () => void): () => void;
  /** Tries to connect now, such as after the worker added the page layer. */
  connect(): void;
}

export function tabConnection(chrome: Pick<ChromeApi, "tabs" | "runtime">, tabId: number): TabConnection {
  const receivers = new Set<(message: unknown) => void>();
  const changes = new Set<() => void>();
  const closing = new Set<() => void>();
  let current: PageTransport | null = null;
  /** Whether the page layer at the other end of the current port has said anything. */
  let live = false;
  /** Another side panel for this tab took the page layer; this one waits for the next page. */
  let replaced = false;
  let closed = false;
  const changed = () => {
    for (const listener of [...changes]) listener();
  };

  const connect = () => {
    if (closed) return;
    const previous = current;
    current = null;
    live = false;
    previous?.close();
    let port;
    try {
      port = chrome.tabs.connect(tabId, { name: PANEL_PORT, frameId: 0 });
    } catch {
      return;
    }
    replaced = false;
    // Before the page layer's messages: the content script's note that another panel took over.
    port.onMessage.addListener((message) => {
      if (isReplaced(message)) replaced = true;
    });
    const transport = portTransport(port);
    current = transport;
    transport.listen((message) => {
      if (current !== transport || isReplaced(message)) return;
      for (const receive of [...receivers]) receive(message);
      if (!live) {
        live = true;
        changed();
      }
    });
    // A tab with no page layer yet disconnects at once; the page layer says when it is listening.
    transport.onClose(() => {
      if (current !== transport) return;
      current = null;
      const was = live;
      live = false;
      if (!was) return;
      changed();
      // The next page's page layer may have said it was listening before this port ended.
      if (!replaced) connect();
    });
  };

  // A page layer started in this tab (after a click, or on a site whose comments show automatically).
  const onMessage = (message: unknown, sender: MessageSender) => {
    if (isPageMessage(message) && message.type === "critiqs:page-ready" && sender.tab?.id === tabId && sender.frameId === 0 && !live) connect();
  };
  chrome.runtime.onMessage.addListener(onMessage);

  return {
    transport: {
      send(message) {
        current?.send(message);
      },
      listen(receive) {
        receivers.add(receive);
        return () => void receivers.delete(receive);
      },
      onClose(listener) {
        closing.add(listener);
        return () => void closing.delete(listener);
      },
      close() {
        if (closed) return;
        closed = true;
        chrome.runtime.onMessage.removeListener(onMessage);
        current?.close();
        current = null;
        receivers.clear();
        for (const listener of [...closing]) listener();
        closing.clear();
      },
    },
    connected: () => live,
    onChange(listener) {
      changes.add(listener);
      return () => void changes.delete(listener);
    },
    connect,
  };
}
