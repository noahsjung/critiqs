import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { issueAccessToken } from "../convex/lib/tokens";
import { setup } from "./harness";

const HOSTED = "https://critiqs-auth.example";
const LOCAL = "http://127.0.0.1:3211";
const PROTOTYPE = "https://proto.example";

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  process.env.CRITIQS_AUTH_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
});

afterEach(() => {
  delete process.env.CRITIQS_DEV_SIGN_IN;
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
});

/** Development sign-in on a local deployment, which is the only place it runs. */
function local() {
  process.env.CRITIQS_AUTH_ISSUER = LOCAL;
  process.env.CRITIQS_DEV_SIGN_IN = "enabled";
  return setup();
}

type Test = ReturnType<typeof setup>;

/** A popup in one browser: its attempt key and the cookie that binds it. */
async function start(t: Test, origin = PROTOTYPE) {
  const response = await t.fetch(`/auth/start?origin=${encodeURIComponent(origin)}&state=nonce-1`);
  const page = await response.text();
  const key = /name="attempt" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const cookie = (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return { key, cookie, page, status: response.status };
}

function post(t: Test, path: string, fields: Record<string, string>, cookie = "") {
  return t.fetch(path, { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(fields).toString() });
}

/** Signs in with a development code shown on the page; returns the page after the code (and name, if asked). */
async function signIn(t: Test, popup: { key: string; cookie: string }, email = "dana@example.com", name = "Dana") {
  const sent = await (await post(t, "/auth/email", { attempt: popup.key, email }, popup.cookie)).text();
  const code = developmentCode(sent);
  if (code === undefined) return sent;
  let page = await (await post(t, "/auth/code", { attempt: popup.key, code }, popup.cookie)).text();
  if (page.includes("Choose your display name")) {
    page = await (await post(t, "/auth/name", { attempt: popup.key, name }, popup.cookie)).text();
  }
  return page;
}

function developmentCode(page: string) {
  return /id="development-code">(\d{6})</.exec(page)?.[1];
}

function consentToken(page: string) {
  return /name="consent" value="([^"]+)"/.exec(page)?.[1] ?? "";
}

function delivered(page: string) {
  const json = /const \{ message, origin \} = (.*);/.exec(page)?.[1];
  return json === undefined ? null : (JSON.parse(json) as { origin: string; message: Record<string, any> });
}

async function allow(t: Test, popup: { key: string; cookie: string }, consentPage: string, decision = "allow") {
  const fields = { attempt: popup.key, consent: consentToken(consentPage), decision };
  return delivered(await (await post(t, "/auth/consent", fields, popup.cookie)).text());
}

test("tokens carry the reviewer's verified email and verify with the published key", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  const t = setup();
  const profile = { subject: "workos|user_1", name: "Dana", email: "dana@example.com", pictureUrl: null };
  const { accessToken } = await issueAccessToken(HOSTED, profile, PROTOTYPE);
  const [header, payload, signature] = accessToken.split(".") as [string, string, string];
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  expect(claims).toMatchObject({ iss: HOSTED, aud: "critiqs", sub: "workos|user_1", email_verified: true, origin: PROTOTYPE });

  const { keys } = await (await t.fetch("/.well-known/jwks.json")).json();
  const key = await crypto.subtle.importKey("jwk", keys[0], { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    bytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
});

test("sign-in is unavailable unless a provider is configured", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  expect((await start(setup())).status).toBe(503);
});

test("development sign-in never runs on a non-local deployment", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  process.env.CRITIQS_DEV_SIGN_IN = "enabled";
  expect((await start(setup())).status).toBe(503);
});

test("the first sign-in from a site asks the reviewer to allow it, then delivers only to that site", async () => {
  const t = local();
  const popup = await start(t);
  expect(popup.cookie).toStartWith("critiqs_sign_in=");
  const consent = await signIn(t, popup);
  expect(consent).toContain("Allow this site to use Critiqs?");
  expect(consent).toContain(PROTOTYPE);

  const result = await allow(t, popup, consent);
  expect(result?.origin).toBe(PROTOTYPE);
  expect(result?.message).toMatchObject({ type: "critiqs:sign-in", state: "nonce-1" });

  // An attempt is used once.
  const reused = await (await post(t, "/auth/consent", { attempt: popup.key, consent: consentToken(consent), decision: "allow" }, popup.cookie)).text();
  expect(reused).toContain("Sign-in expired");

  // The site is remembered: the next sign-in skips consent.
  const again = await start(t);
  expect(delivered(await signIn(t, again))?.message.accessToken).toBeString();
});

test("a sign-in finishes only in the browser that started it", async () => {
  const t = local();
  const popup = await start(t);
  // Another browser that learned the attempt key cannot sign in on it…
  expect(await signIn(t, { key: popup.key, cookie: "critiqs_sign_in=other" })).toContain("Sign-in expired");
  // …nor approve the victim's pending consent.
  const consent = await signIn(t, popup);
  const stolen = await post(t, "/auth/consent", { attempt: popup.key, consent: consentToken(consent), decision: "allow" });
  expect(delivered(await stolen.text())).toBeNull();
  // Consent also needs its own token.
  const forged = await post(t, "/auth/consent", { attempt: popup.key, consent: "guess", decision: "allow" }, popup.cookie);
  expect(delivered(await forged.text())).toBeNull();
  expect((await allow(t, popup, consent))?.message.accessToken).toBeString();
});

test("a verified attempt cannot be switched to another account", async () => {
  const t = local();
  const popup = await start(t);
  await signIn(t, popup, "dana@example.com");
  expect(await signIn(t, popup, "mallory@example.com")).toContain("Sign-in expired");
});

test("declining consent delivers no tokens", async () => {
  const t = local();
  const popup = await start(t);
  const result = await allow(t, popup, await signIn(t, popup), "cancel");
  expect(result?.message).toEqual({ type: "critiqs:sign-in", state: "nonce-1", error: "cancelled" });
});

test("sessions refresh only from their own site and end at sign-out from that site", async () => {
  const t = local();
  const popup = await start(t);
  const result = await allow(t, popup, await signIn(t, popup));
  let refreshToken = result?.message.refreshToken;
  const call = (path: string, origin: string) =>
    t.fetch(path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }) });

  const ok = await call("/auth/refresh", PROTOTYPE);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(PROTOTYPE);
  const rotated = await ok.json();
  expect(rotated.accessToken).toBeString();
  expect(rotated.refreshToken).not.toBe(refreshToken);
  expect((await call("/auth/refresh", PROTOTYPE)).status).toBe(401);
  refreshToken = rotated.refreshToken;
  expect((await call("/auth/refresh", "https://other.example")).status).toBe(401);

  await call("/auth/sign-out", "https://other.example");
  const again = await call("/auth/refresh", PROTOTYPE);
  expect(again.status).toBe(200);
  refreshToken = (await again.json()).refreshToken;
  await call("/auth/sign-out", PROTOTYPE);
  expect((await call("/auth/refresh", PROTOTYPE)).status).toBe(401);
});

test("sign-in accepts only HTTPS sites, or plain HTTP on this computer", async () => {
  const t = local();
  expect((await start(t, "javascript:alert(1)")).page).toContain("incomplete");
  expect((await start(t, "http://proto.example")).page).toContain("HTTPS");
  expect((await start(t, "http://localhost:5173")).key).not.toBe("");
});

function claimsOf(accessToken: string) {
  const payload = accessToken.split(".")[1] ?? "";
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, any>;
}

async function signInAs(t: Test, email: string, name: string) {
  const popup = await start(t);
  const page = await signIn(t, popup, email, name);
  // A site the reviewer already allowed delivers straight away; otherwise allow it.
  return delivered(page) ?? (await allow(t, popup, page));
}

test("a verified email keeps one permanent reviewer ID and the name chosen at registration", async () => {
  const t = local();
  const first = claimsOf((await signInAs(t, "Dana@Example.com", "Dana"))!.message.accessToken);
  const again = claimsOf((await signInAs(t, "dana@example.com", "Someone else"))!.message.accessToken);
  expect(again.sub).toBe(first.sub);
  expect(again.name).toBe("Dana");
  expect(first.sub).not.toContain("@");
  const lee = claimsOf((await signInAs(t, "lee@example.com", "Lee"))!.message.accessToken);
  expect(lee.sub).not.toBe(first.sub);
});

test("a reviewer can change their display name, which the next token carries", async () => {
  const t = local();
  let { refreshToken } = (await signInAs(t, "dana@example.com", "Dana"))!.message;
  const rename = (name: string, token = refreshToken, origin = PROTOTYPE) =>
    t.fetch("/auth/profile", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: token, name }),
    });
  expect((await rename("   ")).status).toBe(400);
  expect((await rename("x".repeat(61))).status).toBe(400);
  expect((await rename("Dana Kim", refreshToken, "https://other.example")).status).toBe(401);
  expect((await rename("Dana Kim", "not-a-session")).status).toBe(401);
  expect((await rename("  Dana   Kim ")).status).toBe(204);

  const refreshed = await t.fetch("/auth/refresh", {
    method: "POST",
    headers: { Origin: PROTOTYPE, "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const next = await refreshed.json();
  refreshToken = next.refreshToken;
  expect(claimsOf(next.accessToken).name).toBe("Dana Kim");
  // Signing in again keeps the new name.
  expect(claimsOf((await signInAs(t, "dana@example.com", "Dana"))!.message.accessToken).name).toBe("Dana Kim");
});

test("a malformed profile request is refused rather than failing", async () => {
  const t = local();
  for (const body of ["null", "[]", "\"name\"", "{"]) {
    const response = await t.fetch("/auth/profile", {
      method: "POST",
      headers: { Origin: PROTOTYPE, "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
  }
});

test("a session whose reviewer record is gone ends instead of renewing", async () => {
  const t = local();
  const { refreshToken, accessToken } = (await signInAs(t, "dana@example.com", "Dana"))!.message;
  const subject = claimsOf(accessToken).sub as string;
  await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("reviewers", subject);
    if (id !== null) await ctx.db.delete(id);
  });
  const refresh = () =>
    t.fetch("/auth/refresh", {
      method: "POST",
      headers: { Origin: PROTOTYPE, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  expect((await refresh()).status).toBe(401);
  expect((await refresh()).status).toBe(401);
});

test("tokens carry the reviewer's profile version, which a rename increases", async () => {
  const t = local();
  const first = (await signInAs(t, "dana@example.com", "Dana"))!.message;
  expect(claimsOf(first.accessToken).profile_version).toBe(1);
  await t.fetch("/auth/profile", {
    method: "POST",
    headers: { Origin: PROTOTYPE, "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: first.refreshToken, name: "Dana Kim" }),
  });
  const next = await (
    await t.fetch("/auth/refresh", {
      method: "POST",
      headers: { Origin: PROTOTYPE, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    })
  ).json();
  expect(claimsOf(next.accessToken)).toMatchObject({ name: "Dana Kim", profile_version: 2 });
});

// Email codes

async function sendCode(t: Test, popup: { key: string; cookie: string }, email = "dana@example.com") {
  return await (await post(t, "/auth/email", { attempt: popup.key, email }, popup.cookie)).text();
}

async function typeCode(t: Test, popup: { key: string; cookie: string }, code: string) {
  return await (await post(t, "/auth/code", { attempt: popup.key, code }, popup.cookie)).text();
}

function wrongCode(code: string) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

test("a wrong code uses up one of five tries, after which the sign-in is locked", async () => {
  const t = local();
  const popup = await start(t);
  const code = developmentCode(await sendCode(t, popup))!;
  for (let left = 4; left >= 1; left--) {
    expect(await typeCode(t, popup, wrongCode(code))).toContain(`${left} ${left === 1 ? "try" : "tries"} left`);
  }
  expect(await typeCode(t, popup, wrongCode(code))).toContain("Too many wrong codes");
  // Even the right code no longer works, and a new code can't reset the count.
  expect(await typeCode(t, popup, code)).toContain("Too many wrong codes");
  expect(await sendCode(t, popup)).toContain("Too many wrong codes");
});

test("a code can be typed with spaces, and malformed codes don't use up tries", async () => {
  const t = local();
  const popup = await start(t);
  const code = developmentCode(await sendCode(t, popup))!;
  expect(await typeCode(t, popup, "12ab")).toContain("Enter the 6-digit code");
  const consent = await typeCode(t, popup, `${code.slice(0, 3)} ${code.slice(3)}`);
  expect(consent).toContain("Choose your display name");
});

test("a new code replaces the previous one, and each window sends at most three", async () => {
  const t = local();
  const popup = await start(t);
  const first = developmentCode(await sendCode(t, popup))!;
  const second = developmentCode(await sendCode(t, popup))!;
  expect(await typeCode(t, popup, first === second ? wrongCode(first) : first)).toContain("4 tries left");
  const third = developmentCode(await sendCode(t, popup))!;
  const refused = await sendCode(t, popup);
  expect(refused).toContain("No more codes can be sent from this window");
  expect(developmentCode(refused)).toBeUndefined();
  expect(await typeCode(t, popup, third)).toContain("Choose your display name");
});

test("an address receives at most five codes in fifteen minutes, across sign-in windows", async () => {
  const t = local();
  for (let i = 0; i < 5; i++) expect(developmentCode(await sendCode(t, await start(t)))).toBeDefined();
  const response = await post(t, "/auth/email", { attempt: (await start(t)).key, email: "dana@example.com" });
  const refusedPopup = await start(t);
  const refused = await post(t, "/auth/email", { attempt: refusedPopup.key, email: "DANA@example.com" }, refusedPopup.cookie);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(response.status).toBe(400);
  // Other addresses are unaffected.
  expect(developmentCode(await sendCode(t, await start(t), "lee@example.com"))).toBeDefined();
});

test("a code expires after ten minutes", async () => {
  const t = local();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const popup = await start(t);
    const code = developmentCode(await sendCode(t, popup))!;
    now += 10 * 60 * 1000 + 1;
    expect(await typeCode(t, popup, code)).toContain("That code has expired");
    const fresh = developmentCode(await sendCode(t, popup))!;
    expect(await typeCode(t, popup, fresh)).toContain("Choose your display name");
  } finally {
    clock.mockRestore();
  }
});

test("the code page reads the same whether or not the address has signed in before", async () => {
  const t = local();
  await signInAs(t, "dana@example.com", "Dana");
  const known = await sendCode(t, await start(t), "dana@example.com");
  const unknown = await sendCode(t, await start(t), "newcomer@example.com");
  const scrub = (page: string) =>
    page
      .replace(/dana@example\.com|newcomer@example\.com/g, "ADDRESS")
      .replace(/value="[^"]+"/g, 'value="…"')
      .replace(/id="development-code">\d{6}</, 'id="development-code">CODE<');
  expect(scrub(known)).toBe(scrub(unknown));
});

test("a new reviewer must choose a valid display name; a returning one is not asked", async () => {
  const t = local();
  const popup = await start(t);
  const code = developmentCode(await sendCode(t, popup, "newcomer@example.com"))!;
  expect(await typeCode(t, popup, code)).toContain("Choose your display name");
  const invalid = await (await post(t, "/auth/name", { attempt: popup.key, name: "   " }, popup.cookie)).text();
  expect(invalid).toContain("1 to 60 characters");
  const consent = await (await post(t, "/auth/name", { attempt: popup.key, name: "New Person" }, popup.cookie)).text();
  expect(consent).toContain("New Person");
  expect(consent).toContain("Allow this site to use Critiqs?");
  const result = await allow(t, popup, consent);
  expect(claimsOf(result!.message.accessToken).name).toBe("New Person");

  const again = await start(t);
  const returning = await typeCode(t, again, developmentCode(await sendCode(t, again, "newcomer@example.com"))!);
  expect(delivered(returning)?.message.accessToken).toBeString();
});

test("only a keyed digest of the code is stored", async () => {
  const t = local();
  const popup = await start(t);
  const code = developmentCode(await sendCode(t, popup))!;
  const stored = await t.run(async (ctx) => ctx.db.query("signInAttempts").withIndex("by_key", (q) => q.eq("key", popup.key)).unique());
  expect(stored?.codeDigest).toBeString();
  expect(JSON.stringify(stored)).not.toContain(code);
});

test("with Resend configured, the code is emailed and never shown in the window", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <sign-in@critiqs.example>";
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.resend.com/")) {
      sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "email_1" });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
  try {
    const t = setup();
    const popup = await start(t);
    const page = await sendCode(t, popup);
    expect(developmentCode(page)).toBeUndefined();
    expect(page).toContain("a 6-digit code is on its way");
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail!.headers.authorization).toBe("Bearer re_test_key");
    expect(mail!.headers["idempotency-key"]).toBe(`${popup.key}:1`);
    expect(mail!.body).toMatchObject({ from: "Critiqs <sign-in@critiqs.example>", to: ["dana@example.com"] });
    const code = /is your Critiqs sign-in code/.test(mail!.body.subject) ? mail!.body.subject.slice(0, 6) : "";
    expect(mail!.body.text).toContain(PROTOTYPE);
    expect(await typeCode(t, popup, code)).toContain("Choose your display name");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.CRITIQS_EMAIL_FROM;
  }
});

test("a code that couldn't be sent is reported, and no code is shown", async () => {
  process.env.CRITIQS_AUTH_ISSUER = HOSTED;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <sign-in@critiqs.example>";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("https://api.resend.com/") ? new Response("nope", { status: 422 }) : realFetch(input as Request, init)) as typeof fetch;
  try {
    const t = setup();
    const page = await sendCode(t, await start(t));
    expect(page).toContain("The code couldn&#39;t be sent");
    expect(developmentCode(page)).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.CRITIQS_EMAIL_FROM;
  }
});

test("a session ends ninety days after sign-in, however often it is used, and so do its tokens", async () => {
  const t = local();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const day = 24 * 60 * 60 * 1000;
  try {
    const signedInAt = now;
    let { refreshToken } = (await signInAs(t, "dana@example.com", "Dana"))!.message;
    const refresh = () =>
      t.fetch("/auth/refresh", {
        method: "POST",
        headers: { Origin: PROTOTYPE, "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    for (const at of [20, 40, 60, 80]) {
      now = signedInAt + at * day;
      const response = await refresh();
      expect(response.status).toBe(200);
      refreshToken = (await response.json()).refreshToken;
    }
    // One minute before the end: still works, but the token stops at the end.
    now = signedInAt + 90 * day - 60_000;
    const last = await refresh();
    expect(last.status).toBe(200);
    const body = await last.json();
    refreshToken = body.refreshToken;
    expect(body.expiresAt).toBeLessThanOrEqual(signedInAt + 90 * day);
    expect(claimsOf(body.accessToken).exp * 1000).toBeLessThanOrEqual(signedInAt + 90 * day);
    now = signedInAt + 90 * day + 1;
    expect((await refresh()).status).toBe(401);
  } finally {
    clock.mockRestore();
  }
});

test("a session from before absolute ends is limited to ninety days from sign-in, for refresh and profile changes", async () => {
  const t = local();
  const { refreshToken } = (await signInAs(t, "dana@example.com", "Dana"))!.message;
  const day = 24 * 60 * 60 * 1000;
  // As stored before sessions recorded their end: signed in 100 days ago, used yesterday.
  await t.run(async (ctx) => {
    for (const session of await ctx.db.query("sessions").collect()) {
      await ctx.db.replace(session._id, {
        refreshHash: session.refreshHash,
        origin: session.origin,
        profile: session.profile,
        createdAt: Date.now() - 100 * day,
        expiresAt: Date.now() + day,
      });
    }
  });
  const call = (path: string, body: object) =>
    t.fetch(path, { method: "POST", headers: { Origin: PROTOTYPE, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await call("/auth/profile", { refreshToken, name: "Someone else" })).status).toBe(401);
  expect((await call("/auth/refresh", { refreshToken })).status).toBe(401);
});

test("sign-in attempts stored before email codes still fit the schema", async () => {
  const t = local();
  await t.run(async (ctx) => {
    await ctx.db.insert("signInAttempts", {
      key: "legacy",
      origin: PROTOTYPE,
      clientState: "s",
      bindingHash: "b",
      codeVerifier: "from WorkOS sign-in",
      createdAt: Date.now(),
    });
  });
});
