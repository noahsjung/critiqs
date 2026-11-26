import { AI_PROVIDERS, type AiChoiceView, type AiSettingsView, type AiTestResult, type PersonalAiSettingsView, type PersonalAiUsage } from "@critiqs/core";
import { CritiqsError, fail } from "../errors.ts";
import { personalUsageSummary, planFor, usageDay } from "../limits.ts";
import { currentReviewer, requireProject, requireUser } from "../operations.ts";
import { personalQuota, projectAccess } from "../organizations.ts";
import type { AiSettingsRecord, Identity, PersonalAiSettingsRecord, Store, StoredConnection } from "../store.ts";
import { askPaid, type CreditSteps, includesPersonalAi, NO_PERSONAL_AI } from "./credits.ts";
import { requeueUngrouped } from "./grouping.ts";
import { MODEL_LISTS_PER_MINUTE } from "./model-lists.ts";
import { accessCheck, toAiError, type StructuredModel } from "./model.ts";
import { testRequest } from "./prompts.ts";
import {
  type AiDeployment,
  type ChosenConnection,
  chooseConnection,
  type ConnectionSource,
  connectionOf,
  connectionStatus,
  checkManagedChoice,
  disallowedDefault,
  draftConnection,
  mergeConnection,
  offeredModels,
  personalSettingsView,
  type PreparedSettings,
  prepareSettings,
  type ResolvedConnection,
  type SettingsInput,
  resolveConnection,
  settingsView,
} from "./settings.ts";

// A project's AI settings, for its owner only; a person's own AI settings,
// for that person only; and the connection test, which uses the same
// resolution and model path as grouping, search, and mockups.

export const TESTS_PER_MINUTE = 10;

/** The project, its settings, and the signed-in person who manages it; anyone else is refused. One transaction. */
export async function requireAiManager(store: Store, identity: Identity | null, projectId: string) {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", "Only the person who set up this project can change its AI settings.");
  return { user, project, settings: await store.aiSettings.find(project._id) };
}

/** The settings as those who manage the project see them. Reads only, so it runs in queries. */
export async function getAiSettings(store: Store, identity: Identity | null, args: { projectId: string }, deployment: AiDeployment): Promise<AiSettingsView> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user?._id ?? null)) !== "manage") fail("forbidden", "Only the person who set up this project can change its AI settings.");
  return settingsView(await store.aiSettings.find(project._id), deployment);
}

/** Changing settings clears fields left out, and their last test: a store leaves fields given as undefined unchanged. */
function cleared(record: StoredConnection) {
  return {
    enabled: record.enabled,
    mode: record.mode,
    epoch: record.epoch,
    updatedAt: record.updatedAt,
    managedModel: record.managedModel ?? null,
    provider: record.provider ?? null,
    model: record.model ?? null,
    models: record.models ?? null,
    baseUrl: record.baseUrl ?? null,
    secret: record.secret ?? null,
    lastTest: null,
  };
}

/**
 * Stores settings already checked and sealed by `prepareSettings` and
 * `sealKey`. A saved key is kept only for the same provider and address;
 * the usage rule, models, and allowed models a client left out keep their
 * saved values. Every change starts a new epoch, so grouping already under
 * way under the old settings can't apply. One transaction.
 */
export async function applyAiSettings(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; prepared: PreparedSettings },
  deployment: AiDeployment,
  now: number,
): Promise<AiSettingsView> {
  const { user, project, settings } = await requireAiManager(store, identity, args.projectId);
  const { prepared } = args;
  // `sealKey` replaces a typed key with its ciphertext and drops the plain text.
  if (prepared.plainKey !== undefined) {
    throw new Error("A key must be sealed before it is stored.");
  }
  checkManagedChoice(settings, prepared, deployment);
  const connection = mergeConnection(settings, prepared);
  const rule = prepared.rule ?? settings?.rule;
  const allowedModels = prepared.allowedModels ?? settings?.allowedModels ?? [];
  // AI left on with Critiqs AI must use a model the project allows, as saved with this save's changes, however the
  // two were set: turning AI off is never refused, nor is a model the deployment no longer lists when none was chosen.
  const disallowed = connection.enabled && connection.mode === "managed" ? disallowedDefault(connection, allowedModels) : null;
  if (disallowed !== null) fail("invalid", disallowed);
  const record: Omit<AiSettingsRecord, "_id"> = {
    projectId: project._id,
    ...connection,
    ...(rule === undefined ? {} : { rule }),
    ...(allowedModels.length === 0 ? {} : { allowedModels }),
    epoch: (settings?.epoch ?? 0) + 1,
    updatedAt: now,
    updatedBy: user._id,
  };
  if (settings === null) await store.aiSettings.insert(record);
  else await store.aiSettings.patch(settings._id, { ...cleared(record), updatedBy: record.updatedBy, rule: record.rule ?? null, allowedModels: record.allowedModels ?? null });
  const saved = await store.aiSettings.find(project._id);
  if (connectionStatus(saved, deployment).ready) await requeueUngrouped(store, project._id, now);
  return settingsView(saved, deployment);
}

/** Before a test: the owner's settings, counted against the owner's per-minute limit. One transaction. */
export async function prepareTest(store: Store, identity: Identity | null, args: { projectId: string }, _deployment: AiDeployment, now: number) {
  const { user, project, settings } = await requireAiManager(store, identity, args.projectId);
  await limitTests(store, user._id, now);
  return { source: "project" as const, ownerId: project._id, settings };
}

async function limitTests(store: Store, userId: string, now: number) {
  if (!(await store.rateLimits.hit(`ai-test:${userId}`, TESTS_PER_MINUTE, 60_000, now))) {
    fail("limit", "Too many connection tests in a minute. Wait a moment and try again.");
  }
}

/**
 * Records a test of the saved settings, unless they changed meanwhile, if the
 * person testing still manages the project: they may have lost that while
 * the test ran. One transaction.
 */
export async function recordTest(store: Store, identity: Identity | null, args: { projectId: string; epoch: number; result: AiTestResult }, now: number): Promise<void> {
  const { settings } = await requireAiManager(store, identity, args.projectId);
  if (settings === null || settings.epoch !== args.epoch) return;
  await store.aiSettings.patch(settings._id, { lastTest: { ok: args.result.ok, at: now, message: args.result.message } });
}

// ---------------------------------------------------------------------------
// A person's own AI settings. Each operation acts on the signed-in person's
// own settings only; there is no way to name someone else's.

/** The signed-in person's own AI settings, as they see them. Reads only, so it runs in queries. */
export async function getPersonalAiSettings(store: Store, identity: Identity | null, deployment: AiDeployment): Promise<PersonalAiSettingsView> {
  const { user } = await currentReviewer(store, identity);
  return personalSettingsView(user === null ? null : await store.personalAiSettings.find(user._id), deployment);
}

/**
 * The signed-in person's own Critiqs AI credits against their plan, in the
 * periods containing `day` (a UTC day the client chooses, so a reactive query
 * follows the clock); null on a deployment without plans. There is no way to
 * name someone else. Reads only, so it runs in queries.
 */
export async function getPersonalAiUsage(store: Store, identity: Identity | null, args: { day?: string }): Promise<PersonalAiUsage | null> {
  const { user } = await currentReviewer(store, identity);
  const userId = user?._id ?? null;
  const quota = userId === null ? { plan: await planFor(store, null), accountId: null } : await personalQuota(store, userId);
  return await personalUsageSummary(store, quota, usageDay(args.day, Date.now()));
}

/** The signed-in person, created from their sign-in if needed, whose own key a save binds to. One transaction. */
export async function requirePersonalAiOwner(store: Store, identity: Identity | null): Promise<{ userId: string }> {
  return { userId: (await requireUser(store, identity))._id };
}

/**
 * Stores the signed-in person's own settings, already checked and sealed for
 * them (`keyBinding("personal", userId)`). Critiqs AI is refused when their
 * plan doesn't include it. One transaction.
 */
export async function applyPersonalAiSettings(
  store: Store,
  identity: Identity | null,
  args: { prepared: PreparedSettings },
  deployment: AiDeployment,
  now: number,
): Promise<PersonalAiSettingsView> {
  const user = await requireUser(store, identity);
  const { prepared } = args;
  // `sealKey` replaces a typed key with its ciphertext and drops the plain text.
  if (prepared.plainKey !== undefined) {
    throw new Error("A key must be sealed before it is stored.");
  }
  if (prepared.enabled && prepared.mode === "managed" && !includesPersonalAi((await personalQuota(store, user._id)).plan)) fail("limit", NO_PERSONAL_AI);
  const settings = await store.personalAiSettings.find(user._id);
  checkManagedChoice(settings, prepared, deployment);
  const record: Omit<PersonalAiSettingsRecord, "_id"> = {
    userId: user._id,
    ...mergeConnection(settings, prepared),
    epoch: (settings?.epoch ?? 0) + 1,
    updatedAt: now,
  };
  if (settings === null) await store.personalAiSettings.insert(record);
  else await store.personalAiSettings.patch(settings._id, cleared(record));
  return personalSettingsView(await store.personalAiSettings.find(user._id), deployment);
}

/** Removes the signed-in person's own settings and key; their requests then follow each project's rule without them. One transaction. */
export async function removePersonalAiSettings(store: Store, identity: Identity | null, deployment: AiDeployment): Promise<PersonalAiSettingsView> {
  const user = await requireUser(store, identity);
  const settings = await store.personalAiSettings.find(user._id);
  if (settings !== null) await store.personalAiSettings.delete(settings._id);
  return personalSettingsView(null, deployment);
}

/** Before a test of the person's own connection: their settings, under the same per-minute limit as project tests. One transaction. */
export async function preparePersonalTest(store: Store, identity: Identity | null, now: number) {
  const user = await requireUser(store, identity);
  await limitTests(store, user._id, now);
  return { source: "personal" as const, ownerId: user._id, settings: await store.personalAiSettings.find(user._id) };
}

/** Records a test of the person's saved settings, unless they changed meanwhile. One transaction. */
export async function recordPersonalTest(store: Store, args: { userId: string; epoch: number; result: AiTestResult }, now: number): Promise<void> {
  const settings = await store.personalAiSettings.find(args.userId);
  if (settings === null || settings.epoch !== args.epoch) return;
  await store.personalAiSettings.patch(settings._id, { lastTest: { ok: args.result.ok, at: now, message: args.result.message } });
}

// ---------------------------------------------------------------------------
// Model lists, and the model choice a person's requests have

async function limitModelLists(store: Store, userId: string, now: number) {
  if (!(await store.rateLimits.hit(`ai-models:${userId}`, MODEL_LISTS_PER_MINUTE, 60_000, now))) {
    fail("limit", "Too many model lists in a minute. Wait a moment and try again.");
  }
}

/** Before listing a project's provider's models: the owner's settings, counted against the owner's per-minute limit. One transaction. */
export async function prepareModelList(store: Store, identity: Identity | null, args: { projectId: string }, now: number) {
  const { user, project, settings } = await requireAiManager(store, identity, args.projectId);
  await limitModelLists(store, user._id, now);
  return { source: "project" as const, ownerId: project._id, settings };
}

/**
 * Checks the person still manages the project, before a request with its
 * settings is sent and before what came back, a connection test's result or
 * its provider's model list, is returned to them. One transaction.
 */
export async function recheckAiManager(store: Store, identity: Identity | null, args: { projectId: string }): Promise<void> {
  await requireAiManager(store, identity, args.projectId);
}

/** Before listing the person's own provider's models: their settings, under the same per-minute limit. One transaction. */
export async function preparePersonalModelList(store: Store, identity: Identity | null, now: number) {
  const user = await requireUser(store, identity);
  await limitModelLists(store, user._id, now);
  return { source: "personal" as const, ownerId: user._id, settings: await store.personalAiSettings.find(user._id) };
}

/**
 * Which connection the signed-in person's requests in a project would use,
 * by the project's AI usage rule, and the models they may name. Never a key
 * or an address. Reads only, so it runs in queries.
 */
export async function getAiChoice(store: Store, identity: Identity | null, args: { projectId: string }, deployment: AiDeployment): Promise<AiChoiceView> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const choice = chooseConnection(
    {
      projectId: project._id,
      project: await store.aiSettings.find(project._id),
      // Someone not yet recorded has no settings of their own.
      person: { userId: user?._id ?? "", settings: user === null ? null : await store.personalAiSettings.find(user._id) },
    },
    deployment,
  );
  if (!choice.ok) {
    return { source: null, models: [], defaultModel: null, reason: choice.reason, ...(choice.code === "setup-ai" ? { reasonCode: "setup-ai" as const } : {}) };
  }
  return { source: choice.source, models: offeredModels(choice, deployment), defaultModel: choice.managedModel?.id ?? choice.model };
}

// ---------------------------------------------------------------------------
// Connection tests

export interface TestSteps extends CreditSteps {
  /** Whose settings are tested: the project's, checking its owner, or the signed-in person's own. */
  prepare(): Promise<{ source: ConnectionSource; ownerId: string; settings: StoredConnection | null }>;
  record(epoch: number, result: AiTestResult): Promise<void>;
  /**
   * For a project's test, checks the person still manages it (see
   * `recheckAiManager`): before each attempt to send the test request, and
   * before any result, of saved settings or a draft, is returned. Throws if not.
   */
  recheck?(): Promise<void>;
  model(connection: Extract<ResolvedConnection, { ready: true }>): StructuredModel;
  deployment: AiDeployment;
}

/**
 * Tests a connection with a short structured request: the key works, the
 * model exists, and it returns structured output. Tests the saved settings,
 * or a draft before it is saved (whose typed key is used only for the test).
 */
export async function testConnection(steps: TestSteps, draft?: SettingsInput): Promise<AiTestResult> {
  const result = await tested(steps, draft);
  await steps.recheck?.();
  return result;
}

async function tested(steps: TestSteps, draft?: SettingsInput): Promise<AiTestResult> {
  const { source, ownerId, settings } = await steps.prepare();
  let connection: ResolvedConnection;
  let tested: ChosenConnection | null;
  try {
    if (draft === undefined) {
      const choice = connectionOf(source, ownerId, settings, steps.deployment);
      tested = choice.ok ? choice : null;
      connection = choice.ok ? await resolveConnection(choice, steps.deployment) : { ready: false, reason: choice.reason };
    } else {
      ({ connection, chosen: tested } = await draftConnection(source, ownerId, settings, await prepareSettings({ ...draft, enabled: true }, steps.deployment), steps.deployment));
    }
  } catch (error) {
    return { ok: false, code: "config", message: error instanceof Error ? error.message : "These settings aren't valid." };
  }
  if (!connection.ready) return { ok: false, code: "config", message: connection.reason };
  let result: AiTestResult;
  const access = steps.recheck === undefined ? null : accessCheck(steps.recheck);
  const request = access === null ? testRequest() : { ...testRequest(), beforeSend: access.beforeSend };
  try {
    const model = steps.model(connection);
    if (tested === null) await model.generate(request);
    else await askPaid(steps, tested, model, request);
    result = {
      ok: true,
      message:
        tested?.managedModel != null
          ? `Connected to Critiqs AI (${tested.managedModel.label}); structured answers work.`
          : `Connected to ${AI_PROVIDERS.find((entry) => entry.id === connection.provider)!.label} with ${connection.model}; structured answers work.`,
    };
  } catch (error) {
    access?.rethrow();
    if (error instanceof CritiqsError) throw error;
    const failure = toAiError(error);
    result = { ok: false, code: failure.code, message: failure.message };
  }
  if (draft === undefined) await steps.record(connection.epoch, result);
  return result;
}
