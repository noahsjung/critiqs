import type { AiTestResult } from "@critiqs/core";

// What Critiqs's AI features need from a model: one structured answer to one
// prompt, checked against a schema. The AI SDK implementation lives in
// providers.ts, loaded only where model calls run (Convex Node actions, the
// self-hosted server's worker), so it never reaches browsers or ordinary
// Convex functions.

/** A JSON Schema object, as the AI SDK's `jsonSchema` takes it. */
export type JsonSchema = Record<string, unknown>;

export interface StructuredRequest<T> {
  /** Names the task in errors and logs. */
  task: "grouping" | "search" | "insights" | "mockup" | "ticket" | "test";
  system: string;
  prompt: string;
  schema: JsonSchema;
  /** Checks and narrows the model's answer; returns null when it doesn't fit. */
  parse: (value: unknown) => T | null;
  maxOutputTokens: number;
  /**
   * Runs right before each attempt is sent to the provider, retries
   * included, and stops the request by throwing: access to what the request
   * carries can end at any point before it is sent. See `accessCheck`.
   */
  beforeSend?: () => Promise<void>;
}

/**
 * A check of access for `beforeSend`, which remembers a refusal: model code
 * reports any failure as an AiError, so the work that asked ends with the
 * refusal itself (`rethrow`), never treating it as the model failing.
 */
export function accessCheck(check: () => Promise<void>): { beforeSend: () => Promise<void>; rethrow: () => void } {
  let refusal: { error: unknown } | null = null;
  return {
    beforeSend: async () => {
      try {
        await check();
      } catch (error) {
        refusal ??= { error };
        throw error;
      }
    },
    rethrow: () => {
      if (refusal !== null) throw refusal.error;
    },
  };
}

/**
 * What one model call used. Input counts cached tokens, which Critiqs prices
 * as ordinary input, and output counts reasoning tokens.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** What the provider reported charging, in US dollars, when it reports it. */
  costUsd?: number;
}

/** A model's checked answer, and what asking cost. */
export interface Generated<T> {
  output: T;
  usage: ModelUsage;
}

export interface StructuredModel {
  /** Which connection answers: shown to owners, never containing a key. */
  readonly description: string;
  generate<T>(request: StructuredRequest<T>): Promise<Generated<T>>;
}

export type AiErrorCode = Exclude<AiTestResult, { ok: true }>["code"];

/** A failed model call, with a message safe to show: never the provider's response, which can echo keys. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

const MESSAGES: Record<AiErrorCode, string> = {
  auth: "The provider refused the key. Check that it is correct and active.",
  model: "The provider doesn't offer this model to this key. Check the model name.",
  capability: "The model didn't return the structured answer Critiqs asked for. Choose a model that supports structured output.",
  network: "Critiqs couldn't reach the provider, or it didn't answer in time.",
  "rate-limit": "The provider is limiting requests right now. Try again later.",
  config: "The AI connection isn't set up completely.",
  unknown: "The provider couldn't answer.",
};

/** The standard explanation for an error code. */
export function aiErrorMessage(code: AiErrorCode): string {
  return MESSAGES[code];
}

/**
 * Whether a value is an AiError, also from another copy of this module, as
 * when the provider code and the server rules ship as separate bundles.
 */
function isAiError(value: unknown): value is AiError {
  return value instanceof AiError || ((value as { name?: unknown } | null)?.name === "AiError" && typeof (value as { code?: unknown }).code === "string");
}

/** Any failure as an AiError, sorting by HTTP status or kind when it isn't one already. */
export function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (isAiError(error)) {
    const copy = error as { code: AiErrorCode; message: string };
    return new AiError(copy.code, copy.message);
  }
  // Retries wrap the last attempt's error.
  const last = (error as { lastError?: unknown } | null)?.lastError;
  if (last !== undefined && last !== error) return toAiError(last);
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (isAiError(cause)) return toAiError(cause);
  const value = error as { statusCode?: unknown; name?: unknown; cause?: unknown; message?: unknown } | null;
  const status = typeof value?.statusCode === "number" ? value.statusCode : null;
  const name = typeof value?.name === "string" ? value.name : "";
  const code: AiErrorCode =
    status === 401 || status === 403
      ? "auth"
      : status === 404
        ? "model"
        : status === 429
          ? "rate-limit"
          : status !== null && status >= 500
            ? "network"
            : status === 400 && /model/i.test(String(value?.message ?? ""))
              ? "model"
              : /NoObjectGenerated|TypeValidation|JSONParse|NoContentGenerated|UnsupportedFunctionality/.test(name)
                ? "capability"
                : /Abort|Timeout/.test(name) || name === "TypeError" || /fetch failed|ECONN|ENOTFOUND|network/i.test(String(value?.message ?? ""))
                  ? "network"
                  : /LoadAPIKey/.test(name)
                    ? "config"
                    : "unknown";
  return new AiError(code, MESSAGES[code]);
}
