import { afterEach, expect, test } from "bun:test";
import type { Anchor, ThreadDetail, ThreadSummary } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { Deployment } from "../src/deployment.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { placeBeside } from "../src/ui/Picker.tsx";
import { followOccurrence, freeBounds, type Layout, SIDEBAR_WIDTH, windowLayout } from "../src/ui/ThreadWindow.tsx";
import { commentField, fieldText, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Placement

test("the free area excludes an open sidebar and a toolbar at the bottom", () => {
  const toolbar = { x: 500, y: 740, width: 200, height: 44 };
  expect(freeBounds({ toolbar, width: 1200, height: 800 }, true)).toEqual({
    left: 0,
    top: 0,
    right: 1200 - SIDEBAR_WIDTH,
    bottom: 732,
  });
});

test("a toolbar moved to the top limits the free area from above instead", () => {
  const toolbar = { x: 500, y: 16, width: 200, height: 44 };
  expect(freeBounds({ toolbar, width: 1200, height: 800 }, false)).toEqual({ left: 0, top: 68, right: 1200, bottom: 800 });
});

test("a window beside a target near the sidebar goes to the target's left, inside the free area", () => {
  const bounds = { left: 0, top: 0, right: 840, bottom: 732 };
  const { left, top } = placeBeside({ x: 600, y: 100, width: 200, height: 30 }, { width: 340, height: 400 }, bounds);
  expect(left + 340).toBeLessThanOrEqual(600);
  expect(top).toBe(100);
});

test("a window never overlaps the sidebar, even when its pin is under it", () => {
  // At 900 px the sidebar starts at x540, left of the title's pin at x731.
  const bounds = { left: 0, top: 0, right: 540, bottom: 732 };
  const { left } = placeBeside({ x: 731, y: 57, width: 26, height: 26 }, { width: 340, height: 300 }, bounds);
  expect(left + 340).toBeLessThanOrEqual(540 - 8);
});

test("a tall window never reaches the toolbar or the top edge", () => {
  const bounds = { left: 0, top: 0, right: 1200, bottom: 732 };
  const { top } = placeBeside({ x: 100, y: 600, width: 100, height: 30 }, { width: 340, height: 500 }, bounds);
  expect(top).toBeGreaterThanOrEqual(8);
  expect(top + 500).toBeLessThanOrEqual(732);
});

const bottomToolbar = (width: number, height: number) => ({ x: width / 2 - 100, y: height - 56, width: 200, height: 40 });
const layout = (overrides: Partial<Layout>): Layout => ({
  anchor: { x: 24, y: 70, width: 720, height: 36 },
  pin: null,
  toolbar: bottomToolbar(1280, 800),
  width: 1280,
  height: 800,
  keyboard: 0,
  ...overrides,
});

test("the window sits beside the pin, not the whole target", () => {
  const pin = { x: 731, y: 57, width: 26, height: 26 };
  const { mode, style } = windowLayout(layout({ pin }), true, 300);
  expect(mode).toBe("beside");
  // No room right of the pin before the sidebar, so it sits just left of the pin.
  expect(Number(style.left) + 340).toBeLessThanOrEqual(pin.x);
  expect(Number(style.left)).toBeGreaterThan(300);
});

test("on a phone the window is a panel above the toolbar", () => {
  const { mode, style } = windowLayout(layout({ width: 390, height: 760, toolbar: bottomToolbar(390, 760) }), false, 300);
  expect(mode).toBe("panel");
  expect(style).toMatchObject({ left: 0, right: 0 });
  // Clear of the toolbar, which starts 56 px from the bottom.
  expect(Number(style.bottom)).toBeGreaterThanOrEqual(56);
});

test("the panel rises above the on-screen keyboard", () => {
  const { style } = windowLayout(layout({ width: 390, height: 760, toolbar: null, keyboard: 300 }), false, 300);
  expect(style.bottom).toBe(300);
});

test("where a window won't fit beside the open sidebar, a panel sits beside it rather than over it", () => {
  const { mode, style } = windowLayout(layout({ width: 650, height: 800, toolbar: bottomToolbar(650, 800) }), true, 300);
  expect(mode).toBe("panel");
  expect(style.right).toBe(SIDEBAR_WIDTH);
});

test("a window whose target can't be shown docks beside the sidebar", () => {
  const { mode, style } = windowLayout(layout({ anchor: null }), true, 300);
  expect(mode).toBe("docked");
  expect(Number(style.left) + 340).toBeLessThanOrEqual(1280 - SIDEBAR_WIDTH);
});

test("a window follows its occurrence's record, and docks rather than moving to another record", () => {
  const row = (record: string) => {
    const container = document.createElement("div");
    container.setAttribute("data-critiqs-record", record);
    const cell = document.createElement("span");
    container.append(cell);
    return cell;
  };
  const [alex, sam, samAgain] = [row("user:u1"), row("user:u2"), row("user:u2")];
  const chosen = { element: sam, recordKey: "user:u2" };
  expect(followOccurrence(chosen, [alex, sam])).toBe(sam);
  // The prototype re-rendered Sam's row.
  expect(followOccurrence(chosen, [alex, samAgain])).toBe(samAgain);
  // Sam's row scrolled out of a virtualized list.
  expect(followOccurrence(chosen, [alex])).toBeNull();
  expect(followOccurrence(null, [alex, sam])).toBe(alex);
});

// Behavior in the mounted interface

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const storageKey = `critiqs:session:${SIGN_IN}`;
const target = { purposeId: "review", recordKey: null, clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } };
const anchor: Anchor = {
  screen: "pilot",
  viewState: {},
  scope: "shared",
  target,
  evidence: {
    url: "https://prototype.example/pilot",
    capturedAt: 1,
    revision: "v1",
    persona: null,
    viewport: { width: 800, height: 600 },
    marker: { x: 0, y: 0, width: 10, height: 10 },
    userAgent: "Browser",
  },
};
const summary: ThreadSummary = {
  _id: "thread",
  status: "open",
  anchor,
  location: null,
  tags: [],
  createdAt: 1,
  lastMessageAt: 1,
  messageCount: 1,
  unread: false,
  preview: { body: "Align the review button", authorName: "Dana", authorImageUrl: null },
};
const detail: ThreadDetail = {
  _id: "thread",
  status: "open",
  anchor,
  tags: [],
  capture: { status: "failed", failureReason: "Blocked by the browser." },
  createdAt: 1,
  lastMessageAt: 1,
  messageCount: 1,
  projectId: "project",
  statusChangedByName: null,
  reattachedByName: null,
  readState: { lastReadAt: 1, manualUnread: false },
  messages: [
    {
      _id: "message",
      body: "Align the review button",
      createdAt: 1,
      editedAt: null,
      revision: "v1",
      author: { name: "Dana", imageUrl: null },
      isMine: false,
      reactions: [],
      mentions: [],
    },
  ],
};

/** Replies stay pending until the test releases them. */
let replies: { body: string; release: () => void }[] = [];
const backend: FakeBackend = {
  project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
  threads: [summary],
  thread: detail,
  reply: ({ body }) => new Promise<string>((resolve) => replies.push({ body, release: () => resolve("reply") })),
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let page: HTMLElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  page?.remove();
  page = null;
  replies = [];
  backend.authenticated = true;
  backend.authLoading = false;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

/** Two occurrences of the shared target, laid out at fixed places on screen. */
function prototypePage() {
  page = document.createElement("main");
  const places = [
    { x: 40, y: 80, width: 120, height: 30 },
    { x: 40, y: 400, width: 120, height: 30 },
  ];
  for (const place of places) {
    const button = document.createElement("button");
    button.setAttribute("data-critiqs-id", "review");
    button.textContent = "Review";
    button.getBoundingClientRect = () => new DOMRect(place.x, place.y, place.width, place.height);
    button.getClientRects = () => [new DOMRect(place.x, place.y, place.width, place.height)] as unknown as DOMRectList;
    (button as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
    page.append(button);
  }
  document.body.append(page);
  return page.querySelectorAll("button");
}

async function mount({ sidebarOpen, deployment = {} }: { sidebarOpen: boolean; deployment?: Partial<Deployment> }) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(
    storageKey,
    JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture-token", expiresAt: Date.now() + 900_000 }),
  );
  localStorage.setItem("critiqs:sidebar-open", JSON.stringify(sidebarOpen));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(backend)}>
        <App
          props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }}
          deployment={{ backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, ...deployment }}
          session={session}
          host={host!}
        />
      </TransportContext.Provider>,
    ),
  );
  // Pins and the window follow the page every animation frame.
  await frames();
  // The comments list is Comment mode's side panel; Browse mode's shows the project.
  if (sidebarOpen) await act(async () => shadow.querySelector<HTMLButtonElement>('[aria-label="Comment mode"]')!.click());
  return shadow;
}

async function frames() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

const threadWindow = (shadow: ShadowRoot) => shadow.querySelector<HTMLElement>('section[aria-label="Comment thread"]');

async function type(field: HTMLElement, value: string) {
  await typeInto(field, value);
}

test("a reply a coding agent wrote shows it beside the person's name", async () => {
  prototypePage();
  const agentReply = { ...detail.messages[0]!, _id: "agent", body: "Fixed in abc123; please check", via: "agent" as const };
  backend.thread = { ...detail, messageCount: 2, messages: [...detail.messages, agentReply] };
  try {
    const shadow = await mount({ sidebarOpen: true });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
    await frames();
    const messages = [...threadWindow(shadow)!.querySelectorAll<HTMLElement>(".message")];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.querySelector(".via")).toBeNull();
    const via = messages[1]!.querySelector<HTMLElement>(".via")!;
    expect(via.textContent).toBe("via coding agent");
    expect(via.title).toBe("A coding agent wrote this for Dana");
  } finally {
    backend.thread = detail;
  }
});

/** The thread window's More actions menu items, by name. */
async function moreActions(shadow: ShadowRoot) {
  await act(async () => threadWindow(shadow)!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click());
  return [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);
}

test("Delete thread is offered only to someone the backend lets delete it, and to all on older backends", async () => {
  prototypePage();
  try {
    for (const [canDelete, offered] of [
      [false, false],
      [true, true],
      [undefined, true],
    ] as const) {
      backend.thread = canDelete === undefined ? detail : { ...detail, canDelete };
      const shadow = await mount({ sidebarOpen: true });
      await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
      await frames();
      const items = await moreActions(shadow);
      expect(items).toContain("Mark unread");
      expect([canDelete, items.includes("Delete thread…")]).toEqual([canDelete, offered]);
      await act(async () => root?.unmount());
      root = null;
      host?.remove();
    }
  } finally {
    backend.thread = detail;
  }
});

/** A clipboard that records what was copied. */
function recordingClipboard(): { text: string | null } {
  const clipboard = { text: null as string | null };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void (clipboard.text = value) } });
  return clipboard;
}

async function chooseAction(shadow: ShadowRoot, name: string) {
  const item = [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((each) => each.textContent === name)!;
  await act(async () => item.click());
  await frames();
}

const PAGE_KEY = "AbCdEfGhIjKlMnOpQrStUv";

test("Copy link copies the thread's page on the website where the backend has thread pages and a website", async () => {
  prototypePage();
  const calls: { name: string; args: unknown }[] = [];
  Object.assign(backend, { calls, threadPageKey: async () => PAGE_KEY });
  const clipboard = recordingClipboard();
  try {
    const shadow = await mount({ sidebarOpen: true, deployment: { website: "https://critiqs.example" } });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
    await frames();
    await moreActions(shadow);
    await chooseAction(shadow, "Copy link");
    expect(clipboard.text).toBe(`https://critiqs.example/t/${PAGE_KEY}`);
    expect(calls).toContainEqual({ name: "threadPageKey", args: { threadId: detail._id } });
    expect(shadow.textContent).toContain("Link to thread copied");
    // A message's own link still opens the prototype at that message: a thread page shows the whole thread.
    clipboard.text = null;
    const message = threadWindow(shadow)!.querySelector<HTMLElement>(".message")!;
    await act(async () => message.querySelector<HTMLButtonElement>('[aria-label="Message actions"]')!.click());
    await chooseAction(shadow, "Copy link to message");
    expect(clipboard.text as string | null).toBe(`https://prototype.example/pilot?critiqs=${detail._id}.message`);
  } finally {
    Object.assign(backend, { calls: undefined, threadPageKey: undefined });
  }
});

test("without a website for thread pages, Copy link copies the prototype's link and asks for no page key", async () => {
  prototypePage();
  const calls: { name: string; args: unknown }[] = [];
  Object.assign(backend, { calls, threadPageKey: async () => PAGE_KEY });
  const clipboard = recordingClipboard();
  try {
    const shadow = await mount({ sidebarOpen: true });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
    await frames();
    await moreActions(shadow);
    await chooseAction(shadow, "Copy link");
    expect(clipboard.text).toBe(`https://prototype.example/pilot?critiqs=${detail._id}`);
    expect(calls.filter((call) => call.name === "threadPageKey")).toEqual([]);
    expect(shadow.textContent).toContain("Link to thread copied");
  } finally {
    Object.assign(backend, { calls: undefined, threadPageKey: undefined });
  }
});

test("a browser that refuses to copy says so instead of saying the link was copied", async () => {
  prototypePage();
  Object.assign(backend, { threadPageKey: async () => PAGE_KEY });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("Not allowed")) } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  try {
    const shadow = await mount({ sidebarOpen: true, deployment: { website: "https://critiqs.example" } });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
    await frames();
    await moreActions(shadow);
    await chooseAction(shadow, "Copy link");
    expect(shadow.textContent).toContain(`Couldn't copy the link. Here it is: https://critiqs.example/t/${PAGE_KEY}`);
    expect(shadow.textContent).not.toContain("Link to thread copied");
  } finally {
    Object.assign(backend, { threadPageKey: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => true });
  }
});

test("a page key the backend refuses copies nothing and says why", async () => {
  prototypePage();
  Object.assign(backend, {
    threadPageKey: async () => {
      throw Object.assign(new Error("Refused"), { data: { code: "forbidden", message: "Only members of this project's organization can review it." } });
    },
  });
  const clipboard = recordingClipboard();
  try {
    const shadow = await mount({ sidebarOpen: true, deployment: { website: "https://critiqs.example" } });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
    await frames();
    await moreActions(shadow);
    await chooseAction(shadow, "Copy link");
    expect(clipboard.text).toBeNull();
    expect(shadow.textContent).toContain("Only members of this project's organization can review it.");
    expect(shadow.textContent).not.toContain("Link to thread copied");
  } finally {
    Object.assign(backend, { threadPageKey: undefined });
  }
});

test("a deletion the backend refuses keeps the thread open and says why", async () => {
  prototypePage();
  backend.thread = { ...detail, canDelete: true };
  backend.removeThread = async () => {
    // As Convex reports Critiqs's refusals.
    throw Object.assign(new Error("Refused"), { data: { code: "forbidden", message: "Only the person who started this thread or the project's owners can delete it." } });
  };
  try {
    const shadow = await mount({ sidebarOpen: true });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
    await frames();
    await moreActions(shadow);
    const item = [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((each) => each.textContent === "Delete thread…")!;
    await act(async () => item.click());
    const confirm = [...shadow.querySelectorAll<HTMLButtonElement>("button.danger")].find((button) => button.textContent === "Delete")!;
    await act(async () => confirm.click());
    await frames();
    expect(threadWindow(shadow)).not.toBeNull();
    expect(shadow.textContent).toContain("Only the person who started this thread or the project's owners can delete it.");
  } finally {
    backend.thread = detail;
    backend.removeThread = undefined;
  }
});

test("selecting a thread in the sidebar keeps the list and opens the thread beside its target", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: true });
  const entry = shadow.querySelector<HTMLButtonElement>(".entry");
  expect(entry).not.toBeNull();
  await act(async () => entry!.click());
  await frames();

  const window = threadWindow(shadow);
  expect(window).not.toBeNull();
  expect(window!.textContent).toContain("Align the review button");
  // The list stays, with the open thread marked.
  expect(shadow.querySelector(".sidebar .entry[aria-current]")).not.toBeNull();
  // Beside the first occurrence, clear of the sidebar.
  expect(window!.classList.contains("docked")).toBe(false);
  expect(Number.parseFloat(window!.style.left)).toBeGreaterThan(160);
  expect(Number.parseFloat(window!.style.left) + 340).toBeLessThanOrEqual(globalThis.window.innerWidth - SIDEBAR_WIDTH);
});

test("a shared thread's window opens beside the pin that was clicked", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  const pins = shadow.querySelectorAll<HTMLButtonElement>(".pin");
  expect(pins.length).toBe(2);
  const second = Array.from(pins).find((pin) => Number.parseFloat(pin.style.top) > 300)!;
  await act(async () => second.click());
  await frames();

  const expanded = Array.from(shadow.querySelectorAll(".pin")).filter((pin) => pin.getAttribute("aria-expanded") === "true");
  expect(expanded.length).toBe(1);
  expect(Number.parseFloat((expanded[0] as HTMLElement).style.top)).toBeGreaterThan(300);
  const window = threadWindow(shadow)!;
  // Level with the second occurrence (top 400, less the pin's reach), not the first.
  expect(Number.parseFloat(window.style.top)).toBeGreaterThan(300);
});

test("Escape closes the window, returns focus to the pin, and keeps the unsent reply", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  const pin = shadow.querySelector<HTMLButtonElement>(".pin")!;
  await act(async () => {
    pin.focus();
    pin.click();
  });
  await frames();
  const reply = commentField(threadWindow(shadow)!, "Reply")!;
  await type(reply, "Half-written reply");

  await act(async () => {
    reply.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  });
  expect(threadWindow(shadow)).toBeNull();
  expect(shadow.activeElement).toBe(shadow.querySelector(".pin"));

  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  expect(fieldText(commentField(threadWindow(shadow)!, "Reply")!)).toBe("Half-written reply");
});

test("a click in the prototype closes the window; a click in Critiqs's sidebar does not", async () => {
  const [first] = prototypePage();
  const shadow = await mount({ sidebarOpen: true });
  await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
  await frames();
  // In Comment mode a click in the prototype selects an element; back in Browse mode it closes the window.
  await act(async () => shadow.querySelector<HTMLButtonElement>('[aria-label="Browse mode"]')!.click());
  expect(threadWindow(shadow)).not.toBeNull();

  await act(async () => {
    shadow.querySelector(".sidebar-body")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  });
  expect(threadWindow(shadow)).not.toBeNull();

  await act(async () => {
    first!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  });
  expect(threadWindow(shadow)).toBeNull();
});

test("a thread whose target isn't shown opens beside the sidebar with its saved context", async () => {
  const shadow = await mount({ sidebarOpen: true });
  await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
  await frames();
  const window = threadWindow(shadow)!;
  expect(window.classList.contains("docked")).toBe(true);
  expect(Number.parseFloat(window.style.left) + 340).toBeLessThanOrEqual(globalThis.window.innerWidth - SIDEBAR_WIDTH);
  // Saved context is shown open rather than folded away.
  expect(window.querySelector("details.saved-context")).toBeNull();
  expect(window.textContent).toContain("Automatic capture failed");
});

test("in Comment mode, Escape closes an open thread, then the side panel, and never leaves Comment mode", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  const sidebar = () => shadow.querySelector('aside[aria-label="Critiqs comments"]');
  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  const commentMode = () => shadow.querySelector('button[aria-label="Comment mode"]')!.getAttribute("aria-pressed");
  await act(async () => shadow.querySelector<HTMLButtonElement>('button[aria-label="Comment mode"]')!.click());
  expect(commentMode()).toBe("true");
  expect(threadWindow(shadow)).not.toBeNull();

  const escape = () => act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await act(async () => shadow.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label^="Comments"]')!.click());
  expect(sidebar()).not.toBeNull();
  await escape();
  expect(threadWindow(shadow)).toBeNull();
  expect(sidebar()).not.toBeNull();
  expect(commentMode()).toBe("true");
  await escape();
  expect(sidebar()).toBeNull();
  expect(commentMode()).toBe("true");
  await escape();
  expect(commentMode()).toBe("true");
  // V and C change the mode.
  await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
  expect(commentMode()).toBe("false");
});

test("opening the same thread from its other pin moves focus into the window again", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  const pins = () => Array.from(shadow.querySelectorAll<HTMLButtonElement>(".pin"));
  await act(async () => pins()[0]!.click());
  await frames();
  const second = pins().find((pin) => pin.getAttribute("aria-expanded") !== "true")!;
  await act(async () => {
    second.focus();
    second.click();
  });
  await frames();
  expect(shadow.activeElement).toBe(threadWindow(shadow));
  expect(pins().filter((pin) => pin.getAttribute("aria-expanded") === "true")).toEqual([second]);
});

test("a reply still sending is neither lost nor repeated when the thread is reopened", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  const pins = () => Array.from(shadow.querySelectorAll<HTMLButtonElement>(".pin"));
  const replyField = () => commentField(threadWindow(shadow)!, "Reply")!;
  const replyButton = () =>
    Array.from(threadWindow(shadow)!.querySelectorAll<HTMLButtonElement>("button")).find((b) => /Reply|Sending/.test(b.textContent ?? ""))!;
  await act(async () => pins()[0]!.click());
  await frames();
  await type(replyField(), "First reply");
  await act(async () => replyButton().click());
  expect(replies.map((reply) => reply.body)).toEqual(["First reply"]);

  // Reopen the thread from its other pin while the reply is sending, then start another.
  await act(async () => pins()[1]!.click());
  await frames();
  expect(replyButton().disabled).toBe(true);
  await act(async () => replyButton().click());
  expect(replies.length).toBe(1);
  await type(replyField(), "Second thought");
  await act(async () => replies[0]!.release());
  expect(fieldText(replyField())).toBe("Second thought");
  expect(replyButton().disabled).toBe(false);
});

test("a reply the backend refuses, such as for too many hashtags, keeps its draft and says why", async () => {
  const reason = "A message can use up to 30 different hashtags; this one uses 31.";
  backend.reply = () => Promise.reject(Object.assign(new Error(reason), { data: { code: "invalid", message: reason } }));
  try {
    prototypePage();
    const shadow = await mount({ sidebarOpen: false });
    await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
    await frames();
    const replyField = () => commentField(threadWindow(shadow)!, "Reply")!;
    const text = Array.from({ length: 31 }, (_, i) => `#w${i}`).join(" ");
    await type(replyField(), text);
    const send = Array.from(threadWindow(shadow)!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Reply")!;
    await act(async () => send.click());
    await frames();
    expect(fieldText(replyField())).toBe(text);
    expect(threadWindow(shadow)!.textContent).toContain(reason);
  } finally {
    backend.reply = ({ body }) => new Promise<string>((resolve) => replies.push({ body, release: () => resolve("reply") }));
  }
});

test("re-authenticating the same reviewer, such as after a rename, keeps the open thread and its draft", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  await type(commentField(threadWindow(shadow)!, "Reply")!, "Half-written reply");

  // The backend briefly stops accepting the token while it switches to the renamed one.
  // A storage event re-reads the session; a resize re-renders the interface, as a real backend's auth change would.
  const rerender = async () => {
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
      window.dispatchEvent(new Event("resize"));
    });
    await frames();
  };
  backend.authenticated = false;
  backend.authLoading = true;
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana Kim", email: "dana@example.com" }));
  localStorage.setItem(storageKey, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "r2", expiresAt: Date.now() + 900_000 }));
  await rerender();
  backend.authenticated = true;
  backend.authLoading = false;
  await rerender();
  const reply = (threadWindow(shadow) && commentField(threadWindow(shadow)!, "Reply"));
  expect(reply && fieldText(reply)).toBe("Half-written reply");
});

test("a backend that refuses the sign-in clears the open thread and its draft", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  await type(commentField(threadWindow(shadow)!, "Reply")!, "Private draft");
  const rerender = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await frames();
  };
  backend.authenticated = false;
  backend.rejected = true;
  await rerender();
  expect(threadWindow(shadow)).toBeNull();
  backend.authenticated = true;
  backend.rejected = false;
  await rerender();
  expect(threadWindow(shadow)).toBeNull();
  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  expect(fieldText(commentField(threadWindow(shadow)!, "Reply")!)).toBe("");
});

test("a token that couldn't be fetched, such as while offline, keeps the open thread and its draft", async () => {
  prototypePage();
  const shadow = await mount({ sidebarOpen: false });
  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  await type(commentField(threadWindow(shadow)!, "Reply")!, "Offline draft");
  const rerender = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await frames();
  };
  backend.authenticated = false;
  await rerender();
  backend.authenticated = true;
  await rerender();
  expect(fieldText(commentField(threadWindow(shadow)!, "Reply")!)).toBe("Offline draft");
});
