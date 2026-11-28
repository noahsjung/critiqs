import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Reviewer, TokenSession } from "../src/session.ts";
import { fakeTransport } from "./fake-transport.tsx";

// The browser extension draws the panel in the reviewed page itself. There it
// isn't an install: the project's onboarding must never hear Connected from
// it, and its threads say they came from the extension. No real Convex
// connection: a client that connects would open a socket to a backend that
// isn't there.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const surfaces: unknown[] = [];
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  ConvexReactClient: class {
    close() {}
  },
}));
mock.module("../src/convex/transport.tsx", () => ({
  convexTransport: (_client: unknown, _deployment: unknown, _session: unknown, surface?: unknown) => {
    surfaces.push(surface);
    return fakeTransport({ project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true }, threads: [] });
  },
}));
const { attachHost, Connect } = await import("../src/connect.tsx");

const originalUrl = window.location.href;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  localStorage.clear();
  surfaces.length = 0;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = realFetch;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

/** Each test uses its own backend: what this page load already reported stays reported. */
let backends = 0;

/** A backend that records connections; returns every address the page asked for. */
function backend() {
  const site = `https://backend-${++backends}.convex.site`;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: site, protocol: 5, transport: "convex", connections: true, threadMadeWith: true });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { backendUrl: site.replace(".site", ".cloud"), connected: () => asked.filter((url) => url === `${site}/critiqs/connected`).length };
}

const reviewer: Reviewer = { id: "dana", name: "Dana", email: "dana@example.com", pictureUrl: null };
const session: TokenSession = {
  getSnapshot: () => ({ reviewer }),
  subscribe: () => () => {},
  signIn: async () => {},
  signOut: async () => {},
  setDisplayName: async () => true,
  fetchAccessToken: async () => null,
};

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** A whole session on the page: open the panel, switch modes, open the sidebar, leave. */
async function session_(backendUrl: string, surface: "extension" | undefined) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const attached = attachHost(document.body, { mode: surface === "extension" ? "closed" : "open" });
  host = attached.host;
  root = createRoot(attached.container);
  const draw = () =>
    root!.render(
      <Connect props={{ projectId: "project", backend: backendUrl }} host={attached.host} shadow={attached.shadow} session={session} {...(surface === undefined ? {} : { surface })} />,
    );
  await act(async () => draw());
  await settle();
  const button = (label: string) => attached.shadow.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button("Comment mode")).not.toBeNull();
  await act(async () => button("Comment mode")!.click());
  await act(async () => button("Browse mode")!.click());
  await act(async () => attached.shadow.querySelector<HTMLButtonElement>("button[aria-pressed][title^='Comments']")?.click());
  await act(async () => draw());
  await settle();
  await act(async () => root?.unmount());
  root = null;
  attached.host.remove();
  host = null;
}

test("with the extension's surface, nothing is reported to /critiqs/connected in a whole session, and its threads say extension", async () => {
  const { backendUrl, connected } = backend();
  await session_(backendUrl, "extension");
  await session_(backendUrl, "extension");
  expect(connected()).toBe(0);
  expect(surfaces.length).toBeGreaterThan(0);
  expect(surfaces.every((surface) => surface === "extension")).toBe(true);
});

test("without a surface, an install reports Connected once, as before, and its threads say nothing", async () => {
  const { backendUrl, connected } = backend();
  await session_(backendUrl, undefined);
  await session_(backendUrl, undefined);
  expect(connected()).toBe(1);
  expect(surfaces.every((surface) => surface === undefined)).toBe(true);
});
