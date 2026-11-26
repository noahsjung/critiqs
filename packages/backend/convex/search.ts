import { authorizeSearch, finalizeSearch, prepareSearch, retrieveSearch } from "@critiqs/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { deployment } from "./lib/ai";
import { convexStore, identityOf, run } from "./lib/store";

// The steps of a search, each its own transaction, run by the `ai.search`
// action with the model called between them. Each checks the reviewer's
// access again.

const scope = v.object({ status: v.union(v.literal("open"), v.literal("resolved"), v.literal("all")), screen: v.union(v.string(), v.null()) });

export const prepare = internalMutation({
  args: { projectId: v.string(), question: v.string(), scope },
  handler: async (ctx, args) => run(async () => prepareSearch(convexStore(ctx), await identityOf(ctx), args, deployment(), Date.now())),
});

/** Checks access again right before each request to the model (see `authorizeSearch`). */
export const authorize = internalQuery({
  args: { projectId: v.string() },
  handler: async (ctx, args) => run(async () => authorizeSearch(convexStore(ctx), await identityOf(ctx), args)),
});

export const retrieve = internalQuery({
  args: { projectId: v.string(), query: v.any(), groups: v.any() },
  handler: async (ctx, args) => run(async () => retrieveSearch(convexStore(ctx), await identityOf(ctx), args)),
});

export const finalize = internalQuery({
  args: { projectId: v.string(), response: v.any() },
  handler: async (ctx, args) => run(async () => finalizeSearch(convexStore(ctx), await identityOf(ctx), args)),
});
