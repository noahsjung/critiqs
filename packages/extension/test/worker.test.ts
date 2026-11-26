import { expect, test } from "bun:test";
import { sessionKey } from "../src/session.ts";
import { showAutomatically } from "../src/site-access.ts";
import { startWorker } from "../src/worker.ts";
import { fakeChrome, settle } from "./fake-chrome.ts";

const tab = { id: 7, windowId: 1, active: true, url: "https://acme-proto.vercel.app/" };
const fromPage = (frameId = 0) => ({ tab, frameId });

test("the icon opens the panel itself, so Chrome dispatches the click (and grants the page) to the worker", () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  expect(chrome.calls).toContain('sidePanel.setPanelBehavior {"openPanelOnActionClick":false}');
});

test("a click opens the side panel for that tab before anything waits, then adds the page layer", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  chrome.calls.length = 0;
  chrome.action.onClicked.fire(tab);
  // Chrome allows opening the panel only during the click itself: both calls go out in the same turn.
  expect(chrome.calls.slice(0, 2)).toEqual(['sidePanel.setOptions {"tabId":7,"path":"panel.html?tab=7","enabled":true}', 'sidePanel.open {"tabId":7}']);
  await settle();
  expect(chrome.calls).toContain("scripting.executeScript 7 page.js");
  expect(chrome.storage.session.items.get("tab:7")).toEqual({});
});

test("a page Chrome won't let the extension use is noted for the panel, which says so instead of waiting", async () => {
  const chrome = fakeChrome();
  chrome.behavior.executeScript = async () => {
    throw new Error("Cannot access a chrome:// URL");
  };
  startWorker(chrome, "https://backend.convex.cloud");
  chrome.action.onClicked.fire({ ...tab, url: undefined });
  await settle();
  expect(chrome.storage.session.items.get("tab:7")).toEqual({ refused: "Cannot access a chrome:// URL" });
});

test("a page with Critiqs installed marks the tab Built in; a message from a frame inside the page is ignored", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  chrome.runtime.onMessage.fire({ type: "critiqs:built-in" }, fromPage(3), () => {});
  await settle();
  expect(chrome.storage.session.items.get("tab:7")).toBeUndefined();
  chrome.runtime.onMessage.fire({ type: "critiqs:built-in" }, fromPage(), () => {});
  await settle();
  expect(chrome.storage.session.items.get("tab:7")).toEqual({ builtIn: true });
  expect(chrome.calls).toContain("action.setTitle 7 Critiqs: Built in. This site has Critiqs installed.");
});

test("a new page in the tab forgets what the worker noted about the last one", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  chrome.runtime.onMessage.fire({ type: "critiqs:built-in" }, fromPage(), () => {});
  await settle();
  chrome.tabs.onUpdated.fire(7, { status: "loading" }, tab);
  await settle();
  expect(chrome.storage.session.items.get("tab:7")).toBeUndefined();
  expect(chrome.calls).toContain("action.setBadgeText 7 ");
});

test("a pin clicked with no side panel open asks Chrome to open it for that tab", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  let answer: unknown;
  const async = chrome.runtime.onMessage.fire({ type: "critiqs:open-panel", threadId: "t1" }, fromPage(), (value) => (answer = value));
  expect(async).toEqual([true]);
  await settle();
  // The panel opens on that pin's comment, named in its own address in the same go.
  expect(chrome.calls.slice(-2)).toEqual(['sidePanel.setOptions {"tabId":7,"path":"panel.html?tab=7&thread=t1","enabled":true}', 'sidePanel.open {"tabId":7}']);
  expect(answer).toEqual({ opened: true });
  // A click on the icon later opens the panel without it.
  chrome.action.onClicked.fire(tab);
  expect(chrome.calls).toContain('sidePanel.setOptions {"tabId":7,"path":"panel.html?tab=7","enabled":true}');
});

test("pins with no panel open need the site's own access: without it the worker answers with nothing to draw", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  let answer: unknown;
  chrome.runtime.onMessage.fire({ type: "critiqs:auto-pins" }, fromPage(), (value) => (answer = value));
  await settle();
  expect(answer).toEqual({ display: null });
});

test("messages that aren't the content script's, or come from no tab, get no answer", () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  expect(chrome.runtime.onMessage.fire({ type: "critiqs:open-panel" }, fromPage(), () => {})).toEqual([undefined]);
  expect(chrome.runtime.onMessage.fire({ type: "critiqs:auto-pins" }, { frameId: 0 }, () => {})).toEqual([undefined]);
  expect(chrome.runtime.onMessage.fire({ type: "something-else" }, fromPage(), () => {})).toEqual([undefined]);
});

test("an answer about the last page that lands after the tab loaded another one doesn't stick to the new page", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  // The old page's Built in note is still being written when the tab starts loading the next page.
  const get = chrome.storage.session.get.bind(chrome.storage.session);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  chrome.storage.session.get = async (keys) => (await held, get(keys));
  chrome.runtime.onMessage.fire({ type: "critiqs:built-in" }, fromPage(), () => {});
  chrome.tabs.onUpdated.fire(7, { status: "loading" }, tab);
  release();
  await settle(10);
  expect(chrome.storage.session.items.get("tab:7")).toBeUndefined();
});

test("a page layer starting in the tab clears an old page's Built in note", async () => {
  const chrome = fakeChrome();
  startWorker(chrome, "https://backend.convex.cloud");
  chrome.runtime.onMessage.fire({ type: "critiqs:built-in" }, fromPage(), () => {});
  await settle();
  chrome.runtime.onMessage.fire({ type: "critiqs:page-ready" }, fromPage(), () => {});
  await settle();
  expect(chrome.storage.session.items.get("tab:7")).toEqual({});
});

test("pins with no panel open aren't read from a backend the panel refuses as too old", async () => {
  const realFetch = globalThis.fetch;
  const signIn = "https://backend.convex.site";
  const asked: string[] = [];
  let flags: Record<string, boolean> = { addressLists: true };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: signIn, protocol: 5, transport: "convex", ...flags });
    asked.push(JSON.parse(String(init?.body)).path);
    return Response.json({ status: "success", value: { status: "none" }, logLines: [] });
  }) as typeof fetch;
  try {
    for (const current of [false, true]) {
      flags = current ? { addressLists: true, addressEdits: true, createKeys: true } : { addressLists: true };
      asked.length = 0;
      const chrome = fakeChrome();
      expect(await showAutomatically(chrome, "https://acme-proto.vercel.app")).toBe(true);
      const accessToken = `h.${btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" })).replace(/=+$/, "")}.a1`;
      chrome.storage.local.items.set(sessionKey(signIn), {
        accessToken,
        refreshToken: "r1",
        expiresAt: Date.now() + 15 * 60_000,
        sessionEndsAt: Date.now() + 86_400_000,
        reviewer: { id: "dana", name: "Dana", email: "dana@example.com" },
      });
      startWorker(chrome, "https://backend.convex.cloud");
      let answer: unknown;
      chrome.runtime.onMessage.fire({ type: "critiqs:auto-pins" }, fromPage(), (value) => (answer = value));
      for (let wait = 0; wait < 50 && answer === undefined; wait++) await Bun.sleep(5);
      expect(answer).toEqual({ display: null });
      // A current backend is asked for the page's project; an older one is asked nothing.
      expect(asked).toEqual(current ? ["projects:findForOrigin"] : []);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
