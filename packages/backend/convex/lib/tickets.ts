import type { TrackerId } from "@critiqs/core";
import { type TicketsDeployment, type TrackerToken, ticketsDeploymentFromEnv, trackerAccessToken } from "@critiqs/server";
import { internal } from "../_generated/api";
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
 * has expired, one refresh at a time. For actions that call the tracker as
 * that person, after they have checked who is asking.
 */
export async function trackerToken(ctx: ActionCtx, userId: string, tracker: TrackerId): Promise<TrackerToken> {
  return await trackerAccessToken(
    {
      claim: (leaseId) => ctx.runMutation(internal.trackers.claimRefresh, { userId, tracker, leaseId }),
      finish: (leaseId, tokens) => ctx.runMutation(internal.trackers.finishRefresh, { userId, tracker, leaseId, tokens }),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => Date.now(),
      leaseId: () => randomSecret(16),
    },
    ticketsDeployment(),
    { userId, tracker },
  );
}
