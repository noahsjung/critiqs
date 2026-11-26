import {
  addProjectAddress,
  ALLOW_CHECKS_PER_PERSON_PER_HOUR,
  ALLOW_CHECKS_PER_PROJECT_PER_HOUR,
  ALLOW_RECHECK_MS,
  ALLOW_HEADER,
  ALLOW_PROOF_PATH,
  type AllowCheckResult,
  type AllowCritiqsSetup,
  allowProof,
  allowProofLine,
  allowToken,
  countWithinAll,
  fail,
  parseAllowProbe,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { allowKey, backendAddresses, bareOrigin, listed, managed, OFF, reviewLinksCapability, reviewSetup } from "./reviewLinks";

// Allow Critiqs: how a site behind a bot wall or firewall lets the review
// proxy in for one project, and only that project. The proxy's user agent and
// egress addresses are the same for every customer, so they never decide
// anything; a project's owners get a token for one exact origin of theirs
// (`issue`), add a firewall rule that lets requests carrying it in, and
// publish the project's proof at `/.well-known/critiqs-allow.txt`. **Check
// again** (`check`) asks the proxy to fetch the site from its own egress with
// the token, and only once that finds the site open and the proof in place do
// the project's leases carry the token to that origin (`allowTokens` in
// reviewLinks.ts). A new version (`rotate`) replaces the token at once. An
// allowed site is checked again on its own every `ALLOW_RECHECK_MS`
// (`recheck`), so removing the proof, or the rule, ends the allowance
// without anyone pressing Check again.

const NOT_OFFERED = "Allow Critiqs isn't set up on this deployment.";

async function rowFor(ctx: QueryCtx, projectId: Id<"projects">, origin: string): Promise<Doc<"reviewAllow"> | null> {
  return await ctx.db
    .query("reviewAllow")
    .withIndex("by_project_origin", (q) => q.eq("projectId", projectId).eq("origin", origin))
    .unique();
}

async function setupOf(ctx: QueryCtx | MutationCtx, row: Doc<"reviewAllow">): Promise<AllowCritiqsSetup> {
  const secret = (await allowKey(ctx))!;
  const setup = reviewSetup()!;
  return {
    projectId: row.projectId,
    origin: row.origin,
    header: ALLOW_HEADER,
    token: await allowToken(secret, row.projectId, row.origin, row.version),
    proofPath: ALLOW_PROOF_PATH,
    proofLine: allowProofLine(await allowProof(secret, row.projectId, row.origin, row.version)),
    userAgent: "Critiqs-Review/1",
    wellKnownUrl: `${setup.proxy.protocol}//${setup.proxy.host}/.well-known/critiqs-review.json`,
    verifiedAt: row.verifiedAt ?? null,
    lastCheck: row.lastResult === undefined || row.checkedAt === undefined ? null : { result: row.lastResult, proof: row.lastProof ?? false, at: row.checkedAt },
  };
}

/** The signed-in owner's project and the exact origin asked about, read only. */
async function ownerAndOrigin(ctx: QueryCtx, projectId: string, input: string) {
  if (reviewLinksCapability()?.allowCritiqs !== true) fail("unavailable", NOT_OFFERED);
  const setup = reviewSetup()!;
  const { user, project } = await managed(ctx, convexStore(ctx), projectId);
  // Never the proxy, the website or the backend; and never a shared build's `.invalid` name, which no site has (parseLiveAddress).
  const refused = [setup.proxy.hostname, new URL(setup.website).hostname, ...backendAddresses().map((value) => new URL(value).hostname)];
  return { user, project, origin: bareOrigin(input, refused) };
}

/** The signed-in owner's project and the exact origin asked about, which joins the project's address list if it isn't there. */
async function ownedOrigin(ctx: MutationCtx, projectId: string, input: string) {
  const { user, project, origin } = await ownerAndOrigin(ctx, projectId, input);
  const store = convexStore(ctx);
  if (!(await listed(ctx, project._id, origin))) await addProjectAddress(store, await identityOf(ctx), { projectId: project._id, address: origin });
  return { user, project, origin };
}

/**
 * The Allow Critiqs setup a project's owners already made for one of its
 * origins, or null when there is none yet. Reads only: opening the Allow
 * Critiqs page from a link changes nothing until an owner presses its button
 * (`issue`).
 */
export const current = query({
  args: { projectId: v.string(), origin: v.string() },
  handler: async (ctx, args): Promise<AllowCritiqsSetup | null> =>
    run(async () => {
      const { project, origin } = await ownerAndOrigin(ctx, args.projectId, args.origin);
      const row = await rowFor(ctx, project._id, origin);
      return row === null ? null : await setupOf(ctx, row);
    }),
});

/**
 * A project's Allow Critiqs token and proof for one of its origins, for its
 * owners, made on first use. The origin joins the project's address list.
 */
export const issue = mutation({
  args: { projectId: v.string(), origin: v.string() },
  handler: async (ctx, args): Promise<AllowCritiqsSetup> =>
    run(async () => {
      const { user, project, origin } = await ownedOrigin(ctx, args.projectId, args.origin);
      let row = await rowFor(ctx, project._id, origin);
      if (row === null) {
        const id = await ctx.db.insert("reviewAllow", { projectId: project._id, origin, version: 1, createdBy: user._id as Id<"users">, createdAt: Date.now() });
        row = (await ctx.db.get(id))!;
      }
      return await setupOf(ctx, row);
    }),
});

/** Replaces the token and proof with new ones: the old token stops being sent at once, and the site must be checked again. */
export const rotate = mutation({
  args: { projectId: v.string(), origin: v.string() },
  handler: async (ctx, args): Promise<AllowCritiqsSetup> =>
    run(async () => {
      const { project, origin } = await ownedOrigin(ctx, args.projectId, args.origin);
      const row = await rowFor(ctx, project._id, origin);
      if (row === null) fail("not-found", "Set up Allow Critiqs for this address first.");
      await ctx.db.patch(row._id, { version: row.version + 1, verifiedAt: undefined, lastResult: undefined, lastProof: undefined, checkedAt: undefined, recheckAt: undefined });
      return await setupOf(ctx, (await ctx.db.get(row._id))!);
    }),
});

/** Starts a check: an owner, an issued token, and the project's hourly checks not used up. */
export const startCheck = internalMutation({
  args: { projectId: v.string(), origin: v.string() },
  handler: async (ctx, args): Promise<{ rowId: Id<"reviewAllow">; version: number; origin: string; token: string; proof: string }> =>
    run(async () => {
      const { user, project, origin } = await ownedOrigin(ctx, args.projectId, args.origin);
      const row = await rowFor(ctx, project._id, origin);
      if (row === null) fail("not-found", "Set up Allow Critiqs for this address first.");
      const hour = new Date().toISOString().slice(0, 13);
      const store = convexStore(ctx);
      if (!(await countWithinAll(store, [[`reviewAllowChecks:${project._id}:${hour}`, ALLOW_CHECKS_PER_PROJECT_PER_HOUR]]))) {
        fail("limit", `A project can check its Allow Critiqs rules ${ALLOW_CHECKS_PER_PROJECT_PER_HOUR} times an hour. Try again later.`);
      }
      // Per person too, across their projects: more projects never make more checks.
      if (!(await countWithinAll(store, [[`reviewAllowChecksBy:${user._id}:${hour}`, ALLOW_CHECKS_PER_PERSON_PER_HOUR]]))) {
        fail("limit", `You can check Allow Critiqs rules ${ALLOW_CHECKS_PER_PERSON_PER_HOUR} times an hour, across your projects. Try again later.`);
      }
      const secret = (await allowKey(ctx))!;
      return { rowId: row._id, version: row.version, origin, token: await allowToken(secret, project._id, origin, row.version), proof: await allowProof(secret, project._id, origin, row.version) };
    }),
});

/**
 * Records a check's coarse result; verified only when the site let the proxy
 * in and published the proof, for the token's current version. A check
 * nobody pressed (`automatic`) that couldn't reach the site, or found the
 * proxy busy, changes nothing but when it is tried again; one that reached it
 * and found the proof gone or the token refused ends the allowance.
 */
export const recordCheck = internalMutation({
  args: {
    rowId: v.id("reviewAllow"),
    version: v.number(),
    result: v.union(v.literal("public"), v.literal("blocked"), v.literal("sign-in"), v.literal("unreachable"), v.literal("unsafe"), v.literal("busy")),
    proof: v.boolean(),
    automatic: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    // A rotation meanwhile: this check was for a token no longer issued.
    if (row === null || row.version !== args.version) return;
    const now = Date.now();
    const verified = args.result === "public" && args.proof;
    const inconclusive = args.result === "busy" || (args.automatic === true && args.result === "unreachable");
    const allowed = verified || (inconclusive && row.verifiedAt !== undefined);
    await ctx.db.patch(row._id, {
      lastResult: args.result,
      lastProof: args.proof,
      checkedAt: now,
      ...(verified ? { verifiedAt: now } : inconclusive ? {} : { verifiedAt: undefined }),
      recheckAt: allowed ? now + ALLOW_RECHECK_MS : undefined,
    });
  },
});

/** Where the deployment asks its proxy to check a site: `CRITIQS_PROXY_PROBE_URL`, or the proxy's own address. */
function probeUrl(): string | null {
  const setup = reviewSetup();
  if (setup === null) return null;
  const base = process.env.CRITIQS_PROXY_PROBE_URL?.trim() || `${setup.proxy.protocol}//${setup.proxy.host}`;
  try {
    return new URL("/__critiqs/probe", base).toString();
  } catch {
    return null;
  }
}

/** Asks the review proxy at `url` to fetch `origin` with the token and look for the proof; what it found, coarsely. */
async function askProxy(url: string, started: { origin: string; token: string; proof: string }): Promise<{ result: AllowCheckResult; proof: boolean }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRITIQS_PROXY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: started.origin, token: started.token, proof: started.proof }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) return { result: "busy", proof: false };
    if (response.ok) return parseAllowProbe(await response.json().catch(() => null)) ?? { result: "unreachable", proof: false };
  } catch {
    // The proxy couldn't be asked: nothing is learned about the site.
  }
  return { result: "unreachable", proof: false };
}

/**
 * **Check again**: asks the review proxy to fetch the origin from its own
 * egress with the project's token, as a review link would, and to look for
 * the project's proof. Answers only what it found, coarsely; the site counts
 * as allowed, and leases carry its token, only when it was open and the proof
 * was there. Only the project's owners may, a limited number of times an hour.
 */
export const check = action({
  args: { projectId: v.string(), origin: v.string() },
  handler: async (ctx, args): Promise<{ result: AllowCheckResult; verified: boolean }> =>
    run(async () => {
      const url = probeUrl();
      if (url === null) fail("unavailable", OFF);
      const started = await ctx.runMutation(internal.reviewAllow.startCheck, args);
      const answer = await askProxy(url, started);
      await ctx.runMutation(internal.reviewAllow.recordCheck, { rowId: started.rowId, version: started.version, result: answer.result, proof: answer.proof });
      return { result: answer.result, verified: answer.result === "public" && answer.proof };
    }),
});

/** Allowed origins due to be checked again, the longest waiting first. */
export const due = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }): Promise<Id<"reviewAllow">[]> =>
    (
      await ctx.db
        .query("reviewAllow")
        .withIndex("by_recheck", (q) => q.gte("recheckAt", 0).lte("recheckAt", now))
        .take(RECHECKS_PER_RUN)
    ).map((row) => row._id),
});

/** What a check nobody pressed needs: the row's current token and proof, while it is still allowed. */
export const startRecheck = internalMutation({
  args: { rowId: v.id("reviewAllow") },
  handler: async (ctx, { rowId }): Promise<{ rowId: Id<"reviewAllow">; version: number; origin: string; token: string; proof: string } | null> => {
    const row = await ctx.db.get(rowId);
    const secret = await allowKey(ctx);
    if (row === null || row.verifiedAt === undefined || secret === null) return null;
    return { rowId: row._id, version: row.version, origin: row.origin, token: await allowToken(secret, row.projectId, row.origin, row.version), proof: await allowProof(secret, row.projectId, row.origin, row.version) };
  },
});

/** At most this many sites are checked again per run, one at a time, well inside the proxy's own check limits. */
const RECHECKS_PER_RUN = 25;

/**
 * Checks allowed sites again, `ALLOW_RECHECK_MS` after their last check: a
 * site whose proof is gone, or whose rule no longer lets the token in, stops
 * getting it then. A site that can't be reached, or a busy proxy, is tried
 * again later without ending anything.
 */
export const recheck = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const url = probeUrl();
    if (url === null) return;
    for (const rowId of await ctx.runQuery(internal.reviewAllow.due, { now: Date.now() })) {
      const started = await ctx.runMutation(internal.reviewAllow.startRecheck, { rowId });
      if (started === null) continue;
      const answer = await askProxy(url, started);
      await ctx.runMutation(internal.reviewAllow.recordCheck, { rowId, version: started.version, result: answer.result, proof: answer.proof, automatic: true });
    }
  },
});
