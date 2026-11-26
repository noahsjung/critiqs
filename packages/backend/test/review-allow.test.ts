import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { ALLOW_CHECKS_PER_PERSON_PER_HOUR, ALLOW_RECHECK_MS, ALLOW_TOKEN, frameHostHash } from "@critiqs/server/review-links";
import { api, internal } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";

// Allow Critiqs on Convex: a token is one project's for one exact origin,
// shown only to that project's owners, and leases carry it to that origin
// only after a check through the proxy found the site open with it and the
// project's proof published. The proxy's probe is a stand-in here.

const SECRET = "proxy-secret-for-tests-0123456789abcdefghij";
const ENV: Record<string, string> = {
  CRITIQS_REVIEW_PROXY_URL: "http://review.localhost:5260",
  CRITIQS_PROXY_SECRET: SECRET,
  CRITIQS_WEB_URL: "https://critiqs.example",
  CONVEX_SITE_URL: "https://test.convex.site",
  CRITIQS_AUTH_ISSUER: "https://test.convex.site",
};
const saved = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;
/** What the stand-in proxy was asked, and what it answers next. */
let probes: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
let probeAnswer: () => Response = () => Response.json({ result: "public", proof: true });
beforeEach(() => {
  for (const name of [...Object.keys(ENV), "CRITIQS_WEB_RISK_API_KEY", "CRITIQS_PROXY_PROBE_URL"]) saved.set(name, process.env[name]);
  Object.assign(process.env, ENV);
  delete process.env.CRITIQS_WEB_RISK_API_KEY;
  delete process.env.CRITIQS_PROXY_PROBE_URL;
  probes = [];
  probeAnswer = () => Response.json({ result: "public", proof: true });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/__critiqs/probe")) return await realFetch(input, init);
    probes.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return probeAnswer();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    const data = (error as { data?: { message?: string } }).data;
    return data?.message ?? (error as Error).message;
  }
}

/** Dana owns "Pilot" and Erin owns "Elsewhere"; Riley is a member of Dana's organization, not an owner; Lee is outside. */
async function fixture() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const erin = t.withIdentity(reviewer("Erin"));
  const riley = t.withIdentity(reviewer("Riley"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const otherProjectId = await erin.mutation(api.projects.create, { name: "Elsewhere" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley.mutation(api.users.sync, {});
  await lee.mutation(api.users.sync, {});
  return { t, dana, erin, riley, lee, projectId, otherProjectId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A live link's lease for `address` in a project, and what the proxy is told about its frame host. */
async function leaseFor(f: Fixture, owner: Fixture["dana"], projectId: string, address: string) {
  const link = await owner.mutation(api.reviewLinks.createLive, { projectId, address });
  await f.t.finishAllScheduledFunctions(() => undefined);
  const opened = await f.t.mutation(api.reviewLinks.open, { key: link.key });
  if (opened.kind !== "ready") throw new Error(`Expected ready, got ${opened.kind}`);
  const hostHash = await frameHostHash(new URL(opened.entry.origin).hostname.split(".")[0]!);
  return async () => {
    const response = await f.t.fetch("/internal/review/v1/resolve", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ hostHash }) });
    return ((await response.json()) as { allow: { origin: string; token: string }[] }).allow;
  };
}

test("/critiqs/config offers Allow Critiqs wherever live links are served", async () => {
  const f = await fixture();
  expect(((await (await f.t.fetch("/critiqs/config")).json()) as { reviewLinks: unknown }).reviewLinks).toEqual({ version: 1, live: true, builds: true, allowCritiqs: true });
});

test("a token is one project's, for one exact origin, and only its owners see it", async () => {
  const f = await fixture();
  const mine = await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com/" });
  expect(mine).toMatchObject({ origin: "https://staging.acme.com", header: "Critiqs-Allow", proofPath: "/.well-known/critiqs-allow.txt", userAgent: "Critiqs-Review/1", wellKnownUrl: "http://review.localhost:5260/.well-known/critiqs-review.json", verifiedAt: null, lastCheck: null });
  expect(mine.token).toMatch(ALLOW_TOKEN);
  expect(mine.proofLine).toMatch(/^critiqs-allow-proof=[A-Za-z0-9_-]{32}$/);
  // The same again; another origin, or another project for the same origin, a different token.
  expect((await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" })).token).toBe(mine.token);
  expect((await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://www.acme.com" })).token).not.toBe(mine.token);
  const theirs = await f.erin.mutation(api.reviewAllow.issue, { projectId: f.otherProjectId, origin: "https://staging.acme.com" });
  expect(theirs.token).not.toBe(mine.token);
  expect(theirs.proofLine).not.toBe(mine.proofLine);
  // The origin joins the project's address list.
  expect(await f.t.run(async (ctx) => (await ctx.db.query("projectAddresses").collect()).map((entry) => entry.address))).toContain("https://staging.acme.com");
  // Members who don't own it, outsiders and people signed out are refused.
  expect(await outcome(f.riley.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" }))).toBe("Only the project's owners can create or change its review links.");
  expect(typeof (await outcome(f.lee.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" })))).toBe("string");
  expect(typeof (await outcome(f.t.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" })))).toBe("string");
  expect(typeof (await outcome(f.riley.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" })))).toBe("string");
  // Only an origin a review link could serve.
  for (const origin of ["http://staging.acme.com", "https://localhost", "https://10.0.0.1", "https://review.localhost:5260", "https://staging.acme.com/path"]) {
    expect([origin, typeof (await outcome(f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin })))]).toEqual([origin, "string"]);
  }
  expect(probes).toEqual([]);
});

test("leases carry an origin's token only after a check finds the site open with it and the proof published, and only that project's", async () => {
  const f = await fixture();
  const allowOf = await leaseFor(f, f.dana, f.projectId, "https://staging.acme.com/");
  const othersAllow = await leaseFor(f, f.erin, f.otherProjectId, "https://staging.acme.com/");
  const mine = await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" });
  expect(await allowOf()).toEqual([]);

  // Open, but no proof: not verified.
  probeAnswer = () => Response.json({ result: "public", proof: false });
  expect(await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" })).toEqual({ result: "public", verified: false });
  expect(await allowOf()).toEqual([]);
  // Still blocked.
  probeAnswer = () => Response.json({ result: "blocked", proof: false });
  expect(await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" })).toEqual({ result: "blocked", verified: false });
  // Open with the proof: verified.
  probeAnswer = () => Response.json({ result: "public", proof: true });
  expect(await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" })).toEqual({ result: "public", verified: true });
  expect(await allowOf()).toEqual([{ origin: "https://staging.acme.com", token: mine.token }]);
  // Another customer's link to the same origin never carries this project's token.
  expect(await othersAllow()).toEqual([]);

  // The proxy was asked with the shared secret, for exactly that origin, token and proof.
  const proof = mine.proofLine.split("=")[1];
  expect(probes.at(-1)).toEqual({ url: "http://review.localhost:5260/__critiqs/probe", authorization: `Bearer ${SECRET}`, body: { origin: "https://staging.acme.com", token: mine.token, proof } });

  // A check that finds it blocked again stops sending the token.
  probeAnswer = () => Response.json({ result: "blocked", proof: false });
  await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" });
  expect(await allowOf()).toEqual([]);
});

test("rotating replaces the token at once: the old one is never sent again, and the site must be checked again", async () => {
  const f = await fixture();
  const allowOf = await leaseFor(f, f.dana, f.projectId, "https://staging.acme.com/");
  const first = await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" });
  await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" });
  expect(await allowOf()).toEqual([{ origin: "https://staging.acme.com", token: first.token }]);
  const second = await f.dana.mutation(api.reviewAllow.rotate, { projectId: f.projectId, origin: "https://staging.acme.com" });
  expect(second.token).not.toBe(first.token);
  expect(second.verifiedAt).toBeNull();
  expect(await allowOf()).toEqual([]);
  await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" });
  expect(await allowOf()).toEqual([{ origin: "https://staging.acme.com", token: second.token }]);
});

test("the proxy's answer is read field by field; an unreachable or odd proxy verifies nothing; checks are limited per project", async () => {
  const f = await fixture();
  await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" });
  const check = () => f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://staging.acme.com" });
  for (const answer of [() => Response.json({ result: "public", proof: "yes" }), () => Response.json({ result: "allowed", proof: true }), () => new Response("nope", { status: 500 }), () => { throw new Error("down"); }]) {
    probeAnswer = answer;
    expect(await check()).toEqual({ result: "unreachable", verified: false });
  }
  probeAnswer = () => new Response("", { status: 429 });
  expect(await check()).toEqual({ result: "busy", verified: false });
  probeAnswer = () => Response.json({ result: "public", proof: true });
  // Five so far; fifteen more reach the hour's twenty.
  for (let n = 5; n < 20; n++) await check();
  expect(await outcome(check())).toBe("A project can check its Allow Critiqs rules 20 times an hour. Try again later.");
});

test("a thread page offers the project's review link only to its owners and its organization's members, never to someone who only commented", async () => {
  const f = await fixture();
  const link = await f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://walled.example/" });
  await f.t.finishAllScheduledFunctions(() => undefined);
  await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://walled.example" });
  expect((await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://walled.example" })).verified).toBe(true);
  const onSite = { ...anchor, evidence: { ...anchor.evidence, url: "https://walled.example/pricing" } };
  const capture = { status: "failed" as const, failureReason: "x" };
  // Lee is outside the organization and was never sent the link; in a project open to anyone he may comment, and open his own thread's page.
  const leesThread = await f.lee.mutation(api.threads.create, { projectId: f.projectId, anchor: onSite, body: "hi", tags: [], capture });
  const leesPage = await f.lee.mutation(api.threads.pageKey, { threadId: leesThread });
  expect(await f.lee.query(api.reviewLinks.forThreadPage, { key: leesPage })).toBeNull();
  // The owner and a member who isn't an owner get it, on the same page.
  expect(await f.dana.query(api.reviewLinks.forThreadPage, { key: leesPage })).toBe(`${link.url}#/pricing`);
  expect(await f.riley.query(api.reviewLinks.forThreadPage, { key: leesPage })).toBe(`${link.url}#/pricing`);
});

test("reading a project's Allow Critiqs setup changes nothing; only issuing makes the token and adds the address", async () => {
  const f = await fixture();
  const addresses = async () => await f.t.run(async (ctx) => (await ctx.db.query("projectAddresses").collect()).map((entry) => entry.address));
  expect(await f.dana.query(api.reviewAllow.current, { projectId: f.projectId, origin: "https://attacker-chosen.example" })).toBeNull();
  expect(await addresses()).not.toContain("https://attacker-chosen.example");
  expect(await f.t.run(async (ctx) => await ctx.db.query("reviewAllow").collect())).toEqual([]);
  const issued = await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://staging.acme.com" });
  expect(await f.dana.query(api.reviewAllow.current, { projectId: f.projectId, origin: "https://staging.acme.com" })).toEqual(issued);
  // Owners only, as issuing is.
  expect(await outcome(f.riley.query(api.reviewAllow.current, { projectId: f.projectId, origin: "https://staging.acme.com" }))).toBe("Only the project's owners can create or change its review links.");
});

test("a shared build's .build.invalid name is never a site to allow", async () => {
  const f = await fixture();
  for (const origin of ["https://babcdefghijklmnopqrstu.build.invalid", "https://x.invalid"]) {
    expect(await outcome(f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin }))).toBe("This address can't be reached on the internet. Use your prototype's public https:// address.");
    expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: `${origin}/` }))).toBe("This address can't be reached on the internet. Use your prototype's public https:// address.");
  }
});

test("an allowed site is checked again on its own: once its proof is gone the allowance ends, with nobody pressing Check again", async () => {
  const f = await fixture();
  const origin = "https://walled.example";
  await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin });
  const allowed = async () => (await f.dana.query(api.reviewAllow.current, { projectId: f.projectId, origin }))!.verifiedAt !== null;
  try {
    expect((await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin })).verified).toBe(true);
    // Not due yet: nothing is asked.
    await f.t.action(internal.reviewAllow.recheck, {});
    expect(probes.length).toBe(1);
    // Due, and the site can't be reached this time: that ends nothing, and it is tried again later.
    setSystemTime(new Date(Date.now() + ALLOW_RECHECK_MS + 1_000));
    probeAnswer = () => new Response("", { status: 502 });
    await f.t.action(internal.reviewAllow.recheck, {});
    expect([probes.length, await allowed()]).toEqual([2, true]);
    // Due again, and the proof is gone: the allowance ends, and leases stop carrying the token.
    setSystemTime(new Date(Date.now() + 2 * ALLOW_RECHECK_MS + 2_000));
    probeAnswer = () => Response.json({ result: "public", proof: false });
    await f.t.action(internal.reviewAllow.recheck, {});
    expect([probes.length, await allowed()]).toEqual([3, false]);
    // No longer allowed, it isn't checked on its own again.
    setSystemTime(new Date(Date.now() + 4 * ALLOW_RECHECK_MS));
    await f.t.action(internal.reviewAllow.recheck, {});
    expect(probes.length).toBe(3);
  } finally {
    setSystemTime();
  }
});

test("one person's checks are limited across their projects, so more projects never make more checks", async () => {
  const f = await fixture();
  const second = await f.dana.mutation(api.projects.create, { name: "Second" });
  await f.dana.mutation(api.reviewAllow.issue, { projectId: f.projectId, origin: "https://one.example" });
  await f.dana.mutation(api.reviewAllow.issue, { projectId: second, origin: "https://two.example" });
  for (let n = 0; n < ALLOW_CHECKS_PER_PERSON_PER_HOUR; n++) await f.dana.action(api.reviewAllow.check, { projectId: f.projectId, origin: "https://one.example" });
  expect(await outcome(f.dana.action(api.reviewAllow.check, { projectId: second, origin: "https://two.example" }))).toBe(`You can check Allow Critiqs rules ${ALLOW_CHECKS_PER_PERSON_PER_HOUR} times an hour, across your projects. Try again later.`);
});
