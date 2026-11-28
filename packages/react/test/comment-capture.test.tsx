import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NewThread } from "@critiqs/core";
import type { CaptureResult } from "../src/capture.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { commentField, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Saving a comment keeps its automatic capture only when the capture shows the
// view the comment names: the page keeps running while it is copied.

let duringCapture: () => void = () => {};
mock.module("../src/capture.ts", () => ({
  captureView: async (): Promise<CaptureResult> => {
    duringCapture();
    return { status: "captured", image: new Blob(["png"], { type: "image/png" }) };
  },
}));
const { App } = await import("../src/App.tsx");

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const backend: FakeBackend = {
  project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
  threads: [],
  thread: undefined,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let page: HTMLElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  page?.remove();
  duringCapture = () => {};
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

async function frames() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** Leaves a comment on the page's button while the host shows `view`, returning what was saved. */
async function comment(view: { tab: string }) {
  page = document.createElement("main");
  const button = document.createElement("button");
  button.setAttribute("data-critiqs-id", "review");
  button.textContent = "Review";
  button.getBoundingClientRect = () => new DOMRect(40, 80, 120, 30);
  button.getClientRects = () => [new DOMRect(40, 80, 120, 30)] as unknown as DOMRectList;
  (button as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  page.append(button);
  document.body.append(page);
  document.elementFromPoint = () => button;

  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const saved: NewThread[] = [];
  const transport = { ...fakeTransport(backend), createThread: async (thread: NewThread) => (saved.push(thread), "thread") };
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null } as const;
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot", viewState: { ...view } }) }} deployment={deployment} session={session} host={host!} shadow={host!.shadowRoot!} />
      </TransportContext.Provider>,
    ),
  );
  await frames();

  await act(async () => shadow.querySelector<HTMLButtonElement>('button[aria-label="Comment mode"]')!.click());
  await frames();
  await act(async () => void button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 })));
  await frames();
  const form = shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  await typeInto(commentField(form)!, "Align the review button");
  await act(async () => form.requestSubmit());
  await frames();
  return saved;
}

test("keeps a capture of the view the comment names", async () => {
  const saved = await comment({ tab: "details" });

  expect(saved.map((thread) => [thread.anchor.viewState, thread.capture])).toEqual([
    [{ tab: "details" }, { status: "captured", fileId: "file" }],
  ]);
});

test("does not keep a capture taken while the host changed views; the comment keeps its view", async () => {
  const view = { tab: "details" };
  duringCapture = () => {
    view.tab = "history";
  };

  const saved = await comment(view);

  expect(saved.map((thread) => [thread.anchor.viewState, thread.capture])).toEqual([
    [{ tab: "details" }, { status: "failed", failureReason: "The view changed while it was being captured." }],
  ]);
});
