import type { ExportPageLoader, TrackerId } from "@critiqs/core";
import { type TicketsDeployment, type TrackerToken, ticketsDeploymentFromEnv, trackerAccessToken } from "@critiqs/server";
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
 * the tracker account `accountId`. For actions that call the tracker as that
 * person, after they have checked who is asking and which account they use.
 */
export async function trackerToken(ctx: ActionCtx, person: { userId: string; accountId: string }, tracker: TrackerId): Promise<TrackerToken> {
  const { userId, accountId } = person;
  return await trackerAccessToken(
    {
      claim: (leaseId) => ctx.runMutation(internal.trackers.claimRefresh, { userId, tracker, accountId, leaseId }),
      finish: (leaseId, tokens) => ctx.runMutation(internal.trackers.finishRefresh, { userId, tracker, leaseId, tokens }),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => Date.now(),
      leaseId: () => randomSecret(16),
    },
    ticketsDeployment(),
    { userId, tracker, accountId },
  );
}

/** A thread's export pages for a draft: the same pages, and access checks, as the Markdown export. */
export function exportPages(ctx: ActionCtx): ExportPageLoader {
  return ({ projectId, threadIds, threadIndex, paginationOpts }) =>
    ctx.runQuery(api.threads.exportThreads, { projectId: projectId as Id<"projects">, threadIds: threadIds as Id<"threads">[], threadIndex, paginationOpts });
}
