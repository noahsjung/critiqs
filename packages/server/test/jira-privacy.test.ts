import { expect, test } from "bun:test";
import { encryptToken, trackerTokenBinding } from "../src/ai/secrets.ts";
import { CritiqsError } from "../src/errors.ts";
import {
  type AccessSteps,
  jiraPrivacyCapability,
  ticketsDeploymentFromEnv,
  type TokenUse,
  trackerAccessToken,
  trackerPrivacyAccess,
} from "../src/tickets/accounts.ts";
import { JIRA_PRIVACY_RETRY_MS, type JiraPrivacyOutcome, reportJiraPersonalData } from "../src/tickets/privacy.ts";
import { TrackerRefusal, type TrackerToken } from "../src/tickets/trackers/index.ts";
import {
  exchangeJiraCode,
  JIRA_PRIVACY_MAX_ACCOUNTS,
  jiraAccountId,
  parseCyclePeriodDays,
  parseRetryAfterMs,
  readJiraProfile,
  reportJiraAccounts,
} from "../src/tickets/trackers/jira.ts";
import { JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, jiraStandIn } from "./jira-standin.ts";

// Atlassian Personal Data Reporting API (3LO):
// low-level HTTP contract, capability confinement (tokens read for `privacy`
// never leave the capability), deduplication using oldest personal-data age,
// Cycle-Period & 429 Retry-After handling, `closed` erasure, `updated` profile
// refresh (including forced token refresh on 401 and `/me`-only retry on 5xx),
// and reporter candidate ordering & safety.

const ORIGIN = "https://jira.test";
const KEY = "operator-encryption-key-".padEnd(48, "x");
const deployment = ticketsDeploymentFromEnv({
  CRITIQS_AI_ENCRYPTION_KEY: KEY,
  CRITIQS_JIRA_CLIENT_ID: JIRA_STANDIN_CLIENT_ID,
  CRITIQS_JIRA_CLIENT_SECRET: JIRA_STANDIN_SECRET,
  CRITIQS_JIRA_API_URL: ORIGIN,
  CRITIQS_JIRA_AUTH_URL: ORIGIN,
  CRITIQS_JIRA_SITES_URL: ORIGIN,
});

async function oauthToken(standIn: ReturnType<typeof jiraStandIn>, account = "557058:dana"): Promise<TrackerToken> {
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  const allow = await standIn.fetchFn(`${ORIGIN}/authorize/allow`, {
    method: "POST",
    body: new URLSearchParams({ redirect_uri: "https://critiqs.test/trackers/jira/callback", state: "s", account }),
  });
  const code = new URL(allow.headers.get("Location")!).searchParams.get("code")!;
  const tokens = await exchangeJiraCode(
    { fetch: standIn.fetchFn, baseUrl: ORIGIN },
    { clientId: JIRA_STANDIN_CLIENT_ID, clientSecret: JIRA_STANDIN_SECRET },
    { code, redirectUri: "https://critiqs.test/trackers/jira/callback" },
    1_000,
  );
  return { method: "oauth", value: tokens.access, site };
}

test("jiraAccountId strips the cloudId prefix and rejects malformed IDs and Atlassian's unknown sentinel", () => {
  expect(jiraAccountId("cloud-1/557058:dana")).toBe("557058:dana");
  expect(jiraAccountId("cloud-1/5be24ad8b1653240376955d2")).toBe("5be24ad8b1653240376955d2");
  expect(jiraAccountId("cloud-1/unknown")).toBeNull();
  expect(jiraAccountId("cloud-1/UNKNOWN")).toBeNull();
  expect(jiraAccountId("no-slash")).toBeNull();
  expect(jiraAccountId("/leading-slash")).toBeNull();
  expect(jiraAccountId("cloud-1/")).toBeNull();
  expect(jiraAccountId(`cloud-1/${"a".repeat(129)}`)).toBeNull();
  expect(jiraAccountId("cloud-1/has space")).toBeNull();
});

test("Cycle-Period and Retry-After header parsing clamps safely and supports HTTP-date", () => {
  expect(parseCyclePeriodDays(null)).toBe(7);
  expect(parseCyclePeriodDays("14")).toBe(14);
  expect(parseCyclePeriodDays(" 1 ")).toBe(1);
  expect(parseCyclePeriodDays("0")).toBe(7);
  expect(parseCyclePeriodDays("-5")).toBe(7);
  expect(parseCyclePeriodDays("abc")).toBe(7);
  expect(parseCyclePeriodDays("99999")).toBe(365);

  const now = Date.UTC(2026, 10, 28, 0, 0, 0);
  expect(parseRetryAfterMs(null, now)).toBe(60 * 60_000);
  expect(parseRetryAfterMs("0", now)).toBe(60_000);
  expect(parseRetryAfterMs("10", now)).toBe(60_000);
  expect(parseRetryAfterMs("300", now)).toBe(300_000);
  expect(parseRetryAfterMs("99999999", now)).toBe(24 * 60 * 60_000);
  expect(parseRetryAfterMs("Sat, 28 Nov 2026 00:05:00 GMT", now)).toBe(5 * 60_000);
  expect(parseRetryAfterMs("bad", now)).toBe(60 * 60_000);
});

test("reportJiraAccounts handles 204, 200 (closed/updated with Atlassian test IDs), Cycle-Period, 429, malformed entries, and >90 accounts", async () => {
  const standIn = jiraStandIn();
  const token = await oauthToken(standIn);
  const endpoint = { fetch: standIn.fetchFn, baseUrl: ORIGIN };
  const now = 1_700_000_000_000;

  // Atlassian's active test ID -> 204 No Content with Cycle-Period header (clamps future updatedAt to now).
  standIn.privacy.cyclePeriodDays = 10;
  const active = await reportJiraAccounts(endpoint, token.value, [{ accountId: "5be24ad8b1653240376955d2", updatedAt: now + 999_999 }], now);
  expect(active).toEqual({ status: "ok", accounts: [], cyclePeriodDays: 10 });
  expect(standIn.privacy.reports[0]).toEqual([{ accountId: "5be24ad8b1653240376955d2", updatedAt: new Date(now).toISOString() }]);

  // Atlassian's closed test ID + an updated user -> 200 JSON.
  standIn.privacy.updated.set("557058:dana", now + 500_000);
  const actions = await reportJiraAccounts(
    endpoint,
    token.value,
    [
      { accountId: "5be24ba3f91c106033269289", updatedAt: now },
      { accountId: "557058:dana", updatedAt: now },
    ],
    now,
  );
  expect(actions).toEqual({
    status: "ok",
    accounts: [
      { accountId: "5be24ba3f91c106033269289", status: "closed" },
      { accountId: "557058:dana", status: "updated" },
    ],
    cyclePeriodDays: 10,
  });

  // Malformed response entry throws instead of silently treating as unchanged.
  standIn.intercept = (_method, path) =>
    path === "/app/report-accounts/" ? Response.json({ accounts: [{ accountId: "557058:dana", status: "mystery" }] }) : undefined;
  await expect(reportJiraAccounts(endpoint, token.value, [{ accountId: "557058:dana", updatedAt: now }], now)).rejects.toBeInstanceOf(CritiqsError);

  // 429 rate-limited respects Retry-After.
  standIn.intercept = (_method, path) => (path === "/app/report-accounts/" ? new Response(null, { status: 429, headers: { "Retry-After": "180" } }) : undefined);
  expect(await reportJiraAccounts(endpoint, token.value, [{ accountId: "557058:dana", updatedAt: now }], now)).toEqual({
    status: "rate-limited",
    retryAfterMs: 180_000,
  });

  // 403 missing scope throws TrackerRefusal("forbidden").
  standIn.intercept = (_method, path) => (path === "/app/report-accounts/" ? new Response("forbidden", { status: 403 }) : undefined);
  await expect(reportJiraAccounts(endpoint, token.value, [{ accountId: "557058:dana", updatedAt: now }], now)).rejects.toBeInstanceOf(TrackerRefusal);

  // Over 90 accounts is refused client-side without hitting Atlassian.
  standIn.intercept = null;
  const tooMany = Array.from({ length: JIRA_PRIVACY_MAX_ACCOUNTS + 1 }, (_, i) => ({ accountId: `id-${i}`, updatedAt: 1_000 }));
  await expect(reportJiraAccounts(endpoint, token.value, tooMany, now)).rejects.toBeInstanceOf(CritiqsError);
});

test("readJiraProfile returns bounded display names and detects closed account_status from /me", async () => {
  const standIn = jiraStandIn({
    users: [{ accountId: "557058:dana", email: "dana@example.com", name: "D".repeat(500), apiToken: "t" }],
  });
  const token = await oauthToken(standIn);
  const profile = await readJiraProfile({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, token.value);
  expect(profile.accountId).toBe("557058:dana");
  expect(profile.closed).toBe(false);
  expect(profile.accountName.length).toBeLessThanOrEqual(200);

  standIn.intercept = (_m, path) => (path === "/me" ? Response.json({ account_id: "557058:dana", account_status: "closed" }) : undefined);
  expect(await readJiraProfile({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, token.value)).toEqual({
    accountId: "557058:dana",
    accountName: "",
    closed: true,
  });
});

test("a token read for privacy reporting is refused by trackerAccessToken and confined to JiraPrivacyAccess", async () => {
  const standIn = jiraStandIn();
  const token = await oauthToken(standIn);
  const access = await encryptToken(KEY, trackerTokenBinding("jira", "u1"), token.value);
  const asked: TokenUse[] = [];
  const steps: AccessSteps = {
    claim: async (_leaseId, use) => {
      asked.push(use);
      return { status: "ready", method: "oauth", access, site: token.site ?? null };
    },
    finish: async () => ({ status: "saved" }),
    sleep: async () => undefined,
    now: () => 1_000,
    leaseId: () => "lease",
  };
  const person = { userId: "u1", accountId: `${standIn.site.cloudId}/557058:dana` };
  // @ts-expect-error A token read for privacy reporting is never returned.
  await expect(trackerAccessToken(steps, deployment, { ...person, tracker: "jira", use: { by: "privacy" } })).rejects.toThrow("never returned");
  expect(asked).toEqual([]);

  const capability = await trackerPrivacyAccess(steps, deployment, person, standIn.fetchFn);
  expect(asked).toEqual([{ by: "privacy" }]);
  expect(Object.keys(capability).sort()).toEqual(["refreshProfile", "reportAccounts"]);
  expect(JSON.stringify(capability)).not.toContain(token.value);
  expect(Object.values(capability).some((value) => value === token || value === token.value)).toBe(false);
  expect(await capability.refreshProfile()).toEqual({ accountId: "557058:dana", accountName: "Dana Smith", closed: false });
});

test("reportJiraPersonalData tries fallbackReporters first, deduplicates shared IDs with oldest timestamp, and skips unknown without stamping privacyReportedAt", async () => {
  const standIn = jiraStandIn({
    users: [
      { accountId: "557058:dana", email: "dana@example.com", name: "Dana Renamed", apiToken: "t1" },
      { accountId: "557058:lee", email: "lee@example.com", name: "Lee Park", apiToken: "t2" },
    ],
  });
  standIn.privacy.updated.set("557058:dana", 20_000);
  const danaToken = await oauthToken(standIn, "557058:dana");
  const leeToken = await oauthToken(standIn, "557058:lee");
  const outcomes = new Map<string, JiraPrivacyOutcome>();
  const probedUsers: string[] = [];
  const now = 100_000;

  const result = await reportJiraPersonalData(
    {
      claim: async () => ({
        pendingRefreshes: [],
        items: [
          { recordId: "r-dana-old", userId: "u1", accountId: `${standIn.site.cloudId}/557058:dana`, connectedAt: 10_000, profileUpdatedAt: 10_000 },
          { recordId: "r-dana-new", userId: "u2", accountId: `other-cloud/557058:dana`, connectedAt: 15_000, profileUpdatedAt: 15_000 },
          { recordId: "r-unknown", userId: "u3", accountId: `${standIn.site.cloudId}/unknown`, connectedAt: 10_000, profileUpdatedAt: 10_000 },
        ],
        fallbackReporters: [{ userId: "u-lee", accountId: `${standIn.site.cloudId}/557058:lee` }],
        hasMore: false,
      }),
      privacy: async (person) => {
        probedUsers.push(person.userId);
        return jiraPrivacyCapability(deployment, person.userId === "u-lee" ? leeToken : danaToken, standIn.fetchFn);
      },
      finish: async (recordId, _leaseId, _connectedAt, outcome) => {
        outcomes.set(recordId, outcome);
        return true;
      },
      leaseId: () => "lease-1",
      now: () => now,
    },
    deployment,
  );

  expect(result).toEqual({ status: "ok", reported: 1, updated: 2, erased: 0, advanced: 3, hasMore: false });
  // Fallback healthy reporter (`u-lee`) was tried FIRST before batch items.
  expect(probedUsers[0]).toBe("u-lee");
  // Only one entry sent for 557058:dana, with the OLDEST timestamp (10_000), and `unknown` never sent.
  expect(standIn.privacy.reports).toEqual([[{ accountId: "557058:dana", updatedAt: new Date(10_000).toISOString() }]]);
  const expectedNext = now + 7 * 24 * 60 * 60_000;
  expect(outcomes.get("r-dana-old")).toEqual({ status: "updated", accountName: "Dana Renamed", nextReportAt: expectedNext });
  expect(outcomes.get("r-dana-new")).toEqual({ status: "updated", accountName: "Dana Renamed", nextReportAt: expectedNext });
  expect(outcomes.get("r-unknown")).toEqual({ status: "skip-unreportable", nextReportAt: expectedNext });
});

test("reportJiraPersonalData erases on explicit TrackerRefusal invalid_grant, never on decryption/misconfig errors", async () => {
  const outcomes = new Map<string, JiraPrivacyOutcome>();
  const now = 50_000;
  // Decryption / key mismatch throws plain CritiqsError("invalid"), NOT TrackerRefusal: must NOT erase!
  const misconfig = await reportJiraPersonalData(
    {
      claim: async () => ({
        pendingRefreshes: [],
        items: [{ recordId: "r-key", userId: "u1", accountId: "cloud-1/557058:dana", connectedAt: 10_000, profileUpdatedAt: 10_000 }],
        fallbackReporters: [],
        hasMore: false,
      }),
      privacy: async () => {
        throw new CritiqsError("invalid", "Critiqs can no longer read your Jira connection.");
      },
      finish: async (recordId, _leaseId, _connectedAt, outcome) => {
        outcomes.set(recordId, outcome);
        return true;
      },
      leaseId: () => "lease-key",
      now: () => now,
    },
    deployment,
  );
  expect(misconfig).toEqual({ status: "failed", reported: 0, updated: 0, erased: 0, advanced: 0, hasMore: false });
  expect(outcomes.get("r-key")).toEqual({ status: "retry", nextReportAt: now + JIRA_PRIVACY_RETRY_MS });

  // Explicit TrackerRefusal("invalid") (invalid_grant from Atlassian) DOES erase when no reporter succeeds.
  outcomes.clear();
  const revoked = await reportJiraPersonalData(
    {
      claim: async () => ({
        pendingRefreshes: [],
        items: [{ recordId: "r-revoked", userId: "u1", accountId: "cloud-1/557058:dana", connectedAt: 10_000, profileUpdatedAt: 10_000 }],
        fallbackReporters: [],
        hasMore: false,
      }),
      privacy: async () => {
        throw new TrackerRefusal("invalid", "Your Jira sign-in has ended.");
      },
      finish: async (recordId, _leaseId, _connectedAt, outcome) => {
        outcomes.set(recordId, outcome);
        return true;
      },
      leaseId: () => "lease-2",
      now: () => now,
    },
    deployment,
  );
  expect(revoked).toEqual({ status: "no-reporter", reported: 0, updated: 0, erased: 1, advanced: 1, hasMore: false });
  expect(outcomes.get("r-revoked")).toEqual({ status: "erase" });
});

test("reportJiraPersonalData backs off on 400 Bad Request so a poison pill rotates behind healthy batches", async () => {
  const standIn = jiraStandIn({
    users: [
      { accountId: "557058:dana", email: "dana@example.com", name: "Dana Smith", apiToken: "t1" },
      { accountId: "557058:lee", email: "lee@example.com", name: "Lee Park", apiToken: "t2" },
    ],
  });
  const danaToken = await oauthToken(standIn, "557058:dana");
  const leeToken = await oauthToken(standIn, "557058:lee");
  let reportCalls = 0;
  standIn.intercept = (method, path) => {
    if (method === "POST" && path === "/app/report-accounts/") {
      reportCalls++;
      return Response.json({ errorType: "BAD_REQUEST", errorMessage: "bad payload" }, { status: 400 });
    }
    return undefined;
  };
  const outcomes = new Map<string, JiraPrivacyOutcome>();
  const now = 50_000;
  const result = await reportJiraPersonalData(
    {
      claim: async () => ({
        pendingRefreshes: [],
        items: [{ recordId: "r1", userId: "u1", accountId: `${standIn.site.cloudId}/557058:dana`, connectedAt: 10_000, profileUpdatedAt: 10_000 }],
        fallbackReporters: [{ userId: "u2", accountId: `${standIn.site.cloudId}/557058:lee` }],
        hasMore: false,
      }),
      privacy: async (person) => jiraPrivacyCapability(deployment, person.userId === "u2" ? leeToken : danaToken, standIn.fetchFn),
      finish: async (recordId, _leaseId, _connectedAt, outcome) => {
        outcomes.set(recordId, outcome);
        return true;
      },
      leaseId: () => "lease-3",
      now: () => now,
    },
    deployment,
  );
  expect(reportCalls).toBe(1);
  expect(result).toEqual({ status: "failed", reported: 0, updated: 0, erased: 0, advanced: 0, hasMore: false });
  expect(outcomes.get("r1")).toEqual({ status: "retry", nextReportAt: now + JIRA_PRIVACY_RETRY_MS });
});

test("transient /me failure advances privacyNextReportAt (refresh-pending) and closed wins over duplicate updated", async () => {
  const standIn = jiraStandIn({
    users: [{ accountId: "557058:dana", email: "dana@example.com", name: "Dana Smith", apiToken: "t1" }],
  });
  const danaToken = await oauthToken(standIn, "557058:dana");
  standIn.intercept = (method, path) => {
    if (method === "POST" && path === "/app/report-accounts/") {
      return Response.json(
        {
          accounts: [
            { accountId: "557058:dana", status: "updated" },
            { accountId: "557058:closed-dup", status: "closed" },
            { accountId: "557058:closed-dup", status: "updated" },
          ],
        },
        { status: 200, headers: { "Cycle-Period": "7" } },
      );
    }
    if (method === "GET" && path === "/me") return new Response("upstream down", { status: 503 });
    return undefined;
  };
  const outcomes = new Map<string, JiraPrivacyOutcome>();
  const now = 100_000;
  const result = await reportJiraPersonalData(
    {
      claim: async () => ({
        pendingRefreshes: [],
        items: [
          { recordId: "r-dana", userId: "u1", accountId: `${standIn.site.cloudId}/557058:dana`, connectedAt: 10_000, profileUpdatedAt: 10_000 },
          { recordId: "r-closed", userId: "u2", accountId: `${standIn.site.cloudId}/557058:closed-dup`, connectedAt: 10_000, profileUpdatedAt: 10_000 },
        ],
        fallbackReporters: [],
        hasMore: false,
      }),
      privacy: async () => jiraPrivacyCapability(deployment, danaToken, standIn.fetchFn),
      finish: async (recordId, _leaseId, _connectedAt, outcome) => {
        outcomes.set(recordId, outcome);
        return true;
      },
      leaseId: () => "lease-4",
      now: () => now,
    },
    deployment,
  );
  const expectedNext = now + 7 * 24 * 60 * 60_000;
  expect(result).toEqual({ status: "ok", reported: 2, updated: 0, erased: 1, advanced: 2, hasMore: false });
  expect(outcomes.get("r-dana")).toEqual({ status: "refresh-pending", nextReportAt: expectedNext });
  expect(outcomes.get("r-closed")).toEqual({ status: "erase" });
});
