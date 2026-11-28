import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Anchor, ThreadDetail, ThreadSummary } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { attachHost } from "../src/connect.tsx";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { hideClosedShadowTrees } from "./closed-shadow.ts";
import { commentField, fieldText, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The browser extension draws Critiqs in a closed shadow root, so the page it
// runs on can't read what Critiqs shows. The root is passed in, never read from
// the host (which a closed root hides), and every check of where a key came
// from or what has focus still sees inside it. An install's open root works as
// before.

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const TYPED = "Check move, colour and overlay: c v m o";
const target = { purposeId: "review", recordKey: null, clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } };
const anchor: Anchor = {
  screen: "pilot",
  viewState: {},
  scope: "shared",
  target,
  evidence: { url: "https://prototype.example/pilot", capturedAt: 1, revision: "v1", persona: null, viewport: { width: 800, height: 600 }, marker: null, userAgent: null },
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
  capture: { status: "failed", failureReason: "Blocked." },
  createdAt: 1,
  lastMessageAt: 1,
  messageCount: 1,
  projectId: "project",
  statusChangedByName: null,
  reattachedByName: null,
  readState: { lastReadAt: 1, manualUnread: false },
  messages: [
    { _id: "message", body: "Align the review button", createdAt: 1, editedAt: null, revision: "v1", author: { name: "Dana", imageUrl: null }, isMine: false, reactions: [], mentions: [] },
  ],
};
const backend: FakeBackend = {
  project: { _id: "project", name: "Pilot", tags: ["Bug"], createdAt: 1, reviewUrl: null, isOwner: true },
  threads: [summary],
  thread: detail,
};

let restore: () => void = () => undefined;
beforeAll(() => {
  restore = hideClosedShadowTrees();
});
afterAll(() => restore());

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
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

function prototypePage() {
  page = document.createElement("main");
  const button = document.createElement("button");
  button.setAttribute("data-critiqs-id", "review");
  button.textContent = "Review";
  button.getBoundingClientRect = () => new DOMRect(40, 80, 120, 30);
  button.getClientRects = () => [new DOMRect(40, 80, 120, 30)] as unknown as DOMRectList;
  (button as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  page.append(button);
  document.body.append(page);
  // Comment mode picks whatever is under the pointer.
  document.elementFromPoint = () => button;
  return { button };
}

async function frames() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** Critiqs mounted in a root of the given mode; counts every read of the host's `shadowRoot`. */
async function mount(mode: "open" | "closed", { sidebarOpen = false } = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  localStorage.setItem("critiqs:sidebar-open", JSON.stringify(sidebarOpen));
  const attached = attachHost(document.body, { mode });
  host = attached.host;
  const reads = { count: 0 };
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get;
  Object.defineProperty(host, "shadowRoot", {
    configurable: true,
    get() {
      reads.count++;
      return own?.call(this) ?? null;
    },
  });
  root = createRoot(attached.container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, presetTags: true } as const;
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(backend)}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={attached.host} shadow={attached.shadow} />
      </TransportContext.Provider>,
    ),
  );
  await frames();
  return { shadow: attached.shadow, reads };
}

const valueSetter = (field: HTMLInputElement | HTMLTextAreaElement) =>
  Object.getOwnPropertyDescriptor(field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!;

/**
 * Types text with key events as a browser delivers them: each key goes to the
 * focused field; unless something prevents it, its character is added and an
 * input event follows; then the key comes up.
 */
async function typeKeys(field: HTMLElement, text: string) {
  await act(async () => field.focus());
  for (const key of text) {
    const down = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
    await act(async () => void field.dispatchEvent(down));
    if (!down.defaultPrevented) {
      if (field.isContentEditable) await typeInto(field, fieldText(field) + key);
      else if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        await act(async () => {
          valueSetter(field).call(field, field.value + key);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
    }
    await act(async () => void field.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, composed: true })));
  }
  await frames();
}

const textOf = (field: HTMLElement) => (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : fieldText(field));
const pressed = (shadow: ShadowRoot, label: string) => shadow.querySelector(`button[aria-label="${label}"]`)!.getAttribute("aria-pressed");
const composer = (shadow: ShadowRoot) => shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]');
const button = (shadow: ShadowRoot, label: string) => shadow.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/** Clears a text input as selecting all and deleting would. */
async function clear(field: HTMLInputElement) {
  await act(async () => {
    valueSetter(field).call(field, "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("in a closed root the toolbar renders, the page layer draws pins and outlines, the page reads no shadow root, and Critiqs never reads host.shadowRoot", async () => {
  const { button: target } = prototypePage();
  const { shadow, reads } = await mount("closed");
  expect(host!.shadowRoot).toBeNull();
  reads.count = 0;
  expect(shadow.querySelector(".toolbar")).not.toBeNull();
  expect(shadow.querySelectorAll(".pin").length).toBe(1);
  // Comment mode outlines the element under the pointer.
  await act(async () => button(shadow, "Comment mode").click());
  await frames();
  await act(async () => void target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, clientX: 50, clientY: 90 })));
  await frames();
  expect(shadow.querySelector(".page-layer .target-box")).not.toBeNull();
  // A pick opens the comment box; a pin opens its thread.
  await act(async () => void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 })));
  await frames();
  expect(composer(shadow)).not.toBeNull();
  await act(async () => button(shadow, "Browse mode").click());
  await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
  await frames();
  expect(shadow.querySelector(".thread-window")).not.toBeNull();
  expect(reads.count).toBe(0);
});

for (const mode of ["closed", "open"] as const) {
  test(`typing Critiqs's shortcut letters into the comment field keeps every character and the mode (${mode} root)`, async () => {
    const { button: target } = prototypePage();
    const { shadow } = await mount(mode);
    await act(async () => button(shadow, "Comment mode").click());
    await frames();
    await act(async () => void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 })));
    await frames();
    const field = commentField(composer(shadow)!)!;
    await typeKeys(field, TYPED);
    expect(composer(shadow)).not.toBeNull();
    expect(textOf(commentField(composer(shadow)!)!)).toBe(TYPED);
    expect(pressed(shadow, "Comment mode")).toBe("true");
  });

  test(`typing them into a reply, the search field, a dialog's field and the tag field keeps every character and the mode (${mode} root)`, async () => {
    prototypePage();
    const { shadow } = await mount(mode, { sidebarOpen: true });

    // A reply, in the thread window.
    await act(async () => shadow.querySelector<HTMLButtonElement>(".pin")!.click());
    await frames();
    const reply = commentField(shadow, "Reply")!;
    await typeKeys(reply, TYPED);
    expect(textOf(commentField(shadow, "Reply")!)).toBe(TYPED);
    expect(shadow.querySelector(".thread-window")).not.toBeNull();
    expect(pressed(shadow, "Browse mode")).toBe("true");

    // The sidebar's search.
    await act(async () => button(shadow, "Comment mode").click());
    await frames();
    const search = shadow.querySelector<HTMLInputElement>('input[type="search"]')!;
    await typeKeys(search, TYPED);
    expect(search.value).toBe(TYPED);
    expect(pressed(shadow, "Comment mode")).toBe("true");

    // A dialog's field: Change display name.
    await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
    await act(async () => Array.from(shadow.querySelectorAll<HTMLElement>("[role='menuitem']")).find((item) => item.textContent === "Change display name…")!.click());
    await frames();
    const name = shadow.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
    await clear(name);
    await typeKeys(name, TYPED);
    expect(name.value).toBe(TYPED);
    expect(pressed(shadow, "Comment mode")).toBe("true");
    await act(async () => Array.from(shadow.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((item) => item.textContent === "Cancel")!.click());
    await frames();

    // The tag field, in Tags and AI.
    await act(async () => button(shadow, "Tags and AI settings").click());
    await frames();
    const tag = shadow.querySelector<HTMLInputElement>('input[aria-label="New preset tag"]')!;
    await typeKeys(tag, TYPED);
    expect(tag.value).toBe(TYPED);
    expect(pressed(shadow, "Comment mode")).toBe("true");
    expect(shadow.querySelector("[role='dialog']")).not.toBeNull();
  });
}

test("in a closed root, choosing a menu item with the mouse runs it: the menu doesn't take the press for a click elsewhere", async () => {
  prototypePage();
  const { shadow } = await mount("closed");
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  const item = Array.from(shadow.querySelectorAll<HTMLElement>("[role='menuitem']")).find((element) => element.textContent === "Change display name…")!;
  // What a browser reports under the pointer, from inside the root.
  (shadow as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => item;
  await act(async () => void item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, clientX: 10, clientY: 10 })));
  expect(item.isConnected).toBe(true);
  await act(async () => item.click());
  await frames();
  expect(shadow.querySelector('input[aria-label="Display name"]')).not.toBeNull();
  // A press on the page still closes a menu.
  await act(async () => shadow.querySelector<HTMLButtonElement>("[role='dialog'] button.btn")!.click());
  await frames();
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  expect(shadow.querySelector("[role='menu']")).not.toBeNull();
  await act(async () => void page!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, clientX: 600, clientY: 500 })));
  expect(shadow.querySelector("[role='menu']")).toBeNull();
});
