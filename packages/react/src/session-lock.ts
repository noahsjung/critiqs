/** Serializes refreshes across components and same-site tabs. */
const queues = new Map<string, Promise<unknown>>();
const WAIT_MS = 30_000;

/**
 * `safeWithoutClaim` is asked when a claim (browsers without Web Locks) is
 * still held after the wait: true means the operation is safe to repeat
 * alongside its owner, so it runs anyway.
 */
export async function withSessionLock<T>(name: string, refreshToken: string, operation: () => Promise<T>, safeWithoutClaim: () => boolean = () => false): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (typeof navigator.locks?.request === "function") return await navigator.locks.request(name, operation);
    if (typeof indexedDB === "undefined") throw new Error("This browser cannot safely refresh a shared Critiqs session.");
    // Single-use tokens need a claim that cannot be stolen while a tab is
    // suspended after the server has rotated but before it stores the response.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refreshToken));
    const tokenKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return await withIndexedDbLock(`${name}:${tokenKey}`, operation, safeWithoutClaim);
  });
  queues.set(name, current);
  try { return await current; }
  finally { if (queues.get(name) === current) queues.delete(name); }
}

/**
 * Atomic per-token claim for browsers without Web Locks. A bounded wait does
 * not authorize takeover: a crashed owner leaves an ambiguous single-use
 * token. Its claimant may finish later; signing in again uses a different key.
 */
async function withIndexedDbLock<T>(name: string, operation: () => Promise<T>, safeWithoutClaim: () => boolean): Promise<T> {
  const db = await openLocks();
  const owner = crypto.randomUUID();
  const deadline = Date.now() + WAIT_MS;
  try {
    while (!(await acquire(db, name, owner))) {
      if (Date.now() >= deadline) {
        if (safeWithoutClaim()) return await operation();
        throw new Error("Critiqs session refresh is pending in another tab. Retry, or sign in again if that tab was closed.");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return await operation();
  } finally {
    await release(db, name, owner);
    db.close();
  }
}

function openLocks(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("critiqs-session-locks", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("leases");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function acquire(db: IDBDatabase, name: string, owner: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("leases", "readwrite");
    const store = tx.objectStore("leases");
    const request = store.get(name);
    let acquired = false;
    request.onsuccess = () => {
      const claim = request.result as { owner: string } | undefined;
      if (claim === undefined) {
        store.put({ owner }, name);
        acquired = true;
      }
    };
    tx.oncomplete = () => resolve(acquired);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
function release(db: IDBDatabase, name: string, owner: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("leases", "readwrite");
    const store = tx.objectStore("leases");
    const request = store.get(name);
    request.onsuccess = () => {
      if (request.result?.owner === owner) store.delete(name);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
