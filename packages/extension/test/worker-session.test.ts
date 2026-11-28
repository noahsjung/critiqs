import { afterEach, expect, test } from "bun:test";
import { panelSignIn } from "@critiqs/core";
import type { MessageSender, Tab } from "../src/chrome.ts";
import { SESSION_CHANGED } from "../src/overlay-protocol.ts";
import { ExtensionSession, sessionKey } from "../src/session.ts";
import { showAutomatically } from "../src/site-access.ts";
import { startWorker } from "../src/worker.ts";
import { accessToken, BACKEND, DEVELOPMENT_CODE, type FakeBackend, fakeBackend, project, SIGN_IN } from "./fake-backend.ts";
import { type FakeChrome, fakeChrome, settle } from "./fake-chrome.ts";

// The worker as the only holder of the sign-in: what it answers Critiqs drawn
// on a page (a content script), and to whom. Each test names the acceptance
// case it proves.

const ORIGIN = "https://acme-proto.vercel.app";
const tabOf = (id: number, url = `${ORIGIN}/users/42`, extra: Partial<Tab> = {}): Tab => ({ id, windowId: 1, active: true, lastAccessed: 1, url, ...extra });

let backend: FakeBackend | null = null;
afterEach(() => {
  backend?.restore();
  backend = null;
});

/** Chrome with these tabs open, and a worker started in it. */
function setUp(tabs: Tab[] = [tabOf(7)], options: { now?: () => number } = {}) {
  backend = fakeBackend();
  const chrome = fakeChrome();
  const byId = new Map(tabs.map((tab) => [tab.id!, tab]));
  chrome.behavior.tab = (tabId) => byId.get(tabId) ?? tabOf(tabId);
  chrome.behavior.tabs = () => [...byId.values()];
  startWorker(chrome, BACKEND, options);
  return { chrome, backend, tabs: byId };
}

/** The content script in a tab's top page, as Chrome describes the sender. */
const fromTab = (chrome: FakeChrome, tab: Tab, extra: Partial<MessageSender> = {}): MessageSender => ({ id: chrome.runtime.id, frameId: 0, tab, ...extra });

/** Sends one message to the worker as Chrome would, and waits for its answer. */
async function ask(chrome: FakeChrome, message: unknown, sender: MessageSender): Promise<any> {
  let answer: unknown;
  let answered = false;
  chrome.runtime.onMessage.fire(message, sender, (value) => {
    answer = value;
    answered = true;
  });
  for (let wait = 0; wait < 200 && !answered; wait++) await Bun.sleep(2);
  return answered ? answer : "no answer";
}

/** The person clicks the icon on a tab: the worker adds Critiqs to it. */
async function clickIcon(chrome: FakeChrome, tab: Tab) {
  chrome.action.onClicked.fire(tab);
  await settle(10);
}

const storedSession = (extra: Record<string, unknown> = {}) => ({
  accessToken: accessToken("Dana", 0),
  refreshToken: `stored-refresh-${"s".repeat(40)}`,
  expiresAt: Date.now() + 15 * 60_000,
  sessionEndsAt: Date.now() + 86_400_000,
  reviewer: { id: "dana", name: "Dana", email: "dana@example.com" },
  ...extra,
});
const signIn = (chrome: FakeChrome, extra: Record<string, unknown> = {}) => chrome.storage.local.items.set(sessionKey(SIGN_IN), storedSession(extra));

// ---------------------------------------------------------------------------
// 1. The storage lock

test("case 1: the worker's first use of storage locks it to trusted contexts, and a restart locks it again", async () => {
  const { chrome } = setUp();
  expect(chrome.storageCalls[0]).toBe("local.setAccessLevel TRUSTED_CONTEXTS");
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(7)));
  expect(chrome.storageCalls.filter((call) => call.startsWith("local.setAccessLevel"))).toEqual(["local.setAccessLevel TRUSTED_CONTEXTS"]);
  // Chrome stops the worker and starts it again: the same storage, a new start.
  startWorker(chrome, BACKEND);
  expect(chrome.storageCalls.filter((call) => call.startsWith("local.setAccessLevel"))).toHaveLength(2);
});

test("case 1: no request is answered, and nothing is read, before the lock has taken", async () => {
  backend = fakeBackend();
  const chrome = fakeChrome();
  let release!: () => void;
  const locking = new Promise<void>((resolve) => (release = resolve));
  chrome.storage.local.setAccessLevel = async ({ accessLevel }) => {
    chrome.storageCalls.push(`local.setAccessLevel ${accessLevel}`);
    await locking;
  };
  signIn(chrome);
  startWorker(chrome, BACKEND);
  chrome.action.onClicked.fire(tabOf(7));
  let answered = false;
  chrome.runtime.onMessage.fire({ type: "critiqs:token", force: false }, fromTab(chrome, tabOf(7)), () => (answered = true));
  await settle(10);
  expect(answered).toBe(false);
  expect(chrome.storageCalls).toEqual(["local.setAccessLevel TRUSTED_CONTEXTS"]);
  release();
  for (let wait = 0; wait < 100 && !answered; wait++) await Bun.sleep(2);
  expect(answered).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. The session view

test("case 2: critiqs:session answers the reviewer and no token; signed out it answers null", async () => {
  const { chrome } = setUp();
  const pending = "p".repeat(43);
  signIn(chrome, { nextRefreshToken: pending });
  await clickIcon(chrome, tabOf(7));
  const answer = await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(7)));
  expect(answer).toEqual({ reviewer: { id: "dana", name: "Dana", email: "dana@example.com" } });
  const json = JSON.stringify(answer);
  const stored = storedSession();
  for (const secret of [stored.accessToken, stored.refreshToken, pending]) expect(json).not.toContain(secret);
  // Signed out elsewhere: Chrome tells the worker the session left storage.
  await chrome.storage.local.remove(sessionKey(SIGN_IN));
  await settle(10);
  expect(await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(7)))).toEqual({ reviewer: null });
});

// ---------------------------------------------------------------------------
// 3. Access tokens, and to whom

test("case 3: an access token goes to the top frame of a tab Critiqs was opened in, and force renews it", async () => {
  const { chrome, backend } = setUp();
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  expect(await ask(chrome, { type: "critiqs:token", force: false }, fromTab(chrome, tabOf(7)))).toEqual({ token: storedSession().accessToken });
  const renewed = await ask(chrome, { type: "critiqs:token", force: true }, fromTab(chrome, tabOf(7)));
  expect(renewed.token).not.toBe(storedSession().accessToken);
  expect(renewed.token).toBe(accessToken("Dana", 1));
  expect(backend.requests.filter((request) => request.url === `${SIGN_IN}/auth/refresh`)).toHaveLength(1);
});

test("case 3: a frame, another extension, a tab Critiqs isn't open in, a message with no tab: each is refused, with no token", async () => {
  const { chrome } = setUp([tabOf(7), tabOf(8)]);
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  const token = { type: "critiqs:token", force: false };
  const senders: [string, MessageSender][] = [
    ["a frame inside the page", fromTab(chrome, tabOf(7), { frameId: 3 })],
    ["another extension", fromTab(chrome, tabOf(7), { id: "abcdefghijklmnopabcdefghijklmnop" })],
    ["a tab Critiqs isn't open in", fromTab(chrome, tabOf(8))],
    ["no tab", { id: chrome.runtime.id, frameId: 0 }],
    ["no extension ID", { frameId: 0, tab: tabOf(7) }],
  ];
  for (const [, sender] of senders) {
    const answer = await ask(chrome, token, sender);
    expect(typeof answer.refused).toBe("string");
    expect(JSON.stringify(answer)).not.toContain("eyJ");
  }
});

test("case 3: the tab's grant is for the site Critiqs was opened on: the same tab on another site gets no token", async () => {
  const { chrome } = setUp();
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  const elsewhere = tabOf(7, "https://evil.example/");
  const answer = await ask(chrome, { type: "critiqs:token", force: false }, fromTab(chrome, elsewhere));
  expect(answer.token).toBeUndefined();
  expect(typeof answer.refused).toBe("string");
});

test("case 3: a new page in the tab ends the grant; a refused click grants nothing", async () => {
  const { chrome } = setUp([tabOf(7), tabOf(8)]);
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  chrome.tabs.onUpdated.fire(7, { status: "loading" }, tabOf(7));
  await settle(10);
  expect(typeof (await ask(chrome, { type: "critiqs:token", force: false }, fromTab(chrome, tabOf(7)))).refused).toBe("string");
  chrome.behavior.executeScript = async () => {
    throw new Error("Cannot access a chrome:// URL");
  };
  await clickIcon(chrome, tabOf(8));
  expect(typeof (await ask(chrome, { type: "critiqs:token", force: false }, fromTab(chrome, tabOf(8)))).refused).toBe("string");
});

test("case 3: the script's first request, sent as Chrome starts it, already finds the tab open", async () => {
  const { chrome } = setUp();
  signIn(chrome);
  let first: Promise<any> | null = null;
  chrome.behavior.executeScript = async () => {
    first = ask(chrome, { type: "critiqs:token", force: false }, fromTab(chrome, tabOf(7)));
  };
  await clickIcon(chrome, tabOf(7));
  expect(await first!).toEqual({ token: storedSession().accessToken });
});

test("case 3: a tab on a site the person allowed gets a token with no click", async () => {
  const { chrome } = setUp();
  signIn(chrome);
  expect(await showAutomatically(chrome, ORIGIN)).toBe(true);
  expect(await ask(chrome, { type: "critiqs:token", force: false }, fromTab(chrome, tabOf(7)))).toEqual({ token: storedSession().accessToken });
});

// ---------------------------------------------------------------------------
// 4. Signing in through a handle

test("case 4: email answers a handle and the development code, never the attempt key; the code signs in through the handle", async () => {
  const { chrome, backend } = setUp();
  await clickIcon(chrome, tabOf(7));
  const sent = await ask(chrome, { type: "critiqs:sign-in/email", email: "Dana@example.com" }, fromTab(chrome, tabOf(7)));
  expect(sent.email).toBe("dana@example.com");
  expect(sent.developmentCode).toBe(DEVELOPMENT_CODE);
  expect(typeof sent.handle).toBe("string");
  expect(JSON.stringify(sent)).not.toContain("attempt-key");
  const signedIn = await ask(chrome, { type: "critiqs:sign-in/code", handle: sent.handle, code: DEVELOPMENT_CODE }, fromTab(chrome, tabOf(7)));
  expect(signedIn).toEqual({ status: "signed-in" });
  expect(backend.requests.find((request) => request.url.endsWith("/auth/panel/code"))?.body.attempt).toBe("attempt-key-1-secret");
  expect(await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(7)))).toEqual({ reviewer: { id: "dana", name: "Dana", email: "dana@example.com" } });
  expect((chrome.storage.local.items.get(sessionKey(SIGN_IN)) as { reviewer: { id: string } }).reviewer.id).toBe("dana");
  // Used: the same handle again is refused.
  expect(typeof (await ask(chrome, { type: "critiqs:sign-in/code", handle: sent.handle, code: DEVELOPMENT_CODE }, fromTab(chrome, tabOf(7)))).refused).toBe("string");
});

test("case 4: a wrong code answers the backend's failure with the tries left; a new person chooses a name through the handle", async () => {
  const { chrome, backend } = setUp();
  backend.newPeople.add("new@example.com");
  await clickIcon(chrome, tabOf(7));
  const sent = await ask(chrome, { type: "critiqs:sign-in/email", email: "new@example.com" }, fromTab(chrome, tabOf(7)));
  expect(await ask(chrome, { type: "critiqs:sign-in/code", handle: sent.handle, code: "000000" }, fromTab(chrome, tabOf(7)))).toEqual({ status: "failed", code: "wrong-code", message: "That code isn't right.", guessesLeft: 2 });
  expect(await ask(chrome, { type: "critiqs:sign-in/code", handle: sent.handle, code: DEVELOPMENT_CODE }, fromTab(chrome, tabOf(7)))).toEqual({ status: "needs-name" });
  expect(await ask(chrome, { type: "critiqs:sign-in/name", handle: sent.handle, name: "Nell" }, fromTab(chrome, tabOf(7)))).toEqual({ status: "signed-in" });
  expect((await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(7)))).reviewer.name).toBe("Nell");
  expect(typeof (await ask(chrome, { type: "critiqs:sign-in/name", handle: sent.handle, name: "Nell" }, fromTab(chrome, tabOf(7)))).refused).toBe("string");
});

test("case 4: Send a new code keeps the same attempt behind the same handle", async () => {
  const { chrome, backend } = setUp();
  await clickIcon(chrome, tabOf(7));
  const first = await ask(chrome, { type: "critiqs:sign-in/email", email: "dana@example.com" }, fromTab(chrome, tabOf(7)));
  const again = await ask(chrome, { type: "critiqs:sign-in/email", email: "dana@example.com", again: first.handle }, fromTab(chrome, tabOf(7)));
  expect(again.handle).toBe(first.handle);
  expect(backend.requests.filter((request) => request.url.endsWith("/auth/panel/email")).map((request) => request.body.attempt)).toEqual([undefined, "attempt-key-1-secret"]);
});

test("case 4: an unknown, expired, or other tab's handle is refused", async () => {
  let now = Date.now();
  const { chrome } = setUp([tabOf(7), tabOf(8)], { now: () => now });
  await clickIcon(chrome, tabOf(7));
  await clickIcon(chrome, tabOf(8));
  const code = (handle: string, tab: Tab) => ask(chrome, { type: "critiqs:sign-in/code", handle, code: DEVELOPMENT_CODE }, fromTab(chrome, tab));
  expect(typeof (await code("made-up-handle", tabOf(7))).refused).toBe("string");
  const sent = await ask(chrome, { type: "critiqs:sign-in/email", email: "dana@example.com" }, fromTab(chrome, tabOf(7)));
  // Another tab, even one Critiqs is open in, can't use it.
  expect(typeof (await code(sent.handle, tabOf(8))).refused).toBe("string");
  // Nor a new email step there that names it.
  expect(typeof (await ask(chrome, { type: "critiqs:sign-in/email", email: "dana@example.com", again: sent.handle }, fromTab(chrome, tabOf(8)))).refused).toBe("string");
  // Past the backend's 30 minutes for an attempt.
  now += 31 * 60_000;
  expect(typeof (await code(sent.handle, tabOf(7))).refused).toBe("string");
});

test("case 4: a handle outlives the worker stopping between the email and the code", async () => {
  const { chrome } = setUp();
  await clickIcon(chrome, tabOf(7));
  const sent = await ask(chrome, { type: "critiqs:sign-in/email", email: "dana@example.com" }, fromTab(chrome, tabOf(7)));
  // Chrome stops the idle worker while the person reads their email; the code wakes a new one.
  chrome.runtime.onMessage = (await import("./fake-chrome.ts")).fakeEvent();
  startWorker(chrome, BACKEND);
  expect(await ask(chrome, { type: "critiqs:sign-in/code", handle: sent.handle, code: DEVELOPMENT_CODE }, fromTab(chrome, tabOf(7)))).toEqual({ status: "signed-in" });
});

// ---------------------------------------------------------------------------
// 5. The project, from Chrome's own address for the tab

test("case 5: the project lookup uses the tab's address from Chrome, whatever the message names", async () => {
  const { chrome, backend } = setUp();
  signIn(chrome);
  backend.lookups.set(ORIGIN, { status: "found", project: project("p1", "Acme") });
  backend.lookups.set("https://evil.example", { status: "found", project: project("evil", "Someone else's") });
  await clickIcon(chrome, tabOf(7));
  const named = { type: "critiqs:project", origin: "https://evil.example", url: "https://evil.example/", tab: { url: "https://evil.example/" }, sender: { tab: { url: "https://evil.example/" } } };
  const answer = await ask(chrome, named, fromTab(chrome, tabOf(7)));
  expect(answer).toEqual({ kind: "show", project: project("p1", "Acme"), choices: null, origin: ORIGIN });
  expect(backend.calls.filter(([path]) => path === "projects:findForOrigin").map(([, args]) => args.origin)).toEqual([ORIGIN]);
});

test("case 5: choose remembers one of the projects offered; another project is refused and nothing is remembered", async () => {
  const { chrome, backend } = setUp();
  signIn(chrome);
  const offered = [project("p1"), project("p2")];
  backend.lookups.set(ORIGIN, { status: "choose", projects: offered });
  await clickIcon(chrome, tabOf(7));
  const page = fromTab(chrome, tabOf(7));
  expect(await ask(chrome, { type: "critiqs:project" }, page)).toEqual({ kind: "choose", projects: offered, origin: ORIGIN });
  const refused = await ask(chrome, { type: "critiqs:project/choose", projectId: "evil", origin: "https://evil.example" }, page);
  expect(refused.kind).toBeUndefined();
  expect(await ask(chrome, { type: "critiqs:project" }, page)).toEqual({ kind: "choose", projects: offered, origin: ORIGIN });
  expect(await ask(chrome, { type: "critiqs:project/choose", projectId: "p2" }, page)).toEqual({ kind: "show", project: project("p2"), choices: offered, origin: ORIGIN });
  expect(await ask(chrome, { type: "critiqs:project" }, page)).toEqual({ kind: "show", project: project("p2"), choices: offered, origin: ORIGIN });
});

test("case 5: start, manageable and add answer as the side panel's calls do, for the tab's own site", async () => {
  const { chrome, backend } = setUp();
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  const page = fromTab(chrome, tabOf(7));
  expect(await ask(chrome, { type: "critiqs:project" }, page)).toEqual({ kind: "none", origin: ORIGIN });
  const started = await ask(chrome, { type: "critiqs:project/start", origin: "https://evil.example" }, page);
  expect(started).toEqual({ kind: "show", project: project("p-new", "acme-proto.vercel.app"), choices: null, origin: ORIGIN });
  expect(backend.calls.filter(([path]) => path === "projects:addAddress").map(([, args]) => args)).toEqual([{ projectId: "p-new", address: ORIGIN }]);
  backend.manageable = [project("m1", "Mine"), project("m2", "Team")];
  expect(await ask(chrome, { type: "critiqs:project/manageable" }, page)).toEqual({ projects: backend.manageable, complete: true });
  const added = await ask(chrome, { type: "critiqs:project/add", projectId: "m2", origin: "https://evil.example" }, page);
  expect(added).toEqual({ kind: "show", project: project("m2", "Team"), choices: null, origin: ORIGIN });
  expect(backend.calls.filter(([path]) => path === "projects:addAddress").at(-1)?.[1]).toEqual({ projectId: "m2", address: ORIGIN });
});

test("case 5: signed out, or on an address no project lists, the lookup says so without asking the backend", async () => {
  const { chrome, backend } = setUp([tabOf(7), tabOf(8, "file:///home/report.html")]);
  await clickIcon(chrome, tabOf(7));
  await clickIcon(chrome, tabOf(8, "file:///home/report.html"));
  expect(await ask(chrome, { type: "critiqs:project" }, fromTab(chrome, tabOf(7)))).toEqual({ kind: "signed-out" });
  signIn(chrome);
  expect(await ask(chrome, { type: "critiqs:project" }, fromTab(chrome, tabOf(8, "file:///home/report.html")))).toEqual({ kind: "unsupported" });
  expect(backend.calls).toEqual([]);
});

// ---------------------------------------------------------------------------
// 6. Screenshots

test("case 6: critiqs:capture answers a PNG of the sender's own tab, and nothing when another tab is in front", async () => {
  const { chrome, tabs } = setUp([tabOf(7, undefined, { windowId: 4 })]);
  await clickIcon(chrome, tabOf(7, undefined, { windowId: 4 }));
  const page = fromTab(chrome, tabOf(7, undefined, { windowId: 4 }));
  expect(await ask(chrome, { type: "critiqs:capture" }, page)).toEqual({ image: `data:image/png;base64,${btoa("png")}` });
  expect(chrome.calls).toContain("tabs.captureVisibleTab 4 png");
  chrome.calls.length = 0;
  tabs.set(7, tabOf(7, undefined, { windowId: 4, active: false }));
  expect(await ask(chrome, { type: "critiqs:capture" }, page)).toEqual({ image: null });
  expect(chrome.calls.filter((call) => call.startsWith("tabs.captureVisibleTab"))).toEqual([]);
  // The person switched tabs while Chrome took the picture: it may be of another tab.
  tabs.set(7, tabOf(7, undefined, { windowId: 4 }));
  chrome.behavior.capture = async () => (tabs.set(7, tabOf(7, undefined, { windowId: 4, lastAccessed: 2 })), `data:image/png;base64,${btoa("png")}`);
  expect(await ask(chrome, { type: "critiqs:capture" }, page)).toEqual({ image: null });
});

// ---------------------------------------------------------------------------
// 7. Session changes reach every tab

test("case 7: signing out and changing the name reach every tab with Critiqs open", async () => {
  const { chrome } = setUp([tabOf(7), tabOf(9, "https://other.example/")]);
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  await clickIcon(chrome, tabOf(9, "https://other.example/"));
  chrome.tabMessages.length = 0;
  expect(await ask(chrome, { type: "critiqs:set-name", name: "Dana Lee" }, fromTab(chrome, tabOf(7)))).toEqual({ applied: true });
  await settle(10);
  expect(chrome.tabMessages).toContainEqual([7, SESSION_CHANGED]);
  expect(chrome.tabMessages).toContainEqual([9, SESSION_CHANGED]);
  expect((await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(9, "https://other.example/")))).reviewer.name).toBe("Dana Lee");
  chrome.tabMessages.length = 0;
  expect(await ask(chrome, { type: "critiqs:sign-out" }, fromTab(chrome, tabOf(7)))).toEqual({ signedOut: true });
  await settle(10);
  expect(chrome.tabMessages).toContainEqual([7, SESSION_CHANGED]);
  expect(chrome.tabMessages).toContainEqual([9, SESSION_CHANGED]);
  expect(await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(9, "https://other.example/")))).toEqual({ reviewer: null });
});

test("case 7: signing in, renaming or out in the side panel reaches every tab too; a renewal alone doesn't", async () => {
  const { chrome } = setUp([tabOf(7), tabOf(9, "https://other.example/")]);
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  chrome.tabMessages.length = 0;
  // A renewal: new tokens, the same reviewer.
  await ask(chrome, { type: "critiqs:token", force: true }, fromTab(chrome, tabOf(7)));
  await settle(10);
  expect(chrome.tabMessages).toEqual([]);
  // The side panel, an extension page, keeps its own session over the same storage.
  const panel = new ExtensionSession(SIGN_IN, panelSignIn(SIGN_IN), chrome.storage.local, chrome.storage.onChanged);
  await panel.ready;
  await chrome.storage.local.set({ [sessionKey(SIGN_IN)]: storedSession({ reviewer: { id: "dana", name: "Dana Lee", email: "dana@example.com" } }) });
  await settle(10);
  expect(chrome.tabMessages.map(([tabId]) => tabId).sort()).toEqual([7, 9]);
  chrome.tabMessages.length = 0;
  await panel.signOut();
  await settle(10);
  // Told at the sign-out mark, and again as the session leaves storage: each tab at least once.
  expect([...new Set(chrome.tabMessages.map(([tabId]) => tabId))].sort()).toEqual([7, 9]);
  // Signing in again in the side panel.
  chrome.tabMessages.length = 0;
  await panel.signedIn(storedSession());
  await settle(10);
  expect(chrome.tabMessages.map(([tabId]) => tabId).sort()).toEqual([7, 9]);
});

// ---------------------------------------------------------------------------
// The sender gate for the rest

test("every request from a frame, another extension, or a tab Critiqs isn't open in is refused", async () => {
  const { chrome } = setUp([tabOf(7), tabOf(8)]);
  signIn(chrome);
  await clickIcon(chrome, tabOf(7));
  const requests = [
    { type: "critiqs:session" },
    { type: "critiqs:sign-in/email", email: "dana@example.com" },
    { type: "critiqs:sign-out" },
    { type: "critiqs:set-name", name: "Mallory" },
    { type: "critiqs:project" },
    { type: "critiqs:project/start" },
    { type: "critiqs:project/manageable" },
    { type: "critiqs:capture" },
    { type: "critiqs:auto" },
    { type: "critiqs:hidden", hidden: true },
  ];
  for (const request of requests) {
    for (const sender of [fromTab(chrome, tabOf(7), { frameId: 2 }), fromTab(chrome, tabOf(8)), fromTab(chrome, tabOf(7), { id: "another-extension" })]) {
      expect(Object.keys(await ask(chrome, request, sender))).toEqual(["refused"]);
    }
  }
  // Nothing changed: still signed in, no screenshot taken.
  expect(await ask(chrome, { type: "critiqs:session" }, fromTab(chrome, tabOf(7)))).toEqual({ reviewer: { id: "dana", name: "Dana", email: "dana@example.com" } });
  expect(chrome.calls.filter((call) => call.startsWith("tabs.captureVisibleTab"))).toEqual([]);
});

test("critiqs:auto says whether the tab's site shows comments automatically; critiqs:hidden keeps the tab's toggle", async () => {
  const { chrome } = setUp();
  await clickIcon(chrome, tabOf(7));
  const page = fromTab(chrome, tabOf(7));
  expect(await ask(chrome, { type: "critiqs:auto" }, page)).toEqual({ on: false });
  await showAutomatically(chrome, ORIGIN);
  expect(await ask(chrome, { type: "critiqs:auto" }, page)).toEqual({ on: true });
  expect(await ask(chrome, { type: "critiqs:hidden", hidden: true }, page)).toEqual({ hidden: true });
});
