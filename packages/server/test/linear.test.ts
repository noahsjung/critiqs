import { afterAll, beforeAll, expect, test } from "bun:test";
import { CritiqsError } from "../src/errors.ts";
import { exchangeLinearCode, linearAdapter, linearAuthorizeUrl, refreshLinearToken } from "../src/tickets/trackers/linear.ts";

// Linear's adapter against a local stand-in for Linear's API: what it sends,
// how it reads Linear's answers, and the errors people see when Linear refuses.

type Reply = { status?: number; body: unknown } | "garbage";
const replies: Reply[] = [];
const requests: { path: string; authorization: string | null; contentType: string | null; body: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("Authorization"), contentType: request.headers.get("Content-Type"), body: await request.text() });
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
  expect(await linear.verify({ method: "token", value: "lin_api_123" })).toEqual({ accountId: "user-1", accountName: "Dana Smith", email: "dana@example.com", site: { id: "org-1", name: "Acme" } });
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
