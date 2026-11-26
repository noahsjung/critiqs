import { claimAddressCheck as claimAddressCheckOp, saveAboutYou as saveAboutYouOp } from "@critiqs/server";
import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";

// Onboarding on the Critiqs website. The address check fetches in
// `addressCheck:check`, a Node action; each check is counted here first.

/** Requires sign-in and counts one address check against the hourly limits. */
export const claimAddressCheck = internalMutation({
  args: {},
  handler: async (ctx) => run(async () => claimAddressCheckOp(convexStore(ctx), await identityOf(ctx), Date.now())),
});

/** Saves the signed-in person's "About you" answers. Unknown values are dropped; a skipped answer changes nothing. */
export const saveAboutYou = mutation({
  args: { role: v.optional(v.string()), teamSize: v.optional(v.string()) },
  handler: async (ctx, args) => run(async () => saveAboutYouOp(convexStore(ctx), await identityOf(ctx), args)),
});
