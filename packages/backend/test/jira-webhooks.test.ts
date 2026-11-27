import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { WEBHOOK_UPDATES_PER_MINUTE } from "@critiqs/server";
import { addJiraIssue, moveJiraIssue, JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, type JiraStandIn, jiraIssueWebhook, jiraStandIn, jiraTimestamp } from "@critiqs/server/jira-standin";
import { api, internal } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";
import { thread as getThread } from "./pages";

// Jira's status webhooks on Convex, against a stand-in for Atlassian and one
// Jira site: what a delivery is trusted with (only that an issue on a site
// changed, from a webhook Critiqs registered there), which site's webhook it
// is, how long its token is good for, and that a person's webhook follows
// only the projects they may still review, and ends with their connection.

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
      { accountId: "557058:dana", email: "dana@example.com", name: "Dana Smith", apiToken: "ATATT-dana" },
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

type Person = ReturnType<ReturnType<typeof setup>["withIdentity"]>;

/** Signs `as` in to Jira through the backend's window and the stand-in's consent page. */
async function signIn(t: ReturnType<typeof setup>, as: Person, account = "557058:lee") {
  const started = await as.action(api.trackers.startSignIn, { tracker: "jira", site: "acme" });
  const start = await t.fetch("/trackers/jira/start", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ state: started.state, binding: started.binding }) });
  const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const authorize = new URL(start.headers.get("Location")!);
  const accepted = await jira.fetchFn(`http://127.0.0.1:${server.port}/authorize/allow`, {
    method: "POST",
    body: new URLSearchParams({ redirect_uri: authorize.searchParams.get("redirect_uri")!, state: authorize.searchParams.get("state")!, account }),
  });
  const back = new URL(accepted.headers.get("Location")!);
  expect(await (await t.fetch(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } })).text()).toContain("Jira is connected");
}

/** Lee's thread in Dana's project, linked by Lee (with a pasted token) to a To Do issue; Critiqs's webhook 1000 on the site, as a sign-in registers one. */
async function linked(options: { otherSites?: number } = {}) {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await lee.action(api.trackers.connectWithToken, { tracker: "jira", token: "ATATT-lee", email: "lee@example.com", site: "acme" });
  const issue = addJiraIssue(jira, { summary: "Existing", status: { name: "To Do", categoryKey: "new" } });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  const users = await t.run((ctx) => ctx.db.query("users").collect());
  const leeId = users.find((user) => user.name === "Lee")!._id;
  const danaId = users.find((user) => user.name === "Dana")!._id;
  const account = (await t.run((ctx) => ctx.db.query("trackerAccounts").collect()))[0]!;
  await t.run(async (ctx) => {
    // People on other Jira sites whose webhook also got ID 1000, registered first.
    for (let site = 0; site < (options.otherSites ?? 0); site++) {
      await ctx.db.insert("trackerWebhooks", { userId: danaId, tracker: "jira", accountId: `other-${site}`, site: { id: `cloud-other-${site}`, name: `other${site}.atlassian.net` }, hookId: "1000", scopes: ["10001"], expiresAt: Date.now() + 86_400_000, updatedAt: 0 });
    }
    await ctx.db.insert("trackerWebhooks", { userId: leeId, tracker: "jira", accountId: account.accountId, site: { id: jira.site.cloudId, name: "acme.atlassian.net" }, hookId: "1000", scopes: ["10001"], expiresAt: Date.now() + 86_400_000, updatedAt: 1 });
  });
  const deliver = async (delivery: { body: string; headers: Record<string, string> }) => {
    const response = await t.fetch("/trackers/jira/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
    await t.finishAllScheduledFunctions(() => undefined);
    return response;
  };
  const chip = async () => (await getThread(dana, { threadId })).tickets?.[0]?.status?.label;
  const updated = (extra: Partial<Parameters<typeof jiraIssueWebhook>[1]> = {}) => jiraIssueWebhook(jira, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: Date.now(), ...extra });
  return { t, dana, lee, projectId, threadId, issue, leeId, danaId, account, deliver, chip, updated };
}

test("a delivery reaches its own site's webhook however many webhooks on other sites, registered first, share its ID", async () => {
  const { issue, deliver, chip, updated } = await linked({ otherSites: 20 });
  jira.setStatus(issue.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  expect((await deliver(await updated())).status).toBe(200);
  expect(await chip()).toBe("Done");
});

test("a delivery's token must say when it expires, and be good for minutes, not days", async () => {
  const { issue, deliver, chip, updated } = await linked();
  jira.setStatus(issue.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  const now = Math.floor(Date.now() / 1000);
  // No expiry, issued 400 days ago: refused.
  expect((await deliver(await updated({ claims: { iss: JIRA_STANDIN_CLIENT_ID, iat: now - 400 * 86_400 } }))).status).toBe(401);
  // Good for a year: refused.
  expect((await deliver(await updated({ claims: { iss: JIRA_STANDIN_CLIENT_ID, iat: now, exp: now + 365 * 86_400 } }))).status).toBe(401);
  expect(await chip()).toBe("To Do");
  expect((await deliver(await updated())).status).toBe(200);
  expect(await chip()).toBe("Done");
});

test("a delivery only says an issue changed: its status is read from Jira with the linker's token, never taken from the delivery's body", async () => {
  const { issue, deliver, chip, updated } = await linked();
  // Signed while the issue was Done; Jira has it To Do again since.
  jira.setStatus(issue.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now() - 2_000));
  const stale = await updated();
  jira.setStatus(issue.id, { name: "To Do", categoryKey: "new" }, jiraTimestamp(Date.now() - 1_000));
  expect((await deliver(stale)).status).toBe(200);
  expect(await chip()).toBe("To Do");
  // The token doesn't cover the body: a genuine token with the event changed to a deletion deletes nothing.
  const genuine = await updated();
  const swapped = { ...genuine, body: JSON.stringify({ ...JSON.parse(genuine.body), webhookEvent: "jira:issue_deleted" }) };
  expect((await deliver(swapped)).status).toBe(200);
  expect(await chip()).toBe("To Do");
  // Deleted in Jira, and the notice says so: the linker's read finds no issue, which Jira also answers for one they may no
  // longer see, so the chip keeps its last status, marked last known, rather than Deleted.
  const deletion = await jiraIssueWebhook(jira, { event: "jira:issue_deleted", issueId: issue.id, webhookIds: [1000], sentAt: Date.now() });
  jira.issues.splice(jira.issues.findIndex((each) => each.id === issue.id), 1);
  expect((await deliver(deletion)).status).toBe(200);
  expect(await chip()).toBe("To Do");
});

test("an issue Jira stops showing the linker is never marked Deleted, even after a deletion notice: Jira answers a hidden issue as a missing one, so its last status stays, marked last known", async () => {
  const { issue, deliver, threadId, dana, updated } = await linked();
  const shown = async () => (await getThread(dana, { threadId })).tickets?.[0];
  // Lee loses permission to see the issue (issue security, or a project role removed), and a deletion notice arrives.
  issue.hiddenFrom = ["557058:lee"];
  expect((await deliver(await jiraIssueWebhook(jira, { event: "jira:issue_deleted", issueId: issue.id, webhookIds: [1000], sentAt: Date.now() }))).status).toBe(200);
  expect(await shown()).toMatchObject({ status: { label: "To Do" }, statusStale: true });
  // Seen again: an ordinary notice clears it.
  issue.hiddenFrom = [];
  jira.setStatus(issue.id, { name: "In Progress", categoryKey: "indeterminate" }, jiraTimestamp(Date.now()));
  await deliver(await updated());
  expect(await shown()).toMatchObject({ status: { label: "In Progress" }, statusStale: false });
  // Really deleted, and Jira says so in the notice: its answer to the read is the same 404, so still last known, never Deleted.
  const deletion = await jiraIssueWebhook(jira, { event: "jira:issue_deleted", issueId: issue.id, webhookIds: [1000], sentAt: Date.now() });
  jira.issues.splice(jira.issues.findIndex((each) => each.id === issue.id), 1);
  await deliver(deletion);
  expect(await shown()).toMatchObject({ status: { label: "In Progress" }, statusStale: true });
});

test("an issue's address names its site one way only: the site's own host, or Atlassian's gateway with its cloud ID", async () => {
  const { issue, deliver, chip, updated } = await linked();
  jira.setStatus(issue.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  // The site's cloud ID, on an address that isn't Atlassian's gateway.
  expect((await deliver(await updated({ self: `https://evil.example/ex/jira/${jira.site.cloudId}/rest/api/2/issue/${issue.id}` }))).status).toBe(200);
  // The gateway's path on the site's host.
  expect((await deliver(await updated({ self: `https://other.atlassian.net/ex/jira/${jira.site.cloudId}/rest/api/2/issue/${issue.id}` }))).status).toBe(200);
  expect(await chip()).toBe("To Do");
  // Atlassian's gateway, naming the site's cloud ID.
  expect((await deliver(await updated({ self: `https://api.atlassian.com/ex/jira/${jira.site.cloudId}/rest/api/2/issue/${issue.id}` }))).status).toBe(200);
  expect(await chip()).toBe("Done");
});

test("a delivery to a webhook whose registration expired changes nothing", async () => {
  const { t, issue, deliver, chip, updated } = await linked();
  await t.run(async (ctx) => {
    const [hook] = await ctx.db.query("trackerWebhooks").collect();
    await ctx.db.patch(hook!._id, { expiresAt: Date.now() - 1 });
  });
  jira.setStatus(issue.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  expect((await deliver(await updated())).status).toBe(200);
  expect(await chip()).toBe("To Do");
});

test("past a site's status updates for the minute, a delivery is answered 429, so Jira sends it again later", async () => {
  const { t, updated } = await linked();
  const statuses: number[] = [];
  for (let index = 0; index <= WEBHOOK_UPDATES_PER_MINUTE; index++) {
    statuses.push((await t.fetch("/trackers/jira/webhook", { method: "POST", ...(await updated()) })).status);
  }
  expect(statuses.slice(0, WEBHOOK_UPDATES_PER_MINUTE).every((status) => status === 200)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
});

test("a person's webhook follows only projects where they still have a linked ticket they may review: removed from the organization, renewal removes it at Jira", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "lee@example.com", role: "member" });
  await lee.mutation(api.users.sync, {});
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await signIn(t, lee);
  const issue = addJiraIssue(jira, { summary: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toHaveLength(1);
  const leeId = (await t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Lee")!._id;
  await dana.mutation(api.organizations.removeMember, { organizationId: organization!.id, userId: leeId });
  // Due for renewal: Lee may no longer review the project, so nothing of his follows it any more.
  const [record] = await t.run((ctx) => ctx.db.query("trackerWebhooks").collect());
  await t.run((ctx) => ctx.db.patch(record!._id, { expiresAt: Date.now() + 86_400_000 }));
  jira.requests.length = 0;
  expect(await t.mutation(internal.trackerWebhooks.renewDue, {})).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.requests.some((request) => request.includes("PUT") && request.includes("/webhook/refresh"))).toBe(false);
  expect(jira.webhooks).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("trackerWebhooks").collect())).toEqual([]);
});

test("a person's webhook follows only tickets linked with the Jira account it is registered as, and a follow with nothing new to register never reads their token", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await signIn(t, lee);
  const issue = addJiraIssue(jira, { summary: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toHaveLength(1);
  const [account] = await t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  // The ticket was linked with another Jira account Lee had on the site before.
  await t.run(async (ctx) => {
    for (const link of await ctx.db.query("ticketLinks").collect()) await ctx.db.patch(link._id, { accountId: `${jira.site.cloudId}/557058:earlier` });
    for (const hook of await ctx.db.query("trackerWebhooks").collect()) await ctx.db.delete(hook._id);
  });
  jira.webhooks.length = 0;
  jira.requests.length = 0;
  // Nothing linked with this account: nothing to register, and Jira isn't asked, not even to refresh the sign-in.
  await t.run((ctx) => ctx.db.patch(account!._id, { expiresAt: Date.now() - 1 }));
  expect(await t.action(internal.trackerWebhooks.follow, { userId: account!.userId, accountId: account!.accountId, tracker: "jira" })).toBe("covered");
  expect(jira.requests).toEqual([]);
  expect(jira.webhooks).toEqual([]);
});

test("an issue moved to another project stays linked under its new key: search finds it by its old key, a check moves the link, and the webhook follows its new project", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await signIn(t, lee);
  const issue = addJiraIssue(jira, { summary: "Existing" });
  const oldKey = issue.key;
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks.map((hook) => hook.jqlFilter)).toEqual(["project IN (10001)"]);
  moveJiraIssue(jira, issue.id, "OPS");
  jira.setStatus(issue.id, { name: "Done", categoryKey: "done" }, jiraTimestamp(Date.now()));
  // Searching by its old key finds it, under its new key.
  expect((await lee.action(api.tickets.search, { tracker: "jira", query: oldKey })).map((found) => found.key)).toEqual([issue.key]);
  // Opening the thread checks it by its ID: the link takes its new key and page, and its project.
  await t.run(async (ctx) => {
    for (const link of await ctx.db.query("ticketLinks").collect()) await ctx.db.patch(link._id, { statusCheckedAt: 0, statusCheckStartedAt: 0 });
  });
  await dana.mutation(api.ticketStatus.checkStatus, { threadId });
  await t.finishAllScheduledFunctions(() => undefined);
  expect((await getThread(dana, { threadId })).tickets?.[0]).toMatchObject({ key: issue.key, url: `https://acme.atlassian.net/browse/${issue.key}`, status: { label: "Done" } });
  // Lee's webhook now follows the issue's new project, so its deliveries arrive again.
  expect(jira.webhooks.map((hook) => hook.jqlFilter)).toEqual(["project IN (10002)"]);
});

test("unlinking the last ticket in a project stops the person's webhook following it", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await signIn(t, lee);
  const issue = addJiraIssue(jira, { summary: "Existing" });
  const link = await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toHaveLength(1);
  await lee.mutation(api.tickets.unlink, { linkId: link._id });
  const [record] = await t.run((ctx) => ctx.db.query("trackerWebhooks").collect());
  await t.run((ctx) => ctx.db.patch(record!._id, { expiresAt: Date.now() + 86_400_000 }));
  expect(await t.mutation(internal.trackerWebhooks.renewDue, {})).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("trackerWebhooks").collect())).toEqual([]);
});

test("disconnecting Jira removes the person's webhooks at Jira too", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  await signIn(t, lee);
  const issue = addJiraIssue(jira, { summary: "Existing" });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toHaveLength(1);
  await lee.action(api.trackers.disconnect, { tracker: "jira" });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(jira.webhooks).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("trackerWebhooks").collect())).toEqual([]);
});
