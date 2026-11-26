import { beforeEach, expect, test } from "bun:test";
import { convexClient } from "../src/convex/client.ts";
import { Session } from "../src/session.ts";

const SIGN_IN = "https://auth.example";
const ZERO_TS = "AAAAAAAAAAA=";

function token(claims: Record<string, unknown>) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "ES256" })}.${encode(claims)}.signature`;
}

/** A Convex deployment that accepts every token it is sent, or rejects the first when asked. */
function fakeDeployment({ rejectFirst = false } = {}) {
  const authenticated: string[] = [];
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
    constructor(readonly url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    /** The versions this connection has confirmed, and the ones the client asked for since. */
    confirmed = { querySet: 0, identity: 0 };
    wanted = { querySet: 0, identity: 0 };
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
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code: 1000, reason: "" }));
    }
  }
  return { Socket: Socket as unknown as typeof WebSocket, authenticated };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } });
});

/** A reviewer signed in on this site, with an access token good for another ten minutes. */
function signedIn() {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = token({ sub: "dana", name: "Dana", iat: now - 300, exp: now + 600 });
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken, refreshToken: "r1", expiresAt: (now + 600) * 1000 }));
  const refreshes: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    refreshes.push(String(url));
    const fresh = Math.floor(Date.now() / 1000);
    return Response.json({ accessToken: token({ sub: "dana", name: "Dana", iat: fresh, exp: fresh + 900 }), refreshToken: JSON.parse(String(init.body)).nextRefreshToken ?? "r2", expiresAt: (fresh + 900) * 1000 });
  });
  return { accessToken, refreshes, session };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("loading a page with a sign-in that is still good uses the saved token without refreshing it", async () => {
  const { accessToken, refreshes, session } = signedIn();
  const { Socket, authenticated } = fakeDeployment();
  const client = convexClient("https://happy-otter-123.convex.cloud", { webSocketConstructor: Socket, unsavedChangesWarning: false });
  const changes: boolean[] = [];
  client.setAuth(session.fetchAccessToken, (isAuthenticated) => changes.push(isAuthenticated));
  await settle();
  expect(refreshes).toEqual([]);
  expect(authenticated).toEqual([accessToken]);
  expect(changes).toEqual([true]);
  void client.close();
});

test("a token the deployment rejects is still replaced", async () => {
  const { accessToken, refreshes, session } = signedIn();
  const { Socket, authenticated } = fakeDeployment({ rejectFirst: true });
  const client = convexClient("https://happy-otter-123.convex.cloud", { webSocketConstructor: Socket, unsavedChangesWarning: false });
  const changes: boolean[] = [];
  client.setAuth(session.fetchAccessToken, (isAuthenticated) => changes.push(isAuthenticated));
  await settle();
  expect(refreshes).toEqual([`${SIGN_IN}/auth/refresh`]);
  expect(authenticated).toHaveLength(2);
  expect(authenticated[0]).toBe(accessToken);
  expect(authenticated[1]).not.toBe(accessToken);
  expect(changes).toEqual([true]);
  void client.close();
});
