import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { guardedFetch, OPENROUTER_ENDPOINT } from "./endpoints.ts";
import { AiError, type Generated, type ModelUsage, type StructuredModel, type StructuredRequest, toAiError } from "./model.ts";
import type { ResolvedConnection } from "./settings.ts";

// Model calls through the AI SDK, with an explicit provider instance for each
// connection. Every setting is passed explicitly, never read from the
// environment, so a key or address meant for one connection can't leak into
// another, and the Gateway is used only when chosen. Imported only where
// model calls run: Convex Node actions and the self-hosted server's worker.

/** Each provider's own address, used when a connection names none. */
export const DEFAULT_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: OPENROUTER_ENDPOINT,
  gateway: "https://ai-gateway.vercel.sh/v4/ai",
} as const;

export const DEFAULT_TIMEOUT_MS = 30_000;

const LABELS = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini", openrouter: "OpenRouter", gateway: "Vercel AI Gateway", compatible: "OpenAI-compatible endpoint" };

type Ready = Extract<ResolvedConnection, { ready: true }>;

function languageModel(connection: Ready, fetch: typeof globalThis.fetch, baseURL: string): LanguageModel {
  const apiKey = connection.apiKey;
  switch (connection.provider) {
    case "openai":
      return createOpenAI({ apiKey: apiKey ?? "", baseURL, fetch, organization: undefined, project: undefined })(connection.model);
    case "anthropic":
      return createAnthropic({ apiKey: apiKey ?? "", baseURL, fetch })(connection.model);
    case "google":
      return createGoogle({ apiKey: apiKey ?? "", baseURL, fetch })(connection.model);
    case "gateway":
      // Without a key the Gateway would look for a Vercel OIDC token in the environment.
      if (!apiKey) throw new AiError("config", "Vercel AI Gateway needs an API key.");
      return createGateway({ apiKey, baseURL, fetch })(connection.model);
    case "openrouter":
      // OpenRouter speaks the OpenAI-compatible API at its own address, which Critiqs sets.
      return createOpenAICompatible({ name: "openrouter", baseURL, apiKey: apiKey ?? "", fetch, supportsStructuredOutputs: true })(connection.model);
    case "compatible":
      return createOpenAICompatible({
        name: "compatible",
        baseURL,
        ...(apiKey ? { apiKey } : {}),
        fetch,
        supportsStructuredOutputs: true,
      })(connection.model);
  }
}

function dollars(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * What OpenRouter reports charging for one step. With its own key, `cost` is
 * the whole charge. With a key of one's own (`is_byok`), `cost` is only
 * OpenRouter's fee and the provider's charge is `upstream_inference_cost`.
 */
function openRouterCost(raw: unknown): number | null {
  const usage = raw as { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } | null } | undefined;
  const cost = dollars(usage?.cost);
  if (cost === null || usage?.is_byok !== true) return cost;
  const upstream = dollars(usage.cost_details?.upstream_inference_cost);
  return upstream === null ? null : cost + upstream;
}

/**
 * What Vercel AI Gateway reports charging for one step, in its metadata, as
 * text or a number. Its market cost is the list price, higher than `cost`
 * when a key of one's own pays the provider.
 */
function gatewayCost(metadata: unknown): number | null {
  const gateway = (metadata as { gateway?: { cost?: unknown; marketCost?: unknown } } | undefined)?.gateway;
  const amount = (value: unknown) => dollars(typeof value === "string" && value.trim() !== "" ? Number(value) : value);
  const cost = amount(gateway?.cost);
  if (cost === null) return null;
  const charged = Math.max(cost, amount(gateway?.marketCost) ?? 0);
  return charged > 0 ? charged : null;
}

type Step = { usage: { raw?: unknown }; providerMetadata?: unknown };

const REPORTED_COST: Partial<Record<Ready["provider"], (step: Step) => number | null>> = {
  openrouter: (step) => openRouterCost(step.usage.raw),
  gateway: (step) => gatewayCost(step.providerMetadata),
};

function usageOf(provider: Ready["provider"], result: { usage: { inputTokens: number | undefined; outputTokens: number | undefined }; steps: Step[] }): ModelUsage {
  const usage = { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
  const reported = REPORTED_COST[provider];
  if (reported === undefined) return usage;
  const costs = result.steps.map(reported);
  if (costs.length === 0 || costs.includes(null)) return usage;
  return { ...usage, costUsd: costs.reduce<number>((sum, cost) => sum + cost!, 0) };
}

/** A structured-output model for one resolved connection. */
export function createStructuredModel(connection: Ready, options: { timeoutMs?: number } = {}): StructuredModel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseURL = connection.baseUrl ?? (connection.provider === "compatible" ? null : DEFAULT_ENDPOINTS[connection.provider]);
  if (baseURL === null) throw new AiError("config", "Enter the endpoint's address in AI settings.");
  const fetch = guardedFetch(baseURL, timeoutMs, connection.trustedEndpoint);
  const description = `${connection.mode === "managed" ? "Critiqs-managed AI" : LABELS[connection.provider]} · ${connection.model}`;
  return {
    description,
    async generate<T>(request: StructuredRequest<T>): Promise<Generated<T>> {
      let output: unknown;
      let usage: ModelUsage;
      try {
        const model = languageModel(connection, fetch, baseURL);
        const result = await generateText({
          model,
          system: request.system,
          prompt: request.prompt,
          output: Output.object({ schema: jsonSchema(request.schema) }),
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 1,
          timeout: timeoutMs,
        });
        output = result.output;
        usage = usageOf(connection.provider, result);
      } catch (error) {
        throw toAiError(error);
      }
      const parsed = request.parse(output);
      if (parsed === null) throw new AiError("capability", "The model's answer didn't match what Critiqs asked for.");
      return { output: parsed, usage };
    },
  };
}
