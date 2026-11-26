import { type TicketDestination, type TicketField, type TicketFieldValue, type TicketStatus, type TicketStatusCategory, TRACKER_LIMITS, webAddress } from "@critiqs/core";
import { CritiqsError, fail } from "../../errors.ts";
import { type AdfDocument, markdownToAdf, plainAdf } from "./adf.ts";
import {
  checkedAdapter,
  type CreatedTicket,
  type CreateOutcome,
  type SignInTokens,
  type TicketImage,
  type TrackerAdapter,
  type TrackerEndpoint,
  type TrackerEndpointOptions,
  type TrackerIdentity,
  type TrackerLabel,
  TrackerRefusal,
  type TicketPlace,
  type TrackerSite,
  type TrackerToken,
  trackerEndpoint,
  trackerText,
} from "./index.ts";

// Jira Cloud, through its REST API v3
// (https://developer.atlassian.com/cloud/jira/platform/rest/v3/). Each
// person's token is for one Jira site: a sign-in (Atlassian OAuth 2.0, 3LO)
// reaches the site through Atlassian's API gateway by its cloud ID; a pasted
// API token reaches the site's own address with Basic authentication (the
// person's email and the token). Jira's IDs are unique only within a site, so
// Critiqs's IDs for Jira issues and accounts start with the site's cloud ID:
// `<cloudId>/<issueId>`, `<cloudId>/<accountId>`. Jira takes text as
// Atlassian Document Format, converted from Critiqs's Markdown.

/** Atlassian's API gateway: sign-in's calls to a site (`/ex/jira/<cloudId>`), and who signed in (`/me`). */
export const JIRA_API_URL = "https://api.atlassian.com";
/** Where people sign in to Atlassian and allow Critiqs, and where sign-in's tokens come from. */
export const JIRA_AUTH_URL = "https://auth.atlassian.com";
/** Where a person creates an Atlassian API token. */
export const JIRA_API_TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** An operator's Atlassian OAuth 2.0 (3LO) app. Its client secret also signs the webhooks Jira sends it. */
export interface JiraApp {
  clientId: string;
  clientSecret: string;
}

/** The issue property each ticket Critiqs creates carries, naming its creation, so a retry finds it. */
export const JIRA_CREATION_PROPERTY = "critiqs-creation";
/** What Critiqs reads of an issue. */
const ISSUE_FIELDS = ["summary", "status", "updated", "project"];
/** Required fields Critiqs fills itself, or Jira does. */
const FILLED_FIELDS = new Set(["project", "issuetype", "summary", "description", "reporter", "labels", "attachment", "issuelinks"]);
/** A Jira issue key, such as `ENG-123`: the project's key and the issue's number. */
const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-(\d{1,9})$/;
/** The most projects listed as destinations, a hundred per page. */
const MAX_PROJECT_PAGES = 3;
/** How many of the person's most recent issues a retry looks through for the one its creation made. */
const FIND_CREATED_LIMIT = 50;

/** A Jira Cloud site's host: Atlassian's own cloud hosts only. */
const JIRA_SITE_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.(?:atlassian\.net|jira\.com)$/;

/**
 * A Jira Cloud site's host from what a person typed: `acme`,
 * `acme.atlassian.net`, or any address on it. Only Atlassian's own cloud
 * hosts, so Critiqs never sends a token, or a request, anywhere else.
 */
export function parseJiraSite(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === "") fail("invalid", "Enter your Jira site's address, such as your-team.atlassian.net.");
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") host = "";
      else host = url.hostname;
    } catch {
      host = "";
    }
  } else host = raw.split("/")[0]!;
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(host)) host = `${host}.atlassian.net`;
  if (!JIRA_SITE_HOST.test(host)) {
    fail("invalid", "That isn't a Jira Cloud site. Enter its address, such as your-team.atlassian.net.");
  }
  return host;
}

/**
 * Where Jira's adapter sends requests: Atlassian's API gateway (`api`), and
 * each site's own address, which a pasted API token is sent to (`site`);
 * every one through Critiqs's tracker endpoint, so the token goes only to
 * the address it is for.
 */
interface JiraEndpoints {
  api: TrackerEndpoint;
  site(host: string): TrackerEndpoint;
}

function endpointsOf(options: TrackerEndpointOptions): JiraEndpoints {
  const api = trackerEndpoint(options, JIRA_API_URL);
  const sites = new Map<string, TrackerEndpoint>();
  return {
    api,
    site: (host) => {
      // Checked again where it is used: only Atlassian's cloud hosts, so no other address gets the token.
      if (!JIRA_SITE_HOST.test(host)) throw new CritiqsError("invalid", "Connect Jira again in Your trackers: Critiqs doesn't know which Jira site to use.");
      let endpoint = sites.get(host);
      if (endpoint === undefined) {
        const baseUrl = options.sitesUrl ? `${options.sitesUrl.replace(/\/$/, "")}/${host}` : `https://${host}`;
        endpoint = trackerEndpoint({ ...options, baseUrl }, baseUrl);
        sites.set(host, endpoint);
      }
      return endpoint;
    },
  };
}

/** The site a token is for; refused for a token without one, which only a bug could make. */
function siteOf(token: TrackerToken): TrackerSite {
  if (token.site == null || !JIRA_SITE_HOST.test(token.site.name)) throw new CritiqsError("invalid", "Connect Jira again in Your trackers: Critiqs doesn't know which Jira site to use.");
  return token.site;
}

/** Where a token's requests to its site go: the API gateway for a sign-in, the site's own address for an API token. */
function siteBase(to: JiraEndpoints, token: TrackerToken): { endpoint: TrackerEndpoint; base: string } {
  const site = siteOf(token);
  if (token.method === "oauth") return { endpoint: to.api, base: `${to.api.baseUrl}/ex/jira/${encodeURIComponent(site.id)}` };
  const endpoint = to.site(site.name);
  return { endpoint, base: endpoint.baseUrl };
}

/** Where people open an issue: on the site's own address; null when that isn't a web address. */
const browseUrl = (site: TrackerSite, key: string) => webAddress(`https://${site.name}/browse/${encodeURIComponent(key)}`);

/** Critiqs's ID for a Jira issue or account: the site's cloud ID, then Jira's ID. */
export const jiraId = (site: { id: string }, id: string) => `${site.id}/${id}`;

/** Jira's own ID from Critiqs's, refused when it is on another site than the token's. */
function localId(token: TrackerToken, externalId: string): string {
  const site = siteOf(token);
  const slash = externalId.indexOf("/");
  if (slash === -1 || externalId.slice(0, slash) !== site.id) fail("not-found", `This Jira issue is on another Jira site than the one you connected (${site.name}).`);
  return externalId.slice(slash + 1);
}

function authorization(token: TrackerToken): string {
  if (token.method === "oauth") return `Bearer ${token.value}`;
  // A pasted token is stored as `email:token`, as Basic authentication sends it.
  return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(token.value)))}`;
}

const unreachable = () => new CritiqsError("unavailable", "Critiqs couldn't reach Jira. Try again in a moment.");
const unexpected = (what: string) => new CritiqsError("unavailable", `Jira's answer wasn't what Critiqs expected (${what}). Try again in a moment.`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

interface Request {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
}

/** Jira's own words for a refusal, as one sentence: its `errorMessages` and field `errors`. */
function refusalText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter(text) : [];
  const fields = isRecord(body.errors) ? Object.entries(body.errors).flatMap(([field, message]) => (text(message) ? [`${field}: ${message}`] : [])) : [];
  const line = [...messages, ...fields].join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
  return line === "" ? null : /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * Sends a request to the token's Jira site (or, with `absolute`, to that
 * address) and returns its JSON, or null for an empty answer. Throws what a
 * refusal means: a TrackerRefusal for one Jira answered with, so it did
 * nothing; a not-found CritiqsError for an issue the person can't see; or a
 * failure that may have done what was asked.
 */
async function call(to: JiraEndpoints, token: TrackerToken, path: string, request: Request = {}, gateway = false): Promise<unknown> {
  const { endpoint, base } = gateway ? { endpoint: to.api, base: to.api.baseUrl } : siteBase(to, token);
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
  const headers: Record<string, string> = { Accept: "application/json", Authorization: authorization(token) };
  let body: BodyInit | undefined;
  if (request.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.json);
  } else if (request.form !== undefined) {
    // Jira refuses uploads without it, as protection against cross-site requests.
    headers["X-Atlassian-Token"] = "no-check";
    body = request.form;
  }
  let response: Response;
  try {
    response = await endpoint.fetch(url, { method: request.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
  } catch {
    throw unreachable();
  }
  const raw = await response.text().catch(() => null);
  let parsed: unknown = null;
  try {
    parsed = raw === null || raw === "" ? null : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (response.status === 401) {
    throw new TrackerRefusal(
      "invalid",
      token.method === "oauth"
        ? "Jira no longer accepts Critiqs's sign-in. Connect Jira again in Your trackers."
        : "Jira didn't accept this email and API token for this site. Check the site, your email, and that you copied all of the token.",
    );
  }
  if (response.status === 429) throw new TrackerRefusal("limit", "Jira is limiting requests right now. Try again in a minute.");
  if (response.status === 404) fail("not-found", "Jira can't find this issue, or you can't see it.");
  if (response.status === 403) throw new TrackerRefusal("forbidden", `Jira turned this down: ${refusalText(parsed) ?? "you don't have permission."}`);
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    throw new TrackerRefusal("invalid", `Jira turned this down: ${refusalText(parsed) ?? `status ${response.status}.`}`);
  }
  if (!response.ok || parsed === undefined) throw unexpected(`status ${response.status}`);
  return parsed;
}

/** Jira's status categories, as Critiqs's. Jira has no canceled category: work closed as won't do is done there too. */
export function jiraStatusCategory(key: string): TicketStatusCategory {
  switch (key) {
    case "new":
      return "open";
    case "indeterminate":
      return "started";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

function parseStatus(value: unknown): TicketStatus {
  if (!isRecord(value) || !text(value.name)) return { label: "Unknown", category: "unknown" };
  const category = isRecord(value.statusCategory) && typeof value.statusCategory.key === "string" ? jiraStatusCategory(value.statusCategory.key) : "unknown";
  return { label: value.name, category };
}

/** A time Jira sent (ISO 8601, its offset written `+0000`), in milliseconds; null when it isn't one. */
export function jiraTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(time) ? time : null;
}

/** An issue as Jira sent it, on the token's site; null when it isn't one. */
function parseIssue(site: TrackerSite, value: unknown): CreatedTicket | null {
  if (!isRecord(value) || !text(value.id) || !text(value.key) || !isRecord(value.fields)) return null;
  const { fields } = value;
  const project = isRecord(fields.project) && text(fields.project.id) ? fields.project.id : null;
  const url = browseUrl(site, value.key);
  if (url === null) return null;
  return {
    tracker: "jira",
    externalId: jiraId(site, value.id),
    key: value.key,
    url,
    title: typeof fields.summary === "string" ? fields.summary : "",
    status: parseStatus(fields.status),
    site: site.id,
    asOf: jiraTime(fields.updated),
    ...(project === null ? {} : { webhookScope: project }),
  };
}

/**
 * A JQL string: in double quotes, with backslashes and quotes escaped and
 * line breaks made spaces, so what a person typed can only ever be a value.
 */
export function jqlString(value: string): string {
  return `"${value.replace(/[\r\n\t]+/g, " ").replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Words for JQL's text search (`text ~`): the characters its search syntax
 * reads (`+ - & | ! ( ) { } [ ] ^ ~ * ? \ : " /`) made spaces, since Jira
 * ignores punctuation in text search anyway, then quoted as a JQL string.
 */
export function jqlText(value: string): string {
  return jqlString(value.replace(/[+\-&|!(){}[\]^~*?\\:"/'<>=]/g, " ").replace(/\s+/g, " ").trim());
}

/** A destination's ID: a Jira project and one of its issue types, which decides the issue's fields. */
function destinationOf(destinationId: string): { projectId: string; issueTypeId: string } {
  const [projectId, issueTypeId, ...rest] = destinationId.split("/");
  if (!projectId || !issueTypeId || rest.length > 0 || !/^\d{1,18}$/.test(projectId) || !/^\d{1,18}$/.test(issueTypeId)) {
    fail("invalid", "Choose a Jira project and issue type from the list.");
  }
  return { projectId, issueTypeId };
}

/** The address of a Jira site's description of itself, which names its cloud ID (https://support.atlassian.com/jira/kb/retrieve-my-atlassian-sites-cloud-id/). */
async function cloudIdOf(to: JiraEndpoints, host: string): Promise<string> {
  const site = to.site(host);
  let response: Response;
  try {
    response = await site.fetch(`${site.baseUrl}/_edge/tenant_info`, { headers: { Accept: "application/json" } });
  } catch {
    throw unreachable();
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404) fail("invalid", `There's no Jira Cloud site at ${host}. Check its address.`);
  if (!response.ok || !isRecord(body) || !text(body.cloudId)) throw unexpected(`no cloud ID for ${host}`);
  return body.cloudId;
}

/** A required field as the Create dialog asks for it, or null when Critiqs can't fill it. */
function askedField(field: Record<string, unknown>): TicketField | null {
  const schema = isRecord(field.schema) ? field.schema : {};
  const id = typeof field.fieldId === "string" ? field.fieldId : typeof field.key === "string" ? field.key : null;
  if (id === null || !text(field.name)) return null;
  const options = (Array.isArray(field.allowedValues) ? field.allowedValues : []).flatMap((value) => {
    if (!isRecord(value) || !text(value.id)) return [];
    const name = text(value.name) ? value.name : text(value.value) ? value.value : null;
    return name === null ? [] : [{ id: value.id, name }];
  });
  const custom = typeof schema.custom === "string" ? schema.custom : "";
  switch (schema.type) {
    case "string":
      return { id, name: field.name, kind: custom.endsWith(":textarea") || schema.system === "environment" ? "paragraph" : "text", options: [] };
    case "number":
      return { id, name: field.name, kind: "number", options: [] };
    case "date":
      return { id, name: field.name, kind: "date", options: [] };
    case "option":
    case "priority":
    case "version":
    case "component":
    case "securitylevel":
      return options.length === 0 ? null : { id, name: field.name, kind: "choice", options };
    case "array":
      return ["option", "version", "component"].includes(String(schema.items)) && options.length > 0 ? { id, name: field.name, kind: "choices", options } : null;
    default:
      return null;
  }
}

/** A required field's value as Jira takes it, by the field's kind. */
function fieldValue(field: TicketField, value: TicketFieldValue): unknown {
  const one = Array.isArray(value) ? (value[0] ?? "") : value;
  switch (field.kind) {
    case "text":
    case "date":
      return one;
    case "paragraph":
      return plainAdf(one);
    case "number": {
      const number = Number(one);
      if (one.trim() === "" || !Number.isFinite(number)) fail("invalid", `${field.name} must be a number.`);
      return number;
    }
    case "choice":
      return { id: one };
    case "choices":
      return (Array.isArray(value) ? value : [value]).map((id) => ({ id }));
  }
}

/** Jira's adapter: issues in a project as one of its issue types, the thread's link as a remote link, and the capture as an attachment. */
export function jiraAdapter(endpoint: TrackerEndpointOptions = {}): TrackerAdapter {
  const to = endpointsOf(endpoint);
  /** An issue as Jira answers for an ID or key; a key that moved with its issue to another project answers with its new key. */
  const read = async (token: TrackerToken, idOrKey: string) => {
    const found = parseIssue(siteOf(token), await call(to, token, `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`, { query: { fields: ISSUE_FIELDS.join(",") } }));
    if (found === null) throw unexpected("issue unreadable");
    return found;
  };
  /**
   * The issue with this ID, which Critiqs links and writes to: another issue
   * than the one asked for isn't this one, since its attachments and
   * comments would go there.
   */
  const issue = async (token: TrackerToken, id: string) => {
    if (!/^\d+$/.test(id)) throw unexpected("issue ID");
    const found = await read(token, id);
    if (found.externalId !== jiraId(siteOf(token), id)) throw unexpected("another issue");
    return found;
  };
  const search = async (token: TrackerToken, jql: string, maxResults: number, properties: string[] = []) => {
    const answer = await call(to, token, "/rest/api/3/search/jql", { method: "POST", json: { jql, maxResults, fields: ISSUE_FIELDS, ...(properties.length === 0 ? {} : { properties }) } });
    if (!isRecord(answer) || !Array.isArray(answer.issues)) throw unexpected("no issues");
    return answer.issues.filter(isRecord);
  };
  const createFields = async (token: TrackerToken, destinationId: string) => {
    const { projectId, issueTypeId } = destinationOf(destinationId);
    const answer = await call(to, token, `/rest/api/3/issue/createmeta/${projectId}/issuetypes/${issueTypeId}`, { query: { maxResults: "200" } });
    const fields = isRecord(answer) ? (Array.isArray(answer.fields) ? answer.fields : Array.isArray(answer.results) ? answer.results : null) : null;
    if (fields === null) throw unexpected("no fields");
    return fields.filter(isRecord);
  };
  const requiredFields = async (token: TrackerToken, destinationId: string) => {
    const fields: TicketField[] = [];
    const unsupported: string[] = [];
    for (const field of await createFields(token, destinationId)) {
      const id = typeof field.fieldId === "string" ? field.fieldId : typeof field.key === "string" ? field.key : "";
      if (field.required !== true || field.hasDefaultValue === true || FILLED_FIELDS.has(id)) continue;
      const asked = askedField(field);
      if (asked === null) unsupported.push(text(field.name) ? field.name : id);
      else fields.push(asked);
    }
    return { fields, unsupported };
  };
  return checkedAdapter({
    verify: async (token): Promise<TrackerIdentity> => {
      const site = siteOf(token);
      if (token.method === "oauth") {
        // Who signed in, with their email, from Atlassian's own account (`read:me`); the site is the one their sign-in chose.
        const me = await call(to, token, "/me", {}, true);
        if (!isRecord(me) || !text(me.account_id) || !text(me.name)) throw unexpected("no account");
        // Atlassian's documented answer says nothing of whether the email is verified; one that says it isn't is never compared.
        const verified = !("email_verified" in me) || me.email_verified === true;
        return { accountId: jiraId(site, me.account_id), accountName: me.name, emails: text(me.email) && verified ? [me.email] : [], site };
      }
      const cloudId = await cloudIdOf(to, site.name);
      const myself = await call(to, token, "/rest/api/3/myself");
      if (!isRecord(myself) || !text(myself.accountId) || !text(myself.displayName)) throw unexpected("no account");
      return {
        accountId: jiraId({ id: cloudId }, myself.accountId),
        accountName: myself.displayName,
        emails: text(myself.emailAddress) ? [myself.emailAddress] : [],
        site: { id: cloudId, name: site.name },
      };
    },
    destinations: async (token) => {
      const destinations: TicketDestination[] = [];
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const answer = await call(to, token, "/rest/api/3/project/search", {
          query: { action: "create", expand: "issueTypes", maxResults: "100", startAt: String(page * 100), orderBy: "name" },
        });
        if (!isRecord(answer) || !Array.isArray(answer.values)) throw unexpected("no projects");
        for (const project of answer.values) {
          if (!isRecord(project) || !text(project.id) || !text(project.name) || !Array.isArray(project.issueTypes)) continue;
          for (const type of project.issueTypes) {
            // A subtask needs a parent issue, which Critiqs doesn't ask for.
            if (!isRecord(type) || !text(type.id) || !text(type.name) || type.subtask === true) continue;
            destinations.push({ id: `${project.id}/${type.id}`, name: `${project.name} · ${type.name}`, key: text(project.key) ? project.key : null });
          }
        }
        if (answer.isLast !== false) break;
      }
      return destinations;
    },
    search: async (token, query, destinationId) => {
      const site = siteOf(token);
      const term = query.trim();
      // By key: Jira finds an issue moved to another project by its old key too, and answers with its key now. It is
      // offered under that key, and what is linked is the issue with its ID, read again by that ID.
      if (KEY_PATTERN.test(term)) {
        const found = await read(token, term.toUpperCase()).catch((error: unknown) => {
          if (error instanceof CritiqsError && error.code === "not-found") return null;
          throw error;
        });
        if (found !== null) return [found];
      }
      const words = jqlText(term);
      if (words === '""') return [];
      const project = destinationId === undefined ? "" : `project = ${jqlString(destinationOf(destinationId).projectId)} AND `;
      const issues = await search(token, `${project}text ~ ${words} ORDER BY updated DESC`, 10);
      return issues.flatMap((each) => {
        const parsed = parseIssue(site, each);
        return parsed === null ? [] : [parsed];
      });
    },
    get: async (token, externalId) => await issue(token, localId(token, externalId)),
    create: async (token, input): Promise<CreateOutcome> => {
      const site = siteOf(token);
      let fields: Record<string, unknown>;
      try {
        const { projectId, issueTypeId } = destinationOf(input.destinationId);
        const extra: Record<string, unknown> = {};
        if (Object.keys(input.fields ?? {}).length > 0) {
          const asked = new Map((await requiredFields(token, input.destinationId)).fields.map((field) => [field.id, field]));
          for (const [id, value] of Object.entries(input.fields ?? {})) {
            const field = asked.get(id);
            if (field !== undefined) extra[id] = fieldValue(field, value);
          }
        }
        fields = {
          project: { id: projectId },
          issuetype: { id: issueTypeId },
          summary: input.title,
          description: markdownToAdf(input.body),
          ...(input.labels.length === 0 ? {} : { labels: input.labels }),
          ...extra,
        };
      } catch (error) {
        return { status: "refused", error: error instanceof CritiqsError ? error : unexpected("fields") };
      }
      let created: unknown;
      try {
        created = await call(to, token, "/rest/api/3/issue", {
          method: "POST",
          // The creation's ID goes with the issue, so a retry whose answer was lost finds it (`findCreated`).
          json: { fields, properties: [{ key: JIRA_CREATION_PROPERTY, value: { id: input.creationId } }] },
        });
      } catch (error) {
        if (error instanceof TrackerRefusal) return { status: "refused", error };
        // A 404 answers before anything is made: the project or issue type isn't there for this person.
        if (error instanceof CritiqsError && error.code === "not-found") {
          return { status: "refused", error: new TrackerRefusal("invalid", "Jira can't find this project or issue type, or you can't create issues in it. Choose another.") };
        }
        return { status: "unknown", error: error instanceof CritiqsError ? error : unexpected("no answer") };
      }
      if (!isRecord(created) || !text(created.id) || !text(created.key)) return { status: "unknown", error: unexpected("issue unreadable") };
      // Jira answers a creation with the issue's ID and key only; the rest is read back.
      try {
        return { status: "created", ticket: await issue(token, created.id) };
      } catch (error) {
        return { status: "unknown", error: error instanceof CritiqsError ? error : unexpected("issue unreadable") };
      }
    },
    findCreated: async (token, created) => {
      const site = siteOf(token);
      const issues = await search(token, "creator = currentUser() ORDER BY created DESC", FIND_CREATED_LIMIT, [JIRA_CREATION_PROPERTY]);
      for (const each of issues) {
        const property = isRecord(each.properties) ? each.properties[JIRA_CREATION_PROPERTY] : null;
        if (isRecord(property) && property.id === created.creationId) return parseIssue(site, each);
      }
      return null;
    },
    linkBack: async (token, ticket, link) => {
      // One remote link per thread: Jira updates the link with the same global ID instead of adding another.
      await call(to, token, `/rest/api/3/issue/${encodeURIComponent(localId(token, ticket.externalId))}/remotelink`, {
        method: "POST",
        json: { globalId: await linkGlobalId(link.url), relationship: "Critiqs thread", object: { url: link.url, title: link.title.slice(0, 255), summary: "Comment thread in Critiqs" } },
      });
    },
    comment: async (token, ticket, body) => {
      await call(to, token, `/rest/api/3/issue/${encodeURIComponent(localId(token, ticket.externalId))}/comment`, { method: "POST", json: { body: markdownToAdf(body) } });
    },
    status: async (token, ticket) => {
      const found = await issue(token, localId(token, ticket.externalId));
      // Where it is now: an issue moved to another project keeps its ID and gets a new key, page, and project.
      const place = { key: found.key, url: found.url, title: found.title, ...(found.webhookScope === undefined ? {} : { webhookScope: found.webhookScope }) };
      return { externalId: found.externalId, status: found.status, asOf: found.asOf, place };
    },
    attachImage: async (token, ticket, image) => {
      const form = new FormData();
      form.append("file", new File([image.data], image.name, { type: image.contentType }));
      await call(to, token, `/rest/api/3/issue/${encodeURIComponent(localId(token, ticket.externalId))}/attachments`, { method: "POST", form });
    },
    requiredFields,
    labels: async (token, destinationId) => {
      // Only where the issue type's create screen has labels: elsewhere Jira refuses them.
      const fields = await createFields(token, destinationId);
      if (!fields.some((field) => field.fieldId === "labels" || field.key === "labels")) return [];
      const answer = await call(to, token, "/rest/api/3/label", { query: { maxResults: "1000" } });
      if (!isRecord(answer) || !Array.isArray(answer.values)) throw unexpected("no labels");
      return answer.values.filter(text).map((name): TrackerLabel => ({ id: name, name, exclusiveGroup: null }));
    },
    webhooks: {
      register: async (token, input) => {
        const scopes = [...new Set(input.scopes)].filter((scope) => /^\d{1,18}$/.test(scope));
        if (scopes.length === 0) fail("invalid", "Critiqs has no Jira projects to follow yet.");
        const answer = await call(to, token, "/rest/api/3/webhook", {
          method: "POST",
          json: {
            url: input.url,
            webhooks: [{ events: ["jira:issue_updated", "jira:issue_deleted"], jqlFilter: `project IN (${scopes.join(", ")})` }],
          },
        });
        // {"webhookRegistrationResult":[{"createdWebhookId":1000}]}, or the webhook's errors in place of its ID.
        const [result] = isRecord(answer) && Array.isArray(answer.webhookRegistrationResult) ? answer.webhookRegistrationResult : [];
        if (!isRecord(result)) throw unexpected("no webhook");
        if (typeof result.createdWebhookId !== "number" || !Number.isSafeInteger(result.createdWebhookId)) {
          const errors = Array.isArray(result.errors) ? result.errors.filter(text).join(" ") : "";
          throw new TrackerRefusal("invalid", `Jira didn't register the webhook${errors === "" ? "." : `: ${errors}`}`);
        }
        // Jira's answer doesn't say when it expires; its documentation says 30 days from registration. Asking would risk
        // losing a webhook Jira made over an answer Critiqs couldn't read.
        return { id: String(result.createdWebhookId), expiresAt: input.now + JIRA_WEBHOOK_LIFE_MS };
      },
      renew: async (token, ids) => await renew(to, token, ids),
      remove: async (token, ids) => {
        await call(to, token, "/rest/api/3/webhook", { method: "DELETE", json: { webhookIds: ids.map(Number) } });
      },
    },
  }, jiraPlace);
}

/** How long a Jira webhook lives after it is registered or extended (https://developer.atlassian.com/cloud/jira/platform/webhooks/). */
export const JIRA_WEBHOOK_LIFE_MS = 30 * 24 * 60 * 60_000;

/**
 * Extends webhooks' life; returns when they now expire. Jira's documentation
 * describes `expirationDate` as a number of milliseconds, and shows it as a
 * date in Jira's format (`"2019-06-01T12:42:30.000+0000"`): either is taken.
 */
async function renew(to: JiraEndpoints, token: TrackerToken, ids: string[]): Promise<number> {
  const answer = await call(to, token, "/rest/api/3/webhook/refresh", { method: "PUT", json: { webhookIds: ids.map(Number) } });
  const date = isRecord(answer) ? answer.expirationDate : undefined;
  const expiresAt = typeof date === "number" ? date : jiraTime(date);
  if (expiresAt === null || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw unexpected("no expiration date");
  return expiresAt;
}

/**
 * Where Jira's issues are: `https://<site>/browse/<key>`, on the site of the
 * token the issue was read with. An address is kept only when it is that page
 * for an issue on that site.
 */
const jiraPlace: TicketPlace = (ticket, token) => {
  const site = token.site;
  const url = webAddress(ticket.url);
  if (site == null || ticket.site !== site.id || url === null) return null;
  const prefix = `https://${site.name}/browse/`;
  if (!url.startsWith(prefix)) return null;
  const named = url.slice(prefix.length);
  if (named.includes("/") || named.includes("?") || named.includes("#") || /%(?![0-9A-Fa-f]{2})/.test(named)) return null;
  // Compared as Critiqs keeps keys, cut to their limit.
  return trackerText(decodeURIComponent(named), TRACKER_LIMITS.key) === ticket.key ? url : null;
};

/** The remote link's global ID for a thread's link: the same for the same thread, so adding it again updates it. */
async function linkGlobalId(url: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return `critiqs-thread=${[...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Sign-in: Atlassian OAuth 2.0 (3LO). Atlassian doesn't offer PKCE; the
// state, bound to the browser that started, and the client secret protect
// the code. Refresh tokens rotate: each is used once.

/**
 * What Critiqs asks Atlassian for: to read and write Jira issues, to know who
 * signed in and their email (`read:me`), to register its status webhooks,
 * and a refresh token (`offline_access`).
 */
export const JIRA_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-webhook", "read:me", "offline_access"];

export function jiraAuthorizeUrl(authUrl: string, input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL("/authorize", authUrl);
  url.search = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: input.clientId,
    scope: JIRA_SCOPES.join(" "),
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: "code",
    prompt: "consent",
  }).toString();
  return url.toString();
}

export async function exchangeJiraCode(endpoint: TrackerEndpointOptions, app: JiraApp, input: { code: string; redirectUri: string }, now: number): Promise<SignInTokens> {
  return await jiraTokenRequest(
    endpoint,
    { grant_type: "authorization_code", client_id: app.clientId, client_secret: app.clientSecret, code: input.code, redirect_uri: input.redirectUri },
    now,
    "Atlassian didn't accept this sign-in. Close this window and connect Jira again.",
  );
}

/** Trades a refresh token for new tokens; the one used stops working. `signal` calls the request off. */
export async function refreshJiraToken(endpoint: TrackerEndpointOptions, app: JiraApp, refreshToken: string, now: number, signal?: AbortSignal): Promise<SignInTokens> {
  return await jiraTokenRequest(
    endpoint,
    { grant_type: "refresh_token", client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refreshToken },
    now,
    "Your Jira sign-in has ended. Connect Jira again in Your trackers.",
    signal,
  );
}

/** Atlassian's token endpoint, at `baseUrl` (its sign-in address). */
async function jiraTokenRequest(endpoint: TrackerEndpointOptions, body: Record<string, string>, now: number, refused: string, signal?: AbortSignal): Promise<SignInTokens> {
  const to = trackerEndpoint(endpoint, JIRA_AUTH_URL);
  let response: Response;
  try {
    response = await to.fetch(`${to.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw unreachable();
  }
  const answer: unknown = await response.json().catch(() => null);
  // Atlassian answers a used, expired, or unknown code or refresh token with 400 or 403 (`invalid_grant`).
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    // A client Atlassian doesn't know is the operator's to fix: 401, as OAuth answers a client that failed to authenticate.
    if (response.status === 401 || (isRecord(answer) && (answer.error === "invalid_client" || answer.error === "unauthorized_client"))) {
      fail("unavailable", "Atlassian doesn't recognize this deployment's Jira app. Its operator must check CRITIQS_JIRA_CLIENT_ID and CRITIQS_JIRA_CLIENT_SECRET.");
    }
    fail("invalid", refused);
  }
  if (!response.ok || !isRecord(answer) || !text(answer.access_token)) throw unexpected(`status ${response.status}`);
  const expiresIn = typeof answer.expires_in === "number" && answer.expires_in > 0 ? answer.expires_in : null;
  return { access: answer.access_token, refresh: text(answer.refresh_token) ? answer.refresh_token : null, expiresAt: expiresIn === null ? null : now + expiresIn * 1000 };
}

/**
 * The Jira site a sign-in's token is for: the one the person chose before
 * signing in (`chosen`, its host), from Atlassian's accessible resources,
 * with its cloud ID; refused when the sign-in doesn't reach it.
 */
export async function jiraSignInSite(endpoint: TrackerEndpointOptions, accessToken: string, chosen: string): Promise<TrackerSite> {
  const to = trackerEndpoint(endpoint, JIRA_API_URL);
  let response: Response;
  try {
    response = await to.fetch(`${to.baseUrl}/oauth/token/accessible-resources`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw unreachable();
  }
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(answer)) throw unexpected(`status ${response.status}`);
  const site = answer.slice(0, 500).flatMap((resource): TrackerSite[] => {
    if (!isRecord(resource) || !text(resource.id) || !text(resource.url) || resource.id.length > 256) return [];
    // Jira's sites only: a resource's scopes say which product it is.
    if (Array.isArray(resource.scopes) && !resource.scopes.some((scope) => typeof scope === "string" && scope.includes("jira"))) return [];
    try {
      const host = new URL(resource.url).hostname.toLowerCase();
      return JIRA_SITE_HOST.test(host) ? [{ id: resource.id, name: host }] : [];
    } catch {
      return [];
    }
  }).find((each) => each.name === chosen);
  if (site === undefined) {
    fail(
      "forbidden",
      `Your Atlassian sign-in doesn't give Critiqs access to ${chosen || "that site"}. Connect again and choose ${chosen || "your site"} when Atlassian asks which site to use, or connect with an Atlassian API token instead.`,
    );
  }
  return site;
}

// ---------------------------------------------------------------------------
// Webhooks. Jira sends an OAuth app's webhooks with a bearer token in the
// Authorization header, signed with the app's client secret
// (https://developer.atlassian.com/cloud/jira/platform/webhooks/): a JSON Web
// Token, checked here as HMAC-SHA256 over its header and payload, in constant
// time, before anything in the delivery is read.

/** Leeway on a webhook token's times, for clocks that differ. */
export const JIRA_WEBHOOK_LEEWAY_MS = 5 * 60_000;
/** The longest a webhook token may be good for: Atlassian's tokens last minutes, so one good for longer isn't a delivery's. */
export const JIRA_WEBHOOK_TOKEN_MAX_MS = 60 * 60_000;
/** The status Critiqs records for an issue Jira deleted: the work is closed there. */
export const JIRA_DELETED_STATUS = { label: "Deleted", category: "canceled" } as const;

/** A Jira site as a delivery's issue address names it: by its cloud ID through Atlassian's gateway, or by its own host. */
export type JiraDeliverySite = { id: string } | { name: string };

/** What a call to the Jira webhook route means. */
export type JiraWebhook =
  /** Not from the operator's Jira app, or its token has expired: nothing in it is used. */
  | { status: "refused"; reason: string }
  /** From Jira, but nothing Critiqs keeps. */
  | { status: "ignored" }
  /**
   * That an issue changed, or was deleted. The token Jira signs doesn't
   * cover the body, so nothing else in it is used: the issue's status is read
   * from Jira with each linker's token. `webhookIds` are the webhooks it
   * matched, which Critiqs registered on one site each, and `site` the one
   * site the issue's address names, which must be theirs: webhook IDs are
   * unique only within a site.
   */
  | { status: "notice"; webhookIds: string[]; site: JiraDeliverySite; issueId: string; deleted: boolean };

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function base64UrlJson(value: string): unknown {
  const bytes = base64UrlBytes(value);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Whether `authorization` is a bearer token signed with `secret` (HS256)
 * that says when it expires (`exp`), hasn't, and is good for at most
 * `JIRA_WEBHOOK_TOKEN_MAX_MS`; the reason when it isn't. Atlassian documents
 * no other claims of these tokens, so none is required.
 */
export async function checkJiraWebhookToken(secret: string, authorization: string | null, now: number): Promise<string | null> {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization?.trim() ?? "");
  if (match === null) return "missing or malformed token";
  const [, head, payload, signature] = match as unknown as [string, string, string, string];
  const given = base64UrlBytes(signature);
  if (given === null) return "malformed signature";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, given, new TextEncoder().encode(`${head}.${payload}`)))) return "wrong signature";
  const header = base64UrlJson(head);
  if (!isRecord(header) || header.alg !== "HS256") return "unexpected algorithm";
  const claims = base64UrlJson(payload);
  if (!isRecord(claims)) return "unreadable claims";
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return "no expiry";
  if (claims.exp * 1000 < now - JIRA_WEBHOOK_LEEWAY_MS) return "expired";
  if (claims.exp * 1000 > now + JIRA_WEBHOOK_TOKEN_MAX_MS + JIRA_WEBHOOK_LEEWAY_MS) return "good for too long";
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat * 1000 > now + JIRA_WEBHOOK_LEEWAY_MS)) return "issued in the future";
  return null;
}

/**
 * The one site an issue's address names: its cloud ID, through Atlassian's
 * gateway (`https://api.atlassian.com/ex/jira/<cloudId>/…`), or the site's
 * own Atlassian host. Null for any other address, or none.
 */
export function jiraDeliverySite(self: unknown): JiraDeliverySite | null {
  if (!text(self)) return null;
  let url: URL;
  try {
    url = new URL(self);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.origin === JIRA_API_URL) {
    const cloudId = /^\/ex\/jira\/([A-Za-z0-9-]{1,64})\//.exec(url.pathname)?.[1];
    return cloudId === undefined ? null : { id: cloudId };
  }
  const host = url.hostname.toLowerCase();
  return JIRA_SITE_HOST.test(host) && !url.pathname.startsWith("/ex/") ? { name: host } : null;
}

/**
 * Reads a call to the Jira webhook route: the token is checked first; then
 * an issue's update or deletion becomes a notice that it changed, on the
 * site its address names. The token doesn't cover the body, so no status in
 * it is used: Critiqs reads the issue from Jira with the linker's token.
 */
export async function readJiraWebhook(secret: string, rawBody: Uint8Array<ArrayBuffer>, authorization: string | null, now: number): Promise<JiraWebhook> {
  const refused = await checkJiraWebhookToken(secret, authorization, now);
  if (refused !== null) return { status: "refused", reason: refused };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return { status: "refused", reason: "unreadable body" };
  }
  if (!isRecord(body) || !isRecord(body.issue) || !text(body.issue.id) || !/^\d{1,18}$/.test(body.issue.id)) return { status: "ignored" };
  const webhookIds = Array.isArray(body.matchedWebhookIds) ? body.matchedWebhookIds.flatMap((id) => (typeof id === "number" || text(id) ? [String(id)] : [])) : [];
  if (webhookIds.length === 0 || webhookIds.length > 20) return { status: "ignored" };
  const site = jiraDeliverySite(body.issue.self);
  if (site === null) return { status: "ignored" };
  switch (body.webhookEvent) {
    case "jira:issue_created":
    case "jira:issue_updated":
      return { status: "notice", webhookIds, site, issueId: body.issue.id, deleted: false };
    case "jira:issue_deleted":
      return { status: "notice", webhookIds, site, issueId: body.issue.id, deleted: true };
    default:
      return { status: "ignored" };
  }
}
