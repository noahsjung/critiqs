import { expect, test } from "bun:test";
import { type PanelSignIn, PanelSignInError, type PanelTokens } from "@critiqs/core";
import { ExtensionSession, endingKey, sessionKey, type StoredSession } from "../src/session.ts";
import { type FakeChrome, fakeChrome, settle } from "./fake-chrome.ts";

// Every renewal replaces the refresh token. These tests keep the reviewer
// signed in when a renewal's answer never arrives (the side panel closed, the
// worker was stopped, the network dropped), using a sign-in service that
// follows the real one's rules (packages/backend/convex/signIn.ts): a
// replaced token sent again with exactly the replacement it was switched to
// repeats that renewal, and any other use of a replaced token ends the
// session as stolen.

const SIGN_IN = "https://signin.example";
const KEY = sessionKey(SIGN_IN);
const NOW = 1_800_000_000_000;
const CHOSEN = /^[A-Za-z0-9_-]{43}$/;

const token = (name: string, serial: string) => `h.${btoa(JSON.stringify({ sub: "dana", name, email: "dana@example.com" })).replace(/=+$/, "")}.${serial}`;
const stored = (changes: Partial<StoredSession> = {}): StoredSession => ({
  accessToken: token("Dana", "a1"),
  refreshToken: "r1",
  expiresAt: NOW,
  sessionEndsAt: NOW + 30 * 86_400_000,
  reviewer: { id: "dana", name: "Dana", email: "dana@example.com" },
  ...changes,
});

/**
 * The sign-in service: one session, its current refresh token, and the
 * tokens it replaced. `older` acts as a service from before clients chose
 * their replacement: it ignores `nextRefreshToken` and never repeats a
 * renewal.
 */
function service({ older = false } = {}) {
  let current: string | null = "r1";
  let serial = 1;
  const replaced = new Map<string, string>();
  const calls: string[] = [];
  /** Runs before the service answers; throwing loses the answer after the service has committed. */
  let afterCommit: (sent: { refreshToken: string; nextRefreshToken?: string }) => Promise<void> = async () => {};
  const issue = (refreshToken: string): PanelTokens => ({ accessToken: token("Dana", `a${++serial}`), refreshToken, expiresAt: NOW + 15 * 60_000 });
  const client: PanelSignIn = {
    available: async () => true,
    sendCode: async () => ({ attempt: "a", email: "dana@example.com" }),
    checkCode: async () => ({ status: "needs-name" }),
    chooseName: async () => {
      throw new Error("unused");
    },
    refresh: async (refreshToken, nextRefreshToken) => {
      calls.push(`refresh ${refreshToken} ${nextRefreshToken === undefined ? "-" : nextRefreshToken === undefined || !CHOSEN.test(nextRefreshToken) ? "?" : "chosen"}`);
      const next = older || nextRefreshToken === undefined ? `s${serial + 1}` : nextRefreshToken;
      if (current !== null && refreshToken === current) {
        replaced.set(refreshToken, next);
        current = next;
      } else if (!older && replaced.get(refreshToken) === nextRefreshToken && current === nextRefreshToken) {
        calls.push("repeated");
      } else {
        if (replaced.has(refreshToken)) {
          calls.push("ended as stolen");
          current = null;
        }
        throw new PanelSignInError("signed-out", "Your sign-in has ended.");
      }
      await afterCommit({ refreshToken, ...(nextRefreshToken === undefined ? {} : { nextRefreshToken }) });
      return issue(current!);
    },
    setDisplayName: async (refreshToken, name) => {
      calls.push(`rename ${refreshToken === current ? "current" : refreshToken} ${name}`);
      if (refreshToken !== current) throw new PanelSignInError("signed-out", "Your sign-in has ended.");
    },
    signOut: async (refreshToken) => {
      const owner = refreshToken === current || replaced.has(refreshToken);
      calls.push(`sign-out ${refreshToken === current ? "current" : replaced.has(refreshToken) ? "replaced" : "unknown"}`);
      if (owner) current = null;
      return owner;
    },
  };
  return {
    client,
    calls,
    get current() {
      return current;
    },
    loseNextAnswer() {
      afterCommit = async () => {
        afterCommit = async () => {};
        throw new PanelSignInError("network", "Critiqs's sign-in service couldn't be reached.");
      };
    },
    set afterCommit(run: typeof afterCommit) {
      afterCommit = run;
    },
  };
}

/** A Web Lock shared by every part of the extension, as `navigator.locks` is across one extension's pages and its worker. */
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

async function part(chrome: FakeChrome, client: PanelSignIn, locks: ReturnType<typeof sharedLocks> | null = sharedLocks()) {
  const value = new ExtensionSession(SIGN_IN, client, chrome.storage.local, chrome.storage.onChanged, () => {}, locks, () => NOW);
  await value.ready;
  return value;
}

const saved = (chrome: FakeChrome) => chrome.storage.local.items.get(KEY) as StoredSession | undefined;

test("the replacement token is saved in extension storage before the renewal is sent", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  let savedWhenSent: unknown;
  const client: PanelSignIn = {
    ...fake.client,
    refresh: async (refreshToken, nextRefreshToken) => {
      savedWhenSent = saved(chrome)?.nextRefreshToken;
      return await fake.client.refresh(refreshToken, nextRefreshToken);
    },
  };
  const session = await part(chrome, client);
  await session.fetchAccessToken({ forceRefreshToken: false });
  expect(fake.calls).toEqual(["refresh r1 chosen"]);
  expect(savedWhenSent).toMatch(CHOSEN);
  // Once answered, the replacement is the session's token and nothing is left pending.
  expect(saved(chrome)?.refreshToken).toBe(savedWhenSent as string);
  expect(saved(chrome)?.nextRefreshToken).toBeUndefined();
});

test("a renewal whose answer was lost is sent again with the same pair, and the reviewer stays signed in", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const session = await part(chrome, fake.client);
  fake.loseNextAnswer();
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  const pending = saved(chrome)!;
  expect(pending.refreshToken).toBe("r1");
  expect(pending.nextRefreshToken).toBe(fake.current!);
  // The next request for a token finishes it.
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).toBe(token("Dana", "a2"));
  expect(fake.calls).toEqual(["refresh r1 chosen", "refresh r1 chosen", "repeated"]);
  expect(saved(chrome)?.refreshToken).toBe(fake.current!);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
  // And it keeps renewing from there.
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBe(token("Dana", "a3"));
  expect(fake.calls.at(-1)).toBe("refresh " + pending.nextRefreshToken + " chosen");
});

test("the side panel closes mid-renewal and the worker finishes it, without ending the session", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const locks = sharedLocks();
  const panel = await part(chrome, fake.client, locks);
  const worker = await part(chrome, fake.client, locks);
  // The service commits the panel's renewal, but the panel closes before its answer arrives.
  fake.loseNextAnswer();
  await panel.fetchAccessToken({ forceRefreshToken: false });
  expect(await worker.fetchAccessToken({ forceRefreshToken: false })).not.toBeNull();
  expect(fake.calls).toEqual(["refresh r1 chosen", "refresh r1 chosen", "repeated"]);
  expect(fake.current).not.toBeNull();
  expect(saved(chrome)?.refreshToken).toBe(fake.current!);
  expect(panel.getSnapshot().reviewer).not.toBeNull();
});

test("the side panel and the worker renewing at once send one renewal, and both use it", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const locks = sharedLocks();
  const panel = await part(chrome, fake.client, locks);
  const worker = await part(chrome, fake.client, locks);
  const [fromPanel, fromWorker] = await Promise.all([panel.fetchAccessToken({ forceRefreshToken: false }), worker.fetchAccessToken({ forceRefreshToken: true })]);
  expect(fake.calls).toEqual(["refresh r1 chosen"]);
  expect(fromPanel).toBe(fromWorker);
  expect(fromPanel).not.toBeNull();
});

test("a renewal that times out while the service answers late is finished by the next try, which keeps the result", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const session = await part(chrome, fake.client);
  fake.loseNextAnswer();
  await session.fetchAccessToken({ forceRefreshToken: false });
  // The same pair again, twice (another try, and the worker after it): both get the same session.
  const worker = await part(chrome, fake.client);
  const again = await session.fetchAccessToken({ forceRefreshToken: false });
  expect(await worker.fetchAccessToken({ forceRefreshToken: false })).toBe(again);
  expect(fake.calls.filter((call) => call.startsWith("refresh"))).toHaveLength(2);
  expect(fake.current).toBe(saved(chrome)!.refreshToken);
});

test("signing out with a renewal pending ends the session whichever token the service holds", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const session = await part(chrome, fake.client);
  fake.loseNextAnswer();
  await session.fetchAccessToken({ forceRefreshToken: false });
  await session.signOut();
  await settle();
  expect(fake.current).toBeNull();
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(chrome.storage.local.items.has(endingKey(SIGN_IN))).toBe(false);
  // Both tokens are sent: whichever the service holds ends the session (the replaced one does too), and the other is unknown by then.
  expect(fake.calls.filter((call) => call.startsWith("sign-out")).sort()).toEqual(["sign-out replaced", "sign-out unknown"]);
});

test("changing the name with a renewal pending finishes the renewal first, instead of signing out", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW + 15 * 60_000 }));
  const fake = service();
  const session = await part(chrome, fake.client);
  fake.loseNextAnswer();
  await session.fetchAccessToken({ forceRefreshToken: true });
  await session.setDisplayName("Dana Kim");
  expect(fake.calls).toContain("rename current Dana Kim");
  expect(fake.current).not.toBeNull();
  expect(session.getSnapshot().reviewer).not.toBeNull();
});

test("changing the name while the service can't finish a pending renewal says so, and keeps the reviewer signed in", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW + 15 * 60_000 }));
  const fake = service();
  const session = await part(chrome, fake.client);
  fake.loseNextAnswer();
  await session.fetchAccessToken({ forceRefreshToken: true });
  fake.loseNextAnswer();
  await expect(session.setDisplayName("Dana Kim")).rejects.toThrow("Your name couldn't be changed. Check your connection and try again.");
  expect(fake.calls.some((call) => call.startsWith("rename"))).toBe(false);
  expect(saved(chrome)?.nextRefreshToken).toBe(fake.current!);
  expect(session.getSnapshot().reviewer).not.toBeNull();
});

test("a renewal answered after a sign-out doesn't bring the session back, and ends the one it made", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const locks = sharedLocks();
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  fake.afterCommit = async () => {
    fake.afterCommit = async () => {};
    await answered;
  };
  const panel = await part(chrome, fake.client, locks);
  const worker = await part(chrome, fake.client, locks);
  const renewal = worker.fetchAccessToken({ forceRefreshToken: false });
  await settle();
  const out = panel.signOut();
  answer();
  await Promise.all([renewal, out]);
  await settle(20);
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(worker.getSnapshot().reviewer).toBeNull();
  expect(fake.current).toBeNull();
});

test("with a service from before clients chose their replacement, renewals keep working, without the protection", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service({ older: true });
  const session = await part(chrome, fake.client);
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).not.toBeNull();
  // The service chose the token; the session keeps that one.
  expect(saved(chrome)?.refreshToken).toBe(fake.current!);
  expect(saved(chrome)?.nextRefreshToken).toBeUndefined();
  fake.loseNextAnswer();
  await session.fetchAccessToken({ forceRefreshToken: true });
  // A lost answer still signs out there, as before.
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
  expect(session.getSnapshot().reviewer).toBeNull();
});

test("a pending replacement survives being read back from storage, and a malformed one is ignored", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, { ...stored(), nextRefreshToken: 42 });
  const fake = service();
  const session = await part(chrome, fake.client);
  expect(session.getSnapshot().reviewer).not.toBeNull();
  await session.fetchAccessToken({ forceRefreshToken: false });
  expect(fake.calls).toEqual(["refresh r1 chosen"]);
});

/** The shared Web Lock, and a way to hold it, as a part busy renewing does. */
function heldLocks() {
  const locks = sharedLocks();
  return {
    ...locks,
    /** Holds the lock until the returned function is called. */
    hold() {
      let release!: () => void;
      void locks.request("", () => new Promise<void>((resolve) => (release = resolve)));
      return () => release();
    },
  };
}

const lee = { accessToken: token("Lee", "l1"), refreshToken: "lee-1", expiresAt: NOW + 15 * 60_000, sessionEndsAt: NOW + 30 * 86_400_000, reviewer: { id: "lee", name: "Lee", email: "lee@example.com" } };

test("a name change waiting behind someone else's sign-in in another panel changes nothing", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW + 15 * 60_000 }));
  const fake = service();
  const locks = heldLocks();
  const dana = await part(chrome, fake.client, locks);
  const other = await part(chrome, fake.client, locks);
  await settle();
  const release = locks.hold();
  await settle();
  // Dana's panel shows Dana when the name is saved; Lee's sign-in elsewhere is ahead of it.
  const signingIn = other.signedIn(lee);
  const renaming = dana.setDisplayName("Dana Kim");
  release();
  await signingIn;
  await expect(renaming).rejects.toThrow("You signed out, so your name wasn't changed.");
  expect(fake.calls.some((call) => call.startsWith("rename"))).toBe(false);
  expect(saved(chrome)?.reviewer.name).toBe("Lee");
});

test("a sign-in that lands before a sign-out's clean-up still ends the signed-out session on the service", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW + 15 * 60_000 }));
  const fake = service();
  const locks = heldLocks();
  const dana = await part(chrome, fake.client, locks);
  const other = await part(chrome, fake.client, locks);
  await settle();
  const release = locks.hold();
  await settle();
  // Lee signs in elsewhere while the lock is busy; Dana signs out here, and the clean-up waits behind Lee's sign-in.
  const signingIn = other.signedIn(lee);
  const out = dana.signOut();
  release();
  await Promise.all([signingIn, out]);
  await settle(20);
  expect(fake.current).toBeNull();
  expect(fake.calls).toContain("sign-out current");
  expect(saved(chrome)?.reviewer.id).toBe("lee");
  expect(other.getSnapshot().reviewer?.id).toBe("lee");
  expect(chrome.storage.local.items.has(endingKey(SIGN_IN))).toBe(false);
});

test("a saved replacement the service wouldn't accept is replaced by a new one", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, { ...stored(), nextRefreshToken: "not a token" });
  const fake = service();
  let sent: string | undefined;
  const session = await part(chrome, { ...fake.client, refresh: async (refreshToken, next) => ((sent = next), await fake.client.refresh(refreshToken, next)) });
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).not.toBeNull();
  expect(sent).toMatch(CHOSEN);
});

test("a replacement the service refuses as already in use is dropped, and the next renewal chooses another", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored());
  const fake = service();
  const sent: (string | undefined)[] = [];
  let refuse = true;
  const session = await part(chrome, {
    ...fake.client,
    refresh: async (refreshToken, next) => {
      sent.push(next);
      if (refuse) {
        refuse = false;
        throw new PanelSignInError("invalid-request", "This request is incomplete.");
      }
      return await fake.client.refresh(refreshToken, next);
    },
  });
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
  expect(saved(chrome)?.nextRefreshToken).toBeUndefined();
  expect(session.getSnapshot().reviewer).not.toBeNull();
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).not.toBeNull();
  expect(sent).toHaveLength(2);
  expect(sent[1]).not.toBe(sent[0]);
});

test("a sign-in whose save fails leaves the stored session as it was, and doesn't end it", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW + 15 * 60_000 }));
  const fake = service();
  const set = chrome.storage.local.set.bind(chrome.storage.local);
  // Storage refuses the write that would keep Lee's session (full, or the extension is being updated).
  chrome.storage.local.set = async (values) => {
    if ((values[KEY] as StoredSession | undefined)?.reviewer.id === "lee") throw new Error("QUOTA_BYTES quota exceeded");
    await set(values);
  };
  const other = await part(chrome, fake.client);
  await expect(other.signedIn(lee)).rejects.toThrow("QUOTA_BYTES");
  // The next part to start finds Dana's session as it was, and it still works.
  const next = await part(chrome, fake.client);
  await settle(20);
  expect(next.getSnapshot().reviewer?.id).toBe("dana");
  expect(fake.calls.filter((call) => call.startsWith("sign-out"))).toEqual([]);
  expect(await next.fetchAccessToken({ forceRefreshToken: true })).not.toBeNull();
  expect(fake.current).not.toBeNull();
});

test("signing out again while the last sign-out is still telling the service ends that session too, without another part starting", async () => {
  const chrome = fakeChrome();
  chrome.storage.local.items.set(KEY, stored({ expiresAt: NOW + 15 * 60_000 }));
  const fake = service();
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const ended: string[] = [];
  const session = await part(chrome, {
    ...fake.client,
    signOut: async (refreshToken) => {
      ended.push(refreshToken);
      if (refreshToken === "r1") await answered;
      return true;
    },
  });
  const first = session.signOut();
  await settle();
  // Signed in again and out again while the service hasn't answered the first sign-out.
  await session.signedIn(lee);
  const second = session.signOut();
  answer();
  await Promise.all([first, second]);
  await settle(20);
  expect(ended.sort()).toEqual(["lee-1", "r1"]);
  expect(chrome.storage.local.items.has(KEY)).toBe(false);
  expect(chrome.storage.local.items.has(endingKey(SIGN_IN))).toBe(false);
});
