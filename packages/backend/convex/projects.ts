import {
  addProjectAddress,
  findProjectsForOrigin,
  getProjectAddresses,
  listManageableProjects,
  operations,
  recordProjectOpened,
  removeProjectAddress,
  setProjectAddresses,
} from "@critiqs/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { projectAnswersArgs } from "./lib/validators";

export { DEFAULT_TAGS } from "@critiqs/server";

/**
 * Project setup: any signed-in reviewer can create a project, noting where its
 * prototype is reviewed, in an organization they belong to (their home one
 * unless `organizationId` names another). Onboarding also sends its answers
 * about the project and the stack; what it's for picks the starting tags.
 * With `idempotencyKey`, a retry by the same person within a day returns the
 * project the first call created.
 */
export const create = mutation({
  args: {
    name: v.string(),
    reviewUrl: v.optional(v.union(v.string(), v.null())),
    organizationId: v.optional(v.string()),
    onboarding: v.optional(projectAnswersArgs),
    stack: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    run(async () => (await operations.createProject(convexStore(ctx), await identityOf(ctx), args)) as Id<"projects">),
});

/** Projects the reviewer created, so setup can reconnect an existing project. */
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) =>
    run(async () => operations.listMyProjects(convexStore(ctx), await identityOf(ctx), paginationOpts)),
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => operations.getProject(convexStore(ctx), await identityOf(ctx), args)),
});

/** The prototype address mention emails link to. Only those who manage the project may change it. */
export const setReviewUrl = mutation({
  args: { projectId: v.id("projects"), reviewUrl: v.string() },
  handler: async (ctx, args) => run(async () => operations.setReviewUrl(convexStore(ctx), await identityOf(ctx), args)),
});

/** Who can review the project: anyone who signs in, or only its organization's members. Only those who manage the project may change it. */
export const setReviewAccess = mutation({
  args: { projectId: v.id("projects"), reviewAccess: v.union(v.literal("anyone"), v.literal("organization")) },
  handler: async (ctx, args) => run(async () => operations.setReviewAccess(convexStore(ctx), await identityOf(ctx), args)),
});

/** Mention suggestions: people who have commented in the project, by name. */
export const participants = query({
  args: { projectId: v.id("projects"), query: v.string() },
  handler: async (ctx, args) => run(async () => operations.listParticipants(convexStore(ctx), await identityOf(ctx), args)),
});

/** Everyone in the project with exactly this name, for mentioning by name (`critiqs_reply`). */
export const participantsNamed = query({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, args) => run(async () => operations.listParticipantsNamed(convexStore(ctx), await identityOf(ctx), args)),
});

/** The project's usage against its Critiqs Cloud plan, for its owner; null without plans. */
export const usage = query({
  // The UTC day comes from the client, so the result changes when the day does.
  args: { projectId: v.id("projects"), day: v.string(), aiCredits: v.optional(v.boolean()) },
  handler: async (ctx, args) => run(async () => operations.getUsage(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Replaces the project's address list, which the browser extension's project
 * lookup searches; returns it normalized. Only the project's owners may.
 */
export const setAddresses = mutation({
  args: { projectId: v.id("projects"), addresses: v.array(v.string()) },
  handler: async (ctx, args) => run(async () => setProjectAddresses(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Adds one address to the project's list in one transaction, so people adding
 * at the same time keep every address; returns the list. An address already
 * listed changes nothing. Only the project's owners may.
 */
export const addAddress = mutation({
  args: { projectId: v.id("projects"), address: v.string() },
  handler: async (ctx, args) => run(async () => addProjectAddress(convexStore(ctx), await identityOf(ctx), args)),
});

/** Removes one address from the project's list; returns the list. Only the project's owners may. */
export const removeAddress = mutation({
  args: { projectId: v.id("projects"), address: v.string() },
  handler: async (ctx, args) => run(async () => removeProjectAddress(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * The projects whose address lists the signed-in person may change: those in
 * organizations they're an admin of, and those they created while a member.
 */
export const manageable = query({
  args: {},
  handler: async (ctx) => run(async () => listManageableProjects(convexStore(ctx), await identityOf(ctx))),
});

/** The project's address list, for its owners. */
export const addresses = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => getProjectAddresses(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * Records that the signed-in person opened the project through an install, so
 * the lookup searches it too. The component calls it once per session and project.
 */
export const recordOpened = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => recordProjectOpened(convexStore(ctx), await identityOf(ctx), args)),
});

/**
 * The browser extension's project lookup: projects whose address lists match
 * the page's origin, among those the signed-in person can reach.
 */
export const findForOrigin = query({
  args: { origin: v.string() },
  handler: async (ctx, args) => run(async () => findProjectsForOrigin(convexStore(ctx), await identityOf(ctx), args)),
});
