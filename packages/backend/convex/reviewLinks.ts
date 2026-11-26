import {
  addProjectAddress,
  canReview,
  countWithinAll,
  fail,
  operations,
  projectAccess,
  recordProjectOpened,
  type Store,
  utcDay,
  deriveLinkKey,
  frameHostHash,
  frameOrigin,
  HOST_HASH,
  REVIEW_LEASE_MAX_MS,
  REVIEW_LEASE_MS,
  linkKeyHash,
  listsOrigin,
  MIN_PROXY_SECRET,
  newFrameLabel,
  newSecret,
  parseLiveAddress,
  parseProxyAddress,
  type ProxyAddress,
  proxySeparate,
  RENEW_EVERY_MS,
  renewalHash,
  REPUTATION_MAX_AGE_MS,
  REPUTATION_RECHECK_MS,
  reputationSubject,
  RESOLUTION_CACHE_MS,
  REVIEW_LINK_KEY,
  REVIEW_LINK_LIMITS,
  type ReputationVerdict,
  type ReviewAdoption,
  type ReviewLinkSummary,
  type ReviewLinksCapability,
  type ReviewOpen,
  type ReviewRenewal,
  type ReviewResolution,
  webRiskVerdict,
} from "@critiqs/server";
import { canonicalHost, hostOf } from "@critiqs/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { threadPageWebsite } from "./notifications";

// Review links on Convex (see `review-links.ts` in `@critiqs/server` for the shared
// rules). Owners create a link for an exact origin in the project's address
// list; anyone with the key opens it as the project's review access allows,
// which mints a lease with its own frame host; the review proxy asks
// `/internal/review/v1/resolve` what a frame host stands for. Every one of
// those steps runs the same checks (`serving`), so revoking a link, limiting
// the project to its organization, removing a member, removing the address
// from the list, an unsafe reputation verdict, an operator's deny entry, or a
// day's usage ceiling stops the link everywhere, within the proxy's five
// seconds of caching.

// ---------------------------------------------------------------------------
// Configuration

interface ReviewSetup {
  proxy: ProxyAddress;
  website: string;
}

/**
 * The deployment's review proxy, or null when review links are off: it needs
 * the proxy's address (`CRITIQS_REVIEW_PROXY_URL`) on a domain apart from the
 * website and the backend, the secret the proxy authenticates with
 * (`CRITIQS_PROXY_SECRET`), and the website that serves `/r/<key>`
 * (`CRITIQS_WEB_URL`).
 */
export function reviewSetup(): ReviewSetup | null {
  const proxy = parseProxyAddress(process.env.CRITIQS_REVIEW_PROXY_URL);
  const secret = process.env.CRITIQS_PROXY_SECRET;
  const website = threadPageWebsite();
  if (proxy === null || website === null || secret === undefined || secret.length < MIN_PROXY_SECRET) return null;
  if (!proxySeparate(proxy, [website, ...backendAddresses()])) return null;
  return { proxy, website: website.replace(/\/$/, "") };
}

function backendAddresses(): string[] {
  return [process.env.CONVEX_SITE_URL, process.env.CONVEX_CLOUD_URL].filter((value): value is string => !!value);
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Where reputation verdicts come from: Google Web Risk with
 * `CRITIQS_WEB_RISK_API_KEY`; without a key, a fixture only when the proxy is
 * on this computer (`*.localhost`), which calls the hosts listed in
 * `CRITIQS_REVIEW_TEST_UNSAFE_HOSTS` unsafe and every other one clean. Null
 * otherwise: no link is ever served.
 */
function reputationSource(setup: ReviewSetup | null): "web-risk" | "fixture" | null {
  if (process.env.CRITIQS_WEB_RISK_API_KEY) return "web-risk";
  return setup !== null && isLocalhostName(setup.proxy.hostname) ? "fixture" : null;
}

/** What `/critiqs/config` reports as `reviewLinks`; null leaves it out. */
export function reviewLinksCapability(): ReviewLinksCapability | null {
  const setup = reviewSetup();
  if (setup === null) return null;
  // A shared build has no address to check, so it needs only the proxy.
  return { version: 1, live: reputationSource(setup) !== null, builds: true, allowCritiqs: false };
}

/** The shortest gap between two reputation checks of one link that opening it starts. */
const REPUTATION_ATTEMPT_MS = 60_000;

// ---------------------------------------------------------------------------
// Keys

/** The key ring version new links use. */
export const KEY_VERSION = 1;
const ringName = (version: number) => `review-link-key:v${version}`;

/** The key ring's secret for `version`, made on first use in a mutation. Never leaves the backend. */
export async function ringSecret(ctx: QueryCtx | MutationCtx, version: number): Promise<string | null> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", ringName(version)))
    .unique();
  if (row !== null) return row.value;
  if (!("insert" in ctx.db)) return null;
  const value = newSecret();
  await (ctx as MutationCtx).db.insert("settings", { key: ringName(version), value });
  return value;
}

export async function linkKey(ctx: QueryCtx | MutationCtx, link: Doc<"reviewLinks">): Promise<string | null> {
  const secret = await ringSecret(ctx, link.keyVersion);
  return secret === null ? null : await deriveLinkKey(secret, link._id, link.keyVersion);
}

async function linkByKey(ctx: QueryCtx | MutationCtx, key: string): Promise<Doc<"reviewLinks"> | null> {
  const keyHash = await linkKeyHash(key);
  return await ctx.db
    .query("reviewLinks")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
}

// ---------------------------------------------------------------------------
// The checks every step runs

const denySubjects = (link: Doc<"reviewLinks">) => [
  `link:${link._id}`,
  `project:${link.projectId}`,
  `origin:${link.origin}`,
  ...link.assetOrigins.map((origin) => `origin:${origin}`),
];

async function denied(ctx: QueryCtx, subject: string): Promise<boolean> {
  return (
    (await ctx.db
      .query("reviewDeny")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .first()) !== null
  );
}

/** Whether an exact origin is still in the project's address list (`listsOrigin`); a pattern that matches it doesn't count. */
async function listed(ctx: QueryCtx, projectId: Id<"projects">, origin: string): Promise<boolean> {
  const project = await ctx.db.get(projectId);
  if (project === null) return false;
  const rows = await ctx.db
    .query("projectAddresses")
    .withIndex("by_project_key", (q) => q.eq("projectId", projectId).eq("key", origin))
    .take(10);
  return rows.some((row) => listsOrigin(project, row, origin));
}

export async function usageToday(ctx: QueryCtx, linkId: Id<"reviewLinks">, now: number): Promise<Doc<"reviewUsage"> | null> {
  return await ctx.db
    .query("reviewUsage")
    .withIndex("by_link_day", (q) => q.eq("linkId", linkId).eq("day", utcDay(now)))
    .unique();
}

export function pausedBy(usage: Doc<"reviewUsage"> | null): boolean {
  return usage !== null && (usage.requests >= REVIEW_LINK_LIMITS.requestsPerLinkPerDay || usage.bytes >= REVIEW_LINK_LIMITS.bytesPerLinkPerDay);
}

type Serving = "ok" | "denied" | "pending" | "limited";

/**
 * Whether a link may be shown, now, to `userId` (null: someone signed out).
 * `denied` comes before anything that would tell someone who may not open the
 * link more about it; `pending` (no fresh clean reputation verdict) and
 * `limited` (today's usage ceiling) come only after the access check.
 */
async function serving(
  ctx: QueryCtx,
  store: Store,
  link: Doc<"reviewLinks">,
  project: Doc<"projects"> | null,
  userId: string | null,
  now: number,
): Promise<Serving> {
  if (reviewSetup() === null || project === null || project._id !== link.projectId) return "denied";
  if (link.status === "revoked" || link.status === "blocked") return "denied";
  for (const subject of denySubjects(link)) if (await denied(ctx, subject)) return "denied";
  if (!(await canReview(store, project, userId))) return "denied";
  if (link.kind === "share") {
    // A shared build serves only while it is published and unexpired; it has no address to keep listed or to check.
    const build = link.buildId === undefined ? null : await ctx.db.get(link.buildId);
    if (build === null || build.status !== "ready" || build.expiresAt === undefined || build.expiresAt <= now || build.linkId !== link._id) return "denied";
    return pausedBy(await usageToday(ctx, link._id, now)) ? "limited" : "ok";
  }
  if (!(await listed(ctx, project._id, link.origin))) return "denied";
  if (link.status !== "active" || link.checkedAt === undefined || now - link.checkedAt > REPUTATION_MAX_AGE_MS) return "pending";
  if (reputationSource(reviewSetup()) === null) return "pending";
  if (pausedBy(await usageToday(ctx, link._id, now))) return "limited";
  return "ok";
}

const live = (lease: Doc<"reviewLeases">, now: number) => now < lease.expiresAt && now < lease.deadline;

/** A lease, its link, and its project, when `renewalSecret` is the lease's and it hasn't ended; otherwise null. */
async function heldLease(ctx: QueryCtx, leaseId: string, secret: string, now: number) {
  const id = ctx.db.normalizeId("reviewLeases", leaseId);
  const lease = id === null ? null : await ctx.db.get(id);
  if (lease === null || !live(lease, now) || (await renewalHash(secret)) !== lease.renewalHash) return null;
  const link = await ctx.db.get(lease.linkId);
  if (link === null) return null;
  return { lease, link, project: await ctx.db.get(link.projectId) };
}

/** The signed-in person's record, without writing; null when signed out, unverified, or never seen. */
async function viewerId(ctx: QueryCtx, store: Store): Promise<Id<"users"> | null> {
  const identity = await identityOf(ctx);
  if (identity === null || !identity.emailVerified || !identity.email) return null;
  return ((await store.users.byToken(identity.tokenIdentifier))?._id as Id<"users"> | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Owners: create, list, copy, revoke

export const OWNERS_ONLY = "Only the project's owners can create or change its review links.";
export const OFF = "Review links aren't set up on this deployment.";
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const REQUEST_KEY_MS = 24 * 60 * 60_000;

/**
 * The signed-in owner and the project they manage; refuses everyone else.
 * Reads only, so a query can use it: an owner always has a user record, and
 * someone the deployment has never seen gets the same refusal as any
 * non-owner.
 */
export async function managed(ctx: QueryCtx, store: Store, projectId: string) {
  const { user } = await operations.currentReviewer(store, await identityOf(ctx));
  if (user === null) fail("forbidden", OWNERS_ONLY);
  const project = await operations.requireProject(store, user, projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", OWNERS_ONLY);
  return { user, project: project as unknown as Doc<"projects"> };
}

async function managedLink(ctx: QueryCtx, store: Store, linkId: string) {
  // Signed in first, so someone signed out learns nothing about which IDs exist.
  await operations.currentReviewer(store, await identityOf(ctx));
  const id = ctx.db.normalizeId("reviewLinks", linkId);
  const link = id === null ? null : await ctx.db.get(id);
  if (link === null) fail("not-found", "This review link does not exist.");
  return { ...(await managed(ctx, store, link.projectId)), link };
}

function bareOrigin(input: string, refused: string[]): string {
  const address = parseLiveAddress(input, refused);
  if (address.path !== "/" || /[?#]/.test(input.trim().replace(/\/$/, "").slice(address.origin.length))) {
    fail("invalid", "List other origins without a path, such as https://api.acme.com.");
  }
  return address.origin;
}

/**
 * Creates a review link for a prototype at `address`, opening at its path. The
 * origin, and each of `assetOrigins` (other origins its pages read from, at
 * most four), are added to the project's address list if they aren't there
 * exactly. The link starts `checking` until the reputation provider has a
 * verdict. With `requestKey`, a retry by the same person within a day returns
 * the link the first call created. Only the project's owners may.
 */
export const createLive = mutation({
  args: {
    projectId: v.string(),
    address: v.string(),
    assetOrigins: v.optional(v.array(v.string())),
    requestKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ linkId: Id<"reviewLinks">; key: string; url: string; status: Doc<"reviewLinks">["status"] }> =>
    run(async () => {
      const store = convexStore(ctx);
      const setup = reviewSetup();
      if (setup === null) fail("unavailable", OFF);
      const identity = await identityOf(ctx);
      const { user, project } = await managed(ctx, store, args.projectId);
      const now = Date.now();
      const answer = async (link: Doc<"reviewLinks">) => {
        const key = (await linkKey(ctx, link))!;
        return { linkId: link._id, key, url: `${setup.website}/r/${key}`, status: link.status };
      };
      if (args.requestKey !== undefined) {
        if (!REQUEST_KEY.test(args.requestKey)) fail("invalid", "This request key isn't valid.");
        const earlier = await ctx.db
          .query("reviewLinks")
          .withIndex("by_creator_request", (q) => q.eq("createdBy", user._id as Id<"users">).eq("requestKey", args.requestKey))
          .order("desc")
          .first();
        if (earlier !== null && earlier.projectId === project._id && earlier.status !== "revoked" && now - earlier.createdAt < REQUEST_KEY_MS) {
          return await answer(earlier);
        }
      }

      const refused = [setup.proxy.hostname, new URL(setup.website).hostname, ...backendAddresses().map((value) => new URL(value).hostname)];
      const address = parseLiveAddress(args.address, refused);
      const assetOrigins: string[] = [];
      for (const input of args.assetOrigins ?? []) {
        const origin = bareOrigin(input, refused);
        if (origin !== address.origin && !assetOrigins.includes(origin)) assetOrigins.push(origin);
      }
      if (assetOrigins.length > REVIEW_LINK_LIMITS.assetOrigins) {
        fail("invalid", `A review link can read from at most ${REVIEW_LINK_LIMITS.assetOrigins} other origins.`);
      }

      let open = 0;
      for (const status of ["checking", "active"] as const) {
        open += (
          await ctx.db
            .query("reviewLinks")
            .withIndex("by_project_status", (q) => q.eq("projectId", project._id).eq("status", status))
            .take(REVIEW_LINK_LIMITS.activePerProject)
        ).length;
      }
      if (open >= REVIEW_LINK_LIMITS.activePerProject) {
        fail("limit", `A project can have ${REVIEW_LINK_LIMITS.activePerProject} review links at once. Remove one first.`);
      }
      const day = `reviewLinkCreates:${user._id}:${utcDay(now)}`;
      if (!(await countWithinAll(store, [[day, REVIEW_LINK_LIMITS.createsPerPersonPerDay]]))) {
        fail("limit", `You can create ${REVIEW_LINK_LIMITS.createsPerPersonPerDay} review links a day. Try again tomorrow.`);
      }

      for (const origin of [address.origin, ...assetOrigins]) await addProjectAddress(store, identity, { projectId: project._id, address: origin });
      const linkId = await ctx.db.insert("reviewLinks", {
        projectId: project._id,
        kind: "site",
        origin: address.origin,
        startPath: address.path,
        assetOrigins,
        keyHash: "",
        keyVersion: KEY_VERSION,
        status: "checking",
        createdBy: user._id as Id<"users">,
        createdAt: now,
        ...(args.requestKey === undefined ? {} : { requestKey: args.requestKey }),
      });
      const secret = (await ringSecret(ctx, KEY_VERSION))!;
      const key = await deriveLinkKey(secret, linkId, KEY_VERSION);
      await ctx.db.patch(linkId, { keyHash: await linkKeyHash(key) });
      await ctx.scheduler.runAfter(0, internal.reviewLinks.checkReputation, { linkId });
      return { linkId, key, url: `${setup.website}/r/${key}`, status: "checking" as const };
    }),
});

/** The project's review links that aren't revoked, for its owners. Never their keys. */
export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<ReviewLinkSummary[]> =>
    run(async () => {
      const store = convexStore(ctx);
      const { project } = await managed(ctx, store, args.projectId);
      const now = Date.now();
      const links: Doc<"reviewLinks">[] = [];
      for (const status of ["active", "checking", "blocked"] as const) {
        links.push(
          ...(await ctx.db
            .query("reviewLinks")
            .withIndex("by_project_status", (q) => q.eq("projectId", project._id).eq("status", status))
            .take(REVIEW_LINK_LIMITS.activePerProject * 2)),
        );
      }
      links.sort((a, b) => b.createdAt - a.createdAt);
      const summaries: ReviewLinkSummary[] = [];
      for (const link of links) {
        const usage = await usageToday(ctx, link._id, now);
        const build = link.buildId === undefined ? null : await ctx.db.get(link.buildId);
        summaries.push({
          linkId: link._id,
          kind: link.kind,
          origin: link.origin,
          startPath: link.startPath,
          assetOrigins: link.assetOrigins,
          status: link.status,
          paused: pausedBy(usage),
          createdAt: link.createdAt,
          createdByName: (await ctx.db.get(link.createdBy))?.name ?? "Reviewer",
          usageToday: { requests: usage?.requests ?? 0, bytes: usage?.bytes ?? 0 },
          build: build === null ? null : { buildId: build._id, fileCount: build.fileCount, bytes: build.bytes, expiresAt: build.expiresAt ?? build.createdAt },
        });
      }
      return summaries;
    }),
});

/** A link's address again, derived from its ID, for the project's owners. Refused once revoked. */
export const copy = query({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<{ key: string; url: string }> =>
    run(async () => {
      const setup = reviewSetup();
      if (setup === null) fail("unavailable", OFF);
      const { link } = await managedLink(ctx, convexStore(ctx), args.linkId);
      if (link.status === "revoked") fail("unavailable", "This review link was removed.");
      const key = await linkKey(ctx, link);
      if (key === null) fail("unavailable", "This review link was removed.");
      return { key, url: `${setup.website}/r/${key}` };
    }),
});

/** Revokes a link for good: it stops opening, renewing, and serving at once. Revoking again changes nothing. */
export const revoke = mutation({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<null> =>
    run(async () => {
      const { link } = await managedLink(ctx, convexStore(ctx), args.linkId);
      await revokeLink(ctx, link);
      // A shared build's link is the build: removing one removes the other, and its files go with cleanup.
      if (link.buildId !== undefined) await endBuild(ctx, link.buildId, "deleted");
      return null;
    }),
});

/** Revokes a link for good and removes its leases; every check already refuses it, and the leases go now, or with cleanup. */
export async function revokeLink(ctx: MutationCtx, link: Doc<"reviewLinks">) {
  if (link.status !== "revoked") await ctx.db.patch(link._id, { status: "revoked", revokedAt: Date.now() });
  for (const lease of await ctx.db
    .query("reviewLeases")
    .withIndex("by_link", (q) => q.eq("linkId", link._id))
    .take(100)) {
    await removeLease(ctx, lease._id);
  }
}

/**
 * Ends a shared build: it stops serving at once, its link is revoked, and
 * cleanup removes its stored files. Threads left on it stay, with the
 * build's `.build.invalid` address. Ending it again changes nothing.
 */
export async function endBuild(ctx: MutationCtx, buildId: Id<"reviewBuilds">, status: "expired" | "deleted") {
  const build = await ctx.db.get(buildId);
  if (build === null) return;
  if (build.status === "uploading" || build.status === "ready") await ctx.db.patch(build._id, { status, endedAt: Date.now() });
  const link = build.linkId === undefined ? null : await ctx.db.get(build.linkId);
  if (link !== null) await revokeLink(ctx, link);
  await ctx.scheduler.runAfter(0, internal.reviewBuilds.purge, {});
}

async function removeLease(ctx: MutationCtx, leaseId: Id<"reviewLeases">) {
  for (const host of await ctx.db
    .query("reviewFrameHosts")
    .withIndex("by_lease", (q) => q.eq("leaseId", leaseId))
    .take(10)) {
    await ctx.db.delete(host._id);
  }
  await ctx.db.delete(leaseId);
}

// ---------------------------------------------------------------------------
// Viewers: open, renew, adopt, recordOpened

/** Counts a new lease against the link's hourly ceiling; false at the ceiling. */
async function countLease(ctx: MutationCtx, linkId: Id<"reviewLinks">, now: number): Promise<boolean> {
  const hour = new Date(now).toISOString().slice(0, 13);
  const usage = await usageToday(ctx, linkId, now);
  if (usage === null) {
    await ctx.db.insert("reviewUsage", { linkId, day: utcDay(now), requests: 0, bytes: 0, leaseHour: hour, leases: 1 });
    return true;
  }
  const leases = usage.leaseHour === hour ? usage.leases : 0;
  if (leases >= REVIEW_LINK_LIMITS.leasesPerLinkPerHour) return false;
  await ctx.db.patch(usage._id, { leaseHour: hour, leases: leases + 1 });
  return true;
}

/**
 * Opens a review link by its key. With review access `anyone`, anyone with the
 * key gets a lease, and only someone signed in learns the project; limited to
 * its organization, only its members do. See `ReviewOpen` for the answers.
 * Each answer that isn't ready says nothing about whether the key exists.
 */
export const open = mutation({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<ReviewOpen> =>
    run(async () => {
      const store = convexStore(ctx);
      const identity = await identityOf(ctx);
      const signedIn = identity !== null && identity.emailVerified && !!identity.email;
      const refused: ReviewOpen = signedIn ? { kind: "unavailable" } : { kind: "sign-in" };
      const setup = reviewSetup();
      if (setup === null || !REVIEW_LINK_KEY.test(args.key)) return refused;
      const link = await linkByKey(ctx, args.key);
      if (link === null) return refused;
      const project = await ctx.db.get(link.projectId);
      const user = signedIn ? await operations.requireUser(store, identity) : null;
      const now = Date.now();
      const verdict = await serving(ctx, store, link, project, user?._id ?? null, now);
      if (verdict === "denied") return refused;
      if (verdict === "pending") {
        // A stale verdict is checked again, at most once a minute however often the link is opened.
        if (link.status === "active" && (link.attemptedAt === undefined || now - link.attemptedAt >= REPUTATION_ATTEMPT_MS)) {
          await ctx.db.patch(link._id, { attemptedAt: now });
          await ctx.scheduler.runAfter(0, internal.reviewLinks.checkReputation, { linkId: link._id });
        }
        return { kind: "pending" };
      }
      if (verdict === "limited" || !(await countLease(ctx, link._id, now))) return { kind: "limited" };

      const build = link.buildId === undefined ? null : await ctx.db.get(link.buildId);
      const label = newFrameLabel();
      const renewalSecret = newSecret();
      const expiresAt = now + REVIEW_LEASE_MS;
      const leaseId = await ctx.db.insert("reviewLeases", {
        linkId: link._id,
        ...(user === null ? {} : { userId: user._id as Id<"users"> }),
        renewalHash: await renewalHash(renewalSecret),
        issuedAt: now,
        expiresAt,
        deadline: now + REVIEW_LEASE_MAX_MS,
      });
      await ctx.db.insert("reviewFrameHosts", { hostHash: await frameHostHash(label), leaseId, linkId: link._id });
      return {
        kind: "ready",
        entry: { origin: frameOrigin(setup.proxy, label), path: link.startPath, leaseId, renewalSecret, expiresAt, renewEveryMs: RENEW_EVERY_MS },
        projectId: user === null ? null : project!._id,
        projectName: user === null ? null : project!.name,
        source: build === null ? { kind: "site", origin: link.origin } : { kind: "share", origin: link.origin, expiresAt: build.expiresAt ?? now },
      };
    }),
});

/**
 * Keeps a lease for another `REVIEW_LEASE_MS`, up to its deadline, while every check
 * still passes for its viewer: the renewal secret, and for a signed-in lease
 * the same person. Anything else ends it.
 */
/**
 * Whether a lease still serves, for the review page around its frame, which
 * watches it: a link removed, paused, or closed to the viewer ends the session
 * on the page as soon as it happens, rather than at the next renewal, while
 * the proxy stops serving it within five seconds. The same checks as `renew`,
 * without renewing.
 */
export const leaseState = query({
  args: { leaseId: v.string(), renewalSecret: v.string() },
  handler: async (ctx, args): Promise<{ kind: "live" } | { kind: "ended" }> =>
    run(async () => {
      const store = convexStore(ctx);
      const now = Date.now();
      const held = await heldLease(ctx, args.leaseId, args.renewalSecret, now);
      if (held === null) return { kind: "ended" };
      const { lease, link, project } = held;
      if (lease.userId !== undefined && (await viewerId(ctx, store)) !== lease.userId) return { kind: "ended" };
      return (await serving(ctx, store, link, project, lease.userId ?? null, now)) === "ok" ? { kind: "live" } : { kind: "ended" };
    }),
});

export const renew = mutation({
  args: { leaseId: v.string(), renewalSecret: v.string() },
  handler: async (ctx, args): Promise<ReviewRenewal> =>
    run(async () => {
      const store = convexStore(ctx);
      const now = Date.now();
      const held = await heldLease(ctx, args.leaseId, args.renewalSecret, now);
      if (held === null) return { kind: "ended" };
      const { lease, link, project } = held;
      if (lease.userId !== undefined && (await viewerId(ctx, store)) !== lease.userId) return { kind: "ended" };
      if ((await serving(ctx, store, link, project, lease.userId ?? null, now)) !== "ok") return { kind: "ended" };
      const expiresAt = Math.min(now + REVIEW_LEASE_MS, lease.deadline);
      await ctx.db.patch(lease._id, { expiresAt });
      return { kind: "renewed", expiresAt };
    }),
});

/**
 * Binds an anonymous lease to the person who just signed in, so the frame and
 * what they picked stay as they were, and tells them the project. Only while
 * the lease would still be served both signed out and to them; adopting again
 * as the same person answers the same.
 */
export const adopt = mutation({
  args: { leaseId: v.string(), renewalSecret: v.string() },
  handler: async (ctx, args): Promise<ReviewAdoption> =>
    run(async () => {
      const store = convexStore(ctx);
      const user = await operations.requireUser(store, await identityOf(ctx));
      const now = Date.now();
      const held = await heldLease(ctx, args.leaseId, args.renewalSecret, now);
      if (held === null || held.project === null) return { kind: "ended" };
      const { lease, link, project } = held;
      if (lease.userId !== undefined && lease.userId !== user._id) return { kind: "ended" };
      if (lease.userId === undefined && (await serving(ctx, store, link, project, null, now)) !== "ok") return { kind: "ended" };
      if ((await serving(ctx, store, link, project, user._id, now)) !== "ok") return { kind: "ended" };
      if (lease.userId === undefined) await ctx.db.patch(lease._id, { userId: user._id as Id<"users"> });
      return { kind: "adopted", projectId: project._id, projectName: project.name };
    }),
});

/**
 * Records that the lease's signed-in viewer opened the project, as an install
 * does, so the extension's lookup searches it too. The review page calls it
 * once the frame connects. Does nothing for an anonymous lease.
 */
export const recordOpened = mutation({
  args: { leaseId: v.string(), renewalSecret: v.string() },
  handler: async (ctx, args): Promise<boolean> =>
    run(async () => {
      const store = convexStore(ctx);
      const now = Date.now();
      const held = await heldLease(ctx, args.leaseId, args.renewalSecret, now);
      if (held === null || held.lease.userId === undefined) return false;
      if ((await viewerId(ctx, store)) !== held.lease.userId) return false;
      if ((await serving(ctx, store, held.link, held.project, held.lease.userId, now)) !== "ok") return false;
      await recordProjectOpened(store, await identityOf(ctx), { projectId: held.link.projectId });
      return true;
    }),
});

// ---------------------------------------------------------------------------
// The proxy: `/internal/review/v1/*` (reviewHttp.ts)

/** What a frame host stands for now, or null for anything that must serve nothing. */
export const resolveHost = internalQuery({
  // `now` is the time the proxy asked, passed in by the HTTP action: a query
  // judged by its own clock could be answered from Convex's cache after the
  // lease or link ended, as long as nothing it read changed.
  args: { hostHash: v.string(), now: v.number() },
  handler: async (ctx, { hostHash, now }): Promise<ReviewResolution | null> => (await hostResolution(ctx, hostHash, now))?.resolution ?? null,
});

/**
 * What a frame host stands for now, with its link, or null for anything that
 * must serve nothing: every check `serving` runs, for the lease's viewer.
 * The proxy's resolve and a shared build's file routes all start here.
 */
export async function hostResolution(ctx: QueryCtx, hostHash: string, now: number = Date.now()): Promise<{ resolution: ReviewResolution; link: Doc<"reviewLinks"> } | null> {
  if (!HOST_HASH.test(hostHash)) return null;
  const host = await ctx.db
    .query("reviewFrameHosts")
    .withIndex("by_host_hash", (q) => q.eq("hostHash", hostHash))
    .unique();
  if (host === null) return null;
  const lease = await ctx.db.get(host.leaseId);
  if (lease === null || !live(lease, now)) return null;
  const link = await ctx.db.get(lease.linkId);
  if (link === null || link._id !== host.linkId) return null;
  const project = await ctx.db.get(link.projectId);
  if ((await serving(ctx, convexStore(ctx), link, project, lease.userId ?? null, now)) !== "ok") return null;
  const assetOrigins: ReviewResolution["assetOrigins"] = [];
  for (const [index, origin] of link.assetOrigins.entries()) {
    if (link.kind === "site" && (await listed(ctx, link.projectId, origin))) assetOrigins.push({ slot: index + 1, origin });
  }
  const expiresAt = Math.min(lease.expiresAt, lease.deadline);
  const resolution: ReviewResolution = {
    v: 1,
    kind: link.kind,
    linkId: link._id,
    leaseId: lease._id,
    origin: link.origin,
    assetOrigins,
    // Allow Critiqs tokens come with Allow Critiqs; until then the proxy sends none.
    allow: [],
    expiresAt,
    cacheUntil: Math.min(now + RESOLUTION_CACHE_MS, expiresAt),
  };
  return { resolution, link };
}

/** Adds the proxy's traffic reports to each link's day; returns the links now past the day's ceiling. */
export const recordUsage = internalMutation({
  args: { reports: v.array(v.object({ linkId: v.string(), requests: v.number(), bytes: v.number() })) },
  handler: async (ctx, { reports }): Promise<{ paused: string[] }> => {
    const now = Date.now();
    const paused: string[] = [];
    for (const report of reports.slice(0, REVIEW_LINK_LIMITS.usageReports)) {
      const linkId = ctx.db.normalizeId("reviewLinks", report.linkId);
      if (linkId === null || !Number.isSafeInteger(report.requests) || !Number.isSafeInteger(report.bytes)) continue;
      if (report.requests < 0 || report.bytes < 0 || (await ctx.db.get(linkId)) === null) continue;
      let usage = await usageToday(ctx, linkId, now);
      if (usage === null) {
        const id = await ctx.db.insert("reviewUsage", {
          linkId,
          day: utcDay(now),
          requests: report.requests,
          bytes: report.bytes,
          leaseHour: "",
          leases: 0,
        });
        usage = (await ctx.db.get(id))!;
      } else {
        await ctx.db.patch(usage._id, { requests: usage.requests + report.requests, bytes: usage.bytes + report.bytes });
        usage = { ...usage, requests: usage.requests + report.requests, bytes: usage.bytes + report.bytes };
      }
      if (pausedBy(usage) && !paused.includes(linkId)) paused.push(linkId);
    }
    return { paused };
  },
});

// ---------------------------------------------------------------------------
// Reputation

/** A link's addresses as the reputation provider is asked about them. */
export const reputationSubjects = internalQuery({
  args: { linkId: v.id("reviewLinks") },
  handler: async (ctx, { linkId }): Promise<string[] | null> => {
    const link = await ctx.db.get(linkId);
    // A shared build has no address on the web: nothing to ask about.
    if (link === null || link.kind === "share" || link.status === "revoked" || link.status === "blocked") return null;
    return [reputationSubject(link.origin, link.startPath), ...link.assetOrigins.map((origin) => reputationSubject(origin, "/"))];
  },
});

async function verdictFor(subject: string): Promise<ReputationVerdict> {
  const source = reputationSource(reviewSetup());
  if (source === "web-risk") return await webRiskVerdict(subject, { apiKey: process.env.CRITIQS_WEB_RISK_API_KEY! });
  if (source === "fixture") {
    const unsafe = (process.env.CRITIQS_REVIEW_TEST_UNSAFE_HOSTS ?? "").split(/[\s,]+/).map((host) => canonicalHost(host)).filter((host): host is string => host !== null);
    const host = hostOf(new URL(subject));
    return host !== null && unsafe.includes(host) ? "unsafe" : "clean";
  }
  return "unknown";
}

/** Asks the reputation provider about a link's addresses and records the verdict. */
export const checkReputation = internalAction({
  args: { linkId: v.id("reviewLinks") },
  handler: async (ctx, { linkId }): Promise<ReputationVerdict | null> => {
    const subjects = await ctx.runQuery(internal.reviewLinks.reputationSubjects, { linkId });
    if (subjects === null) return null;
    let verdict: ReputationVerdict = "clean";
    for (const subject of subjects) {
      const each = await verdictFor(subject);
      if (each === "unsafe") {
        verdict = "unsafe";
        break;
      }
      if (each === "unknown") verdict = "unknown";
    }
    await ctx.runMutation(internal.reviewLinks.recordReputation, { linkId, verdict });
    return verdict;
  },
});

/**
 * Records a verdict: unsafe blocks the link for good; clean makes it active
 * and fresh; unknown changes nothing, so a link with no fresh verdict is never
 * served (see `REPUTATION_MAX_AGE_MS`).
 */
export const recordReputation = internalMutation({
  args: { linkId: v.id("reviewLinks"), verdict: v.union(v.literal("clean"), v.literal("unsafe"), v.literal("unknown")) },
  handler: async (ctx, { linkId, verdict }) => {
    const link = await ctx.db.get(linkId);
    if (link === null || link.status === "revoked" || link.status === "blocked") return;
    const now = Date.now();
    if (verdict === "unknown") {
      // Nothing learned, but the attempt counts, so the next round takes links that waited longer.
      await ctx.db.patch(linkId, { attemptedAt: now });
      return;
    }
    await ctx.db.patch(linkId, verdict === "unsafe" ? { status: "blocked", checkedAt: now, attemptedAt: now } : { status: "active", checkedAt: now, attemptedAt: now });
  },
});

/** Checks again links still waiting for a verdict, and active ones whose verdict is a day old. */
export const recheckReputation = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = [
      // Links never tried first, then the ones whose last try is oldest, so links stuck waiting can't starve newer ones.
      ...(await ctx.db
        .query("reviewLinks")
        .withIndex("by_status_attempted", (q) => q.eq("status", "checking"))
        .take(50)),
      ...(await ctx.db
        .query("reviewLinks")
        .withIndex("by_status_checked", (q) => q.eq("status", "active").gt("checkedAt", 0).lt("checkedAt", now - REPUTATION_RECHECK_MS))
        .take(50)),
    ];
    for (const link of due) await ctx.scheduler.runAfter(0, internal.reviewLinks.checkReputation, { linkId: link._id });
    return due.length;
  },
});

// ---------------------------------------------------------------------------
// Operators and cleanup

function denySubject(args: { linkId?: string; projectId?: string; origin?: string }): string {
  const given = [args.linkId, args.projectId, args.origin].filter((value) => value !== undefined);
  if (given.length !== 1) throw new Error("Name exactly one of linkId, projectId, or origin.");
  if (args.linkId !== undefined) return `link:${args.linkId}`;
  if (args.projectId !== undefined) return `project:${args.projectId}`;
  const url = new URL(args.origin!);
  const host = hostOf(url);
  if (host === null || url.origin !== args.origin!.replace(/\/$/, "")) throw new Error("Give an origin without a path, such as https://acme-proto.vercel.app.");
  // The same spelling links store (`parseLiveAddress`), so a trailing dot can't miss.
  if (!url.hostname.startsWith("[")) url.hostname = host;
  return `origin:${url.origin}`;
}

const denyArgs = { linkId: v.optional(v.id("reviewLinks")), projectId: v.optional(v.id("projects")), origin: v.optional(v.string()) };

/**
 * An operator's takedown, effective on the proxy's next question (at most five
 * seconds): `npx convex run reviewLinks:deny '{"origin":"https://x.example","reason":"phishing report"}'`.
 */
export const deny = internalMutation({
  args: { ...denyArgs, reason: v.string() },
  handler: async (ctx, { reason, ...target }) => {
    const subject = denySubject(target);
    const existing = await ctx.db
      .query("reviewDeny")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .first();
    if (existing === null) await ctx.db.insert("reviewDeny", { subject, reason, createdAt: Date.now() });
    return subject;
  },
});

/** Lifts an operator's takedown: `npx convex run reviewLinks:undeny '{"origin":"https://x.example"}'`. */
export const undeny = internalMutation({
  args: denyArgs,
  handler: async (ctx, target) => {
    const subject = denySubject(target);
    for (const row of await ctx.db
      .query("reviewDeny")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .take(10)) {
      await ctx.db.delete(row._id);
    }
    return subject;
  },
});

/** Removes ended leases with their frame hosts, and usage older than yesterday. A batch per run; it schedules the next. */
export const cleanUp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const ended = await ctx.db
      .query("reviewLeases")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
      .take(200);
    for (const lease of ended) await removeLease(ctx, lease._id);
    const yesterday = utcDay(now - 24 * 60 * 60_000);
    const old = await ctx.db
      .query("reviewUsage")
      .withIndex("by_day", (q) => q.lt("day", yesterday))
      .take(200);
    for (const row of old) await ctx.db.delete(row._id);
    if (ended.length === 200 || old.length === 200) await ctx.scheduler.runAfter(0, internal.reviewLinks.cleanUp, {});
    return { leases: ended.length, usage: old.length };
  },
});
