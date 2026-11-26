import type { TrackerId } from "@critiqs/core";
import { CritiqsError } from "../errors.ts";
import { canReview } from "../organizations.ts";
import type { Store, TrackerWebhookRecord } from "../store.ts";
import { type TicketsDeployment, ticketStore, type TokenUse, trackerAdapter, trackerSignIn } from "./accounts.ts";
import { MAX_TICKET_LINK_ROWS } from "./links.ts";
import { webhookRoom } from "./status.ts";
import type { JiraWebhook } from "./trackers/jira.ts";
import { jiraId } from "./trackers/jira.ts";
import type { TrackerSite, TrackerToken } from "./trackers/index.ts";

// Status webhooks that people's sign-ins register, for trackers that send
// webhooks only to those their users register, and expire them (Jira:
// https://developer.atlassian.com/cloud/jira/platform/webhooks/). Each person
// has at most one per tracker and site, following the projects of the
// tickets they linked there in projects they may still review: worked out
// again whenever it is registered or renewed, so a person removed from a
// project, or whose last ticket there was unlinked, stops following it, and
// a webhook that follows nothing is removed at the tracker. A scheduled job
// renews each before it expires. Pasted tokens can't register webhooks:
// their tickets' status comes from the check when a thread opens.

/** How long one registration or renewal may hold a webhook before another may take over. */
export const WEBHOOK_LEASE_MS = 60_000;
/** How long before it expires a webhook is renewed. Jira's last 30 days. */
export const WEBHOOK_RENEW_MARGIN_MS = 7 * 24 * 60 * 60_000;
/** The most projects one webhook follows, so its filter stays short. */
export const MAX_WEBHOOK_SCOPES = 100;
/** The most of a person's links on a site read to work out what their webhook follows. */
const MAX_FOLLOWED_LINKS = 500;
/** How long a check a delivery asked for counts as waiting: until then, more deliveries for the link ask for none. */
export const QUEUED_CHECK_MS = 10 * 60_000;

type Webhooks = NonNullable<Store["tickets"]>["webhooks"];

function webhookStore(store: Store): Webhooks {
  return ticketStore(store).webhooks;
}

const sameScopes = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((scope, index) => scope === [...b].sort()[index]);

/** What a person's webhook on a site may follow: Jira projects (`scopes`), and the Critiqs projects whose links put them there. */
export interface Followed {
  scopes: string[];
  projects: string[];
}

/**
 * What a person's webhook on a site may follow now: the scopes (Jira
 * projects) of the tickets they linked there with the tracker account it is
 * registered as (`accountId`), in projects they may still review, and those
 * projects. Their right to review each project is checked here, before any
 * registration or renewal reads their token; that read checks the projects
 * again. At most `MAX_WEBHOOK_SCOPES`.
 */
export async function followedScopes(store: Store, userId: string, tracker: TrackerId, siteId: string, accountId: string): Promise<Followed> {
  const links = await ticketStore(store).links.listForLinker(userId, tracker, siteId, MAX_FOLLOWED_LINKS);
  const reviews = new Map<string, boolean>();
  const scopes = new Set<string>();
  const projects = new Set<string>();
  for (const link of links) {
    // A ticket linked with another tracker account, such as one the person had before reconnecting, isn't this webhook's.
    if (link.state !== "linked" || link.webhookScope === undefined || (link.accountId ?? link.creatorAccountId) !== accountId) continue;
    let may = reviews.get(link.projectId);
    if (may === undefined) {
      const project = await store.projects.get(link.projectId);
      may = project !== null && (await canReview(store, project, userId));
      reviews.set(link.projectId, may);
    }
    if (!may) continue;
    if (!scopes.has(link.webhookScope) && scopes.size >= MAX_WEBHOOK_SCOPES) continue;
    scopes.add(link.webhookScope);
    projects.add(link.projectId);
  }
  return { scopes: [...scopes].sort(), projects: [...projects].sort() };
}

export type WebhookClaim =
  /** The person's webhook on the site follows what it should already, and isn't due for renewal; or there is nothing to follow and no webhook. */
  | { status: "covered" }
  /** The person has no sign-in to the tracker as the account asked for, on a site, so no webhook is theirs to register. */
  | { status: "unsupported" }
  /** Another registration holds the person's webhook; try again shortly. */
  | { status: "busy" }
  /** This caller registers a webhook on `site` following `scopes`, for `projects`, replacing `previous` (the tracker's ID for the old one), if any. */
  | { status: "claimed"; site: TrackerSite; scopes: string[]; projects: string[]; previous: string | null }
  /** The person's webhook follows nothing they may still review: this caller removes `previous` at the tracker, if any, and the record. */
  | { status: "retire"; site: TrackerSite; previous: string | null };

/**
 * Takes the person's webhook on the site of their sign-in to make it follow
 * what it may now (`followedScopes`), under `leaseId`, unless it does
 * already. Worked out before anything reads their token. One transaction.
 */
export async function claimWebhookUpdate(store: Store, args: { userId: string; tracker: TrackerId; accountId: string; leaseId: string }, now: number): Promise<WebhookClaim> {
  const account = await ticketStore(store).accounts.find(args.userId, args.tracker);
  if (account === null || account.accountId !== args.accountId || account.method !== "oauth" || account.site === undefined) return { status: "unsupported" };
  const site = account.site;
  const webhooks = webhookStore(store);
  const { scopes, projects } = await followedScopes(store, args.userId, args.tracker, site.id, args.accountId);
  const existing = await webhooks.find(args.userId, args.tracker, site.id);
  const lease = { id: args.leaseId, until: now + WEBHOOK_LEASE_MS };
  if (existing === null) {
    if (scopes.length === 0) return { status: "covered" };
    await webhooks.insert({ userId: args.userId, tracker: args.tracker, accountId: args.accountId, site, hookId: "", scopes: [], expiresAt: 0, updatedAt: now, lease });
    return { status: "claimed", site, scopes, projects, previous: null };
  }
  const sameAccount = existing.accountId === args.accountId;
  if (sameAccount && existing.hookId !== "" && sameScopes(existing.scopes, scopes) && existing.expiresAt > now) return { status: "covered" };
  if (existing.lease !== undefined && existing.lease.until > now && existing.lease.id !== args.leaseId) return { status: "busy" };
  await webhooks.patch(existing._id, { lease });
  // Another account on the site can't renew or remove the old webhook; it expires on its own.
  const previous = sameAccount && existing.hookId !== "" ? existing.hookId : null;
  return scopes.length === 0 ? { status: "retire", site, previous } : { status: "claimed", site, scopes, projects, previous };
}

/**
 * Saves the webhook a registration made and releases the lease; with `hook`
 * null, only releases it (a placeholder goes); with `"retired"`, removes the
 * record. Nothing changes unless `leaseId` holds it, and then it says false:
 * a webhook registered under a lost lease is nobody's, for the caller to
 * remove. One transaction.
 */
export async function saveWebhookUpdate(
  store: Store,
  args: { userId: string; tracker: TrackerId; accountId: string; siteId: string; leaseId: string; hook: { hookId: string; scopes: string[]; expiresAt: number } | null | "retired" },
  now: number,
): Promise<boolean> {
  const webhooks = webhookStore(store);
  const existing = await webhooks.find(args.userId, args.tracker, args.siteId);
  if (existing === null || existing.lease?.id !== args.leaseId) return false;
  if (args.hook === "retired") {
    await webhooks.delete(existing._id);
    return true;
  }
  if (args.hook === null) {
    if (existing.hookId === "") await webhooks.delete(existing._id);
    else await webhooks.patch(existing._id, { lease: null });
    return true;
  }
  await webhooks.patch(existing._id, { ...args.hook, accountId: args.accountId, updatedAt: now, lease: null });
  return true;
}

/** The steps of making a person's webhook follow what it may; each store step is its own transaction. */
export interface WebhookSteps {
  /** The person's webhook to update, worked out before their token is read. */
  claim(leaseId: string): Promise<WebhookClaim>;
  /** The person's token for the account they linked the ticket with, read only as `use` allows (`claimTokenRefresh`). */
  token(use: TokenUse): Promise<TrackerToken>;
  save(siteId: string, leaseId: string, hook: { hookId: string; scopes: string[]; expiresAt: number } | null | "retired"): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  leaseId(): string;
  now(): number;
  /** The deployment's webhook address for the tracker. */
  url: string;
}

/**
 * Makes the person's status webhook on their site follow what it may now:
 * registering a new one that follows those scopes and removing the old one,
 * or, when it may follow nothing, removing it. What it follows is worked out
 * first (`claim`); only then is the person's token read, for the projects it
 * follows, or only to remove what Critiqs registered. A webhook registered
 * after another run took the record is removed again; one Jira won't remove
 * stays on record for the next run, and this one says `failed`. Only for a
 * sign-in on a deployment with the operator's app, whose secret checks the
 * deliveries. Returns what it did.
 */
export async function followTicketScope(
  steps: WebhookSteps,
  deployment: TicketsDeployment,
  args: { tracker: TrackerId },
  fetchFn: typeof fetch = fetch,
): Promise<"followed" | "covered" | "retired" | "unsupported" | "busy" | "failed"> {
  const adapter = trackerAdapter(args.tracker, deployment, fetchFn);
  if (adapter.webhooks === undefined || trackerSignIn(args.tracker, deployment) === null) return "unsupported";
  const webhooks = adapter.webhooks;
  const leaseId = steps.leaseId();
  for (let tries = 0; ; tries++) {
    const claim = await steps.claim(leaseId);
    if (claim.status === "covered" || claim.status === "unsupported") return claim.status;
    if (claim.status === "busy") {
      if (tries >= 10) return "busy";
      await steps.sleep(2_000);
      continue;
    }
    const release = () => steps.save(claim.site.id, leaseId, null).catch(() => false);
    if (claim.status === "retire") {
      if (claim.previous !== null) {
        try {
          await webhooks.remove(await siteToken(steps, { by: "cleanup" }, claim.site), [claim.previous]);
        } catch {
          // Still at Jira: the record stays, so the next run (or its renewal) removes it.
          await release();
          return "failed";
        }
      }
      await steps.save(claim.site.id, leaseId, "retired");
      return "retired";
    }
    let token: TrackerToken;
    let hook: { id: string; expiresAt: number };
    try {
      token = await siteToken(steps, { by: "job", projects: claim.projects }, claim.site);
      hook = await webhooks.register(token, { url: steps.url, scopes: claim.scopes, now: steps.now() });
    } catch (error) {
      await release();
      throw error;
    }
    if (!(await steps.save(claim.site.id, leaseId, { hookId: hook.id, scopes: claim.scopes, expiresAt: hook.expiresAt }))) {
      // Another run took the record meanwhile: this webhook is nobody's, so it doesn't keep one of the person's few slots at Jira.
      await webhooks.remove(token, [hook.id]).catch(() => undefined);
      return "busy";
    }
    if (claim.previous !== null) await webhooks.remove(token, [claim.previous]).catch(() => undefined);
    return "followed";
  }
}

/** The person's token, only for a sign-in on the site the webhook is on. */
async function siteToken(steps: { token(use: TokenUse): Promise<TrackerToken> }, use: TokenUse, site: TrackerSite): Promise<TrackerToken> {
  const token = await steps.token(use);
  if (token.method !== "oauth" || token.site?.id !== site.id) throw new CritiqsError("unavailable", "Your Jira connection changed. Try again.");
  return token;
}

// ---------------------------------------------------------------------------
// Renewal, on a schedule.

/** Webhooks due for renewal: expiring within the margin. */
export async function webhooksToRenew(store: Store, now: number, limit = 100): Promise<string[]> {
  return (await webhookStore(store).listExpiring(now + WEBHOOK_RENEW_MARGIN_MS, limit)).filter((hook) => hook.hookId !== "" && (hook.lease === undefined || hook.lease.until <= now)).map((hook) => hook._id);
}

export type WebhookRenewal =
  | { status: "skip" }
  | {
      status: "renew";
      person: { userId: string; accountId: string };
      tracker: TrackerId;
      site: TrackerSite;
      hookId: string;
      /** What the webhook follows now, and what it may follow (`followedScopes`): none, and it is removed. */
      scopes: string[];
      followed: string[];
      /** The Critiqs projects whose links it may follow, which reading the person's token checks again. */
      projects: string[];
      expired: boolean;
    };

/**
 * Takes a webhook to renew it under `leaseId`; skipped when it's gone, not
 * due, or another run holds it. Works out what it may follow now, from the
 * person's tickets linked with the account it is registered as, checking they
 * may still review each project, before their token is read. One transaction.
 */
export async function claimWebhookRenewal(store: Store, args: { webhookId: string; leaseId: string }, now: number): Promise<WebhookRenewal> {
  const webhooks = webhookStore(store);
  const hook = await webhooks.get(args.webhookId);
  if (hook === null || hook.hookId === "" || hook.expiresAt > now + WEBHOOK_RENEW_MARGIN_MS || (hook.lease !== undefined && hook.lease.until > now)) return { status: "skip" };
  const { scopes: followed, projects } = await followedScopes(store, hook.userId, hook.tracker, hook.site.id, hook.accountId);
  await webhooks.patch(hook._id, { lease: { id: args.leaseId, until: now + WEBHOOK_LEASE_MS } });
  return {
    status: "renew",
    person: { userId: hook.userId, accountId: hook.accountId },
    tracker: hook.tracker,
    site: hook.site,
    hookId: hook.hookId,
    scopes: hook.scopes,
    followed,
    projects,
    expired: hook.expiresAt <= now,
  };
}

/**
 * Saves a renewal: the webhook (registered again when it had expired or
 * must follow other scopes), what it follows, and when it expires; `gone`
 * removes the record, as when the person disconnected or it follows
 * nothing now. False, changing nothing, when `leaseId` no longer holds it.
 * One transaction.
 */
export async function finishWebhookRenewal(
  store: Store,
  args: { webhookId: string; leaseId: string; result: { hookId: string; expiresAt: number; scopes: string[] } | "gone" | "failed" },
  now: number,
): Promise<boolean> {
  const webhooks = webhookStore(store);
  const hook = await webhooks.get(args.webhookId);
  if (hook === null || hook.lease?.id !== args.leaseId) return false;
  if (args.result === "gone") await webhooks.delete(hook._id);
  else if (args.result === "failed") await webhooks.patch(hook._id, { lease: null });
  else await webhooks.patch(hook._id, { hookId: args.result.hookId, expiresAt: args.result.expiresAt, scopes: args.result.scopes, updatedAt: now, lease: null });
  return true;
}

/** The steps of renewing one webhook; each store step is its own transaction. */
export interface RenewSteps {
  claim(leaseId: string): Promise<WebhookRenewal>;
  /** The person's token, read only as `use` allows (`claimTokenRefresh`). */
  token(person: { userId: string; accountId: string }, tracker: TrackerId, use: TokenUse): Promise<TrackerToken>;
  finish(leaseId: string, result: { hookId: string; expiresAt: number; scopes: string[] } | "gone" | "failed"): Promise<boolean>;
  leaseId(): string;
  now(): number;
  url: string;
}

/**
 * Renews one webhook with its person's token, read only after what it may
 * follow is worked out: extends it while it follows what it may; registers
 * it again, removing the old one, when it must follow other scopes or
 * expired before it could be renewed; and removes it at the tracker when its
 * person may follow nothing there now, reading the token only for that. A
 * webhook registered again after another run took the record is removed
 * again; one Jira won't remove stays on record for the next run. When the
 * person disconnected or connected another account, the record goes, and
 * Jira's webhook expires on its own.
 */
export async function renewTicketWebhook(steps: RenewSteps, deployment: TicketsDeployment, fetchFn: typeof fetch = fetch): Promise<"renewed" | "retired" | "gone" | "skipped" | "failed"> {
  const leaseId = steps.leaseId();
  const claim = await steps.claim(leaseId);
  if (claim.status === "skip") return "skipped";
  const adapter = trackerAdapter(claim.tracker, deployment, fetchFn);
  const use: TokenUse = claim.followed.length === 0 ? { by: "cleanup" } : { by: "job", projects: claim.projects };
  let token: TrackerToken;
  try {
    token = await steps.token(claim.person, claim.tracker, use);
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
    if (claim.followed.length === 0) {
      // Nothing it may follow: removed with the person's own token, not renewed. Jira refusing keeps the record (below).
      await adapter.webhooks.remove(token, [claim.hookId]);
      await steps.finish(leaseId, "gone");
      return "retired";
    }
    if (claim.expired || !sameScopes(claim.scopes, claim.followed)) {
      const hook = await adapter.webhooks.register(token, { url: steps.url, scopes: claim.followed, now: steps.now() });
      if (!(await steps.finish(leaseId, { hookId: hook.id, expiresAt: hook.expiresAt, scopes: claim.followed }))) {
        // Another run took the record meanwhile: this new webhook is nobody's.
        await adapter.webhooks.remove(token, [hook.id]).catch(() => undefined);
        return "failed";
      }
      if (!claim.expired) await adapter.webhooks.remove(token, [claim.hookId]).catch(() => undefined);
      return "renewed";
    }
    await steps.finish(leaseId, { hookId: claim.hookId, expiresAt: await adapter.webhooks.renew(token, [claim.hookId]), scopes: claim.scopes });
    return "renewed";
  } catch {
    await steps.finish(leaseId, "failed");
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Deliveries.

/** What a Jira delivery did: the links whose status to check now, and whether its site was over its minute's limit. */
export interface JiraNoticeResult {
  checks: string[];
  limited?: true;
}

/**
 * Takes a Jira delivery as a notice that an issue on a site changed: Jira's
 * token doesn't cover the delivery's body, so the status in it is never
 * used. The notice counts only from a webhook Critiqs registered on the site
 * the issue's address names, found by that site and the webhook's ID
 * together, and still current: not expired, nor replaced. Each link to the
 * issue on that site then gets a check, which reads the issue with its
 * linker's token after checking they may still review its project
 * (`prepareStatusCheck`); a link whose check already waits gets no other.
 * Each site's notices that reach links take its updates for the minute
 * (`webhookRoom`). One transaction. Returns the links to check.
 */
export async function applyJiraWebhook(store: Store, delivery: Extract<JiraWebhook, { status: "notice" }>, now: number): Promise<JiraNoticeResult> {
  const webhooks = webhookStore(store);
  const sites = new Map<string, TrackerWebhookRecord["site"]>();
  for (const hookId of delivery.webhookIds) {
    for (const hook of await webhooks.findByHook("jira", delivery.site, hookId)) {
      if (hook.hookId === hookId && hook.expiresAt > now) sites.set(hook.site.id, hook.site);
    }
  }
  const links = ticketStore(store).links;
  const checks: string[] = [];
  for (const site of sites.values()) {
    const linked = (await links.findByExternal("jira", jiraId(site, delivery.issueId), MAX_TICKET_LINK_ROWS)).filter((link) => link.state === "linked" && link.site === site.id);
    if (linked.length === 0) continue;
    if (!(await webhookRoom(store, "jira", site.id, now))) return { checks, limited: true };
    for (const link of linked) {
      const queued = link.statusCheckQueued;
      // The waiting check reads the issue after this change too.
      if (queued !== undefined && now - queued.at < QUEUED_CHECK_MS) continue;
      await links.patch(link._id, { statusCheckQueued: { at: now } });
      checks.push(link._id);
    }
  }
  return { checks };
}
