import { type TicketDestination, type TicketStatus, type TicketStatusCategory, TRACKER_LIMITS, type WebAddress, webAddress } from "@critiqs/core";
import { CritiqsError, fail } from "../../errors.ts";
import {
  checkedAdapter,
  type CreatedTicket,
  type CreateOutcome,
  type SignInTokens,
  type TicketImage,
  type TrackerAdapter,
  type TrackerEndpoint,
  type TrackerEndpointOptions,
  type TicketPlace,
  type TrackerIdentity,
  TrackerRefusal,
  type TrackerToken,
  trackerEndpoint,
  trackerText,
  trackerWebOrigins,
} from "./index.ts";

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
/** What Critiqs reads of an issue. */
const ISSUE = "id identifier title url state { name type } team { organization { id } }";
const TEAMS = "query CritiqsTeams { teams(first: 250) { nodes { id name key } } }";
// Archived issues too: Linear's lists leave them out unless asked, and an issue
// archived since it was created or linked is still that ticket.
const ISSUE_BY_ID = `query CritiqsIssue($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1, includeArchived: true) { nodes { ${ISSUE} } } }`;
const ISSUE_BY_KEY = `query CritiqsIssueByKey($team: String!, $number: Float!) { issues(filter: { team: { key: { eqIgnoreCase: $team } }, number: { eq: $number } }, first: 1) { nodes { ${ISSUE} } } }`;
const SEARCH = `query CritiqsSearch($term: String!, $teamId: String) { searchIssues(term: $term, teamId: $teamId, first: 10) { nodes { ${ISSUE} } } }`;
const CREATE = `mutation CritiqsCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`;
// Linear keeps one attachment per issue and address: creating it again updates
// it (https://linear.app/developers/attachments), so the link back is safe to repeat.
const LINK_BACK = "mutation CritiqsLinkBack($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }";
const COMMENT = "mutation CritiqsComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }";
const UPLOAD = "mutation CritiqsUpload($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }";

/** A Linear issue key, such as `ENG-123`: the team's key and the issue's number. */
const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-(\d{1,9})$/;
/** Linear accepts an issue ID chosen by the caller only in UUID v4 form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function endpointOf(endpoint: TrackerEndpointOptions): TrackerEndpoint {
  return trackerEndpoint(endpoint, LINEAR_API_URL);
}

/** Linear's adapter: issues in a team, the thread's link as an attachment, and the capture uploaded into the issue's text. */
export function linearAdapter(endpoint: TrackerEndpointOptions = {}): TrackerAdapter {
  const to = endpointOf(endpoint);
  const issueById = async (token: TrackerToken, id: string) => firstIssue(await graphql(to, token, ISSUE_BY_ID, { id }), "issues");
  return checkedAdapter({
    verify: async (token) => parseIdentity(await graphql(to, token, VERIFY)),
    destinations: async (token) => parseTeams(await graphql(to, token, TEAMS)),
    search: async (token, query, destinationId) => {
      const term = query.trim();
      const key = KEY_PATTERN.exec(term);
      if (key !== null) {
        const found = firstIssue(await graphql(to, token, ISSUE_BY_KEY, { team: key[1], number: Number(key[2]) }), "issues");
        if (found !== null) return [found];
      }
      return issueList(await graphql(to, token, SEARCH, { term, teamId: destinationId ?? null }), "searchIssues");
    },
    get: async (token, externalId) => {
      const issue = await issueById(token, externalId);
      if (issue === null) fail("not-found", "Linear can't find this issue, or you can't see it.");
      return issue;
    },
    create: async (token, input): Promise<CreateOutcome> => {
      let written: Written;
      try {
        written = await write(to, token, CREATE, {
          input: {
            ...(UUID_PATTERN.test(input.creationId) ? { id: input.creationId } : {}),
            teamId: input.destinationId,
            title: input.title,
            description: input.body,
          },
        }, "issueCreate", "issue");
      } catch (error) {
        if (error instanceof TrackerRefusal) return { status: "refused", error };
        return { status: "unknown", error: error instanceof CritiqsError ? error : unexpected("no answer") };
      }
      // Linear answered that it made nothing.
      if (!written.done) return { status: "refused", error: new TrackerRefusal("invalid", "Linear didn't create the issue. Try again, or choose another team.") };
      // Made, but Critiqs can't read all of it: the next attempt finds it by the creation's ID.
      const ticket = parseIssue(written.payload.issue);
      return ticket === null || !written.clean ? { status: "unknown", error: unexpected(ticket === null ? "issue unreadable" : "errors with the issue") } : { status: "created", ticket };
    },
    // The creation's ID became the issue's ID, so the issue is found by it alone.
    findCreated: async (token, created) => (UUID_PATTERN.test(created.creationId) ? await issueById(token, created.creationId) : null),
    linkBack: async (token, ticket, link) => {
      const written = await write(to, token, LINK_BACK, { input: { issueId: ticket.externalId, url: link.url, title: link.title } }, "attachmentCreate");
      if (!written.done) throw new TrackerRefusal("invalid", "Linear didn't add the link back to the thread.");
    },
    comment: async (token, ticket, body) => {
      const written = await write(to, token, COMMENT, { input: { issueId: ticket.externalId, body } }, "commentCreate");
      if (!written.done) throw new TrackerRefusal("invalid", "Add it in Linear instead.");
    },
    status: async (token, ticket) => {
      const issue = (await issueById(token, ticket.externalId)) ?? fail("not-found", "Linear can't find this issue, or you can't see it.");
      return { externalId: issue.externalId, status: issue.status };
    },
    uploadImage: async (token, image) => uploadImage(to, token, image),
  }, linearPlace(trackerWebOrigins(endpoint, LINEAR_APP_URL)));
}

/**
 * Where Linear's issues are: `<Linear>/<workspace>/issue/<key>`, with the
 * issue's title after it. Critiqs doesn't hold the workspace's name in the
 * address, so an issue's address is kept when it is on Linear's own address
 * and names the issue's key.
 */
function linearPlace(origins: string[]): TicketPlace {
  return (ticket) => {
    const url = webAddress(ticket.url);
    if (url === null) return null;
    const address = new URL(url);
    const [workspace, kind, key] = address.pathname.split("/").slice(1);
    // Compared as Critiqs keeps keys, cut to their limit.
    const named = key === undefined || /%(?![0-9A-Fa-f]{2})/.test(key) ? "" : trackerText(decodeURIComponent(key), TRACKER_LIMITS.key);
    return origins.includes(address.origin) && workspace !== undefined && workspace !== "" && kind === "issue" && named.toLowerCase() === ticket.key.toLowerCase() ? url : null;
  };
}

/** Linear's state types, as Critiqs's status categories. */
export function linearStatusCategory(type: string): TicketStatusCategory {
  switch (type) {
    case "triage":
    case "backlog":
    case "unstarted":
      return "open";
    case "started":
      return "started";
    case "completed":
      return "done";
    // Linear files duplicates under Canceled.
    case "canceled":
    case "duplicate":
      return "canceled";
    default:
      return "unknown";
  }
}

/**
 * Uploads an image to Linear's storage: Linear signs an upload address, the
 * image goes there with the headers it names, and the issue's text embeds its
 * asset address, which Linear serves to people in the workspace.
 */
async function uploadImage(to: TrackerEndpoint, token: TrackerToken, image: TicketImage): Promise<WebAddress> {
  const written = await write(to, token, UPLOAD, { contentType: image.contentType, filename: image.name, size: image.data.size }, "fileUpload");
  const file = written.done && written.clean ? written.payload.uploadFile : null;
  if (!isRecord(file) || !text(file.uploadUrl) || !text(file.assetUrl) || !Array.isArray(file.headers)) throw unexpected("no upload address");
  const asset = webAddress(file.assetUrl);
  if (asset === null) throw unexpected("upload address");
  const headers = new Headers({ "Content-Type": image.contentType, "Cache-Control": "public, max-age=31536000" });
  for (const header of file.headers) {
    // Only the storage's own headers that sign the upload, never ones that could stand for someone, such as Authorization.
    if (isRecord(header) && text(header.key) && UPLOAD_HEADER.test(header.key) && typeof header.value === "string") headers.set(header.key, header.value);
  }
  let response: Response;
  try {
    response = await to.fetch(file.uploadUrl, { method: "PUT", headers, body: image.data });
  } catch {
    throw unreachable();
  }
  if (!response.ok) throw unexpected(`upload status ${response.status}`);
  return asset;
}

/** The headers an upload may carry from Linear's answer: its storage's signed `x-goog-` (or `x-amz-`) headers, and how the file is stored. */
const UPLOAD_HEADER = /^(?:x-goog-[a-z0-9-]+|x-amz-[a-z0-9-]+|content-disposition|content-md5|cache-control)$/i;

const unreachable = () => new CritiqsError("unavailable", "Critiqs couldn't reach Linear. Try again in a moment.");
const unexpected = (what: string) => new CritiqsError("unavailable", `Linear's answer wasn't what Critiqs expected (${what}). Try again in a moment.`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Linear's answer to one request, before Critiqs decides what it means. */
interface Answer {
  response: Response;
  body: unknown;
  errors: unknown[];
}

async function send(to: TrackerEndpoint, token: TrackerToken, query: string, variables: Record<string, unknown>): Promise<Answer> {
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
  return { response, body, errors: isRecord(body) && Array.isArray(body.errors) ? body.errors : [] };
}

/** Throws what an answer with a problem means: a refusal Linear answered with, so it did nothing; or a failure that may have done what was asked. */
function requireClean({ response, body, errors }: Answer, token: TrackerToken): void {
  if (response.status === 401 || response.status === 403 || errors.some(isAuthenticationError)) {
    throw new TrackerRefusal(
      "invalid",
      token.method === "oauth"
        ? "Linear no longer accepts Critiqs's sign-in. Connect Linear again in Your trackers."
        : "Linear didn't accept this API key. Check that you copied all of it, or create a new one.",
    );
  }
  if (response.status === 429 || errors.some((error) => extensionsOf(error).code === "RATELIMITED")) {
    throw new TrackerRefusal("limit", "Linear is limiting requests right now. Try again in a minute.");
  }
  const refused = errors.find(isUserError);
  if (refused !== undefined || (response.status >= 400 && response.status < 500 && response.status !== 408)) {
    const forbidden = refused !== undefined && (extensionsOf(refused).code === "FORBIDDEN" || extensionsOf(refused).type === "forbidden");
    throw new TrackerRefusal(forbidden ? "forbidden" : "invalid", `Linear turned this down: ${refusalText(refused) ?? `status ${response.status}`}`);
  }
  // Anything else may have done what was asked: a server error, or an answer Critiqs can't read.
  if (!response.ok || errors.length > 0 || !isRecord(body) || !isRecord(body.data)) throw unexpected(`status ${response.status}`);
}

async function graphql(to: TrackerEndpoint, token: TrackerToken, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const answer = await send(to, token, query, variables);
  requireClean(answer, token);
  return (answer.body as { data: unknown }).data;
}

/** What a write did, as Linear answered. */
interface Written {
  /** The write's answer, `data[field]`; empty when Linear made nothing. */
  payload: Record<string, unknown>;
  /** Whether Linear says it made the write. */
  done: boolean;
  /** Whether the answer had no errors besides. */
  clean: boolean;
}

/**
 * Sends a write and reads its own answer (`data[field]`) before any error:
 * Linear can make a write and still report errors elsewhere in its answer,
 * such as a field of the new issue it couldn't read back. A write Linear says
 * it made (`success`, or the `record` it wrote present) is done, whatever
 * those errors say; one it says failed (`success: false`) isn't. Otherwise
 * the answer's errors decide, as for any request.
 */
async function write(to: TrackerEndpoint, token: TrackerToken, query: string, variables: Record<string, unknown>, field: string, record?: string): Promise<Written> {
  const answer = await send(to, token, query, variables);
  const data = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : null;
  const payload = data !== null && isRecord(data[field]) ? data[field] : null;
  if (payload !== null && (payload.success === true || (record !== undefined && payload[record] != null))) {
    return { payload, done: true, clean: answer.response.ok && answer.errors.length === 0 };
  }
  if (payload !== null && payload.success === false) return { payload, done: false, clean: answer.errors.length === 0 };
  requireClean(answer, token);
  throw unexpected(`no ${field}`);
}

function extensionsOf(error: unknown): Record<string, unknown> {
  return isRecord(error) && isRecord(error.extensions) ? error.extensions : {};
}

/** An error Linear says the caller caused, such as input it turned down or something the person may not do: nothing was done. */
function isUserError(error: unknown): boolean {
  const extensions = extensionsOf(error);
  return extensions.userError === true || extensions.code === "INPUT_ERROR" || extensions.code === "FORBIDDEN" || extensions.type === "invalid input" || extensions.type === "forbidden";
}

/** Linear's own words for a refusal, as one sentence. */
function refusalText(error: unknown): string | null {
  const extensions = extensionsOf(error);
  const text = typeof extensions.userPresentableMessage === "string" ? extensions.userPresentableMessage : isRecord(error) && typeof error.message === "string" ? error.message : "";
  const line = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return line === "" ? null : /[.!?]$/.test(line) ? line : `${line}.`;
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

function parseTeams(data: unknown): TicketDestination[] {
  const teams = isRecord(data) && isRecord(data.teams) && Array.isArray(data.teams.nodes) ? data.teams.nodes : null;
  if (teams === null) throw unexpected("no teams");
  return teams
    .filter((team): team is Record<string, unknown> => isRecord(team) && text(team.id) && text(team.name))
    .map((team) => ({ id: team.id as string, name: team.name as string, key: text(team.key) ? team.key : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseStatus(value: unknown): TicketStatus {
  if (!isRecord(value) || !text(value.name)) return { label: "Unknown", category: "unknown" };
  return { label: value.name, category: typeof value.type === "string" ? linearStatusCategory(value.type) : "unknown" };
}

/** An issue as Linear sent it; null when it isn't one. */
function parseIssue(value: unknown): CreatedTicket | null {
  if (!isRecord(value) || !text(value.id) || !text(value.identifier) || typeof value.title !== "string" || !text(value.url) || !/^https?:\/\//.test(value.url)) return null;
  const organization = isRecord(value.team) && isRecord(value.team.organization) ? value.team.organization : null;
  return {
    tracker: "linear",
    externalId: value.id,
    key: value.identifier,
    url: value.url,
    title: value.title,
    status: parseStatus(value.state),
    site: organization !== null && text(organization.id) ? organization.id : null,
  };
}

function issueList(data: unknown, field: string): CreatedTicket[] {
  const connection = isRecord(data) ? data[field] : null;
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) throw unexpected("no issues");
  return connection.nodes.map(parseIssue).filter((issue): issue is CreatedTicket => issue !== null);
}

function firstIssue(data: unknown, field: string): CreatedTicket | null {
  return issueList(data, field)[0] ?? null;
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

/**
 * Ends a sign-in's token at Linear (https://linear.app/developers/oauth-2-0-authentication,
 * "Revoke an access token"): the token in the `token` field, with which kind
 * it is. `revoked` when Linear answered 200; `refused` when it couldn't revoke
 * it (400, as for a token already revoked, or any other refusal); and
 * `unreachable` when there was no answer, or a server error.
 */
export async function revokeLinearToken(endpoint: TrackerEndpointOptions, app: LinearApp, token: string, kind: "access_token" | "refresh_token"): Promise<"revoked" | "refused" | "unreachable"> {
  const to = endpointOf(endpoint);
  try {
    const response = await to.fetch(`${to.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ token, token_type_hint: kind, client_id: app.clientId, client_secret: app.clientSecret }).toString(),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "revoked";
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? "refused" : "unreachable";
  } catch {
    return "unreachable";
  }
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
