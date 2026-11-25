import {
  applyAiSettings,
  applyPersonalAiSettings,
  getAiChoice,
  getAiSettings,
  getPersonalAiSettings,
  getPersonalAiUsage,
  prepareModelList as prepareModelListOp,
  preparePersonalModelList as preparePersonalModelListOp,
  preparePersonalTest as preparePersonalTestOp,
  prepareTest as prepareTestOp,
  recordPersonalTest as recordPersonalTestOp,
  recordTest as recordTestOp,
  removePersonalAiSettings,
  requirePersonalAiOwner,
  reserveCredits,
  settleCredits,
} from "@critiqs/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { deployment } from "./lib/ai";
import { convexStore, identityOf, run } from "./lib/store";

// A project's AI settings, for its owner only, and each person's own AI
// settings, for that person only. Keys are encrypted in the `ai` actions
// before they reach these functions, and never returned.

/** The project's AI settings as its owner sees them: never a key, only a hint. */
export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => getAiSettings(convexStore(ctx), await identityOf(ctx), args, deployment())),
});

/** Refuses anyone but the owner, before a key is even encrypted. */
export const requireOwner = internalQuery({
  args: { projectId: v.string() },
  handler: async (ctx, args) => run(async () => void (await getAiSettings(convexStore(ctx), await identityOf(ctx), args, deployment()))),
});

/** Stores settings already checked, with any key already sealed. */
export const apply = internalMutation({
  args: { projectId: v.string(), prepared: v.any() },
  handler: async (ctx, args) =>
    run(async () => applyAiSettings(convexStore(ctx), await identityOf(ctx), args, deployment(), Date.now())),
});

export const prepareTest = internalMutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => run(async () => prepareTestOp(convexStore(ctx), await identityOf(ctx), args, deployment(), Date.now())),
});

const payer = v.union(v.literal("project"), v.literal("person"));

/** Holds a Critiqs AI request's worst-case credits before its model is asked, or says why it can't start. */
export const reserve = internalMutation({
  args: { payer, ownerId: v.string(), credits: v.number() },
  handler: async (ctx, { credits, ...who }) => await reserveCredits(convexStore(ctx), who, credits, Date.now()),
});

/** Releases a request's hold and counts what it really cost. */
export const settle = internalMutation({
  args: { hold: v.union(v.string(), v.null()), charge: v.union(v.object({ payer, ownerId: v.string(), credits: v.number() }), v.null()) },
  handler: async (ctx, { hold, charge }) => await settleCredits(convexStore(ctx), hold, charge, Date.now()),
});

export const recordTest = internalMutation({
  args: { projectId: v.string(), epoch: v.number(), result: v.any() },
  handler: async (ctx, args) => await recordTestOp(convexStore(ctx), args, Date.now()),
});

// ---------------------------------------------------------------------------
// The signed-in person's own AI settings ("Your AI")

/** The signed-in person's own AI settings: never a key, only a hint. */
export const getPersonal = query({
  args: {},
  handler: async (ctx) => run(async () => getPersonalAiSettings(convexStore(ctx), await identityOf(ctx), deployment())),
});

/** The signed-in person's own Critiqs AI credits against their plan; null without plans. */
export const myUsage = query({
  // The UTC day comes from the client, so the result changes when the day does.
  args: { day: v.string() },
  handler: async (ctx, args) => run(async () => getPersonalAiUsage(convexStore(ctx), await identityOf(ctx), args)),
});

/** Removes the signed-in person's own settings and key. */
export const removePersonal = mutation({
  args: {},
  handler: async (ctx) => run(async () => removePersonalAiSettings(convexStore(ctx), await identityOf(ctx), deployment())),
});

/** The signed-in person's ID, which their own key is bound to, before it is encrypted. */
export const requirePerson = internalMutation({
  args: {},
  handler: async (ctx) => run(async () => requirePersonalAiOwner(convexStore(ctx), await identityOf(ctx))),
});

/** Stores the person's own settings, already checked, with any key already sealed for them. */
export const applyPersonal = internalMutation({
  args: { prepared: v.any() },
  handler: async (ctx, args) => run(async () => applyPersonalAiSettings(convexStore(ctx), await identityOf(ctx), args, deployment(), Date.now())),
});

export const preparePersonalTest = internalMutation({
  args: {},
  handler: async (ctx) => run(async () => preparePersonalTestOp(convexStore(ctx), await identityOf(ctx), Date.now())),
});

export const recordPersonalTest = internalMutation({
  args: { userId: v.string(), epoch: v.number(), result: v.any() },
  handler: async (ctx, args) => await recordPersonalTestOp(convexStore(ctx), args, Date.now()),
});

// ---------------------------------------------------------------------------
// Model lists, and the model choice a person's requests have

/** The owner's settings before listing their provider's models, counted against their per-minute limit. */
export const prepareModelList = internalMutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => run(async () => prepareModelListOp(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

/** The person's own settings before listing their provider's models, under the same limit. */
export const preparePersonalModelList = internalMutation({
  args: {},
  handler: async (ctx) => run(async () => preparePersonalModelListOp(convexStore(ctx), await identityOf(ctx), Date.now())),
});

/** Which connection the signed-in person's requests in the project use, and the models they may choose among: never a key or an address. */
export const myChoice = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => run(async () => getAiChoice(convexStore(ctx), await identityOf(ctx), args, deployment())),
});
