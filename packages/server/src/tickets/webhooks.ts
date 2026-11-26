import type { TrackerId } from "@critiqs/core";
import { CritiqsError } from "../errors.ts";
import type { Store, TrackerWebhookRecord } from "../store.ts";
import { type TicketsDeployment, ticketStore, trackerAdapter, trackerSignIn } from "./accounts.ts";
import { applyTicketStatus } from "./status.ts";
import type { JiraWebhook } from "./trackers/jira.ts";
import { jiraId } from "./trackers/jira.ts";
import type { TrackerSite, TrackerToken } from "./trackers/index.ts";

// Status webhooks that people's sign-ins register, for trackers that send
// webhooks only to those their users register, and expire them (Jira:
// https://developer.atlassian.com/cloud/jira/platform/webhooks/). Each person
// has at most one per tracker and site, following the projects they linked
// or created tickets in there; linking a ticket in another project replaces
// it with one that follows that project too. A scheduled job renews each
// before it expires. Pasted tokens can't register webhooks: their tickets'
// status comes from the check when a thread opens.

/** How long one registration or renewal may hold a webhook before another may take over. */
export const WEBHOOK_LEASE_MS = 60_000;
/** How long before it expires a webhook is renewed. Jira's last 30 days. */
export const WEBHOOK_RENEW_MARGIN_MS = 7 * 24 * 60 * 60_000;
/** The most projects one webhook follows, so its filter stays short. */
export const MAX_WEBHOOK_SCOPES = 100;

type Webhooks = NonNullable<Store["tickets"]>["webhooks"];

function webhookStore(store: Store): Webhooks {
  return ticketStore(store).webhooks;
}

export type WebhookClaim =
  /** The person's webhook on the site follows the scope already, and isn't due for renewal. */
  | { status: "covered" }
  /** Another registration holds the person's webhook; try again shortly. */
  | { status: "busy" }
  /** This caller registers a webhook following `scopes`, replacing `previous` (the tracker's ID for the old one), if any. */
  | { status: "claimed"; scopes: string[]; previous: string | null };

/**
 * Takes the person's webhook on a site to make it follow `scope` too, under
 * `leaseId`, unless it does already. One transaction.
 */
export async function claimWebhookUpdate(
  store: Store,
  args: { userId: string; tracker: TrackerId; accountId: string; site: TrackerSite; scope: string; leaseId: string },
  now: number,
): Promise<WebhookClaim> {
  const webhooks = webhookStore(store);
  const existing = await webhooks.find(args.userId, args.tracker, args.site.id);
  const lease = { id: args.leaseId, until: now + WEBHOOK_LEASE_MS };
  if (existing === null) {
    await webhooks.insert({ userId: args.userId, tracker: args.tracker, accountId: args.accountId, site: args.site, hookId: "", scopes: [], expiresAt: 0, updatedAt: now, lease });
    return { status: "claimed", scopes: [args.scope], previous: null };
  }
  const sameAccount = existing.accountId === args.accountId;
  if (sameAccount && existing.hookId !== "" && existing.scopes.includes(args.scope) && existing.expiresAt > now) return { status: "covered" };
  if (existing.lease !== undefined && existing.lease.until > now && existing.lease.id !== args.leaseId) return { status: "busy" };
  await webhooks.patch(existing._id, { lease });
  // Another account on the site can't renew or remove the old webhook; it expires on its own.
  const kept = sameAccount ? existing.scopes.filter((scope) => scope !== args.scope) : [];
  return { status: "claimed", scopes: [args.scope, ...kept].slice(0, MAX_WEBHOOK_SCOPES), previous: sameAccount && existing.hookId !== "" ? existing.hookId : null };
}

/** Saves the webhook a registration made and releases the lease; with `hook` null, only releases it. Nothing changes unless `leaseId` holds it. One transaction. */
export async function saveWebhookUpdate(
  store: Store,
  args: { userId: string; tracker: TrackerId; accountId: string; siteId: string; leaseId: string; hook: { hookId: string; scopes: string[]; expiresAt: number } | null },
  now: number,
): Promise<boolean> {
  const webhooks = webhookStore(store);
  const existing = await webhooks.find(args.userId, args.tracker, args.siteId);
  if (existing === null || existing.lease?.id !== args.leaseId) return false;
  if (args.hook === null) {
    if (existing.hookId === "") await webhooks.delete(existing._id);
    else await webhooks.patch(existing._id, { lease: null });
    return true;
  }
  await webhooks.patch(existing._id, { ...args.hook, accountId: args.accountId, updatedAt: now, lease: null });
  return true;
}

/** The steps of making a person's webhook follow a ticket's scope; each store step is its own transaction. */
export interface WebhookSteps {
  /** The person's token for the account they linked the ticket with. */
  token(): Promise<TrackerToken>;
  claim(site: TrackerSite, leaseId: string): Promise<WebhookClaim>;
  save(siteId: string, leaseId: string, hook: { hookId: string; scopes: string[]; expiresAt: number } | null): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  leaseId(): string;
  /** The deployment's webhook address for the tracker. */
  url: string;
}

/**
 * Makes the person's status webhook on the ticket's site follow its scope
 * (a Jira project), registering a new one that follows it with the ones
 * before and removing the old one. Only for a sign-in on a deployment with
 * the operator's app, whose secret checks the deliveries. Returns what it did.
 */
export async function followTicketScope(
  steps: WebhookSteps,
  deployment: TicketsDeployment,
  args: { tracker: TrackerId; scope: string },
  fetchFn: typeof fetch = fetch,
): Promise<"followed" | "covered" | "unsupported" | "busy"> {
  const adapter = trackerAdapter(args.tracker, deployment, fetchFn);
  if (adapter.webhooks === undefined || trackerSignIn(args.tracker, deployment) === null) return "unsupported";
  const token = await steps.token();
  if (token.method !== "oauth" || token.site == null) return "unsupported";
  const leaseId = steps.leaseId();
  for (let tries = 0; ; tries++) {
    const claim = await steps.claim(token.site, leaseId);
    if (claim.status === "covered") return "covered";
    if (claim.status === "busy") {
      if (tries >= 10) return "busy";
      await steps.sleep(2_000);
      continue;
    }
    let hook: { id: string; expiresAt: number };
    try {
      hook = await adapter.webhooks.register(token, { url: steps.url, scopes: claim.scopes });
    } catch (error) {
      await steps.save(token.site.id, leaseId, null).catch(() => undefined);
      throw error;
    }
    await steps.save(token.site.id, leaseId, { hookId: hook.id, scopes: claim.scopes, expiresAt: hook.expiresAt });
    if (claim.previous !== null) await adapter.webhooks.remove(token, [claim.previous]).catch(() => undefined);
    return "followed";
  }
}

// ---------------------------------------------------------------------------
// Renewal, on a schedule.

/** Webhooks due for renewal: expiring within the margin. */
export async function webhooksToRenew(store: Store, now: number, limit = 100): Promise<string[]> {
  return (await webhookStore(store).listExpiring(now + WEBHOOK_RENEW_MARGIN_MS, limit)).filter((hook) => hook.hookId !== "" && (hook.lease === undefined || hook.lease.until <= now)).map((hook) => hook._id);
}

export type WebhookRenewal =
  | { status: "skip" }
  | { status: "renew"; person: { userId: string; accountId: string }; tracker: TrackerId; site: TrackerSite; hookId: string; scopes: string[]; expired: boolean };

/** Takes a webhook to renew it under `leaseId`; skipped when it's gone, not due, or another run holds it. One transaction. */
export async function claimWebhookRenewal(store: Store, args: { webhookId: string; leaseId: string }, now: number): Promise<WebhookRenewal> {
  const webhooks = webhookStore(store);
  const hook = await webhooks.get(args.webhookId);
  if (hook === null || hook.hookId === "" || hook.expiresAt > now + WEBHOOK_RENEW_MARGIN_MS || (hook.lease !== undefined && hook.lease.until > now)) return { status: "skip" };
  await webhooks.patch(hook._id, { lease: { id: args.leaseId, until: now + WEBHOOK_LEASE_MS } });
  return { status: "renew", person: { userId: hook.userId, accountId: hook.accountId }, tracker: hook.tracker, site: hook.site, hookId: hook.hookId, scopes: hook.scopes, expired: hook.expiresAt <= now };
}

/** Saves a renewal: the webhook (re-registered when it had expired) and when it expires; `gone` removes the record, as when the person disconnected. One transaction. */
export async function finishWebhookRenewal(
  store: Store,
  args: { webhookId: string; leaseId: string; result: { hookId: string; expiresAt: number } | "gone" | "failed" },
  now: number,
): Promise<void> {
  const webhooks = webhookStore(store);
  const hook = await webhooks.get(args.webhookId);
  if (hook === null || hook.lease?.id !== args.leaseId) return;
  if (args.result === "gone") await webhooks.delete(hook._id);
  else if (args.result === "failed") await webhooks.patch(hook._id, { lease: null });
  else await webhooks.patch(hook._id, { hookId: args.result.hookId, expiresAt: args.result.expiresAt, updatedAt: now, lease: null });
}

/** The steps of renewing one webhook; each store step is its own transaction. */
export interface RenewSteps {
  claim(leaseId: string): Promise<WebhookRenewal>;
  token(person: { userId: string; accountId: string }, tracker: TrackerId): Promise<TrackerToken>;
  finish(leaseId: string, result: { hookId: string; expiresAt: number } | "gone" | "failed"): Promise<void>;
  leaseId(): string;
  url: string;
}

/**
 * Renews one webhook with its person's token, or registers it again when it
 * expired before it could be renewed. When the person disconnected or
 * connected another account, the record goes, and Jira's webhook expires on
 * its own.
 */
export async function renewTicketWebhook(steps: RenewSteps, deployment: TicketsDeployment, fetchFn: typeof fetch = fetch): Promise<"renewed" | "gone" | "skipped" | "failed"> {
  const leaseId = steps.leaseId();
  const claim = await steps.claim(leaseId);
  if (claim.status === "skip") return "skipped";
  const adapter = trackerAdapter(claim.tracker, deployment, fetchFn);
  let token: TrackerToken;
  try {
    token = await steps.token(claim.person, claim.tracker);
  } catch (error) {
    // Not connected as that account any more: nothing can renew it.
    if (error instanceof CritiqsError && (error.code === "not-found" || error.code === "invalid")) {
      await steps.finish(leaseId, "gone");
      return "gone";
    }
    await steps.finish(leaseId, "failed");
    return "failed";
  }
  try {
    if (adapter.webhooks === undefined || token.method !== "oauth" || token.site?.id !== claim.site.id) {
      await steps.finish(leaseId, "gone");
      return "gone";
    }
    const result = claim.expired
      ? await adapter.webhooks.register(token, { url: steps.url, scopes: claim.scopes }).then((hook) => ({ hookId: hook.id, expiresAt: hook.expiresAt }))
      : { hookId: claim.hookId, expiresAt: await adapter.webhooks.renew(token, [claim.hookId]) };
    await steps.finish(leaseId, result);
    return "renewed";
  } catch {
    await steps.finish(leaseId, "failed");
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Deliveries.

/**
 * Saves a Jira webhook's issue status on every thread linking that issue on
 * the site the delivery came from: a site Critiqs registered the matched
 * webhook for, which the issue's address must name too (its host, or its
 * cloud ID through Atlassian's gateway). Jira's webhook and issue IDs are
 * unique within a site only, so a delivery from another site's webhook with
 * the same ID, such as one left behind when its person disconnected, or one
 * whose issue address names no site, changes nothing. One transaction.
 */
export async function applyJiraWebhook(store: Store, delivery: Extract<JiraWebhook, { status: "update" }>, now: number): Promise<{ updated: number; resolved: string[] }> {
  const webhooks = webhookStore(store);
  const sites = new Map<string, TrackerWebhookRecord["site"]>();
  for (const hookId of delivery.webhookIds) {
    for (const hook of await webhooks.findByHook("jira", hookId)) sites.set(hook.site.id, hook.site);
  }
  const self = delivery.self;
  const candidates = self === null ? [] : [...sites.values()].filter((site) => site.name === self.host || (self.cloudId !== null && site.id === self.cloudId));
  let updated = 0;
  const resolved: string[] = [];
  for (const site of candidates) {
    const result = await applyTicketStatus(
      store,
      { tracker: "jira", externalId: jiraId(site, delivery.issueId), site: site.id, status: delivery.reading.status, asOf: delivery.reading.asOf, deleted: delivery.deleted },
      now,
    );
    updated += result.updated;
    resolved.push(...result.resolved);
  }
  return { updated, resolved };
}
