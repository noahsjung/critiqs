import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { STATUS_CHECK_MS } from "@critiqs/server";
import { addGithubIssue, type GithubStandIn, githubIssueWebhook, githubStandIn } from "@critiqs/server/github-standin";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";
import { thread as getThread } from "./pages";

// The attacks the security reviews of the Linear tickets port made, against
// GitHub Issues on Convex: hostile people (display names and thread text with
// Markdown and HTML, a page address the thread's author sends), a removed
// member's token, a webhook about another repository, and an unbounded body.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const SECRET = "github-webhook-secret";
const ENV = ["CRITIQS_AI_ENCRYPTION_KEY", "CRITIQS_GITHUB_WEBHOOK_SECRET", "CRITIQS_GITHUB_API_URL", "CRITIQS_GITHUB_APP_URL", "CONVEX_SITE_URL", "CRITIQS_AUTH_ISSUER"];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const failedCapture = { status: "failed" as const, failureReason: "Blocked" };

let server: ReturnType<typeof Bun.serve>;
let github: GithubStandIn;
beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => github.handle(request) });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  const origin = `http://127.0.0.1:${server.port}`;
  github = githubStandIn(origin);
  github.users.push({ id: 1003, login: "lee-park", emails: [{ email: "lee@example.com", primary: true, verified: true }] });
  github.personalTokens.set("github_pat_lee", "lee-park");
  github.personalTokens.set("github_pat_riley", "riley");
  github.repositories.find((repository) => repository.name === "web")!.pushers.push("lee-park");
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  process.env.CRITIQS_GITHUB_API_URL = origin;
  process.env.CRITIQS_GITHUB_APP_URL = origin;
  process.env.CRITIQS_GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = "https://backend.example";
  process.env.CRITIQS_AUTH_ISSUER = "https://auth.example";
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** Every link and image address a tracker would render from Markdown, web and email addresses included. */
const rendered = (markdown: string) => [...Bun.markdown.html(markdown, { autolinks: true }).matchAll(/(?:href|src)="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
/** Whether rendered Markdown has any tag other than text structure and links. */
const tags = (markdown: string) => [...Bun.markdown.html(markdown).matchAll(/<([a-z][a-z0-9]*)/gi)].map((match) => match[1]!.toLowerCase()).filter((tag) => !["p", "h1", "h2", "h3", "ul", "ol", "li", "a", "blockquote", "code", "hr", "strong", "em", "br"].includes(tag));

test("GitHub attack: display names and thread text with Markdown and HTML reach the issue and its comments as text, with only the thread's link", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity({ ...reviewer("Lee"), name: "[Admin](https://evil.example) <img src=x onerror=alert(1)>" });
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const body = "<script>alert(1)</script> [click](https://evil.example/a) ![px](https://evil.example/px.png) <b>bold</b>";
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body, tags: ["<i>Bug</i>"], capture: failedCapture });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "github" });
  await lee.action(api.tickets.create, { threadId, submissionId: crypto.randomUUID(), tracker: "github", destinationId: "acme/web", title: draft.title, body: draft.body, createdFromCritiqs: true });
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: true });
  const texts = [...github.issues.map((issue) => issue.body), ...github.comments.map((comment) => comment.body)];
  for (const text of texts) {
    expect({ text, links: rendered(text).filter((url) => !url.startsWith("https://review.example/app?")) }).toEqual({ text, links: [] });
    expect({ text, tags: tags(text) }).toEqual({ text, tags: [] });
  }
});

test("GitHub attack: without a review address or website, a ticket never links to the page its thread's author sent, nor copies its query", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype" });
  const page = "https://evil.example/critiqs-login?session=SECRET";
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor: { ...anchor, evidence: { ...anchor.evidence, url: page } }, body: "Department is wrong", tags: [], capture: failedCapture });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "github" });
  await lee.action(api.tickets.create, { threadId, submissionId: crypto.randomUUID(), tracker: "github", destinationId: "acme/web", title: draft.title, body: draft.body, createdFromCritiqs: true });
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: true });
  const texts = [...github.issues.map((issue) => issue.body), ...github.comments.map((comment) => comment.body)];
  for (const text of texts) expect({ text, links: rendered(text) }).toEqual({ text, links: [] });
  expect(JSON.stringify(texts)).not.toContain("SECRET");
});

test("GitHub attack: a status check never uses the token of someone removed from the project's organization", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const riley = t.withIdentity(reviewer("Riley"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley.mutation(api.users.sync, {});
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });
  const threadId = await riley.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await riley.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_riley" });
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Existing" });
  const link = await riley.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: false });
  const rileyId = (await t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Riley")!._id;
  await dana.mutation(api.organizations.removeMember, { organizationId: organization!.id, userId: rileyId });
  github.setState(existing.nodeId, "closed", "not_planned");
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  github.requests.length = 0;
  expect(await dana.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(github.requests).toEqual([]);
  expect((await getThread(dana, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "Open" }, statusStale: true });
});

test("GitHub attack: a signed delivery about another repository changes no link to an issue in this one", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: false });
  const deliver = (delivery: { body: string; headers: Record<string, string> }) => t.fetch("/trackers/github/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
  const other = await githubIssueWebhook(SECRET, { action: "closed", issue: { nodeId: existing.nodeId, number: 12, state: "closed", updatedAt: "2099-01-01T00:00:00Z" }, repository: "other/web" } as never);
  expect((await deliver(other)).status).toBe(200);
  expect((await getThread(dana, { threadId })).tickets?.[0]?.status?.label).toBe("Open");
  // The same change about the issue's own repository does.
  const own = await githubIssueWebhook(SECRET, { action: "closed", issue: { nodeId: existing.nodeId, number: 12, state: "closed", updatedAt: "2099-01-01T00:00:00Z" } });
  expect((await deliver(own)).status).toBe(200);
  expect((await getThread(dana, { threadId })).tickets?.[0]?.status?.label).toBe("Closed");
});

test("GitHub attack: the webhook route reads at most a megabyte of a delivery", async () => {
  const t = setup();
  const huge = "x".repeat(2 * 1024 * 1024);
  const response = await t.fetch("/trackers/github/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "issues", "X-Hub-Signature-256": "sha256=00" }, body: huge });
  expect(response.status).toBe(413);
});
