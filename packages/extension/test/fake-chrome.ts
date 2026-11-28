import type { ChromeApi, ChromeEvent, MessageSender, Port, RegisteredContentScript, StorageArea, StorageChange, Tab } from "../src/chrome.ts";

// A small stand-in for Chrome's extension API: storage in memory, events the
// test can fire, and every call recorded in order.

export function fakeEvent<Listener extends (...args: never[]) => unknown>() {
  const listeners = new Set<Listener>();
  const event: ChromeEvent<Listener> & { fire(...args: Parameters<Listener>): ReturnType<Listener>[]; count(): number } = {
    addListener: (listener) => void listeners.add(listener),
    removeListener: (listener) => void listeners.delete(listener),
    fire: (...args) => [...listeners].map((listener) => listener(...args) as ReturnType<Listener>),
    count: () => listeners.size,
  };
  return event;
}

function fakeStorage(name: string, onChanged: ReturnType<typeof fakeEvent<(changes: Record<string, StorageChange>, area: string) => void>>, used: string[]) {
  const items = new Map<string, unknown>();
  const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const area: StorageArea & { items: Map<string, unknown> } = {
    items,
    async get(keys) {
      used.push(`${name}.get`);
      const wanted = keys === null ? [...items.keys()] : typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(wanted.filter((key) => items.has(key)).map((key) => [key, copy(items.get(key))]));
    },
    async set(values) {
      used.push(`${name}.set`);
      const changes: Record<string, StorageChange> = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: items.get(key), newValue: copy(value) };
        items.set(key, copy(value));
      }
      onChanged.fire(changes, name);
    },
    async remove(keys) {
      used.push(`${name}.remove`);
      const changes: Record<string, StorageChange> = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (!items.has(key)) continue;
        changes[key] = { oldValue: items.get(key) };
        items.delete(key);
      }
      if (Object.keys(changes).length > 0) onChanged.fire(changes, name);
    },
  };
  return area;
}

/** One end of a fake port pair: what one side posts, the other receives, a moment later as Chrome delivers it. */
export function fakePorts(name: string, sender?: { tab?: Tab }): [Port & { disconnected: boolean }, Port & { disconnected: boolean }] {
  const make = () => ({ onMessage: fakeEvent<(message: unknown) => void>(), onDisconnect: fakeEvent<() => void>() });
  const sides = [make(), make()];
  const ends = sides.map((own, index) => {
    const other = sides[1 - index]!;
    const end = {
      name,
      sender,
      disconnected: false,
      postMessage(message: unknown) {
        if (end.disconnected) throw new Error("Attempting to use a disconnected port object");
        const copy = JSON.parse(JSON.stringify(message));
        queueMicrotask(() => other.onMessage.fire(copy));
      },
      onMessage: own.onMessage,
      onDisconnect: own.onDisconnect,
      disconnect() {
        if (end.disconnected) return;
        end.disconnected = true;
        const peer = ends[1 - index]!;
        if (!peer.disconnected) {
          peer.disconnected = true;
          queueMicrotask(() => other.onDisconnect.fire());
        }
      },
    };
    return end;
  });
  return [ends[0]!, ends[1]!];
}

export interface FakeChrome extends ChromeApi {
  calls: string[];
  /** Every use of extension storage, in order: `local.get`, `session.set`, `local.setAccessLevel TRUSTED_CONTEXTS`, … */
  storageCalls: string[];
  /** Messages the worker sent to tabs: [tabId, message]. */
  tabMessages: [number, unknown][];
  tabs: ChromeApi["tabs"] & { onRemoved: ReturnType<typeof fakeEvent<(tabId: number) => void>>; onUpdated: ReturnType<typeof fakeEvent<(tabId: number, change: { status?: string; url?: string }, tab: Tab) => void>> };
  action: ChromeApi["action"] & { onClicked: ReturnType<typeof fakeEvent<(tab: Tab) => void>> };
  runtime: ChromeApi["runtime"] & {
    onMessage: ReturnType<typeof fakeEvent<(message: unknown, sender: MessageSender, respond: (answer: unknown) => void) => boolean | void>>;
    onConnect: ReturnType<typeof fakeEvent<(port: Port) => void>>;
  };
  storage: ChromeApi["storage"] & { local: ChromeApi["storage"]["local"] & { items: Map<string, unknown> }; session: StorageArea & { items: Map<string, unknown> } };
  /** What the fake does when asked; tests change these. */
  behavior: {
    executeScript: (tabId: number) => Promise<void>;
    permissionRequest: (origins: string[]) => boolean;
    capture: (windowId: number) => Promise<string>;
    tab: (tabId: number) => Tab;
    connect: (tabId: number, name: string) => Port;
    registerFails: boolean;
    /** The tabs `tabs.query` lists. */
    tabs: () => Tab[];
  };
  granted: Set<string>;
  registered: Map<string, RegisteredContentScript>;
}

export function fakeChrome(): FakeChrome {
  const calls: string[] = [];
  const storageCalls: string[] = [];
  const tabMessages: [number, unknown][] = [];
  const onChanged = fakeEvent<(changes: Record<string, StorageChange>, area: string) => void>();
  const granted = new Set<string>();
  const registered = new Map<string, RegisteredContentScript>();
  const behavior: FakeChrome["behavior"] = {
    executeScript: async () => {},
    permissionRequest: () => true,
    capture: async () => `data:image/png;base64,${btoa("png")}`,
    tab: (tabId) => ({ id: tabId, windowId: 1, active: true, lastAccessed: 1, url: "https://acme-proto.vercel.app/users/42" }),
    connect: (tabId, name) => {
      const [, panel] = fakePorts(name);
      queueMicrotask(() => panel.disconnect());
      return panel;
    },
    registerFails: false,
    tabs: () => [behavior.tab(7)],
  };
  const chrome: FakeChrome = {
    calls,
    storageCalls,
    tabMessages,
    behavior,
    granted,
    registered,
    runtime: {
      id: "pfdpnmmiemejphfghkalofichdcoandg",
      getURL: (path) => `chrome-extension://pfdpnmmiemejphfghkalofichdcoandg/${path}`,
      sendMessage: async (message) => (calls.push(`runtime.sendMessage ${JSON.stringify(message)}`), undefined),
      onMessage: fakeEvent(),
      onConnect: fakeEvent(),
    },
    tabs: {
      get: async (tabId) => behavior.tab(tabId),
      captureVisibleTab: async (windowId, options) => (calls.push(`tabs.captureVisibleTab ${windowId} ${options.format}`), await behavior.capture(windowId)),
      query: async () => behavior.tabs(),
      sendMessage: async (tabId, message) => void tabMessages.push([tabId, JSON.parse(JSON.stringify(message))]),
      connect: (tabId, info) => (calls.push(`tabs.connect ${tabId} ${info.name}`), behavior.connect(tabId, info.name)),
      onRemoved: fakeEvent(),
      onUpdated: fakeEvent(),
    },
    action: {
      onClicked: fakeEvent(),
      setTitle: async ({ tabId, title }) => void calls.push(`action.setTitle ${tabId} ${title}`),
      setBadgeText: async ({ tabId, text }) => void calls.push(`action.setBadgeText ${tabId} ${text}`),
    },
    sidePanel: {
      setPanelBehavior: async (behavior) => void calls.push(`sidePanel.setPanelBehavior ${JSON.stringify(behavior)}`),
      setOptions: async (options) => void calls.push(`sidePanel.setOptions ${JSON.stringify(options)}`),
      open: async (options) => void calls.push(`sidePanel.open ${JSON.stringify(options)}`),
    },
    scripting: {
      executeScript: async ({ target, files }) => {
        calls.push(`scripting.executeScript ${target.tabId} ${files.join(",")}`);
        await behavior.executeScript(target.tabId);
        return [{}];
      },
      registerContentScripts: async (scripts) => {
        calls.push(`scripting.registerContentScripts ${JSON.stringify(scripts)}`);
        if (behavior.registerFails) throw new Error("Couldn't register");
        for (const script of scripts) {
          if (registered.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`);
          registered.set(script.id, script);
        }
      },
      unregisterContentScripts: async ({ ids }) => {
        calls.push(`scripting.unregisterContentScripts ${ids.join(",")}`);
        const missing = ids.filter((id) => !registered.has(id));
        for (const id of ids) registered.delete(id);
        if (missing.length > 0) throw new Error(`Nonexistent script ID '${missing[0]}'`);
      },
      getRegisteredContentScripts: async ({ ids }) => ids.flatMap((id) => (registered.has(id) ? [registered.get(id)!] : [])),
    },
    permissions: {
      request: async ({ origins }) => {
        calls.push(`permissions.request ${origins.join(",")}`);
        const answer = behavior.permissionRequest(origins);
        if (answer) for (const origin of origins) granted.add(origin);
        return answer;
      },
      remove: async ({ origins }) => {
        calls.push(`permissions.remove ${origins.join(",")}`);
        for (const origin of origins) granted.delete(origin);
        return true;
      },
      contains: async ({ origins }) => origins.every((origin) => granted.has(origin)),
    },
    storage: {
      local: Object.assign(fakeStorage("local", onChanged, storageCalls), {
        setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => void storageCalls.push(`local.setAccessLevel ${accessLevel}`),
      }),
      session: fakeStorage("session", onChanged, storageCalls),
      onChanged,
    },
  };
  return chrome;
}

/** Lets queued deliveries and storage writes finish. */
export const settle = async (rounds = 5) => {
  for (let round = 0; round < rounds; round++) await new Promise((resolve) => setTimeout(resolve, 0));
};
