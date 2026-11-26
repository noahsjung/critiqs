import { directTransports, panelEndpoint, type PageTransport, portTransport } from "@critiqs/core";
import { HOST_TAG } from "../../react/src/constants.ts";
import { PageLink } from "../../react/src/page-layer/link.ts";
import { type MountedPageLayer, mountPageLayer } from "../../react/src/page-layer/mount.tsx";
import type { AutoPins } from "./auto-pins.ts";
import { type ChromeApi, chromeApi, type Port } from "./chrome.ts";
import { CHANNEL, MOCKUP_PORT, PANEL_PORT, type PageMessage, REPLACED } from "./config.ts";
import { SITES_CHANGED } from "./site-access.ts";

/**
 * The content script: Critiqs's page layer in the reviewer's own tab. The
 * side panel connects to it through a port and draws everything else. On a
 * site whose comments show automatically it also runs with no side panel
 * open, drawing pins the worker reads from the backend. On a page that has
 * Critiqs installed it does nothing, and says so.
 */

/** The `critiqs` package's element for pages without a build (`critiqs/element`). */
const ELEMENT_TAG = "critiqs-app";

/** Critiqs installed by the site itself: its element, or its host that isn't the extension's own. */
export function installedCritiqs(root: ParentNode, own: ReadonlySet<Element>): boolean {
  if (root.querySelector(ELEMENT_TAG) !== null) return true;
  return Array.from(root.querySelectorAll(HOST_TAG)).some((host) => !own.has(host));
}

/** Whether nodes just added to the page bring the site's own Critiqs. */
function bringsCritiqs(nodes: Iterable<Node>, own: ReadonlySet<Element>): boolean {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.localName === ELEMENT_TAG || (node.localName === HOST_TAG && !own.has(node))) return true;
    if (node.firstElementChild !== null && installedCritiqs(node, own)) return true;
  }
  return false;
}

export interface RunningPage {
  /** Tells an open side panel again that the page layer is listening, as after a second click. */
  announce(): void;
  stop(): void;
}

export function startPage(chrome: Pick<ChromeApi, "runtime" | "storage">, document: Document): RunningPage {
  const send = (message: PageMessage) => chrome.runtime.sendMessage(message).catch(() => undefined);
  const own = new Set<Element>();
  let layer: MountedPageLayer | null = null;
  /** The Mockup tab's own page layer, which freezes the page for it and draws nothing. */
  let mockupLayer: { port: Port; layer: MountedPageLayer } | null = null;
  let pins: PageLink | null = null;
  let panel: Port | null = null;
  let builtIn = false;

  /** Starts a page layer, counting its host among the extension's own. */
  const start = (transport: PageTransport): MountedPageLayer => {
    const before = new Set(document.querySelectorAll(HOST_TAG));
    const started = mountPageLayer({ transport, channel: CHANNEL });
    for (const host of Array.from(document.querySelectorAll(HOST_TAG))) if (!before.has(host)) own.add(host);
    return started;
  };
  const mount = (transport: PageTransport) => {
    layer = start(transport);
  };
  const stopMockups = () => {
    mockupLayer?.port.disconnect();
    mockupLayer?.layer.destroy();
    mockupLayer = null;
  };
  const unmount = () => {
    pins?.close();
    pins = null;
    layer?.destroy();
    layer = null;
  };

  /** Pins with no side panel open, on a site whose comments show automatically. */
  let asked = 0;
  const showPins = async () => {
    // Only the latest question counts: an earlier answer may be from before a sign-out.
    const question = ++asked;
    const answer = (await chrome.runtime.sendMessage({ type: "critiqs:auto-pins" } satisfies PageMessage).catch(() => null)) as AutoPins | null;
    if (question !== asked || answer?.display == null || builtIn || panel !== null || layer !== null) return;
    const [panelEnd, layerEnd] = directTransports();
    mount(layerEnd);
    const link = new PageLink(panelEndpoint(panelEnd, { channel: CHANNEL }));
    pins = link;
    // A pin opens the side panel on its comment; Chrome may refuse outside a click on the icon.
    link.on("pin", ({ threadId }) => void send({ type: "critiqs:open-panel", threadId }));
    await link.connect();
    link.display(answer.display);
  };

  // Signing in or out, or turning a site's automatic comments on or off, changes what pins shown
  // on their own may draw: they are read again, or removed.
  const onStorage = (changes: Record<string, unknown>, area: string) => {
    if (area !== "local" || panel !== null || builtIn) return;
    if (!Object.keys(changes).some((key) => key === SITES_CHANGED || key.startsWith("session:") || key.startsWith("signed-out:"))) return;
    unmount();
    void showPins();
  };

  const onConnect = (port: Port) => {
    if (builtIn) return;
    if (port.name === MOCKUP_PORT) {
      // One Mockup tab at a time; the side panel's page layer and pins stay as they are.
      stopMockups();
      const opened = { port, layer: start(portTransport(port)) };
      mockupLayer = opened;
      port.onDisconnect.addListener(() => {
        if (mockupLayer !== opened) return;
        opened.layer.destroy();
        mockupLayer = null;
      });
      return;
    }
    if (port.name !== PANEL_PORT) return;
    // The side panel takes over from pins shown on their own, and from an earlier panel.
    const previous = panel;
    panel = port;
    if (previous !== null) {
      // So the earlier panel doesn't connect again and take the page back.
      previous.postMessage(REPLACED);
      previous.disconnect();
    }
    unmount();
    mount(portTransport(port));
    port.onDisconnect.addListener(() => {
      if (panel !== port) return;
      panel = null;
      unmount();
      void showPins();
    });
  };

  const standAside = () => {
    builtIn = true;
    observer?.disconnect();
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.runtime.onConnect.removeListener(onConnect);
    panel?.disconnect();
    panel = null;
    unmount();
    stopMockups();
    void send({ type: "critiqs:built-in" });
  };

  let observer: MutationObserver | null = null;
  if (installedCritiqs(document, own)) {
    standAside();
  } else {
    chrome.runtime.onConnect.addListener(onConnect);
    chrome.storage.onChanged.addListener(onStorage);
    // A site's own Critiqs may start after this script, such as once its app has loaded.
    observer = new MutationObserver((records) => {
      if (records.some((record) => bringsCritiqs(record.addedNodes, own))) standAside();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void send({ type: "critiqs:page-ready" });
    void showPins();
  }

  return {
    announce: () => void send(builtIn ? { type: "critiqs:built-in" } : { type: "critiqs:page-ready" }),
    stop() {
      observer?.disconnect();
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onConnect.removeListener(onConnect);
      panel?.disconnect();
      unmount();
      stopMockups();
    },
  };
}

// Clicking the icon again adds this script again; the page keeps the one already running.
const RUNNING = Symbol.for("critiqs.extension.page");
const scope = globalThis as { [RUNNING]?: RunningPage };
const chrome = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
if (chrome?.runtime?.id !== undefined && typeof document !== "undefined") {
  if (scope[RUNNING] === undefined) scope[RUNNING] = startPage(chromeApi(), document);
  else scope[RUNNING].announce();
}
