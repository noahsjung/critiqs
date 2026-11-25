import { AI_PROVIDERS, type AiModelListDraft, type AiModelListResult, type AiModelOption, type AiProvider } from "@critiqs/core";
import { fail } from "../errors.ts";
import type { StoredConnection } from "../store.ts";
import { checkEndpoint, guardedFetch, OPENROUTER_ENDPOINT } from "./endpoints.ts";
import { AiError, aiErrorMessage, toAiError } from "./model.ts";
import { decryptSecret, keyBinding } from "./secrets.ts";
import { type AiDeployment, type ConnectionSource, MODEL_PATTERN } from "./settings.ts";

// A provider's own list of models, for picking a connection's models. The
// request goes from the server, through the same endpoint policy and guarded
// fetch as model calls: HTTPS, the operator's allowlist for custom addresses,
// no redirects, a timeout, and a size limit. Only model ids and display names
// are read from the answer; failures are sorted like connection tests and
// never repeat the provider's response, which can echo keys.

/** Most models one list returns; the rest are left out, and the list says so. */
export const MAX_LISTED_MODELS = 500;
export const MODEL_LIST_TIMEOUT_MS = 15_000;
/** OpenRouter's list, the largest, is a few megabytes with every model's description and prices. */
export const MAX_MODEL_LIST_BYTES = 8 * 1024 * 1024;
/** Model lists per person per minute, projects' and their own together. */
export const MODEL_LISTS_PER_MINUTE = 10;

/** Where each provider lists its models when no address is entered. The Gateway lists them outside its model API's address. */
const LIST_BASES: Record<Exclude<AiProvider, "compatible">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: OPENROUTER_ENDPOINT,
  gateway: "https://ai-gateway.vercel.sh/v1",
};

/** One provider to list models from, its key already in hand. */
export interface ModelListTarget {
  provider: AiProvider;
  /** An address that passed the deployment's policy; null for the provider's own. */
  baseUrl: string | null;
  apiKey: string | undefined;
  /** The address may use plain HTTP: the operator allowed local endpoints and it passed that policy. */
  allowHttp: boolean;
}

const NO_LIST = "This provider doesn't list its models here. Type the model's name instead.";
const UNREADABLE = "The provider's model list couldn't be read. Type the model's name instead.";
const TOO_LARGE = "The provider's model list is too large to read. Type the model's name instead.";

const labelOf = (provider: AiProvider) => AI_PROVIDERS.find((entry) => entry.id === provider)!.label;
const WHERE: Record<ConnectionSource, string> = { project: "AI settings", personal: "Your AI" };

/**
 * The provider, address, and key a list request uses: a draft's, with the
 * key typed for this request, or the saved settings'. A saved key is used
 * only for the provider and address it was saved with, as a connection test
 * does. Returns why not when it can't be listed.
 */
export async function modelListTarget(
  source: ConnectionSource,
  ownerId: string,
  record: StoredConnection | null,
  draft: AiModelListDraft | undefined,
  deployment: AiDeployment,
): Promise<{ ok: true; target: ModelListTarget } | { ok: false; reason: string }> {
  const provider = draft === undefined ? (record?.mode === "own" ? record.provider : undefined) : draft.provider;
  if (provider === undefined) return { ok: false, reason: "Choose a provider first." };
  const info = AI_PROVIDERS.find((entry) => entry.id === provider);
  if (info === undefined) fail("invalid", "Choose one of the listed providers.");
  const entered = draft === undefined ? (record?.baseUrl ?? null) : draft.baseUrl?.trim() || null;
  let baseUrl: string | null = null;
  if (entered !== null) {
    if (info.address === "fixed") return { ok: false, reason: `${info.label}'s address is set by Critiqs; leave the address empty.` };
    const checked = checkEndpoint(entered, deployment.endpoints);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    baseUrl = checked.url;
  } else if (info.address === "required") {
    return { ok: false, reason: "Enter the endpoint's address." };
  }
  const typed = draft?.apiKey?.trim() ?? "";
  let apiKey: string | undefined;
  if (typed !== "") {
    if (typed.length > 1000 || /\s/.test(typed)) return { ok: false, reason: "That doesn't look like an API key." };
    apiKey = typed;
  } else if (record?.secret !== undefined && record.provider === provider && (record.baseUrl ?? null) === baseUrl) {
    const key = deployment.encryptionKey === null ? null : await decryptSecret(deployment.encryptionKey, keyBinding(source, ownerId), record.secret);
    if (key === null) return { ok: false, reason: `The saved key can't be read. Enter the key again in ${WHERE[source]}.` };
    apiKey = key;
  } else if (info.needsKey) {
    return { ok: false, reason: `Enter your ${info.label} API key to list its models.` };
  }
  return { ok: true, target: { provider, baseUrl, apiKey, allowHttp: baseUrl?.startsWith("http:") === true } };
}

/** The list request for one provider: the address it must stay under, the URL, and the key's headers. */
function listRequest(target: ModelListTarget): { base: string; url: string; headers: Record<string, string> } {
  const { provider, apiKey } = target;
  if (provider === "gateway" && target.baseUrl !== null) {
    throw new AiError("config", "Critiqs lists Vercel AI Gateway's models only at its own address. Type the model's name instead.");
  }
  const base = target.baseUrl ?? (provider === "compatible" ? null : LIST_BASES[provider]);
  if (base === null) throw new AiError("config", "Enter the endpoint's address.");
  const bearer: Record<string, string> = apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` };
  switch (provider) {
    case "anthropic":
      return { base, url: `${base}/models?limit=1000`, headers: { ...(apiKey === undefined ? {} : { "x-api-key": apiKey }), "anthropic-version": "2023-06-01" } };
    case "google":
      return { base, url: `${base}/models?pageSize=1000`, headers: apiKey === undefined ? {} : { "x-goog-api-key": apiKey } };
    default:
      return { base, url: `${base}/models`, headers: bearer };
  }
}

/** OpenAI lists models for every kind of request; these can't answer Critiqs's structured text requests. */
const OPENAI_NOT_TEXT = /embed|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|davinci|babbage|sora|search-api/i;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** Each provider's answer as model ids and display names, or null when it isn't a list. */
function entriesOf(provider: AiProvider, body: unknown): { id: unknown; label: unknown }[] | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const list = provider === "google" ? record.models : record.data;
  if (!Array.isArray(list)) return null;
  const entries: { id: unknown; label: unknown }[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const model = item as Record<string, unknown>;
    switch (provider) {
      case "google": {
        // Only models that answer prompts; "models/gemini-2.5-flash" is named "gemini-2.5-flash" in requests.
        const methods = model.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
        entries.push({ id: typeof model.name === "string" ? model.name.replace(/^models\//, "") : null, label: model.displayName });
        break;
      }
      case "anthropic":
        entries.push({ id: model.id, label: model.display_name });
        break;
      case "gateway":
        if (typeof model.type === "string" && model.type !== "language") continue;
        entries.push({ id: model.id, label: model.name });
        break;
      case "openrouter":
        entries.push({ id: model.id, label: model.name });
        break;
      case "openai":
        if (typeof model.id === "string" && OPENAI_NOT_TEXT.test(model.id)) continue;
        entries.push({ id: model.id, label: null });
        break;
      case "compatible":
        entries.push({ id: model.id, label: model.name });
        break;
    }
  }
  return entries;
}

/**
 * Reads a provider's model list: ids a request can name, with display names
 * when they differ, without repeats, sorted by name (the display name, else
 * the id), keeping the first `MAX_LISTED_MODELS` in that order. Null when the
 * answer isn't a model list.
 */
export function parseModelList(provider: AiProvider, body: unknown): { models: AiModelOption[]; truncated: boolean } | null {
  const entries = entriesOf(provider, body);
  if (entries === null) return null;
  const seen = new Map<string, AiModelOption>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !MODEL_PATTERN.test(entry.id) || seen.has(entry.id)) continue;
    const label = text(entry.label, 100);
    seen.set(entry.id, { id: entry.id, label: label === entry.id ? null : label });
  }
  const name = (model: AiModelOption) => model.label ?? model.id;
  const models = [...seen.values()].sort((a, b) => name(a).localeCompare(name(b), "en", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id));
  return { models: models.slice(0, MAX_LISTED_MODELS), truncated: models.length > MAX_LISTED_MODELS };
}

/** A response's JSON, read up to `MAX_MODEL_LIST_BYTES`. */
async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_MODEL_LIST_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AiError("capability", TOO_LARGE);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new AiError("capability", UNREADABLE);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MODEL_LIST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AiError("capability", TOO_LARGE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AiError("capability", UNREADABLE);
  }
}

/** Asks a provider for its models. Throws an AiError with a message safe to show. */
export async function fetchModelList(
  target: ModelListTarget,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<{ models: AiModelOption[]; truncated: boolean }> {
  const request = listRequest(target);
  const send = guardedFetch(request.base, options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS, target.allowHttp, options.fetch);
  let response: Response;
  try {
    response = await send(request.url, { method: "GET", headers: { Accept: "application/json", ...request.headers } });
  } catch (error) {
    // Unreachable, timed out, or refused by the guard: sorted, never the underlying message.
    throw toAiError(error);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    if (status === 401 || status === 403) throw new AiError("auth", aiErrorMessage("auth"));
    if (status === 404 || status === 405) throw new AiError("capability", NO_LIST);
    if (status === 429) throw new AiError("rate-limit", aiErrorMessage("rate-limit"));
    if (status >= 500) throw new AiError("network", aiErrorMessage("network"));
    throw new AiError("unknown", aiErrorMessage("unknown"));
  }
  let body: unknown;
  try {
    body = await readJson(response);
  } catch (error) {
    // A timeout or reset partway through the answer, sorted like one before it.
    throw toAiError(error);
  }
  const parsed = parseModelList(target.provider, body);
  if (parsed === null) throw new AiError("capability", UNREADABLE);
  return parsed;
}

/** What listing models needs from its backend: whose settings, checked and counted against the per-minute limit. */
export interface ModelListSteps {
  prepare(): Promise<{ source: ConnectionSource; ownerId: string; settings: StoredConnection | null }>;
  deployment: AiDeployment;
  timeoutMs?: number;
  /** For tests: the underlying fetch. */
  fetch?: typeof fetch;
}

/**
 * Lists the models a provider offers to a key: for the saved settings, or a
 * draft before saving, whose typed key is used for this request only and
 * never stored. Failures come back as a result, like a connection test.
 */
export async function listModels(steps: ModelListSteps, draft?: AiModelListDraft): Promise<AiModelListResult> {
  const { source, ownerId, settings } = await steps.prepare();
  const prepared = await modelListTarget(source, ownerId, settings, draft, steps.deployment);
  if (!prepared.ok) return { ok: false, code: "config", message: prepared.reason };
  try {
    const { models, truncated } = await fetchModelList(prepared.target, { ...(steps.timeoutMs === undefined ? {} : { timeoutMs: steps.timeoutMs }), ...(steps.fetch === undefined ? {} : { fetch: steps.fetch }) });
    if (models.length === 0) return { ok: false, code: "model", message: `${labelOf(prepared.target.provider)} listed no models this key can use. Type the model's name instead.` };
    return { ok: true, models, truncated };
  } catch (error) {
    const failure = toAiError(error);
    return { ok: false, code: failure.code, message: failure.message };
  }
}
