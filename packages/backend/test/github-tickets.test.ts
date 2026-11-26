import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { decryptToken, STATUS_CHECK_MS, trackerTokenBinding } from "@critiqs/server";
import { addGithubIssue, type GithubStandIn, githubIssueWebhook, githubStandIn } from "@critiqs/server/github-standin";
import { api, internal } from "../convex/_generated/api";
import { anchor, reviewer, setup, upload } from "./harness";
import { list, thread as getThread } from "./pages";

// GitHub Issues on Convex, end to end against a stand-in for GitHub served
// over HTTP: connecting through the operator's GitHub App (its sign-in
// window, PKCE, the email rule, refreshing) or with a pasted fine-grained
// token; creating and linking issues; status from signed webhooks and from
// the check when a thread opens; templates and labels; and the refusals for
// someone outside an organization-only project.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const SITE = "https://backend.example";
const SECRET = "github-webhook-secret";
const ENV = [
  "CRITIQS_AI_ENCRYPTION_KEY",
  "CRITIQS_GITHUB_CLIENT_ID",
  "CRITIQS_GITHUB_CLIENT_SECRET",
  "CRITIQS_GITHUB_APP_SLUG",
  "CRITIQS_GITHUB_WEBHOOK_SECRET",
  "CRITIQS_GITHUB_API_URL",
  "CRITIQS_GITHUB_APP_URL",
  "CONVEX_SITE_URL",
  "CRITIQS_AUTH_ISSUER",
];
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
  // Lee and Riley reach the same repositories with their own pasted tokens; Lee may push to acme/web.
  github.users.push({ id: 1003, login: "lee-park", emails: [{ email: "lee@example.com", primary: true, verified: true }] });
  github.personalTokens.set("github_pat_lee", "lee-park");
  github.repositories.find((repository) => repository.name === "web")!.pushers.push("lee-park");
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  process.env.CRITIQS_GITHUB_API_URL = origin;
  process.env.CRITIQS_GITHUB_APP_URL = origin;
  process.env.CRITIQS_GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = SITE;
  process.env.CRITIQS_AUTH_ISSUER = "https://auth.example";
  delete process.env.CRITIQS_GITHUB_CLIENT_ID;
  delete process.env.CRITIQS_GITHUB_CLIENT_SECRET;
  delete process.env.CRITIQS_GITHUB_APP_SLUG;
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function withApp() {
  process.env.CRITIQS_GITHUB_CLIENT_ID = github.app.clientId;
  process.env.CRITIQS_GITHUB_CLIENT_SECRET = github.app.clientSecret;
  process.env.CRITIQS_GITHUB_APP_SLUG = "critiqs-test";
}

async function project() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const sam = t.withIdentity(reviewer("Sam"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: ["Bug"], capture: failedCapture });
  await sam.query(api.trackers.mine, {});
  return { t, dana, lee, sam, projectId, threadId };
}

const config = async (t: ReturnType<typeof setup>) => (await (await t.fetch("/critiqs/config")).json()) as { tickets?: { trackers: unknown[] } };

/** Runs Dana's GitHub sign-in through the backend's window and the stand-in's pages, as her browser would. */
async function signIn(t: ReturnType<typeof setup>, dana: ReturnType<ReturnType<typeof setup>["withIdentity"]>) {
  const started = await dana.action(api.trackers.startSignIn, { tracker: "github" });
  expect(started.url).toBe(`${SITE}/trackers/github/start`);
  const start = await t.fetch("/trackers/github/start", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ state: started.state, binding: started.binding }) });
  const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const authorize = new URL(start.headers.get("Location")!);
  // GitHub's page sends the window back to the callback with a code.
  const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("Location")!);
  const done = await t.fetch(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } });
  return { start, authorize, done };
}

test("/critiqs/config offers GitHub with a pasted token, or through the operator's GitHub App with its install link", async () => {
  const { t } = await project();
  expect((await config(t)).tickets?.trackers).toContainEqual({ id: "github", signIn: "token" });
  withApp();
  expect((await config(t)).tickets?.trackers).toContainEqual({ id: "github", signIn: "oauth", installUrl: `${github.origin}/apps/critiqs-test/installations/new` });
  // The app needs its client ID, secret, and public name together.
  delete process.env.CRITIQS_GITHUB_APP_SLUG;
  expect((await config(t)).tickets?.trackers).toContainEqual({ id: "github", signIn: "token" });
});

test("GitHub sign-in: the window goes to GitHub with PKCE, comes back with a code, and saves the account when one of its verified emails is the Critiqs one", async () => {
  withApp();
  const { t, dana } = await project();
  const { start, authorize, done } = await signIn(t, dana);
  expect(start.status).toBe(303);
  expect(start.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(authorize.origin + authorize.pathname).toBe(`${github.origin}/login/oauth/authorize`);
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: github.app.clientId, redirect_uri: `${SITE}/trackers/github/callback`, code_challenge_method: "S256" });
  expect(done.status).toBe(200);
  expect(await done.text()).toContain("GitHub is connected");
  // Dana's GitHub primary address is personal; her Critiqs address is another verified one.
  expect(await dana.query(api.trackers.mine, {})).toEqual([expect.objectContaining({ tracker: "github", method: "oauth", accountName: "dana-smith", site: null })]);
  const [row] = await t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  const danaId = row!.userId;
  expect(await decryptToken(KEY, trackerTokenBinding("github", danaId), row!.access)).toMatch(/^ghu_standin_/);
  expect(row!.expiresAt).toBeGreaterThan(Date.now() + 28_000_000);
  // Through the app, Dana's repositories are those where it is installed and that take issues.
  expect((await dana.action(api.tickets.destinations, { tracker: "github" })).map((repository) => repository.id)).toEqual(["acme/api", "acme/web"]);

  // An expired user access token is refreshed with GitHub before use; the refresh token used is spent.
  const spent = await decryptToken(KEY, trackerTokenBinding("github", danaId), row!.refresh!);
  await t.run((ctx) => ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 }));
  const fresh = await t.action(internal.trackers.accessToken, { userId: danaId, accountId: row!.accountId, tracker: "github" });
  expect(fresh.value).not.toBe(await decryptToken(KEY, trackerTokenBinding("github", danaId), row!.access));
  expect(github.refreshTokens.has(spent!)).toBe(false);
});

test("GitHub sign-in into an account with none of the Critiqs email's addresses saves nothing, and the window says so", async () => {
  withApp();
  const { t, dana } = await project();
  github.signInAs = "riley";
  const { done } = await signIn(t, dana);
  expect(done.status).toBe(403);
  const page = await done.text();
  expect(page).toContain("riley@example.com");
  expect(page).toContain("fine-grained personal access token");
  expect(page).not.toContain("dana@example.com");
  expect(await dana.query(api.trackers.mine, {})).toEqual([]);
  // Declining in GitHub stores nothing either.
  github.signInAs = null;
  expect(await (await signIn(t, dana)).done.text()).toContain("allow Critiqs to use your GitHub account. You can close this window.");
  // Without the app, GitHub sign-in can't start, and a pasted token still connects.
  delete process.env.CRITIQS_GITHUB_CLIENT_ID;
  await expect(dana.action(api.trackers.startSignIn, { tracker: "github" })).rejects.toThrow("GitHub Issues sign-in isn't set up on this deployment.");
  expect((await t.fetch("/trackers/github/start")).status).toBe(404);
  expect(await dana.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_dana" })).toMatchObject({ tracker: "github", method: "token", accountName: "dana-smith" });
});

test("a reviewer pastes a token, creates an issue from the thread with the link in its text, and everyone sees it; a lost answer is found on retry", async () => {
  const { t, lee, sam, projectId, threadId } = await project();
  const storageId = await upload(lee, projectId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
  await lee.mutation(api.threads.attachScreenshot, { threadId, storageId });
  await expect(lee.action(api.tickets.destinations, { tracker: "github" })).rejects.toThrow("Connect GitHub Issues in Your trackers first.");
  await expect(lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_wrong" })).rejects.toThrow("GitHub didn't accept this token.");
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "github" });
  // GitHub has no upload API: the capture stays with the thread, and the text says how to see it.
  expect(draft.body).toContain("- Capture: saved with the thread; open its link to view it");

  const create = { threadId, submissionId: crypto.randomUUID(), tracker: "github" as const, destinationId: "acme/web", title: draft.title, body: draft.body, createdFromCritiqs: true, labelIds: ["bug"] };
  github.intercept = (method, path) => (method === "POST" && path === "/repos/acme/web/issues" ? "after" : undefined);
  await expect(lee.action(api.tickets.create, create)).rejects.toThrow("wasn't what Critiqs expected");
  github.intercept = null;
  const view = await lee.action(api.tickets.create, create);
  expect(view).toMatchObject({ key: "web#1", status: { label: "Open", category: "open" }, linkedByName: "Lee", canAddLinkBack: false });
  expect(github.issues).toHaveLength(1);
  const [issue] = github.issues;
  expect(issue!.body).toContain(`[open the thread](<https://review.example/app?critiqs=${threadId}>)`);
  expect(issue!.body).toContain("Created from Critiqs by Lee");
  expect(issue!.labels).toEqual(["bug"]);
  // The link is in the text already: no comment.
  expect(github.comments).toEqual([]);
  expect((await list(sam, { projectId }))[0]!.tickets).toEqual([{ tracker: "github", key: "web#1", status: { label: "Open", category: "open" } }]);
  expect((await getThread(sam, { threadId })).tickets).toEqual([expect.objectContaining({ key: "web#1", url: `${github.origin}/acme/web/issues/1` })]);
  void t;
});

test("a reviewer searches GitHub, links an existing issue with a link-back comment and a summary, and unlinks it", async () => {
  const { dana, lee, threadId } = await project();
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Department label is unclear" });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const [found] = await lee.action(api.tickets.search, { tracker: "github", query: "department" });
  expect(found).toEqual({ tracker: "github", externalId: existing.nodeId, key: "web#12", url: `${github.origin}/acme/web/issues/12`, title: "Department label is unclear", status: { label: "Open", category: "open" } });
  expect(await lee.action(api.tickets.search, { tracker: "github", query: "acme/web#12" })).toEqual([found!]);

  const view = await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: true });
  expect(view).toMatchObject({ key: "web#12", createdFromCritiqs: false });
  expect(github.comments.map((comment) => comment.body)).toEqual([`> Department is wrong\n\nThread: [open the thread](<https://review.example/app?critiqs=${threadId}>)\n`, expect.stringContaining("Linked from Critiqs by Lee")]);
  // Linking again changes nothing and asks GitHub nothing.
  github.requests.length = 0;
  expect((await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: true }))._id).toBe(view._id);
  expect(github.requests).toEqual([]);
  await dana.mutation(api.tickets.unlink, { linkId: view._id });
  expect((await getThread(lee, { threadId })).tickets).toEqual([]);
});

test("once a project is limited to its organization, someone outside it can't draft, create, link, unlink, or check its GitHub tickets", async () => {
  const { t, dana, lee, threadId, projectId } = await project();
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Department label is unclear" });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const linked = await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: false });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  const riley = t.withIdentity(reviewer("Riley"));
  await riley.mutation(api.users.sync, {});
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });

  const refused = "This project is limited to members of its organization. Ask one of its admins to invite you.";
  github.requests.length = 0;
  const create = { threadId, submissionId: crypto.randomUUID(), tracker: "github" as const, destinationId: "acme/web", title: "T", body: "Text", createdFromCritiqs: false };
  await expect(lee.action(api.tickets.draft, { threadId, tracker: "github" })).rejects.toThrow(refused);
  await expect(lee.action(api.ai.draftTicket, { threadId, tracker: "github", destinationId: "acme/web", templateId: null })).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.options, { threadId, tracker: "github", destinationId: "acme/web" })).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.create, create)).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: true })).rejects.toThrow(refused);
  await expect(lee.mutation(api.tickets.unlink, { linkId: linked._id })).rejects.toThrow(refused);
  await expect(lee.mutation(api.ticketStatus.checkStatus, { threadId })).rejects.toThrow(refused);
  // Refused before anything reached GitHub.
  expect(github.requests).toEqual([]);

  // A member of the organization still can.
  github.personalTokens.set("github_pat_riley", "riley");
  await riley.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_riley" });
  expect((await riley.action(api.tickets.create, { ...create, submissionId: crypto.randomUUID() })).key).toBe("web#13");
});

test("a signed GitHub webhook updates every thread linking the issue and Resolve when done resolves them; forged, replayed, or older deliveries change nothing", async () => {
  const { t, dana, lee, sam, projectId, threadId } = await project();
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Department label is unclear" });
  const otherId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Same label elsewhere", tags: [], capture: failedCapture });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  for (const id of [threadId, otherId]) await lee.action(api.tickets.link, { threadId: id, tracker: "github", externalId: existing.nodeId, comment: false });
  await dana.mutation(api.ticketStatus.setResolveWhenDone, { projectId, on: true });
  const deliver = (delivery: { body: string; headers: Record<string, string> }) => t.fetch("/trackers/github/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
  const statuses = async () => (await list(sam, { projectId })).map((row) => row.tickets?.[0]?.status?.label);
  /** GitHub's time of a change `ago` milliseconds before now: deliveries arrive within seconds of it. */
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  const closed = await githubIssueWebhook(SECRET, { action: "closed", issue: { nodeId: existing.nodeId, number: 12, state: "closed", stateReason: "completed", updatedAt: ago(60_000) } });
  expect((await deliver(await githubIssueWebhook("not-the-secret", { action: "closed", issue: { nodeId: existing.nodeId, state: "closed", updatedAt: ago(60_000) } }))).status).toBe(401);
  expect((await deliver({ ...closed, body: closed.body.replace('"closed"', '"open"') })).status).toBe(401);
  expect(await statuses()).toEqual(["Open", "Open"]);

  expect((await deliver(closed)).status).toBe(200);
  expect(await statuses()).toEqual(["Closed", "Closed"]);
  for (const id of [threadId, otherId]) expect(await getThread(sam, { threadId: id })).toMatchObject({ status: "resolved", resolvedByTickets: true });
  // The same delivery again, or an older change delivered late: still closed.
  expect((await deliver(closed)).status).toBe(200);
  expect((await deliver(await githubIssueWebhook(SECRET, { action: "edited", issue: { nodeId: existing.nodeId, state: "open", updatedAt: ago(120_000) } }))).status).toBe(200);
  expect(await statuses()).toEqual(["Closed", "Closed"]);
  // GitHub's ping when the webhook is added is answered and ignored.
  const ping = await githubIssueWebhook(SECRET, { action: "created", issue: { nodeId: existing.nodeId, state: "open", updatedAt: ago(0) }, event: "ping" });
  expect((await deliver(ping)).status).toBe(200);
  expect(await statuses()).toEqual(["Closed", "Closed"]);
  // A change GitHub signed two days ago, sent again now, is past what a delivery is good for.
  expect((await deliver(await githubIssueWebhook(SECRET, { action: "reopened", issue: { nodeId: existing.nodeId, state: "open", updatedAt: ago(2 * 86_400_000) } }))).status).toBe(200);
  expect(await statuses()).toEqual(["Closed", "Closed"]);
  // A deleted issue shows Deleted.
  expect((await deliver(await githubIssueWebhook(SECRET, { action: "deleted", issue: { nodeId: existing.nodeId, state: "closed", updatedAt: ago(60_000) } }))).status).toBe(200);
  expect(await statuses()).toEqual(["Deleted", "Deleted"]);

  // Without the secret, the route refuses every call.
  delete process.env.CRITIQS_GITHUB_WEBHOOK_SECRET;
  expect((await deliver(closed)).status).toBe(404);
});

test("opening a thread checks a GitHub ticket's status with the linker's token; after they disconnect, the last status stays, marked last known", async () => {
  const { t, lee, sam, threadId } = await project();
  const existing = addGithubIssue(github, "acme/web", { number: 12, title: "Department label is unclear" });
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  const link = await lee.action(api.tickets.link, { threadId, tracker: "github", externalId: existing.nodeId, comment: false });
  github.setState(existing.nodeId, "closed", "not_planned");
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect((await getThread(sam, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "Closed as not planned", category: "canceled" }, statusStale: false });

  await lee.mutation(api.trackers.disconnect, { tracker: "github" });
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1, statusCheckStartedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  github.requests.length = 0;
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(github.requests).toEqual([]);
  expect((await getThread(sam, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "Closed as not planned" }, statusStale: true });
});

test("a project's owner turns on a repository's issue form; the draft fills its fields, and creating adds the template's labels and the tag's", async () => {
  const { dana, lee, projectId, threadId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_lee" });
  await dana.action(api.trackers.connectWithToken, { tracker: "github", token: "github_pat_dana" });
  const groups = await dana.action(api.tickets.trackerTemplates, { projectId, tracker: "github" });
  expect(groups.map((group) => [group.destination.name, group.templates.map((template) => template.name)])).toEqual([["acme/web", ["Bug report", "Feature request"]]]);
  await dana.mutation(api.tickets.saveTemplateSettings, { projectId, on: true, templates: [{ tracker: "github", destinationId: "acme/web", templateId: "acme/web:bug.yml", name: "Bug report" }] });

  // Lee's thread is tagged Bug: the repository's bug label is suggested.
  expect(await lee.action(api.tickets.options, { threadId, tracker: "github", destinationId: "acme/web" })).toEqual({
    templates: [{ id: "acme/web:bug.yml", name: "Bug report" }],
    labels: [{ id: "bug", name: "bug" }],
  });
  const plain = await lee.action(api.tickets.draft, { threadId, tracker: "github", destinationId: "acme/web", templateId: "acme/web:bug.yml" });
  expect(plain.body.startsWith("### What happened?\n\n> Department is wrong\n")).toBe(true);
  expect(plain.body).toContain("### Code of Conduct\n\n- [ ] I agree to follow this project's Code of Conduct");

  const view = await lee.action(api.tickets.create, {
    threadId,
    submissionId: crypto.randomUUID(),
    tracker: "github",
    destinationId: "acme/web",
    title: plain.title,
    body: plain.body,
    createdFromCritiqs: false,
    templateId: "acme/web:bug.yml",
    labelIds: ["bug"],
  });
  // The form's own labels are bug and triage; the repository has only bug.
  expect(github.issues.find((issue) => issue.nodeId === view.externalId)!.labels).toEqual(["bug"]);
  // Attribution off: the thread's link stays in the text all the same, since GitHub has no other place for it.
  expect(github.issues.find((issue) => issue.nodeId === view.externalId)!.body).toContain(`critiqs=${threadId}`);
});
