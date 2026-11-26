import { markdownCodeBlock, markdownLink, markdownText, type TicketDestination, type TicketMarkdown, type TicketRef, type TicketStatus, ticketLinkComment, type TrackerTemplateGroup, webAddress } from "@critiqs/core";
import { parse as parseYaml } from "yaml";
import { CritiqsError, fail } from "../../errors.ts";
import {
  checkedAdapter,
  type CreatedTicket,
  type CreateOutcome,
  type HeldTicket,
  type SignInTokens,
  type TicketStatusUpdate,
  type TrackerAdapter,
  type TrackerEndpoint,
  type TrackerEndpointOptions,
  type TrackerIdentity,
  type TrackerLabel,
  TrackerRefusal,
  type TrackerTemplate,
  type TicketPlace,
  type TicketPlaceNow,
  type TrackerToken,
  trackerEndpoint,
  trackerWebOrigins,
} from "./index.ts";

// GitHub Issues, through GitHub's REST API (https://docs.github.com/en/rest),
// and its GraphQL API for reading and commenting on one issue by its node ID,
// which stays the same when its repository is renamed or moved, unlike the
// repository's name and the issue's number. Both kinds of
// token are sent as bearer tokens: a GitHub App's user access token from
// sign-in, or a fine-grained personal access token a person pasted. A ticket's
// permanent ID is the issue's node ID, which GitHub's webhooks carry too.
//
// Sign-in is the GitHub App's web flow with PKCE. Its user access tokens
// expire after 8 hours; each refresh returns a new refresh token and ends the
// old one, so refreshes run one at a time, as for Linear. The app reaches only
// repositories where an organization or person installed it, and a user
// access token only what both the person and the app can reach.

/** GitHub's REST and GraphQL API. */
export const GITHUB_API_URL = "https://api.github.com";
/** Where people sign in to GitHub and install apps; also where sign-in tokens are issued. */
export const GITHUB_APP_URL = "https://github.com";
/** Where a person creates a fine-grained personal access token. */
export const GITHUB_TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

/** An operator's GitHub App: its client ID and secret, and its public name (slug), for the install link. */
export interface GithubApp {
  clientId: string;
  clientSecret: string;
  slug: string;
}

/** The REST API version Critiqs is written against. */
const API_VERSION = "2022-11-28";
/** Where a repository keeps its issue templates and issue forms. */
const TEMPLATE_FOLDER = ".github/ISSUE_TEMPLATE";
/** Most templates read in one repository, and most repositories read for templates at once. */
const MAX_TEMPLATES = 25;
const MAX_TEMPLATE_REPOSITORIES = 30;
/** Most installations, and pages of 100 repositories, read for a person's destinations. */
const MAX_INSTALLATIONS = 10;
const MAX_REPOSITORY_PAGES = 5;
/** Most repositories one search names, and most words it searches for. */
const MAX_SEARCH_REPOSITORIES = 20;
const MAX_SEARCH_WORDS = 10;

/** A repository's full name, `owner/name`, as a destination's ID. GitHub forbids the names `.` and `..`, which an address would collapse. */
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?!\.{1,2}$)([A-Za-z0-9._-]{1,100})$/;
/** An issue's key as people write it: `owner/repo#12`, `repo#12`, or `#12`. */
const KEY = /^(?:(?:([A-Za-z0-9-]{1,39})\/)?(?!\.{1,2}#)([A-Za-z0-9._-]{1,100}))?#(\d{1,9})$/;
/** A template's ID: the repository's full name and the file's name in its template folder. */
const TEMPLATE_ID = /^([A-Za-z0-9-]{1,39}\/(?!\.{1,2}:)[A-Za-z0-9._-]{1,100}):([A-Za-z0-9._ -]{1,200})$/;
/** Template files GitHub reads: Markdown templates and issue forms. `config.yml` configures the chooser and isn't one. */
const TEMPLATE_FILE = /\.(?:md|ya?ml)$/i;
const CONFIG_FILE = /^config\.ya?ml$/i;

/** A creation's ID as Critiqs makes them: a UUID, so its mark can't end the comment it is in. */
const CREATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The mark a new issue carries, so an attempt whose answer was lost finds the
 * issue it made. An HTML comment: GitHub doesn't show it. Refused for an ID
 * that isn't a UUID, so nothing in it can end the comment.
 */
export function creationMark(creationId: string): string {
  if (!CREATION_ID.test(creationId)) throw new TrackerRefusal("invalid", "This ticket's creation has no valid ID. Close the dialog and create the ticket again.");
  return `<!-- critiqs-creation: ${creationId.toLowerCase()} -->`;
}

const ISSUE_FIELDS = "id number title url state stateReason updatedAt repository { name nameWithOwner }";
const NODE = `query CritiqsIssue($id: ID!) { node(id: $id) { __typename ... on Issue { ${ISSUE_FIELDS} } } }`;
// An issue's text and its comments, a hundred at a time, by its node ID: where the thread's link may already be.
const LINKS = "query CritiqsIssueLinks($id: ID!, $after: String) { node(id: $id) { __typename ... on Issue { id body comments(first: 100, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } } } }";
// A comment on the issue by its node ID (https://docs.github.com/en/graphql/reference/mutations#addcomment).
const ADD_COMMENT = "mutation CritiqsComment($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { subject { id } } }";

function endpointOf(endpoint: TrackerEndpointOptions, base: string): TrackerEndpoint {
  return trackerEndpoint(endpoint, base);
}

const unreachable = () => new CritiqsError("unavailable", "Critiqs couldn't reach GitHub. Try again in a moment.");
const unexpected = (what: string) => new CritiqsError("unavailable", `GitHub's answer wasn't what Critiqs expected (${what}). Try again in a moment.`);
const notFound = () => new CritiqsError("not-found", "GitHub can't find this issue, or you can't see it.");
/** A write to an issue GitHub no longer has, or the person can't see: refused, so nothing was written. */
const gone = () => new TrackerRefusal("invalid", "GitHub can't find this issue any more, or you can't see it.");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** A repository's owner and name from a destination ID; refused when it isn't one. */
function repositoryOf(destinationId: string): { owner: string; name: string } {
  const match = REPOSITORY.exec(destinationId);
  if (match === null) throw new TrackerRefusal("invalid", "Choose a repository from the list.");
  return { owner: match[1]!, name: match[2]! };
}

/** A path under a repository, its parts escaped, so nothing a person or GitHub sent changes which address is asked. */
function repoPath(repository: { owner: string; name: string }, ...rest: (string | number)[]): string {
  return ["repos", repository.owner, repository.name, ...rest].map((part) => encodeURIComponent(String(part))).join("/");
}

/** GitHub's answer to one request, before Critiqs decides what it means. */
interface Answer {
  response: Response;
  body: unknown;
}

/** What a request needs besides its address. */
interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number>;
  json?: unknown;
  /** Asks for a file's raw text (`application/vnd.github.raw+json`), read as text. */
  raw?: boolean;
}

async function send(to: TrackerEndpoint, token: TrackerToken, path: string, options: RequestOptions = {}): Promise<Answer> {
  const url = new URL(`${to.baseUrl}/${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, String(value));
  let response: Response;
  try {
    response = await to.fetch(url.toString(), {
      method: options.method ?? "GET",
      headers: {
        Accept: options.raw === true ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        Authorization: `Bearer ${token.value}`,
        "X-GitHub-Api-Version": API_VERSION,
        // GitHub refuses requests without a User-Agent.
        "User-Agent": "Critiqs",
        ...(options.json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    });
  } catch {
    throw unreachable();
  }
  const body: unknown = options.raw === true && response.ok ? await response.text().catch(() => null) : await response.json().catch(() => null);
  return { response, body };
}

/** GitHub's own words for a refusal, as one sentence: its message and the first of its validation errors. */
function refusalText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const parts = [typeof body.message === "string" ? body.message : ""];
  const [first] = Array.isArray(body.errors) ? body.errors : [];
  if (isRecord(first) && typeof first.message === "string") parts.push(first.message);
  else if (isRecord(first) && typeof first.field === "string" && typeof first.code === "string") parts.push(`${first.field} ${first.code}`);
  const line = parts.join(": ").replace(/\s+/g, " ").trim().slice(0, 200);
  return line === "" ? null : /[.!?]$/.test(line) ? line : `${line}.`;
}

/** Whether an answer is GitHub limiting requests: 429, or 403 with no requests left or a time to wait. */
function isLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
}

/**
 * Throws what an answer with a problem means: a refusal GitHub answered with,
 * so it did nothing (a token it doesn't accept, a limit, something the person
 * may not do, input it turned down); or a failure that may have done what was
 * asked (a server error, an answer Critiqs can't read). `missing` is what a
 * 404 or 410 means for this request.
 */
function requireOk(answer: Answer, token: TrackerToken, missing: () => CritiqsError = notFound): void {
  const { response, body } = answer;
  if (response.ok) return;
  if (response.status === 401) {
    throw new TrackerRefusal(
      "invalid",
      token.method === "oauth"
        ? "GitHub no longer accepts Critiqs's sign-in. Connect GitHub again in Your trackers."
        : "GitHub didn't accept this token. Check that you copied all of it and that it hasn't expired, or create a new one.",
    );
  }
  if (isLimited(response)) throw new TrackerRefusal("limit", "GitHub is limiting requests right now. Try again in a minute.");
  if (response.status === 403) throw new TrackerRefusal("forbidden", `GitHub turned this down: ${refusalText(body) ?? "you don't have access"}`);
  if (response.status === 404 || response.status === 410) throw missing();
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    throw new TrackerRefusal("invalid", `GitHub turned this down: ${refusalText(body) ?? `status ${response.status}`}`);
  }
  throw unexpected(`status ${response.status}`);
}

async function rest(to: TrackerEndpoint, token: TrackerToken, path: string, options: RequestOptions = {}, missing?: () => CritiqsError): Promise<unknown> {
  const answer = await send(to, token, path, options);
  requireOk(answer, token, missing);
  return answer.body;
}

/** Up to `pages` pages of 100 of a list, each read by `items` from one answer; stops at the first short page. */
async function pages<T>(read: (page: number) => Promise<unknown>, items: (body: unknown) => T[] | null, maxPages: number): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const list = items(await read(page));
    if (list === null) throw unexpected("no list");
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

async function graphql(to: TrackerEndpoint, token: TrackerToken, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await send(to, token, "graphql", { method: "POST", json: { query, variables } });
  requireOk(answer, token);
  const { body } = answer;
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const type = (error: unknown) => (isRecord(error) && typeof error.type === "string" ? error.type : "");
  if (errors.some((error) => type(error) === "RATE_LIMITED")) throw new TrackerRefusal("limit", "GitHub is limiting requests right now. Try again in a minute.");
  if (errors.some((error) => type(error) === "FORBIDDEN")) throw new TrackerRefusal("forbidden", "GitHub turned this down: you don't have access.");
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  // GitHub answers an ID it can't resolve, or one the person can't see, with NOT_FOUND and a null node.
  if (data === null || (errors.length > 0 && !errors.every((error) => type(error) === "NOT_FOUND"))) throw unexpected("errors in the answer");
  return data;
}

// ---------------------------------------------------------------------------
// Issues and their status.

/** GitHub's issue states, with the reason it was closed, as Critiqs's statuses. */
export function githubStatus(state: string, reason: string | null | undefined): TicketStatus {
  if (state.toLowerCase() === "open") return { label: "Open", category: "open" };
  if (state.toLowerCase() !== "closed") return { label: "Unknown", category: "unknown" };
  switch (reason?.toLowerCase()) {
    case "not_planned":
      return { label: "Closed as not planned", category: "canceled" };
    case "duplicate":
      return { label: "Closed as duplicate", category: "canceled" };
    default:
      return { label: "Closed", category: "done" };
  }
}

/** The status Critiqs records for an issue GitHub deleted: the work is closed there, as for not planned. */
export const GITHUB_DELETED_STATUS = { label: "Deleted", category: "canceled" } as const;

/** A time GitHub sent as an ISO 8601 string, in milliseconds; null when it isn't one. */
function timeOf(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * A repository's full name as a ticket's site: lower-case, as GitHub matches
 * names. Issue node IDs are unique across GitHub, but a webhook still reaches
 * only links to issues in the repository it names.
 */
export function githubSite(fullName: string): string {
  return fullName.toLowerCase();
}

/** An issue as the REST API sends it, in `repository`; null when it isn't one, is a pull request, or its page isn't a web address. */
function parseRestIssue(value: unknown, repository: { owner: string; name: string }): CreatedTicket | null {
  if (!isRecord(value) || isRecord(value.pull_request) || !text(value.node_id) || typeof value.number !== "number" || !Number.isSafeInteger(value.number) || typeof value.title !== "string") return null;
  const url = typeof value.html_url === "string" ? webAddress(value.html_url) : null;
  if (url === null || typeof value.state !== "string") return null;
  return {
    tracker: "github",
    externalId: value.node_id,
    key: `${repository.name}#${value.number}`,
    url,
    title: value.title,
    status: githubStatus(value.state, typeof value.state_reason === "string" ? value.state_reason : null),
    site: githubSite(`${repository.owner}/${repository.name}`),
    asOf: timeOf(value.updated_at),
  };
}

/** An issue as the GraphQL API sends it; null when the node isn't an issue, or its page isn't a web address. */
function parseNodeIssue(value: unknown): CreatedTicket | null {
  if (!isRecord(value) || value.__typename !== "Issue" || !text(value.id) || typeof value.number !== "number" || !Number.isSafeInteger(value.number) || typeof value.title !== "string") return null;
  const url = typeof value.url === "string" ? webAddress(value.url) : null;
  if (url === null || typeof value.state !== "string" || !isRecord(value.repository) || !text(value.repository.name)) return null;
  const { repository } = value;
  if (!text(repository.nameWithOwner) || !REPOSITORY.test(repository.nameWithOwner)) return null;
  return {
    tracker: "github",
    externalId: value.id,
    key: `${repository.name}#${value.number}`,
    url,
    title: value.title,
    status: githubStatus(value.state, typeof value.stateReason === "string" ? value.stateReason : null),
    site: githubSite(repository.nameWithOwner),
    asOf: timeOf(value.updatedAt),
  };
}

/** The repository's name from an API repository object, as `owner/name`, with its short name. */
function nameOf(value: unknown): { fullName: string; name: string } | null {
  if (!isRecord(value) || !text(value.full_name) || !text(value.name) || !REPOSITORY.test(value.full_name)) return null;
  return { fullName: value.full_name, name: value.name };
}

/** An issue's repository and number, from its key (`repo#12`) and its site (`owner/repo`); null when they don't agree. */
function issueIn(ticket: { key: string; site: string | null }): { repository: { owner: string; name: string }; number: number } | null {
  const site = ticket.site === null ? null : REPOSITORY.exec(ticket.site);
  const key = /^(?!\.{1,2}#)([A-Za-z0-9._-]{1,100})#(\d{1,9})$/.exec(ticket.key);
  if (site === null || key === null || key[1]!.toLowerCase() !== site[2]!.toLowerCase()) return null;
  return { repository: { owner: site[1]!, name: site[2]! }, number: Number(key[2]) };
}

/** Where an issue lives, from its page's address (`…/owner/repo/issues/12`), for an address a person pasted to search. */
function issueAddress(url: string): { repository: { owner: string; name: string }; number: number } {
  let parts: string[];
  try {
    parts = new URL(url).pathname.split("/").filter((part) => part !== "");
  } catch {
    throw unexpected("issue address");
  }
  const [owner, name, kind, number] = parts.slice(-4);
  if (owner === undefined || name === undefined || kind !== "issues" || number === undefined || !/^\d{1,9}$/.test(number) || !REPOSITORY.test(`${owner}/${name}`)) {
    throw unexpected("issue address");
  }
  return { repository: { owner, name }, number: Number(number) };
}

/**
 * Where GitHub's issues are: `<GitHub>/<owner>/<repo>/issues/<number>`, from
 * the issue's site (its repository) and key (its number). An address is kept
 * only when it is that page, on GitHub's own address, in any letter case.
 */
function githubPlace(origins: string[]): TicketPlace {
  return (ticket) => {
    const issue = issueIn(ticket);
    const url = webAddress(ticket.url);
    if (issue === null || url === null) return null;
    const path = `/${issue.repository.owner}/${issue.repository.name}/issues/${issue.number}`.toLowerCase();
    const address = new URL(url);
    return origins.includes(address.origin) && address.pathname.replace(/\/$/, "").toLowerCase() === path && address.search === "" && address.hash === "" ? url : null;
  };
}

/**
 * Search words as GitHub's search reads them literally: each one quoted, with
 * the quotes and backslashes in it dropped, so nothing a person types becomes
 * a qualifier (`repo:`, `is:`), an operator (`OR`, `NOT`), or ends the quote.
 */
export function githubSearchWords(query: string): string {
  return query
    .split(/\s+/)
    .map((word) => word.replace(/["\\]/g, ""))
    .filter((word) => word !== "")
    .slice(0, MAX_SEARCH_WORDS)
    .map((word) => `"${word}"`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Templates: Markdown templates and issue forms in `.github/ISSUE_TEMPLATE`.

/** A template file as Critiqs reads it: its name, the labels it adds, and its text as Markdown with a heading per section. */
export interface GithubTemplateFile {
  name: string;
  labels: string[];
  body: string;
}

function labelList(value: unknown): string[] {
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return list.filter((label): label is string => typeof label === "string").map((label) => label.trim()).filter((label) => label !== "");
}

/**
 * Reads a template file. A Markdown template's YAML front matter names it
 * and its labels; its text is the rest. An issue form (YAML) becomes the
 * Markdown GitHub writes when the form is submitted: each field's label as a
 * `###` heading, a field's preset value under it, a checkbox per option; its
 * Markdown blocks, which aren't submitted, are left out. What a form means
 * as text stays text: labels and one-line answers (`input`) are escaped, and a
 * field GitHub renders as code (`render`) is a code block in that language.
 * A textarea's preset text and a checkbox's label are Markdown in GitHub's
 * forms, and stay Markdown here, as a Markdown template's text does. A form's
 * validations (such as `required`) aren't part of what GitHub writes, so the
 * draft doesn't carry them. Null when the file isn't a template GitHub would
 * offer, such as one without a name.
 */
export function parseGithubTemplate(fileName: string, source: string): GithubTemplateFile | null {
  if (/\.md$/i.test(fileName)) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (front === null) return null;
    const meta = safeYaml(front[1]!);
    if (!isRecord(meta) || !text(meta.name)) return null;
    return { name: meta.name.trim(), labels: labelList(meta.labels), body: source.slice(front[0].length).replace(/^\s*\n/, "") };
  }
  const form = safeYaml(source);
  if (!isRecord(form) || !text(form.name) || !Array.isArray(form.body)) return null;
  const sections: string[] = [];
  for (const element of form.body) {
    if (!isRecord(element) || !isRecord(element.attributes) || element.type === "markdown") continue;
    const { attributes } = element;
    if (!text(attributes.label)) continue;
    const heading = `### ${markdownText(attributes.label)}`;
    if (element.type === "checkboxes" && Array.isArray(attributes.options)) {
      const boxes = attributes.options.flatMap((option) => (isRecord(option) && text(option.label) ? [`- [ ] ${option.label.replace(/\s+/g, " ").trim()}`] : []));
      sections.push([heading, "", ...boxes].join("\n"));
      continue;
    }
    const preset = (element.type === "textarea" || element.type === "input") && typeof attributes.value === "string" ? attributes.value.trim() : "";
    const value =
      preset === ""
        ? ""
        : element.type === "textarea" && typeof attributes.render === "string"
          ? markdownCodeBlock(preset, attributes.render.trim())
          : element.type === "input"
            ? markdownText(preset)
            : preset;
    sections.push(value === "" ? heading : `${heading}\n\n${value}`);
  }
  return { name: form.name.trim(), labels: labelList(form.labels), body: sections.length === 0 ? "" : `${sections.join("\n\n")}\n` };
}

function safeYaml(source: string): unknown {
  try {
    // Plain data only: no custom tags, and a bounded number of aliases.
    return parseYaml(source, { maxAliasCount: 20, prettyErrors: false });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The adapter.

/** GitHub's adapter: issues in a repository, the thread's link in the issue's text or a comment, no uploaded capture (GitHub has no API for it). */
export function githubAdapter(endpoint: TrackerEndpointOptions = {}): TrackerAdapter {
  const to = endpointOf(endpoint, GITHUB_API_URL);

  const issueByNode = async (token: TrackerToken, id: string): Promise<CreatedTicket | null> => {
    if (!/^[A-Za-z0-9_=-]{1,100}$/.test(id)) return null;
    const data = await graphql(to, token, NODE, { id });
    return parseNodeIssue(data.node);
  };

  /** Adds a comment to the issue with this node ID; refused when GitHub has no such issue for the person. */
  const addComment = async (token: TrackerToken, id: string, body: TicketMarkdown): Promise<void> => {
    if (!/^[A-Za-z0-9_=-]{1,100}$/.test(id)) throw gone();
    const added = (await graphql(to, token, ADD_COMMENT, { id, body })).addComment;
    if (!isRecord(added)) throw gone();
  };

  const issueByNumber = async (token: TrackerToken, repository: { owner: string; name: string }, number: number): Promise<CreatedTicket | null> => {
    const answer = await send(to, token, repoPath(repository, "issues", number));
    if (answer.response.status === 404 || answer.response.status === 410) return null;
    requireOk(answer, token);
    const issue = parseRestIssue(answer.body, repository);
    // Another number than the one asked for isn't this issue.
    return issue === null || issue.key !== `${repository.name}#${number}` ? null : issue;
  };

  /** The repositories the person can create issues in: where the app is installed and they have access, or what their token reaches. */
  const repositories = async (token: TrackerToken): Promise<TicketDestination[]> => {
    const listed: unknown[] = [];
    const repositoriesOf = (body: unknown) => (isRecord(body) && Array.isArray(body.repositories) ? body.repositories : null);
    if (token.method === "oauth") {
      const body = await rest(to, token, "user/installations", { query: { per_page: 100 } });
      const installations = isRecord(body) && Array.isArray(body.installations) ? body.installations : null;
      if (installations === null) throw unexpected("no installations");
      for (const installation of installations.slice(0, MAX_INSTALLATIONS)) {
        if (!isRecord(installation) || typeof installation.id !== "number") continue;
        const path = `user/installations/${installation.id}/repositories`;
        listed.push(...(await pages((page) => rest(to, token, path, { query: { per_page: 100, page } }), repositoriesOf, MAX_REPOSITORY_PAGES)));
      }
    } else {
      listed.push(...(await pages((page) => rest(to, token, "user/repos", { query: { per_page: 100, page, sort: "full_name" } }), (body) => (Array.isArray(body) ? body : null), MAX_REPOSITORY_PAGES)));
    }
    const seen = new Map<string, TicketDestination>();
    for (const repository of listed) {
      const names = nameOf(repository);
      // Repositories with issues turned off, or archived (read-only), take no new issues.
      if (names === null || !isRecord(repository) || repository.has_issues === false || repository.archived === true) continue;
      seen.set(names.fullName.toLowerCase(), { id: names.fullName, name: names.fullName, key: null });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  const login = async (token: TrackerToken): Promise<string> => {
    const user = await rest(to, token, "user");
    if (!isRecord(user) || !text(user.login)) throw unexpected("no account");
    return user.login;
  };

  /** A repository's template files, by name, in GitHub's order; none when it has no template folder. */
  const templateFiles = async (token: TrackerToken, repository: { owner: string; name: string }): Promise<string[]> => {
    const answer = await send(to, token, repoPath(repository, "contents", ...TEMPLATE_FOLDER.split("/")));
    if (answer.response.status === 404) return [];
    requireOk(answer, token);
    if (!Array.isArray(answer.body)) return [];
    return answer.body
      .filter((entry): entry is { type: string; name: string } => isRecord(entry) && entry.type === "file" && text(entry.name))
      .map((entry) => entry.name)
      .filter((name) => TEMPLATE_FILE.test(name) && !CONFIG_FILE.test(name))
      .slice(0, MAX_TEMPLATES);
  };

  const readTemplate = async (token: TrackerToken, repository: { owner: string; name: string }, fileName: string): Promise<GithubTemplateFile | null> => {
    const answer = await send(to, token, repoPath(repository, "contents", ...TEMPLATE_FOLDER.split("/"), fileName), { raw: true });
    if (answer.response.status === 404) return null;
    requireOk(answer, token);
    return typeof answer.body === "string" ? parseGithubTemplate(fileName, answer.body) : null;
  };

  const templateGroup = async (token: TrackerToken, destination: TicketDestination): Promise<TrackerTemplateGroup> => {
    const repository = repositoryOf(destination.id);
    const templates: { id: string; name: string }[] = [];
    for (const file of await templateFiles(token, repository)) {
      const template = await readTemplate(token, repository, file);
      if (template !== null) templates.push({ id: `${destination.id}:${file}`, name: template.name });
    }
    return { destination, templates };
  };

  const labels = async (token: TrackerToken, destinationId: string): Promise<TrackerLabel[]> => {
    const repository = repositoryOf(destinationId);
    const list = await pages((page) => rest(to, token, repoPath(repository, "labels"), { query: { per_page: 100, page } }), (body) => (Array.isArray(body) ? body : null), 3);
    // GitHub takes labels by name; it has no single-select label groups.
    return list.filter((label): label is { name: string } => isRecord(label) && text(label.name)).map((label) => ({ id: label.name, name: label.name, exclusiveGroup: null }));
  };

  return checkedAdapter({
    verify: async (token) => {
      const user = await rest(to, token, "user");
      if (!isRecord(user) || typeof user.id !== "number" || !text(user.login)) throw unexpected("no account");
      // Only a sign-in's emails are checked; a pasted token needn't be able to read them.
      let emails: string[] = [];
      if (token.method === "oauth") {
        const answer = await send(to, token, "user/emails", { query: { per_page: 100 } });
        // Without the app's "Email addresses" permission there are none to compare, so nothing is saved.
        if (answer.response.ok && Array.isArray(answer.body)) {
          emails = answer.body
            .filter((entry): entry is { email: string; primary?: unknown } => isRecord(entry) && entry.verified === true && text(entry.email))
            .sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
            .map((entry) => entry.email);
        } else if (!answer.response.ok && answer.response.status !== 403 && answer.response.status !== 404) {
          requireOk(answer, token);
        }
      }
      return { accountId: String(user.id), accountName: user.login, emails, site: null } satisfies TrackerIdentity;
    },
    destinations: repositories,
    search: async (token, query, destinationId) => {
      const term = query.trim();
      // An issue's address, or its key.
      const address = /^https?:\/\//.test(term) ? (() => { try { return issueAddress(term); } catch { return null; } })() : null;
      const key = KEY.exec(term);
      let destinations: TicketDestination[] | null = null;
      // A destination the person names is a repository's full name, or nothing is searched: it becomes a `repo:` qualifier.
      if (destinationId !== undefined) repositoryOf(destinationId);
      const all = async () => (destinations ??= destinationId === undefined ? await repositories(token) : [{ id: destinationId, name: destinationId, key: null }]);
      if (address !== null) {
        const found = await issueByNumber(token, address.repository, address.number);
        return found === null ? [] : [found];
      }
      if (key !== null) {
        const [, owner, name, number] = key;
        const candidates = (await all()).filter((destination) => {
          const repository = repositoryOf(destination.id);
          if (name === undefined) return destinationId !== undefined;
          return repository.name.toLowerCase() === name.toLowerCase() && (owner === undefined || repository.owner.toLowerCase() === owner.toLowerCase());
        });
        if (owner !== undefined && name !== undefined && candidates.length === 0) candidates.push({ id: `${owner}/${name}`, name: `${owner}/${name}`, key: null });
        const found: CreatedTicket[] = [];
        for (const destination of candidates.slice(0, 5)) {
          const issue = await issueByNumber(token, repositoryOf(destination.id), Number(number));
          if (issue !== null) found.push(issue);
        }
        if (found.length > 0) return found;
      }
      const words = githubSearchWords(term);
      if (words === "") return [];
      const scope = (await all()).slice(0, MAX_SEARCH_REPOSITORIES);
      if (scope.length === 0) return [];
      // Only the person's own repositories; GitHub requires is:issue for an app's user access token.
      const q = `${words} is:issue ${scope.map((destination) => `repo:${destination.id}`).join(" ")}`;
      const body = await rest(to, token, "search/issues", { query: { q, per_page: 10 } });
      const items = isRecord(body) && Array.isArray(body.items) ? body.items : null;
      if (items === null) throw unexpected("no issues");
      const allowed = new Set(scope.map((destination) => destination.id.toLowerCase()));
      return items.flatMap((item) => {
        if (!isRecord(item) || !text(item.repository_url)) return [];
        const fullName = item.repository_url.split("/").slice(-2).join("/");
        if (!allowed.has(fullName.toLowerCase()) || !REPOSITORY.test(fullName)) return [];
        const issue = parseRestIssue(item, repositoryOf(fullName));
        return issue === null ? [] : [issue];
      });
    },
    get: async (token, externalId) => {
      const issue = await issueByNode(token, externalId);
      if (issue === null) throw notFound();
      return issue;
    },
    create: async (token, input): Promise<CreateOutcome> => {
      let labelNames = input.labels;
      try {
        const repository = repositoryOf(input.destinationId);
        // A template's own labels, as GitHub adds them when a person picks it: only those the repository has.
        if (input.templateId !== null) {
          const template = TEMPLATE_ID.exec(input.templateId);
          const file = template === null || template[1]!.toLowerCase() !== input.destinationId.toLowerCase() ? null : await readTemplate(token, repository, template[2]!);
          if (file === null) return { status: "refused", error: new TrackerRefusal("invalid", "GitHub no longer has this template. Choose another, or Critiqs's standard format.") };
          if (file.labels.length > 0) {
            const known = new Map((await labels(token, input.destinationId)).map((label) => [label.name.toLowerCase(), label.name]));
            labelNames = [...new Set([...labelNames, ...file.labels.flatMap((name) => known.get(name.toLowerCase()) ?? [])])];
          }
        }
        // The mark goes first: an HTML comment there can't be swallowed by anything the text leaves open.
        const body = `${creationMark(input.creationId)}\n\n${input.body}`;
        const answer = await send(to, token, repoPath(repository, "issues"), {
          method: "POST",
          json: { title: input.title, body, ...(labelNames.length === 0 ? {} : { labels: labelNames }) },
        });
        if (answer.response.status === 410) return { status: "refused", error: new TrackerRefusal("invalid", "Issues are turned off in this repository. Choose another.") };
        if (answer.response.status === 404) return { status: "refused", error: new TrackerRefusal("invalid", "GitHub can't find this repository, or you can't create issues in it. Choose another.") };
        requireOk(answer, token);
        const ticket = parseRestIssue(answer.body, repository);
        // Made, but Critiqs can't read it: the next attempt finds it by its mark.
        return ticket === null ? { status: "unknown", error: unexpected("issue unreadable") } : { status: "created", ticket };
      } catch (error) {
        if (error instanceof TrackerRefusal) return { status: "refused", error };
        return { status: "unknown", error: error instanceof CritiqsError ? error : unexpected("no answer") };
      }
    },
    findCreated: async (token, created) => {
      const repository = repositoryOf(created.destinationId);
      const creator = await login(token);
      const mark = creationMark(created.creationId);
      // Issues changed since a minute before the creation was submitted, newest first: the one it made carries its mark.
      const since = new Date(Math.max(0, created.since - 60_000)).toISOString().replace(/\.\d{3}Z$/, "Z");
      for (let page = 1; page <= 3; page++) {
        const body = await rest(to, token, repoPath(repository, "issues"), {
          query: { state: "all", creator, since, sort: "created", direction: "desc", per_page: 100, page },
        });
        if (!Array.isArray(body)) throw unexpected("no issues");
        for (const item of body) {
          if (isRecord(item) && typeof item.body === "string" && item.body.includes(mark)) {
            const issue = parseRestIssue(item, repository);
            if (issue !== null) return issue;
          }
        }
        if (body.length < 100) break;
      }
      return null;
    },
    // Writes go to the issue by its node ID, never by a repository name and number, which a rename or transfer changes
    // and another repository may take: a ticket whose repository moved is still written to, and no other issue is.
    linkBack: async (token, ticket, link) => {
      const written = markdownLink("open the thread", link.url);
      // The address as Critiqs writes it in a link, `&` escaped, and as it is.
      const forms = [link.url, written.slice(written.indexOf("(<") + 2, -2)];
      const mentions = (value: unknown) => typeof value === "string" && forms.some((form) => value.includes(form));
      // The link is in the issue's text when Critiqs created it, or in a comment already: GitHub keeps one link to the thread.
      let after: string | null = null;
      for (let page = 0; page < 5; page++) {
        const data: Record<string, unknown> = await graphql(to, token, LINKS, { id: ticket.externalId, after });
        const node: unknown = data.node;
        if (!isRecord(node) || node.__typename !== "Issue" || node.id !== ticket.externalId) throw gone();
        const comments: Record<string, unknown> | null = isRecord(node.comments) ? node.comments : null;
        const nodes: unknown[] | null = comments !== null && Array.isArray(comments.nodes) ? comments.nodes : null;
        if (comments === null || nodes === null) throw unexpected("no comments");
        if ((page === 0 && mentions(node.body)) || nodes.some((comment: unknown) => isRecord(comment) && mentions(comment.body))) return;
        const info: unknown = comments.pageInfo;
        const next: string | null = isRecord(info) && info.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null;
        if (next === null) break;
        after = next;
      }
      await addComment(token, ticket.externalId, ticketLinkComment(link.title, { link: link.url, attribution: null }));
    },
    comment: async (token, ticket, body) => await addComment(token, ticket.externalId, body),
    status: async (token, ticket) => {
      const issue = await issueByNode(token, ticket.externalId);
      if (issue === null) throw notFound();
      // Where it is now: a renamed or transferred repository keeps the issue's node ID and gives it a new name and number.
      const place = { key: issue.key, url: issue.url, title: issue.title, site: issue.site };
      return { externalId: issue.externalId, status: issue.status, asOf: issue.asOf, place };
    },
    templates: async (token, destinationId) => {
      const destinations = destinationId === undefined ? (await repositories(token)).slice(0, MAX_TEMPLATE_REPOSITORIES) : [{ id: destinationId, name: destinationId, key: null }];
      const groups: TrackerTemplateGroup[] = [];
      for (const destination of destinations) {
        const group = await templateGroup(token, destination);
        if (group.templates.length > 0) groups.push(group);
      }
      return groups.sort((a, b) => a.destination.name.localeCompare(b.destination.name));
    },
    template: async (token, templateId): Promise<TrackerTemplate | null> => {
      const match = TEMPLATE_ID.exec(templateId);
      if (match === null) return null;
      const [, destinationId, fileName] = match as unknown as [string, string, string];
      if (!TEMPLATE_FILE.test(fileName) || CONFIG_FILE.test(fileName)) return null;
      const file = await readTemplate(token, repositoryOf(destinationId), fileName);
      return file === null ? null : { id: templateId, name: file.name, destinationId, body: file.body };
    },
    labels,
  }, githubPlace(trackerWebOrigins(endpoint, GITHUB_APP_URL)));
}

// ---------------------------------------------------------------------------
// Sign-in: the GitHub App's web flow, with PKCE.

/**
 * GitHub's sign-in page for the operator's GitHub App. A GitHub App asks for
 * no scopes: what its tokens may do is the app's permissions, as installed.
 */
export function githubAuthorizeUrl(appUrl: string, input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL("/login/oauth/authorize", appUrl);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    allow_signup: "false",
  }).toString();
  return url.toString();
}

/** Where an organization or person installs the operator's GitHub App, choosing its repositories. */
export function githubInstallUrl(appUrl: string, slug: string): string {
  return new URL(`/apps/${encodeURIComponent(slug)}/installations/new`, appUrl).toString();
}

/** Exchanges a sign-in's code for tokens. */
export async function exchangeGithubCode(
  endpoint: TrackerEndpointOptions,
  app: GithubApp,
  input: { code: string; redirectUri: string; verifier: string },
  now: number,
): Promise<SignInTokens> {
  return await tokenRequest(
    endpointOf(endpoint, GITHUB_APP_URL),
    { client_id: app.clientId, client_secret: app.clientSecret, code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier },
    now,
    "GitHub didn't accept this sign-in. Close this window and connect GitHub again.",
  );
}

/**
 * Trades a refresh token for new tokens. GitHub rotates refresh tokens: the
 * one used here, and the access token before it, stop working. `signal`
 * calls the request off, answer included.
 */
export async function refreshGithubToken(endpoint: TrackerEndpointOptions, app: GithubApp, refreshToken: string, now: number, signal?: AbortSignal): Promise<SignInTokens> {
  return await tokenRequest(
    endpointOf(endpoint, GITHUB_APP_URL),
    { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    now,
    "Your GitHub sign-in has ended. Connect GitHub again in Your trackers.",
    signal,
  );
}

/**
 * Ends a person's sign-in at GitHub: deletes the app's grant for them
 * (https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization),
 * which ends every token the app holds for them, with the app's client ID
 * and secret by Basic authentication and one of their access tokens, which
 * GitHub requires to be valid. `deleted` when GitHub answered 204;
 * `refused` when it turned the token down (422, as for one that expired);
 * `unreachable` when there was no answer, or another one.
 */
export async function deleteGithubGrant(endpoint: TrackerEndpointOptions, app: GithubApp, accessToken: string): Promise<"deleted" | "refused" | "unreachable"> {
  const to = endpointOf(endpoint, GITHUB_API_URL);
  try {
    const response = await to.fetch(`${to.baseUrl}/applications/${encodeURIComponent(app.clientId)}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "Critiqs",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 204 ? "deleted" : response.status === 422 ? "refused" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function tokenRequest(to: TrackerEndpoint, form: Record<string, string>, now: number, refused: string, signal?: AbortSignal): Promise<SignInTokens> {
  let response: Response;
  try {
    response = await to.fetch(`${to.baseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "Critiqs" },
      body: new URLSearchParams(form).toString(),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw unreachable();
  }
  const body: unknown = await response.json().catch(() => null);
  // GitHub names a refusal in the answer's `error`, whatever its status.
  if (isRecord(body) && typeof body.error === "string") {
    if (body.error === "incorrect_client_credentials") {
      fail("unavailable", "GitHub doesn't recognize this deployment's GitHub App. Its operator must check CRITIQS_GITHUB_CLIENT_ID and CRITIQS_GITHUB_CLIENT_SECRET.");
    }
    if (body.error === "redirect_uri_mismatch") {
      fail("unavailable", "This deployment's GitHub App doesn't list its callback address. Its operator must add it to the app's settings.");
    }
    fail("invalid", refused);
  }
  if (response.status === 400 || response.status === 401) fail("invalid", refused);
  if (!response.ok || !isRecord(body) || !text(body.access_token)) throw unexpected(`status ${response.status}`);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return {
    access: body.access_token,
    refresh: text(body.refresh_token) ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
  };
}

// ---------------------------------------------------------------------------
// Webhooks.

/** What a call to the GitHub webhook route means. */
export type GithubWebhook =
  /** Not from GitHub: a wrong, missing, or malformed signature, or a body that isn't JSON. Nothing in it is used. */
  | { status: "refused"; reason: string }
  /** From GitHub, but nothing Critiqs keeps: another event, such as `ping`, or an issue event without an issue it can read. */
  | { status: "ignored" }
  /** An issue's status, for every thread that links it. */
  | { status: "update"; update: TicketStatusUpdate };

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/**
 * Where a delivery says an issue is: its key, GitHub's page for it, worked out
 * from the repository and number the signature covers (never an address the
 * delivery names), and its title.
 */
function githubDeliveryPlace(repository: string, number: number, title: string): TicketPlaceNow {
  const [owner, name] = repository.split("/") as [string, string];
  return { key: `${name}#${number}`, url: `${GITHUB_APP_URL}/${owner}/${name}/issues/${number}`, title, site: githubSite(repository) };
}

/** How old the issue's update in a delivery may be, by GitHub's own time in it, for the delivery to be used: GitHub delivers within seconds, and lets an operator send one again for a few days. */
export const GITHUB_DELIVERY_MAX_AGE_MS = 24 * 60 * 60_000;
/** How far ahead of Critiqs's clock the issue's update time may be. */
const GITHUB_CLOCK_LEEWAY_MS = 5 * 60_000;

/**
 * Reads a call to the GitHub webhook route. GitHub signs each delivery's raw
 * body with the webhook's secret (`X-Hub-Signature-256: sha256=<hex
 * HMAC-SHA256>`); the signature is checked over the body's exact bytes, in
 * constant time, before anything in the body is decoded or read. What is
 * used is only what the signature covers: the issue, its repository, and its
 * own `updated_at`, which the status is saved as of, so an older or repeated
 * delivery changes nothing. GitHub's deliveries carry no time of sending, so
 * that time also bounds how long a signed delivery is good for: an update
 * more than `GITHUB_DELIVERY_MAX_AGE_MS` old, or one without the time, is
 * ignored. A deleted issue is Deleted, which counts as canceled, as of its
 * last update, whenever that was: GitHub never brings a deleted issue's ID
 * back, so a deletion delivered again only says what is still true. A
 * deletion without that time is ignored, never placed at its arrival.
 */
export async function readGithubWebhook(secret: string, rawBody: Uint8Array<ArrayBuffer>, signature: string | null, event: string | null, now: number): Promise<GithubWebhook> {
  const given = signature === null || !signature.trim().startsWith("sha256=") ? null : hexBytes(signature.trim().slice("sha256=".length));
  if (given === null) return { status: "refused", reason: "missing or malformed signature" };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, given, rawBody))) return { status: "refused", reason: "wrong signature" };
  let body: unknown;
  try {
    // Only now is the body text: strict UTF-8, so bytes that aren't are refused rather than replaced.
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return { status: "refused", reason: "unreadable body" };
  }
  if (event !== "issues" || !isRecord(body) || !isRecord(body.issue)) return { status: "ignored" };
  const { issue } = body;
  if (isRecord(issue.pull_request) || !text(issue.node_id) || typeof issue.state !== "string") return { status: "ignored" };
  // The repository the delivery is about: only links to issues in it are updated.
  const fullName = isRecord(body.repository) && typeof body.repository.full_name === "string" ? body.repository.full_name : null;
  if (fullName === null || !REPOSITORY.test(fullName)) return { status: "ignored" };
  const asOf = timeOf(issue.updated_at);
  // Without the issue's own time, or with one ahead of now, a delivery can't be placed in order.
  if (asOf === null || asOf > now + GITHUB_CLOCK_LEEWAY_MS) return { status: "ignored" };
  /**
   * An update about the issue with this node ID, where it is (`repository`,
   * `number`): its node ID is the same in any repository it moves to, so
   * links to it under an old name take the update and follow it there.
   */
  const update = (status: TicketStatus, at: { repository: string; number: unknown; title: unknown; asOf: number }, deleted = false): GithubWebhook => {
    const place = typeof at.number === "number" && Number.isSafeInteger(at.number) && at.number > 0 ? githubDeliveryPlace(at.repository, at.number, typeof at.title === "string" ? at.title : "") : null;
    return {
      status: "update",
      update: { tracker: "github", externalId: issue.node_id as string, site: githubSite(at.repository), status, asOf: at.asOf, deleted, idAcrossSites: true, ...(place === null ? {} : { place }) },
    };
  };
  const here = { repository: fullName, number: issue.number, title: issue.title, asOf };
  switch (body.action) {
    case "deleted":
      return update({ ...GITHUB_DELETED_STATUS }, here, true);
    // The issue moved to another repository. Only when it is still the same node there does a link follow it; a new
    // node is another issue, and the check when a thread opens finds the old one gone.
    case "transferred": {
      const changes = isRecord(body.changes) ? body.changes : null;
      const moved = changes !== null && isRecord(changes.new_issue) ? changes.new_issue : null;
      const target = changes !== null && isRecord(changes.new_repository) && typeof changes.new_repository.full_name === "string" ? changes.new_repository.full_name : null;
      const movedAt = moved === null ? null : timeOf(moved.updated_at);
      if (moved === null || moved.node_id !== issue.node_id || target === null || !REPOSITORY.test(target) || typeof moved.state !== "string" || movedAt === null || movedAt > now + GITHUB_CLOCK_LEEWAY_MS) return { status: "ignored" };
      if (now - movedAt > GITHUB_DELIVERY_MAX_AGE_MS) return { status: "ignored" };
      return update(githubStatus(moved.state, typeof moved.state_reason === "string" ? moved.state_reason : null), { repository: target, number: moved.number, title: moved.title, asOf: movedAt });
    }
    default:
      return now - asOf > GITHUB_DELIVERY_MAX_AGE_MS ? { status: "ignored" } : update(githubStatus(issue.state, typeof issue.state_reason === "string" ? issue.state_reason : null), here);
  }
}
