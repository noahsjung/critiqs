import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { Deployment } from "../src/deployment.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Opening a project through an install records it for the signed-in
// reviewer, so the browser extension's project lookup finds it for them.
// Only backends that keep address lists are asked, once per page load.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: false },
    threads: [],
    calls: [],
    ...overrides,
  };
}

/** Each test uses its own backend address: what this page load already recorded stays recorded. */
let backends = 0;
function deployment(addressLists: boolean): Deployment {
  backends++;
  return { backendUrl: `https://backend-${backends}.convex.cloud`, siteUrl: `https://backend-${backends}.convex.site`, signInUrl: SIGN_IN, transport: "convex", signIn: null, addressLists };
}

/** The whole interface for a project, signed in as Dana unless `signedIn` is false. */
async function render(data: FakeBackend, using: Deployment, { signedIn = true, projectId = "project" } = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  if (signedIn) {
    const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
    localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  }
  if (host === null) {
    host = document.createElement("critiqs-root");
    document.body.append(host);
    root = createRoot(host.attachShadow({ mode: "open" }).appendChild(document.createElement("div")));
  }
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(data)}>
        <App props={{ projectId }} deployment={using} session={session} host={host!} />
      </TransportContext.Provider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const recorded = (data: FakeBackend) => data.calls!.filter((call) => call.name === "recordProjectOpened").map((call) => call.args);

test("a signed-in reviewer's project is recorded as opened once, however often the page renders", async () => {
  const data = backend();
  const using = deployment(true);
  await render(data, using);
  await render(data, using);
  expect(recorded(data)).toEqual([{ projectId: "project" }]);
  // Another project on the same page is recorded too.
  await render(data, using, { projectId: "other" });
  expect(recorded(data)).toEqual([{ projectId: "project" }, { projectId: "other" }]);
});

test("nothing is recorded on a backend without address lists, while signed out, or before the project loads", async () => {
  const withoutLists = backend();
  await render(withoutLists, deployment(false));
  expect(recorded(withoutLists)).toEqual([]);
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();

  const signedOut = backend();
  await render(signedOut, deployment(true), { signedIn: false });
  expect(recorded(signedOut)).toEqual([]);

  const loading = backend({ project: undefined });
  const using = deployment(true);
  await render(loading, using);
  expect(recorded(loading)).toEqual([]);
  // Once the project loads, it is recorded.
  loading.project = backend().project;
  await render(loading, using);
  expect(recorded(loading)).toEqual([{ projectId: "project" }]);
});

test("a recording that failed is tried again the next time the project opens", async () => {
  const using = deployment(true);
  const failing = backend();
  const transport = fakeTransport(failing);
  let attempts = 0;
  transport.recordProjectOpened = async () => {
    attempts++;
    throw new Error("Offline");
  };
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  root = createRoot(host.attachShadow({ mode: "open" }).appendChild(document.createElement("div")));
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App props={{ projectId: "project" }} deployment={using} session={session} host={host!} />
      </TransportContext.Provider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(attempts).toBe(1);
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  host = null;

  const working = backend();
  await render(working, using);
  expect(recorded(working)).toEqual([{ projectId: "project" }]);
});
