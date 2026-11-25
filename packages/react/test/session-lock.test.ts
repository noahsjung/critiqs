import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

const originalIndexedDb = globalThis.indexedDB;
const originalLocks = navigator.locks;
const name = "critiqs:session:https://auth.example";
let store: { refreshToken: string; accessToken: string };
let requests: string[];

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  store = { refreshToken: "r1", accessToken: "old" };
  requests = [];
});
afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb });
  Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
});

// Query suffixes give each simulated tab its own module queue; only IndexedDB
// is shared. A shared module queue would hide the cross-tab contention bug.
async function tabs() {
  return await Promise.all([
    import(`../src/session-lock.ts?tab=a-${crypto.randomUUID()}`),
    import(`../src/session-lock.ts?tab=b-${crypto.randomUUID()}`),
  ]);
}

/** Session's error handling: failed arbitration preserves stored tokens for retry. */
async function refresh(lock: (name: string, token: string, operation: () => Promise<string>) => Promise<string>, operation: () => Promise<string>) {
  return await lock(name, store.refreshToken, operation).catch(() => null);
}

test("an independent tab never reuses a token owned by a suspended refresh, even after 30 seconds", async () => {
  const [a, b] = await tabs();
  expect(a.withSessionLock).not.toBe(b.withSessionLock);
  let resume!: () => void;
  let started!: () => void;
  const serverRotated = new Promise<void>(resolve => { started = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const pending = refresh(a.withSessionLock, async () => {
    requests.push(store.refreshToken);
    // The server has consumed r1 and issued r2, but tab A is suspended before
    // the response can update the site's shared storage.
    started();
    await paused;
    store = { refreshToken: "r2", accessToken: "new" };
    return "new";
  });
  await serverRotated;
  let now = Date.now() + 60_000;
  const clock = spyOn(Date, "now").mockImplementation(() => { const value = now; now += 60_000; return value; });
  try {
    const waiter = await refresh(b.withSessionLock, async () => { requests.push(store.refreshToken); throw new Error("Reused token"); });
    expect(waiter).toBeNull();
    expect(store).toEqual({ refreshToken: "r1", accessToken: "old" });
    expect(requests).toEqual(["r1"]);
  } finally { clock.mockRestore(); }
  resume();
  expect(await pending).toBe("new");
  expect(store.refreshToken).toBe("r2");
  expect(await refresh(b.withSessionLock, async () => { requests.push(store.refreshToken); return "next"; })).toBe("next");
  expect(requests).toEqual(["r1", "r2"]);
});

test("an abandoned claim blocks its ambiguous old token but a new sign-in token can recover", async () => {
  const [a, b] = await tabs();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("r1"));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  await abandonedClaim(`${name}:${hash}`);
  let now = Date.now() + 60_000;
  const clock = spyOn(Date, "now").mockImplementation(() => { const value = now; now += 60_000; return value; });
  try {
    expect(await refresh(a.withSessionLock, async () => { requests.push("r1"); return "unsafe"; })).toBeNull();
    expect(requests).toEqual([]);
    expect(store.refreshToken).toBe("r1");
  } finally { clock.mockRestore(); }
  // A new popup sign-in provides a different single-use token, unaffected by
  // the old claim. Never infer that the old server request did not finish.
  store = { refreshToken: "fresh-sign-in", accessToken: "fresh-access" };
  expect(await refresh(b.withSessionLock, async () => { requests.push(store.refreshToken); return "fresh-access"; })).toBe("fresh-access");
  expect(requests).toEqual(["fresh-sign-in"]);
});

async function abandonedClaim(key: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("critiqs-session-locks", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("leases");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("leases", "readwrite");
      tx.objectStore("leases").put({ owner: "closed-tab" }, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
