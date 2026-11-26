import { describe, expect, test } from "bun:test";
import { ticketBody, ticketLinkComment, type TicketMarkdown, type WebAddress, webAddress } from "@critiqs/core";
import { CritiqsError } from "../src/errors.ts";
import {
  creationMark,
  exchangeGithubCode,
  githubAdapter,
  githubAuthorizeUrl,
  githubInstallUrl,
  githubSearchWords,
  githubStatus,
  parseGithubTemplate,
  readGithubWebhook,
  refreshGithubToken,
} from "../src/tickets/trackers/github.ts";
import { TrackerRefusal, type TrackerToken } from "../src/tickets/trackers/index.ts";
import { addGithubIssue, type GithubStandIn, githubIssueWebhook, githubSignature, githubStandIn } from "./github-standin.ts";

// GitHub's adapter against a local stand-in for GitHub's REST and GraphQL
// APIs and its GitHub App sign-in: what it sends, how it reads GitHub's
// answers, and what people see when GitHub refuses.

/** Ticket text as Critiqs makes it, from a draft with nothing added. */
const md = (draft: string): TicketMarkdown => ticketBody(draft, { capture: null, attribution: null, link: null });
const web = (value: string): WebAddress => webAddress(value)!;

const PAT: TrackerToken = { method: "token", value: "github_pat_dana" };
const app = { clientId: "Iv1.critiqs", clientSecret: "app-secret", slug: "critiqs-test" };
const REDIRECT = "https://deployment.example/trackers/github/callback";

function setup(): { standIn: GithubStandIn; github: ReturnType<typeof githubAdapter> } {
  const standIn = githubStandIn();
  return { standIn, github: githubAdapter({ fetch: standIn.fetchFn, baseUrl: standIn.origin }) };
}

async function refusal(promise: Promise<unknown>): Promise<CritiqsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CritiqsError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs Dana in through the stand-in's GitHub App, as the callback would, and returns her tokens. */
async function signIn(standIn: GithubStandIn) {
  const verifier = "verifier-".padEnd(48, "v");
  const authorize = githubAuthorizeUrl(standIn.origin, { clientId: app.clientId, redirectUri: REDIRECT, state: "state-1", challenge: await challenge(verifier) });
  const back = new URL((await standIn.fetchFn(authorize, { redirect: "manual" })).headers.get("Location")!);
  return await exchangeGithubCode({ fetch: standIn.fetchFn, baseUrl: standIn.origin }, app, { code: back.searchParams.get("code")!, redirectUri: REDIRECT, verifier }, 1_000);
}

describe("sign-in", () => {
  test("asks GitHub for the app's sign-in with PKCE and no scopes, and links to installing the app", () => {
    const url = new URL(githubAuthorizeUrl("https://github.com", { clientId: "Iv1.x", redirectUri: REDIRECT, state: "s", challenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "Iv1.x", redirect_uri: REDIRECT, state: "s", code_challenge: "c", code_challenge_method: "S256", allow_signup: "false" });
    expect(githubInstallUrl("https://github.com", "critiqs app")).toBe("https://github.com/apps/critiqs%20app/installations/new");
  });

  test("a code becomes an 8-hour token and a refresh token, which GitHub rotates", async () => {
    const { standIn } = setup();
    const tokens = await signIn(standIn);
    expect(tokens).toEqual({ access: expect.stringMatching(/^ghu_/), refresh: expect.stringMatching(/^ghr_/), expiresAt: 1_000 + 28_800_000 });
    const endpoint = { fetch: standIn.fetchFn, baseUrl: standIn.origin };
    const next = await refreshGithubToken(endpoint, app, tokens.refresh!, 2_000);
    expect(next.access).not.toBe(tokens.access);
    expect(next.refresh).not.toBe(tokens.refresh);
    // The refresh token used is spent.
    expect((await refusal(refreshGithubToken(endpoint, app, tokens.refresh!, 3_000))).message).toBe("Your GitHub sign-in has ended. Connect GitHub again in Your trackers.");
  });

  test("a wrong verifier, a used code, or an unknown app is refused in words; GitHub answers those with 200 and an error", async () => {
    const { standIn } = setup();
    const endpoint = { fetch: standIn.fetchFn, baseUrl: standIn.origin };
    const authorize = githubAuthorizeUrl(standIn.origin, { clientId: app.clientId, redirectUri: REDIRECT, state: "s", challenge: await challenge("right-verifier") });
    const code = new URL((await standIn.fetchFn(authorize, { redirect: "manual" })).headers.get("Location")!).searchParams.get("code")!;
    expect((await refusal(exchangeGithubCode(endpoint, app, { code, redirectUri: REDIRECT, verifier: "wrong-verifier" }, 0))).message).toBe("GitHub didn't accept this sign-in. Close this window and connect GitHub again.");
    // The code is spent by any exchange, as GitHub's are.
    expect((await refusal(exchangeGithubCode(endpoint, app, { code, redirectUri: REDIRECT, verifier: "right-verifier" }, 0))).code).toBe("invalid");
    const unknown = await refusal(exchangeGithubCode(endpoint, { ...app, clientSecret: "nope" }, { code: "x", redirectUri: REDIRECT, verifier: "v" }, 0));
    expect(unknown.code).toBe("unavailable");
    expect(unknown.message).toContain("CRITIQS_GITHUB_CLIENT_ID and CRITIQS_GITHUB_CLIENT_SECRET");
  });

  test("the person declining sends them back with an error and no code", async () => {
    const { standIn } = setup();
    standIn.signInAs = null;
    const authorize = githubAuthorizeUrl(standIn.origin, { clientId: app.clientId, redirectUri: REDIRECT, state: "s", challenge: "c" });
    const back = new URL((await standIn.fetchFn(authorize, { redirect: "manual" })).headers.get("Location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });
});

describe("accounts and destinations", () => {
  test("verify reads a sign-in's verified emails, primary first; a pasted token's needn't be readable", async () => {
    const { standIn, github } = setup();
    const tokens = await signIn(standIn);
    expect(await github.verify({ method: "oauth", value: tokens.access })).toEqual({ accountId: "1001", accountName: "dana-smith", emails: ["dana@personal.example", "dana@example.com"], site: null });
    expect(await github.verify(PAT)).toEqual({ accountId: "1001", accountName: "dana-smith", emails: [], site: null });
    expect(standIn.requests.filter((request) => request.endsWith("/user/emails"))).toHaveLength(1);
  });

  test("a token GitHub doesn't accept is refused in words that say what to do, never echoing it", async () => {
    const { github } = setup();
    const pasted = await refusal(github.verify({ method: "token", value: "github_pat_wrong" }));
    expect(pasted).toBeInstanceOf(TrackerRefusal);
    expect(pasted.message).toBe("GitHub didn't accept this token. Check that you copied all of it and that it hasn't expired, or create a new one.");
    expect(pasted.message).not.toContain("github_pat_wrong");
    expect((await refusal(github.verify({ method: "oauth", value: "ghu_expired" }))).message).toBe("GitHub no longer accepts Critiqs's sign-in. Connect GitHub again in Your trackers.");
  });

  test("every request names Critiqs, the API version, and the token as a bearer token", async () => {
    const { standIn, github } = setup();
    const seen: Request[] = [];
    const watched = githubAdapter({ fetch: (async (input: string, init?: RequestInit) => (seen.push(new Request(input, init)), standIn.fetchFn(input, init))) as typeof fetch, baseUrl: standIn.origin });
    await watched.verify(PAT);
    expect(seen[0]!.headers.get("Authorization")).toBe("Bearer github_pat_dana");
    expect(seen[0]!.headers.get("User-Agent")).toBe("Critiqs");
    expect(seen[0]!.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(seen[0]!.headers.get("Accept")).toBe("application/vnd.github+json");
    void github;
  });

  test("a sign-in's destinations are the repositories where the app is installed and that take issues; a pasted token's, every repository it reaches", async () => {
    const { standIn, github } = setup();
    const tokens = await signIn(standIn);
    expect(await github.destinations({ method: "oauth", value: tokens.access })).toEqual([
      { id: "acme/api", name: "acme/api", key: null },
      { id: "acme/web", name: "acme/web", key: null },
    ]);
    expect((await github.destinations(PAT)).map((destination) => destination.id)).toEqual(["acme/api", "acme/web", "dana-smith/notes"]);
  });

  test("a limit GitHub answers with, by 429 or a 403 with no requests left, is a refusal to try again later", async () => {
    const { standIn, github } = setup();
    standIn.intercept = () => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const limited = await refusal(github.destinations(PAT));
    expect([limited.code, limited.message]).toEqual(["limit", "GitHub is limiting requests right now. Try again in a minute."]);
    standIn.intercept = () => Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 429, headers: { "retry-after": "60" } });
    expect((await refusal(github.destinations(PAT))).code).toBe("limit");
    standIn.intercept = () => new Response("<html>unicorn</html>", { status: 502 });
    expect((await refusal(github.destinations(PAT))).message).toBe("GitHub's answer wasn't what Critiqs expected (status 502). Try again in a moment.");
  });
});

describe("finding and reading issues", () => {
  test("search finds an issue by its address or key, then by words, only in the person's repositories, never a pull request", async () => {
    const { standIn, github } = setup();
    const label = addGithubIssue(standIn, "acme/web", { number: 12, title: "Department label is unclear" });
    addGithubIssue(standIn, "acme/web", { number: 13, title: "Department label PR", pullRequest: true });
    addGithubIssue(standIn, "acme/api", { number: 4, title: "Department endpoint", state: "closed", stateReason: "not_planned" });
    const byAddress = await github.search(PAT, `${standIn.origin}/acme/web/issues/12`);
    expect(byAddress).toEqual([{ tracker: "github", externalId: label.nodeId, key: "web#12", url: `${standIn.origin}/acme/web/issues/12`, title: "Department label is unclear", status: { label: "Open", category: "open" } }]);
    expect((await github.search(PAT, "acme/web#12")).map((issue) => issue.key)).toEqual(["web#12"]);
    expect((await github.search(PAT, "web#12")).map((issue) => issue.key)).toEqual(["web#12"]);
    // A pull request's number isn't an issue.
    expect(await github.search(PAT, "acme/web#13")).toEqual([]);
    const words = await github.search(PAT, "department");
    expect(words.map((issue) => [issue.key, issue.status.label])).toEqual([
      ["web#12", "Open"],
      ["api#4", "Closed as not planned"],
    ]);
  });

  test("search words are quoted literally, so what a person types never becomes a qualifier or an operator; an app's token always sends is:issue", async () => {
    expect(githubSearchWords('label repo:evil/secret OR "x\\" is:pr')).toBe('"label" "repo:evil/secret" "OR" "x" "is:pr"');
    expect(githubSearchWords(' "" \\ ')).toBe("");
    const { standIn, github } = setup();
    const tokens = await signIn(standIn);
    const queries: string[] = [];
    standIn.intercept = (method, path) => {
      if (path === "/search/issues") queries.push(method);
      return undefined;
    };
    const seen: string[] = [];
    const watched = githubAdapter({ fetch: (async (input: string, init?: RequestInit) => (seen.push(String(input)), standIn.fetchFn(input, init))) as typeof fetch, baseUrl: standIn.origin });
    await watched.search({ method: "oauth", value: tokens.access }, 'label repo:dana-smith/notes OR');
    const q = new URL(seen.find((address) => address.includes("/search/issues"))!).searchParams.get("q")!;
    expect(q).toBe('"label" "repo:dana-smith/notes" "OR" is:issue repo:acme/api repo:acme/web');
    expect(queries).toEqual(["GET"]);
    void github;
  });

  test("get and status read an issue by its node ID; one the person can't see, or GitHub deleted, is refused", async () => {
    const { standIn, github } = setup();
    const issue = addGithubIssue(standIn, "acme/web", { number: 3, title: "Footer", updatedAt: "2026-02-01T00:00:00Z" });
    expect(await github.get(PAT, issue.nodeId)).toEqual({
      tracker: "github",
      externalId: issue.nodeId,
      key: "web#3",
      url: `${standIn.origin}/acme/web/issues/3`,
      title: "Footer",
      status: { label: "Open", category: "open" },
      site: "acme/web",
      asOf: Date.parse("2026-02-01T00:00:00Z"),
    });
    standIn.setState(issue.nodeId, "closed", "completed");
    const ref = { tracker: "github" as const, externalId: issue.nodeId, key: "web#3", url: `${standIn.origin}/acme/web/issues/3`, title: "Footer", site: "acme/web" };
    expect(await github.status(PAT, ref)).toEqual({ status: { label: "Closed", category: "done" }, asOf: Date.parse("2026-02-01T00:00:01Z"), place: { key: "web#3", url: `${standIn.origin}/acme/web/issues/3`, title: "Footer", site: "acme/web" } });
    issue.deleted = true;
    expect((await refusal(github.status(PAT, ref))).code).toBe("not-found");
    expect((await refusal(github.get(PAT, "I_kwNothing"))).message).toBe("GitHub can't find this issue, or you can't see it.");
    expect((await refusal(github.get(PAT, "not a node id!"))).code).toBe("not-found");
  });

  test("GitHub's states and reasons become Critiqs's status categories", () => {
    expect(githubStatus("open", null)).toEqual({ label: "Open", category: "open" });
    expect(githubStatus("OPEN", "REOPENED")).toEqual({ label: "Open", category: "open" });
    expect(githubStatus("closed", "completed")).toEqual({ label: "Closed", category: "done" });
    expect(githubStatus("closed", null)).toEqual({ label: "Closed", category: "done" });
    expect(githubStatus("CLOSED", "NOT_PLANNED")).toEqual({ label: "Closed as not planned", category: "canceled" });
    expect(githubStatus("closed", "duplicate")).toEqual({ label: "Closed as duplicate", category: "canceled" });
    expect(githubStatus("merged", null)).toEqual({ label: "Unknown", category: "unknown" });
  });
});

describe("creating", () => {
  const input = (overrides: Partial<Parameters<ReturnType<typeof githubAdapter>["create"]>[1]> = {}) => ({
    destinationId: "acme/web",
    title: "Department label is unclear",
    body: md("> The label is unclear.\n"),
    labels: [],
    templateId: null,
    creationId: "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b",
    ...overrides,
  });

  test("create sends the title and the text with the creation's mark first, and reads the issue back", async () => {
    const { standIn, github } = setup();
    const outcome = await github.create(PAT, input({ labels: ["bug"] }));
    expect(outcome.status).toBe("created");
    const [made] = standIn.issues;
    expect(made!.body).toBe(`${creationMark("6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b")}\n\n> The label is unclear.\n`);
    expect(made!.labels).toEqual(["bug"]);
    if (outcome.status === "created") expect(outcome.ticket).toMatchObject({ key: "web#1", externalId: made!.nodeId, status: { label: "Open", category: "open" }, site: "acme/web" });
  });

  test("a draft ending inside a code fence can't swallow the mark, which goes first", async () => {
    const { standIn, github } = setup();
    await github.create(PAT, input({ body: md("```\nstill code") }));
    expect(standIn.issues[0]!.body.startsWith("<!-- critiqs-creation: ")).toBe(true);
  });

  test("labels from someone without push access are dropped by GitHub, as it documents; the issue is still made", async () => {
    const { standIn, github } = setup();
    const outcome = await github.create(PAT, input({ destinationId: "acme/api", labels: ["bug"] }));
    expect(outcome.status).toBe("created");
    expect(standIn.issues[0]!.labels).toEqual([]);
  });

  test("a template's own labels are added, only those the repository has", async () => {
    const { standIn, github } = setup();
    await github.create(PAT, input({ templateId: "acme/web:feature.md", labels: ["bug"] }));
    // The feature template names enhancement and wording; the repository has both (Wording in its own case).
    expect(standIn.issues[0]!.labels).toEqual(["bug", "enhancement", "Wording"]);
    const gone = await github.create(PAT, input({ templateId: "acme/web:gone.md" }));
    expect(gone.status).toBe("refused");
    const elsewhere = await github.create(PAT, input({ templateId: "acme/api:feature.md" }));
    expect(elsewhere.status).toBe("refused");
    expect(standIn.issues).toHaveLength(1);
  });

  test("create says whether GitHub refused, so nothing was made, or the outcome is unknown", async () => {
    const { standIn, github } = setup();
    const disabled = await github.create(PAT, input({ destinationId: "acme/docs" }));
    expect(disabled.status === "refused" && disabled.error.message).toBe("Issues are turned off in this repository. Choose another.");
    const missing = await github.create(PAT, input({ destinationId: "acme/nowhere" }));
    expect(missing.status === "refused" && missing.error.message).toBe("GitHub can't find this repository, or you can't create issues in it. Choose another.");
    const invalid = await github.create(PAT, input({ title: "" }));
    expect(invalid.status === "refused" && invalid.error.message).toBe("GitHub turned this down: Validation Failed: title missing_field.");
    const notRepository = await github.create(PAT, input({ destinationId: "../../user" }));
    expect(notRepository.status).toBe("refused");
    expect(standIn.issues).toHaveLength(0);
    // GitHub made the issue, but the answer was lost.
    standIn.intercept = (method, path) => (method === "POST" && path === "/repos/acme/web/issues" ? "after" : undefined);
    const lost = await github.create(PAT, input());
    expect(lost.status).toBe("unknown");
    expect(standIn.issues).toHaveLength(1);
    standIn.intercept = () => {
      throw new Error("network down");
    };
    expect((await github.create(PAT, input())).status).toBe("unknown");
  });

  test("an unknown creation's issue is found by its mark among the person's issues changed since it was submitted, in the repository it was submitted to", async () => {
    const { standIn, github } = setup();
    const creationId = "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b";
    const since = Date.now();
    addGithubIssue(standIn, "acme/web", { number: 1, title: "Someone else's", body: creationMark(creationId), creator: "riley", updatedAt: new Date(since).toISOString() });
    const found = { creationId, link: web("https://review.example/?critiqs=t1"), destinationId: "acme/web", since };
    expect(await github.findCreated(PAT, found)).toBeNull();
    standIn.intercept = (method, path) => (method === "POST" && path === "/repos/acme/web/issues" ? "after" : undefined);
    await github.create(PAT, input({ creationId }));
    standIn.intercept = null;
    expect((await github.findCreated(PAT, found))?.key).toBe("web#2");
    // Not in another repository, and not among issues older than the creation.
    expect(await github.findCreated(PAT, { ...found, destinationId: "acme/api" })).toBeNull();
    expect(await github.findCreated(PAT, { ...found, since: since + 3_600_000 })).toBeNull();
  });
});

describe("links back and comments", () => {
  test("a created issue has the link in its text already, so no comment is added; a linked one gets one comment, however often it is linked", async () => {
    const { standIn, github } = setup();
    const link = { url: web("https://review.example/page?critiqs=t1&view=2"), title: "The label" };
    const body = ticketBody("Text", { capture: null, attribution: { name: "Dana" }, link: link.url });
    const outcome = await github.create(PAT, { destinationId: "acme/web", title: "T", body, labels: [], templateId: null, creationId: "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b" });
    if (outcome.status !== "created") throw new Error("not created");
    await github.linkBack(PAT, outcome.ticket, link);
    expect(standIn.comments).toEqual([]);

    const existing = addGithubIssue(standIn, "acme/web", { number: 7, title: "Existing" });
    const ref = { tracker: "github" as const, externalId: existing.nodeId, key: "web#7", url: web(`${standIn.origin}/acme/web/issues/7`), title: "Existing", site: "acme/web" };
    await github.linkBack(PAT, ref, link);
    await github.linkBack(PAT, ref, link);
    expect(standIn.comments).toEqual([{ issueNodeId: existing.nodeId, body: "> The label\n\nThread: [open the thread](<https://review.example/page?critiqs=t1&amp;view=2>)\n", user: "dana-smith" }]);
    await github.comment(PAT, ref, ticketLinkComment("Summary", { link: null, attribution: null }));
    expect(standIn.comments.at(-1)).toEqual({ issueNodeId: existing.nodeId, body: "> Summary\n", user: "dana-smith" });
  });

  test("a link back or comment on an issue GitHub no longer has is a refusal, so nothing was written", async () => {
    const { standIn, github } = setup();
    const existing = addGithubIssue(standIn, "acme/web", { number: 7, title: "Existing", deleted: true });
    const ref = { tracker: "github" as const, externalId: existing.nodeId, key: "web#7", url: web(`${standIn.origin}/acme/web/issues/7`), title: "Existing", site: "acme/web" };
    expect(await refusal(github.linkBack(PAT, ref, { url: web("https://review.example/"), title: "t" }))).toBeInstanceOf(TrackerRefusal);
    expect(await refusal(github.comment(PAT, ref, ticketLinkComment("x", { link: null, attribution: null })))).toBeInstanceOf(TrackerRefusal);
  });
});

describe("templates and labels", () => {
  test("templates are each repository's issue forms and Markdown templates, by name, skipping config.yml", async () => {
    const { standIn, github } = setup();
    const tokens = await signIn(standIn);
    expect(await github.templates!({ method: "oauth", value: tokens.access })).toEqual([
      {
        destination: { id: "acme/web", name: "acme/web", key: null },
        templates: [
          { id: "acme/web:bug.yml", name: "Bug report" },
          { id: "acme/web:feature.md", name: "Feature request" },
        ],
      },
    ]);
    expect(await github.templates!(PAT, "acme/api")).toEqual([]);
  });

  test("a repository without a template folder uses its owner's .github repository's templates, as GitHub does; one with its own doesn't", async () => {
    const { standIn, github } = setup();
    standIn.repositories.push({
      id: 510, owner: "acme", name: ".github", hasIssues: true, archived: false, installationId: 71, pushers: ["dana-smith"], labels: ["bug"],
      templates: { "org-bug.md": "---\nname: Organization bug\nlabels: [bug, missing]\n---\n## What broke\n" },
    });
    const tokens = await signIn(standIn);
    const groups = await github.templates!({ method: "oauth", value: tokens.access });
    // acme/api has no folder: the organization's template, marked as from acme/.github. acme/web keeps its own.
    expect(groups.find((group) => group.destination.id === "acme/api")).toEqual({
      destination: { id: "acme/api", name: "acme/api", key: null },
      templates: [{ id: "acme/.github:org-bug.md", name: "Organization bug" }],
      from: "acme/.github",
    });
    expect(groups.find((group) => group.destination.id === "acme/web")!.templates.map((template) => template.id)).toEqual(["acme/web:bug.yml", "acme/web:feature.md"]);
    expect(groups.find((group) => group.destination.id === "acme/web")!.from).toBeUndefined();
    // Read for a draft in acme/api, it applies; in acme/web, which has its own, or another owner's repository, it doesn't.
    expect(await github.template!(PAT, "acme/.github:org-bug.md", "acme/api")).toEqual({ id: "acme/.github:org-bug.md", name: "Organization bug", destinationId: "acme/api", body: "## What broke\n" });
    expect(await github.template!(PAT, "acme/.github:org-bug.md", "acme/web")).toBeNull();
    expect(await github.template!(PAT, "acme/.github:org-bug.md", "dana-smith/notes")).toBeNull();
    expect(await github.template!(PAT, "acme/web:bug.yml", "acme/api")).toBeNull();
    // Created from it in acme/api, the issue gets the template's labels that acme/api has (Dana can push there).
    standIn.repositories.find((repository) => repository.name === "api")!.pushers.push("dana-smith");
    const created = await github.create(PAT, { destinationId: "acme/api", title: "T", body: md("B"), labels: [], templateId: "acme/.github:org-bug.md", creationId: "6f1c2b9a-3d4e-4f50-8a1b-000000000001" });
    expect(created.status).toBe("created");
    expect(standIn.issues.at(-1)?.labels).toEqual(["bug"]);
    // In acme/web it is refused before GitHub is asked to create anything.
    const before = standIn.issues.length;
    expect((await github.create(PAT, { destinationId: "acme/web", title: "T", body: md("B"), labels: [], templateId: "acme/.github:org-bug.md", creationId: "6f1c2b9a-3d4e-4f50-8a1b-000000000002" })).status).toBe("refused");
    expect(standIn.issues.length).toBe(before);
  });

  test("an issue form reads as the Markdown GitHub writes from it: each field's label a heading, preset values, a checkbox per option of a checkbox or dropdown field", async () => {
    const { github } = setup();
    expect(await github.template!(PAT, "acme/web:bug.yml", "acme/web")).toEqual({
      id: "acme/web:bug.yml",
      name: "Bug report",
      destinationId: "acme/web",
      body: "### What happened?\n\n### Version\n\n1\\.0\n\n### Which browsers?\n\n- [ ] Firefox\n- [ ] Chrome\n\n### Code of Conduct\n\n- [ ] I agree to follow this project's Code of Conduct\n",
    });
    expect((await github.template!(PAT, "acme/web:feature.md", "acme/web"))?.body).toBe("## Problem\n\n## Proposal\n");
    expect(await github.template!(PAT, "acme/web:gone.md", "acme/web")).toBeNull();
    expect(await github.template!(PAT, "acme/web:config.yml", "acme/web")).toBeNull();
    expect(await github.template!(PAT, "../etc:passwd.md", "acme/web")).toBeNull();
  });

  test("an issue form's literal text stays literal: labels and one-line answers as text, and a field GitHub renders as code in a code block", () => {
    const form = [
      "name: Literal",
      "body:",
      "  - type: textarea",
      "    attributes:",
      '      label: "Version *beta* <b>x</b>"',
      '      value: "Version *beta*\\n```\\n<script>"',
      "      render: text",
      "  - type: input",
      "    attributes:",
      '      label: "Where [link](https://x.example)"',
      '      value: "<b>1.2</b> *x* [y](https://y.example)"',
      "  - type: textarea",
      "    attributes:",
      "      label: Steps",
      '      value: "1. Do *this*"',
      "  - type: checkboxes",
      "    attributes:",
      "      label: Terms",
      "      options:",
      '        - label: "I agree to the **Code of Conduct**"',
      "  - type: dropdown",
      "    attributes:",
      '      label: "OS <i>any</i>"',
      "      options: [Linux, macOS]",
    ].join("\n");
    const parsed = parseGithubTemplate("literal.yml", form);
    expect(parsed).not.toBeNull();
    const html = Bun.markdown.html(parsed!.body);
    // Labels: headings with the label's characters as text, no emphasis, link, or HTML.
    expect(html).toContain("<h3>Version *beta* &lt;b&gt;x&lt;/b&gt;</h3>");
    expect(html).toContain("<h3>Where [link](https://x.example)</h3>");
    expect(html).toContain("<h3>OS &lt;i&gt;any&lt;/i&gt;</h3>");
    // A field GitHub renders as code (`render`) is a code block in that language, whatever its text holds.
    expect(html).toContain('<pre><code class="language-text">Version *beta*\n```\n&lt;script&gt;\n</code></pre>');
    // A one-line answer is text.
    expect(html).toContain("<p>&lt;b&gt;1.2&lt;/b&gt; *x* [y](https://y.example)</p>");
    // A textarea's preset text, like a Markdown template, and a checkbox's label, which GitHub's forms render as Markdown, keep their formatting.
    expect(html).toContain("<em>this</em>");
    expect(html).toContain("<strong>Code of Conduct</strong>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain('href="https://x.example"');
    expect(html).not.toContain('href="https://y.example"');
  });

  test("template files GitHub wouldn't offer are skipped", () => {
    expect(parseGithubTemplate("x.md", "No front matter")).toBeNull();
    expect(parseGithubTemplate("x.md", "---\nabout: no name\n---\nBody")).toBeNull();
    expect(parseGithubTemplate("x.yml", "name: [unclosed")).toBeNull();
    expect(parseGithubTemplate("x.yml", "name: Form\ndescription: d\n")).toBeNull();
    expect(parseGithubTemplate("x.yaml", "name: Form\ndescription: d\nlabels: a, b\nbody:\n  - type: markdown\n    attributes:\n      value: Hi\n")).toEqual({ name: "Form", labels: ["a", "b"], body: "" });
  });

  test("labels are the repository's, by name, which is how GitHub takes them", async () => {
    const { github } = setup();
    expect(await github.labels!(PAT, "acme/web")).toEqual([
      { id: "bug", name: "bug", exclusiveGroup: null },
      { id: "Wording", name: "Wording", exclusiveGroup: null },
      { id: "enhancement", name: "enhancement", exclusiveGroup: null },
    ]);
  });
});

describe("GitHub webhooks", () => {
  const secret = "github-webhook-secret";
  const bytes = (body: string) => new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>;
  /** A moment after the deliveries below were sent. */
  const NOW = Date.parse("2026-03-01T12:00:00Z");

  test("the signature is GitHub's documented one: sha256= and the hex HMAC of the exact body", async () => {
    expect(await githubSignature("It's a Secret to Everybody", "Hello, World!")).toBe("sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  });

  test("a signed issues event becomes the issue's status as of the issue's own update time", async () => {
    const { body, headers } = await githubIssueWebhook(secret, { action: "closed", issue: { nodeId: "I_1", state: "closed", stateReason: "completed", updatedAt: "2026-03-01T10:00:00Z" } });
    expect(await readGithubWebhook(secret, bytes(body), headers["X-Hub-Signature-256"]!, "issues", NOW)).toEqual({
      status: "update",
      update: {
        tracker: "github",
        externalId: "I_1",
        site: "acme/web",
        status: { label: "Closed", category: "done" },
        asOf: Date.parse("2026-03-01T10:00:00Z"),
        deleted: false,
        // The node ID is the issue wherever it is; where it is, GitHub's page worked out from the signed repository and number.
        idAcrossSites: true,
        place: { key: "web#1", url: "https://github.com/acme/web/issues/1", title: "Department label is unclear", site: "acme/web" },
      },
    });
    const reopened = await githubIssueWebhook(secret, { action: "reopened", issue: { nodeId: "I_1", state: "open", stateReason: "reopened", updatedAt: "2026-03-01T11:00:00Z" } });
    const read = await readGithubWebhook(secret, bytes(reopened.body), reopened.headers["X-Hub-Signature-256"]!, "issues", NOW);
    expect(read.status === "update" && read.update.status).toEqual({ label: "Open", category: "open" });
  });

  test("a deleted issue counts as canceled, labeled Deleted", async () => {
    const { body, headers } = await githubIssueWebhook(secret, { action: "deleted", issue: { nodeId: "I_1", state: "open", updatedAt: "2026-03-01T10:00:00Z" } });
    const read = await readGithubWebhook(secret, bytes(body), headers["X-Hub-Signature-256"]!, "issues", NOW);
    expect(read.status === "update" && read.update).toMatchObject({ status: { label: "Deleted", category: "canceled" }, deleted: true });
  });

  test("a delivery is used only as of the time GitHub signed into it: one without the issue's update time, or one whose update is over a day old, changes nothing", async () => {
    const sent = Date.parse("2026-03-01T10:00:00Z");
    const at = (updatedAt: string, action = "closed") => githubIssueWebhook(secret, { action, issue: { nodeId: "I_1", state: "closed", stateReason: "completed", updatedAt } });
    const read = async (delivery: { body: string; headers: Record<string, string> }, now: number) => await readGithubWebhook(secret, bytes(delivery.body), delivery.headers["X-Hub-Signature-256"]!, "issues", now);
    // Sent a moment after the change: used.
    expect((await read(await at("2026-03-01T10:00:00Z"), sent + 5_000)).status).toBe("update");
    // The same signed delivery sent again two days later, such as a recorded one: not used.
    expect(await read(await at("2026-03-01T10:00:00Z"), sent + 2 * 86_400_000)).toEqual({ status: "ignored" });
    // A deletion without the issue's own time can't be placed in order, so it isn't used as of whenever it arrives.
    const deletion = await at("not a time", "deleted");
    expect(await read(deletion, sent)).toEqual({ status: "ignored" });
    // A deletion with it is used, however long ago the issue last changed: GitHub never brings a deleted issue's ID back.
    const deleted = await read(await at("2025-01-01T00:00:00Z", "deleted"), sent);
    expect(deleted.status === "update" && deleted.update).toMatchObject({ deleted: true, asOf: Date.parse("2025-01-01T00:00:00Z") });
  });

  test("a wrong, missing, or malformed signature, or a body changed after signing, is refused before the body is read", async () => {
    const { body, headers } = await githubIssueWebhook(secret, { action: "closed", issue: { nodeId: "I_1", state: "closed", updatedAt: "2026-03-01T10:00:00Z" } });
    const signature = headers["X-Hub-Signature-256"]!;
    expect((await readGithubWebhook("another-secret", bytes(body), signature, "issues", NOW)).status).toBe("refused");
    expect((await readGithubWebhook(secret, bytes(body), null, "issues", NOW)).status).toBe("refused");
    expect((await readGithubWebhook(secret, bytes(body), signature.slice("sha256=".length), "issues", NOW)).status).toBe("refused");
    expect((await readGithubWebhook(secret, bytes(body), "sha1=abc", "issues", NOW)).status).toBe("refused");
    expect((await readGithubWebhook(secret, bytes(body.replace("closed", "open")), signature, "issues", NOW)).status).toBe("refused");
    // Signed bytes that aren't UTF-8 are refused, never replaced.
    const invalid = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect(await readGithubWebhook(secret, invalid, await githubSignature(secret, invalid), "issues", NOW)).toEqual({ status: "refused", reason: "unreadable body" });
  });

  test("other events, pull requests, and transfers are ignored", async () => {
    const ping = await githubIssueWebhook(secret, { action: "created", issue: { nodeId: "I_1", state: "open", updatedAt: "2026-03-01T10:00:00Z" }, event: "ping" });
    expect(await readGithubWebhook(secret, bytes(ping.body), ping.headers["X-Hub-Signature-256"]!, "ping", NOW)).toEqual({ status: "ignored" });
    const pull = await githubIssueWebhook(secret, { action: "closed", issue: { nodeId: "PR_1", state: "closed", updatedAt: "2026-03-01T10:00:00Z", pullRequest: true } });
    expect(await readGithubWebhook(secret, bytes(pull.body), pull.headers["X-Hub-Signature-256"]!, "issues", NOW)).toEqual({ status: "ignored" });
    const moved = await githubIssueWebhook(secret, { action: "transferred", issue: { nodeId: "I_1", state: "open", updatedAt: "2026-03-01T10:00:00Z" } });
    expect(await readGithubWebhook(secret, bytes(moved.body), moved.headers["X-Hub-Signature-256"]!, "issues", NOW)).toEqual({ status: "ignored" });
  });
});

describe("ending a sign-in", () => {
  test("GitHub's grant is deleted only when asked right before each deletion, the one after refreshing an expired token too", async () => {
    const { standIn } = setup();
    const { ticketsDeploymentFromEnv, trackerSignIn } = await import("../src/tickets/accounts.ts");
    const deployment = ticketsDeploymentFromEnv({
      CRITIQS_AI_ENCRYPTION_KEY: "operator-encryption-key-".padEnd(48, "x"),
      CRITIQS_GITHUB_CLIENT_ID: app.clientId,
      CRITIQS_GITHUB_CLIENT_SECRET: app.clientSecret,
      CRITIQS_GITHUB_APP_SLUG: app.slug,
      CRITIQS_GITHUB_API_URL: standIn.origin,
      CRITIQS_GITHUB_APP_URL: standIn.origin,
    });
    const end = trackerSignIn("github", deployment)!.end!;
    const deletions = () => standIn.requests.filter((request) => request.endsWith("/grant")).length;
    // Another Critiqs account uses the grant: nothing is deleted.
    let tokens = await signIn(standIn);
    expect(await end(tokens, standIn.fetchFn, 1_000, async () => false)).toBe("shared");
    expect(deletions()).toBe(0);
    expect(standIn.accessTokens.has(tokens.access)).toBe(true);
    // The access token expired: GitHub turns the first deletion down, Critiqs refreshes, and asks again before the second,
    // when a sign-in to that GitHub account has finished meanwhile.
    standIn.accessTokens.get(tokens.access)!.expiresAt = 0;
    const asked: boolean[] = [];
    expect(await end(tokens, standIn.fetchFn, 1_000, async () => (asked.push(asked.length === 0), asked.at(-1)!))).toBe("shared");
    expect(asked).toEqual([true, false]);
    expect(deletions()).toBe(1);
    // Free to end: deleted.
    tokens = await signIn(standIn);
    expect(await end(tokens, standIn.fetchFn, 1_000, async () => true)).toBe(true);
    expect(standIn.accessTokens.has(tokens.access)).toBe(false);
  });
});

describe("drafting with an issue form", () => {
  test("Critiqs AI is asked to fill only a form's free-text fields: its checkbox and dropdown fields are left for the person to tick", async () => {
    const { ticketDraftRequest } = await import("../src/tickets/drafts.ts");
    const { ticketOutline } = await import("@critiqs/core");
    const form = parseGithubTemplate("bug.yml", (await import("./github-standin.ts")).GITHUB_BUG_FORM)!;
    const outline = ticketOutline(form.body);
    const request = JSON.stringify(ticketDraftRequest({ thread: "Dana: the button is grey", template: { name: form.name, body: form.body }, outline }));
    expect(request).toContain('Sections: [\\"What happened?\\",\\"Version\\"]');
    expect(request).not.toContain('\\"enum\\":[\\"What happened?\\",\\"Version\\",\\"Which browsers?\\"');
  });
});
