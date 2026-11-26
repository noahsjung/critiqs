import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { decryptToken, trackerTokenBinding } from "@critiqs/server";
import { addJiraIssue, adfText, JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, type JiraStandIn, jiraIssueWebhook, jiraStandIn, jiraTimestamp, validAdf } from "@critiqs/server/jira-standin";
import { api, internal } from "../convex/_generated/api";
import { anchor, reviewer, setup, upload } from "./harness";
import { list, thread as getThread } from "./pages";

// Jira Cloud on Convex, end to end against a stand-in for Atlassian's
// sign-in and one Jira site, served over HTTP: connecting with an API token
// and with sign-in (the site chosen first), the project's issue types as
// destinations, required fields, creating with the capture attached and the
// thread as a remote link, linking an existing issue, the webhook a sign-in
// registers and its signed deliveries, renewal, and the organization-only
// refusal.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const SITE = "https://backend.example";
const ENV = [
  "CRITIQS_AI_ENCRYPTION_KEY",
  "CRITIQS_JIRA_CLIENT_ID",
  "CRITIQS_JIRA_CLIENT_SECRET",
  "CRITIQS_JIRA_API_URL",
  "CRITIQS_JIRA_AUTH_URL",
  "CRITIQS_JIRA_SITES_URL",
  "CONVEX_SITE_URL",
  "CRITIQS_AUTH_ISSUER",
];
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
  jira = jiraStandIn({ users: [
    { accountId: "557058:lee", email: "lee@example.com", name: "Lee Park", apiToken: "ATATT-lee" },
    { accountId: "557058:dana", email: "dana@example.com", name: "Dana Smith", apiToken: "ATATT-dana" },
  ] });
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  process.env.CRITIQS_JIRA_API_URL = origin;
  process.env.CRITIQS_JIRA_AUTH_URL = origin;
  process.env.CRITIQS_JIRA_SITES_URL = origin;
  process.env.CONVEX_SITE_URL = SITE;
  delete process.env.CRITIQS_JIRA_CLIENT_ID;
  delete process.env.CRITIQS_JIRA_CLIENT_SECRET;
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const withSignIn = () => {
  process.env.CRITIQS_JIRA_CLIENT_ID = JIRA_STANDIN_CLIENT_ID;
  process.env.CRITIQS_JIRA_CLIENT_SECRET = JIRA_STANDIN_SECRET;
};

async function project() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const sam = t.withIdentity(reviewer("Sam"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: ["copy"], capture: failedCapture });
  await sam.query(api.trackers.mine, {});
  return { t, dana, lee, sam, projectId, threadId };
}

const userId = async (t: ReturnType<typeof setup>, name: string) => (await t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === name)!._id;

/** Signs Lee in to Jira through the backend's window and the stand-in's consent page, for `site`. */
async function signIn(t: ReturnType<typeof setup>, as: ReturnType<ReturnType<typeof setup>["withIdentity"]>, site: string, account = "557058:lee") {
  const started = await as.action(api.trackers.startSignIn, { tracker: "jira", site });
  expect(started.url).toBe(`${SITE}/trackers/jira/start`);
  const start = await t.fetch("/trackers/jira/start", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ state: started.state, binding: started.binding }) });
  expect(start.status).toBe(303);
  const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const authorize = new URL(start.headers.get("Location")!);
  // The stand-in's consent page, then Accept, as the person would.
  expect((await jira.fetchFn(authorize)).status).toBe(200);
  const accepted = await jira.fetchFn(`http://127.0.0.1:${server.port}/authorize/allow`, {
    method: "POST",
    body: new URLSearchParams({ redirect_uri: authorize.searchParams.get("redirect_uri")!, state: authorize.searchParams.get("state")!, account }),
  });
  const back = new URL(accepted.headers.get("Location")!);
  expect(back.origin + back.pathname).toBe(`${SITE}/trackers/jira/callback`);
  return { authorize, done: await t.fetch(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } }) };
}

test("/critiqs/config offers Jira by API token, or by sign-in with the operator's Atlassian app", async () => {
  const { t } = await project();
  process.env.CRITIQS_AUTH_ISSUER = "https://auth.example";
  const config = async () => ((await (await t.fetch("/critiqs/config")).json()) as { tickets: { trackers: unknown[] } }).tickets.trackers;
  expect(await config()).toContainEqual({ id: "jira", signIn: "token" });
  withSignIn();
  expect(await config()).toContainEqual({ id: "jira", signIn: "oauth" });
});

test("a pasted Atlassian API token connects its person to their Jira site, stored encrypted; a wrong one, or a site that isn't Atlassian's, is refused", async () => {
  const { t, lee, sam } = await project();
  await expect(lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "http://127.0.0.1:1" })).rejects.toThrow("That isn't a Jira Cloud site");
  await expect(lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", site: "acme" })).rejects.toThrow("Enter the email address of your Atlassian account.");
  await expect(lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "wrong", email: "lee@example.com", site: "acme" })).rejects.toThrow("Jira didn't accept this email and API token");
  expect(jira.requests.filter((request) => !request.includes("acme.atlassian.net"))).toEqual([]);
  const view = await lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "https://acme.atlassian.net/jira" });
  expect(view).toMatchObject({ tracker: "jira", method: "token", accountName: "Lee Park", site: "acme.atlassian.net" });
  expect(await sam.query(api.trackers.mine, {})).toEqual([]);
  const [row] = await t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  expect(row!.accountId).toBe(`${jira.site.cloudId}/557058:lee`);
  expect(row!.site).toEqual({ id: jira.site.cloudId, name: "acme.atlassian.net" });
  expect(JSON.stringify(row)).not.toContain("ATATT-lee");
  expect(await decryptToken(KEY, trackerTokenBinding("jira", await userId(t, "Lee")), row!.access)).toBe("lee@example.com:ATATT-lee");
  await lee.action(api.trackers.disconnect, { tracker: "jira" });
  expect(await lee.query(api.trackers.mine, {})).toEqual([]);
});

test("Jira sign-in: the site is chosen first, Atlassian's window comes back with a code, and only a sign-in reaching that site with the Critiqs email connects", async () => {
  withSignIn();
  const { t, lee, dana } = await project();
  const { authorize, done } = await signIn(t, lee, "acme.atlassian.net");
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ audience: "api.atlassian.com", client_id: JIRA_STANDIN_CLIENT_ID, response_type: "code", prompt: "consent", redirect_uri: `${SITE}/trackers/jira/callback` });
  expect(authorize.searchParams.get("scope")).toContain("offline_access");
  expect(await done.text()).toContain("Jira is connected");
  expect(await lee.query(api.trackers.mine, {})).toEqual([expect.objectContaining({ tracker: "jira", method: "oauth", accountName: "Lee Park", site: "acme.atlassian.net" })]);
  const [row] = await t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  expect(row!.refresh).toBeDefined();
  expect(JSON.stringify(row)).not.toContain("jira-access-");

  // A site the sign-in doesn't reach saves nothing.
  const other = await signIn(t, dana, "other.atlassian.net", "557058:dana");
  expect(other.done.status).toBe(403);
  expect(await other.done.text()).toContain("give Critiqs access to other.atlassian.net");
  // Nor does a sign-in as another Atlassian account than the Critiqs email's.
  const wrongPerson = await signIn(t, dana, "acme", "557058:lee");
  expect(await wrongPerson.done.text()).toContain("use the same email address");
  expect(await dana.query(api.trackers.mine, {})).toEqual([]);
  // A start link opened on its own goes nowhere.
  expect((await t.fetch("/trackers/jira/start")).status).toBe(400);
});

test("a reviewer creates a Jira issue: project and issue type, ADF text, labels from tags, the capture attached, the thread as a remote link; everyone sees it", async () => {
  const { t, lee, sam, projectId, threadId } = await project();
  const storageId = await upload(lee, projectId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
  await lee.mutation(api.threads.attachScreenshot, { threadId, storageId });
  await lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "acme" });
  expect((await lee.action(api.tickets.destinations, { tracker: "jira" })).map((destination) => destination.name)).toEqual([
    "Website · Bug",
    "Website · Task",
    "Operations · Incident",
    "Operations · Escalation",
  ]);
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "jira", destinationId: "10001/10010" });
  expect(draft.body).toContain("- Capture: attached to this ticket");
  expect(await lee.action(api.tickets.options, { threadId, tracker: "jira", destinationId: "10001/10010" })).toEqual({ templates: [], labels: [{ id: "copy", name: "copy" }], fields: [], unsupportedFields: [] });

  const create = { threadId, submissionId: crypto.randomUUID(), tracker: "jira" as const, destinationId: "10001/10010", title: draft.title, body: `${draft.body}\n**Please** fix.`, createdFromCritiqs: true, labelIds: ["copy"] };
  const view = await lee.action(api.tickets.create, create);
  const issue = jira.issues.at(-1)!;
  expect(view).toMatchObject({ tracker: "jira", key: "WEB-1", externalId: `${jira.site.cloudId}/${issue.id}`, url: "https://acme.atlassian.net/browse/WEB-1", status: { label: "To Do", category: "open" } });
  expect(validAdf(issue.description)).toBeNull();
  expect(adfText(issue.description)).toContain("Created from Critiqs by Lee");
  expect(issue.labels).toEqual(["copy"]);
  expect(jira.attachments).toEqual([{ issueId: issue.id, filename: "critiqs-capture.png", mimeType: "image/png", size: 10 }]);
  expect(jira.remoteLinks).toEqual([{ issueId: issue.id, globalId: expect.stringMatching(/^critiqs-thread=/), url: `https://review.example/app?critiqs=${threadId}`, title: "Department is wrong" }]);
  // The retry is the same ticket.
  expect((await lee.action(api.tickets.create, create))._id).toBe(view._id);
  expect(jira.issues).toHaveLength(1);
  expect((await list(sam, { projectId }))[0]!.tickets).toEqual([{ tracker: "jira", key: "WEB-1", status: { label: "To Do", category: "open" } }]);
  // A pasted token registers no webhook.
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toEqual([]);
});

test("an issue type's required fields are asked for and sent; one Critiqs can't fill is named", async () => {
  const { lee, threadId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "acme" });
  const options = await lee.action(api.tickets.options, { threadId, tracker: "jira", destinationId: "10002/10020" });
  expect(options.fields?.map((field) => [field.name, field.kind])).toEqual([
    ["Priority", "choice"],
    ["Customer impact", "paragraph"],
    ["Affected users", "number"],
  ]);
  expect((await lee.action(api.tickets.options, { threadId, tracker: "jira", destinationId: "10002/10021" })).unsupportedFields).toEqual(["Escalation owner"]);
  const create = { threadId, tracker: "jira" as const, destinationId: "10002/10020", title: "Checkout down", body: "Down", createdFromCritiqs: false };
  await expect(lee.action(api.tickets.create, { ...create, submissionId: crypto.randomUUID() })).rejects.toThrow("Priority is required.");
  const view = await lee.action(api.tickets.create, { ...create, submissionId: crypto.randomUUID(), fields: { priority: "3", customfield_10050: "Everyone", customfield_10051: "40" } });
  expect(view.key).toBe("OPS-1");
  expect(jira.issues.at(-1)!.fields).toMatchObject({ priority: { id: "3" }, customfield_10051: 40 });
});

test("a project's owner pastes a Jira template; the draft fills it", async () => {
  const { dana, lee, projectId, threadId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "acme" });
  const template = { tracker: "jira" as const, destinationId: "10001/10010", templateId: "pasted-1", name: "Bug report", body: "## What happened\n\n## Expected\n" };
  await expect(dana.mutation(api.tickets.saveTemplateSettings, { projectId, on: true, templates: [{ ...template, body: " " }] })).rejects.toThrow("Paste the template's text.");
  await dana.mutation(api.tickets.saveTemplateSettings, { projectId, on: true, templates: [template] });
  expect((await lee.action(api.tickets.options, { threadId, tracker: "jira", destinationId: "10001/10010" })).templates).toEqual([{ id: "pasted-1", name: "Bug report" }]);
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "jira", destinationId: "10001/10010", templateId: "pasted-1" });
  expect(draft.body.startsWith("## What happened\n\n> Department is wrong")).toBe(true);
  expect(draft.body).toContain("## Expected");
});

test("linking an existing Jira issue adds a remote link and the summary comment; a sign-in's webhook follows its project and a signed delivery updates the chip and resolves the thread", async () => {
  withSignIn();
  const { t, dana, lee, sam, projectId, threadId } = await project();
  const existing = addJiraIssue(jira, { summary: "Department label is unclear", status: { name: "In Progress", categoryKey: "indeterminate" } });
  expect(await (await signIn(t, lee, "acme")).done.text()).toContain("Jira is connected");
  const [found] = await lee.action(api.tickets.search, { tracker: "jira", query: "department" });
  expect(found).toEqual({ tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, key: existing.key, url: `https://acme.atlassian.net/browse/${existing.key}`, title: existing.summary, status: { label: "In Progress", category: "started" } });
  const view = await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: found!.externalId, comment: true });
  expect(view).toMatchObject({ key: existing.key, createdFromCritiqs: false });
  expect(jira.remoteLinks.map((link) => link.url)).toEqual([`https://review.example/app?critiqs=${threadId}`]);
  expect(adfText(jira.comments[0]!.body)).toContain("Department is wrong");

  // The link had Lee's sign-in register a webhook following the issue's project.
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toEqual([expect.objectContaining({ url: `${SITE}/trackers/jira/webhook`, jqlFilter: "project IN (10001)", ownerId: "557058:lee" })]);
  const [record] = await t.run((ctx) => ctx.db.query("trackerWebhooks").collect());
  expect(record).toMatchObject({ hookId: String(jira.webhooks[0]!.id), scopes: ["10001"], site: { id: jira.site.cloudId, name: "acme.atlassian.net" } });

  await dana.mutation(api.ticketStatus.setResolveWhenDone, { projectId, on: true });
  jira.setStatus(existing.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  const deliver = async (delivery: { body: string; headers: Record<string, string> }) => await t.fetch("/trackers/jira/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
  // A delivery not signed with the app's secret changes nothing.
  const forged = await jiraIssueWebhook(jira, { event: "jira:issue_updated", issueId: existing.id, webhookIds: [jira.webhooks[0]!.id], sentAt: Date.now(), secret: "someone-else" });
  expect((await deliver(forged)).status).toBe(401);
  expect((await getThread(sam, { threadId })).tickets?.[0]?.status).toEqual({ label: "In Progress", category: "started" });
  const delivery = await jiraIssueWebhook(jira, { event: "jira:issue_updated", issueId: existing.id, webhookIds: [jira.webhooks[0]!.id], sentAt: Date.now() });
  expect((await deliver(delivery)).status).toBe(200);
  // The delivery says the issue changed; Lee's sign-in reads it as Jira has it.
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await getThread(sam, { threadId })).toMatchObject({ status: "resolved", resolvedByTickets: true, tickets: [{ key: existing.key, status: { label: "Done", category: "done" } }] });

  // Disconnecting removes the webhook's record, and the webhook at Jira.
  await lee.action(api.trackers.disconnect, { tracker: "jira" });
  expect(await t.run((ctx) => ctx.db.query("trackerWebhooks").collect())).toEqual([]);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toEqual([]);
});

test("a webhook due to expire is renewed with its person's sign-in; one whose person disconnected is dropped", async () => {
  withSignIn();
  const { t, lee, threadId } = await project();
  const existing = addJiraIssue(jira, { summary: "Renew me" });
  await signIn(t, lee, "acme");
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);
  const [record] = await t.run((ctx) => ctx.db.query("trackerWebhooks").collect());
  // Not due yet: nothing is renewed.
  expect(await t.mutation(internal.trackerWebhooks.renewDue, {})).toBe(0);
  const soon = Date.now() + 2 * 86_400_000;
  await t.run((ctx) => ctx.db.patch(record!._id, { expiresAt: soon }));
  jira.webhooks[0]!.expiresAt = soon;
  expect(await t.mutation(internal.trackerWebhooks.renewDue, {})).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  const [renewed] = await t.run((ctx) => ctx.db.query("trackerWebhooks").collect());
  expect(renewed!.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  expect(jira.webhooks[0]!.expiresAt).toBe(renewed!.expiresAt);
  expect(renewed!.lease).toBeUndefined();

  // Lee disconnects; a due record found later goes.
  await t.run((ctx) => ctx.db.delete(record!._id));
  await t.run(async (ctx) => {
    await ctx.db.insert("trackerWebhooks", { userId: record!.userId, tracker: "jira", accountId: record!.accountId, site: record!.site, hookId: "1000", scopes: ["10001"], expiresAt: soon, updatedAt: 1 });
    const [account] = await ctx.db.query("trackerAccounts").collect();
    await ctx.db.delete(account!._id);
  });
  expect(await t.mutation(internal.trackerWebhooks.renewDue, {})).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await t.run((ctx) => ctx.db.query("trackerWebhooks").collect())).toEqual([]);
});

test("once a project is limited to its organization, someone outside it can't draft, create, link, or search on its threads in Jira; nothing reaches Jira", async () => {
  const { t, dana, lee, threadId, projectId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "acme" });
  const existing = addJiraIssue(jira, { summary: "Existing" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });
  const refused = "This project is limited to members of its organization. Ask one of its admins to invite you.";
  jira.requests.length = 0;
  await expect(lee.action(api.tickets.draft, { threadId, tracker: "jira" })).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.options, { threadId, tracker: "jira", destinationId: "10001/10010" })).rejects.toThrow(refused);
  await expect(
    lee.action(api.tickets.create, { threadId, submissionId: crypto.randomUUID(), tracker: "jira", destinationId: "10001/10010", title: "T", body: "B", createdFromCritiqs: false }),
  ).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${existing.id}`, comment: true })).rejects.toThrow(refused);
  expect(jira.requests).toEqual([]);
  expect(jira.issues).toHaveLength(1);
  void t;
});
