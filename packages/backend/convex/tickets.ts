import type { TicketDestination, TicketDraft, TicketLinkView, TicketSearchResult } from "@critiqs/core";
import {
  addTicketLinkBack,
  claimTicketCreation,
  claimTicketLink,
  createTicket,
  finishTicketCreation,
  finishTicketLink,
  IMAGE_TYPES,
  imageTypeOf,
  linkTicket,
  listTicketDestinations,
  prepareTicketDraft,
  prepareTicketLinkBack,
  releaseTicketHold,
  requireTicketCreator,
  requireTrackerAccount,
  saveTicketLinkBack,
  searchTickets,
  ticketDraft,
  unlinkTicket,
} from "@critiqs/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalMutation, mutation } from "./_generated/server";
import { r2Config, r2Storage } from "./lib/r2";
import { convexStore, identityOf, run } from "./lib/store";
import { ticketsDeployment, trackerToken } from "./lib/tickets";
import { ticketStatusValidator, trackerValidator } from "./lib/validators";

// Tickets linked to threads: drafting, creating, and linking tickets in the
// person's own tracker, and unlinking. Calls to trackers run in actions, in
// Convex's default runtime; every read and write is its own transaction that
// checks who is asking again. Thread answers carry the linked tickets
// (threads.ts).

const createdTicket = v.object({
  tracker: trackerValidator,
  externalId: v.string(),
  key: v.string(),
  url: v.string(),
  title: v.string(),
  status: ticketStatusValidator,
  site: v.union(v.string(), v.null()),
});
const hold = { linkId: v.string(), holder: v.string() };

/** Where the signed-in person can create tickets in a tracker, such as their Linear teams. */
export const destinations = action({
  args: { tracker: trackerValidator },
  handler: async (ctx, args): Promise<TicketDestination[]> => run(() => listTicketDestinations(trackerSteps(ctx, args.tracker), ticketsDeployment(), args)),
});

/** Tickets the signed-in person can see in their tracker, by key or words. */
export const search = action({
  args: { tracker: trackerValidator, query: v.string() },
  handler: async (ctx, args): Promise<TicketSearchResult[]> => run(() => searchTickets(trackerSteps(ctx, args.tracker), ticketsDeployment(), args)),
});

/** A new ticket's title and text from the thread, without AI, for the person to edit. */
export const draft = action({
  args: { threadId: v.id("threads"), tracker: trackerValidator },
  handler: async (ctx, args): Promise<TicketDraft> =>
    run(() =>
      ticketDraft(
        {
          prepare: () => ctx.runMutation(internal.tickets.prepareDraft, args),
          // The same pages, and access checks, as the Markdown export.
          loadPage: ({ projectId, threadIds, threadIndex, paginationOpts }) =>
            ctx.runQuery(api.threads.exportThreads, { projectId: projectId as Id<"projects">, threadIds: threadIds as Id<"threads">[], threadIndex, paginationOpts }),
        },
        args,
      ),
    ),
});

/** Creates a ticket from a thread in the signed-in person's tracker, as them, and links it to the thread. */
export const create = action({
  args: {
    threadId: v.id("threads"),
    submissionId: v.string(),
    tracker: trackerValidator,
    destinationId: v.string(),
    title: v.string(),
    body: v.string(),
    createdFromCritiqs: v.boolean(),
  },
  handler: async (ctx, args): Promise<TicketLinkView> =>
    run(() => {
      const { threadId, tracker } = args;
      return createTicket(
        {
          requireCreator: () => ctx.runMutation(internal.tickets.requireCreator, { threadId, tracker }),
          token: (creator) => trackerToken(ctx, creator, tracker),
          claim: (ids) => ctx.runMutation(internal.tickets.claimCreate, { threadId, tracker, ...ids }),
          finish: ({ linkId, holder }, ticket, linkBackAdded) => ctx.runMutation(internal.tickets.finishCreate, { linkId, holder, threadId, ticket, linkBackAdded }),
          release: async ({ linkId, holder }, end) => void (await ctx.runMutation(internal.tickets.release, { linkId, holder, end })),
          capture: (fileId) => readCapture(ctx, fileId),
          now: () => Date.now(),
          // Random here, in the action; a mutation's randomness is replayed.
          newId: () => crypto.randomUUID(),
        },
        ticketsDeployment(),
        args,
      );
    }),
});

/** Adds the link back to the thread that the tracker didn't add when the signed-in person created the ticket. */
export const addLinkBack = action({
  args: { linkId: v.string() },
  handler: async (ctx, args): Promise<TicketLinkView> =>
    run(() =>
      addTicketLinkBack(
        {
          prepare: () => ctx.runMutation(internal.tickets.prepareLinkBack, args),
          token: (person, tracker) => trackerToken(ctx, person, tracker),
          save: () => ctx.runMutation(internal.tickets.saveLinkBack, args),
        },
        ticketsDeployment(),
      ),
    ),
});

/** Links a thread to a ticket the signed-in person can see in their tracker. */
export const link = action({
  args: { threadId: v.id("threads"), tracker: trackerValidator, externalId: v.string(), comment: v.boolean() },
  handler: async (ctx, args): Promise<TicketLinkView> =>
    run(() =>
      linkTicket(
        {
          claim: (holder) => ctx.runMutation(internal.tickets.claimLink, { threadId: args.threadId, tracker: args.tracker, externalId: args.externalId, holder }),
          token: (person) => trackerToken(ctx, person, args.tracker),
          finish: ({ linkId, holder }, ticket) => ctx.runMutation(internal.tickets.finishLink, { linkId, holder, threadId: args.threadId, ticket }),
          release: async ({ linkId, holder }, end) => void (await ctx.runMutation(internal.tickets.release, { linkId, holder, end })),
          now: () => Date.now(),
          // Random here, in the action; a mutation's randomness is replayed.
          newId: () => crypto.randomUUID(),
        },
        ticketsDeployment(),
        args,
      ),
    ),
});

/** Removes a ticket's link from its thread, in Critiqs only. */
export const unlink = mutation({
  args: { linkId: v.string() },
  handler: async (ctx, args) => run(async () => unlinkTicket(convexStore(ctx), await identityOf(ctx), args)),
});

export const requireAccount = internalMutation({
  args: { tracker: trackerValidator },
  handler: async (ctx, args) => run(async () => requireTrackerAccount(convexStore(ctx), await identityOf(ctx), args)),
});

export const prepareDraft = internalMutation({
  args: { threadId: v.id("threads"), tracker: trackerValidator },
  handler: async (ctx, args) => run(async () => prepareTicketDraft(convexStore(ctx), await identityOf(ctx), args)),
});

export const requireCreator = internalMutation({
  args: { threadId: v.id("threads"), tracker: trackerValidator },
  handler: async (ctx, args) => run(async () => requireTicketCreator(convexStore(ctx), await identityOf(ctx), args)),
});

export const claimCreate = internalMutation({
  args: { threadId: v.id("threads"), tracker: trackerValidator, creationId: v.string(), holder: v.string(), accountId: v.string() },
  handler: async (ctx, args) => run(async () => claimTicketCreation(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

export const finishCreate = internalMutation({
  args: { ...hold, threadId: v.id("threads"), ticket: createdTicket, linkBackAdded: v.boolean() },
  handler: async (ctx, args) => run(async () => finishTicketCreation(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

export const release = internalMutation({
  args: { ...hold, end: v.union(v.literal("nothing"), v.literal("unknown"), v.literal("parked")) },
  handler: async (ctx, args) => run(async () => releaseTicketHold(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

export const prepareLinkBack = internalMutation({
  args: { linkId: v.string() },
  handler: async (ctx, args) => run(async () => prepareTicketLinkBack(convexStore(ctx), await identityOf(ctx), args)),
});

export const saveLinkBack = internalMutation({
  args: { linkId: v.string() },
  handler: async (ctx, args) => run(async () => saveTicketLinkBack(convexStore(ctx), await identityOf(ctx), args)),
});

export const claimLink = internalMutation({
  args: { threadId: v.id("threads"), tracker: trackerValidator, externalId: v.string(), holder: v.string() },
  handler: async (ctx, args) => run(async () => claimTicketLink(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

export const finishLink = internalMutation({
  args: { ...hold, threadId: v.id("threads"), ticket: createdTicket },
  handler: async (ctx, args) => run(async () => finishTicketLink(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

function trackerSteps(ctx: ActionCtx, tracker: "linear" | "github" | "jira") {
  return {
    requirePerson: () => ctx.runMutation(internal.tickets.requireAccount, { tracker }),
    token: (person: { userId: string; accountId: string }) => trackerToken(ctx, person, tracker),
  };
}

/** A thread's capture, from R2 or Convex storage, as an image; null when it can't be read or isn't one. */
async function readCapture(ctx: ActionCtx, fileId: string): Promise<{ data: Blob; contentType: string } | null> {
  const location = await ctx.runQuery(internal.captures.fileLocation, { fileId: fileId as Id<"_storage"> | Id<"captureFiles"> });
  let data: Blob | null;
  let declared: string | undefined;
  if (location !== null) {
    if (location.status !== "attached") return null;
    const response = await r2Storage(r2Config()).get(location);
    data = response === null ? null : await response.blob();
    declared = location.contentType;
  } else {
    data = await ctx.storage.get(fileId as Id<"_storage">);
    declared = data?.type;
  }
  if (data === null) return null;
  // Only an image goes into a ticket: its declared type, else what its first bytes say.
  const type = declared !== undefined && IMAGE_TYPES.includes(declared) ? declared : imageTypeOf(new Uint8Array(await data.slice(0, 16).arrayBuffer()));
  return type === null ? null : { data: new Blob([data], { type }), contentType: type };
}
