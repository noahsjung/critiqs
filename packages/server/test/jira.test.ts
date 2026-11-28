import { expect, test } from "bun:test";
import { ticketBody, ticketLinkComment, type TicketMarkdown, type WebAddress, webAddress } from "@critiqs/core";
import { CritiqsError } from "../src/errors.ts";
import { TrackerRefusal, type TrackerToken } from "../src/tickets/trackers/index.ts";
import {
  exchangeJiraCode,
  JIRA_CREATION_PROPERTY,
  jiraAdapter,
  jiraAuthorizeUrl,
  jiraSignInSite,
  jqlString,
  jqlText,
  parseJiraSite,
  readJiraWebhook,
  refreshJiraToken,
} from "../src/tickets/trackers/jira.ts";
import { addJiraIssue, adfText, moveJiraIssue, JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, jiraIssueWebhook, jiraStandIn, jiraTimestamp, validAdf } from "./jira-standin.ts";

const ORIGIN = "https://jira.test";
const app = { clientId: JIRA_STANDIN_CLIENT_ID, clientSecret: JIRA_STANDIN_SECRET };
/** Ticket text as Critiqs makes it, from a draft with nothing added. */
const md = (draft: string): TicketMarkdown => ticketBody(draft, { capture: null, attribution: null, link: null });
const web = (value: string): WebAddress => webAddress(value)!;

function setup() {
  const standIn = jiraStandIn();
  const adapter = jiraAdapter({ fetch: standIn.fetchFn, baseUrl: ORIGIN, sitesUrl: ORIGIN });
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  const pasted: TrackerToken = { method: "token", value: "dana@example.com:ATATT-dana-token", site };
  return { standIn, adapter, site, pasted };
}

/** A sign-in's token for Dana, through the stand-in's consent and token endpoints. */
async function signIn(standIn: ReturnType<typeof jiraStandIn>, site: { id: string; name: string }): Promise<TrackerToken> {
  const allow = await standIn.fetchFn(`${ORIGIN}/authorize/allow`, {
    method: "POST",
    body: new URLSearchParams({ redirect_uri: "https://critiqs.test/trackers/jira/callback", state: "s", account: "557058:dana" }),
  });
  const code = new URL(allow.headers.get("Location")!).searchParams.get("code")!;
  const tokens = await exchangeJiraCode({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, app, { code, redirectUri: "https://critiqs.test/trackers/jira/callback" }, 1_000);
  return { method: "oauth", value: tokens.access, site };
}

async function refusal(promise: Promise<unknown>): Promise<CritiqsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CritiqsError) return error;
    throw error;
  }
  throw new Error("Expected a refusal");
}

test("a Jira site is only ever one of Atlassian's cloud hosts", () => {
  expect(parseJiraSite("acme")).toBe("acme.atlassian.net");
  expect(parseJiraSite(" https://Acme.atlassian.net/jira/software/projects ")).toBe("acme.atlassian.net");
  expect(parseJiraSite("acme.jira.com")).toBe("acme.jira.com");
  for (const bad of ["", "http://acme.atlassian.net", "acme.atlassian.net.evil.test", "127.0.0.1", "https://acme.atlassian.net:8443", "https://user@acme.atlassian.net", "evil.test/acme.atlassian.net", "a_b.atlassian.net"]) {
    expect(() => parseJiraSite(bad)).toThrow(CritiqsError);
  }
});

test("JQL values are quoted strings, whatever a person types", () => {
  expect(jqlString('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c d"');
  // Text search's own syntax characters become spaces, so they can't change the search.
  expect(jqlText('x" OR project = "OPS')).toBe('"x OR project OPS"');
  expect(jqlText("department* (label)~")).toBe('"department label"');
});

test("a pasted API token connects to its site: whose it is, with the site's cloud ID; a wrong one is refused", async () => {
  const { adapter, site, standIn } = setup();
  const identity = await adapter.verify({ method: "token", value: "dana@example.com:ATATT-dana-token", site: { id: "", name: site.name } });
  expect(identity).toEqual({ accountId: `${site.id}/557058:dana`, accountName: "Dana Smith", emails: ["dana@example.com"], site });
  const wrong = await refusal(adapter.verify({ method: "token", value: "dana@example.com:wrong", site: { id: "", name: site.name } }));
  expect(wrong).toBeInstanceOf(TrackerRefusal);
  expect(wrong.message).toBe("Jira didn't accept this email and API token for this site. Check the site, your email, and that you copied all of the token.");
  expect((await refusal(adapter.verify({ method: "token", value: "dana@example.com:ATATT-dana-token", site: { id: "", name: "other.atlassian.net" } }))).message).toBe(
    "There's no Jira Cloud site at other.atlassian.net. Check its address.",
  );
  // Basic authentication goes only to the site's own address.
  expect(standIn.requests).toContain("GET /acme.atlassian.net/rest/api/3/myself");
});

test("sign-in: Atlassian's authorize page, the code for tokens, the sites it reaches, who signed in, and refresh tokens used once", async () => {
  const { standIn, adapter, site } = setup();
  const authorize = new URL(jiraAuthorizeUrl(ORIGIN, { clientId: app.clientId, redirectUri: "https://critiqs.test/trackers/jira/callback", state: "state-1" }));
  expect(Object.fromEntries(authorize.searchParams)).toEqual({
    audience: "api.atlassian.com",
    client_id: app.clientId,
    scope: "read:jira-work write:jira-work read:jira-user manage:jira-webhook read:me report:personal-data offline_access",
    redirect_uri: "https://critiqs.test/trackers/jira/callback",
    state: "state-1",
    response_type: "code",
    prompt: "consent",
  });
  expect((await standIn.fetchFn(authorize)).status).toBe(200);
  const token = await signIn(standIn, site);
  expect(await jiraSignInSite({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, token.value, site.name)).toEqual(site);
  expect((await refusal(jiraSignInSite({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, token.value, "other.atlassian.net"))).code).toBe("forbidden");
  expect(await adapter.verify(token)).toEqual({ accountId: `${site.id}/557058:dana`, accountName: "Dana Smith", emails: ["dana@example.com"], site });
  // Calls go through the gateway by cloud ID with the bearer token.
  await adapter.destinations(token);
  expect(standIn.requests).toContain(`GET /ex/jira/${site.id}/rest/api/3/project/search`);
  const [refresh] = [...standIn.oauth.refresh.keys()];
  const renewed = await refreshJiraToken({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, app, refresh!, 2_000);
  expect(renewed.refresh).not.toBe(refresh);
  expect(renewed.expiresAt).toBe(2_000 + 3600_000);
  expect((await refusal(refreshJiraToken({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, app, refresh!, 3_000))).message).toBe("Your Jira sign-in has ended. Connect Jira again in Your trackers.");
  expect((await refusal(refreshJiraToken({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, { ...app, clientSecret: "wrong" }, renewed.refresh!, 3_000))).message).toContain("CRITIQS_JIRA_CLIENT_ID");
});

test("destinations are each project's issue types, without subtasks", async () => {
  const { adapter, pasted } = setup();
  expect(await adapter.destinations(pasted)).toEqual([
    { id: "10001/10010", name: "Website · Bug", key: "WEB" },
    { id: "10001/10011", name: "Website · Task", key: "WEB" },
    { id: "10002/10020", name: "Operations · Incident", key: "OPS" },
    { id: "10002/10021", name: "Operations · Escalation", key: "OPS" },
  ]);
});

test("search finds an issue by key, or by words with the JQL built as data, on the token's site", async () => {
  const { adapter, pasted, site, standIn } = setup();
  const issue = addJiraIssue(standIn, { summary: 'Department label "is" wrong' });
  addJiraIssue(standIn, { summary: "Unrelated", projectKey: "OPS" });
  const ref = { tracker: "jira", externalId: `${site.id}/${issue.id}`, key: issue.key, url: `https://acme.atlassian.net/browse/${issue.key}`, title: issue.summary, status: { label: "In Progress", category: "started" as const } } as const;
  expect(await adapter.search(pasted, issue.key.toLowerCase())).toEqual([ref]);
  expect(await adapter.search(pasted, 'department "is"')).toEqual([ref]);
  expect(await adapter.search(pasted, "department", "10002/10020")).toEqual([]);
  // A query trying to leave its string stays words.
  expect(await adapter.search(pasted, 'x" OR project = "10002')).toEqual([]);
  // A key that doesn't exist falls back to words.
  expect(await adapter.search(pasted, "NOPE-1")).toEqual([]);
});

test("an issue moved to another project is found by its old key under its new one, and a status read says where it is now", async () => {
  const { adapter, pasted, site, standIn } = setup();
  const issue = addJiraIssue(standIn, { summary: "Department label is wrong" });
  const oldKey = issue.key;
  moveJiraIssue(standIn, issue.id, "OPS");
  // Jira resolves the old key to the issue as it is now: the same issue, under its new key.
  expect((await adapter.search(pasted, oldKey)).map((found) => [found.externalId, found.key])).toEqual([[`${site.id}/${issue.id}`, issue.key]]);
  // Linked as it was before the move, it is read by its ID: its new key, page, and project come back with its status.
  const held = { tracker: "jira" as const, externalId: `${site.id}/${issue.id}`, key: oldKey, url: `https://acme.atlassian.net/browse/${oldKey}`, title: issue.summary, site: site.id };
  expect((await adapter.status(pasted, held)).place).toEqual({ key: issue.key, url: `https://acme.atlassian.net/browse/${issue.key}`, title: issue.summary, webhookScope: "10002" });
});

test("create: ADF text, labels, the creation's ID as an issue property, read back; a retry finds it by that ID", async () => {
  const { adapter, pasted, site, standIn } = setup();
  const creationId = crypto.randomUUID();
  const outcome = await adapter.create(pasted, {
    destinationId: "10001/10010",
    title: "Department label is wrong",
    body: md("> The label\n\n## Context\n\n- Link: [open the thread](<https://app.test/t?x=1&amp;y=2>)\n"),
    labels: ["copy"],
    templateId: null,
    creationId,
  });
  if (outcome.status !== "created") throw new Error(outcome.error.message);
  const created = standIn.issues.at(-1)!;
  expect(outcome.ticket).toEqual({
    tracker: "jira",
    externalId: `${site.id}/${created.id}`,
    key: "WEB-1",
    url: "https://acme.atlassian.net/browse/WEB-1",
    title: "Department label is wrong",
    status: { label: "To Do", category: "open" },
    site: site.id,
    asOf: Date.parse(created.updated.replace("+0000", "Z")),
    webhookScope: "10001",
  });
  expect(validAdf(created.description)).toBeNull();
  expect(adfText(created.description)).toContain("open the thread");
  expect(JSON.stringify(created.description)).toContain("https://app.test/t?x=1&y=2");
  expect(created.labels).toEqual(["copy"]);
  expect(created.properties[JIRA_CREATION_PROPERTY]).toEqual({ id: creationId });
  expect(await adapter.findCreated(pasted, { creationId, link: web("https://app.test/t"), destinationId: "10001/10010", since: 0 })).toEqual(outcome.ticket);
  expect(await adapter.findCreated(pasted, { creationId: crypto.randomUUID(), link: web("https://app.test/t"), destinationId: "10001/10010", since: 0 })).toBeNull();
});

test("required fields: asked for by kind, those Critiqs can't fill named, and sent as Jira takes them", async () => {
  const { adapter, pasted, standIn } = setup();
  expect(await adapter.requiredFields!(pasted, "10001/10010")).toEqual({ fields: [], unsupported: [] });
  expect(await adapter.requiredFields!(pasted, "10002/10021")).toEqual({ fields: [], unsupported: ["Escalation owner"] });
  const incident = await adapter.requiredFields!(pasted, "10002/10020");
  expect(incident).toEqual({
    fields: [
      { id: "priority", name: "Priority", kind: "choice", options: [{ id: "1", name: "Highest" }, { id: "3", name: "Medium" }] },
      { id: "customfield_10050", name: "Customer impact", kind: "paragraph", options: [] },
      { id: "customfield_10051", name: "Affected users", kind: "number", options: [] },
    ],
    unsupported: [],
  });
  const base = { destinationId: "10002/10020", title: "Checkout is down", body: md("Down"), labels: [], templateId: null };
  const missing = await adapter.create(pasted, { ...base, creationId: crypto.randomUUID() });
  expect(missing.status).toBe("refused");
  if (missing.status === "refused") expect(missing.error.message).toContain("Priority is required.");
  const notNumber = await adapter.create(pasted, { ...base, creationId: crypto.randomUUID(), fields: { priority: "1", customfield_10050: "All of them", customfield_10051: "many" } });
  expect(notNumber).toMatchObject({ status: "refused", error: { message: "Affected users must be a number." } });
  const made = await adapter.create(pasted, { ...base, creationId: crypto.randomUUID(), fields: { priority: "1", customfield_10050: "All of them\nreally", customfield_10051: "1200" } });
  expect(made.status).toBe("created");
  expect(standIn.issues.at(-1)!.fields).toEqual({
    priority: { id: "1" },
    customfield_10050: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "All of them" }, { type: "hardBreak" }, { type: "text", text: "really" }] }] },
    customfield_10051: 1200,
  });
});

test("a refusal Jira answers with is refused; a server error or a lost answer is unknown", async () => {
  const { adapter, pasted, standIn } = setup();
  const input = { destinationId: "10001/99999", title: "T", body: md("B"), labels: [], templateId: null, creationId: crypto.randomUUID() };
  expect((await adapter.create(pasted, input)).status).toBe("refused");
  standIn.intercept = () => "after";
  expect((await adapter.create(pasted, { ...input, destinationId: "10001/10010" })).status).toBe("unknown");
  // It was made: the retry finds it.
  standIn.intercept = null;
  expect((await adapter.findCreated(pasted, { creationId: input.creationId, link: null, destinationId: "10001/10010", since: 0 }))?.key).toBe("WEB-1");
  const bad = await adapter.create({ ...pasted, value: "dana@example.com:wrong" }, input);
  expect(bad).toMatchObject({ status: "refused" });
});

test("the link back is one remote link per thread, the comment and capture reach the issue, and status maps Jira's categories", async () => {
  const { adapter, pasted, site, standIn } = setup();
  const issue = addJiraIssue(standIn, { summary: "Linked", status: { name: "Done", categoryKey: "done" }, updated: jiraTimestamp(5_000) });
  const ticket = { tracker: "jira" as const, externalId: `${site.id}/${issue.id}`, key: issue.key, url: web(`https://acme.atlassian.net/browse/${issue.key}`), title: issue.summary, site: site.id };
  await adapter.linkBack(pasted, ticket, { url: web("https://app.test/t1"), title: "Thread one" });
  await adapter.linkBack(pasted, ticket, { url: web("https://app.test/t1"), title: "Thread one again" });
  await adapter.linkBack(pasted, ticket, { url: web("https://app.test/t2"), title: "Thread two" });
  expect(standIn.remoteLinks.map((link) => link.title)).toEqual(["Thread one again", "Thread two"]);
  await adapter.comment(pasted, ticket, ticketLinkComment("summary", { link: web("https://app.test/t1"), attribution: null }));
  expect(validAdf(standIn.comments[0]!.body)).toBeNull();
  await adapter.attachImage!(pasted, ticket, { data: new Blob([new Uint8Array([1, 2, 3])]), contentType: "image/png", name: "critiqs-capture.png" });
  expect(standIn.attachments).toEqual([{ issueId: issue.id, filename: "critiqs-capture.png", mimeType: "image/png", size: 3 }]);
  expect(await adapter.status(pasted, ticket)).toEqual({
    status: { label: "Done", category: "done" },
    asOf: 5_000,
    place: { key: issue.key, url: `https://acme.atlassian.net/browse/${issue.key}`, title: "Linked", webhookScope: "10001" },
  });
  // Another site's issue, or one the person can't see, isn't found.
  expect((await refusal(adapter.status(pasted, { ...ticket, externalId: `other-cloud/${issue.id}` }))).code).toBe("not-found");
  expect((await refusal(adapter.get(pasted, `${site.id}/424242`))).code).toBe("not-found");
});

test("labels are the site's, offered only where the issue type's create screen has them", async () => {
  const { adapter, pasted, standIn } = setup();
  expect((await adapter.labels!(pasted, "10001/10010")).map((label) => label.name)).toEqual(["Bug", "copy", "Wording"]);
  standIn.projects[0]!.issueTypes[0]!.fields = [];
  const fieldsWithoutLabels = standIn.projects[1]!.issueTypes[0]!.fields;
  expect(fieldsWithoutLabels.some((field) => field.fieldId === "labels")).toBe(false);
});

test("webhooks: registered, renewed, and removed only with a sign-in, following the given projects", async () => {
  let now = 10_000;
  const standIn = jiraStandIn({ now: () => now });
  const adapter = jiraAdapter({ fetch: standIn.fetchFn, baseUrl: ORIGIN, sitesUrl: ORIGIN });
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  const token = await signIn(standIn, site);
  const hook = await adapter.webhooks!.register(token, { url: "https://critiqs.test/trackers/jira/webhook", scopes: ["10001", "10002", "10001"], now });
  expect(hook).toEqual({ id: "1000", expiresAt: 10_000 + 30 * 86_400_000 });
  expect(standIn.webhooks[0]).toMatchObject({ url: "https://critiqs.test/trackers/jira/webhook", jqlFilter: "project IN (10001, 10002)", events: ["jira:issue_updated", "jira:issue_deleted"] });
  now = 20_000;
  expect(await adapter.webhooks!.renew(token, ["1000"])).toBe(20_000 + 30 * 86_400_000);
  await adapter.webhooks!.remove(token, ["1000"]);
  expect(standIn.webhooks).toEqual([]);
  // Only OAuth apps can register webhooks: a pasted token is refused.
  const pasted: TrackerToken = { method: "token", value: "dana@example.com:ATATT-dana-token", site };
  expect(await refusal(adapter.webhooks!.register(pasted, { url: "https://critiqs.test/trackers/jira/webhook", scopes: ["10001"], now }))).toBeInstanceOf(TrackerRefusal);
});

test("webhook registration and renewal take the answers Atlassian documents, and a registered webhook's ID is kept whatever its renewal answers", async () => {
  const now = 10_000;
  const standIn = jiraStandIn({ now: () => now });
  const adapter = jiraAdapter({ fetch: standIn.fetchFn, baseUrl: ORIGIN, sitesUrl: ORIGIN });
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  const token = await signIn(standIn, site);
  standIn.requests.length = 0;
  // Registered: {"webhookRegistrationResult":[{"createdWebhookId":1000}]}. A webhook lives 30 days from its registration.
  const hook = await adapter.webhooks!.register(token, { url: "https://critiqs.test/trackers/jira/webhook", scopes: ["10001"], now });
  expect(hook).toEqual({ id: "1000", expiresAt: now + 30 * 86_400_000 });
  expect(standIn.webhooks).toHaveLength(1);
  // Extended: the documented example's date, {"expirationDate":"2019-06-01T12:42:30.000+0000"} ...
  expect(await adapter.webhooks!.renew(token, ["1000"])).toBe(now + 30 * 86_400_000);
  // ... or a number, as the schema says.
  standIn.intercept = (method, path) => (method === "PUT" && path === "/rest/api/3/webhook/refresh" ? Response.json({ expirationDate: 1_700_000_000_000 }) : undefined);
  expect(await adapter.webhooks!.renew(token, ["1000"])).toBe(1_700_000_000_000);
  // An answer with neither is refused, not saved as a date.
  standIn.intercept = (method, path) => (method === "PUT" && path === "/rest/api/3/webhook/refresh" ? Response.json({ expirationDate: "soon" }) : undefined);
  expect((await refusal(adapter.webhooks!.renew(token, ["1000"]))).code).toBe("unavailable");
  // Registering needs no renewal, so an answer Critiqs can't read there never loses a webhook Jira made.
  standIn.intercept = (method, path) => (method === "PUT" && path === "/rest/api/3/webhook/refresh" ? Response.json({}) : undefined);
  expect(await adapter.webhooks!.register(token, { url: "https://critiqs.test/trackers/jira/webhook", scopes: ["10002"], now })).toEqual({ id: "1001", expiresAt: now + 30 * 86_400_000 });
});

test("an issue Jira answers with in place of the one asked for, such as a creation's read-back, is never taken for it", async () => {
  const { adapter, pasted, standIn } = setup();
  const other = addJiraIssue(standIn, { summary: "Someone else's" });
  // Asked for the new issue, Jira answers with another one: its attachments and comments would go there.
  standIn.intercept = (method, path) => (method === "GET" && /^\/rest\/api\/3\/issue\/\d+$/.test(path) && path !== `/rest/api/3/issue/${other.id}` ? standIn.handle(new Request(`${ORIGIN}/acme.atlassian.net/rest/api/3/issue/${other.id}`, { headers: { Authorization: `Basic ${btoa("dana@example.com:ATATT-dana-token")}`, Accept: "application/json" } })) : undefined);
  const made = await adapter.create(pasted, { destinationId: "10001/10010", title: "T", body: md("B"), labels: [], templateId: null, creationId: crypto.randomUUID() });
  expect(made.status).toBe("unknown");
});

test("Atlassian sign-in's email counts only when Atlassian doesn't say it is unverified", async () => {
  const standIn = jiraStandIn();
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  let verified: boolean | undefined;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await standIn.fetchFn(input, init);
    if (!new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/me") || verified === undefined) return answer;
    return Response.json({ ...(await answer.json()), email_verified: verified });
  }) as typeof fetch;
  const adapter = jiraAdapter({ fetch: fetchFn, baseUrl: ORIGIN, sitesUrl: ORIGIN });
  const token = await signIn(standIn, site);
  // Atlassian's documented answer has no such field: its email is compared.
  expect((await adapter.verify(token)).emails).toEqual(["dana@example.com"]);
  verified = false;
  expect((await adapter.verify(token)).emails).toEqual([]);
  verified = true;
  expect((await adapter.verify(token)).emails).toEqual(["dana@example.com"]);
});

test("a webhook is read only with a token signed with the app's secret that says when it expires, hasn't, and isn't good for long; it is only a notice that an issue on one site changed", async () => {
  const { standIn } = setup();
  const issue = addJiraIssue(standIn, { summary: "Hooked", status: { name: "In Review", categoryKey: "indeterminate" }, updated: jiraTimestamp(50_000) });
  const read = async (delivery: { body: string; headers: Record<string, string> }, now = 60_000) =>
    await readJiraWebhook(JIRA_STANDIN_SECRET, new TextEncoder().encode(delivery.body), delivery.headers.Authorization ?? null, now);
  const updated = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000 });
  // No status from the body: the token doesn't cover it.
  expect(await read(updated)).toEqual({ status: "notice", webhookIds: ["1000"], site: { name: "acme.atlassian.net" }, issueId: issue.id, deleted: false });
  const deleted = await jiraIssueWebhook(standIn, { event: "jira:issue_deleted", issueId: issue.id, webhookIds: [1000], sentAt: 70_000 });
  expect(await read(deleted, 70_000)).toMatchObject({ status: "notice", deleted: true });
  const gateway = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000, self: `https://api.atlassian.com/ex/jira/${standIn.site.cloudId}/rest/api/2/issue/${issue.id}` });
  expect(await read(gateway)).toMatchObject({ status: "notice", site: { id: standIn.site.cloudId } });
  // An address on another host that borrows the gateway's path, or none, names no site.
  for (const self of [`https://evil.example/ex/jira/${standIn.site.cloudId}/rest/api/2/issue/${issue.id}`, `https://acme.atlassian.net/ex/jira/${standIn.site.cloudId}/rest/api/2/issue/${issue.id}`, "http://acme.atlassian.net/rest/api/2/issue/1", null]) {
    expect(await read(await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000, self }))).toEqual({ status: "ignored" });
  }
  const forged = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000, secret: "not-the-secret" });
  expect(await read(forged)).toEqual({ status: "refused", reason: "wrong signature" });
  const old = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000, claims: { iat: 1, exp: 2 } });
  expect(await read(old, 2_000 + 5 * 60_000 + 1)).toEqual({ status: "refused", reason: "expired" });
  const forever = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000, claims: { iat: 60 } });
  expect(await read(forever)).toEqual({ status: "refused", reason: "no expiry" });
  const long = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: [1000], sentAt: 60_000, claims: { iat: 60, exp: 60 + 86_400 } });
  expect(await read(long)).toEqual({ status: "refused", reason: "good for too long" });
  expect(await read({ body: updated.body, headers: {} })).toEqual({ status: "refused", reason: "missing or malformed token" });
  const unrelated = { ...updated, body: JSON.stringify({ webhookEvent: "comment_created", comment: {} }) };
  expect(await read(unrelated)).toEqual({ status: "ignored" });
});

test("a Jira issue Critiqs holds is written to only when its address is its site's page for its key", async () => {
  const { adapter, pasted, site, standIn } = setup();
  const issue = addJiraIssue(standIn, { summary: "Linked" });
  const held = { tracker: "jira" as const, externalId: `${site.id}/${issue.id}`, key: issue.key, url: web(`https://acme.atlassian.net/browse/${issue.key}`), title: "t", site: site.id };
  standIn.requests.length = 0;
  for (const url of ["https://evil.example/browse/WEB-1", `https://acme.atlassian.net/browse/OTHER-9`, `https://other.atlassian.net/browse/${issue.key}`]) {
    expect(await refusal(adapter.comment(pasted, { ...held, url: web(url) }, md("Text")))).toBeInstanceOf(TrackerRefusal);
  }
  expect(await refusal(adapter.linkBack(pasted, { ...held, site: "another-cloud" }, { url: web("https://app.test/t1"), title: "t" }))).toBeInstanceOf(TrackerRefusal);
  expect(standIn.requests).toEqual([]);
  await adapter.comment(pasted, held, md("Text"));
  expect(standIn.comments).toHaveLength(1);
});
