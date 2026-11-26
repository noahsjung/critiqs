import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { decryptToken, trackerTokenBinding } from "@critiqs/server";
import { api, internal } from "../convex/_generated/api";
import { reviewer, setup } from "./harness";

// Your trackers on Convex: connecting Linear with a pasted API key or through
// Linear's sign-in, against a local stand-in for Linear's API and sign-in;
// the sign-in's state checks; refreshing an expired sign-in token; and the
// `tickets` flag in /critiqs/config.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const SITE = "https://backend.example";
const ENV = ["CRITIQS_AI_ENCRYPTION_KEY", "CRITIQS_LINEAR_CLIENT_ID", "CRITIQS_LINEAR_CLIENT_SECRET", "CRITIQS_LINEAR_API_URL", "CRITIQS_LINEAR_APP_URL", "CONVEX_SITE_URL", "CRITIQS_AUTH_ISSUER"];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

/** What Linear's token endpoint answers next, in order; with none left it refuses. */
const tokenReplies: { status?: number; body: unknown }[] = [];
const sent: { path: string; authorization: string | null; form: Record<string, string> }[] = [];
/** The email Linear reports for whoever signed in; Dana's Critiqs address unless a test changes it. */
let linearEmail = "dana@example.com";
let linear: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  linear = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.text();
      const authorization = request.headers.get("Authorization");
      sent.push({ path, authorization, form: path === "/oauth/token" ? Object.fromEntries(new URLSearchParams(body)) : { query: body } });
      if (path === "/oauth/token") {
        const next = tokenReplies.shift() ?? { status: 400, body: { error: "invalid_grant" } };
        return Response.json(next.body, { status: next.status ?? 200 });
      }
      if (authorization === "lin_api_bad" || authorization === "Bearer revoked") {
        return Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 });
      }
      return Response.json({ data: { viewer: { id: "user-1", name: "Dana Smith", email: linearEmail }, organization: { id: "org-1", name: "Acme" } } });
    },
  });
});
afterAll(() => linear.stop(true));

beforeEach(() => {
  process.env.CONVEX_SITE_URL = SITE;
  process.env.CRITIQS_AUTH_ISSUER = "https://auth.example";
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  process.env.CRITIQS_LINEAR_API_URL = `http://127.0.0.1:${linear.port}`;
  process.env.CRITIQS_LINEAR_APP_URL = "https://linear.example";
  delete process.env.CRITIQS_LINEAR_CLIENT_ID;
  delete process.env.CRITIQS_LINEAR_CLIENT_SECRET;
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  tokenReplies.length = 0;
  sent.length = 0;
  linearEmail = "dana@example.com";
});

function withSignIn() {
  process.env.CRITIQS_LINEAR_CLIENT_ID = "client-1";
  process.env.CRITIQS_LINEAR_CLIENT_SECRET = "secret-1";
}

function people() {
  const t = setup();
  return { t, dana: t.withIdentity(reviewer("Dana")), lee: t.withIdentity(reviewer("Lee")) };
}

async function userId(t: ReturnType<typeof setup>, name: string) {
  return await t.run(async (ctx) => (await ctx.db.query("users").collect()).find((user) => user.name === name)!._id);
}

const config = async (t: ReturnType<typeof setup>) => (await (await t.fetch("/critiqs/config")).json()) as { tickets?: unknown };

/** The cookie a response sets, as a browser sends it back. */
function cookieOf(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0]!;
}

/** One browser's cookies for the backend: kept from responses, sent back with later requests. */
function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    take(response: Response) {
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(";").map((part) => part.trim());
        const [name, value] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
        if (attributes.includes("Max-Age=0") || value === "") cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    names: () => [...cookies.keys()],
  };
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("/critiqs/config offers Linear only with an encryption key: by API key, or by sign-in with the operator's Linear app", async () => {
  const { t } = people();
  delete process.env.CRITIQS_AI_ENCRYPTION_KEY;
  expect(await config(t)).not.toHaveProperty("tickets");
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  expect((await config(t)).tickets).toEqual({ trackers: [{ id: "linear", signIn: "token" }] });
  withSignIn();
  expect((await config(t)).tickets).toEqual({ trackers: [{ id: "linear", signIn: "oauth" }] });
});

test("a pasted Linear API key is checked with Linear, stored encrypted, and shown only to its person, never as a token", async () => {
  const { t, dana, lee } = people();
  const view = await dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_good" });
  expect(view).toMatchObject({ tracker: "linear", method: "token", accountName: "Dana Smith", site: "Acme", attribution: true });
  expect(sent.map((request) => [request.path, request.authorization])).toEqual([["/graphql", "lin_api_good"]]);
  expect(await dana.query(api.trackers.mine, {})).toEqual([view]);
  expect(await lee.query(api.trackers.mine, {})).toEqual([]);
  const danaId = await userId(t, "Dana");
  const [row] = await t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  expect(JSON.stringify(row)).not.toContain("lin_api_good");
  expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), row!.access)).toBe("lin_api_good");

  await expect(dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_bad" })).rejects.toThrow("Linear didn't accept this API key");
  // The refused key didn't replace the working one.
  expect(await dana.query(api.trackers.mine, {})).toEqual([view]);

  expect(await dana.mutation(api.trackers.setAttribution, { tracker: "linear", attribution: false })).toMatchObject({ attribution: false });
  await dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_again" });
  expect(await t.run((ctx) => ctx.db.query("trackerAccounts").collect())).toHaveLength(1);
  expect(await dana.query(api.trackers.mine, {})).toEqual([expect.objectContaining({ attribution: false })]);

  await dana.mutation(api.trackers.disconnect, { tracker: "linear" });
  expect(await dana.query(api.trackers.mine, {})).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("trackerAccounts").collect())).toEqual([]);
});

test("without an encryption key, or signed out, nothing can be connected", async () => {
  const { t } = people();
  delete process.env.CRITIQS_AI_ENCRYPTION_KEY;
  const dana = t.withIdentity(reviewer("Dana"));
  await expect(dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_good" })).rejects.toThrow("CRITIQS_AI_ENCRYPTION_KEY");
  expect(sent).toEqual([]);
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  await expect(t.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_good" })).rejects.toThrow("Sign in");
  await expect(t.query(api.trackers.mine, {})).rejects.toThrow("Sign in");
});

/** Starts a sign-in as Dana and opens it, as her window does, by posting the state and binding secret: the redirect to Linear and that browser's cookie. */
async function openSignIn(f: ReturnType<typeof people>) {
  const started = await f.dana.action(api.trackers.startSignIn, { tracker: "linear" });
  expect(started.url).toBe(`${SITE}/trackers/linear/start`);
  const start = await post(f, { state: started.state, binding: started.binding });
  return { state: started.state, binding: started.binding, start, cookie: cookieOf(start) };
}

const post = (f: ReturnType<typeof people>, fields: Record<string, string>) =>
  f.t.fetch("/trackers/linear/start", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

const callback = (f: ReturnType<typeof people>, query: Record<string, string>, cookie?: string) =>
  f.t.fetch(`/trackers/linear/callback?${new URLSearchParams(query)}`, cookie === undefined ? {} : { headers: { Cookie: cookie } });

test("Linear sign-in: the window goes to Linear with PKCE, comes back with a code, and stores the tokens encrypted", async () => {
  withSignIn();
  const f = people();
  const { state, start, cookie } = await openSignIn(f);
  expect(start.status).toBe(303);
  expect(start.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(start.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  const authorize = new URL(start.headers.get("Location")!);
  expect(authorize.origin + authorize.pathname).toBe("https://linear.example/oauth/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    client_id: "client-1",
    redirect_uri: `${SITE}/trackers/linear/callback`,
    response_type: "code",
    scope: "read,issues:create,comments:create",
    state,
    actor: "user",
    code_challenge_method: "S256",
  });

  tokenReplies.push({ body: { access_token: "access-1", token_type: "Bearer", expires_in: 86_399, refresh_token: "refresh-1" } });
  const done = await callback(f, { code: "code-1", state }, cookie);
  expect(done.status).toBe(200);
  expect(await done.text()).toContain("Linear is connected");
  // The code went with the verifier whose hash Linear was given, and Linear was asked whose the token is.
  const exchange = sent.find((request) => request.path === "/oauth/token")!;
  expect(exchange.form).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-1", client_secret: "secret-1", redirect_uri: `${SITE}/trackers/linear/callback` });
  expect(await sha256(exchange.form.code_verifier!)).toBe(authorize.searchParams.get("code_challenge")!);
  expect(sent.find((request) => request.path === "/graphql")!.authorization).toBe("Bearer access-1");

  expect(await f.dana.query(api.trackers.mine, {})).toEqual([expect.objectContaining({ tracker: "linear", method: "oauth", accountName: "Dana Smith", site: "Acme" })]);
  const danaId = await userId(f.t, "Dana");
  const [row] = await f.t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), row!.access)).toBe("access-1");
  expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), row!.refresh!)).toBe("refresh-1");
  expect(row!.expiresAt).toBeGreaterThan(Date.now() + 86_000_000);
  // The state is used up.
  expect(await f.t.run((ctx) => ctx.db.query("trackerSignIns").collect())).toEqual([]);
  expect(await (await callback(f, { code: "code-1", state }, cookie)).text()).toContain("expired or was already used");
});

test("Linear sign-in stores an account only when its Linear email is the Critiqs account's, in any letter case", async () => {
  withSignIn();
  const f = people();
  // Someone else finished Dana's sign-in, into their own Linear account.
  linearEmail = "lee@example.com";
  const other = await openSignIn(f);
  tokenReplies.push({ body: { access_token: "lee-access", expires_in: 86_399, refresh_token: "lee-refresh" } });
  const refused = await callback(f, { code: "code-lee", state: other.state }, other.cookie);
  expect(refused.status).toBe(403);
  const page = await refused.text();
  expect(page).toContain("Linear wasn&#39;t connected");
  expect(page).toContain("The Linear account you signed in with (lee@example.com) doesn&#39;t use the same email address as the Critiqs account");
  expect(page).toContain("connect with a Linear API key in Your trackers instead");
  // The Critiqs account's address isn't shown to whoever is in the window.
  expect(page).not.toContain("dana@example.com");
  expect(JSON.parse(sent.find((request) => request.path === "/graphql")!.form.query!).query).toContain("viewer { id name email }");
  expect(await f.t.run((ctx) => ctx.db.query("trackerAccounts").collect())).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("trackerSignIns").collect())).toEqual([]);

  // Dana's own Linear account, whose address differs only in letter case.
  linearEmail = "Dana@Example.com";
  const own = await openSignIn(f);
  tokenReplies.push({ body: { access_token: "dana-access", expires_in: 86_399, refresh_token: "dana-refresh" } });
  expect(await (await callback(f, { code: "code-dana", state: own.state }, own.cookie)).text()).toContain("Linear is connected");
  const [row] = await f.t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  expect(await decryptToken(KEY, trackerTokenBinding("linear", await userId(f.t, "Dana")), row!.access)).toBe("dana-access");
});

test("Linear sign-in refuses an unknown or expired state, a window opened twice, and another browser", async () => {
  withSignIn();
  const f = people();
  expect(await (await post(f, { state: "made-up", binding: "b" })).text()).toContain("expired or was already used");
  expect(await (await callback(f, { code: "c", state: "made-up" })).text()).toContain("expired or was already used");

  const { state, binding, cookie } = await openSignIn(f);
  // The sign-in opens once; posting its secret again is refused.
  const again = await post(f, { state, binding });
  expect(again.status).toBe(400);
  expect(again.headers.get("Location")).toBeNull();
  // A browser without the cookie, such as one the start link's redirect was forwarded to, can't finish it.
  const elsewhere = await callback(f, { code: "c", state });
  expect(await elsewhere.text()).toContain("same browser window that started it");
  expect(await f.dana.query(api.trackers.mine, {})).toEqual([]);

  // Expired: the person came back too late.
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("trackerSignIns").collect()) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });
  expect(await (await callback(f, { code: "c", state }, cookie)).text()).toContain("expired or was already used");
  expect(sent).toEqual([]);
  expect(await f.dana.query(api.trackers.mine, {})).toEqual([]);
});

test("a start link opened by a browser that didn't start the sign-in never reaches Linear (a forwarded link)", async () => {
  withSignIn();
  const f = people();
  // Dana starts a sign-in; the link reaches Lee's browser, which never had what Dana's window was given.
  const { url, state } = await f.dana.action(api.trackers.startSignIn, { tracker: "linear" });
  const link = new URL(url);
  // The secret isn't in the address.
  expect(link.search).toBe("");
  const attempts = [
    await f.t.fetch(link.pathname),
    await f.t.fetch(`${link.pathname}?state=${encodeURIComponent(state)}`),
    await post(f, { state }),
    await post(f, { state, binding: "guessed" }),
  ];
  for (const forwarded of attempts) {
    expect(forwarded.headers.get("Location")).toBeNull();
    expect(forwarded.headers.get("Set-Cookie")).toBeNull();
    expect(forwarded.status).toBe(400);
    expect(await forwarded.text()).toContain("only works in the window Your trackers opens");
  }
  // Nothing about the sign-in changed: no browser holds it, so no callback can finish it.
  expect(await f.t.run(async (ctx) => (await ctx.db.query("trackerSignIns").collect()).map((row) => row.openedAt ?? null))).toEqual([null]);
  expect(await (await callback(f, { code: "c", state })).text()).toContain("same browser window that started it");
  expect(sent).toEqual([]);
});

test("two sign-in windows in one browser each finish, in either order, and each clears only its own cookie", async () => {
  withSignIn();
  const f = people();
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const jar = cookieJar();
    const windows = [await openSignIn(f), await openSignIn(f)];
    for (const window of windows) jar.take(window.start);
    expect(jar.names()).toHaveLength(2);
    for (const [finished, index] of order.entries()) {
      tokenReplies.push({ body: { access_token: `access-${index}`, expires_in: 86_399, refresh_token: `refresh-${index}` } });
      const done = await callback(f, { code: `code-${index}`, state: windows[index]!.state }, jar.header());
      expect(await done.text()).toContain("Linear is connected");
      jar.take(done);
      // The other window's cookie is still there for its own return.
      expect(jar.names()).toHaveLength(1 - finished);
    }
    const danaId = await userId(f.t, "Dana");
    const [row] = await f.t.run((ctx) => ctx.db.query("trackerAccounts").collect());
    expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), row!.access)).toBe(`access-${order[1]}`);
  }
});

test("Linear sign-in: a person who doesn't allow Critiqs, or a code Linear refuses, gets a plain message and nothing is stored", async () => {
  withSignIn();
  const f = people();
  const denied = await openSignIn(f);
  const page = await callback(f, { error: "access_denied", state: denied.state }, denied.cookie);
  expect(await page.text()).toContain("You didn&#39;t allow Critiqs to use your Linear account.");
  expect(await f.t.run((ctx) => ctx.db.query("trackerSignIns").collect())).toEqual([]);

  const refused = await openSignIn(f);
  const failedPage = await callback(f, { code: "stale", state: refused.state }, refused.cookie);
  expect(failedPage.status).toBe(502);
  expect(await failedPage.text()).toContain("Linear didn&#39;t accept this sign-in.");
  expect(await f.dana.query(api.trackers.mine, {})).toEqual([]);
});

test("Linear sign-in can't start without the operator's app, and a pasted key still connects", async () => {
  const f = people();
  await expect(f.dana.action(api.trackers.startSignIn, { tracker: "linear" })).rejects.toThrow("Paste an API key instead");
  expect((await f.t.fetch("/trackers/linear/start")).status).toBe(404);
  expect((await post(f, { state: "x", binding: "y" })).status).toBe(404);
});

test("expired tracker sign-ins are cleaned up with the other sign-in records", async () => {
  withSignIn();
  const f = people();
  await f.dana.action(api.trackers.startSignIn, { tracker: "linear" });
  await f.dana.action(api.trackers.startSignIn, { tracker: "linear" });
  await f.t.run(async (ctx) => {
    const [first] = await ctx.db.query("trackerSignIns").collect();
    await ctx.db.patch(first!._id, { expiresAt: Date.now() - 1 });
  });
  await f.t.mutation(internal.signIn.cleanUp, {});
  expect(await f.t.run((ctx) => ctx.db.query("trackerSignIns").collect())).toHaveLength(1);
});

test("an expired sign-in token is refreshed with Linear before use, and the rotated tokens replace the old ones", async () => {
  withSignIn();
  const f = people();
  const { state, cookie } = await openSignIn(f);
  // A token that has already expired, as one does after a day.
  tokenReplies.push({ body: { access_token: "access-1", expires_in: 1, refresh_token: "refresh-1" } });
  await callback(f, { code: "code-1", state }, cookie);
  const danaId = await userId(f.t, "Dana");
  tokenReplies.push({ body: { access_token: "access-2", expires_in: 86_399, refresh_token: "refresh-2" } });
  expect(await f.t.action(internal.trackers.accessToken, { userId: danaId, tracker: "linear" })).toEqual({ method: "oauth", value: "access-2" });
  expect(sent.filter((request) => request.path === "/oauth/token").at(-1)!.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
  // Fresh now: used as it is.
  expect(await f.t.action(internal.trackers.accessToken, { userId: danaId, tracker: "linear" })).toEqual({ method: "oauth", value: "access-2" });
  expect(sent.filter((request) => request.path === "/oauth/token")).toHaveLength(2);
  const [row] = await f.t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), row!.refresh!)).toBe("refresh-2");
  expect(row!.refreshLease).toBeUndefined();
});

test("the sign-in start reads at most a few kilobytes of what is posted to it", async () => {
  withSignIn();
  const { t } = people();
  const response = await t.fetch("/trackers/linear/start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `state=s&binding=b&padding=${"x".repeat(1024 * 1024)}`,
  });
  expect(response.status).toBe(413);
});

test("each person may start ten sign-ins and connect ten API keys a minute", async () => {
  withSignIn();
  const { dana, lee } = people();
  for (let index = 0; index < 10; index++) await dana.action(api.trackers.startSignIn, { tracker: "linear" });
  await expect(dana.action(api.trackers.startSignIn, { tracker: "linear" })).rejects.toThrow("Too many");
  // Another person isn't held back.
  await lee.action(api.trackers.startSignIn, { tracker: "linear" });
  for (let index = 0; index < 10; index++) await dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_good" });
  await expect(dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_good" })).rejects.toThrow("Too many");
});

test("a failed sign-in says only Critiqs's own message, whatever else went wrong", async () => {
  const { failureMessage } = await import("../convex/trackerHttp");
  const { ConvexError } = await import("convex/values");
  expect(failureMessage(new ConvexError({ code: "invalid", message: "Linear said no." }))).toBe("Linear said no.");
  expect(failureMessage(new ConvexError("a bare string"))).toContain("Something went wrong");
  expect(failureMessage(new Error("token lin_oauth_secret leaked"))).toContain("Something went wrong");
});
