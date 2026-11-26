import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessTokenFor, signOutComputer } from "../bin/agent.mjs";
import { runCli } from "../bin/cli.mjs";
import { createTools } from "../bin/mcp.mjs";

// Renewing and ending this computer's sign-in while another Critiqs process
// does the same, against a stand-in sign-in service that follows the
// backend's rules (`refreshSession` and `endSession` in
// packages/backend/convex/signIn.ts). Another process is played here by making
// the lock look abandoned, as it does to other processes when its holder is
// suspended (a laptop asleep, a stopped process) for longer than 30 seconds.

const TEAM = "https://team.convex.cloud";
const SITE = "https://team.convex.site";
const MINUTE = 60_000;

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "critiqs-sign-in-races-"));
  folders.push(made);
  return made;
};

const token = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/**
 * The sign-in service's sessions. A refresh replaces a session's token with
 * the one the client chose; sending a replaced token again with that same
 * replacement, before the replacement is used, repeats the refresh; any other
 * use of a replaced token ends the session as stolen. Signing out ends a
 * session by its token or, unless `onlyIfCurrent`, by a token it replaced.
 */
function signInService() {
  let clock = Date.now();
  let ids = 0;
  const sessions = new Map<number, string>();
  const replacedTokens = new Map<string, { sessionId: number; next: string }>();
  const holding = (refreshToken: string) => [...sessions].find(([, current]) => current === refreshToken)?.[0];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const refresh = (refreshToken: string, next: string) => {
    let id = holding(refreshToken);
    let repeated = false;
    if (id === undefined) {
      const replaced = replacedTokens.get(refreshToken);
      if (replaced === undefined || !sessions.has(replaced.sessionId)) return new Response("Signed out", { status: 401 });
      if (replaced.next !== next || sessions.get(replaced.sessionId) !== next) {
        sessions.delete(replaced.sessionId);
        return new Response("Signed out", { status: 401 });
      }
      id = replaced.sessionId;
      repeated = true;
    } else if (holding(next) !== undefined || replacedTokens.has(next)) {
      return new Response("Bad request", { status: 400 });
    }
    if (!repeated) {
      sessions.set(id, next);
      replacedTokens.set(refreshToken, { sessionId: id, next });
    }
    const expiresAt = clock + 15 * MINUTE;
    return Response.json({ accessToken: token({ sub: "dana", name: "Dana", session: id, exp: expiresAt / 1000 }), refreshToken: next, expiresAt });
  };
  const end = (refreshToken: string, onlyIfCurrent: boolean) => {
    const replaced = onlyIfCurrent ? undefined : replacedTokens.get(refreshToken);
    const id = holding(refreshToken) ?? (replaced !== undefined && sessions.has(replaced.sessionId) ? replaced.sessionId : undefined);
    if (id !== undefined) sessions.delete(id);
    return new Response(null, { status: 204, headers: { "Critiqs-Session-Ended": String(id !== undefined) } });
  };
  /** What the service does with a request; the answer is returned only once `reached` (another process's turn) is done. */
  const fetchWith =
    (reached?: (path: string, body: Record<string, unknown>) => Promise<void> | void) =>
    (async (url: string, init: RequestInit = {}) => {
      const { pathname } = new URL(url);
      if (pathname === "/critiqs/config") return Response.json({ protocol: 5, signInUrl: SITE, deviceSignIn: true, deviceSessions: true });
      const body = JSON.parse(String(init.body ?? "{}"));
      requests.push({ path: pathname, body });
      const answer =
        pathname === "/auth/refresh" ? refresh(body.refreshToken, body.nextRefreshToken) : pathname === "/auth/sign-out" ? end(body.refreshToken, body.onlyIfCurrent === true) : null;
      if (answer === null) throw new Error(`Unexpected ${url}`);
      await reached?.(pathname, body);
      return answer;
    }) as unknown as typeof fetch;
  return {
    now: () => clock,
    pass: (ms: number) => void (clock += ms),
    open: (refreshToken: string) => (sessions.set(++ids, refreshToken), ids),
    live: (id: number) => sessions.has(id),
    current: (id: number) => sessions.get(id),
    requests,
    fetchFn: fetchWith(),
    fetchWith,
  };
}

const signInFile = (config: string) => join(config, "sign-in.v2.json");
const read = (config: string) => JSON.parse(readFileSync(signInFile(config), "utf8"));
function save(config: string, entry: Record<string, unknown>, more: Record<string, unknown> = {}) {
  const saved = { origin: SITE, bindings: [{ backend: TEAM, site: SITE }], accessToken: "a0", accessExpiresAt: 0, reviewer: { name: "Dana", email: null }, signedInAt: 1, ...entry };
  writeFileSync(signInFile(config), JSON.stringify({ version: 2, services: { [SITE]: saved }, ...more }));
}
/** Makes the lock look abandoned, so the next process to want it takes it over. */
function suspend(config: string) {
  const past = new Date(Date.now() - 2 * MINUTE);
  utimesSync(join(`${signInFile(config)}.lock`, "owner"), past, past);
}
const expired = (accessToken: string, now: number) => JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString()).exp * 1000 <= now;
/** The access token this computer would use now, or the reason it can't. */
const usableToken = (env: Record<string, string>, service: ReturnType<typeof signInService>) =>
  accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: service.fetchFn, now: service.now }).catch((error: Error) => `error: ${error.message}`);

test("a late answer to a renewal another process finished keeps the replacement that process saved since, so the session isn't ended as stolen", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  const session = service.open("r1");
  save(config, { refreshToken: "r1" });
  let late = true;
  const process1 = service.fetchWith(async () => {
    if (!late) return;
    late = false;
    // The service renewed r1 for process 1, which is then suspended before it reads the answer.
    suspend(config);
    // Process 2 sends the saved replacement again, which the service accepts as a repeat, and saves it.
    await accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: service.fetchFn, now: service.now });
    // Twenty minutes later process 3 renews again; the service switches to its replacement, but its answer is lost.
    service.pass(20 * MINUTE);
    const lost = service.fetchWith(() => {
      throw new TypeError("The answer never arrived.");
    });
    await expect(accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: lost, now: service.now })).rejects.toThrow("Can't reach");
  });
  const first = await accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: process1, now: service.now }).catch((error: Error) => error);
  // Process 1's answer is twenty minutes old: its access token has expired, so it isn't handed out.
  expect(first).toBeInstanceOf(Error);
  expect((first as Error).message).toContain("Try again");
  const pending = service.requests.at(-1)!.body.nextRefreshToken;
  expect(read(config).services[SITE].nextRefreshToken).toBe(pending);

  // The next renewal sends process 3's replacement again, and the service finishes it.
  const next = await usableToken(env, service);
  expect(next).not.toStartWith("error");
  expect(expired(next, service.now())).toBe(false);
  expect(service.live(session)).toBe(true);
  expect(service.current(session)).toBe(pending as string);
  expect(read(config).services[SITE]).toMatchObject({ refreshToken: pending });
});

test("a sign-out that crosses another process finishing a lost renewal ends the session and leaves nothing usable on disk", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  const session = service.open("r1");
  // A renewal whose answer was lost left its replacement saved; the service never got it.
  save(config, { refreshToken: "r1", nextRefreshToken: "n1" });
  let crossed = false;
  const signingOut = service.fetchWith(async () => {});
  const crossing = (async (url: string, init?: RequestInit) => {
    if (!crossed && url.endsWith("/auth/sign-out")) {
      crossed = true;
      // Sign-out is suspended as it sends its first request; another process sends the saved replacement and saves it.
      suspend(config);
      await accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: service.fetchFn, now: service.now });
      expect(read(config).services[SITE]).toMatchObject({ refreshToken: "n1" });
    }
    return signingOut(url, init);
  }) as unknown as typeof fetch;
  const printed: string[] = [];
  expect(await runCli(["sign-out", "--backend", TEAM], { print: (line) => void printed.push(line), env, fetchFn: crossing })).toBe(0);
  expect(printed).toEqual(["Signed out Dana."]);
  expect(service.live(session)).toBe(false);
  expect(read(config).services).toEqual({});
  expect(await usableToken(env, service)).toStartWith("error: This computer isn't signed in to Critiqs.");
});

test("a sign-out that crosses two renewals by another process says the sign-in may remain and exits non-zero, and signing out again clears it", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  const session = service.open("r1");
  save(config, { refreshToken: "r1", nextRefreshToken: "n1" });
  let crossed = false;
  const signingOut = service.fetchWith(async () => {});
  const crossing = (async (url: string, init?: RequestInit) => {
    if (!crossed && url.endsWith("/auth/sign-out")) {
      crossed = true;
      suspend(config);
      // Another process finishes the lost renewal, and renews again once that access token is nearly used up.
      await accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: service.fetchFn, now: service.now });
      service.pass(15 * MINUTE);
      await accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: service.fetchFn, now: service.now });
    }
    return signingOut(url, init);
  }) as unknown as typeof fetch;
  const printed: string[] = [];
  const signOut = (fetchFn: typeof fetch) => runCli(["sign-out", "--backend", TEAM], { print: (line) => void printed.push(line), env, fetchFn });
  expect(await signOut(crossing)).toBe(1);
  expect(printed.at(-1)).toBe("Another Critiqs process changed this computer's sign-in while it was signing out, so it may still be signed in. Sign out again.");
  // The service ended the session through the token it replaced, but its last access token is still saved.
  expect(service.live(session)).toBe(false);
  expect(read(config).services[SITE]).toBeDefined();

  expect(await signOut(service.fetchFn)).toBe(0);
  expect(read(config).services).toEqual({});
  expect(await usableToken(env, service)).toStartWith("error: This computer isn't signed in to Critiqs.");
});

test("a sign-out the service doesn't confirm for an earlier session says what is left and exits non-zero, in the command and the MCP tool", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  const signedIn = service.open("r1");
  // A renewal that lost a race to another sign-in kept its session aside, to end when signing out.
  const spare = service.open("spare");
  save(config, { refreshToken: "r1" }, { recovered: [{ signInUrl: SITE, origin: SITE, refreshToken: "spare" }] });
  let reachable = false;
  const flaky = (async (url: string, init?: RequestInit) => {
    if (!reachable && JSON.parse(String(init?.body ?? "{}")).refreshToken === "spare") throw new TypeError("The request timed out.");
    return service.fetchFn(url, init);
  }) as unknown as typeof fetch;
  const printed: string[] = [];
  const signOut = () => runCli(["sign-out", "--backend", TEAM], { print: (line) => void printed.push(line), env, fetchFn: flaky });
  const left = `didn't confirm ending an earlier session from this computer, so it stays saved here. Sign out again when it's reachable.`;

  expect(await signOut()).toBe(1);
  expect(printed).toEqual([`Signed out Dana, but Critiqs's sign-in service at ${SITE} ${left}`]);
  expect(service.live(signedIn)).toBe(false);
  expect(service.live(spare)).toBe(true);
  expect(read(config).services).toEqual({});
  expect(read(config).recovered).toEqual([{ signInUrl: SITE, origin: SITE, refreshToken: "spare" }]);

  // With only that session left, signing out doesn't say this computer wasn't signed in.
  expect(await signOut()).toBe(1);
  expect(printed.at(-1)).toBe(`Critiqs's sign-in service at ${SITE} ${left}`);
  const tools = createTools({ cwd: config, env, fetchFn: flaky, open: () => {}, sleep: async () => {} });
  const tool = await tools.call("critiqs_sign_out", { backend: TEAM });
  expect(tool).toMatchObject({ isError: true, content: [{ text: `Critiqs's sign-in service at ${SITE} ${left}` }] });

  reachable = true;
  expect(await signOut()).toBe(0);
  expect(printed.at(-1)).toBe("This computer wasn't signed in to Critiqs.");
  expect(service.live(spare)).toBe(false);
  expect(read(config).recovered).toBeUndefined();
});

test("a renewal that lost a race ends its orphaned session without keeping another process waiting for the lock", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  service.open("r1");
  const other = service.open("other-r");
  save(config, { refreshToken: "r1" });
  let other2: string | undefined;
  const process1 = service.fetchWith(async (path, body) => {
    if (path === "/auth/refresh" && body.refreshToken === "r1") {
      // Another process signed this computer in again meanwhile, with an access token nearly used up.
      save(config, { refreshToken: "other-r", accessToken: "other-a", accessExpiresAt: service.now() + 30_000, signedInAt: 2 });
    }
    if (path === "/auth/sign-out" && body.onlyIfCurrent === true) {
      // The clean-up isn't answered until that process has renewed, which takes the lock.
      other2 = await usableToken(env, service);
    }
  });
  await expect(accessTokenFor(SITE, { backendUrl: TEAM, env, fetchFn: process1, now: service.now })).rejects.toThrow("changed while renewing");
  expect(other2).not.toStartWith("error");
  expect(service.live(other)).toBe(true);
  expect(service.requests.filter((request) => request.path === "/auth/sign-out").map((request) => request.body)).toEqual([
    { refreshToken: service.requests[0]!.body.nextRefreshToken, onlyIfCurrent: true },
  ]);
  expect(read(config).recovered).toBeUndefined();
}, 30_000);

test("a sign-out keeps the lock only while it ends the saved sign-in, so another process isn't kept waiting by the sessions kept aside", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  service.open("r1");
  const spares = [service.open("spare-1"), service.open("spare-2")];
  save(config, { refreshToken: "r1", nextRefreshToken: "n1" }, {
    recovered: ["spare-1", "spare-2"].map((refreshToken) => ({ signInUrl: SITE, origin: SITE, refreshToken })),
  });
  const reached = new Set<string>();
  let together = false;
  let waiting: string | undefined;
  const slow = service.fetchWith(async (path, body) => {
    if (path !== "/auth/sign-out") return;
    reached.add(String(body.refreshToken));
    if (body.refreshToken === "r1") {
      // The saved token and its saved replacement are ended at once, not one long request after the other.
      const deadline = Date.now() + 1000;
      while (!reached.has("n1") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      together = reached.has("n1");
    }
    // A slow answer for a session kept aside: another process wants the lock meanwhile.
    if (body.refreshToken === "spare-1") waiting = await usableToken(env, service);
  });
  const printed: string[] = [];
  expect(await runCli(["sign-out", "--backend", TEAM], { print: (line) => void printed.push(line), env, fetchFn: slow })).toBe(0);
  expect(printed).toEqual(["Signed out Dana."]);
  expect(together).toBe(true);
  expect(waiting).toStartWith("error: This computer isn't signed in to Critiqs.");
  expect(spares.map((id) => service.live(id))).toEqual([false, false]);
  expect(read(config).recovered).toBeUndefined();
}, 30_000);

test("a session another process keeps aside while sign-out runs is reported as left, not a clean sign-out", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  const session = service.open("r1");
  const kept = service.open("kept-meanwhile");
  save(config, { refreshToken: "r1" });
  const crossing = service.fetchWith((path) => {
    if (path !== "/auth/sign-out") return;
    // Sign-out is suspended long enough to lose the lock; another process loses a renewal race and keeps its session aside.
    const stored = read(config);
    writeFileSync(signInFile(config), JSON.stringify({ ...stored, recovered: [{ signInUrl: SITE, origin: SITE, refreshToken: "kept-meanwhile" }] }));
  });
  const printed: string[] = [];
  const signOut = (fetchFn: typeof fetch) => runCli(["sign-out", "--backend", TEAM], { print: (line) => void printed.push(line), env, fetchFn });
  expect(await signOut(crossing)).toBe(1);
  expect(printed.at(-1)).toBe(
    `Signed out Dana, but Critiqs's sign-in service at ${SITE} didn't confirm ending an earlier session from this computer, so it stays saved here. Sign out again when it's reachable.`,
  );
  expect(service.live(session)).toBe(false);
  expect(read(config).recovered).toEqual([{ signInUrl: SITE, origin: SITE, refreshToken: "kept-meanwhile" }]);

  expect(await signOut(service.fetchFn)).toBe(0);
  expect(service.live(kept)).toBe(false);
  expect(read(config).recovered).toBeUndefined();
});

test("a sign-out the service had no session for, with a session kept aside it didn't confirm, says it forgot the sign-in", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const service = signInService();
  // The saved token was already ended elsewhere; the session kept aside is live but the service doesn't answer for it.
  save(config, { refreshToken: "gone" }, { recovered: [{ signInUrl: SITE, origin: SITE, refreshToken: "spare" }] });
  service.open("spare");
  const offline = (async (url: string, init?: RequestInit) => {
    if (JSON.parse(String(init?.body ?? "{}")).refreshToken === "spare") throw new TypeError("The request timed out.");
    return service.fetchFn(url, init);
  }) as unknown as typeof fetch;
  const printed: string[] = [];
  expect(await runCli(["sign-out", "--backend", TEAM], { print: (line) => void printed.push(line), env, fetchFn: offline })).toBe(1);
  expect(printed).toEqual([
    `Forgot this computer's sign-in Dana, but Critiqs's sign-in service at ${SITE} didn't confirm ending an earlier session from this computer, so it stays saved here. Sign out again when it's reachable.`,
  ]);
});
