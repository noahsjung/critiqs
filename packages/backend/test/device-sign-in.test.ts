import { afterEach, beforeAll, expect, test } from "bun:test";
import { DEVICE_BEGIN_LIMIT, DEVICE_BEGIN_PER_GRANT_LIMIT, DEVICE_MISS_LIMIT } from "../convex/deviceSignIn";
import { setup } from "./harness";

// Approving setup from another device: the command line polls with a secret
// while a person signs in and approves in a browser elsewhere.

const LOCAL = "http://127.0.0.1:3211";

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  process.env.CRITIQS_AUTH_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
});

afterEach(() => {
  delete process.env.CRITIQS_DEV_SIGN_IN;
  delete process.env.CRITIQS_AUTH_ISSUER;
});

function local() {
  process.env.CRITIQS_AUTH_ISSUER = LOCAL;
  process.env.CRITIQS_DEV_SIGN_IN = "enabled";
  return setup();
}

type Test = ReturnType<typeof setup>;

function form(t: Test, path: string, fields: Record<string, string>, cookie = "") {
  return t.fetch(path, { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(fields).toString() });
}

/** What the command line does first. */
async function startDevice(t: Test) {
  const response = await t.fetch("/auth/device/start", { method: "POST", body: "{}" });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function poll(t: Test, deviceCode: string) {
  const response = await t.fetch("/auth/device/token", { method: "POST", body: JSON.stringify({ deviceCode }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** In a browser: types the setup code and signs in with a development code; returns the approval page and the browser's cookie. */
async function approveIn(t: Test, userCode: string, email = "dana@example.com", name = "Dana") {
  const entered = await form(t, "/auth/device", { user_code: userCode.toLowerCase().replace("-", " ") });
  const cookie = (entered.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const emailPage = await entered.text();
  const attempt = /name="attempt" value="([^"]+)"/.exec(emailPage)?.[1] ?? "";
  const sent = await (await form(t, "/auth/email", { attempt, email }, cookie)).text();
  const code = /id="development-code">(\d{6})</.exec(sent)?.[1] ?? "";
  let page = await (await form(t, "/auth/code", { attempt, code }, cookie)).text();
  if (page.includes("Choose your display name")) page = await (await form(t, "/auth/name", { attempt, name }, cookie)).text();
  const consent = /name="consent" value="([^"]+)"/.exec(page)?.[1] ?? "";
  return { page, emailPage, cookie, attempt, consent };
}

const decide = (t: Test, approval: { attempt: string; consent: string; cookie: string }, decision: string, cookie = approval.cookie) =>
  form(t, "/auth/device/decision", { attempt: approval.attempt, consent: approval.consent, decision }, cookie).then((r) => r.text());

test("the sign-in service declares remote approval, and starts grants with no secret in any address", async () => {
  const t = local();
  expect((await (await t.fetch("/critiqs/config")).json()).deviceSignIn).toBe(true);
  // Older components ignore what they don't know; newer ones offer Your AI only where this is set.
  expect((await (await t.fetch("/critiqs/config")).json()).personalAi).toBe(true);
  expect((await (await t.fetch("/critiqs/config")).json()).modelLists).toBe(true);
  expect((await (await t.fetch("/critiqs/config")).json()).overageCap).toBe(true);
  const { status, body } = await startDevice(t);
  expect(status).toBe(200);
  expect(body.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  expect(body.deviceCode.length).toBeGreaterThanOrEqual(43);
  expect(body.verificationUrl).toBe(`${LOCAL}/auth/device`);
  expect(body.verificationUrl).not.toContain(body.deviceCode);
  expect(body).toMatchObject({ expiresIn: 600, interval: 5 });
  // Only hashes are stored.
  const stored = await t.run(async (ctx) => await ctx.db.query("deviceGrants").collect());
  expect(JSON.stringify(stored)).not.toContain(body.deviceCode);
  expect(JSON.stringify(stored)).not.toContain(body.userCode.replace("-", ""));
});

test("approval in another browser gives the command line one short-lived token, and no session", async () => {
  const t = local();
  const { body } = await startDevice(t);
  expect((await poll(t, body.deviceCode)).body).toEqual({ error: "authorization_pending", interval: 5 });

  const approval = await approveIn(t, body.userCode);
  expect(approval.emailPage).toContain("approve Critiqs setup started on another device");
  expect(approval.page).toContain("Approve Critiqs setup?");
  expect(approval.page).toContain("dana@example.com");
  // Still pending until approved.
  await t.run(async (ctx) => {
    for (const grant of await ctx.db.query("deviceGrants").collect()) await ctx.db.patch(grant._id, { lastPolledAt: 0 });
  });
  expect((await poll(t, body.deviceCode)).body.error).toBe("authorization_pending");

  expect(await decide(t, approval, "approve")).toContain("Setup approved");
  const granted = await poll(t, body.deviceCode);
  expect(granted.status).toBe(200);
  expect(granted.body.accessToken).toBeString();
  expect(granted.body.refreshToken).toBeUndefined();
  expect(granted.body.reviewer).toEqual({ name: "Dana", email: "dana@example.com" });
  const claims = JSON.parse(atob(granted.body.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);
  // Used once: a replay gets nothing.
  expect((await poll(t, body.deviceCode)).body.error).toBe("invalid_grant");
  // An approval is neither a site grant nor a session.
  const [grants, sessions] = await t.run(async (ctx) => [await ctx.db.query("siteGrants").collect(), await ctx.db.query("sessions").collect()]);
  expect(grants).toEqual([]);
  expect(sessions).toEqual([]);
  // Its answer can't be given twice.
  expect(await decide(t, approval, "approve")).toContain("Setup approval expired");
});

test("the approval page names the backend the command line signs in for and where it serves downloads, and says so to the command line", async () => {
  const t = local();
  for (const [body, backend, site, line] of [
    [
      { keepSignedIn: true, backend: "https://team.convex.cloud/some/path", site: "https://team.convex.site/x" },
      "https://team.convex.cloud",
      "https://team.convex.site",
      "This is for the Critiqs backend at <strong>https://team.convex.cloud</strong>, which serves screenshots and page copies from <strong>https://team.convex.site</strong>. Approve only if you recognize these addresses.",
    ],
    [
      { keepSignedIn: true, backend: "https://team.example:8443", site: "https://team.example:8444" },
      "https://team.example:8443",
      "https://team.example:8444",
      "This is for the Critiqs backend at <strong>https://team.example:8443</strong>, which serves screenshots and page copies from <strong>https://team.example:8444</strong>.",
    ],
    [
      { backend: "http://127.0.0.1:3210" },
      "http://127.0.0.1:3210",
      null,
      "This is for the Critiqs backend at <strong>http://127.0.0.1:3210</strong>. Approve only if you recognize this address.",
    ],
    // Not a web address, a download address without a backend, or from an older command line that doesn't say: nothing is named.
    [{ keepSignedIn: true, backend: "javascript:alert(1)", site: "https://team.convex.site" }, null, null, null],
    [{ keepSignedIn: true }, null, null, null],
  ] as const) {
    const response = await t.fetch("/auth/device/start", { method: "POST", body: JSON.stringify(body) });
    const started = (await response.json()) as { userCode: string; deviceCode: string; backend: unknown; site: unknown };
    // What the page will name, so the command line can refuse a service that wouldn't.
    expect({ backend: started.backend, site: started.site }).toEqual({ backend, site });
    const approval = await approveIn(t, started.userCode);
    if (line === null) expect(approval.page).not.toContain("Critiqs backend at");
    else expect(approval.page).toContain(line);
    // The grant names it again, with the tokens.
    expect(await decide(t, approval, "approve")).toContain("approved");
    await t.run(async (ctx) => {
      for (const grant of await ctx.db.query("deviceGrants").collect()) await ctx.db.patch(grant._id, { lastPolledAt: 0 });
    });
    const granted = await poll(t, started.deviceCode);
    expect(granted.status).toBe(200);
    expect({ backend: granted.body.backend, site: granted.body.site }).toEqual({ backend, site });
  }
});

test("denial ends the grant, and the command line is told once", async () => {
  const t = local();
  const { body } = await startDevice(t);
  expect(await decide(t, await approveIn(t, body.userCode), "deny")).toContain("Setup denied");
  expect((await poll(t, body.deviceCode)).body.error).toBe("access_denied");
  expect((await poll(t, body.deviceCode)).body.error).toBe("invalid_grant");
});

test("expired grants can't be approved or redeemed", async () => {
  const t = local();
  const { body } = await startDevice(t);
  const approval = await approveIn(t, body.userCode);
  await t.run(async (ctx) => {
    for (const grant of await ctx.db.query("deviceGrants").collect()) await ctx.db.patch(grant._id, { expiresAt: Date.now() - 1 });
  });
  expect(await decide(t, approval, "approve")).toContain("Setup approval expired");
  expect((await poll(t, body.deviceCode)).body.error).toBe("expired_token");
  // The expired code no longer starts an approval.
  const again = await form(t, "/auth/device", { user_code: body.userCode });
  expect(again.status).toBe(400);
  expect(await again.text()).toContain("isn&#39;t waiting for approval");
});

test("another browser, another grant's secret, or a site sign-in can't use an approval", async () => {
  const t = local();
  const first = (await startDevice(t)).body;
  const second = (await startDevice(t)).body;
  const approval = await approveIn(t, first.userCode);
  // Another browser can't answer this browser's approval…
  expect(await decide(t, approval, "approve", "critiqs_sign_in=other")).toContain("Setup approval expired");
  // …and the approval page's token can't finish a site sign-in.
  const consent = await form(t, "/auth/consent", { attempt: approval.attempt, consent: approval.consent, decision: "allow" }, approval.cookie);
  expect(await consent.text()).toContain("Sign-in expired");
  // The browser that signed in still can.
  expect(await decide(t, approval, "approve")).toContain("Setup approved");
  // The other grant stays pending: its own secret gets nothing yet, and a made-up one gets nothing ever.
  expect((await poll(t, second.deviceCode)).body.error).toBe("authorization_pending");
  expect((await poll(t, "not-a-device-code")).body.error).toBe("invalid_grant");
  expect((await poll(t, first.deviceCode)).status).toBe(200);
});

test("polling faster than asked slows the command line down", async () => {
  const t = local();
  const { body } = await startDevice(t);
  expect((await poll(t, body.deviceCode)).body.error).toBe("authorization_pending");
  expect((await poll(t, body.deviceCode)).body).toEqual({ error: "slow_down", interval: 10 });
});

test("wrong setup codes are limited across the deployment, so codes can't be guessed", async () => {
  const t = local();
  const { body } = await startDevice(t);
  expect((await form(t, "/auth/device", { user_code: "12" })).status).toBe(400);
  for (let i = 0; i < DEVICE_MISS_LIMIT; i++) await form(t, "/auth/device", { user_code: "BBBB-BBBB" });
  const limited = await form(t, "/auth/device", { user_code: body.userCode });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).not.toBeNull();
});

test("remote approval is unavailable where sign-in is", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "https://critiqs-auth.example";
  const t = setup();
  expect((await startDevice(t)).status).toBe(503);
  expect((await t.fetch("/auth/device")).status).toBe(503);
});

test("a valid setup code has a transactional browser-attempt limit", async () => {
  const t = local();
  const { body } = await startDevice(t);
  const starts = await Promise.all(Array.from({ length: DEVICE_BEGIN_PER_GRANT_LIMIT + 4 }, () => form(t, "/auth/device", { user_code: body.userCode })));
  expect(starts.filter((response) => response.status === 200)).toHaveLength(DEVICE_BEGIN_PER_GRANT_LIMIT);
  expect(starts.filter((response) => response.status === 429)).toHaveLength(4);
  expect(Number(starts.find((response) => response.status === 429)!.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await t.run(async (ctx) => (await ctx.db.query("signInAttempts").collect()).length)).toBe(DEVICE_BEGIN_PER_GRANT_LIMIT);
  // The limit expires: a person can retry without discarding their waiting grant.
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("signInLimits").collect()) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });
  expect((await form(t, "/auth/device", { user_code: body.userCode })).status).toBe(200);
});

test("valid codes also share the deployment-wide browser-attempt limit", async () => {
  const t = local();
  const { body } = await startDevice(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("signInLimits", { key: "device-begin:global", count: DEVICE_BEGIN_LIMIT, expiresAt: Date.now() + 60_000 });
  });
  expect((await form(t, "/auth/device", { user_code: body.userCode })).status).toBe(429);
  expect(await t.run(async (ctx) => await ctx.db.query("signInAttempts").collect())).toEqual([]);
});

test("cleanup removes expired grants", async () => {
  const t = local();
  await startDevice(t);
  await t.run(async (ctx) => {
    for (const grant of await ctx.db.query("deviceGrants").collect()) await ctx.db.patch(grant._id, { expiresAt: Date.now() - 1 });
  });
  const { internal } = await import("../convex/_generated/api");
  await t.mutation(internal.signIn.cleanUp, {});
  expect(await t.run(async (ctx) => await ctx.db.query("deviceGrants").collect())).toEqual([]);
});

// `critiqs sign-in`: the same approval, asked to keep the command line signed in.

async function startAccess(t: Test) {
  const response = await t.fetch("/auth/device/start", { method: "POST", body: JSON.stringify({ keepSignedIn: true }) });
  return (await response.json()) as Record<string, any>;
}

const refresh = (t: Test, refreshToken: string, origin = LOCAL) =>
  t.fetch("/auth/refresh", { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ refreshToken }) });

test("the sign-in service declares that an approval can keep a command line signed in", async () => {
  const t = local();
  expect((await (await t.fetch("/critiqs/config")).json()).deviceSessions).toBe(true);
});

test("an access approval says what it allows and for how long, then keeps the command line signed in", async () => {
  const t = local();
  const body = await startAccess(t);
  const approval = await approveIn(t, body.userCode);
  expect(approval.emailPage).toContain("approve Critiqs access for a command line or coding agent");
  expect(approval.page).toContain("Approve Critiqs access?");
  expect(approval.page).toContain("stay signed in as <strong>Dana</strong> (dana@example.com)");
  expect(approval.page).toContain("read and change feedback in every Critiqs project you can open");
  expect(approval.page).toContain("unused for 30 days, or 90 days pass");
  expect(approval.page).not.toContain("15 minutes");
  expect(await decide(t, approval, "approve")).toContain("Access approved");

  const granted = await poll(t, body.deviceCode);
  expect(granted.status).toBe(200);
  expect(granted.body.refreshToken).toBeString();
  expect(granted.body.reviewer).toEqual({ name: "Dana", email: "dana@example.com" });
  const days = (granted.body.sessionEndsAt - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(89.9);
  expect(days).toBeLessThanOrEqual(90);
  // One session, owned by the sign-in service itself and stored only as a hash; still no site grant.
  const [grants, sessions] = await t.run(async (ctx) => [await ctx.db.query("siteGrants").collect(), await ctx.db.query("sessions").collect()]);
  expect(grants).toEqual([]);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ origin: LOCAL, profile: { name: "Dana", email: "dana@example.com" } });
  expect(JSON.stringify(sessions)).not.toContain(granted.body.refreshToken);
  // Used once, like setup's.
  expect((await poll(t, body.deviceCode)).body.error).toBe("invalid_grant");

  // The command line renews from the sign-in service's origin, and only there.
  expect((await refresh(t, granted.body.refreshToken, "https://proto.example")).status).toBe(401);
  const renewed = await refresh(t, granted.body.refreshToken);
  expect(renewed.status).toBe(200);
  const next = (await renewed.json()) as Record<string, any>;
  expect(next.accessToken).toBeString();
  // Each renewal replaces the refresh token.
  expect((await refresh(t, granted.body.refreshToken)).status).toBe(401);

  // Signing out ends it.
  await t.fetch("/auth/sign-out", { method: "POST", headers: { Origin: LOCAL }, body: JSON.stringify({ refreshToken: next.refreshToken }) });
  expect((await refresh(t, next.refreshToken)).status).toBe(401);
  expect(await t.run(async (ctx) => await ctx.db.query("sessions").collect())).toEqual([]);
});

test("a denied access approval starts no session", async () => {
  const t = local();
  const body = await startAccess(t);
  expect(await decide(t, await approveIn(t, body.userCode), "deny")).toContain("Access denied");
  expect((await poll(t, body.deviceCode)).body.error).toBe("access_denied");
  expect(await t.run(async (ctx) => await ctx.db.query("sessions").collect())).toEqual([]);
});

test("setup's approval is unchanged by an unrecognized or false request to stay signed in", async () => {
  const t = local();
  for (const request of ["", "not json", JSON.stringify({ keepSignedIn: false }), JSON.stringify({ keepSignedIn: "yes" })]) {
    const body = (await (await t.fetch("/auth/device/start", { method: "POST", body: request })).json()) as Record<string, any>;
    const approval = await approveIn(t, body.userCode);
    expect(approval.page).toContain("Approve Critiqs setup?");
    expect(await decide(t, approval, "approve")).toContain("Setup approved");
    expect((await poll(t, body.deviceCode)).body.refreshToken).toBeUndefined();
  }
  expect(await t.run(async (ctx) => await ctx.db.query("sessions").collect())).toEqual([]);
});
