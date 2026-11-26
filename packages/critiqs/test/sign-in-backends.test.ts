import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessTokenFor, beginSignIn, listComments, readMockup, readScreenshot, signInStatus, signOutComputer } from "../bin/agent.mjs";
import { runCli } from "../bin/cli.mjs";
import { createTools } from "../bin/mcp.mjs";
import { callConvex, openBrowser, requireSecureTokenTarget, signOut, startRemoteSignIn } from "../bin/setup.mjs";

// A sign-in kept on this computer goes only to the backends it was approved
// for, and to where each serves screenshots and page copies, compared by
// origin (scheme, host, and port), whichever sign-in service a backend names.

const CLOUD = "https://brazen-snail-591.convex.cloud";
const CLOUD_SIGN_IN = "https://brazen-snail-591.convex.site";
const TEAM = "https://team.convex.cloud";
const TEAM_SITE = "https://team.convex.site";
const binding = (backend: string, site: string) => ({ backend, site });

const folders: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }));
  servers.splice(0).forEach((server) => server.close());
});
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "critiqs-sign-in-backends-"));
  folders.push(made);
  return made;
};

/** A token-shaped string with these claims; only the command line reads it here. */
const token = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/**
 * Backends by their site origin, each naming a sign-in service; records every
 * request and the Authorization header it carried. Sign-in services repeat the
 * `backend` and `site` they are asked to show, unless `echo` is false (an
 * older service) or names what they show instead.
 */
function network(
  signInUrls: Record<string, string>,
  approve: Record<string, unknown> = {},
  { echo = true }: { echo?: boolean | { backend: string | null; site: string | null } } = {},
) {
  const requests: { url: string; authorization: string | null; body: string }[] = [];
  // Named again with the tokens, unless `approve` says otherwise.
  let shown: Record<string, unknown> = {};
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const { origin, pathname } = new URL(url);
    requests.push({ url, authorization: new Headers(init.headers).get("Authorization"), body: String(init.body ?? "") });
    if (pathname === "/critiqs/config" && signInUrls[origin] !== undefined) {
      return Response.json({ protocol: 5, signInUrl: signInUrls[origin], deviceSignIn: true, deviceSessions: true });
    }
    if (pathname === "/api/query") {
      const { path } = JSON.parse(String(init.body));
      if (path === "projects:get") return Response.json({ status: "success", value: { name: "Pilot", reviewUrl: null } });
      if (path === "threads:list") return Response.json({ status: "success", value: { page: [], isDone: true, continueCursor: "" } });
    }
    if (pathname === "/auth/refresh") return Response.json({ accessToken: token({ sub: "dana" }), refreshToken: "r2", expiresAt: Date.now() + 900_000 });
    if (pathname === "/auth/sign-out") return new Response(null, { status: 204 });
    if (pathname === "/auth/device/start") {
      const asked = JSON.parse(String(init.body));
      shown = echo === true ? { backend: asked.backend ?? null, site: asked.site ?? null } : echo === false ? {} : echo;
      return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: `${origin}/auth/device`, expiresIn: 600, interval: 1, ...shown });
    }
    if (pathname === "/auth/device/token") return Response.json({ ...shown, ...approve });
    throw new Error(`Unexpected ${url}`);
  }) as unknown as typeof fetch;
  const withToken = () => requests.filter((request) => request.authorization !== null);
  return { fetchFn, requests, withToken };
}

function save(config: string, services: Record<string, Record<string, unknown>>, version = 2) {
  const filled = Object.fromEntries(
    Object.entries(services).map(([signInUrl, entry]) => [
      signInUrl,
      { origin: signInUrl, refreshToken: "r1", accessToken: "a1", accessExpiresAt: Date.now() + 600_000, reviewer: { name: "Dana", email: "dana@example.com" }, ...entry },
    ]),
  );
  // Version 1 is what earlier versions write, to their own file.
  writeFileSync(join(config, version === 1 ? "sign-in.json" : "sign-in.v2.json"), JSON.stringify({ version, services: filled }));
}
const file = (config: string) => JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8"));
const legacyFile = (config: string) => JSON.parse(readFileSync(join(config, "sign-in.json"), "utf8"));
const saved = (config: string, signInUrl: string) => file(config).services[signInUrl];

/**
 * How versions before this one read their sign-in file (`readSignIns` in
 * bin/agent.mjs as released): anything but version 1 is no sign-in at all.
 */
function legacyRead(config: string): { version: number; services: Record<string, unknown> } {
  let stored: { version?: number; services?: Record<string, unknown> } | null = null;
  try {
    stored = legacyFile(config);
  } catch {}
  return stored?.version === 1 && typeof stored.services === "object" && stored.services !== null ? { version: 1, services: stored.services } : { version: 1, services: {} };
}

test("a saved sign-in isn't sent to a backend it wasn't approved for, even one naming the same sign-in service", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  // Expired, so using it would mean renewing it first.
  save(config, { [TEAM_SITE]: { bindings: [binding(TEAM, TEAM_SITE)], accessExpiresAt: 0 } });
  const others = {
    "https://critiqs-mirror.example": "https://critiqs-mirror.example",
    // The same host on another port is another backend.
    "https://team.convex.cloud:8443": "https://team.convex.site:8443",
  };
  const { fetchFn, requests, withToken } = network({ [TEAM_SITE]: TEAM_SITE, ...Object.fromEntries(Object.values(others).map((site) => [site, TEAM_SITE])) });
  for (const backend of Object.keys(others)) {
    const refused = listComments({ projectId: "p1", backend }, { env, fetchFn });
    await expect(refused).rejects.toThrow(`isn't approved for the backend at ${backend}, so nothing was sent to it`);
    await expect(listComments({ projectId: "p1", backend }, { env, fetchFn })).rejects.toThrow(`npx critiqs sign-in --backend '${backend}'`);
  }
  expect(withToken()).toEqual([]);
  expect(requests.some((request) => request.url.includes("/auth/refresh"))).toBe(false);
  expect(saved(config, TEAM_SITE)).toMatchObject({ refreshToken: "r1", bindings: [binding(TEAM, TEAM_SITE)] });
});

test("a saved sign-in is sent to the backend it was approved for, and only there", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  save(config, { [TEAM_SITE]: { bindings: [binding(TEAM, TEAM_SITE)] } });
  const { fetchFn, withToken } = network({ [TEAM_SITE]: TEAM_SITE });
  // Origins compare as browsers do: case and a trailing slash don't matter.
  for (const backend of [TEAM, "https://TEAM.convex.cloud/"]) {
    const result = await listComments({ projectId: "p1", backend }, { env, fetchFn });
    expect(result.project.name).toBe("Pilot");
  }
  expect(withToken().length).toBeGreaterThan(0);
  for (const request of withToken()) {
    expect(new URL(request.url).origin).toBe(TEAM);
    expect(request.authorization).toBe("Bearer a1");
  }
});

test("a version 1 sign-in file moves to its own version 2 file once, keeping only a Critiqs Cloud sign-in from Critiqs Cloud, and is left signed out", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  // `backends` in a version 1 file is ignored: no released version wrote it.
  save(config, { [CLOUD_SIGN_IN]: { accessExpiresAt: 0 }, [TEAM_SITE]: { backends: [TEAM] } }, 1);
  expect(Object.keys(legacyRead(config).services)).toHaveLength(2);
  const { fetchFn, withToken } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN, "https://own.convex.site": CLOUD_SIGN_IN, [TEAM_SITE]: TEAM_SITE });

  // From Critiqs Cloud's sign-in service: Critiqs Cloud only.
  expect((await listComments({ projectId: "p1", backend: CLOUD }, { env, fetchFn })).project.name).toBe("Pilot");
  expect(file(config).version).toBe(2);
  expect(saved(config, CLOUD_SIGN_IN)).toMatchObject({ refreshToken: "r2", bindings: [binding(CLOUD, CLOUD_SIGN_IN)] });
  await expect(listComments({ projectId: "p1", backend: "https://own.convex.cloud" }, { env, fetchFn })).rejects.toThrow(
    "isn't approved for the backend at https://own.convex.cloud",
  );
  // From any other sign-in service: a fresh sign-in, even for that service's own backend. It is kept so signing out can end it.
  await expect(listComments({ projectId: "p1", backend: TEAM }, { env, fetchFn })).rejects.toThrow(`npx critiqs sign-in --backend '${TEAM}'`);
  expect(new Set(withToken().map((request) => new URL(request.url).origin))).toEqual(new Set([CLOUD]));
  expect(saved(config, TEAM_SITE)).toMatchObject({ refreshToken: "r1", bindings: [] });
  expect(saved(config, TEAM_SITE).backends).toBeUndefined();
  // The version 1 file is signed out, and still a file older versions read: they find no sign-in, so they can't send one anywhere.
  expect(legacyFile(config)).toEqual({ version: 1, services: {} });
});

test("only reading the sign-in, such as checking it, also moves a version 1 file", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  // Still fresh: nothing is renewed, and the old file would otherwise stay readable.
  save(config, { [CLOUD_SIGN_IN]: {}, [TEAM_SITE]: {} }, 1);
  const { fetchFn } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN, [TEAM_SITE]: TEAM_SITE });
  expect(await accessTokenFor(CLOUD_SIGN_IN, { backendUrl: CLOUD, env, fetchFn })).toBe("a1");
  expect(file(config).version).toBe(2);
  expect(legacyFile(config)).toEqual({ version: 1, services: {} });

  const other = folder();
  save(other, { [TEAM_SITE]: {} }, 1);
  const tools = createTools({ cwd: other, env: { CRITIQS_CONFIG_DIR: other }, fetchFn, open: () => {}, sleep: () => new Promise(() => {}) });
  try {
    await tools.call("critiqs_sign_in", { signIn: "remote", backend: TEAM });
  } finally {
    tools.close();
  }
  expect(file(other).version).toBe(2);
  expect(legacyFile(other)).toEqual({ version: 1, services: {} });
});

test("an older version that signs in again after the move can't undo it; only its Critiqs Cloud sign-in moves, when there is none", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, withToken } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN, [TEAM_SITE]: TEAM_SITE, "https://evil.convex.site": TEAM_SITE });
  save(config, { [TEAM_SITE]: { bindings: [binding(TEAM, TEAM_SITE)], accessToken: "team-token" } });
  // An older version signs in to Critiqs Cloud and to the team's service, writing only its own file.
  save(config, { [CLOUD_SIGN_IN]: { accessToken: "cloud-token" }, [TEAM_SITE]: { accessToken: "old-team-token", bindings: [binding("https://evil.convex.cloud", "https://evil.convex.site")] } }, 1);

  expect(await accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn })).toBe("team-token");
  // Its Critiqs Cloud sign-in moved, for Critiqs Cloud only; the rest stays with it, and approves nothing here.
  expect(saved(config, CLOUD_SIGN_IN)).toMatchObject({ accessToken: "cloud-token", bindings: [binding(CLOUD, CLOUD_SIGN_IN)] });
  expect(saved(config, TEAM_SITE)).toMatchObject({ accessToken: "team-token", bindings: [binding(TEAM, TEAM_SITE)] });
  expect(Object.keys(legacyFile(config).services)).toEqual([TEAM_SITE]);
  await expect(listComments({ projectId: "p1", backend: "https://evil.convex.cloud" }, { env, fetchFn })).rejects.toThrow("isn't approved for the backend at https://evil.convex.cloud");
  expect(withToken()).toEqual([]);

  // Once this file has a Critiqs Cloud sign-in, a later one from an older version is left where it is.
  save(config, { [CLOUD_SIGN_IN]: { accessToken: "newer-cloud-token", refreshToken: "newer-cloud-refresh", signedInAt: Date.now() } }, 1);
  expect(await accessTokenFor(CLOUD_SIGN_IN, { backendUrl: CLOUD, env, fetchFn })).toBe("cloud-token");
  expect(legacyFile(config).services[CLOUD_SIGN_IN]).toMatchObject({ accessToken: "newer-cloud-token" });

  // Signing out here leaves the older version's sign-in to it.
  expect(await signOutComputer({ backendUrl: TEAM, env, fetchFn })).toMatchObject({ found: true });
  expect(saved(config, TEAM_SITE)).toBeUndefined();
  expect(legacyFile(config).services[CLOUD_SIGN_IN]).toMatchObject({ accessToken: "newer-cloud-token" });
});

test("signing out of Critiqs Cloud also ends an older version's Critiqs Cloud sign-in, so the next command doesn't switch to it", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, requests } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN });
  save(config, { [CLOUD_SIGN_IN]: { refreshToken: "dana-r", bindings: [binding(CLOUD, CLOUD_SIGN_IN)], signedInAt: Date.now() - 1_000 } });
  // An older version signed in to Critiqs Cloud as someone else, after this file had a Critiqs Cloud sign-in.
  save(config, { [CLOUD_SIGN_IN]: { refreshToken: "sam-r", reviewer: { name: "Sam", email: "sam@example.com" }, signedInAt: Date.now() - 500 } }, 1);
  expect((await signInStatus({ backendUrl: CLOUD, env, fetchFn })).saved?.reviewer?.name).toBe("Dana");

  expect(await signOutComputer({ backendUrl: CLOUD, env, fetchFn })).toEqual({ reviewer: { name: "Dana", email: "dana@example.com" }, found: true });
  const ended = requests.filter((request) => request.url === `${CLOUD_SIGN_IN}/auth/sign-out`).map((request) => JSON.parse(request.body).refreshToken);
  expect(ended).toEqual(["dana-r", "sam-r"]);
  expect(legacyRead(config).services).toEqual({});
  expect((await signInStatus({ backendUrl: CLOUD, env, fetchFn })).saved).toBeNull();
  await expect(accessTokenFor(CLOUD_SIGN_IN, { backendUrl: CLOUD, env, fetchFn })).rejects.toThrow("isn't signed in");
});

test("an older version's Critiqs Cloud session the service doesn't confirm ending is kept aside, and the next sign-out ends it", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, requests } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN });
  let reachable = false;
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!reachable && String(input).endsWith("/auth/sign-out") && JSON.parse(String(init?.body)).refreshToken === "sam-r") throw new Error("offline");
    return fetchFn(input, init);
  }) as typeof fetch;
  save(config, { [CLOUD_SIGN_IN]: { refreshToken: "dana-r", bindings: [binding(CLOUD, CLOUD_SIGN_IN)], signedInAt: Date.now() - 1_000 } });
  save(config, { [CLOUD_SIGN_IN]: { refreshToken: "sam-r", reviewer: { name: "Sam", email: "sam@example.com" }, signedInAt: Date.now() - 500 } }, 1);
  await signInStatus({ backendUrl: CLOUD, env, fetchFn: flaky });

  // Signing out says so, rather than reporting a clean sign-out.
  await expect(signOutComputer({ backendUrl: CLOUD, env, fetchFn: flaky })).rejects.toThrow(
    `Signed out Dana, but Critiqs's sign-in service at ${CLOUD_SIGN_IN} didn't confirm ending an earlier session from this computer, so it stays saved here.`,
  );
  // Out of the older version's file, but its token is kept until the service confirms the session ended.
  expect(legacyRead(config).services).toEqual({});
  expect(file(config).recovered?.map((spare: { refreshToken: string }) => spare.refreshToken)).toEqual(["sam-r"]);

  reachable = true;
  await signOutComputer({ backendUrl: CLOUD, env, fetchFn: flaky });
  expect(requests.filter((request) => request.url === `${CLOUD_SIGN_IN}/auth/sign-out` && JSON.parse(request.body).refreshToken === "sam-r")).toHaveLength(1);
  expect(file(config).recovered).toBeUndefined();
});

test("the same Critiqs Cloud sign-in in both files keeps the copy renewed last, never a spent refresh token", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN });
  const signedInAt = Date.now() - 60_000;
  const cloud = (refreshToken: string, accessExpiresAt: number) => ({ refreshToken, accessToken: `${refreshToken}-a`, accessExpiresAt, signedInAt });
  // The older version renewed the session after it was copied here: its copy is the live one.
  writeFileSync(join(config, "sign-in.v2.json"), JSON.stringify({ version: 2, services: { [CLOUD_SIGN_IN]: { ...cloud("spent-r", Date.now() + 120_000), bindings: [binding(CLOUD, CLOUD_SIGN_IN)] } } }));
  save(config, { [CLOUD_SIGN_IN]: cloud("live-r", Date.now() + 600_000) }, 1);
  await signInStatus({ backendUrl: CLOUD, env, fetchFn });
  expect(file(config).services[CLOUD_SIGN_IN]).toMatchObject({ refreshToken: "live-r" });
  expect(legacyRead(config).services).toEqual({});

  // The other way round, the copy here was renewed last and stays.
  writeFileSync(join(config, "sign-in.v2.json"), JSON.stringify({ version: 2, services: { [CLOUD_SIGN_IN]: { ...cloud("live-r", Date.now() + 600_000), bindings: [binding(CLOUD, CLOUD_SIGN_IN)] } } }));
  save(config, { [CLOUD_SIGN_IN]: cloud("spent-r", Date.now() + 120_000) }, 1);
  await signInStatus({ backendUrl: CLOUD, env, fetchFn });
  expect(file(config).services[CLOUD_SIGN_IN]).toMatchObject({ refreshToken: "live-r" });
});

test("an older version's Critiqs Cloud sign-in moves in only if it was made after the last sign-out here", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN });
  const signedOutAt = Date.now() - 10_000;
  for (const [signedInAt, expected] of [
    [signedOutAt - 1_000, null],
    [undefined, null],
    [signedOutAt + 1_000, "Sam"],
  ] as const) {
    writeFileSync(join(config, "sign-in.v2.json"), JSON.stringify({ version: 2, services: {}, cloudSignedOutAt: signedOutAt }));
    save(config, { [CLOUD_SIGN_IN]: { reviewer: { name: "Sam", email: "sam@example.com" }, signedInAt } }, 1);
    expect((await signInStatus({ backendUrl: CLOUD, env, fetchFn })).saved?.reviewer?.name ?? null).toBe(expected);
  }
});

test("signing out also ends sessions kept aside by a renewal that lost the lock", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, requests } = network({ [TEAM_SITE]: TEAM_SITE, [CLOUD_SIGN_IN]: CLOUD_SIGN_IN });
  const spare = (signInUrl: string, refreshToken: string) => ({ signInUrl, origin: signInUrl, refreshToken });
  writeFileSync(
    join(config, "sign-in.v2.json"),
    JSON.stringify({
      version: 2,
      services: { [TEAM_SITE]: { origin: TEAM_SITE, refreshToken: "team-r", accessToken: "a1", accessExpiresAt: Date.now() + 600_000, bindings: [binding(TEAM, TEAM_SITE)] } },
      recovered: [spare(TEAM_SITE, "team-spare"), spare(CLOUD_SIGN_IN, "cloud-spare")],
    }),
  );
  expect(await signOutComputer({ backendUrl: TEAM, env, fetchFn })).toMatchObject({ found: true });
  const ended = requests.filter((request) => request.url.endsWith("/auth/sign-out")).map((request) => [new URL(request.url).origin, JSON.parse(request.body).refreshToken]);
  expect(ended).toEqual([
    [TEAM_SITE, "team-r"],
    [TEAM_SITE, "team-spare"],
  ]);
  expect(file(config).services).toEqual({});
  expect(file(config).recovered).toEqual([spare(CLOUD_SIGN_IN, "cloud-spare")]);
});

test("signing out ends the saved token, a saved replacement and every spare, and keeps a spare the service didn't confirm", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, requests } = network({ [TEAM_SITE]: TEAM_SITE, [CLOUD_SIGN_IN]: CLOUD_SIGN_IN });
  let reachable = false;
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!reachable && String(input).endsWith("/auth/sign-out") && JSON.parse(String(init?.body)).refreshToken === "team-spare-2") throw new Error("offline");
    return fetchFn(input, init);
  }) as typeof fetch;
  const spare = (signInUrl: string, refreshToken: string) => ({ signInUrl, origin: signInUrl, refreshToken });
  writeFileSync(
    join(config, "sign-in.v2.json"),
    JSON.stringify({
      version: 2,
      // A renewal whose answer was lost left its replacement saved, and two renewals that lost a race left spares.
      services: { [TEAM_SITE]: { origin: TEAM_SITE, refreshToken: "team-r", nextRefreshToken: "team-n", accessToken: "a1", accessExpiresAt: 0, bindings: [binding(TEAM, TEAM_SITE)] } },
      recovered: [spare(TEAM_SITE, "team-spare-1"), spare(TEAM_SITE, "team-spare-2"), spare(CLOUD_SIGN_IN, "cloud-spare")],
    }),
  );
  const endedTokens = () => requests.filter((request) => request.url.endsWith("/auth/sign-out")).map((request) => [new URL(request.url).origin, JSON.parse(request.body)]);
  await expect(signOutComputer({ backendUrl: TEAM, env, fetchFn: flaky })).rejects.toThrow(
    `Signed out, but Critiqs's sign-in service at ${TEAM_SITE} didn't confirm ending an earlier session from this computer, so it stays saved here. Sign out again when it's reachable.`,
  );
  expect(endedTokens()).toEqual([
    [TEAM_SITE, { refreshToken: "team-r" }],
    [TEAM_SITE, { refreshToken: "team-n" }],
    [TEAM_SITE, { refreshToken: "team-spare-1" }],
  ]);
  expect(file(config).services).toEqual({});
  expect(file(config).recovered).toEqual([spare(TEAM_SITE, "team-spare-2"), spare(CLOUD_SIGN_IN, "cloud-spare")]);

  // The next sign-out ends the one left, though this computer is already signed out.
  reachable = true;
  expect(await signOutComputer({ backendUrl: TEAM, env, fetchFn: flaky })).toBeNull();
  expect(endedTokens().at(-1)).toEqual([TEAM_SITE, { refreshToken: "team-spare-2" }]);
  expect(file(config).recovered).toEqual([spare(CLOUD_SIGN_IN, "cloud-spare")]);
});

test("a lost renewal is sent again with the same replacement once another process lets go of the lock, and only for an approved backend", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, requests } = network({ [TEAM_SITE]: TEAM_SITE });
  save(config, { [TEAM_SITE]: { accessExpiresAt: 0, bindings: [binding(TEAM, TEAM_SITE)] } });
  let lose = true;
  const losing = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchFn(input, init);
    if (lose && String(input).endsWith("/auth/refresh")) throw new TypeError("The answer never arrived.");
    return response;
  }) as typeof fetch;
  await expect(accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn: losing })).rejects.toThrow("Can't reach");
  const pending = saved(config, TEAM_SITE).nextRefreshToken;
  expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(saved(config, TEAM_SITE)).toMatchObject({ refreshToken: "r1", bindings: [binding(TEAM, TEAM_SITE)] });

  // The saved replacement goes nowhere the sign-in wasn't approved for.
  const before = requests.length;
  await expect(accessTokenFor(TEAM_SITE, { backendUrl: "https://other.convex.cloud", env, fetchFn })).rejects.toThrow("isn't approved for the backend at https://other.convex.cloud");
  expect(requests.length).toBe(before);

  // Another process holds the lock (its heartbeat is fresh), so this one waits, then sends the same pair.
  const lock = join(config, "sign-in.v2.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "another-process");
  setTimeout(() => rmSync(lock, { recursive: true, force: true }), 300);
  lose = false;
  const started = Date.now();
  expect(await accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn: losing })).toBe(token({ sub: "dana" }));
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  const refreshes = requests.filter((request) => request.url.endsWith("/auth/refresh")).map((request) => JSON.parse(request.body));
  expect(refreshes).toEqual([
    { refreshToken: "r1", nextRefreshToken: pending },
    { refreshToken: "r1", nextRefreshToken: pending },
  ]);
  // The replacement was used: saved as the refresh token, and no longer pending; the approval is kept.
  expect(saved(config, TEAM_SITE)).toMatchObject({ refreshToken: "r2", bindings: [binding(TEAM, TEAM_SITE)] });
  expect(saved(config, TEAM_SITE).nextRefreshToken).toBeUndefined();
});

test("a renewal that lost a race to a new sign-in keeps its session aside when the clean-up isn't answered, and signing out ends it", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, requests } = network({ [TEAM_SITE]: TEAM_SITE });
  save(config, { [TEAM_SITE]: { accessExpiresAt: 0, bindings: [binding(TEAM, TEAM_SITE)] } });
  let offline = true;
  const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/auth/refresh")) {
      // While this renewal was on its way, another process signed this computer in again.
      save(config, { [TEAM_SITE]: { refreshToken: "other-r", accessToken: "other-a", bindings: [binding(TEAM, TEAM_SITE)] } });
    }
    if (offline && String(input).endsWith("/auth/sign-out")) {
      requests.push({ url: String(input), authorization: null, body: String(init?.body) });
      throw new TypeError("offline");
    }
    return fetchFn(input, init);
  }) as typeof fetch;
  expect(await accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn: racing })).toBe("other-a");
  const signOuts = () => requests.filter((request) => request.url.endsWith("/auth/sign-out")).map((request) => JSON.parse(request.body));
  // It tried to end the renewed session, only while current; unanswered, it is kept aside rather than dropped.
  expect(signOuts()).toEqual([{ refreshToken: "r2", onlyIfCurrent: true }]);
  expect(file(config).recovered).toEqual([{ signInUrl: TEAM_SITE, origin: TEAM_SITE, refreshToken: "r2" }]);
  expect(saved(config, TEAM_SITE)).toMatchObject({ refreshToken: "other-r" });

  offline = false;
  expect(await signOutComputer({ backendUrl: TEAM, env, fetchFn: racing })).toMatchObject({ found: true });
  expect(signOuts().slice(1)).toEqual([{ refreshToken: "other-r" }, { refreshToken: "r2" }]);
  expect(file(config).services).toEqual({});
  expect(file(config).recovered).toBeUndefined();
});

test("signing in for another backend adds it for the same person, and starts over for someone else", async () => {
  for (const [subject, expected] of [
    ["dana", [binding(CLOUD, CLOUD_SIGN_IN), binding("https://own.convex.cloud", "https://own.convex.site")]],
    ["sam", [binding("https://own.convex.cloud", "https://own.convex.site")]],
  ] as const) {
    const config = folder();
    const env = { CRITIQS_CONFIG_DIR: config };
    save(config, { [CLOUD_SIGN_IN]: { accessToken: token({ sub: "dana" }), bindings: [binding(CLOUD, CLOUD_SIGN_IN)] } });
    const approval = { accessToken: token({ sub: subject }), refreshToken: "r9", expiresAt: Date.now() + 900_000, reviewer: { name: subject, email: `${subject}@example.com` } };
    const { fetchFn, requests } = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN, "https://own.convex.site": CLOUD_SIGN_IN }, approval);
    const pending = await beginSignIn({ backendUrl: "https://own.convex.cloud", method: "remote", env, fetchFn, sleep: async () => {} });
    expect(requests.find((request) => request.url.endsWith("/auth/device/start"))?.body).toBe(
      '{"keepSignedIn":true,"backend":"https://own.convex.cloud","site":"https://own.convex.site"}',
    );
    const finished = await pending.finish();
    expect(finished.bindings).toEqual([...expected]);
    expect(file(config).version).toBe(2);
    expect(saved(config, CLOUD_SIGN_IN)).toMatchObject({ refreshToken: "r9", bindings: [...expected] });
    expect(legacyRead(config).services).toEqual({});
  }
});

test("a sign-in travels over plain http only to localhost and literal loopback addresses", async () => {
  for (const url of ["https://team.example", "http://localhost:3210", "http://LOCALHOST:3210", "http://127.0.0.1:3210", "http://127.4.5.6", "http://[::1]:3210"]) {
    expect(() => requireSecureTokenTarget(url)).not.toThrow();
  }
  for (const url of [
    "http://team.example",
    "http://192.168.1.20:3210",
    // Names resolved by DNS or the hosts file, even under .localhost.
    "http://app.localhost:3210",
    "http://localhost.:3210",
    "http://localhost.team.example",
    "http://127.0.0.1.team.example",
    "http://[::ffff:127.0.0.1]",
    "ftp://localhost",
  ]) {
    expect(() => requireSecureTokenTarget(url)).toThrow("doesn't use HTTPS, so Critiqs won't send a sign-in to it");
  }

  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const plain = "http://team.example:3210";
  const local = (origin: string) => binding(origin, origin.replace(/3210$/, "3211"));
  save(config, { [TEAM_SITE]: { bindings: ["http://app.localhost:3210", plain, "http://127.0.0.1:3210", "http://localhost:3210"].map(local) } });
  const { fetchFn, requests, withToken } = network({
    [TEAM_SITE]: TEAM_SITE,
    "http://team.example:3211": TEAM_SITE,
    "http://app.localhost:3211": TEAM_SITE,
    "http://127.0.0.1:3211": TEAM_SITE,
    "http://localhost:3211": TEAM_SITE,
  });
  // Even a binding that names it doesn't send a token over plain http elsewhere.
  await expect(listComments({ projectId: "p1", backend: plain }, { env, fetchFn })).rejects.toThrow("http://team.example:3210 doesn't use HTTPS");
  await expect(listComments({ projectId: "p1", backend: "http://app.localhost:3210" }, { env, fetchFn })).rejects.toThrow("doesn't use HTTPS");
  await expect(callConvex(plain, "query", "projects:get", {}, "a1", { fetchFn })).rejects.toThrow("doesn't use HTTPS");
  // Nor does signing in for it get as far as an approval.
  await expect(beginSignIn({ backendUrl: plain, method: "remote", env, fetchFn })).rejects.toThrow("doesn't use HTTPS");
  expect(requests.some((request) => request.url.includes("/auth/device/start"))).toBe(false);
  expect(withToken()).toEqual([]);

  for (const backend of ["http://127.0.0.1:3210", "http://localhost:3210"]) {
    expect((await listComments({ projectId: "p1", backend }, { env, fetchFn })).project.name).toBe("Pilot");
  }
  expect(new Set(withToken().map((request) => new URL(request.url).origin))).toEqual(new Set(["http://127.0.0.1:3210", "http://localhost:3210"]));
});

test("the MCP tools refuse a backend the sign-in wasn't approved for as a tool error, and signing in for it asks for approval", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  save(config, { [TEAM_SITE]: { bindings: [binding(TEAM, TEAM_SITE)] } });
  const mirror = "https://critiqs-mirror.example";
  const { fetchFn, requests, withToken } = network({ [TEAM_SITE]: TEAM_SITE, [mirror]: TEAM_SITE });
  const tools = createTools({ cwd: config, env, fetchFn, open: () => {}, sleep: () => new Promise(() => {}) });
  try {
    for (const [name, args] of [
      ["critiqs_comments", { projectId: "p1", backend: mirror }],
      ["critiqs_thread", { thread: "t1", backend: mirror }],
      ["critiqs_reply", { thread: "t1", body: "Fixed", backend: mirror }],
    ] as const) {
      const result = await tools.call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`isn't approved for the backend at ${mirror}`);
      expect(result.content[0]!.text).toContain(`npx critiqs sign-in --backend '${mirror}'`);
    }
    expect(withToken()).toEqual([]);

    // Signed in elsewhere isn't signed in here: the approval names this backend.
    const started = await tools.call("critiqs_sign_in", { signIn: "remote", backend: mirror });
    expect(started.isError).toBeUndefined();
    expect(started.content[0]!.text).toContain("enter the code BCDF-GHJK");
    expect(requests.find((request) => request.url.endsWith("/auth/device/start"))?.body).toBe(`{"keepSignedIn":true,"backend":"${mirror}","site":"${mirror}"}`);
    // For the backend it was approved for, it is already signed in.
    expect((await tools.call("critiqs_sign_in", { backend: TEAM })).content[0]!.text).toContain(`already signed in to Critiqs as Dana (dana@example.com) for ${TEAM}`);
  } finally {
    tools.close();
  }
});

// ---------------------------------------------------------------------------
// Redirects: a 307 or 308 repeats the request, body and all, to another address.

type Seen = { method: string; url: string; authorization: string | null; body: string };

async function listen(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void, port = 0) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => handler(request, response, body));
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * A backend on this computer whose credential-bearing addresses redirect with
 * `status` to `target`, which records anything that reaches it. The backend's
 * site is the next port, as `siteUrlOf` pairs them.
 */
async function redirecting(status: 307 | 308) {
  const reached: Seen[] = [];
  const target = await listen((request, response, body) => {
    reached.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization ?? null, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"success","value":null,"accessToken":"stolen","refreshToken":"stolen"}');
  });
  const answer = (backend: string) => (request: IncomingMessage, response: ServerResponse, body: string) => {
    const { pathname } = new URL(request.url!, backend);
    const json = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (pathname === "/critiqs/config") return json({ protocol: 5, signInUrl: site, deviceSignIn: true, deviceSessions: true, mockups: true });
    if (pathname === "/auth/device/start") {
      return json({ deviceCode: "device-secret", userCode: "BCDF-GHJK", verificationUrl: `${site}/auth/device`, expiresIn: 600, interval: 1, ...JSON.parse(body) });
    }
    if (pathname === "/api/query") {
      // Queries answer, so a download is what gets redirected.
      const { path } = JSON.parse(body);
      if (path === "threads:get") return json({ status: "success", value: { capture: { status: "captured" }, anchor: { evidence: {} }, page: [], isDone: true } });
      if (path === "mockups:get") return json({ status: "success", value: MOCKUP });
      if (path === "projects:get") return json({ status: "success", value: { name: "Pilot", reviewUrl: null } });
      if (path === "mockups:threads") return json({ status: "success", value: [] });
      if (path === "threads:redirect") return redirect();
    }
    redirect();
    function redirect() {
      response.writeHead(status, { Location: `${target}${request.url}` });
      response.end();
    }
  };
  // The backend and its site on neighboring ports; another process may hold the next one.
  let backend = "";
  let site = "";
  for (let attempt = 0; ; attempt++) {
    const handler = (request: IncomingMessage, response: ServerResponse, body: string) => answer(backend)(request, response, body);
    backend = await listen(handler);
    try {
      site = await listen(handler, Number(new URL(backend).port) + 1);
      break;
    } catch (error) {
      servers.pop()!.close();
      if (attempt > 5) throw error;
    }
  }
  return { backend, site, reached };
}

const MOCKUP = {
  _id: "m1",
  projectId: "p1",
  title: "Settings",
  source: { url: "https://proto.example", screen: "home", viewState: {}, revision: null, persona: null },
  createdAt: 1,
  updatedAt: 1,
  createdByName: "Dana",
  versionCount: 0,
  threadCount: 0,
  threads: [],
  snapshots: [{ _id: "s1", width: 1440, height: 900, capturedAt: 1, createdByName: "Dana" }],
  linkedThreadIds: [],
  versions: [],
};

/**
 * The runtime's own fetch: the test preload's DOM replaces the global one,
 * which ignores `redirect`, and its `AbortSignal`, which the runtime's refuses,
 * so request time limits are left out here.
 */
const fetchFn = ((url: string, init: RequestInit = {}) => Bun.fetch(url, { ...init, signal: undefined })) as unknown as typeof fetch;

for (const status of [307, 308] as const) {
  test(`a ${status} redirect is refused wherever a sign-in is sent, and the sign-in never reaches where it points`, async () => {
    const { backend, site, reached } = await redirecting(status);
    const config = folder();
    const env = { CRITIQS_CONFIG_DIR: config };
    const refused = `${site} answered with a redirect, so Critiqs didn't follow it or send the sign-in anywhere else`;

    // Renewing a session sends its refresh token to the sign-in service.
    save(config, { [site]: { bindings: [binding(backend, site)], accessExpiresAt: 0, refreshToken: "refresh-secret" } });
    await expect(accessTokenFor(site, { backendUrl: backend, env, fetchFn })).rejects.toThrow(refused);
    expect(saved(config, site)).toMatchObject({ refreshToken: "refresh-secret" });

    // Signing out sends it too, and the computer stays signed in.
    await expect(signOutComputer({ backendUrl: backend, env, fetchFn })).rejects.toThrow(refused);
    expect(saved(config, site)).toMatchObject({ refreshToken: "refresh-secret" });

    // Setup's clean-up is best effort, but follows no redirect either.
    await signOut(site, "setup-refresh-secret", { origin: site, fetchFn });

    // Calls to the backend carry the access token.
    await expect(callConvex(backend, "query", "threads:redirect", {}, "access-secret", { fetchFn })).rejects.toThrow(
      `${backend} answered with a redirect, so Critiqs didn't follow it`,
    );

    // So do screenshots and page copies, from the site.
    save(config, { [site]: { bindings: [binding(backend, site)], accessToken: "access-secret" } });
    await expect(readScreenshot({ thread: "t1", backend }, { env, fetchFn, cwd: config })).rejects.toThrow(refused);
    await expect(readMockup({ mockup: "m1", backend, saveCopies: "copies" }, { env, fetchFn, cwd: config })).rejects.toThrow(refused);

    // Waiting for approval sends the device secret.
    const approval = await startRemoteSignIn({ signInUrl: site, backendUrl: backend, fetchFn, sleep: async () => {} });
    await expect(approval.tokens).rejects.toThrow(refused);

    expect(reached).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Where screenshots and page copies come from

test("screenshots and page copies go only to the download address the sign-in was approved for", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  const custom = "https://team.example:8443";
  const derived = "https://team.example:8444";
  // Approved for the backend, but with its downloads somewhere else.
  save(config, { [TEAM_SITE]: { bindings: [binding(custom, "https://team.example:9000")] } });
  const { fetchFn, withToken } = network({ [derived]: TEAM_SITE, [TEAM_SITE]: TEAM_SITE });
  await expect(readScreenshot({ thread: "t1", backend: custom }, { env, fetchFn, cwd: config })).rejects.toThrow(
    `approved for the backend at ${custom} with screenshots and page copies from https://team.example:9000, not ${derived}, so nothing was sent`,
  );
  await expect(listComments({ projectId: "p1", backend: custom }, { env, fetchFn })).rejects.toThrow("so nothing was sent");
  expect(withToken()).toEqual([]);

  // Approved for both: both get it.
  save(config, { [TEAM_SITE]: { bindings: [binding(custom, derived)] } });
  expect((await listComments({ projectId: "p1", backend: custom }, { env, fetchFn })).project.name).toBe("Pilot");
  expect(new Set(withToken().map((request) => new URL(request.url).origin))).toEqual(new Set([custom]));
});

test("signing in for a backend whose downloads aren't its Convex Cloud pair needs the approval page to name them", async () => {
  const custom = "https://team.example:8443";
  const derived = "https://team.example:8444";
  const approval = { accessToken: token({ sub: "dana" }), refreshToken: "r9", expiresAt: Date.now() + 900_000 };

  // A service that names the backend but not where its downloads come from is stopped before a code is shown.
  const partial = network({ [derived]: TEAM_SITE, [TEAM_SITE]: TEAM_SITE }, approval, { echo: { backend: custom, site: null } });
  await expect(beginSignIn({ backendUrl: custom, method: "remote", env: { CRITIQS_CONFIG_DIR: folder() }, fetchFn: partial.fetchFn })).rejects.toThrow(
    `didn't say clearly which addresses its approval page names, so this sign-in for ${custom} (screenshots and page copies from ${derived}) was stopped`,
  );

  // Named in full, it is approved for exactly those two origins.
  const config = folder();
  const full = network({ [derived]: TEAM_SITE, [TEAM_SITE]: TEAM_SITE }, approval);
  const pending = await beginSignIn({ backendUrl: custom, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: full.fetchFn, sleep: async () => {} });
  expect(full.requests.find((request) => request.url.endsWith("/auth/device/start"))?.body).toBe(`{"keepSignedIn":true,"backend":"${custom}","site":"${derived}"}`);
  expect(pending.binding).toEqual(binding(custom, derived));
  expect((await pending.finish()).bindings).toEqual([binding(custom, derived)]);

  // Even a Convex Cloud deployment's .convex.site pair must be named: a service that names one address of two is unclear.
  const pair = network({ [TEAM_SITE]: TEAM_SITE }, approval, { echo: { backend: TEAM, site: null } });
  await expect(beginSignIn({ backendUrl: TEAM, method: "remote", env: { CRITIQS_CONFIG_DIR: folder() }, fetchFn: pair.fetchFn })).rejects.toThrow(
    `didn't say clearly which addresses its approval page names, so this sign-in for ${TEAM} was stopped`,
  );
});

// ---------------------------------------------------------------------------
// The approval page must name the backend

test("an older sign-in service that doesn't confirm it names the backend can't add one, but Critiqs Cloud keeps working", async () => {
  const approval = { accessToken: token({ sub: "dana" }), refreshToken: "r9", expiresAt: Date.now() + 900_000 };

  // A team backend: stopped before anyone is shown a code to approve.
  const team = network({ [TEAM_SITE]: TEAM_SITE }, approval, { echo: false });
  const config = folder();
  await expect(beginSignIn({ backendUrl: TEAM, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: team.fetchFn })).rejects.toThrow(
    `Critiqs's sign-in service at ${TEAM_SITE} runs an older version that doesn't confirm its approval page names the backend, so this computer won't sign in through it for ${TEAM}`,
  );
  expect(team.requests.some((request) => request.url.endsWith("/auth/device/token"))).toBe(false);
  // Nor through Critiqs Cloud's sign-in service.
  const viaCloud = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN, [TEAM_SITE]: CLOUD_SIGN_IN }, approval, { echo: false });
  await expect(beginSignIn({ backendUrl: TEAM, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: viaCloud.fetchFn })).rejects.toThrow(
    "runs an older version that doesn't confirm",
  );
  expect(() => file(config)).toThrow();

  // Critiqs Cloud, from its own sign-in service, signs in as before.
  const cloud = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN }, approval, { echo: false });
  const pending = await beginSignIn({ backendUrl: CLOUD, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: cloud.fetchFn, sleep: async () => {} });
  expect((await pending.finish()).bindings).toEqual([binding(CLOUD, CLOUD_SIGN_IN)]);
});

test("a sign-in service that names another backend, at the start or with the tokens, doesn't add one", async () => {
  const approval = { accessToken: token({ sub: "dana" }), refreshToken: "r9", expiresAt: Date.now() + 900_000 };
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };

  const elsewhere = network({ [TEAM_SITE]: TEAM_SITE }, approval, { echo: { backend: "https://attacker.example", site: "https://attacker.example" } });
  await expect(beginSignIn({ backendUrl: TEAM, method: "remote", env, fetchFn: elsewhere.fetchFn })).rejects.toThrow(
    `names https://attacker.example (screenshots and page copies from https://attacker.example) on its approval page, not ${TEAM}, so this sign-in was stopped`,
  );
  // Even Critiqs Cloud's compatibility doesn't cover a service that names something else.
  const cloud = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN }, approval, { echo: { backend: TEAM, site: TEAM_SITE } });
  await expect(beginSignIn({ backendUrl: CLOUD, method: "remote", env, fetchFn: cloud.fetchFn })).rejects.toThrow(`names ${TEAM}`);

  // The grant names another backend than the one confirmed: the session is ended, not kept.
  const switched = network({ [TEAM_SITE]: TEAM_SITE }, { ...approval, backend: "https://attacker.example", site: "https://attacker.example" });
  const pending = await beginSignIn({ backendUrl: TEAM, method: "remote", env, fetchFn: switched.fetchFn, sleep: async () => {} });
  await expect(pending.finish()).rejects.toThrow("This computer didn't keep the sign-in.");
  expect(switched.requests.find((request) => request.url.endsWith("/auth/sign-out"))?.body).toBe('{"refreshToken":"r9"}');
  expect(() => file(config)).toThrow();

  // The grant names what was confirmed: kept.
  const same = network({ [TEAM_SITE]: TEAM_SITE }, { ...approval, backend: TEAM, site: TEAM_SITE });
  const kept = await beginSignIn({ backendUrl: TEAM, method: "remote", env, fetchFn: same.fetchFn, sleep: async () => {} });
  expect((await kept.finish()).bindings).toEqual([binding(TEAM, TEAM_SITE)]);
});

test("after a start that named the backend, the approval must name it again, exactly, or nothing is kept", async () => {
  const approval = { accessToken: token({ sub: "dana" }), refreshToken: "r9", expiresAt: Date.now() + 900_000 };
  for (const [granted, message] of [
    // Missing.
    [{ backend: null, site: null }, `named ${TEAM} when the approval started, but didn't confirm it with the approval`],
    // Partial.
    [{ backend: TEAM, site: null }, "didn't say clearly which addresses its approval page names"],
    [{ backend: null, site: TEAM_SITE }, "didn't say clearly which addresses its approval page names"],
    // Malformed.
    [{ backend: TEAM, site: "javascript:alert(1)" }, "didn't say clearly which addresses its approval page names"],
    [{ backend: `${TEAM}/path`, site: TEAM_SITE }, "didn't say clearly which addresses its approval page names"],
    [{ backend: 42, site: TEAM_SITE }, "didn't say clearly which addresses its approval page names"],
    // Conflicting.
    [{ backend: TEAM, site: "https://evil.convex.site" }, `names ${TEAM} (screenshots and page copies from https://evil.convex.site) on its approval page, not ${TEAM}`],
  ] as const) {
    const config = folder();
    const net = network({ [TEAM_SITE]: TEAM_SITE }, { ...approval, ...granted });
    const pending = await beginSignIn({ backendUrl: TEAM, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: net.fetchFn, sleep: async () => {} });
    expect(pending.confirmed).toBe(true);
    await expect(pending.finish()).rejects.toThrow(`${message}`);
    await expect(pending.finish()).rejects.toThrow("This computer didn't keep the sign-in.");
    // The session the approval started is ended, not kept.
    expect(net.requests.find((request) => request.url.endsWith("/auth/sign-out"))?.body).toBe('{"refreshToken":"r9"}');
    expect(() => file(config)).toThrow();
  }

  // The legacy Critiqs Cloud flow, whose start named nothing: nothing with the approval is fine; what it does name must match.
  for (const [granted, kept] of [
    [{}, true],
    [{ backend: CLOUD, site: CLOUD_SIGN_IN }, true],
    [{ backend: TEAM, site: TEAM_SITE }, false],
    [{ backend: CLOUD, site: null }, false],
  ] as const) {
    const config = folder();
    const net = network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN }, { ...approval, ...granted }, { echo: false });
    const pending = await beginSignIn({ backendUrl: CLOUD, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: net.fetchFn, sleep: async () => {} });
    expect(pending.confirmed).toBe(false);
    if (kept) expect((await pending.finish()).bindings).toEqual([binding(CLOUD, CLOUD_SIGN_IN)]);
    else await expect(pending.finish()).rejects.toThrow("This computer didn't keep the sign-in.");
  }
});

// ---------------------------------------------------------------------------
// Where the person is sent to approve

test("the approval address is the sign-in service's own page, whatever its answer suggests, and opens without a shell", async () => {
  const malicious = 'https://evil.example/" & calc.exe & "';
  const { fetchFn: base } = network({ [TEAM_SITE]: TEAM_SITE });
  const fetchFn = (async (url: string, init: RequestInit) => {
    const response = await base(url, init);
    if (!url.endsWith("/auth/device/start")) return response;
    return Response.json({ ...(await response.json()), verificationUrl: malicious, verification_uri_complete: malicious });
  }) as unknown as typeof fetch;

  const approval = await startRemoteSignIn({ signInUrl: TEAM_SITE, backendUrl: TEAM, fetchFn, sleep: () => new Promise(() => {}) });
  approval.close();
  expect(approval.url).toBe(`${TEAM_SITE}/auth/device`);
  const pending = await beginSignIn({ backendUrl: TEAM, method: "browser", env: { CRITIQS_CONFIG_DIR: folder() }, fetchFn, sleep: () => new Promise(() => {}) });
  pending.cancel();
  expect(pending.url).toBe(`${TEAM_SITE}/auth/device`);
  // The MCP server opens and shows only that page.
  const opened: string[] = [];
  const tools = createTools({ cwd: folder(), env: { CRITIQS_CONFIG_DIR: folder() }, fetchFn, open: (url: string) => void opened.push(url), sleep: () => new Promise(() => {}) });
  try {
    const started = await tools.call("critiqs_sign_in", { signIn: "browser", backend: TEAM });
    expect(started.content[0]!.text).not.toContain("evil.example");
  } finally {
    tools.close();
  }
  expect(opened).toEqual([`${TEAM_SITE}/auth/device`]);

  // The launcher gets the address as one argument, with no shell, on every platform.
  const launched: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const spawnFn = (command: string, args: string[], options: Record<string, unknown>) => {
    launched.push({ command, args, options });
    return { on: () => {}, unref: () => {} };
  };
  const address = "https://approve.example/auth/device?a=1&b=2|x^y";
  const href = new URL(address).href;
  for (const platform of ["win32", "darwin", "linux"]) openBrowser(address, { platform, env: { SystemRoot: "C:\\Windows" }, spawnFn });
  expect(launched.map(({ command, args, options }) => ({ command, args, shell: options.shell }))).toEqual([
    { command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", href], shell: false },
    { command: "open", args: [href], shell: false },
    { command: "xdg-open", args: [href], shell: false },
  ]);
  // Anything but a web address isn't opened at all.
  for (const other of ["file:///etc/passwd", "javascript:alert(1)", "calc.exe", "ms-settings:display", 'a.example/" & calc']) {
    openBrowser(other, { platform: "win32", spawnFn });
  }
  expect(launched).toHaveLength(3);
});

test("`critiqs sign-in` asks the person to check what the approval page can show", async () => {
  const approval = { accessToken: token({ sub: "dana" }), refreshToken: "r9", expiresAt: Date.now() + 900_000 };
  const signIn = async (args: string[], fetchFn: typeof fetch) => {
    const printed: string[] = [];
    const code = await runCli(["sign-in", "--remote", ...args], { print: (line) => void printed.push(line), env: { CRITIQS_CONFIG_DIR: folder() }, fetchFn, sleep: async () => {} });
    return { code, printed: printed.join("\n") };
  };
  // A current service names the backend on its page.
  const team = await signIn(["--backend", TEAM], network({ [TEAM_SITE]: TEAM_SITE }, approval).fetchFn);
  expect(team.code).toBe(0);
  expect(team.printed).toContain(`check that the page names ${TEAM}, and choose Approve`);
  // An older Critiqs Cloud service doesn't, so its own address is what to check.
  const cloud = await signIn([], network({ [CLOUD_SIGN_IN]: CLOUD_SIGN_IN }, approval, { echo: false }).fetchFn);
  expect(cloud.code).toBe(0);
  expect(cloud.printed).toContain(`check that the page's address starts with ${CLOUD_SIGN_IN}/, and choose Approve`);
  expect(cloud.printed).not.toContain("check that the page names");
});

// ---------------------------------------------------------------------------
// Suggested commands and renewals

test("the suggested sign-in command quotes the backend's origin for the shell", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  // Host names may hold shell syntax; URLs lower-case them.
  const backend = "https://a$(touch${IFS}pwned)'b;c&d`id`.example";
  const origin = new URL(backend).origin;
  expect(origin).toBe("https://a$(touch${ifs}pwned)'b;c&d`id`.example");
  save(config, { [TEAM_SITE]: { bindings: [binding(TEAM, TEAM_SITE)] } });
  const { fetchFn } = network({ [origin]: TEAM_SITE, [TEAM_SITE]: TEAM_SITE });
  let message = "";
  await listComments({ projectId: "p1", backend: `${backend}/?x=1` }, { env, fetchFn }).catch((error: Error) => (message = error.message));
  expect(message).toContain(`isn't approved for the backend at ${origin}, so nothing was sent to it`);
  // The origin alone, not the address given, in single quotes with each quote escaped.
  expect(message).not.toContain("?x=1");
  const command = /`npx critiqs sign-in --backend (.+?)`\. The approval page/.exec(message)?.[1];
  expect(command).toBe("'https://a$(touch${ifs}pwned)'\\''b;c&d`id`.example'");
  // A shell reads it back as exactly the origin, running nothing.
  expect(execFileSync("sh", ["-c", `printf %s ${command}`], { cwd: folder(), encoding: "utf8" })).toBe(origin);

  // Not signed in at all: the same.
  await expect(accessTokenFor(TEAM_SITE, { backendUrl: backend, env: { CRITIQS_CONFIG_DIR: folder() }, fetchFn })).rejects.toThrow(
    `for the Critiqs backend at ${origin}: call the critiqs_sign_in tool with backend ${JSON.stringify(origin)}, or run \`npx critiqs sign-in --backend ${command}\``,
  );
});

test("a session another process replaced during a refused renewal is held to the same approval", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  save(config, { [TEAM_SITE]: { bindings: [binding(TEAM, TEAM_SITE)], accessExpiresAt: 0 } });
  const { fetchFn: base } = network({ [TEAM_SITE]: TEAM_SITE });
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("/auth/refresh")) return base(url, init);
    // Meanwhile, another process signed in for another backend only.
    save(config, { [TEAM_SITE]: { bindings: [binding("https://other.convex.cloud", "https://other.convex.site")], refreshToken: "r2", accessToken: "other-token" } });
    return new Response("Signed out", { status: 401 });
  }) as unknown as typeof fetch;
  await expect(accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn })).rejects.toThrow(`isn't approved for the backend at ${TEAM}`);
});
