import { afterEach, expect, test } from "bun:test";
import type { Anchor, MockupDetail, MockupSummary, ThreadDetail, ThreadSummary } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { RestoreRequest } from "../src/host.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The Mockup panel: offered where the backend stores mockups, asking to sign
// in when signed out; its first level lists every page's mockup threads, this
// page's first, and opening one from another page first asks to go there; its
// second level is one thread, whose Critiqs AI replies carry their versions.

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const anchor: Anchor = {
  screen: "pilot",
  viewState: {},
  scope: "shared",
  target: { purposeId: "review", recordKey: null, clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } },
  evidence: { url: "https://prototype.example/pilot", capturedAt: 1, revision: "v1", persona: null, viewport: { width: 800, height: 600 }, marker: null, userAgent: null },
};
const feedback: ThreadSummary = {
  _id: "feedback",
  status: "open",
  anchor,
  location: null,
  tags: [],
  createdAt: 1,
  lastMessageAt: 1,
  messageCount: 1,
  unread: false,
  preview: { body: "Save is hard to find", authorName: "Dana", authorImageUrl: null },
};
const detailOf = (summary: ThreadSummary, messages: ThreadDetail["messages"]): ThreadDetail => ({
  _id: summary._id,
  projectId: "project",
  status: summary.status,
  anchor,
  tags: [],
  capture: { status: "failed", failureReason: "Mockup threads have no capture." },
  createdAt: 1,
  lastMessageAt: messages.at(-1)!.createdAt,
  messageCount: messages.length,
  statusChangedByName: null,
  reattachedByName: null,
  readState: { lastReadAt: messages.at(-1)!.createdAt, manualUnread: false },
  ...(summary.mockup === undefined ? {} : { mockup: summary.mockup }),
  messages,
});
const message = (id: string, body: string, extra: Partial<ThreadDetail["messages"][number]> = {}) => ({
  _id: id,
  body,
  createdAt: 2,
  editedAt: null,
  revision: "v1",
  author: { name: "Dana", imageUrl: null },
  isMine: true,
  reactions: [],
  mentions: [],
  ...extra,
});
const mockupThread: ThreadSummary = {
  ...feedback,
  _id: "mockup-thread",
  preview: { body: "Make Save stand out", authorName: "Dana", authorImageUrl: null },
  messageCount: 2,
  mockup: { mockupId: "mockup", snapshotId: "desktop", node: 7 },
};
const mockup: MockupDetail = {
  _id: "mockup",
  projectId: "project",
  title: "Checkout mockup",
  source: { url: "https://prototype.example/pilot", screen: "pilot", viewState: {}, revision: "v1", persona: null },
  createdAt: 1,
  updatedAt: 1,
  listedAt: 1,
  createdByName: "Dana",
  versionCount: 2,
  threadCount: 1,
  snapshots: [{ _id: "desktop", width: 1024, height: 2000, capturedAt: 1, createdByName: "Dana" }],
  threads: [mockupThread],
  linkedThreadIds: ["feedback"],
  versions: [
    { number: 1, createdAt: 1, authorName: "Dana", byAi: true, summary: "Bolder Save button", threadId: "mockup-thread", messageId: "ai-1", restoredFrom: null, edits: { desktop: [] } },
    { number: 2, createdAt: 2, authorName: "Lee", byAi: false, summary: "Restored the original page", threadId: null, messageId: null, restoredFrom: 0, edits: {} },
  ],
};

/** A mockup thread on another page, the only thread of its own mockup. */
const otherThread: ThreadSummary = {
  ...feedback,
  _id: "other-thread",
  lastMessageAt: 5,
  preview: { body: "Rename the Save button", authorName: "Lee", authorImageUrl: null },
  mockup: { mockupId: "other", snapshotId: null, node: null },
};
const otherMockup: MockupDetail = {
  ...mockup,
  _id: "other",
  title: "Rename the Save button",
  source: { ...mockup.source, url: "https://prototype.example/settings", screen: "settings", viewState: { tab: "profile" } },
  versionCount: 0,
  threads: [otherThread],
  linkedThreadIds: [],
  versions: [],
};
const summaryOf = ({ linkedThreadIds: _linked, versions: _versions, snapshots, ...rest }: MockupDetail): MockupSummary => ({
  ...rest,
  snapshots: snapshots.map(({ _id, width }) => ({ _id, width })),
});

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: [feedback],
    thread: detailOf(feedback, [message("first", "Save is hard to find")]),
    threadDetails: {
      "mockup-thread": detailOf(mockupThread, [
        message("ask", "Make Save stand out"),
        message("ai-1", "I made the Save button bolder.", { via: "ai", mockupVersion: 1, isMine: false, author: { name: "Dana", imageUrl: null } }),
      ]),
      "other-thread": detailOf(otherThread, [message("ask-2", "Rename the Save button")]),
    },
    mockups: {
      list: [summaryOf(otherMockup), summaryOf(mockup)],
      detail: mockup,
      details: { other: otherMockup },
      forThread: [{ _id: "mockup", title: "Checkout mockup" }],
    },
    calls: [],
    ...overrides,
  };
}

/** One mockup with the given detail, listed alone. */
function only(detail: MockupDetail): FakeBackend["mockups"] {
  return { list: [summaryOf(detail)], detail, forThread: [] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
/** Adds an element of the prototype's page, removed after the test. */
function pageElement(tag: string, attributes: Record<string, string> = {}, text = "") {
  const element = document.body.appendChild(document.createElement(tag));
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.textContent = text;
  pageElements.push(element);
  return element;
}
const pageElements: HTMLElement[] = [];

afterEach(async () => {
  for (const element of pageElements.splice(0)) element.remove();
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

interface MountOptions {
  mockups?: boolean;
  /** The backend keeps each person's own AI settings (Your AI). */
  personalAi?: boolean;
  /** The backend reports which models a person's requests may choose among. */
  modelLists?: boolean;
  signedIn?: boolean;
  /** The prototype's current screen, which `restoreContext` may change. */
  app?: { screen: string; viewState?: Record<string, string> };
  restoreContext?: (request: RestoreRequest) => boolean | Promise<boolean>;
  onSignIn?: () => void;
}

async function mount(data: FakeBackend, { mockups = true, personalAi = false, modelLists = false, signedIn = true, app = { screen: "pilot" }, restoreContext, onSignIn }: MountOptions = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  if (signedIn) {
    const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
    localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  }
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  if (onSignIn !== undefined) {
    session.signIn = () => {
      onSignIn();
      return new Promise(() => {});
    };
  }
  const transport = fakeTransport(data);
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, mockups, personalAi, modelLists } as const;
  const props = { projectId: "project", getContext: () => ({ screen: app.screen, viewState: app.viewState ?? {} }), ...(restoreContext === undefined ? {} : { restoreContext }) };
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App props={props} deployment={deployment} session={session} host={host!} />
      </TransportContext.Provider>,
    ),
  );
  await frames();
  return shadow;
}

/** Mounts again with other data, after unmounting the current interface. */
async function remount(data: FakeBackend, options?: MountOptions) {
  await act(async () => root?.unmount());
  host?.remove();
  return await mount(data, options);
}

async function frames() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

async function press(key: string, type: "keydown" | "keyup" = "keydown") {
  const event = new KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true });
  await act(async () => void document.body.dispatchEvent(event));
  await frames();
  return event.defaultPrevented;
}

async function click(element: Element | null | undefined) {
  if (element == null) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
  await frames();
}

async function type(field: HTMLTextAreaElement | HTMLInputElement | null, text: string) {
  if (field === null) throw new Error("No field");
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text) ?? null;
const panel = (shadow: ShadowRoot) => shadow.querySelector('aside[aria-label="Mockup"]:not([hidden])');
const section = (shadow: ShadowRoot, label: string) => panel(shadow)!.querySelector(`section[aria-label="${label}"]`);
const row = (shadow: ShadowRoot, text: string) => [...panel(shadow)!.querySelectorAll("section .entry")].find((entry) => entry.textContent?.includes(text)) ?? null;
const heading = (shadow: ShadowRoot) => panel(shadow)!.querySelector(".sidebar-header h2")!.textContent;

/** Opens the Mockup panel, then this page's thread. */
async function openThread(shadow: ShadowRoot) {
  await press("m");
  await click(row(shadow, "Make Save stand out"));
}

async function waitFor(check: () => boolean, rounds = 20) {
  for (let i = 0; i < rounds && !check(); i++) await frames();
}

test("the toolbar offers Mockup only where the backend stores mockups", async () => {
  let shadow = await mount(backend(), { mockups: false });
  expect(shadow.querySelector('button[aria-label="Mockup mode"]')).toBeNull();
  // M is the prototype's own key there.
  expect(await press("m")).toBe(false);
  await act(async () => root!.unmount());
  host!.remove();

  // A backend whose transport has no mockups, such as the embedded server, doesn't either.
  shadow = await mount(backend({ mockups: undefined }), { mockups: true });
  expect(shadow.querySelector('button[aria-label="Mockup mode"]')).toBeNull();
  await act(async () => root!.unmount());
  host!.remove();

  shadow = await mount(backend());
  const toolbarButton = shadow.querySelector('button[aria-label="Mockup mode"]')!;
  expect(toolbarButton.getAttribute("title")).toBe("Mockup mode: freeze the page and ask Critiqs AI for changes (M)");
});

test("signed out, Mockup is offered and asks to sign in, as Comment does", async () => {
  let signIns = 0;
  const shadow = await mount(backend(), { signedIn: false, onSignIn: () => signIns++ });
  await click(shadow.querySelector('button[aria-label="Comment mode"]'));
  expect(signIns).toBe(1);
  await click(shadow.querySelector('button[aria-label="Mockup mode"]'));
  expect(signIns).toBe(2);
  // Nothing of the mockups shows before sign-in.
  expect(panel(shadow)).toBeNull();
  expect(shadow.querySelector('[data-testid="mockup-canvas"]')).toBeNull();
});

test("signed out, M asks to sign in, as the Mockup button does", async () => {
  let signIns = 0;
  const shadow = await mount(backend(), { signedIn: false, onSignIn: () => signIns++ });
  expect(await press("m")).toBe(true);
  expect(signIns).toBe(1);
  expect(shadow.querySelector('button[aria-label="Mockup mode"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(panel(shadow)).toBeNull();
  // M again leaves Mockup mode without asking again.
  await press("m");
  expect(signIns).toBe(1);
  expect(shadow.querySelector('button[aria-label="Mockup mode"]')!.getAttribute("aria-pressed")).toBe("false");
});

test("M opens the Mockup panel over the page and closes it again; Escape closes the panel and keeps Mockup mode and the thread", async () => {
  const shadow = await mount(backend());
  expect(await press("m")).toBe(true);
  expect(shadow.querySelector('button[aria-label="Mockup mode"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(heading(shadow)).toBe("Mockup");
  expect(shadow.querySelector('[data-testid="mockup-canvas"]')).not.toBeNull();
  expect(shadow.querySelector(".mode-hint")!.textContent).toBe("Mockup mode: open a thread or start a new one · V to leave");
  expect(button(panel(shadow)!, "Close sidebar")).not.toBeNull();

  expect(await press("m")).toBe(true);
  expect(panel(shadow)).toBeNull();
  expect(shadow.querySelector('[data-testid="mockup-canvas"]')).toBeNull();

  await openThread(shadow);
  expect(heading(shadow)).toBe("Checkout mockup");
  await press("Escape");
  expect(panel(shadow)).toBeNull();
  expect(shadow.querySelector('button[aria-label="Mockup mode"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(shadow.querySelector('[data-testid="mockup-canvas"]')).not.toBeNull();
  // The panel comes back on the same thread; V leaves Mockup mode.
  await click(button(shadow, "Mockup"));
  expect(heading(shadow)).toBe("Checkout mockup");
  await press("v");
  expect(shadow.querySelector('[data-testid="mockup-canvas"]')).toBeNull();
});

test("the list shows every page's mockup threads, this page's first, each labeled with its page", async () => {
  const data = backend();
  const shadow = await mount(data);
  await press("m");
  const sections = [...panel(shadow)!.querySelectorAll("section")];
  expect(sections.map((element) => element.getAttribute("aria-label"))).toEqual(["This page", "Page settings"]);
  expect(sections.map((element) => element.querySelector(".group-title")!.textContent)).toEqual(["This page", "settings"]);

  const here = row(shadow, "Make Save stand out")!;
  expect(sections[0]!.contains(here)).toBe(true);
  expect(here.querySelector(".author")!.textContent).toBe("Dana");
  expect(here.querySelector(".details")!.textContent).toContain("pilot");
  expect(here.querySelector(".details")!.textContent).toContain("v2");
  const there = row(shadow, "Rename the Save button")!;
  expect(there.querySelector(".page-label")!.textContent).toBe("settings · tab: profile");
  expect(there.querySelector(".details")!.textContent).toContain("No changes yet");

  // Asked for this page's screen, whose threads backends list however many newer ones other pages have.
  expect(data.mockups!.listedFor).toBe("pilot");

  // No mockup levels, titles, or version menus: threads are the list.
  expect(panel(shadow)!.querySelector('input[aria-label="Mockup title"]')).toBeNull();
  expect(button(shadow, "Versions")).toBeNull();
  expect(button(shadow, "Create mockup")).toBeNull();
  expect(panel(shadow)!.textContent).not.toContain("Existing feedback");
  expect(panel(shadow)!.textContent).not.toContain("Mockup mode");
});

/** `count` mockups made on `screen`, each with its one thread, the first most recently changed. */
function proposals(screen: string, count: number, newest = 1000): MockupSummary[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${screen}-${index}`;
    const time = newest - index;
    const thread: ThreadSummary = {
      ...feedback,
      _id: `${id}-thread`,
      lastMessageAt: time,
      preview: { body: `${screen} proposal ${index}`, authorName: "Lee", authorImageUrl: null },
      mockup: { mockupId: id, snapshotId: null, node: null },
    };
    return { ...summaryOf(mockup), _id: id, title: `${screen} ${index}`, source: { ...mockup.source, screen }, updatedAt: time, listedAt: time, versionCount: 0, threads: [thread] };
  });
}
const excerpts = (scope: Element | null) => [...(scope?.querySelectorAll(".entry .excerpt") ?? [])].map((element) => element.textContent);
const otherSections = (shadow: ShadowRoot) => [...panel(shadow)!.querySelectorAll('section:not([aria-label="This page"])')];

test("this page's threads show 20 at a time: Show more adds the next 20 and goes away when there are no more", async () => {
  const list = proposals("pilot", 45);
  const last = { ...mockup, ...list[44]!, snapshots: mockup.snapshots };
  const shadow = await mount(backend({ mockups: { list, details: { [last._id]: last }, forThread: [] } }));
  await press("m");
  const here = () => section(shadow, "This page");
  expect(excerpts(here())).toEqual(Array.from({ length: 20 }, (_, index) => `pilot proposal ${index}`));
  const more = button(here()!, "Show more on this page")!;
  expect(more.textContent).toBe("Show more");
  // Nothing more on other pages, so they offer nothing.
  expect(button(shadow, "Show more from other pages")).toBeNull();

  await click(more);
  expect(excerpts(here())).toHaveLength(40);
  await click(button(here()!, "Show more on this page"));
  expect(excerpts(here())).toEqual(Array.from({ length: 45 }, (_, index) => `pilot proposal ${index}`));
  expect(button(shadow, "Show more on this page")).toBeNull();

  // Opening a thread from a later page works as from the first.
  await click(row(shadow, "pilot proposal 44"));
  expect(heading(shadow)).toBe("pilot 44");
});

test("opening a thread and going back keeps the threads loaded and where the list was scrolled", async () => {
  const list = proposals("pilot", 45);
  const opened = { ...mockup, ...list[30]!, snapshots: mockup.snapshots };
  const shadow = await mount(backend({ mockups: { list, details: { [opened._id]: opened }, forThread: [] } }));
  await press("m");
  await click(button(shadow, "Show more on this page"));
  expect(excerpts(section(shadow, "This page"))).toHaveLength(40);
  const body = () => panel(shadow)!.querySelector(".sidebar-body")!;
  body().scrollTop = 600;

  await click(row(shadow, "pilot proposal 30"));
  expect(heading(shadow)).toBe("pilot 30");
  expect(section(shadow, "This page")).toBeNull();
  await click(button(shadow, "All mockup threads"));
  expect(heading(shadow)).toBe("Mockup");
  expect(excerpts(section(shadow, "This page"))).toHaveLength(40);
  expect(body().scrollTop).toBe(600);
});

test("other pages show their newest 20 threads, grouped by page, with one Show more after them", async () => {
  const others = [...proposals("settings", 13, 900), ...proposals("billing", 12, 899.5)];
  const shadow = await mount(backend({ mockups: { list: [...proposals("pilot", 3), ...others], forThread: [] } }));
  await press("m");
  expect(excerpts(section(shadow, "This page"))).toEqual(["pilot proposal 0", "pilot proposal 1", "pilot proposal 2"]);
  expect(button(shadow, "Show more on this page")).toBeNull();
  // The 20 newest of the other pages' threads, still grouped and labeled by page.
  expect(otherSections(shadow).map((element) => element.getAttribute("aria-label"))).toEqual(["Page settings", "Page billing"]);
  expect(otherSections(shadow).flatMap(excerpts)).toHaveLength(20);
  expect(excerpts(section(shadow, "Page settings"))).toEqual(Array.from({ length: 10 }, (_, index) => `settings proposal ${index}`));

  const more = button(shadow, "Show more from other pages")!;
  expect(more.closest("section")).toBeNull();
  expect(more.closest(".list-more")!.previousElementSibling).toBe(section(shadow, "Page billing"));
  await click(more);
  expect(otherSections(shadow).flatMap(excerpts)).toHaveLength(25);
  expect(excerpts(section(shadow, "Page billing"))).toHaveLength(12);
  expect(button(shadow, "Show more from other pages")).toBeNull();
  expect(excerpts(section(shadow, "This page"))).toHaveLength(3);
});

test("threads are ordered by when their mockups were last active, the order the list's pages are read in", async () => {
  // Thread times that disagree with their mockups' must not reorder rows or pages.
  const [a, b] = proposals("pilot", 2, 10);
  const [c, d] = [...proposals("settings", 1, 6), ...proposals("billing", 1, 5)];
  const at = (summary: MockupSummary, lastMessageAt: number) => ({ ...summary, threads: [{ ...summary.threads[0]!, lastMessageAt }] });
  const shadow = await mount(backend({ mockups: { list: [at(a!, 1), at(b!, 50), at(c!, 2), at(d!, 60)], forThread: [] } }));
  await press("m");
  expect(excerpts(section(shadow, "This page"))).toEqual(["pilot proposal 0", "pilot proposal 1"]);
  expect(otherSections(shadow).map((element) => element.getAttribute("aria-label"))).toEqual(["Page settings", "Page billing"]);
});

const deferred = () => {
  let resolve = () => {};
  return { until: new Promise<void>((done) => (resolve = done)), resolve: () => resolve() };
};

test("this page and the other pages each have their own Show more, which loads only its part", async () => {
  const shadow = await mount(backend({ mockups: { list: [...proposals("pilot", 25, 1000), ...proposals("settings", 25, 900)], forThread: [] } }));
  await press("m");
  expect(excerpts(section(shadow, "This page"))).toHaveLength(20);
  expect(excerpts(section(shadow, "Page settings"))).toHaveLength(20);
  await click(button(shadow, "Show more on this page"));
  expect(excerpts(section(shadow, "This page"))).toHaveLength(25);
  expect(excerpts(section(shadow, "Page settings"))).toHaveLength(20);
  expect(button(shadow, "Show more on this page")).toBeNull();
  await click(button(shadow, "Show more from other pages"));
  expect(excerpts(section(shadow, "Page settings"))).toHaveLength(25);
  expect(button(shadow, "Show more from other pages")).toBeNull();
});

test("while more threads load, Show more says Loading… and the threads shown stay", async () => {
  const gate = deferred();
  const shadow = await mount(backend({ mockups: { list: proposals("pilot", 25), forThread: [], hold: gate.until } }));
  await press("m");
  await click(button(shadow, "Show more on this page"));
  const loading = button(shadow, "Show more on this page")!;
  expect(loading.textContent).toBe("Loading…");
  expect(loading.disabled).toBe(true);
  expect(excerpts(section(shadow, "This page"))).toHaveLength(20);

  await act(async () => gate.resolve());
  await frames();
  expect(excerpts(section(shadow, "This page"))).toHaveLength(25);
  expect(button(shadow, "Show more on this page")).toBeNull();
});

test("with exactly 20 threads, the last Show more adds nothing and then goes away", async () => {
  // As Convex pages: a page filled exactly to the end doesn't say it's the last.
  const shadow = await mount(backend({ mockups: { list: proposals("pilot", 20), forThread: [] } }));
  await press("m");
  expect(excerpts(section(shadow, "This page"))).toHaveLength(20);
  await click(button(shadow, "Show more on this page"));
  expect(excerpts(section(shadow, "This page"))).toHaveLength(20);
  expect(button(shadow, "Show more on this page")).toBeNull();
  expect(panel(shadow)!.textContent).not.toContain("No mockup threads");
});

test("when the list can't load, the panel stays and Try again reads it again", async () => {
  const data = backend({ mockups: { list: proposals("pilot", 3), forThread: [], failing: true } });
  const shadow = await mount(data);
  await press("m");
  expect(heading(shadow)).toBe("Mockup");
  expect(panel(shadow)!.textContent).toContain("Couldn't load this page's mockup threads");
  expect(button(panel(shadow)!, "New thread")).not.toBeNull();

  data.mockups!.failing = false;
  for (const again of [...panel(shadow)!.querySelectorAll("button")].filter((b) => b.textContent === "Try again")) await click(again);
  expect(excerpts(section(shadow, "This page"))).toEqual(["pilot proposal 0", "pilot proposal 1", "pilot proposal 2"]);
  expect(panel(shadow)!.textContent).not.toContain("Couldn't load");
});

test("a list from a backend that doesn't send mockups' threads shows no threads instead of breaking", async () => {
  // As from a backend deployed before mockups:list returned threads.
  const { threads: _threads, ...older } = summaryOf(mockup);
  const shadow = await mount(backend({ mockups: { ...only(mockup), list: [older as MockupSummary] } }));
  await press("m");
  expect(heading(shadow)).toBe("Mockup");
  expect(row(shadow, "Make Save stand out")).toBeNull();
  expect(button(panel(shadow)!, "New thread")).not.toBeNull();
});

test("a thread on this page opens directly, with its conversation, copy, and Hold to compare", async () => {
  const shadow = await mount(backend());
  await openThread(shadow);
  expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  expect(heading(shadow)).toBe("Checkout mockup");
  expect(panel(shadow)!.querySelector(".thread-heading .note")!.textContent).toBe("pilot");
  expect(panel(shadow)!.textContent).toContain("I made the Save button bolder.");
  // One copy: no width tabs.
  expect(panel(shadow)!.querySelector('[aria-label="Page copies"]')).toBeNull();

  const hold = button(shadow, "Hold to compare")!;
  expect(hold.hasAttribute("disabled")).toBe(false);
  const canvas = shadow.querySelector('[data-testid="mockup-canvas"]')!;
  await act(async () => void hold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })));
  expect(canvas.classList.contains("original")).toBe(true);
  await act(async () => void hold.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })));
  expect(canvas.classList.contains("original")).toBe(false);
  // Holding O does the same.
  await press("o");
  expect(canvas.classList.contains("original")).toBe(true);
  await press("o", "keyup");
  expect(canvas.classList.contains("original")).toBe(false);
});

test("a thread on another page asks to go there, then the prototype opens it and the thread shows", async () => {
  const app: { screen: string; viewState?: Record<string, string> } = { screen: "pilot" };
  const requests: RestoreRequest[] = [];
  const restoreContext = (request: RestoreRequest) => {
    requests.push(request);
    app.screen = request.screen;
    app.viewState = request.viewState as Record<string, string>;
    // The app renders the page it now shows.
    document.body.append(document.createElement("main"));
    return true;
  };
  const shadow = await mount(backend(), { app, restoreContext });
  await press("m");
  await click(row(shadow, "Rename the Save button"));

  const dialog = shadow.querySelector('[role="dialog"][aria-label="Go to settings?"]')!;
  expect(dialog.textContent).toContain("This mockup thread is on settings · tab: profile.");
  // Cancel stays on the list, on this page.
  await click(button(dialog, "Cancel"));
  expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  expect(requests).toEqual([]);

  await click(row(shadow, "Rename the Save button"));
  await click(button(shadow.querySelector('[role="dialog"]')!, "Go to settings"));
  await waitFor(() => heading(shadow) === "Rename the Save button");
  expect(requests.map(({ threadId, screen, viewState }) => ({ threadId, screen, viewState }))).toEqual([
    { threadId: "other-thread", screen: "settings", viewState: { tab: "profile" } },
  ]);
  expect(heading(shadow)).toBe("Rename the Save button");
  expect(panel(shadow)!.textContent).not.toContain("Comparing with the live page isn't available");
  expect(button(shadow, "Hold to compare")!.hasAttribute("disabled")).toBe(false);
});

test("where the prototype can't open another page, its thread opens on its copy and says it can't be compared", async () => {
  const shadow = await mount(backend());
  await press("m");
  await click(row(shadow, "Rename the Save button"));
  expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  expect(heading(shadow)).toBe("Rename the Save button");
  expect(panel(shadow)!.textContent).toContain("This mockup thread is on settings. Comparing with the live page isn't available here.");
  expect(button(shadow, "Hold to compare")!.hasAttribute("disabled")).toBe(true);
});

test("asking for a change starts a new mockup named after the message, with the comments added for it", async () => {
  const data = backend();
  const shadow = await mount(data);
  await press("m");
  expect(panel(shadow)!.querySelector('input[aria-label="Mockup title"]')).toBeNull();
  // The list has no message box: a thread starts from New thread.
  expect(panel(shadow)!.querySelector('textarea[aria-label="Ask for a change"]')).toBeNull();
  await click(button(panel(shadow)!, "New thread"));
  expect(heading(shadow)).toBe("New thread");

  await click(button(panel(shadow)!, "+ Add existing comment"));
  const picker = shadow.querySelector('[role="dialog"][aria-label="Add a comment"]')!;
  await type(picker.querySelector<HTMLInputElement>('input[aria-label="Search comments"]'), "hard to find");
  await click([...picker.querySelectorAll(".entry")].find((entry) => entry.textContent?.includes("Save is hard to find")));
  expect(panel(shadow)!.querySelector('[aria-label="Comments"]')!.textContent).toContain("Save is hard to find");

  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask for a change"]'), "  Make the header\ngreen ");
  await waitFor(() => !button(panel(shadow)!, "Send")!.hasAttribute("disabled"));
  await click(button(panel(shadow)!, "Send"));
  await waitFor(() => data.calls!.some((call) => call.name === "createThread"));

  // Linked as the mockup is made, so a refused link leaves no mockup, and Critiqs AI reads it with the first request.
  expect(data.calls).toContainEqual({
    name: "createMockup",
    args: expect.objectContaining({ title: "Make the header green", source: expect.objectContaining({ screen: "pilot" }), linkedThreadIds: ["feedback"] }),
  });
  expect(data.calls!.map((call) => call.name)).not.toContain("link");
  expect(data.calls).toContainEqual({
    name: "createThread",
    args: expect.objectContaining({ body: "  Make the header\ngreen ", mockup: { mockupId: "mockup", snapshotId: null, node: null } }),
  });
});

test("Critiqs AI's reply carries its version card to view or restore, and an older version says so", async () => {
  const data = backend();
  const shadow = await mount(data);
  await openThread(shadow);

  const reply = [...panel(shadow)!.querySelectorAll(".message")].find((element) => element.textContent?.includes("bolder"))!;
  expect(reply.querySelector(".author")!.textContent).toBe("Critiqs AI");
  expect(reply.querySelector(".badge.ai")!.textContent).toBe("AI");
  const card = reply.querySelector('[aria-label="Version 1"]')!;
  expect(card.textContent).toContain("Version 1");
  // The reviewer's own message has no version.
  const ask = [...panel(shadow)!.querySelectorAll(".message")].find((element) => element.textContent?.includes("stand out"))!;
  expect(ask.querySelector(".version-card")).toBeNull();

  await click(button(card, "View"));
  const card1 = () => panel(shadow)!.querySelector('[aria-label="Version 1"]')!;
  expect(panel(shadow)!.querySelector(".mockup-banner")!.textContent).toBe("Viewing version 1·Back to latest");
  expect(card1().textContent).toContain("On the copy");
  await click(button(panel(shadow)!, "Back to latest"));
  expect(panel(shadow)!.textContent).not.toContain("Viewing version 1");
  await click(button(card1(), "Restore"));
  expect(data.calls).toContainEqual({ name: "restore", args: { mockupId: "mockup", number: 1, expectedHead: 2 } });
});

test("+ Add comment in a thread links one of the project's comments and shows it, removable", async () => {
  const other: ThreadSummary = { ...feedback, _id: "elsewhere", anchor: { ...anchor, screen: "settings" }, preview: { body: "Labels are vague", authorName: "Lee", authorImageUrl: null } };
  const data = backend({ threads: [other, feedback], mockups: { ...backend().mockups!, detail: { ...mockup, linkedThreadIds: [] } } });
  const shadow = await mount(data);
  await openThread(shadow);
  // Nothing linked yet: only "+ Add existing comment" above the reply field.
  expect(panel(shadow)!.querySelectorAll('[aria-label="Comments"] .chip-text')).toHaveLength(0);

  await click(button(panel(shadow)!, "+ Add existing comment"));
  const picker = shadow.querySelector('[role="dialog"][aria-label="Add a comment"]')!;
  // This page's comments first; others say where they are.
  const options = [...picker.querySelectorAll(".entry")];
  expect(options.map((entry) => entry.querySelector(".excerpt")!.textContent)).toEqual(["Save is hard to find", "Labels are vague"]);
  expect(options[1]!.textContent).toContain("On settings");
  await type(picker.querySelector<HTMLInputElement>('input[aria-label="Search comments"]'), "vague");
  expect([...picker.querySelectorAll(".entry")]).toHaveLength(1);
  await click(picker.querySelector(".entry"));
  expect(data.calls).toContainEqual({ name: "link", args: { mockupId: "mockup", threadId: "elsewhere" } });
  expect(shadow.querySelector('[aria-label="Add a comment"]')).toBeNull();
});

test("a linked comment shows as a chip in the composer, above the reply field, and removing it unlinks it", async () => {
  const data = backend();
  const shadow = await mount(data);
  await openThread(shadow);
  const chips = panel(shadow)!.querySelector('[aria-label="Comments"]')!;
  // In the composer, before the field, beside "+ Add existing comment", like a chat's added context.
  const composer = chips.closest("form")!;
  expect(composer.querySelector("textarea")!.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(button(chips, "+ Add existing comment")).not.toBeNull();
  expect(chips.textContent).toContain("Save is hard to find");
  await click(button(chips, "Remove comment: Save is hard to find"));
  expect(data.calls).toContainEqual({ name: "unlink", args: { mockupId: "mockup", threadId: "feedback" } });
});

test("a comment linked to a mockup opens its thread, and mockup threads stay out of the comments list", async () => {
  const data = backend({ threads: [feedback, mockupThread] });
  const shadow = await mount(data);
  await click(button(shadow, "Comment mode"));
  await click(button(shadow, "Comments"));
  expect([...shadow.querySelectorAll('aside[aria-label="Critiqs comments"] .entry')].map((entry) => entry.textContent)).not.toContainEqual(
    expect.stringContaining("Make Save stand out"),
  );
  await click(shadow.querySelector("aside .entry"));
  await click(button(shadow, "Open mockup: Checkout mockup"));
  await waitFor(() => panel(shadow)?.querySelector(".thread-heading") != null);
  expect(heading(shadow)).toBe("Checkout mockup");
  expect(panel(shadow)!.textContent).toContain("I made the Save button bolder.");
});

test("a reply in a mockup thread asks Critiqs AI, and an unavailable AI says why", async () => {
  const data = backend();
  data.mockups!.mockupReply = async () => {
    const { ConvexError } = await import("convex/values");
    throw new ConvexError({ code: "unavailable", message: "AI isn't set up for this project yet." });
  };
  const shadow = await mount(data);
  await openThread(shadow);
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]'), "Make it green");
  await click(button(shadow, "Reply"));
  // The description step lays the copy out in a frame, which may wait for it to load.
  await waitFor(() => panel(shadow)!.textContent?.includes("AI isn't set up") === true);
  expect(data.calls!.some((call) => call.name === "mockupReply")).toBe(true);
  expect(panel(shadow)!.textContent).toContain("AI isn't set up for this project yet.");
  expect(button(shadow, "Open AI settings")).not.toBeNull();
});

test("a request the project's AI usage rule refuses until Your AI is set up offers to set it up", async () => {
  const data = backend({
    personalAiSettings: {
      saved: false,
      enabled: false,
      mode: "managed",
      managedModel: null,
      provider: null,
      model: null,
      models: [],
      baseUrl: null,
      keyHint: null,
      deployment: { managed: true, managedModels: [{ id: "default", label: "Critiqs AI", credits: 1 }], defaultProvider: null, keysStorable: true, allowedEndpoints: [] },
      status: { ready: false, reason: "Set up your AI to use this." },
      lastTest: null,
    },
  });
  data.mockups!.mockupReply = async () => {
    const { ConvexError } = await import("convex/values");
    throw new ConvexError({ code: "setup-ai", message: "Set up your AI to use this." });
  };
  const shadow = await mount(data, { personalAi: true });
  await openThread(shadow);
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]'), "Make it green");
  await click(button(shadow, "Reply"));
  await waitFor(() => button(shadow, "Set up your AI") !== null);
  expect(panel(shadow)!.textContent).toContain("Set up your AI to use this.");
  // It isn't the project's AI that is missing, so the owner isn't sent to the project's settings.
  expect(button(shadow, "Open AI settings")).toBeNull();
  expect(button(shadow, "Try again")).not.toBeNull();
  await click(button(shadow, "Set up your AI"));
  const yourAi = shadow.querySelector('[role="dialog"][aria-label="Your AI"]');
  expect(yourAi?.querySelector("h3")?.textContent).toBe("Your AI");
});

test("while Critiqs AI is answering, another request waits instead of racing it", async () => {
  const data = backend();
  data.mockups!.mockupReply = () => new Promise(() => {});
  const shadow = await mount(data);
  await openThread(shadow);
  const field = () => panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]');
  await type(field(), "Make it green");
  await click(button(shadow, "Reply"));
  await waitFor(() => data.calls!.some((call) => call.name === "mockupReply"));
  await type(field(), "And bigger");
  expect(button(shadow, "Reply")!.hasAttribute("disabled")).toBe(true);
  await click(button(shadow, "Reply"));
  expect(data.calls!.filter((call) => call.name === "mockupReply")).toHaveLength(1);
  // Nor can a new thread start meanwhile.
  await click(button(shadow, "All mockup threads"));
  await click(button(panel(shadow)!, "New thread"));
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask for a change"]'), "Another idea");
  expect(button(panel(shadow)!, "Send")!.hasAttribute("disabled")).toBe(true);
});

test("while Critiqs AI works, the thread shows its steps and a light sweeps over the copy it edits, not over the list's fresh copy", async () => {
  const data = backend();
  let answer: (() => void) | null = null;
  data.mockups!.mockupReply = () => new Promise((resolve) => (answer = () => resolve({ messageId: "ai", version: null, remaining: false })));
  const shadow = await mount(data);
  await openThread(shadow);
  expect(shadow.querySelector(".ai-scan")).toBeNull();
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]'), "Make it green");
  await click(button(shadow, "Reply"));
  await waitFor(() => data.calls!.some((call) => call.name === "mockupReply"));
  await waitFor(() => panel(shadow)!.querySelector('[role="status"].ai-working') !== null);
  const working = panel(shadow)!.querySelector('[role="status"].ai-working')!;
  expect([...working.querySelectorAll(".ai-steps li")].map((step) => [step.textContent, step.className])).toEqual([
    ["✓Read the page", "done"],
    ["Change the HTML and CSS", "now"],
  ]);
  expect(shadow.querySelector(".ai-scan")?.textContent).toBe("Critiqs AI is editing this copy");
  // The list shows a fresh copy of the live page, which Critiqs AI isn't editing.
  await click(button(shadow, "All mockup threads"));
  expect(shadow.querySelector(".ai-scan")).toBeNull();
  answer!();
  await frames();
  expect(shadow.querySelector(".ai-scan")).toBeNull();
});

test("a new copy is offered only when the thread's page is the one shown, since it freezes the live page", async () => {
  const wide = { ...mockup, snapshots: [{ ...mockup.snapshots[0]!, width: 1600 }] };
  const offered = async (screen: string) => {
    const shadow = await mount(backend({ mockups: only(wide) }), { app: { screen } });
    await press("m");
    await click(panel(shadow)!.querySelector("section .entry"));
    const found = [...shadow.querySelectorAll("button")].some((candidate) => candidate.textContent?.startsWith("Take a copy at"));
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    return found;
  };
  expect(await offered("pilot")).toBe(true);
  expect(await offered("settings")).toBe(false);
});

test("a thread with two copies shows width tabs, and a copy taken after changes says how to bring them to it", async () => {
  const twoCopies: MockupDetail = {
    ...mockup,
    snapshots: [mockup.snapshots[0]!, { _id: "phone", width: 390, height: 1800, capturedAt: 2, createdByName: "Dana" }],
    versions: [{ ...mockup.versions[0]!, edits: { desktop: [{ kind: "css", css: "h1 { color: navy }" }] } }],
  };
  const shadow = await mount(backend({ mockups: only(twoCopies) }));
  await openThread(shadow);
  expect(button(shadow, "1024 px")!.getAttribute("aria-pressed")).toBe("true");
  expect(panel(shadow)!.textContent).not.toContain("Earlier changes were made on other copies");
  await click(button(shadow, "390 px"));
  expect(panel(shadow)!.textContent).toContain("Earlier changes were made on other copies. Ask in this thread to bring them to this one.");
});

test("pressing Try again twice starts one Critiqs AI turn", async () => {
  const data = backend();
  let calls = 0;
  data.mockups!.mockupReply = async () => {
    calls++;
    if (calls === 1) {
      const { ConvexError } = await import("convex/values");
      throw new ConvexError({ code: "unavailable", message: "The model didn't answer." });
    }
    return new Promise(() => {});
  };
  const shadow = await mount(data);
  await openThread(shadow);
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]'), "Make it green");
  await click(button(shadow, "Reply"));
  await waitFor(() => button(shadow, "Try again") !== null);
  const again = button(shadow, "Try again")!;
  await act(async () => {
    again.click();
    again.click();
  });
  for (let i = 0; i < 10; i++) await frames();
  expect(calls).toBe(2);
});

test("a mockup made on one record's page goes back to that record, even from the same screen", async () => {
  const alex: MockupDetail = { ...otherMockup, source: { ...otherMockup.source, screen: "pilot", viewState: {}, recordKey: "alex" } };
  const requests: RestoreRequest[] = [];
  const restoreContext = (request: RestoreRequest) => {
    requests.push(request);
    document.querySelector("[data-critiqs-record]")?.setAttribute("data-critiqs-record", request.recordKey ?? "");
    return true;
  };
  pageElement("main", { "data-critiqs-record": "sam" });
  const shadow = await mount(backend({ mockups: { list: [summaryOf(alex)], detail: alex, details: { other: alex }, forThread: [] } }), { restoreContext });
  await press("m");
  await click(row(shadow, "Rename the Save button"));
  await click(button(shadow.querySelector('[role="dialog"]')!, "Go to pilot"));
  await waitFor(() => requests.length > 0);
  expect(requests.map(({ recordKey, scope }) => ({ recordKey, scope }))).toEqual([{ recordKey: "alex", scope: "record" }]);
});

test("a record's mockup opened over another record of its screen can't be compared or copied there", async () => {
  const alex: MockupDetail = {
    ...otherMockup,
    source: { ...otherMockup.source, screen: "pilot", viewState: {}, recordKey: "alex" },
    snapshots: [{ ...mockup.snapshots[0]!, width: 1600 }],
  };
  pageElement("main", { "data-critiqs-record": "sam" });
  // The prototype refuses to go to Alex's record, so Sam's page stays beneath the copy.
  const shadow = await mount(backend({ mockups: { list: [summaryOf(alex)], detail: alex, details: { other: alex }, forThread: [] } }), { restoreContext: () => false });
  await press("m");
  await click(row(shadow, "Rename the Save button"));
  await click(button(shadow.querySelector('[role="dialog"]')!, "Go to pilot"));
  await waitFor(() => heading(shadow) === "Rename the Save button");
  expect(button(shadow, "Hold to compare")!.hasAttribute("disabled")).toBe(true);
  expect(panel(shadow)!.textContent).toContain("Comparing with the live page isn't available here.");
  await press("o");
  expect(shadow.querySelector('[data-testid="mockup-canvas"]')!.classList.contains("original")).toBe(false);
  // Taking a copy would freeze Sam's page into Alex's mockup.
  expect([...shadow.querySelectorAll("button")].some((candidate) => candidate.textContent?.startsWith("Take a copy at"))).toBe(false);
});

test("a restore that shows the screen but not the mockup's record doesn't count as showing its page", async () => {
  const alex: MockupDetail = { ...otherMockup, source: { ...otherMockup.source, screen: "pilot", viewState: {}, recordKey: "alex" } };
  pageElement("main", { "data-critiqs-record": "sam" });
  // The prototype says it restored the view, but Sam's record is still shown.
  const shadow = await mount(backend({ mockups: { list: [summaryOf(alex)], detail: alex, details: { other: alex }, forThread: [] } }), { restoreContext: () => true });
  await press("m");
  await click(row(shadow, "Rename the Save button"));
  await click(button(shadow.querySelector('[role="dialog"]')!, "Go to pilot"));
  await waitFor(() => heading(shadow) === "Rename the Save button", 250);
  expect(heading(shadow)).toBe("Rename the Save button");
  expect(shadow.textContent).toContain("The prototype couldn't open pilot");
  expect(button(shadow, "Hold to compare")!.hasAttribute("disabled")).toBe(true);
});

/** Starts a new thread and asks for a change in it, and waits for the mockup thread it saves. */
async function askForChange(shadow: ShadowRoot, data: FakeBackend, text: string) {
  await click(button(panel(shadow)!, "New thread"));
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask for a change"]'), text);
  await waitFor(() => !button(panel(shadow)!, "Send")!.hasAttribute("disabled"));
  await click(button(panel(shadow)!, "Send"));
  await waitFor(() => data.calls!.some((call) => call.name === "createThread"));
}

const created = (data: FakeBackend) => {
  const upload = data.calls!.find((call) => call.name === "uploadSnapshot")!.args as { html: string };
  const mockupArgs = data.calls!.find((call) => call.name === "createMockup")!.args as { source: { screen: string; url: string } };
  return { html: upload.html, source: mockupArgs.source };
};

test("a new mockup keeps the page details of the moment its copy was frozen, even if the page changed since", async () => {
  const app: { screen: string; viewState?: Record<string, string> } = { screen: "pilot" };
  const data = backend();
  const heading = pageElement("h1", {}, "Pilot page");
  const shadow = await mount(data, { app });
  await press("m");
  await waitFor(() => !shadow.textContent!.includes("Freezing the page"));
  // The prototype moves on beneath the frozen copy.
  app.screen = "settings";
  heading.textContent = "Settings page";
  await frames();
  await askForChange(shadow, data, "Make the header green");
  const { html, source } = created(data);
  expect(html).toContain("Pilot page");
  expect(source.screen).toBe("pilot");
});

test("cancelling a visit the prototype already began freezes the page it now shows, so a new mockup matches its details", async () => {
  const app: { screen: string; viewState?: Record<string, string> } = { screen: "pilot" };
  const heading = pageElement("h1", {}, "Pilot page");
  // The prototype shows settings, then never reports back.
  const restoreContext = (request: RestoreRequest) => {
    app.screen = request.screen;
    app.viewState = request.viewState as Record<string, string>;
    heading.textContent = "Settings page";
    return new Promise<boolean>(() => {});
  };
  const data = backend();
  const shadow = await mount(data, { app, restoreContext });
  await press("m");
  await waitFor(() => !shadow.textContent!.includes("Freezing the page"));
  await click(row(shadow, "Rename the Save button"));
  await click(button(shadow.querySelector('[role="dialog"]')!, "Go to settings"));
  await click(button(shadow.querySelector('[role="dialog"]')!, "Cancel"));
  expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  await waitFor(() => !shadow.textContent!.includes("Freezing the page"));
  await askForChange(shadow, data, "Make the header green");
  const { html, source } = created(data);
  expect(source.screen).toBe("settings");
  expect(html).toContain("Settings page");
});

test("a restore shows in the thread at its time with its version card, so the latest version is always marked", async () => {
  const data = backend();
  const shadow = await mount(data);
  await openThread(shadow);
  // Version 2 restored the original copy; no message carries it.
  const restored = panel(shadow)!.querySelector('[aria-label="Version 2"]');
  expect(restored).not.toBeNull();
  expect(restored!.textContent).toContain("Version 2 · latest");
  expect(restored!.textContent).toContain("On the copy");
  expect(button(restored!, "Restore")).toBeNull();
  const event = restored!.closest(".version-event")!;
  expect(event.textContent).toContain("Lee restored the original copy as Version 2");
  // After the reply that made Version 1, which is no longer marked latest.
  const items = [...panel(shadow)!.querySelectorAll(".messages > *")];
  expect(items.indexOf(event)).toBe(items.length - 1);
  const first = panel(shadow)!.querySelector('[aria-label="Version 1"]')!;
  expect(first.textContent).not.toContain("latest");
  await click(button(first, "Restore"));
  expect(data.calls).toContainEqual({ name: "restore", args: { mockupId: "mockup", number: 1, expectedHead: 2 } });
});

test("+ Add comment stops at the comments a mockup can link, and says so", async () => {
  const comments = Array.from({ length: 21 }, (_, index): ThreadSummary => ({
    ...feedback,
    _id: `comment-${index}`,
    preview: { body: `Comment ${index}`, authorName: "Dana", authorImageUrl: null },
  }));
  const full = { ...mockup, linkedThreadIds: comments.slice(0, 20).map((comment) => comment._id) };
  const shadow = await mount(backend({ threads: comments, mockups: only(full) }));
  await openThread(shadow);
  await click(button(panel(shadow)!, "+ Add existing comment"));
  const picker = shadow.querySelector('[role="dialog"][aria-label="Add a comment"]')!;
  expect(picker.querySelector(".entry")).toBeNull();
  expect(picker.textContent).toContain("A mockup links up to 20 comments. Remove one to add another.");
});


test("when only other pages can't load, this page's threads stay", async () => {
  const data = backend({ mockups: { list: [...proposals("pilot", 2), ...proposals("settings", 2)], forThread: [], failing: "elsewhere" } });
  const shadow = await mount(data);
  await press("m");
  expect(excerpts(section(shadow, "This page"))).toEqual(["pilot proposal 0", "pilot proposal 1"]);
  expect(panel(shadow)!.textContent).toContain("Couldn't load other pages' mockup threads");
  expect(panel(shadow)!.textContent).not.toContain("Couldn't load this page's");
});

test("going back from a new thread with nothing in it saves nothing, and its open comment picker goes with it", async () => {
  const data = backend();
  const shadow = await mount(data);
  await press("m");
  await click(button(panel(shadow)!, "New thread"));
  expect(shadow.querySelector(".mode-hint")!.textContent).toBe("Mockup mode: select an element to ask about it · V to leave");
  // With the panel closed, elements of the copy aren't chosen; the new thread waits as it was.
  await press("Escape");
  expect(panel(shadow)).toBeNull();
  expect(shadow.querySelector(".mode-hint")!.textContent).toBe("Mockup mode · V to leave");
  await click(button(shadow, "Mockup"));
  expect(heading(shadow)).toBe("New thread");
  await click(button(panel(shadow)!, "+ Add existing comment"));
  expect(shadow.querySelector('[role="dialog"][aria-label="Add a comment"]')).not.toBeNull();
  await click(button(shadow, "All mockup threads"));
  expect(shadow.querySelector('[role="dialog"][aria-label="Add a comment"]')).toBeNull();
  expect(heading(shadow)).toBe("Mockup");
  expect(data.calls!.some((call) => call.name === "createMockup" || call.name === "createThread")).toBe(false);

  // Keys work in a thread opened afterwards.
  await click(row(shadow, "Make Save stand out"));
  expect(heading(shadow)).toBe("Checkout mockup");
  const canvas = () => shadow.querySelector('[data-testid="mockup-canvas"]')!;
  await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true, composed: true, cancelable: true })));
  expect(canvas().classList.contains("original")).toBe(true);
  await act(async () => void window.dispatchEvent(new KeyboardEvent("keyup", { key: "o", bubbles: true, composed: true })));
  await press("Escape");
  expect(panel(shadow)).toBeNull();
});

test("Browse mode's side panel shows the project and its settings; Comment mode's shows the comments", async () => {
  const shadow = await mount(backend({ threads: [feedback] }));
  await click(button(shadow, "Project"));
  const project = shadow.querySelector('aside[aria-label="Critiqs project"]')!;
  expect(project.querySelector(".sidebar-header h2")!.textContent).toBe("Pilot");
  expect([...project.querySelectorAll("section")].map((part) => part.getAttribute("aria-label"))).toEqual([
    "Comments",
    "Who has access",
    "Your email notifications",
    "Documentation",
    "Project ID",
  ]);
  expect(project.querySelector('section[aria-label="Comments"]')!.textContent).toContain("1 open thread");
  expect(project.querySelector('section[aria-label="Who has access"]')!.textContent).toContain("Dana (you, project owner)");
  expect(project.textContent).not.toContain("Review address");
  expect(shadow.querySelector('aside[aria-label="Critiqs comments"]')).toBeNull();

  await click(button(project, "Show comments"));
  const comments = shadow.querySelector('aside[aria-label="Critiqs comments"]')!;
  expect(comments.querySelector(".sidebar-header h2")!.textContent).toBe("Comments");
  expect(comments.querySelector(".entry")!.textContent).toContain("Save is hard to find");
  expect(button(shadow, "Comment mode")!.getAttribute("aria-pressed")).toBe("true");
});

test("Project setup opened from the Project panel goes back to it", async () => {
  const shadow = await mount(backend({ threads: [feedback] }));
  await click(button(shadow, "Project"));
  await click(button(shadow, "Project setup"));
  expect(shadow.querySelector("aside .sidebar-header h2")!.textContent).toBe("Project setup");
  await click(button(shadow, "Back to project"));
  expect(shadow.querySelector('aside[aria-label="Critiqs project"] .sidebar-header h2')!.textContent).toBe("Pilot");
});

test("signed out, Browse mode's panel is still named Project", async () => {
  const signedOut = await mount(backend({ threads: [feedback] }), { signedIn: false });
  await click(button(signedOut, "Project"));
  const panel = signedOut.querySelector('aside[aria-label="Critiqs project"]')!;
  expect(panel.querySelector("h2")!.textContent).toBe("Project");
  expect(panel.textContent).toContain("Sign in to see this project");
});

test("the Project panel opens the documentation, which explains every part of Critiqs and can be searched", async () => {
  const shadow = await mount(backend({ threads: [feedback] }));
  await click(button(shadow, "Project"));
  await click(button(shadow, "Open documentation"));
  const docs = shadow.querySelector('aside[aria-label="Critiqs documentation"]')!;
  expect(docs.querySelector(".sidebar-header h2")!.textContent).toBe("Documentation");
  const titles = () => [...docs.querySelectorAll(".doc-topic summary")].map((summary) => summary.textContent);
  expect(titles()).toEqual(expect.arrayContaining(["Toolbar and modes", "The Project panel", "Leaving a comment", "Mockup mode", "Keyboard shortcuts"]));
  expect(docs.querySelectorAll(".doc-topic[open]")).toHaveLength(0);

  await type(docs.querySelector<HTMLInputElement>('input[aria-label="Search the documentation"]'), "compare");
  expect(titles()).toEqual(["Mockup mode", "Keyboard shortcuts"]);
  expect(docs.querySelectorAll(".doc-topic[open]")).toHaveLength(2);
  await type(docs.querySelector<HTMLInputElement>('input[aria-label="Search the documentation"]'), "zzz");
  expect(docs.textContent).toContain("Nothing in the documentation matches");

  // In the search field, Escape clears the search, then closes the panel.
  const search = docs.querySelector<HTMLInputElement>('input[aria-label="Search the documentation"]')!;
  const escape = () => act(async () => void search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await escape();
  expect(search.value).toBe("");
  expect(titles()).toHaveLength(16);
  await escape();
  expect(shadow.querySelector('aside[aria-label="Critiqs documentation"]')).toBeNull();
  await click(button(shadow, "Project"));
  await click(button(shadow.querySelector('aside[aria-label="Critiqs documentation"]')!, "Back to project"));
  expect(shadow.querySelector('aside[aria-label="Critiqs project"]')).not.toBeNull();
});

const modelSelect = (scope: ParentNode) => scope.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
const TWO_MODELS = {
  source: "project" as const,
  models: [
    { id: "fast", label: "Fast", credits: 1 },
    { id: "strong", label: "Strong", credits: 3, estimated: true as const },
  ],
  defaultModel: "fast",
};

async function choose(select: HTMLSelectElement | null, value: string) {
  if (select === null) throw new Error("No select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("with one model on offer, no model choice shows and Critiqs AI's requests name none", async () => {
  const data = backend({ aiChoice: { source: "personal", models: [{ id: "mine", label: "mine" }], defaultModel: "mine" } });
  const shadow = await mount(data, { modelLists: true });
  await openThread(shadow);
  expect(modelSelect(panel(shadow)!)).toBeNull();
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]'), "Make it green");
  await click(button(shadow, "Reply"));
  await waitFor(() => data.calls!.some((call) => call.name === "mockupReply"));
  expect(data.calls!.find((call) => call.name === "mockupReply")!.args).not.toHaveProperty("model");
});

test("with several models, each composer offers the choice, and Critiqs AI's requests name the one chosen, remembered for the project", async () => {
  const data = backend({ aiChoice: TWO_MODELS });
  // A backend that doesn't report model choices shows none.
  let shadow = await mount(data);
  await press("m");
  await click(button(panel(shadow)!, "New thread"));
  expect(modelSelect(panel(shadow)!)).toBeNull();

  shadow = await remount(data, { modelLists: true });
  await press("m");
  await click(button(panel(shadow)!, "New thread"));
  const select = modelSelect(panel(shadow)!)!;
  // Models by name; what the chosen one costs is in its hint.
  expect([...select.options].map((option) => option.textContent)).toEqual(["Fast", "Strong"]);
  expect(select.title).toBe("The model Critiqs AI answers with: 1 credit per request");
  expect(select.value).toBe("fast");
  await choose(select, "strong");
  expect(select.title).toBe("The model Critiqs AI answers with: about 3 credits per request");
  await type(panel(shadow)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask for a change"]'), "Make the header green");
  await waitFor(() => !button(panel(shadow)!, "Send")!.hasAttribute("disabled"));
  await click(button(panel(shadow)!, "Send"));
  await waitFor(() => data.calls!.some((call) => call.name === "mockupReply"));
  expect(data.calls!.find((call) => call.name === "mockupReply")!.args).toMatchObject({ model: "strong" });
  expect(localStorage.getItem("critiqs:mockup-model:project")).toBe('"strong"');

  // The thread's reply box offers it too, still on the model chosen.
  shadow = await remount(data, { modelLists: true });
  await openThread(shadow);
  expect(modelSelect(panel(shadow)!)!.value).toBe("strong");
  // A remembered model the connection no longer offers falls back to its default.
  localStorage.setItem("critiqs:mockup-model:project", '"gone"');
  shadow = await remount(data, { modelLists: true });
  await openThread(shadow);
  expect(modelSelect(panel(shadow)!)!.value).toBe("fast");
});

test("a mockup thread reads as a chat: people on the right in bubbles, Critiqs AI and coding agents on the left", async () => {
  const data = backend();
  data.threadDetails!["mockup-thread"] = detailOf(mockupThread, [
    message("ask", "Make Save stand out"),
    message("ai-1", "I made the Save button bolder.", { via: "ai", mockupVersion: 1, isMine: false, author: { name: "Dana", imageUrl: null } }),
    message("lee", "Can it be green?", { isMine: false, author: { name: "Lee", imageUrl: null } }),
    message("agent", "Pushed the change to a branch.", { via: "agent", isMine: false, author: { name: "Dana", imageUrl: null } }),
  ]);
  const shadow = await mount(data);
  await openThread(shadow);
  const sides = [...panel(shadow)!.querySelectorAll(".mockup-thread .message")].map((row) => [
    row.classList.contains("from-person") ? "right" : "left",
    row.querySelector(".author")!.textContent,
    (row.querySelector(".bubble") ?? row.querySelector(".body"))!.textContent,
  ]);
  expect(sides).toEqual([
    ["right", "Dana", "Make Save stand out"],
    ["left", "Critiqs AI", "I made the Save button bolder."],
    // Everyone's messages sit on the right, named, so people can tell each other apart.
    ["right", "Lee", "Can it be green?"],
    ["left", "Dana", "Pushed the change to a branch."],
  ]);
});

test("the panel's left edge resizes it within limits by keys, and the width is remembered", async () => {
  const shadow = await mount(backend());
  await openThread(shadow);
  const handle = panel(shadow)!.querySelector<HTMLElement>('[role="separator"][aria-label="Resize sidebar"]')!;
  const width = () => Number.parseFloat((panel(shadow) as HTMLElement).style.width);
  expect(width()).toBe(360);
  await act(async () => void handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
  expect(width()).toBe(384);
  expect(handle.getAttribute("aria-valuenow")).toBe("384");
  expect(localStorage.getItem("critiqs:sidebar-width")).toBe("384");
  await act(async () => void handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
  expect(width()).toBe(300);
  await act(async () => void handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  expect(width()).toBe(300);
  await act(async () => void handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(width()).toBe(360);
});

test("dragging the panel's edge resizes it, and a drag that loses the pointer ends instead of following later hovers", async () => {
  const shadow = await mount(backend());
  await openThread(shadow);
  const handle = panel(shadow)!.querySelector<HTMLElement>('[role="separator"][aria-label="Resize sidebar"]')!;
  Object.assign(handle, { setPointerCapture: () => undefined, hasPointerCapture: () => false, releasePointerCapture: () => undefined });
  const width = () => Number.parseFloat((panel(shadow) as HTMLElement).style.width);
  const pointer = (type: string, clientX: number) => act(async () => void handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX, bubbles: true })));
  await pointer("pointerdown", window.innerWidth - 360);
  await pointer("pointermove", window.innerWidth - 450);
  expect(width()).toBe(450);
  expect(handle.classList.contains("dragging")).toBe(true);
  // Capture lost, as when Critiqs is hidden mid-drag: the drag is over.
  await pointer("lostpointercapture", window.innerWidth - 450);
  expect(handle.classList.contains("dragging")).toBe(false);
  await pointer("pointermove", window.innerWidth - 600);
  expect(width()).toBe(450);
  // End goes to the widest this window allows, and says so.
  await act(async () => void handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
  const max = Math.min(720, window.innerWidth - 160);
  expect(width()).toBe(max);
  expect(handle.getAttribute("aria-valuemax")).toBe(String(max));
  await act(async () => void handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
});

test("with comments added, a thread starts or continues without typing, asking Critiqs AI to act on them", async () => {
  const sent: string[] = [];
  const data = backend({ reply: async (args) => (sent.push(args.body), "message") });
  const shadow = await mount(data);
  await openThread(shadow);
  // The thread has a linked comment, so Reply works with the box empty.
  const reply = button(panel(shadow)!, "Reply")!;
  expect(reply.disabled).toBe(false);
  await click(reply);
  expect(sent).toEqual(["Make the changes these comments ask for."]);
  expect(data.calls!.some((call) => call.name === "mockupReply")).toBe(true);
});

test("people's messages sit on the right with their avatar beside the bubble", async () => {
  const shadow = await mount(backend());
  await openThread(shadow);
  const mine = panel(shadow)!.querySelector(".mockup-thread .message.from-person")!;
  // Name and time above the bubble, and the avatar after it, on the right.
  expect([...mine.children].map((child) => child.className)).toEqual(["said", "avatar large"]);
  expect(mine.querySelector(".said .meta .author")!.textContent).toBe("Dana");
});
