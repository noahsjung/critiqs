// What the extension's parts share: the backend it uses, and the names of the
// messages and ports between the side panel, the worker, and the page.

declare const CRITIQS_BACKEND: string | undefined;

/** Critiqs Cloud, unless a build names another Convex deployment (`CRITIQS_BACKEND=… bun run build`). */
export const BACKEND_URL: string = typeof CRITIQS_BACKEND === "string" && CRITIQS_BACKEND !== "" ? CRITIQS_BACKEND : "https://brazen-snail-591.convex.cloud";

/** The page layer protocol channel between the side panel and the page. */
export const CHANNEL = "critiqs-extension";

/** The port the side panel opens to the page's content script. */
export const PANEL_PORT = "critiqs:panel";

/** The port the Mockup tab opens to the page's content script: a page layer of its own, beside the side panel's. */
export const MOCKUP_PORT = "critiqs:mockup";

/** What the content script tells a side panel's port before another panel for the tab takes over the page layer. */
export const REPLACED = { type: "critiqs:replaced" } as const;

export function isReplaced(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === REPLACED.type;
}

/** The side panel's page, for one tab, and the comment to open first when a pin opened it. */
export const panelPath = (tabId: number, threadId?: string) =>
  `panel.html?${new URLSearchParams({ tab: String(tabId), ...(threadId === undefined ? {} : { thread: threadId }) })}`;

/** The Mockup tab for one tab's page and project, opened on a mockup's thread when one is asked for. */
export const mockupPath = (tabId: number, projectId: string, request: { mockupId: string; threadId: string | null } | null) =>
  `mockup.html?${new URLSearchParams({
    tab: String(tabId),
    project: projectId,
    ...(request === null ? {} : { mockup: request.mockupId }),
    ...(request?.threadId == null ? {} : { thread: request.threadId }),
  })}`;

/** Messages the content script sends the worker and the side panel. */
export type PageMessage =
  /** A page layer is listening in this tab; an open side panel connects to it. */
  | { type: "critiqs:page-ready" }
  /** This page has Critiqs installed, so the extension stays out of the way. */
  | { type: "critiqs:built-in" }
  /** On a site with comments shown automatically: what to draw, with no side panel open. */
  | { type: "critiqs:auto-pins" }
  /** A pin was clicked with no side panel open. */
  | { type: "critiqs:open-panel"; threadId: string };

export function isPageMessage(value: unknown): value is PageMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (type === "critiqs:open-panel") return typeof (value as { threadId?: unknown }).threadId === "string";
  return type === "critiqs:page-ready" || type === "critiqs:built-in" || type === "critiqs:auto-pins";
}

/** What the worker knows about a tab, in session storage, for the side panel to read. */
export interface TabState {
  /** The page has Critiqs installed. */
  builtIn?: boolean;
  /** Why the page layer couldn't be added after the last click, such as a page Chrome protects. */
  refused?: string;
}

export const tabKey = (tabId: number) => `tab:${tabId}`;
