import type { ExportPageLoader, TrackerId } from "@critiqs/core";
import { type AccessSteps, type JiraPrivacyAccess, type TicketsDeployment, type TokenRead, type TokenUse, type TrackerToken, ticketsDeploymentFromEnv, trackerAccessToken, trackerAdapter, trackerPrivacyAccess, trackerRemovalAccess, trackerSignIn, type WebhookRemoval } from "@critiqs/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { randomSecret } from "./tokens";

/** This deployment's tickets setup, from its environment: the key that encrypts tracker tokens, and the operator's tracker apps. */
export function ticketsDeployment(): TicketsDeployment {
  return ticketsDeploymentFromEnv(process.env);
}

/** This deployment's own HTTP address, which trackers send people back to after signing in. */
export function siteUrl(): string {
  const site = process.env.CONVEX_SITE_URL;
  if (site === undefined || site === "") throw new Error("CONVEX_SITE_URL is not set.");
  return site.replace(/\/$/, "");
}

/**
 * A person's working token for a tracker, refreshed first when their sign-in's
 * has expired, one refresh at a time; only while they are still connected as
 * the tracker account `accountId`, and only as `use` says: in that person's
 * own request (`person`, the default), or for a job in projects they may
 * still review (`job`). The step that reads the token checks `use` first, so
 * every caller, a scheduled job above all, checks before it holds the token.
 * A token read only to remove what Critiqs registered is never returned:
 * `trackerRemoval` holds it.
 */
export async function trackerToken(ctx: ActionCtx, person: { userId: string; accountId: string }, tracker: TrackerId, use: TokenRead = { by: "person" }): Promise<TrackerToken> {
  // Checked here too, for callers the types don't reach.
  const by = (use as TokenUse).by;
  if (by === "cleanup") throw new Error("A token read only to remove what Critiqs registered is held by trackerRemoval, never returned.");
  if (by === "privacy") throw new Error("A token read only for personal data reporting is held by jiraPrivacy, never returned.");
  return await trackerAccessToken(accessSteps(ctx, person, tracker), ticketsDeployment(), { ...person, tracker, use });
}

/**
 * A person's token for a tracker, read only to remove webhooks Critiqs
 * registered there (`cleanup`), as a `WebhookRemoval`, which can do that and
 * nothing else: the token never leaves it.
 */
export async function trackerRemoval(ctx: ActionCtx, person: { userId: string; accountId: string }, tracker: TrackerId): Promise<WebhookRemoval> {
  const webhooks = trackerAdapter(tracker, ticketsDeployment()).webhooks;
  if (webhooks === undefined) throw new Error(`${tracker} has no webhooks for Critiqs to remove.`);
  return await trackerRemovalAccess(accessSteps(ctx, person, tracker), ticketsDeployment(), { ...person, tracker }, webhooks);
}

/**
 * A person's Jira OAuth token, read only for Atlassian's Personal Data
 * Reporting API (`privacy`), as a `JiraPrivacyAccess` that never reveals the
 * token.
 */
export async function jiraPrivacy(ctx: ActionCtx, person: { userId: string; accountId: string }, forceRefresh = false): Promise<JiraPrivacyAccess> {
  return await trackerPrivacyAccess(accessSteps(ctx, person, "jira"), ticketsDeployment(), { ...person, forceRefresh });
}

/** The store steps of reading a person's token: the reader passes its use, which `claimRefresh` checks as it reads the account. */
function accessSteps(ctx: ActionCtx, person: { userId: string; accountId: string }, tracker: TrackerId): AccessSteps {
  const { userId, accountId } = person;
  return {
    claim: (leaseId, use, forceRefresh) =>
      ctx.runMutation(internal.trackers.claimRefresh, {
        userId,
        tracker,
        accountId,
        leaseId,
        use,
        ...(forceRefresh === undefined ? {} : { forceRefresh }),
      }),
    finish: (leaseId, tokens) => ctx.runMutation(internal.trackers.finishRefresh, { userId, tracker, leaseId, tokens }),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    leaseId: () => randomSecret(16),
  };
}

/** A thread's export pages for a draft: the same pages, and access checks, as the Markdown export. */
export function exportPages(ctx: ActionCtx): ExportPageLoader {
  return ({ projectId, threadIds, threadIndex, paginationOpts }) =>
    ctx.runQuery(api.threads.exportThreads, { projectId: projectId as Id<"projects">, threadIds: threadIds as Id<"threads">[], threadIndex, paginationOpts });
}

/** For a sign-in that ends every token of its tracker account (GitHub's grant): may it be ended now? Read fresh each time. */
export function mayEnd(ctx: ActionCtx, account: { userId: string; tracker: TrackerId; accountId?: string }): () => Promise<boolean> {
  return async () =>
    trackerSignIn(account.tracker, ticketsDeployment())?.endsEveryToken !== true ||
    !(await ctx.runQuery(internal.trackers.grantInUse, { userId: account.userId, tracker: account.tracker, ...(account.accountId === undefined ? {} : { accountId: account.accountId }) }));
}
