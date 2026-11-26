import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { STATUS_CHECK_MS } from "@critiqs/server";
import { addJiraIssue, adfText, JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, type JiraStandIn, jiraIssueWebhook, jiraStandIn, jiraTimestamp } from "@critiqs/server/jira-standin";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";
import { thread as getThread } from "./pages";

// The attacks the security reviews of the Linear tickets port made, against
// Jira Cloud on Convex: hostile people (display names and thread text with
// Markdown and HTML, a page address the thread's author sends), a removed
// member's token, a webhook from another site, and an unbounded body.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const SITE = "https://backend.example";
const ENV = ["CRITIQS_AI_ENCRYPTION_KEY", "CRITIQS_JIRA_CLIENT_ID", "CRITIQS_JIRA_CLIENT_SECRET", "CRITIQS_JIRA_API_URL", "CRITIQS_JIRA_AUTH_URL", "CRITIQS_JIRA_SITES_URL", "CONVEX_SITE_URL", "CRITIQS_AUTH_ISSUER"];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const failedCapture = { status: "failed" as const, failureReason: "Blocked" };

let server: ReturnType<typeof Bun.serve>;
let jira: JiraStandIn;
beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => jira.handle(request) });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  const origin = `http://127.0.0.1:${server.port}`;
  jira = jiraStandIn({
    users: [
      { accountId: "557058:lee", email: "lee@example.com", name: "Lee Park", apiToken: "ATATT-lee" },
      { accountId: "557058:riley", email: "riley@example.com", name: "Riley", apiToken: "ATATT-riley" },
    ],
  });
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  process.env.CRITIQS_JIRA_API_URL = origin;
  process.env.CRITIQS_JIRA_AUTH_URL = origin;
  process.env.CRITIQS_JIRA_SITES_URL = origin;
  process.env.CONVEX_SITE_URL = SITE;
  process.env.CRITIQS_AUTH_ISSUER = "https://auth.example";
  process.env.CRITIQS_JIRA_CLIENT_ID = JIRA_STANDIN_CLIENT_ID;
  process.env.CRITIQS_JIRA_CLIENT_SECRET = JIRA_STANDIN_SECRET;
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** Every link mark a Jira document carries. */
function links(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const record = node as { marks?: { type: string; attrs?: { href?: string } }[]; content?: unknown[] };
    for (const mark of record.marks ?? []) if (mark.type === "link") found.push(mark.attrs?.href ?? "");
    for (const child of record.content ?? []) walk(child);
  };
  walk(document);
  return found;
}

/** Connects `who`'s Jira with a pasted API token on the stand-in's site. */
const connect = (who: ReturnType<ReturnType<typeof setup>["withIdentity"]>, token: string, email: string) =>
  who.action(api.trackers.connectWithToken, { tracker: "jira", token, email, site: "acme" });

test("Jira attack: display names and thread text with Markdown and HTML reach the issue and its comments as text, with only the thread's link", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity({ ...reviewer("Lee"), name: "[Admin](https://evil.example) <img src=x onerror=alert(1)>" });
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const body = "<script>alert(1)</script> [click](https://evil.example/a) ![px](https://evil.example/px.png) <b>bold</b>";
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body, tags: [], capture: failedCapture });
  await connect(lee, "ATATT-lee", "lee@example.com");
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "jira" });
  await lee.action(api.tickets.create, { threadId, submissionId: crypto.randomUUID(), tracker: "jira", destinationId: "10001/10010", title: draft.title, body: draft.body, createdFromCritiqs: true });
  const existing = addJiraIssue(jira, { summary: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, comment: true });
  const documents = [...jira.issues.map((issue) => issue.description), ...jira.comments.map((comment) => comment.body)].filter((document) => document !== null && document !== undefined);
  expect(documents.length).toBeGreaterThan(1);
  for (const document of documents) {
    expect(links(document).filter((url) => !url.startsWith("https://review.example/app?"))).toEqual([]);
  }
  // Nothing is lost: the people's text is there as they wrote it.
  const text = documents.map(adfText).join("\n");
  expect(text).toContain("<script>alert(1)</script>");
  expect(text).toContain("[Admin](https://evil.example)");
});

test("Jira attack: without a review address or website, a ticket never links to the page its thread's author sent, nor copies its query", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype" });
  const page = "https://evil.example/critiqs-login?session=SECRET";
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor: { ...anchor, evidence: { ...anchor.evidence, url: page } }, body: "Department is wrong", tags: [], capture: failedCapture });
  await connect(lee, "ATATT-lee", "lee@example.com");
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "jira" });
  await lee.action(api.tickets.create, { threadId, submissionId: crypto.randomUUID(), tracker: "jira", destinationId: "10001/10010", title: draft.title, body: draft.body, createdFromCritiqs: true });
  const existing = addJiraIssue(jira, { summary: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, comment: true });
  for (const document of [...jira.issues.map((issue) => issue.description), ...jira.comments.map((comment) => comment.body)]) expect(links(document)).toEqual([]);
  expect(jira.remoteLinks).toEqual([]);
  expect(JSON.stringify({ issues: jira.issues, comments: jira.comments })).not.toContain("SECRET");
});

test("Jira attack: a status check never uses the token of someone removed from the project's organization", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const riley = t.withIdentity(reviewer("Riley"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley.mutation(api.users.sync, {});
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });
  const threadId = await riley.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await connect(riley, "ATATT-riley", "riley@example.com");
  const existing = addJiraIssue(jira, { summary: "Existing", status: { name: "To Do", categoryKey: "new" } });
  const link = await riley.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, comment: false });
  const rileyId = (await t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Riley")!._id;
  await dana.mutation(api.organizations.removeMember, { organizationId: organization!.id, userId: rileyId });
  jira.setStatus(existing.id, { name: "Secret Private Status", categoryKey: "indeterminate" }, jiraTimestamp(Date.now()));
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  jira.requests.length = 0;
  expect(await dana.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.requests).toEqual([]);
  expect((await getThread(dana, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "To Do" }, statusStale: true });
});

test("Jira attack: a signed delivery from another site's webhook with the same ID, or naming no issue address, changes no link on this site", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await connect(lee, "ATATT-lee", "lee@example.com");
  const existing = addJiraIssue(jira, { summary: "Existing", status: { name: "To Do", categoryKey: "new" } });
  const link = await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, comment: false });
  // Critiqs registered webhook 1000 on this site for Lee (as a sign-in would).
  const leeId = (await t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Lee")!._id;
  const account = (await t.run((ctx) => ctx.db.query("trackerAccounts").collect()))[0]!;
  await t.run(async (ctx) => {
    await ctx.db.insert("trackerWebhooks", { userId: leeId, tracker: "jira", accountId: account.accountId, site: { id: jira.site.cloudId, name: "acme.atlassian.net" }, hookId: "1000", scopes: ["10001"], expiresAt: Date.now() + 86_400_000, updatedAt: 1 });
  });
  expect(link.status?.label).toBe("To Do");
  const deliver = async (delivery: { body: string; headers: Record<string, string> }) => await t.fetch("/trackers/jira/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
  jira.setStatus(existing.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  // Another site's webhook 1000, about its own issue with the same ID.
  const other = await jiraIssueWebhook(jira, { event: "jira:issue_updated", issueId: existing.id, webhookIds: [1000], sentAt: Date.now(), self: `https://other.atlassian.net/rest/api/2/issue/${existing.id}` });
  expect((await deliver(other)).status).toBe(200);
  expect((await getThread(dana, { threadId })).tickets?.[0]?.status?.label).toBe("To Do");
  const nowhere = await jiraIssueWebhook(jira, { event: "jira:issue_updated", issueId: existing.id, webhookIds: [1000], sentAt: Date.now(), self: null });
  expect((await deliver(nowhere)).status).toBe(200);
  expect((await getThread(dana, { threadId })).tickets?.[0]?.status?.label).toBe("To Do");
  // The same change from this site's webhook does.
  const own = await jiraIssueWebhook(jira, { event: "jira:issue_updated", issueId: existing.id, webhookIds: [1000], sentAt: Date.now() });
  expect((await deliver(own)).status).toBe(200);
  expect((await getThread(dana, { threadId })).tickets?.[0]?.status?.label).toBe("Done");
});

test("Jira attack: the webhook route reads at most 256 KB of a delivery", async () => {
  const t = setup();
  const response = await t.fetch("/trackers/jira/webhook", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer a.b.c" }, body: "x".repeat(2 * 1024 * 1024) });
  expect(response.status).toBe(413);
});
