import { TRACKERS, type TicketsConfig, type TrackerAccountView, type TrackerId } from "@critiqs/core";
import { decryptToken, encryptToken, trackerTokenBinding, validEncryptionKey } from "../ai/secrets.ts";
import { CritiqsError, fail } from "../errors.ts";
import { normalizeEmail } from "../signin.ts";
import { currentReviewer, requireUser } from "../operations.ts";
import { canReview } from "../organizations.ts";
import type { Identity, Store, StoredToken, TrackerAccountRecord } from "../store.ts";
import { type SignInTokens, TRACKER_ADAPTERS, type TrackerAdapter, type TrackerEndpointOptions, type TrackerIdentity, type TrackerSite, type TrackerToken, type TrackerWebhooks } from "./trackers/index.ts";
import { type WebhookRemoval, webhookRemoval } from "./webhooks.ts";
import { deleteGithubGrant, exchangeGithubCode, GITHUB_API_URL, GITHUB_APP_URL, type GithubApp, githubAuthorizeUrl, githubInstallUrl, refreshGithubToken } from "./trackers/github.ts";
import { exchangeJiraCode, JIRA_API_URL, JIRA_AUTH_URL, type JiraAccountReport, type JiraApp, type JiraReportedAccount, jiraAccountId, jiraAuthorizeUrl, jiraSignInSite, parseJiraSite, readJiraProfile, refreshJiraToken, reportJiraAccounts } from "./trackers/jira.ts";
import { exchangeLinearCode, LINEAR_API_URL, LINEAR_APP_URL, type LinearApp, linearAdapter, linearAuthorizeUrl, refreshLinearToken, revokeLinearToken } from "./trackers/linear.ts";

// Each person's own tracker accounts ("Your trackers"), one per person and
// tracker. Only that person sees or changes them. Tokens are verified with the
// tracker, then stored only encrypted, bound to the person and tracker; no
// view ever carries one. Connecting needs the operator's encryption key, the
// same one that protects AI provider keys.

/** What a deployment's operator set up for tickets. Never sent to browsers whole. */
export interface TicketsDeployment {
  /** Encrypts tracker tokens; without it, no tracker can be connected and tickets aren't offered. */
  encryptionKey: string | null;
  /** The operator's Linear OAuth app; without it, people paste a Linear API key instead of signing in. */
  linear: LinearApp | null;
  /** Signs the Linear app's webhooks (`CRITIQS_LINEAR_WEBHOOK_SECRET`); without it, the webhook route refuses every call and status comes from checks when threads open. */
  linearWebhookSecret: string | null;
  /** Linear's API and sign-in addresses. Only tests change them, to reach a local stand-in. */
  linearApiUrl: string;
  linearAppUrl: string;
  /** The operator's GitHub App; without it, people paste a fine-grained personal access token instead of signing in. */
  github: GithubApp | null;
  /** The secret of the GitHub App's webhook, or of an organization's or repository's webhook (`CRITIQS_GITHUB_WEBHOOK_SECRET`); without it, the webhook route refuses every call. */
  githubWebhookSecret: string | null;
  /** GitHub's API and sign-in addresses. Only tests change them, to reach a local stand-in. */
  githubApiUrl: string;
  githubAppUrl: string;
  /**
   * The operator's Atlassian OAuth app; Jira connects through Atlassian
   * sign-in only (never pasted API tokens), so Jira is offered only when set.
   * Its client secret also checks the webhooks Jira sends it.
   */
  jira: JiraApp | null;
  /** Atlassian's API gateway and sign-in addresses, and where Jira sites are reached with a pasted token. Only tests change them, to reach a local stand-in. */
  jiraApiUrl: string;
  jiraAuthUrl: string;
  jiraSitesUrl: string | null;
}

/**
 * Reads the operator's settings: `CRITIQS_AI_ENCRYPTION_KEY`,
 * `CRITIQS_LINEAR_CLIENT_ID` and `CRITIQS_LINEAR_CLIENT_SECRET` (both, or
 * neither), `CRITIQS_LINEAR_WEBHOOK_SECRET`, and, for tests only, `CRITIQS_LINEAR_API_URL` and `CRITIQS_LINEAR_APP_URL`;
 * `CRITIQS_GITHUB_CLIENT_ID`, `CRITIQS_GITHUB_CLIENT_SECRET`, and `CRITIQS_GITHUB_APP_SLUG` (all three, or none),
 * `CRITIQS_GITHUB_WEBHOOK_SECRET`, and, for tests only, `CRITIQS_GITHUB_API_URL` and `CRITIQS_GITHUB_APP_URL`;
 * `CRITIQS_JIRA_CLIENT_ID` and `CRITIQS_JIRA_CLIENT_SECRET` (both, or neither), and, for tests only,
 * `CRITIQS_JIRA_API_URL`, `CRITIQS_JIRA_AUTH_URL`, and `CRITIQS_JIRA_SITES_URL`.
 */
export function ticketsDeploymentFromEnv(env: Record<string, string | undefined>): TicketsDeployment {
  const clientId = env.CRITIQS_LINEAR_CLIENT_ID?.trim();
  const clientSecret = env.CRITIQS_LINEAR_CLIENT_SECRET?.trim();
  const github = { clientId: env.CRITIQS_GITHUB_CLIENT_ID?.trim(), clientSecret: env.CRITIQS_GITHUB_CLIENT_SECRET?.trim(), slug: env.CRITIQS_GITHUB_APP_SLUG?.trim() };
  const jiraClientId = env.CRITIQS_JIRA_CLIENT_ID?.trim();
  const jiraClientSecret = env.CRITIQS_JIRA_CLIENT_SECRET?.trim();
  return {
    encryptionKey: validEncryptionKey(env.CRITIQS_AI_ENCRYPTION_KEY) ? env.CRITIQS_AI_ENCRYPTION_KEY! : null,
    linear: clientId && clientSecret ? { clientId, clientSecret } : null,
    linearWebhookSecret: env.CRITIQS_LINEAR_WEBHOOK_SECRET?.trim() || null,
    linearApiUrl: env.CRITIQS_LINEAR_API_URL?.trim() || LINEAR_API_URL,
    linearAppUrl: env.CRITIQS_LINEAR_APP_URL?.trim() || LINEAR_APP_URL,
    github: github.clientId && github.clientSecret && github.slug ? { clientId: github.clientId, clientSecret: github.clientSecret, slug: github.slug } : null,
    githubWebhookSecret: env.CRITIQS_GITHUB_WEBHOOK_SECRET?.trim() || null,
    githubApiUrl: env.CRITIQS_GITHUB_API_URL?.trim() || GITHUB_API_URL,
    githubAppUrl: env.CRITIQS_GITHUB_APP_URL?.trim() || GITHUB_APP_URL,
    jira: jiraClientId && jiraClientSecret ? { clientId: jiraClientId, clientSecret: jiraClientSecret } : null,
    jiraApiUrl: env.CRITIQS_JIRA_API_URL?.trim() || JIRA_API_URL,
    jiraAuthUrl: env.CRITIQS_JIRA_AUTH_URL?.trim() || JIRA_AUTH_URL,
    jiraSitesUrl: env.CRITIQS_JIRA_SITES_URL?.trim() || null,
  };
}

/** The trackers people can connect so far. */
export const OFFERED_TRACKERS: readonly TrackerId[] = ["linear", "github", "jira"];

/** Whether connecting a tracker names the site the account is on (Jira Cloud). */
export const trackerHasSites = (tracker: TrackerId) => tracker === "jira";

/**
 * What `/critiqs/config` reports: the trackers offered and how each connects,
 * that threads can create and link tickets, that the Create dialog can draft
 * with AI and from templates, and that tickets' status comes back; null, so tickets aren't
 * offered, without an encryption key.
 */
export function ticketsConfig(deployment: TicketsDeployment): TicketsConfig | null {
  if (deployment.encryptionKey === null) return null;
  return {
    trackers: OFFERED_TRACKERS.flatMap((id) => {
      const app = trackerSignIn(id, deployment);
      // Atlassian discourages apps from collecting personal API tokens, so Jira is offered only through OAuth sign-in.
      if (id === "jira" && app === null) return [];
      return [{ id, signIn: app === null ? "token" : "oauth", ...(app?.installUrl === undefined ? {} : { installUrl: app.installUrl }) }];
    }),
    threadTickets: true,
    drafting: true,
    ticketStatus: true,
    defaultDestinations: true,
  };
}

/** A tracker's API address on this deployment. */
function apiUrlOf(tracker: TrackerId, deployment: TicketsDeployment): string {
  return tracker === "github" ? deployment.githubApiUrl : tracker === "jira" ? deployment.jiraApiUrl : deployment.linearApiUrl;
}

/** The adapter that talks to a tracker, at the deployment's addresses. */
export function trackerAdapter(tracker: TrackerId, deployment: TicketsDeployment, fetchFn: typeof fetch = fetch): TrackerAdapter {
  requireOffered(tracker);
  return TRACKER_ADAPTERS[tracker]({ fetch: fetchFn, baseUrl: apiUrlOf(tracker, deployment), ...(tracker === "jira" && deployment.jiraSitesUrl !== null ? { sitesUrl: deployment.jiraSitesUrl } : {}) });
}

/** A tracker's sign-in on this deployment, through the operator's app: its pages and token requests. */
export interface TrackerSignIn {
  /** The tracker's page where the person allows Critiqs, sending them back to `redirectUri`. */
  authorizeUrl(input: { redirectUri: string; state: string; challenge: string }): string;
  exchange(input: { code: string; redirectUri: string; verifier: string }, now: number, fetchFn?: typeof fetch): Promise<SignInTokens>;
  /** Trades a refresh token for new tokens; the tracker ends the one used. */
  refresh(refreshToken: string, now: number, signal?: AbortSignal, fetchFn?: typeof fetch): Promise<SignInTokens>;
  /** Where an organization installs the app to reach its repositories (GitHub). */
  installUrl?: string;
  /**
   * Whether ending one sign-in ends every token the app holds for the person
   * (GitHub's grant), so a sign-in they made since would end with it.
   */
  endsEveryToken?: boolean;
  /**
   * The site a sign-in's token is for, where the tracker has several (Jira):
   * the one the person chose before signing in, once the tracker confirms the
   * token reaches it; refused otherwise.
   */
  site?(accessToken: string, chosen: string, fetchFn?: typeof fetch): Promise<TrackerSite>;
  /**
   * Ends a sign-in at the tracker, where it offers a call that does: true
   * when the tracker no longer accepts its tokens. Where ending it ends every
   * token (`endsEveryToken`), `mayEnd` is asked right before each call that
   * would, and `"shared"` returned when it says no.
   */
  end?(tokens: { access: string | null; refresh: string | null }, fetchFn?: typeof fetch, now?: number, mayEnd?: () => Promise<boolean>): Promise<boolean | "shared">;
}

/** The tracker's sign-in on this deployment; null where its operator registered no app, so people paste a token. */
export function trackerSignIn(tracker: TrackerId, deployment: TicketsDeployment): TrackerSignIn | null {
  if (tracker === "linear" && deployment.linear !== null) {
    const app = deployment.linear;
    const endpoint = (fetchFn?: typeof fetch) => ({ baseUrl: deployment.linearApiUrl, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) });
    return {
      authorizeUrl: (input) => linearAuthorizeUrl(deployment.linearAppUrl, { clientId: app.clientId, ...input }),
      exchange: (input, now, fetchFn) => exchangeLinearCode(endpoint(fetchFn), app, input, now),
      refresh: (refreshToken, now, signal, fetchFn) => refreshLinearToken(endpoint(fetchFn), app, refreshToken, now, signal),
      // Linear's revocation, refresh token first, then the access token, each checked: Linear's 400 alone proves nothing.
      end: async (tokens, fetchFn, now = Date.now()) => await endLinearSignIn(endpoint(fetchFn), app, tokens, now),
    };
  }
  if (tracker === "github" && deployment.github !== null) {
    const app = deployment.github;
    const endpoint = (fetchFn?: typeof fetch) => ({ baseUrl: deployment.githubAppUrl, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) });
    return {
      authorizeUrl: (input) => githubAuthorizeUrl(deployment.githubAppUrl, { clientId: app.clientId, ...input }),
      exchange: (input, now, fetchFn) => exchangeGithubCode(endpoint(fetchFn), app, input, now),
      refresh: (refreshToken, now, signal, fetchFn) => refreshGithubToken(endpoint(fetchFn), app, refreshToken, now, signal),
      installUrl: githubInstallUrl(deployment.githubAppUrl, app.slug),
      endsEveryToken: true,
      // Deleting the app's grant for the person ends every token it holds for them. GitHub needs a valid access token for
      // it, and they last eight hours: one GitHub turns down is refreshed first, when the refresh token still works.
      // The grant is GitHub's per GitHub account, not per Critiqs account: `mayEnd` is asked right before each deletion, so
      // one isn't deleted while another Critiqs account, or a sign-in, uses it.
      end: async ({ access, refresh }, fetchFn, now = Date.now(), mayEnd = async () => true) => {
        const api = { baseUrl: deployment.githubApiUrl, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) };
        if (access !== null && !(await mayEnd())) return "shared";
        const first = access === null ? "refused" : await deleteGithubGrant(api, app, access);
        if (first !== "refused" || refresh === null) return first === "deleted";
        let fresh: SignInTokens;
        try {
          fresh = await refreshGithubToken(endpoint(fetchFn), app, refresh, now);
        } catch {
          return false;
        }
        if (!(await mayEnd())) return "shared";
        return (await deleteGithubGrant(api, app, fresh.access)) === "deleted";
      },
    };
  }
  if (tracker === "jira" && deployment.jira !== null) {
    const app = deployment.jira;
    const auth = (fetchFn?: typeof fetch) => ({ baseUrl: deployment.jiraAuthUrl, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) });
    return {
      // Atlassian doesn't offer PKCE: the state, bound to the browser that started, and the client secret protect the code.
      authorizeUrl: ({ redirectUri, state }) => jiraAuthorizeUrl(deployment.jiraAuthUrl, { clientId: app.clientId, redirectUri, state }),
      exchange: ({ code, redirectUri }, now, fetchFn) => exchangeJiraCode(auth(fetchFn), app, { code, redirectUri }, now),
      refresh: (refreshToken, now, signal, fetchFn) => refreshJiraToken(auth(fetchFn), app, refreshToken, now, signal),
      site: (accessToken, chosen, fetchFn) => jiraSignInSite({ baseUrl: deployment.jiraApiUrl, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) }, accessToken, chosen),
    };
  }
  return null;
}

export function trackerLabel(tracker: TrackerId): string {
  return TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;
}

export function ticketStore(store: Store): NonNullable<Store["tickets"]> {
  if (store.tickets === undefined) fail("unavailable", "This Critiqs backend doesn't keep tracker accounts.");
  return store.tickets;
}

function requireKey(deployment: TicketsDeployment): string {
  if (deployment.encryptionKey === null) {
    fail("unavailable", "This deployment can't store tracker accounts yet. Its operator must set an encryption key (CRITIQS_AI_ENCRYPTION_KEY) first.");
  }
  return deployment.encryptionKey;
}

/** Refuses a tracker ID Critiqs doesn't know, from a caller that didn't check it. */
export function requireOffered(tracker: TrackerId) {
  if (!OFFERED_TRACKERS.includes(tracker)) fail("invalid", "Choose Linear, GitHub Issues, or Jira.");
}

/** An account as Your trackers shows it: never a token. */
export function trackerAccountView(record: TrackerAccountRecord): TrackerAccountView {
  return {
    tracker: record.tracker,
    method: record.method,
    accountName: record.accountName,
    site: record.site?.name ?? null,
    connectedAt: record.connectedAt,
    attribution: record.attribution,
  };
}

/** The signed-in person's tracker accounts, in the order trackers are offered. */
export async function listTrackerAccounts(store: Store, identity: Identity | null): Promise<TrackerAccountView[]> {
  const { user } = await currentReviewer(store, identity);
  if (user === null) return [];
  const records = await ticketStore(store).accounts.list(user._id);
  const order = (tracker: TrackerId) => TRACKERS.findIndex((entry) => entry.id === tracker);
  return records.sort((a, b) => order(a.tracker) - order(b.tracker)).map(trackerAccountView);
}

/** The signed-in person who is connecting a tracker, before their token is verified or encrypted; refused when tokens can't be stored. */
export async function requireTrackerPerson(store: Store, identity: Identity | null, deployment: TicketsDeployment, args: { tracker: TrackerId }, now: number): Promise<{ userId: string }> {
  ticketStore(store);
  requireKey(deployment);
  requireOffered(args.tracker);
  if (args.tracker === "jira") fail("invalid", "Jira connects through Atlassian sign-in only.");
  const user = await requireUser(store, identity);
  await requireConnectRoom(store, "token", user._id, now);
  return { userId: user._id };
}

/** How many times a minute one person may start a tracker sign-in, and, separately, connect a pasted token: each stores a row or calls the tracker. */
export const TRACKER_CONNECTS_PER_MINUTE = 10;

async function requireConnectRoom(store: Store, kind: "sign-in" | "token", userId: string, now: number): Promise<void> {
  if (!(await store.rateLimits.hit(`tracker-${kind}:${userId}`, TRACKER_CONNECTS_PER_MINUTE, 60_000, now))) {
    fail("limit", "Too many tries to connect a tracker. Wait a minute, then try again.");
  }
}

/** A verified account with its tokens already encrypted for its person (`trackerTokenBinding`). */
export interface SealedAccount {
  tracker: TrackerId;
  method: "oauth" | "token";
  identity: TrackerIdentity;
  access: StoredToken;
  refresh: StoredToken | null;
  expiresAt: number | null;
}

/**
 * Stores a person's account, replacing any they had for that tracker: one per
 * person and tracker. Their attribution default carries over. One transaction.
 */
export async function saveTrackerAccount(store: Store, userId: string, account: SealedAccount, now: number): Promise<TrackerAccountView> {
  const accounts = ticketStore(store).accounts;
  const privacyAccountKey = account.tracker === "jira" && account.method === "oauth" ? jiraAccountId(account.identity.accountId) : null;
  // Coordinate with any existing row sharing the same raw Atlassian accountId so reconnecting or connecting a second
  // Critiqs account for the same Atlassian user never triggers a duplicate report inside Cycle-Period.
  const siblings = privacyAccountKey === null ? [] : await accounts.withPrivacyKey("jira", privacyAccountKey, 10);
  const existing = await accounts.find(userId, account.tracker);
  const sameExisting =
    existing !== null &&
    privacyAccountKey !== null &&
    jiraAccountId(existing.accountId) === privacyAccountKey;
  const activeSchedule = [...(sameExisting ? [existing] : []), ...siblings]
    .filter((row) => row.privacyNextReportAt !== undefined && row.privacyNextReportAt > now)
    .sort((a, b) => (b.privacyNextReportAt ?? 0) - (a.privacyNextReportAt ?? 0))[0];
  const fields = {
    method: account.method,
    accountId: account.identity.accountId,
    accountName: account.identity.accountName,
    access: account.access,
    connectedAt: now,
    updatedAt: now,
    profileUpdatedAt: now,
  };
  if (existing !== null) {
    await accounts.patch(existing._id, {
      ...fields,
      site: account.identity.site,
      refresh: account.refresh,
      expiresAt: account.expiresAt,
      refreshLease: null,
      privacyAccountKey,
      privacyReportedAt: activeSchedule?.privacyReportedAt ?? null,
      privacyNextReportAt: activeSchedule?.privacyNextReportAt ?? null,
      privacyRefreshNeeded: null,
      privacyLease: null,
    });
    return trackerAccountView((await accounts.find(userId, account.tracker))!);
  }
  const record = {
    userId,
    tracker: account.tracker,
    ...fields,
    attribution: true,
    ...(privacyAccountKey === null ? {} : { privacyAccountKey }),
    ...(activeSchedule?.privacyReportedAt === undefined ? {} : { privacyReportedAt: activeSchedule.privacyReportedAt }),
    ...(activeSchedule?.privacyNextReportAt === undefined ? {} : { privacyNextReportAt: activeSchedule.privacyNextReportAt }),
    ...(account.identity.site === null ? {} : { site: account.identity.site }),
    ...(account.refresh === null ? {} : { refresh: account.refresh }),
    ...(account.expiresAt === null ? {} : { expiresAt: account.expiresAt }),
  };
  const id = await accounts.insert(record);
  return trackerAccountView({ _id: id, ...record });
}

export type SignedInSave = { status: "saved" } | { status: "other-email" } | { status: "cancelled" };

/**
 * Stores the account of a finished sign-in for the person who started it, but
 * only when the tracker account's email is their Critiqs email (compared as
 * sign-in compares addresses). The window that finishes a sign-in can't prove
 * it belongs to the person who started it, so a sign-in finished by someone
 * else, into another tracker account, stores nothing. Only while the
 * sign-in `state` names is still under way, claimed by the window the tracker
 * sent back: a person who disconnected meanwhile cancelled it, and it stores
 * nothing either (`cancelled`). Each sign-in saves once. One transaction.
 */
export async function saveSignedInAccount(store: Store, args: { userId: string; account: SealedAccount; state: string }, now: number): Promise<SignedInSave> {
  const signIns = ticketStore(store).signIns;
  const signIn = await signIns.findByState(args.state);
  if (signIn === null || signIn.claimedAt === undefined || signIn.userId !== args.userId || signIn.tracker !== args.account.tracker) return { status: "cancelled" };
  await signIns.delete(signIn._id);
  const user = await store.users.get(args.userId);
  const critiqs = user?.email == null ? null : normalizeEmail(user.email);
  // Any of the tracker account's verified addresses: GitHub accounts often have several.
  if (critiqs === null || !args.account.identity.emails.some((email) => normalizeEmail(email) === critiqs)) return { status: "other-email" };
  await saveTrackerAccount(store, args.userId, args.account, now);
  return { status: "saved" };
}

/** Stores the signed-in person's own account, sealed for them in an earlier step; refused for anyone else. */
export async function saveOwnTrackerAccount(store: Store, identity: Identity | null, args: { userId: string; account: SealedAccount }, now: number): Promise<TrackerAccountView> {
  const user = await requireUser(store, identity);
  if (user._id !== args.userId) fail("forbidden", "Connect your tracker again.");
  return await saveTrackerAccount(store, user._id, args.account, now);
}

/**
 * An account just disconnected, with its tokens still sealed, so what
 * Critiqs holds at the tracker can be ended there (`endTrackerAccount`).
 */
export interface DisconnectedAccount {
  userId: string;
  tracker: TrackerId;
  /** The tracker's ID for the account; absent on retries scheduled before it was kept. */
  accountId?: string;
  method: "oauth" | "token";
  access: StoredToken;
  refresh: StoredToken | null;
  /** When the access token expires, when the tracker said. */
  expiresAt: number | null;
  /** The site the account is on, where the tracker has several (Jira). */
  site: { id: string; name: string } | null;
  /** The tracker's IDs of status webhooks the person's sign-in registered there, to remove. */
  hooks: string[];
}

/**
 * Removes the signed-in person's account for a tracker and its tokens, and
 * cancels their sign-ins to it still under way, so none connects it again
 * afterwards. Tickets they linked keep their links. Returns the account
 * removed, to end at the tracker; null when there was none. One transaction.
 */
export async function disconnectTracker(store: Store, identity: Identity | null, args: { tracker: TrackerId }): Promise<DisconnectedAccount | null> {
  const accounts = ticketStore(store).accounts;
  const user = await requireUser(store, identity);
  const signIns = ticketStore(store).signIns;
  for (const signIn of await signIns.listForUser(user._id, args.tracker)) await signIns.delete(signIn._id);
  const existing = await accounts.find(user._id, args.tracker);
  // Nothing renews their webhooks now: their records go, and the webhooks on this account's site are removed at the tracker with it.
  const webhooks = ticketStore(store).webhooks;
  const hooks: string[] = [];
  for (const hook of await webhooks.listForUser(user._id, args.tracker)) {
    if (hook.hookId !== "" && existing !== null && hook.accountId === existing.accountId && hook.site.id === existing.site?.id) hooks.push(hook.hookId);
    await webhooks.delete(hook._id);
  }
  if (existing === null) return null;
  await accounts.delete(existing._id);
  return {
    userId: user._id,
    tracker: args.tracker,
    accountId: existing.accountId,
    method: existing.method,
    access: existing.access,
    refresh: existing.refresh ?? null,
    expiresAt: existing.expiresAt ?? null,
    site: existing.site ?? null,
    hooks,
  };
}

/** What disconnecting did at the tracker: ended Critiqs's access there, left a pasted token for the person to remove, or couldn't end it. */
export type TrackerEnd = "ended" | "kept" | "failed" | "shared";

/**
 * Ends a disconnected account at its tracker, where an API call can. Status
 * webhooks its sign-in registered (Jira) are removed first, with a refreshed
 * token if it had expired. Then a Linear sign-in's tokens are revoked, and a
 * GitHub sign-in's grant is deleted, which ends all its tokens. Atlassian
 * documents no call that revokes a sign-in, and no tracker lets another
 * caller revoke a pasted token, so those are `kept`: valid until they expire,
 * or until the person removes them in the tracker. `failed` when a call
 * couldn't be made, was refused, or the tracker still accepts a token
 * afterwards; the person is told. `shared` when ending it would end every
 * token and `mayEnd` (asked right before each such call) says another
 * sign-in still uses it.
 */
export async function endTrackerAccount(
  deployment: TicketsDeployment,
  account: DisconnectedAccount,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
  mayEnd: () => Promise<boolean> = async () => true,
): Promise<TrackerEnd> {
  if (account.method !== "oauth") return "kept";
  const key = deployment.encryptionKey;
  const signIn = trackerSignIn(account.tracker, deployment);
  if (key === null || signIn === null) return "failed";
  const binding = trackerTokenBinding(account.tracker, account.userId);
  const refresh = account.refresh === null ? null : await decryptToken(key, binding, account.refresh);
  let access = await decryptToken(key, binding, account.access);
  let removed = true;
  if (account.hooks.length > 0) {
    removed = false;
    try {
      if ((access === null || (account.expiresAt !== null && account.expiresAt <= now + REFRESH_MARGIN_MS)) && refresh !== null) access = (await signIn.refresh(refresh, now, undefined, fetchFn)).access;
      const webhooks = trackerAdapter(account.tracker, deployment, fetchFn).webhooks;
      if (access !== null && webhooks !== undefined) {
        await webhooks.remove({ method: "oauth", value: access, ...(trackerHasSites(account.tracker) ? { site: account.site } : {}) }, account.hooks);
        removed = true;
      }
    } catch {
      removed = false;
    }
  }
  if (signIn.end === undefined) return removed ? "kept" : "failed";
  if (!removed || (access === null && refresh === null)) return "failed";
  const ended = await signIn.end({ access, refresh }, fetchFn, now, mayEnd);
  return ended === "shared" ? "shared" : ended ? "ended" : "failed";
}

/**
 * Ends a sign-in's tokens at the tracker, where it offers a call that does:
 * true when the tracker no longer accepts them. Also for tokens a sign-in
 * got after the person cancelled it by disconnecting.
 */
export async function endTrackerSignIn(
  deployment: TicketsDeployment,
  tracker: TrackerId,
  tokens: { access: string | null; refresh: string | null },
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
  mayEnd: () => Promise<boolean> = async () => true,
): Promise<boolean | "shared"> {
  const end = trackerSignIn(tracker, deployment)?.end;
  return end !== undefined && (await end(tokens, fetchFn, now, mayEnd));
}

/**
 * Whether a tracker sign-in that ends every token for its tracker account
 * (GitHub's grant) is still in use, so it mustn't be ended: another Critiqs
 * account is connected with a sign-in to the same tracker account
 * (`accountId`), or the person is signing in to the tracker again, whose new
 * tokens would share it. Read right before each call that would end it.
 */
export async function trackerGrantInUse(store: Store, args: { userId: string; tracker: TrackerId; accountId?: string }): Promise<boolean> {
  const tickets = ticketStore(store);
  if ((await tickets.signIns.listForUser(args.userId, args.tracker)).length > 0) return true;
  // A retry scheduled before the account's ID was kept knows only its person.
  if (args.accountId === undefined) return (await tickets.accounts.find(args.userId, args.tracker)) !== null;
  // Only a sign-in holds the grant; any number of pasted tokens for the same account may come first.
  return (await tickets.accounts.withAccountId(args.tracker, args.accountId, "oauth", 1)).length > 0;
}

/**
 * Revokes a Linear sign-in's tokens, refresh token first, and says whether
 * Linear no longer accepts either. Linear answers 400 when it can't revoke a
 * token, as for one already revoked, so a 400 alone proves nothing: an access
 * token then counts as ended only when Linear's API refuses it, and a refresh
 * token only when Linear refuses to refresh with it; one that still works is
 * spent on new tokens, which are revoked in turn, once.
 */
async function endLinearSignIn(endpoint: TrackerEndpointOptions, app: LinearApp, tokens: { access: string | null; refresh: string | null }, now: number, again = true): Promise<boolean> {
  const refreshed = tokens.refresh === null ? "revoked" : await revokeLinearToken(endpoint, app, tokens.refresh, "refresh_token");
  const accessed = tokens.access === null ? "revoked" : await revokeLinearToken(endpoint, app, tokens.access, "access_token");
  if (refreshed === "unreachable" || accessed === "unreachable") return false;
  if (accessed === "refused" && !(await linearRefuses(endpoint, tokens.access!))) return false;
  if (refreshed === "revoked") return true;
  let fresh: SignInTokens;
  try {
    fresh = await refreshLinearToken(endpoint, app, tokens.refresh!, now);
  } catch (error: unknown) {
    // Linear won't refresh with it: it no longer works.
    return error instanceof CritiqsError && error.code === "invalid";
  }
  return again && (await endLinearSignIn(endpoint, app, fresh, now, false));
}

/** Whether Linear's API refuses an access token, so it no longer works; false when Linear accepts it or couldn't be asked. */
async function linearRefuses(endpoint: TrackerEndpointOptions, access: string): Promise<boolean> {
  try {
    await linearAdapter(endpoint).verify({ method: "oauth", value: access });
    return false;
  } catch (error) {
    return error instanceof CritiqsError && error.code === "invalid";
  }
}

/** Whether a person has an account for a tracker now, as after connecting it again. One transaction. */
export async function hasTrackerAccount(store: Store, args: { userId: string; tracker: TrackerId }): Promise<boolean> {
  return (await ticketStore(store).accounts.find(args.userId, args.tracker)) !== null;
}

/** Sets whether the person's new tickets in a tracker say they came from Critiqs, by default. */
export async function setTrackerAttribution(store: Store, identity: Identity | null, args: { tracker: TrackerId; attribution: boolean }, now: number): Promise<TrackerAccountView> {
  const accounts = ticketStore(store).accounts;
  const user = await requireUser(store, identity);
  const existing = await accounts.find(user._id, args.tracker);
  if (existing === null) fail("not-found", `Connect ${trackerLabel(args.tracker)} first.`);
  await accounts.patch(existing._id, { attribution: args.attribution, updatedAt: now });
  return trackerAccountView({ ...existing, attribution: args.attribution, updatedAt: now });
}

const MAX_TOKEN_LENGTH = 500;
const MAX_EMAIL_LENGTH = 254;

/** A pasted token, trimmed, or why it can't be one. */
export function parsePastedToken(raw: string): string {
  const token = raw.trim();
  if (token === "") fail("invalid", "Paste your API key.");
  if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) fail("invalid", "That doesn't look like an API key. Copy the key again and paste only the key.");
  return token;
}

/** The steps of connecting with a pasted token; each is its own transaction. */
export interface ConnectSteps {
  requirePerson(): Promise<{ userId: string }>;
  save(userId: string, account: SealedAccount): Promise<TrackerAccountView>;
}

/**
 * What a pasted token is sent with: for Jira, the token with the person's
 * Atlassian email, as Basic authentication sends them (`email:token`), and
 * the site's host; for other trackers, the token alone.
 */
export function pastedCredential(args: { tracker: TrackerId; token: string; email?: string | null; site?: string | null }): TrackerToken {
  const value = parsePastedToken(args.token);
  if (!trackerHasSites(args.tracker)) return { method: "token", value };
  const site = parseJiraSite(args.site ?? "");
  const email = (args.email ?? "").trim();
  if (email === "") fail("invalid", "Enter the email address of your Atlassian account.");
  if (email.length > MAX_EMAIL_LENGTH || !/^[^\s:@]+@[^\s:@]+$/.test(email)) fail("invalid", "That doesn't look like an email address. Enter the one you sign in to Atlassian with.");
  return { method: "token", value: `${email}:${value}`, site: { id: "", name: site } };
}

/**
 * Connects a tracker with a personal token the person pasted (for Jira, with
 * their email and the site): checks they may, asks the tracker whose token
 * it is, and stores it encrypted for them.
 */
export async function connectTrackerWithToken(
  steps: ConnectSteps,
  deployment: TicketsDeployment,
  args: { tracker: TrackerId; token: string; email?: string | null; site?: string | null },
  fetchFn: typeof fetch = fetch,
): Promise<TrackerAccountView> {
  if (args.tracker === "jira") fail("invalid", "Jira connects through Atlassian sign-in only.");
  const credential = pastedCredential(args);
  const { value } = credential;
  const { userId } = await steps.requirePerson();
  const identity = await trackerAdapter(args.tracker, deployment, fetchFn).verify(credential);
  const access = await encryptToken(requireKey(deployment), trackerTokenBinding(args.tracker, userId), value);
  return await steps.save(userId, { tracker: args.tracker, method: "token", identity, access, refresh: null, expiresAt: null });
}

/** Encrypts a sign-in's tokens, verified as `identity`, for their person. */
export async function sealSignIn(deployment: TicketsDeployment, tracker: TrackerId, userId: string, identity: TrackerIdentity, tokens: SignInTokens): Promise<SealedAccount> {
  const key = requireKey(deployment);
  const binding = trackerTokenBinding(tracker, userId);
  return {
    tracker,
    method: "oauth",
    identity,
    access: await encryptToken(key, binding, tokens.access),
    refresh: tokens.refresh === null ? null : await encryptToken(key, binding, tokens.refresh),
    expiresAt: tokens.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Tracker sign-in (OAuth): started by the person, finished in a window that
// the tracker sends back to the backend.

/** How long a started sign-in waits for the tracker to send the person back. */
export const SIGN_IN_MINUTES = 10;

/**
 * Starts a sign-in for the signed-in person. `state` and `verifier` are fresh
 * random secrets; `bindingHash` is the hash of a third, which only the
 * interface that started the sign-in receives. Refused when the tracker has no
 * sign-in here.
 */
export async function startTrackerSignIn(
  store: Store,
  identity: Identity | null,
  deployment: TicketsDeployment,
  args: { tracker: TrackerId; state: string; verifier: string; bindingHash: string; site?: string | null },
  now: number,
): Promise<void> {
  const tickets = ticketStore(store);
  requireKey(deployment);
  requireOffered(args.tracker);
  if (trackerSignIn(args.tracker, deployment) === null) {
    fail(
      "invalid",
      args.tracker === "jira"
        ? "Jira sign-in isn't set up on this deployment."
        : `${trackerLabel(args.tracker)} sign-in isn't set up on this deployment. Paste an API key instead.`,
    );
  }
  // The site the person chose: the sign-in connects them to it, and only to it.
  const site = trackerHasSites(args.tracker) ? parseJiraSite(args.site ?? "") : null;
  const user = await requireUser(store, identity);
  await requireConnectRoom(store, "sign-in", user._id, now);
  await tickets.signIns.insert({
    state: args.state,
    userId: user._id,
    tracker: args.tracker,
    verifier: args.verifier,
    bindingHash: args.bindingHash,
    expiresAt: now + SIGN_IN_MINUTES * 60 * 1000,
    ...(site === null ? {} : { site }),
  });
}

export type OpenedSignIn = { status: "opened"; verifier: string } | { status: "expired" } | { status: "used" } | { status: "other-browser" };

/**
 * Opens a started sign-in's window, once, when it brings the secret only the
 * interface that started it was given (`bindingHash`, hashed). Without it, as
 * from a forwarded link, nothing changes.
 */
export async function openTrackerSignIn(store: Store, args: { tracker: TrackerId; state: string; bindingHash: string }, now: number): Promise<OpenedSignIn> {
  const signIns = ticketStore(store).signIns;
  const signIn = await signIns.findByState(args.state);
  if (signIn === null || signIn.tracker !== args.tracker) return { status: "expired" };
  if (signIn.expiresAt <= now) {
    await signIns.delete(signIn._id);
    return { status: "expired" };
  }
  if (signIn.bindingHash === undefined || signIn.bindingHash !== args.bindingHash) return { status: "other-browser" };
  if (signIn.openedAt !== undefined) return { status: "used" };
  await signIns.patch(signIn._id, { openedAt: now });
  return { status: "opened", verifier: signIn.verifier ?? "" };
}

/** Ends a claimed sign-in that saved nothing, as when the person didn't allow Critiqs or the tracker refused its code. One transaction. */
export async function dropTrackerSignIn(store: Store, args: { tracker: TrackerId; state: string }): Promise<void> {
  const signIns = ticketStore(store).signIns;
  const signIn = await signIns.findByState(args.state);
  if (signIn !== null && signIn.tracker === args.tracker && signIn.claimedAt !== undefined) await signIns.delete(signIn._id);
}

export type ClaimedSignIn = { status: "claimed"; userId: string; verifier: string; site: string | null } | { status: "expired" } | { status: "other-browser" };

/**
 * Claims a sign-in when the tracker sends the person back, whatever the
 * outcome: each state is claimed once, and only by the browser whose window
 * opened it, which holds the same secret in a cookie. It is kept, claimed,
 * until its tokens are saved (`saveSignedInAccount`), so disconnecting
 * meanwhile cancels it.
 */
export async function claimTrackerSignIn(store: Store, args: { tracker: TrackerId; state: string; bindingHash: string }, now: number): Promise<ClaimedSignIn> {
  const signIns = ticketStore(store).signIns;
  const signIn = await signIns.findByState(args.state);
  if (signIn === null || signIn.tracker !== args.tracker) return { status: "expired" };
  if (signIn.openedAt === undefined || signIn.bindingHash === undefined || signIn.bindingHash !== args.bindingHash) return { status: "other-browser" };
  if (signIn.claimedAt !== undefined) return { status: "expired" };
  if (signIn.expiresAt <= now) {
    await signIns.delete(signIn._id);
    return { status: "expired" };
  }
  await signIns.patch(signIn._id, { claimedAt: now });
  return { status: "claimed", userId: signIn.userId, verifier: signIn.verifier ?? "", site: signIn.site ?? null };
}

// ---------------------------------------------------------------------------
// Access tokens, refreshed when a sign-in's has expired. Linear rotates
// refresh tokens, so two refreshes at once would end the connection: one runs
// at a time per person and tracker, under a short lease.

/** How early before it expires an access token is refreshed. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** How long one refresh may hold the lease before another may take over. */
export const REFRESH_LEASE_MS = 30 * 1000;
/**
 * How long before its lease ends a refresh's request to the tracker is called
 * off, leaving time to encrypt and save the new tokens while the lease holds.
 */
export const REFRESH_SAVE_MS = 10 * 1000;

export type RefreshClaim =
  | { status: "missing" }
  /** The person's account for the tracker is another tracker account than the one asked for: they reconnected meanwhile. */
  | { status: "changed" }
  /** The access token is good as it is, for the account's site, if it has one. */
  | { status: "ready"; method: "oauth" | "token"; access: StoredToken; site: TrackerSite | null }
  /** Another refresh is running; ask again shortly. */
  | { status: "busy" }
  /** This caller holds the lease until `until`, and refreshes the connection made at `connectedAt` with this token. */
  | { status: "claimed"; refresh: StoredToken; until: number; connectedAt: number; site: TrackerSite | null }
  /** The access token expired and there's no refresh token. */
  | { status: "ended" }
  /** The token may not be used as asked (`TokenUse`): not the person's own request, or a job for a project they may no longer review. */
  | { status: "forbidden" };

/**
 * What a person's stored token is read for. It is checked in the same step
 * that reads the token (`claimTokenRefresh`), before the token is decrypted
 * or refreshed, so no caller can use it first and check afterwards:
 *
 * - `person`: the signed-in person, in their own request; they must be the
 *   token's person.
 * - `job`: work in the background on their behalf in these projects, such as
 *   a status check or a webhook following their linked tickets; they must
 *   still be allowed to review every one, and there must be at least one.
 * - `cleanup`: removing at the tracker only what Critiqs registered there
 *   with the token, such as a webhook, which reads nothing of any project.
 * - `privacy`: reporting stored Jira accounts to Atlassian's Personal Data
 *   Reporting API and refreshing the account's own display name (`/me`),
 *   which reads nothing of any project.
 */
export type TokenUse = { by: "person" } | { by: "job"; projects: string[] } | { by: "cleanup" } | { by: "privacy" };
/** A use a token may be returned for (`trackerAccessToken`): `cleanup` and `privacy` tokens are held only by narrow capabilities and never returned. */
export type TokenRead = Exclude<TokenUse, { by: "cleanup" | "privacy" }>;

/** Whether a token may be used as `use` says, for the person `userId` and tracker. */
async function mayUseToken(store: Store, userId: string, tracker: TrackerId, use: TokenUse, identity: Identity | null): Promise<boolean> {
  if (use.by === "cleanup") return true;
  if (use.by === "privacy") return tracker === "jira";
  if (use.by === "person") return identity !== null && (await store.users.byToken(identity.tokenIdentifier))?._id === userId;
  if (use.projects.length === 0) return false;
  for (const projectId of new Set(use.projects)) {
    const project = await store.projects.get(projectId);
    if (project === null || !(await canReview(store, project, userId))) return false;
  }
  return true;
}

/**
 * Reads a person's account for a tracker, only when it is still the tracker
 * account `accountId` (the tracker's ID for it) that the caller checked and
 * the token may be used as `use` says (`identity` is who is asking, for a
 * person's own request), and, when its access token is due (or `forceRefresh`
 * is requested), takes the refresh lease under `leaseId`. One transaction.
 */
export async function claimTokenRefresh(
  store: Store,
  args: { userId: string; tracker: TrackerId; accountId: string; leaseId: string; use: TokenUse; forceRefresh?: boolean },
  now: number,
  identity: Identity | null = null,
): Promise<RefreshClaim> {
  if (!(await mayUseToken(store, args.userId, args.tracker, args.use, identity))) return { status: "forbidden" };
  const accounts = ticketStore(store).accounts;
  const account = await accounts.find(args.userId, args.tracker);
  if (account === null) return { status: "missing" };
  if (args.use.by === "privacy" && account.method !== "oauth") return { status: "forbidden" };
  if (account.accountId !== args.accountId) return { status: "changed" };
  const site = account.site ?? null;
  if (!args.forceRefresh && (account.expiresAt === undefined || account.expiresAt > now + REFRESH_MARGIN_MS)) {
    return { status: "ready", method: account.method, access: account.access, site };
  }
  if (account.refreshLease !== undefined && account.refreshLease.until > now && account.refreshLease.id !== args.leaseId) return { status: "busy" };
  if (account.refresh === undefined) return { status: "ended" };
  const until = now + REFRESH_LEASE_MS;
  await accounts.patch(account._id, { refreshLease: { id: args.leaseId, until } });
  return { status: "claimed", refresh: account.refresh, until, connectedAt: account.connectedAt, site };
}

/** A person's account for a tracker as it is now: which connection, and its access token. */
export interface CurrentConnection {
  connectedAt: number;
  method: "oauth" | "token";
  access: StoredToken;
  expiresAt: number | null;
  site: TrackerSite | null;
}

export type RefreshFinish =
  | { status: "saved" }
  /** `leaseId` no longer held the lease: the account as it is now, or null when it's gone. */
  | { status: "rejected"; current: CurrentConnection | null };

/**
 * Stores refreshed tokens, already encrypted, and releases the lease; with
 * `tokens` null, only releases it. Nothing changes when `leaseId` no longer
 * holds the lease: the person disconnected or reconnected meanwhile, or
 * another caller took the lease over; the account as it is now comes back
 * instead. One transaction.
 */
export async function finishTokenRefresh(
  store: Store,
  args: { userId: string; tracker: TrackerId; leaseId: string; tokens: { access: StoredToken; refresh: StoredToken | null; expiresAt: number | null } | null },
  now: number,
): Promise<RefreshFinish> {
  const accounts = ticketStore(store).accounts;
  const account = await accounts.find(args.userId, args.tracker);
  if (account === null) return { status: "rejected", current: null };
  if (account.refreshLease?.id !== args.leaseId) {
    return { status: "rejected", current: { connectedAt: account.connectedAt, method: account.method, access: account.access, expiresAt: account.expiresAt ?? null, site: account.site ?? null } };
  }
  if (args.tokens === null) {
    await accounts.patch(account._id, { refreshLease: null });
    return { status: "saved" };
  }
  // A refresh that returns no new refresh token keeps the old one.
  await accounts.patch(account._id, {
    access: args.tokens.access,
    ...(args.tokens.refresh === null ? {} : { refresh: args.tokens.refresh }),
    expiresAt: args.tokens.expiresAt,
    refreshLease: null,
    updatedAt: now,
  });
  return { status: "saved" };
}

/** The steps of reading an access token; each store step is its own transaction. */
export interface AccessSteps {
  /** Reads the account, checking `use` in the same step (`claimTokenRefresh`): the reader passes its own use. */
  claim(leaseId: string, use: TokenUse, forceRefresh?: boolean): Promise<RefreshClaim>;
  finish(leaseId: string, tokens: { access: StoredToken; refresh: StoredToken | null; expiresAt: number | null } | null): Promise<RefreshFinish>;
  sleep(ms: number): Promise<void>;
  now(): number;
  leaseId(): string;
  fetch?: typeof fetch;
}

const BUSY_WAIT_MS = 500;

/**
 * A person's working token for a tracker, read for `use`, which the store
 * step checks (`AccessSteps.claim`); refreshed first when it has expired;
 * while another refresh runs, waits for it. Only the token of the tracker
 * account `accountId` that the caller checked: when the person has since
 * connected another account, it is refused, so nothing is asked of the
 * tracker as an account the caller didn't check. A token read only to
 * remove what Critiqs registered is never returned: `trackerRemovalAccess`
 * holds it.
 */
export async function trackerAccessToken(steps: AccessSteps, deployment: TicketsDeployment, args: { userId: string; tracker: TrackerId; accountId: string; use: TokenRead }): Promise<TrackerToken> {
  // Checked here too, for callers the types don't reach.
  const by = (args.use as TokenUse).by;
  if (by === "cleanup" || by === "privacy") throw new Error("A token read only for cleanup or privacy reporting is never returned.");
  return await accessToken(steps, deployment, args, args.use);
}

/**
 * A person's token for a tracker, read only to remove webhooks Critiqs
 * registered there (`cleanup`), as a `WebhookRemoval`, which can do that and
 * nothing else: the token never leaves it.
 */
export async function trackerRemovalAccess(steps: AccessSteps, deployment: TicketsDeployment, args: { userId: string; tracker: TrackerId; accountId: string }, webhooks: TrackerWebhooks): Promise<WebhookRemoval> {
  return webhookRemoval(webhooks, await accessToken(steps, deployment, args, { by: "cleanup" }));
}

/**
 * A person's Jira OAuth token read only for Atlassian's Personal Data
 * Reporting API (`{ by: "privacy" }`): it can report stored accounts and
 * refresh the person's own display name (`/me`), and nothing else — the
 * token never leaves it.
 */
export interface JiraPrivacyAccess {
  reportAccounts(accounts: readonly JiraReportedAccount[], now?: number): Promise<JiraAccountReport>;
  refreshProfile(): Promise<{ accountId: string; accountName: string; closed: boolean }>;
}

/** Holds a Jira OAuth token read for personal data reporting as a frozen `JiraPrivacyAccess`. */
export function jiraPrivacyCapability(deployment: TicketsDeployment, token: TrackerToken, fetchFn: typeof fetch = fetch): JiraPrivacyAccess {
  if (token.method !== "oauth") fail("invalid", "Personal data reporting requires a Jira OAuth sign-in.");
  const endpoint: TrackerEndpointOptions = { baseUrl: deployment.jiraApiUrl, fetch: fetchFn };
  const capability: JiraPrivacyAccess = {
    reportAccounts: async (accounts, now) => await reportJiraAccounts(endpoint, token.value, accounts, now),
    refreshProfile: async () => await readJiraProfile(endpoint, token.value),
  };
  return Object.freeze(capability);
}

/**
 * A person's Jira OAuth token, read only for Atlassian's Personal Data
 * Reporting API (`privacy`), as a `JiraPrivacyAccess` that never reveals the
 * token.
 */
export async function trackerPrivacyAccess(
  steps: AccessSteps,
  deployment: TicketsDeployment,
  args: { userId: string; accountId: string; forceRefresh?: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<JiraPrivacyAccess> {
  const token = await accessToken(steps, deployment, { ...args, tracker: "jira" }, { by: "privacy" }, args.forceRefresh === true);
  return jiraPrivacyCapability(deployment, token, fetchFn);
}

async function accessToken(steps: AccessSteps, deployment: TicketsDeployment, args: { userId: string; tracker: TrackerId; accountId: string }, use: TokenUse, forceRefresh = false): Promise<TrackerToken> {
  const key = requireKey(deployment);
  const binding = trackerTokenBinding(args.tracker, args.userId);
  const label = trackerLabel(args.tracker);
  const unreadable = (): never => fail("invalid", `Critiqs can no longer read your ${label} connection. Connect ${label} again in Your trackers.`);
  const leaseId = steps.leaseId();
  // Only a tracker reached at each site's own address gets the site with the token.
  const siteFor = (site: TrackerSite | null) => (trackerHasSites(args.tracker) ? { site } : {});
  // Waits at most a lease's length for another refresh, then takes over.
  for (let waited = 0; ; waited += BUSY_WAIT_MS) {
    const claim = forceRefresh ? await steps.claim(leaseId, use, true) : await steps.claim(leaseId, use);
    switch (claim.status) {
      case "forbidden":
        fail("forbidden", `Critiqs doesn't use your ${label} connection for this: you may no longer review its project.`);
      case "missing":
        fail("not-found", `Connect ${label} in Your trackers first.`);
      case "changed":
        fail("unavailable", `Your ${label} connection changed. Try again.`);
      case "ended":
        fail("invalid", `Your ${label} sign-in has ended. Connect ${label} again in Your trackers.`);
      case "ready": {
        const value = await decryptToken(key, binding, claim.access);
        return { method: claim.method, value: value ?? unreadable(), ...siteFor(claim.site) };
      }
      case "busy":
        if (waited >= REFRESH_LEASE_MS) fail("unavailable", `Critiqs couldn't refresh your ${label} sign-in. Try again in a moment.`);
        await steps.sleep(BUSY_WAIT_MS);
        continue;
      case "claimed": {
        const refreshToken = await decryptToken(key, binding, claim.refresh);
        const app = trackerSignIn(args.tracker, deployment);
        if (refreshToken === null || app === null) {
          await steps.finish(leaseId, null);
          return unreadable();
        }
        // The request ends, with time left to save, before the lease does:
        // after it, another caller may take over and spend the same refresh
        // token. Past that cutoff, it never starts.
        const cutoff = claim.until - REFRESH_SAVE_MS;
        if (steps.now() >= cutoff) {
          await steps.finish(leaseId, null);
          fail("unavailable", `Critiqs couldn't refresh your ${label} sign-in. Try again in a moment.`);
        }
        const call = new AbortController();
        const timer = setTimeout(() => call.abort(), cutoff - steps.now());
        let tokens: SignInTokens;
        try {
          tokens = await app.refresh(refreshToken, steps.now(), call.signal, steps.fetch ?? fetch);
        } catch (error) {
          await steps.finish(leaseId, null);
          if (call.signal.aborted) fail("unavailable", `${label} took too long to refresh your sign-in. Try again in a moment.`);
          throw error;
        } finally {
          clearTimeout(timer);
        }
        const saved = await steps.finish(leaseId, {
          access: await encryptToken(key, binding, tokens.access),
          refresh: tokens.refresh === null ? null : await encryptToken(key, binding, tokens.refresh),
          expiresAt: tokens.expiresAt,
        });
        if (saved.status === "saved") return { method: "oauth", value: tokens.access, ...siteFor(claim.site) };
        // Not saved, so never returned: the account as it is now decides.
        const current = saved.current;
        if (current === null) fail("not-found", `Connect ${label} in Your trackers first.`);
        if (current.connectedAt !== claim.connectedAt) fail("not-found", `Your ${label} connection changed while Critiqs was using it. Try again.`);
        if (current.expiresAt !== null && current.expiresAt <= steps.now() + REFRESH_MARGIN_MS) {
          fail("unavailable", `Critiqs couldn't refresh your ${label} sign-in. Try again in a moment.`);
        }
        // Another caller refreshed this connection and saved first.
        const value = await decryptToken(key, binding, current.access);
        return { method: current.method, value: value ?? unreadable(), ...siteFor(current.site) };
      }
    }
  }
}
