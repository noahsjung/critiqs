import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { AiModelListDraft, AiSettingsInput, PageRequest, PersonalAiSettingsInput, ReactionRow, SearchScope, ThreadDetail, ThreadDetailPage, ThreadPageView } from "@critiqs/core";
import {
  applyAiSettings,
  applyPersonalAiSettings,
  getAiChoice,
  getAiSettings,
  getPersonalAiSettings,
  getPersonalAiUsage,
  prepareModelList,
  preparePersonalModelList,
  preparePersonalTest,
  prepareTest,
  recordPersonalTest,
  recheckAiManager,
  recordTest,
  removePersonalAiSettings,
  requirePersonalAiOwner,
  testConnection,
} from "../ai/connection.ts";
import { type CreditSteps, reserveCredits, settleCredits } from "../ai/credits.ts";
import { listModels } from "../ai/model-lists.ts";
import { type AddressCheckDeps, checkPrototypeAddress, nodeNetwork } from "../address-check.ts";
import { applyGrouping, claimGrouping, failGrouping, groupDueTags } from "../ai/grouping.ts";
import type { StructuredModel } from "../ai/model.ts";
import { authorizeSearch, finalizeSearch, prepareSearch, retrieveSearch, runSearch } from "../ai/search.ts";
import { type AiDeployment, type AiConnectionConfig, prepareSettings, type ResolvedConnection, sealKey } from "../ai/settings.ts";
import { keyBinding, validEncryptionKey } from "../ai/secrets.ts";
import { CritiqsError, fail } from "../errors.ts";
import {
  canReview,
  claimInviteEmail,
  getOrganization,
  inviteMember,
  listMyOrganizations,
  removeMember,
  renameOrganization,
  revokeInvite,
  setMemberRole,
  setOverageCap,
} from "../organizations.ts";
import {
  applyPreferenceLink,
  beginDelivery,
  advanceReplyEmails,
  claimDue,
  type DeliveryResult,
  makeDeliveryPageKey,
  cleanUpDeliveries,
  completeDeliveries,
  deliverOne,
  deliveryAllowed,
  discussionPage,
  freezeDelivery,
  isLocalReviewAddress,
  type LinkScope,
  preferenceToken,
  readPreferenceToken,
  stillMentions,
} from "../notify.ts";
import {
  deliverDeveloperEmail,
  getDeveloperSetup,
  getProjectSetup,
  listDeveloperSends,
  prepareDeveloperEmail,
  readReportToken,
  recordDeveloperEmail,
  REPORT_DONE,
  REPORT_PATH,
  REPORT_QUESTION,
  reportToken,
  reportUnwantedEmail,
  reserveDeveloperSends,
  setupUrl,
  webBase,
} from "../developer-setup.ts";
import { readBody } from "./body.ts";
import { claimAddressCheck, clearConnected, MAX_CONNECTION_REPORT_BYTES, reportConnected, saveAboutYou } from "../onboarding.ts";
import * as ops from "../operations.ts";
import {
  addProjectAddress,
  findProjectsForOrigin,
  getProjectAddresses,
  listManageableProjects,
  recordProjectOpened,
  removeProjectAddress,
  setProjectAddresses,
} from "../project-addresses.ts";
import {
  CODE_MINUTES,
  cleanCode,
  codeDigest,
  countUse,
  displayName,
  EMAIL_SEND_LIMIT,
  EMAIL_SEND_WINDOW_MS,
  generateCode,
  GLOBAL_SEND_LIMIT,
  GLOBAL_SEND_WINDOW_MS,
  MailError,
  type Mailer,
  MAX_CODE_SENDS,
  MAX_GUESSES,
  normalizeEmail,
  preparedMessage,
  resendMailer,
  sameDigest,
  signInCodeMessage,
} from "../signin.ts";
import type { SqlDriver } from "../sqlite/driver.ts";
import { SqliteStore } from "../sqlite/store.ts";
import type { Identity, Store, UserRecord } from "../store.ts";
import { codePage, donePage, emailPage, messagePage, namePage, preferencePage, reportPage } from "./pages.ts";
import { ARGUMENTS } from "./validate.ts";

// Critiqs's server inside the host app's own Node or Bun server, storing
// feedback in a SQLite file. The host mounts one request handler at a path
// such as /critiqs, and passes that URL as the component's `backend`. The
// component checks for changes every few seconds instead of live updates.

/** The backend version this server provides; see the component's `BACKEND_PROTOCOL`. */
const PROTOCOL = 5;
const ATTEMPT_MINUTES = 30;
const SESSION_DAYS = 90;
const SESSION_COOKIE = "critiqs_session";
const ATTEMPT_COOKIE = "critiqs_sign_in";
/** Header every API call carries. Browsers send custom headers cross-site only after a preflight this server never allows. */
const REQUEST_HEADER = "X-Critiqs-Request";
const WORKER_MS = 60_000;
/** Largest API call or sign-in form, so requests can't exhaust the host app's memory. */
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FORM_BYTES = 16 * 1024;
/** Mention emails waiting longer than this mean sending isn't running. */
const OVERDUE_MS = 10 * 60_000;
const BATCH = 25;

/** Someone the host app has already signed in. */
export interface HostUser {
  /** The host app's permanent ID for them. */
  id: string;
  name: string;
  /** Where mention emails go; the host app vouches that it is theirs. */
  email: string;
  pictureUrl?: string | null;
}

export interface CritiqsHandlerOptions {
  /** A SQLite file path, or an open database through a Critiqs SQL driver. */
  database: string | SqlDriver;
  /** Where the host mounts the handler; the component's `backend` is this URL. Default `/critiqs`. */
  basePath?: string;
  /** Resend key and sender for sign-in codes and mention emails. */
  email?: { resendApiKey: string; from: string };
  /**
   * Uses the host app's own sign-in instead of Critiqs's: returns who made the
   * request, or null when nobody is signed in to the host app.
   */
  identify?: (request: Request) => HostUser | null | Promise<HostUser | null>;
  /**
   * Shows sign-in codes on screen instead of emailing them, only for requests
   * whose connection comes from this computer (see `fetch`'s `remoteAddress`).
   */
  developmentSignIn?: boolean;
  /** For tests: a mail service in place of Resend. */
  mailer?: Mailer;
  /**
   * AI for automatic tag grouping, natural-language search, and insights. The
   * provider here is the default for every project; with `encryptionKey`,
   * project owners can also connect their own provider in Critiqs, whose keys
   * are stored encrypted. Read these from your server's environment; never
   * put keys in browser code. Without AI, search and grouping still work
   * without it.
   */
  ai?: CritiqsAiOptions;
  /** For tests: models in place of real providers. */
  aiModel?: (connection: Extract<ResolvedConnection, { ready: true }>) => StructuredModel;
  /** For tests: what model lists are fetched with, in place of the network. */
  aiFetch?: typeof fetch;
  /**
   * Onboarding's address check fetches addresses people type, refusing
   * private and local addresses. It can't see where the host's network routes
   * a public address: run this server with outbound traffic restricted to the
   * internet, or pass `false` to turn the check off. For tests, a resolver and
   * connections in place of the network.
   */
  addressCheck?: AddressCheckDeps | false;
  /**
   * The Critiqs website that setup links in developer setup emails open, such
   * as `https://critiqs.app`: HTTPS, or HTTP on this computer. Without it,
   * `publicUrl`, or `email`, this server sends no setup emails.
   */
  webUrl?: string;
  /**
   * The public address of the app this server runs in, such as
   * `https://app.example.com`: HTTPS, or HTTP on this computer. Report links
   * in developer setup emails start with it, then `basePath`. Without it,
   * `webUrl`, or `email`, this server sends no setup emails.
   */
  publicUrl?: string;
}

export interface CritiqsAiOptions {
  provider?: AiConnectionConfig["provider"];
  model?: string;
  apiKey?: string;
  /** The provider's address; required for an OpenAI-compatible endpoint, such as `http://localhost:11434/v1` for Ollama. */
  baseURL?: string;
  /** At least 32 random characters, such as from `openssl rand -base64 32`; lets owners store their own keys, encrypted. */
  encryptionKey?: string;
  /** Endpoint addresses owners may enter, such as `https://llm.example.com/v1`. */
  allowedEndpoints?: string[];
  /** Allows `http://` and private-network addresses among `allowedEndpoints`, for providers on your own network. */
  allowLocalEndpoints?: boolean;
  /** Longest a model request may take. Default 30 seconds. */
  timeoutMs?: number;
}

export interface CritiqsHandler {
  /**
   * Answers a request. `remoteAddress` is the connection's address, which
   * development sign-in needs to know a request comes from this computer.
   */
  fetch(request: Request, connection?: { remoteAddress?: string }): Promise<Response>;
  /** Sends due mention emails now; also runs every minute. */
  deliverMentionEmails(): Promise<void>;
  /** Groups tags waiting for automatic grouping now; also runs every minute. */
  groupTags(): Promise<void>;
  store: SqliteStore;
  /** Stops the mention email and grouping timer. */
  close(): void;
}

const STATUS: Record<string, number> = {
  unauthenticated: 401,
  "email-unverified": 403,
  forbidden: 403,
  "not-found": 404,
  unavailable: 410,
  invalid: 400,
  limit: 429,
  "setup-ai": 403,
};

async function openDatabase(path: string): Promise<SqlDriver> {
  const { bunDriver, preparedDriver } = await import("../sqlite/driver.ts");
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return bunDriver(db);
  }
  const { DatabaseSync } = await import("node:sqlite").catch((error: unknown) => {
    if ((error as { code?: string }).code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    throw new Error("Critiqs's built-in SQLite server requires Node.js 22.13 or later, or Bun. Node.js 20 supports the browser package and CLI, but not this SQLite server.", { cause: error });
  });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return preparedDriver(db as never);
}

/** Whether a connection's address is this computer: 127.0.0.0/8 or ::1, plain or IPv4-mapped. */
export const isLoopbackAddress = (address: string | undefined) =>
  address !== undefined && /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(address);

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/** Whether the browser reached this server over HTTPS, directly or through a proxy. */
function secure(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("X-Forwarded-Proto") === "https";
}

function cookie(request: Request, name: string, value: string, path: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure(request) ? "; Secure" : ""}`;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(new TextDecoder().decode(await readBody(request, MAX_FORM_BYTES)));
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Creates Critiqs's request handler for a host app's server. */
export async function createCritiqsHandler(options: CritiqsHandlerOptions): Promise<CritiqsHandler> {
  const base = (options.basePath ?? "/critiqs").replace(/\/$/, "");
  const sql = typeof options.database === "string" ? await openDatabase(options.database) : options.database;
  const store = new SqliteStore(sql);
  const mailer = options.mailer ?? (options.email ? resendMailer({ apiKey: options.email.resendApiKey, from: options.email.from }) : null);
  /** Increases with every change, so the component knows when to look again. */
  let version = Date.now();
  const aiOptions = options.ai ?? {};
  const deployment: AiDeployment = {
    // Critiqs-managed AI belongs to Critiqs Cloud; a server in the host app connects its own.
    managed: null,
    defaultProvider:
      aiOptions.provider !== undefined && aiOptions.model
        ? {
            provider: aiOptions.provider,
            model: aiOptions.model,
            ...(aiOptions.apiKey ? { apiKey: aiOptions.apiKey } : {}),
            ...(aiOptions.baseURL ? { baseUrl: aiOptions.baseURL.replace(/\/+$/, "") } : {}),
          }
        : null,
    encryptionKey: validEncryptionKey(aiOptions.encryptionKey) ? aiOptions.encryptionKey : null,
    endpoints: { allowed: aiOptions.allowedEndpoints ?? [], allowLocal: aiOptions.allowLocalEndpoints === true },
  };
  if (aiOptions.encryptionKey && deployment.encryptionKey === null) {
    throw new Error("Critiqs's ai.encryptionKey must have at least 32 characters, such as from `openssl rand -base64 32`.");
  }
  const credits: CreditSteps = {
    reserve: (payer, amount) => store.transaction((s) => reserveCredits(s, payer, amount, Date.now())),
    settle: (hold, charge) => store.transaction((s) => settleCredits(s, hold, charge, Date.now())),
  };
  /** A model for a connection; the AI SDK loads only when a model is first used. */
  const modelFor = (connection: Extract<ResolvedConnection, { ready: true }>): StructuredModel => {
    const standIn = options.aiModel?.(connection);
    // A stand-in sends nothing itself; it is checked once, as a provider's request would be.
    if (standIn !== undefined) {
      return {
        description: standIn.description,
        generate: async (request) => {
          await request.beforeSend?.();
          return await standIn.generate(request);
        },
      };
    }
    return {
      description: `${connection.provider} · ${connection.model}`,
      generate: async (request) => {
        const { createStructuredModel } = await import("../ai/providers.ts");
        return await createStructuredModel(connection, { timeoutMs: aiOptions.timeoutMs }).generate(request);
      },
    };
  };
  /** How model lists reach providers: within the request time limit, and through the test stand-in when one is given. */
  const modelListOptions = {
    ...(aiOptions.timeoutMs === undefined ? {} : { timeoutMs: aiOptions.timeoutMs }),
    ...(options.aiFetch === undefined ? {} : { fetch: options.aiFetch }),
  };
  const web = webBase(options.webUrl, null);
  if (options.webUrl !== undefined && web === null) {
    throw new Error("Critiqs's webUrl must be an https:// address (or http:// on this computer) with no query or hash.");
  }
  // Never learned from requests: the first one can come from inside the network, under another host name.
  const publicBase = webBase(options.publicUrl, null);
  if (options.publicUrl !== undefined && publicBase === null) {
    throw new Error("Critiqs's publicUrl must be an https:// address (or http:// on this computer) with no query or hash.");
  }
  /** What developer setup emails need: email, the website setup links open, and this server's public address; null without one. */
  const developerEmails = mailer !== null && web !== null && publicBase !== null ? { mailer, web, publicBase } : null;
  const addressCheckDeps = options.addressCheck ?? nodeNetwork({ http, https, Resolver });
  const addressCheckOn = addressCheckDeps !== false;
  /** The address people reach this server at, learned from requests, for links in emails. */
  let publicOrigin: string | null = null;

  const secret = (key: string) =>
    store.withSql((db) => {
      const existing = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
      if (existing !== undefined) return existing.value;
      const value = randomToken();
      db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, value]);
      return value;
    });

  /** Each request's connection address, from the host's server; the Host header can't show where a request came from. */
  const clients = new WeakMap<Request, string | undefined>();

  function signInMode(request: Request): "host" | "email" | "development" | "unavailable" {
    if (options.identify) return "host";
    if (mailer !== null) return "email";
    if (options.developmentSignIn && isLoopbackAddress(clients.get(request))) return "development";
    return "unavailable";
  }

  /** Who made the request, as Critiqs's operations expect it. */
  async function identityOf(request: Request): Promise<Identity | null> {
    if (options.identify) {
      const user = await options.identify(request);
      if (user === null) return null;
      return {
        tokenIdentifier: `host|${user.id}`,
        name: user.name,
        email: user.email,
        emailVerified: true,
        pictureUrl: user.pictureUrl ?? null,
        profileVersion: null,
      };
    }
    const token = cookieValue(request, SESSION_COOKIE);
    if (token === null) return null;
    const tokenHash = await sha256(token);
    const user = await store.withSql((db) => {
      const session = db.get<{ user_id: string; ends_at: number }>("SELECT user_id, ends_at FROM sessions WHERE token_hash = ?", [tokenHash]);
      if (session === undefined || session.ends_at <= Date.now()) return null;
      return db.get<{ token: string; name: string; email: string | null; image_url: string | null; profile_version: number | null }>(
        "SELECT token, name, email, image_url, profile_version FROM users WHERE id = ?",
        [session.user_id],
      ) ?? null;
    });
    if (user === null) return null;
    return {
      tokenIdentifier: user.token,
      name: user.name,
      email: user.email,
      emailVerified: user.email !== null,
      pictureUrl: user.image_url,
      profileVersion: user.profile_version,
    };
  }

  // -------------------------------------------------------------------------
  // The component's API

  type Run = (store: Store, identity: Identity | null) => Promise<unknown>;
  const all = async <T,>(load: (page: PageRequest) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>) => {
    const rows: T[] = [];
    let cursor: string | null = null;
    for (;;) {
      const result = await load({ numItems: ops.PAGE_SIZE, cursor });
      rows.push(...result.page);
      if (result.isDone) return rows;
      cursor = result.continueCursor;
    }
  };
  const queries: Record<string, (args: any) => Run> = {
    project: (args) => (s, id) => ops.getProject(s, id, args),
    myProjects: () => (s, id) => all((page) => ops.listMyProjects(s, id, page)),
    myOrganizations: () => (s, id) => listMyOrganizations(s, id),
    organization: (args) => (s, id) => getOrganization(s, id, args),
    threads: (args) => (s, id) => all((page) => ops.listThreads(s, id, args, page)),
    thread: (args) => (s, id) => loadThread(s, id, args),
    threadPage: (args) => (s, id) => loadThreadPage(s, id, args),
    participants: (args) => (s, id) => ops.listParticipants(s, id, args),
    participantsNamed: (args) => (s, id) => ops.listParticipantsNamed(s, id, args),
    notificationSettings: (args) => (s, id) => ops.getNotificationSettings(s, id, args),
    usage: (args) => (s, id) => ops.getUsage(s, id, args),
    tags: (args) => (s, id) => ops.listTags(s, id, args),
    aiSettings: (args) => (s, id) => getAiSettings(s, id, args, deployment),
    personalAiSettings: () => (s, id) => getPersonalAiSettings(s, id, deployment),
    personalAiUsage: (args) => (s, id) => getPersonalAiUsage(s, id, args),
    aiChoice: (args) => (s, id) => getAiChoice(s, id, args, deployment),
    exportPage: ({ paginationOpts, ...args }) => (s, id) => ops.exportThreads(s, id, args, paginationOpts),
    developerSetup: (args) => (s, id) => getDeveloperSetup(s, id, args),
    projectSetup: (args) => (s, id) => getProjectSetup(s, id, args),
    developerSends: (args) => (s, id) => listDeveloperSends(s, id, args),
    projectAddresses: (args) => (s, id) => getProjectAddresses(s, id, args),
    findProjectsForOrigin: (args) => (s, id) => findProjectsForOrigin(s, id, args),
    manageableProjects: () => (s, id) => listManageableProjects(s, id),
  };
  const changes: Record<string, (args: any) => Run> = {
    sync: () => (s, id) => ops.syncReviewer(s, id),
    createProject: (args) => (s, id) => ops.createProject(s, id, args),
    saveAboutYou: (args) => (s, id) => saveAboutYou(s, id, args),
    clearConnected: (args) => (s, id) => clearConnected(s, id, args),
    setReviewUrl: (args) => (s, id) => ops.setReviewUrl(s, id, args),
    setReviewAccess: (args) => (s, id) => ops.setReviewAccess(s, id, args),
    setProjectAddresses: (args) => (s, id) => setProjectAddresses(s, id, args),
    addProjectAddress: (args) => (s, id) => addProjectAddress(s, id, args),
    removeProjectAddress: (args) => (s, id) => removeProjectAddress(s, id, args),
    recordProjectOpened: (args) => (s, id) => recordProjectOpened(s, id, args),
    setOverageCap: (args) => (s, id) => setOverageCap(s, id, args),
    createThread: (args) => (s, id) =>
      // This server doesn't store mockups yet; its /critiqs/config doesn't offer them.
      args.mockup === undefined ? ops.createThread(s, id, args) : fail("unavailable", "Mockups aren't available on this Critiqs server."),
    reply: (args) => (s, id) => ops.reply(s, id, args),
    threadPageKey: (args) => (s, id) => ops.threadPageKey(s, id, args),
    editMessage: (args) => (s, id) => ops.editMessage(s, id, args),
    toggleReaction: (args) => (s, id) => ops.toggleReaction(s, id, args),
    setStatus: (args) => (s, id) => ops.setStatus(s, id, args),
    remove: (args) => (s, id) => ops.removeThread(s, id, args),
    setTags: (args) => (s, id) => ops.setTags(s, id, args),
    reattach: (args) => (s, id) => ops.reattach(s, id, args),
    attachScreenshot: (args) => (s, id) => ops.attachScreenshot(s, id, args),
    markRead: (args) => (s, id) => ops.markRead(s, id, args),
    markUnread: (args) => (s, id) => ops.markUnread(s, id, args),
    setNotificationSettings: (args) => (s, id) => ops.setNotificationSettings(s, id, args),
    createTagGroup: (args) => (s, id) => ops.createGroup(s, id, args),
    renameTagGroup: (args) => (s, id) => ops.renameGroup(s, id, args),
    deleteTagGroup: (args) => (s, id) => ops.deleteGroup(s, id, args),
    mergeTagGroups: (args) => (s, id) => ops.mergeGroups(s, id, args),
    setTagGroups: (args) => (s, id) => ops.setTagGroups(s, id, args),
    setPresetTags: (args) => (s, id) => ops.setPresetTags(s, id, args),
    removePersonalAiSettings: () => (s, id) => removePersonalAiSettings(s, id, deployment),
    renameOrganization: (args) => (s, id) => renameOrganization(s, id, args),
    revokeInvite: (args) => (s, id) => revokeInvite(s, id, args),
    setMemberRole: (args) => (s, id) => setMemberRole(s, id, args),
    removeMember: (args) => (s, id) => removeMember(s, id, args),
  };
  /** Calls that run in several transactions, with work between them such as a model request or an email. */
  const actions: Record<string, (args: any, identity: Identity | null) => Promise<unknown>> = {
    inviteMember: async ({ projectId, ...args }: { organizationId: string; email: string; role: "admin" | "member"; projectId?: string }, identity) => {
      const result = await store.transaction((s) => inviteMember(s, identity, args, Date.now()));
      if (result.status !== "invited") return { status: result.status };
      version++;
      const message = mailer === null ? null : await store.transaction((s) => claimInviteEmail(s, { inviteId: result.inviteId, projectId }, Date.now()));
      // Without email, past an email limit, or when the send fails, the person still joins by signing in; `email` lets the interface say which.
      const sent =
        message !== null &&
        (await mailer!.send(message).then(
          () => true,
          (error) => (console.error("Critiqs couldn't send an invite email:", error instanceof Error ? error.message : "unknown error"), false),
        ));
      return { status: "invited", email: sent ? "sent" : "not-sent" } as const;
    },
    search: (args: { projectId: string; question: string; scope: SearchScope }, identity) =>
      runSearch({
        prepare: () => store.transaction((s) => prepareSearch(s, identity, args, deployment, Date.now())),
        authorize: () => store.transaction((s) => authorizeSearch(s, identity, { projectId: args.projectId })),
        retrieve: (query, groups) => store.transaction((s) => retrieveSearch(s, identity, { projectId: args.projectId, query, groups })),
        finalize: (response) => store.transaction((s) => finalizeSearch(s, identity, { projectId: args.projectId, response })),
        ...credits,
        model: modelFor,
        deployment,
        now: Date.now(),
      }),
    saveAiSettings: async (input: AiSettingsInput, identity) => {
      // Only the owner, before a key is even encrypted.
      await store.transaction((s) => getAiSettings(s, identity, { projectId: input.projectId }, deployment));
      const prepared = await sealKey(await prepareSettings(input, deployment), keyBinding("project", input.projectId), deployment);
      return await store.transaction((s) => applyAiSettings(s, identity, { projectId: input.projectId, prepared }, deployment, Date.now()));
    },
    testAiConnection: (args: { projectId: string; draft?: AiSettingsInput }, identity) =>
      testConnection(
        {
          prepare: () => store.transaction((s) => prepareTest(s, identity, args, deployment, Date.now())),
          record: (epoch, result) => store.transaction((s) => recordTest(s, identity, { projectId: args.projectId, epoch, result }, Date.now())),
          recheck: () => store.transaction((s) => recheckAiManager(s, identity, { projectId: args.projectId })),
          ...credits,
          model: modelFor,
          deployment,
        },
        args.draft === undefined ? undefined : { ...args.draft, projectId: args.projectId },
      ),
    savePersonalAiSettings: async (input: PersonalAiSettingsInput, identity) => {
      // The person's own key is bound to them before it is encrypted.
      const { userId } = await store.transaction((s) => requirePersonalAiOwner(s, identity));
      const prepared = await sealKey(await prepareSettings(input, deployment), keyBinding("personal", userId), deployment);
      return await store.transaction((s) => applyPersonalAiSettings(s, identity, { prepared }, deployment, Date.now()));
    },
    testPersonalAiConnection: async (args: { draft?: PersonalAiSettingsInput }, identity) => {
      let userId = "";
      return await testConnection(
        {
          prepare: async () => {
            const prepared = await store.transaction((s) => preparePersonalTest(s, identity, Date.now()));
            userId = prepared.ownerId;
            return prepared;
          },
          record: (epoch, result) => store.transaction((s) => recordPersonalTest(s, { userId, epoch, result }, Date.now())),
          ...credits,
          model: modelFor,
          deployment,
        },
        args.draft,
      );
    },
    listAiModels: (args: { projectId: string; draft?: AiModelListDraft }, identity) =>
      listModels(
        {
          prepare: () => store.transaction((s) => prepareModelList(s, identity, args, Date.now())),
          recheck: () => store.transaction((s) => recheckAiManager(s, identity, { projectId: args.projectId })),
          deployment,
          ...modelListOptions,
        },
        args.draft,
      ),
    listPersonalAiModels: (args: { draft?: AiModelListDraft }, identity) =>
      listModels({ prepare: () => store.transaction((s) => preparePersonalModelList(s, identity, Date.now())), deployment, ...modelListOptions }, args.draft),
    // Reserved and counted in one transaction, then each email sent and its answer recorded in its own.
    sendDeveloperSetup: async (args: { projectId: string; emails: string[] }, identity) => {
      if (developerEmails === null) fail("unavailable", "This Critiqs server can't send setup emails. Copy the message instead.");
      const { mailer: sender, web: site, publicBase: origin } = developerEmails;
      const { results, reserved } = await store.transaction((s) => reserveDeveloperSends(s, identity, args, Date.now()));
      if (reserved.length > 0) version++;
      const reportSecret = await secret("preference-links");
      for (const { sendId, idempotencyKey } of reserved) {
        const reportUrl = `${origin}${base}${REPORT_PATH}?token=${encodeURIComponent(await reportToken(reportSecret, sendId))}`;
        await deliverDeveloperEmail({
          prepare: () => store.transaction((s) => prepareDeveloperEmail(s, { sendId, idempotencyKey, setupUrl: setupUrl(site, sendId), reportUrl }, Date.now())),
          send: (message) => sender.send(message),
          record: async (attempt, answer) => {
            const status = await store.transaction((s) => recordDeveloperEmail(s, { sendId, idempotencyKey, attempt, answer }));
            version++;
            return status;
          },
        }).catch((error) => console.error("Critiqs couldn't send a setup email:", error instanceof Error ? error.message : "unknown error"));
      }
      return results;
    },
    // Counted in one transaction, then fetched outside it, so a slow address doesn't hold the database.
    checkPrototypeAddress: (args: { address: string }, identity) =>
      addressCheckDeps === false
        ? fail("unavailable", "This Critiqs server doesn't check prototype addresses.")
        : checkPrototypeAddress({ claim: () => store.transaction((s) => claimAddressCheck(s, identity, Date.now())), deps: addressCheckDeps }, args),
  };

  async function loadThread(s: Store, identity: Identity | null, args: { threadId: string }): Promise<ThreadDetail> {
    return await wholeThread(s, identity, (page) => ops.getThread(s, identity, args, page));
  }

  /** A thread page, only for those who may open it; it records nothing, never an opened project. */
  async function loadThreadPage(s: Store, identity: Identity | null, args: { key: string }): Promise<ThreadPageView> {
    return await wholeThread(s, identity, (page) => ops.getThreadPage(s, identity, args, page));
  }

  /** Every page of a thread's discussion, with its reactions, in one transaction. */
  async function wholeThread<P extends ThreadDetailPage>(
    s: Store,
    identity: Identity | null,
    load: (page: PageRequest) => Promise<P>,
  ): Promise<Omit<P, "page" | "isDone" | "continueCursor"> & Pick<ThreadDetail, "messages">> {
    const pages: P[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: P = await load({ numItems: ops.PAGE_SIZE, cursor });
      pages.push(page);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const { page: _page, isDone: _done, continueCursor: _cursor, ...thread } = pages[0]!;
    const reactions: ReactionRow[] = await all((page) => ops.listReactions(s, identity, { threadId: thread._id }, page));
    return {
      ...thread,
      messages: pages
        .flatMap((page) => page.page)
        .map((message) => {
          const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
          for (const reaction of reactions) {
            if (reaction.messageId !== message._id) continue;
            const entry = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
            entry.count++;
            entry.mine ||= reaction.mine;
            byEmoji.set(reaction.emoji, entry);
          }
          return { ...message, reactions: [...byEmoji.values()] };
        }),
    };
  }

  /** API calls must come from this site's own pages. */
  function sameSite(request: Request): boolean {
    if (request.headers.get(REQUEST_HEADER) !== "1") return false;
    const origin = request.headers.get("Origin");
    return origin === null || new URL(origin).host === new URL(request.url).host;
  }

  function failure(error: unknown): Response {
    if (error instanceof CritiqsError) return json({ error: { code: error.code, message: error.message } }, STATUS[error.code] ?? 400);
    throw error;
  }

  async function api(request: Request, name: string): Promise<Response> {
    if (request.method !== "POST" || !sameSite(request)) return json({ error: { code: "forbidden", message: "Not allowed." } }, 403);
    const make = queries[name] ?? changes[name];
    const action = actions[name];
    const shape = ARGUMENTS[name];
    if ((make === undefined && action === undefined) || shape === undefined) {
      return json({ error: { code: "not-found", message: "Unknown request." } }, 404);
    }
    try {
      const args = JSON.parse(new TextDecoder().decode(await readBody(request, MAX_JSON_BYTES)));
      shape(args, "args");
      const identity = await identityOf(request);
      const value = action !== undefined ? await action(args, identity) : await store.transaction((s) => make!(args)(s, identity));
      // Recording an opened project changes nothing anyone is shown.
      if ((name in changes && name !== "recordProjectOpened") || name === "saveAiSettings" || name === "savePersonalAiSettings") version++;
      // A reply's emails to everyone in its thread are queued right away, outside the request.
      if (name === "reply") void queueReplyEmails().catch(() => {});
      return json({ value: value ?? null });
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: { code: "invalid", message: "Bad request." } }, 400);
      return failure(error);
    }
  }

  async function upload(request: Request): Promise<Response> {
    if (request.method !== "POST" || !sameSite(request)) return json({ error: { code: "forbidden", message: "Not allowed." } }, 403);
    const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
    try {
      // Who may upload is checked before reading any of the image.
      const identity = await identityOf(request);
      await store.transaction((s) => ops.authorizeUpload(s, identity, { projectId }));
      const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ops.IMAGE_TYPES.includes(contentType)) fail("invalid", "Upload a PNG, JPEG, WebP, or GIF image.");
      const data = await readBody(request, ops.MAX_IMAGE_BYTES, "Images must be 10 MB or smaller.");
      // Access can end while the image arrives, so it is checked again in the transaction that saves it.
      const fileId = await store.transaction(async (s) => {
        await ops.authorizeUpload(s, identity, { projectId });
        return await store.saveFile(data, contentType);
      });
      return json({ fileId });
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * A thread's image by its thread's ID, or by its thread page's key (the `X-Critiqs-Thread-Page` header, which keeps
   * it out of the address that access logs record, or `threadPage`), after the same checks as reading either.
   */
  async function capture(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const key = request.headers.get("X-Critiqs-Thread-Page") ?? params.get("threadPage");
    const threadId = params.get("threadId") ?? "";
    const identity = await identityOf(request);
    try {
      // Read in the transaction that checks access, so no change to access can come between them.
      const file = await store.transaction(async (s) => {
        const fileId = key === null ? await ops.authorizedCapture(s, identity, { threadId }) : await ops.authorizedPageCapture(s, identity, { key });
        return fileId === null ? null : store.readFile(fileId);
      });
      if (file === null) return new Response("No capture", { status: 404 });
      return new Response(file.data as Uint8Array<ArrayBuffer>, {
        headers: {
          "Content-Type": file.contentType !== null && ops.IMAGE_TYPES.includes(file.contentType) ? file.contentType : "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          // An image opened directly can never run anything on the host app's site.
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "private, no-store",
        },
      });
    } catch (error) {
      if (error instanceof CritiqsError) return new Response(error.message, { status: STATUS[error.code] ?? 400 });
      throw error;
    }
  }

  async function me(request: Request): Promise<Response> {
    const identity = await identityOf(request);
    if (identity === null) return json({ reviewer: null });
    try {
      // Records a host-app reviewer the first time, so their ID never changes between answers.
      const user = await store.transaction((s) => ops.requireUser(s, identity));
      return json({ reviewer: { id: user._id, name: user.name, email: identity.email, pictureUrl: identity.pictureUrl } });
    } catch (error) {
      return failure(error);
    }
  }

  // -------------------------------------------------------------------------
  // Critiqs's own sign-in, when the host app doesn't provide one

  type Attempt = {
    key_hash: string;
    binding_hash: string;
    state: string;
    email: string | null;
    generation: number;
    code_digest: string | null;
    code_expires_at: number | null;
    guesses: number;
    verified: number;
    expires_at: number;
  };

  async function attemptFor(request: Request, key: string): Promise<Attempt | null> {
    const binding = cookieValue(request, ATTEMPT_COOKIE);
    if (binding === null || key === "") return null;
    const [keyHash, bindingHash] = [await sha256(key), await sha256(binding)];
    const attempt = await store.withSql((db) => db.get<Attempt>("SELECT * FROM sign_in_attempts WHERE key_hash = ?", [keyHash]) ?? null);
    if (attempt === null || attempt.expires_at <= Date.now() || !sameDigest(attempt.binding_hash, bindingHash)) return null;
    return attempt;
  }

  const expired = () => messagePage("Sign-in expired", "This sign-in window has expired. Close it and sign in again.");

  async function startSignIn(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    if (state === "" || state.length > 200) return messagePage("Can't sign in", "This sign-in link is incomplete. Close this window and try again.");
    if (signInMode(request) === "host") {
      return messagePage("Sign in to the app", "This app signs reviewers in itself. Close this window and sign in to the app.", 400);
    }
    if (signInMode(request) === "unavailable") {
      return messagePage("Sign-in unavailable", "This server can't send sign-in codes yet. Its developer needs to set up email.", 503);
    }
    const key = randomToken();
    const binding = randomToken();
    const now = Date.now();
    const [keyHash, bindingHash] = [await sha256(key), await sha256(binding)];
    await store.withSql((db) => {
      db.run("DELETE FROM sign_in_attempts WHERE expires_at <= ?", [now]);
      db.run("INSERT INTO sign_in_attempts (key_hash, binding_hash, state, expires_at) VALUES (?, ?, ?, ?)", [
        keyHash,
        bindingHash,
        state,
        now + ATTEMPT_MINUTES * 60_000,
      ]);
    });
    const response = emailPage(base, key);
    response.headers.append("Set-Cookie", cookie(request, ATTEMPT_COOKIE, binding, `${base}/auth`, ATTEMPT_MINUTES * 60));
    return response;
  }

  /** The attempt as stored now, inside the current transaction; null once it ended. */
  function liveAttempt(db: SqlDriver, keyHash: string, now: number): Attempt | null {
    const attempt = db.get<Attempt>("SELECT * FROM sign_in_attempts WHERE key_hash = ?", [keyHash]);
    return attempt === undefined || attempt.expires_at <= now ? null : attempt;
  }

  /** Ends the attempt and starts a session for the reviewer, in the transaction that verified them. */
  async function startSession(db: SqlDriver, keyHash: string, userId: string, now: number): Promise<string> {
    const token = randomToken();
    db.run("DELETE FROM sign_in_attempts WHERE key_hash = ?", [keyHash]);
    db.run("DELETE FROM sessions WHERE ends_at <= ?", [now]);
    db.run("INSERT INTO sessions (token_hash, user_id, created_at, ends_at) VALUES (?, ?, ?, ?)", [
      await sha256(token),
      userId,
      now,
      now + SESSION_DAYS * 86_400_000,
    ]);
    return token;
  }

  const sessionCookie = (request: Request, token: string) => cookie(request, SESSION_COOKIE, token, base, SESSION_DAYS * 86_400);
  const LOCAL_USER = "SELECT id FROM users WHERE email = ? AND token LIKE 'critiqs-local|%' ORDER BY seq LIMIT 1";

  async function sendCode(request: Request): Promise<Response> {
    const form = await readForm(request);
    const key = form.get("key") ?? "";
    const attempt = await attemptFor(request, key);
    if (attempt === null) return expired();
    const email = normalizeEmail(form.get("email") ?? "");
    if (email === null) return emailPage(base, key, "Enter a valid email address.");
    const now = Date.now();
    const code = generateCode();
    const codeSecret = await secret("sign-in-codes");
    const outcome = await store.withSql(async (db) => {
      const current = liveAttempt(db, attempt.key_hash, now);
      if (current === null) return { expired: true as const };
      // Every code this sign-in sends counts, whichever address it goes to.
      if (current.generation >= MAX_CODE_SENDS) return { refused: "Too many codes for this sign-in. Close this window and start again." };
      for (const [counterKey, limit, window] of [
        [`email:${email}`, EMAIL_SEND_LIMIT, EMAIL_SEND_WINDOW_MS],
        ["global", GLOBAL_SEND_LIMIT, GLOBAL_SEND_WINDOW_MS],
      ] as const) {
        const row = db.get<{ count: number; expires_at: number }>("SELECT count, expires_at FROM sign_in_counters WHERE key = ?", [counterKey]);
        const counted = countUse(row === undefined ? null : { count: row.count, expiresAt: row.expires_at }, limit, window, now);
        if (!counted.allowed) return { refused: "Too many codes were sent. Wait a few minutes and try again." };
        db.run("INSERT INTO sign_in_counters (key, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at", [
          counterKey,
          counted.next.count,
          counted.next.expiresAt,
        ]);
      }
      const generation = current.generation + 1;
      const digest = await codeDigest(codeSecret, { attempt: current.key_hash, email, generation, code });
      // A new code replaces any verification: only the address its code proves can be signed in.
      db.run("UPDATE sign_in_attempts SET email = ?, generation = ?, code_digest = ?, code_expires_at = ?, verified = 0 WHERE key_hash = ?", [
        email,
        generation,
        digest,
        now + CODE_MINUTES * 60_000,
        current.key_hash,
      ]);
      return { generation };
    });
    if ("expired" in outcome) return expired();
    if ("refused" in outcome) return emailPage(base, key, outcome.refused);
    const mode = signInMode(request);
    if (mode === "development") return codePage(base, key, email, { developmentCode: code });
    try {
      await mailer!.send(
        signInCodeMessage({ to: email, code, site: new URL(request.url).host, idempotencyKey: `critiqs-sign-in:${attempt.key_hash.slice(0, 16)}:${outcome.generation}` }),
      );
    } catch (error) {
      if (!(error instanceof MailError)) throw error;
      return emailPage(base, key, "The code couldn't be sent. Try again in a moment.");
    }
    return codePage(base, key, email);
  }

  async function checkCode(request: Request): Promise<Response> {
    const form = await readForm(request);
    const key = form.get("key") ?? "";
    const attempt = await attemptFor(request, key);
    if (attempt === null) return expired();
    const codeSecret = await secret("sign-in-codes");
    const now = Date.now();
    // Read, count the guess, and decide in one transaction, so simultaneous guesses can't exceed the limit.
    const outcome = await store.withSql(async (db) => {
      const current = liveAttempt(db, attempt.key_hash, now);
      if (current === null || current.email === null || current.code_digest === null) return { kind: "expired" as const };
      const email = current.email;
      if (current.guesses >= MAX_GUESSES) return { kind: "locked" as const };
      if ((current.code_expires_at ?? 0) <= now) return { kind: "code-expired" as const };
      db.run("UPDATE sign_in_attempts SET guesses = guesses + 1 WHERE key_hash = ?", [current.key_hash]);
      const digest = await codeDigest(codeSecret, {
        attempt: current.key_hash,
        email,
        generation: current.generation,
        code: cleanCode(form.get("code") ?? ""),
      });
      if (!sameDigest(digest, current.code_digest)) return { kind: "wrong" as const, email };
      const user = db.get<{ id: string }>(LOCAL_USER, [email]);
      if (user === undefined) {
        // Verified for this address and this code only; sending another code clears it.
        db.run("UPDATE sign_in_attempts SET verified = ?, code_digest = NULL WHERE key_hash = ?", [current.generation, current.key_hash]);
        return { kind: "needs-name" as const };
      }
      return { kind: "signed-in" as const, token: await startSession(db, current.key_hash, user.id, now), state: current.state };
    });
    if (outcome.kind === "expired") return expired();
    if (outcome.kind === "locked") return messagePage("Too many tries", "Too many wrong codes. Close this window and sign in again.", 429);
    if (outcome.kind === "code-expired") return emailPage(base, key, "That code expired. Send a new one.");
    if (outcome.kind === "wrong") return codePage(base, key, outcome.email, { error: "That code isn't right. Check the email and try again." });
    if (outcome.kind === "needs-name") return namePage(base, key);
    return donePage(outcome.state, sessionCookie(request, outcome.token));
  }

  async function chooseName(request: Request): Promise<Response> {
    const form = await readForm(request);
    const key = form.get("key") ?? "";
    const attempt = await attemptFor(request, key);
    if (attempt === null) return expired();
    const name = displayName(form.get("name") ?? "");
    if (name === null) return namePage(base, key, "Enter a name of up to 60 characters.");
    const now = Date.now();
    const outcome = await store.withSql(async (db, s) => {
      const current = liveAttempt(db, attempt.key_hash, now);
      // Only the address the latest code verified.
      if (current === null || current.email === null || current.verified === 0 || current.verified !== current.generation) return null;
      const userId =
        db.get<{ id: string }>(LOCAL_USER, [current.email])?.id ??
        (await s.users.insert({ tokenIdentifier: `critiqs-local|${crypto.randomUUID()}`, name, email: current.email, imageUrl: null, profileVersion: 1 }));
      return { token: await startSession(db, current.key_hash, userId, now), state: current.state };
    });
    if (outcome === null) return expired();
    return donePage(outcome.state, sessionCookie(request, outcome.token));
  }

  async function signOut(request: Request): Promise<Response> {
    if (request.method !== "POST" || !sameSite(request)) return json({ error: { code: "forbidden", message: "Not allowed." } }, 403);
    const token = cookieValue(request, SESSION_COOKIE);
    if (token !== null) {
      const tokenHash = await sha256(token);
      await store.withSql((db) => db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]));
    }
    return json({ ok: true }, 200, { "Set-Cookie": cookie(request, SESSION_COOKIE, "", base, 0) });
  }

  async function rename(request: Request): Promise<Response> {
    if (request.method !== "POST" || !sameSite(request)) return json({ error: { code: "forbidden", message: "Not allowed." } }, 403);
    if (options.identify) return json({ error: { code: "forbidden", message: "Change your name in the app you signed in to." } }, 403);
    const identity = await identityOf(request);
    const body = (await readBody(request, MAX_FORM_BYTES)
      .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)))
      .catch(() => null)) as { name?: unknown } | null;
    const name = displayName(typeof body?.name === "string" ? body.name : "");
    try {
      if (identity === null) fail("unauthenticated", "Sign in to change your name.");
      if (name === null) fail("invalid", "Enter a name of up to 60 characters.");
      await store.transaction(async (s) => {
        const user = (await s.users.byToken(identity.tokenIdentifier)) as UserRecord;
        await s.users.patch(user._id, { name, profileVersion: (user.profileVersion ?? 0) + 1 });
      });
      version++;
      return json({ name });
    } catch (error) {
      return failure(error);
    }
  }

  // -------------------------------------------------------------------------
  // Mention emails

  /** Queues reply emails to everyone in their threads, a step (one transaction) at a time; one run at a time. */
  let queuingReplies: Promise<void> | null = null;
  function queueReplyEmails(): Promise<void> {
    queuingReplies ??= (async () => {
      try {
        while (await store.transaction((s) => advanceReplyEmails(s, Date.now()))) {}
      } finally {
        queuingReplies = null;
      }
    })();
    return queuingReplies;
  }

  async function deliverMentionEmails(): Promise<void> {
    await queueReplyEmails();
    for (;;) {
      const claimToken = crypto.randomUUID();
      const now = Date.now();
      const ids = await store.transaction((s) => claimDue(s, now, BATCH, claimToken));
      if (ids.length === 0) break;
      const linkSecret = await secret("preference-links");
      const origin = publicOrigin;
      const preferenceUrl = async (scope: LinkScope) =>
        `${origin ?? ""}${base}/notifications/preferences?token=${encodeURIComponent(await preferenceToken(linkSecret, scope))}`;
      const outcomes: { deliveryId: string; claimToken: string; result: DeliveryResult; reason?: string }[] = [];
      for (const id of ids) {
        if (mailer === null || origin === null) {
          outcomes.push({ deliveryId: id, claimToken, result: "skipped", reason: "Email isn't set up for this server." });
          continue;
        }
        const sender = mailer;
        // Each step is its own transaction, so other requests run between pages of a long discussion.
        const outcome = await deliverOne({
          begin: () => store.transaction((s) => beginDelivery(s, { id, claimToken, preferenceUrl })),
          allowed: () => store.transaction((s) => deliveryAllowed(s, { id, claimToken })),
          page: ({ version, cursor }) => store.transaction((s) => discussionPage(s, { id, claimToken, version, cursor })),
          stillMentions: (messageId) => store.transaction((s) => stillMentions(s, { id, claimToken, messageId })),
          // This server passes no website, so its emails never ask for a page key; the step is here for completeness.
          pageKey: () => store.transaction((s) => makeDeliveryPageKey(s, { id, claimToken }, Date.now())),
          freeze: ({ version, fileId, to }) => store.transaction((s) => freezeDelivery(s, { id, claimToken, version, fileId, to })),
          readFile: async (fileId) => {
            const file = store.readFile(fileId);
            return file === null ? null : new Blob([file.data as Uint8Array<ArrayBuffer>]);
          },
          saveFile: async (body) => await store.saveFile(new Uint8Array(await body.arrayBuffer()), "application/json"),
          deleteFile: (fileId) => store.transaction((s) => s.files.delete(fileId)),
          sendPrepared: async (body, idempotencyKey) =>
            sender.sendPrepared ? await sender.sendPrepared(body, idempotencyKey) : await sender.send(preparedMessage(await body.text(), idempotencyKey)),
          sendMessage: (message) => sender.send(message),
        });
        // An email that isn't ready goes back in line at once, with its attempt, rather than after the rest of the batch.
        if (outcome?.result === "deferred") await store.transaction((s) => completeDeliveries(s, [{ deliveryId: id, claimToken, ...outcome }], Date.now()));
        else if (outcome !== null) outcomes.push({ deliveryId: id, claimToken, ...outcome });
      }
      await store.transaction((s) => completeDeliveries(s, outcomes, Date.now()));
      if (ids.length < BATCH) break;
    }
    await store.transaction((s) => cleanUpDeliveries(s, Date.now(), 100));
  }
  let delivering: Promise<void> | null = null;
  let grouping: Promise<void> | null = null;
  const groupTags = () =>
    groupDueTags({
      claim: (claimToken) => store.transaction((s) => claimGrouping(s, deployment, Date.now(), claimToken)),
      apply: async (claim, answer) => {
        const changed = await store.transaction((s) => applyGrouping(s, claim, answer, Date.now()));
        if (changed > 0) version++;
        return changed;
      },
      fail: (claim, message) => store.transaction((s) => failGrouping(s, claim, message, Date.now())),
      ...credits,
      model: modelFor,
      deployment,
    });
  const startGrouping = () => {
    grouping ??= groupTags()
      .catch((error) => console.error("Critiqs couldn't group tags:", error instanceof Error ? error.message : "unknown error"))
      .finally(() => (grouping = null));
  };
  const tick = () => {
    delivering ??= deliverMentionEmails()
      .catch((error) => console.error("Critiqs couldn't send mention emails:", error))
      .finally(() => (delivering = null));
    startGrouping();
  };
  const timer = setInterval(tick, WORKER_MS);
  (timer as { unref?: () => void }).unref?.();

  async function preferences(request: Request): Promise<Response> {
    const token =
      request.method === "GET" ? (new URL(request.url).searchParams.get("token") ?? "") : ((await readForm(request)).get("token") ?? "");
    const scope = await readPreferenceToken(await secret("preference-links"), token);
    if (scope === null) return messagePage("Link not recognized", "This link is incomplete or was changed. Use the link in your email.");
    if (request.method === "GET") {
      return preferencePage(
        base,
        token,
        scope.projectId === null
          ? "Stop all emails from Critiqs, for mentions and replies? You can turn them back on from the account menu."
          : "Mute emails from this project? You can unmute it from the account menu.",
      );
    }
    await store.transaction((s) => applyPreferenceLink(s, scope));
    return messagePage(
      "Done",
      scope.projectId === null ? "You won't get emails from Critiqs any more." : "This project's emails are muted.",
      200,
    );
  }

  async function report(request: Request): Promise<Response> {
    const token =
      request.method === "GET" ? (new URL(request.url).searchParams.get("token") ?? "") : ((await readForm(request)).get("token") ?? "");
    const sendId = await readReportToken(await secret("preference-links"), token);
    if (sendId === null) return messagePage("Link not recognized", "This link is incomplete or was changed. Use the link in your email.");
    if (request.method === "GET") return reportPage(token, REPORT_QUESTION);
    await store.transaction((s) => reportUnwantedEmail(s, { sendId }, Date.now()));
    return messagePage("Done", REPORT_DONE, 200);
  }

  /**
   * The component reporting that it loaded with a project's ID, for
   * onboarding's Connected: the body is the project ID, read only up to
   * `MAX_CONNECTION_REPORT_BYTES`, and the origin is the one the browser sent.
   * Always the same empty answer, so it says nothing about which projects exist.
   */
  async function connected(request: Request): Promise<Response> {
    const body = await readBody(request, MAX_CONNECTION_REPORT_BYTES).catch(() => new Uint8Array());
    const projectId = new TextDecoder().decode(body).trim();
    if (projectId !== "") await store.transaction((s) => reportConnected(s, { projectId, origin: request.headers.get("origin") }, Date.now()));
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  /**
   * What `critiqs doctor` checks, as on Convex: sign-in, email, whether
   * mention emails go out, and a project. Reveals no feedback, and nothing
   * about a project limited to its organization except to its members.
   */
  async function health(request: Request): Promise<Response> {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const now = Date.now();
    const identity = projectId === null ? null : await identityOf(request);
    const state = await store.withSql(async (db, s) => {
      const [stuck] = await s.deliveries.due(now - OVERDUE_MS, 1);
      const last = db.get<{ status: string; finished_at: number }>(
        "SELECT status, finished_at FROM deliveries WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
      );
      const found = projectId === null ? undefined : await s.projects.get(projectId);
      const viewer = identity === null ? null : await s.users.byToken(identity.tokenIdentifier);
      const project = found === undefined || found === null || (await canReview(s, found, viewer?._id ?? null)) ? found : undefined;
      return {
        mentionEmails: {
          // Due mention emails exist only when the worker is behind; it runs every minute while the server runs.
          overdue: stuck !== undefined,
          waitingSince: stuck === undefined ? null : stuck.status === "sending" ? (stuck.leaseUntil ?? stuck.dueAt) : stuck.dueAt,
          last: last === undefined ? null : { status: last.status, at: last.finished_at },
        },
        ...(project === undefined ? {} : project === null ? { project: "missing" } : { project: "found", reviewAddress: project.reviewUrl !== undefined, reviewAddressLocal: isLocalReviewAddress(project.reviewUrl) }),
      };
    });
    return json({ protocol: PROTOCOL, signIn: signInMode(request), email: mailer !== null, plans: false, ai: aiHealth(), ...state });
  }

  /** Which AI this server offers, without any key. */
  function aiHealth() {
    return {
      managed: false,
      defaultProvider: deployment.defaultProvider === null ? null : deployment.defaultProvider.provider,
      keysStorable: deployment.encryptionKey !== null,
    };
  }

  // -------------------------------------------------------------------------

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return new Response("Not found", { status: 404 });
    publicOrigin ??= `${secure(request) ? "https" : url.protocol.slice(0, -1)}://${url.host}`;
    const path = url.pathname.slice(base.length);
    const get = request.method === "GET";
    if (path === "/critiqs/config" && get) {
      // `personalAi`: each person's own AI settings (`personalAiSettings` and the calls beside it, including
      // `personalAiUsage`) and projects' AI usage rules.
      // `modelLists`: providers' model lists (`listAiModels`, `listPersonalAiModels`), the OpenRouter provider, and `aiChoice`.
      // `organizations`: the organizations a person belongs to (`myOrganizations`), and `organization` on projects.
      // `organizationMembers`: an organization's members and invites (`organization`, `renameOrganization`, `inviteMember`,
      // `revokeInvite`, `setMemberRole`, `removeMember`), `home` on organizations, and `organizationId` on `createProject`.
      // `overageCap`: an organization's admins set its cap on extra Critiqs AI credits (`setOverageCap`).
      // `addressCheck`: onboarding's check of a prototype's address (`checkPrototypeAddress`); false when the host turned it off.
      // `onboardingAnswers`: onboarding saves the person's answers (`saveAboutYou`), and `createProject` takes `onboarding` and `stack`.
      // `developerEmails`: a project's owners email its setup steps to developers (`sendDeveloperSetup`, `developerSends`), and
      // setup links show them (`developerSetup`); false without email, `webUrl`, or `publicUrl`. A copied message's
      // setup page shows the project and its install commands (`projectSetup`), with or without email.
      // `reviewAccess`: projects report who can review them (`reviewAccess` on projects), and their owners
      // limit them to their organization's members (`setReviewAccess`).
      // `addressLists`: projects' address lists (`projectAddresses`, `setProjectAddresses`), recording projects a
      // person opened (`recordProjectOpened`), and the browser extension's lookup (`findProjectsForOrigin`).
      // `addressEdits`: adding or removing one address (`addProjectAddress`, `removeProjectAddress`), and the
      // projects whose lists a person may change (`manageableProjects`).
      // `createKeys`: `idempotencyKey` on `createProject`, so a retried create returns the same project.
      // `presetTags`: a project's owner changes its preset tags (`setPresetTags`).
      // `connections`: the component reports that it loaded with a project's ID (`POST /critiqs/connected`), setup pages
      // say when it last did at the project's own address (`connected` on `projectSetup` and `developerSetup`), and its
      // owners clear it (`clearConnected`).
      return json({
        protocol: PROTOCOL,
        transport: "http",
        signIn: signInMode(request),
        signInUrl: `${url.origin}${base}`,
        ai: aiHealth(),
        personalAi: true,
        modelLists: true,
        organizations: true,
        organizationMembers: true,
        overageCap: true,
        addressCheck: addressCheckOn,
        onboardingAnswers: true,
        developerEmails: developerEmails !== null,
        reviewAccess: true,
        threadPages: true,
        addressLists: true,
        addressEdits: true,
        createKeys: true,
        presetTags: true,
        connections: true,
      });
    }
    if (path === "/critiqs/connected" && request.method === "POST") return await connected(request);
    if (path === "/critiqs/health" && get) return await health(request);
    if (path === "/me" && get) return await me(request);
    if (path === "/changes" && get) return json({ version });
    if (path.startsWith("/api/")) return await api(request, path.slice("/api/".length));
    if (path === "/upload") return await upload(request);
    if (path === "/capture" && get) return await capture(request);
    if (path === "/auth/start" && get) return await startSignIn(request);
    if (options.identify && /^\/auth\/(email|code|name)$/.test(path)) return messagePage("Sign in to the app", "This app signs reviewers in itself.");
    if (path === "/auth/email" && request.method === "POST") return await sendCode(request);
    if (path === "/auth/code" && request.method === "POST") return await checkCode(request);
    if (path === "/auth/name" && request.method === "POST") return await chooseName(request);
    if (path === "/auth/sign-out") return await signOut(request);
    if (path === "/auth/profile") return await rename(request);
    if (path === "/notifications/preferences" && (get || request.method === "POST")) return await preferences(request);
    if (path === REPORT_PATH && (get || request.method === "POST")) return await report(request);
    return new Response("Not found", { status: 404 });
  }

  return {
    fetch: async (request, connection) => {
      clients.set(request, connection?.remoteAddress);
      try {
        return await handle(request);
      } catch (error) {
        console.error("Critiqs request failed:", error);
        return json({ error: { code: "error", message: "Something went wrong." } }, 500);
      }
    },
    deliverMentionEmails: async () => {
      tick();
      await delivering;
    },
    groupTags: async () => {
      startGrouping();
      await grouping;
    },
    store,
    close: () => clearInterval(timer),
  };
}
