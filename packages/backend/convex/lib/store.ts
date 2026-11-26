import type { PageRequest } from "@critiqs/core";
import {
  CritiqsError,
  type Identity,
  type PageResult,
  PAGE_SIZE,
  type StoredCapture,
  type Store,
  type ThreadRecord,
  upgradeAddress,
} from "@critiqs/server";
import type { PaginationOptions, PaginationResult, UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { billingConfig, isPaidPlan } from "./billing";

// Critiqs's server rules (@critiqs/server) on Convex. Each Convex function is
// one transaction, so an operation's reads and writes commit together.

/** The storage interface over a query's or mutation's database. Writes need a mutation. */
export function convexStore(ctx: QueryCtx | MutationCtx): Store {
  const db = ctx.db;
  const writer = () => {
    if (!("insert" in db)) throw new Error("This Critiqs operation changes data and must run in a mutation.");
    return (ctx as MutationCtx).db;
  };
  const page = <T, R>(result: PaginationResult<T>, map: (row: T) => R): PageResult<R> => ({
    page: result.page.map(map),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  });

  return {
    normalizeId: (table, raw) => {
      switch (table) {
        case "files":
          return db.normalizeId("captureFiles", raw) ?? db.system.normalizeId("_storage", raw);
        case "projects":
          return db.normalizeId("projects", raw);
        case "threads":
          return db.normalizeId("threads", raw);
        case "messages":
          return db.normalizeId("messages", raw);
        case "users":
          return db.normalizeId("users", raw);
        case "deliveries":
          return db.normalizeId("deliveries", raw);
        case "tagGroups":
          return db.normalizeId("tagGroups", raw);
        case "organizations":
          return db.normalizeId("organizations", raw);
        case "invites":
          return db.normalizeId("invites", raw);
        case "developerSends":
          return db.normalizeId("developerSends", raw);
      }
    },

    users: {
      byToken: async (tokenIdentifier) =>
        await db
          .query("users")
          .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
          .unique(),
      get: async (id) => await db.get(id as Id<"users">),
      insert: async ({ homeOrganizationId, ...user }) =>
        await writer().insert("users", { ...user, ...organizationRef("homeOrganizationId", homeOrganizationId) }),
      patch: async (id, { homeOrganizationId, ...changes }) =>
        await writer().patch(id as Id<"users">, { ...defined(changes), ...organizationRef("homeOrganizationId", homeOrganizationId) }),
    },
    organizations: {
      get: async (id) => await db.get(id as Id<"organizations">),
      insert: async (organization) => await writer().insert("organizations", { ...organization, createdBy: organization.createdBy as Id<"users"> }),
      patch: async (id, { overageCap, ...changes }) =>
        await writer().patch(id as Id<"organizations">, {
          ...defined(changes),
          ...(overageCap === undefined ? {} : { overageCap: overageCap === "default" ? undefined : overageCap }),
        }),
    },
    memberships: {
      find: async (organizationId, userId) =>
        await db
          .query("memberships")
          .withIndex("by_organization_user", (q) => q.eq("organizationId", organizationId as Id<"organizations">).eq("userId", userId as Id<"users">))
          .unique(),
      insert: async (membership) =>
        await writer().insert("memberships", {
          ...membership,
          organizationId: membership.organizationId as Id<"organizations">,
          userId: membership.userId as Id<"users">,
        }),
      patch: async (id, changes) => await writer().patch(id as Id<"memberships">, { role: changes.role }),
      delete: async (id) => await writer().delete(id as Id<"memberships">),
      forUser: async (userId, limit) =>
        await db
          .query("memberships")
          .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
          .take(limit),
      admins: async (organizationId, limit) =>
        await db
          .query("memberships")
          .withIndex("by_organization_role", (q) => q.eq("organizationId", organizationId as Id<"organizations">).eq("role", "admin"))
          .take(limit),
      forOrganization: async (organizationId, limit) =>
        await db
          .query("memberships")
          .withIndex("by_organization_user", (q) => q.eq("organizationId", organizationId as Id<"organizations">))
          .take(limit),
    },
    invites: {
      get: async (id) => await db.get(id as Id<"invites">),
      findPending: async (organizationId, email) =>
        await db
          .query("invites")
          .withIndex("by_organization_email", (q) => q.eq("organizationId", organizationId as Id<"organizations">).eq("email", email))
          .filter((q) => q.eq(q.field("acceptedAt"), undefined))
          .first(),
      insert: async (invite) =>
        await writer().insert("invites", {
          ...invite,
          organizationId: invite.organizationId as Id<"organizations">,
          invitedBy: invite.invitedBy as Id<"users">,
        }),
      patch: async (id, changes) => await writer().patch(id as Id<"invites">, { acceptedAt: changes.acceptedAt }),
      delete: async (id) => await writer().delete(id as Id<"invites">),
      pendingForOrganization: async (organizationId, limit) =>
        await db
          .query("invites")
          .withIndex("by_organization_pending", (q) => q.eq("organizationId", organizationId as Id<"organizations">).eq("acceptedAt", undefined))
          .take(limit),
      pendingForEmail: async (email, limit) =>
        await db
          .query("invites")
          .withIndex("by_email_pending", (q) => q.eq("email", email).eq("acceptedAt", undefined))
          .take(limit),
    },
    developerSends: {
      get: async (id) => await db.get(id as Id<"developerSends">),
      find: async (projectId, email) =>
        await db
          .query("developerSends")
          .withIndex("by_project_email", (q) => q.eq("projectId", projectId as Id<"projects">).eq("email", email))
          .unique(),
      forProject: async (projectId, limit) =>
        await db
          .query("developerSends")
          .withIndex("by_project_email", (q) => q.eq("projectId", projectId as Id<"projects">))
          .take(limit)
          .then((sends) => sends.sort((a, b) => a._creationTime - b._creationTime)),
      insert: async (send) =>
        await writer().insert("developerSends", { ...send, projectId: send.projectId as Id<"projects">, sentBy: send.sentBy as Id<"users"> }),
      patch: async (id, { sentBy, message, ...changes }) =>
        await writer().patch(id as Id<"developerSends">, {
          ...defined(changes),
          ...(sentBy === undefined ? {} : { sentBy: sentBy as Id<"users"> }),
          // Null clears the message, which Convex does for a field set to undefined.
          ...(message === undefined ? {} : { message: message ?? undefined }),
        }),
    },
    emailSuppressions: {
      has: async (inbox) =>
        (await db
          .query("emailSuppressions")
          .withIndex("by_inbox", (q) => q.eq("inbox", inbox))
          .first()) !== null,
      add: async (inbox, now) => {
        const existing = await db
          .query("emailSuppressions")
          .withIndex("by_inbox", (q) => q.eq("inbox", inbox))
          .first();
        if (existing === null) await writer().insert("emailSuppressions", { inbox, createdAt: now });
      },
    },
    projects: {
      get: async (id) => await db.get(id as Id<"projects">),
      insert: async ({ organizationId, ...project }) =>
        await writer().insert("projects", { ...project, createdBy: project.createdBy as Id<"users">, ...organizationRef("organizationId", organizationId) }),
      patch: async (id, { organizationId, ...changes }) =>
        await writer().patch(id as Id<"projects">, { ...defined(changes), ...organizationRef("organizationId", organizationId) }),
      listByCreator: async (userId, request) =>
        page(
          await db
            .query("projects")
            .withIndex("by_creator", (q) => q.eq("createdBy", userId as Id<"users">))
            .paginate(bounded(request)),
          (project) => project,
        ),
    },
    projectAddresses: {
      forProject: async (projectId, limit) =>
        await db
          .query("projectAddresses")
          .withIndex("by_project", (q) => q.eq("projectId", projectId as Id<"projects">))
          .take(limit),
      insert: async (address) =>
        await writer().insert("projectAddresses", {
          ...address,
          projectId: address.projectId as Id<"projects">,
          organizationId: address.organizationId as Id<"organizations">,
        }),
      delete: async (id) => await writer().delete(id as Id<"projectAddresses">),
      inOrganization: async (organizationId, key, limit) =>
        await db
          .query("projectAddresses")
          .withIndex("by_organization_key", (q) => q.eq("organizationId", organizationId as Id<"organizations">).eq("key", key))
          .take(limit),
      inProject: async (projectId, key) =>
        await db
          .query("projectAddresses")
          .withIndex("by_project_key", (q) => q.eq("projectId", projectId as Id<"projects">).eq("key", key))
          .collect(),
    },
    openedProjects: {
      find: async (userId, projectId) =>
        await db
          .query("openedProjects")
          .withIndex("by_user_project", (q) => q.eq("userId", userId as Id<"users">).eq("projectId", projectId as Id<"projects">))
          .unique(),
      insert: async (opened) =>
        await writer().insert("openedProjects", { ...opened, userId: opened.userId as Id<"users">, projectId: opened.projectId as Id<"projects"> }),
      patch: async (id, changes) => await writer().patch(id as Id<"openedProjects">, { openedAt: changes.openedAt }),
      recent: async (userId, limit) =>
        await db
          .query("openedProjects")
          .withIndex("by_user_time", (q) => q.eq("userId", userId as Id<"users">))
          .order("desc")
          .take(limit),
    },
    threads: {
      get: async (id) => {
        const thread = await db.get(id as Id<"threads">);
        return thread === null ? null : threadRecord(thread);
      },
      insert: async (thread) => await writer().insert("threads", threadDoc(thread)),
      patch: async (id, changes) => await writer().patch(id as Id<"threads">, threadDoc(defined(changes))),
      listVisible: async (projectId, request) =>
        page(
          await db
            .query("threads")
            .withIndex("by_project", (q) => q.eq("projectId", projectId as Id<"projects">))
            .filter((q) => q.and(q.neq(q.field("status"), "deleted"), q.eq(q.field("mockup"), undefined)))
            .paginate(bounded(request)),
          threadRecord,
        ),
      byCaptureFile: async (fileId) => {
        const thread = await db
          .query("threads")
          .withIndex("by_capture_storage", (q) => q.eq("capture.storageId", fileId as Id<"_storage">))
          .first();
        return thread === null ? null : threadRecord(thread);
      },
      byPageKey: async (key) => {
        const thread = await db
          .query("threads")
          .withIndex("by_page_key", (q) => q.eq("pageKey", key))
          .unique();
        return thread === null ? null : threadRecord(thread);
      },
      recent: async (projectId, limit) =>
        (
          await db
            .query("threads")
            .withIndex("by_project_activity", (q) => q.eq("projectId", projectId as Id<"projects">))
            .order("desc")
            .filter((q) => q.and(q.neq(q.field("status"), "deleted"), q.eq(q.field("mockup"), undefined)))
            .take(limit)
        ).map(threadRecord),
    },
    messages: {
      get: async (id) => await db.get(id as Id<"messages">),
      insert: async (message) =>
        await writer().insert("messages", {
          threadId: message.threadId as Id<"threads">,
          authorId: message.authorId as Id<"users">,
          body: message.body,
          createdAt: message.createdAt,
          editedAt: message.editedAt,
          revision: message.revision,
          ...(message.mentions === undefined
            ? {}
            : { mentions: message.mentions.map((mention) => ({ userId: mention.userId as Id<"users">, label: mention.label })) }),
          ...(message.projectId === undefined ? {} : { projectId: message.projectId as Id<"projects"> }),
          ...(message.hashtags === undefined ? {} : { hashtags: message.hashtags }),
          ...(message.via === undefined ? {} : { via: message.via }),
          ...(message.mockupVersion === undefined ? {} : { mockupVersion: message.mockupVersion }),
        }),
      patch: async (id, changes) => await writer().patch(id as Id<"messages">, defined(changes) as Partial<Doc<"messages">>),
      list: async (threadId, request) =>
        page(
          await db
            .query("messages")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
            .paginate(bounded(request)),
          (message) => message,
        ),
      first: async (threadId) =>
        await db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
          .first(),
      latest: async (threadId, limit) =>
        await db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
          .order("desc")
          .take(limit),

      search: async (projectId, terms, limit) => {
        const text = terms.map((term) => term.trim()).filter(Boolean).slice(0, 16).join(" ");
        if (text === "") return [];
        return await db
          .query("messages")
          .withSearchIndex("search_body", (q) => q.search("body", text).eq("projectId", projectId as Id<"projects">))
          .take(limit);
      },
    },
    tags: {
      find: async (projectId, key) =>
        await db
          .query("projectTags")
          .withIndex("by_project_key", (q) => q.eq("projectId", projectId as Id<"projects">).eq("key", key))
          .unique(),
      get: async (id) => {
        const tagId = db.normalizeId("projectTags", id);
        return tagId === null ? null : await db.get(tagId);
      },
      insert: async (tag) =>
        await writer().insert("projectTags", {
          ...tag,
          projectId: tag.projectId as Id<"projects">,
          groupIds: tag.groupIds as Id<"tagGroups">[],
        }),
      patch: async (id, changes) =>
        await writer().patch(id as Id<"projectTags">, defined(changes) as Partial<Doc<"projectTags">>),
      list: async (projectId, limit) =>
        await db
          .query("projectTags")
          .withIndex("by_project_used", (q) => q.eq("projectId", projectId as Id<"projects">))
          .order("desc")
          .take(limit),
      due: async (now, limit) =>
        await db
          .query("projectTags")
          .withIndex("by_due", (q) => q.eq("grouping", "pending").lte("nextAttemptAt", now))
          .take(limit),
      dueInProject: async (projectId, now, limit) =>
        await db
          .query("projectTags")
          .withIndex("by_project_grouping", (q) =>
            q.eq("projectId", projectId as Id<"projects">).eq("grouping", "pending").lte("nextAttemptAt", now),
          )
          .take(limit),
      inState: async (projectId, grouping, limit) =>
        await db
          .query("projectTags")
          .withIndex("by_project_grouping", (q) => q.eq("projectId", projectId as Id<"projects">).eq("grouping", grouping))
          .take(limit),
    },
    tagGroups: {
      get: async (id) => await db.get(id as Id<"tagGroups">),
      byName: async (projectId, nameKey) =>
        await db
          .query("tagGroups")
          .withIndex("by_project_name", (q) => q.eq("projectId", projectId as Id<"projects">).eq("nameKey", nameKey))
          .unique(),
      list: async (projectId, limit) =>
        await db
          .query("tagGroups")
          .withIndex("by_project_name", (q) => q.eq("projectId", projectId as Id<"projects">))
          .take(limit),
      insert: async (group) => await writer().insert("tagGroups", { ...group, projectId: group.projectId as Id<"projects"> }),
      patch: async (id, changes) => await writer().patch(id as Id<"tagGroups">, defined(changes)),
      delete: async (id) => await writer().delete(id as Id<"tagGroups">),
    },
    threadTags: {
      forThread: async (threadId) =>
        await db
          .query("threadTags")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
          .collect(),
      insert: async (row) =>
        await writer().insert("threadTags", {
          projectId: row.projectId as Id<"projects">,
          threadId: row.threadId as Id<"threads">,
          key: row.key,
        }),
      delete: async (id) => await writer().delete(id as Id<"threadTags">),
      byKey: async (projectId, key, limit) =>
        await db
          .query("threadTags")
          .withIndex("by_project_key", (q) => q.eq("projectId", projectId as Id<"projects">).eq("key", key))
          .order("desc")
          .take(limit),
    },
    aiSettings: {
      find: async (projectId) =>
        await db
          .query("aiSettings")
          .withIndex("by_project", (q) => q.eq("projectId", projectId as Id<"projects">))
          .unique(),
      insert: async (settings) => await writer().insert("aiSettings", { ...settings, projectId: settings.projectId as Id<"projects"> }),
      patch: async (id, changes) => {
        // `null` clears an optional field; Convex removes fields patched to undefined.
        const fields = Object.fromEntries(
          Object.entries(changes)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, value === null ? undefined : value]),
        );
        await writer().patch(id as Id<"aiSettings">, fields as Partial<Doc<"aiSettings">>);
      },
    },
    personalAiSettings: {
      find: async (userId) => {
        const id = db.normalizeId("users", userId);
        if (id === null) return null;
        const row = await db
          .query("personalAiSettings")
          .withIndex("by_user", (q) => q.eq("userId", id))
          .unique();
        return row === null ? null : { ...row, userId: row.userId as string };
      },
      insert: async (settings) => await writer().insert("personalAiSettings", { ...settings, userId: settings.userId as Id<"users"> }),
      patch: async (id, changes) => {
        // `null` clears an optional field; Convex removes fields patched to undefined.
        const fields = Object.fromEntries(
          Object.entries(changes)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, value === null ? undefined : value]),
        );
        await writer().patch(id as Id<"personalAiSettings">, fields as Partial<Doc<"personalAiSettings">>);
      },
      delete: async (id) => await writer().delete(id as Id<"personalAiSettings">),
    },
    rateLimits: {
      hit: async (key, limit, windowMs, now) => {
        const row = await db
          .query("aiRateLimits")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique();
        if (row !== null && row.expiresAt > now && row.count >= limit) return false;
        if (row === null) await writer().insert("aiRateLimits", { key, count: 1, expiresAt: now + windowMs });
        else if (row.expiresAt <= now) await writer().patch(row._id, { count: 1, expiresAt: now + windowMs });
        else await writer().patch(row._id, { count: row.count + 1 });
        return true;
      },
    },
    reactions: {
      find: async (messageId, userId, emoji) =>
        await db
          .query("reactions")
          .withIndex("by_message_user_emoji", (q) =>
            q.eq("messageId", messageId as Id<"messages">).eq("userId", userId as Id<"users">).eq("emoji", emoji),
          )
          .unique(),
      insert: async (reaction) =>
        await writer().insert("reactions", {
          threadId: reaction.threadId as Id<"threads">,
          messageId: reaction.messageId as Id<"messages">,
          userId: reaction.userId as Id<"users">,
          emoji: reaction.emoji,
        }),
      delete: async (id) => await writer().delete(id as Id<"reactions">),
      list: async (threadId, request) =>
        page(
          await db
            .query("reactions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
            .paginate(bounded(request)),
          (reaction) => reaction,
        ),
    },
    readStates: {
      find: async (userId, threadId) =>
        await db
          .query("readStates")
          .withIndex("by_user_thread", (q) => q.eq("userId", userId as Id<"users">).eq("threadId", threadId as Id<"threads">))
          .unique(),
      insert: async (state) =>
        await writer().insert("readStates", {
          ...state,
          userId: state.userId as Id<"users">,
          threadId: state.threadId as Id<"threads">,
        }),
      patch: async (id, changes) => await writer().patch(id as Id<"readStates">, defined(changes) as Partial<Doc<"readStates">>),
    },
    participants: {
      find: async (projectId, userId) =>
        await db
          .query("participants")
          .withIndex("by_project_user", (q) => q.eq("projectId", projectId as Id<"projects">).eq("userId", userId as Id<"users">))
          .unique(),
      insert: async (participant) =>
        await writer().insert("participants", {
          projectId: participant.projectId as Id<"projects">,
          userId: participant.userId as Id<"users">,
          lastActiveAt: participant.lastActiveAt,
        }),
      patch: async (id, changes) => await writer().patch(id as Id<"participants">, defined(changes)),
      recent: async (projectId, limit) =>
        await db
          .query("participants")
          .withIndex("by_project_activity", (q) => q.eq("projectId", projectId as Id<"projects">))
          .order("desc")
          .take(limit),
    },
    planAlerts: {
      get: async (id) => await db.get(id as Id<"planAlerts">),
      find: async (organizationId, kind, month, plan) =>
        await db
          .query("planAlerts")
          .withIndex("by_organization_kind_month_plan", (q) =>
            q.eq("organizationId", organizationId as Id<"organizations">).eq("kind", kind).eq("month", month).eq("plan", plan),
          )
          .unique(),
      insert: async (alert) =>
        await writer().insert("planAlerts", {
          ...alert,
          organizationId: alert.organizationId as Id<"organizations">,
          projectId: alert.projectId as Id<"projects"> | undefined,
        }),
      patch: async (id, changes) => await writer().patch(id as Id<"planAlerts">, defined(changes)),
      due: async (now, limit) => {
        const pending = await db
          .query("planAlerts")
          .withIndex("by_status_due", (q) => q.eq("status", "pending").lte("dueAt", now))
          .take(limit);
        const stalled = await db
          .query("planAlerts")
          .withIndex("by_status_lease", (q) => q.eq("status", "sending").lte("leaseUntil", now))
          .take(limit);
        return [...pending, ...stalled].sort((a, b) => a.dueAt - b.dueAt).slice(0, limit);
      },
    },
    deliveries: {
      get: async (id) => await db.get(id as Id<"deliveries">),
      insert: async (delivery) =>
        await writer().insert("deliveries", {
          ...delivery,
          recipientId: delivery.recipientId as Id<"users">,
          projectId: delivery.projectId as Id<"projects">,
          threadId: delivery.threadId as Id<"threads">,
          payload: delivery.payload === undefined ? undefined : { ...delivery.payload, fileId: delivery.payload.fileId as Id<"_storage"> },
        }),
      patch: async (id, changes) =>
        await writer().patch(id as Id<"deliveries">, defined(changes) as Partial<Doc<"deliveries">>),
      gathering: async (recipientId, threadId) =>
        await db
          .query("deliveries")
          .withIndex("by_recipient_thread", (q) =>
            q
              .eq("recipientId", recipientId as Id<"users">)
              .eq("threadId", threadId as Id<"threads">)
              .eq("status", "pending")
              .eq("attempts", 0),
          )
          .order("desc")
          .first(),
      due: async (now, limit) => {
        const pending = await db
          .query("deliveries")
          .withIndex("by_status_due", (q) => q.eq("status", "pending").lte("dueAt", now))
          .take(limit);
        const stalled = await db
          .query("deliveries")
          .withIndex("by_status_lease", (q) => q.eq("status", "sending").lte("leaseUntil", now))
          .take(limit);
        return [...pending, ...stalled].sort((a, b) => a.dueAt - b.dueAt).slice(0, limit);
      },
      finishedBefore: async (before, limit) =>
        await db
          .query("deliveries")
          .withIndex("by_finished", (q) => q.gt("finishedAt", 0).lt("finishedAt", before))
          .take(limit),
      delete: async (id) => await writer().delete(id as Id<"deliveries">),
    },
    notifications: {
      insert: async (notification) =>
        await writer().insert("notifications", {
          deliveryId: notification.deliveryId as Id<"deliveries">,
          recipientId: notification.recipientId as Id<"users">,
          messageId: notification.messageId as Id<"messages">,
          authorId: notification.authorId as Id<"users">,
          createdAt: notification.createdAt,
          ...(notification.kind === undefined ? {} : { kind: notification.kind }),
        }),
      forDelivery: async (deliveryId, limit) =>
        await db
          .query("notifications")
          .withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId as Id<"deliveries">))
          .take(limit),
      delete: async (id) => await writer().delete(id as Id<"notifications">),
    },
    followers: {
      find: async (threadId, userId) =>
        await db
          .query("threadFollowers")
          .withIndex("by_thread_user", (q) => q.eq("threadId", threadId as Id<"threads">).eq("userId", userId as Id<"users">))
          .unique(),
      insert: async (follower) =>
        await writer().insert("threadFollowers", {
          threadId: follower.threadId as Id<"threads">,
          userId: follower.userId as Id<"users">,
          since: follower.since,
        }),
      list: async (threadId, request) =>
        page(
          await db
            .query("threadFollowers")
            .withIndex("by_thread_user", (q) => q.eq("threadId", threadId as Id<"threads">))
            .paginate({ numItems: request.numItems, cursor: request.cursor }),
          (follower) => follower,
        ),
    },
    replyEmailJobs: {
      insert: async (job) =>
        await writer().insert("replyEmailJobs", {
          ...job,
          projectId: job.projectId as Id<"projects">,
          threadId: job.threadId as Id<"threads">,
          messageId: job.messageId as Id<"messages">,
          authorId: job.authorId as Id<"users">,
        }),
      next: async () => await db.query("replyEmailJobs").withIndex("by_created").first(),
      patch: async (id, changes) => await writer().patch(id as Id<"replyEmailJobs">, defined(changes)),
      delete: async (id) => await writer().delete(id as Id<"replyEmailJobs">),
    },
    preferences: {
      find: async (userId) =>
        await db
          .query("preferences")
          .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
          .unique(),
      insert: async (preference) =>
        await writer().insert("preferences", {
          userId: preference.userId as Id<"users">,
          mentionEmails: preference.mentionEmails,
          ...(preference.replyEmails === undefined ? {} : { replyEmails: preference.replyEmails }),
          mutedProjects: preference.mutedProjects as Id<"projects">[],
        }),
      patch: async (id, changes) =>
        await writer().patch(id as Id<"preferences">, defined(changes) as Partial<Doc<"preferences">>),
    },
    limits: {
      // Only Critiqs Cloud limits usage; a team's own deployment leaves this unset.
      enabled: () => process.env.CRITIQS_PLANS === "enabled",
      upgradeUrl: () => upgradeAddress(process.env.CRITIQS_UPGRADE_URL),
      plan: async (name) => {
        const plan = await db.query("plans").withIndex("by_name", (q) => q.eq("name", name)).unique();
        return plan === null ? null : { name: plan.name, label: plan.label, limits: plan.limits };
      },
    },
    usage: {
      find: async (key) => await db.query("usage").withIndex("by_key", (q) => q.eq("key", key)).unique(),
      insert: async (usage) => await writer().insert("usage", usage),
      patch: async (id, changes) => await writer().patch(id as Id<"usage">, changes),
      isMember: async (key, member) =>
        (await db
          .query("usageMembers")
          .withIndex("by_key_member", (q) => q.eq("key", key).eq("member", member))
          .unique()) !== null,
      addMember: async (key, member) => {
        await writer().insert("usageMembers", { key, member });
      },
    },
    ...(billingConfig() === null
      ? {}
      : {
          billedCredits: {
            add: async ({ organizationId, credits, now }) => {
              const id = organizationId as Id<"organizations">;
              const account = await db
                .query("billingAccounts")
                .withIndex("by_organization", (q) => q.eq("organizationId", id))
                .unique();
              if (account?.state === undefined || !isPaidPlan(account.state.plan)) return;
              await writer().insert("billingUsage", {
                organizationId: id,
                credits,
                createdAt: now,
                status: "pending",
                attempts: 0,
                dueAt: now,
              });
              // Sent at once rather than by the next minute's run: Autumn counts usage in the period current when it arrives.
              await (ctx as MutationCtx).scheduler.runAfter(0, internal.billing.reportUsage, {});
            },
          },
        }),
    creditHolds: {
      held: async (scope, now) => {
        const holds = await db
          .query("creditHolds")
          .withIndex("by_scope_expiry", (q) => q.eq("scope", scope).gt("expiresAt", now))
          .collect();
        return holds.reduce((sum, hold) => sum + hold.credits, 0);
      },
      insert: async (hold, now) => {
        const expired = await db
          .query("creditHolds")
          .withIndex("by_scope_expiry", (q) => q.eq("scope", hold.scope).lte("expiresAt", now))
          .take(100);
        for (const row of expired) await writer().delete(row._id);
        return await writer().insert("creditHolds", hold);
      },
      delete: async (raw) => {
        const id = db.normalizeId("creditHolds", raw);
        if (id !== null && (await db.get(id)) !== null) await writer().delete(id);
      },
    },
    files: {
      info: async (fileId) => {
        const id = db.normalizeId("captureFiles", fileId);
        if (id !== null) {
          const file = await db.get(id);
          return file === null || (file.status !== "ready" && file.status !== "attached") || file.size === undefined
            ? null
            : { contentType: file.contentType, size: file.size, createdAt: file.createdAt };
        }
        const file = await db.system.get(fileId as Id<"_storage">);
        return file === null
          ? null
          : { ...(file.contentType === undefined ? {} : { contentType: file.contentType }), size: file.size, createdAt: file._creationTime };
      },
      delete: async (fileId) => {
        writer();
        if ((await db.system.get(fileId as Id<"_storage">)) !== null) await (ctx as MutationCtx).storage.delete(fileId as Id<"_storage">);
      },
    },
  };
}

/** The signed-in reviewer as Critiqs's rules see them, from Convex's view of the token. */
export async function identityOf(ctx: { auth: QueryCtx["auth"] }): Promise<Identity | null> {
  const identity: UserIdentity | null = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  // Convex keeps custom JWT claims under their own names (`email_verified`,
  // `picture`) rather than the OpenID field names it uses for other providers.
  const picture = identity.pictureUrl ?? identity.picture;
  const version = identity.profile_version;
  return {
    tokenIdentifier: identity.tokenIdentifier,
    name: identity.name ?? null,
    email: identity.email ?? null,
    emailVerified: identity.emailVerified === true || identity.email_verified === true,
    pictureUrl: typeof picture === "string" ? picture : null,
    profileVersion: typeof version === "number" ? version : null,
  };
}

/** Runs one of Critiqs's operations, reporting refusals as Convex errors the interface understands. */
export async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CritiqsError) throw new ConvexError({ code: error.code, message: error.message });
    throw error;
  }
}

/**
 * Changes without fields set to `undefined`. Convex would remove such a field;
 * Critiqs's stores treat it as unchanged, as SQLite does.
 */
function defined<T extends object>(changes: T): T {
  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as T;
}

function organizationRef<K extends string>(field: K, id: string | undefined): { [P in K]?: Id<"organizations"> } {
  return (id === undefined ? {} : { [field]: id as Id<"organizations"> }) as { [P in K]?: Id<"organizations"> };
}

/** Convex reads a bounded number of rows and bytes per page, besides the item count. */
function bounded(request: PageRequest): PaginationOptions {
  return { ...request, maximumRowsRead: PAGE_SIZE * 2, maximumBytesRead: 512_000 };
}

export function threadRecord(thread: Doc<"threads">): ThreadRecord {
  const { _creationTime: _created, capture, ...rest } = thread;
  return { ...rest, capture: storedCapture(capture) };
}

function storedCapture(capture: Doc<"threads">["capture"]): StoredCapture {
  switch (capture.status) {
    case "captured":
      return { status: "captured", fileId: capture.storageId };
    case "supplied":
      return { status: "supplied", fileId: capture.storageId, failureReason: capture.failureReason };
    case "failed":
      return capture;
  }
}

/** Convex's shape of a thread or of changes to one. */
function threadDoc<T extends Partial<Omit<ThreadRecord, "_id">>>(thread: T) {
  const { capture, projectId, createdBy, statusChangedBy, reattachment, mockup, ...rest } = thread;
  return {
    ...rest,
    ...(projectId === undefined ? {} : { projectId: projectId as Id<"projects"> }),
    ...(createdBy === undefined ? {} : { createdBy: createdBy as Id<"users"> }),
    ...(statusChangedBy === undefined ? {} : { statusChangedBy: statusChangedBy as Id<"users"> }),
    ...(reattachment === undefined
      ? {}
      : { reattachment: { ...reattachment, reattachedBy: reattachment.reattachedBy as Id<"users"> } }),
    ...(mockup === undefined
      ? {}
      : {
          mockup: {
            mockupId: mockup.mockupId as Id<"mockups">,
            snapshotId: mockup.snapshotId as Id<"mockupSnapshots"> | null,
            node: mockup.node,
          },
        }),
    ...(capture === undefined
      ? {}
      : {
          capture:
            capture.status === "failed"
              ? capture
              : capture.status === "captured"
                ? { status: "captured" as const, storageId: capture.fileId as Id<"_storage"> }
                : { status: "supplied" as const, storageId: capture.fileId as Id<"_storage">, failureReason: capture.failureReason },
        }),
  } as Omit<Doc<"threads">, "_id" | "_creationTime">;
}
