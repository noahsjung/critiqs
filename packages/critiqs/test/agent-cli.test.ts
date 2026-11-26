import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessTokenFor, beginSignIn, credentialsFile, legacyCredentialsFile, listMockups, MAX_INLINE_IMAGE_BYTES, parseTime, postReply, readFilters, readMockup, readScreenshot, signOutComputer, threadIdOf } from "../bin/agent.mjs";
import { findElements } from "../bin/markup.mjs";
import { parseCommand } from "../bin/cli.mjs";
import { createTools, TOOLS } from "../bin/mcp.mjs";
import { startRemoteSignIn } from "../bin/setup.mjs";

// Reading feedback from the command line: where the sign-in is kept, filters,
// links, and refusals. The end-to-end flow against the real backend is in
// packages/backend/test/agent-tools-contract.test.ts.

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "critiqs-agent-cli-"));
  folders.push(made);
  return made;
};

test("the sign-in is kept in the user's configuration folder, or where CRITIQS_CONFIG_DIR says", () => {
  expect(credentialsFile({ CRITIQS_CONFIG_DIR: "/secure/critiqs" })).toBe("/secure/critiqs/sign-in.v2.json");
  expect(credentialsFile({ XDG_CONFIG_HOME: "/home/dana/.config-x" }, "linux")).toBe("/home/dana/.config-x/critiqs/sign-in.v2.json");
  expect(credentialsFile({}, "darwin")).toEndWith("/.config/critiqs/sign-in.v2.json");
  // Beside the file versions before format 2 kept, which they may still write.
  expect(legacyCredentialsFile(credentialsFile({ CRITIQS_CONFIG_DIR: "/secure/critiqs" }))).toBe("/secure/critiqs/sign-in.json");
  expect(credentialsFile({ APPDATA: "C:\\Users\\Dana\\AppData\\Roaming" }, "win32")).toContain("critiqs");
});

test("a computer that never signed in is told how to sign in, without asking the network", async () => {
  const env = { CRITIQS_CONFIG_DIR: folder() };
  const fetchFn = (async () => {
    throw new Error("No request expected");
  }) as unknown as typeof fetch;
  await expect(accessTokenFor("https://auth.example", { backendUrl: "https://brazen-snail-591.convex.cloud", env, fetchFn })).rejects.toThrow(
    "critiqs_sign_in tool, or run `npx critiqs sign-in`",
  );
  await expect(accessTokenFor("https://auth.example", { backendUrl: "https://team.example", env, fetchFn })).rejects.toThrow(
    "run `npx critiqs sign-in --backend 'https://team.example'`",
  );
});

test("a lock left by a process that died is taken over, so renewal doesn't hang", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  writeFileSync(
    join(config, "sign-in.v2.json"),
    JSON.stringify({
      version: 2,
      services: {
        "https://auth.example": {
          origin: "https://auth.example",
          bindings: [{ backend: "https://team.example", site: "https://team.example" }],
          refreshToken: "r1",
          accessToken: "old",
          accessExpiresAt: 0,
        },
      },
    }),
  );
  const lock = join(config, "sign-in.v2.json.lock");
  writeFileSync(lock, "");
  const longAgo = new Date(Date.now() - 60_000);
  utimesSync(lock, longAgo, longAgo);
  const requests: { url: string; origin: string | null; body: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, origin: new Headers(init.headers).get("Origin"), body: String(init.body) });
    return Response.json({ accessToken: "new", refreshToken: "r2", expiresAt: Date.now() + 900_000 });
  }) as unknown as typeof fetch;
  expect(await accessTokenFor("https://auth.example", { backendUrl: "https://team.example", env, fetchFn })).toBe("new");
  expect(requests).toEqual([{ url: "https://auth.example/auth/refresh", origin: "https://auth.example", body: '{"refreshToken":"r1"}' }]);
  expect(JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services["https://auth.example"]).toMatchObject({ refreshToken: "r2", accessToken: "new" });
  expect(existsSync(lock)).toBe(false);
  // Fresh tokens are reused without asking again.
  expect(await accessTokenFor("https://auth.example", { backendUrl: "https://team.example", env, fetchFn })).toBe("new");
  expect(requests).toHaveLength(1);
});

test("a sign-in service that can't keep a computer signed in yet is refused clearly, before any code is shown", async () => {
  const started: string[] = [];
  const fetchFn = (async (url: string) => {
    if (url.endsWith("/critiqs/config")) return Response.json({ protocol: 5, signInUrl: "https://auth.example", deviceSignIn: true });
    started.push(url);
    return Response.json({});
  }) as unknown as typeof fetch;
  await expect(startRemoteSignIn({ signInUrl: "https://auth.example", backendUrl: "https://team.example", fetchFn, keepSignedIn: true })).rejects.toThrow(
    "runs an older version that can't keep this computer signed in with a code yet. Its operator needs to deploy the current Critiqs backend",
  );
  expect(started).toEqual([]);
});

test("times are dates, date-times, or ages; a date alone ends a range at the end of that day", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  expect(parseTime("2026-10-01", "since", now)).toBe(Date.parse("2026-10-01T00:00:00Z"));
  expect(parseTime("2026-10-01", "until", now, true)).toBe(Date.parse("2026-10-01T23:59:59.999Z"));
  expect(parseTime("2026-10-01T09:30:00+02:00", "since", now)).toBe(Date.parse("2026-10-01T07:30:00Z"));
  expect(parseTime("7d", "since", now)).toBe(now - 7 * 86_400_000);
  expect(parseTime("12h", "since", now)).toBe(now - 12 * 3_600_000);
  expect(parseTime("2w", "since", now)).toBe(now - 14 * 86_400_000);
  expect(parseTime("", "since", now)).toBeNull();
  expect(() => parseTime("yesterday", "since", now)).toThrow("since must be a date");
  expect(readFilters({}, now)).toEqual({ status: "open", since: null, until: null, limit: 50, author: null, tag: null, screen: null, text: null });
  expect(() => readFilters({ limit: 501 }, now)).toThrow("limit must be a whole number from 1 to 500");
});

test("threads are named by ID or by a Critiqs link to the thread or one of its messages", () => {
  expect(threadIdOf("k17abc")).toEqual({ threadId: "k17abc", messageId: null });
  expect(threadIdOf("https://planner.example/users/7?tab=roles&critiqs=k17abc.m22def#top")).toEqual({ threadId: "k17abc", messageId: "m22def" });
  expect(threadIdOf("http://localhost:5173/?critiqs=k17abc")).toEqual({ threadId: "k17abc", messageId: null });
  expect(() => threadIdOf("https://planner.example/users/7")).toThrow("no Critiqs thread");
  expect(() => threadIdOf("  ")).toThrow("Give a thread ID or a Critiqs link");
});

test("the command line signs a computer in and out, and the MCP server offers the reading tools", () => {
  expect(parseCommand(["sign-in"])).toMatchObject({ command: "sign-in", signIn: null, target: null });
  expect(parseCommand(["sign-in", "--remote", "--backend", "https://team.convex.cloud"])).toMatchObject({ signIn: "remote", target: "https://team.convex.cloud" });
  expect(parseCommand(["sign-out"])).toMatchObject({ command: "sign-out" });
  expect(parseCommand(["sign-in", "extra"])).toEqual({ error: "Unexpected argument extra." });
  const names = TOOLS.map((tool) => tool.name);
  for (const name of ["critiqs_comments", "critiqs_thread", "critiqs_screenshot", "critiqs_mockups", "critiqs_mockup", "critiqs_sign_in", "critiqs_sign_in_finish", "critiqs_sign_out"]) {
    expect(names).toContain(name);
  }
  const comments = TOOLS.find((tool) => tool.name === "critiqs_comments")!;
  expect((comments.inputSchema as { required: string[] }).required).toEqual(["projectId"]);
  expect(comments.annotations).toEqual({ readOnlyHint: true });
});

// A team backend whose sign-in service is itself, as the tools see it over HTTP.
const TEAM = "https://team.convex.cloud";
const TEAM_SITE = "https://team.convex.site";
/** What a current sign-in service says its approval page names for TEAM. */
const SHOWN = { backend: TEAM, site: TEAM_SITE };

function team(handle: (path: string, init: RequestInit) => Response | Promise<Response | undefined> | undefined) {
  const requests: { path: string; body: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const { pathname, search } = new URL(url);
    requests.push({ path: `${pathname}${search}`, body: String(init.body ?? "") });
    const answer = await handle(pathname, init);
    if (answer !== undefined) return answer;
    if (pathname === "/critiqs/config") return Response.json({ protocol: 5, signInUrl: TEAM_SITE, deviceSignIn: true, deviceSessions: true });
    throw new Error(`Unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function signedIn(config: string, entry: Record<string, unknown> = {}) {
  writeFileSync(
    join(config, "sign-in.v2.json"),
    JSON.stringify({ version: 2, services: { [TEAM_SITE]: { origin: TEAM_SITE, bindings: [{ backend: TEAM, site: TEAM_SITE }], refreshToken: "r1", accessToken: "a1", accessExpiresAt: Date.now() + 600_000, reviewer: { name: "Dana", email: "dana@example.com" }, ...entry } } }),
  );
}
const saved = (config: string) => JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services[TEAM_SITE];

test("signing out forgets the sign-in only once the service confirms it ended", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  signedIn(config);
  for (const failure of [() => new Response("Unavailable", { status: 503 }), () => Promise.reject(new TypeError("fetch failed"))]) {
    const { fetchFn } = team((path) => (path === "/auth/sign-out" ? (failure() as Response) : undefined));
    await expect(signOutComputer({ backendUrl: TEAM, env, fetchFn })).rejects.toThrow("didn't confirm signing out, so this computer is still signed in");
    expect(saved(config)).toMatchObject({ refreshToken: "r1" });
  }
  const { fetchFn, requests } = team((path) => (path === "/auth/sign-out" ? new Response(null, { status: 204 }) : undefined));
  expect(await signOutComputer({ backendUrl: TEAM, env, fetchFn })).toEqual({ reviewer: { name: "Dana", email: "dana@example.com" }, found: true });
  expect(requests.find((request) => request.path === "/auth/sign-out")?.body).toBe('{"refreshToken":"r1"}');
  expect(saved(config)).toBeUndefined();
});

test("every sign-in, with or without a desktop, is the code approval that says the computer stays signed in", async () => {
  for (const [method, env] of [["browser", {}], ["auto", { DISPLAY: ":0" }], ["remote", {}]] as const) {
    const { fetchFn, requests } = team((path) =>
      path === "/auth/device/start"
        ? Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: `${TEAM_SITE}/auth/device`, expiresIn: 600, interval: 5, ...SHOWN })
        : undefined,
    );
    const pending = await beginSignIn({ backendUrl: TEAM, method, env: { ...env, CRITIQS_CONFIG_DIR: folder() }, fetchFn, sleep: () => new Promise(() => {}) });
    pending.cancel();
    expect({ url: pending.url, userCode: pending.userCode }).toEqual({ url: `${TEAM_SITE}/auth/device`, userCode: "BCDF-GHJK" });
    expect(pending.method).toBe(method === "auto" ? "browser" : method);
    // The approval page names the backend the sign-in is for.
    expect(requests.find((request) => request.path === "/auth/device/start")?.body).toBe(`{"keepSignedIn":true,"backend":"${TEAM}","site":"${TEAM_SITE}"}`);
  }
});

test("a renewal refused because another process already renewed keeps that process's sign-in", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  signedIn(config, { accessExpiresAt: 0 });
  const { fetchFn } = team((path) => {
    if (path !== "/auth/refresh") return undefined;
    // Meanwhile, another process (whose lock was taken over) renewed with the same token.
    signedIn(config, { refreshToken: "r2", accessToken: "a2" });
    return new Response("Signed out", { status: 401 });
  });
  expect(await accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn })).toBe("a2");
  expect(saved(config)).toMatchObject({ refreshToken: "r2", accessToken: "a2" });
});

test("a holder whose lock another process took over neither releases it nor writes until that one is done, and keeps the new refresh token", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  signedIn(config, { accessExpiresAt: 0 });
  const lock = join(config, "sign-in.v2.json.lock");
  const seen: string[] = [];
  const { fetchFn } = team((path) => {
    if (path !== "/auth/refresh") return undefined;
    // Another process took the lock over meanwhile; it is still working.
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "another-owner");
    setTimeout(() => {
      seen.push(`other done: lock ${readFileSync(join(lock, "owner"), "utf8")}, refresh token ${saved(config).refreshToken}`);
      rmSync(lock, { recursive: true, force: true });
    }, 300);
    return Response.json({ accessToken: "a2", refreshToken: "r2", expiresAt: Date.now() + 900_000 });
  });
  expect(await accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env, fetchFn })).toBe("a2");
  expect(seen).toEqual(["other done: lock another-owner, refresh token r1"]);
  expect(saved(config)).toMatchObject({ refreshToken: "r2", accessToken: "a2" });
  expect(existsSync(lock)).toBe(false);
});

test("a screenshot too large to return is refused unless it can be saved to a file", async () => {
  const config = folder();
  const env = { CRITIQS_CONFIG_DIR: config };
  signedIn(config);
  const large = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
  const { fetchFn } = team((path, init) => {
    if (path === "/api/query") {
      const page = { _id: "t1", projectId: "p1", capture: { status: "captured" }, anchor: { evidence: { url: "https://p.example/", viewport: { width: 1, height: 1 }, marker: null } }, page: [], isDone: true, continueCursor: "" };
      return JSON.parse(String(init.body)).path === "threads:get" ? Response.json({ status: "success", value: page }) : undefined;
    }
    return path === "/capture" ? new Response(large, { headers: { "Content-Type": "image/png" } }) : undefined;
  });
  await expect(readScreenshot({ thread: "t1", backend: TEAM }, { env, fetchFn, cwd: config })).rejects.toThrow("too large to return here. Ask again with file");
  const result = await readScreenshot({ thread: "t1", backend: TEAM, file: "big.png" }, { env, fetchFn, cwd: config });
  expect({ image: result.image, bytes: result.bytes, file: result.file }).toEqual({ image: null, bytes: large.length, file: join(config, "big.png") });
  expect(readFileSync(join(config, "big.png")).length).toBe(large.length);
});

test("an approval that arrives after the sign-in was cancelled ends that session instead of keeping it", async () => {
  const config = folder();
  let pending: Awaited<ReturnType<typeof beginSignIn>> | null = null;
  const { fetchFn, requests } = team((path) => {
    if (path === "/auth/device/start") {
      return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: `${TEAM_SITE}/auth/device`, expiresIn: 600, interval: 1, ...SHOWN });
    }
    if (path === "/auth/device/token") {
      // Signing out cancels while this poll is in flight; the approval still arrives.
      pending!.cancel();
      return Response.json({ accessToken: "a1", refreshToken: "late", expiresAt: Date.now() + 900_000, sessionEndsAt: Date.now() + 90 * 86_400_000, ...SHOWN });
    }
    if (path === "/auth/sign-out") return new Response(null, { status: 204 });
    return undefined;
  });
  pending = await beginSignIn({ backendUrl: TEAM, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn, sleep: async () => {} });
  await expect(pending.finish()).rejects.toThrow("This sign-in was cancelled");
  expect(requests.find((request) => request.path === "/auth/sign-out")?.body).toBe('{"refreshToken":"late"}');
  expect(existsSync(join(config, "sign-in.v2.json"))).toBe(false);
});

test("a sign-in cancelled while it waits for the lock doesn't save, and ends its session", async () => {
  const config = folder();
  const lock = join(config, "sign-in.v2.json.lock");
  let pending: Awaited<ReturnType<typeof beginSignIn>> | null = null;
  const { fetchFn, requests } = team((path) => {
    if (path === "/auth/device/start") {
      return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: `${TEAM_SITE}/auth/device`, expiresIn: 600, interval: 1, ...SHOWN });
    }
    if (path === "/auth/device/token") {
      // Another process (signing out) holds the lock when the approval arrives…
      writeFileSync(lock, "sign-out");
      // …and cancels this sign-in before releasing it.
      setTimeout(() => {
        pending!.cancel();
        rmSync(lock);
      }, 120);
      return Response.json({ accessToken: "a1", refreshToken: "late", expiresAt: Date.now() + 900_000, ...SHOWN });
    }
    if (path === "/auth/sign-out") return new Response(null, { status: 204 });
    return undefined;
  });
  pending = await beginSignIn({ backendUrl: TEAM, method: "remote", env: { CRITIQS_CONFIG_DIR: config }, fetchFn, sleep: async () => {} });
  await expect(pending.finish()).rejects.toThrow("This sign-in was cancelled");
  expect(requests.find((request) => request.path === "/auth/sign-out")?.body).toBe('{"refreshToken":"late"}');
  expect(existsSync(join(config, "sign-in.v2.json"))).toBe(false);
});

test("signing out while a sign-in is still starting cancels it", async () => {
  const config = folder();
  let release!: () => void;
  const started = new Promise<void>((done) => (release = done));
  const { fetchFn, requests } = team(async (path) => {
    if (path !== "/auth/device/start") return undefined;
    await started;
    return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: `${TEAM_SITE}/auth/device`, expiresIn: 600, interval: 1, ...SHOWN });
  });
  const tools = createTools({ cwd: config, env: { CRITIQS_CONFIG_DIR: config }, fetchFn, open: () => {}, sleep: async () => {} });
  const signingIn = tools.call("critiqs_sign_in", { signIn: "remote", backend: TEAM });
  await new Promise((done) => setTimeout(done, 20));
  expect((await tools.call("critiqs_sign_out", { backend: TEAM })).content[0]!.text).toBe("This computer wasn't signed in to Critiqs.");
  release();
  const result = await signingIn;
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain("cancelled before it started");
  // It stopped waiting for the approval, and nothing was saved.
  const polls = () => requests.filter((request) => request.path === "/auth/device/token").length;
  const before = polls();
  await new Promise((done) => setTimeout(done, 50));
  expect(polls()).toBe(before);
  expect((await tools.call("critiqs_sign_in_finish", {})).content[0]!.text).toContain("No sign-in is waiting");
  expect(existsSync(join(config, "sign-in.v2.json"))).toBe(false);
});

test("approval messages name sign-in for `critiqs sign-in`, and setup for setup", async () => {
  for (const [keepSignedIn, error, expected] of [
    [true, "expired_token", "The sign-in code expired before it was approved. Run sign-in again."],
    [true, "access_denied", "Sign-in was denied in the browser. Run sign-in again to retry."],
    [false, "expired_token", "The setup code expired before it was approved. Run setup again."],
    [false, "access_denied", "Setup was denied in the browser. Run setup again to retry."],
  ] as const) {
    const fetchFn = (async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/critiqs/config") return Response.json({ protocol: 5, signInUrl: TEAM_SITE, deviceSignIn: true, deviceSessions: true });
      if (pathname === "/auth/device/start") {
        return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: `${TEAM_SITE}/auth/device`, expiresIn: 600, interval: 1, ...SHOWN });
      }
      return Response.json({ error }, { status: 400 });
    }) as unknown as typeof fetch;
    const approval = await startRemoteSignIn({ signInUrl: TEAM_SITE, backendUrl: TEAM, fetchFn, sleep: async () => {}, keepSignedIn });
    await expect(approval.tokens).rejects.toThrow(expected);
  }
});

test("an agent reply to an older backend is refused before anything is posted", async () => {
  const config = folder();
  signedIn(config);
  const { fetchFn, requests } = team((path) =>
    path === "/critiqs/config" ? Response.json({ protocol: 5, signInUrl: TEAM_SITE, deviceSignIn: true, deviceSessions: true }) : undefined,
  );
  await expect(postReply({ thread: "t1", body: "Fixed", backend: TEAM }, { env: { CRITIQS_CONFIG_DIR: config }, fetchFn })).rejects.toThrow(
    "runs an older version that can't post agent replies yet",
  );
  expect(requests.some((request) => request.path.startsWith("/api/"))).toBe(false);
});

test("reading mockups from an older backend is refused before anything is read", async () => {
  const config = folder();
  signedIn(config);
  const { fetchFn, requests } = team(() => undefined);
  const services = { env: { CRITIQS_CONFIG_DIR: config }, fetchFn };
  const refusal = "runs an older version that has no mockups yet. Its operator needs to deploy the current Critiqs backend";
  await expect(listMockups({ projectId: "p1", backend: TEAM }, services)).rejects.toThrow(refusal);
  await expect(readMockup({ mockup: "m1", backend: TEAM }, services)).rejects.toThrow(refusal);
  expect(requests.some((request) => request.path.startsWith("/api/") || request.path.startsWith("/mockup/"))).toBe(false);
});

test("saved page copies never leave the folder they are saved to", async () => {
  const config = folder();
  signedIn(config);
  const detail = {
    _id: "../outside",
    projectId: "p1",
    title: "Escape",
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
  const answers: Record<string, unknown> = { "mockups:get": detail, "projects:get": { name: "Pilot", reviewUrl: null }, "mockups:threads": [] };
  const { fetchFn } = team((path, init) => {
    if (path === "/critiqs/config") return Response.json({ protocol: 5, signInUrl: TEAM_SITE, mockups: true });
    if (path === "/mockup/snapshot") return new Response("<html></html>");
    if (path === "/api/query") return Response.json({ status: "success", value: answers[JSON.parse(String(init.body)).path] });
    return undefined;
  });
  const cwd = join(config, "project");
  await expect(readMockup({ mockup: "../outside", saveCopies: "copies", backend: TEAM }, { cwd, env: { CRITIQS_CONFIG_DIR: config }, fetchFn })).rejects.toThrow(
    "can't be used as file names",
  );
  expect(existsSync(join(config, "outside"))).toBe(false);
  expect(existsSync(join(cwd, "copies"))).toBe(false);
});

test("a page copy's elements are found by number in its HTML, as the copy has them", () => {
  const html =
    '<!DOCTYPE html><html><head><style>p::before { content: "<b data-critiqs-node=\'2\'>" }</style><title data-critiqs-node="9">Settings</title></head>' +
    '<body data-critiqs-node="1"><!-- <i> > <b data-critiqs-node="2">old</b> -->' +
    '<section data-critiqs-node="2" data-critiqs-id="settings"><p data-critiqs-node="3" title="say &quot;hi&quot; > there" style="color: red">Hello <b data-critiqs-node="4">big</b>&nbsp;world &amp; more</p>' +
    `<img data-critiqs-node="5" alt="Avatar" src="data:image/png;base64,${"A".repeat(200)}">` +
    '<textarea data-critiqs-node="6">a <b> isn\'t markup</textarea><svg data-critiqs-node="7"><path data-critiqs-node="8" d="M0 0"></path></svg></section>' +
    '<p data-critiqs-node="10">data-critiqs-node="11" is only text</p></body></html>';
  const { elements, highest } = findElements(html, [2, 3, 4, 5, 6, 8, 9, 11, 12]);
  expect(highest).toBe(10);
  expect(elements.get(2)).toEqual({ tag: "section", markup: '<section data-critiqs-id="settings">', text: "Hello big world & morea <b> isn't markup", purposeId: "settings" });
  expect(elements.get(3)).toEqual({ tag: "p", markup: '<p title="say &quot;hi&quot; > there" style="color: red">', text: "Hello big world & more", purposeId: "settings" });
  expect(elements.get(4)).toMatchObject({ markup: "<b>", text: "big" });
  expect(elements.get(5)!.markup).toBe(`<img alt="Avatar" src="data:image/png;base64,${"A".repeat(57)}…">`);
  expect(elements.get(6)).toMatchObject({ tag: "textarea", text: "a <b> isn't markup" });
  expect(elements.get(8)).toEqual({ tag: "path", markup: '<path d="M0 0">', text: "", purposeId: "settings" });
  expect(elements.get(9)).toMatchObject({ tag: "title", text: "Settings", purposeId: null });
  // Text that looks like markup, and numbers past the copy's highest, aren't elements.
  expect(elements.has(11)).toBe(false);
  expect(elements.has(12)).toBe(false);
  // Long text is shortened.
  const long = findElements(`<p data-critiqs-node="1">${"word ".repeat(100)}</p>`, [1], { textChars: 20 }).elements.get(1)!;
  expect(long.text).toBe("word word word word…");
});
