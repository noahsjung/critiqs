import {
  applyJiraWebhook,
  claimWebhookRenewal,
  claimWebhookUpdate,
  finishWebhookRenewal,
  followTicketScope,
  renewTicketWebhook,
  saveWebhookUpdate,
  type TrackerSite,
  type WebhookClaim,
  type WebhookRenewal,
  webhooksToRenew,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { convexStore } from "./lib/store";
import { siteUrl, ticketsDeployment, trackerToken } from "./lib/tickets";
import { randomSecret } from "./lib/tokens";
import { ticketStatusValidator, trackerValidator } from "./lib/validators";

// Status webhooks that people's sign-ins register with Jira, which sends
// webhooks only to those its users register and expires them after 30 days
// (packages/server/src/tickets/webhooks.ts). Linking or creating a ticket
// has the linker's webhook on that site follow its project; a daily job
// renews each a week before it expires; deliveries arrive at
// /trackers/jira/webhook (trackerHttp.ts).

const site = v.object({ id: v.string(), name: v.string() });
const person = { userId: v.string(), accountId: v.string(), tracker: trackerValidator };

/** Where Jira sends a tracker's webhooks on this deployment. */
const webhookUrl = (tracker: string) => `${siteUrl()}/trackers/${tracker}/webhook`;

/** Has the person's webhook on the ticket's site follow its scope (a Jira project). */
export const follow = internalAction({
  args: { ...person, scope: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const { userId, accountId, tracker, scope } = args;
    return await followTicketScope(
      {
        token: () => trackerToken(ctx, { userId, accountId }, tracker),
        claim: (on: TrackerSite, leaseId: string): Promise<WebhookClaim> => ctx.runMutation(internal.trackerWebhooks.claim, { userId, accountId, tracker, site: on, scope, leaseId }),
        save: (siteId, leaseId, hook): Promise<boolean> => ctx.runMutation(internal.trackerWebhooks.save, { userId, accountId, tracker, siteId, leaseId, hook }),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        leaseId: () => randomSecret(16),
        url: webhookUrl(tracker),
      },
      ticketsDeployment(),
      { tracker, scope },
    );
  },
});

export const claim = internalMutation({
  args: { ...person, site, scope: v.string(), leaseId: v.string() },
  handler: async (ctx, args): Promise<WebhookClaim> => await claimWebhookUpdate(convexStore(ctx), args, Date.now()),
});

export const save = internalMutation({
  args: { ...person, siteId: v.string(), leaseId: v.string(), hook: v.union(v.object({ hookId: v.string(), scopes: v.array(v.string()), expiresAt: v.number() }), v.null()) },
  handler: async (ctx, args): Promise<boolean> => await saveWebhookUpdate(convexStore(ctx), args, Date.now()),
});

/** Schedules a renewal of each webhook that expires within a week. Runs daily. */
export const renewDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const due = await webhooksToRenew(convexStore(ctx), Date.now());
    for (const webhookId of due) await ctx.scheduler.runAfter(0, internal.trackerWebhooks.renew, { webhookId });
    return due.length;
  },
});

/** Renews one webhook with its person's token. */
export const renew = internalAction({
  args: { webhookId: v.string() },
  handler: async (ctx, args): Promise<string> =>
    await renewTicketWebhook(
      {
        claim: (leaseId): Promise<WebhookRenewal> => ctx.runMutation(internal.trackerWebhooks.claimRenewal, { ...args, leaseId }),
        token: (who, tracker) => trackerToken(ctx, who, tracker),
        finish: async (leaseId, result) => void (await ctx.runMutation(internal.trackerWebhooks.finishRenewal, { ...args, leaseId, result })),
        leaseId: () => randomSecret(16),
        url: webhookUrl("jira"),
      },
      ticketsDeployment(),
    ),
});

export const claimRenewal = internalMutation({
  args: { webhookId: v.string(), leaseId: v.string() },
  handler: async (ctx, args): Promise<WebhookRenewal> => await claimWebhookRenewal(convexStore(ctx), args, Date.now()),
});

export const finishRenewal = internalMutation({
  args: {
    webhookId: v.string(),
    leaseId: v.string(),
    result: v.union(v.object({ hookId: v.string(), expiresAt: v.number() }), v.literal("gone"), v.literal("failed")),
  },
  handler: async (ctx, args): Promise<void> => await finishWebhookRenewal(convexStore(ctx), args, Date.now()),
});

/** Saves a Jira webhook's issue status on every thread linking the issue on the site the delivery came from. */
export const applyJira = internalMutation({
  args: {
    delivery: v.object({
      status: v.literal("update"),
      webhookIds: v.array(v.string()),
      self: v.union(v.object({ host: v.string(), cloudId: v.union(v.string(), v.null()) }), v.null()),
      issueId: v.string(),
      reading: v.object({ status: ticketStatusValidator, asOf: v.number() }),
      deleted: v.boolean(),
    }),
  },
  handler: async (ctx, args): Promise<{ updated: number; resolved: string[] }> => await applyJiraWebhook(convexStore(ctx), args.delivery, Date.now()),
});
