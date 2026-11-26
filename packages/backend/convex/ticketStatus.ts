import type { TicketSettingsView } from "@critiqs/core";
import type { StatusCheck, WebhookResult } from "@critiqs/server";
import { applyCheckedStatus, applyTicketStatus, catchUpResolveWhenDone, checkTicketStatus, claimStatusChecks, markStatusStale, prepareStatusCheck, setResolveWhenDone as saveResolveWhenDone, ticketSettings } from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { ticketsDeployment, trackerToken } from "./lib/tickets";
import { ticketStatusValidator, trackerValidator } from "./lib/validators";

// Tickets' status coming back from trackers: the check when someone opens a
// thread, scheduled as one action per link that reads the tracker with the
// linker's own token and saves on that link only; and webhooks
// (trackerHttp.ts), saved through `apply` on every link to the ticket.
// Resolve when done, a project setting, resolves threads as statuses arrive.

const statusFields = { status: ticketStatusValidator, asOf: v.union(v.number(), v.null()) };
/** What a check read: the status, and where the ticket is now, which the link follows when the ticket moved. */
const statusReading = v.object({
  ...statusFields,
  place: v.optional(v.object({ key: v.string(), url: v.string(), title: v.string(), site: v.optional(v.union(v.string(), v.null())) })),
});
const statusUpdate = v.object({
  ...statusFields,
  tracker: trackerValidator,
  externalId: v.string(),
  site: v.union(v.string(), v.null()),
  deleted: v.boolean(),
});

/**
 * Called when someone opens a thread: schedules a check of each linked ticket
 * whose status is more than a few minutes old, at most once every few minutes
 * per link. Returns how many checks it started.
 */
export const checkStatus = mutation({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<number> =>
    run(async () => {
      const linkIds = await claimStatusChecks(convexStore(ctx), await identityOf(ctx), args, Date.now());
      for (const linkId of linkIds) await ctx.scheduler.runAfter(0, internal.ticketStatus.check, { linkId });
      return linkIds.length;
    }),
});

/** Checks one linked ticket's status in its tracker as the person who linked it. */
export const check = internalAction({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<string> =>
    await checkTicketStatus(
      {
        prepare: (): Promise<StatusCheck> => ctx.runMutation(internal.ticketStatus.prepare, args),
        token: (person, tracker, use) => trackerToken(ctx, person, tracker, use),
        save: (reading): Promise<unknown> => ctx.runMutation(internal.ticketStatus.saveCheck, { ...args, reading }),
        stale: async (startedAt) => void (await ctx.runMutation(internal.ticketStatus.stale, { ...args, startedAt })),
      },
      ticketsDeployment(),
    ),
});

export const prepare = internalMutation({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<StatusCheck> => await prepareStatusCheck(convexStore(ctx), args, Date.now()),
});

export const stale = internalMutation({
  args: { linkId: v.string(), startedAt: v.number() },
  handler: async (ctx, args): Promise<void> => await markStatusStale(convexStore(ctx), args),
});

/** Saves a webhook's status on every thread that links the ticket, and resolves threads under Resolve when done. */
export const apply = internalMutation({
  args: { update: statusUpdate },
  handler: async (ctx, args): Promise<WebhookResult> => await applyTicketStatus(convexStore(ctx), args.update, Date.now()),
});

/** Saves what a check read on the checked link only, and resolves its thread under Resolve when done. */
export const saveCheck = internalMutation({
  args: { linkId: v.string(), reading: statusReading },
  handler: async (ctx, args): Promise<{ updated: number; resolved: string[] }> => await applyCheckedStatus(convexStore(ctx), args, Date.now()),
});

/** A project's ticket settings, for its owners. */
export const settings = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<TicketSettingsView> => run(async () => ticketSettings(convexStore(ctx), await identityOf(ctx), args)),
});

/** Turns Resolve when done on or off; project owners only. Turned on, it catches up the project's threads in steps (`catchUp`). */
export const setResolveWhenDone = mutation({
  args: { projectId: v.string(), on: v.boolean() },
  handler: async (ctx, args): Promise<TicketSettingsView> =>
    run(async () => {
      const now = Date.now();
      return await saveResolveWhenDone(convexStore(ctx), await identityOf(ctx), args, now, async (projectId) => {
        await ctx.scheduler.runAfter(0, internal.ticketStatus.catchUp, { projectId, since: now, cursor: null });
      });
    }),
});

/** One step of catching up the project's threads after Resolve when done was turned on; schedules the next. */
export const catchUp = internalMutation({
  args: { projectId: v.string(), since: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    const { cursor } = await catchUpResolveWhenDone(convexStore(ctx), args, Date.now());
    if (cursor !== null) await ctx.scheduler.runAfter(0, internal.ticketStatus.catchUp, { ...args, cursor });
  },
});
