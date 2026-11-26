import { CritiqsError, fail } from "../../errors.ts";
import { checkedAdapter, type SignInTokens, type TrackerAdapter, type TrackerEndpoint, type TrackerEndpointOptions, type TrackerIdentity, type TrackerToken, trackerEndpoint } from "./index.ts";

// Linear, through its GraphQL API (https://linear.app/developers). A pasted
// personal API key is sent as it is; a sign-in's access token as a bearer
// token. Sign-in is OAuth 2 with PKCE; Linear rotates refresh tokens, so each
// one is used once.

/** Linear's API, which also issues sign-in tokens. */
export const LINEAR_API_URL = "https://api.linear.app";
/** Where people sign in to Linear and allow Critiqs. */
export const LINEAR_APP_URL = "https://linear.app";
/** Where a person creates a personal API key. */
export const LINEAR_API_KEY_PAGE = "https://linear.app/settings/account/security";

/** An operator's Linear OAuth app. */
export interface LinearApp {
  clientId: string;
  clientSecret: string;
}

const VERIFY = "query CritiqsVerify { viewer { id name email } organization { id name } }";

function endpointOf(endpoint: TrackerEndpointOptions): TrackerEndpoint {
  return trackerEndpoint(endpoint, LINEAR_API_URL);
}

/** Linear's adapter. Only `verify` is built so far; creating and linking tickets come next. */
export function linearAdapter(endpoint: TrackerEndpointOptions = {}): Pick<TrackerAdapter, "verify"> {
  const to = endpointOf(endpoint);
  return checkedAdapter({
    verify: async (token) => parseIdentity(await graphql(to, token, VERIFY)),
  });
}

const unreachable = () => new CritiqsError("unavailable", "Critiqs couldn't reach Linear. Try again in a moment.");
const unexpected = (what: string) => new CritiqsError("unavailable", `Linear's answer wasn't what Critiqs expected (${what}). Try again in a moment.`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function graphql(to: TrackerEndpoint, token: TrackerToken, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await to.fetch(`${to.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token.method === "oauth" ? `Bearer ${token.value}` : token.value,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw unreachable();
  }
  const body: unknown = await response.json().catch(() => null);
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  if (response.status === 401 || response.status === 403 || errors.some(isAuthenticationError)) {
    fail(
      "invalid",
      token.method === "oauth"
        ? "Linear no longer accepts Critiqs's sign-in. Connect Linear again in Your trackers."
        : "Linear didn't accept this API key. Check that you copied all of it, or create a new one.",
    );
  }
  if (response.status === 429 || errors.some((error) => isRecord(error) && isRecord(error.extensions) && error.extensions.code === "RATELIMITED")) {
    fail("limit", "Linear is limiting requests right now. Try again in a minute.");
  }
  if (!response.ok || errors.length > 0 || !isRecord(body) || !isRecord(body.data)) throw unexpected(`status ${response.status}`);
  return body.data;
}

function isAuthenticationError(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error.extensions)) return false;
  return error.extensions.code === "AUTHENTICATION_ERROR" || error.extensions.type === "authentication error";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseIdentity(data: unknown): TrackerIdentity {
  const viewer = isRecord(data) ? data.viewer : null;
  const organization = isRecord(data) ? data.organization : null;
  if (!isRecord(viewer) || !text(viewer.id) || !text(viewer.name)) throw unexpected("no account");
  const site = isRecord(organization) && text(organization.id) && text(organization.name) ? { id: organization.id, name: organization.name } : null;
  return { accountId: viewer.id, accountName: viewer.name, email: text(viewer.email) ? viewer.email : null, site };
}

/**
 * Linear's sign-in page for Critiqs, asking only for what tickets need: to
 * read, to create and update issues with their attachments and files, and to
 * add comments. Never Linear's broad `write`.
 */
export function linearAuthorizeUrl(appUrl: string, input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL("/oauth/authorize", appUrl);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "read,issues:create,comments:create",
    state: input.state,
    actor: "user",
    prompt: "consent",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Exchanges a sign-in's code for tokens. */
export async function exchangeLinearCode(
  endpoint: TrackerEndpointOptions,
  app: LinearApp,
  input: { code: string; redirectUri: string; verifier: string },
  now: number,
): Promise<SignInTokens> {
  return await tokenRequest(
    endpointOf(endpoint),
    { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier, client_id: app.clientId, client_secret: app.clientSecret },
    now,
    "Linear didn't accept this sign-in. Close this window and connect Linear again.",
  );
}

/**
 * Trades a refresh token for new tokens. Linear rotates refresh tokens: the
 * one used here stops working. `signal` calls the request off, answer included.
 */
export async function refreshLinearToken(endpoint: TrackerEndpointOptions, app: LinearApp, refreshToken: string, now: number, signal?: AbortSignal): Promise<SignInTokens> {
  return await tokenRequest(
    endpointOf(endpoint),
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret },
    now,
    "Your Linear sign-in has ended. Connect Linear again in Your trackers.",
    signal,
  );
}

async function tokenRequest(to: TrackerEndpoint, form: Record<string, string>, now: number, refused: string, signal?: AbortSignal): Promise<SignInTokens> {
  let response: Response;
  try {
    response = await to.fetch(`${to.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw unreachable();
  }
  const body: unknown = await response.json().catch(() => null);
  // OAuth's refusals: a code or refresh token that is wrong, used, or expired, or a client Linear doesn't know.
  if (response.status === 400 || response.status === 401) {
    if (isRecord(body) && (body.error === "invalid_client" || body.error === "unauthorized_client")) {
      fail("unavailable", "Linear doesn't recognize this deployment's Linear app. Its operator must check CRITIQS_LINEAR_CLIENT_ID and CRITIQS_LINEAR_CLIENT_SECRET.");
    }
    fail("invalid", refused);
  }
  if (!response.ok || !isRecord(body) || !text(body.access_token)) throw unexpected(`status ${response.status}`);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return {
    access: body.access_token,
    refresh: text(body.refresh_token) ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
  };
}
