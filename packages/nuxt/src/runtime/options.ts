import type { CritiqsOptions } from "critiqs";
import type { PublicCritiqsConfig } from "../module.ts";

/**
 * Critiqs's settings from public runtime config. Values set through
 * NUXT_PUBLIC_CRITIQS_… arrive parsed, so a number-like value or "false"
 * may not be the type the config declares.
 */
export function critiqsOptions(value: unknown): CritiqsOptions & { router: boolean } {
  const config = (typeof value === "object" && value !== null ? value : {}) as Partial<Record<keyof PublicCritiqsConfig, unknown>>;
  const on = (value: unknown) => value !== false && String(value).toLowerCase() !== "false";
  const text = (value: unknown) => (value === undefined || value === null || String(value).trim() === "" ? undefined : String(value).trim());
  return {
    projectId: text(config.projectId),
    requireProjectId: on(config.requireProjectId),
    backend: text(config.backend),
    version: text(config.version),
    router: on(config.router),
  };
}
