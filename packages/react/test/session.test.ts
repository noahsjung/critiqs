import { beforeEach, expect, spyOn, test } from "bun:test";
import { Session } from "../src/session.ts";

const SIGN_IN = "https://auth.example";

function token(claims: Record<string, unknown>) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "ES256" })}.${encode(claims)}.signature`;
}

/** A request body without the replacement token the session chose, which is random. */
function chosen(body: unknown) {
  const { nextRefreshToken, ...rest } = JSON.parse(String(body)) as { nextRefreshToken?: string };
  if (nextRefreshToken !== undefined) expect(nextRefreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return JSON.stringify(rest);
}

function store(session: { accessToken: string; refreshToken: string; expiresAt: number }) {
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify(session));
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } });
});

test("signed out without a stored session", async () => {
  const session = new Session(SIGN_IN, localStorage);
  expect(session.getSnapshot().reviewer).toBeNull();
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).toBeNull();
});

test("reads the reviewer from the stored token and reuses a fresh token", async () => {
  const access = token({ name: "Dana Lee", email: "dana@example.com" });
  store({ accessToken: access, refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  const session = new Session(SIGN_IN, localStorage, async () => {
    throw new Error("should not refresh");
  });
  expect(session.getSnapshot().reviewer).toEqual({ id: "", name: "Dana Lee", email: "dana@example.com", pictureUrl: null });
  expect(await session.fetchAccessToken({ forceRefreshToken: false })).toBe(access);
});

test("refreshes once for concurrent requests near expiry", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 1000 });
  const fresh = token({ name: "Dana" });
  let calls = 0;
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    calls += 1;
    expect(String(url)).toBe(`${SIGN_IN}/auth/refresh`);
    expect(chosen(init.body)).toBe('{"refreshToken":"r1"}');
    return Response.json({ accessToken: fresh, refreshToken: "r2", expiresAt: Date.now() + 15 * 60_000 });
  });
  const [a, b] = await Promise.all([
    session.fetchAccessToken({ forceRefreshToken: false }),
    session.fetchAccessToken({ forceRefreshToken: true }),
  ]);
  expect([a, b]).toEqual([fresh, fresh]);
  expect(calls).toBe(1);
});

test("an ended session signs the reviewer out", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const session = new Session(SIGN_IN, localStorage, async () => new Response("Signed out", { status: 401 }));
  let notified = 0;
  session.subscribe(() => notified++);
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
  expect(session.getSnapshot().reviewer).toBeNull();
  expect(notified).toBe(1);
});

test("a network failure keeps the session for a later retry", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const session = new Session(SIGN_IN, localStorage, async () => {
    throw new TypeError("offline");
  });
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
});

test("sign-out forgets the session and ends it on the server", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 60_000 });
  const requests: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    requests.push(`${url} ${init.body}`);
    return new Response(null, { status: 204 });
  });
  await session.signOut();
  expect(session.getSnapshot().reviewer).toBeNull();
  expect(requests).toEqual([`${SIGN_IN}/auth/sign-out {"refreshToken":"r1"}`]);
});

test("a refresh that finishes after sign-out does not sign the reviewer back in", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  let respond: (response: Response) => void = () => {};
  const session = new Session(SIGN_IN, localStorage, async (url) =>
    String(url).endsWith("/auth/refresh")
      ? await new Promise<Response>((resolve) => (respond = resolve))
      : new Response(null, { status: 204 }),
  );
  const pending = session.fetchAccessToken({ forceRefreshToken: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  await session.signOut();
  respond(Response.json({ accessToken: token({ name: "Dana" }), refreshToken: "r2", expiresAt: Date.now() + 60_000 }));
  expect(await pending).toBeNull();
  expect(session.getSnapshot().reviewer).toBeNull();
});

test("a stale rejection does not end a newer session", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  let respond: (response: Response) => void = () => {};
  const session = new Session(SIGN_IN, localStorage, () => new Promise<Response>((resolve) => (respond = resolve)));
  const pending = session.fetchAccessToken({ forceRefreshToken: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  store({ accessToken: token({ name: "Lee" }), refreshToken: "r2", expiresAt: Date.now() + 60_000 });
  respond(new Response("Signed out", { status: 401 }));
  await pending;
  expect(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).refreshToken).toBe("r2");
});

test("two Session instances serialize forced refreshes and persist the replacement for the next refresh", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const requests: string[] = [];
  const fetcher = async (_url: URL, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).refreshToken);
    await new Promise(resolve => setTimeout(resolve, 1));
    return Response.json({ accessToken: `access-${requests.length}`, refreshToken: `r${requests.length + 1}`, expiresAt: Date.now() + 900_000 });
  };
  const a = new Session(SIGN_IN, localStorage, fetcher);
  const b = new Session(SIGN_IN, localStorage, fetcher);
  expect(await Promise.all([a.fetchAccessToken({ forceRefreshToken: true }), b.fetchAccessToken({ forceRefreshToken: true })])).toEqual(["access-1", "access-1"]);
  expect(requests).toEqual(["r1"]);
  expect(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).refreshToken).toBe("r2");
  expect(await b.fetchAccessToken({ forceRefreshToken: true })).toBe("access-2");
  expect(requests).toEqual(["r1", "r2"]);
});

test("sign-out revokes a replacement issued by an in-flight refresh", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  let respond!: (response: Response) => void;
  const revoked: string[] = [];
  let chosenToken = "";
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    if (url.pathname === "/auth/refresh") {
      chosenToken = JSON.parse(String(init.body)).nextRefreshToken;
      return await new Promise<Response>(resolve => { respond = resolve; });
    }
    revoked.push(JSON.parse(String(init.body)).refreshToken);
    return new Response(null, { status: 204 });
  });
  const pending = session.fetchAccessToken({ forceRefreshToken: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  await session.signOut();
  respond(Response.json({ accessToken: "new-access", refreshToken: "r2", expiresAt: Date.now() + 900_000 }));
  expect(await pending).toBeNull();
  // The token the refresh asked for is ended too: the service may already have switched to it.
  expect(revoked).toEqual(["r1", chosenToken, "r2"]);
  expect(localStorage.getItem(`critiqs:session:${SIGN_IN}`)).toBeNull();
});

test("malformed refresh responses and server errors preserve the session for retry", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  for (const response of [new Response("failure", { status: 503 }), new Response("bad json"), Response.json({ accessToken: "access", expiresAt: 123 })]) {
    const session = new Session(SIGN_IN, localStorage, async () => response);
    expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
    expect(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).refreshToken).toBe("r1");
  }
});

test("sign-out updates other subscribed Session instances in the same tab", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 60_000 });
  const a = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const b = new Session(SIGN_IN, localStorage);
  const unsubscribe = b.subscribe(() => {});
  await a.signOut();
  expect(b.getSnapshot().reviewer).toBeNull();
  unsubscribe();
});

test("changing the display name updates the server, then refreshes so the token carries it", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  const requests: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    requests.push(`${String(url)} ${chosen(init.body)}`);
    if (String(url).endsWith("/auth/profile")) return new Response(null, { status: 204 });
    return Response.json({ accessToken: token({ name: "Dana Kim" }), refreshToken: "r2", expiresAt: Date.now() + 15 * 60_000 });
  });
  expect(await session.setDisplayName("Dana Kim")).toBe(true);
  expect(requests).toEqual([
    `${SIGN_IN}/auth/profile {"refreshToken":"r1","name":"Dana Kim"}`,
    `${SIGN_IN}/auth/refresh {"refreshToken":"r1"}`,
  ]);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana Kim");
});

test("a rejected display name explains why and keeps the session", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  const session = new Session(SIGN_IN, localStorage, async () =>
    Response.json({ error: "Use a name of 1 to 60 characters." }, { status: 400 }),
  );
  await expect(session.setDisplayName("")).rejects.toThrow("1 to 60 characters");
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
});

test("a token without a name never shows the email address as the name", () => {
  store({ accessToken: token({ email: "dana@example.com" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  expect(new Session(SIGN_IN, localStorage).getSnapshot().reviewer?.name).toBe("Reviewer");
});

test("a name saved while the refresh fails reports that the token doesn't carry it yet", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  const session = new Session(SIGN_IN, localStorage, async (url) =>
    String(url).endsWith("/auth/profile") ? new Response(null, { status: 204 }) : new Response(null, { status: 503 }),
  );
  expect(await session.setDisplayName("Dana Kim")).toBe(false);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
});

test("a rename waits for a refresh already under way and uses the token it delivers", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 1000 });
  const bodies: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let refreshes = 0;
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    bodies.push(`${new URL(String(url)).pathname} ${chosen(init.body)}`);
    if (String(url).endsWith("/auth/profile")) return new Response(null, { status: 204 });
    refreshes += 1;
    if (refreshes === 1) await held;
    return Response.json({ accessToken: token({ name: refreshes === 1 ? "Dana" : "Dana Kim" }), refreshToken: `r${refreshes + 1}`, expiresAt: Date.now() + 15 * 60_000 });
  });
  const refreshing = session.fetchAccessToken({ forceRefreshToken: true });
  const renaming = session.setDisplayName("Dana Kim");
  release();
  await refreshing;
  expect(await renaming).toBe(true);
  expect(bodies).toEqual([
    '/auth/refresh {"refreshToken":"r1"}',
    '/auth/profile {"refreshToken":"r2","name":"Dana Kim"}',
    '/auth/refresh {"refreshToken":"r2"}',
  ]);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana Kim");
});

test("a rename waiting for a lock claimed on a token another tab has since rotated claims the current token", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  const claims: string[] = [];
  let rotated = false;
  // Locks keyed per token, as without Web Locks; another tab rotates while this one waits.
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, callback: () => Promise<unknown>) => {
        claims.push(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).refreshToken);
        if (!rotated) {
          rotated = true;
          store({ accessToken: token({ name: "Dana" }), refreshToken: "r2", expiresAt: Date.now() + 10 * 60_000 });
        }
        return callback();
      },
    },
  });
  const bodies: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    bodies.push(`${new URL(String(url)).pathname} ${chosen(init.body)}`);
    if (String(url).endsWith("/auth/profile")) return new Response(null, { status: 204 });
    return Response.json({ accessToken: token({ name: "Dana Kim" }), refreshToken: "r3", expiresAt: Date.now() + 15 * 60_000 });
  });
  expect(await session.setDisplayName("Dana Kim")).toBe(true);
  expect(bodies).toEqual(['/auth/profile {"refreshToken":"r2","name":"Dana Kim"}', '/auth/refresh {"refreshToken":"r2"}']);
});

test("a rename queued behind another tab never renames a different reviewer who signed in meanwhile", async () => {
  store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, callback: () => Promise<unknown>) => {
        // While this tab waited, Dana signed out and Lee signed in.
        store({ accessToken: token({ sub: "lee", name: "Lee" }), refreshToken: "lee-1", expiresAt: Date.now() + 10 * 60_000 });
        return callback();
      },
    },
  });
  const requests: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url) => {
    requests.push(String(url));
    return new Response(null, { status: 204 });
  });
  await expect(session.setDisplayName("Dana Kim")).rejects.toThrow("signed out");
  expect(requests).toEqual([]);
  // Lee's session is untouched.
  expect(new Session(SIGN_IN, localStorage).getSnapshot().reviewer?.name).toBe("Lee");
});

test("sign-in accepts tokens only from its own popup", async () => {
  const popup = { closed: false } as unknown as Window;
  let opened = "";
  const realOpen = window.open;
  window.open = ((url: string) => {
    opened = url;
    return popup;
  }) as typeof window.open;
  try {
    const session = new Session(SIGN_IN, localStorage);
    const signingIn = session.signIn();
    const state = new URL(opened).searchParams.get("state");
    const deliver = (source: unknown, name: string) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: SIGN_IN,
          source: source as MessageEventSource,
          data: { type: "critiqs:sign-in", state, accessToken: token({ name }), refreshToken: "r1", expiresAt: Date.now() + 60_000 },
        }),
      );
    // Another window on Critiqs's sign-in origin, with the right nonce, is still ignored.
    deliver({}, "Mallory");
    expect(session.getSnapshot().reviewer).toBeNull();
    deliver(popup, "Dana");
    await signingIn;
    expect(session.getSnapshot().reviewer?.name).toBe("Dana");
  } finally {
    window.open = realOpen;
  }
});

test("the replacement token is saved before the refresh is sent, and sent again until an answer arrives", async () => {
  store({ accessToken: token({ name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const sent: { refreshToken: string; nextRefreshToken: string }[] = [];
  let online = false;
  const session = new Session(SIGN_IN, localStorage, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    // Already on disk when the request leaves, so a page that closes now can finish it later.
    expect(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).nextRefreshToken).toBe(body.nextRefreshToken);
    sent.push(body);
    if (!online) throw new TypeError("offline");
    return Response.json({ accessToken: token({ name: "Dana" }), refreshToken: body.nextRefreshToken, expiresAt: Date.now() + 900_000 });
  });
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
  online = true;
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]!);
  const saved = JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!);
  expect(saved.refreshToken).toBe(sent[0]!.nextRefreshToken);
  expect(saved.nextRefreshToken).toBeUndefined();
});

test("a rename whose answer arrives after sign-out doesn't bring the cleared sign-in back", async () => {
  store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  let answer!: () => void;
  const session = new Session(SIGN_IN, localStorage, async (url) => {
    if (url.pathname === "/auth/profile") {
      await new Promise<void>((resolve) => (answer = resolve));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/auth/refresh") throw new TypeError("offline");
    return new Response(null, { status: 204 });
  });
  const renaming = session.setDisplayName("Dana Kim");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await session.signOut();
  answer();
  await renaming.catch(() => undefined);
  expect(localStorage.getItem(`critiqs:session:${SIGN_IN}`)).toBeNull();
  expect(session.getSnapshot().reviewer).toBeNull();
});

test("a rename that can't reach the service to finish a pending refresh says so", async () => {
  store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r1", expiresAt: Date.now() + 10 * 60_000 });
  // A refresh whose answer was lost left its chosen token saved.
  const saved = JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!);
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ ...saved, nextRefreshToken: "n".repeat(43) }));
  const paths: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url) => {
    paths.push(url.pathname);
    throw new TypeError("offline");
  });
  await expect(session.setDisplayName("Dana Kim")).rejects.toThrow("couldn't be changed");
  expect(paths).toEqual(["/auth/refresh"]);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
});

test("a refresh another tab already finished with the same replacement is kept, not ended", async () => {
  store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const ended: string[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.pathname === "/auth/sign-out") {
      ended.push(body.refreshToken);
      return new Response(null, { status: 204 });
    }
    // While this page was suspended, another tab repeated the same refresh and saved its result.
    store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: body.nextRefreshToken, expiresAt: Date.now() + 900_000 });
    return Response.json({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: body.nextRefreshToken, expiresAt: Date.now() + 900_000 });
  });
  expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  expect(ended).toEqual([]);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
});

test("without Web Locks, a claim left by a closed page doesn't stop the page from finishing the saved refresh", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const originalIndexedDb = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const key = `critiqs:session:${SIGN_IN}`;
  // The closed page saved its chosen token, sent the refresh, and never released its claim.
  store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const saved = JSON.parse(localStorage.getItem(key)!);
  const chosenToken = "c".repeat(43);
  localStorage.setItem(key, JSON.stringify({ ...saved, nextRefreshToken: chosenToken }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("r1"));
  const claim = `${key}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("critiqs-session-locks", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("leases");
    open.onsuccess = () => {
      const tx = open.result.transaction("leases", "readwrite");
      tx.objectStore("leases").put({ owner: "closed-page" }, claim);
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  const sent: unknown[] = [];
  const session = new Session(SIGN_IN, localStorage, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return Response.json({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: body.nextRefreshToken, expiresAt: Date.now() + 900_000 });
  });
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 5_000));
  try {
    expect(await session.fetchAccessToken({ forceRefreshToken: true })).toBeString();
  } finally {
    clock.mockRestore();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb });
  }
  expect(sent).toEqual([{ refreshToken: "r1", nextRefreshToken: chosenToken }]);
  expect(JSON.parse(localStorage.getItem(key)!).refreshToken).toBe(chosenToken);
});

test("a page whose late answer finds another session saved ends it only if it is still current", async () => {
  store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r1", expiresAt: 0 });
  const signOuts: unknown[] = [];
  const session = new Session(SIGN_IN, localStorage, async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.pathname === "/auth/sign-out") {
      signOuts.push(body);
      return new Response(null, { status: 204 });
    }
    // Meanwhile another tab finished this refresh and renewed again.
    store({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: "r3", expiresAt: Date.now() + 900_000 });
    return Response.json({ accessToken: token({ sub: "dana", name: "Dana" }), refreshToken: body.nextRefreshToken, expiresAt: Date.now() + 900_000 });
  });
  await session.fetchAccessToken({ forceRefreshToken: true });
  expect(signOuts).toEqual([{ refreshToken: expect.any(String), onlyIfCurrent: true }]);
  expect(JSON.parse(localStorage.getItem(`critiqs:session:${SIGN_IN}`)!).refreshToken).toBe("r3");
});
