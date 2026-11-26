import { beforeAll, beforeEach, expect, test } from "bun:test";
import { Session } from "../../react/src/session.ts";
import { hashSecret, issueAccessToken } from "../convex/lib/tokens";
import { setup } from "./harness";

// The component's real session code against the real sign-in service, with
// the answer to a refresh lost after the service has acted on it: what
// happens when the page closes, or the network drops, mid-refresh.

const SIGN_IN = "https://auth.example";
const SITE = "https://proto.example";
const KEY = `critiqs:session:${SIGN_IN}`;

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  process.env.CRITIQS_AUTH_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
  process.env.CRITIQS_AUTH_ISSUER = SIGN_IN;
});

/** The parts of a browser page the session uses; a DOM library would drop the Origin header these requests need. */
class MemoryStorage {
  readonly #items = new Map<string, string>();
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, value); }
  removeItem(key: string) { this.#items.delete(key); }
}
let localStorage: Storage;

beforeEach(() => {
  localStorage = new MemoryStorage() as unknown as Storage;
  Object.assign(globalThis, { window: new EventTarget() });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } });
});

/** A signed-in reviewer on the site, as the sign-in popup leaves them, with an access token about to expire. */
async function signedIn() {
  const t = setup();
  const subject = await t.run((ctx) => ctx.db.insert("reviewers", { email: "dana@example.com", name: "Dana", nameVersion: 1, createdAt: Date.now() }));
  const profile = { subject: subject as string, name: "Dana", email: "dana@example.com", pictureUrl: null, profileVersion: 1 };
  const refreshToken = "first-refresh-token-0123456789-abcdefghijklm";
  await t.run(async (ctx) => {
    await ctx.db.insert("sessions", { refreshHash: await hashSecret(refreshToken), origin: SITE, profile, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 });
  });
  const { accessToken } = await issueAccessToken(SIGN_IN, profile, SITE, Date.now() - 3_600_000);
  localStorage.setItem(KEY, JSON.stringify({ accessToken, refreshToken, expiresAt: 0 }));
  /** The service as the page reaches it: the site's origin on every request. */
  const service = (input: URL, init: RequestInit) =>
    t.fetch(input.pathname, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: SITE } });
  return { t, service };
}

test("an ordinary refresh renews the session through the service", async () => {
  const { service } = await signedIn();
  const statuses: number[] = [];
  const session = new Session(SIGN_IN, localStorage, async (input, init) => {
    const response = await service(input, init);
    statuses.push(response.status);
    return response;
  });
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  expect(statuses).toEqual([200, 200]);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
});

test("a refresh whose answer is lost after the service rotated the token keeps the reviewer signed in", async () => {
  const { service } = await signedIn();
  // The service handles the refresh, but the answer never reaches the page.
  const lost = new Session(SIGN_IN, localStorage, async (input, init) => {
    await service(input, init);
    throw new TypeError("The page closed before the answer arrived.");
  });
  expect(await lost.fetchAccessToken({ forceRefreshToken: true })).toBeNull();

  // The page opens again.
  const reopened = new Session(SIGN_IN, localStorage, service);
  const token = await reopened.fetchAccessToken({ forceRefreshToken: true });
  expect(token).toBeString();
  expect(reopened.getSnapshot().reviewer?.email).toBe("dana@example.com");
  // And the session keeps renewing afterwards.
  expect(await reopened.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  expect(reopened.getSnapshot().reviewer?.name).toBe("Dana");
});

test("signing out after a lost refresh ends the session on the service", async () => {
  const { t, service } = await signedIn();
  const lost = new Session(SIGN_IN, localStorage, async (input, init) => {
    await service(input, init);
    throw new TypeError("The page closed before the answer arrived.");
  });
  await lost.fetchAccessToken({ forceRefreshToken: true });
  await new Session(SIGN_IN, localStorage, service).signOut();
  expect(await t.run((ctx) => ctx.db.query("sessions").collect())).toEqual([]);
});

test("a rename after a lost refresh finishes the refresh first and keeps the reviewer signed in", async () => {
  const { service } = await signedIn();
  const lost = new Session(SIGN_IN, localStorage, async (input, init) => {
    await service(input, init);
    throw new TypeError("The page closed before the answer arrived.");
  });
  await lost.fetchAccessToken({ forceRefreshToken: true });
  const reopened = new Session(SIGN_IN, localStorage, service);
  expect(await reopened.setDisplayName("Dana Kim")).toBe(true);
  expect(reopened.getSnapshot().reviewer?.name).toBe("Dana Kim");
});

test("a page whose late answer arrives after another tab moved the session on leaves it signed in", async () => {
  const { service } = await signedIn();
  const post = (body: Record<string, string>) =>
    service(new URL("/auth/refresh", SIGN_IN), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Tab A's refresh reaches the service. Before A handles the answer, tab B
  // (same saved pair) finishes the same refresh and later renews again.
  const suspended = new Session(SIGN_IN, localStorage, async (input, init) => {
    const response = await service(input, init);
    if (input.pathname === "/auth/refresh") {
      const pair = JSON.parse(String(init.body)) as { refreshToken: string; nextRefreshToken: string };
      expect((await post(pair)).status).toBe(200);
      const third = "third-refresh-token-0123456789-abcdefghijklmn";
      const renewed = await post({ refreshToken: pair.nextRefreshToken, nextRefreshToken: third });
      expect(renewed.status).toBe(200);
      localStorage.setItem(KEY, JSON.stringify({ ...(await renewed.json()), refreshToken: third }));
    }
    return response;
  });
  await suspended.fetchAccessToken({ forceRefreshToken: true });
  // A's late clean-up must not have ended the session B moved on to.
  const other = new Session(SIGN_IN, localStorage, service);
  expect(await other.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  expect(other.getSnapshot().reviewer?.name).toBe("Dana");
});
