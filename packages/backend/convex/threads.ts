import { operations } from "@critiqs/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { anchorValidator, captureValidator, captureFileValidator, locationValidator, revisionValidator, threadMockupValidator } from "./lib/validators";
import { checkAttachment, markAttached } from "./captures";
import { checkThreadMockup, touchThreadMockup, unlistThreadMockup } from "./mockups";

/** A mention: who, and the name the text shows after `@`. */
const mentionValidator = v.object({ userId: v.id("users"), label: v.string() });

// Thread functions: Convex validates argument shapes; @critiqs/server applies
// Critiqs's rules in the same transaction.

/**
 * Starts a thread with its first message. The author has read their own
 * thread. With `mockup`, it's a mockup thread, which only the mockup lists.
 */
export const create = mutation({
  args: {
    projectId: v.id("projects"),
    anchor: anchorValidator,
    body: v.string(),
    tags: v.array(v.string()),
    capture: captureValidator,
    mentions: v.optional(v.array(mentionValidator)),
    mockup: v.optional(threadMockupValidator),
  },
  handler: async (ctx, { capture, ...args }) =>
    run(async () => {
      const identity = await identityOf(ctx);
      if (capture.status !== "failed") await checkAttachment(ctx, capture.storageId, args.projectId, identity);
      const id = await operations.createThread(convexStore(ctx), identity, {
        ...args,
        capture:
          capture.status === "failed"
            ? capture
            : capture.status === "captured"
              ? { status: "captured", fileId: capture.storageId }
              : { status: "supplied", fileId: capture.storageId, failureReason: capture.failureReason },
      });
      if (capture.status !== "failed") await markAttached(ctx, capture.storageId);
      // After the thread's own checks, so refusals of who may comment come first.
      if (args.mockup !== undefined) await checkThreadMockup(ctx, args.projectId, args.mockup, id as Id<"threads">);
      return id as Id<"threads">;
    }),
});

/** Threads the reviewer may see, with their personal unread state. Filtering and grouping happen in @critiqs/core. */
export const list = query({
  args: { projectId: v.id("projects"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...args }) =>
    run(async () => operations.listThreads(convexStore(ctx), await identityOf(ctx), args, paginationOpts)),
});

/** A bounded discussion page. Metadata/read state accompany every page. */
export const get = query({
  args: { threadId: v.id("threads"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...args }) =>
    run(async () => operations.getThread(convexStore(ctx), await identityOf(ctx), args, paginationOpts)),
});

/**
 * A thread page by its key (`/t/<key>`): only for those in the project's
 * organization or already in the thread, after the project's own check;
 * anyone else, signed in or not, gets the answer for a page that doesn't
 * exist. A query, so it records nothing, never an opened project.
 */
export const page = query({
  args: { key: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...args }) =>
    run(async () => operations.getThreadPage(convexStore(ctx), await identityOf(ctx), args, paginationOpts)),
});

/** The key for a thread page's link, for **Share**; an older thread gets one the first time it is shared. */
export const pageKey = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => run(async () => operations.threadPageKey(convexStore(ctx), await identityOf(ctx), args)),
});

/** Reactions paginate independently; a busy discussion cannot overflow a query. */
export const listReactions = query({
  args: { threadId: v.id("threads"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...args }) =>
    run(async () => operations.listReactions(convexStore(ctx), await identityOf(ctx), args, paginationOpts)),
});

/** Anyone with project access can resolve or reopen a thread (F3). */
export const setStatus = mutation({
  args: { threadId: v.id("threads"), status: v.union(v.literal("open"), v.literal("resolved")) },
  handler: async (ctx, args) => run(async () => operations.setStatus(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Soft delete: hides the thread and records who deleted it, keeping its
 * history. Only its author or the project's owners may. A mockup thread's
 * mockup leaves the Mockup list.
 */
export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) =>
    run(async () => {
      await operations.removeThread(convexStore(ctx), await identityOf(ctx), args);
      await unlistThreadMockup(ctx, args.threadId);
    }),
});

export const setTags = mutation({
  args: { threadId: v.id("threads"), tags: v.array(v.string()) },
  handler: async (ctx, args) => run(async () => operations.setTags(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Points a thread at a replacement target. The anchor keeps the original
 * target, capture, and context as evidence (F8).
 */
export const reattach = mutation({
  args: { threadId: v.id("threads"), location: locationValidator },
  handler: async (ctx, args) => run(async () => operations.reattach(convexStore(ctx), await identityOf(ctx), args)),
});

/** One selected thread's export page; callers combine pages into full discussions. */
export const exportThreads = query({
  args: {
    projectId: v.id("projects"),
    threadIds: v.array(v.id("threads")),
    threadIndex: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { paginationOpts, ...args }) =>
    run(async () => operations.exportThreads(convexStore(ctx), await identityOf(ctx), args, paginationOpts)),
});

/** Attaches a reviewer-supplied screenshot when automatic capture failed (F6). */
export const attachScreenshot = mutation({
  args: { threadId: v.id("threads"), storageId: captureFileValidator },
  handler: async (ctx, { threadId, storageId }) =>
    run(async () => {
      const identity = await identityOf(ctx);
      const user = await operations.requireUser(convexStore(ctx), identity);
      const { thread } = await operations.requireThread(convexStore(ctx), user, threadId);
      await checkAttachment(ctx, storageId, thread.projectId, identity);
      await operations.attachScreenshot(convexStore(ctx), identity, { threadId, fileId: storageId });
      await markAttached(ctx, storageId);
    }),
});

/**
 * A reply; `via: "agent"` when a coding agent wrote it for the signed-in
 * reviewer (`critiqs_reply`), and `threadPage: true` from a thread page.
 */
export const reply = mutation({
  args: {
    threadId: v.id("threads"),
    body: v.string(),
    revision: revisionValidator,
    mentions: v.optional(v.array(mentionValidator)),
    via: v.optional(v.literal("agent")),
    /** Sent from the thread page: only those who may open that page may reply this way. */
    threadPage: v.optional(v.boolean()),
  },
  handler: async (ctx, args) =>
    run(async () => {
      const messageId = (await operations.reply(convexStore(ctx), await identityOf(ctx), args)) as Id<"messages">;
      await touchThreadMockup(ctx, args.threadId);
      return messageId;
    }),
});

/** Authors can edit only their own messages (F2). Edits do not make the thread unread. */
export const editMessage = mutation({
  args: { messageId: v.id("messages"), body: v.string(), mentions: v.optional(v.array(mentionValidator)) },
  handler: async (ctx, args) => run(async () => operations.editMessage(convexStore(ctx), await identityOf(ctx), args)),
});

export const toggleReaction = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, args) => run(async () => operations.toggleReaction(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Marks the thread read through the newest message the reviewer has seen.
 * Clients pass that message's time so replies arriving unseen stay unread (F5).
 */
export const markRead = mutation({
  args: { threadId: v.id("threads"), seenThrough: v.number() },
  handler: async (ctx, args) => run(async () => operations.markRead(convexStore(ctx), await identityOf(ctx), args)),
});

export const markUnread = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => run(async () => operations.markUnread(convexStore(ctx), await identityOf(ctx), args)),
});
