import { expect, test } from "bun:test";
import type { Tab } from "../src/chrome.ts";
import { leaveMockupTab, mockupTabs } from "../src/mockup-tab.ts";
import { fakeChrome } from "./fake-chrome.ts";

// The Mockup tab: Mockup mode beside the reviewed tab, since a side panel has no page beneath it to cover.

function tabsChrome() {
  const chrome = fakeChrome();
  const open = new Map<number, Tab>([[7, { id: 7, windowId: 2, index: 3, active: true }]]);
  let next = 100;
  chrome.behavior.tab = (tabId) => open.get(tabId)!;
  chrome.tabs.create = async (properties) => {
    chrome.calls.push(`tabs.create ${JSON.stringify(properties)}`);
    const tab = { id: next++, windowId: properties.windowId ?? 1, index: properties.index, active: true };
    open.set(tab.id, tab);
    return tab;
  };
  chrome.tabs.update = async (tabId, properties) => {
    chrome.calls.push(`tabs.update ${tabId} ${JSON.stringify(properties)}`);
    const tab = open.get(tabId);
    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  };
  chrome.tabs.remove = async (tabId) => {
    chrome.calls.push(`tabs.remove ${tabId}`);
    open.delete(tabId);
  };
  return { chrome, open };
}

test("opens beside the reviewed tab, for its page and project, then shows that same tab on the mockup asked for", async () => {
  const { chrome } = tabsChrome();
  const open = mockupTabs(chrome, 7, "project-1");
  await open(null);
  expect(chrome.calls.at(-1)).toBe(`tabs.create ${JSON.stringify({ url: "chrome-extension://pfdpnmmiemejphfghkalofichdcoandg/mockup.html?tab=7&project=project-1", windowId: 2, openerTabId: 7, active: true, index: 4 })}`);
  await open({ mockupId: "m1", threadId: "t1" });
  expect(chrome.calls.at(-1)).toBe(`tabs.update 100 ${JSON.stringify({ url: "chrome-extension://pfdpnmmiemejphfghkalofichdcoandg/mockup.html?tab=7&project=project-1&mockup=m1&thread=t1", active: true })}`);
  expect(chrome.calls.filter((call) => call.startsWith("tabs.create"))).toHaveLength(1);
});

test("a Mockup tab the person closed is opened again", async () => {
  const { chrome, open: tabs } = tabsChrome();
  const open = mockupTabs(chrome, 7, "project-1");
  await open(null);
  tabs.delete(100);
  await open({ mockupId: "m1", threadId: null });
  expect(chrome.calls.at(-1)).toContain("tabs.create");
  expect(chrome.calls.at(-1)).toContain("mockup.html?tab=7&project=project-1&mockup=m1");
});

test("leaving Mockup mode goes back to the reviewed tab and closes the Mockup tab", async () => {
  const { chrome } = tabsChrome();
  chrome.tabs.getCurrent = async () => ({ id: 100, windowId: 2, active: true });
  await leaveMockupTab(chrome, 7);
  expect(chrome.calls.slice(-2)).toEqual([`tabs.update 7 ${JSON.stringify({ active: true })}`, "tabs.remove 100"]);
});
