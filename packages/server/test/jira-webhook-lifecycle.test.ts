import { expect, test } from "bun:test";
import { trackerAdapter, ticketsDeploymentFromEnv } from "../src/tickets/accounts.ts";
import { exchangeJiraCode } from "../src/tickets/trackers/jira.ts";
import type { TrackerToken } from "../src/tickets/trackers/index.ts";
import { followTicketScope, renewTicketWebhook, webhookRemoval } from "../src/tickets/webhooks.ts";
import { JIRA_STANDIN_CLIENT_ID, JIRA_STANDIN_SECRET, jiraStandIn } from "./jira-standin.ts";

// The steps of a person's Jira status webhook (registering, renewing,
// removing), against the Jira stand-in, with each store step recorded: what
// runs before the person's token is read, and what happens at Jira when a
// step loses its lease or Jira turns a removal down.

const ORIGIN = "https://jira.test";
const deployment = ticketsDeploymentFromEnv({
  CRITIQS_AI_ENCRYPTION_KEY: "operator-encryption-key-".padEnd(48, "x"),
  CRITIQS_JIRA_CLIENT_ID: JIRA_STANDIN_CLIENT_ID,
  CRITIQS_JIRA_CLIENT_SECRET: JIRA_STANDIN_SECRET,
  CRITIQS_JIRA_API_URL: ORIGIN,
  CRITIQS_JIRA_AUTH_URL: ORIGIN,
  CRITIQS_JIRA_SITES_URL: ORIGIN,
});

async function signedIn() {
  const standIn = jiraStandIn();
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  const allow = await standIn.fetchFn(`${ORIGIN}/authorize/allow`, {
    method: "POST",
    body: new URLSearchParams({ redirect_uri: "https://critiqs.test/trackers/jira/callback", state: "s", account: "557058:dana" }),
  });
  const code = new URL(allow.headers.get("Location")!).searchParams.get("code")!;
  const tokens = await exchangeJiraCode({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, { clientId: JIRA_STANDIN_CLIENT_ID, clientSecret: JIRA_STANDIN_SECRET }, { code, redirectUri: "https://critiqs.test/trackers/jira/callback" }, 1_000);
  const token: TrackerToken = { method: "oauth", value: tokens.access, site };
  return { standIn, site, token };
}

/** Webhook steps whose store answers are given, recording each step and what the token was read for. */
function steps(token: TrackerToken, answers: { claim: Record<string, unknown>; save?: boolean }, fetchFn?: typeof fetch) {
  const calls: unknown[][] = [];
  return {
    calls,
    steps: {
      token: async (...args: unknown[]) => {
        calls.push(["token", ...args]);
        return token;
      },
      removal: async (...args: unknown[]) => {
        calls.push(["removal", ...args]);
        return webhookRemoval(trackerAdapter("jira", deployment, fetchFn).webhooks!, token);
      },
      claim: async (...args: unknown[]) => {
        calls.push(["claim"]);
        void args;
        return answers.claim as never;
      },
      save: async (_siteId: string, _leaseId: string, hook: unknown) => {
        calls.push(["save", hook]);
        return answers.save ?? true;
      },
      sleep: async () => undefined,
      leaseId: () => "lease",
      now: () => 1_000,
      url: "https://critiqs.test/trackers/jira/webhook",
    },
  };
}

test("a webhook that follows what it should already never has its person's token read, even to refresh it", async () => {
  const { standIn, token } = await signedIn();
  const { calls, steps: given } = steps(token, { claim: { status: "covered" } });
  expect(await followTicketScope(given as never, deployment, { tracker: "jira" }, standIn.fetchFn)).toBe("covered");
  expect(calls.map((call) => call[0])).toEqual(["claim"]);
});

test("registering reads the token for the projects the webhook follows, after they are worked out; a registration whose lease was lost is removed at Jira again", async () => {
  const { standIn, site, token } = await signedIn();
  const claim = { status: "claimed", scopes: ["10001"], previous: null, site, projects: ["project-1"] };
  const { calls, steps: given } = steps(token, { claim, save: false });
  const outcome = await followTicketScope(given as never, deployment, { tracker: "jira" }, standIn.fetchFn);
  expect(calls[0]).toEqual(["claim"]);
  expect(calls[1]).toEqual(["token", { by: "job", projects: ["project-1"] }]);
  // Another run holds the record now: the webhook just registered is nobody's, so it is removed, not left using a slot.
  expect(outcome).not.toBe("followed");
  expect(standIn.webhooks).toEqual([]);
  expect(standIn.requests.filter((request) => request.endsWith("/rest/api/3/webhook")).map((request) => request.split(" ")[0])).toEqual(["POST", "DELETE"]);
});

test("a webhook Jira refuses to remove is kept on record, so a later run removes it, and the run says it failed", async () => {
  const { standIn, site, token } = await signedIn();
  const registered = await (await import("../src/tickets/accounts.ts")).trackerAdapter("jira", deployment, standIn.fetchFn).webhooks!.register(token, { url: "https://critiqs.test/trackers/jira/webhook", scopes: ["10001"], now: 1_000 });
  standIn.intercept = (method, path) => (method === "DELETE" && path === "/rest/api/3/webhook" ? new Response("unavailable", { status: 503 }) : undefined);
  const { calls, steps: given } = steps(token, { claim: { status: "retire", previous: registered.id, site } }, standIn.fetchFn);
  expect(await followTicketScope(given as never, deployment, { tracker: "jira" }, standIn.fetchFn)).toBe("failed");
  // Only to remove what Critiqs registered: no project is read, and no token is handed out, only a removal.
  expect(calls.find((call) => call[0] === "token")).toBeUndefined();
  expect(calls.find((call) => call[0] === "removal")).toEqual(["removal"]);
  expect(calls.filter((call) => call[0] === "save")).toEqual([["save", null]]);
  expect(standIn.webhooks).toHaveLength(1);
});

test("a renewal that registers again but lost its lease removes the new webhook at Jira", async () => {
  const { standIn, site, token } = await signedIn();
  const calls: unknown[][] = [];
  const outcome = await renewTicketWebhook(
    {
      claim: async () => ({ status: "renew", person: { userId: "u", accountId: "a" }, tracker: "jira", site, hookId: "999", scopes: ["10001"], followed: ["10001"], projects: ["project-1"], expired: true }) as never,
      token: async (...args: unknown[]) => {
        calls.push(["token", ...args]);
        return token;
      },
      removal: async () => {
        throw new Error("Not read: the webhook still follows projects.");
      },
      finish: (async (_leaseId: string, result: unknown) => {
        calls.push(["finish", result]);
        return false;
      }) as never,
      leaseId: () => "lease",
      now: () => 1_000,
      url: "https://critiqs.test/trackers/jira/webhook",
    },
    deployment,
    standIn.fetchFn,
  );
  expect(calls[0]).toEqual(["token", { userId: "u", accountId: "a" }, "jira", { by: "job", projects: ["project-1"] }]);
  expect(outcome).not.toBe("renewed");
  expect(standIn.webhooks).toEqual([]);
});

test("a token read only to remove what Critiqs registered can do nothing else: its holder gets a removal that never shows the token", async () => {
  const { standIn, site, token } = await signedIn();
  const webhooks = trackerAdapter("jira", deployment, standIn.fetchFn).webhooks!;
  const registered = await webhooks.register(token, { url: "https://critiqs.test/trackers/jira/webhook", scopes: ["10001"], now: 1_000 });
  const removal = webhookRemoval(webhooks, token);
  // What the holder can see: the sign-in's kind and site, to check it is for the webhook's site, and remove.
  expect(Object.keys(removal).sort()).toEqual(["method", "remove", "site"]);
  expect(removal).toMatchObject({ method: "oauth", site });
  expect(JSON.stringify(removal)).not.toContain(token.value);
  expect(Object.values(removal).some((value) => value === token || value === token.value)).toBe(false);
  await removal.remove([registered.id]);
  expect(standIn.webhooks).toEqual([]);
});
