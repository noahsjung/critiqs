import type { Store, TrackerAccountRecord } from "../store.ts";
import { type JiraPrivacyAccess, type TicketsDeployment, ticketStore } from "./accounts.ts";
import { TrackerRefusal } from "./trackers/index.ts";
import {
  JIRA_PRIVACY_DEFAULT_CYCLE_DAYS,
  JIRA_PRIVACY_MAX_ACCOUNTS,
  type JiraAccountPrivacyStatus,
  type JiraAccountReport,
  type JiraReportedAccount,
  jiraAccountId,
} from "./trackers/jira.ts";

// Atlassian Personal Data Reporting API (3LO) lifecycle:
// periodically reports stored Jira OAuth accounts to
// `POST https://api.atlassian.com/app/report-accounts/`, respects the
// `Cycle-Period` header (default 7 days) so no Atlassian account is reported
// more frequently than allowed (even across multiple Critiqs accounts or
// reconnects), refreshes `accountName` on `"updated"` via `/me` (retrying
// `/me` separately without re-reporting if `/me` transiently fails), and
// erases stored personal data across all matching rows on `"closed"` (or when
// Atlassian explicitly rejects a refresh/profile call on an `"updated"`
// account).

const DAY_MS = 24 * 60 * 60_000;
/** Longer than Convex's 10-minute action limit so a slow batch never loses its lease mid-run. */
export const JIRA_PRIVACY_LEASE_MS = 15 * 60_000;
/** Backoff when a batch cannot be reported yet (e.g. legacy tokens lacking `report:personal-data`, or a failing batch rotating behind healthy ones). */
export const JIRA_PRIVACY_RETRY_MS = 60 * 60_000;
/** Most reporter candidates probed per run, preventing long sequential timeout chains. */
const MAX_REPORTER_PROBES = 5;
/** Most sibling rows sharing one Atlassian account ID coordinated in one transaction. */
const MAX_SIBLING_ACCOUNTS = 100;

/** One Jira OAuth account claimed for a personal data reporting or profile-refresh batch. */
export interface ClaimedJiraPrivacyAccount {
  recordId: string;
  userId: string;
  /** Critiqs's stored ID (`<cloudId>/<atlassianAccountId>`). */
  accountId: string;
  /** When `connectedAt` was recorded; guards against clobbering a reconnection. */
  connectedAt: number;
  /** Oldest personal-data timestamp among rows sharing this raw Atlassian accountId. */
  profileUpdatedAt: number;
}

/** A batch of Jira OAuth accounts claimed under one lease. */
export interface JiraPrivacyClaim {
  /** Accounts whose `/me` refresh was left pending after a prior `updated` answer (never re-reported to `/app/report-accounts/`). */
  pendingRefreshes: ClaimedJiraPrivacyAccount[];
  /** Accounts due for `POST /app/report-accounts/`. */
  items: ClaimedJiraPrivacyAccount[];
  /** Most recently reported healthy Jira OAuth accounts, tried FIRST as reporter tokens. */
  fallbackReporters: { userId: string; accountId: string }[];
  /** True when the due query filled the batch cap, so another batch may be waiting. */
  hasMore: boolean;
}

/** What a reporting run writes back for one claimed Jira account. */
export type JiraPrivacyOutcome =
  | { status: "unchanged"; nextReportAt: number }
  | { status: "skip-unreportable"; nextReportAt: number }
  | { status: "updated"; accountName: string; nextReportAt: number }
  | { status: "refresh-pending"; nextReportAt: number }
  | { status: "refreshed"; accountName: string }
  | { status: "erase" }
  | { status: "retry"; nextReportAt?: number };

/**
 * Claims pending `/me` refreshes (from prior `updated` responses) plus up to
 * `limit` (default 90) Jira OAuth accounts due for `POST /app/report-accounts/`
 * whose lease is not active. Coordinates across rows sharing one raw Atlassian
 * account ID so an already-reported Atlassian account is never re-reported
 * inside `Cycle-Period`, and uses the oldest `profileUpdatedAt` across
 * siblings. One transaction.
 */
export async function claimJiraPrivacyBatch(
  store: Store,
  args: { leaseId: string; limit?: number },
  now: number,
): Promise<JiraPrivacyClaim> {
  const accounts = ticketStore(store).accounts;
  const limit = Math.max(1, Math.min(args.limit ?? JIRA_PRIVACY_MAX_ACCOUNTS, JIRA_PRIVACY_MAX_ACCOUNTS));
  const lease = { id: args.leaseId, until: now + JIRA_PRIVACY_LEASE_MS };

  // 1. Claim accounts waiting on a `/me`-only refresh from a previous `updated` response.
  const pendingRows = await accounts.pendingPrivacyRefresh("jira", limit);
  const pendingRefreshes: ClaimedJiraPrivacyAccount[] = [];
  const claimedIds = new Set<string>();
  for (const account of pendingRows) {
    if (account.method !== "oauth") continue;
    if (account.privacyLease !== undefined && account.privacyLease.until > now && account.privacyLease.id !== args.leaseId) continue;
    const rawId = jiraAccountId(account.accountId);
    await accounts.patch(account._id, {
      privacyLease: lease,
      ...(rawId !== null && account.privacyAccountKey === undefined ? { privacyAccountKey: rawId } : {}),
    });
    claimedIds.add(account._id);
    pendingRefreshes.push({
      recordId: account._id,
      userId: account.userId,
      accountId: account.accountId,
      connectedAt: account.connectedAt,
      profileUpdatedAt: account.profileUpdatedAt ?? account.connectedAt,
    });
  }

  // 2. Claim accounts due for `POST /app/report-accounts/`.
  const due = await accounts.duePrivacyReport("jira", "oauth", now, limit);
  const items: ClaimedJiraPrivacyAccount[] = [];
  const seenKeys = new Map<string, { siblings: TrackerAccountRecord[]; activeNext: number | null; activeReported: number | undefined; oldestProfile: number }>();

  for (const account of due) {
    if (claimedIds.has(account._id)) continue;
    if (account.privacyLease !== undefined && account.privacyLease.until > now && account.privacyLease.id !== args.leaseId) continue;
    const rawId = jiraAccountId(account.accountId);
    let oldestProfile = account.profileUpdatedAt ?? account.connectedAt;

    if (rawId !== null) {
      let group = seenKeys.get(rawId);
      if (group === undefined) {
        const siblings = await accounts.withPrivacyKey("jira", rawId, MAX_SIBLING_ACCOUNTS);
        let activeNext: number | null = null;
        let activeReported: number | undefined;
        let minProfile = oldestProfile;
        for (const sibling of siblings) {
          const sibProfile = sibling.profileUpdatedAt ?? sibling.connectedAt;
          if (sibProfile < minProfile) minProfile = sibProfile;
          if (sibling.privacyNextReportAt !== undefined && sibling.privacyNextReportAt > now && (activeNext === null || sibling.privacyNextReportAt > activeNext)) {
            activeNext = sibling.privacyNextReportAt;
            activeReported = sibling.privacyReportedAt;
          }
        }
        group = { siblings, activeNext, activeReported, oldestProfile: minProfile };
        seenKeys.set(rawId, group);
      }
      // A sibling row for the same Atlassian account was already reported within Cycle-Period: adopt its schedule
      // instead of re-reporting the same Atlassian accountId early.
      if (group.activeNext !== null) {
        await accounts.patch(account._id, {
          privacyAccountKey: rawId,
          ...(group.activeReported === undefined ? {} : { privacyReportedAt: group.activeReported }),
          privacyNextReportAt: group.activeNext,
        });
        continue;
      }
      if (oldestProfile < group.oldestProfile) group.oldestProfile = oldestProfile;
      oldestProfile = group.oldestProfile;
    }

    await accounts.patch(account._id, {
      privacyLease: lease,
      ...(rawId !== null && account.privacyAccountKey === undefined ? { privacyAccountKey: rawId } : {}),
    });
    claimedIds.add(account._id);
    items.push({
      recordId: account._id,
      userId: account.userId,
      accountId: account.accountId,
      connectedAt: account.connectedAt,
      profileUpdatedAt: oldestProfile,
    });
  }

  // 3. Fetch the most recently reported healthy Jira OAuth accounts as primary reporter candidates.
  const fallbackReporters: { userId: string; accountId: string }[] = [];
  if (items.length > 0) {
    const recent = await accounts.recentByTracker("jira", "oauth", MAX_REPORTER_PROBES);
    for (const account of recent) {
      fallbackReporters.push({ userId: account.userId, accountId: account.accountId });
    }
  }
  return { pendingRefreshes, items, fallbackReporters, hasMore: due.length >= limit || pendingRows.length >= limit };
}

/** Erases one Jira account row, its status webhooks, and its Atlassian accountId references on linked tickets. */
async function eraseJiraAccountRow(store: Store, account: TrackerAccountRecord): Promise<void> {
  const tickets = ticketStore(store);
  for (const hook of await tickets.webhooks.listForUser(account.userId, "jira")) {
    if (hook.accountId === account.accountId) await tickets.webhooks.delete(hook._id);
  }
  await tickets.links.clearLinkerAccount(account.userId, "jira", account.accountId);
  await tickets.accounts.delete(account._id);
}

/**
 * Saves one claimed account's personal data reporting outcome and releases its
 * lease. Coordinates schedules and erasures across sibling rows sharing the
 * same raw Atlassian accountId so no sibling re-reports inside `Cycle-Period`
 * or retains data for a closed Atlassian account. Changes nothing when
 * `leaseId` no longer holds the record or the user reconnected meanwhile. One
 * transaction.
 */
export async function finishJiraPrivacyAccount(
  store: Store,
  args: { recordId: string; leaseId: string; connectedAt: number; outcome: JiraPrivacyOutcome },
  now: number,
): Promise<boolean> {
  const tickets = ticketStore(store);
  const account = await tickets.accounts.get(args.recordId);
  if (account === null || account.tracker !== "jira" || account.privacyLease?.id !== args.leaseId || account.connectedAt !== args.connectedAt) {
    return false;
  }
  const rawId = account.privacyAccountKey ?? jiraAccountId(account.accountId);
  const syncSiblingSchedule = async (nextReportAt: number, updatedName?: string) => {
    if (rawId === null) return;
    for (const sibling of await tickets.accounts.withPrivacyKey("jira", rawId, MAX_SIBLING_ACCOUNTS)) {
      if (sibling._id === account._id) continue;
      // Leave siblings held by another active lease alone unless advancing their schedule without clobbering.
      await tickets.accounts.patch(sibling._id, {
        ...(updatedName === undefined ? {} : { accountName: updatedName, profileUpdatedAt: now, updatedAt: now, privacyRefreshNeeded: null }),
        privacyReportedAt: now,
        privacyNextReportAt: Math.max(sibling.privacyNextReportAt ?? 0, nextReportAt),
      });
    }
  };

  switch (args.outcome.status) {
    case "unchanged":
      await tickets.accounts.patch(account._id, {
        ...(rawId === null ? {} : { privacyAccountKey: rawId }),
        privacyReportedAt: now,
        privacyNextReportAt: args.outcome.nextReportAt,
        privacyRefreshNeeded: null,
        privacyLease: null,
      });
      await syncSiblingSchedule(args.outcome.nextReportAt);
      return true;
    case "skip-unreportable":
      // Unreportable sentinel (`unknown`) was never sent to Atlassian: advance schedule without stamping privacyReportedAt.
      await tickets.accounts.patch(account._id, {
        privacyNextReportAt: args.outcome.nextReportAt,
        privacyRefreshNeeded: null,
        privacyLease: null,
      });
      return true;
    case "updated":
      await tickets.accounts.patch(account._id, {
        ...(rawId === null ? {} : { privacyAccountKey: rawId }),
        accountName: args.outcome.accountName,
        profileUpdatedAt: now,
        updatedAt: now,
        privacyReportedAt: now,
        privacyNextReportAt: args.outcome.nextReportAt,
        privacyRefreshNeeded: null,
        privacyLease: null,
      });
      await syncSiblingSchedule(args.outcome.nextReportAt, args.outcome.accountName);
      return true;
    case "refresh-pending":
      // Report was accepted by Atlassian (advance nextReportAt so we never over-poll), while marking `/me` for retry.
      await tickets.accounts.patch(account._id, {
        ...(rawId === null ? {} : { privacyAccountKey: rawId }),
        privacyReportedAt: now,
        privacyNextReportAt: args.outcome.nextReportAt,
        privacyRefreshNeeded: true,
        privacyLease: null,
      });
      await syncSiblingSchedule(args.outcome.nextReportAt);
      return true;
    case "refreshed":
      await tickets.accounts.patch(account._id, {
        accountName: args.outcome.accountName,
        profileUpdatedAt: now,
        updatedAt: now,
        privacyRefreshNeeded: null,
        privacyLease: null,
      });
      return true;
    case "retry":
      await tickets.accounts.patch(account._id, {
        privacyLease: null,
        ...(args.outcome.nextReportAt === undefined ? {} : { privacyNextReportAt: Math.max(account.privacyNextReportAt ?? 0, args.outcome.nextReportAt) }),
      });
      return true;
    case "erase": {
      await eraseJiraAccountRow(store, account);
      // Erase every sibling row sharing this closed Atlassian accountId so closed personal data never lingers.
      if (rawId !== null) {
        for (const sibling of await tickets.accounts.withPrivacyKey("jira", rawId, MAX_SIBLING_ACCOUNTS)) {
          if (sibling._id === account._id) continue;
          await eraseJiraAccountRow(store, sibling);
        }
      }
      return true;
    }
  }
}

/** Store and capability steps of reporting one batch of Jira accounts. */
export interface JiraPrivacySteps {
  claim(leaseId: string): Promise<JiraPrivacyClaim>;
  /** A person's Jira OAuth token wrapped so it can only report accounts and refresh `/me`. */
  privacy(person: { userId: string; accountId: string }, forceRefresh?: boolean): Promise<JiraPrivacyAccess>;
  finish(recordId: string, leaseId: string, connectedAt: number, outcome: JiraPrivacyOutcome): Promise<boolean>;
  leaseId(): string;
  now(): number;
}

/** Summary of one personal data reporting batch. */
export interface JiraPrivacyRunResult {
  status: "idle" | "ok" | "rate-limited" | "no-reporter" | "failed";
  reported: number;
  updated: number;
  erased: number;
  /** Accounts that moved past this cycle (unchanged, updated, erased, or refreshed), so a stalled batch never loops. */
  advanced: number;
  hasMore: boolean;
}

/** Explicit refusal from Atlassian that a user's OAuth grant/token is revoked or lacks scope (never decryption or invalid_client). */
const isAtlassianAuthRefusal = (error: unknown) =>
  error instanceof TrackerRefusal && (error.code === "invalid" || error.code === "forbidden");

/** Refreshes one account's `/me` profile, retrying once with a forced token refresh on 401 before concluding consent was revoked. */
async function refreshAccountProfile(
  steps: JiraPrivacySteps,
  item: ClaimedJiraPrivacyAccount,
  rawId: string,
  cached?: JiraPrivacyAccess,
): Promise<{ status: "updated"; accountName: string } | { status: "erase" } | { status: "transient" }> {
  const tryRead = async (forceRefresh: boolean) => {
    const access = !forceRefresh && cached !== undefined ? cached : await steps.privacy({ userId: item.userId, accountId: item.accountId }, forceRefresh);
    return await access.refreshProfile();
  };
  try {
    const profile = await tryRead(false);
    if (profile.closed || profile.accountId !== rawId) return { status: "erase" };
    return { status: "updated", accountName: profile.accountName };
  } catch (firstError) {
    // Only retry with a forced refresh on 401 from `/me` (not on 403 or refresh-token invalid_grant).
    if (firstError instanceof TrackerRefusal && firstError.code === "invalid") {
      try {
        const profile = await tryRead(true);
        if (profile.closed || profile.accountId !== rawId) return { status: "erase" };
        return { status: "updated", accountName: profile.accountName };
      } catch (retryError) {
        return isAtlassianAuthRefusal(retryError) ? { status: "erase" } : { status: "transient" };
      }
    }
    return isAtlassianAuthRefusal(firstError) ? { status: "erase" } : { status: "transient" };
  }
}

/**
 * Claims pending `/me` refreshes and one batch of up to 90 due Jira OAuth
 * accounts, reports the due batch to Atlassian's Personal Data Reporting API
 * (`POST /app/report-accounts/`), refreshes `"updated"` profiles via `/me`,
 * and erases `"closed"` accounts. Respects `Cycle-Period` and `429 Retry-After`.
 */
export async function reportJiraPersonalData(steps: JiraPrivacySteps, deployment: TicketsDeployment): Promise<JiraPrivacyRunResult> {
  if (deployment.jira === null || deployment.encryptionKey === null) {
    return { status: "idle", reported: 0, updated: 0, erased: 0, advanced: 0, hasMore: false };
  }
  const leaseId = steps.leaseId();
  const claim = await steps.claim(leaseId);
  if (claim.pendingRefreshes.length === 0 && claim.items.length === 0) {
    return { status: "idle", reported: 0, updated: 0, erased: 0, advanced: 0, hasMore: false };
  }

  let updated = 0;
  let erased = 0;
  let advanced = 0;
  const safeFinish = async (item: ClaimedJiraPrivacyAccount, outcome: JiraPrivacyOutcome): Promise<boolean> => {
    try {
      return await steps.finish(item.recordId, leaseId, item.connectedAt, outcome);
    } catch {
      return false;
    }
  };

  // 1. Drain any `/me`-only retries left from prior `updated` responses (never re-calling `/app/report-accounts/`).
  for (const item of claim.pendingRefreshes) {
    const rawId = jiraAccountId(item.accountId);
    if (rawId === null) {
      await safeFinish(item, { status: "retry" });
      continue;
    }
    const refreshed = await refreshAccountProfile(steps, item, rawId);
    if (refreshed.status === "updated") {
      if (await safeFinish(item, { status: "refreshed", accountName: refreshed.accountName })) {
        updated++;
        advanced++;
      }
    } else if (refreshed.status === "erase") {
      if (await safeFinish(item, { status: "erase" })) {
        erased++;
        advanced++;
      }
    } else {
      await safeFinish(item, { status: "retry" });
    }
  }

  if (claim.items.length === 0) {
    return { status: "ok", reported: 0, updated, erased, advanced, hasMore: claim.hasMore };
  }

  // 2. Deduplicate due rows by raw Atlassian accountId, sending the oldest personal-data timestamp among copies,
  // and skipping unreportable IDs such as Atlassian's `unknown` sentinel.
  const oldestByRawId = new Map<string, number>();
  for (const item of claim.items) {
    const rawId = jiraAccountId(item.accountId);
    if (rawId === null) continue;
    const prev = oldestByRawId.get(rawId);
    if (prev === undefined || item.profileUpdatedAt < prev) oldestByRawId.set(rawId, item.profileUpdatedAt);
  }
  const payload: JiraReportedAccount[] = [...oldestByRawId.entries()].map(([accountId, updatedAt]) => ({ accountId, updatedAt }));
  if (payload.length === 0) {
    const nextReportAt = steps.now() + JIRA_PRIVACY_DEFAULT_CYCLE_DAYS * DAY_MS;
    for (const item of claim.items) {
      if (await safeFinish(item, { status: "skip-unreportable", nextReportAt })) advanced++;
    }
    return { status: "ok", reported: 0, updated, erased, advanced, hasMore: claim.hasMore };
  }

  // 3. Try the healthiest recently-reported accounts FIRST, then newest batch accounts, bounded to MAX_REPORTER_PROBES.
  const seenCandidates = new Set<string>();
  const candidates: { userId: string; accountId: string; recordId?: string }[] = [];
  const pushCandidate = (candidate: { userId: string; accountId: string; recordId?: string }) => {
    const key = `${candidate.userId}:${candidate.accountId}`;
    if (seenCandidates.has(key)) return;
    seenCandidates.add(key);
    candidates.push(candidate);
  };
  for (const fallback of claim.fallbackReporters) pushCandidate(fallback);
  for (const item of [...claim.items].sort((a, b) => b.connectedAt - a.connectedAt)) {
    pushCandidate({ userId: item.userId, accountId: item.accountId, recordId: item.recordId });
  }

  const cachedAccess = new Map<string, JiraPrivacyAccess>();
  const revokedRefreshRecords = new Set<string>();
  let report: JiraAccountReport | null = null;
  let transientFailure = false;

  for (const candidate of candidates.slice(0, MAX_REPORTER_PROBES)) {
    let access: JiraPrivacyAccess;
    try {
      access = await steps.privacy({ userId: candidate.userId, accountId: candidate.accountId });
      if (candidate.recordId !== undefined) cachedAccess.set(candidate.recordId, access);
    } catch (error) {
      // Explicit invalid_grant from Atlassian's token endpoint (TrackerRefusal("invalid")) means this grant is revoked;
      // decryption errors or `unavailable` (invalid_client / network / timeout) abort or skip without erasing anything.
      if (error instanceof TrackerRefusal && error.code === "invalid") {
        if (candidate.recordId !== undefined) revokedRefreshRecords.add(candidate.recordId);
        continue;
      }
      if (!isAtlassianAuthRefusal(error)) {
        transientFailure = true;
        break;
      }
      continue;
    }
    try {
      report = await access.reportAccounts(payload, steps.now());
      break;
    } catch (error) {
      if (isAtlassianAuthRefusal(error)) {
        // 401 (stale/revoked access token) or 403 (pre-existing token without `report:personal-data`): try next candidate.
        continue;
      }
      transientFailure = true;
      break;
    }
  }

  if (transientFailure) {
    // Rotate failing batches behind healthy due accounts so a poison pill or outage never starves the queue.
    const retryAt = steps.now() + JIRA_PRIVACY_RETRY_MS;
    for (const item of claim.items) await safeFinish(item, { status: "retry", nextReportAt: retryAt });
    return { status: "failed", reported: 0, updated, erased, advanced, hasMore: false };
  }

  if (report === null) {
    // No connected Jira account could call `/app/report-accounts/`. Only erase batch items whose own refresh token
    // was explicitly refused by Atlassian (`invalid_grant`), never on 403/401/decryption/misconfig errors.
    const retryAt = steps.now() + JIRA_PRIVACY_RETRY_MS;
    for (const item of claim.items) {
      if (revokedRefreshRecords.has(item.recordId)) {
        if (await safeFinish(item, { status: "erase" })) {
          erased++;
          advanced++;
        }
      } else {
        await safeFinish(item, { status: "retry", nextReportAt: retryAt });
      }
    }
    return { status: "no-reporter", reported: 0, updated, erased, advanced, hasMore: false };
  }

  if (report.status === "rate-limited") {
    const retryAt = steps.now() + report.retryAfterMs;
    for (const item of claim.items) await safeFinish(item, { status: "retry", nextReportAt: retryAt });
    return { status: "rate-limited", reported: 0, updated, erased, advanced, hasMore: false };
  }

  // 4. Apply Atlassian's directives. `"closed"` always wins if Atlassian returns duplicate entries for one accountId.
  const nextReportAt = steps.now() + report.cyclePeriodDays * DAY_MS;
  const actions = new Map<string, JiraAccountPrivacyStatus>();
  for (const entry of report.accounts) {
    if (actions.get(entry.accountId) !== "closed") actions.set(entry.accountId, entry.status);
  }

  for (const item of claim.items) {
    const rawId = jiraAccountId(item.accountId);
    if (rawId === null) {
      if (await safeFinish(item, { status: "skip-unreportable", nextReportAt })) advanced++;
      continue;
    }
    const action = actions.get(rawId);
    if (action === undefined) {
      if (await safeFinish(item, { status: "unchanged", nextReportAt })) advanced++;
      continue;
    }
    if (action === "closed") {
      if (await safeFinish(item, { status: "erase" })) {
        erased++;
        advanced++;
      }
      continue;
    }
    // `status === "updated"`: refresh display name from `/me`. If `/me` transiently fails, advance `nextReportAt`
    // (so `/app/report-accounts/` is NEVER re-called inside Cycle-Period) and mark `/me` for retry.
    const refreshed = await refreshAccountProfile(steps, item, rawId, cachedAccess.get(item.recordId));
    if (refreshed.status === "updated") {
      if (await safeFinish(item, { status: "updated", accountName: refreshed.accountName, nextReportAt })) {
        updated++;
        advanced++;
      }
    } else if (refreshed.status === "erase") {
      if (await safeFinish(item, { status: "erase" })) {
        erased++;
        advanced++;
      }
    } else {
      if (await safeFinish(item, { status: "refresh-pending", nextReportAt })) advanced++;
    }
  }

  return { status: "ok", reported: payload.length, updated, erased, advanced, hasMore: claim.hasMore };
}
