// A stand-in for Linear's GraphQL API and its upload storage, for tests: it
// keeps teams, issues, attachments, comments, and uploads in memory and
// answers the queries Critiqs's Linear adapter sends. Each test makes its own.

export interface StandInIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  teamId: string;
  state: { name: string; type: string };
  /** When the issue was archived; Linear's lists leave archived issues out unless asked with `includeArchived: true`. */
  archivedAt?: string;
  /** The template it was created from, and the labels it was created with. */
  templateId?: string;
  labelIds?: string[];
  /** When the issue last changed, as Linear reports it (ISO 8601). */
  updatedAt?: string;
}

export interface StandInLabel {
  id: string;
  name: string;
  teamId: string | null;
  isGroup?: boolean;
  groupType?: "singleSelect" | "multiSelect";
  parentId?: string;
}

/** An issue template in the stand-in: a team's, or the workspace's when `teamId` is null. */
export interface StandInTemplate {
  id: string;
  name: string;
  teamId: string | null;
  content: string | null;
}

export interface LinearStandIn {
  fetchFn: typeof fetch;
  /** Answers one request, as Bun.serve's handler. */
  handle(request: Request): Promise<Response>;
  issues: StandInIssue[];
  attachments: { issueId: string; url: string; title: string | null }[];
  comments: { issueId: string; body: string }[];
  uploads: { path: string; contentType: string | null; size: number }[];
  /** Issue templates, which tests may change between drafts. */
  templates: StandInTemplate[];
  /**
   * Labels: a team's, or the workspace's when `teamId` is null. A group
   * (`isGroup`) holds the labels whose `parentId` names it; an issue takes at
   * most one label of a single-select group, which a group without a
   * `groupType` is, as in Linear.
   */
  labels: StandInLabel[];
  /** Every GraphQL operation's name, in order. */
  operations: string[];
  /** The token each operation was sent with, in the same order. */
  tokens: string[];
  /**
   * Runs before an operation is answered; return a Response to answer with
   * it instead, or "after" to answer with an error after doing the work (as a
   * timeout after Linear created the issue would look).
   */
  intercept: ((operation: string, variables: Record<string, unknown>, token: string) => Promise<Response | "after" | undefined> | Response | "after" | undefined) | null;
  /** The page an issue's answers name; Linear's own, `https://linear.app/acme/issue/<key>`, unless a test names another. */
  pageOf: ((issue: StandInIssue) => string) | null;
}

const TEAMS = [
  { id: "team-eng", name: "Engineering", key: "ENG" },
  { id: "team-des", name: "Design", key: "DES" },
];

/** A stand-in Linear at `origin` (where its upload addresses point), with the given existing issues. */
/** When an issue last changed, for issues a test doesn't date, such as ones Critiqs creates: before any test's clock. */
export const STAND_IN_UPDATED_AT = "2026-01-01T00:00:00.000Z";

export function linearStandIn(origin = "https://linear.test", existing: Omit<StandInIssue, "description">[] = []): LinearStandIn {
  const standIn: LinearStandIn = {
    // Like a network: a caller that aborts stops waiting, but Linear finishes what it started.
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = standIn.handle(new Request(input, { ...init, signal: null }));
      const signal = init?.signal;
      if (!signal) return await answer;
      if (signal.aborted) throw signal.reason;
      return await Promise.race([answer, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    }) as typeof fetch,
    handle: async (request) => {
      const url = new URL(request.url);
      if (request.method === "PUT" && url.pathname.startsWith("/uploads/")) {
        const body = await request.arrayBuffer();
        standIn.uploads.push({ path: url.pathname, contentType: request.headers.get("Content-Type"), size: body.byteLength });
        return new Response(null, { status: 200 });
      }
      const authorization = request.headers.get("Authorization");
      if (authorization === null || authorization === "lin_api_bad") {
        return Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 });
      }
      const { query, variables = {} } = (await request.json()) as { query: string; variables?: Record<string, unknown> };
      const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "unknown";
      standIn.operations.push(operation);
      standIn.tokens.push(authorization);
      const intercepted = (await standIn.intercept?.(operation, variables, authorization)) ?? undefined;
      if (intercepted instanceof Response) return intercepted;
      const data = answer(operation, variables, /\bincludeArchived:\s*true\b/.test(query));
      if (intercepted === "after") return new Response("upstream timeout", { status: 504 });
      return data instanceof Response ? data : Response.json({ data });
    },
    issues: existing.map((issue) => ({ ...issue, description: "" })),
    attachments: [],
    comments: [],
    uploads: [],
    templates: [
      { id: "tpl-bug", name: "Bug report", teamId: "team-eng", content: "## Summary\n\nWhat happened?\n\n## Steps to reproduce\n\n1.\n\n## Expected\n\n## Actual\n" },
      { id: "tpl-feature", name: "Feature request", teamId: "team-eng", content: "## Problem\n\n## Proposal\n" },
      { id: "tpl-copy", name: "Copy change", teamId: "team-des", content: null },
      { id: "tpl-workspace", name: "Workspace template", teamId: null, content: "## Notes\n" },
    ],
    labels: [
      { id: "label-bug", name: "Bug", teamId: "team-eng" },
      { id: "label-wording", name: "Wording", teamId: null },
      { id: "label-des-bug", name: "Bug", teamId: "team-des" },
      { id: "label-area", name: "Area", teamId: "team-eng", isGroup: true },
    ],
    operations: [],
    tokens: [],
    intercept: null,
    pageOf: null,
  };

  const view = (issue: StandInIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: standIn.pageOf?.(issue) ?? `https://linear.app/acme/issue/${issue.identifier.toLowerCase()}`,
    state: issue.state,
    updatedAt: issue.updatedAt ?? STAND_IN_UPDATED_AT,
    team: { organization: { id: "org-1" } },
  });

  function answer(operation: string, variables: Record<string, unknown>, includeArchived: boolean): unknown {
    // As Linear's lists do: archived issues only when asked for.
    const listed = () => standIn.issues.filter((issue) => includeArchived || issue.archivedAt === undefined);
    switch (operation) {
      case "CritiqsVerify":
        return { viewer: { id: "user-1", name: "Dana Smith" }, organization: { id: "org-1", name: "Acme" } };
      case "CritiqsTeams":
        return { teams: { nodes: TEAMS } };
      case "CritiqsIssueStatus":
        return {
          issues: {
            nodes: listed()
              .filter((issue) => issue.id === variables.id)
              .map((issue) => {
                // The fields the status query asks for: with where the issue is now, its key and page change when it moves to another team.
                const { id, identifier, title, url, state, updatedAt } = view(issue);
                return { id, identifier, title, url, state, updatedAt };
              }),
          },
        };
      case "CritiqsIssue":
        return { issues: { nodes: listed().filter((issue) => issue.id === variables.id).map(view) } };
      case "CritiqsIssueByKey":
        return {
          issues: {
            nodes: listed().filter((issue) => issue.identifier.toLowerCase() === `${String(variables.team)}-${String(variables.number)}`.toLowerCase()).map(view),
          },
        };
      case "CritiqsSearch": {
        const term = String(variables.term).toLowerCase();
        return { searchIssues: { nodes: listed().filter((issue) => issue.title.toLowerCase().includes(term)).map(view) } };
      }
      case "CritiqsCreate": {
        const input = variables.input as { id?: string; teamId: string; title: string; description: string; templateId?: string; labelIds?: string[] };
        const team = TEAMS.find((entry) => entry.id === input.teamId);
        if (team === undefined) return Response.json({ errors: [{ message: "Entity not found: Team", extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
        if (input.id !== undefined && standIn.issues.some((issue) => issue.id === input.id)) {
          return Response.json({ errors: [{ message: "Issue with this id already exists", extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
        }
        const number = Math.max(0, ...standIn.issues.filter((issue) => issue.teamId === team.id).map((issue) => Number(issue.identifier.split("-")[1]))) + 1;
        if (input.templateId !== undefined && !standIn.templates.some((template) => template.id === input.templateId)) {
          return Response.json({ errors: [{ message: "Entity not found: Template", extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
        }
        const labelError = invalidLabels(input.labelIds ?? [], team.id);
        if (labelError !== null) return Response.json({ errors: [{ message: labelError, extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
        const issue: StandInIssue = {
          id: input.id ?? crypto.randomUUID(),
          identifier: `${team.key}-${number}`,
          title: input.title,
          description: input.description,
          teamId: team.id,
          state: { name: "Triage", type: "triage" },
          ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
          ...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
        };
        standIn.issues.push(issue);
        return { issueCreate: { success: true, issue: view(issue) } };
      }
      case "CritiqsLinkBack": {
        // One attachment per issue and address: creating it again updates it, as Linear does.
        const input = variables.input as { issueId: string; url: string; title?: string };
        const attachment = { issueId: input.issueId, url: input.url, title: typeof input.title === "string" ? input.title : null };
        const index = standIn.attachments.findIndex((entry) => entry.issueId === attachment.issueId && entry.url === attachment.url);
        if (index === -1) standIn.attachments.push(attachment);
        else standIn.attachments[index] = attachment;
        return { attachmentCreate: { success: true } };
      }
      case "CritiqsComment": {
        const input = variables.input as { issueId: string; body: string };
        standIn.comments.push(input);
        return { commentCreate: { success: true } };
      }
      case "CritiqsTemplates":
      case "CritiqsTeamTemplates":
      case "CritiqsTemplate": {
        const found = standIn.templates.filter(
          (template) =>
            template.teamId !== null &&
            (operation !== "CritiqsTeamTemplates" || template.teamId === variables.team) &&
            (operation !== "CritiqsTemplate" || template.id === variables.id),
        );
        return {
          templateSearch: found.map((template) => {
            const team = TEAMS.find((entry) => entry.id === template.teamId)!;
            return { id: template.id, name: template.name, team, ...(operation === "CritiqsTemplate" ? { content: template.content } : {}) };
          }),
        };
      }
      case "CritiqsLabels":
        return {
          issueLabels: {
            nodes: standIn.labels
              .filter((label) => label.isGroup !== true && (label.teamId === null || label.teamId === variables.team))
              .map(({ id, name, parentId }) => {
                const parent = standIn.labels.find((group) => group.id === parentId);
                return { id, name, parent: parent === undefined ? null : { id: parent.id, groupType: parent.groupType ?? null } };
              }),
          },
        };
      case "CritiqsUpload": {
        const id = standIn.uploads.length + 1;
        return {
          fileUpload: {
            success: true,
            uploadFile: { uploadUrl: `${origin}/uploads/${id}?signature=s`, assetUrl: `https://uploads.linear.app/asset-${id}`, headers: [{ key: "x-goog-meta-id", value: String(id) }] },
          },
        };
      }
      default:
        return Response.json({ errors: [{ message: `Unknown operation ${operation}` }] }, { status: 400 });
    }
  }

  /** Why Linear refuses an issue's labels, as it does: one it can't find for the team, a group, or two of one single-select group; null when it takes them. */
  function invalidLabels(ids: string[], teamId: string): string | null {
    const groups = new Set<string>();
    for (const id of ids) {
      const label = standIn.labels.find((each) => each.id === id && (each.teamId === null || each.teamId === teamId));
      if (label === undefined) return "Entity not found: IssueLabel";
      if (label.isGroup === true) return "Label groups can't be applied to issues";
      const group = standIn.labels.find((each) => each.id === label.parentId);
      if (group === undefined || group.groupType === "multiSelect") continue;
      if (groups.has(group.id)) return `Only one label of the group "${group.name}" can be applied to an issue`;
      groups.add(group.id);
    }
    return null;
  }

  return standIn;
}

/** The hex HMAC-SHA256 of `body` (as UTF-8 when text) under `secret`, as Linear signs a webhook delivery (`Linear-Signature`). */
export async function linearSignature(secret: string, body: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof body === "string" ? new TextEncoder().encode(body) : body));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A webhook delivery as Linear sends one for an issue event: the JSON body
 * and its headers, signed with `secret`. `sentAt` is `webhookTimestamp`;
 * `updatedAt` is the issue's own last change; `happenedAt`, the event's
 * `createdAt`, is when the action happened (`updatedAt` unless given).
 */
export async function linearIssueWebhook(
  secret: string,
  event: { action: "create" | "update" | "remove"; issueId: string; state?: { name: string; type: string } | null; updatedAt: number; sentAt: number; happenedAt?: number; organizationId?: string; type?: string },
): Promise<{ body: string; headers: Record<string, string> }> {
  const payload = {
    action: event.action,
    type: event.type ?? "Issue",
    createdAt: new Date(event.happenedAt ?? event.updatedAt).toISOString(),
    data: {
      id: event.issueId,
      identifier: "ENG-9",
      title: "Department label is unclear",
      updatedAt: new Date(event.updatedAt).toISOString(),
      ...(event.state === null ? {} : { state: { id: "state-1", color: "#000000", ...(event.state ?? { name: "Done", type: "completed" }) } }),
    },
    url: "https://linear.app/acme/issue/eng-9",
    organizationId: event.organizationId ?? "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: event.sentAt,
  };
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Linear-Delivery": crypto.randomUUID(),
      "Linear-Event": payload.type,
      "Linear-Signature": await linearSignature(secret, body),
      "User-Agent": "Linear-Webhook",
    },
  };
}
