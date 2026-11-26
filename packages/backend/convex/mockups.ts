import type { MockupDetail, MockupSummary, ThreadSummary } from "@critiqs/core";
import {
  appendEdits,
  authorizeMockupTurn,
  checkDescriptions,
  checkLinkedThreads,
  checkMockupRoom,
  checkSnapshotFile,
  checkSnapshotLayout,
  conversationOf,
  editsFor,
  editsRecord,
  fail,
  MOCKUP_AI,
  MOCKUP_RULES,
  mockupTitle,
  operations,
  projectAccess,
  projectQuota,
  recheckMockupTurn,
  type ProjectRecord,
  type Store,
  type UserRecord,
  useQuota,
  type VersionEdits,
} from "@critiqs/server";
import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, type ActionCtx, internalMutation, internalQuery, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { deployment } from "./lib/ai";
import { convexStore, identityOf, run, threadRecord } from "./lib/store";
import { mockupEditValidator, mockupSourceValidator, type threadMockupValidator } from "./lib/validators";
import { checkUpload, markUploadAttached, reserveUpload, usedFile } from "./uploads";
import type { Infer } from "convex/values";

// Mockups: proposed changes to frozen page copies, discussed in mockup
// threads (see Mockup mode in docs/technical-direction.md). Anyone who can
// read a project's threads can read and change its mockups; only a mockup's
// creator or those who manage the project can delete one. Mockups' rules live in
// @critiqs/server; these functions store them.

const snapshotInput = v.object({
  storageId: v.id("_storage"),
  width: v.number(),
  height: v.number(),
  scrollY: v.number(),
  viewportHeight: v.number(),
  capturedAt: v.number(),
});

// ---------------------------------------------------------------------------
// Reading

/**
 * A project's mockups, most recently changed first: its newest, and with
 * `screen`, also that screen's mockups, so many newer mockups elsewhere never
 * push a page's own out of the list. Kept for the MCP tools and older
 * components; the Mockup panel reads `listPage`.
 */
export const list = query({
  args: { projectId: v.id("projects"), screen: v.optional(v.string()) },
  handler: async (ctx, args): Promise<MockupSummary[]> =>
    run(async () => {
      const { store, user, projectId } = await listable(ctx, args.projectId);
      const newest = await ctx.db
        .query("mockups")
        .withIndex("by_project_updated", (q) => q.eq("projectId", projectId))
        .order("desc")
        .take(MOCKUP_RULES.listed);
      const { screen } = args;
      const forScreen =
        screen === undefined
          ? []
          : await ctx.db
              .query("mockups")
              .withIndex("by_project_screen_updated", (q) => q.eq("projectId", projectId).eq("source.screen", screen))
              .order("desc")
              .take(MOCKUP_RULES.listedForScreen);
      const mockups = [...new Map([...newest, ...forScreen].map((mockup) => [mockup._id, mockup])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return await Promise.all(mockups.map((mockup) => summary(ctx, store, user, mockup)));
    }),
});

/**
 * One page of a project's mockups with threads, most recently active first,
 * each with its threads as `list` returns them: one screen's, or every other
 * screen's. Mockups are listed once their thread exists (`listedAt`), so a
 * page never holds mockups without one.
 *
 * Other screens' pages read the project's index and leave the screen out with
 * a filter inside `paginate`, which reads past the screen's own mockups until
 * the page is full. Each read is small, but a screen with many thousands of
 * mockups makes other screens' pages slower, up to Convex's read limit.
 */
export const listPage = query({
  args: {
    projectId: v.id("projects"),
    scope: v.union(v.object({ screen: v.string() }), v.object({ otherThan: v.string() })),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { scope, paginationOpts, ...args }): Promise<PaginationResult<MockupSummary>> =>
    run(async () => {
      const { store, user, projectId } = await listable(ctx, args.projectId);
      operations.boundedPage(paginationOpts);
      const mockups = ctx.db.query("mockups");
      // Mockups without `listedAt` sort first in an index; `gt` leaves them out.
      const page = await ("screen" in scope
        ? mockups.withIndex("by_project_screen_listed", (q) => q.eq("projectId", projectId).eq("source.screen", scope.screen).gt("listedAt", 0))
        : mockups.withIndex("by_project_listed", (q) => q.eq("projectId", projectId).gt("listedAt", 0)).filter((q) => q.neq(q.field("source.screen"), scope.otherThan))
      )
        .order("desc")
        .paginate(paginationOpts);
      return { ...page, page: await Promise.all(page.page.map((mockup) => summary(ctx, store, user, mockup))) };
    }),
});

/**
 * Lists mockups whose thread was made before mockups had `listedAt`, a page at
 * a time, scheduling the next page. Safe to run again. Run it once on a
 * deployment with such mockups: `npx convex run mockups:backfillListedAt`.
 */
export const backfillListedAt = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("mockups").paginate({ numItems: 100, cursor: cursor ?? null });
    for (const mockup of page.page) {
      if (mockup.listedAt === undefined && (await threadsOf(ctx, mockup._id)).length > 0) await ctx.db.patch(mockup._id, { listedAt: mockup.updatedAt });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.mockups.backfillListedAt, { cursor: page.continueCursor });
  },
});

/** A mockup with its page copies, linked threads, and every version, oldest first. */
export const get = query({
  args: { mockupId: v.id("mockups") },
  handler: async (ctx, args): Promise<MockupDetail> =>
    run(async () => {
      const { mockup, store, user } = await readable(ctx, args.mockupId);
      const names = nameCache(ctx);
      const snapshots = await snapshotsOf(ctx, mockup._id);
      const links = await linksOf(ctx, mockup._id);
      const linkedThreadIds: string[] = [];
      for (const link of links) {
        const thread = await ctx.db.get(link.threadId);
        if (thread !== null && thread.status !== "deleted") linkedThreadIds.push(thread._id);
      }
      const versions = await ctx.db
        .query("mockupVersions")
        .withIndex("by_mockup_number", (q) => q.eq("mockupId", mockup._id))
        .collect();
      return {
        ...(await summary(ctx, store, user, mockup)),
        snapshots: await Promise.all(
          snapshots.map(async (snapshot) => ({
            _id: snapshot._id,
            width: snapshot.width,
            height: snapshot.height,
            capturedAt: snapshot.capturedAt,
            createdByName: await names(snapshot.createdBy),
          })),
        ),
        linkedThreadIds,
        versions: await Promise.all(
          versions.map(async (version) => ({
            number: version.number,
            createdAt: version.createdAt,
            authorName: await names(version.authorId),
            byAi: version.byAi,
            summary: version.summary,
            threadId: version.threadId ?? null,
            messageId: version.messageId ?? null,
            restoredFrom: version.restoredFrom ?? null,
            edits: editsRecord(version.edits),
          })),
        ),
      };
    }),
});

/** A mockup's open and resolved threads, oldest first, as the thread list shows threads. */
export const threads = query({
  args: { mockupId: v.id("mockups") },
  handler: async (ctx, args): Promise<ThreadSummary[]> =>
    run(async () => {
      const { mockup, store, user } = await readable(ctx, args.mockupId);
      const rows = await threadsOf(ctx, mockup._id);
      return await Promise.all(rows.map((thread) => operations.threadSummary(store, user, threadRecord(thread))));
    }),
});

/** The mockups an existing thread is linked to, so its thread window can show them. */
export const forThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args): Promise<{ _id: Id<"mockups">; title: string }[]> =>
    run(async () => {
      const store = convexStore(ctx);
      const { user } = await operations.currentReviewer(store, await identityOf(ctx));
      const { thread } = await operations.requireThread(store, user, args.threadId);
      const links = await ctx.db
        .query("mockupLinks")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id as Id<"threads">))
        .take(MOCKUP_RULES.listed);
      const mockups = [];
      for (const link of links) {
        const mockup = await ctx.db.get(link.mockupId);
        if (mockup !== null) mockups.push({ _id: mockup._id, title: mockup.title });
      }
      return mockups;
    }),
});

/** A page copy's file, after the same checks as reading its mockup; served by the `/mockup/snapshot` route. */
export const authorizedSnapshot = internalQuery({
  args: { snapshotId: v.string() },
  handler: async (ctx, args): Promise<Id<"_storage">> =>
    run(async () => {
      // Sign-in first, as for captures, so a malformed ID tells a stranger nothing.
      await operations.currentReviewer(convexStore(ctx), await identityOf(ctx));
      const id = ctx.db.normalizeId("mockupSnapshots", args.snapshotId);
      const snapshot = id === null ? null : await ctx.db.get(id);
      if (snapshot === null) fail("not-found", "This page copy does not exist.");
      await readable(ctx, snapshot.mockupId);
      return snapshot.storageId;
    }),
});

// ---------------------------------------------------------------------------
// Changing

/** An upload address for a page copy, reserved for the caller in the project (see `uploads.ts`), for anyone who may add to it. */
export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<string> =>
    run(async () => {
      const store = convexStore(ctx);
      const identity = await identityOf(ctx);
      await operations.authorizeUpload(store, identity, args);
      const user = await operations.requireUser(store, identity);
      return await reserveUpload(ctx, { projectId: args.projectId, userId: user._id as Id<"users">, purpose: "pageCopy" });
    }),
});

/** What starting a mockup takes: its first copy, and existing threads to link as instructions, if any. */
const createArgs = {
  projectId: v.id("projects"),
  title: v.string(),
  source: mockupSourceValidator,
  snapshot: snapshotInput,
  linkedThreadIds: v.optional(v.array(v.id("threads"))),
};

/**
 * Starts a mockup from an uploaded page copy, linking the threads given in
 * the same step. An action, so that a refused upload can be deleted: a
 * refusing mutation would roll back its own delete.
 */
export const create = action({
  args: createArgs,
  handler: async (ctx, args): Promise<Id<"mockups">> =>
    await discardRefusedUpload(ctx, args.snapshot.storageId, () => ctx.runMutation(internal.mockups.insert, args)),
});

/** Adds a page copy at another width. It has no changes until a later version gives it some. */
export const addSnapshot = action({
  args: { mockupId: v.id("mockups"), snapshot: snapshotInput },
  handler: async (ctx, args): Promise<Id<"mockupSnapshots">> =>
    await discardRefusedUpload(ctx, args.snapshot.storageId, () => ctx.runMutation(internal.mockups.insertSnapshot, args)),
});

export const insert = internalMutation({
  args: createArgs,
  handler: async (ctx, args): Promise<Id<"mockups">> =>
    run(async () => {
      const store = convexStore(ctx);
      const user = await operations.requireUser(store, await identityOf(ctx));
      const project = await operations.requireProject(store, user, args.projectId);
      const title = mockupTitle(args.title);
      const linkedThreadIds = [...new Set(args.linkedThreadIds ?? [])];
      checkLinkedThreads(project._id, await Promise.all(linkedThreadIds.map((threadId) => store.threads.get(threadId))), 0);
      const now = Date.now();
      const mockupId = await ctx.db.insert("mockups", {
        projectId: project._id as Id<"projects">,
        title,
        source: args.source,
        createdBy: user._id as Id<"users">,
        createdAt: now,
        updatedAt: now,
        headVersion: 0,
        editBytes: 0,
      });
      await addCopy(ctx, store, { mockupId, project, user, snapshot: args.snapshot, now });
      for (const threadId of linkedThreadIds) {
        await ctx.db.insert("mockupLinks", { mockupId, threadId, projectId: project._id as Id<"projects">, linkedBy: user._id as Id<"users">, linkedAt: now });
      }
      return mockupId;
    }),
});

export const insertSnapshot = internalMutation({
  args: { mockupId: v.id("mockups"), snapshot: snapshotInput },
  handler: async (ctx, args): Promise<Id<"mockupSnapshots">> =>
    run(async () => {
      const { mockup, project, user, store } = await changeable(ctx, args.mockupId);
      const now = Date.now();
      const snapshotId = await addCopy(ctx, store, { mockupId: mockup._id, project, user, snapshot: args.snapshot, now });
      await ctx.db.patch(mockup._id, movedTo(mockup, now));
      return snapshotId;
    }),
});

/**
 * Deletes a page copy a refused `create` or `addSnapshot` uploaded, unless it
 * isn't fresh, something uses it, someone else uploaded it, or it was
 * uploaded as a screenshot: a refusal of one person's request never deletes
 * another's upload, nor one meant for something else.
 */
export const discardUpload = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const file = await ctx.db.system.get(storageId);
    if (file === null || file._creationTime < Date.now() - MOCKUP_RULES.uploadMinutes * 60_000) return;
    const upload = await ctx.db.query("uploads").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
    const identity = await identityOf(ctx);
    const user = identity === null ? null : await convexStore(ctx).users.byToken(identity.tokenIdentifier);
    if (upload === null || user === null || upload.uploadedBy !== user._id || upload.purpose !== "pageCopy" || upload.status === "attached") return;
    if (!(await usedFile(ctx, storageId))) {
      await ctx.storage.delete(storageId);
      await ctx.db.delete(upload._id);
    }
  },
});

export const rename = mutation({
  args: { mockupId: v.id("mockups"), title: v.string() },
  handler: async (ctx, args) =>
    run(async () => {
      const { mockup } = await changeable(ctx, args.mockupId);
      await ctx.db.patch(mockup._id, { title: mockupTitle(args.title), ...movedTo(mockup, Date.now()) });
    }),
});

/**
 * Saves an earlier version's changes (0: the original copies) as a new
 * version. `expectedHead` is the latest version the reviewer saw; if another
 * was saved since, nothing changes and the restore is refused.
 */
export const restore = mutation({
  args: { mockupId: v.id("mockups"), number: v.number(), expectedHead: v.number() },
  handler: async (ctx, args): Promise<number> =>
    run(async () => {
      const { mockup, user } = await changeable(ctx, args.mockupId);
      if (mockup.headVersion !== args.expectedHead) fail("invalid", "This mockup has a newer version than the one you saw. Look at it, then restore again.");
      if (!Number.isSafeInteger(args.number) || args.number < 0 || args.number > mockup.headVersion) fail("invalid", "That version doesn't exist.");
      return await saveVersion(ctx, mockup, {
        authorId: user._id as Id<"users">,
        byAi: false,
        summary: args.number === 0 ? "Restored the original page" : `Restored version ${args.number}`,
        restoredFrom: args.number,
        edits: await versionEdits(ctx, mockup._id, args.number),
      });
    }),
});

/**
 * Adds an existing thread of the same project to a mockup as instructions.
 * Linking twice changes nothing. The thread is checked against the mockup's
 * project before anything else, so a thread that doesn't exist, and one in
 * another project, whether limited to its organization or deleted, get the
 * same refusal.
 */
export const link = mutation({
  args: { mockupId: v.id("mockups"), threadId: v.id("threads") },
  handler: async (ctx, args) =>
    run(async () => {
      const { mockup, user, store } = await changeable(ctx, args.mockupId);
      const links = await linksOf(ctx, mockup._id);
      // Links hold only the mockup's own project's threads, so this tells nothing about another's.
      if (links.some((existing) => existing.threadId === args.threadId)) return;
      checkLinkedThreads(mockup.projectId, [await store.threads.get(args.threadId)], links.length);
      await ctx.db.insert("mockupLinks", {
        mockupId: mockup._id,
        threadId: args.threadId,
        projectId: mockup.projectId,
        linkedBy: user._id as Id<"users">,
        linkedAt: Date.now(),
      });
    }),
});

export const unlink = mutation({
  args: { mockupId: v.id("mockups"), threadId: v.id("threads") },
  handler: async (ctx, args) =>
    run(async () => {
      const { mockup } = await changeable(ctx, args.mockupId);
      const existing = await ctx.db
        .query("mockupLinks")
        .withIndex("by_mockup", (q) => q.eq("mockupId", mockup._id).eq("threadId", args.threadId))
        .first();
      if (existing !== null) await ctx.db.delete(existing._id);
    }),
});

/**
 * Deletes a mockup with its versions, links, and page copies, and deletes its
 * threads as deleting a thread does. Only its creator or those who manage the
 * project may, and only if they may delete each of its threads: a creator
 * can't delete a mockup whose thread someone else started, so nothing is
 * removed until that thread is deleted by its author or the project's owners.
 */
export const remove = mutation({
  args: { mockupId: v.id("mockups") },
  handler: async (ctx, args) =>
    run(async () => {
      const { store, mockup, project, user } = await changeable(ctx, args.mockupId);
      if (user._id !== mockup.createdBy && (await projectAccess(store, project, user._id)) !== "manage") {
        fail("forbidden", "Only the person who made this mockup or the project's owner can delete it.");
      }
      const threads = await threadsOf(ctx, mockup._id);
      for (const thread of threads) {
        if (!(await operations.canDeleteThread(store, project, thread, user._id))) {
          fail("forbidden", "Someone else started this mockup's thread. Only they or the project's owners can delete it.");
        }
      }
      const now = Date.now();
      for (const version of await ctx.db.query("mockupVersions").withIndex("by_mockup_number", (q) => q.eq("mockupId", mockup._id)).collect()) {
        await ctx.db.delete(version._id);
      }
      for (const link of await linksOf(ctx, mockup._id)) await ctx.db.delete(link._id);
      for (const snapshot of await snapshotsOf(ctx, mockup._id)) {
        await ctx.db.delete(snapshot._id);
        // A file stored before uploads were reserved might also be a thread's capture or another copy; then it stays.
        if ((await ctx.db.system.get(snapshot.storageId)) !== null && !(await usedFile(ctx, snapshot.storageId))) await ctx.storage.delete(snapshot.storageId);
      }
      for (const thread of threads) {
        await ctx.db.patch(thread._id, { status: "deleted", statusChangedBy: user._id as Id<"users">, statusChangedAt: now });
      }
      await ctx.db.delete(mockup._id);
    }),
});

// ---------------------------------------------------------------------------
// Mockup threads and Critiqs AI

/**
 * Checks a new mockup thread's mockup and copy belong to its project, that
 * the mockup has no thread yet: each mockup thread is its own proposal, with
 * its own copies and versions, and that the mockup's creator starts it.
 * Someone else starting it would own the proposal, and could keep its creator
 * from deleting the mockup. `threads.create` calls it.
 */
export async function checkThreadMockup(
  ctx: MutationCtx,
  projectId: string,
  mockup: Infer<typeof threadMockupValidator>,
  threadId: Id<"threads">,
): Promise<void> {
  const found = await ctx.db.get(mockup.mockupId);
  if (found === null || found.projectId !== projectId) fail("invalid", "This mockup isn't in the project.");
  if (mockup.snapshotId !== null) {
    const snapshot = await ctx.db.get(mockup.snapshotId);
    if (snapshot === null || snapshot.mockupId !== found._id) fail("invalid", "This page copy isn't in the mockup.");
  }
  // The new thread is already inserted, so any other thread is a second one.
  if ((await threadsOf(ctx, found._id)).some((thread) => thread._id !== threadId)) {
    fail("invalid", "This mockup already has its thread. Start a new mockup for another proposal.");
  }
  if ((await ctx.db.get(threadId))?.createdBy !== found.createdBy) {
    fail("forbidden", "Only the person who made this mockup can start its thread. Start a new mockup for your proposal.");
  }
  // Its thread exists now, so the panel lists it.
  const now = Date.now();
  await ctx.db.patch(found._id, { updatedAt: now, listedAt: now });
}

/**
 * Moves a mockup thread's mockup to its latest message, so the list, which
 * pages and sorts mockups by `listedAt`, shows active threads first. Every
 * message in a mockup thread calls it: a reply here, and Critiqs AI's answers.
 */
export async function touchThreadMockup(ctx: MutationCtx, threadId: Id<"threads">): Promise<void> {
  const thread = await ctx.db.get(threadId);
  if (thread?.mockup === undefined) return;
  const mockup = await ctx.db.get(thread.mockup.mockupId);
  if (mockup !== null && mockup.updatedAt < thread.lastMessageAt) await ctx.db.patch(mockup._id, movedTo(mockup, thread.lastMessageAt));
}

/** Takes a mockup off the panel's list when its thread is deleted: `threads.remove` calls it. */
export async function unlistThreadMockup(ctx: MutationCtx, threadId: Id<"threads">): Promise<void> {
  const thread = await ctx.db.get(threadId);
  if (thread?.mockup === undefined) return;
  const mockup = await ctx.db.get(thread.mockup.mockupId);
  if (mockup !== null && (await threadsOf(ctx, mockup._id)).length === 0) await ctx.db.patch(mockup._id, { listedAt: undefined });
}

/** The first step of a Critiqs AI turn: access, limits, and what the model reads. */
export const prepareAi = internalMutation({
  args: {
    threadId: v.id("threads"),
    snapshots: v.array(v.object({ snapshotId: v.id("mockupSnapshots"), description: v.string(), complete: v.boolean() })),
    continuation: v.boolean(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    run(async () => {
      const store = convexStore(ctx);
      const { thread, connection } = await authorizeMockupTurn(store, await identityOf(ctx), args, deployment(), Date.now());
      checkDescriptions(args.snapshots);
      const mockup = await ctx.db.get(thread.mockup.mockupId as Id<"mockups">);
      if (mockup === null) fail("not-found", "This mockup was deleted.");
      const snapshots = await snapshotsOf(ctx, mockup._id);
      const head = await versionEdits(ctx, mockup._id, mockup.headVersion);
      const copies = args.snapshots.map((entry) => {
        const snapshot = snapshots.find((candidate) => candidate._id === entry.snapshotId);
        if (snapshot === undefined) fail("invalid", "That page copy isn't in this mockup.");
        return { snapshotId: snapshot._id as string, width: snapshot.width, description: entry.description, complete: entry.complete, edits: editsFor(head, snapshot._id) };
      });
      const linked = [];
      for (const link of (await linksOf(ctx, mockup._id)).slice(0, MOCKUP_AI.linkedThreads)) {
        const other = await store.threads.get(link.threadId);
        if (other === null || other.status === "deleted") continue;
        linked.push({
          screen: other.reattachment?.location.screen ?? other.anchor.screen,
          status: other.status,
          messages: await conversationOf(store, other._id, MOCKUP_AI.linkedMessages),
        });
      }
      const { snapshotId, node } = thread.mockup;
      return {
        connection,
        head: mockup.headVersion,
        input: {
          title: mockup.title,
          page: { url: mockup.source.url, screen: mockup.source.screen },
          copies,
          focus: snapshotId === null ? null : { snapshotId, node },
          conversation: await conversationOf(store, thread._id, MOCKUP_AI.threadMessages),
          linked,
          continuation: args.continuation,
        },
      };
    }),
});

/** Checks access again right before the model is asked (see `recheckMockupTurn`). */
export const recheckAi = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => run(async () => recheckMockupTurn(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * The last step of a Critiqs AI turn: saves its reply and, when it changed
 * anything, the next version, unless another version was saved since `head`.
 */
export const finishAi = internalMutation({
  args: {
    threadId: v.id("threads"),
    head: v.number(),
    answer: v.object({
      reply: v.string(),
      summary: v.string(),
      edits: v.array(v.object({ snapshotId: v.string(), edits: v.array(mockupEditValidator) })),
      remaining: v.boolean(),
    }),
  },
  handler: async (ctx, { threadId, head, answer }): Promise<{ messageId: Id<"messages">; version: number | null }> =>
    run(async () => {
      const store = convexStore(ctx);
      const user = await operations.requireUser(store, await identityOf(ctx));
      const { thread, project } = await operations.requireThread(store, user, threadId);
      const mockup = thread.mockup === undefined ? null : await ctx.db.get(thread.mockup.mockupId as Id<"mockups">);
      if (mockup === null) fail("not-found", "This mockup was deleted.");
      if (mockup.headVersion !== head) {
        fail("invalid", "Someone saved another version of this mockup while Critiqs AI was working. Ask again to build on it.");
      }
      const context = { user, thread, project };
      if (answer.edits.length === 0) {
        const messageId = await operations.aiReply(store, context, { body: answer.reply, mockupVersion: null });
        await touchThreadMockup(ctx, thread._id as Id<"threads">);
        return { messageId: messageId as Id<"messages">, version: null };
      }
      const snapshotIds = new Set<string>((await snapshotsOf(ctx, mockup._id)).map((snapshot) => snapshot._id));
      if (answer.edits.some((entry) => !snapshotIds.has(entry.snapshotId))) fail("invalid", "A page copy of this mockup was removed meanwhile.");
      const edits = appendEdits(await versionEdits(ctx, mockup._id, mockup.headVersion), answer.edits);
      const version = mockup.headVersion + 1;
      const messageId = (await operations.aiReply(store, context, { body: answer.reply, mockupVersion: version })) as Id<"messages">;
      await saveVersion(ctx, mockup, {
        authorId: user._id as Id<"users">,
        byAi: true,
        summary: answer.summary,
        threadId: thread._id as Id<"threads">,
        messageId,
        edits,
      });
      await touchThreadMockup(ctx, thread._id as Id<"threads">);
      return { messageId, version };
    }),
});

// ---------------------------------------------------------------------------
// Helpers

/** Moves a mockup's `updatedAt` to `at`, and `listedAt` with it once the mockup is listed. */
function movedTo(mockup: Doc<"mockups">, at: number): Pick<Doc<"mockups">, "updatedAt" | "listedAt"> {
  return mockup.listedAt === undefined ? { updatedAt: at } : { updatedAt: at, listedAt: at };
}

/** A project whose mockups the reviewer may list: the same checks as reading its threads. */
async function listable(ctx: QueryCtx, projectId: Id<"projects">) {
  const store = convexStore(ctx);
  const { user } = await operations.currentReviewer(store, await identityOf(ctx));
  const project = await operations.requireProject(store, user, projectId);
  return { store, user, projectId: project._id as Id<"projects"> };
}

/** A mockup after the same checks as reading its project's threads; `user` is null before the reviewer's first change. */
async function readable(ctx: QueryCtx, mockupId: Id<"mockups">) {
  const store = convexStore(ctx);
  const { user } = await operations.currentReviewer(store, await identityOf(ctx));
  const mockup = await ctx.db.get(mockupId);
  if (mockup === null) fail("not-found", "This mockup does not exist.");
  const project = await operations.requireProject(store, user, mockup.projectId);
  return { store, user, mockup, project };
}

/** A mockup after the same checks as changing its project's threads. */
async function changeable(ctx: MutationCtx, mockupId: Id<"mockups">) {
  const store = convexStore(ctx);
  const user = await operations.requireUser(store, await identityOf(ctx));
  const mockup = await ctx.db.get(mockupId);
  if (mockup === null) fail("not-found", "This mockup does not exist.");
  const project = await operations.requireProject(store, user, mockup.projectId);
  return { store, user, mockup, project };
}

async function summary(ctx: QueryCtx, store: Store, user: UserRecord | null, mockup: Doc<"mockups">): Promise<MockupSummary> {
  const threads = await threadsOf(ctx, mockup._id);
  return {
    _id: mockup._id,
    projectId: mockup.projectId,
    title: mockup.title,
    source: mockup.source,
    createdAt: mockup.createdAt,
    updatedAt: mockup.updatedAt,
    listedAt: mockup.listedAt ?? null,
    createdByName: (await ctx.db.get(mockup.createdBy))?.name ?? "Unknown",
    versionCount: mockup.headVersion,
    threadCount: threads.length,
    snapshots: (await snapshotsOf(ctx, mockup._id)).map((snapshot) => ({ _id: snapshot._id, width: snapshot.width })),
    threads: await Promise.all(threads.map((thread) => operations.threadSummary(store, user, threadRecord(thread)))),
  };
}

function nameCache(ctx: QueryCtx) {
  const names = new Map<string, Promise<string>>();
  return (id: Id<"users">) => {
    if (!names.has(id)) names.set(id, ctx.db.get(id).then((user) => user?.name ?? "Unknown"));
    return names.get(id)!;
  };
}

async function snapshotsOf(ctx: QueryCtx, mockupId: Id<"mockups">) {
  return await ctx.db
    .query("mockupSnapshots")
    .withIndex("by_mockup", (q) => q.eq("mockupId", mockupId))
    .take(MOCKUP_RULES.snapshotsPerMockup);
}

async function linksOf(ctx: QueryCtx, mockupId: Id<"mockups">) {
  return await ctx.db
    .query("mockupLinks")
    .withIndex("by_mockup", (q) => q.eq("mockupId", mockupId))
    .take(MOCKUP_RULES.links);
}

/** A mockup's threads that aren't deleted, oldest first. */
async function threadsOf(ctx: QueryCtx, mockupId: Id<"mockups">) {
  return await ctx.db
    .query("threads")
    .withIndex("by_mockup", (q) => q.eq("mockup.mockupId", mockupId))
    .filter((q) => q.neq(q.field("status"), "deleted"))
    .take(MOCKUP_RULES.threads);
}

/** A version's changes; version 0 is the original copies, without any. */
async function versionEdits(ctx: QueryCtx, mockupId: Id<"mockups">, number: number): Promise<VersionEdits> {
  if (number === 0) return [];
  const version = await ctx.db
    .query("mockupVersions")
    .withIndex("by_mockup_number", (q) => q.eq("mockupId", mockupId).eq("number", number))
    .unique();
  if (version === null) throw new Error(`Mockup ${mockupId} has no version ${number}.`);
  return version.edits;
}

/** Saves the next version and makes it the mockup's latest. */
async function saveVersion(
  ctx: MutationCtx,
  mockup: Doc<"mockups">,
  version: Omit<Doc<"mockupVersions">, "_id" | "_creationTime" | "mockupId" | "number" | "createdAt" | "edits"> & { edits: VersionEdits },
): Promise<number> {
  const number = mockup.headVersion + 1;
  const now = Date.now();
  const editBytes = checkMockupRoom(mockup.editBytes, version.edits);
  await ctx.db.insert("mockupVersions", {
    ...version,
    edits: version.edits.map((entry) => ({ snapshotId: entry.snapshotId as Id<"mockupSnapshots">, edits: entry.edits })),
    mockupId: mockup._id,
    number,
    createdAt: now,
  });
  await ctx.db.patch(mockup._id, { headVersion: number, ...movedTo(mockup, now), editBytes });
  return number;
}

/** Stores an uploaded page copy once it, the layout, and the project's room check out. */
async function addCopy(
  ctx: MutationCtx,
  store: Store,
  args: { mockupId: Id<"mockups">; project: ProjectRecord; user: UserRecord; snapshot: Infer<typeof snapshotInput>; now: number },
): Promise<Id<"mockupSnapshots">> {
  const { snapshot, project } = args;
  checkSnapshotLayout(snapshot);
  if ((await snapshotsOf(ctx, args.mockupId)).length >= MOCKUP_RULES.snapshotsPerMockup) {
    fail("invalid", `A mockup holds up to ${MOCKUP_RULES.snapshotsPerMockup} page copies.`);
  }
  const file = await ctx.db.system.get(snapshot.storageId);
  checkSnapshotFile(file === null ? null : { ...(file.contentType === undefined ? {} : { contentType: file.contentType }), size: file.size, createdAt: file._creationTime }, args.now);
  // Only the caller's own upload for a page copy in this project, used by nothing yet.
  await checkUpload(ctx, snapshot.storageId, { projectId: project._id, userId: args.user._id, purpose: "pageCopy" });
  await useQuota(store, { ...(await projectQuota(store, project)), metric: "captureBytes", amount: file!.size, now: args.now });
  await markUploadAttached(ctx, snapshot.storageId);
  return await ctx.db.insert("mockupSnapshots", {
    ...snapshot,
    mockupId: args.mockupId,
    projectId: project._id as Id<"projects">,
    createdBy: args.user._id as Id<"users">,
    size: file!.size,
  });
}

/** Runs a mutation that stores an upload; if it's refused for the upload's sake, the upload is deleted. */
async function discardRefusedUpload<T>(ctx: ActionCtx, storageId: Id<"_storage">, store: () => Promise<T>): Promise<T> {
  try {
    return await store();
  } catch (error) {
    // Refusals of who may add to the project leave the file alone.
    const code = error instanceof ConvexError ? (error.data as { code?: unknown }).code : undefined;
    if (code === "invalid" || code === "limit") await ctx.runMutation(internal.mockups.discardUpload, { storageId });
    throw error;
  }
}
