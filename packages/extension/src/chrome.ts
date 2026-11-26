// The parts of Chrome's extension API that Critiqs uses, typed narrowly so
// tests can stand in for them with a small fake.

export interface ChromeEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface Tab {
  id?: number;
  windowId: number;
  /** Its place in its window's tab strip. */
  index?: number;
  url?: string;
  active: boolean;
  /** When the tab was last made active, in milliseconds. */
  lastAccessed?: number;
}

export interface Port {
  name: string;
  sender?: { tab?: Tab };
  postMessage(message: unknown): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
  disconnect(): void;
}

export interface MessageSender {
  tab?: Tab;
  /** Set for messages from a page's frames; absent from extension pages. */
  frameId?: number;
  id?: string;
}

export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface RegisteredContentScript {
  id: string;
  matches?: string[];
  js?: string[];
  runAt?: "document_start" | "document_end" | "document_idle";
  persistAcrossSessions?: boolean;
  allFrames?: boolean;
}

export interface ChromeApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: ChromeEvent<(message: unknown, sender: MessageSender, respond: (answer: unknown) => void) => boolean | void>;
    onConnect: ChromeEvent<(port: Port) => void>;
    connect?(info: { name: string }): Port;
  };
  tabs: {
    get(tabId: number): Promise<Tab>;
    /** The tab this extension page is in; undefined outside a tab, such as in the side panel. */
    getCurrent?(): Promise<Tab | undefined>;
    create?(properties: { url: string; windowId?: number; index?: number; openerTabId?: number; active?: boolean }): Promise<Tab>;
    update?(tabId: number, properties: { url?: string; active?: boolean }): Promise<Tab>;
    remove?(tabId: number): Promise<void>;
    captureVisibleTab(windowId: number, options: { format: "png" | "jpeg" }): Promise<string>;
    connect(tabId: number, info: { name: string; frameId?: number }): Port;
    onRemoved: ChromeEvent<(tabId: number) => void>;
    onUpdated: ChromeEvent<(tabId: number, change: { status?: string; url?: string }, tab: Tab) => void>;
  };
  action: {
    onClicked: ChromeEvent<(tab: Tab) => void>;
    setTitle(details: { tabId?: number; title: string }): Promise<void>;
    setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  };
  sidePanel: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
    setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
  };
  scripting: {
    executeScript(injection: { target: { tabId: number; frameIds?: number[] }; files: string[] }): Promise<{ result?: unknown }[]>;
    registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<RegisteredContentScript[]>;
  };
  permissions: {
    request(permissions: { origins: string[] }): Promise<boolean>;
    remove(permissions: { origins: string[] }): Promise<boolean>;
    contains(permissions: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    local: StorageArea;
    session: StorageArea;
    onChanged: ChromeEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
  };
}

/** The browser's extension API, where this code runs as part of the extension. */
export function chromeApi(): ChromeApi {
  return (globalThis as unknown as { chrome: ChromeApi }).chrome;
}
