import { claimPlanAlerts, completePlanAlerts, planAlertEmails } from "@critiqs/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { convexStore } from "./lib/store";

// The steps of sending alert emails about organizations' Critiqs AI credits;
// `notificationEmails.deliverPlanAlerts` runs them.

export const claim = internalMutation({
  args: { claimToken: v.string(), limit: v.number() },
  handler: async (ctx, { claimToken, limit }) => await claimPlanAlerts(convexStore(ctx), Date.now(), limit, claimToken),
});

export const emails = internalQuery({
  args: { id: v.id("planAlerts"), claimToken: v.string() },
  handler: async (ctx, args) => await planAlertEmails(convexStore(ctx), args),
});

export const complete = internalMutation({
  args: {
    claimToken: v.string(),
    outcomes: v.array(
      v.object({ id: v.id("planAlerts"), result: v.union(v.literal("sent"), v.literal("skipped"), v.literal("failed")), reason: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, { claimToken, outcomes }) =>
    await completePlanAlerts(
      convexStore(ctx),
      outcomes.map((outcome) => ({ ...outcome, claimToken })),
      Date.now(),
    ),
});
