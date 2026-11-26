import type { ChromeApi } from "./chrome.ts";
import { mockupPath } from "./config.ts";

/**
 * Mockup mode for the extension. Its copy of the page covers a window, and a
 * side panel has no page beneath it to cover, so Mockup mode opens in a tab
 * of its own beside the reviewed tab: the Mockup tab. It freezes the reviewed
 * tab's page through a page layer of its own there (`MOCKUP_PORT`), and
 * leaving Mockup mode closes it and goes back to the reviewed tab.
 */

type Tabs = Pick<ChromeApi, "tabs" | "runtime">;
type Request = { mockupId: string; threadId: string | null } | null;

/**
 * Opens the Mockup tab for the reviewed tab and project, beside it, or shows
 * the one this side panel already opened, on the mockup asked for.
 */
export function mockupTabs(chrome: Tabs, tabId: number, projectId: string): (request: Request) => Promise<void> {
  let opened: number | null = null;
  return async (request) => {
    const url = chrome.runtime.getURL(mockupPath(tabId, projectId, request));
    if (opened !== null) {
      const shown = await chrome.tabs.update!(opened, { url, active: true }).catch(() => null);
      if (shown !== null) return;
    }
    const reviewed = await chrome.tabs.get(tabId);
    const created = await chrome.tabs.create!({ url, windowId: reviewed.windowId, openerTabId: tabId, active: true, ...(reviewed.index === undefined ? {} : { index: reviewed.index + 1 }) });
    opened = created.id ?? null;
  };
}

/** Leaves Mockup mode: closes the Mockup tab, back on the reviewed tab and its side panel. */
export async function leaveMockupTab(chrome: Tabs, tabId: number): Promise<void> {
  await chrome.tabs.update!(tabId, { active: true }).catch(() => undefined);
  const current = await chrome.tabs.getCurrent!().catch(() => undefined);
  if (current?.id !== undefined) await chrome.tabs.remove!(current.id);
}
