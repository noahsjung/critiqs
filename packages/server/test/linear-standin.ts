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
}

export interface LinearStandIn {
  fetchFn: typeof fetch;
  /** Answers one request, as Bun.serve's handler. */
  handle(request: Request): Promise<Response>;
  issues: StandInIssue[];
  attachments: { issueId: string; url: string; title: string | null }[];
  comments: { issueId: string; body: string }[];
  uploads: { path: string; contentType: string | null; size: number }[];
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
}

const TEAMS = [
  { id: "team-eng", name: "Engineering", key: "ENG" },
  { id: "team-des", name: "Design", key: "DES" },
];

/** A stand-in Linear at `origin` (where its upload addresses point), with the given existing issues. */
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
    operations: [],
    tokens: [],
    intercept: null,
  };

  const view = (issue: StandInIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: `https://linear.app/acme/issue/${issue.identifier.toLowerCase()}`,
    state: issue.state,
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
        const input = variables.input as { id?: string; teamId: string; title: string; description: string };
        const team = TEAMS.find((entry) => entry.id === input.teamId);
        if (team === undefined) return Response.json({ errors: [{ message: "Entity not found: Team", extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
        if (input.id !== undefined && standIn.issues.some((issue) => issue.id === input.id)) {
          return Response.json({ errors: [{ message: "Issue with this id already exists", extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
        }
        const number = Math.max(0, ...standIn.issues.filter((issue) => issue.teamId === team.id).map((issue) => Number(issue.identifier.split("-")[1]))) + 1;
        const issue = { id: input.id ?? crypto.randomUUID(), identifier: `${team.key}-${number}`, title: input.title, description: input.description, teamId: team.id, state: { name: "Triage", type: "triage" } };
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

  return standIn;
}
