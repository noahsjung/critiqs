import { operations, registerTagsForBackfill } from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";

// Tags and shared tag groups. Anyone with project access reads them; only the
// project's owner organizes groups.

/** The project's tags for suggestions and filters, and its tag groups. */
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => operations.listTags(convexStore(ctx), await identityOf(ctx), args)),
});

export const createGroup = mutation({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, args) =>
    run(async () => (await operations.createGroup(convexStore(ctx), await identityOf(ctx), args)) as Id<"tagGroups">),
});

export const renameGroup = mutation({
  args: { projectId: v.id("projects"), groupId: v.string(), name: v.string() },
  handler: async (ctx, args) => run(async () => operations.renameGroup(convexStore(ctx), await identityOf(ctx), args)),
});

export const deleteGroup = mutation({
  args: { projectId: v.id("projects"), groupId: v.string() },
  handler: async (ctx, args) => run(async () => operations.deleteGroup(convexStore(ctx), await identityOf(ctx), args)),
});

export const mergeGroups = mutation({
  args: { projectId: v.id("projects"), groupId: v.string(), intoGroupId: v.string() },
  handler: async (ctx, args) => run(async () => operations.mergeGroups(convexStore(ctx), await identityOf(ctx), args)),
});

/** Sets a tag's groups, or hands it back to automatic grouping. */
export const setTagGroups = mutation({
  args: { projectId: v.id("projects"), tag: v.string(), groupIds: v.array(v.string()), automatic: v.optional(v.boolean()) },
  handler: async (ctx, args) => run(async () => operations.setTagGroups(convexStore(ctx), await identityOf(ctx), args)),
});

/** Sets the project's preset tags, in order; threads keep the tags they carry. See `setPresetTags`. */
export const setPresets = mutation({
  args: { projectId: v.id("projects"), tags: v.array(v.string()), previous: v.array(v.string()) },
  handler: async (ctx, args) => run(async () => operations.setPresetTags(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Derives tags for feedback from before tags were derived: reads hashtags from
 * each older message (giving it its project, for search), then records every
 * thread's tags, explicit and written, in the registry and thread-tag
 * records. A page per run; it schedules the next. Safe to run again. Run once
 * after deploying with `npx convex run tags:backfill`.
 */
export const backfill = internalMutation({
  args: { phase: v.optional(v.union(v.literal("messages"), v.literal("threads"))), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { phase = "messages", cursor = null }) => {
    const store = convexStore(ctx);
    const table = phase === "messages" ? "messages" : "threads";
    const result = await ctx.db.query(table).paginate({ numItems: 100, cursor });
    for (const row of result.page) {
      if (phase === "messages") {
        const message = row as Awaited<ReturnType<typeof store.messages.get>> & {};
        if (message.hashtags === undefined) await registerTagsForBackfill.message(store, message);
      } else {
        await registerTagsForBackfill.thread(store, row._id);
      }
    }
    if (!result.isDone) await ctx.scheduler.runAfter(0, internal.tags.backfill, { phase, cursor: result.continueCursor });
    else if (phase === "messages") await ctx.scheduler.runAfter(0, internal.tags.backfill, { phase: "threads", cursor: null });
  },
});
