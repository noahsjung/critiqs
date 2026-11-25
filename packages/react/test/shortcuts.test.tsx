import { afterEach, expect, test } from "bun:test";
import type { Anchor, ThreadDetail, ThreadSummary } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { isHideShortcut } from "../src/hooks.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { commentField, fieldText, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Keyboard shortcuts: C and V switch modes, keeping a comment draft; Ctrl or
// Cmd + \ hides all of Critiqs and gives the host page back its input.

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
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
  const field = document.createElement("input");
  field.setAttribute("aria-label", "Host field");
  page.append(button, field);
  document.body.append(page);
  // Comment mode picks whatever is under the pointer.
  document.elementFromPoint = () => button;
  return { button, field };
}

let rerender: () => Promise<void> = async () => undefined;

async function mount({ sidebarOpen = false, data = backend } = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  localStorage.setItem("critiqs:sidebar-open", JSON.stringify(sidebarOpen));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const transport = fakeTransport(data);
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null } as const;
  // A fresh element each time, so a live update to `data` renders.
  const render = () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} />
      </TransportContext.Provider>,
    );
  rerender = async () => {
    await act(async () => render());
    await frames();
  };
  await act(async () => render());
  await frames();
  return shadow;
}

async function frames() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** Presses a key as the browser would deliver it to `target`, returning whether something prevented its default. */
async function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, composed: true, cancelable: true, ...init });
  await act(async () => void target.dispatchEvent(event));
  await frames();
  return event.defaultPrevented;
}

/**
 * Presses a letter as a browser would: unless something prevents the key's
 * default, its text goes to whatever has focus once the key's handlers ran,
 * such as a comment field the key itself opened.
 */
async function pressLetter(target: EventTarget, key: string) {
  const prevented = await press(target, { key });
  let focused: Element | null = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  if (!prevented && focused instanceof HTMLElement && focused.isContentEditable) await typeInto(focused, fieldText(focused) + key);
  else if (!prevented && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)) {
    await act(async () => {
      focused.value += key;
      focused.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  return prevented;
}

async function type(field: HTMLElement, value: string) {
  await typeInto(field, value);
}

const pressed = (shadow: ShadowRoot, label: string) => shadow.querySelector(`button[aria-label="${label}"]`)!.getAttribute("aria-pressed");
const composer = (shadow: ShadowRoot) => shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]');

async function draftComment(shadow: ShadowRoot, button: HTMLElement, text: string) {
  await act(async () => shadow.querySelector<HTMLButtonElement>('button[aria-label="Comment mode"]')!.click());
  await frames();
  await act(async () => void button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 })));
  await frames();
  await type(commentField(composer(shadow)!)!, text);
}

/** Opens the first thread from the comments list, which is Comment mode's panel, then returns to Browse mode. */
async function openFromList(shadow: ShadowRoot) {
  const mode = (label: string) => shadow.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  await act(async () => mode("Comment mode").click());
  await act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
  await act(async () => mode("Browse mode").click());
}

test("the hide shortcut is Ctrl or Cmd with backslash or pipe, ignoring repeats and composition", () => {
  const key = (init: KeyboardEventInit) => isHideShortcut(new KeyboardEvent("keydown", init));
  expect(key({ key: "\\", code: "Backslash", ctrlKey: true })).toBe(true);
  expect(key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true })).toBe(true);
  // Other layouts put backslash elsewhere: the physical key still works.
  expect(key({ key: "#", code: "Backslash", ctrlKey: true })).toBe(true);
  expect(key({ key: "\\", code: "Backslash" })).toBe(false);
  expect(key({ key: "\\", code: "Backslash", ctrlKey: true, altKey: true })).toBe(false);
  expect(key({ key: "\\", code: "Backslash", ctrlKey: true, repeat: true })).toBe(false);
  expect(key({ key: "\\", code: "Backslash", ctrlKey: true, isComposing: true })).toBe(false);
});

test("V returns to Browse mode and keeps a comment draft; C brings it back; Escape discards it", async () => {
  const { button } = prototypePage();
  const shadow = await mount();
  await draftComment(shadow, button, "Half-written #wording");
  expect(composer(shadow)).not.toBeNull();
  // While typing in the comment, V is a letter.
  expect(await press(commentField(composer(shadow)!)!, { key: "v" })).toBe(false);
  expect(pressed(shadow, "Comment mode")).toBe("true");

  // Outside a text field, V is Browse mode, kept from the prototype.
  expect(await press(document.body, { key: "v" })).toBe(true);
  expect(pressed(shadow, "Browse mode")).toBe("true");
  expect(composer(shadow)).toBeNull();
  expect(shadow.querySelector(".toasts")!.textContent).toContain("Comment draft kept");
  // In Browse mode V is the prototype's own key.
  expect(await press(document.body, { key: "v" })).toBe(false);
  // Escape in Browse mode, such as to close the side panel, keeps the draft.
  await press(document.body, { key: "Escape" });

  // C brings the draft back exactly: the key opens the comment, typing nothing into it.
  expect(await pressLetter(document.body, "c")).toBe(true);
  expect(pressed(shadow, "Comment mode")).toBe("true");
  const resumed = commentField(composer(shadow)!)!;
  expect(shadow.activeElement).toBe(resumed);
  expect(fieldText(resumed)).toBe("Half-written #wording");
  // In the comment field, C is a letter.
  expect(await pressLetter(resumed, "c")).toBe(false);
  expect(fieldText(resumed)).toBe("Half-written #wordingc");
  expect(pressed(shadow, "Comment mode")).toBe("true");
  await type(resumed, "Half-written #wording");
  // The restored draft highlights its hashtags inside the input.
  expect(Array.from(composer(shadow)!.querySelectorAll(".tag-pill")).map((chip) => chip.textContent)).toEqual(["#wording"]);

  expect(await press(document.body, { key: "Escape" })).toBe(true);
  expect(composer(shadow)).toBeNull();
  await press(document.body, { key: "v" });
  await press(document.body, { key: "c" });
  expect(composer(shadow)).toBeNull();
});

test("an empty new comment is discarded when V leaves Comment mode", async () => {
  const { button } = prototypePage();
  const shadow = await mount();
  await draftComment(shadow, button, "   ");
  await press(document.body, { key: "V", shiftKey: true });
  expect(pressed(shadow, "Browse mode")).toBe("true");
  await press(document.body, { key: "c" });
  expect(composer(shadow)).toBeNull();
});

test("Ctrl+\\ hides everything and gives the host page its input; Cmd+| restores the open thread, its draft, and focus", async () => {
  const { button, field } = prototypePage();
  const shadow = await mount({ sidebarOpen: true });
  await openFromList(shadow);
  await frames();
  const reply = commentField(shadow, "Reply")!;
  await type(reply, "Unsent reply");
  await act(async () => reply.focus());

  // Works even while typing in Critiqs.
  expect(await press(reply, { key: "\\", code: "Backslash", ctrlKey: true })).toBe(true);
  expect(host!.style.getPropertyValue("display")).toBe("none");
  expect(shadow.activeElement).toBeNull();

  // Hidden, the page's clicks and keys are its own: nothing closes, picks, or is kept from it.
  await act(async () => void button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })));
  expect(await press(field, { key: "Escape" })).toBe(false);
  expect(await press(document.body, { key: "c" })).toBe(false);
  expect(pressed(shadow, "Comment mode")).toBe("false");
  // Holding the shortcut down doesn't flicker Critiqs back.
  expect(await press(document.body, { key: "\\", code: "Backslash", ctrlKey: true, repeat: true })).toBe(false);
  expect(host!.style.getPropertyValue("display")).toBe("none");

  expect(await press(field, { key: "|", code: "Backslash", metaKey: true, shiftKey: true })).toBe(true);
  expect(host!.style.getPropertyValue("display")).toBe("");
  const restored = commentField(shadow, "Reply");
  expect(restored).toBe(reply);
  expect(fieldText(restored!)).toBe("Unsent reply");
  expect(shadow.activeElement).toBe(reply);
  expect(shadow.querySelector(".sidebar")).not.toBeNull();
});

test("hiding in Comment mode stops picking until Critiqs returns", async () => {
  const { button } = prototypePage();
  const shadow = await mount();
  await act(async () => shadow.querySelector<HTMLButtonElement>('button[aria-label="Comment mode"]')!.click());
  await frames();
  expect(document.documentElement.style.cursor).toBe("crosshair");
  await press(document.body, { key: "\\", code: "Backslash", ctrlKey: true });
  expect(document.documentElement.style.cursor).toBe("");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 });
  await act(async () => void button.dispatchEvent(click));
  expect(click.defaultPrevented).toBe(false);
  expect(composer(shadow)).toBeNull();
  await press(document.body, { key: "\\", code: "Backslash", ctrlKey: true });
  expect(document.documentElement.style.cursor).toBe("crosshair");
  expect(pressed(shadow, "Comment mode")).toBe("true");
});

test("hidden, a thread marked unread elsewhere stays unread", async () => {
  prototypePage();
  const calls: { name: string; args: unknown }[] = [];
  const data: FakeBackend = { ...backend, calls };
  // Messages fill the thread window, so the open thread is read.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.closest?.(".message, .thread-body, .window-body") ? new DOMRect(0, 0, 300, 200) : rect.call(this);
  };
  try {
    const shadow = await mount({ sidebarOpen: true, data });
    await openFromList(shadow);
    await frames();
    // Unread while visible: reading marks it read again.
    data.thread = { ...detail, readState: { lastReadAt: 1, manualUnread: true } };
    await rerender();
    expect(calls.filter((call) => call.name === "markRead")).toHaveLength(1);

    await press(document.body, { key: "\\", code: "Backslash", ctrlKey: true });
    // Another tab marks it unread again while Critiqs is hidden.
    data.thread = { ...detail, readState: { lastReadAt: 1, manualUnread: true }, lastMessageAt: 1 };
    await rerender();
    expect(host!.style.getPropertyValue("display")).toBe("none");
    expect(calls.filter((call) => call.name === "markRead")).toHaveLength(1);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("C enters Comment mode without typing, and is a letter in the host page's fields", async () => {
  const { field } = prototypePage();
  const shadow = await mount();
  await act(async () => field.focus());
  expect(await pressLetter(field, "c")).toBe(false);
  expect(field.value).toBe("c");
  expect(pressed(shadow, "Comment mode")).toBe("false");
  await act(async () => field.blur());
  expect(await pressLetter(document.body, "c")).toBe(true);
  expect(pressed(shadow, "Comment mode")).toBe("true");
  expect(await pressLetter(document.body, "c")).toBe(true);
  expect(pressed(shadow, "Browse mode")).toBe("true");
});

test("each placement choice has its own help, which never changes the choice; Escape dismisses help before the draft", async () => {
  const { button, field } = prototypePage();
  button.setAttribute("data-critiqs-record", "alex");
  const shadow = await mount({ sidebarOpen: true });
  await draftComment(shadow, button, "Keep this draft #wording");
  const form = composer(shadow)!;
  // No title above the choices, which name what they apply to.
  expect(form.textContent).not.toContain("Comment on");
  const choices = form.querySelector('[role="group"][aria-label="Comment placement"]')!;
  const options = Array.from(choices.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"));
  expect(options.map((option) => option.textContent?.trim())).toEqual(["This component", "Matching components"]);
  expect(choices.textContent).not.toMatch(/\bones?\b/);
  expect(options[0]!.getAttribute("aria-pressed")).toBe("true");
  // Each choice's information button comes right after it, as a separate button.
  const [thisInfo, matchingInfo] = options.map((option) => option.nextElementSibling!.querySelector<HTMLButtonElement>("button.icon-btn")!);
  expect(thisInfo!.getAttribute("aria-label")).toBe("About commenting on this component");
  expect(matchingInfo!.getAttribute("aria-label")).toBe("About commenting on matching components");
  expect(choices.querySelector("button button")).toBeNull();
  const tooltip = () => shadow.querySelector('[role="tooltip"]');

  await act(async () => thisInfo!.focus());
  expect(tooltip()!.textContent).toContain("this button’s spacing or placement");
  expect(thisInfo!.getAttribute("aria-describedby")).toBe(tooltip()!.id);
  expect(await press(thisInfo!, { key: "Escape" })).toBe(true);
  expect(tooltip()).toBeNull();
  expect(fieldText(commentField(composer(shadow)!)!)).toBe("Keep this draft #wording");

  // Tapping a choice's help opens it without choosing it.
  await act(async () => matchingInfo!.click());
  expect(tooltip()!.textContent).toContain("One shared discussion for this same component");
  expect(tooltip()!.textContent).toContain("who can read the comment doesn’t change");
  expect(matchingInfo!.getAttribute("aria-describedby")).toBe(tooltip()!.id);
  expect(options[0]!.getAttribute("aria-pressed")).toBe("true");
  expect(options[1]!.getAttribute("aria-pressed")).toBe("false");

  // Escape also closes hovered help when focus is still in the input.
  await act(async () => matchingInfo!.blur());
  await act(async () => commentField(form)!.focus());
  await act(async () => thisInfo!.parentElement!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  expect(tooltip()!.textContent).toContain("here only");
  expect(await press(commentField(form)!, { key: "Escape" })).toBe(true);
  expect(tooltip()).toBeNull();
  expect(composer(shadow)).not.toBeNull();
  const search = shadow.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => search.focus());
  await act(async () => matchingInfo!.parentElement!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  expect(tooltip() !== null).toBe(true);
  expect(await press(search, { key: "Escape" })).toBe(true);
  expect(tooltip()).toBeNull();
  expect(fieldText(commentField(composer(shadow)!)!)).toBe("Keep this draft #wording");

  // Hidden, Critiqs leaves the page's Escape alone, help or not.
  await act(async () => thisInfo!.click());
  expect(await press(document.body, { key: "\\", code: "Backslash", ctrlKey: true })).toBe(true);
  expect(await press(field, { key: "Escape" })).toBe(false);
  expect(await press(field, { key: "|", code: "Backslash", metaKey: true, shiftKey: true })).toBe(true);
  expect(composer(shadow)).not.toBeNull();

  await act(async () => options[1]!.click());
  expect(options[1]!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => options[0]!.click());
  expect(options[0]!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => thisInfo!.click());
  expect(tooltip() !== null).toBe(true);
  await act(async () => commentField(form)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })));
  expect(tooltip()).toBeNull();
  expect(fieldText(commentField(composer(shadow)!)!)).toBe("Keep this draft #wording");
});
