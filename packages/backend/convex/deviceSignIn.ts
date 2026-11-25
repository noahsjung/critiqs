import { countUse, MAX_GUESSES } from "@critiqs/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { SESSION_DAYS, SESSION_MAX_DAYS } from "./lib/tokens";
import { liveAttempt } from "./signIn";

// Approving setup from another device (see http.ts). The command line starts
// a grant and keeps its device secret; the person types the grant's short code
// into Critiqs's sign-in pages in any browser, signs in there, and approves.
// The command line then exchanges its secret for a short-lived access token,
// once. Secrets and codes are stored only as hashes, and nothing about the
// grant appears in a URL.
//
// `critiqs sign-in` asks for the same approval to keep the command line
// signed in, so coding agents on that computer can read feedback: the poll
// that receives the approval also starts a session, which lasts as a site's
// does (30 days unused, 90 at most) until `critiqs sign-out` ends it. The
// approval page says which of the two the person is approving.

/** How long a grant waits for approval. */
export const DEVICE_MINUTES = 10;
/** Seconds between polls; polling faster is answered with `slow_down`. */
export const DEVICE_INTERVAL_SECONDS = 5;
/** Grants started per minute across the deployment. */
export const DEVICE_START_LIMIT = 60;
/** Codes typed that match no waiting grant, per minute across the deployment, so codes can't be guessed. */
export const DEVICE_MISS_LIMIT = 30;
/** Browser sign-in attempts per minute, including starts with a valid code. */
export const DEVICE_BEGIN_LIMIT = 200;
/** A known code cannot be used to create unlimited browser attempts. */
export const DEVICE_BEGIN_PER_GRANT_LIMIT = 5;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Shown wherever a device approval names what is being signed in to. */
export const DEVICE_SITE = "Critiqs setup on another device";
/** The same, for an approval that keeps a command line signed in. Matches `DEVICE_ACCESS_SITE` in lib/pages.ts. */
export const DEVICE_ACCESS_SITE = "Critiqs access for a command line";

/** Counts one use of a limit; false when it is used up. */
async function take(ctx: MutationCtx, key: string, limit: number, now: number) {
  const row = await ctx.db.query("signInLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const use = countUse(row === null ? null : { count: row.count, expiresAt: row.expiresAt }, limit, MINUTE_MS, now);
  if (!use.allowed) return { allowed: false as const, retryAfter: Math.ceil(use.retryAfterMs / 1000) };
  if (row === null) await ctx.db.insert("signInLimits", { key, ...use.next });
  else await ctx.db.patch(row._id, use.next);
  return { allowed: true as const, retryAfter: 0 };
}

async function grantByCode(ctx: MutationCtx, userCodeHash: string, now: number) {
  const grant = await ctx.db.query("deviceGrants").withIndex("by_user_code", (q) => q.eq("userCodeHash", userCodeHash)).first();
  return grant !== null && grant.expiresAt > now ? grant : null;
}

/** Starts a grant. A code already waiting is refused, so the caller draws another. */
export const start = internalMutation({
  args: { deviceHash: v.string(), userCodeHash: v.string(), keepSignedIn: v.optional(v.boolean()) },
  handler: async (ctx, { deviceHash, userCodeHash, keepSignedIn }) => {
    const now = Date.now();
    if ((await grantByCode(ctx, userCodeHash, now)) !== null) return { status: "collision" as const };
    const limit = await take(ctx, "device-start:global", DEVICE_START_LIMIT, now);
    if (!limit.allowed) return { status: "rate-limited" as const, retryAfter: limit.retryAfter };
    await ctx.db.insert("deviceGrants", {
      deviceHash,
      userCodeHash,
      createdAt: now,
      expiresAt: now + DEVICE_MINUTES * MINUTE_MS,
      interval: DEVICE_INTERVAL_SECONDS,
      status: "pending",
      ...(keepSignedIn === true ? { keepSignedIn: true } : {}),
    });
    return { status: "started" as const, expiresIn: DEVICE_MINUTES * 60, interval: DEVICE_INTERVAL_SECONDS };
  },
});

/**
 * A typed code starts a sign-in in this browser for its grant. Codes that
 * match no waiting grant count toward a deployment-wide limit.
 */
export const begin = internalMutation({
  args: { userCodeHash: v.string(), key: v.string(), bindingHash: v.string(), clientState: v.string() },
  handler: async (ctx, { userCodeHash, key, bindingHash, clientState }) => {
    const now = Date.now();
    const misses = await ctx.db.query("signInLimits").withIndex("by_key", (q) => q.eq("key", "device-miss:global")).unique();
    if (misses !== null && misses.expiresAt > now && misses.count >= DEVICE_MISS_LIMIT) {
      return { status: "rate-limited" as const, retryAfter: Math.ceil((misses.expiresAt - now) / 1000) };
    }
    const grant = await grantByCode(ctx, userCodeHash, now);
    if (grant === null || grant.status !== "pending") {
      const limit = await take(ctx, "device-miss:global", DEVICE_MISS_LIMIT, now);
      return limit.allowed ? { status: "unknown" as const } : { status: "rate-limited" as const, retryAfter: limit.retryAfter };
    }
    for (const [key, maximum] of [[`device-begin:${grant._id}`, DEVICE_BEGIN_PER_GRANT_LIMIT], ["device-begin:global", DEVICE_BEGIN_LIMIT]] as const) {
      const limit = await take(ctx, key, maximum, now);
      if (!limit.allowed) return { status: "rate-limited" as const, retryAfter: limit.retryAfter };
    }
    const site = grant.keepSignedIn === true ? DEVICE_ACCESS_SITE : DEVICE_SITE;
    await ctx.db.insert("signInAttempts", {
      key,
      origin: site,
      clientState,
      bindingHash,
      createdAt: now,
      codesSent: 0,
      codeGeneration: 0,
      guessesLeft: MAX_GUESSES,
      device: grant._id,
    });
    return { status: "started" as const, site };
  },
});

/**
 * Approves or denies a grant, once, from the browser that signed in for it,
 * with the token its approval page carried.
 */
export const decide = internalMutation({
  args: { key: v.string(), bindingHash: v.string(), consentHash: v.string(), allow: v.boolean() },
  handler: async (ctx, { key, bindingHash, consentHash, allow }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash);
    if (attempt === null || attempt.device === undefined || attempt.profile === undefined || attempt.consentHash !== consentHash) {
      return { status: "expired" as const };
    }
    await ctx.db.delete(attempt._id);
    const grant = await ctx.db.get(attempt.device as Id<"deviceGrants">);
    if (grant === null || grant.status !== "pending" || grant.expiresAt <= Date.now()) return { status: "expired" as const };
    await ctx.db.patch(grant._id, allow ? { status: "approved", profile: attempt.profile } : { status: "denied" });
    return { status: allow ? ("approved" as const) : ("denied" as const), profile: attempt.profile, keepSignedIn: grant.keepSignedIn === true };
  },
});

/**
 * The command line's poll. An approved grant is used up by the poll that
 * receives it, in the same transaction, so its secret works once. A grant
 * that keeps the command line signed in starts its session here, under
 * `refreshHash` and the sign-in service's own `origin`.
 */
export const poll = internalMutation({
  args: { deviceHash: v.string(), refreshHash: v.optional(v.string()), origin: v.optional(v.string()) },
  handler: async (ctx, { deviceHash, refreshHash, origin }) => {
    const now = Date.now();
    const grant = await ctx.db.query("deviceGrants").withIndex("by_device", (q) => q.eq("deviceHash", deviceHash)).unique();
    if (grant === null) return { status: "invalid" as const };
    if (grant.expiresAt <= now) {
      await ctx.db.delete(grant._id);
      return { status: "expired" as const };
    }
    if (grant.status === "denied") {
      await ctx.db.delete(grant._id);
      return { status: "denied" as const };
    }
    if (grant.status === "approved" && grant.profile !== undefined) {
      await ctx.db.delete(grant._id);
      // The current display name, as a refresh would give.
      const id = ctx.db.normalizeId("reviewers", grant.profile.subject);
      const reviewer = id === null ? null : await ctx.db.get(id);
      if (reviewer === null) return { status: "invalid" as const };
      const profile = { ...grant.profile, name: reviewer.name, profileVersion: reviewer.nameVersion };
      if (grant.keepSignedIn !== true || refreshHash === undefined || origin === undefined) {
        return { status: "approved" as const, profile, session: null };
      }
      const endsAt = now + SESSION_MAX_DAYS * DAY_MS;
      await ctx.db.insert("sessions", { refreshHash, origin, profile, createdAt: now, expiresAt: now + SESSION_DAYS * DAY_MS, endsAt });
      return { status: "approved" as const, profile, session: { endsAt } };
    }
    const early = grant.lastPolledAt !== undefined && now - grant.lastPolledAt < grant.interval * 1000;
    // Each early poll lengthens the wait, as RFC 8628 asks.
    await ctx.db.patch(grant._id, { lastPolledAt: now, ...(early ? { interval: grant.interval + 5 } : {}) });
    return { status: early ? ("slow-down" as const) : ("pending" as const), interval: early ? grant.interval + 5 : grant.interval };
  },
});
