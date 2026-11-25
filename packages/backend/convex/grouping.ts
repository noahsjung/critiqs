import { applyGrouping, claimGrouping, failGrouping, type GroupingClaim } from "@critiqs/server";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { deployment } from "./lib/ai";
import { convexStore } from "./lib/store";

// Automatic grouping's transactions, run by the `ai.groupTags` action every
// minute with the model called between them.

export const claim = internalMutation({
  args: { claimToken: v.string() },
  handler: async (ctx, { claimToken }) => await claimGrouping(convexStore(ctx), deployment(), Date.now(), claimToken),
});

export const apply = internalMutation({
  args: { claim: v.any(), assignments: v.array(v.object({ key: v.string(), groupIds: v.array(v.string()), newGroups: v.array(v.string()) })) },
  handler: async (ctx, { claim, assignments }) =>
    await applyGrouping(
      convexStore(ctx),
      claim as GroupingClaim,
      { assignments: new Map(assignments.map(({ key, ...assignment }) => [key, assignment])) },
      Date.now(),
    ),
});

export const fail = internalMutation({
  args: { claim: v.any(), message: v.string() },
  handler: async (ctx, { claim, message }) => await failGrouping(convexStore(ctx), claim as GroupingClaim, message, Date.now()),
});

/** Removes expired search and test counters, in bounded batches. */
export const cleanUpRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("aiRateLimits")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const row of expired) await ctx.db.delete(row._id);
  },
});
