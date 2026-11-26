import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { panelSignIn, PanelSignInError } from "@critiqs/core";
import { hashSecret } from "../convex/lib/tokens";
import { internal } from "../convex/_generated/api";
import { setup } from "./harness";

// Signing in inside Critiqs's own panels (its website and its extension's side
// panel) with JSON routes, and how those origins are trusted.

const LOCAL = "http://127.0.0.1:3211";
const HOSTED = "https://critiqs-auth.example";
const WEB = "https://critiqs.example";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION = `chrome-extension://${EXTENSION_ID}`;
const OTHER_EXTENSION = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const PROTOTYPE = "https://proto.example";

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  process.env.CRITIQS_AUTH_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
});

beforeEach(() => {
  process.env.CRITIQS_AUTH_ISSUER = LOCAL;
  process.env.CRITIQS_DEV_SIGN_IN = "enabled";
  process.env.CRITIQS_WEB_ORIGINS = `${WEB}, http://localhost:5299`;
  process.env.CRITIQS_EXTENSION_IDS = EXTENSION_ID;
});

afterEach(() => {
  delete process.env.CRITIQS_DEV_SIGN_IN;
  delete process.env.CRITIQS_WEB_ORIGINS;
  delete process.env.CRITIQS_EXTENSION_IDS;
  delete process.env.RESEND_API_KEY;
  delete process.env.CRITIQS_EMAIL_FROM;
});

type Test = ReturnType<typeof setup>;

function call(t: Test, path: string, body: unknown, origin: string | null = WEB) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin !== null) headers.Origin = origin;
  return t.fetch(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

/** Sends a code to `email`; returns the attempt key and the development code. */
async function sendCode(t: Test, email = "dana@example.com", origin = WEB, attempt?: string) {
  const response = await call(t, "/auth/panel/email", attempt === undefined ? { email } : { email, attempt }, origin);
  expect(response.status).toBe(200);
  const body = await json(response);
  return { attempt: body.attempt as string, code: body.developmentCode as string };
}

async function signIn(t: Test, email = "dana@example.com", name = "Dana", origin = WEB) {
  const { attempt, code } = await sendCode(t, email, origin);
  let body = await json(await call(t, "/auth/panel/code", { attempt, code }, origin));
  if (body.status === "needs-name") body = await json(await call(t, "/auth/panel/name", { attempt, name }, origin));
  return body;
}

/** A popup sign-in from `origin` as Dana; returns the last page and what continues it. */
async function popupSignIn(t: Test, origin: string) {
  const started = await t.fetch(`/auth/start?origin=${encodeURIComponent(origin)}&state=s`);
  const key = /name="attempt" value="([^"]+)"/.exec(await started.text())?.[1] ?? "";
  const cookie = (started.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const post = (path: string, fields: Record<string, string>) =>
    t.fetch(path, { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(fields).toString() });
  const sent = await (await post("/auth/email", { attempt: key, email: "dana@example.com" })).text();
  const code = /id="development-code">(\d{6})</.exec(sent)?.[1] ?? "";
  let page = await (await post("/auth/code", { attempt: key, code })).text();
  if (page.includes("Choose your display name")) page = await (await post("/auth/name", { attempt: key, name: "Dana" })).text();
  return { page, key, post };
}

function wrongCode(code: string) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

function claimsOf(accessToken: string) {
  const payload = accessToken.split(".")[1] ?? "";
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, any>;
}

test("a new reviewer signs in from Critiqs's website: email, code, then a display name, and receives tokens", async () => {
  const t = setup();
  const sent = await call(t, "/auth/panel/email", { email: " Dana@Example.com " });
  expect(sent.status).toBe(200);
  expect(sent.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
  expect(sent.headers.get("Vary")).toBe("Origin");
  const { attempt, email, developmentCode } = await json(sent);
  expect(attempt).toBeString();
  expect(email).toBe("dana@example.com");
  expect(developmentCode).toMatch(/^\d{6}$/);
  // No cookie carries the attempt.
  expect(sent.headers.get("Set-Cookie")).toBeNull();

  const checked = await call(t, "/auth/panel/code", { attempt, code: developmentCode });
  expect(checked.status).toBe(200);
  expect(checked.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
  expect(await json(checked)).toEqual({ status: "needs-name" });

  const named = await call(t, "/auth/panel/name", { attempt, name: "Dana" });
  expect(named.status).toBe(200);
  expect(named.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
  const tokens = await json(named);
  expect(tokens).toMatchObject({ status: "signed-in", reviewer: { name: "Dana", email: "dana@example.com" } });
  expect(tokens.refreshToken).toBeString();
  expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  expect(tokens.sessionEndsAt).toBeGreaterThan(tokens.expiresAt);
  expect(claimsOf(tokens.accessToken)).toMatchObject({ origin: WEB, name: "Dana", email: "dana@example.com", sub: tokens.reviewer.id });

  // An attempt is used once.
  expect((await call(t, "/auth/panel/name", { attempt, name: "Dana" })).status).toBe(410);
  // Critiqs's own website needs no site grant and records none.
  expect(await t.run(async (ctx) => await ctx.db.query("siteGrants").collect())).toEqual([]);
});

test("a returning reviewer receives tokens straight after the code, keeping their name", async () => {
  const t = setup();
  const first = await signIn(t, "dana@example.com", "Dana");
  const { attempt, code } = await sendCode(t);
  const again = await json(await call(t, "/auth/panel/code", { attempt, code }));
  expect(again).toMatchObject({ status: "signed-in", reviewer: { id: first.reviewer.id, name: "Dana" } });
});

test("a display name must be 1 to 60 characters", async () => {
  const t = setup();
  const { attempt, code } = await sendCode(t, "newcomer@example.com");
  await call(t, "/auth/panel/code", { attempt, code });
  for (const name of ["   ", "x".repeat(61), 42]) {
    const response = await call(t, "/auth/panel/name", { attempt, name });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("invalid-name");
  }
  expect((await json(await call(t, "/auth/panel/name", { attempt, name: " New  Person " }))).reviewer.name).toBe("New Person");
});

test("a name can't be chosen before the code matches", async () => {
  const t = setup();
  const { attempt } = await sendCode(t, "newcomer@example.com");
  expect((await call(t, "/auth/panel/name", { attempt, name: "Mallory" })).status).toBe(410);
});

test("the extension's side panel signs in, renews, renames, and signs out from its own origin", async () => {
  const t = setup();
  const tokens = await signIn(t, "dana@example.com", "Dana", EXTENSION);
  expect(tokens.status).toBe("signed-in");
  expect(claimsOf(tokens.accessToken).origin).toBe(EXTENSION);
  let refreshToken = tokens.refreshToken as string;

  const refreshed = await call(t, "/auth/refresh", { refreshToken }, EXTENSION);
  expect(refreshed.status).toBe(200);
  expect(refreshed.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION);
  refreshToken = (await json(refreshed)).refreshToken;

  // The session belongs to the extension: Critiqs's website can't use it, nor another extension.
  expect((await call(t, "/auth/refresh", { refreshToken }, WEB)).status).toBe(401);
  expect((await call(t, "/auth/refresh", { refreshToken }, OTHER_EXTENSION)).status).toBe(400);

  const renamed = await call(t, "/auth/profile", { refreshToken, name: "Dana Kim" }, EXTENSION);
  expect(renamed.status).toBe(204);
  expect(renamed.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION);
  const next = await json(await call(t, "/auth/refresh", { refreshToken }, EXTENSION));
  expect(claimsOf(next.accessToken).name).toBe("Dana Kim");
  refreshToken = next.refreshToken;

  const out = await call(t, "/auth/sign-out", { refreshToken }, EXTENSION);
  expect(out.status).toBe(204);
  expect(out.headers.get("Critiqs-Session-Ended")).toBe("true");
  expect((await call(t, "/auth/refresh", { refreshToken }, EXTENSION)).status).toBe(401);
});

test("session routes answer preflights from an allowed extension and refuse other extensions", async () => {
  const t = setup();
  const preflight = (origin: string) =>
    t.fetch("/auth/refresh", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  expect((await preflight(EXTENSION)).headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION);
  expect((await preflight(OTHER_EXTENSION)).headers.get("Access-Control-Allow-Origin")).toBe("null");
});

test("any other origin gets no CORS headers, and nothing happens", async () => {
  const t = setup();
  const refused = [
    PROTOTYPE,
    OTHER_EXTENSION,
    "https://critiqs.example.evil.example",
    "https://www.critiqs.example",
    "http://critiqs.example",
    `${WEB}/`,
    "null",
    null,
  ];
  for (const origin of refused) {
    for (const path of ["/auth/panel/email", "/auth/panel/code", "/auth/panel/name"]) {
      const response = await call(t, path, { email: "dana@example.com", attempt: "a", code: "123456", name: "Dana" }, origin);
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(JSON.stringify(await response.json())).not.toMatch(/\d{6}/);
      const preflight = await t.fetch(path, {
        method: "OPTIONS",
        headers: origin === null ? {} : { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  }
  // No attempt was started and no code was reserved.
  expect(await t.run(async (ctx) => await ctx.db.query("signInAttempts").collect())).toEqual([]);
  expect(await t.run(async (ctx) => await ctx.db.query("signInLimits").collect())).toEqual([]);
});

test("allowed origins pass a preflight", async () => {
  const t = setup();
  for (const origin of [WEB, "http://localhost:5299", EXTENSION]) {
    const preflight = await t.fetch("/auth/panel/email", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  }
});

test("panel origins come only from exact settings; anything broader is ignored", async () => {
  process.env.CRITIQS_WEB_ORIGINS = "https://ok.example, https://path.example/review, http://plain.example, *.critiqs.example, HTTPS://UPPER.EXAMPLE";
  process.env.CRITIQS_EXTENSION_IDS = `${EXTENSION_ID} ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP short`;
  const t = setup();
  const status = async (origin: string) => (await call(t, "/auth/panel/email", { email: "dana@example.com" }, origin)).status;
  expect(await status("https://ok.example")).toBe(200);
  expect(await status(EXTENSION)).toBe(200);
  for (const origin of [
    "https://path.example",
    "http://plain.example",
    "https://x.critiqs.example",
    "https://upper.example",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
    "moz-extension://abcdefghijklmnopabcdefghijklmnop",
  ]) {
    expect(await status(origin)).toBe(403);
  }
});

test("with no panel origins configured, the panel routes refuse everyone", async () => {
  delete process.env.CRITIQS_WEB_ORIGINS;
  delete process.env.CRITIQS_EXTENSION_IDS;
  const t = setup();
  expect((await call(t, "/auth/panel/email", { email: "dana@example.com" }, WEB)).status).toBe(403);
  expect((await call(t, "/auth/panel/email", { email: "dana@example.com" }, EXTENSION)).status).toBe(403);
});

test("a wrong code uses up one of five tries, after which the attempt is locked", async () => {
  const t = setup();
  const { attempt, code } = await sendCode(t);
  for (let left = 4; left >= 1; left--) {
    const response = await call(t, "/auth/panel/code", { attempt, code: wrongCode(code) });
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(await json(response)).toMatchObject({ error: "wrong-code", guessesLeft: left });
  }
  const locked = await call(t, "/auth/panel/code", { attempt, code: wrongCode(code) });
  expect(locked.status).toBe(429);
  expect((await json(locked)).error).toBe("locked");
  // Even the right code no longer works, and a new code can't reset the count.
  expect((await json(await call(t, "/auth/panel/code", { attempt, code }))).error).toBe("locked");
  expect((await json(await call(t, "/auth/panel/email", { email: "dana@example.com", attempt }))).error).toBe("locked");
});

test("malformed codes use up no tries, and a code may be typed with spaces", async () => {
  const t = setup();
  const { attempt, code } = await sendCode(t);
  for (const typed of ["12ab", "", 123456]) {
    const response = await call(t, "/auth/panel/code", { attempt, code: typed });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("invalid-code");
  }
  expect((await json(await call(t, "/auth/panel/code", { attempt, code: `${code.slice(0, 3)} ${code.slice(3)}` }))).status).toBe("needs-name");
});

test("a new code replaces the previous one, keeps the wrong-code count, and an attempt sends at most three", async () => {
  const t = setup();
  const first = await sendCode(t);
  const second = await sendCode(t, "dana@example.com", WEB, first.attempt);
  expect(second.attempt).toBe(first.attempt);
  const stale = first.code === second.code ? wrongCode(first.code) : first.code;
  expect(await json(await call(t, "/auth/panel/code", { attempt: first.attempt, code: stale }))).toMatchObject({ guessesLeft: 4 });
  const third = await sendCode(t, "dana@example.com", WEB, first.attempt);
  const refused = await call(t, "/auth/panel/email", { email: "dana@example.com", attempt: first.attempt });
  expect(refused.status).toBe(429);
  const body = await json(refused);
  expect(body.error).toBe("too-many-codes");
  expect(body.developmentCode).toBeUndefined();
  expect((await json(await call(t, "/auth/panel/code", { attempt: first.attempt, code: third.code }))).status).toBe("needs-name");
});

test("an address receives at most five codes in fifteen minutes, counting popup and panel sign-ins together", async () => {
  const t = setup();
  // Two through the popup…
  for (let i = 0; i < 2; i++) {
    const popup = await t.fetch(`/auth/start?origin=${encodeURIComponent(PROTOTYPE)}&state=s`);
    const key = /name="attempt" value="([^"]+)"/.exec(await popup.text())?.[1] ?? "";
    const cookie = (popup.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const page = await (await t.fetch("/auth/email", {
      method: "POST",
      headers: { Cookie: cookie },
      body: new URLSearchParams({ attempt: key, email: "dana@example.com" }).toString(),
    })).text();
    expect(page).toContain("development-code");
  }
  // …and three through panels.
  for (let i = 0; i < 3; i++) await sendCode(t, "dana@example.com", i % 2 === 0 ? WEB : EXTENSION);
  const refused = await call(t, "/auth/panel/email", { email: "DANA@example.com" });
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await json(refused)).toMatchObject({ error: "rate-limited" });
  // Other addresses are unaffected.
  await sendCode(t, "lee@example.com");
});

test("each panel origin starts at most twenty sign-ins a minute, like any site", async () => {
  const t = setup();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (let i = 0; i < 20; i++) await sendCode(t, `person${i}@example.com`);
    const refused = await call(t, "/auth/panel/email", { email: "late@example.com" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await json(refused)).toMatchObject({ error: "rate-limited" });
    // Another origin has its own allowance; this one recovers after the minute.
    await sendCode(t, "late@example.com", EXTENSION);
    now += 60_001;
    await sendCode(t, "later@example.com");
  } finally {
    clock.mockRestore();
  }
});

test("an invalid email starts no attempt", async () => {
  const t = setup();
  for (const email of ["not-an-email", "", 7]) {
    const response = await call(t, "/auth/panel/email", { email });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("invalid-email");
  }
  expect(await t.run(async (ctx) => await ctx.db.query("signInAttempts").collect())).toEqual([]);
});

test("malformed or oversized requests are refused", async () => {
  const t = setup();
  for (const body of ["{", "null", "[]", "\"x\"", JSON.stringify({ email: "dana@example.com", pad: "x".repeat(5000) })]) {
    const response = await call(t, "/auth/panel/email", body);
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
  }
  for (const attempt of [7, "", "x".repeat(201)]) {
    expect((await call(t, "/auth/panel/code", { attempt, code: "123456" })).status).toBe(400);
  }
});

test("an attempt expires after thirty minutes, and a code after ten", async () => {
  const t = setup();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { attempt, code } = await sendCode(t);
    now += 10 * 60 * 1000 + 1;
    const late = await call(t, "/auth/panel/code", { attempt, code });
    expect(late.status).toBe(400);
    expect((await json(late)).error).toBe("code-expired");
    const fresh = await sendCode(t, "dana@example.com", WEB, attempt);

    now += 20 * 60 * 1000;
    const expired = await call(t, "/auth/panel/code", { attempt, code: fresh.code });
    expect(expired.status).toBe(410);
    expect(await json(expired)).toMatchObject({ error: "expired" });
    expect((await call(t, "/auth/panel/email", { email: "dana@example.com", attempt })).status).toBe(410);
  } finally {
    clock.mockRestore();
  }
});

test("an unknown attempt is expired", async () => {
  const t = setup();
  expect((await call(t, "/auth/panel/code", { attempt: "guess", code: "123456" })).status).toBe(410);
  expect((await call(t, "/auth/panel/email", { attempt: "guess", email: "dana@example.com" })).status).toBe(410);
});

test("an attempt continues only from the origin that started it", async () => {
  const t = setup();
  const { attempt, code } = await sendCode(t, "dana@example.com", WEB);
  expect((await call(t, "/auth/panel/code", { attempt, code }, EXTENSION)).status).toBe(410);
  expect((await call(t, "/auth/panel/email", { attempt, email: "mallory@example.com" }, EXTENSION)).status).toBe(410);
  // The other origin's guess used up nothing.
  expect((await json(await call(t, "/auth/panel/code", { attempt, code }, WEB))).status).toBe("needs-name");
});

test("panel and popup attempts never continue each other", async () => {
  const t = setup();
  // A panel attempt's key, posted to the popup's pages (which have no cookie for it)…
  const panel = await sendCode(t);
  const viaPopup = await (await t.fetch("/auth/code", {
    method: "POST",
    body: new URLSearchParams({ attempt: panel.attempt, code: panel.code }).toString(),
  })).text();
  expect(viaPopup).toContain("Sign-in expired");
  // …even with a cookie that matches its binding: a panel attempt is never a popup's.
  await t.run(async (ctx) => {
    await ctx.db.insert("signInAttempts", {
      key: "panel-key", origin: WEB, clientState: "panel", bindingHash: await hashSecret("cookie"), panel: true,
      createdAt: Date.now(), codesSent: 0, codeGeneration: 0, guessesLeft: 5,
    });
  });
  const forged = await (await t.fetch("/auth/email", {
    method: "POST",
    headers: { Cookie: "critiqs_sign_in=cookie" },
    body: new URLSearchParams({ attempt: "panel-key", email: "dana@example.com" }).toString(),
  })).text();
  expect(forged).toContain("Sign-in expired");

  // A popup attempt's key, posted to the panel routes.
  const popup = await t.fetch(`/auth/start?origin=${encodeURIComponent(WEB)}&state=s`);
  const key = /name="attempt" value="([^"]+)"/.exec(await popup.text())?.[1] ?? "";
  expect((await call(t, "/auth/panel/email", { attempt: key, email: "dana@example.com" })).status).toBe(410);
});

test("Critiqs's own origins skip the allow page in the popup too; other sites still see it", async () => {
  const t = setup();
  for (const origin of [WEB, EXTENSION]) {
    const page = (await popupSignIn(t, origin)).page;
    expect(page).not.toContain("Allow this site to use Critiqs?");
    expect(page).toContain("critiqs:sign-in");
    expect(page).toContain(JSON.stringify(origin));
  }
  expect((await popupSignIn(t, PROTOTYPE)).page).toContain("Allow this site to use Critiqs?");
  expect(await t.run(async (ctx) => await ctx.db.query("siteGrants").collect())).toEqual([]);
});

test("a reviewer who allowed a site keeps that grant; panel sign-in changes no other site's rule", async () => {
  const t = setup();
  // Allow the prototype once through the popup.
  const first = await popupSignIn(t, PROTOTYPE);
  expect(first.page).toContain("Allow this site to use Critiqs?");
  const consent = /name="consent" value="([^"]+)"/.exec(first.page)?.[1] ?? "";
  expect(await (await first.post("/auth/consent", { attempt: first.key, consent, decision: "allow" })).text()).toContain("accessToken");
  // Sign in through a panel meanwhile.
  expect((await signIn(t)).status).toBe("signed-in");
  // The prototype's grant still stands: no allow page.
  const again = await popupSignIn(t, PROTOTYPE);
  expect(again.page).not.toContain("Allow this site to use Critiqs?");
  expect(again.page).toContain("accessToken");
  // Another site still asks.
  expect((await popupSignIn(t, "https://another.example")).page).toContain("Allow this site to use Critiqs?");
  const grants = await t.run(async (ctx) => (await ctx.db.query("siteGrants").collect()).map((grant) => grant.origin));
  expect(grants).toEqual([PROTOTYPE]);
});

test("with email configured, the code is emailed, naming the panel, and never returned", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  delete process.env.CRITIQS_DEV_SIGN_IN;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <sign-in@critiqs.example>";
  const sent: { body: any; idempotencyKey: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://api.resend.com/")) {
      sent.push({ body: JSON.parse(String(init?.body)), idempotencyKey: new Headers(init?.headers).get("Idempotency-Key") ?? "" });
      return Response.json({ id: "email_1" });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
  try {
    const t = setup();
    const web = await json(await call(t, "/auth/panel/email", { email: "dana@example.com" }, WEB));
    expect(web.developmentCode).toBeUndefined();
    const extension = await json(await call(t, "/auth/panel/email", { email: "lee@example.com" }, EXTENSION));
    expect(extension.developmentCode).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.text).toContain(WEB);
    expect(sent[1]!.body.text).toContain("Critiqs's browser extension");
    expect(sent[1]!.body.text).not.toContain("chrome-extension://");
    // The email points to the panel, not a sign-in window.
    for (const mail of sent) {
      expect(mail.body.text).toContain("Only type it into the Critiqs panel where you asked for it.");
      expect(mail.body.text).not.toContain("sign-in window");
    }
    // The mail provider never sees the attempt key the panel holds.
    expect(sent.map((mail) => mail.idempotencyKey).join(" ")).not.toContain(web.attempt);
    expect(sent.map((mail) => mail.idempotencyKey).join(" ")).not.toContain(extension.attempt);
    const code = String(sent[0]!.body.subject).slice(0, 6);
    expect((await json(await call(t, "/auth/panel/code", { attempt: web.attempt, code }, WEB))).status).toBe("needs-name");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a code that couldn't be sent is reported", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  delete process.env.CRITIQS_DEV_SIGN_IN;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <sign-in@critiqs.example>";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("https://api.resend.com/") ? new Response("nope", { status: 422 }) : realFetch(input as Request, init)) as typeof fetch;
  try {
    const response = await call(setup(), "/auth/panel/email", { email: "dana@example.com" });
    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({ error: "send-failed" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("panel sign-in is unavailable where sign-in is, and development codes never show on a shared address", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  const response = await call(setup(), "/auth/panel/email", { email: "dana@example.com" });
  expect(response.status).toBe(503);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
  expect(await json(response)).toMatchObject({ error: "unavailable" });
});

test("the configuration says panels can sign in", async () => {
  const config = await json(await setup().fetch("/critiqs/config"));
  expect(config.panelSignIn).toBe(true);
});

test("a panel signs in and out end to end with Critiqs's panel client", async () => {
  const t = setup();
  // As a browser sends it from the panel: the page's origin in every request.
  const client = panelSignIn(LOCAL, {
    fetch: (input, init) => t.fetch(input.pathname, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: EXTENSION } }),
  });
  expect(await client.available()).toBe(true);
  const sent = await client.sendCode("newcomer@example.com");
  const wrong = await client.checkCode(sent.attempt, wrongCode(sent.developmentCode!)).catch((error: unknown) => error);
  expect(wrong).toBeInstanceOf(PanelSignInError);
  expect(wrong).toMatchObject({ code: "wrong-code", guessesLeft: 4 });
  expect(await client.checkCode(sent.attempt, sent.developmentCode!)).toEqual({ status: "needs-name" });
  const session = await client.chooseName(sent.attempt, "New Person");
  expect(session.reviewer).toMatchObject({ name: "New Person", email: "newcomer@example.com" });
  expect(claimsOf(session.accessToken).origin).toBe(EXTENSION);

  await client.setDisplayName(session.refreshToken, "Newer Person");
  const renewed = await client.refresh(session.refreshToken);
  expect(claimsOf(renewed.accessToken).name).toBe("Newer Person");
  expect(await client.signOut(renewed.refreshToken)).toBe(true);
  expect(await client.refresh(renewed.refreshToken).catch((error: PanelSignInError) => error.code)).toBe("signed-out");
});

test("session routes let another origin read whether sign-out found the session", async () => {
  const response = await call(setup(), "/auth/sign-out", { refreshToken: "none" }, EXTENSION);
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Critiqs-Session-Ended");
  expect(response.headers.get("Critiqs-Session-Ended")).toBe("false");
});

test("only digests of a panel's attempt key are stored", async () => {
  const t = setup();
  const { attempt } = await sendCode(t);
  const stored = JSON.stringify(await t.run(async (ctx) => await ctx.db.query("signInAttempts").collect()));
  expect(stored).not.toContain(attempt);
});

test("removing a panel origin ends its sessions, which no grant backs; other sessions continue", async () => {
  const t = setup();
  const panel = await signIn(t, "dana@example.com", "Dana", WEB);
  const extension = await signIn(t, "lee@example.com", "Lee", EXTENSION);
  // A site the reviewer allowed through the popup keeps its own grant.
  process.env.CRITIQS_WEB_ORIGINS = "";
  process.env.CRITIQS_EXTENSION_IDS = EXTENSION_ID;
  expect((await call(t, "/auth/refresh", { refreshToken: panel.refreshToken }, WEB)).status).toBe(401);
  expect((await call(t, "/auth/profile", { refreshToken: panel.refreshToken, name: "Mallory" }, WEB)).status).toBe(401);
  const stillAllowed = await call(t, "/auth/refresh", { refreshToken: extension.refreshToken }, EXTENSION);
  expect(stillAllowed.status).toBe(200);
  // Putting the origin back doesn't revive the ended session.
  process.env.CRITIQS_WEB_ORIGINS = WEB;
  expect((await call(t, "/auth/refresh", { refreshToken: panel.refreshToken }, WEB)).status).toBe(401);
});

test("a popup session backed by a site grant doesn't depend on the panel settings", async () => {
  process.env.CRITIQS_WEB_ORIGINS = "";
  const t = setup();
  const first = await popupSignIn(t, PROTOTYPE);
  const consent = /name="consent" value="([^"]+)"/.exec(first.page)?.[1] ?? "";
  const page = await (await first.post("/auth/consent", { attempt: first.key, consent, decision: "allow" })).text();
  const refreshToken = JSON.parse(/const \{ message, origin \} = (.*);/.exec(page)![1]!).message.refreshToken as string;
  expect((await call(t, "/auth/refresh", { refreshToken }, PROTOTYPE)).status).toBe(200);
});

test("a panel can ask whether it can sign in here: only allowed origins, and only where codes can be sent", async () => {
  const t = setup();
  // A POST, since browsers send Origin with every POST, even to the same origin.
  const status = (origin: string | null) => call(t, "/auth/panel/status", {}, origin);
  const allowed = await status(WEB);
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
  expect(await json(allowed)).toEqual({ ready: true });
  const preflight = await t.fetch("/auth/panel/status", { method: "OPTIONS", headers: { Origin: EXTENSION, "Access-Control-Request-Method": "POST" } });
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION);
  for (const origin of [PROTOTYPE, OTHER_EXTENSION, null]) {
    const refused = await status(origin);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBeNull();
  }
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  const unavailable = await status(EXTENSION);
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("Access-Control-Allow-Origin")).toBe(EXTENSION);
});

test("cleanup ends consent-free sessions of a removed origin, so adding it back doesn't revive them", async () => {
  const t = setup();
  const web = await signIn(t, "dana@example.com", "Dana", WEB);
  const extension = await signIn(t, "lee@example.com", "Lee", EXTENSION);
  const kept = await signIn(t, "kim@example.com", "Kim", "http://localhost:5299");
  // A prototype session backed by a site grant.
  const first = await popupSignIn(t, PROTOTYPE);
  const consent = /name="consent" value="([^"]+)"/.exec(first.page)?.[1] ?? "";
  const page = await (await first.post("/auth/consent", { attempt: first.key, consent, decision: "allow" })).text();
  const prototypeToken = JSON.parse(/const \{ message, origin \} = (.*);/.exec(page)![1]!).message.refreshToken as string;

  // Both panel origins removed, then the hourly cleanup runs, with no request in between.
  process.env.CRITIQS_WEB_ORIGINS = "http://localhost:5299";
  delete process.env.CRITIQS_EXTENSION_IDS;
  await t.mutation(internal.signIn.cleanUp, {});
  await t.finishAllScheduledFunctions(() => {});
  process.env.CRITIQS_WEB_ORIGINS = `${WEB}, http://localhost:5299`;
  process.env.CRITIQS_EXTENSION_IDS = EXTENSION_ID;

  expect((await call(t, "/auth/refresh", { refreshToken: web.refreshToken }, WEB)).status).toBe(401);
  expect((await call(t, "/auth/refresh", { refreshToken: extension.refreshToken }, EXTENSION)).status).toBe(401);
  expect((await call(t, "/auth/refresh", { refreshToken: kept.refreshToken }, "http://localhost:5299")).status).toBe(200);
  expect((await call(t, "/auth/refresh", { refreshToken: prototypeToken }, PROTOTYPE)).status).toBe(200);
});

test("an operator can end every consent-free session of one origin at once", async () => {
  const t = setup();
  const web = await signIn(t, "dana@example.com", "Dana", WEB);
  const extension = await signIn(t, "lee@example.com", "Lee", EXTENSION);
  expect(await t.mutation(internal.signIn.endPanelSessions, { origin: WEB })).toBe(1);
  expect((await call(t, "/auth/refresh", { refreshToken: web.refreshToken }, WEB)).status).toBe(401);
  expect((await call(t, "/auth/refresh", { refreshToken: extension.refreshToken }, EXTENSION)).status).toBe(200);
});

test("the body limit counts bytes, so multibyte text can't exceed it", async () => {
  const t = setup();
  // Under 4096 characters, but over 4096 bytes.
  const body = JSON.stringify({ email: "dana@example.com", pad: "é".repeat(2200) });
  expect(body.length).toBeLessThan(4096);
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(4096);
  const response = await call(t, "/auth/panel/email", body);
  expect(response.status).toBe(400);
  expect(await t.run(async (ctx) => await ctx.db.query("signInAttempts").collect())).toEqual([]);
});
