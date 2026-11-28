import type { ChromeApi } from "./chrome.ts";

/**
 * Real-pixel screenshots for new comments: Chrome's `captureVisibleTab`, so
 * canvases, video, and frames appear as on screen. Chrome allows it only
 * after the person clicked the Critiqs icon on this page (or allowed every
 * site), and nothing here assumes it does: each screenshot is tried, and a
 * refusal hands the comment to the page's own capture. The first refusal
 * tells the person, once, how to get real pixels.
 */
export function tabScreenshots(chrome: Pick<ChromeApi, "tabs">, tabId: number, onFirstRefusal: () => void): () => Promise<Blob | null> {
  let told = false;
  return async () => {
    try {
      const dataUrl = await captureTab(chrome, tabId);
      return dataUrl === null ? null : dataUrlBlob(dataUrl);
    } catch {
      if (!told) {
        told = true;
        onFirstRefusal();
      }
      return null;
    }
  };
}

/**
 * Chrome's PNG of one tab, as a data URL: null when the picture may be of
 * another tab (the person switched tabs while Chrome took it). Throws when
 * Chrome refuses, or when another tab is in front of this one in its window.
 */
export async function captureTab(chrome: Pick<ChromeApi, "tabs">, tabId: number): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId);
  // Chrome captures what its window shows; another tab in front isn't this page.
  if (!tab.active) throw new Error("The page isn't the tab shown in its window.");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  // Chrome captures whichever tab its window shows when the screenshot runs. If the person
  // switched tabs meanwhile, even away and back, the picture may be of another tab.
  const after = await chrome.tabs.get(tabId);
  // Not Chrome refusing: the next comment's screenshot may well work, so there's nothing to tell.
  if (tab.lastAccessed === undefined || !after.active || after.windowId !== tab.windowId || after.lastAccessed !== tab.lastAccessed) return null;
  return dataUrl;
}

function dataUrlBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (match === null) throw new Error("Chrome's screenshot wasn't an image.");
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}
