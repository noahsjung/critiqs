import { afterEach, expect, test } from "bun:test";
import { startPage } from "../src/page.ts";
import { fakeChrome, fakePorts, settle } from "./fake-chrome.ts";

// The content script in the reviewer's tab.

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

const sent = (chrome: ReturnType<typeof fakeChrome>) => chrome.calls.filter((call) => call.startsWith("runtime.sendMessage")).map((call) => JSON.parse(call.slice("runtime.sendMessage ".length)).type);
const hosts = () => document.querySelectorAll("critiqs-root").length;

test("on a page with Critiqs installed the extension adds nothing and says Built in", async () => {
  document.body.innerHTML = "<main>App</main><critiqs-app project-id=\"p\"></critiqs-app>";
  const chrome = fakeChrome();
  stop = startPage(chrome, document).stop;
  await settle();
  expect(sent(chrome)).toEqual(["critiqs:built-in"]);
  expect(chrome.runtime.onConnect.count()).toBe(0);
  expect(hosts()).toBe(0);
});

test("the side panel's port gets a page layer; when the panel closes, nothing of it stays on the page", async () => {
  const chrome = fakeChrome();
  stop = startPage(chrome, document).stop;
  await settle();
  expect(sent(chrome)).toEqual(["critiqs:page-ready", "critiqs:auto-pins"]);
  expect(hosts()).toBe(0);
  const [panel, page] = fakePorts("critiqs:panel");
  const heard: unknown[] = [];
  panel.onMessage.addListener((message) => heard.push(message));
  chrome.runtime.onConnect.fire(page);
  await settle(10);
  expect(hosts()).toBe(1);
  // The page layer says it is ready, over the port.
  expect(heard.some((message) => (message as { event?: string }).event === "ready")).toBe(true);
  panel.disconnect();
  await settle(10);
  expect(hosts()).toBe(0);
});

test("ports that aren't the side panel's are ignored", async () => {
  const chrome = fakeChrome();
  stop = startPage(chrome, document).stop;
  const [, page] = fakePorts("something-else");
  chrome.runtime.onConnect.fire(page);
  await settle(10);
  expect(hosts()).toBe(0);
});

test("a site whose own Critiqs starts after the extension's page layer gets the page back", async () => {
  const chrome = fakeChrome();
  stop = startPage(chrome, document).stop;
  const [panel, page] = fakePorts("critiqs:panel");
  chrome.runtime.onConnect.fire(page);
  await settle(10);
  expect(hosts()).toBe(1);
  // The app mounts its own Critiqs, as an installed site does once it has loaded.
  const app = document.createElement("div");
  app.innerHTML = "<critiqs-root></critiqs-root>";
  document.body.append(app);
  await settle(10);
  expect(sent(chrome)).toContain("critiqs:built-in");
  expect(panel.disconnected).toBe(true);
  expect(hosts()).toBe(1);
  expect(chrome.runtime.onConnect.count()).toBe(0);
});

test("on a site whose comments show automatically, pins come without a panel; the panel takes over when it opens", async () => {
  const chrome = fakeChrome();
  chrome.runtime.sendMessage = async (message) => {
    chrome.calls.push(`runtime.sendMessage ${JSON.stringify(message)}`);
    if ((message as { type: string }).type !== "critiqs:auto-pins") return undefined;
    return { display: { hidden: false, exposedRight: null, watch: [], pins: [], selected: null, highlight: null, picking: null, picked: null } };
  };
  stop = startPage(chrome, document).stop;
  await settle(10);
  expect(hosts()).toBe(1);
  const [panel, page] = fakePorts("critiqs:panel");
  chrome.runtime.onConnect.fire(page);
  await settle(10);
  // Still one page layer: the panel's replaced the one drawing pins on its own.
  expect(hosts()).toBe(1);
  // The panel closes: pins on their own come back.
  panel.disconnect();
  await settle(20);
  expect(hosts()).toBe(1);
  expect(sent(chrome).filter((type) => type === "critiqs:auto-pins")).toHaveLength(2);
});

test("pins shown on their own go away when the person signs out or stops showing comments on the site", async () => {
  const changes: ({ remove: string } | { set: Record<string, unknown> })[] = [{ remove: "session:https://signin.example" }, { set: { "signed-out:https://signin.example": "mark" } }, { set: { "sites-changed": 1 } }];
  for (const change of changes) {
    const chrome = fakeChrome();
    let allowed = true;
    chrome.runtime.sendMessage = async (message) => {
      if ((message as { type: string }).type !== "critiqs:auto-pins") return undefined;
      return { display: allowed ? { hidden: false, exposedRight: null, watch: [], pins: [], selected: null, highlight: null, picking: null, picked: null } : null };
    };
    chrome.storage.local.items.set("session:https://signin.example", { any: true });
    stop = startPage(chrome, document).stop;
    await settle(10);
    expect(hosts()).toBe(1);
    allowed = false;
    if ("remove" in change) await chrome.storage.local.remove(change.remove);
    else await chrome.storage.local.set(change.set);
    await settle(10);
    expect(hosts()).toBe(0);
    stop();
    stop = null;
  }
});

