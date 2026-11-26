import type { EnvConvention } from "./frameworks/types.d.mts";

export interface AppDescription {
  root: string;
  workspace: { root: string; name: string; label: string } | null;
  projectName: string;
  /** Added to the framework's variable name, such as `_ADMIN`; "" outside a workspace; null when two apps' names would collide. */
  suffix: string | null;
  envFile: string | null;
}

/** This computer's `.env` files for an environment-backed project ID. */
export interface EnvTarget {
  /** What the framework loads, highest precedence first, the person's chosen file before all. */
  files: string[];
  /** The file setup writes, or null for frameworks that load none. */
  local: string | null;
  /** The app's name in comments, or null for "this app". */
  label: string | null;
}

export interface EnvPlan {
  name: string;
  value: string;
  file: string;
  original: string | null;
  source: string;
  changed: boolean;
  example: { file: string; original: string | null; source: string } | null;
}

export declare function workspacePatterns(dir: string): string[] | null;
export declare function workspaceMembers(workspaceRoot: string, patterns?: string[]): string[];
export declare function findWorkspace(root: string): { root: string; patterns: string[] } | null;
export declare function describeApp(root: string, options?: { envFile?: string | null }): AppDescription;
export declare function envTarget(root: string, convention: EnvConvention, options?: { envFile?: string | null; label?: string | null }): EnvTarget;
/** A `.env` file that exists but can't be read; `file` is its absolute path. */
export declare class UnreadableEnvFile extends Error {
  readonly file: string;
  constructor(file: string, cause?: unknown);
}
export declare function readEnvValue(target: EnvTarget, name: string): { value: string; file: string } | null;
export declare function planEnv(target: EnvTarget, name: string, value: string): EnvPlan;
export declare function checkWritable(file: string): void;
export declare function applyEnv(plan: EnvPlan): { example: string | null };
export declare function gitIgnored(file: string): boolean | null;
