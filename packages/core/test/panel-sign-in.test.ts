import { expect, test } from "bun:test";
import { panelSignIn, PanelSignInError } from "../src/panel-sign-in.ts";

const SERVICE = "https://auth.critiqs.example";

/** A fake sign-in service: records each request and answers with the next response. */
function service(...responses: (Response | Error)[]) {
  const requests: { url: string; init: RequestInit; body: unknown }[] = [];
  const client = panelSignIn(SERVICE, {
    fetch: async (input, init) => {
      requests.push({ url: input.toString(), init, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const next = responses.shift();
      if (next === undefined) throw new Error("No more responses");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, requests };
}

const signedIn = {
  status: "signed-in",
  accessToken: "a.b.c",
  refreshToken: "refresh-1",
  expiresAt: 1_000,
  sessionEndsAt: 2_000,
  reviewer: { id: "r1", name: "Dana", email: "dana@example.com" },
};

async function rejection(promise: Promise<unknown>): Promise<PanelSignInError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PanelSignInError);
    return error as PanelSignInError;
  }
  throw new Error("Expected a rejection");
}

test("sends a code as JSON, without cookies or redirects, and returns the attempt", async () => {
  const { client, requests } = service(Response.json({ attempt: "k1", email: "dana@example.com", developmentCode: "123456" }));
  expect(await client.sendCode("Dana@Example.com")).toEqual({ attempt: "k1", email: "dana@example.com", developmentCode: "123456" });
  const [request] = requests;
  expect(request!.url).toBe(`${SERVICE}/auth/panel/email`);
  expect(request!.body).toEqual({ email: "Dana@Example.com" });
  expect(request!.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
  expect(new Headers(request!.init.headers).get("Content-Type")).toBe("application/json");
});

test("a new code for the same sign-in names its attempt", async () => {
  const { client, requests } = service(Response.json({ attempt: "k1", email: "dana@example.com" }));
  expect(await client.sendCode("dana@example.com", "k1")).toEqual({ attempt: "k1", email: "dana@example.com" });
  expect(requests[0]!.body).toEqual({ email: "dana@example.com", attempt: "k1" });
});

test("a returning reviewer is signed in by the code; a new one chooses a name", async () => {
  const returning = service(Response.json(signedIn));
  expect(await returning.client.checkCode("k1", "123456")).toEqual(signedIn as never);
  expect(returning.requests[0]!.url).toBe(`${SERVICE}/auth/panel/code`);
  expect(returning.requests[0]!.body).toEqual({ attempt: "k1", code: "123456" });

  const newcomer = service(Response.json({ status: "needs-name" }), Response.json(signedIn));
  expect(await newcomer.client.checkCode("k1", "123456")).toEqual({ status: "needs-name" });
  const { status: _, ...session } = signedIn;
  expect(await newcomer.client.chooseName("k1", "Dana")).toEqual(session);
  expect(newcomer.requests[1]!.url).toBe(`${SERVICE}/auth/panel/name`);
  expect(newcomer.requests[1]!.body).toEqual({ attempt: "k1", name: "Dana" });
});

test("the service's errors arrive with their code, message, tries left, and wait", async () => {
  const wrong = await rejection(service(Response.json({ error: "wrong-code", message: "That code doesn't match. 3 tries left.", guessesLeft: 3 }, { status: 400 })).client.checkCode("k1", "000000"));
  expect(wrong).toMatchObject({ code: "wrong-code", message: "That code doesn't match. 3 tries left.", guessesLeft: 3 });

  const limited = await rejection(service(Response.json({ error: "rate-limited", message: "Wait." }, { status: 429, headers: { "Retry-After": "42" } })).client.sendCode("dana@example.com"));
  expect(limited).toMatchObject({ code: "rate-limited", retryAfter: 42 });

  for (const code of ["expired", "locked", "too-many-codes", "code-expired", "invalid-email", "invalid-name", "send-failed", "unavailable"]) {
    expect((await rejection(service(Response.json({ error: code, message: "m" }, { status: 400 })).client.checkCode("k1", "1"))).code).toBe(code as never);
  }
});

test("no answer, a hidden answer, or a malformed one is reported, never treated as success", async () => {
  // A browser hides the answer from a page the service doesn't allow; fetch rejects.
  expect((await rejection(service(new TypeError("Failed to fetch")).client.sendCode("dana@example.com"))).code).toBe("network");
  for (const response of [
    new Response("<html>", { status: 502 }),
    Response.json({ error: "something-new" }, { status: 400 }),
    Response.json({ attempt: 7, email: "dana@example.com" }),
    Response.json([]),
  ]) {
    expect((await rejection(service(response).client.sendCode("dana@example.com"))).code).toBe("unexpected");
  }
  for (const body of [{ ...signedIn, accessToken: 1 }, { ...signedIn, reviewer: null }, { ...signedIn, status: "other" }, { ...signedIn, expiresAt: "soon" }]) {
    expect((await rejection(service(Response.json(body)).client.checkCode("k1", "123456"))).code).toBe("unexpected");
  }
});

test("refresh returns new tokens, and reports a session that ended", async () => {
  const { client, requests } = service(Response.json({ accessToken: "x.y.z", refreshToken: "refresh-2", expiresAt: 5_000 }), new Response("Signed out", { status: 401 }));
  expect(await client.refresh("refresh-1")).toEqual({ accessToken: "x.y.z", refreshToken: "refresh-2", expiresAt: 5_000 });
  expect(requests[0]!.url).toBe(`${SERVICE}/auth/refresh`);
  expect(requests[0]!.body).toEqual({ refreshToken: "refresh-1" });
  expect((await rejection(client.refresh("refresh-2"))).code).toBe("signed-out");
});

test("renaming reports an invalid name and an ended session", async () => {
  const { client, requests } = service(
    new Response(null, { status: 204 }),
    Response.json({ error: "Use a name of 1 to 60 characters." }, { status: 400 }),
    new Response("Signed out", { status: 401 }),
  );
  await client.setDisplayName("refresh-1", "Dana Kim");
  expect(requests[0]!.url).toBe(`${SERVICE}/auth/profile`);
  expect(requests[0]!.body).toEqual({ refreshToken: "refresh-1", name: "Dana Kim" });
  expect(await rejection(client.setDisplayName("refresh-1", " "))).toMatchObject({ code: "invalid-name", message: "Use a name of 1 to 60 characters." });
  expect((await rejection(client.setDisplayName("refresh-1", "Dana"))).code).toBe("signed-out");
});

test("sign-out says whether the service found the session", async () => {
  const { client, requests } = service(
    new Response(null, { status: 204, headers: { "Critiqs-Session-Ended": "true" } }),
    new Response(null, { status: 204, headers: { "Critiqs-Session-Ended": "false" } }),
  );
  expect(await client.signOut("refresh-1")).toBe(true);
  expect(await client.signOut("refresh-1")).toBe(false);
  expect(requests[0]!.url).toBe(`${SERVICE}/auth/sign-out`);
});

test("panel sign-in is offered only where the sign-in service says this page can use it now", async () => {
  const { client, requests } = service(
    Response.json({ ready: true }),
    Response.json({ error: "unavailable", message: "m" }, { status: 503 }),
    Response.json({ error: "origin-not-allowed" }, { status: 403 }),
    new Response("Not found", { status: 404 }),
    new TypeError("Failed to fetch"),
  );
  expect(await client.available()).toBe(true);
  expect(requests[0]!.url).toBe(`${SERVICE}/auth/panel/status`);
  expect(requests[0]!.init).toMatchObject({ method: "POST", credentials: "omit" });
  expect(requests[0]!.body).toEqual({});
  // Codes can't be sent; this origin isn't listed; an older service; none reachable, or an answer the browser hid.
  for (let i = 0; i < 4; i++) expect(await client.available()).toBe(false);
});
