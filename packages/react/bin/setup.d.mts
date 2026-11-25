import type { JsxElement, Props, Wiring } from "./init.mjs";

export declare const CLOUD_BACKEND_URL: string;
export declare const BACKEND_PROTOCOL: number;
export declare const SIGN_IN_PROTOCOL: number;
export declare class SetupError extends Error {}

export type Fetch = typeof fetch;
export type PropValue = { kind: "literal"; value: string } | { kind: "expression"; text?: string } | null;

export declare function siteUrlOf(backendUrl: string): string;
export declare function resolveBackend(
  backendUrl: string,
  options?: { fetchFn?: Fetch },
): Promise<{ backendUrl: string; siteUrl: string; signInUrl: string; transport: "convex" | "http" }>;
export declare function openBrowser(url: string): void;
export declare function startBrowserSignIn(options?: {
  signInUrl?: string;
  timeoutMs?: number;
  port?: number;
}): Promise<{ url: string; tokens: Promise<{ accessToken: string; refreshToken: string }>; close(): void }>;
export declare function callConvex(
  backendUrl: string,
  kind: "query" | "mutation" | "action",
  path: string,
  args: Record<string, unknown>,
  accessToken: string,
  options?: { fetchFn?: Fetch },
): Promise<unknown>;
export declare function createProject(args: {
  backendUrl: string;
  accessToken: string;
  name: string;
  reviewUrl?: string | null;
  fetchFn?: Fetch;
}): Promise<string>;
export declare function signOut(signInUrl: string, refreshToken: string, options?: { origin?: string; fetchFn?: Fetch }): Promise<void>;
export declare function locateComponent(
  root: string,
  cwd?: string,
): { error: string } | { usage: { file: string; source: string; element: JsxElement } };
export declare function isHeadless(env?: Record<string, string | undefined>, platform?: string): boolean;
export declare function startRemoteSignIn(options: {
  signInUrl: string;
  fetchFn?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Also start a session for this computer (`critiqs sign-in`); `tokens` then carries its refresh token. */
  keepSignedIn?: boolean;
}): Promise<{
  url: string;
  userCode: string;
  expiresAt: number;
  tokens: Promise<{
    accessToken: string;
    expiresAt: number;
    refreshToken: string | null;
    sessionEndsAt: number | null;
    reviewer: { name: string; email: string } | null;
  }>;
  close(): void;
}>;
export declare function listMyProjects(args: {
  backendUrl: string;
  accessToken: string;
  fetchFn?: Fetch;
}): Promise<{ _id: string; name: string; reviewUrl: string | null }[]>;
export interface Written {
  ok: boolean;
  message: string;
  file?: string;
  line?: number;
  changed?: string[];
  installed?: boolean;
  preview?: string[];
  /** For an environment-backed project ID: the variable, the file set on this computer, and what each deployment does. */
  env?: { name: string; file: string; advice: string; ignored?: boolean | null };
}
export declare function writeComponentProps(args: {
  root: string;
  cwd?: string;
  props: Props;
  dryRun?: boolean;
  entry?: string | null;
  mount?: string | null;
  also?: string;
}): Written;
export declare function writeConnection(args: {
  root: string;
  cwd?: string;
  wiring: Wiring;
  projectId: string;
  backend?: string;
  dryRun?: boolean;
  entry?: string | null;
  mount?: string | null;
}): Written;
export declare function readComponentProps(
  root: string,
  cwd?: string,
): { error: string } | { file: string; line: number; projectId: PropValue; backend: PropValue; requireProjectId: boolean };
export declare function targetDeployment(env: Record<string, string | undefined>): { backendUrl: string; env: Record<string, string> };
export declare function convexEnv(
  target: { env: Record<string, string> },
  base?: Record<string, string | undefined>,
): Record<string, string | undefined>;
export declare function deployOwnConvex(args: {
  env?: Record<string, string | undefined>;
  signInUrl?: string;
  resendApiKey?: string;
  emailFrom?: string;
  log?: (message: string) => void;
}): Promise<string>;
export interface Check {
  /** `info`: an optional feature, such as AI, is off. */
  status: "pass" | "warn" | "fail" | "info";
  name: string;
  detail: string;
  stage: "code" | "service" | "project" | "reviewers" | "optional";
  /** Whether the check read settings, or something the backend actually did. */
  basis: "configuration" | "observed";
}
export declare const DOCTOR_NOTE: string;
export declare function isLocalAddress(address: string): boolean;
export declare function doctor(args: {
  root: string;
  cwd?: string;
  /** The .env file the app loads, relative to root, for custom framework env directories. */
  envFile?: string | null;
  backendUrl?: string;
  fetchFn?: Fetch;
  now?: number;
  /** The environment builds started here would see; defaults to this process's. */
  env?: Record<string, string | undefined>;
}): Promise<Check[]>;
export declare function doctorReport(checks: Check[]): { ok: boolean; checks: Check[]; note: string };
export interface Stage {
  status: "pass" | "warn" | "fail" | "next";
  name: string;
  detail: string;
}
export declare function readiness(result: {
  written: Written;
  projectId: string;
  projectName: string;
  backendUrl: string;
  reviewAddress?: string | null;
  reused?: boolean;
  connected?: boolean;
}): Stage[];
export declare function defaultProjectName(root: string): string;
export interface SetupResult {
  projectId: string;
  projectName: string;
  backendUrl: string;
  written: Written;
  reviewAddress: string | null;
  reused: boolean;
  connected: boolean;
  approvedBy: { name: string; email: string } | null;
}
export declare function beginSetup(args: {
  root: string;
  cwd?: string;
  /** "cloud", "own-convex", or a backend URL; null keeps a project the code names, or uses Critiqs Cloud. */
  target?: string | null;
  name?: string;
  reviewUrl?: string;
  keys?: { convexDeployKey?: string; resendApiKey?: string; emailFrom?: string };
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  fetchFn?: Fetch;
  entry?: string | null;
  mount?: string | null;
  newProject?: boolean;
  signIn?: "auto" | "browser" | "remote";
  /** The .env file to set an environment-backed project ID in, relative to `root`. */
  envFile?: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { connected: { projectId: string; backendUrl: string; env?: { name: string; file: string } }; backendUrl: string }
  | {
      connected?: undefined;
      url: string;
      method: "browser" | "remote";
      userCode: string | null;
      backendUrl: string;
      cancel(): void;
      finish(): Promise<SetupResult>;
    }
>;
