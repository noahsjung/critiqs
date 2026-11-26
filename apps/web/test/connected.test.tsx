import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Connected } from "../src/App.tsx";
import type { Deployment } from "../src/shared.ts";

// The website signs in with critiqs-react's `Session` and talks to Convex over
// a WebSocket. These tests mount the website's real wiring (`Connected`) with
// a fake Convex deployment, so they see every token it sends and every refresh.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SIGN_IN = "https://auth.example";
const ZERO_TS = "AAAAAAAAAAA=";
const deployment = { backendUrl: "https://happy-otter-123.convex.cloud", siteUrl: "https://happy-otter-123.convex.site", signInUrl: SIGN_IN, transport: "convex" } as Deployment;

function token(claims: Record<string, unknown>) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "ES256" })}.${encode(claims)}.signature`;
}

/** Every fake socket opened, closed after each test. */
const sockets = new Set<{ close(): void }>();
/** Which test's deployment is live: a client from an earlier test never connects again. */
let generation = 0;

/** A Convex deployment that accepts every token it is sent, or rejects the first when asked. */
function fakeDeployment({ rejectFirst = false } = {}) {
  const authenticated: string[] = [];
  const mine = generation;
  class Socket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    confirmed = { querySet: 0, identity: 0 };
    wanted = { querySet: 0, identity: 0 };
    constructor(readonly url: string) {
      // After its test, a client's reconnect stays connecting and never opens.
      if (mine !== generation) return;
      sockets.add(this);
      setTimeout(() => {
        // Closed while connecting: it never opens.
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(data: string) {
      const message = JSON.parse(data) as { type: string; baseVersion?: number; newVersion?: number; value?: string };
      if (message.type === "ModifyQuerySet") this.wanted.querySet = message.newVersion ?? 0;
      else if (message.type === "Authenticate") {
        authenticated.push(message.value ?? "");
        if (rejectFirst && authenticated.length === 1) {
          const reply = { type: "AuthError", error: "Token rejected", baseVersion: message.baseVersion ?? 0, authUpdateAttempted: true };
          setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }));
          return;
        }
        this.wanted.identity = (message.baseVersion ?? 0) + 1;
      } else return;
      setTimeout(() => {
        if (this.readyState !== 1) return;
        const startVersion = { ...this.confirmed, ts: ZERO_TS };
        this.confirmed = { ...this.wanted };
        this.onmessage?.({ data: JSON.stringify({ type: "Transition", startVersion, endVersion: { ...this.confirmed, ts: ZERO_TS }, modifications: [] }) });
      });
    }
    close() {
      sockets.delete(this);
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code: 1000, reason: "" }));
    }
  }
  return { Socket, authenticated };
}

const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let refreshes: { refreshToken: string; nextRefreshToken?: string; savedWhenSent?: string }[] = [];

beforeEach(() => {
  localStorage.clear();
  refreshes = [];
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== `${SIGN_IN}/auth/refresh`) throw new Error(`Unexpected request to ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { refreshToken: string; nextRefreshToken?: string };
    // What this site had saved when the request left: the replacement must already be there.
    refreshes.push({ ...body, savedWhenSent: JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`) ?? "{}").nextRefreshToken });
    const fresh = Math.floor(Date.now() / 1000);
    return Response.json({ accessToken: token({ sub: "dana", name: "Dana", iat: fresh, exp: fresh + 900 }), refreshToken: body.nextRefreshToken ?? "r2", expiresAt: (fresh + 900) * 1000 });
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  generation++;
  for (const socket of [...sockets]) socket.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.WebSocket = realWebSocket;
  globalThis.fetch = realFetch;
});

/** A reviewer signed in on this site, with an access token good for another ten minutes. */
function signedIn() {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = token({ sub: "dana", name: "Dana", email: "dana@example.com", iat: now - 300, exp: now + 600 });
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken, refreshToken: "r1", expiresAt: (now + 600) * 1000 }));
  return accessToken;
}

async function load(Socket: unknown) {
  globalThis.WebSocket = Socket as typeof WebSocket;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<Connected deployment={deployment} features={{ createKeys: false, addressEdits: false, developerResends: false }}><p>Page</p></Connected>));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

test("loading a page with a sign-in that is still good uses the saved token without refreshing it", async () => {
  const accessToken = signedIn();
  const { Socket, authenticated } = fakeDeployment();
  await load(Socket);
  expect(refreshes).toEqual([]);
  expect(authenticated).toEqual([accessToken]);
});

test("a token the deployment rejects is still replaced, with a replacement saved before it is sent", async () => {
  const accessToken = signedIn();
  const { Socket, authenticated } = fakeDeployment({ rejectFirst: true });
  await load(Socket);
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]!.refreshToken).toBe("r1");
  expect(refreshes[0]!.nextRefreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(refreshes[0]!.savedWhenSent).toBe(refreshes[0]!.nextRefreshToken);
  expect(authenticated[0]).toBe(accessToken);
  expect(authenticated.at(-1)).not.toBe(accessToken);
  expect(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).refreshToken).toBe(refreshes[0]!.nextRefreshToken);
});
