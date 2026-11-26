import { describe, expect, test } from "bun:test";
import {
  directTransports,
  type ElementRef,
  PAGE_MESSAGE_TAG,
  PAGE_PROTOCOL,
  type PageDisplay,
  type PageHandlers,
  type PageState,
  type PageTransport,
  type PortLike,
  PageLayerError,
  pageLayerEndpoint,
  panelEndpoint,
  parsePageMessage,
  portTransport,
  type WindowLike,
  windowTransport,
} from "../src/index.ts";

const CHANNEL = "test";
const STATE: PageState = {
  document: "d1",
  version: 1,
  url: "https://prototype.example/users/42",
  context: { screen: "users/:id", viewState: { tab: "profile" }, persona: null },
  viewport: { width: 1280, height: 800 },
  restores: true,
  located: { t1: { status: "found", occurrences: [{ ref: "e1" as ElementRef, recordKey: "42" }] }, t2: null },
};
const DISPLAY: PageDisplay = {
  hidden: false,
  exposedRight: null,
  watch: [],
  pins: [],
  selected: null,
  highlight: null,
  picking: null,
  picked: null,
};
const request = (method: string, params: unknown, extra: Record<string, unknown> = {}) => ({
  tag: PAGE_MESSAGE_TAG,
  v: PAGE_PROTOCOL,
  channel: CHANNEL,
  kind: "request",
  id: 7,
  method,
  params,
  document: null,
  ...extra,
});

/** Handlers that answer every request plainly; tests replace the ones they need. */
function handlers(overrides: Partial<PageHandlers> = {}): PageHandlers {
  const missing = () => {
    throw new Error("not used in this test");
  };
  return {
    connect: () => ({ protocol: PAGE_PROTOCOL, state: STATE }),
    display: () => STATE,
    reveal: missing,
    showPage: missing,
    measure: missing,
    capture: missing,
    conceal: () => null,
    copyPage: missing,
    removeLink: () => null,
    ...overrides,
  };
}

function connected(overrides: Partial<PageHandlers> = {}, [panelSide, pageSide]: [PageTransport, PageTransport] = directTransports()) {
  const page = pageLayerEndpoint(pageSide, { channel: CHANNEL, handlers: handlers(overrides) });
  const panel = panelEndpoint(panelSide, { channel: CHANNEL });
  return { page, panel, panelSide, pageSide };
}

describe("checking messages", () => {
  test("ignores messages that aren't Critiqs's, or are on another channel", () => {
    expect(parsePageMessage("hello", CHANNEL)).toEqual({ ok: false, ignore: true });
    expect(parsePageMessage({ type: "webpackHotUpdate" }, CHANNEL)).toEqual({ ok: false, ignore: true });
    expect(parsePageMessage(request("display", DISPLAY), "another")).toEqual({ ok: false, ignore: true });
  });

  test("accepts a well-formed request", () => {
    const parsed = parsePageMessage(request("display", DISPLAY), CHANNEL);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.kind === "request") expect(parsed.message.method).toBe("display");
  });

  test("refuses another protocol version", () => {
    const parsed = parsePageMessage(request("display", DISPLAY, { v: 2 }), CHANNEL);
    expect(parsed).toMatchObject({ ok: false, ignore: false, reply: "request", id: 7, code: "unsupported-version" });
  });

  test("refuses requests that don't exist, including inherited names", () => {
    expect(parsePageMessage(request("eval", {}), CHANNEL)).toMatchObject({ ok: false, code: "unknown-method" });
    expect(parsePageMessage(request("toString", {}), CHANNEL)).toMatchObject({ ok: false, code: "unknown-method" });
    expect(parsePageMessage(request("__proto__", {}), CHANNEL)).toMatchObject({ ok: false, code: "unknown-method" });
  });

  test("refuses params with a missing field, an unknown field, or a wrong type", () => {
    const { picked: _picked, ...missing } = DISPLAY;
    expect(parsePageMessage(request("display", missing), CHANNEL)).toMatchObject({ ok: false, code: "bad-request", reason: "params.picked must be present." });
    expect(parsePageMessage(request("display", { ...DISPLAY, script: "alert(1)" }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
    expect(parsePageMessage(request("display", { ...DISPLAY, hidden: "yes" }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request", reason: "params.hidden must be true or false." });
    expect(parsePageMessage(request("capture", { marker: null, image: "data:image/png;base64,AAAA" }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
    expect(parsePageMessage(request("measure", { ref: null }, { id: -1 }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
  });

  test("refuses view state values that aren't text, numbers, true, false, or null", () => {
    const location = { screen: "s", viewState: { tab: { nested: true } }, scope: "shared", target: { purposeId: "p", recordKey: null, clues: { tagName: "button", role: null, label: null, path: "" } } };
    expect(parsePageMessage(request("reveal", { threadId: "t", location, chosen: null }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
    expect(parsePageMessage(request("reveal", { threadId: "t", location: { ...location, viewState: { tab: 1 } }, chosen: null }), CHANNEL).ok).toBe(true);
  });

  test("refuses fields that only exist on every object, such as constructor or __proto__", () => {
    for (const field of ["constructor", "toString", "hasOwnProperty"]) {
      expect(parsePageMessage(request("conceal", { concealed: true, [field]: 1 }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
    }
    const withProto = JSON.parse('{"concealed": true, "__proto__": {"polluted": true}}');
    expect(parsePageMessage(request("conceal", withProto), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("connecting names exactly this protocol version", () => {
    expect(parsePageMessage(request("connect", { protocol: PAGE_PROTOCOL }), CHANNEL).ok).toBe(true);
    expect(parsePageMessage(request("connect", { protocol: 2 }), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
  });

  test("takes the long values a host app may report, as installed Critiqs always has", () => {
    const filter = "x".repeat(1_000_001);
    const state = { ...STATE, context: { screen: "s".repeat(10_000), viewState: { filter }, persona: null } };
    expect(parsePageMessage({ tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel: CHANNEL, kind: "event", event: "state", data: state }, CHANNEL).ok).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`filter${index}`, index]));
    const wide = { ...STATE, context: { ...STATE.context, viewState: many } };
    expect(parsePageMessage({ tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel: CHANNEL, kind: "event", event: "state", data: wide }, CHANNEL).ok).toBe(true);
  });

  test("refuses a page address that would run code or carry content", () => {
    const event = (url: string) => ({ tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel: CHANNEL, kind: "event", event: "state", data: { ...STATE, url } });
    for (const url of ["https://prototype.example/a", "http://localhost:5173/", "file:///Users/dana/prototype/index.html", "about:srcdoc"]) {
      expect(parsePageMessage(event(url), CHANNEL).ok).toBe(true);
    }
    for (const url of ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox", "/relative", ""]) {
      expect(parsePageMessage(event(url), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
    }
  });

  test("refuses events that don't exist or carry the wrong data", () => {
    const event = (name: string, data: unknown) => ({ tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel: CHANNEL, kind: "event", event: name, data });
    expect(parsePageMessage(event("pin", { threadId: "t", occurrence: { ref: "e1", recordKey: null } }), CHANNEL).ok).toBe(true);
    expect(parsePageMessage(event("pin", { threadId: "t" }), CHANNEL)).toMatchObject({ ok: false, reply: null, code: "bad-request" });
    expect(parsePageMessage(event("keylogger", {}), CHANNEL)).toMatchObject({ ok: false, code: "bad-request" });
  });
});

describe("requests and events", () => {
  test("a request gets the page layer's answer", async () => {
    const { panel } = connected();
    expect(await panel.request("connect", { protocol: PAGE_PROTOCOL })).toEqual({ protocol: PAGE_PROTOCOL, state: STATE });
  });

  test("the direct transport answers in the same call, with no copying", () => {
    const [panelSide, pageSide] = directTransports();
    const seen: unknown[] = [];
    pageSide.listen((message) => seen.push(message));
    const message = { tag: PAGE_MESSAGE_TAG } as never;
    panelSide.send(message);
    expect(seen).toEqual([message]);
    expect(seen[0]).toBe(message);
  });

  test("a handler's error fails the request with its message", async () => {
    const { panel } = connected({
      copyPage: () => {
        throw new Error("The page couldn't be copied.");
      },
    });
    const failure = panel.request("copyPage", {}).catch((error: unknown) => error);
    expect(await failure).toBeInstanceOf(PageLayerError);
    expect(await failure).toMatchObject({ code: "failed", message: "The page couldn't be copied." });
  });

  test("an answer that doesn't match the request's result fails the request instead of reaching the panel", async () => {
    const { panel } = connected({ display: () => ({ ...STATE, url: 42 }) as unknown as PageState });
    expect(await panel.request("display", DISPLAY).catch((error: unknown) => error)).toMatchObject({ code: "bad-request" });
  });

  test("sending bad params never reaches the handler", async () => {
    let called = false;
    const { panel } = connected({
      display: () => {
        called = true;
        return STATE;
      },
    });
    const bad = { ...DISPLAY, hidden: "no" } as unknown as PageDisplay;
    expect(await panel.request("display", bad).catch((error: unknown) => error)).toMatchObject({ code: "bad-request" });
    expect(called).toBe(false);
  });

  test("a panel with another protocol version is told so", async () => {
    const [panelSide, pageSide] = directTransports();
    pageLayerEndpoint(pageSide, { channel: CHANNEL, handlers: handlers() });
    const answers: unknown[] = [];
    panelSide.listen((message) => answers.push(message));
    panelSide.send(request("connect", { protocol: 2 }, { v: 2 }) as never);
    expect(answers).toEqual([
      expect.objectContaining({ kind: "error", id: 7, error: expect.objectContaining({ code: "unsupported-version" }) }),
    ]);
  });

  test("a request for a page layer that another document's replaced is refused as gone", async () => {
    const [panelSide, pageSide] = directTransports();
    let called = false;
    pageLayerEndpoint(pageSide, { channel: CHANNEL, document: "new-page", handlers: handlers({ measure: () => ((called = true), null as never) }) });
    const panel = panelEndpoint(panelSide, { channel: CHANNEL });
    expect(await panel.request("measure", { ref: "e1" as ElementRef }, { document: "old-page" }).catch((error: unknown) => error)).toMatchObject({ code: "gone" });
    expect(called).toBe(false);
    // Connecting is for whichever page layer is there.
    expect(await panel.request("connect", { protocol: PAGE_PROTOCOL })).toMatchObject({ protocol: PAGE_PROTOCOL });
  });

  test("cancelling aborts the handler's work and fails the request", async () => {
    let aborted = false;
    const { panel } = connected({
      reveal: (_params, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ status: "failed", reason: "late", keepOccurrence: true });
          });
        }),
    });
    const controller = new AbortController();
    const location = { screen: "s", viewState: {}, scope: "shared" as const, target: { purposeId: "p", recordKey: null, clues: { tagName: "b", role: null, label: null, path: "" } } };
    const pending = panel.request("reveal", { threadId: "t", location, chosen: null }, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    expect(aborted).toBe(true);
  });

  test("a request with no answer in time fails with a timeout and is cancelled", async () => {
    let aborted = false;
    const { panel } = connected({ copyPage: (_params, signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))) });
    expect(await panel.request("copyPage", {}, { timeoutMs: 10 }).catch((error: unknown) => error)).toMatchObject({ code: "timeout" });
    expect(aborted).toBe(true);
  });

  test("events reach the panel's handlers until they stop listening", () => {
    const { page, panel } = connected();
    const pins: string[] = [];
    const stop = panel.on("pin", (data) => pins.push(data.threadId));
    page.emit("pin", { threadId: "t1", occurrence: { ref: "e1" as ElementRef, recordKey: null } });
    stop();
    page.emit("pin", { threadId: "t2", occurrence: { ref: "e2" as ElementRef, recordKey: null } });
    expect(pins).toEqual(["t1"]);
  });

  test("a panel that closes stops the page layer's work for it", async () => {
    let aborted = false;
    const { panel } = connected({ copyPage: (_params, signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))) });
    const pending = panel.request("copyPage", {}).catch((error: unknown) => error);
    panel.close();
    expect(await pending).toMatchObject({ code: "closed" });
    expect(aborted).toBe(true);
  });

  test("closing the connection fails requests still waiting", async () => {
    const { panel, panelSide } = connected({ copyPage: () => new Promise(() => {}) });
    const pending = panel.request("copyPage", {}).catch((error: unknown) => error);
    panelSide.close();
    expect(await pending).toMatchObject({ code: "closed" });
    expect(await panel.request("conceal", { concealed: true }).catch((error: unknown) => error)).toMatchObject({ code: "closed" });
  });
});

/**
 * Two fake windows. As in a browser, `target.postMessage(message, origin)`
 * delivers to `target` asynchronously, from the other window, and only when
 * `origin` is the target's own origin; each records the origins it was sent to.
 */
function fakeWindows(originA: string, originB: string) {
  type Listener = (event: MessageEvent) => void;
  type Fake = WindowLike & { origin: string; received: string[]; deliver(data: unknown, from: { origin: string; source: unknown }): void };
  const make = (origin: string, sender: () => Fake): Fake => {
    const listeners = new Set<Listener>();
    const win: Fake = {
      origin,
      received: [],
      postMessage(message, targetOrigin) {
        win.received.push(targetOrigin);
        if (targetOrigin !== "*" && targetOrigin !== origin) return;
        const data = structuredClone(message);
        const from = sender();
        setTimeout(() => win.deliver(data, { origin: from.origin, source: from }));
      },
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
      deliver(data, from) {
        for (const listener of [...listeners]) listener({ data, origin: from.origin, source: from.source } as MessageEvent);
      },
    };
    return win;
  };
  const a: Fake = make(originA, () => b);
  const b: Fake = make(originB, () => a);
  return { a, b };
}

describe("postMessage transport", () => {
  const PANEL = "https://critiqs.example";
  const PAGE = "https://prototype.example";

  test("requests and answers cross between windows, each sent only to the peer's origin", async () => {
    const { a: panelWindow, b: pageWindow } = fakeWindows(PANEL, PAGE);
    pageLayerEndpoint(windowTransport({ self: pageWindow, peer: panelWindow, peerOrigin: PANEL }), { channel: CHANNEL, handlers: handlers() });
    const panel = panelEndpoint(windowTransport({ self: panelWindow, peer: pageWindow, peerOrigin: PAGE }), { channel: CHANNEL });
    expect(await panel.request("connect", { protocol: PAGE_PROTOCOL })).toMatchObject({ protocol: PAGE_PROTOCOL });
    expect(pageWindow.received).toEqual([PAGE]);
    expect(panelWindow.received).toEqual([PANEL]);
  });

  test("ignores messages from another origin or another window", async () => {
    const { a: panelWindow, b: pageWindow } = fakeWindows(PANEL, PAGE);
    const received: unknown[] = [];
    windowTransport({ self: pageWindow, peer: panelWindow, peerOrigin: PANEL }).listen((message) => received.push(message));
    const message = request("conceal", { concealed: true });
    // Right window, wrong origin: such as the panel's frame navigated to another site.
    pageWindow.deliver(message, { origin: "https://evil.example", source: panelWindow });
    // Right origin, wrong window: such as another tab of the same site.
    pageWindow.deliver(message, { origin: PANEL, source: {} });
    expect(received).toEqual([]);
    pageWindow.deliver(message, { origin: PANEL, source: panelWindow });
    expect(received).toEqual([message]);
  });

  test("refuses a peer origin that isn't exact", () => {
    const { a, b } = fakeWindows(PANEL, PAGE);
    for (const peerOrigin of ["*", "https://prototype.example/", "https://prototype.example/path", "null", "prototype.example", ""]) {
      expect(() => windowTransport({ self: a, peer: b, peerOrigin })).toThrow("exact origin");
    }
  });
});

/** An in-memory pair of extension ports: JSON only, delivered asynchronously, as `chrome.runtime` ports are. */
function fakePorts(): [PortLike & { sent: string[] }, PortLike & { sent: string[] }] {
  type End = PortLike & { sent: string[]; other: () => End; messages: Set<(message: unknown) => void>; disconnects: Set<() => void> };
  const ends: End[] = [];
  const shared = { connected: true };
  const make = (index: number): End => {
    const messages = new Set<(message: unknown) => void>();
    const disconnects = new Set<() => void>();
    const end: End = {
      sent: [],
      messages,
      disconnects,
      other: () => ends[1 - index]!,
      postMessage(message) {
        if (!shared.connected) throw new Error("Attempting to use a disconnected port object");
        const json = JSON.stringify(message);
        end.sent.push(json);
        setTimeout(() => {
          for (const listener of [...end.other().messages]) listener(JSON.parse(json));
        });
      },
      onMessage: { addListener: (listener) => void messages.add(listener), removeListener: (listener) => void messages.delete(listener) },
      onDisconnect: { addListener: (listener) => void disconnects.add(listener), removeListener: (listener) => void disconnects.delete(listener) },
      disconnect() {
        shared.connected = false;
        // Chrome tells only the other end.
        setTimeout(() => {
          for (const listener of [...end.other().disconnects]) listener();
        });
      },
    };
    return end;
  };
  ends.push(make(0), make(1));
  return [ends[0]!, ends[1]!];
}

describe("extension port transport", () => {
  test("images cross a JSON-only port and arrive as images", async () => {
    const [panelPort, pagePort] = fakePorts();
    let received: Blob | null = null;
    pageLayerEndpoint(portTransport(pagePort), {
      channel: CHANNEL,
      handlers: handlers({
        capture: async ({ image }) => {
          received = image;
          return { status: "captured", image: new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], { type: "image/png" }) };
        },
      }),
    });
    const panel = panelEndpoint(portTransport(panelPort), { channel: CHANNEL });
    const supplied = new Blob([new Uint8Array([1, 2, 3, 250])], { type: "image/jpeg" });
    const outcome = await panel.request("capture", { marker: { x: 1, y: 2, width: 3, height: 4 }, image: supplied });
    expect(received).toBeInstanceOf(Blob);
    expect(received!.type).toBe("image/jpeg");
    expect([...new Uint8Array(await received!.arrayBuffer())]).toEqual([1, 2, 3, 250]);
    expect(outcome.status).toBe("captured");
    if (outcome.status === "captured") expect([...new Uint8Array(await outcome.image.arrayBuffer())]).toEqual([137, 80, 78, 71, 0, 255]);
    // Nothing but JSON went through the port.
    expect(panelPort.sent.every((json) => typeof JSON.parse(json) === "object")).toBe(true);
  });

  test("messages keep their order while an image ahead of them is encoded", async () => {
    const [panelPort, pagePort] = fakePorts();
    const order: string[] = [];
    pageLayerEndpoint(portTransport(pagePort), {
      channel: CHANNEL,
      handlers: handlers({
        capture: () => (order.push("capture"), { status: "failed", reason: "no" }),
        conceal: ({ concealed }) => (order.push(`conceal ${concealed}`), null),
      }),
    });
    const panel = panelEndpoint(portTransport(panelPort), { channel: CHANNEL });
    await Promise.all([
      panel.request("conceal", { concealed: true }),
      panel.request("capture", { marker: null, image: new Blob([new Uint8Array(200_000)], { type: "image/png" }) }),
      panel.request("conceal", { concealed: false }),
    ]);
    expect(order).toEqual(["conceal true", "capture", "conceal false"]);
  });

  test("a disconnected port fails requests still waiting", async () => {
    const [panelPort, pagePort] = fakePorts();
    pageLayerEndpoint(portTransport(pagePort), { channel: CHANNEL, handlers: handlers({ copyPage: () => new Promise(() => {}) }) });
    const panel = panelEndpoint(portTransport(panelPort), { channel: CHANNEL });
    const pending = panel.request("copyPage", {}).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The tab navigated away: Chrome disconnects the content script's port.
    pagePort.disconnect();
    expect(await pending).toMatchObject({ code: "closed" });
  });

  test("the page layer stops its work when the panel's port disconnects", async () => {
    const [panelPort, pagePort] = fakePorts();
    let aborted = false;
    pageLayerEndpoint(portTransport(pagePort), {
      channel: CHANNEL,
      handlers: handlers({ copyPage: (_params, signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))) }),
    });
    const panelSide = portTransport(panelPort);
    const panel = panelEndpoint(panelSide, { channel: CHANNEL });
    void panel.request("copyPage", {}).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    panelSide.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(aborted).toBe(true);
  });
});
