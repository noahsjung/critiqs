import { expect, test } from "bun:test";
import { tabScreenshots } from "../src/capture.ts";
import { fakeChrome } from "./fake-chrome.ts";

test("a screenshot Chrome allows comes back as an image of the tab's window", async () => {
  const chrome = fakeChrome();
  let told = 0;
  const image = await tabScreenshots(chrome, 7, () => told++)();
  expect(image?.type).toBe("image/png");
  expect(await image?.text()).toBe("png");
  expect(chrome.calls).toEqual(["tabs.captureVisibleTab 1 png"]);
  expect(told).toBe(0);
});

test("a refused screenshot falls back to the page's own capture, and the person is told once", async () => {
  const chrome = fakeChrome();
  chrome.behavior.capture = async () => {
    throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  };
  let told = 0;
  const take = tabScreenshots(chrome, 7, () => told++);
  expect(await take()).toBeNull();
  expect(await take()).toBeNull();
  expect(told).toBe(1);
});

test("with another tab in front, nothing is captured, since Chrome would capture that tab", async () => {
  const chrome = fakeChrome();
  chrome.behavior.tab = (tabId) => ({ id: tabId, windowId: 1, active: false });
  expect(await tabScreenshots(chrome, 7, () => {})()).toBeNull();
  expect(chrome.calls).toEqual([]);
});

test("a screenshot taken while the person switched tabs is thrown away, since it may show the other tab", async () => {
  for (const after of [
    { active: false, lastAccessed: 1 },
    // Switched away and back: the tab was activated again during the screenshot.
    { active: true, lastAccessed: 2 },
  ]) {
    const chrome = fakeChrome();
    let reads = 0;
    chrome.behavior.tab = (tabId) => ({ id: tabId, windowId: 1, ...(reads++ === 0 ? { active: true, lastAccessed: 1 } : after) });
    let told = 0;
    expect(await tabScreenshots(chrome, 7, () => told++)()).toBeNull();
    expect(chrome.calls).toEqual(["tabs.captureVisibleTab 1 png"]);
    // Chrome didn't refuse, so the note about clicking the icon would be wrong.
    expect(told).toBe(0);
  }
});

test("a screenshot is kept only when the tab can be shown to have stayed in front, so a browser that can't say isn't trusted", async () => {
  const chrome = fakeChrome();
  chrome.behavior.tab = (tabId) => ({ id: tabId, windowId: 1, active: true });
  expect(await tabScreenshots(chrome, 7, () => {})()).toBeNull();
});
