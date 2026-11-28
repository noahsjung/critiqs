import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { attachHost } from "../src/connect.tsx";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { madeUp, real } from "./closed-shadow.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Two options the browser extension sets when it draws Critiqs in the page:
// shortcuts that ignore key events the page's own scripts make up
// (`trustedEventsOnly`), and its own items in the account menu
// (`accountItems`). Without them, Critiqs behaves as installed.

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const backend = (): FakeBackend => ({
  project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
  threads: [],
  mockups: { list: [] },
});

let root: Root | null = null;
let host: HTMLElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

async function frames() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

type Options = { trustedEventsOnly?: boolean; accountItems?: { label: string; onSelect(): void }[] };

async function mount(options: Options = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  const attached = attachHost(document.body);
  host = attached.host;
  root = createRoot(attached.container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, mockups: true } as const;
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(backend())}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={attached.host} shadow={attached.shadow} {...options} />
      </TransportContext.Provider>,
    ),
  );
  await frames();
  return attached.shadow;
}

const keydown = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, composed: true, cancelable: true, ...init });
async function send(target: EventTarget, event: Event) {
  await act(async () => void target.dispatchEvent(event));
  await frames();
}
const mode = (shadow: ShadowRoot) => ["Browse mode", "Comment mode", "Mockup mode"].find((label) => shadow.querySelector(`button[aria-label="${label}"]`)?.getAttribute("aria-pressed") === "true");
const hide = { key: "\\", code: "Backslash", ctrlKey: true };
const menuItem = (shadow: ShadowRoot, label: string) => Array.from(shadow.querySelectorAll<HTMLElement>("[role='menuitem']")).find((item) => item.textContent === label);

test("with trustedEventsOnly, made-up C, M, V, Escape and the hide shortcut change nothing; real ones work", async () => {
  const shadow = await mount({ trustedEventsOnly: true });
  expect(mode(shadow)).toBe("Browse mode");

  await send(document.body, madeUp(keydown({ key: "c" })));
  expect(mode(shadow)).toBe("Browse mode");
  await send(document.body, real(keydown({ key: "c" })));
  expect(mode(shadow)).toBe("Comment mode");

  await send(document.body, madeUp(keydown({ key: "v" })));
  expect(mode(shadow)).toBe("Comment mode");
  await send(document.body, real(keydown({ key: "v" })));
  expect(mode(shadow)).toBe("Browse mode");

  await send(document.body, madeUp(keydown({ key: "m" })));
  expect(mode(shadow)).toBe("Browse mode");
  await send(document.body, real(keydown({ key: "m" })));
  expect(mode(shadow)).toBe("Mockup mode");
  await send(document.body, real(keydown({ key: "v" })));
  expect(mode(shadow)).toBe("Browse mode");

  // Escape closes the sidebar in Browse mode.
  await act(async () => shadow.querySelector<HTMLButtonElement>('button[aria-label="Project"]')!.click());
  await frames();
  expect(shadow.querySelector(".sidebar")).not.toBeNull();
  await send(document.body, madeUp(keydown({ key: "Escape" })));
  expect(shadow.querySelector(".sidebar")).not.toBeNull();
  await send(document.body, real(keydown({ key: "Escape" })));
  expect(shadow.querySelector(".sidebar")).toBeNull();

  await send(document.body, madeUp(keydown(hide)));
  expect(host!.style.getPropertyValue("display")).toBe("");
  await send(document.body, real(keydown(hide)));
  expect(host!.style.getPropertyValue("display")).toBe("none");
  await send(document.body, madeUp(keydown(hide)));
  expect(host!.style.getPropertyValue("display")).toBe("none");
  await send(document.body, real(keydown(hide)));
  expect(host!.style.getPropertyValue("display")).toBe("");

  // A menu's and a dialog's Escape.
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  await send(document.body, madeUp(keydown({ key: "Escape" })));
  expect(shadow.querySelector("[role='menu']")).not.toBeNull();
  await send(document.body, real(keydown({ key: "Escape" })));
  expect(shadow.querySelector("[role='menu']")).toBeNull();
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  await act(async () => menuItem(shadow, "Change display name…")!.click());
  await frames();
  expect(shadow.querySelector("[role='dialog']")).not.toBeNull();
  await send(document.body, madeUp(keydown({ key: "Escape" })));
  expect(shadow.querySelector("[role='dialog']")).not.toBeNull();
  await send(document.body, real(keydown({ key: "Escape" })));
  expect(shadow.querySelector("[role='dialog']")).toBeNull();
});

test("without trustedEventsOnly, made-up keys work as today", async () => {
  const shadow = await mount();
  await send(document.body, madeUp(keydown({ key: "c" })));
  expect(mode(shadow)).toBe("Comment mode");
  await send(document.body, madeUp(keydown({ key: "v" })));
  expect(mode(shadow)).toBe("Browse mode");
  await send(document.body, madeUp(keydown({ key: "m" })));
  expect(mode(shadow)).toBe("Mockup mode");
  await send(document.body, madeUp(keydown({ key: "v" })));
  await send(document.body, madeUp(keydown(hide)));
  expect(host!.style.getPropertyValue("display")).toBe("none");
  await send(document.body, madeUp(keydown(hide)));
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  await send(document.body, madeUp(keydown({ key: "Escape" })));
  expect(shadow.querySelector("[role='menu']")).toBeNull();
});

test("accountItems appear after the package's own items, before Sign out; each runs once and closes the menu", async () => {
  const chosen: string[] = [];
  const shadow = await mount({
    accountItems: [
      { label: "Show comments here automatically", onSelect: () => void chosen.push("automatic") },
      { label: "Change project for this site", onSelect: () => void chosen.push("project") },
    ],
  });
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  const labels = Array.from(shadow.querySelectorAll("[role='menuitem']")).map((item) => item.textContent);
  expect(labels.slice(-3)).toEqual(["Show comments here automatically", "Change project for this site", "Sign out"]);
  expect(labels.indexOf("Change display name…")).toBeLessThan(labels.indexOf("Show comments here automatically"));
  await act(async () => menuItem(shadow, "Change project for this site")!.click());
  await frames();
  expect(chosen).toEqual(["project"]);
  expect(shadow.querySelector("[role='menu']")).toBeNull();
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  await act(async () => menuItem(shadow, "Show comments here automatically")!.click());
  await frames();
  expect(chosen).toEqual(["project", "automatic"]);
  expect(shadow.querySelector("[role='menu']")).toBeNull();
});

test("without accountItems, the account menu is as today", async () => {
  const shadow = await mount();
  await act(async () => shadow.querySelector<HTMLButtonElement>("button.who")!.click());
  const labels = Array.from(shadow.querySelectorAll("[role='menuitem']")).map((item) => item.textContent);
  expect(labels.at(-1)).toBe("Sign out");
  expect(labels).not.toContain("Show comments here automatically");
  expect(labels[0]).toBe("Project setup");
});
