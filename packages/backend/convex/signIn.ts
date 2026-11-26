import {
  countUse,
  displayName,
  EMAIL_SEND_LIMIT,
  EMAIL_SEND_WINDOW_MS,
  GLOBAL_SEND_LIMIT,
  GLOBAL_SEND_WINDOW_MS,
  MAX_CODE_SENDS,
  MAX_GUESSES,
  sameDigest,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { isPanelOrigin } from "./lib/origins";
import { type ReviewerProfile, SESSION_DAYS, SESSION_MAX_DAYS } from "./lib/tokens";

// State behind Critiqs's sign-in popup (see http.ts). Each attempt is bound to
// the browser that started it by a cookie, so a forwarded sign-in link or a
// leaked attempt key cannot finish it elsewhere. The reviewer proves they
// control an email address with a code sent to it. The popup reports back only
// to the site that opened it, and only after the reviewer allowed that site.
//
// Critiqs's own panels (lib/origins.ts) sign in with the same attempts and
// codes, as JSON (`panel: true`). Their attempt key travels in the request
// body instead of a cookie, bound to the panel's origin, and the two kinds of
// attempt never continue each other. Critiqs's own origins need no site grant.

/** Which kind of attempt a step continues: a popup's (default) or a panel's. */
const panelArg = { panel: v.optional(v.boolean()) };

/** How long a sign-in window stays usable, long enough for a few codes. */
export const ATTEMPT_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 500;
export const START_WINDOW_MS = 60_000;
export const START_ORIGIN_LIMIT = 20;
export const START_GLOBAL_LIMIT = 200;


export const startAttempt = internalMutation({
  args: {
    key: v.string(),
    origin: v.string(),
    clientState: v.string(),
    bindingHash: v.string(),
    ...panelArg,
  },
  handler: async (ctx, { panel, ...args }) => {
    const now = Date.now();
    const buckets = await Promise.all(["global", `origin:${args.origin}`].map(async (key) =>
      ({ key, row: await ctx.db.query("signInLimits").withIndex("by_key", q => q.eq("key", key)).unique() })));
    for (const { key, row } of buckets) {
      const limit = key === "global" ? START_GLOBAL_LIMIT : START_ORIGIN_LIMIT;
      if (row !== null && row.expiresAt > now && row.count >= limit) {
        return { allowed: false, retryAfter: Math.ceil((row.expiresAt - now) / 1000) };
      }
    }
    for (const { key, row } of buckets) {
      const value = { key, count: row !== null && row.expiresAt > now ? row.count + 1 : 1,
        expiresAt: row !== null && row.expiresAt > now ? row.expiresAt : now + START_WINDOW_MS };
      if (row === null) await ctx.db.insert("signInLimits", value);
      else await ctx.db.patch(row._id, value);
    }
    await ctx.db.insert("signInAttempts", {
      ...args,
      ...(panel === true ? { panel: true } : {}),
      createdAt: now,
      codesSent: 0,
      codeGeneration: 0,
      guessesLeft: MAX_GUESSES,
    });
    return { allowed: true, retryAfter: 0 };
  },
});

/**
 * Reserves the next code for an attempt and an address. Each attempt sends
 * a few codes at most; each address, and the deployment as a whole, a limited
 * number per window. A new code replaces any earlier one, but the attempt's
 * remaining guesses carry over. The caller generates the code and stores its
 * digest with `storeCode`.
 */
export const prepareCode = internalMutation({
  args: { key: v.string(), bindingHash: v.string(), email: v.string(), ...panelArg },
  handler: async (ctx, { key, bindingHash, email, panel }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash, panel);
    if (attempt === null || attempt.profile !== undefined || attempt.verifiedEmail !== undefined) {
      return { status: "expired" as const };
    }
    if ((attempt.guessesLeft ?? 0) <= 0) return { status: "locked" as const };
    if ((attempt.codesSent ?? 0) >= MAX_CODE_SENDS) return { status: "too-many-codes" as const };
    const now = Date.now();
    const limits = [
      { key: `send:${email}`, limit: EMAIL_SEND_LIMIT, windowMs: EMAIL_SEND_WINDOW_MS },
      { key: "send:global", limit: GLOBAL_SEND_LIMIT, windowMs: GLOBAL_SEND_WINDOW_MS },
    ];
    const rows = await Promise.all(
      limits.map(async (limit) => ({
        ...limit,
        row: await ctx.db.query("signInLimits").withIndex("by_key", (q) => q.eq("key", limit.key)).unique(),
      })),
    );
    const counted = [];
    for (const { key: limitKey, limit, windowMs, row } of rows) {
      const use = countUse(row === null ? null : { count: row.count, expiresAt: row.expiresAt }, limit, windowMs, now);
      if (!use.allowed) return { status: "rate-limited" as const, retryAfter: Math.ceil(use.retryAfterMs / 1000) };
      counted.push({ key: limitKey, row, next: use.next });
    }
    for (const { key: limitKey, row, next } of counted) {
      if (row === null) await ctx.db.insert("signInLimits", { key: limitKey, ...next });
      else await ctx.db.patch(row._id, next);
    }
    const generation = (attempt.codeGeneration ?? 0) + 1;
    await ctx.db.patch(attempt._id, {
      email,
      codeGeneration: generation,
      codesSent: (attempt.codesSent ?? 0) + 1,
      codeDigest: undefined,
      codeExpiresAt: undefined,
    });
    return { status: "ready" as const, generation, origin: attempt.origin };
  },
});

/** Stores the digest of the code just generated, if no newer code replaced it meanwhile. */
export const storeCode = internalMutation({
  args: { key: v.string(), bindingHash: v.string(), generation: v.number(), digest: v.string(), expiresAt: v.number(), ...panelArg },
  handler: async (ctx, { key, bindingHash, generation, digest, expiresAt, panel }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash, panel);
    if (attempt === null || attempt.codeGeneration !== generation || attempt.verifiedEmail !== undefined) return false;
    await ctx.db.patch(attempt._id, { codeDigest: digest, codeExpiresAt: expiresAt });
    return true;
  },
});

/** The address and send a typed code must match, for computing its digest. */
export const codeContext = internalMutation({
  args: { key: v.string(), bindingHash: v.string(), ...panelArg },
  handler: async (ctx, { key, bindingHash, panel }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash, panel);
    if (attempt === null || attempt.email === undefined || attempt.profile !== undefined) return null;
    return { email: attempt.email, generation: attempt.codeGeneration ?? 0, origin: attempt.origin };
  },
});

/**
 * Checks a typed code, once per guess. A wrong code uses up one of the
 * attempt's guesses; when they run out, the attempt is locked. A right code
 * verifies the address: a known reviewer goes on to allow the site, and a new
 * one chooses a display name first.
 */
export const verifyCode = internalMutation({
  args: { key: v.string(), bindingHash: v.string(), generation: v.number(), digest: v.string(), consentHash: v.string(), ...panelArg },
  handler: async (ctx, { key, bindingHash, generation, digest, consentHash, panel }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash, panel);
    if (attempt === null || attempt.profile !== undefined || attempt.verifiedEmail !== undefined || attempt.email === undefined) {
      return { status: "expired" as const };
    }
    const guessesLeft = attempt.guessesLeft ?? 0;
    if (guessesLeft <= 0) return { status: "locked" as const };
    const now = Date.now();
    if (
      attempt.codeDigest === undefined ||
      attempt.codeGeneration !== generation ||
      attempt.codeExpiresAt === undefined ||
      attempt.codeExpiresAt <= now
    ) {
      return { status: "code-expired" as const };
    }
    if (!sameDigest(attempt.codeDigest, digest)) {
      await ctx.db.patch(attempt._id, { guessesLeft: guessesLeft - 1 });
      return guessesLeft - 1 <= 0 ? { status: "locked" as const } : { status: "wrong" as const, guessesLeft: guessesLeft - 1 };
    }
    const email = attempt.email;
    await ctx.db.patch(attempt._id, { codeDigest: undefined, codeExpiresAt: undefined, verifiedEmail: email });
    const reviewer = await ctx.db.query("reviewers").withIndex("by_email", (q) => q.eq("email", email)).unique();
    if (reviewer === null) return { status: "needs-name" as const, origin: attempt.origin };
    return await verified(ctx, { ...attempt, verifiedEmail: email }, reviewer, consentHash);
  },
});

/** Registers a reviewer whose address was just verified, with the display name they chose. */
export const registerReviewer = internalMutation({
  args: { key: v.string(), bindingHash: v.string(), name: v.string(), consentHash: v.string(), ...panelArg },
  handler: async (ctx, { key, bindingHash, name, consentHash, panel }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash, panel);
    if (attempt === null || attempt.profile !== undefined || attempt.verifiedEmail === undefined) {
      return { status: "expired" as const };
    }
    const chosen = displayName(name);
    if (chosen === null) return { status: "invalid-name" as const };
    const email = attempt.verifiedEmail;
    // Another window may have registered the same address meanwhile; its name stands.
    let reviewer = await ctx.db.query("reviewers").withIndex("by_email", (q) => q.eq("email", email)).unique();
    if (reviewer === null) {
      const id = await ctx.db.insert("reviewers", { email, name: chosen, nameVersion: 1, createdAt: Date.now() });
      reviewer = (await ctx.db.get(id))!;
    }
    return await verified(ctx, attempt, reviewer, consentHash);
  },
});

/** Records a verified reviewer on an attempt, and whether its site needs no consent: allowed before, or Critiqs's own. */
async function verified(ctx: MutationCtx, attempt: Doc<"signInAttempts">, reviewer: Doc<"reviewers">, consentHash: string) {
  const profile: ReviewerProfile = {
    subject: reviewer._id,
    name: reviewer.name,
    email: reviewer.email,
    pictureUrl: null,
    profileVersion: reviewer.nameVersion,
  };
  // A device approval is always asked, never remembered like a site.
  const device = attempt.device !== undefined;
  const allowed = !device && (isPanelOrigin(attempt.origin) || (await grantFor(ctx, profile.subject, attempt.origin)) !== null);
  const grant = device ? await ctx.db.get(attempt.device as Id<"deviceGrants">) : null;
  const keepSignedIn = grant?.keepSignedIn === true;
  await ctx.db.patch(attempt._id, { profile, consentHash });
  return { status: "verified" as const, origin: attempt.origin, allowed, device, keepSignedIn, backend: grant?.backend ?? null, site: grant?.site ?? null, profile };
}

/**
 * Changes a reviewer's display name, for the reviewer whose session this is.
 * Every deployment sees the new name from the next token.
 */
export const renameReviewer = internalMutation({
  args: { refreshHash: v.string(), origin: v.string(), name: v.string() },
  handler: async (ctx, { refreshHash, origin, name }) => {
    const session = await sessionFor(ctx, refreshHash);
    if (session === null || session.origin !== origin || !sessionLive(session, Date.now())) return "signed-out" as const;
    if (!stillTrusted(session)) {
      await ctx.db.delete(session._id);
      return "signed-out" as const;
    }
    const chosen = displayName(name);
    if (chosen === null) return "invalid" as const;
    const reviewer = await reviewerOf(ctx, session.profile.subject);
    if (reviewer === null) return "signed-out" as const;
    await ctx.db.patch(reviewer._id, { name: chosen, nameVersion: reviewer.nameVersion + 1 });
    return "renamed" as const;
  },
});

/**
 * Finishes an attempt once. Allowing records the site grant and starts a
 * session; declining ends the attempt without one. A consent token is needed
 * unless the reviewer allowed the site before, or the site is Critiqs's own,
 * which is never recorded as a grant.
 */
export const finishAttempt = internalMutation({
  args: {
    key: v.string(),
    bindingHash: v.string(),
    consentHash: v.union(v.string(), v.null()),
    allow: v.boolean(),
    refreshHash: v.string(),
    ...panelArg,
  },
  handler: async (ctx, { key, bindingHash, consentHash, allow, refreshHash, panel }) => {
    const attempt = await liveAttempt(ctx, key, bindingHash, panel);
    // A device approval never becomes a site session; it finishes in deviceSignIn.ts.
    if (attempt?.profile === undefined || attempt.device !== undefined) return null;
    const { origin, clientState, profile } = attempt;
    const firstParty = isPanelOrigin(origin);
    const existing = await grantFor(ctx, profile.subject, origin);
    if (consentHash === null ? existing === null && !firstParty : consentHash !== attempt.consentHash) return null;
    await ctx.db.delete(attempt._id);
    if (!allow) return { origin, clientState, profile: null };

    const now = Date.now();
    if (existing === null && !firstParty) await ctx.db.insert("siteGrants", { subject: profile.subject, origin, grantedAt: now });
    const endsAt = now + SESSION_MAX_DAYS * DAY_MS;
    await ctx.db.insert("sessions", {
      refreshHash,
      origin,
      profile,
      createdAt: now,
      expiresAt: now + SESSION_DAYS * DAY_MS,
      endsAt,
      // Without a grant, only the panel setting backs this session.
      ...(firstParty && existing === null ? { firstParty: true } : {}),
    });
    if (firstParty && existing === null) {
      const tracked = await ctx.db.query("panelSessionOrigins").withIndex("by_origin", (q) => q.eq("origin", origin)).unique();
      if (tracked === null) await ctx.db.insert("panelSessionOrigins", { origin });
    }
    return { origin, clientState, profile, endsAt };
  },
});

/** Keeps a session alive for the site that owns it. Sessions slide forward on use. */
export const refreshSession = internalMutation({
  args: { refreshHash: v.string(), nextRefreshHash: v.string(), origin: v.string() },
  handler: async (ctx, { refreshHash, nextRefreshHash, origin }) => {
    const session = await sessionFor(ctx, refreshHash);
    const now = Date.now();
    if (session === null || session.origin !== origin) return null;
    // Sessions slide forward with use, but never past their absolute end, so a
    // leaked refresh token can't keep a session alive forever.
    const endsAt = sessionEnd(session);
    if (!sessionLive(session, now) || !stillTrusted(session)) {
      await ctx.db.delete(session._id);
      return null;
    }
    // A session whose reviewer no longer exists ends rather than renewing a stale identity.
    const reviewer = await reviewerOf(ctx, session.profile.subject);
    if (reviewer === null) {
      await ctx.db.delete(session._id);
      return null;
    }
    await ctx.db.patch(session._id, {
      refreshHash: nextRefreshHash,
      expiresAt: Math.min(now + SESSION_DAYS * DAY_MS, endsAt),
    });
    // The current display name, so a rename reaches every deployment with the next token.
    return { profile: { ...session.profile, name: reviewer.name, profileVersion: reviewer.nameVersion }, endsAt };
  },
});

/** Ends the session; whether there was one to end. */
export const endSession = internalMutation({
  args: { refreshHash: v.string(), origin: v.string() },
  handler: async (ctx, { refreshHash, origin }) => {
    const session = await sessionFor(ctx, refreshHash);
    if (session === null || session.origin !== origin) return false;
    await ctx.db.delete(session._id);
    return true;
  },
});

/** Removes abandoned attempts and expired sessions (scheduled in crons.ts). */
export const cleanUp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const attempts = await ctx.db
      .query("signInAttempts")
      .withIndex("by_created", (q) => q.lt("createdAt", now - ATTEMPT_MINUTES * 60 * 1000))
      .take(CLEANUP_BATCH);
    for (const attempt of attempts) await ctx.db.delete(attempt._id);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
      .take(CLEANUP_BATCH);
    for (const session of sessions) await ctx.db.delete(session._id);
    const limits = await ctx.db.query("signInLimits").withIndex("by_expiry", q => q.lt("expiresAt", now)).take(CLEANUP_BATCH);
    for (const limit of limits) await ctx.db.delete(limit._id);
    const devices = await ctx.db.query("deviceGrants").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(CLEANUP_BATCH);
    for (const device of devices) await ctx.db.delete(device._id);
    // Consent-free sessions of panel origins no longer listed, so adding an origin back doesn't revive them.
    let unlisted = false;
    for (const tracked of await ctx.db.query("panelSessionOrigins").collect()) {
      if (isPanelOrigin(tracked.origin)) continue;
      const ended = await endFirstPartySessions(ctx, tracked.origin);
      if (ended === CLEANUP_BATCH) unlisted = true;
      else await ctx.db.delete(tracked._id);
    }
    // Keep going in further transactions until the backlog is gone.
    if (unlisted || [attempts, sessions, limits, devices].some((batch) => batch.length === CLEANUP_BATCH)) {
      await ctx.scheduler.runAfter(0, internal.signIn.cleanUp, {});
    }
  },
});

/** Ends up to one batch of an origin's consent-free sessions; how many it ended. */
async function endFirstPartySessions(ctx: MutationCtx, origin: string): Promise<number> {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_first_party_origin", (q) => q.eq("firstParty", true).eq("origin", origin))
    .take(CLEANUP_BATCH);
  for (const session of sessions) await ctx.db.delete(session._id);
  return sessions.length;
}

/**
 * Ends every consent-free session of one panel origin at once, such as after
 * removing it from the settings: `npx convex run signIn:endPanelSessions
 * '{"origin":"https://…"}'`. Sessions backed by a site grant stay. Returns how
 * many it ended in this transaction; it continues in later ones.
 */
export const endPanelSessions = internalMutation({
  args: { origin: v.string() },
  handler: async (ctx, { origin }) => {
    const ended = await endFirstPartySessions(ctx, origin);
    if (ended === CLEANUP_BATCH) await ctx.scheduler.runAfter(0, internal.signIn.endPanelSessions, { origin });
    return ended;
  },
});

/** The attempt, if it is still open, of the kind asked for, and bound to this browser or panel. */
export async function liveAttempt(ctx: MutationCtx, key: string, bindingHash: string, panel = false) {
  const attempt = await ctx.db
    .query("signInAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (attempt === null) return null;
  if (attempt.createdAt < Date.now() - ATTEMPT_MINUTES * 60 * 1000) {
    await ctx.db.delete(attempt._id);
    return null;
  }
  return attempt.bindingHash === bindingHash && (attempt.panel === true) === panel ? attempt : null;
}

async function grantFor(ctx: MutationCtx, subject: string, origin: string) {
  return await ctx.db
    .query("siteGrants")
    .withIndex("by_subject_origin", (q) => q.eq("subject", subject).eq("origin", origin))
    .unique();
}

async function reviewerOf(ctx: MutationCtx, subject: string) {
  const id = ctx.db.normalizeId("reviewers", subject);
  return id === null ? null : await ctx.db.get(id as Id<"reviewers">);
}

/** When a session ends however often it is used; older sessions without a recorded end count from sign-in. */
function sessionEnd(session: Doc<"sessions">): number {
  return session.endsAt ?? session.createdAt + SESSION_MAX_DAYS * DAY_MS;
}

/** A session no grant backs ends once its origin is no longer one of Critiqs's own panels. */
function stillTrusted(session: Doc<"sessions">): boolean {
  return session.firstParty !== true || isPanelOrigin(session.origin);
}

/** Whether a session may still be used: within both its sliding and its absolute end. */
function sessionLive(session: Doc<"sessions">, now: number): boolean {
  return session.expiresAt > now && sessionEnd(session) > now;
}

async function sessionFor(ctx: MutationCtx, refreshHash: string) {
  return await ctx.db
    .query("sessions")
    .withIndex("by_refresh_hash", (q) => q.eq("refreshHash", refreshHash))
    .unique();
}

/** The site an attempt signs in to, for the browser that started it. */
export const attemptOrigin = internalMutation({
  args: { key: v.string(), bindingHash: v.string() },
  handler: async (ctx, { key, bindingHash }) => (await liveAttempt(ctx, key, bindingHash, false))?.origin ?? null,
});
