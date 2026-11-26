// A stand-in for Jira Cloud, for tests and the browser walk: Atlassian's
// sign-in (authorize page, token endpoint, accessible resources, `/me`) and
// one Jira site's REST API v3, reached both ways the adapter reaches a site:
// through the API gateway by cloud ID with a sign-in's bearer token
// (`/ex/jira/<cloudId>/rest/api/3/…`), and at the site's own address with an
// email and API token (`/<host>/rest/api/3/…`, as `CRITIQS_JIRA_SITES_URL`
// puts it). It keeps projects, issue types and their create fields, issues,
// issue properties, remote links, comments, attachments, labels, and dynamic
// webhooks in memory, and answers as Jira's documentation says
// (https://developer.atlassian.com/cloud/jira/platform/rest/v3/, checked
// against its OpenAPI description, swagger-v3.v3.json). Descriptions and
// comments must be valid Atlassian Document Format, as Jira requires.
//
// Not modelled: pagination past one page (projects, labels, webhooks);
// JQL beyond the queries Critiqs sends (`creator = currentUser() ORDER BY
// created DESC`, `[project = "<id>" AND ]text ~ "<words>" ORDER BY updated
// DESC`); permissions within a site (every user sees and edits everything);
// workflows (tests set statuses directly); rate limits; the webhook limit of
// five per app and user; webhook retries; the claims inside Jira's webhook
// token beyond `iat` and `exp` (Atlassian doesn't document them); and
// Atlassian's consent screen beyond one Allow button.

export const JIRA_STANDIN_SECRET = "jira-standin-client-secret";
export const JIRA_STANDIN_CLIENT_ID = "jira-standin-client";
/** When an issue last changed, for issues a test doesn't date: before any test's clock. */
export const JIRA_STAND_IN_UPDATED = "2026-01-01T00:00:00.000+0000";

/** What a deployment without Jira's sign-in sets, for tests that don't use Jira. */
export const NO_JIRA = { jira: null, jiraApiUrl: "https://api.atlassian.test", jiraAuthUrl: "https://auth.atlassian.test", jiraSitesUrl: null } as const;

export interface JiraStandInSite {
  cloudId: string;
  host: string;
  name: string;
}

export interface JiraStandInUser {
  accountId: string;
  email: string;
  /** Hidden from `/myself`, as a person's privacy settings may hide it. */
  hideEmail?: boolean;
  name: string;
  apiToken: string;
}

export interface JiraStandInField {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
  schema: { type: string; items?: string; system?: string; custom?: string };
  allowedValues?: { id: string; name?: string; value?: string }[];
}

export interface JiraStandInIssue {
  id: string;
  key: string;
  projectId: string;
  issueTypeId: string;
  summary: string;
  description: unknown;
  labels: string[];
  /** Other fields it was created with, by field ID. */
  fields: Record<string, unknown>;
  status: { name: string; categoryKey: "new" | "indeterminate" | "done" };
  updated: string;
  created: string;
  creatorId: string;
  properties: Record<string, unknown>;
}

export interface JiraStandIn {
  fetchFn: typeof fetch;
  handle(request: Request): Promise<Response>;
  site: JiraStandInSite;
  users: JiraStandInUser[];
  projects: { id: string; key: string; name: string; issueTypes: { id: string; name: string; subtask: boolean; fields: JiraStandInField[] }[] }[];
  issues: JiraStandInIssue[];
  labels: string[];
  remoteLinks: { issueId: string; globalId: string | null; url: string; title: string }[];
  comments: { issueId: string; body: unknown; authorId: string }[];
  attachments: { issueId: string; filename: string; mimeType: string; size: number }[];
  webhooks: { id: number; url: string; jqlFilter: string; events: string[]; expiresAt: number; ownerId: string }[];
  /** Codes and tokens of sign-ins: each code once, each refresh token once (they rotate). */
  oauth: { codes: Map<string, string>; access: Map<string, { accountId: string; expiresAt: number }>; refresh: Map<string, string> };
  /** Every request's method and path, in order. */
  requests: string[];
  /** Runs before a request is answered; return a Response to answer with it instead, or "after" to answer 504 after doing the work. */
  intercept: ((method: string, path: string, body: unknown) => Promise<Response | "after" | undefined> | Response | "after" | undefined) | null;
  /** The stand-in's clock, for webhook expiry. */
  now: () => number;
  setStatus(issueId: string, status: JiraStandInIssue["status"], updated: string): void;
}

const ERROR = (status: number, errorMessages: string[], errors: Record<string, string> = {}) => Response.json({ errorMessages, errors }, { status });

/** Jira's time format: ISO 8601 with the offset written `+0000`. */
export function jiraTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

/** Whether a value is an ADF document Jira would take: the nodes and marks Critiqs writes, each where ADF allows it. */
export function validAdf(document: unknown): string | null {
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(document) || document.type !== "doc" || document.version !== 1 || !Array.isArray(document.content)) return "not a version 1 document";
  const inline = (nodes: unknown, codeOnly = false): string | null => {
    if (nodes === undefined) return null;
    if (!Array.isArray(nodes)) return "inline content isn't a list";
    for (const node of nodes) {
      if (!record(node)) return "inline node isn't an object";
      if (node.type === "hardBreak" && !codeOnly) continue;
      if (node.type !== "text" || typeof node.text !== "string" || node.text === "") return `bad inline node ${String(node.type)}`;
      const marks = node.marks;
      if (marks === undefined) continue;
      if (!Array.isArray(marks) || codeOnly) return "marks where none are allowed";
      const types = marks.map((mark) => (record(mark) ? mark.type : null));
      if (new Set(types).size !== types.length) return "repeated mark";
      for (const mark of marks) {
        if (!record(mark) || !["strong", "em", "code", "link"].includes(String(mark.type))) return "unknown mark";
        if (mark.type === "link" && (!record(mark.attrs) || typeof mark.attrs.href !== "string" || !/^(https?:|mailto:)/.test(mark.attrs.href))) return "bad link";
      }
      if (types.includes("code") && types.some((type) => type !== "code" && type !== "link")) return "code with another mark";
    }
    return null;
  };
  const blocks = (nodes: unknown, allowed: string[]): string | null => {
    if (!Array.isArray(nodes)) return "block content isn't a list";
    for (const node of nodes) {
      if (!record(node) || !allowed.includes(String(node.type))) return `block ${record(node) ? String(node.type) : "?"} not allowed here`;
      switch (node.type) {
        case "paragraph": {
          const problem = inline(node.content);
          if (problem !== null) return problem;
          break;
        }
        case "heading": {
          if (!record(node.attrs) || typeof node.attrs.level !== "number" || node.attrs.level < 1 || node.attrs.level > 6) return "bad heading level";
          const problem = inline(node.content);
          if (problem !== null) return problem;
          break;
        }
        case "codeBlock": {
          if (node.content !== undefined) {
            const problem = inline(node.content, true);
            if (problem !== null) return problem;
          }
          break;
        }
        case "rule":
          break;
        case "blockquote": {
          if (!Array.isArray(node.content) || node.content.length === 0) return "empty quote";
          const problem = blocks(node.content, ["paragraph", "bulletList", "orderedList", "codeBlock"]);
          if (problem !== null) return problem;
          break;
        }
        case "bulletList":
        case "orderedList": {
          if (!Array.isArray(node.content) || node.content.length === 0) return "empty list";
          for (const item of node.content) {
            if (!record(item) || item.type !== "listItem" || !Array.isArray(item.content) || item.content.length === 0) return "bad list item";
            const problem = blocks(item.content, ["paragraph", "bulletList", "orderedList", "codeBlock"]);
            if (problem !== null) return problem;
          }
          break;
        }
      }
    }
    return null;
  };
  return blocks(document.content, ["paragraph", "heading", "codeBlock", "rule", "blockquote", "bulletList", "orderedList"]);
}

/** The text an ADF document shows, blocks on their own lines, for tests. */
export function adfText(document: unknown): string {
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const walk = (node: unknown): string => {
    if (!record(node)) return "";
    if (node.type === "text") return String(node.text);
    if (node.type === "hardBreak") return "\n";
    const inner = Array.isArray(node.content) ? node.content.map(walk) : [];
    return ["paragraph", "heading", "codeBlock"].includes(String(node.type)) ? `${inner.join("")}\n` : inner.join("");
  };
  return walk(document);
}

/** Reads the JQL string at the start of `text` (`"…"` with `\\` escapes): its value and length; null when it isn't one. */
function jqlStringAt(text: string): { value: string; length: number } | null {
  if (text[0] !== '"') return null;
  let value = "";
  for (let index = 1; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\") {
      value += text[++index] ?? "";
      continue;
    }
    if (char === '"') return { value, length: index + 1 };
    value += char;
  }
  return null;
}

/** A stand-in Jira site `acme.atlassian.net` with one user (Dana), two projects, and the given issues. */
export function jiraStandIn(options: { users?: JiraStandInUser[]; now?: () => number } = {}): JiraStandIn {
  const site: JiraStandInSite = { cloudId: "11111111-2222-4333-8444-555555555555", host: "acme.atlassian.net", name: "acme" };
  let nextIssue = 10000;
  let nextHook = 1000;
  const standIn: JiraStandIn = {
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = standIn.handle(new Request(input, { ...init, signal: null }));
      const signal = init?.signal;
      if (!signal) return await answer;
      if (signal.aborted) throw signal.reason;
      return await Promise.race([answer, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    }) as typeof fetch,
    handle: async (request) => await handle(request),
    site,
    users: options.users ?? [{ accountId: "557058:dana", email: "dana@example.com", name: "Dana Smith", apiToken: "ATATT-dana-token" }],
    projects: [
      {
        id: "10001",
        key: "WEB",
        name: "Website",
        issueTypes: [
          { id: "10010", name: "Bug", subtask: false, fields: [] },
          { id: "10011", name: "Task", subtask: false, fields: [] },
          { id: "10012", name: "Sub-task", subtask: true, fields: [] },
        ],
      },
      {
        id: "10002",
        key: "OPS",
        name: "Operations",
        issueTypes: [
          {
            id: "10020",
            name: "Incident",
            subtask: false,
            fields: [
              { fieldId: "priority", name: "Priority", required: true, schema: { type: "priority", system: "priority" }, allowedValues: [{ id: "1", name: "Highest" }, { id: "3", name: "Medium" }] },
              { fieldId: "customfield_10050", name: "Customer impact", required: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } },
              { fieldId: "customfield_10051", name: "Affected users", required: true, schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" } },
              { fieldId: "customfield_10052", name: "Environment tier", required: false, schema: { type: "option" }, allowedValues: [{ id: "20", value: "Production" }] },
            ],
          },
          {
            id: "10021",
            name: "Escalation",
            subtask: false,
            fields: [{ fieldId: "customfield_10060", name: "Escalation owner", required: true, schema: { type: "user", custom: "com.atlassian.jira.plugin.system.customfieldtypes:userpicker" } }],
          },
        ],
      },
    ],
    issues: [],
    labels: ["Bug", "copy", "Wording"],
    remoteLinks: [],
    comments: [],
    attachments: [],
    webhooks: [],
    oauth: { codes: new Map(), access: new Map(), refresh: new Map() },
    requests: [],
    intercept: null,
    now: options.now ?? (() => Date.now()),
    setStatus: (issueId, status, updated) => {
      const issue = standIn.issues.find((each) => each.id === issueId);
      if (issue === undefined) throw new Error(`No issue ${issueId}`);
      issue.status = status;
      issue.updated = updated;
    },
  };

  // Every project's issue types carry the standard create fields too.
  const standardFields: JiraStandInField[] = [
    { fieldId: "project", name: "Project", required: true, schema: { type: "project", system: "project" } },
    { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype", system: "issuetype" } },
    { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
    { fieldId: "description", name: "Description", required: false, schema: { type: "string", system: "description" } },
    { fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: true, schema: { type: "user", system: "reporter" } },
    { fieldId: "labels", name: "Labels", required: false, schema: { type: "array", items: "string", system: "labels" } },
  ];

  const issueView = (issue: JiraStandInIssue, base: string, properties: string[] = []) => {
    const project = standIn.projects.find((each) => each.id === issue.projectId)!;
    return {
      id: issue.id,
      key: issue.key,
      self: `${base}/rest/api/3/issue/${issue.id}`,
      fields: {
        summary: issue.summary,
        status: { name: issue.status.name, statusCategory: { key: issue.status.categoryKey, name: issue.status.categoryKey } },
        updated: issue.updated,
        project: { id: project.id, key: project.key, name: project.name },
      },
      ...(properties.length === 0 ? {} : { properties: Object.fromEntries(properties.filter((key) => key in issue.properties).map((key) => [key, issue.properties[key]])) }),
    };
  };

  const findIssue = (idOrKey: string) => standIn.issues.find((issue) => issue.id === idOrKey || issue.key === idOrKey.toUpperCase());

  /** Who a request is, by its Authorization header, for the way it reached the site; null when Jira wouldn't accept it. */
  function caller(request: Request, via: "gateway" | "site" | "me"): JiraStandInUser | null {
    const header = request.headers.get("Authorization") ?? "";
    if (via === "site") {
      const basic = /^Basic (.+)$/.exec(header);
      if (basic === null) return null;
      const [email, ...token] = atob(basic[1]!).split(":");
      return standIn.users.find((user) => user.email === email && user.apiToken === token.join(":")) ?? null;
    }
    const bearer = /^Bearer (.+)$/.exec(header);
    const access = bearer === null ? undefined : standIn.oauth.access.get(bearer[1]!);
    if (access === undefined || access.expiresAt <= standIn.now()) return null;
    return standIn.users.find((user) => user.accountId === access.accountId) ?? null;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    standIn.requests.push(`${request.method} ${path}`);
    // Atlassian's sign-in: the consent page, which sends the person back with a code.
    if (path === "/authorize" && request.method === "GET") return consentPage(url);
    if (path === "/authorize/allow" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const user = standIn.users.find((each) => each.accountId === form.get("account")) ?? standIn.users[0]!;
      const code = `code-${crypto.randomUUID()}`;
      standIn.oauth.codes.set(code, user.accountId);
      const back = new URL(form.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", form.get("state") ?? "");
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }
    if (path === "/oauth/token" && request.method === "POST") return await token(request);
    if (path === "/oauth/token/accessible-resources") {
      if (caller(request, "me") === null) return ERROR(401, ["Unauthorized"]);
      return Response.json([{ id: site.cloudId, url: `https://${site.host}`, name: site.name, scopes: ["read:jira-work", "write:jira-work", "manage:jira-webhook"], avatarUrl: "https://example.test/a.png" }]);
    }
    if (path === "/me") {
      const user = caller(request, "me");
      if (user === null) return ERROR(401, ["Unauthorized"]);
      return Response.json({ account_type: "atlassian", account_id: user.accountId, email: user.email, name: user.name, account_status: "active" });
    }
    const gateway = /^\/ex\/jira\/([^/]+)(\/rest\/api\/3\/.*)$/.exec(path);
    const direct = /^\/([a-z0-9-]+\.atlassian\.net)(\/.*)$/.exec(path);
    if (direct !== null && direct[2] === "/_edge/tenant_info") {
      return direct[1] === site.host ? Response.json({ cloudId: site.cloudId }) : new Response("Not found", { status: 404 });
    }
    let rest: string;
    let user: JiraStandInUser | null;
    let base: string;
    if (gateway !== null) {
      if (gateway[1] !== site.cloudId) return ERROR(404, ["Site not found."]);
      rest = gateway[2]!;
      user = caller(request, "gateway");
      base = `${url.origin}/ex/jira/${site.cloudId}`;
    } else if (direct !== null) {
      if (direct[1] !== site.host) return new Response("Not found", { status: 404 });
      rest = direct[2]!;
      user = caller(request, "site");
      base = `https://${site.host}`;
    } else return new Response("Not found", { status: 404 });
    if (user === null) return ERROR(401, ["You are not authenticated. Authentication required to perform this operation."]);
    let body: unknown = null;
    if (request.headers.get("Content-Type")?.startsWith("application/json")) body = await request.json().catch(() => undefined);
    if (body === undefined) return ERROR(400, ["Unexpected character in the request body."]);
    const intercepted = (await standIn.intercept?.(request.method, rest, body)) ?? undefined;
    if (intercepted instanceof Response) return intercepted;
    const answer = await route(request, rest, url, body, user, base, gateway !== null);
    return intercepted === "after" ? new Response("upstream timeout", { status: 504 }) : answer;
  }

  function consentPage(url: URL): Response {
    const params = url.searchParams;
    if (params.get("audience") !== "api.atlassian.com" || params.get("client_id") !== JIRA_STANDIN_CLIENT_ID || params.get("response_type") !== "code" || params.get("prompt") !== "consent") {
      return new Response("Bad authorization request", { status: 400 });
    }
    const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
    const hidden = (name: string) => `<input type="hidden" name="${name}" value="${escape(params.get(name) ?? "")}">`;
    const html = `<!doctype html><meta charset="utf-8"><title>Atlassian (stand-in)</title>
<body style="font-family:sans-serif;max-width:420px;margin:40px auto">
<h1>Critiqs is requesting access to your Atlassian account</h1>
<p>Stand-in consent screen. Site: <strong>${escape(site.host)}</strong></p>
<p>Scopes: ${escape(params.get("scope") ?? "")}</p>
<form method="post" action="/authorize/allow">${hidden("redirect_uri")}${hidden("state")}
<label>Account <select name="account">${standIn.users.map((user) => `<option value="${escape(user.accountId)}">${escape(user.name)} (${escape(user.email)})</option>`).join("")}</select></label>
<p><button type="submit">Accept</button></p></form></body>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  async function token(request: Request): Promise<Response> {
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return Response.json({ error: "invalid_request" }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;
    if (body.client_id !== JIRA_STANDIN_CLIENT_ID || body.client_secret !== JIRA_STANDIN_SECRET) return Response.json({ error: "access_denied", error_description: "Unauthorized" }, { status: 401 });
    let accountId: string | undefined;
    if (body.grant_type === "authorization_code") {
      accountId = standIn.oauth.codes.get(body.code ?? "");
      standIn.oauth.codes.delete(body.code ?? "");
    } else if (body.grant_type === "refresh_token") {
      accountId = standIn.oauth.refresh.get(body.refresh_token ?? "");
      // Rotating: the refresh token used stops working.
      standIn.oauth.refresh.delete(body.refresh_token ?? "");
    }
    if (accountId === undefined) return Response.json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, { status: 403 });
    const access = `jira-access-${crypto.randomUUID()}`;
    const refresh = `jira-refresh-${crypto.randomUUID()}`;
    standIn.oauth.access.set(access, { accountId, expiresAt: standIn.now() + 3600_000 });
    standIn.oauth.refresh.set(refresh, accountId);
    return Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600, scope: "read:jira-work write:jira-work read:me offline_access", token_type: "Bearer" });
  }

  function createFields(projectId: string, typeId: string): JiraStandInField[] | null {
    const project = standIn.projects.find((each) => each.id === projectId || each.key === projectId);
    const type = project?.issueTypes.find((each) => each.id === typeId);
    return type === undefined ? null : [...standardFields, ...type.fields];
  }

  async function route(request: Request, path: string, url: URL, body: unknown, user: JiraStandInUser, base: string, viaGateway: boolean): Promise<Response> {
    const method = request.method;
    const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    if (method === "GET" && path === "/rest/api/3/myself") {
      return Response.json({ accountId: user.accountId, displayName: user.name, emailAddress: user.hideEmail === true ? null : user.email, active: true, accountType: "atlassian" });
    }
    if (method === "GET" && path === "/rest/api/3/project/search") {
      const expand = (url.searchParams.get("expand") ?? "").split(",");
      return Response.json({
        isLast: true,
        startAt: Number(url.searchParams.get("startAt") ?? 0),
        maxResults: 100,
        total: standIn.projects.length,
        values: standIn.projects.map((project) => ({
          id: project.id,
          key: project.key,
          name: project.name,
          ...(expand.includes("issueTypes") ? { issueTypes: project.issueTypes.map(({ id, name, subtask }) => ({ id, name, subtask })) } : {}),
        })),
      });
    }
    const meta = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes\/([^/]+)$/.exec(path);
    if (method === "GET" && meta !== null) {
      const fields = createFields(meta[1]!, meta[2]!);
      if (fields === null) return ERROR(400, ["Issue type not found."]);
      return Response.json({ startAt: 0, maxResults: 200, total: fields.length, fields: fields.map((field) => ({ ...field, key: field.fieldId, hasDefaultValue: field.hasDefaultValue ?? false, operations: ["set"] })) });
    }
    if (method === "GET" && path === "/rest/api/3/label") return Response.json({ isLast: true, maxResults: 1000, startAt: 0, total: standIn.labels.length, values: standIn.labels });
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      if (!record(body) || typeof body.jql !== "string") return ERROR(400, ["The JQL query is missing."]);
      const matched = search(body.jql, user);
      if (typeof matched === "string") return ERROR(400, [matched]);
      const properties = Array.isArray(body.properties) ? body.properties.map(String) : [];
      const max = typeof body.maxResults === "number" ? body.maxResults : 50;
      return Response.json({ issues: matched.slice(0, max).map((issue) => issueView(issue, base, properties)), isLast: true, nextPageToken: null });
    }
    if (method === "POST" && path === "/rest/api/3/issue") return createIssue(body, user, viaGateway);
    const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (issuePath !== null) {
      const issue = findIssue(decodeURIComponent(issuePath[1]!));
      if (issue === undefined) return ERROR(404, ["Issue does not exist or you do not have permission to see it."]);
      switch (`${method} ${issuePath[2] ?? ""}`) {
        case "GET ":
          return Response.json(issueView(issue, base));
        case "POST /remotelink": {
          if (!record(body) || !record(body.object) || typeof body.object.url !== "string" || typeof body.object.title !== "string") return ERROR(400, ["The remote link object is missing its url or title."]);
          const globalId = typeof body.globalId === "string" ? body.globalId : null;
          const existing = globalId === null ? -1 : standIn.remoteLinks.findIndex((link) => link.issueId === issue.id && link.globalId === globalId);
          const link = { issueId: issue.id, globalId, url: body.object.url, title: body.object.title };
          // Jira updates the remote link with the same global ID (200) instead of adding another (201).
          if (existing !== -1) {
            standIn.remoteLinks[existing] = link;
            return Response.json({ id: existing + 1, self: `${base}/rest/api/3/issue/${issue.id}/remotelink/${existing + 1}` }, { status: 200 });
          }
          standIn.remoteLinks.push(link);
          return Response.json({ id: standIn.remoteLinks.length, self: `${base}/rest/api/3/issue/${issue.id}/remotelink/${standIn.remoteLinks.length}` }, { status: 201 });
        }
        case "POST /comment": {
          if (!record(body)) return ERROR(400, ["Comment body can not be empty!"]);
          const problem = validAdf(body.body);
          if (problem !== null) return ERROR(400, [], { comment: `Operation value must be an Atlassian Document (${problem}).` });
          standIn.comments.push({ issueId: issue.id, body: body.body, authorId: user.accountId });
          return Response.json({ id: String(standIn.comments.length), body: body.body }, { status: 201 });
        }
        case "POST /attachments": {
          if (request.headers.get("X-Atlassian-Token") !== "no-check") return new Response("XSRF check failed", { status: 403 });
          const form = await request.formData().catch(() => null);
          const files = form?.getAll("file").filter((value): value is File => typeof value !== "string") ?? [];
          if (files.length === 0) return ERROR(400, ["No file was sent in the 'file' part."]);
          const added = files.map((file) => ({ issueId: issue.id, filename: file.name, mimeType: file.type, size: file.size }));
          standIn.attachments.push(...added);
          return Response.json(added.map((each, index) => ({ id: String(standIn.attachments.length - added.length + index + 1), filename: each.filename, mimeType: each.mimeType, size: each.size })));
        }
        default:
          return ERROR(405, ["Method not allowed."]);
      }
    }
    if (path === "/rest/api/3/webhook" || path === "/rest/api/3/webhook/refresh") {
      // Only Connect and OAuth 2.0 apps can register webhooks.
      if (!viaGateway) return ERROR(403, ["Only Connect and OAuth 2.0 apps can use this operation."]);
      if (method === "POST" && path === "/rest/api/3/webhook") {
        if (!record(body) || typeof body.url !== "string" || !Array.isArray(body.webhooks)) return ERROR(400, ["url and webhooks are required."]);
        const results = body.webhooks.map((hook) => {
          if (!record(hook) || !Array.isArray(hook.events) || typeof hook.jqlFilter !== "string") return { errors: ["events and jqlFilter are required."] };
          if (!/^project IN \((?:\d+)(?:, \d+)*\)$/.test(hook.jqlFilter)) return { errors: [`The clause ${hook.jqlFilter} is unsupported`] };
          const id = nextHook++;
          standIn.webhooks.push({ id, url: body.url as string, jqlFilter: hook.jqlFilter, events: hook.events.map(String), expiresAt: standIn.now() + 30 * 86_400_000, ownerId: user.accountId });
          return { createdWebhookId: id };
        });
        return Response.json({ webhookRegistrationResult: results });
      }
      if (!record(body) || !Array.isArray(body.webhookIds)) return ERROR(400, ["webhookIds is required."]);
      const ids = body.webhookIds.map(Number);
      if (method === "PUT") {
        const expiresAt = standIn.now() + 30 * 86_400_000;
        // Unrecognized IDs are ignored.
        for (const hook of standIn.webhooks) if (ids.includes(hook.id) && hook.ownerId === user.accountId) hook.expiresAt = expiresAt;
        return Response.json({ expirationDate: expiresAt });
      }
      if (method === "DELETE") {
        standIn.webhooks = standIn.webhooks.filter((hook) => !ids.includes(hook.id) || hook.ownerId !== user.accountId);
        return new Response(null, { status: 202 });
      }
    }
    return ERROR(404, [`No route for ${method} ${path}`]);
  }

  function search(jql: string, user: JiraStandInUser): JiraStandInIssue[] | string {
    if (jql === "creator = currentUser() ORDER BY created DESC") {
      return standIn.issues.filter((issue) => issue.creatorId === user.accountId).sort((a, b) => b.created.localeCompare(a.created) || Number(b.id) - Number(a.id));
    }
    let rest = jql;
    let projectId: string | null = null;
    if (rest.startsWith("project = ")) {
      const value = jqlStringAt(rest.slice("project = ".length));
      if (value === null || !rest.slice("project = ".length + value.length).startsWith(" AND ")) return "Error in the JQL Query: expected AND.";
      projectId = value.value;
      rest = rest.slice("project = ".length + value.length + " AND ".length);
    }
    if (!rest.startsWith("text ~ ")) return `Error in the JQL Query: unsupported query ${jql}`;
    const words = jqlStringAt(rest.slice("text ~ ".length));
    if (words === null || rest.slice("text ~ ".length + words.length) !== " ORDER BY updated DESC") return "Error in the JQL Query: the quoted string is not closed.";
    const terms = words.value.toLowerCase().split(/\s+/).filter((term) => term !== "");
    return standIn.issues
      .filter((issue) => (projectId === null || issue.projectId === projectId) && terms.every((term) => `${issue.summary} ${JSON.stringify(issue.description)}`.toLowerCase().includes(term)))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  function createIssue(body: unknown, user: JiraStandInUser, _viaGateway: boolean): Response {
    const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    if (!record(body) || !record(body.fields)) return ERROR(400, ["fields are required."]);
    const fields = body.fields;
    const projectId = record(fields.project) ? String(fields.project.id ?? fields.project.key ?? "") : "";
    const typeId = record(fields.issuetype) ? String(fields.issuetype.id ?? "") : "";
    const project = standIn.projects.find((each) => each.id === projectId || each.key === projectId);
    if (project === undefined) return ERROR(400, [], { project: "valid project is required" });
    const allowed = createFields(project.id, typeId);
    if (allowed === null) return ERROR(400, [], { issuetype: "valid issue type is required" });
    const errors: Record<string, string> = {};
    if (typeof fields.summary !== "string" || fields.summary.trim() === "") errors.summary = "You must specify a summary of the issue.";
    if (fields.description !== undefined) {
      const problem = validAdf(fields.description);
      if (problem !== null) errors.description = `Operation value must be an Atlassian Document (${problem}).`;
    }
    for (const field of allowed) {
      if (field.required && field.hasDefaultValue !== true && !["project", "issuetype", "summary"].includes(field.fieldId) && fields[field.fieldId] === undefined) {
        errors[field.fieldId] = `${field.name} is required.`;
      }
    }
    for (const [id, value] of Object.entries(fields)) {
      const field = allowed.find((each) => each.fieldId === id);
      if (field === undefined) {
        errors[id] = `Field '${id}' cannot be set. It is not on the appropriate screen, or unknown.`;
        continue;
      }
      if (id === "labels" && (!Array.isArray(value) || value.some((label) => typeof label !== "string" || /\s/.test(label)))) errors.labels = "Labels can't contain spaces.";
      if (field.schema.custom?.endsWith(":textarea") && validAdf(value) !== null) errors[id] = "Operation value must be an Atlassian Document.";
      if (field.schema.type === "number" && typeof value !== "number") errors[id] = `${field.name} must be a number.`;
      if (field.allowedValues !== undefined && field.schema.type !== "array") {
        if (!record(value) || !field.allowedValues.some((option) => option.id === value.id)) errors[id] = `Specify a valid value for ${field.name}.`;
      }
    }
    if (Object.keys(errors).length > 0) return ERROR(400, [], errors);
    const number = standIn.issues.filter((issue) => issue.projectId === project.id).length + 1;
    const now = jiraTimestamp(standIn.now());
    const issue: JiraStandInIssue = {
      id: String(nextIssue++),
      key: `${project.key}-${number}`,
      projectId: project.id,
      issueTypeId: typeId,
      summary: String(fields.summary),
      description: fields.description ?? null,
      labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      fields: Object.fromEntries(Object.entries(fields).filter(([id]) => !["project", "issuetype", "summary", "description", "labels"].includes(id))),
      status: { name: "To Do", categoryKey: "new" },
      updated: now,
      created: now,
      creatorId: user.accountId,
      properties: Object.fromEntries(
        (Array.isArray(body.properties) ? body.properties : []).flatMap((property) => (record(property) && typeof property.key === "string" ? [[property.key, property.value]] : [])),
      ),
    };
    for (const label of issue.labels) if (!standIn.labels.includes(label)) standIn.labels.push(label);
    standIn.issues.push(issue);
    return Response.json({ id: issue.id, key: issue.key, self: `https://${site.host}/rest/api/3/issue/${issue.id}` }, { status: 201 });
  }

  return standIn;
}

/** An existing issue in the stand-in, for tests that link one. */
export function addJiraIssue(standIn: JiraStandIn, issue: { projectKey?: string; summary: string; status?: JiraStandInIssue["status"]; updated?: string; creatorId?: string }): JiraStandInIssue {
  const project = standIn.projects.find((each) => each.key === (issue.projectKey ?? "WEB"))!;
  const id = String(20000 + standIn.issues.length);
  const created: JiraStandInIssue = {
    id,
    key: `${project.key}-${100 + standIn.issues.length}`,
    projectId: project.id,
    issueTypeId: project.issueTypes[0]!.id,
    summary: issue.summary,
    description: null,
    labels: [],
    fields: {},
    status: issue.status ?? { name: "In Progress", categoryKey: "indeterminate" },
    updated: issue.updated ?? JIRA_STAND_IN_UPDATED,
    created: issue.updated ?? JIRA_STAND_IN_UPDATED,
    creatorId: issue.creatorId ?? "557058:someone-else",
    properties: {},
  };
  standIn.issues.push(created);
  return created;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A bearer token as Jira signs one for an OAuth app's webhook delivery: HS256 with the app's client secret. */
export async function jiraWebhookToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signing = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signing)));
  return `${signing}.${base64Url(signature)}`;
}

/**
 * A webhook delivery as Jira sends one for an issue event to the webhooks it
 * matched: the JSON body and its headers, with the bearer token signed with
 * `secret`. `sentAt` is the delivery's `timestamp`.
 */
export async function jiraIssueWebhook(
  standIn: JiraStandIn,
  event: { event: "jira:issue_updated" | "jira:issue_deleted" | "jira:issue_created"; issueId: string; webhookIds: number[]; sentAt: number; secret?: string; claims?: Record<string, unknown>; self?: string | null },
): Promise<{ body: string; headers: Record<string, string> }> {
  const issue = standIn.issues.find((each) => each.id === event.issueId)!;
  const project = standIn.projects.find((each) => each.id === issue.projectId)!;
  const payload = {
    timestamp: event.sentAt,
    webhookEvent: event.event,
    issue_event_type_name: event.event === "jira:issue_updated" ? "issue_generic" : event.event === "jira:issue_deleted" ? "issue_deleted" : "issue_created",
    user: { accountId: "557058:someone-else", accountType: "atlassian", displayName: "Lee" },
    issue: {
      id: issue.id,
      ...(event.self === null ? {} : { self: event.self ?? `https://${standIn.site.host}/rest/api/2/issue/${issue.id}` }),
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: issue.status.name, statusCategory: { key: issue.status.categoryKey } },
        updated: issue.updated,
        project: { id: project.id, key: project.key },
      },
    },
    matchedWebhookIds: event.webhookIds,
  };
  const now = Math.floor(event.sentAt / 1000);
  const token = await jiraWebhookToken(event.secret ?? JIRA_STANDIN_SECRET, event.claims ?? { iss: JIRA_STANDIN_CLIENT_ID, iat: now, exp: now + 180 });
  return {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
      "X-Atlassian-Webhook-Identifier": crypto.randomUUID(),
      "X-Atlassian-Webhook-Flow": "Primary",
    },
  };
}
