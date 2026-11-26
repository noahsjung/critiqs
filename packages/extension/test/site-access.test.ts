import { expect, test } from "bun:test";
import { SITES_CHANGED, showAutomatically, showsAutomatically, siteScriptId, sitePattern, stopShowingAutomatically } from "../src/site-access.ts";
import { fakeChrome } from "./fake-chrome.ts";

const ORIGIN = "http://localhost:5173";

test("turning it on asks Chrome for this one site, then registers the page layer for every page of it", async () => {
  const chrome = fakeChrome();
  expect(await showAutomatically(chrome, ORIGIN)).toBe(true);
  expect(chrome.calls[0]).toBe("permissions.request http://localhost:5173/*");
  expect([...chrome.registered.values()]).toEqual([
    { id: siteScriptId(ORIGIN), matches: ["http://localhost:5173/*"], js: ["page.js"], runAt: "document_idle", persistAcrossSessions: true, allFrames: false },
  ]);
  expect(await showsAutomatically(chrome, ORIGIN)).toBe(true);
  // Another site is untouched.
  expect(await showsAutomatically(chrome, "http://localhost:3000")).toBe(false);
});

test("when Chrome's question is declined nothing is registered", async () => {
  const chrome = fakeChrome();
  chrome.behavior.permissionRequest = () => false;
  expect(await showAutomatically(chrome, ORIGIN)).toBe(false);
  expect(chrome.registered.size).toBe(0);
});

test("a registration that fails gives the site's access back", async () => {
  const chrome = fakeChrome();
  chrome.behavior.registerFails = true;
  expect(await showAutomatically(chrome, ORIGIN)).toBe(false);
  expect(chrome.granted.size).toBe(0);
  expect(chrome.calls).toContain("permissions.remove http://localhost:5173/*");
});

test("turning it on twice keeps one registration", async () => {
  const chrome = fakeChrome();
  await showAutomatically(chrome, ORIGIN);
  expect(await showAutomatically(chrome, ORIGIN)).toBe(true);
  expect(chrome.registered.size).toBe(1);
});

test("turning it off removes the script and the site's access", async () => {
  const chrome = fakeChrome();
  await showAutomatically(chrome, ORIGIN);
  await stopShowingAutomatically(chrome, ORIGIN);
  expect(chrome.registered.size).toBe(0);
  expect(chrome.granted.size).toBe(0);
  expect(await showsAutomatically(chrome, ORIGIN)).toBe(false);
});

test("a site whose access the person removed in Chrome's settings no longer counts as on", async () => {
  const chrome = fakeChrome();
  await showAutomatically(chrome, ORIGIN);
  chrome.granted.delete(sitePattern(ORIGIN));
  expect(await showsAutomatically(chrome, ORIGIN)).toBe(false);
});

test("each origin gets its own script ID, made only of characters Chrome accepts", () => {
  expect(siteScriptId("https://a.dev")).not.toBe(siteScriptId("https://b.dev"));
  expect(siteScriptId("http://localhost:5173")).toMatch(/^critiqs-site-[0-9a-f]+$/);
});

test("turning it on or off tells pages already open on the site to check again", async () => {
  const chrome = fakeChrome();
  await showAutomatically(chrome, ORIGIN);
  const first = chrome.storage.local.items.get(SITES_CHANGED);
  expect(first).toBeNumber();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await stopShowingAutomatically(chrome, ORIGIN);
  expect(chrome.storage.local.items.get(SITES_CHANGED)).not.toBe(first);
});
