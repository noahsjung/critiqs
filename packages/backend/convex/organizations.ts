import {
  adoptPlan,
  adoptProject,
  claimInviteEmail as claimInviteEmailOf,
  getOrganization,
  getOrganizationUsage,
  inviteMember,
  listMyOrganizations,
  recountStorage as recountStorageOp,
  removeMember as removeMemberOf,
  renameOrganization,
  revokeInvite as revokeInviteOf,
  setMemberRole,
  setOverageCap as setOverageCapOp,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";

const role = v.union(v.literal("admin"), v.literal("member"));

/** The organizations the signed-in reviewer belongs to, with their role and plan. */
export const mine = query({
  args: {},
  handler: async (ctx) => run(async () => listMyOrganizations(convexStore(ctx), await identityOf(ctx))),
});

/** An organization's name and members; its admins also see members' addresses and pending invites. Members only. */
export const get = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => run(async () => getOrganization(convexStore(ctx), await identityOf(ctx), args)),
});

/** Renames an organization. Admins only. */
export const rename = mutation({
  args: { organizationId: v.string(), name: v.string() },
  handler: async (ctx, args) => run(async () => renameOrganization(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Invites someone by email, then emails them. Admins only. Someone already a
 * member or invited is left alone. `projectId`, the project the admin invited
 * from, adds a link to its prototype in the email.
 */
export const invite = mutation({
  args: { organizationId: v.string(), email: v.string(), role, projectId: v.optional(v.string()) },
  handler: async (ctx, { projectId, ...args }) =>
    run(async () => {
      const result = await inviteMember(convexStore(ctx), await identityOf(ctx), args, Date.now());
      if (result.status !== "invited") return { status: result.status };
      await ctx.scheduler.runAfter(0, internal.organizationEmails.sendInvite, { inviteId: result.inviteId as Id<"invites">, projectId: projectId ?? null });
      return { status: result.status };
    }),
});

/** Withdraws an invite no one has accepted yet. Admins only. */
export const revokeInvite = mutation({
  args: { inviteId: v.string() },
  handler: async (ctx, args) => run(async () => revokeInviteOf(convexStore(ctx), await identityOf(ctx), args)),
});

/** Makes a member an admin, or an admin a member. Admins only; the last admin stays one. */
export const setRole = mutation({
  args: { organizationId: v.string(), userId: v.string(), role },
  handler: async (ctx, args) => run(async () => setMemberRole(convexStore(ctx), await identityOf(ctx), args)),
});

/** Removes someone from an organization, or lets them leave; never its last admin. */
export const removeMember = mutation({
  args: { organizationId: v.string(), userId: v.string() },
  handler: async (ctx, args) => run(async () => removeMemberOf(convexStore(ctx), await identityOf(ctx), args)),
});

/** A new invite's email, counted against the invite email limits; null once it was accepted or withdrawn, or past a limit. */
export const claimInviteEmail = internalMutation({
  args: { inviteId: v.id("invites"), projectId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => await claimInviteEmailOf(convexStore(ctx), args, Date.now()),
});

/** What the organization's plan limits for the whole organization, with usage so far, for its members; null without plans. */
export const usage = query({
  // The UTC day comes from the client, so the result changes when the day does.
  args: { organizationId: v.id("organizations"), day: v.string() },
  handler: async (ctx, args) => run(async () => getOrganizationUsage(convexStore(ctx), await identityOf(ctx), args)),
});

/** Sets how many Critiqs AI credits past the plan's the organization may use each month, null for no cap, or `default` for the plan's. For its admins. */
export const setOverageCap = mutation({
  args: { organizationId: v.id("organizations"), cap: v.union(v.number(), v.null(), v.literal("default")) },
  handler: async (ctx, args) => run(async () => setOverageCapOp(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Moves everything from before organizations into them: each project into its
 * creator's home organization (created with them as admin, their plan, and
 * the projects, images, and AI credits counted for them), then each person with a plan but no projects into a
 * home organization holding it, then recounts each organization's images
 * (`recountStorage`). A page per run; it schedules the next. Safe to run
 * again: what already moved is left alone. Run once after deploying with
 * `npx convex run organizations:backfill`.
 */
export const backfill = internalMutation({
  args: { phase: v.optional(v.union(v.literal("projects"), v.literal("users"))), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { phase = "projects", cursor = null }) => {
    const store = convexStore(ctx);
    const now = Date.now();
    let changed = 0;
    if (phase === "projects") {
      const result = await ctx.db.query("projects").paginate({ numItems: 100, cursor });
      for (const project of result.page) if (await adoptProject(store, project._id, now)) changed++;
      if (!result.isDone) await ctx.scheduler.runAfter(0, internal.organizations.backfill, { phase, cursor: result.continueCursor });
      else await ctx.scheduler.runAfter(0, internal.organizations.backfill, { phase: "users", cursor: null });
    } else {
      const result = await ctx.db.query("users").paginate({ numItems: 100, cursor });
      for (const user of result.page) if (await adoptPlan(store, user._id, now)) changed++;
      if (!result.isDone) await ctx.scheduler.runAfter(0, internal.organizations.backfill, { phase, cursor: result.continueCursor });
      else await ctx.scheduler.runAfter(0, internal.organizations.recountStorage, {});
    }
    return { phase, changed };
  },
});

/**
 * Sets each organization's stored image bytes to what its projects store
 * (`recountStorage`). A page of organizations per run; it schedules the next.
 * Safe to run again at any time. The backfill runs it last.
 */
export const recountStorage = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor = null }) => {
    const store = convexStore(ctx);
    const now = Date.now();
    let changed = 0;
    const result = await ctx.db.query("organizations").paginate({ numItems: 20, cursor });
    for (const organization of result.page) {
      const projects = await ctx.db.query("projects").withIndex("by_organization", (q) => q.eq("organizationId", organization._id)).collect();
      if (await recountStorageOp(store, organization._id, projects.map((project) => project._id), now)) changed++;
    }
    if (!result.isDone) await ctx.scheduler.runAfter(0, internal.organizations.recountStorage, { cursor: result.continueCursor });
    return { changed };
  },
});
