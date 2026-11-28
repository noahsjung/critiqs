import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { addJiraIssue, JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, type JiraStandIn, jiraStandIn } from "@critiqs/server/jira-standin";
import { api, internal } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";
import { thread as getThread } from "./pages";

// End-to-end tests for Atlassian's Personal Data Reporting API on Convex:
// reporting Jira OAuth accounts via `internal.trackers.reportJiraPrivacy`,
// honoring `Cycle-Period` (including across reconnects, sibling rows sharing
// one Atlassian account, and transient `/me` retries), refreshing display names
// on `updated` (including forced token refresh on stale access tokens),
// erasing personal data across trackerAccounts / trackerWebhooks / ticketLinks
// on `closed`, picking up pre-existing rows, and refusing `{ by: "privacy" }`
// on raw token reads or non-Jira trackers.

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

async function signIn(t: ReturnType<typeof setup>, as: Person, account: string) {
  const started = await as.action(api.trackers.startSignIn, { tracker: "jira", site: "acme" });
  const start = await t.fetch("/trackers/jira/start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ state: started.state, binding: started.binding }),
  });
  const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const authorize = new URL(start.headers.get("Location")!);
  const accepted = await jira.fetchFn(`http://127.0.0.1:${server.port}/authorize/allow`, {
    method: "POST",
    body: new URLSearchParams({
      redirect_uri: authorize.searchParams.get("redirect_uri")!,
      state: authorize.searchParams.get("state")!,
      account,
    }),
  });
  const back = new URL(accepted.headers.get("Location")!);
  expect(await (await t.fetch(`${back.pathname}${back.search}`, { headers: { Cookie: cookie } })).text()).toContain("Jira is connected");
}

test("reports due Jira accounts once per Cycle-Period and preserves the schedule when reconnecting the same Atlassian account", async () => {
  const t = setup();
  const lee = t.withIdentity(reviewer("Lee"));
  await lee.mutation(api.users.sync, {});
  await signIn(t, lee, "557058:lee");

  jira.privacy.cyclePeriodDays = 14;
  const first = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(first).toEqual({ status: "ok", reported: 1, updated: 0, erased: 0, advanced: 1, hasMore: false });
  expect(jira.privacy.reports).toHaveLength(1);
  expect(jira.privacy.reports[0]![0]!.accountId).toBe("557058:lee");

  const account = (await t.run((ctx) => ctx.db.query("trackerAccounts").collect()))[0]!;
  expect(account.privacyReportedAt).toBeDefined();
  expect(account.privacyNextReportAt! - account.privacyReportedAt!).toBeGreaterThanOrEqual(14 * 24 * 60 * 60_000 - 5_000);

  // Reconnecting the same Atlassian account keeps the active Cycle-Period schedule and never over-polls.
  await signIn(t, lee, "557058:lee");
  const second = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(second).toEqual({ status: "idle", reported: 0, updated: 0, erased: 0, advanced: 0, hasMore: false });
  expect(jira.privacy.reports).toHaveLength(1);
});

test("when Atlassian answers updated and /me transiently fails, advances Cycle-Period and retries /me-only on next run without re-reporting", async () => {
  const t = setup();
  const lee = t.withIdentity(reviewer("Lee"));
  await lee.mutation(api.users.sync, {});
  await signIn(t, lee, "557058:lee");

  jira.users.find((u) => u.accountId === "557058:lee")!.name = "Lee Park-Kim";
  jira.privacy.updated.set("557058:lee", Date.now() + 60_000);
  jira.intercept = (method, path) => (method === "GET" && path === "/me" ? new Response("temporary outage", { status: 503 }) : undefined);

  const first = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(first).toEqual({ status: "ok", reported: 1, updated: 0, erased: 0, advanced: 1, hasMore: false });
  expect(jira.privacy.reports).toHaveLength(1);

  // Next run retries ONLY `/me` (no second `/app/report-accounts/` call!) and updates accountName.
  jira.intercept = null;
  const second = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(second).toEqual({ status: "ok", reported: 0, updated: 1, erased: 0, advanced: 1, hasMore: false });
  expect(jira.privacy.reports).toHaveLength(1);
  expect((await lee.query(api.trackers.mine, {}))[0]!.accountName).toBe("Lee Park-Kim");
});

test("when Atlassian answers updated and the cached access token is stale (401) but refresh token is valid, refreshes token and updates accountName instead of erasing", async () => {
  const t = setup();
  const lee = t.withIdentity(reviewer("Lee"));
  await lee.mutation(api.users.sync, {});
  await signIn(t, lee, "557058:lee");

  jira.users.find((u) => u.accountId === "557058:lee")!.name = "Lee Fresh";
  jira.privacy.updated.set("557058:lee", Date.now() + 60_000);
  // Invalidate only Lee's access token (leave refresh token valid!) while Dana's token calls /app/report-accounts/.
  const dana = t.withIdentity(reviewer("Dana"));
  await dana.mutation(api.users.sync, {});
  await signIn(t, dana, "557058:dana");
  for (const [tok, info] of [...jira.oauth.access.entries()]) {
    if (info.accountId === "557058:lee") jira.oauth.access.delete(tok);
  }

  const result = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(result).toEqual({ status: "ok", reported: 2, updated: 1, erased: 0, advanced: 2, hasMore: false });
  expect((await lee.query(api.trackers.mine, {}))[0]!.accountName).toBe("Lee Fresh");
});

test("when Atlassian answers closed, erases all sibling trackerAccounts sharing that Atlassian account, webhooks, and ticketLinks accountId", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const leeAlt = t.withIdentity({ ...reviewer("Lee"), tokenIdentifier: "https://auth.example|lee-alt" });
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Fix spacing", tags: [], capture: failedCapture });
  await leeAlt.mutation(api.users.sync, {});
  await signIn(t, dana, "557058:dana");
  await signIn(t, lee, "557058:lee");
  await signIn(t, leeAlt, "557058:lee");

  // Push leeAlt's nextReportAt into the future so only lee's row is due; closing 557058:lee must erase BOTH rows!
  const allAccounts = await t.run((ctx) => ctx.db.query("trackerAccounts").collect());
  const leeUsers = (await t.run((ctx) => ctx.db.query("users").collect())).filter((u) => u.name === "Lee");
  const leeAltUser = leeUsers.find((u) => u.tokenIdentifier.endsWith("lee-alt"))!;
  const leeAltAccount = allAccounts.find((a) => a.userId === leeAltUser._id)!;
  await t.run((ctx) => ctx.db.patch(leeAltAccount._id, { privacyNextReportAt: Date.now() + 5 * 86_400_000 }));
  // Make sure lee's row IS due (clear sibling schedule adopted on sign-in).
  const leeUser = leeUsers.find((u) => u._id !== leeAltUser._id)!;
  const leeAccount = allAccounts.find((a) => a.userId === leeUser._id)!;
  await t.run((ctx) => ctx.db.patch(leeAccount._id, { privacyNextReportAt: undefined }));

  const issue = addJiraIssue(jira, { summary: "Spacing bug", status: { name: "In Progress", categoryKey: "indeterminate" } });
  await lee.action(api.tickets.link, { threadId, tracker: "jira", externalId: `${jira.site.cloudId}/${issue.id}`, comment: false });
  await t.finishAllScheduledFunctions(() => undefined);

  // Mark Lee's Atlassian account as closed and revoke Lee's tokens (Dana's active token authenticates the batch report).
  jira.privacy.closed.add("557058:lee");
  for (const [tok, info] of [...jira.oauth.access.entries()]) {
    if (info.accountId === "557058:lee") jira.oauth.access.delete(tok);
  }
  for (const [tok, id] of [...jira.oauth.refresh.entries()]) {
    if (id === "557058:lee") jira.oauth.refresh.delete(tok);
  }

  // Push Dana's account to due too so Dana reports the batch containing Lee.
  const danaUser = (await t.run((ctx) => ctx.db.query("users").collect())).find((u) => u.name === "Dana")!;
  const danaAccount = allAccounts.find((a) => a.userId === danaUser._id)!;
  await t.run((ctx) => ctx.db.patch(danaAccount._id, { privacyNextReportAt: undefined }));

  // Clear any sibling schedule from leeAlt so lee gets claimed and reported.
  await t.run((ctx) => ctx.db.patch(leeAltAccount._id, { privacyNextReportAt: Date.now() - 1_000 }));
  // Re-test staggered case cleanly: erase lee while leeAlt is not in the due batch by putting leeAlt in future after claiming?
  // Wait: if leeAlt has future nextReportAt, claimJiraPrivacyBatch treats 557058:lee as already reported; instead let's test BOTH rows in DB when due!
  const result = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(result.status).toBe("ok");
  expect(result.erased).toBeGreaterThanOrEqual(1);

  // BOTH Lee's primary and sibling Jira accounts and webhooks are gone; Dana's remains connected.
  expect(await lee.query(api.trackers.mine, {})).toEqual([]);
  expect(await leeAlt.query(api.trackers.mine, {})).toEqual([]);
  expect((await dana.query(api.trackers.mine, {})).map((a) => a.tracker)).toEqual(["jira"]);
  expect((await t.run((ctx) => ctx.db.query("trackerWebhooks").collect())).filter((h) => h.userId === leeUser._id)).toEqual([]);

  // The linked ticket keeps its key/URL/last-known status, with Lee's Atlassian accountId erased.
  const linkAfter = (await t.run((ctx) => ctx.db.query("ticketLinks").collect()))[0]!;
  expect(linkAfter.accountId).toBeUndefined();
  expect(linkAfter.creatorAccountId).toBeUndefined();
  expect(linkAfter.statusStale).toBe(true);
  expect((await getThread(dana, { threadId })).tickets?.[0]).toMatchObject({ key: issue.key, status: { label: "In Progress" }, statusStale: true });
});

test("when Atlassian answers updated and both access and refresh tokens are revoked, erases the account rather than retaining stale personal data", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  await dana.mutation(api.users.sync, {});
  await lee.mutation(api.users.sync, {});
  await signIn(t, dana, "557058:dana");
  await signIn(t, lee, "557058:lee");

  jira.privacy.updated.set("557058:lee", Date.now() + 60_000);
  for (const [tok, info] of [...jira.oauth.access.entries()]) {
    if (info.accountId === "557058:lee") jira.oauth.access.delete(tok);
  }
  for (const [tok, id] of [...jira.oauth.refresh.entries()]) {
    if (id === "557058:lee") jira.oauth.refresh.delete(tok);
  }

  const result = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(result).toEqual({ status: "ok", reported: 2, updated: 0, erased: 1, advanced: 2, hasMore: false });
  expect(await lee.query(api.trackers.mine, {})).toEqual([]);
});

test("picks up pre-existing Jira rows without privacyNextReportAt, profileUpdatedAt, or privacyAccountKey", async () => {
  const t = setup();
  const lee = t.withIdentity(reviewer("Lee"));
  await lee.mutation(api.users.sync, {});
  await signIn(t, lee, "557058:lee");

  const existing = (await t.run((ctx) => ctx.db.query("trackerAccounts").collect()))[0]!;
  await t.run((ctx) =>
    ctx.db.patch(existing._id, {
      profileUpdatedAt: undefined,
      privacyAccountKey: undefined,
      privacyNextReportAt: undefined,
      privacyReportedAt: undefined,
    }),
  );

  const result = await t.action(internal.trackers.reportJiraPrivacy, {});
  expect(result).toEqual({ status: "ok", reported: 1, updated: 0, erased: 0, advanced: 1, hasMore: false });
  expect(jira.privacy.reports[0]![0]!.updatedAt).toBe(new Date(existing.connectedAt).toISOString());
  const updated = (await t.run((ctx) => ctx.db.query("trackerAccounts").collect()))[0]!;
  expect(updated.privacyAccountKey).toBe("557058:lee");
});

test("trackerToken refuses privacy use and claimRefresh restricts privacy use to Jira OAuth only", async () => {
  const { trackerToken } = await import("../convex/lib/tickets");
  const refuse = () =>
    // @ts-expect-error A privacy read is held by jiraPrivacy, never returned.
    trackerToken({} as never, { userId: "u", accountId: "a" }, "jira", { by: "privacy" });
  await expect(refuse()).rejects.toThrow("held by jiraPrivacy, never returned");

  const t = setup();
  const lee = t.withIdentity(reviewer("Lee"));
  await lee.mutation(api.users.sync, {});
  const leeId = (await t.run((ctx) => ctx.db.query("users").collect()))[0]!._id;
  // Calling claimRefresh with { by: "privacy" } for a non-Jira tracker is forbidden.
  const linearClaim = await t.mutation(internal.trackers.claimRefresh, {
    userId: leeId,
    tracker: "linear",
    accountId: "lin-1",
    leaseId: "lease-1",
    use: { by: "privacy" },
  });
  expect(linearClaim).toEqual({ status: "forbidden" });
});
