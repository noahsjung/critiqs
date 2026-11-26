import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { frameHostHash, REVIEW_LEASE_MAX_MS, REVIEW_LEASE_MS, REVIEW_LINK_LIMITS } from "@critiqs/server/review-links";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

// Review links on Convex: who may create one, who may open one, and that a
// lease never outlives or widens what the project allows. The review proxy's
// side is `/internal/review/v1/*`, called here as the proxy calls it.

const SECRET = "proxy-secret-for-tests-0123456789abcdefghij";
const ENV: Record<string, string> = {
  CRITIQS_REVIEW_PROXY_URL: "http://review.localhost:5260",
  CRITIQS_PROXY_SECRET: SECRET,
  CRITIQS_WEB_URL: "https://critiqs.example",
  CONVEX_SITE_URL: "https://test.convex.site",
  CRITIQS_AUTH_ISSUER: "https://test.convex.site",
};
const CLEARED = ["CRITIQS_WEB_RISK_API_KEY", "CRITIQS_REVIEW_TEST_UNSAFE_HOSTS"];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of [...Object.keys(ENV), ...CLEARED]) saved.set(name, process.env[name]);
  Object.assign(process.env, ENV);
  for (const name of CLEARED) delete process.env[name];
});
afterEach(() => {
  setSystemTime();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const OWNERS_ONLY = "Only the project's owners can create or change its review links.";
const ORGANIZATION_ONLY = "This project is limited to members of its organization. Ask one of its admins to invite you.";

/** What an attempt came to: its value, or its refusal's message. */
async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    const data = (error as { data?: { message?: string } }).data;
    return data?.message ?? (error as Error).message;
  }
}

/**
 * Dana's project "Pilot"; Riley joined her organization as a member (not an
 * owner); Lee is outside it; `anonymous` is someone signed out.
 */
async function fixture(reviewAccess: "anyone" | "organization" = "anyone") {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const riley = t.withIdentity(reviewer("Riley"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley.mutation(api.users.sync, {});
  await lee.mutation(api.users.sync, {});
  if (reviewAccess === "organization") await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess });
  /** Creates a link as Dana and lets its reputation check finish. */
  const link = async (address = "https://app.acme.com/users/42?tab=1", more: { assetOrigins?: string[]; requestKey?: string } = {}) => {
    const created = await dana.mutation(api.reviewLinks.createLive, { projectId, address, ...more });
    await t.finishAllScheduledFunctions(() => undefined);
    return created;
  };
  return { t, dana, riley, lee, anonymous: t, projectId, organizationId: organization!.id, link };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Client = Fixture["dana"] | Fixture["t"];

const labelOf = (origin: string) => new URL(origin).hostname.split(".")[0]!;

/** Asks the backend what a frame host stands for, as the proxy does. */
async function resolve(t: Fixture["t"], label: string, secret: string | null = SECRET) {
  const response = await t.fetch("/internal/review/v1/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }) },
    body: JSON.stringify({ hostHash: await frameHostHash(label) }),
  });
  return { status: response.status, body: await response.text(), cache: response.headers.get("Cache-Control") };
}

/** Opens a link and returns its lease, failing the test if it isn't ready. */
async function lease(who: Client, key: string) {
  const opened = await who.mutation(api.reviewLinks.open, { key });
  if (opened.kind !== "ready") throw new Error(`Expected a ready link, got ${opened.kind}`);
  return { ...opened, label: labelOf(opened.entry.origin) };
}

const NOT_FOUND = { status: 404, body: "Not found", cache: "no-store" };

// ---------------------------------------------------------------------------
// Configuration

test("review links are off, and /critiqs/config says nothing of them, until the proxy, its secret, and the website are set up", async () => {
  const f = await fixture();
  const config = async () => (await (await f.t.fetch("/critiqs/config")).json()) as { reviewLinks?: unknown };
  expect((await config()).reviewLinks).toEqual({ version: 1, live: true, builds: false, allowCritiqs: false });
  const { key } = await f.link();

  for (const [name, value] of [
    ["CRITIQS_REVIEW_PROXY_URL", undefined],
    ["CRITIQS_PROXY_SECRET", undefined],
    ["CRITIQS_PROXY_SECRET", "too-short"],
    ["CRITIQS_WEB_URL", undefined],
    // On the website's own site, frames could set cookies the website reads.
    ["CRITIQS_REVIEW_PROXY_URL", "https://review.critiqs.example"],
    ["CRITIQS_REVIEW_PROXY_URL", "https://test.convex.site"],
    // Plain HTTP only on this computer.
    ["CRITIQS_REVIEW_PROXY_URL", "http://review.example"],
  ] as const) {
    Object.assign(process.env, ENV);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    expect([name, value, (await config()).reviewLinks]).toEqual([name, value, undefined]);
    expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://other.example" }))).toBe(
      "Review links aren't set up on this deployment.",
    );
    expect(await f.anonymous.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "sign-in" });
    expect(await f.dana.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "unavailable" });
  }
  Object.assign(process.env, ENV);

  // A proxy on the internet with no reputation provider serves nothing.
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://critiqs-review.example";
  expect((await config()).reviewLinks).toEqual({ version: 1, live: false, builds: false, allowCritiqs: false });
  expect(await f.dana.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "pending" });
  process.env.CRITIQS_WEB_RISK_API_KEY = "test-key";
  expect((await config()).reviewLinks).toEqual({ version: 1, live: true, builds: false, allowCritiqs: false });
});

// ---------------------------------------------------------------------------
// Who may create a link

test("only the project's owners may create, list, copy, or revoke review links", async () => {
  const f = await fixture();
  const { linkId } = await f.link();
  const attempts: Record<string, (who: Client) => Promise<unknown>> = {
    createLive: (who: Client) => who.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://proto.example" }),
    list: (who: Client) => who.query(api.reviewLinks.list, { projectId: f.projectId }),
    copy: (who: Client) => who.query(api.reviewLinks.copy, { linkId }),
    revoke: (who: Client) => who.mutation(api.reviewLinks.revoke, { linkId }),
  };
  const unverified = f.t.withIdentity({ ...reviewer("Uma"), email_verified: false });
  for (const [name, attempt] of Object.entries(attempts)) {
    expect([name, await outcome(attempt(f.riley))]).toEqual([name, OWNERS_ONLY]);
    expect([name, await outcome(attempt(f.lee))]).toEqual([name, OWNERS_ONLY]);
    expect([name, await outcome(attempt(f.anonymous))]).toEqual([name, "Sign in to view feedback."]);
    expect([name, await outcome(attempt(unverified))]).toEqual([name, "Verify your email address first."]);
  }
  // Nothing they tried made or changed a link.
  const links = await f.t.run((ctx) => ctx.db.query("reviewLinks").collect());
  expect(links.map((link) => link.status)).toEqual(["active"]);
});

test("limited to its organization, a project's outsiders are refused as outsiders before anything else", async () => {
  const f = await fixture("organization");
  const create = f.lee.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://proto.example" });
  expect(await outcome(create)).toBe(ORGANIZATION_ONLY);
});

test("a live link needs a public https address, and adds its exact origin to the project's address list", async () => {
  const f = await fixture();
  const refusals: Record<string, string> = {
    "http://proto.example": "A review link needs an address that starts with https://.",
    "ftp://proto.example": "A review link needs an address that starts with https://.",
    "https://user:pass@proto.example": "Leave the username and password out of the address.",
    "https://proto.example:8443/": "A review link needs an address on the usual port, without :port.",
    "https://localhost/": "This address is on a computer or private network. Share a build or use the browser extension instead.",
    "https://10.0.0.1/": "This address is on a computer or private network. Share a build or use the browser extension instead.",
    "https://169.254.169.254/": "This address is on a computer or private network. Share a build or use the browser extension instead.",
    "https://devbox/": "This address is on a computer or private network. Share a build or use the browser extension instead.",
    "https://v-abc.review.localhost/": "This address is on a computer or private network. Share a build or use the browser extension instead.",
    "https://critiqs.example/": "Critiqs's own addresses can't be reviewed through a review link.",
    "https://app.critiqs.example/": "Critiqs's own addresses can't be reviewed through a review link.",
    "https://test.convex.site/": "Critiqs's own addresses can't be reviewed through a review link.",
    "https://proto.example/__critiqs/a": "Paths starting with /__critiqs/ are reserved for review links.",
    "not an address": "Enter the full address, starting with https://.",
  };
  for (const [address, message] of Object.entries(refusals)) {
    expect([address, await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address }))]).toEqual([address, message]);
  }
  const tooMany = ["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example"];
  expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://proto.example", assetOrigins: tooMany }))).toBe(
    "A review link can read from at most 4 other origins.",
  );
  expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://proto.example", assetOrigins: ["https://api.example/v1"] }))).toBe(
    "List other origins without a path, such as https://api.acme.com.",
  );
  expect(await f.dana.query(api.projects.addresses, { projectId: f.projectId })).toEqual([]);

  const created = await f.link("https://proto.example/users/42?tab=1#top", { assetOrigins: ["https://api.example", "https://proto.example"] });
  expect(created).toMatchObject({ status: "checking", url: `https://critiqs.example/r/${created.key}` });
  expect(created.key).toMatch(/^[a-z2-7]{26}$/);
  expect(await f.dana.query(api.projects.addresses, { projectId: f.projectId })).toEqual(["https://proto.example", "https://api.example"]);
  const [summary] = await f.dana.query(api.reviewLinks.list, { projectId: f.projectId });
  expect(summary).toMatchObject({ origin: "https://proto.example", startPath: "/users/42?tab=1", assetOrigins: ["https://api.example"], status: "active", paused: false, createdByName: "Dana" });
});

test("a retried create with the same request key returns the same link", async () => {
  const f = await fixture();
  const first = await f.link("https://proto.example", { requestKey: "create-key-1" });
  const again = await f.link("https://proto.example", { requestKey: "create-key-1" });
  expect(again).toEqual({ ...first, status: "active" });
  const other = await f.link("https://proto.example", { requestKey: "create-key-2" });
  expect(other.linkId).not.toBe(first.linkId);
  expect(await f.t.run(async (ctx) => (await ctx.db.query("reviewLinks").collect()).length)).toBe(2);
  // Once revoked, the same key makes a new link rather than handing back a removed one.
  await f.dana.mutation(api.reviewLinks.revoke, { linkId: first.linkId });
  expect((await f.link("https://proto.example", { requestKey: "create-key-1" })).linkId).not.toBe(first.linkId);
});

test("only a key's hash is stored, an owner copies the same key again, and a wrong key opens nothing", async () => {
  const f = await fixture();
  const { linkId, key } = await f.link();
  const row = await f.t.run(async (ctx) => await ctx.db.get(linkId));
  expect(JSON.stringify(row)).not.toContain(key);
  expect(await f.dana.query(api.reviewLinks.copy, { linkId })).toEqual({ key, url: `https://critiqs.example/r/${key}` });
  for (const wrong of ["a".repeat(26), `${key.slice(0, 25)}${key.endsWith("a") ? "b" : "a"}`, "not-a-key", key.toUpperCase()]) {
    expect(await f.anonymous.mutation(api.reviewLinks.open, { key: wrong })).toEqual({ kind: "sign-in" });
    expect(await f.lee.mutation(api.reviewLinks.open, { key: wrong })).toEqual({ kind: "unavailable" });
  }
  await f.dana.mutation(api.reviewLinks.revoke, { linkId });
  expect(await outcome(f.dana.query(api.reviewLinks.copy, { linkId }))).toBe("This review link was removed.");
});

test("a project holds at most 20 open links, and a person creates at most 10 a day", async () => {
  const f = await fixture();
  for (let index = 0; index < REVIEW_LINK_LIMITS.createsPerPersonPerDay; index++) await f.link(`https://app.example/page-${index}`);
  expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://app.example/page-10" }))).toBe(
    "You can create 10 review links a day. Try again tomorrow.",
  );
  setSystemTime(Date.now() + 24 * 60 * 60_000);
  for (let index = 10; index < REVIEW_LINK_LIMITS.activePerProject; index++) await f.link(`https://app.example/page-${index}`);
  expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://app.example/page-20" }))).toBe(
    "A project can have 20 review links at once. Remove one first.",
  );
  const [first] = await f.dana.query(api.reviewLinks.list, { projectId: f.projectId });
  await f.dana.mutation(api.reviewLinks.revoke, { linkId: first!.linkId });
  setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
  await f.link("https://app.example/page-20");
});

// ---------------------------------------------------------------------------
// Who may open a link

test("AT-17: open to anyone, a link opens signed out without telling the project; the frame host resolves", async () => {
  const f = await fixture();
  const { key } = await f.link();
  const opened = await lease(f.anonymous, key);
  expect(opened).toMatchObject({ kind: "ready", projectId: null, projectName: null, source: { kind: "site", origin: "https://app.acme.com" } });
  expect(opened.entry).toMatchObject({ path: "/users/42?tab=1", expiresAt: expect.any(Number), renewEveryMs: 5 * 60_000 });
  expect(opened.entry.origin).toMatch(/^http:\/\/v-[a-z2-7]{26}\.review\.localhost:5260$/);
  expect(JSON.stringify(opened)).not.toContain(f.projectId);
  expect(JSON.stringify(opened)).not.toContain("Pilot");

  const resolved = await resolve(f.t, opened.label);
  expect(resolved.status).toBe(200);
  expect(JSON.parse(resolved.body)).toMatchObject({ v: 1, kind: "site", origin: "https://app.acme.com", leaseId: opened.entry.leaseId, assetOrigins: [] });

  // Signed in, the same link tells the project; each open gets its own frame host.
  const signedIn = await lease(f.lee, key);
  expect(signedIn).toMatchObject({ projectId: f.projectId, projectName: "Pilot" });
  expect(signedIn.label).not.toBe(opened.label);
  const hosts = await f.t.run((ctx) => ctx.db.query("reviewFrameHosts").collect());
  expect(JSON.stringify(hosts)).not.toContain(opened.label);
});

test("AT-17: limited to its organization, outsiders get the same answer as a key that opens nothing", async () => {
  const f = await fixture("organization");
  const { key } = await f.link();
  const unknown = "a".repeat(26);
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key })).toEqual(await f.anonymous.mutation(api.reviewLinks.open, { key: unknown }));
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "sign-in" });
  expect(await f.lee.mutation(api.reviewLinks.open, { key })).toEqual(await f.lee.mutation(api.reviewLinks.open, { key: unknown }));
  expect(await f.lee.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "unavailable" });
  // Someone signed in whose email isn't verified is someone signed out.
  expect(await f.t.withIdentity({ ...reviewer("Uma"), email_verified: false }).mutation(api.reviewLinks.open, { key })).toEqual({ kind: "sign-in" });
  expect(await f.t.run(async (ctx) => (await ctx.db.query("reviewLeases").collect()).length)).toBe(0);

  const member = await lease(f.riley, key);
  expect(member).toMatchObject({ projectId: f.projectId, projectName: "Pilot" });
  expect((await resolve(f.t, member.label)).status).toBe(200);
});

/** Each way a link stops: what to do to the project, as Dana. */
const stops: Record<string, (f: Fixture, link: { linkId: Id<"reviewLinks"> }) => Promise<unknown>> = {
  "the link is revoked": (f, { linkId }) => f.dana.mutation(api.reviewLinks.revoke, { linkId }),
  "the project is limited to its organization": (f) => f.dana.mutation(api.projects.setReviewAccess, { projectId: f.projectId, reviewAccess: "organization" }),
  "the exact origin leaves the address list, though a pattern still matches it": async (f) => {
    await f.dana.mutation(api.projects.addAddress, { projectId: f.projectId, address: "https://*.acme.com" });
    await f.dana.mutation(api.projects.removeAddress, { projectId: f.projectId, address: "https://app.acme.com" });
  },
};

for (const [name, stop] of Object.entries(stops)) {
  test(`AT-18: once ${name}, the frame host serves nothing and the lease can't be renewed or adopted`, async () => {
    const f = await fixture();
    const created = await f.link();
    const anonymous = await lease(f.anonymous, created.key);
    const before = await resolve(f.t, anonymous.label);
    expect(before.status).toBe(200);
    await stop(f, created);
    expect(await resolve(f.t, anonymous.label)).toEqual(NOT_FOUND);
    expect(await f.anonymous.mutation(api.reviewLinks.renew, { leaseId: anonymous.entry.leaseId, renewalSecret: anonymous.entry.renewalSecret })).toEqual({ kind: "ended" });
    expect(await f.lee.mutation(api.reviewLinks.adopt, { leaseId: anonymous.entry.leaseId, renewalSecret: anonymous.entry.renewalSecret })).toEqual({ kind: "ended" });
    // Not even someone allowed to see the project brings it back.
    expect(await f.riley.mutation(api.reviewLinks.adopt, { leaseId: anonymous.entry.leaseId, renewalSecret: anonymous.entry.renewalSecret })).toEqual({ kind: "ended" });
    expect(await f.anonymous.mutation(api.reviewLinks.open, { key: created.key })).toEqual({ kind: "sign-in" });
  });
}

test("AT-18: once a member leaves the organization, their lease on a limited project stops", async () => {
  const f = await fixture("organization");
  const { key } = await f.link();
  const riley = await lease(f.riley, key);
  expect((await resolve(f.t, riley.label)).status).toBe(200);
  const rileyId = (await f.t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Riley")!._id;
  await f.dana.mutation(api.organizations.removeMember, { organizationId: f.organizationId, userId: rileyId });
  expect(await resolve(f.t, riley.label)).toEqual(NOT_FOUND);
  expect(await f.riley.mutation(api.reviewLinks.renew, { leaseId: riley.entry.leaseId, renewalSecret: riley.entry.renewalSecret })).toEqual({ kind: "ended" });
  expect(await f.riley.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "unavailable" });
});

test("AT-19: a lease renews only with its own secret, for its own viewer, and never past its deadline", async () => {
  const f = await fixture();
  const { key } = await f.link();
  const anonymous = await lease(f.anonymous, key);
  const member = await lease(f.lee, key);
  const forged = { leaseId: anonymous.entry.leaseId, renewalSecret: member.entry.renewalSecret };
  expect(await f.anonymous.mutation(api.reviewLinks.renew, forged)).toEqual({ kind: "ended" });
  expect(await f.anonymous.mutation(api.reviewLinks.renew, { leaseId: "not-an-id", renewalSecret: "x" })).toEqual({ kind: "ended" });
  // A signed-in lease renews only for the person it belongs to.
  const leeLease = { leaseId: member.entry.leaseId, renewalSecret: member.entry.renewalSecret };
  expect(await f.anonymous.mutation(api.reviewLinks.renew, leeLease)).toEqual({ kind: "ended" });
  expect(await f.riley.mutation(api.reviewLinks.renew, leeLease)).toEqual({ kind: "ended" });
  // Nothing refused changed either lease.
  expect((await resolve(f.t, anonymous.label)).status).toBe(200);

  const start = Date.now();
  setSystemTime(start + 4 * 60_000);
  expect(await f.lee.mutation(api.reviewLinks.renew, leeLease)).toEqual({ kind: "renewed", expiresAt: start + 4 * 60_000 + REVIEW_LEASE_MS });
  // Renewed every few minutes, a lease still ends at its deadline.
  let now = start;
  while (now + 5 * 60_000 < start + REVIEW_LEASE_MAX_MS) {
    now += 5 * 60_000;
    setSystemTime(now);
    const renewed = await f.lee.mutation(api.reviewLinks.renew, leeLease);
    expect(renewed).toEqual({ kind: "renewed", expiresAt: Math.min(now + REVIEW_LEASE_MS, member.entry.expiresAt - REVIEW_LEASE_MS + REVIEW_LEASE_MAX_MS) });
  }
  setSystemTime(start + REVIEW_LEASE_MAX_MS);
  expect(await f.lee.mutation(api.reviewLinks.renew, leeLease)).toEqual({ kind: "ended" });
  expect(await resolve(f.t, member.label)).toEqual(NOT_FOUND);
  // The anonymous lease, never renewed, ended ten minutes in.
  expect(await resolve(f.t, anonymous.label)).toEqual(NOT_FOUND);
});

test("AT-19: an anonymous lease is adopted once, by whoever signs in with its secret, keeping its frame host", async () => {
  const f = await fixture();
  const { key } = await f.link();
  const anonymous = await lease(f.anonymous, key);
  const held = { leaseId: anonymous.entry.leaseId, renewalSecret: anonymous.entry.renewalSecret };
  expect(await f.lee.mutation(api.reviewLinks.adopt, { ...held, renewalSecret: "forged" })).toEqual({ kind: "ended" });
  expect(await outcome(f.anonymous.mutation(api.reviewLinks.adopt, held))).toBe("Sign in to view feedback.");
  expect(await f.lee.mutation(api.reviewLinks.adopt, held)).toEqual({ kind: "adopted", projectId: f.projectId, projectName: "Pilot" });
  expect(await f.lee.mutation(api.reviewLinks.adopt, held)).toEqual({ kind: "adopted", projectId: f.projectId, projectName: "Pilot" });
  expect(await f.riley.mutation(api.reviewLinks.adopt, held)).toEqual({ kind: "ended" });
  // Now Lee's: renewing needs Lee, and the frame host still serves.
  expect(await f.anonymous.mutation(api.reviewLinks.renew, held)).toEqual({ kind: "ended" });
  expect(await f.lee.mutation(api.reviewLinks.renew, held)).toMatchObject({ kind: "renewed" });
  expect((await resolve(f.t, anonymous.label)).status).toBe(200);
  expect(await f.lee.mutation(api.reviewLinks.recordOpened, held)).toBe(true);
  expect(await f.riley.mutation(api.reviewLinks.recordOpened, held)).toBe(false);
  const opened = await f.t.run((ctx) => ctx.db.query("openedProjects").collect());
  expect(opened.map((row) => row.projectId)).toEqual([f.projectId]);
});

test("AT-20: unknown, paused, blocked, and ended frame hosts all get one identical 404", async () => {
  const f = await fixture();
  const ready = await f.link("https://ready.example");
  const paused = await f.link("https://paused.example");
  process.env.CRITIQS_REVIEW_TEST_UNSAFE_HOSTS = "blocked.example";
  const blocked = await f.link("https://blocked.example");
  delete process.env.CRITIQS_REVIEW_TEST_UNSAFE_HOSTS;
  const hosts = {
    ready: await lease(f.anonymous, ready.key),
    paused: await lease(f.anonymous, paused.key),
    ended: await lease(f.anonymous, ready.key),
  };
  // The unsafe verdict blocked the link before anyone could open it.
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key: blocked.key })).toEqual({ kind: "sign-in" });
  expect((await f.dana.query(api.reviewLinks.list, { projectId: f.projectId })).find((link) => link.linkId === blocked.linkId)?.status).toBe("blocked");
  const usage = await f.t.fetch("/internal/review/v1/usage", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reports: [{ linkId: paused.linkId, requests: REVIEW_LINK_LIMITS.requestsPerLinkPerDay, bytes: 10 }] }),
  });
  expect(await usage.json()).toEqual({ paused: [paused.linkId] });
  await f.t.run(async (ctx) => {
    const lease = await ctx.db.get(hosts.ended.entry.leaseId as Id<"reviewLeases">);
    await ctx.db.patch(lease!._id, { expiresAt: Date.now() - 1 });
  });

  expect((await resolve(f.t, hosts.ready.label)).status).toBe(200);
  for (const label of [hosts.paused.label, hosts.ended.label, "v-" + "a".repeat(26), "v-short", "not-a-host"]) {
    expect([label, await resolve(f.t, label)]).toEqual([label, NOT_FOUND]);
  }
  // Paused only for the day: the owner sees it, and an allowed viewer is told it's limited.
  const summaries = await f.dana.query(api.reviewLinks.list, { projectId: f.projectId });
  expect(summaries.find((link) => link.linkId === paused.linkId)).toMatchObject({ paused: true, usageToday: { requests: REVIEW_LINK_LIMITS.requestsPerLinkPerDay, bytes: 10 } });
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key: paused.key })).toEqual({ kind: "limited" });
  setSystemTime(Date.now() + 24 * 60 * 60_000);
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key: paused.key })).toMatchObject({ kind: "ready" });
});

test("AT-21: the proxy's routes answer a missing or wrong secret, or review links being off, with the same 404", async () => {
  const f = await fixture();
  const { key } = await f.link();
  const opened = await lease(f.anonymous, key);
  for (const secret of [null, "", "wrong", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
    expect([secret, await resolve(f.t, opened.label, secret)]).toEqual([secret, NOT_FOUND]);
    const usage = await f.t.fetch("/internal/review/v1/usage", {
      method: "POST",
      headers: secret === null ? {} : { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ reports: [] }),
    });
    expect([secret, usage.status, await usage.text()]).toEqual([secret, 404, "Not found"]);
  }
  const malformed = await f.t.fetch("/internal/review/v1/resolve", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "{" });
  expect([malformed.status, await malformed.text()]).toEqual([404, "Not found"]);
  delete process.env.CRITIQS_REVIEW_PROXY_URL;
  expect(await resolve(f.t, opened.label)).toEqual(NOT_FOUND);
});

test("AT-21: the proxy secret is never in anything a public function or route returns", async () => {
  const f = await fixture();
  const created = await f.link();
  const anonymous = await lease(f.anonymous, created.key);
  const held = { leaseId: anonymous.entry.leaseId, renewalSecret: anonymous.entry.renewalSecret };
  const answers = [
    await (await f.t.fetch("/critiqs/config")).text(),
    created,
    await f.dana.query(api.reviewLinks.list, { projectId: f.projectId }),
    await f.dana.query(api.reviewLinks.copy, { linkId: created.linkId }),
    anonymous,
    await lease(f.riley, created.key),
    await f.anonymous.mutation(api.reviewLinks.renew, held),
    await f.lee.mutation(api.reviewLinks.adopt, held),
    await f.lee.mutation(api.reviewLinks.recordOpened, held),
    (await resolve(f.t, anonymous.label)).body,
  ];
  for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(SECRET);
  // Nor is the key ring's secret, which only derives keys.
  const ring = await f.t.run(async (ctx) => (await ctx.db.query("settings").collect()).find((row) => row.key.startsWith("review-link-key:"))!.value);
  for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(ring);
});

test("AT-22: an unsafe reputation verdict, or an operator's deny entry, stops serving at once", async () => {
  const f = await fixture();
  const created = await f.link("https://proto.example", { assetOrigins: ["https://api.example"] });
  const opened = await lease(f.anonymous, created.key);
  expect(JSON.parse((await resolve(f.t, opened.label)).body).assetOrigins).toEqual([{ slot: 1, origin: "https://api.example" }]);

  for (const target of [{ linkId: created.linkId }, { projectId: f.projectId }, { origin: "https://proto.example" }, { origin: "https://api.example" }]) {
    await f.t.mutation(internal.reviewLinks.deny, { ...target, reason: "test takedown" });
    expect([target, await resolve(f.t, opened.label)]).toEqual([target, NOT_FOUND]);
    expect([target, await f.anonymous.mutation(api.reviewLinks.renew, { leaseId: opened.entry.leaseId, renewalSecret: opened.entry.renewalSecret })]).toEqual([
      target,
      { kind: "ended" },
    ]);
    expect([target, await f.dana.mutation(api.reviewLinks.open, { key: created.key })]).toEqual([target, { kind: "unavailable" }]);
    await f.t.mutation(internal.reviewLinks.undeny, target);
    expect([target, (await resolve(f.t, opened.label)).status]).toEqual([target, 200]);
  }

  // A recheck that finds the address unsafe blocks the link for good.
  process.env.CRITIQS_REVIEW_TEST_UNSAFE_HOSTS = "api.example";
  expect(await f.t.action(internal.reviewLinks.checkReputation, { linkId: created.linkId })).toBe("unsafe");
  expect(await resolve(f.t, opened.label)).toEqual(NOT_FOUND);
  // Blocked, it opens for no one, owner included, and isn't waiting for anything.
  expect(await f.dana.mutation(api.reviewLinks.open, { key: created.key })).toEqual({ kind: "unavailable" });
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key: created.key })).toEqual({ kind: "sign-in" });
  delete process.env.CRITIQS_REVIEW_TEST_UNSAFE_HOSTS;
  expect(await f.t.action(internal.reviewLinks.checkReputation, { linkId: created.linkId })).toBe(null);
  expect(await resolve(f.t, opened.label)).toEqual(NOT_FOUND);
});

test("a link isn't served until a reputation verdict is in, nor after it goes stale; the provider failing serves nothing", async () => {
  const f = await fixture("organization");
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://critiqs-review.example";
  process.env.CRITIQS_WEB_RISK_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    lookups++;
    expect(String(input)).toStartWith("https://webrisk.googleapis.com/v1/uris:search?");
    // Asked about the origin and path only, never the query.
    expect(new URL(String(input)).searchParams.get("uri")).toBe("https://app.acme.com/users/42");
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    const created = await f.link();
    expect(lookups).toBe(1);
    // Only someone allowed to open it learns it's waiting.
    expect(await f.riley.mutation(api.reviewLinks.open, { key: created.key })).toEqual({ kind: "pending" });
    expect(await f.lee.mutation(api.reviewLinks.open, { key: created.key })).toEqual({ kind: "unavailable" });
    expect(await f.t.mutation(internal.reviewLinks.recheckReputation, {})).toBe(1);

    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    await f.t.finishAllScheduledFunctions(() => undefined);
    const opened = await lease(f.riley, created.key);
    expect(opened.entry.origin).toMatch(/^https:\/\/v-[a-z2-7]{26}\.critiqs-review\.example$/);

    // Two days on with no new verdict, the link waits again.
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    setSystemTime(Date.now() + 49 * 60 * 60_000);
    expect(await f.t.mutation(internal.reviewLinks.recheckReputation, {})).toBe(1);
    await f.t.finishAllScheduledFunctions(() => undefined);
    expect(await f.riley.mutation(api.reviewLinks.open, { key: created.key })).toEqual({ kind: "pending" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a link mints at most 60 leases an hour", async () => {
  const f = await fixture();
  const { key } = await f.link();
  for (let index = 0; index < REVIEW_LINK_LIMITS.leasesPerLinkPerHour; index++) await lease(f.anonymous, key);
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "limited" });
  setSystemTime(Date.now() + 60 * 60_000);
  await lease(f.anonymous, key);
});

test("cleanup removes ended leases with their frame hosts", async () => {
  const f = await fixture();
  const { key } = await f.link();
  await lease(f.anonymous, key);
  const kept = await lease(f.lee, key);
  const start = Date.now();
  setSystemTime(start + 6 * 60_000);
  await f.lee.mutation(api.reviewLinks.renew, { leaseId: kept.entry.leaseId, renewalSecret: kept.entry.renewalSecret });
  setSystemTime(start + REVIEW_LEASE_MS + 1);
  expect(await f.t.mutation(internal.reviewLinks.cleanUp, {})).toEqual({ leases: 1, usage: 0 });
  expect(await f.t.run(async (ctx) => [(await ctx.db.query("reviewLeases").collect()).length, (await ctx.db.query("reviewFrameHosts").collect()).length])).toEqual([1, 1]);
});

// ---------------------------------------------------------------------------
// Attacks from the security reviews (F-H3-1, F-H3-2, notes 3, 4, 6;
// N5, N7, N9), each reproduced against the real functions.

test("F-H3-1: a proxy on a sibling of the website's own site turns review links off", async () => {
  const f = await fixture();
  const config = async () => (await (await f.t.fetch("/critiqs/config")).json()) as { reviewLinks?: unknown };
  process.env.CRITIQS_WEB_URL = "https://app.critiqs.example";
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://proxy.critiqs.example";
  process.env.CRITIQS_WEB_RISK_API_KEY = "test-key";
  expect((await config()).reviewLinks).toBeUndefined();
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://app.critiqs.example.";
  expect((await config()).reviewLinks).toBeUndefined();
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://critiqs-review.example";
  expect((await config()).reviewLinks).toEqual({ version: 1, live: true, builds: false, allowCritiqs: false });
});

test("F-H3-2: an address written with extra dots is refused, and a trailing dot is checked as its host", async () => {
  const f = await fixture();
  process.env.CRITIQS_REVIEW_TEST_UNSAFE_HOSTS = "unsafe.example";
  for (const address of ["https://unsafe.example../", "https://critiqs.example../"]) {
    expect(typeof (await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address })))).toBe("string");
  }
  expect(await f.t.run(async (ctx) => (await ctx.db.query("reviewLinks").collect()).length)).toBe(0);
  const created = await f.link("https://unsafe.example./");
  const link = await f.t.run((ctx) => ctx.db.get(created.linkId));
  expect(link?.origin).toBe("https://unsafe.example");
  expect(link?.status).toBe("blocked");
  expect(await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address: "https://critiqs.example./" }))).toBe("Critiqs's own addresses can't be reviewed through a review link.");
});

test("note 3: someone signed out learns nothing about whether a link ID exists", async () => {
  const f = await fixture();
  const { linkId } = await f.link();
  const bogus = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("reviewDeny", { subject: "x", reason: "x", createdAt: 0 });
    await ctx.db.delete(id);
    return String(id);
  });
  for (const id of [linkId, bogus, "not-an-id"]) {
    expect(await outcome(f.anonymous.query(api.reviewLinks.copy, { linkId: id as Id<"reviewLinks"> }))).toBe("Sign in to view feedback.");
    expect(await outcome(f.anonymous.mutation(api.reviewLinks.revoke, { linkId: id as Id<"reviewLinks"> }))).toBe("Sign in to view feedback.");
  }
});

test("note 4: opening a link with a stale verdict asks the provider again at most once a minute", async () => {
  const f = await fixture();
  const { key } = await f.link();
  const checks = async () => (await f.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter((job) => job.name.includes("checkReputation")).length;
  const before = await checks();
  // The provider can't answer (a proxy on the internet with no key), so the verdict stays stale and every open is pending.
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://critiqs-review.example";
  setSystemTime(Date.now() + 49 * 60 * 60_000);
  // Anyone holding the key, signed out, opening it again and again.
  for (let index = 0; index < 20; index++) expect(await f.anonymous.mutation(api.reviewLinks.open, { key })).toEqual({ kind: "pending" });
  expect((await checks()) - before).toBeLessThanOrEqual(1);
  setSystemTime(Date.now() + 49 * 60 * 60_000 + 61_000);
  await f.dana.mutation(api.reviewLinks.open, { key });
  expect((await checks()) - before).toBe(2);
});

test("note 6: links stuck waiting for a verdict don't starve newer ones", async () => {
  const f = await fixture();
  const projectId = f.projectId as Id<"projects">;
  const userId = (await f.t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Dana")!._id;
  const stuck = await f.t.run(async (ctx) => {
    const ids: Id<"reviewLinks">[] = [];
    for (let index = 0; index < 60; index++) {
      ids.push(
        await ctx.db.insert("reviewLinks", { projectId, kind: "site", origin: `https://s${index}.example`, startPath: "/", assetOrigins: [], keyHash: `h${index}`, keyVersion: 1, status: "checking", createdBy: userId, createdAt: index }),
      );
    }
    return ids;
  });
  // No provider on the internet: every check comes back unknown and the links keep waiting.
  process.env.CRITIQS_REVIEW_PROXY_URL = "https://critiqs-review.example";
  const picked = new Set<string>();
  for (let round = 0; round < 3; round++) {
    const before = await f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job._id));
    await f.t.mutation(internal.reviewLinks.recheckReputation, {});
    const jobs = await f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => !before.includes(job._id)));
    for (const job of jobs) picked.add(String((job.args[0] as { linkId: string }).linkId));
    await f.t.finishAllScheduledFunctions(() => undefined);
  }
  expect(stuck.every((id) => picked.has(id))).toBe(true);
});

test("N9: an owner-approved origin stops serving once it leaves the address list", async () => {
  const f = await fixture();
  const created = await f.link("https://app.acme.com/", { assetOrigins: ["https://api.acme.com"] });
  const opened = await lease(f.anonymous, created.key);
  expect(JSON.parse((await resolve(f.t, opened.label)).body).assetOrigins).toEqual([{ slot: 1, origin: "https://api.acme.com" }]);
  await f.dana.mutation(api.projects.removeAddress, { projectId: f.projectId, address: "https://api.acme.com" });
  const after = await resolve(f.t, opened.label);
  expect(after.status).toBe(200);
  expect(JSON.parse(after.body).assetOrigins).toEqual([]);
});

test("N5: during a rotation the proxy's previous secret still works, and only until it is removed", async () => {
  const f = await fixture();
  const opened = await lease(f.anonymous, (await f.link()).key);
  const next = "next-proxy-secret-for-tests-0123456789abcdef";
  process.env.CRITIQS_PROXY_SECRET = next;
  process.env.CRITIQS_PROXY_SECRET_PREVIOUS = SECRET;
  try {
    expect((await resolve(f.t, opened.label, SECRET)).status).toBe(200);
    expect((await resolve(f.t, opened.label, next)).status).toBe(200);
    delete process.env.CRITIQS_PROXY_SECRET_PREVIOUS;
    expect(await resolve(f.t, opened.label, SECRET)).toEqual(NOT_FOUND);
  } finally {
    delete process.env.CRITIQS_PROXY_SECRET_PREVIOUS;
  }
});

test("N7: an owner replaces a link's key by removing the link and creating it again; the old key opens nothing", async () => {
  const f = await fixture();
  const first = await f.link();
  const opened = await lease(f.anonymous, first.key);
  await f.dana.mutation(api.reviewLinks.revoke, { linkId: first.linkId });
  const second = await f.link();
  expect(second.key).not.toBe(first.key);
  expect(await f.anonymous.mutation(api.reviewLinks.open, { key: first.key })).toEqual({ kind: "sign-in" });
  expect(await resolve(f.t, opened.label)).toEqual(NOT_FOUND);
  expect((await lease(f.anonymous, second.key)).kind).toBe("ready");
});

// ---------------------------------------------------------------------------
// Round 3

test("someone signed in whom the deployment has never seen gets the owners-only sentence from list and copy, not a server error", async () => {
  const f = await fixture();
  const { linkId } = await f.link();
  // Olive has never opened the website: no user record yet, and a query can't write one.
  const olive = f.t.withIdentity(reviewer("Olive"));
  expect(await outcome(olive.query(api.reviewLinks.list, { projectId: f.projectId }))).toBe(OWNERS_ONLY);
  expect(await outcome(olive.query(api.reviewLinks.copy, { linkId }))).toBe(OWNERS_ONLY);
  // And nothing was written for her.
  expect(await f.t.run(async (ctx) => (await ctx.db.query("users").collect()).some((user) => user.name === "Olive"))).toBe(false);
});

test("an owner whose sign-in carries a new name still lists and copies links: a query never writes", async () => {
  const f = await fixture();
  const { linkId } = await f.link();
  const renamed = f.t.withIdentity({ ...reviewer("Dana"), name: "Dana Renamed" });
  expect((await renamed.query(api.reviewLinks.list, { projectId: f.projectId })).map((link) => link.linkId)).toEqual([linkId]);
  expect((await renamed.query(api.reviewLinks.copy, { linkId })).url).toContain("/r/");
});

test("a .invalid name is never a live address: it can't be reached, and shared builds use it", async () => {
  const f = await fixture();
  for (const address of ["https://k3jx7q2m4n5p6r7s8t9u.build.invalid/", "https://anything.invalid/", "https://ANYTHING.INVALID./x"]) {
    expect([address, await outcome(f.dana.mutation(api.reviewLinks.createLive, { projectId: f.projectId, address }))]).toEqual([
      address,
      "This address can't be reached on the internet. Use your prototype's public https:// address.",
    ]);
  }
});

test("a frame host is judged at the time the proxy asks, which the HTTP action passes in, so no cached answer outlives the lease", async () => {
  const f = await fixture();
  const { key } = await f.link();
  const opened = await lease(f.anonymous, key);
  const hostHash = await frameHostHash(opened.label);
  const now = Date.now();
  expect(await f.t.query(internal.reviewLinks.resolveHost, { hostHash, now })).not.toBeNull();
  // The same question asked after the lease's end: nothing, with nothing in the database changed.
  expect(await f.t.query(internal.reviewLinks.resolveHost, { hostHash, now: now + REVIEW_LEASE_MAX_MS + 1 })).toBeNull();
});
