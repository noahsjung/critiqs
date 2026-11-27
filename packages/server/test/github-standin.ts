// A stand-in for GitHub, for tests and the browser walk: the REST and GraphQL
// calls Critiqs's GitHub adapter makes, the GitHub App's sign-in pages and
// token endpoint, and signed webhook deliveries, as GitHub documents them
// (https://docs.github.com/en/rest, .../apps/creating-github-apps/authenticating-with-a-github-app,
// .../webhooks). It keeps users, installations, repositories, issues,
// comments, labels, and template files in memory. Each test makes its own.
// Repository renames are modeled as GitHub documents them
// (https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository):
// the old name redirects (301) until another repository takes it; node IDs
// don't change. Issue transfers move an issue to another repository under a
// new number; whether its node ID stays is not documented, so a test chooses.
//
// Not modeled: pagination beyond what a test fills, the `Link` header, ETags
// and 304s, GitHub's search ranking and index delay (search is a plain word
// match), secondary rate limits beyond what `intercept` answers,
// organization-wide default templates from a `.github`
// repository, labels GitHub might create when named on a new issue (the
// stand-in refuses unknown labels), and how issue-form answers render.

import type { TicketsDeployment } from "../src/tickets/accounts.ts";

/** A deployment without the GitHub App: GitHub connects with a pasted token, at the stand-in's addresses. */
export const NO_GITHUB: Pick<TicketsDeployment, "github" | "githubWebhookSecret" | "githubApiUrl" | "githubAppUrl"> = {
  github: null,
  githubWebhookSecret: null,
  githubApiUrl: "https://api.github.test",
  githubAppUrl: "https://github.test",
};

export interface StandInUser {
  id: number;
  login: string;
  emails: { email: string; primary: boolean; verified: boolean }[];
}

export interface StandInRepository {
  id: number;
  owner: string;
  name: string;
  hasIssues: boolean;
  archived: boolean;
  /** The app installation that reaches it; null when only personal tokens reach it. */
  installationId: number | null;
  /** Users who may push (set labels on new issues); everyone else's labels are silently dropped, as GitHub does. */
  pushers: string[];
  labels: string[];
  /** Files in `.github/ISSUE_TEMPLATE`, by name. */
  templates: Record<string, string>;
}

export interface StandInGithubIssue {
  id: number;
  nodeId: string;
  repositoryId: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "duplicate" | "reopened" | null;
  labels: string[];
  creator: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the issue was deleted: GitHub answers 410 for it. */
  deleted?: boolean;
  /** A pull request, which GitHub's issue lists include. */
  pullRequest?: boolean;
}

export interface GithubStandIn {
  fetchFn: typeof fetch;
  handle(request: Request): Promise<Response>;
  /** The stand-in's own address: its API, sign-in pages, and issue pages. */
  origin: string;
  users: StandInUser[];
  /** Personal tokens, by value, and whose they are. */
  personalTokens: Map<string, string>;
  repositories: StandInRepository[];
  issues: StandInGithubIssue[];
  comments: { issueNodeId: string; body: string; user: string }[];
  /** Each request, as `METHOD path`, in order. */
  requests: string[];
  /** The GitHub App's client ID and secret, which the token endpoint checks. */
  app: { clientId: string; clientSecret: string };
  /** Who signs in on the authorize page; null makes the person deny access. */
  signInAs: string | null;
  /** Issued access and refresh tokens. */
  accessTokens: Map<string, { login: string; expiresAt: number }>;
  refreshTokens: Map<string, string>;
  /** The access token issued with each refresh token, which refreshing with it ends too. */
  pairs: Map<string, string>;
  /** The stand-in's clock, for token expiry. */
  now: () => number;
  /**
   * Runs before a request is answered; return a Response to answer with it
   * instead, or "after" to answer 502 after doing the work (as a timeout after
   * GitHub created the issue would look).
   */
  intercept: ((method: string, path: string, token: string | null) => Promise<Response | "after" | undefined> | Response | "after" | undefined) | null;
  /** Old repository names, by `owner/name` in lower case, and the repository they redirect to until another takes the name. */
  renamed: Map<string, number>;
  /** Changes an issue's state as a person would on GitHub, a second after its last change; returns the issue. */
  setState(nodeId: string, state: "open" | "closed", reason?: StandInGithubIssue["stateReason"]): StandInGithubIssue;
}

export const STAND_IN_GITHUB_UPDATED_AT = "2026-01-01T00:00:00Z";

export const GITHUB_BUG_FORM = `name: Bug report
description: Something isn't working
title: "[Bug]: "
labels: ["bug", "triage"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to fill out this bug report!
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Also tell us, what did you expect to happen?
      placeholder: Tell us what you see!
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Version
      value: "1.0"
  - type: dropdown
    id: browsers
    attributes:
      label: Which browsers?
      multiple: true
      options:
        - Firefox
        - Chrome
  - type: checkboxes
    id: terms
    attributes:
      label: Code of Conduct
      options:
        - label: I agree to follow this project's Code of Conduct
          required: true
`;

const FEATURE_TEMPLATE = `---
name: Feature request
about: Suggest an idea for this project
title: ''
labels: enhancement, wording
assignees: ''
---

## Problem

## Proposal
`;

/** A stand-in GitHub at `origin`, with Dana (signed in through the app and holding a personal token) and three repositories. */
export function githubStandIn(origin = "https://github.test"): GithubStandIn {
  const codes = new Map<string, { login: string; challenge: string; redirectUri: string; clientId: string }>();
  let issued = 0;
  const standIn: GithubStandIn = {
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = standIn.handle(new Request(input, { ...init, signal: null }));
      const signal = init?.signal;
      if (!signal) return await answer;
      if (signal.aborted) throw signal.reason;
      return await Promise.race([answer, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    }) as typeof fetch,
    handle: async (request) => await handle(request),
    origin,
    users: [
      {
        id: 1001,
        login: "dana-smith",
        emails: [
          { email: "dana@personal.example", primary: true, verified: true },
          { email: "dana@example.com", primary: false, verified: true },
          { email: "unverified@example.com", primary: false, verified: false },
        ],
      },
      { id: 1002, login: "riley", emails: [{ email: "riley@example.com", primary: true, verified: true }] },
    ],
    personalTokens: new Map([
      ["github_pat_dana", "dana-smith"],
      ["github_pat_riley", "riley"],
    ]),
    repositories: [
      { id: 501, owner: "acme", name: "web", hasIssues: true, archived: false, installationId: 71, pushers: ["dana-smith"], labels: ["bug", "Wording", "enhancement"], templates: { "bug.yml": GITHUB_BUG_FORM, "feature.md": FEATURE_TEMPLATE, "config.yml": "blank_issues_enabled: false\n" } },
      { id: 502, owner: "acme", name: "api", hasIssues: true, archived: false, installationId: 71, pushers: [], labels: ["bug"], templates: {} },
      { id: 503, owner: "acme", name: "old", hasIssues: true, archived: true, installationId: 71, pushers: ["dana-smith"], labels: [], templates: {} },
      { id: 504, owner: "acme", name: "docs", hasIssues: false, archived: false, installationId: 71, pushers: ["dana-smith"], labels: [], templates: {} },
      { id: 505, owner: "dana-smith", name: "notes", hasIssues: true, archived: false, installationId: null, pushers: ["dana-smith"], labels: [], templates: {} },
    ],
    issues: [],
    comments: [],
    requests: [],
    app: { clientId: "Iv1.critiqs", clientSecret: "app-secret" },
    signInAs: "dana-smith",
    accessTokens: new Map(),
    refreshTokens: new Map(),
    pairs: new Map(),
    renamed: new Map(),
    now: () => Date.now(),
    intercept: null,
    setState: (nodeId, state, reason = state === "closed" ? "completed" : "reopened") => {
      const issue = standIn.issues.find((each) => each.nodeId === nodeId);
      if (issue === undefined) throw new Error(`No issue ${nodeId}`);
      issue.state = state;
      issue.stateReason = reason;
      issue.updatedAt = new Date(Date.parse(issue.updatedAt) + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      return issue;
    },
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
  const message = (text: string, status: number, headers: Record<string, string> = {}) => json({ message: text, documentation_url: "https://docs.github.com/rest" }, status, headers);
  const repositoryById = (id: number) => standIn.repositories.find((repository) => repository.id === id)!;
  const fullName = (repository: StandInRepository) => `${repository.owner}/${repository.name}`;

  /** Who a token belongs to, and how it was made; null when GitHub doesn't accept it. */
  function holder(authorization: string | null): { login: string; kind: "app" | "personal" } | null {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (token === undefined) return null;
    const personal = standIn.personalTokens.get(token);
    if (personal !== undefined) return { login: personal, kind: "personal" };
    const access = standIn.accessTokens.get(token);
    if (access !== undefined && access.expiresAt > standIn.now()) return { login: access.login, kind: "app" };
    return null;
  }

  /** Repositories a token reaches: an app token, those where the app is installed; a personal token, the person's own and their organization's. */
  function reachable(who: { login: string; kind: "app" | "personal" }): StandInRepository[] {
    return who.kind === "app" ? standIn.repositories.filter((repository) => repository.installationId !== null) : standIn.repositories;
  }

  function repositoryView(repository: StandInRepository, who: { login: string }) {
    return {
      id: repository.id,
      node_id: `R_${repository.id}`,
      name: repository.name,
      full_name: fullName(repository),
      owner: { login: repository.owner },
      private: true,
      html_url: `${origin}/${fullName(repository)}`,
      has_issues: repository.hasIssues,
      archived: repository.archived,
      permissions: { admin: false, maintain: false, push: repository.pushers.includes(who.login), triage: false, pull: true },
    };
  }

  function issueView(issue: StandInGithubIssue) {
    const repository = repositoryById(issue.repositoryId);
    return {
      id: issue.id,
      node_id: issue.nodeId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.stateReason,
      labels: issue.labels.map((name) => ({ name })),
      user: { login: issue.creator },
      html_url: `${origin}/${fullName(repository)}/${issue.pullRequest === true ? "pull" : "issues"}/${issue.number}`,
      repository_url: `${origin}/repos/${fullName(repository)}`,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      ...(issue.pullRequest === true ? { pull_request: { url: `${origin}/repos/${fullName(repository)}/pulls/${issue.number}` } } : {}),
    };
  }

  function nodeView(issue: StandInGithubIssue) {
    const repository = repositoryById(issue.repositoryId);
    return {
      __typename: issue.pullRequest === true ? "PullRequest" : "Issue",
      id: issue.nodeId,
      number: issue.number,
      title: issue.title,
      url: `${origin}/${fullName(repository)}/issues/${issue.number}`,
      state: issue.state.toUpperCase(),
      stateReason: issue.stateReason?.toUpperCase() ?? null,
      updatedAt: issue.updatedAt,
      repository: { name: repository.name, nameWithOwner: fullName(repository) },
    };
  }

  async function challengeOf(verifier: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function issueTokens(login: string) {
    issued++;
    const access = `ghu_standin_${issued}`;
    const refresh = `ghr_standin_${issued}`;
    standIn.accessTokens.set(access, { login, expiresAt: standIn.now() + 28_800_000 });
    standIn.refreshTokens.set(refresh, login);
    standIn.pairs.set(refresh, access);
    return { access_token: access, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600, scope: "", token_type: "bearer" };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    standIn.requests.push(`${request.method} ${path}`);
    const authorization = request.headers.get("Authorization");
    const intercepted = (await standIn.intercept?.(request.method, path, authorization)) ?? undefined;
    if (intercepted instanceof Response) return intercepted;
    const answer = await route(request, url, path, authorization);
    return intercepted === "after" ? new Response("upstream timeout", { status: 502 }) : answer;
  }

  async function route(request: Request, url: URL, path: string, authorization: string | null): Promise<Response> {
    // The GitHub App's sign-in: the authorize page sends the person straight back, as an already-installed app does.
    if (request.method === "GET" && path === "/login/oauth/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const back = new URL(redirect);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (standIn.signInAs === null) {
        back.searchParams.set("error", "access_denied");
        return new Response(null, { status: 302, headers: { Location: back.toString() } });
      }
      if (url.searchParams.get("code_challenge_method") !== "S256") return new Response("PKCE S256 required by this stand-in", { status: 400 });
      const code = `code_${crypto.randomUUID()}`;
      codes.set(code, { login: standIn.signInAs, challenge: url.searchParams.get("code_challenge") ?? "", redirectUri: redirect, clientId: url.searchParams.get("client_id") ?? "" });
      back.searchParams.set("code", code);
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }
    // Delete an app authorization (https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization):
    // the app's client ID and secret by Basic authentication, and "a valid OAuth access_token" in the body; 204, and every
    // token of the app for that user stops working. An expired or unknown token is refused with 422, the only refusal listed.
    if (request.method === "DELETE" && path === `/applications/${standIn.app.clientId}/grant`) {
      if (authorization !== `Basic ${btoa(`${standIn.app.clientId}:${standIn.app.clientSecret}`)}`) return message("Requires authentication", 401);
      const body: unknown = await request.json().catch(() => null);
      const token = typeof body === "object" && body !== null && typeof (body as { access_token?: unknown }).access_token === "string" ? (body as { access_token: string }).access_token : "";
      const access = standIn.accessTokens.get(token);
      if (access === undefined || access.expiresAt <= standIn.now()) return message("Validation Failed", 422);
      const owner = access.login;
      for (const [access, entry] of standIn.accessTokens) if (entry.login === owner) standIn.accessTokens.delete(access);
      for (const [refresh, login] of standIn.refreshTokens) if (login === owner) standIn.refreshTokens.delete(refresh);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && path === "/login/oauth/access_token") {
      const form = new URLSearchParams(await request.text());
      const fail = (error: string, description: string) => json({ error, error_description: description, error_uri: "https://docs.github.com/apps" });
      if (form.get("client_id") !== standIn.app.clientId || form.get("client_secret") !== standIn.app.clientSecret) {
        return fail("incorrect_client_credentials", "The client_id and/or client_secret passed are incorrect.");
      }
      if (form.get("grant_type") === "refresh_token") {
        const login = standIn.refreshTokens.get(form.get("refresh_token") ?? "");
        if (login === undefined) return fail("bad_refresh_token", "The refresh token passed is incorrect or expired.");
        // Rotated: "that refresh token and the old user access token will no longer work"
        // (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
        standIn.refreshTokens.delete(form.get("refresh_token")!);
        const pair = standIn.pairs.get(form.get("refresh_token")!);
        if (pair !== undefined) standIn.accessTokens.delete(pair);
        return json(issueTokens(login));
      }
      const code = codes.get(form.get("code") ?? "");
      if (code === undefined) return fail("bad_verification_code", "The code passed is incorrect or expired.");
      codes.delete(form.get("code")!);
      if (form.get("redirect_uri") !== null && form.get("redirect_uri") !== code.redirectUri) return fail("redirect_uri_mismatch", "The redirect_uri MUST match the registered callback URL for this application.");
      if ((await challengeOf(form.get("code_verifier") ?? "")) !== code.challenge) return fail("bad_verification_code", "The code passed is incorrect or expired.");
      return json(issueTokens(code.login));
    }

    const who = holder(authorization);
    if (who === null) return message("Bad credentials", 401);
    if (request.headers.get("User-Agent") === null) return message("Request forbidden by administrative rules. Please make sure your request has a User-Agent header.", 403);
    const user = standIn.users.find((each) => each.login === who.login)!;

    if (request.method === "POST" && path === "/graphql") {
      const { query, variables } = (await request.json()) as { query: string; variables: { id?: string; body?: string; after?: string | null } };
      const issue = standIn.issues.find((each) => each.nodeId === variables.id && each.deleted !== true);
      const visible = issue !== undefined && reachable(who).some((repository) => repository.id === issue.repositoryId);
      const notFound = (field: string) => json({ data: { [field]: null }, errors: [{ type: "NOT_FOUND", path: [field], message: `Could not resolve to a node with the global id of '${variables.id}'` }] });
      // addComment (https://docs.github.com/en/graphql/reference/mutations#addcomment): the subject by its node ID.
      if (/addComment\(input: \{ subjectId: \$id, body: \$body \}\)/.test(query)) {
        if (!visible) return notFound("addComment");
        if (typeof variables.body !== "string" || variables.body === "") return json({ data: { addComment: null }, errors: [{ type: "UNPROCESSABLE", message: "Body can't be blank" }] });
        standIn.comments.push({ issueNodeId: issue.nodeId, body: variables.body, user: who.login });
        return json({ data: { addComment: { subject: { id: issue.nodeId } } } });
      }
      if (!/node\(id: \$id\)/.test(query)) return json({ errors: [{ message: "Unknown query in the stand-in" }] });
      if (!visible) return notFound("node");
      // An issue's text and a page of its comments, when asked for.
      if (/comments\(first: 100, after: \$after\)/.test(query)) {
        const all = standIn.comments.filter((comment) => comment.issueNodeId === issue.nodeId);
        const start = variables.after == null ? 0 : Number(variables.after);
        const nodes = all.slice(start, start + 100).map((comment) => ({ body: comment.body }));
        const end = start + nodes.length;
        return json({ data: { node: { ...nodeView(issue), body: issue.body, comments: { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } } });
      }
      return json({ data: { node: nodeView(issue) } });
    }
    if (request.method === "GET" && path === "/user") return json({ login: user.login, id: user.id, name: user.login === "dana-smith" ? "Dana Smith" : user.login, email: null });
    if (request.method === "GET" && path === "/user/emails") {
      // A personal token reads emails only with the "Email addresses" permission, which the stand-in's tokens lack.
      if (who.kind === "personal") return message("Resource not accessible by personal access token", 403);
      return json(user.emails.map((email) => ({ ...email, visibility: null })));
    }
    if (request.method === "GET" && path === "/user/installations") {
      if (who.kind !== "app") return message("You must authenticate with an access token authorized to a GitHub App in order to list installations", 403);
      const ids = [...new Set(standIn.repositories.flatMap((repository) => (repository.installationId === null ? [] : [repository.installationId])))];
      return json({ total_count: ids.length, installations: ids.map((id) => ({ id, account: { login: "acme" }, repository_selection: "selected", app_slug: "critiqs" })) });
    }
    const installation = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (request.method === "GET" && installation !== null) {
      if (who.kind !== "app") return message("Not Found", 404);
      const listed = standIn.repositories.filter((repository) => repository.installationId === Number(installation[1]));
      return json({ total_count: listed.length, repository_selection: "selected", repositories: page(url, listed).map((repository) => repositoryView(repository, who)) });
    }
    if (request.method === "GET" && path === "/user/repos") return json(page(url, reachable(who)).map((repository) => repositoryView(repository, who)));
    if (request.method === "GET" && path === "/search/issues") return search(url, who);

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch === null) return message("Not Found", 404);
    const [, owner, name, rest = ""] = repoMatch.map((part) => (part === undefined ? part : decodeURIComponent(part)));
    const repository = reachable(who).find((each) => each.owner.toLowerCase() === owner!.toLowerCase() && each.name.toLowerCase() === name!.toLowerCase());
    if (repository === undefined) {
      // A renamed repository's old name redirects to it, while no other repository has taken the name.
      const moved = standIn.renamed.get(`${owner}/${name}`.toLowerCase());
      const target = moved === undefined ? undefined : standIn.repositories.find((each) => each.id === moved);
      if (target !== undefined) return new Response(null, { status: 301, headers: { Location: `${origin}/repos/${fullName(target)}${rest}` } });
      return message("Not Found", 404);
    }
    const inRepository = standIn.issues.filter((issue) => issue.repositoryId === repository.id);

    if (rest === "/issues" && request.method === "POST") {
      if (!repository.hasIssues) return message("Issues are disabled for this repo", 410);
      if (repository.archived) return message("Repository was archived so is read-only.", 403);
      const input = (await request.json()) as { title?: unknown; body?: unknown; labels?: unknown };
      if (typeof input.title !== "string" || input.title === "") return json({ message: "Validation Failed", errors: [{ resource: "Issue", code: "missing_field", field: "title" }] }, 422);
      let labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === "string") : [];
      // Labels from someone without push access are silently dropped, as GitHub documents.
      if (!repository.pushers.includes(who.login)) labels = [];
      const unknown = labels.find((label) => !repository.labels.some((known) => known.toLowerCase() === label.toLowerCase()));
      if (unknown !== undefined) return json({ message: "Validation Failed", errors: [{ value: unknown, resource: "Label", field: "name", code: "invalid" }] }, 422);
      const at = new Date(standIn.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
      const id = 9000 + standIn.issues.length + 1;
      const issue: StandInGithubIssue = {
        id,
        nodeId: `I_kwStandIn${id}`,
        repositoryId: repository.id,
        number: Math.max(0, ...inRepository.map((each) => each.number)) + 1,
        title: input.title,
        body: typeof input.body === "string" ? input.body : "",
        state: "open",
        stateReason: null,
        labels,
        creator: who.login,
        createdAt: at,
        updatedAt: at,
      };
      standIn.issues.push(issue);
      return json(issueView(issue), 201);
    }
    if (rest === "/issues" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const creator = url.searchParams.get("creator");
      const since = url.searchParams.get("since");
      let listed = inRepository.filter(
        (issue) =>
          issue.deleted !== true &&
          (state === "all" || issue.state === state) &&
          (creator === null || issue.creator === creator) &&
          (since === null || Date.parse(issue.updatedAt) >= Date.parse(since)),
      );
      const sort = url.searchParams.get("sort") ?? "created";
      listed = listed.sort((a, b) => Date.parse(sort === "updated" ? a.updatedAt : a.createdAt) - Date.parse(sort === "updated" ? b.updatedAt : b.createdAt) || a.number - b.number);
      if ((url.searchParams.get("direction") ?? "desc") === "desc") listed.reverse();
      return json(page(url, listed).map(issueView));
    }
    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    if (issueMatch !== null) {
      const issue = inRepository.find((each) => each.number === Number(issueMatch[1]));
      if (issue === undefined) return message("Not Found", 404);
      if (issue.deleted === true) return message("This issue was deleted", 410);
      if (issueMatch[2] === undefined && request.method === "GET") return json(issueView(issue));
      if (issueMatch[2] !== undefined && request.method === "GET") {
        return json(page(url, standIn.comments.filter((comment) => comment.issueNodeId === issue.nodeId)).map((comment, index) => ({ id: index + 1, body: comment.body, user: { login: comment.user } })));
      }
      if (issueMatch[2] !== undefined && request.method === "POST") {
        const input = (await request.json()) as { body?: unknown };
        if (typeof input.body !== "string" || input.body === "") return json({ message: "Validation Failed", errors: [{ resource: "IssueComment", code: "missing_field", field: "body" }] }, 422);
        standIn.comments.push({ issueNodeId: issue.nodeId, body: input.body, user: who.login });
        return json({ id: standIn.comments.length, body: input.body, user: { login: who.login } }, 201);
      }
    }
    if (rest === "/labels" && request.method === "GET") {
      return json(page(url, repository.labels).map((label, index) => ({ id: index + 1, node_id: `LA_${index + 1}`, name: label, color: "ededed", description: null, default: false })));
    }
    if (rest === "/contents/.github/ISSUE_TEMPLATE" && request.method === "GET") {
      const files = Object.keys(repository.templates);
      if (files.length === 0) return message("Not Found", 404);
      return json(files.map((file) => ({ type: "file", name: file, path: `.github/ISSUE_TEMPLATE/${file}`, sha: "0", size: repository.templates[file]!.length })));
    }
    const file = /^\/contents\/\.github\/ISSUE_TEMPLATE\/(.+)$/.exec(rest);
    if (file !== null && request.method === "GET") {
      const source = repository.templates[file[1]!];
      if (source === undefined) return message("Not Found", 404);
      if (request.headers.get("Accept") === "application/vnd.github.raw+json") return new Response(source, { headers: { "Content-Type": "application/vnd.github.raw" } });
      return json({ type: "file", name: file[1], content: btoa(source), encoding: "base64" });
    }
    return message("Not Found", 404);
  }

  function page<T>(url: URL, items: T[]): T[] {
    const perPage = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
    const number = Number(url.searchParams.get("page") ?? 1);
    return items.slice((number - 1) * perPage, number * perPage);
  }

  /** GitHub's issue search, as a plain match of every quoted word in an issue's title or text, in the `repo:` repositories named. */
  function search(url: URL, who: { login: string; kind: "app" | "personal" }): Response {
    const q = url.searchParams.get("q") ?? "";
    const qualifiers = [...q.matchAll(/(?:^|\s)(is|repo):(\S+)/g)].map((match) => ({ name: match[1]!, value: match[2]! }));
    if (who.kind === "app" && !qualifiers.some((each) => each.name === "is" && (each.value === "issue" || each.value === "pull-request"))) {
      return json({ message: "Validation Failed", errors: [{ message: "Requests must include the is:issue or is:pull-request qualifier." }] }, 422);
    }
    const words = [...q.matchAll(/"([^"]*)"/g)].map((match) => match[1]!.toLowerCase());
    const repositories = qualifiers.filter((each) => each.name === "repo").map((each) => each.value.toLowerCase());
    const visible = reachable(who);
    const items = standIn.issues.filter((issue) => {
      const repository = visible.find((each) => each.id === issue.repositoryId);
      if (repository === undefined || issue.deleted === true || issue.pullRequest === true) return false;
      if (repositories.length > 0 && !repositories.includes(fullName(repository).toLowerCase())) return false;
      const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    return json({ total_count: items.length, incomplete_results: false, items: items.slice(0, Number(url.searchParams.get("per_page") ?? 30)).map(issueView) });
  }

  return standIn;
}

/** Adds an existing issue to the stand-in, in a repository by full name. */
export function addGithubIssue(standIn: GithubStandIn, repository: string, issue: Partial<StandInGithubIssue> & { number: number; title: string }): StandInGithubIssue {
  const found = standIn.repositories.find((each) => `${each.owner}/${each.name}` === repository);
  if (found === undefined) throw new Error(`No repository ${repository}`);
  const id = 8000 + standIn.issues.length + 1;
  const added: StandInGithubIssue = {
    id,
    nodeId: `I_kwExisting${id}`,
    repositoryId: found.id,
    body: "",
    state: "open",
    stateReason: null,
    labels: [],
    creator: "riley",
    createdAt: STAND_IN_GITHUB_UPDATED_AT,
    updatedAt: STAND_IN_GITHUB_UPDATED_AT,
    ...issue,
  };
  standIn.issues.push(added);
  return added;
}

/**
 * Renames a repository as its owner would on GitHub: its node ID and its
 * issues' stay, and the old name redirects until another repository takes it.
 */
export function renameGithubRepository(standIn: GithubStandIn, from: string, to: string): StandInRepository {
  const found = standIn.repositories.find((each) => `${each.owner}/${each.name}` === from);
  if (found === undefined) throw new Error(`No repository ${from}`);
  const [owner, name] = to.split("/") as [string, string];
  found.owner = owner;
  found.name = name;
  standIn.renamed.set(from.toLowerCase(), found.id);
  return found;
}

/** Makes a new repository, as when another takes a renamed repository's old name, which then no longer redirects. */
export function addGithubRepository(standIn: GithubStandIn, fullName: string, id: number): StandInRepository {
  const [owner, name] = fullName.split("/") as [string, string];
  const repository: StandInRepository = { id, owner, name, hasIssues: true, archived: false, installationId: 71, pushers: [], labels: [], templates: {} };
  standIn.repositories.push(repository);
  standIn.renamed.delete(fullName.toLowerCase());
  return repository;
}

/**
 * Transfers an issue to another repository, as a person would on GitHub: it
 * takes the next number there. `keepNode` says whether its node ID stays,
 * which GitHub doesn't document; otherwise it gets a new one and the old one
 * resolves to nothing.
 */
export function transferGithubIssue(standIn: GithubStandIn, nodeId: string, to: string, keepNode: boolean): StandInGithubIssue {
  const issue = standIn.issues.find((each) => each.nodeId === nodeId);
  const target = standIn.repositories.find((each) => `${each.owner}/${each.name}` === to);
  if (issue === undefined || target === undefined) throw new Error(`No issue ${nodeId} or repository ${to}`);
  issue.repositoryId = target.id;
  issue.number = Math.max(0, ...standIn.issues.filter((each) => each.repositoryId === target.id && each !== issue).map((each) => each.number)) + 1;
  if (!keepNode) issue.nodeId = `${nodeId}_moved`;
  issue.updatedAt = new Date(Date.parse(issue.updatedAt) + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return issue;
}

/** The `X-Hub-Signature-256` GitHub sends: `sha256=` and the hex HMAC-SHA256 of the body under the webhook's secret. */
export async function githubSignature(secret: string, body: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof body === "string" ? new TextEncoder().encode(body) : body));
  return `sha256=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A webhook delivery as GitHub sends one for an `issues` event: the JSON body
 * (the issue, its repository, the installation, and the sender) and its
 * headers, signed with `secret`.
 */
export async function githubIssueWebhook(
  secret: string,
  event: {
    action: string;
    issue: { nodeId: string; number?: number; state: "open" | "closed"; stateReason?: string | null; updatedAt: string; pullRequest?: boolean };
    event?: string;
    repository?: string;
    repositoryId?: number;
    /** For `transferred`: the issue as it is in the repository it moved to. */
    changes?: { newIssue: { nodeId: string; number: number; state: "open" | "closed"; updatedAt: string }; newRepository: { id: number; fullName: string } };
  },
): Promise<{ body: string; headers: Record<string, string> }> {
  const repository = event.repository ?? "acme/web";
  const payload = {
    action: event.action,
    issue: {
      id: 9001,
      node_id: event.issue.nodeId,
      number: event.issue.number ?? 1,
      title: "Department label is unclear",
      state: event.issue.state,
      state_reason: event.issue.stateReason ?? null,
      html_url: `https://github.com/${repository}/issues/${event.issue.number ?? 1}`,
      updated_at: event.issue.updatedAt,
      user: { login: "dana-smith" },
      ...(event.issue.pullRequest === true ? { pull_request: { url: "https://api.github.com/repos/acme/web/pulls/1" } } : {}),
    },
    repository: { id: event.repositoryId ?? 501, node_id: `R_${event.repositoryId ?? 501}`, name: repository.split("/")[1], full_name: repository },
    ...(event.changes === undefined
      ? {}
      : {
          changes: {
            new_issue: {
              node_id: event.changes.newIssue.nodeId,
              number: event.changes.newIssue.number,
              title: "Department label is unclear",
              state: event.changes.newIssue.state,
              state_reason: null,
              html_url: `https://github.com/${event.changes.newRepository.fullName}/issues/${event.changes.newIssue.number}`,
              updated_at: event.changes.newIssue.updatedAt,
            },
            new_repository: { id: event.changes.newRepository.id, node_id: `R_${event.changes.newRepository.id}`, full_name: event.changes.newRepository.fullName },
          },
        }),
    installation: { id: 71, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNzE=" },
    sender: { login: "dana-smith" },
  };
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "GitHub-Hookshot/0000000",
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-GitHub-Event": event.event ?? "issues",
      "X-GitHub-Hook-ID": "1",
      "X-GitHub-Hook-Installation-Target-ID": "1",
      "X-GitHub-Hook-Installation-Target-Type": "integration",
      "X-Hub-Signature-256": await githubSignature(secret, body),
    },
  };
}
