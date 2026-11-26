/**
 * Critiqs Cloud's Convex deployment, used when a prototype names no backend.
 * Teams that run Critiqs on their own Convex deployment pass `backend` instead.
 */
export { HOSTED_BACKEND_URL } from "@critiqs/core";
import { HOSTED_BACKEND_URL } from "@critiqs/core";

/**
 * The backend version this component needs: server-derived tags, tag groups,
 * search, and AI settings (5), besides authenticated R2 uploads and opaque
 * capture IDs (4).
 */
export const BACKEND_PROTOCOL = 5;

/** The sign-in service version this component needs; sign-in hasn't changed since protocol 4. */
export const SIGN_IN_PROTOCOL = 4;

export interface Deployment {
  /**
   * Convex deployment URL for functions, such as `https://name.convex.cloud`;
   * or, for a server in the host app, the address it is mounted at.
   */
  backendUrl: string;
  /** Convex, with live updates; or a server in the host app, checked every few seconds. */
  transport: "convex" | "http";
  /** How reviewers sign in to a server in the host app: the host app's own sign-in, or Critiqs's. */
  signIn: "host" | "email" | "development" | "unavailable" | null;
  /** The same deployment's HTTP address, which serves captures and its configuration. */
  siteUrl: string;
  /** Critiqs's sign-in service that this deployment trusts. */
  signInUrl: string;
  /** The backend stores mockups, so Mockup mode can be offered; absent from backends before Mockup mode. */
  mockups?: boolean;
  /** The backend keeps each person's own AI settings (Your AI) and projects' AI usage rules; absent from backends before them. */
  personalAi?: boolean;
  /** The backend lists providers' models and the models a person's requests may choose among; absent from backends before them. */
  modelLists?: boolean;
  /** The backend keeps organizations, which own projects and plans; absent from backends before them. */
  organizations?: boolean;
  /** The backend keeps organizations' members and invites, and creates projects in a chosen organization; absent from backends before them. */
  organizationMembers?: boolean;
  /** An organization's admins can set its cap on extra Critiqs AI credits; absent from backends before it. */
  overageCap?: boolean;
  /** The backend takes payment for plans (Critiqs Cloud); absent where it doesn't. */
  billing?: boolean;
  /**
   * The Critiqs website that serves this deployment's thread pages, where
   * **Copy link** on a thread links (`<website>/t/<key>`). Absent unless the
   * backend reports thread pages and a website for them, as only Critiqs
   * Cloud does for now; there, the link opens the prototype as before.
   */
  website?: string;
  /** The backend keeps projects' address lists and records the projects each person opened; absent from backends before them. */
  addressLists?: boolean;
  /** The backend adds or removes one address at a time and lists the projects a person manages; absent from backends before it. */
  addressEdits?: boolean;
  /** The backend accepts `idempotencyKey` on project creation; absent from backends before it. */
  createKeys?: boolean;
  /** A project's owner can change its preset tags; absent from backends before it. */
  presetTags?: boolean;
  /** The backend records when Critiqs first loads with a project's ID (`POST /critiqs/connected`), for onboarding's Connected. */
  connections?: boolean;
}

/** What `/critiqs/config` reports; only `signInUrl` is always there. */
interface ServiceConfig {
  signInUrl: string;
  protocol?: number;
  transport?: string;
  signIn?: string;
  mockups?: boolean;
  personalAi?: boolean;
  modelLists?: boolean;
  organizations?: boolean;
  organizationMembers?: boolean;
  overageCap?: boolean;
  billing?: boolean;
  threadPages?: boolean;
  website?: unknown;
  addressLists?: boolean;
  addressEdits?: boolean;
  createKeys?: boolean;
  presetTags?: boolean;
  connections?: boolean;
}

/** The website a backend reports for its thread pages, when it reports them and the address is a web address. */
function threadPageWebsite(config: ServiceConfig): string | undefined {
  if (config.threadPages !== true || typeof config.website !== "string") return undefined;
  try {
    const url = new URL(config.website);
    return url.protocol === "https:" || url.protocol === "http:" ? config.website : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The HTTP address Convex pairs with a deployment URL: `.convex.cloud` becomes
 * `.convex.site`, and a local deployment's port is followed by its site port.
 */
export function siteUrlOf(backendUrl: string): string {
  const url = new URL(backendUrl);
  // A server in the host app answers at the path it is mounted at.
  if (url.pathname !== "/" && !url.hostname.endsWith(".convex.cloud")) return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (url.hostname.endsWith(".convex.cloud")) {
    url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
  } else if (url.port !== "") {
    url.port = String(Number(url.port) + 1);
  }
  return url.origin;
}

/** A Critiqs service's configuration, or why it can't be used. */
async function readConfig(siteUrl: string, fetchFn: typeof fetch, unreachable: string, needed = BACKEND_PROTOCOL) {
  const response = await fetchFn(`${siteUrl}/critiqs/config`).catch(() => {
    throw new Error(`${unreachable}.`);
  });
  if (!response.ok) throw new Error(`${unreachable} (${response.status}).`);
  const config = (await response.json()) as ServiceConfig;
  return {
    signInUrl: config.signInUrl.replace(/\/$/, ""),
    current: typeof config.protocol === "number" && config.protocol >= needed,
    transport: config.transport === "http" ? ("http" as const) : ("convex" as const),
    signIn: (config.signIn ?? null) as Deployment["signIn"],
    mockups: config.mockups === true,
    personalAi: config.personalAi === true,
    modelLists: config.modelLists === true,
    organizations: config.organizations === true,
    organizationMembers: config.organizationMembers === true,
    overageCap: config.overageCap === true,
    billing: config.billing === true,
    website: threadPageWebsite(config),
    addressLists: config.addressLists === true,
    addressEdits: config.addressEdits === true,
    createKeys: config.createKeys === true,
    presetTags: config.presetTags === true,
    connections: config.connections === true,
  };
}

/**
 * Reads which sign-in service the deployment trusts, and checks both are
 * recent enough for this component. Errors are complete sentences for reviewers.
 */
export async function resolveDeployment(given: string, fetchFn: typeof fetch = fetch): Promise<Deployment> {
  // A path such as "/critiqs" names a server in the host app on this site.
  const backendUrl = new URL(given, globalThis.location?.href).toString().replace(/\/$/, "");
  const siteUrl = siteUrlOf(backendUrl);
  const hosted = backendUrl.replace(/\/$/, "") === HOSTED_BACKEND_URL;
  const backend = await readConfig(siteUrl, fetchFn, `Critiqs can't reach its backend at ${backendUrl}`);
  if (!backend.current) {
    throw new Error(
      hosted
        ? "Critiqs Cloud isn't ready for this version of Critiqs yet."
        : `The Critiqs backend at ${backendUrl} runs an older version. Deploy the current Critiqs functions to it.`,
    );
  }
  // A deployment may trust another's sign-in service, usually Critiqs Cloud's; that one must be current too.
  if (backend.transport === "convex" && new URL(backend.signInUrl).origin !== siteUrl) {
    const signIn = await readConfig(
      new URL(backend.signInUrl).origin,
      fetchFn,
      `Critiqs can't reach its sign-in service at ${backend.signInUrl}`,
      SIGN_IN_PROTOCOL,
    );
    if (!signIn.current) throw new Error(`Critiqs's sign-in service at ${backend.signInUrl} isn't ready for this version of Critiqs yet.`);
  }
  return { backendUrl, siteUrl, signInUrl: backend.signInUrl, transport: backend.transport, signIn: backend.signIn, mockups: backend.mockups, personalAi: backend.personalAi, modelLists: backend.modelLists, organizations: backend.organizations, organizationMembers: backend.organizationMembers, overageCap: backend.overageCap, billing: backend.billing, addressLists: backend.addressLists, addressEdits: backend.addressEdits, createKeys: backend.createKeys, presetTags: backend.presetTags, connections: backend.connections, ...(backend.website === undefined ? {} : { website: backend.website }) };
}

/** The usage query's `aiCredits` argument, only for backends that accept it: those that report `overageCap` came with it. */
export function creditsArg(deployment: Deployment): { aiCredits?: true } {
  return deployment.overageCap === true ? { aiCredits: true } : {};
}

/**
 * Critiqs project IDs: a Convex document ID (lowercase letters and digits), or
 * a self-hosted server's (`p_` and 32 hex digits). Matches the CLI's pattern.
 */
export const PROJECT_ID_PATTERN = /^([a-z0-9]{16,64}|p_[0-9a-f]{32})$/;

/**
 * Whether the backend knows a project, from its public health report. Only an
 * explicit "missing" counts; anything else (an older backend, a failed request)
 * is "unknown", so Critiqs isn't hidden by a check that couldn't run.
 */
export async function checkProject(deployment: Deployment, projectId: string, fetchFn: typeof fetch = fetch): Promise<"found" | "missing" | "unknown"> {
  try {
    const response = await fetchFn(`${deployment.siteUrl}/critiqs/health?projectId=${encodeURIComponent(projectId)}`);
    if (!response.ok) return "unknown";
    const health = (await response.json()) as { project?: string };
    return health.project === "found" || health.project === "missing" ? health.project : "unknown";
  } catch {
    return "unknown";
  }
}
