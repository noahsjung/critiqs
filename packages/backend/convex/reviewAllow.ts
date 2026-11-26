import {
  addProjectAddress,
  ALLOW_CHECKS_PER_PROJECT_PER_HOUR,
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
import { action, internalMutation, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
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
// reviewLinks.ts). A new version (`rotate`) replaces the token at once.

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
      await ctx.db.patch(row._id, { version: row.version + 1, verifiedAt: undefined, lastResult: undefined, lastProof: undefined, checkedAt: undefined });
      return await setupOf(ctx, (await ctx.db.get(row._id))!);
    }),
});

/** Starts a check: an owner, an issued token, and the project's hourly checks not used up. */
export const startCheck = internalMutation({
  args: { projectId: v.string(), origin: v.string() },
  handler: async (ctx, args): Promise<{ rowId: Id<"reviewAllow">; version: number; origin: string; token: string; proof: string }> =>
    run(async () => {
      const { project, origin } = await ownedOrigin(ctx, args.projectId, args.origin);
      const row = await rowFor(ctx, project._id, origin);
      if (row === null) fail("not-found", "Set up Allow Critiqs for this address first.");
      const hour = new Date().toISOString().slice(0, 13);
      if (!(await countWithinAll(convexStore(ctx), [[`reviewAllowChecks:${project._id}:${hour}`, ALLOW_CHECKS_PER_PROJECT_PER_HOUR]]))) {
        fail("limit", `A project can check its Allow Critiqs rules ${ALLOW_CHECKS_PER_PROJECT_PER_HOUR} times an hour. Try again later.`);
      }
      const secret = (await allowKey(ctx))!;
      return { rowId: row._id, version: row.version, origin, token: await allowToken(secret, project._id, origin, row.version), proof: await allowProof(secret, project._id, origin, row.version) };
    }),
});

/** Records a check's coarse result; verified only when the site let the proxy in and published the proof, for the token's current version. */
export const recordCheck = internalMutation({
  args: { rowId: v.id("reviewAllow"), version: v.number(), result: v.union(v.literal("public"), v.literal("blocked"), v.literal("sign-in"), v.literal("unreachable"), v.literal("unsafe"), v.literal("busy")), proof: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    // A rotation meanwhile: this check was for a token no longer issued.
    if (row === null || row.version !== args.version) return;
    const now = Date.now();
    const verified = args.result === "public" && args.proof;
    await ctx.db.patch(row._id, { lastResult: args.result, lastProof: args.proof, checkedAt: now, ...(verified ? { verifiedAt: now } : args.result === "busy" ? {} : { verifiedAt: undefined }) });
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
      let answer: { result: AllowCheckResult; proof: boolean } = { result: "unreachable", proof: false };
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRITIQS_PROXY_SECRET}`, "Content-Type": "application/json" },
          body: JSON.stringify({ origin: started.origin, token: started.token, proof: started.proof }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 429) answer = { result: "busy", proof: false };
        else if (response.ok) answer = parseAllowProbe(await response.json().catch(() => null)) ?? answer;
      } catch {
        // The proxy couldn't be asked: nothing is learned about the site.
      }
      await ctx.runMutation(internal.reviewAllow.recordCheck, { rowId: started.rowId, version: started.version, result: answer.result, proof: answer.proof });
      return { result: answer.result, verified: answer.result === "public" && answer.proof };
    }),
});
