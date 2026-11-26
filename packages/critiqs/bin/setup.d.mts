import type { Written } from "./app.mjs";

export declare const CLOUD_BACKEND_URL: string;
export declare const BACKEND_PROTOCOL: number;
export declare const SIGN_IN_PROTOCOL: number;
export declare class SetupError extends Error {}

export type Fetch = typeof fetch;

export declare function siteUrlOf(backendUrl: string): string;
export declare function resolveBackend(
  backendUrl: string,
  options?: { fetchFn?: Fetch },
): Promise<{ backendUrl: string; siteUrl: string; signInUrl: string; transport: "convex" | "http" }>;
/** Exactly `localhost`, or a literal loopback address (127.0.0.0/8, [::1]). */
export declare function isLoopbackHost(hostname: string): boolean;
/** Whether `site` is the address Convex Cloud pairs with `backend` (both origins). */
export declare function isConvexCloudPair(backend: string, site: string): boolean;
/** Raised when a request carrying a sign-in is answered with a redirect, which isn't followed. */
export declare class RedirectRefusedError extends SetupError {}
/** Sends a request carrying a sign-in without following redirects; a redirect throws `RedirectRefusedError`. */
export declare function sendCredential(fetchFn: Fetch, url: string, init?: RequestInit): Promise<Response>;
/** Throws unless a sign-in token may travel to `url`: HTTPS, or plain http to this computer. */
export declare function requireSecureTokenTarget(url: string): void;
/** Opens an http or https address in the default browser without a shell; `spawnFn` gets the address as one argument. */
export declare function openBrowser(
  url: string,
  options?: {
    platform?: string;
    env?: Record<string, string | undefined>;
    spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => { on(event: "error", listener: () => void): unknown; unref(): void };
  },
): void;
export declare function startBrowserSignIn(options?: {
  signInUrl?: string;
  /** The backend the sign-in is for, which the page names. */
  backendUrl?: string | null;
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
export declare function isHeadless(env?: Record<string, string | undefined>, platform?: string): boolean;
/** A backend and where it serves screenshots and page copies (`site`), as origins. */
export type Binding = { backend: string; site: string };
/** Critiqs Cloud's sign-in service. */
export declare const CLOUD_SIGN_IN_URL: string;
/** Critiqs Cloud's backend and site, as origins. */
export declare const CLOUD_BINDING: Readonly<Binding>;
/** Critiqs Cloud's backend and site through Critiqs Cloud's own sign-in service. */
export declare function isLegacyCloudApproval(signInUrl: string, binding: Binding): boolean;
/**
 * Why an approval for `binding` can't go ahead, from what the service said its page names when it started and,
 * once approved, with the tokens (`undefined` before then); null when it can.
 */
export declare function approvalRefusal(
  signInUrl: string,
  binding: Binding,
  started: Binding | { invalid: true } | null,
  granted: Binding | { invalid: true } | null | undefined,
): string | null;
export declare function startRemoteSignIn(options: {
  signInUrl: string;
  /** The backend the tokens are for; the approval page names it and where it serves downloads (`site`). */
  backendUrl: string;
  fetchFn?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Also start a session for this computer (`critiqs sign-in`); `tokens` then carries its refresh token. */
  keepSignedIn?: boolean;
}): Promise<{
  /** The sign-in service's own `/auth/device` page. */
  url: string;
  userCode: string;
  expiresAt: number;
  signInUrl: string;
  /** What the approval is for, as origins. */
  binding: Binding;
  /** Whether the approval page names the backend; false only for the legacy Critiqs Cloud approval. */
  confirmed: boolean;
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
export declare const MAX_PROJECT_NAME_LENGTH: number;
export declare function shortenProjectName(name: string): string;
export declare function checkProjectName(name: string | null | undefined): void;
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
  /** `env.file` is null where the framework loads no `.env` file and the shell's environment gave the ID. */
  | { connected: { projectId: string; backendUrl: string; env?: { name: string; file: string | null } }; backendUrl: string }
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
