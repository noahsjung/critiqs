import {
  AI_PROVIDERS,
  type AiConnectionInput,
  type AiChoiceView,
  type AiConnectionView,
  type AiProvider,
  type AiRule,
  type AiSettingsInput,
  type AiSettingsView,
  type ManagedModelInfo,
  type PersonalAiSettingsView,
} from "@critiqs/core";
import { fail } from "../errors.ts";
import type { AiSettingsRecord, PersonalAiSettingsRecord, StoredAiProvider, StoredConnection } from "../store.ts";
import { type ModelPrice, pricedCredits, REFERENCE_USAGE } from "./credits.ts";
import { checkEndpoint, type EndpointPolicy } from "./endpoints.ts";
import { decryptSecret, encryptSecret, keyBinding, validEncryptionKey } from "./secrets.ts";

// Each project, and each person, may connect to AI in one of two ways:
// Critiqs AI, a model from the list a deployment's operator offers (Critiqs
// Cloud's default), or their own key: OpenAI, Anthropic, Google Gemini,
// Vercel AI Gateway, or an OpenAI-compatible endpoint. A project's settings
// are seen and changed only by its owner, who also picks whose connection the
// requests people start use (`chooseConnection`); a person's only by that
// person. A failed request reports its error; Critiqs never falls back to
// another connection. Turning a project's AI off keeps basic search and
// manual grouping working.

/** One connection: a provider, its model, an optional address, and its key. */
export interface AiConnectionConfig {
  provider: StoredAiProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/** A Critiqs AI model the operator offers. */
export interface ManagedModel extends ManagedModelInfo {
  /** The provider's name for the model; never shown to people. */
  model: string;
  /** With a price, requests cost their real token use and `credits` is the estimate shown. */
  price?: ModelPrice;
}

/** Critiqs-managed AI: one provider and key, and the models offered with it; the first is the default. */
export interface ManagedAi {
  provider: StoredAiProvider;
  apiKey?: string;
  baseUrl?: string;
  models: ManagedModel[];
}

/** What a deployment's operator set up for AI. Never sent to browsers whole. */
export interface AiDeployment {
  /** Critiqs-managed AI, available to every project and person. */
  managed: ManagedAi | null;
  /** Why Critiqs-managed AI is off although the operator turned it on, for health checks. */
  managedProblem?: string | null;
  /** A provider the operator configured for projects that save none. */
  defaultProvider: AiConnectionConfig | null;
  /** Encrypts keys entered in Critiqs; without it, keys can't be saved. */
  encryptionKey: string | null;
  endpoints: EndpointPolicy;
}

export const NO_AI: AiDeployment = { managed: null, defaultProvider: null, encryptionKey: null, endpoints: { allowed: [], allowLocal: false } };

const PROVIDER_IDS = AI_PROVIDERS.map((provider) => provider.id);

function isProvider(value: string | undefined): value is AiProvider {
  return value !== undefined && (PROVIDER_IDS as string[]).includes(value);
}

function connectionFrom(provider: string | undefined, model: string | undefined, apiKey: string | undefined, baseUrl: string | undefined) {
  if (!isProvider(provider) || !model) return null;
  return { provider, model, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
}

/** A model's name as a provider writes it, such as gpt-5-mini or anthropic/claude-sonnet-4.5. */
export const MODEL_PATTERN = /^[\w.:/@+-]{1,200}$/;
const MANAGED_ID_PATTERN = /^[A-Za-z0-9][\w-]{0,39}$/;
const MANAGED_FIELDS = ["id", "label", "model", "credits", "price"];
const MAX_USD_PER_MILLION_TOKENS = 1000;
export const MAX_MANAGED_MODELS = 20;
/** Most models one own connection may offer. */
export const MAX_CONNECTION_MODELS = 50;

/** Reads a model's price, `{ input, output }` in US dollars per million tokens, or says what is wrong with it. */
export function parseModelPrice(value: unknown, where: string): ModelPrice | string {
  const problem = `${where} must be { "input", "output" }: US dollars per million tokens, each from 0 to ${MAX_USD_PER_MILLION_TOKENS}.`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return problem;
  if (Object.keys(value).some((key) => key !== "input" && key !== "output")) return problem;
  const { input, output } = value as Record<string, unknown>;
  const valid = (amount: unknown): amount is number => typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= MAX_USD_PER_MILLION_TOKENS;
  return valid(input) && valid(output) ? { input, output } : problem;
}

function priced(model: Omit<ManagedModel, "credits" | "price" | "estimated">, price: ModelPrice): ManagedModel {
  return { ...model, credits: pricedCredits(price, REFERENCE_USAGE), estimated: true, price };
}

/**
 * Reads `CRITIQS_MANAGED_AI_MODELS`: a JSON list of `{ id, label, model }`,
 * each with either flat `credits` per request or a `price` per million
 * tokens. Returns the models, or what is wrong with the setting.
 */
export function parseManagedModels(raw: string): ManagedModel[] | string {
  const name = "CRITIQS_MANAGED_AI_MODELS";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return `${name} isn't valid JSON.`;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MANAGED_MODELS) {
    return `${name} must be a list of 1 to ${MAX_MANAGED_MODELS} models, each { "id", "label", "model" } with "credits" or "price".`;
  }
  const models: ManagedModel[] = [];
  for (const [index, entry] of value.entries()) {
    const where = `${name}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `${where} must be an object with id, label, model, and credits or price.`;
    const unexpected = Object.keys(entry).filter((key) => !MANAGED_FIELDS.includes(key));
    if (unexpected.length > 0) return `${where} has unexpected ${unexpected.join(", ")}.`;
    const { id, label, model, credits, price } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !MANAGED_ID_PATTERN.test(id)) return `${where}.id must be 1 to 40 letters, digits, - or _.`;
    if (models.some((other) => other.id === id)) return `${where}.id repeats "${id}".`;
    if (typeof label !== "string" || label.trim() === "" || label.length > 60) return `${where}.label must be text of 1 to 60 characters.`;
    if (typeof model !== "string" || !MODEL_PATTERN.test(model)) return `${where}.model must be the provider's name for the model.`;
    const named = { id, label: label.trim(), model };
    if (price !== undefined) {
      if (credits !== undefined) return `${where} has both credits and price; give one.`;
      const parsed = parseModelPrice(price, `${where}.price`);
      if (typeof parsed === "string") return parsed;
      models.push(priced(named, parsed));
      continue;
    }
    if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 1 || credits > 1000) return `${where}.credits must be a whole number from 1 to 1000.`;
    models.push({ ...named, credits });
  }
  return models;
}

function singleModel(model: string, rawPrice: string | undefined): ManagedModel[] | string {
  const named = { id: "default", label: "Critiqs AI", model };
  if (!rawPrice) return [{ ...named, credits: 1 }];
  let value: unknown;
  try {
    value = JSON.parse(rawPrice);
  } catch {
    return "CRITIQS_MANAGED_AI_PRICE isn't valid JSON.";
  }
  const price = parseModelPrice(value, "CRITIQS_MANAGED_AI_PRICE");
  return typeof price === "string" ? price : [priced(named, price)];
}

/** Critiqs-managed AI from a Convex deployment's environment, or why it is off although turned on. */
function managedFromEnv(env: Record<string, string | undefined>): { managed: ManagedAi | null; problem: string | null } {
  if (env.CRITIQS_MANAGED_AI !== "enabled") return { managed: null, problem: null };
  const provider = env.CRITIQS_MANAGED_AI_PROVIDER;
  if (!isProvider(provider)) return { managed: null, problem: `CRITIQS_MANAGED_AI_PROVIDER must be one of ${PROVIDER_IDS.join(", ")}.` };
  const apiKey = env.CRITIQS_MANAGED_AI_API_KEY || undefined;
  if (apiKey === undefined && provider !== "compatible") return { managed: null, problem: "CRITIQS_MANAGED_AI_API_KEY isn't set." };
  const models = env.CRITIQS_MANAGED_AI_MODELS
    ? parseManagedModels(env.CRITIQS_MANAGED_AI_MODELS)
    : env.CRITIQS_MANAGED_AI_MODEL
      ? singleModel(env.CRITIQS_MANAGED_AI_MODEL, env.CRITIQS_MANAGED_AI_PRICE)
      : "Set CRITIQS_MANAGED_AI_MODELS, or CRITIQS_MANAGED_AI_MODEL for a single model.";
  if (typeof models === "string") return { managed: null, problem: models };
  const baseUrl = env.CRITIQS_MANAGED_AI_BASE_URL || undefined;
  return { managed: { provider, models, ...(apiKey === undefined ? {} : { apiKey }), ...(baseUrl === undefined ? {} : { baseUrl }) }, problem: null };
}

/** A deployment's AI from its environment, as Convex deployments are configured. */
export function aiDeploymentFromEnv(env: Record<string, string | undefined>): AiDeployment {
  const { managed, problem } = managedFromEnv(env);
  return {
    managed,
    managedProblem: problem,
    defaultProvider: connectionFrom(env.CRITIQS_AI_PROVIDER, env.CRITIQS_AI_MODEL, env.CRITIQS_AI_API_KEY, env.CRITIQS_AI_BASE_URL),
    encryptionKey: validEncryptionKey(env.CRITIQS_AI_ENCRYPTION_KEY) ? env.CRITIQS_AI_ENCRYPTION_KEY! : null,
    endpoints: {
      allowed: (env.CRITIQS_AI_ALLOWED_ENDPOINTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
      allowLocal: env.CRITIQS_AI_LOCAL_ENDPOINTS === "enabled",
    },
  };
}

/** The deployment's Critiqs AI models as people see them: never the provider's model names. */
export function managedModelList(deployment: AiDeployment): ManagedModelInfo[] {
  return (deployment.managed?.models ?? []).map(modelInfo);
}

function modelInfo({ id, label, credits, estimated }: ManagedModel): ManagedModelInfo {
  return { id, label, credits, ...(estimated ? { estimated } : {}) };
}

/** Whose settings a connection is: a project's or a person's own. */
export type ConnectionSource = "project" | "personal";

/** Who a request's Critiqs AI credits count against; `none` for an own key. */
export type Payer = "project" | "person" | "none";

/** The message a request gets when the project's rule needs the person's own AI and they have none ready. */
export const SETUP_AI = "Set up your AI to use this.";

/** A connection ready to use, or why there is none. */
export type ResolvedConnection =
  | {
      ready: true;
      mode: "managed" | "own";
      provider: StoredAiProvider;
      model: string;
      baseUrl: string | null;
      apiKey: string | undefined;
      /**
       * The address may use plain HTTP: the operator configured it, or allowed
       * local endpoints and the address passed that policy.
       */
      trustedEndpoint: boolean;
      /** The settings' epoch, so work that started under older settings can tell. */
      epoch: number;
    }
  | { ready: false; reason: string };

const needsKey = (provider: StoredAiProvider) => AI_PROVIDERS.find((entry) => entry.id === provider)!.needsKey;

/** Where people change each kind of settings, for messages. */
const WHERE: Record<ConnectionSource, string> = { project: "AI settings", personal: "Your AI" };

type Inspected =
  | { kind: "managed"; managed: ManagedAi }
  | { kind: "default"; config: AiConnectionConfig }
  | { kind: "own"; record: StoredConnection; httpAllowed: boolean }
  | { kind: "none"; reason: string };

/** Which way one connection works, and whether it can, before any key is decrypted. */
function inspect(source: ConnectionSource, record: StoredConnection | null, deployment: AiDeployment): Inspected {
  const where = WHERE[source];
  // Which Critiqs AI model a request uses is `pickManagedModel`'s choice.
  const managed = (): Inspected => {
    if (deployment.managed === null) {
      return {
        kind: "none",
        reason:
          source === "project"
            ? "Critiqs-managed AI isn't available on this deployment. The project's owner can connect their own provider."
            : "Critiqs AI isn't available on this deployment. Connect your own key in Your AI.",
      };
    }
    return { kind: "managed", managed: deployment.managed };
  };
  if (record === null) {
    // Everyone has Critiqs AI until they choose otherwise, where the deployment offers it.
    if (deployment.managed !== null) return managed();
    if (source === "personal") return { kind: "none", reason: SETUP_AI };
    if (deployment.defaultProvider !== null) return { kind: "default", config: deployment.defaultProvider };
    return { kind: "none", reason: "AI isn't set up for this project. Its owner can connect a provider in AI settings." };
  }
  if (!record.enabled) return { kind: "none", reason: source === "project" ? "AI is turned off for this project." : "Your AI is turned off." };
  if (record.mode === "managed") return managed();
  if (record.provider === undefined) {
    // The operator's provider serves projects that save none, never a person's own connection.
    return source === "project" && deployment.defaultProvider !== null
      ? { kind: "default", config: deployment.defaultProvider }
      : { kind: "none", reason: `Choose a provider in ${where}.` };
  }
  if (!record.model) return { kind: "none", reason: `Enter the model to use in ${where}.` };
  if (record.provider === "compatible" && !record.baseUrl) return { kind: "none", reason: `Enter the endpoint's address in ${where}.` };
  let httpAllowed = false;
  if (record.baseUrl) {
    // The allowlist may have changed since the address was saved.
    const checked = checkEndpoint(record.baseUrl, deployment.endpoints);
    if (!checked.ok) return { kind: "none", reason: checked.reason };
    // Plain HTTP passes the check only where the operator allowed local endpoints.
    httpAllowed = checked.url.startsWith("http:");
  }
  if (record.secret !== undefined && deployment.encryptionKey === null) {
    return { kind: "none", reason: "The saved key can't be read: this deployment's encryption key isn't set. Ask its operator to restore it." };
  }
  if (record.secret === undefined && needsKey(record.provider)) return { kind: "none", reason: `Add the provider's API key in ${where}.` };
  return { kind: "own", record, httpAllowed };
}

/** The models an own connection offers: its picked models, or only its default. */
export function connectionModels(record: StoredConnection | null): string[] {
  if (record?.model === undefined) return [];
  return record.models !== undefined && record.models.length > 0 ? record.models : [record.model];
}

/** The connection a request uses, its payer, and its model, chosen before any key is decrypted. */
export interface ChosenConnection {
  source: ConnectionSource;
  /** The project's or the person's ID; a saved key is bound to it. */
  ownerId: string;
  kind: "managed" | "default" | "own";
  payer: Payer;
  /** The provider's name for the model this request uses. */
  model: string;
  /** The Critiqs AI model, when it is one. */
  managedModel: ManagedModelInfo | null;
  /** Critiqs AI credits one request costs its payer when its model has no price; 0 for an own key. */
  credits: number;
  /** The Critiqs AI model's price, when requests cost their real token use. */
  price: ModelPrice | null;
  /** The settings, keys still encrypted; null when the project saved none. */
  settings: StoredConnection | null;
}

/** A chosen connection, or why the request is refused: `setup-ai` asks the person to set up Your AI. */
export type ConnectionChoice = ({ ok: true } & ChosenConnection) | { ok: false; code: "setup-ai" | "unavailable" | "invalid"; reason: string };

/**
 * One connection as a request would use it, with the model it names or the
 * connection's default. A project's Critiqs AI is limited to the models its
 * owner allows; a person's isn't.
 */
export function connectionOf(source: ConnectionSource, ownerId: string, record: StoredConnection | null, deployment: AiDeployment, requested?: string): ConnectionChoice {
  const inspected = inspect(source, record, deployment);
  if (inspected.kind === "none") return { ok: false, code: "unavailable", reason: inspected.reason };
  const base = { ok: true as const, source, ownerId, kind: inspected.kind, settings: record };
  if (inspected.kind === "managed") {
    const picked = pickManagedModel(source, record, inspected.managed, requested);
    if (!picked.ok) return picked;
    const { credits, model, price } = picked.model;
    return { ...base, payer: source === "project" ? "project" : "person", model, managedModel: modelInfo(picked.model), credits, price: price ?? null };
  }
  const offered = inspected.kind === "default" ? [inspected.config.model] : connectionModels(inspected.record);
  const model = requested ?? (inspected.kind === "default" ? inspected.config.model : inspected.record.model!);
  if (!offered.includes(model)) return { ok: false, code: "invalid", reason: `This connection doesn't offer that model. Its models are chosen in ${WHERE[source]}.` };
  return { ...base, payer: "none", model, managedModel: null, credits: 0, price: null };
}

/** The models a request with this connection may name, in the order offered: what the person choosing sees. */
export function offeredModels(chosen: ChosenConnection, deployment: AiDeployment): AiChoiceView["models"] {
  if (chosen.kind === "managed") {
    const allowedIds = chosen.source === "project" ? ((chosen.settings as AiSettingsRecord | null)?.allowedModels ?? []) : [];
    return managedModelList(deployment).filter((entry) => allowedIds.length === 0 || allowedIds.includes(entry.id));
  }
  const ids = chosen.kind === "default" ? [chosen.model] : connectionModels(chosen.settings);
  return ids.map((id) => ({ id, label: id }));
}

/**
 * The Critiqs AI model a request uses: the one it names, when offered and,
 * for the project's connection, allowed; otherwise the saved model when still
 * offered and allowed, else the first allowed model when the project limits
 * them. A person's own Critiqs AI isn't limited by the project.
 */
function pickManagedModel(
  source: ConnectionSource,
  record: StoredConnection | null,
  managed: ManagedAi,
  requested: string | undefined,
): { ok: true; model: ManagedModel } | { ok: false; code: "invalid" | "unavailable"; reason: string } {
  const all = managed.models;
  const allowedIds = source === "project" ? ((record as AiSettingsRecord | null)?.allowedModels ?? []) : [];
  const allowed = allowedIds.length === 0 ? all : all.filter((entry) => allowedIds.includes(entry.id));
  if (requested !== undefined) {
    const named = all.find((entry) => entry.id === requested);
    if (named === undefined) return { ok: false, code: "invalid", reason: "Critiqs AI doesn't offer that model." };
    if (!allowed.includes(named)) return { ok: false, code: "invalid", reason: `This project's owner doesn't allow ${named.label} for the project's AI.` };
    return { ok: true, model: named };
  }
  const saved = record?.managedModel === undefined ? all[0] : all.find((entry) => entry.id === record.managedModel);
  if (saved !== undefined && allowed.includes(saved)) return { ok: true, model: saved };
  // The deployment's list changed since the settings were saved.
  if (allowedIds.length > 0) {
    return allowed[0] !== undefined
      ? { ok: true, model: allowed[0] }
      : { ok: false, code: "unavailable", reason: "None of the Critiqs AI models this project allows is offered any more. Its owner can choose others in AI settings." };
  }
  return { ok: false, code: "unavailable", reason: `The Critiqs AI model chosen in ${WHERE[source]} is no longer offered. Choose another.` };
}

/**
 * Why a project's settings can't be saved or tested as they are: a Critiqs
 * AI model its owner chose must be one it allows. Null when they can. Without
 * a chosen model, requests use the first allowed one (`pickManagedModel`).
 */
export function disallowedDefault(connection: Pick<StoredConnection, "mode" | "managedModel">, allowedModels: string[]): string | null {
  if (connection.mode !== "managed" || connection.managedModel === undefined || allowedModels.length === 0) return null;
  return allowedModels.includes(connection.managedModel) ? null : "Allow the project's Critiqs AI model, or choose one of the allowed models.";
}

/** What `chooseConnection` decides from. */
export interface ConnectionRequest {
  projectId: string;
  project: AiSettingsRecord | null;
  /** Who started the request and their own settings; null for background work, such as automatic grouping. */
  person: { userId: string; settings: PersonalAiSettingsRecord | null } | null;
  /** A model the request names: a Critiqs AI model's id, or one of an own connection's models. */
  model?: string;
}

/**
 * Which connection a request uses, and who pays, from the project's AI usage
 * rule (absent means `either`):
 *
 * 1. Background work: the project's connection, or none.
 * 2. A person's request under `project`: the project's connection.
 * 3. Under `personal`: the person's connection, or refused with `setup-ai`.
 *    A person who saved nothing has Critiqs AI on their own plan, where the
 *    deployment offers it.
 * 4. Under `either`: the person's connection when they saved one that is
 *    turned on and ready, otherwise the project's.
 *
 * A project whose AI is turned off uses none, so its owner can keep its
 * feedback away from every provider. Nothing is decrypted here, and a failed
 * request never falls back to another connection.
 */
export function chooseConnection(request: ConnectionRequest, deployment: AiDeployment): ConnectionChoice {
  const project = () => connectionOf("project", request.projectId, request.project, deployment, request.model);
  if (request.person === null) return project();
  if (request.project !== null && !request.project.enabled) return { ok: false, code: "unavailable", reason: "AI is turned off for this project." };
  const rule: AiRule = request.project?.rule ?? "either";
  if (rule === "project") return project();
  const { userId, settings } = request.person;
  // Readiness first, as the person's settings show it; only a ready connection checks the model the request names.
  const personal = connectionOf("personal", userId, settings, deployment);
  // Under `either` the project pays unless the person chose their own.
  if (rule === "either" && settings === null) return project();
  if (personal.ok) return request.model === undefined ? personal : connectionOf("personal", userId, settings, deployment, request.model);
  if (rule === "either") return project();
  // Only a connection the person turned on says more than that it's missing.
  const reason = settings?.enabled ? `${SETUP_AI} ${personal.reason}` : SETUP_AI;
  return { ok: false, code: "setup-ai", reason };
}

/**
 * Makes a chosen connection ready to use. Its own key is decrypted here, so
 * call this only where model calls run, never in what a query returns.
 */
export async function resolveConnection(chosen: ChosenConnection, deployment: AiDeployment): Promise<ResolvedConnection> {
  const inspected = inspect(chosen.source, chosen.settings, deployment);
  const epoch = chosen.settings?.epoch ?? 0;
  if (inspected.kind === "none") return { ready: false, reason: inspected.reason };
  if (inspected.kind === "managed" || inspected.kind === "default") {
    const config = inspected.kind === "managed" ? inspected.managed : inspected.config;
    return {
      ready: true,
      mode: inspected.kind === "managed" ? "managed" : "own",
      provider: config.provider,
      model: chosen.model,
      baseUrl: config.baseUrl ?? null,
      apiKey: config.apiKey,
      trustedEndpoint: true,
      epoch,
    };
  }
  const own = inspected.record;
  let apiKey: string | undefined;
  if (own.secret !== undefined) {
    const key = await decryptSecret(deployment.encryptionKey!, keyBinding(chosen.source, chosen.ownerId), own.secret);
    if (key === null) return { ready: false, reason: `The saved key can't be read, perhaps because the deployment's encryption key changed. Enter the key again in ${WHERE[chosen.source]}.` };
    apiKey = key;
  }
  return { ready: true, mode: "own", provider: own.provider!, model: chosen.model, baseUrl: own.baseUrl ?? null, apiKey, trustedEndpoint: inspected.httpAllowed, epoch };
}

/** The connection a project's own settings make, as background work uses it. */
export async function resolveProjectConnection(projectId: string, record: AiSettingsRecord | null, deployment: AiDeployment): Promise<ResolvedConnection> {
  const chosen = connectionOf("project", projectId, record, deployment);
  return chosen.ok ? await resolveConnection(chosen, deployment) : { ready: false, reason: chosen.reason };
}

/** Whether a connection is usable, without decrypting anything, for what its owner sees. */
export function connectionStatus(record: StoredConnection | null, deployment: AiDeployment, source: ConnectionSource = "project"): AiConnectionView["status"] {
  // The same choice a request without a named model makes, so the two can't disagree.
  const chosen = connectionOf(source, "", record, deployment);
  return chosen.ok ? { ready: true } : { ready: false, reason: chosen.reason };
}

function connectionView(source: ConnectionSource, record: StoredConnection | null, deployment: AiDeployment): AiConnectionView {
  const def = source === "project" ? deployment.defaultProvider : null;
  return {
    // With no saved settings, a project has AI on, under rule `either`, even without a connection of its own; a person has Critiqs AI where it's offered.
    enabled: record?.enabled ?? (source === "project" || deployment.managed !== null),
    mode: record?.mode ?? (deployment.managed !== null ? "managed" : "own"),
    managedModel: record?.managedModel ?? null,
    provider: record?.provider ?? null,
    model: record?.model ?? null,
    models: connectionModels(record),
    baseUrl: record?.baseUrl ?? null,
    keyHint: record?.secret?.hint ?? null,
    deployment: {
      managed: deployment.managed !== null,
      managedModels: managedModelList(deployment),
      defaultProvider: def === null ? null : { provider: def.provider, model: def.model },
      keysStorable: deployment.encryptionKey !== null,
      allowedEndpoints: deployment.endpoints.allowed,
      providers: PROVIDER_IDS,
    },
    status: connectionStatus(record, deployment, source),
    lastTest: record?.lastTest ?? null,
  };
}

/** A project's AI settings as its owner sees them: never a key, only its last four characters. */
export function settingsView(record: AiSettingsRecord | null, deployment: AiDeployment): AiSettingsView {
  return { ...connectionView("project", record, deployment), rule: record?.rule ?? "either", allowedModels: record?.allowedModels ?? [] };
}

/** A person's own AI settings as they see them. */
export function personalSettingsView(record: PersonalAiSettingsRecord | null, deployment: AiDeployment): PersonalAiSettingsView {
  return { ...connectionView("personal", record, deployment), saved: record !== null };
}

/** Settings ready to store: checked, with any new key already encrypted. Fields left out keep their saved values. */
export interface PreparedSettings {
  enabled: boolean;
  mode: "managed" | "own";
  provider: StoredAiProvider | null;
  model: string | null;
  baseUrl: string | null;
  /** `keep` the saved key, store this encrypted one, or remove it. */
  secret: "keep" | null | { ciphertext: string; iv: string; hint: string };
  /** The new key in plain text, kept only in memory for a connection test. */
  plainKey?: string;
  /** A Critiqs AI model's id; null resets to the deployment's first. */
  managedModel?: string | null;
  /** The own key's models, including `model`. */
  models?: string[];
  /** A project's AI usage rule. */
  rule?: AiRule;
  /** Critiqs AI model ids a project's connection may use; empty allows all. */
  allowedModels?: string[];
}

const RULES: AiRule[] = ["project", "personal", "either"];

const NOT_OFFERED = "Choose among the Critiqs AI models this deployment offers.";

/** Critiqs AI model ids as submitted, checked for shape only: whether the deployment offers them is checked against the saved ones (`checkManagedChoice`). */
function managedIds(ids: unknown, what: string): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_MANAGED_MODELS) fail("invalid", `Choose at most ${MAX_MANAGED_MODELS} ${what}.`);
  for (const id of ids) if (typeof id !== "string" || id.length === 0 || id.length > 100) fail("invalid", NOT_OFFERED);
  return [...new Set(ids as string[])];
}

/** The Critiqs AI fields a connection has saved, a project's with the models it allows. */
type SavedChoice = Pick<StoredConnection, "enabled" | "mode" | "managedModel"> & { allowedModels?: string[] };

/**
 * Refuses Critiqs AI choices a save makes that this deployment can't serve.
 * Only a save that leaves AI on with Critiqs AI is checked, and only for
 * values that differ from the saved ones, so a client sending back settings
 * as it loaded them can turn AI off or change the rule after the deployment
 * retired a model or turned Critiqs AI off. Without Critiqs AI, only a
 * connection already on and using it may be saved on with it, keeping its
 * saved values; none may switch to it, be turned on with it, or choose new ones.
 */
export function checkManagedChoice(saved: SavedChoice | null, prepared: PreparedSettings, deployment: AiDeployment): void {
  if (!prepared.enabled || prepared.mode !== "managed") return;
  if (deployment.managed === null && !(saved?.enabled === true && saved.mode === "managed")) fail("invalid", "Critiqs-managed AI isn't available on this deployment.");
  const offered = new Set((deployment.managed?.models ?? []).map((entry) => entry.id));
  const { managedModel, allowedModels } = prepared;
  if (managedModel != null && managedModel !== saved?.managedModel && !offered.has(managedModel)) fail("invalid", NOT_OFFERED);
  if (allowedModels !== undefined && !sameIds(allowedModels, saved?.allowedModels ?? []) && allowedModels.some((id) => !offered.has(id))) fail("invalid", NOT_OFFERED);
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** Connection settings as submitted, a project's (with its rule and allowed models) or a person's own. */
export type SettingsInput = AiConnectionInput & Partial<Pick<AiSettingsInput, "projectId" | "rule" | "allowedModels">>;

/**
 * Checks connection settings someone submitted and gets a new key ready to
 * encrypt. Runs before anything is stored, outside a transaction where
 * encryption needs one. `rule` and `allowedModels` are for projects only.
 */
export async function prepareSettings(input: SettingsInput, deployment: AiDeployment): Promise<PreparedSettings> {
  if (input.mode !== "managed" && input.mode !== "own") fail("invalid", "Choose Critiqs-managed AI or your own provider.");
  const provider = input.mode === "own" ? (input.provider ?? null) : null;
  if (provider !== null && !isProvider(provider)) fail("invalid", "Choose one of the listed providers.");
  const model = input.mode === "own" ? (input.model?.trim() || null) : null;
  if (model !== null && !MODEL_PATTERN.test(model)) fail("invalid", "Enter the model's name as the provider writes it, such as gpt-5-mini.");
  if (provider !== null && model === null) fail("invalid", "Enter the model to use.");
  let models: string[] | undefined;
  if (input.models !== undefined && provider !== null) {
    if (!Array.isArray(input.models) || input.models.length > MAX_CONNECTION_MODELS) fail("invalid", `Pick at most ${MAX_CONNECTION_MODELS} models.`);
    const named = input.models.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
    if (named.some((entry) => !MODEL_PATTERN.test(entry))) fail("invalid", "Enter each model's name as the provider writes it, such as gpt-5-mini.");
    models = [...new Set([model!, ...named])];
    if (models.length > MAX_CONNECTION_MODELS) fail("invalid", `Pick at most ${MAX_CONNECTION_MODELS} models.`);
  }
  // Critiqs AI's fields are ignored for an own key, as an own key's are for Critiqs AI, and when AI is turned off, which keeps
  // the saved ones: stale ones a client sends back can't refuse a save.
  const managed = input.mode === "managed" && input.enabled === true;
  let managedModel: string | null | undefined;
  if (managed && input.managedModel !== undefined) {
    managedModel = input.managedModel === null ? null : managedIds([input.managedModel], "models")[0]!;
  }
  if (input.rule !== undefined && !RULES.includes(input.rule)) fail("invalid", "Choose who pays for AI: the project, each person, or the project with personal AI allowed.");
  const allowedModels = !managed || input.allowedModels === undefined ? undefined : managedIds(input.allowedModels, "allowed models");
  let baseUrl: string | null = null;
  if (input.mode === "own" && input.baseUrl?.trim() && AI_PROVIDERS.find((entry) => entry.id === provider)?.address === "fixed") {
    fail("invalid", "OpenRouter's address is set by Critiqs; leave the address empty.");
  }
  if (input.mode === "own" && input.baseUrl?.trim()) {
    const checked = checkEndpoint(input.baseUrl, deployment.endpoints);
    if (!checked.ok) fail("invalid", checked.reason);
    baseUrl = checked.url;
  }
  if (provider === "compatible" && baseUrl === null) fail("invalid", "Enter the endpoint's address.");
  let secret: PreparedSettings["secret"] = "keep";
  let plainKey: string | undefined;
  if (input.mode !== "own" || provider === null) secret = null;
  else if (input.apiKey !== undefined) {
    const key = input.apiKey.trim();
    if (key === "") secret = null;
    else {
      if (key.length > 1000 || /\s/.test(key)) fail("invalid", "That doesn't look like an API key.");
      if (deployment.encryptionKey === null) {
        fail("invalid", "This deployment can't store provider keys yet. Its operator must set an encryption key (CRITIQS_AI_ENCRYPTION_KEY) first.");
      }
      plainKey = key;
      secret = "keep"; // replaced by `sealKey` once its owner is known
    }
  }
  return {
    enabled: input.enabled === true,
    mode: input.mode,
    provider,
    model,
    baseUrl,
    secret,
    ...(plainKey === undefined ? {} : { plainKey }),
    ...(managedModel === undefined ? {} : { managedModel }),
    ...(models === undefined ? {} : { models }),
    ...(input.rule === undefined ? {} : { rule: input.rule }),
    ...(allowedModels === undefined ? {} : { allowedModels }),
  };
}

/** Encrypts a prepared key, bound to its owner (`keyBinding`). */
export async function sealKey(prepared: PreparedSettings, binding: string, deployment: AiDeployment): Promise<PreparedSettings> {
  const { plainKey, ...rest } = prepared;
  if (plainKey === undefined) return rest;
  return { ...rest, secret: await encryptSecret(deployment.encryptionKey!, binding, plainKey) };
}

/** Whether changing to `prepared` must drop the saved key: it belongs to another provider or address. */
export function keyMovesAway(record: StoredConnection | null, prepared: PreparedSettings): boolean {
  if (record?.secret === undefined) return false;
  return (record.provider ?? null) !== prepared.provider || (record.baseUrl ?? null) !== prepared.baseUrl;
}

/**
 * The connection fields to store, from settings already prepared and the
 * saved ones: a saved key stays only for the same provider and address, and
 * fields a client left out keep their saved values.
 */
export function mergeConnection(saved: StoredConnection | null, prepared: PreparedSettings): Omit<StoredConnection, "epoch" | "updatedAt" | "lastTest"> {
  const secret = prepared.secret === "keep" ? (keyMovesAway(saved, prepared) ? undefined : saved?.secret) : (prepared.secret ?? undefined);
  const managedModel = prepared.managedModel === undefined ? saved?.managedModel : (prepared.managedModel ?? undefined);
  const sameConnection = (saved?.provider ?? null) === prepared.provider && (saved?.baseUrl ?? null) === prepared.baseUrl;
  let models: string[] | undefined;
  if (prepared.provider !== null && prepared.model !== null) {
    const picked = prepared.models ?? (sameConnection ? saved?.models : undefined);
    // The default model is always one of them.
    if (picked !== undefined && picked.length > 0) models = picked.includes(prepared.model) ? picked : [prepared.model, ...picked].slice(0, MAX_CONNECTION_MODELS);
  }
  return {
    enabled: prepared.enabled,
    mode: prepared.mode,
    ...(managedModel === undefined ? {} : { managedModel }),
    ...(prepared.provider === null ? {} : { provider: prepared.provider }),
    ...(prepared.model === null ? {} : { model: prepared.model }),
    ...(models === undefined ? {} : { models }),
    ...(prepared.baseUrl === null ? {} : { baseUrl: prepared.baseUrl }),
    ...(secret === undefined ? {} : { secret }),
  };
}

/**
 * The connection a draft would use, for testing it before saving, and the
 * credits that test costs. Reuses the saved key only for the same provider
 * and address.
 */
export async function draftConnection(
  source: ConnectionSource,
  ownerId: string,
  record: StoredConnection | null,
  prepared: PreparedSettings,
  deployment: AiDeployment,
): Promise<{ connection: ResolvedConnection; chosen: ChosenConnection | null }> {
  checkManagedChoice(record, prepared, deployment);
  const merged = mergeConnection(record, { ...prepared, secret: prepared.plainKey !== undefined ? null : prepared.secret });
  const draft: StoredConnection & Pick<AiSettingsRecord, "allowedModels"> = {
    ...merged,
    enabled: true,
    // A project's draft is tested within the models it would allow.
    ...(source === "project" ? { allowedModels: prepared.allowedModels ?? (record as AiSettingsRecord | null)?.allowedModels ?? [] } : {}),
    epoch: record?.epoch ?? 0,
    updatedAt: 0,
  };
  // A project draft that couldn't be saved isn't tested, nor charged.
  const unsaveable = source === "project" ? disallowedDefault(draft, draft.allowedModels ?? []) : null;
  if (unsaveable !== null) return { connection: { ready: false, reason: unsaveable }, chosen: null };
  const chosen = connectionOf(source, ownerId, draft, deployment);
  const resolved: ResolvedConnection = chosen.ok ? await resolveConnection(chosen, deployment) : { ready: false, reason: chosen.reason };
  const result = { connection: resolved, chosen: chosen.ok ? chosen : null };
  if (prepared.plainKey === undefined) return result;
  if (!resolved.ready && !/API key/.test(resolved.reason)) return result;
  // A key typed for the test, not yet stored.
  if (resolved.ready) return { ...result, connection: { ...resolved, apiKey: prepared.plainKey } };
  // Only a missing key stopped it, so the address already passed the deployment's policy.
  const httpAllowed = prepared.baseUrl?.startsWith("http:") === true;
  return {
    chosen: null,
    connection: { ready: true, mode: "own", provider: prepared.provider!, model: prepared.model!, baseUrl: prepared.baseUrl, apiKey: prepared.plainKey, trustedEndpoint: httpAllowed, epoch: draft.epoch },
  };
}
