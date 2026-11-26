import {
  advanceReplyEmails,
  applyPreferenceLink,
  beginDelivery,
  canReview,
  claimDue,
  cleanUpDeliveries,
  completeDeliveries,
  deliveryAllowed,
  discussionPage,
  freezeDelivery,
  isLocalReviewAddress,
  operations,
  preferenceToken,
  stillMentions,
  touchParticipant,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";

// Mention emails. Messages save the emails they owe; the worker in
// `notificationEmails.ts` sends them a minute later through the steps here,
// retries failures, and gives up after several attempts.

export const settings = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => operations.getNotificationSettings(convexStore(ctx), await identityOf(ctx), args)),
});

export const setSettings = mutation({
  args: { projectId: v.id("projects"), mentionEmails: v.optional(v.boolean()), replyEmails: v.optional(v.boolean()), projectMuted: v.optional(v.boolean()) },
  handler: async (ctx, args) => run(async () => operations.setNotificationSettings(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * One step of queuing reply emails (see `advanceReplyEmails`); whether more
 * are waiting. The email worker runs these before sending, every minute.
 */
export const replyEmailStep = internalMutation({
  args: {},
  handler: async (ctx) => await advanceReplyEmails(convexStore(ctx), Date.now()),
});

export const claim = internalMutation({
  args: { claimToken: v.string(), limit: v.number() },
  handler: async (ctx, { claimToken, limit }) =>
    (await claimDue(convexStore(ctx), Date.now(), limit, claimToken)) as Id<"deliveries">[],
});

// The steps of sending one delivery, each its own transaction (see `deliverOne`).

/** Checks a claimed delivery; the link key comes from the action, which may generate it. */
export const begin = internalQuery({
  args: { id: v.id("deliveries"), claimToken: v.string(), secret: v.string() },
  handler: async (ctx, { id, claimToken, secret }) =>
    await beginDelivery(convexStore(ctx), { id, claimToken, preferenceUrl: (scope) => preferenceLink(secret, scope) }),
});

export const page = internalQuery({
  args: { id: v.id("deliveries"), claimToken: v.string(), version: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => await discussionPage(convexStore(ctx), args),
});

/** Whether a held delivery may still go out (see `deliveryAllowed`), right before its capture is read and before it is sent. */
export const allowed = internalQuery({
  args: { id: v.id("deliveries"), claimToken: v.string() },
  handler: async (ctx, args) => await deliveryAllowed(convexStore(ctx), args),
});

export const mentioned = internalQuery({
  args: { id: v.id("deliveries"), claimToken: v.string(), messageId: v.id("messages") },
  handler: async (ctx, args) => await stillMentions(convexStore(ctx), args),
});

export const freeze = internalMutation({
  args: { id: v.id("deliveries"), claimToken: v.string(), version: v.string(), fileId: v.id("_storage"), to: v.string() },
  handler: async (ctx, args) => await freezeDelivery(convexStore(ctx), args),
});

export const removeFile = internalMutation({
  args: { fileId: v.id("_storage") },
  handler: async (ctx, { fileId }) => await convexStore(ctx).files.delete(fileId),
});

export const complete = internalMutation({
  args: {
    claimToken: v.string(),
    outcomes: v.array(
      v.object({
        deliveryId: v.id("deliveries"),
        result: v.union(v.literal("sent"), v.literal("skipped"), v.literal("failed")),
        reason: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { claimToken, outcomes }) =>
    await completeDeliveries(
      convexStore(ctx),
      outcomes.map((outcome) => ({ ...outcome, claimToken })),
      Date.now(),
    ),
});

/** Removes deliveries finished more than a month ago, in batches. */
export const cleanUp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const removed = await cleanUpDeliveries(convexStore(ctx), Date.now(), 100);
    if (removed === 100) await ctx.scheduler.runAfter(0, internal.notifications.cleanUp, {});
  },
});

/**
 * Lets everyone who commented before mentions existed be mentioned: records
 * each message author as a participant of its project, a page at a time.
 * Run once with `npx convex run notifications:backfillParticipants`.
 */
export const backfillParticipants = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const store = convexStore(ctx);
    const result = await ctx.db.query("messages").paginate({ numItems: 200, cursor: cursor ?? null });
    for (const message of result.page) {
      const thread = await ctx.db.get(message.threadId);
      if (thread !== null) await touchParticipant(store, thread.projectId, message.authorId, message.createdAt);
    }
    if (!result.isDone) await ctx.scheduler.runAfter(0, internal.notifications.backfillParticipants, { cursor: result.continueCursor });
  },
});

/** Mention emails waiting longer than this mean scheduled sending isn't running. */
const OVERDUE_MS = 10 * 60_000;

/**
 * Whether mention emails are going out, and whether a project exists, for
 * `critiqs doctor`. A project limited to its organization is described only
 * to its members, signed in with the request; to anyone else, the report says
 * nothing about it. An unknown ID is still reported `missing`, which doctor
 * and the component rely on, so anyone holding a project's ID can tell that
 * it exists, but nothing more about it.
 */
export const health = internalQuery({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, { projectId }) => {
    const now = Date.now();
    const oldest = await ctx.db
      .query("deliveries")
      .withIndex("by_status_due", (q) => q.eq("status", "pending"))
      .first();
    // A worker that stopped mid-send leaves its claim behind; retries pick it up once the lease ends.
    const stranded = await ctx.db
      .query("deliveries")
      .withIndex("by_status_lease", (q) => q.eq("status", "sending").lt("leaseUntil", now - OVERDUE_MS))
      .first();
    const last = await ctx.db
      .query("deliveries")
      .withIndex("by_finished", (q) => q.gt("finishedAt", 0))
      .order("desc")
      .first();
    const id = projectId === undefined ? null : ctx.db.normalizeId("projects", projectId);
    const store = convexStore(ctx);
    const found = id === null ? null : await store.projects.get(id);
    const identity = found === null || (found.reviewAccess ?? "anyone") === "anyone" ? null : await identityOf(ctx);
    const viewer = identity === null ? null : await store.users.byToken(identity.tokenIdentifier);
    const project = found === null || (await canReview(store, found, viewer?._id ?? null)) ? found : undefined;
    const waitingSince = Math.min(oldest?.dueAt ?? Infinity, stranded?.leaseUntil ?? Infinity);
    return {
      mentionEmails: {
        overdue: waitingSince < now - OVERDUE_MS,
        waitingSince: Number.isFinite(waitingSince) ? waitingSince : null,
        last: last === null ? null : { status: last.status, at: last.finishedAt ?? null },
      },
      ...(projectId === undefined || project === undefined
        ? {}
        : { project: project === null ? "missing" : "found", ...(project === null ? {} : { reviewAddress: project.reviewUrl !== undefined, reviewAddressLocal: isLocalReviewAddress(project.reviewUrl) }) }),
    };
  },
});

// ---------------------------------------------------------------------------
// Mute and unsubscribe links

export const secretValue = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "preference-links")).unique())?.value ?? null,
});

/** Stores the generated key unless another run stored one first; returns the key in use. */
export const saveSecret = internalMutation({
  args: { value: v.string() },
  handler: async (ctx, { value }) => {
    const existing = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "preference-links")).unique();
    if (existing !== null) return existing.value;
    await ctx.db.insert("settings", { key: "preference-links", value });
    return value;
  },
});

async function preferenceLink(secret: string, scope: { userId: string; projectId: string | null }): Promise<string> {
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
  return `${site}/notifications/preferences?token=${encodeURIComponent(await preferenceToken(secret, scope))}`;
}

/** Applies a mute or unsubscribe link after the reviewer confirms it. */
export const applyLink = internalMutation({
  args: { userId: v.string(), projectId: v.union(v.string(), v.null()) },
  handler: async (ctx, scope) => await applyPreferenceLink(convexStore(ctx), scope),
});
