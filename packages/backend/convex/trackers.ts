import type { TrackerAccountView, TrackerDisconnected, TrackerSignInStart } from "@critiqs/core";
import {
  claimTokenRefresh,
  claimTrackerSignIn,
  dropTrackerSignIn,
  openTrackerSignIn,
  connectTrackerWithToken,
  type DisconnectedAccount,
  disconnectTracker,
  endTrackerAccount,
  finishTokenRefresh,
  listTrackerAccounts,
  requireTrackerPerson,
  saveOwnTrackerAccount,
  saveSignedInAccount,
  setTrackerAttribution,
  startTrackerSignIn,
  type TrackerToken,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import { storedTokenValidator, tokenUseValidator, trackerValidator } from "./lib/validators";
import { convexStore, identityOf, run } from "./lib/store";
import { siteUrl, ticketsDeployment, trackerToken } from "./lib/tickets";
import { hashSecret, randomSecret } from "./lib/tokens";

// Each person's own tracker accounts ("Your trackers"), for that person only.
// Calls to trackers run in actions, in Convex's default runtime; every read
// and write is its own transaction that checks who is asking again. Tokens are
// encrypted in the action before they reach a mutation, and never returned.
// Tracker sign-in's return trip is in trackerHttp.ts.

const sealedAccount = v.object({
  tracker: trackerValidator,
  method: v.union(v.literal("oauth"), v.literal("token")),
  identity: v.object({ accountId: v.string(), accountName: v.string(), emails: v.array(v.string()), site: v.union(v.object({ id: v.string(), name: v.string() }), v.null()) }),
  access: storedTokenValidator,
  refresh: v.union(storedTokenValidator, v.null()),
  expiresAt: v.union(v.number(), v.null()),
});

/** The signed-in person's tracker accounts: never a token. */
export const mine = query({
  args: {},
  handler: async (ctx) => run(async () => listTrackerAccounts(convexStore(ctx), await identityOf(ctx))),
});

const disconnectedAccount = v.object({
  userId: v.string(),
  tracker: trackerValidator,
  method: v.union(v.literal("oauth"), v.literal("token")),
  access: storedTokenValidator,
  refresh: v.union(storedTokenValidator, v.null()),
});

/** When a sign-in that couldn't be ended at its tracker is tried again, after each failed try: a minute, ten minutes, an hour. */
const END_RETRY_MS = [60_000, 10 * 60_000, 60 * 60_000];

/**
 * Removes the signed-in person's account for a tracker, and its tokens, and
 * cancels their sign-ins to it under way; then ends its sign-in at the
 * tracker where it can, and says whether it did (`TrackerDisconnected`), so
 * the person knows when the tracker couldn't be told. A sign-in that couldn't
 * be ended is tried again in the background for about an hour: the retry is
 * scheduled in the step that removes the account, so a disconnect that stops
 * before it reaches the tracker is still tried again, and cancelled once the
 * first try works.
 */
export const disconnect = action({
  args: { tracker: trackerValidator },
  handler: async (ctx, args): Promise<TrackerDisconnected> =>
    run(async () => {
      const removed = await ctx.runMutation(internal.trackers.removeAccount, args);
      if (removed === null) return "none";
      // Still sealed until here: only an action decrypts them, to end them at the tracker.
      const outcome = await endTrackerAccount(ticketsDeployment(), removed.account);
      if (outcome !== "failed") await ctx.scheduler.cancel(removed.retry);
      return outcome;
    }),
});

/** Removes the person's account (`disconnectTracker`) and, in the same transaction, schedules the first retry of ending it at the tracker. */
export const removeAccount = internalMutation({
  args: { tracker: trackerValidator },
  handler: async (ctx, args): Promise<{ account: DisconnectedAccount; retry: Id<"_scheduled_functions"> } | null> =>
    run(async () => {
      const account = await disconnectTracker(convexStore(ctx), await identityOf(ctx), args);
      if (account === null) return null;
      const retry = await ctx.scheduler.runAfter(END_RETRY_MS[0]!, internal.trackers.endAccount, { account, attempt: 1 });
      return { account, retry };
    }),
});

/** Tries again to end a disconnected account's sign-in at its tracker (`endTrackerAccount`), as `disconnect` couldn't. */
export const endAccount = internalAction({
  args: { account: disconnectedAccount, attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<string> => {
    const outcome = await endTrackerAccount(ticketsDeployment(), args.account);
    // The try after `attempt` waits END_RETRY_MS[attempt]; past the last, it is left to the person.
    const attempt = args.attempt ?? 1;
    const next = END_RETRY_MS[attempt];
    if (outcome === "failed" && next !== undefined) await ctx.scheduler.runAfter(next, internal.trackers.endAccount, { account: args.account, attempt: attempt + 1 });
    return outcome;
  },
});

/** Sets whether the person's new tickets in a tracker say they came from Critiqs, by default. */
export const setAttribution = mutation({
  args: { tracker: trackerValidator, attribution: v.boolean() },
  handler: async (ctx, args) => run(async () => setTrackerAttribution(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

/** Connects a tracker with a personal token the person pasted, after the tracker confirms whose it is. */
export const connectWithToken = action({
  args: { tracker: trackerValidator, token: v.string() },
  handler: async (ctx, args): Promise<TrackerAccountView> =>
    run(() =>
      connectTrackerWithToken(
        {
          requirePerson: () => ctx.runMutation(internal.trackers.requirePerson, { tracker: args.tracker }),
          save: (userId, account) => ctx.runMutation(internal.trackers.saveOwn, { userId, account }),
        },
        ticketsDeployment(),
        args,
      ),
    ),
});

/**
 * Starts a tracker sign-in for the signed-in person. Returns where the
 * interface's window posts the state and the binding secret; only this caller
 * ever gets the secret, and only its hash is stored.
 */
export const startSignIn = action({
  args: { tracker: trackerValidator },
  handler: async (ctx, args): Promise<TrackerSignInStart> =>
    run(async () => {
      // Secrets come from an action, whose randomness is not replayed.
      const state = randomSecret();
      const binding = randomSecret();
      await ctx.runMutation(internal.trackers.createSignIn, { tracker: args.tracker, state, verifier: randomSecret(), bindingHash: await hashSecret(binding) });
      return { url: `${siteUrl()}/trackers/${args.tracker}/start`, state, binding };
    }),
});

/** The signed-in person who is connecting a tracker, before their token is verified. */
export const requirePerson = internalMutation({
  args: { tracker: trackerValidator },
  handler: async (ctx, args) => run(async () => requireTrackerPerson(convexStore(ctx), await identityOf(ctx), ticketsDeployment(), args, Date.now())),
});

/** Stores the signed-in person's account, sealed for them in the action. */
export const saveOwn = internalMutation({
  args: { userId: v.string(), account: sealedAccount },
  handler: async (ctx, args) => run(async () => saveOwnTrackerAccount(convexStore(ctx), await identityOf(ctx), args, Date.now())),
});

export const createSignIn = internalMutation({
  args: { tracker: trackerValidator, state: v.string(), verifier: v.string(), bindingHash: v.string() },
  handler: async (ctx, args) => run(async () => startTrackerSignIn(convexStore(ctx), await identityOf(ctx), ticketsDeployment(), args, Date.now())),
});

/** Opens a started sign-in, once, for the window that brings its binding secret. */
export const openSignIn = internalMutation({
  args: { tracker: trackerValidator, state: v.string(), bindingHash: v.string() },
  handler: async (ctx, args) => await openTrackerSignIn(convexStore(ctx), args, Date.now()),
});

/** Ends a sign-in when the tracker sends the person back, whatever the outcome. */
export const claimSignIn = internalMutation({
  args: { tracker: trackerValidator, state: v.string(), bindingHash: v.string() },
  handler: async (ctx, args) => await claimTrackerSignIn(convexStore(ctx), args, Date.now()),
});

/** Ends a claimed sign-in that saved nothing. */
export const dropSignIn = internalMutation({
  args: { tracker: trackerValidator, state: v.string() },
  handler: async (ctx, args) => await dropTrackerSignIn(convexStore(ctx), args),
});

/** Stores the account of a finished sign-in for the person who started it, only when its email is theirs. */
export const saveSignedIn = internalMutation({
  args: { userId: v.string(), account: sealedAccount, state: v.string() },
  handler: async (ctx, args) => run(async () => saveSignedInAccount(convexStore(ctx), args, Date.now())),
});

/** Reads a person's token for a tracker, only as `use` allows, checked here before it is read (`claimTokenRefresh`). */
export const claimRefresh = internalMutation({
  args: { userId: v.string(), tracker: trackerValidator, accountId: v.string(), leaseId: v.string(), use: tokenUseValidator },
  handler: async (ctx, args) => await claimTokenRefresh(convexStore(ctx), args, Date.now(), await identityOf(ctx)),
});

export const finishRefresh = internalMutation({
  args: {
    userId: v.string(),
    tracker: trackerValidator,
    leaseId: v.string(),
    tokens: v.union(v.object({ access: storedTokenValidator, refresh: v.union(storedTokenValidator, v.null()), expiresAt: v.union(v.number(), v.null()) }), v.null()),
  },
  handler: async (ctx, args) => await finishTokenRefresh(convexStore(ctx), args, Date.now()),
});

/**
 * A person's working token for a tracker, refreshed first when their sign-in's
 * has expired (`trackerToken`), as a function for tests; actions call `trackerToken` directly.
 */
export const accessToken = internalAction({
  args: { userId: v.string(), accountId: v.string(), tracker: trackerValidator, use: tokenUseValidator },
  handler: async (ctx, args): Promise<TrackerToken> => run(() => trackerToken(ctx, args, args.tracker, args.use)),
});
