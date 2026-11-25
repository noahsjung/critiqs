import type { AiSettingsRecord, Store } from "../store.ts";
import { ensureGroup, MAX_GROUPS } from "../tags.ts";
import { aiErrorMessage, toAiError, type StructuredModel } from "./model.ts";
import { type GroupingAnswer, groupingRequest } from "./prompts.ts";
import { askHeld, type CreditSteps, reserveCredits, worstCaseCredits } from "./credits.ts";
import { type AiDeployment, chooseConnection, connectionOf, type ResolvedConnection, resolveConnection } from "./settings.ts";

// Automatic grouping. A background job (every minute on Convex and in the
// self-hosted server) claims one project's pending tags under its own token
// and lease, asks the project's model where they belong, then applies the
// answer only to tags still pending, still claimed by that run, and unchanged
// by any person since. Model calls happen outside transactions. Failures
// retry after growing pauses and give up after a few attempts, leaving the
// tags ungrouped; posting comments never waits for any of this.

export const GROUPING_BATCH = 25;
export const GROUPING_LEASE_MS = 3 * 60_000;
export const MAX_GROUPING_ATTEMPTS = 5;
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];

export interface GroupingClaim {
  projectId: string;
  claimToken: string;
  /** The tags it holds, each at the epoch it was claimed at. */
  tags: { key: string; label: string; epoch: number }[];
  groups: { id: string; name: string }[];
  /** The project's settings as claimed, keys still encrypted; null when it saved none. */
  settings: AiSettingsRecord | null;
  hold: string | null;
}

/**
 * Claims the next project's due tags. Projects whose AI is off or not set up
 * have their due tags marked ungrouped instead, and are requeued when their
 * owner connects AI. One transaction.
 */
export async function claimGrouping(store: Store, deployment: AiDeployment, now: number, claimToken: string): Promise<GroupingClaim | null> {
  const seen = new Set<string>();
  for (const due of await store.tags.due(now, 50)) {
    if (seen.has(due.projectId)) continue;
    seen.add(due.projectId);
    const project = await store.projects.get(due.projectId);
    const tags = await store.tags.dueInProject(due.projectId, now, GROUPING_BATCH);
    const settings = await store.aiSettings.find(due.projectId);
    // Background work: always the project's own connection, whatever its usage rule.
    const choice = chooseConnection({ projectId: due.projectId, project: settings, person: null }, deployment);
    if (project === null || !choice.ok) {
      for (const tag of tags) await store.tags.patch(tag._id, { grouping: "none", lastError: choice.ok ? "" : choice.reason });
      continue;
    }
    const groups = (await store.tagGroups.list(due.projectId, MAX_GROUPS)).map((group) => ({ id: group._id, name: group.name }));
    const claimed = tags.map((tag) => ({ key: tag.key, label: tag.label, epoch: tag.epoch }));
    const reserved = await reserveCredits(store, choice, worstCaseCredits(choice, groupingRequest({ tags: claimed, groups })), now);
    if (!reserved.ok) {
      for (const tag of tags) await store.tags.patch(tag._id, { nextAttemptAt: now + 3_600_000, lastError: reserved.reason });
      continue;
    }
    for (const tag of tags) {
      await store.tags.patch(tag._id, {
        claimToken,
        leaseUntil: now + GROUPING_LEASE_MS,
        nextAttemptAt: now + GROUPING_LEASE_MS,
        attempts: tag.attempts + 1,
      });
    }
    return { projectId: due.projectId, claimToken, tags: claimed, groups, settings, hold: reserved.hold };
  }
  return null;
}

/** Whether the project's settings are still the ones the claim was made under. */
async function sameSettings(store: Store, claim: GroupingClaim): Promise<boolean> {
  const now = await store.aiSettings.find(claim.projectId);
  return (now?.epoch ?? 0) === (claim.settings?.epoch ?? 0) && (now === null) === (claim.settings === null);
}

/** Applies a model's answer to the tags this claim still holds. One transaction. Returns how many tags it changed. */
export async function applyGrouping(store: Store, claim: GroupingClaim, answer: GroupingAnswer, now: number): Promise<number> {
  if (!(await sameSettings(store, claim))) {
    // Settings changed meanwhile: the answer came from a connection no longer chosen.
    await release(store, claim, now, null);
    return 0;
  }
  const existing = new Set((await store.tagGroups.list(claim.projectId, MAX_GROUPS)).map((group) => group._id));
  let changed = 0;
  for (const claimed of claim.tags) {
    const tag = await store.tags.find(claim.projectId, claimed.key);
    if (tag === null || tag.claimToken !== claim.claimToken || tag.grouping !== "pending" || tag.epoch !== claimed.epoch) continue;
    const assignment = answer.assignments.get(claimed.key);
    if (assignment === undefined) {
      // The model skipped this tag; it is tried again later.
      await failOne(store, tag, "The model didn't place this tag.", now);
      continue;
    }
    const groupIds = assignment.groupIds.filter((id) => existing.has(id));
    for (const name of assignment.newGroups) {
      const id = await ensureGroup(store, claim.projectId, name, "ai", now);
      if (id !== null && !groupIds.includes(id)) {
        groupIds.push(id);
        existing.add(id);
      }
    }
    await store.tags.patch(tag._id, { groupIds, grouping: "ai", claimToken: "", leaseUntil: 0, lastError: "" });
    changed++;
  }
  return changed;
}

async function failOne(store: Store, tag: { _id: string; attempts: number }, message: string, now: number) {
  const giveUp = tag.attempts >= MAX_GROUPING_ATTEMPTS;
  await store.tags.patch(tag._id, {
    ...(giveUp ? { grouping: "none" as const } : { nextAttemptAt: now + RETRY_MS[Math.min(tag.attempts - 1, RETRY_MS.length - 1)]! }),
    claimToken: "",
    leaseUntil: 0,
    lastError: message,
  });
}

/** Records a failed run for the tags it still holds: they retry later, or stop after the last attempt. One transaction. */
export async function failGrouping(store: Store, claim: GroupingClaim, message: string, now: number): Promise<void> {
  for (const claimed of claim.tags) {
    const tag = await store.tags.find(claim.projectId, claimed.key);
    if (tag === null || tag.claimToken !== claim.claimToken || tag.grouping !== "pending") continue;
    await failOne(store, tag, message, now);
  }
}

/** Gives claimed tags back without counting an attempt. */
async function release(store: Store, claim: GroupingClaim, now: number, message: string | null) {
  for (const claimed of claim.tags) {
    const tag = await store.tags.find(claim.projectId, claimed.key);
    if (tag === null || tag.claimToken !== claim.claimToken || tag.grouping !== "pending") continue;
    await store.tags.patch(tag._id, { claimToken: "", leaseUntil: 0, nextAttemptAt: now, attempts: Math.max(0, tag.attempts - 1), ...(message === null ? {} : { lastError: message }) });
  }
}

/** Puts a project's tags that waited for AI back in line, once its owner connects AI. Bounded; one transaction. */
export async function requeueUngrouped(store: Store, projectId: string, now: number): Promise<void> {
  for (const tag of await store.tags.inState(projectId, "none", 200)) {
    await store.tags.patch(tag._id, { grouping: "pending", attempts: 0, nextAttemptAt: now, lastError: "" });
  }
}

/** What a grouping run needs from its backend: each step its own transaction, and a model for a connection. */
export interface GroupingSteps extends Pick<CreditSteps, "settle"> {
  claim(claimToken: string): Promise<GroupingClaim | null>;
  apply(claim: GroupingClaim, answer: GroupingAnswer): Promise<number>;
  fail(claim: GroupingClaim, message: string): Promise<void>;
  model(connection: Extract<ResolvedConnection, { ready: true }>): StructuredModel;
  deployment: AiDeployment;
}

/** Groups one project's due tags. Returns false when nothing was due. */
export async function groupOnce(steps: GroupingSteps): Promise<boolean> {
  const claim = await steps.claim(crypto.randomUUID());
  if (claim === null) return false;
  const giveUp = async (message: string) => {
    if (claim.hold !== null) await steps.settle(claim.hold, null);
    await steps.fail(claim, message);
    return true;
  };
  try {
    const chosen = connectionOf("project", claim.projectId, claim.settings, steps.deployment);
    if (!chosen.ok) return await giveUp(chosen.reason);
    const connection = await resolveConnection(chosen, steps.deployment);
    if (!connection.ready) return await giveUp(connection.reason);
    const { output: answer } = await askHeld(steps, claim.hold, chosen, steps.model(connection), groupingRequest({ tags: claim.tags, groups: claim.groups }));
    await steps.apply(claim, answer);
  } catch (error) {
    const failure = toAiError(error);
    return await giveUp(failure.message || aiErrorMessage(failure.code));
  }
  return true;
}

/** Runs grouping until nothing is due, at most `rounds` projects. */
export async function groupDueTags(steps: GroupingSteps, rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round++) if (!(await groupOnce(steps))) return;
}
