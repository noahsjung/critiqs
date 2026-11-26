import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TicketMarkdown, webAddress } from "@critiqs/core";
import { CritiqsError } from "../src/errors.ts";
import { fetchUntil } from "../src/tickets/trackers/index.ts";
import { exchangeLinearCode, linearAdapter, linearAuthorizeUrl, linearStatusCategory, readLinearWebhook, refreshLinearToken } from "../src/tickets/trackers/linear.ts";
import { linearIssueWebhook, linearSignature } from "./linear-standin.ts";

/** Text as a test sends it straight to the adapter; Critiqs itself makes it only with `ticketBody` or `ticketLinkComment`. */
const md = (text: string) => text as TicketMarkdown;
const web = (url: string) => webAddress(url)!;

// Linear's adapter against a local stand-in for Linear's API: what it sends,
// how it reads Linear's answers, and the errors people see when Linear refuses.

type Reply = { status?: number; body: unknown } | "garbage";
const replies: Reply[] = [];
const requests: { method: string; path: string; authorization: string | null; contentType: string | null; headers: Record<string, string>; body: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("Authorization"),
        contentType: request.headers.get("Content-Type"),
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      const next = replies.shift() ?? { status: 500, body: {} };
      if (next === "garbage") return new Response("<html>oops</html>", { status: 200 });
      return Response.json(next.body, { status: next.status ?? 200 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));

const VIEWER = { data: { viewer: { id: "user-1", name: "Dana Smith", email: "dana@example.com" }, organization: { id: "org-1", name: "Acme" } } };

async function refusal(promise: Promise<unknown>): Promise<CritiqsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CritiqsError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

test("verify asks Linear whose token it is, sending an API key as it is and a sign-in token as a bearer token", async () => {
  requests.length = 0;
  replies.push({ body: VIEWER }, { body: VIEWER });
  const linear = linearAdapter({ baseUrl });
  expect(await linear.verify({ method: "token", value: "lin_api_123" })).toEqual({ accountId: "user-1", accountName: "Dana Smith", emails: ["dana@example.com"], site: { id: "org-1", name: "Acme" } });
  await linear.verify({ method: "oauth", value: "oauth-access" });
  expect(requests.map((request) => [request.path, request.authorization])).toEqual([
    ["/graphql", "lin_api_123"],
    ["/graphql", "Bearer oauth-access"],
  ]);
  expect(JSON.parse(requests[0]!.body).query).toContain("viewer { id name email }");
});

test("verify refuses a key Linear doesn't accept, in words that say what to do", async () => {
  // Linear reports a bad key as a GraphQL authentication error, sometimes with status 400.
  replies.push({ status: 400, body: { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR", type: "authentication error" } }] } });
  const pasted = await refusal(linearAdapter({ baseUrl }).verify({ method: "token", value: "lin_api_wrong" }));
  expect(pasted.code).toBe("invalid");
  expect(pasted.message).toBe("Linear didn't accept this API key. Check that you copied all of it, or create a new one.");
  replies.push({ status: 401, body: {} });
  const signedIn = await refusal(linearAdapter({ baseUrl }).verify({ method: "oauth", value: "revoked" }));
  expect(signedIn.message).toBe("Linear no longer accepts Critiqs's sign-in. Connect Linear again in Your trackers.");
});

test("verify reports answers it can't read, rate limits, and an unreachable Linear without echoing the token", async () => {
  replies.push("garbage");
  const garbled = await refusal(linearAdapter({ baseUrl }).verify({ method: "token", value: "lin_api_secret" }));
  expect(garbled.code).toBe("unavailable");
  expect(garbled.message).not.toContain("lin_api_secret");
  replies.push({ body: { data: { viewer: { id: "", name: "Dana" }, organization: null } } });
  expect((await refusal(linearAdapter({ baseUrl }).verify({ method: "token", value: "k" }))).message).toContain("wasn't what Critiqs expected");
  replies.push({ status: 429, body: { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] } });
  expect((await refusal(linearAdapter({ baseUrl }).verify({ method: "token", value: "k" }))).code).toBe("limit");
  const down = await refusal(linearAdapter({ baseUrl: "http://127.0.0.1:1" }).verify({ method: "token", value: "k" }));
  expect(down.message).toBe("Critiqs couldn't reach Linear. Try again in a moment.");
});

test("an account outside any workspace has no site", async () => {
  replies.push({ body: { data: { viewer: { id: "user-1", name: "Dana" }, organization: null } } });
  expect((await linearAdapter({ baseUrl }).verify({ method: "token", value: "k" })).site).toBeNull();
});

test("sign-in asks Linear for read and write access as the person, with PKCE", () => {
  const url = new URL(linearAuthorizeUrl("https://linear.app", { clientId: "client", redirectUri: "https://backend.example/trackers/linear/callback", state: "s1", challenge: "c1" }));
  expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "client",
    redirect_uri: "https://backend.example/trackers/linear/callback",
    response_type: "code",
    scope: "read,issues:create,comments:create",
    state: "s1",
    actor: "user",
    code_challenge: "c1",
    code_challenge_method: "S256",
  });
});

test("a sign-in's code becomes tokens, and a refresh token new ones", async () => {
  requests.length = 0;
  const app = { clientId: "client", clientSecret: "secret" };
  replies.push({ body: { access_token: "a1", token_type: "Bearer", expires_in: 86_399, refresh_token: "r1", scope: "read write" } });
  expect(await exchangeLinearCode({ baseUrl }, app, { code: "code-1", redirectUri: "https://b/cb", verifier: "v1" }, 1_000)).toEqual({ access: "a1", refresh: "r1", expiresAt: 1_000 + 86_399_000 });
  expect(requests[0]!.path).toBe("/oauth/token");
  expect(requests[0]!.contentType).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(new URLSearchParams(requests[0]!.body))).toEqual({
    grant_type: "authorization_code",
    code: "code-1",
    redirect_uri: "https://b/cb",
    code_verifier: "v1",
    client_id: "client",
    client_secret: "secret",
  });
  // A token with no expiry and no refresh token, as older Linear apps get.
  replies.push({ body: { access_token: "a2", token_type: "Bearer" } });
  expect(await refreshLinearToken({ baseUrl }, app, "r1", 5)).toEqual({ access: "a2", refresh: null, expiresAt: null });
  expect(Object.fromEntries(new URLSearchParams(requests[1]!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1" });
});

test("a used or expired code or refresh token is refused in words; an unknown app names the operator's settings", async () => {
  const app = { clientId: "client", clientSecret: "secret" };
  replies.push({ status: 400, body: { error: "invalid_grant" } });
  expect((await refusal(refreshLinearToken({ baseUrl }, app, "used", 0))).message).toBe("Your Linear sign-in has ended. Connect Linear again in Your trackers.");
  replies.push({ status: 400, body: { error: "invalid_grant" } });
  expect((await refusal(exchangeLinearCode({ baseUrl }, app, { code: "c", redirectUri: "r", verifier: "v" }, 0))).code).toBe("invalid");
  replies.push({ status: 401, body: { error: "invalid_client" } });
  expect((await refusal(exchangeLinearCode({ baseUrl }, app, { code: "c", redirectUri: "r", verifier: "v" }, 0))).message).toContain("CRITIQS_LINEAR_CLIENT_ID");
});

// ---------------------------------------------------------------------------
// Tickets: teams, search, issues, links back, comments, and the capture.

const key = { method: "token" as const, value: "lin_api_123" };
const issue = (id: string, identifier: string, state = { name: "In Progress", type: "started" }) => ({
  id,
  identifier,
  title: `Issue ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier.toLowerCase()}`,
  state,
  updatedAt: "2026-11-25T08:00:00.000Z",
  team: { organization: { id: "org-1" } },
});
const sentQuery = (index: number) => JSON.parse(requests[index]!.body) as { query: string; variables: Record<string, unknown> };

test("destinations are the person's teams by name, with their keys", async () => {
  requests.length = 0;
  replies.push({ body: { data: { teams: { nodes: [{ id: "t2", name: "Mobile", key: "MOB" }, { id: "t1", name: "Engineering", key: "ENG" }, { id: "", name: "Broken" }] } } } });
  expect(await linearAdapter({ baseUrl }).destinations(key)).toEqual([
    { id: "t1", name: "Engineering", key: "ENG" },
    { id: "t2", name: "Mobile", key: "MOB" },
  ]);
  expect(sentQuery(0).query).toContain("teams(first: 250)");
});

test("search finds an issue by its key first, then by words, reading each issue's status", async () => {
  requests.length = 0;
  const linear = linearAdapter({ baseUrl });
  replies.push({ body: { data: { issues: { nodes: [issue("i1", "ENG-123")] } } } });
  expect(await linear.search(key, " eng-123 ")).toEqual([
    { tracker: "linear", externalId: "i1", key: "ENG-123", url: "https://linear.app/acme/issue/eng-123", title: "Issue ENG-123", status: { label: "In Progress", category: "started" } },
  ]);
  expect(sentQuery(0).variables).toEqual({ team: "eng", number: 123 });
  expect(sentQuery(0).query).toContain("eqIgnoreCase: $team");
  // No issue with that key: the words are searched instead.
  replies.push({ body: { data: { issues: { nodes: [] } } } }, { body: { data: { searchIssues: { nodes: [issue("i9", "ENG-9", { name: "Todo", type: "unstarted" }), { id: "bad" }] } } } });
  expect((await linear.search(key, "ENG-404")).map((found) => [found.key, found.status.category])).toEqual([["ENG-9", "open"]]);
  expect(sentQuery(2).query).toContain("searchIssues(term: $term, teamId: $teamId, first: 10)");
  replies.push({ body: { data: { searchIssues: { nodes: [] } } } });
  await linear.search(key, "department label", "team-1");
  expect(sentQuery(3).variables).toEqual({ term: "department label", teamId: "team-1" });
});

test("Linear's state types become Critiqs's status categories", () => {
  expect(["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate", "paused"].map(linearStatusCategory)).toEqual([
    "open",
    "open",
    "open",
    "started",
    "done",
    "canceled",
    "canceled",
    "unknown",
  ]);
});

test("create sends the team, title, and Markdown text, using the creation's ID as the issue's, and reads the issue back", async () => {
  requests.length = 0;
  const creationId = "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b";
  replies.push({ body: { data: { issueCreate: { success: true, issue: issue(creationId, "ENG-7", { name: "Triage", type: "triage" }) } } } });
  const created = await linearAdapter({ baseUrl }).create(key, { destinationId: "t1", title: "Department is wrong", body: md("> Text\n"), labels: [], templateId: null, creationId });
  expect(created.status === "created" && created.ticket).toEqual({
    tracker: "linear",
    externalId: creationId,
    key: "ENG-7",
    url: "https://linear.app/acme/issue/eng-7",
    title: "Issue ENG-7",
    status: { label: "Triage", category: "open" },
    site: "org-1",
    // When the issue last changed, so a webhook sent before this read can't replace its status.
    asOf: Date.parse("2026-11-25T08:00:00.000Z"),
  });
  expect(sentQuery(0).variables).toEqual({ input: { id: creationId, teamId: "t1", title: "Department is wrong", description: "> Text\n" } });
  // An ID Linear wouldn't accept isn't sent; Linear picks one.
  replies.push({ body: { data: { issueCreate: { success: true, issue: issue("x", "ENG-8") } } } });
  await linearAdapter({ baseUrl }).create(key, { destinationId: "t1", title: "T", body: md(""), labels: [], templateId: null, creationId: "not-a-uuid" });
  expect(sentQuery(1).variables.input).not.toHaveProperty("id");
});

test("create says whether Linear refused, so nothing was made, or the outcome is unknown", async () => {
  const create = () => linearAdapter({ baseUrl }).create(key, { destinationId: "t1", title: "T", body: md(""), labels: [], templateId: null, creationId: "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b" });
  const outcome = async (reply: Reply) => {
    replies.push(reply);
    const result = await create();
    return result.status === "created" ? ["created"] : [result.status, result.error.code, result.error.message];
  };
  // Refused: Linear answered that it did nothing, with its reason.
  expect(await outcome({ status: 400, body: { errors: [{ message: "Entity not found: Team", extensions: { code: "INPUT_ERROR", type: "invalid input", userError: true, userPresentableMessage: "The team doesn't exist" } }] } })).toEqual([
    "refused",
    "invalid",
    "Linear turned this down: The team doesn't exist.",
  ]);
  expect(await outcome({ status: 200, body: { errors: [{ message: "You can't create issues in this team", extensions: { code: "FORBIDDEN" } }], data: null } })).toEqual([
    "refused",
    "forbidden",
    "Linear turned this down: You can't create issues in this team.",
  ]);
  expect((await outcome({ status: 429, body: { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] } }))[0]).toBe("refused");
  expect((await outcome({ status: 401, body: {} }))[0]).toBe("refused");
  expect((await outcome({ body: { data: { issueCreate: { success: false, issue: null } } } }))[0]).toBe("refused");
  // Unknown: Linear may have made it.
  expect((await outcome({ status: 500, body: { errors: [{ message: "Internal error" }] } }))[0]).toBe("unknown");
  expect((await outcome({ status: 504, body: {} }))[0]).toBe("unknown");
  expect((await outcome({ status: 200, body: { errors: [{ message: "Something broke", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } }))[0]).toBe("unknown");
  expect((await outcome("garbage"))[0]).toBe("unknown");
  expect((await outcome({ body: { data: { issueCreate: { success: true, issue: null } } } }))[0]).toBe("unknown");
  // Linear made the issue but reported an error reading part of it back: made, so never a refusal, and unknown until the next attempt finds it by its ID.
  const fieldError = { message: "Cannot return null for non-nullable field Issue.url", path: ["issueCreate", "issue", "url"], extensions: { code: "INPUT_ERROR", userError: true } };
  const made = issue("6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b", "ENG-7");
  expect((await outcome({ body: { data: { issueCreate: { success: true, issue: { ...made, url: null } } }, errors: [fieldError] } }))[0]).toBe("unknown");
  expect((await outcome({ body: { data: { issueCreate: { success: true, issue: made } }, errors: [fieldError] } }))[0]).toBe("unknown");
  expect((await outcome({ body: { data: { issueCreate: { success: null, issue: made } }, errors: [fieldError] } }))[0]).toBe("unknown");
  const unreachable = await linearAdapter({ baseUrl: "http://127.0.0.1:9" }).create(key, { destinationId: "t1", title: "T", body: md(""), labels: [], templateId: null, creationId: "x" });
  expect(unreachable.status).toBe("unknown");
});

test("an unknown creation's issue is found by the creation's ID, and get refuses an issue the person can't see", async () => {
  requests.length = 0;
  const creationId = "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b";
  const linear = linearAdapter({ baseUrl });
  replies.push({ body: { data: { issues: { nodes: [issue(creationId, "ENG-7")] } } } });
  expect((await linear.findCreated(key, { creationId, link: web("https://review.example/?critiqs=t1"), destinationId: "team-eng", since: 0 }))?.key).toBe("ENG-7");
  expect(sentQuery(0).variables).toEqual({ id: creationId });
  // Archived issues too, which Linear's lists leave out unless asked.
  expect(sentQuery(0).query).toContain("includeArchived: true");
  replies.push({ body: { data: { issues: { nodes: [] } } } });
  expect(await linear.findCreated(key, { creationId, link: web("https://review.example/?critiqs=t1"), destinationId: "team-eng", since: 0 })).toBeNull();
  replies.push({ body: { data: { issues: { nodes: [] } } } });
  const missing = await refusal(linear.get(key, "i404"));
  expect(missing.code).toBe("not-found");
  expect(missing.message).toBe("Linear can't find this issue, or you can't see it.");
  // Status reads the state and Linear's own time of the issue's last update, archived issues included.
  replies.push({ body: { data: { issues: { nodes: [{ id: "i1", state: { name: "Done", type: "completed" }, updatedAt: "2026-11-25T10:00:00.000Z" }] } } } });
  const ref = { tracker: "linear" as const, externalId: "i1", key: "ENG-1", url: "https://linear.app/acme/issue/eng-1", title: "t", site: "org-1" };
  expect(await linear.status(key, ref)).toEqual({ status: { label: "Done", category: "done" }, asOf: Date.parse("2026-11-25T10:00:00.000Z") });
  expect(sentQuery(requests.length - 1).query).toContain("includeArchived: true");
  replies.push({ body: { data: { issues: { nodes: [] } } } });
  expect((await refusal(linear.status(key, ref))).code).toBe("not-found");
});

test("the link back is a URL attachment on the issue, which Linear keeps one of per address, and a comment is Markdown on it", async () => {
  requests.length = 0;
  const linear = linearAdapter({ baseUrl });
  const ticket = { tracker: "linear" as const, externalId: "i1", key: "ENG-1", url: "https://linear.app/acme/issue/eng-1", title: "t", site: "org-1" };
  replies.push({ body: { data: { attachmentCreate: { success: true } } } }, { body: { data: { commentCreate: { success: true } } } });
  await linear.linkBack(key, ticket, { url: web("https://review.example/?critiqs=t1"), title: "Department is wrong" });
  await linear.comment(key, ticket, md("> Department is wrong\n"));
  expect(sentQuery(0).query).toContain("attachmentCreate(input: $input)");
  expect(sentQuery(0).variables).toEqual({ input: { issueId: "i1", url: "https://review.example/?critiqs=t1", title: "Department is wrong" } });
  expect(sentQuery(1).variables).toEqual({ input: { issueId: "i1", body: "> Department is wrong\n" } });
  // Linear answered that it made nothing: a refusal.
  replies.push({ body: { data: { attachmentCreate: { success: false } } } }, { body: { data: { commentCreate: { success: false } } } });
  expect((await refusal(linear.linkBack(key, ticket, { url: web("https://review.example/u"), title: "t" }))).code).toBe("invalid");
  expect((await refusal(linear.comment(key, ticket, md("Text")))).code).toBe("invalid");
  // Made, with an error elsewhere in the answer: done.
  const fieldError = { message: "Cannot read field", path: ["attachmentCreate", "attachment"], extensions: { code: "INPUT_ERROR", userError: true } };
  replies.push({ body: { data: { attachmentCreate: { success: true } }, errors: [fieldError] } }, { body: { data: { commentCreate: { success: true } }, errors: [fieldError] } });
  await linear.linkBack(key, ticket, { url: web("https://review.example/u"), title: "t" });
  await linear.comment(key, ticket, md("Text"));
  // No answer to read: Critiqs can't tell.
  replies.push({ status: 502, body: {} });
  expect((await refusal(linear.comment(key, ticket, md("Text")))).code).toBe("unavailable");
});

test("an image is uploaded to the address Linear signs, with the headers it names, and its asset address returned", async () => {
  requests.length = 0;
  const upload = `${baseUrl}upload/signed?sig=1`;
  replies.push(
    { body: { data: { fileUpload: { success: true, uploadFile: { uploadUrl: upload, assetUrl: "https://uploads.linear.app/asset-1", headers: [{ key: "x-goog-meta-id", value: "abc" }] } } } } },
    { body: {} },
  );
  const data = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  expect((await linearAdapter({ baseUrl }).uploadImage!(key, { data, contentType: "image/png", name: "critiqs-capture.png" })) as string).toBe("https://uploads.linear.app/asset-1");
  expect(sentQuery(0).variables).toEqual({ contentType: "image/png", filename: "critiqs-capture.png", size: 4 });
  expect(requests[1]).toMatchObject({ method: "PUT", path: "/upload/signed", contentType: "image/png" });
  expect(requests[1]!.headers["x-goog-meta-id"]).toBe("abc");
  expect(requests[1]!.authorization).toBeNull();
  replies.push(
    { body: { data: { fileUpload: { success: true, uploadFile: { uploadUrl: upload, assetUrl: "https://uploads.linear.app/asset-2", headers: [] } } } } },
    { status: 403, body: {} },
  );
  expect((await refusal(linearAdapter({ baseUrl }).uploadImage!(key, { data, contentType: "image/png", name: "c.png" }))).code).toBe("unavailable");
});

test("calls bounded by a deadline: none starts at or after it, and one still running then is aborted", async () => {
  let started = 0;
  const slow = (async (_input: string | URL | Request, init?: RequestInit) => {
    started++;
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({})), 1_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
  }) as typeof fetch;
  let now = 5_000;
  await expect(fetchUntil(slow, 5_000, () => now)("https://linear.test/graphql")).rejects.toThrow("ran out before this request");
  expect(started).toBe(0);
  now = Date.now();
  const began = Date.now();
  await expect(fetchUntil(slow, now + 50, () => Date.now())("https://linear.test/graphql")).rejects.toThrow("ran out");
  expect(started).toBe(1);
  expect(Date.now() - began).toBeLessThan(500);
  // Through the adapter, a request cut off by the deadline is an unknown outcome: Linear may have acted.
  const outcome = await linearAdapter({ baseUrl, fetch: fetchUntil(slow, Date.now() + 50, () => Date.now()) }).create(key, { destinationId: "t1", title: "T", body: md(""), labels: [], templateId: null, creationId: "x" });
  expect(outcome.status).toBe("unknown");
});

test("an answer about another issue than the one asked for, or whose address doesn't name its key on Linear, is refused", async () => {
  const linear = linearAdapter({ baseUrl });
  // Asked for i1, answered with i2: Critiqs would link, and later write to, an issue the person didn't choose.
  replies.push({ body: { data: { issues: { nodes: [issue("i2", "ENG-2")] } } } });
  expect((await refusal(linear.get(key, "i1"))).code).toBe("unavailable");
  // The address shown on the thread must be Linear's page for this issue's key.
  replies.push({ body: { data: { issues: { nodes: [{ ...issue("i1", "ENG-1"), url: "https://evil.example/acme/issue/eng-1" }] } } } });
  expect((await refusal(linear.get(key, "i1"))).code).toBe("unavailable");
  replies.push({ body: { data: { issues: { nodes: [{ ...issue("i1", "ENG-1"), url: "https://linear.app/acme/issue/ops-9" }] } } } });
  expect((await refusal(linear.get(key, "i1"))).code).toBe("unavailable");
  replies.push({ body: { data: { searchIssues: { nodes: [{ ...issue("i1", "ENG-1"), url: "https://evil.example/acme/issue/eng-1" }, issue("i3", "ENG-3")] } } } });
  expect((await linear.search(key, "department")).map((found) => found.key)).toEqual(["ENG-3"]);
  // Linear's real addresses carry a title after the key.
  replies.push({ body: { data: { issues: { nodes: [{ ...issue("i1", "ENG-1"), url: "https://linear.app/acme/issue/ENG-1/department-is-wrong" }] } } } });
  expect((await linear.get(key, "i1")).url).toBe("https://linear.app/acme/issue/ENG-1/department-is-wrong");
  // The status of another issue than the one asked for is never saved as this one's.
  replies.push({ body: { data: { issues: { nodes: [issue("i2", "ENG-2", { name: "Done", type: "completed" })] } } } });
  expect((await refusal(linear.status(key, { tracker: "linear", externalId: "i1", key: "ENG-1", url: "https://linear.app/acme/issue/eng-1", title: "t", site: "org-1" } as never))).code).not.toBe(undefined);
});

test("a ticket Critiqs holds whose address doesn't agree with its key is never written to", async () => {
  requests.length = 0;
  const linear = linearAdapter({ baseUrl });
  const held = { tracker: "linear" as const, externalId: "i1", key: "ENG-1", url: "https://evil.example/acme/issue/eng-1", title: "t", site: "org-1" };
  expect((await refusal(linear.linkBack(key, held as never, { url: web("https://review.example/?critiqs=t1"), title: "t" }))).code).toBe("invalid");
  expect((await refusal(linear.comment(key, held as never, md("Text")))).code).toBe("invalid");
  expect(requests).toHaveLength(0);
});

test("a creation is the issue whose ID Critiqs chose: Linear answering with another issue, now or when a lost answer is looked for, links nothing", async () => {
  const creationId = "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b";
  const linear = linearAdapter({ baseUrl });
  // Linear took the creation's ID as the new issue's; an answer about another issue is unknown, so the next attempt looks again.
  replies.push({ body: { data: { issueCreate: { success: true, issue: issue("0d9c8b7a-6f5e-4d3c-8b2a-190807060504", "ENG-9") } } } });
  const created = await linear.create(key, { destinationId: "t1", title: "T", body: md(""), labels: [], templateId: null, creationId });
  expect(created.status).toBe("unknown");
  // Linear answers IDs in lower case; the one Critiqs chose may be written either way.
  replies.push({ body: { data: { issueCreate: { success: true, issue: issue(creationId, "ENG-7") } } } });
  expect((await linear.create(key, { destinationId: "t1", title: "T", body: md(""), labels: [], templateId: null, creationId: creationId.toUpperCase() })).status).toBe("created");
  // Looking for a lost answer by the creation's ID: another issue is not it.
  replies.push({ body: { data: { issues: { nodes: [issue("0d9c8b7a-6f5e-4d3c-8b2a-190807060504", "ENG-9")] } } } });
  expect((await refusal(linear.findCreated(key, { creationId, link: null }))).code).toBe("unavailable");
  replies.push({ body: { data: { issues: { nodes: [issue(creationId, "ENG-7")] } } } });
  expect((await linear.findCreated(key, { creationId, link: null }))?.externalId).toBe(creationId);
});

test("create applies a template and adds labels only when given them", async () => {
  requests.length = 0;
  replies.push({ body: { data: { issueCreate: { success: true, issue: issue("x", "ENG-8") } } } });
  await linearAdapter({ baseUrl }).create(key, { destinationId: "t1", title: "T", body: md("B"), labels: ["label-bug"], templateId: "tpl-1", creationId: "not-a-uuid" });
  expect(sentQuery(0).variables.input).toEqual({ teamId: "t1", title: "T", description: "B", templateId: "tpl-1", labelIds: ["label-bug"] });
});

test("templates are each team's issue templates, by team name, skipping workspace templates and ones Critiqs can't read", async () => {
  requests.length = 0;
  const eng = { id: "team-eng", name: "Engineering", key: "ENG" };
  const des = { id: "team-des", name: "Design", key: null };
  replies.push({
    body: {
      data: {
        templateSearch: [
          { id: "tpl-bug", name: "Bug report", team: eng },
          { id: "tpl-ws", name: "Workspace template", team: null },
          { id: "tpl-feature", name: "Feature", team: eng },
          { id: "tpl-copy", name: "Copy change", team: des },
          { id: "", name: "Broken", team: eng },
          "garbage",
        ],
      },
    },
  });
  expect(await linearAdapter({ baseUrl }).templates!(key)).toEqual([
    { destination: { id: "team-des", name: "Design", key: null }, templates: [{ id: "tpl-copy", name: "Copy change" }] },
    {
      destination: { id: "team-eng", name: "Engineering", key: "ENG" },
      templates: [
        { id: "tpl-bug", name: "Bug report" },
        { id: "tpl-feature", name: "Feature" },
      ],
    },
  ]);
  expect(sentQuery(0).query).toContain('templateSearch(filter: { type: { eq: "issue" }, team: { null: false } }');
  // One team's: asked for by its ID.
  replies.push({ body: { data: { templateSearch: [{ id: "tpl-bug", name: "Bug report", team: eng }] } } });
  expect(await linearAdapter({ baseUrl }).templates!(key, "team-eng")).toEqual([{ destination: eng, templates: [{ id: "tpl-bug", name: "Bug report" }] }]);
  expect(sentQuery(1).variables).toEqual({ team: "team-eng" });
  // An answer without the list is Linear's problem, said in words.
  replies.push({ body: { data: { templateSearch: null } } });
  expect((await refusal(linearAdapter({ baseUrl }).templates!(key))).message).toContain("(no templates)");
});

test("a template is read with its Markdown text and team; one Linear no longer has is null", async () => {
  requests.length = 0;
  replies.push({ body: { data: { templateSearch: [{ id: "tpl-bug", name: "Bug report", team: { id: "team-eng", name: "Engineering", key: "ENG" }, content: "## Summary\n\n## Steps\n" }] } } });
  expect(await linearAdapter({ baseUrl }).template!(key, "tpl-bug")).toEqual({ id: "tpl-bug", name: "Bug report", destinationId: "team-eng", body: "## Summary\n\n## Steps\n" });
  expect(sentQuery(0).variables).toEqual({ id: "tpl-bug" });
  // No body in Linear: an empty one.
  replies.push({ body: { data: { templateSearch: [{ id: "tpl-empty", name: "Empty", team: { id: "team-eng", name: "Engineering" }, content: null }] } } });
  expect((await linearAdapter({ baseUrl }).template!(key, "tpl-empty"))?.body).toBe("");
  replies.push({ body: { data: { templateSearch: [] } } });
  expect(await linearAdapter({ baseUrl }).template!(key, "gone")).toBeNull();
});

test("labels are the team's and the workspace's, without label groups, as Linear names them, each with its single-select group", async () => {
  requests.length = 0;
  const nodes = [
    { id: "label-bug", name: "Bug", parent: null },
    { id: "label-x", name: "" },
    { id: "label-web", name: "Web", parent: { id: "group-platform", groupType: null } },
    { id: "label-ios", name: "iOS", parent: { id: "group-platform", groupType: "singleSelect" } },
    { id: "label-copy", name: "Copy", parent: { id: "group-areas", groupType: "multiSelect" } },
  ];
  replies.push({ body: { data: { issueLabels: { nodes } } } });
  expect(await linearAdapter({ baseUrl }).labels!(key, "team-eng")).toEqual([
    { id: "label-bug", name: "Bug", exclusiveGroup: null },
    // A group without a type is single-select, as Linear treats it.
    { id: "label-web", name: "Web", exclusiveGroup: "group-platform" },
    { id: "label-ios", name: "iOS", exclusiveGroup: "group-platform" },
    { id: "label-copy", name: "Copy", exclusiveGroup: null },
  ]);
  expect(sentQuery(0).query).toContain("isGroup: { eq: false }");
  expect(sentQuery(0).query).toContain("parent { id groupType }");
  expect(sentQuery(0).variables).toEqual({ team: "team-eng" });
});

describe("Linear webhooks", () => {
  const SECRET = "lin_wh_signing_secret";
  const NOW = Date.parse("2026-11-25T12:00:00.000Z");
  const bytes = (text: string) => new TextEncoder().encode(text);
  const read = async (delivery: { body: string; headers: Record<string, string> }, now = NOW) => await readLinearWebhook(SECRET, bytes(delivery.body), delivery.headers["Linear-Signature"] ?? null, now);
  const event = (overrides: Partial<Parameters<typeof linearIssueWebhook>[1]> = {}) =>
    linearIssueWebhook(SECRET, { action: "update", issueId: "issue-9", state: { name: "Done", type: "completed" }, updatedAt: NOW - 5_000, sentAt: NOW - 1_000, ...overrides });

  test("a signed issue update becomes the issue's status, mapped as the adapter maps it, as of the issue's own update time", async () => {
    expect(await read(await event())).toEqual({
      status: "update",
      update: { tracker: "linear", externalId: "issue-9", site: "org-1", status: { label: "Done", category: "done" }, asOf: NOW - 5_000, deleted: false },
    });
    const mapped = async (type: string) => {
      const result = await read(await event({ state: { name: type, type } }));
      return result.status === "update" ? result.update.status.category : result.status;
    };
    expect(await Promise.all(["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate", "something-new"].map(mapped))).toEqual([
      "open",
      "open",
      "open",
      "started",
      "done",
      "canceled",
      "canceled",
      "unknown",
    ]);
    // A new issue carries its state too.
    expect((await read(await event({ action: "create", state: { name: "Triage", type: "triage" } }))).status).toBe("update");
  });

  test("a deleted issue counts as canceled, labeled Deleted, as of when it was deleted", async () => {
    const result = await read(await event({ action: "remove", updatedAt: NOW - 5_000, happenedAt: NOW - 2_000 }));
    expect(result).toMatchObject({ status: "update", update: { status: { label: "Deleted", category: "canceled" }, asOf: NOW - 2_000, deleted: true } });
    // Never before the issue's own last update.
    expect(await read(await event({ action: "remove", updatedAt: NOW - 2_000, happenedAt: NOW - 5_000 }))).toMatchObject({ update: { asOf: NOW - 2_000 } });
    // Without the event's createdAt, when Linear sent it.
    const body = JSON.parse((await event({ action: "remove", updatedAt: NOW - 5_000 })).body) as Record<string, unknown>;
    delete body.createdAt;
    const text = JSON.stringify(body);
    expect(await readLinearWebhook(SECRET, bytes(text), await linearSignature(SECRET, text), NOW)).toMatchObject({ update: { asOf: NOW - 1_000 } });
  });

  test("a wrong, missing, or malformed signature, or a body changed after signing, is refused before the body is read", async () => {
    const delivery = await event();
    expect(await readLinearWebhook("another-secret", bytes(delivery.body), delivery.headers["Linear-Signature"]!, NOW)).toEqual({ status: "refused", reason: "wrong signature" });
    expect(await readLinearWebhook(SECRET, bytes(delivery.body.replace("Done", "Todo")), delivery.headers["Linear-Signature"]!, NOW)).toEqual({ status: "refused", reason: "wrong signature" });
    expect(await readLinearWebhook(SECRET, bytes(delivery.body), null, NOW)).toEqual({ status: "refused", reason: "missing or malformed signature" });
    expect(await readLinearWebhook(SECRET, bytes(delivery.body), "not hex!", NOW)).toEqual({ status: "refused", reason: "missing or malformed signature" });
    // Signed, but not JSON.
    expect(await readLinearWebhook(SECRET, bytes("{nope"), await linearSignature(SECRET, "{nope"), NOW)).toEqual({ status: "refused", reason: "unreadable body" });
  });

  test("the signature is checked over the body's exact bytes, and only valid UTF-8 is read after it", async () => {
    // A delivery whose title holds a byte that isn't UTF-8 (0xFF): read leniently as text, it would become U+FFFD.
    const raw = bytes((await event()).body.replace("Department", "Department\u0000"));
    raw[raw.indexOf(0)] = 0xff;
    const lossy = new TextDecoder().decode(raw);
    expect(lossy).toContain("Department\uFFFD");
    // Signed over what a lenient read makes of it: not the bytes that came, so refused.
    expect(await readLinearWebhook(SECRET, raw, await linearSignature(SECRET, lossy), NOW)).toEqual({ status: "refused", reason: "wrong signature" });
    // Signed over the very bytes: genuine, but not UTF-8, so nothing in it is read.
    expect(await readLinearWebhook(SECRET, raw, await linearSignature(SECRET, raw), NOW)).toEqual({ status: "refused", reason: "unreadable body" });
  });

  test("a delivery whose webhookTimestamp is more than a minute from now, such as a recorded one sent again, is refused", async () => {
    const stale = { status: "refused" as const, reason: "stale or missing webhookTimestamp" };
    expect(await read(await event({ sentAt: NOW - 61_000 }))).toEqual(stale);
    expect(await read(await event({ sentAt: NOW + 61_000 }))).toEqual(stale);
    expect((await read(await event({ sentAt: NOW - 59_000 }))).status).toBe("update");
    // The same delivery, read again two minutes later.
    const delivery = await event();
    expect((await read(delivery)).status).toBe("update");
    expect(await read(delivery, NOW + 120_000)).toEqual(stale);
  });

  test("other events, and issue events without a state, are ignored", async () => {
    expect(await read(await event({ type: "Comment" }))).toEqual({ status: "ignored" });
    expect(await read(await event({ state: null }))).toEqual({ status: "ignored" });
    const body = JSON.stringify({ action: "revoked", type: "OAuthApp", oauthClientId: "c", organizationId: "org-1", webhookTimestamp: NOW });
    expect(await readLinearWebhook(SECRET, bytes(body), await linearSignature(SECRET, body), NOW)).toEqual({ status: "ignored" });
  });
});
