import { claimAddressCheck as claimAddressCheckOp } from "@critiqs/server";
import { internalMutation } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";

// Onboarding on the Critiqs website. The address check fetches in
// `addressCheck:check`, a Node action; each check is counted here first.

/** Requires sign-in and counts one address check against the hourly limits. */
export const claimAddressCheck = internalMutation({
  args: {},
  handler: async (ctx) => run(async () => claimAddressCheckOp(convexStore(ctx), await identityOf(ctx), Date.now())),
});
