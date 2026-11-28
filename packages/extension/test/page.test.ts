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

test("the Mockup tab's port gets a page layer of its own, beside the side panel's, and only it goes when the tab closes", async () => {
  const chrome = fakeChrome();
  stop = startPage(chrome, document).stop;
  const [panel, panelEnd] = fakePorts("critiqs:panel");
  chrome.runtime.onConnect.fire(panelEnd);
  await settle(10);
  const [mockups, mockupEnd] = fakePorts("critiqs:mockup");
  const heard: unknown[] = [];
  mockups.onMessage.addListener((message) => heard.push(message));
  chrome.runtime.onConnect.fire(mockupEnd);
  await settle(10);
  expect(hosts()).toBe(2);
  expect(heard.some((message) => (message as { event?: string }).event === "ready")).toBe(true);
  // The side panel keeps its page layer: the Mockup tab doesn't take it over.
  expect(panel.disconnected).toBe(false);
  mockups.disconnect();
  await settle(10);
  expect(hosts()).toBe(1);
  expect(panel.disconnected).toBe(false);
});

test("a second Mockup tab replaces the first one's page layer", async () => {
  const chrome = fakeChrome();
  stop = startPage(chrome, document).stop;
  const [first, firstEnd] = fakePorts("critiqs:mockup");
  chrome.runtime.onConnect.fire(firstEnd);
  await settle(10);
  const [, secondEnd] = fakePorts("critiqs:mockup");
  chrome.runtime.onConnect.fire(secondEnd);
  await settle(10);
  expect(first.disconnected).toBe(true);
  expect(hosts()).toBe(1);
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

const pinsAnswer = { display: { hidden: false, exposedRight: null, watch: [], pins: [], selected: null, highlight: null, picking: null, picked: null } };

/** Chrome's storage as a content script sees it once the worker has locked it: every use refused. */
function lockedStorage(chrome: ReturnType<typeof fakeChrome>) {
  const refuse = () => {
    chrome.storageCalls.push("refused");
    throw new Error("Access to storage is not allowed from this context.");
  };
  const area = { get: refuse, set: refuse, remove: refuse, setAccessLevel: refuse };
  Object.assign(chrome, { storage: { local: area, session: area, onChanged: { addListener: refuse, removeListener: refuse } } });
}

/** The worker telling this tab the reviewer or the site's automatic comments changed. */
const sessionChanged = (chrome: ReturnType<typeof fakeChrome>, sender: { id?: string } = { id: chrome.runtime.id }) =>
  chrome.runtime.onMessage.fire({ type: "critiqs:session-changed" }, sender, () => {});

test("case 8: the content script never uses extension storage, and with it locked still shows pins and follows sign-in and sign-out", async () => {
  const chrome = fakeChrome();
  lockedStorage(chrome);
  let signedIn = true;
  chrome.runtime.sendMessage = async (message) => {
    chrome.calls.push(`runtime.sendMessage ${JSON.stringify(message)}`);
    if ((message as { type: string }).type !== "critiqs:auto-pins") return undefined;
    return signedIn ? pinsAnswer : { display: null };
  };
  stop = startPage(chrome, document).stop;
  await settle(10);
  expect(hosts()).toBe(1);
  // Signed out (here, in the side panel, or in another tab): the worker says so, and the pins go.
  signedIn = false;
  sessionChanged(chrome);
  await settle(10);
  expect(hosts()).toBe(0);
  // Signed in again: the pins come back.
  signedIn = true;
  sessionChanged(chrome);
  await settle(10);
  expect(hosts()).toBe(1);
  stop();
  stop = null;
  expect(chrome.storageCalls).toEqual([]);
});

test("pins shown on their own go away when the worker says the session or the site's automatic comments changed", async () => {
  const chrome = fakeChrome();
  let allowed = true;
  chrome.runtime.sendMessage = async (message) => {
    if ((message as { type: string }).type !== "critiqs:auto-pins") return undefined;
    return allowed ? pinsAnswer : { display: null };
  };
  stop = startPage(chrome, document).stop;
  await settle(10);
  expect(hosts()).toBe(1);
  allowed = false;
  // Storage changes no longer reach the content script; only the worker's message counts.
  await chrome.storage.local.set({ "sites-changed": 1 });
  await settle(10);
  expect(hosts()).toBe(1);
  // A message that isn't from this extension changes nothing.
  sessionChanged(chrome, { id: "another-extension" });
  await settle(10);
  expect(hosts()).toBe(1);
  sessionChanged(chrome);
  await settle(10);
  expect(hosts()).toBe(0);
});
