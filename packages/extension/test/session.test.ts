import { expect, test } from "bun:test";
import { type PanelSignIn, PanelSignInError, type PanelTokens } from "@critiqs/core";
import { ExtensionSession, endingKey, sessionKey, signedOutKey, type StoredSession } from "../src/session.ts";
import { fakeChrome, settle } from "./fake-chrome.ts";

const SIGN_IN = "https://signin.example";
const KEY = sessionKey(SIGN_IN);
const NOW = 1_800_000_000_000;

const token = (name: string, serial: string) => `h.${btoa(JSON.stringify({ sub: "dana", name, email: "dana@example.com" })).replace(/=+$/, "")}.${serial}`;
const stored = (changes: Partial<StoredSession> = {}): StoredSession => ({
  accessToken: token("Dana", "a1"),
  refreshToken: "r1",
  expiresAt: NOW + 15 * 60_000,
  sessionEndsAt: NOW + 30 * 86_400_000,
  reviewer: { id: "dana", name: "Dana", email: "dana@example.com" },
  ...changes,
});

function client(overrides: Partial<PanelSignIn> = {}) {
  const calls: string[] = [];
  let serial = 1;
  const base: PanelSignIn = {
    available: async () => true,
    sendCode: async () => ({ attempt: "a", email: "dana@example.com" }),
    checkCode: async () => ({ status: "needs-name" }),
    chooseName: async () => {
      throw new Error("unused");
    },
    refresh: async (refreshToken): Promise<PanelTokens> => {
      calls.push(`refresh ${refreshToken}`);
      serial++;
      return { accessToken: token("Dana", `a${serial}`), refreshToken: `r${serial}`, expiresAt: NOW + 15 * 60_000 };
    },
    setDisplayName: async (refreshToken, name) => void calls.push(`rename ${refreshToken} ${name}`),
    signOut: async (refreshToken) => (calls.push(`sign-out ${refreshToken}`), true),
  };
  return { client: { ...base, ...overrides }, calls };
}

async function session(initial: StoredSession | null, overrides: Partial<PanelSignIn> = {}, now = () => NOW) {
  const chrome = fakeChrome();
  if (initial !== null) chrome.storage.local.items.set(KEY, initial);
  const fake = client(overrides);
  const value = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, null, now);
  await value.ready;
  return { session: value, chrome, calls: fake.calls };
}

test("a kept session shows its reviewer and hands Convex its token while it is fresh", async () => {
  const { session: value, calls } = await session(stored());
  expect(value.getSnapshot().reviewer).toEqual({ id: "dana", name: "Dana", email: "dana@example.com", pictureUrl: null });
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).toBe(token("Dana", "a1"));
  expect(calls).toEqual([]);
});

test("a token about to expire is renewed and the new one kept for every part of the extension", async () => {
  const { session: value, chrome, calls } = await session(stored({ expiresAt: NOW + 30_000 }));
  const fresh = await value.fetchAccessToken({ forceRefreshToken: false });
  expect(calls).toEqual(["refresh r1"]);
  expect(fresh).toBe(token("Dana", "a2"));
  expect((chrome.storage.local.items.get(KEY) as StoredSession).refreshToken).toBe("r2");
});

test("two requests for a token at once renew it once, since each renewal replaces the refresh token", async () => {
  const { session: value, calls } = await session(stored({ expiresAt: NOW }));
  const [first, second] = await Promise.all([value.fetchAccessToken({ forceRefreshToken: false }), value.fetchAccessToken({ forceRefreshToken: true })]);
  expect(calls).toEqual(["refresh r1"]);
  expect(first).toBe(second);
});

test("a renewal another part of the extension already made is used, not repeated", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  // The lock is busy while the other part renews; this one waits for it.
  const locks = { request: async <T,>(_: string, work: () => Promise<T>) => (await held, work()) };
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW }));
  const fake = client();
  const value = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, locks, () => NOW);
  await value.ready;
  const waiting = value.fetchAccessToken({ forceRefreshToken: false });
  await chrome.storage.local.set({ [KEY]: stored({ accessToken: token("Dana", "other"), refreshToken: "r-other" }) });
  release();
  expect(await waiting).toBe(token("Dana", "other"));
  expect(fake.calls).toEqual([]);
});

test("a session the service ended signs the reviewer out here", async () => {
  const { session: value, chrome } = await session(stored({ expiresAt: NOW }), {
    refresh: async () => {
      throw new PanelSignInError("signed-out", "Your sign-in has ended.");
    },
  });
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(value.getSnapshot().reviewer).toBeNull();
});

test("offline, a renewal keeps the session for the next try", async () => {
  const { session: value, chrome } = await session(stored({ expiresAt: NOW }), {
    refresh: async () => {
      throw new PanelSignInError("network", "Couldn't reach the service.");
    },
  });
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  expect(chrome.storage.local.items.has(KEY)).toBe(true);
  expect(value.getSnapshot().reviewer?.name).toBe("Dana");
});

test("signing out ends the session here at once, and on the service, even when it can't be reached", async () => {
  const { session: value, chrome, calls } = await session(stored(), {
    signOut: async (refreshToken) => {
      calls.push(`sign-out ${refreshToken}`);
      throw new PanelSignInError("network", "offline");
    },
  });
  await value.signOut();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(value.getSnapshot().reviewer).toBeNull();
  expect(calls).toEqual(["sign-out r1"]);
});

test("a session past its end is signed out, however recently it was renewed", async () => {
  const { session: value } = await session(stored({ sessionEndsAt: NOW - 1 }));
  expect(value.getSnapshot().reviewer).toBeNull();
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
});

test("signing in or out in another side panel shows here too", async () => {
  const { session: value, chrome } = await session(null);
  const seen: (string | null)[] = [];
  value.subscribe(() => seen.push(value.getSnapshot().reviewer?.name ?? null));
  await chrome.storage.local.set({ [KEY]: stored() });
  await settle();
  await chrome.storage.local.remove(KEY);
  await settle();
  expect(seen).toEqual(["Dana", null]);
});

test("a new display name is saved everywhere, and the renewed token carries it", async () => {
  const { session: value, calls } = await session(stored(), {
    refresh: async (refreshToken) => (calls.push(`refresh ${refreshToken}`), { accessToken: token("Dana Kim", "a2"), refreshToken: "r2", expiresAt: NOW + 900_000 }),
  });
  expect(await value.setDisplayName("Dana Kim")).toBe(true);
  expect(calls).toEqual(["rename r1 Dana Kim", "refresh r1"]);
  expect(value.getSnapshot().reviewer?.name).toBe("Dana Kim");
});

test("stored values of another shape count as signed out", async () => {
  const { session: value } = await session({ accessToken: "x" } as unknown as StoredSession);
  expect(value.getSnapshot().reviewer).toBeNull();
});

/** Web Locks as the extension's contexts share them: one holder at a time. */
function sharedLocks() {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_: string, work: () => Promise<T>): Promise<T> {
      const run = queue.then(work, work);
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

test("signing out while a renewal is under way ends the renewed session too, instead of the renewal bringing it back", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW }));
  let finishRefresh!: () => void;
  const answered = new Promise<void>((resolve) => (finishRefresh = resolve));
  const fake = client({
    refresh: async (refreshToken) => {
      fake.calls.push(`refresh ${refreshToken}`);
      await answered;
      return { accessToken: token("Dana", "a2"), refreshToken: "r2", expiresAt: NOW + 900_000 };
    },
  });
  const locks = sharedLocks();
  const now = () => NOW;
  const renewing = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, locks, now);
  const signingOut = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, locks, now);
  await Promise.all([renewing.ready, signingOut.ready]);
  const renewal = renewing.fetchAccessToken({ forceRefreshToken: false });
  await settle();
  const out = signingOut.signOut();
  // Signed out here at once, while the renewal is still waiting for its answer.
  expect(signingOut.getSnapshot().reviewer).toBeNull();
  finishRefresh();
  await Promise.all([renewal, out]);
  await settle();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(renewing.getSnapshot().reviewer).toBeNull();
  // The session the renewal created is ended on the service too (ending the token it replaced is harmless).
  expect(fake.calls).toContain("sign-out r2");
});

test("a sign-out cut short, such as by closing the panel, still holds: the next part of the extension to read the session ends it", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  // The panel replaced the sign-out mark, then closed before it cleared the session or told the service.
  chrome.storage.local.items.set(signedOutKey(SIGN_IN), "after-sign-out");
  const fake = client();
  const value = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, null, () => NOW);
  await value.ready;
  expect(value.getSnapshot().reviewer).toBeNull();
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  await settle();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(fake.calls).toEqual(["sign-out r1"]);
  expect(chrome.storage.local.items.has(endingKey(SIGN_IN))).toBe(false);
});

test("a sign-out holds whatever the computer's clock does afterwards", async () => {
  let clock = NOW;
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const value = new ExtensionSession(SIGN_IN, client({ signOut: () => new Promise(() => {}) }).client, chrome.storage.local, chrome.storage.onChanged, () => {}, null, () => clock);
  await value.ready;
  void value.signOut();
  await settle();
  // The clock is set back a minute.
  clock = NOW - 60_000;
  const later = new ExtensionSession(SIGN_IN, client().client, chrome.storage.local, chrome.storage.onChanged, () => {}, null, () => clock);
  await later.ready;
  expect(later.getSnapshot().reviewer).toBeNull();
  expect(await later.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
});

test("signing in again while the last sign-out is still telling the service shows the new sign-in at once, and keeps it", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = client({ signOut: () => new Promise(() => {}) });
  const value = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, sharedLocks(), () => NOW);
  await value.ready;
  void value.signOut();
  await settle();
  expect(value.getSnapshot().reviewer).toBeNull();
  await value.signedIn({ ...stored({ refreshToken: "r-new" }), reviewer: { id: "lee", name: "Lee", email: "lee@example.com" } });
  await settle();
  expect(value.getSnapshot().reviewer?.name).toBe("Lee");
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).not.toBeNull();
  // A second part of the extension starting now leaves the new sign-in alone.
  const other = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, sharedLocks(), () => NOW);
  await other.ready;
  await settle();
  expect(other.getSnapshot().reviewer?.name).toBe("Lee");
});

test("clearing an old session waits for a sign-in under way, so it never clears the new one", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  chrome.storage.local.items.set(signedOutKey(SIGN_IN), "after-sign-out");
  const locks = sharedLocks();
  // The clean-up reads storage slowly, as another part of the extension signs in meanwhile.
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  let slow = true;
  chrome.storage.local.get = async (keys) => {
    const items = await get(keys);
    if (slow && Array.isArray(keys) && keys.includes(endingKey(SIGN_IN))) {
      slow = false;
      await settle(3);
    }
    return items;
  };
  const cleaning = new ExtensionSession(SIGN_IN, client().client, chrome.storage.local, chrome.storage.onChanged, () => {}, locks, () => NOW);
  const signingIn = new ExtensionSession(SIGN_IN, client().client, chrome.storage.local, chrome.storage.onChanged, () => {}, locks, () => NOW);
  const signedIn = signingIn.signedIn({ ...stored({ refreshToken: "r-new" }), mark: undefined, reviewer: { id: "lee", name: "Lee", email: "lee@example.com" } } as never);
  await Promise.all([cleaning.ready, signedIn]);
  await settle(10);
  expect((chrome.storage.local.items.get(KEY) as StoredSession | undefined)?.refreshToken).toBe("r-new");
  expect(signingIn.getSnapshot().reviewer?.name).toBe("Lee");
});

test("a session the service couldn't be told about is ended by the next part of the extension to start", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const offline = client({
    signOut: async () => {
      throw new PanelSignInError("network", "offline");
    },
  });
  const value = new ExtensionSession(SIGN_IN, offline.client, chrome.storage.local, chrome.storage.onChanged, () => {}, null, () => NOW);
  await value.ready;
  await value.signOut();
  await settle();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(chrome.storage.local.items.get(endingKey(SIGN_IN))).toEqual(["r1"]);
  const online = client();
  const next = new ExtensionSession(SIGN_IN, online.client, chrome.storage.local, chrome.storage.onChanged, () => {}, null, () => NOW);
  await next.ready;
  await settle();
  expect(online.calls).toEqual(["sign-out r1"]);
  expect(chrome.storage.local.items.has(endingKey(SIGN_IN))).toBe(false);
});

test("a sign-out that lands between a renewal's last check and its write still ends the renewed session", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW }));
  const set = chrome.storage.local.set.bind(chrome.storage.local);
  // Another panel signs out just as the renewal saves its new tokens.
  chrome.storage.local.set = async (items) => {
    if ((items[KEY] as StoredSession | undefined)?.refreshToken === "r2") await set({ [signedOutKey(SIGN_IN)]: "after-sign-out" });
    await set(items);
  };
  const fake = client();
  const value = new ExtensionSession(SIGN_IN, fake.client, chrome.storage.local, chrome.storage.onChanged, () => {}, sharedLocks(), () => NOW);
  await value.ready;
  expect(await value.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  await settle();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(value.getSnapshot().reviewer).toBeNull();
  expect(fake.calls).toContain("sign-out r2");
});
