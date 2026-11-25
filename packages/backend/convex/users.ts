import { operations } from "@critiqs/server";
import { mutation } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";

/**
 * Updates this deployment's record of the signed-in reviewer from their token,
 * so a changed display name shows on their existing comments straight away,
 * and joins the organizations that invited their address. Returns the name now
 * stored.
 */
export const sync = mutation({
  args: {},
  handler: async (ctx): Promise<string> => run(async () => operations.syncReviewer(convexStore(ctx), await identityOf(ctx))),
});
