import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Anchor, ExportPage, ThreadSummary } from "@critiqs/core";
import { App } from "../src/App.tsx";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const storageKey = `critiqs:session:${SIGN_IN}`;
const anchor: Anchor = {
  screen: "pilot", viewState: {}, scope: "shared", target: { purposeId: "missing", recordKey: null,
    clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } },
  evidence: { url: "https://prototype.example/pilot", capturedAt: 1, revision: "v1", persona: null,
    viewport: { width: 800, height: 600 }, marker: { x: 0, y: 0, width: 10, height: 10 }, userAgent: "Browser" },
};
const summary: ThreadSummary = { _id: "thread", status: "open", anchor, location: null, tags: [], createdAt: 1,
  lastMessageAt: 1, messageCount: 1, unread: true, preview: { body: "Private reviewer text", authorName: "Dana", authorImageUrl: null } };
let exportResponse: () => Promise<ExportPage> = async () => ({ projectName: "Pilot",
  thread: { _id: "thread", status: "open", tags: [], anchor, location: null, hasCapture: false },
  page: [{ _id: "message", author: "Dana", body: "Private reviewer text", createdAt: 1, editedAt: null, revision: "v1" }],
  isDone: true, continueCursor: "" });

const backend: FakeBackend = {
  project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
  threads: [summary],
  exportPage: () => exportResponse(),
};
let root: Root | null = null;
let host: HTMLElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove(); host = null;
  localStorage.clear();
  backend.threads = [summary];
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

function signInFixture() {
  const payload = btoa(JSON.stringify({ name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(storageKey, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture-token", expiresAt: Date.now() + 900_000 }));
}
async function mount() {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  signInFixture();
  localStorage.setItem("critiqs:sidebar-open", "true");
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div"); shadow.append(container);
  root = createRoot(container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () => root!.render(<TransportContext.Provider value={fakeTransport(backend)}>
    <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }}
      deployment={{ backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null }}
      session={session} host={host!} shadow={host!.shadowRoot!} />
  </TransportContext.Provider>));
  // Exporting starts from the comments list, Comment mode's side panel.
  await act(async () => shadow.querySelector<HTMLButtonElement>('[aria-label="Comment mode"]')!.click());
  return shadow;
}
async function click(shadow: ShadowRoot, selector: string) {
  const button = shadow.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
async function button(shadow: ShadowRoot, text: string) {
  const element = Array.from(shadow.querySelectorAll<HTMLButtonElement>("button")).find(element => element.textContent === text);
  expect(element).toBeDefined();
  await act(async () => element!.click());
}
async function prepareExport(shadow: ShadowRoot) {
  await click(shadow, 'button[aria-label="Select threads to export"]');
  await button(shadow, "Select all");
  await button(shadow, "Export…");
}
async function otherSessionSignOut() {
  const other = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () => other.signOut());
}
async function reauthenticate() {
  await act(async () => {
    signInFixture();
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
  });
}

test("a prepared export disappears immediately on other-instance sign-out and is not restored by sign-in", async () => {
  const shadow = await mount();
  await prepareExport(shadow);
  expect(shadow.querySelector('pre[aria-label="Preview"]')?.textContent).toContain("Private reviewer text");
  expect(shadow.querySelector('[role="dialog"]')).not.toBeNull();
  await otherSessionSignOut();
  expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  expect(shadow.textContent).not.toContain("Private reviewer text");
  expect(shadow.textContent).toContain("Sign in to see this project");
  // New authentication must not redisplay the previous reviewer's retained
  // live-page cache while new thread pages are still loading.
  backend.threads = undefined;
  await reauthenticate();
  expect(shadow.textContent).not.toContain("Private reviewer text");
  expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  // Sign-out left Comment mode; the comments list is back in it.
  await click(shadow, '[aria-label="Comment mode"]');
  expect(shadow.querySelector('button[aria-label="Select threads to export"]')?.getAttribute("aria-pressed")).toBe("false");
  expect(Array.from(shadow.querySelectorAll("button")).some(element => element.textContent === "Export…")).toBe(false);
});

test("an export page that finishes after cross-tab sign-out cannot redisplay its cached contents", async () => {
  const originalResponse = exportResponse;
  let finish!: (data: ExportPage) => void;
  exportResponse = () => new Promise(resolve => { finish = resolve; });
  try {
    const shadow = await mount();
    await prepareExport(shadow);
    expect(shadow.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      localStorage.removeItem(storageKey);
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
    });
    await act(async () => finish(await originalResponse()));
    expect(shadow.querySelector('[role="dialog"]')).toBeNull();
    expect(shadow.textContent).not.toContain("Private reviewer text");
    await reauthenticate();
    expect(shadow.querySelector('[role="dialog"]')).toBeNull();
  } finally { exportResponse = originalResponse; }
});

test("an exported reply a coding agent wrote keeps that mark, in Markdown and JSON", async () => {
  const originalResponse = exportResponse;
  exportResponse = async () => ({
    projectName: "Pilot",
    thread: { _id: "thread", status: "open", tags: [], anchor, location: null, hasCapture: false },
    page: [
      { _id: "message", author: "Dana", body: "Align the button", createdAt: 1, editedAt: null, revision: "v1" },
      { _id: "agent", author: "Dana", body: "Aligned in abc123; please check", createdAt: 2, editedAt: null, revision: "abc123", via: "agent" },
    ],
    isDone: true,
    continueCursor: "",
  });
  try {
    const shadow = await mount();
    await prepareExport(shadow);
    const preview = () => shadow.querySelector('pre[aria-label="Preview"]')?.textContent ?? "";
    expect(preview()).toContain("**Dana** via coding agent, 1970-01-01T00:00:00.002Z, revision abc123:");
    expect(preview()).toContain("**Dana**, 1970-01-01T00:00:00.001Z, revision v1:");
    await button(shadow, "JSON, for tools");
    const messages = JSON.parse(preview()).threads[0].messages as { via?: string }[];
    expect(messages.map((message) => message.via ?? null)).toEqual([null, "agent"]);
  } finally {
    exportResponse = originalResponse;
  }
});
