import { assignPlan, DEFAULT_PLANS, setExtraStorage as setExtraStorageOp } from "@critiqs/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { convexStore } from "./lib/store";

// Critiqs Cloud's plans are configuration. Change one without a deploy:
//   npx convex run plans:set '{"name":"free","label":"Free","limits":[...]}'
// A configured plan replaces the built-in plan of the same name. A plan
// belongs to an organization and covers every project it owns; move an
// organization, named or found by one of its projects, to another plan with:
//   npx convex run plans:assign '{"organizationId":"...","plan":"plus"}'
// Organizations on the former "team" plan have "plus" unless "team" is configured.
// Record an organization's storage add-ons (100 GB each on Pro):
//   npx convex run plans:setExtraStorage '{"organizationId":"...","units":2}'

const limitValidator = v.object({
  metric: v.union(
    v.literal("projects"),
    v.literal("threads"),
    v.literal("messages"),
    v.literal("reviewers"),
    v.literal("captureBytes"),
    v.literal("mentionEmails"),
    v.literal("aiRequests"),
    v.literal("personalAiRequests"),
    v.literal("aiCredits"),
  ),
  period: v.union(v.literal("total"), v.literal("month"), v.literal("day")),
  max: v.number(),
  overage: v.optional(v.object({ defaultCap: v.number() })),
  addOn: v.optional(v.object({ size: v.number() })),
});

export const set = internalMutation({
  args: { name: v.string(), label: v.string(), limits: v.array(limitValidator) },
  handler: async (ctx, plan) => {
    const existing = await ctx.db.query("plans").withIndex("by_name", (q) => q.eq("name", plan.name)).unique();
    if (existing === null) await ctx.db.insert("plans", plan);
    else await ctx.db.replace(existing._id, plan);
  },
});

/** Every plan in effect: configured ones, and built-in ones not replaced. */
export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configured = await ctx.db.query("plans").collect();
    const names = new Set(configured.map((plan) => plan.name));
    return [
      ...configured.map(({ name, label, limits }) => ({ name, label, limits, source: "configured" as const })),
      ...Object.values(DEFAULT_PLANS)
        .filter((plan) => !names.has(plan.name))
        .map((plan) => ({ ...plan, source: "built-in" as const })),
    ];
  },
});

/** Moves an organization to another plan, such as after an upgrade: given directly, or as the organization of one of its projects. */
export const assign = internalMutation({
  args: { organizationId: v.optional(v.id("organizations")), projectId: v.optional(v.id("projects")), plan: v.string() },
  handler: async (ctx, args) => await assignPlan(convexStore(ctx), args, Date.now()),
});

/** Sets how many storage add-ons an organization has; they raise its image storage where its plan offers them. */
export const setExtraStorage = internalMutation({
  args: { organizationId: v.id("organizations"), units: v.number() },
  handler: async (ctx, args) => await setExtraStorageOp(convexStore(ctx), args),
});
