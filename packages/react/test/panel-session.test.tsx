import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Reviewer, TokenSession } from "../src/session.ts";
import { fakeTransport } from "./fake-transport.tsx";
import { pageState, scriptedPage } from "./scripted-page.tsx";

// A panel that keeps its own sign-in, as the browser extension's side panel
// does: it signs in without a popup and stores the session in the extension.
// No real Convex connection: a client that connects would open a socket to a
// backend that isn't there.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const givenToConvex: unknown[] = [];
const clientOptions: unknown[] = [];
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  ConvexReactClient: class {
    constructor(_url: string, options?: unknown) {
      clientOptions.push(options);
    }
    close() {}
  },
}));
mock.module("../src/convex/transport.tsx", () => ({
  convexTransport: (_client: unknown, _deployment: unknown, session: unknown) => {
    givenToConvex.push(session);
    return fakeTransport({ project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true }, threads: [] });
  },
}));
const { Connect } = await import("../src/connect.tsx");
const { PageLink } = await import("../src/page-layer/link.ts");

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
// Sign-ins other test files left on this origin, when files share a process.
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test("a panel's own sign-in is the one Convex asks for its token, and the reviewer it shows", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "http://127.0.0.1:9/", protocol: 5, transport: "convex", addressLists: true });
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  const reviewer: Reviewer = { id: "dana", name: "Dana Panel", email: "dana@example.com", pictureUrl: null };
  const snapshot = { reviewer };
  const session: TokenSession = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    signIn: async () => {},
    signOut: async () => {},
    setDisplayName: async () => true,
    fetchAccessToken: async () => null,
  };
  const shown = pageState("page-a", 1);
  const page = scriptedPage({ display: async () => shown });
  host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<Connect props={{ projectId: "project", backend: "http://127.0.0.1:8" }} host={host!} shadow={host!.shadowRoot!} page={new PageLink(page.endpoint, { initial: shown })} session={session} />),
  );
  for (let tries = 0; tries < 50 && givenToConvex.length === 0; tries++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  // Convex gets its token from the panel's own session, not from Critiqs's sign-in popup.
  expect(givenToConvex).toEqual([session]);
  // And reuses a saved token that is still good, so opening the panel doesn't renew the sign-in.
  expect(clientOptions).toEqual([expect.objectContaining({ initialAuthTokenReuse: true })]);
  // Signed in through the panel's own session: no sign-in is offered.
  expect(shadow.textContent).not.toContain("Sign in");
  // Nothing of the popup's session was stored on this origin.
  expect(Object.keys(localStorage).filter((key) => key.startsWith("critiqs:session:"))).toEqual([]);
});
