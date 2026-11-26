import type { Fetch } from "./setup.mjs";

export declare const BUILD_LIMITS: {
  files: number;
  totalBytes: number;
  fileBytes: number;
  htmlBytes: number;
  cssBytes: number;
  pathLength: number;
  minDays: number;
  maxDays: number;
  defaultDays: number;
};
export declare const BUILD_EXTENSIONS: readonly string[];
export declare const SHARE_USAGE: string;

/** Why a path can't be in a shared build, or null when it can; the backend's rule. */
export declare function buildPathProblem(path: string): string | null;
/** The first problem with a manifest, as the backend would refuse it, or null. */
export declare function manifestProblem(files: readonly { path: string; size: number }[]): string | null;
export interface BuildFolder {
  files: { path: string; size: number; sha256: string; bytes: Uint8Array }[];
  /** System files left out, such as .DS_Store. */
  skipped: string[];
  bytes: number;
}
/** Reads a build folder without following symbolic links; throws a `SetupError` naming the first file that can't be shared. */
export declare function readBuild(folder: string): BuildFolder;
export declare function looksLikeSpa(files: readonly { path: string }[]): boolean;
export declare function shareTarget(value: string): { key: string } | { buildId: string };

export interface ShareOptions {
  action: "share" | "list" | "delete";
  folder: string | null;
  target: string | null;
  project: string | null;
  dir: string | null;
  backendUrl: string | null;
  spa: boolean | null;
  expires: number | null;
  json: boolean;
  help: boolean;
}
export declare function parseShare(argv: string[]): ShareOptions | { error: string };

interface Services {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetchFn?: Fetch;
}
export declare function shareFolder(
  options: ShareOptions,
  services?: Services & { log?: (message: string) => void },
): Promise<{ buildId: string; url: string; expiresAt: number; files: number; bytes: number; spa: boolean; projectId: string }>;
export declare function runShare(argv: string[], services?: Services & { print?: (message: string) => void }): Promise<number>;
