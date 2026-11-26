import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { AddressCheckDeps } from "../src/address-check.ts";
import { createCritiqsHandler, type CritiqsAiOptions, type CritiqsHandler, type HostUser } from "../src/http/index.ts";
import { ADDRESS_CHECKS_PER_HOUR, ADDRESS_CHECKS_PER_PERSON_PER_HOUR, claimAddressCheck } from "../src/onboarding.ts";
import { MailError, type Mailer, type MailMessage } from "../src/signin.ts";
import { bunDriver } from "../src/sqlite/index.ts";
import { anchor } from "./contract.ts";

const SITE = "http://localhost:3000";
const handlers: CritiqsHandler[] = [];
afterEach(() => {
  for (const handler of handlers.splice(0)) handler.close();
});

async function server(
  options: {
    identify?: (request: Request) => HostUser | null;
    mail?: MailMessage[];
    database?: Database;
    ai?: CritiqsAiOptions;
    aiFetch?: typeof fetch;
    addressCheck?: AddressCheckDeps | false;
    webUrl?: string;
    publicUrl?: string;
    mailer?: Mailer;
  } = {},
) {
  const sent = options.mail ?? [];
  const handler = await createCritiqsHandler({
    database: bunDriver(options.database ?? new Database(":memory:")),
    identify: options.identify,
    ai: options.ai,
    ...(options.aiFetch === undefined ? {} : { aiFetch: options.aiFetch }),
    ...(options.addressCheck === undefined ? {} : { addressCheck: options.addressCheck }),
    ...(options.webUrl === undefined ? {} : { webUrl: options.webUrl }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    mailer: options.mailer ?? { send: async (message) => void sent.push(message) },
  });
  handlers.push(handler);
  return { handler, sent };
}

/** A browser on the site: keeps cookies, and sends API calls as the component does. */
function browser(handler: CritiqsHandler) {
  const jar = new Map<string, string>();
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size > 0) headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await handler.fetch(new Request(`${SITE}${path}`, { ...init, headers }));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = pair!.split("=");
      if (value === "") jar.delete(name!);
      else jar.set(name!, value!);
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>) =>
    request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const api = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await request(`/critiqs/api/${name}`, {
      method: "POST",
      headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json", Origin: SITE },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: (await response.json()) as { value?: any; error?: { code: string; message: string } } };
  };
  return { request, form, api, jar };
}

async function signIn(handler: CritiqsHandler, sent: MailMessage[], email: string, name: string) {
  const b = browser(handler);
  const start = await b.request("/critiqs/auth/start?state=nonce-1");
  const key = /name="key" value="([^"]+)"/.exec(await start.text())![1]!;
  await b.form("/critiqs/auth/email", { key, email });
  const code = /(\d{6})/.exec(sent.at(-1)!.subject)![1]!;
  const checked = await b.form("/critiqs/auth/code", { key, code });
  const page = await checked.text();
  const done = page.includes('name="name"') ? await (await b.form("/critiqs/auth/name", { key, name })).text() : page;
  expect(done).toContain('"type":"critiqs:sign-in","state":"nonce-1"');
  return b;
}

test("reports itself as a server in the host app, current with the component", async () => {
  const { handler } = await server();
  const config = await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json();
  expect(config).toEqual({
    protocol: 5,
    transport: "http",
    signIn: "email",
    signInUrl: `${SITE}/critiqs`,
    ai: { managed: false, defaultProvider: null, keysStorable: false },
    personalAi: true,
    modelLists: true,
    organizations: true,
    organizationMembers: true,
    overageCap: true,
    addressCheck: true,
    onboardingAnswers: true,
    developerEmails: false,
  });
  expect((await handler.fetch(new Request(`${SITE}/elsewhere`))).status).toBe(404);
});

test("an admin invites someone by email, who joins when they sign in; members can't invite", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot", reviewUrl: "https://proto.example/app" })).body.value;
  const [organization] = (await dana.api("myOrganizations")).body.value;
  const invited = await dana.api("inviteMember", { organizationId: organization.id, email: " Riley@Example.com ", role: "member", projectId });
  expect(invited.body.value).toEqual({ status: "invited", email: "sent" });
  const email = sent.at(-1)!;
  expect(email).toMatchObject({ to: "riley@example.com", subject: "Dana invited you to Dana's organization on Critiqs" });
  expect(email.text).toContain("Sign in to Critiqs with this address (riley@example.com) and you'll join Dana's organization automatically.");
  expect(email.text).toContain("Open the prototype: https://proto.example/app");
  expect((await dana.api("inviteMember", { organizationId: organization.id, email: "riley@example.com", role: "admin" })).body.value).toEqual({ status: "pending" });

  const riley = await signIn(handler, sent, "riley@example.com", "Riley");
  await riley.api("sync");
  expect((await riley.api("myOrganizations")).body.value).toEqual([{ ...organization, role: "member", home: false }]);
  const refused = await riley.api("inviteMember", { organizationId: organization.id, email: "sam@example.com", role: "member" });
  expect(refused).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  expect((await dana.api("organization", { organizationId: organization.id })).body.value.members.map((member: { name: string; role: string }) => [member.name, member.role])).toEqual([
    ["Dana", "admin"],
    ["Riley", "member"],
  ]);
});

test("an invite says whether its email went out: not without a mail service, nor when the send fails", async () => {
  const call = async (handler: CritiqsHandler, name: string, body: unknown) =>
    (
      await (
        await handler.fetch(
          new Request(`${SITE}/critiqs/api/${name}`, { method: "POST", headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        )
      ).json()
    ).value;
  const pat = () => ({ id: "42", name: "Pat", email: "pat@acme.test" });
  for (const mailer of [undefined, { send: async () => Promise.reject(new Error("Resend is down")) }]) {
    const handler = await createCritiqsHandler({ database: bunDriver(new Database(":memory:")), identify: pat, ...(mailer === undefined ? {} : { mailer }) });
    handlers.push(handler);
    await call(handler, "createProject", { name: "Pilot" });
    const [organization] = await call(handler, "myOrganizations", {});
    expect(await call(handler, "inviteMember", { organizationId: organization.id, email: "riley@example.com", role: "member" })).toEqual({ status: "invited", email: "not-sent" });
  }
});

test("inviting and withdrawing an address uses up its invite emails, but another organization can still invite it", async () => {
  const { handler, sent } = await server();
  const mallory = await signIn(handler, sent, "mallory@example.com", "Mallory");
  await mallory.api("createProject", { name: "Theirs" });
  const [theirs] = (await mallory.api("myOrganizations")).body.value;
  const toRiley = () => sent.filter((message) => message.to === "riley@example.com").length;
  for (let round = 1; round <= 5; round++) {
    expect((await mallory.api("inviteMember", { organizationId: theirs.id, email: "riley@example.com", role: "member" })).body.value).toEqual({ status: "invited", email: "sent" });
    const [pending] = (await mallory.api("organization", { organizationId: theirs.id })).body.value.invites;
    expect((await mallory.api("revokeInvite", { inviteId: pending._id })).status).toBe(200);
    expect(toRiley()).toBe(round);
  }
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  await dana.api("createProject", { name: "Pilot" });
  const [organization] = (await dana.api("myOrganizations")).body.value;
  expect((await dana.api("inviteMember", { organizationId: organization.id, email: "Riley+work@example.com", role: "member" })).body.value).toEqual({ status: "invited", email: "not-sent" });
  expect(sent.filter((message) => message.to === "riley+work@example.com")).toEqual([]);
  expect((await dana.api("inviteMember", { organizationId: organization.id, email: "riley@example.com", role: "member" })).body.value).toEqual({ status: "invited", email: "not-sent" });
  expect(toRiley()).toBe(5);
  const riley = await signIn(handler, sent, "riley@example.com", "Riley");
  await riley.api("sync");
  expect((await riley.api("myOrganizations")).body.value.map((each: { name: string }) => each.name)).toEqual(["Dana's organization"]);
});

test("signs a reviewer in with an emailed code, keeps the session in a cookie, and signs out", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "Dana@Example.com", "Dana");
  expect(sent[0]!.to).toBe("dana@example.com");
  expect((await (await dana.request("/critiqs/me")).json()).reviewer).toMatchObject({ name: "Dana", email: "dana@example.com" });
  // Signing in again finds the same reviewer, without asking for a name.
  const again = await signIn(handler, sent, "dana@example.com", "Ignored");
  const first = (await (await dana.request("/critiqs/me")).json()).reviewer.id;
  expect((await (await again.request("/critiqs/me")).json()).reviewer.id).toBe(first);
  await dana.request("/critiqs/auth/sign-out", { method: "POST", headers: { "X-Critiqs-Request": "1", Origin: SITE } });
  expect((await (await dana.request("/critiqs/me")).json()).reviewer).toBeNull();
  expect(dana.jar.has("critiqs_session")).toBe(false);
});

test("refuses wrong codes, and codes from another browser's sign-in", async () => {
  const { handler, sent } = await server();
  const b = browser(handler);
  const key = /name="key" value="([^"]+)"/.exec(await (await b.request("/critiqs/auth/start?state=s")).text())![1]!;
  await b.form("/critiqs/auth/email", { key, email: "lee@example.com" });
  const code = /(\d{6})/.exec(sent[0]!.subject)![1]!;
  const wrong = code === "000000" ? "111111" : "000000";
  expect(await (await b.form("/critiqs/auth/code", { key, code: wrong })).text()).toContain("That code isn&#39;t right");
  // Another browser, without this sign-in's cookie, can't use the key.
  const other = browser(handler);
  expect(await (await other.form("/critiqs/auth/code", { key, code })).text()).toContain("This sign-in window has expired");
  for (let i = 0; i < 4; i++) await b.form("/critiqs/auth/code", { key, code: wrong });
  expect(await (await b.form("/critiqs/auth/code", { key, code })).text()).toContain("Too many wrong codes");
});

test("runs Critiqs's operations for signed-in reviewers, and only from this site", async () => {
  const { handler, sent } = await server();
  const anonymous = browser(handler);
  expect((await anonymous.api("createProject", { name: "Pilot" })).body.error?.code).toBe("unauthenticated");
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot", reviewUrl: null })).body.value;
  const before = (await (await dana.request("/critiqs/changes")).json()).version;
  const threadId = (
    await dana.api("createThread", { projectId, anchor, body: "Too small", tags: [], capture: { status: "failed", failureReason: "Blocked" }, mentions: [] })
  ).body.value;
  expect((await (await dana.request("/critiqs/changes")).json()).version).toBeGreaterThan(before);
  await dana.api("reply", { threadId, body: "Agreed", revision: null, mentions: [] });
  const thread = (await dana.api("thread", { threadId })).body.value;
  expect(thread.messages.map((message: { body: string }) => message.body)).toEqual(["Too small", "Agreed"]);
  expect((await dana.api("threads", { projectId })).body.value).toHaveLength(1);
  expect((await dana.api("myOrganizations", {})).body.value).toEqual([{ id: expect.any(String), name: "Dana's organization", role: "admin", plan: null, home: true }]);
  expect((await dana.api("project", { projectId })).body.value).toMatchObject({ isOwner: true, organization: { name: "Dana's organization", role: "admin" } });
  expect((await anonymous.api("myOrganizations", {})).status).toBe(401);
  const organizationId = (await dana.api("myOrganizations", {})).body.value[0].id;
  expect((await dana.api("setOverageCap", { organizationId, cap: 500 })).status).toBe(200);
  expect((await dana.api("setOverageCap", { organizationId, cap: null })).status).toBe(200);
  expect((await dana.api("setOverageCap", { organizationId, cap: "default" })).status).toBe(200);
  expect((await dana.api("setOverageCap", { organizationId, cap: "lots" })).body.error?.code).toBe("invalid");
  const lee = await signIn(handler, sent, "lee@example.com", "Lee");
  const outsider = await lee.api("setOverageCap", { organizationId, cap: 1 });
  expect([outsider.status, outsider.body.error]).toEqual([403, { code: "forbidden", message: "Only an organization's admins can change its name, members, or billing." }]);
  expect((await dana.api("dropTables", {})).status).toBe(404);
  // This server doesn't build mockups: it says so and offers none, rather than storing a thread the sidebar would show.
  const mockup = { mockupId: "m1", snapshotId: null, node: null };
  const refused = await dana.api("createThread", { projectId, anchor, body: "Mock", tags: [], capture: { status: "failed", failureReason: "x" }, mockup });
  expect(refused.body.error?.code).toBe("unavailable");
  expect((await dana.api("threads", { projectId })).body.value).toHaveLength(1);
  const config = await (await dana.request("/critiqs/critiqs/config")).json();
  expect(config).toMatchObject({ protocol: 5, transport: "http" });
  expect(config.mockups).toBeUndefined();

  // Another site's page can't call the API with the reviewer's cookie.
  const forged = await dana.request("/critiqs/api/remove", {
    method: "POST",
    headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ threadId }),
  });
  expect(forged.status).toBe(403);
  const plainForm = await dana.request("/critiqs/api/remove", { method: "POST", body: JSON.stringify({ threadId }) });
  expect(plainForm.status).toBe(403);
});

test("stores uploaded images and serves them after the same checks as the thread", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const uploaded = await dana.request(`/critiqs/upload?projectId=${projectId}`, {
    method: "POST",
    headers: { "X-Critiqs-Request": "1", "Content-Type": "image/png", Origin: SITE },
    body: png,
  });
  const { fileId } = await uploaded.json();
  const threadId = (await dana.api("createThread", { projectId, anchor, body: "Look", tags: [], capture: { status: "captured", fileId } })).body.value;
  const image = await dana.request(`/critiqs/capture?threadId=${threadId}`);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  expect((await browser(handler).request(`/critiqs/capture?threadId=${threadId}`)).status).toBe(401);
});

test("with the host app's sign-in, whoever the app signed in is the reviewer", async () => {
  const { handler } = await server({
    identify: (request) => (request.headers.get("Authorization") === "Bearer app-session" ? { id: "42", name: "Pat", email: "pat@acme.test" } : null),
  });
  const config = await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json();
  expect(config.signIn).toBe("host");
  const call = (auth: string | null) =>
    handler.fetch(
      new Request(`${SITE}/critiqs/api/createProject`, {
        method: "POST",
        headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ name: "Pilot" }),
      }),
    );
  expect((await call(null)).status).toBe(401);
  expect((await call("Bearer app-session")).status).toBe(200);
  const me = await (await handler.fetch(new Request(`${SITE}/critiqs/me`, { headers: { Authorization: "Bearer app-session" } }))).json();
  expect(me.reviewer).toMatchObject({ name: "Pat", email: "pat@acme.test" });
  expect((await (await handler.fetch(new Request(`${SITE}/critiqs/auth/start?state=s`))).text())).toContain("This app signs reviewers in");
});

test("emails people mentioned, with working mute links", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const lee = await signIn(handler, sent, "lee@example.com", "Lee");
  const projectId = (await dana.api("createProject", { name: "Pilot", reviewUrl: `${SITE}/app` })).body.value;
  const threadId = (await lee.api("createThread", { projectId, anchor, body: "Hi", tags: [], capture: { status: "failed", failureReason: "x" } })).body.value;
  const leeId = (await (await lee.request("/critiqs/me")).json()).reviewer.id;
  await dana.api("reply", { threadId, body: "@Lee look", revision: null, mentions: [{ userId: leeId, label: "Lee" }] });
  // Mentions gather for a minute before sending.
  await handler.store.transaction(async (store) => {
    for (const delivery of await store.deliveries.due(Date.now() + 120_000, 10)) await store.deliveries.patch(delivery._id, { dueAt: 0 });
  });
  const before = sent.length;
  await handler.deliverMentionEmails();
  const email = sent[before]!;
  expect(email.to).toBe("lee@example.com");
  const link = /http:\/\/localhost:3000\/critiqs\/notifications\/preferences\?token=[^\s"<]+/.exec(email.text)![0];
  const confirm = await handler.fetch(new Request(link.replace("&amp;", "&")));
  expect(await confirm.text()).toContain("Mute emails from this project?");
  const token = new URL(link).searchParams.get("token")!;
  await handler.fetch(new Request(`${SITE}/critiqs/notifications/preferences`, { method: "POST", body: new URLSearchParams({ token }) }));
  expect((await lee.api("notificationSettings", { projectId })).body.value).toEqual({ mentionEmails: true, replyEmails: true, projectMuted: true });
});

/** Dana's captured thread mentioning Lee, with a later reply that doesn't, ready to send. */
async function capturedMention(beforeSending: (database: Database) => void = () => {}) {
  const database = new Database(":memory:");
  const { handler, sent } = await server({ database });
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const lee = await signIn(handler, sent, "lee@example.com", "Lee");
  const projectId = (await dana.api("createProject", { name: "Pilot", reviewUrl: `${SITE}/app` })).body.value;
  await lee.api("createThread", { projectId, anchor, body: "Hi", tags: [], capture: { status: "failed", failureReason: "x" } });
  const leeId = (await (await lee.request("/critiqs/me")).json()).reviewer.id;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const uploaded = await dana.request(`/critiqs/upload?projectId=${projectId}`, {
    method: "POST",
    headers: { "X-Critiqs-Request": "1", "Content-Type": "image/png", Origin: SITE },
    body: png,
  });
  const { fileId } = await uploaded.json();
  const threadId = (
    await dana.api("createThread", {
      projectId,
      anchor,
      body: "@Lee the spacing here",
      tags: ["Bug"],
      capture: { status: "captured", fileId },
      mentions: [{ userId: leeId, label: "Lee" }],
    })
  ).body.value;
  await dana.api("reply", { threadId, body: "Also the header", revision: null, mentions: [] });
  await handler.store.transaction(async (store) => {
    for (const delivery of await store.deliveries.due(Date.now() + 120_000, 10)) await store.deliveries.patch(delivery._id, { dueAt: 0 });
  });
  beforeSending(database);
  const before = sent.length;
  await handler.deliverMentionEmails();
  return { handler, threadId, fileId, png, emails: sent.slice(before) };
}

test("a mention email embeds the thread's capture and shows its whole discussion, without linking the capture", async () => {
  const { handler, threadId, png, emails } = await capturedMention();
  expect(emails).toHaveLength(1);
  const [email] = emails;
  expect(email!.subject).toBe("Dana mentioned you: “@Lee the spacing here” · Pilot");
  expect(email!.attachments).toEqual([{ filename: "capture.png", contentType: "image/png", content: png, contentId: "critiqs-capture" }]);
  expect(email!.html).toContain(`<img src="cid:critiqs-capture"`);
  expect(email!.text).toContain("Also the header");
  expect(email!.text).toContain("Open · Bug · 2 comments");
  // The capture itself still needs a signed-in reviewer; the email carries no address for it.
  expect(email!.html).not.toContain("/critiqs/capture");
  expect((await browser(handler).request(`/critiqs/capture?threadId=${threadId}`)).status).toBe(401);
});

test("a mention email whose capture can't be read says so instead of showing a broken image", async () => {
  // The stored image is damaged after the comment was saved.
  const { emails } = await capturedMention((database) => database.run("UPDATE files SET data = x'00'"));
  const [email] = emails;
  expect(email!.attachments).toBeUndefined();
  expect(email!.html).not.toContain("cid:");
  expect(email!.html).toContain("The capture couldn't be included in this email. Open the comment to see it.");
  expect(email!.text).toContain("Also the header");
});

test("reports health for critiqs doctor, as Convex backends do", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  const health = await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/health?projectId=${projectId}`))).json();
  expect(health).toEqual({
    protocol: 5,
    signIn: "email",
    email: true,
    plans: false,
    ai: { managed: false, defaultProvider: null, keysStorable: false },
    mentionEmails: { overdue: false, waitingSince: null, last: null },
    project: "found",
    reviewAddress: false,
    reviewAddressLocal: false,
  });
  expect((await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/health?projectId=p_0`))).json()).project).toBe("missing");
  const tailnet = (await dana.api("createProject", { name: "Tailnet", reviewUrl: "https://devbox.tail1234.ts.net/app/" })).body.value;
  const read = await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/health?projectId=${tailnet}`))).text();
  expect(JSON.parse(read)).toMatchObject({ reviewAddress: true, reviewAddressLocal: true });
  expect(read).not.toContain("ts.net");
});

// Regressions from review

async function startedAttempt(handler: CritiqsHandler) {
  const b = browser(handler);
  const key = /name="key" value="([^"]+)"/.exec(await (await b.request("/critiqs/auth/start?state=s")).text())![1]!;
  return { b, key };
}

test("a verified address can't be swapped for another before choosing a name", async () => {
  const { handler, sent } = await server();
  await signIn(handler, sent, "victim@example.com", "Victim");
  const { b, key } = await startedAttempt(handler);
  await b.form("/critiqs/auth/email", { key, email: "attacker@example.com" });
  const code = /(\d{6})/.exec(sent.at(-1)!.subject)![1]!;
  expect(await (await b.form("/critiqs/auth/code", { key, code })).text()).toContain('name="name"');
  await b.form("/critiqs/auth/email", { key, email: "victim@example.com" });
  const named = await (await b.form("/critiqs/auth/name", { key, name: "Mallory" })).text();
  expect(named).toContain("This sign-in window has expired");
  expect(b.jar.has("critiqs_session")).toBe(false);
});

test("simultaneous wrong codes can't exceed the guess limit, and new codes don't reset it", async () => {
  const { handler, sent } = await server();
  const { b, key } = await startedAttempt(handler);
  await b.form("/critiqs/auth/email", { key, email: "lee@example.com" });
  const code = /(\d{6})/.exec(sent.at(-1)!.subject)![1]!;
  const wrong = code === "000000" ? "111111" : "000000";
  const pages = await Promise.all(Array.from({ length: 30 }, () => b.form("/critiqs/auth/code", { key, code: wrong }).then((r) => r.text())));
  expect(pages.filter((page) => page.includes("isn&#39;t right"))).toHaveLength(5);
  await b.form("/critiqs/auth/email", { key, email: "lee@example.com" });
  const fresh = /(\d{6})/.exec(sent.at(-1)!.subject)![1]!;
  expect(await (await b.form("/critiqs/auth/code", { key, code: fresh })).text()).toContain("Too many wrong codes");
});

test("refuses images that could run scripts, and serves captures sandboxed", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  const send = (type: string, body: BodyInit) =>
    dana.request(`/critiqs/upload?projectId=${projectId}`, { method: "POST", headers: { "X-Critiqs-Request": "1", "Content-Type": type, Origin: SITE }, body });
  const svg = await send("image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  expect(svg.status).toBe(400);
  const { fileId } = await (await send("image/png", new Uint8Array([137, 80, 78, 71]))).json();
  const threadId = (await dana.api("createThread", { projectId, anchor, body: "Look", tags: [], capture: { status: "captured", fileId } })).body.value;
  const image = await dana.request(`/critiqs/capture?threadId=${threadId}`);
  expect(image.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
});

test("checks every call's arguments before running it", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  const broken = await dana.api("createThread", {
    projectId,
    anchor: { ...anchor, viewState: null },
    body: "x",
    tags: [],
    capture: { status: "failed", failureReason: "x" },
  });
  expect(broken).toMatchObject({ status: 400, body: { error: { code: "invalid", message: "args.anchor.viewState must be an object." } } });
  const threadId = (await dana.api("createThread", { projectId, anchor, body: "x", tags: [], capture: { status: "failed", failureReason: "x" } })).body.value;
  expect((await dana.api("setStatus", { threadId, status: "deleted" })).status).toBe(400);
  expect((await dana.api("remove", { threadId, extra: 1 })).body.error?.message).toBe("args.extra is not expected.");
  expect((await dana.api("threads", { projectId })).body.value).toHaveLength(1);
});

test("tag lists and hashtags are checked at their limits through the API", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  const hashtags = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `#w${from + i}`).join(" ");
  const capture = { status: "failed", failureReason: "x" };
  const threadId = (await dana.api("createThread", { projectId, anchor, body: hashtags(30), tags: ["Bug"], capture })).body.value;
  await dana.api("reply", { threadId, body: hashtags(30, 30), revision: null });
  const thread = async () => (await dana.api("thread", { threadId })).body.value;
  // An older client sends back all 61 tags it was shown, plus the one it toggled on.
  const shown: string[] = (await thread()).tags;
  expect(shown).toHaveLength(61);
  expect(await dana.api("setTags", { threadId, tags: [...shown, "UX copy change"] })).toMatchObject({ status: 200 });
  expect((await thread()).tags.slice(0, 3)).toEqual(["Bug", "UX copy change", "w0"]);
  const huge = Array.from({ length: 251 }, (_, i) => `x${i}`);
  expect(await dana.api("setTags", { threadId, tags: huge })).toMatchObject({ status: 400, body: { error: { message: "args.tags must be a list of at most 250." } } });
  expect(await dana.api("createThread", { projectId, anchor, body: "x", tags: huge.slice(0, 51), capture })).toMatchObject({ status: 400 });
  // A reply writing 31 different hashtags is refused with the reason, and nothing is saved.
  const refused = await dana.api("reply", { threadId, body: hashtags(31, 100), revision: null });
  expect(refused).toMatchObject({ status: 400, body: { error: { code: "invalid", message: "A message can use up to 30 different hashtags; this one uses 31." } } });
  expect((await thread()).messages).toHaveLength(2);
});

test("refuses oversized bodies without reading them all", async () => {
  const { handler, sent } = await server();
  const dana = await signIn(handler, sent, "dana@example.com", "Dana");
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const response = await dana.request(`/critiqs/upload?projectId=${projectId}`, {
    method: "POST",
    headers: { "X-Critiqs-Request": "1", "Content-Type": "image/png", Origin: SITE },
    body: endless,
    duplex: "half",
  } as RequestInit);
  expect(response.status).toBe(400);
  expect(pulled).toBeLessThan(15);
  const big = await dana.request("/critiqs/api/createProject", {
    method: "POST",
    headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json", Origin: SITE },
    body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }),
  });
  expect(big.status).toBe(400);
});

test("development sign-in trusts the connection's address, not the Host header", async () => {
  const handler = await createCritiqsHandler({ database: bunDriver(new Database(":memory:")), developmentSignIn: true });
  handlers.push(handler);
  const config = async (remoteAddress?: string) =>
    (await (await handler.fetch(new Request("http://localhost/critiqs/critiqs/config"), { remoteAddress })).json()).signIn;
  expect(await config(undefined)).toBe("unavailable");
  expect(await config("203.0.113.9")).toBe("unavailable");
  expect(await config("127.0.0.1")).toBe("development");
  expect(await config("::ffff:127.0.0.1")).toBe("development");
});

test("the Node adapter answers malformed requests, streams bodies, and keeps serving", async () => {
  const { createServer } = await import("node:http");
  const { connect } = await import("node:net");
  const { toNodeListener } = await import("../src/http/node.ts");
  const { handler } = await server();
  const listener = createServer(toNodeListener(handler));
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  const raw = (text: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.end(text));
      let reply = "";
      socket.on("data", (chunk) => (reply += chunk));
      socket.on("close", () => resolve(reply));
    });
  expect(await raw("GET /critiqs/me HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n")).toContain("400");
  const config = await raw("GET /critiqs/critiqs/config HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  expect(config).toContain('"transport":"http"');
  // Development sign-in is off here, and the connection address comes from the socket.
  expect(config).toContain('"signIn":"email"');
  await new Promise((resolve) => listener.close(resolve));
});

test("a host-app reviewer has the same ID from the first answer on", async () => {
  const { handler } = await server({ identify: () => ({ id: "42", name: "Pat", email: "pat@acme.test" }) });
  const me = async () => (await (await handler.fetch(new Request(`${SITE}/critiqs/me`))).json()).reviewer.id;
  const first = await me();
  expect(first).toMatch(/^u_/);
  await handler.fetch(
    new Request(`${SITE}/critiqs/api/sync`, { method: "POST", headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json" }, body: "{}" }),
  );
  expect(await me()).toBe(first);
});

// AI, through the real AI SDK path to a local stand-in for an OpenAI-compatible endpoint.

function fakeEndpoint(answer: (system: string, prompt: string) => unknown) {
  const requests: { system: string; prompt: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
      requests.push({ system, prompt, authorization: request.headers.get("Authorization") });
      return Response.json({
        id: "chat",
        object: "chat.completion",
        created: 1,
        model: "local-model",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer(system, prompt)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return { requests, base: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

test("a server with AI searches with interpretation and cited insights, and groups new tags in the background", async () => {
  const endpoint = fakeEndpoint((system, prompt) => {
    if (system.includes("turn a question")) return { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" };
    if (system.includes("summarize")) return { findings: [{ title: "Labels are unclear", detail: "Reviewers ask for clearer labels.", threads: ["T1", "T8"] }] };
    if (system.includes("organize the tags")) {
      const tags = [...prompt.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      return { assignments: tags.map((tag) => ({ tag, groups: [], newGroups: tag === "layout" ? ["Visual design"] : [] })) };
    }
    return { status: "ok" };
  });
  try {
    const who = { current: { id: "1", name: "Dana", email: "dana@acme.test" } };
    const { handler } = await server({
      identify: () => who.current,
      ai: { provider: "compatible", model: "local-model", apiKey: "local-key", baseURL: endpoint.base, encryptionKey: "k".repeat(40), allowedEndpoints: ["https://llm.example.com/v1"] },
    });
    const config = await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json();
    expect(config.ai).toEqual({ managed: false, defaultProvider: "compatible", keysStorable: true });
    const dana = browser(handler);
    const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
    const threadId = (await dana.api("createThread", { projectId, anchor, body: "The department label is unclear #layout", tags: [], capture: { status: "failed", failureReason: "x" } })).body.value;

    const found = await dana.api("search", { projectId, question: "What do people say about labels?", scope: { status: "open", screen: null } });
    expect(found.status).toBe(200);
    expect(found.body.value).toMatchObject({ mode: "ai", notice: null, query: { terms: ["label"], status: "open" } });
    expect(found.body.value.results.map((result: { threadId: string }) => result.threadId)).toEqual([threadId]);
    expect(found.body.value.insights).toEqual([{ title: "Labels are unclear", detail: "Reviewers ask for clearer labels.", threadIds: [threadId] }]);
    // The operator's key went to the operator's endpoint, and nowhere into the answer.
    expect(endpoint.requests[0]!.authorization).toBe("Bearer local-key");
    expect(JSON.stringify(found.body)).not.toContain("local-key");

    await handler.groupTags();
    const { value: tags } = (await dana.api("tags", { projectId })).body;
    const visual = tags.groups.find((group: { name: string }) => group.name === "Visual design");
    expect(visual).toMatchObject({ origin: "ai" });
    expect(tags.tags.find((tag: { key: string }) => tag.key === "layout")).toMatchObject({ groupIds: [visual._id], grouping: "ai" });

    // Settings are the owner's: keys go in, only a hint comes out.
    const saved = await dana.api("saveAiSettings", { projectId, enabled: true, mode: "own", provider: "compatible", model: "m2", baseUrl: "https://llm.example.com/v1", apiKey: "owner-secret-9876" });
    expect(saved.body.value).toMatchObject({ provider: "compatible", keyHint: "9876", status: { ready: true } });
    expect(JSON.stringify(saved.body)).not.toContain("owner-secret");
    const evil = await dana.api("saveAiSettings", { projectId, enabled: true, mode: "own", provider: "compatible", model: "m2", baseUrl: "https://evil.example/v1", apiKey: "k" });
    expect(evil.status).toBe(400);
    who.current = { id: "2", name: "Lee", email: "lee@acme.test" };
    expect((await dana.api("aiSettings", { projectId })).status).toBe(403);
    expect((await dana.api("saveAiSettings", { projectId, enabled: false, mode: "own" })).status).toBe(403);
    expect((await dana.api("testAiConnection", { projectId })).status).toBe(403);
    // Anyone with access can still search; the project's own provider at llm.example.com is unreachable here, so search falls back.
    const basic = await dana.api("search", { projectId, question: "department", scope: { status: "all", screen: null } });
    expect(basic.body.value.mode).toBe("basic");
    expect(basic.body.value.notice).toStartWith("AI unavailable: basic search.");
    expect(basic.body.value.results).toHaveLength(1);
  } finally {
    endpoint.stop();
  }
});

test("without AI, search is basic and grouping leaves tags ungrouped; the operator's encryption key must be strong", async () => {
  const { handler } = await server({ identify: () => ({ id: "1", name: "Dana", email: "dana@acme.test" }) });
  const dana = browser(handler);
  const projectId = (await dana.api("createProject", { name: "Pilot" })).body.value;
  await dana.api("createThread", { projectId, anchor, body: "Spacing is off #spacing", tags: [], capture: { status: "failed", failureReason: "x" } });
  const found = (await dana.api("search", { projectId, question: "#spacing", scope: { status: "all", screen: null } })).body.value;
  expect(found).toMatchObject({ mode: "basic", query: { tags: ["spacing"] } });
  expect(found.results).toHaveLength(1);
  await handler.groupTags();
  const tags = (await dana.api("tags", { projectId })).body.value;
  expect(tags.tags.find((tag: { key: string }) => tag.key === "spacing").grouping).toBe("none");
  const keyless = await dana.api("saveAiSettings", { projectId, enabled: true, mode: "own", provider: "openai", model: "gpt", apiKey: "sk-1" });
  expect(keyless.body.error?.message).toContain("CRITIQS_AI_ENCRYPTION_KEY");
  await expect(server({ ai: { encryptionKey: "short" } })).rejects.toThrow("at least 32 characters");
});

test("a server lets each person save, test, and remove their own AI, which projects whose rule allows it use", async () => {
  const endpoint = fakeEndpoint((system) => {
    if (system.includes("turn a question")) return { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" };
    if (system.includes("summarize")) return { findings: [] };
    return { status: "ok" };
  });
  try {
    const who = { current: { id: "1", name: "Dana", email: "dana@acme.test" } as HostUser | null };
    const { handler } = await server({
      identify: () => who.current,
      ai: { encryptionKey: "k".repeat(40), allowedEndpoints: [endpoint.base], allowLocalEndpoints: true },
    });
    const config = await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json();
    expect(config.personalAi).toBe(true);
    const b = browser(handler);
    const projectId = (await b.api("createProject", { name: "Pilot" })).body.value;
    await b.api("createThread", { projectId, anchor, body: "The department label is unclear", tags: [], capture: { status: "failed", failureReason: "x" } });
    // Each person pays; the project has no connection of its own.
    expect((await b.api("saveAiSettings", { projectId, enabled: true, mode: "own", rule: "personal" })).body.value).toMatchObject({ rule: "personal" });

    expect((await b.api("personalAiSettings")).body.value).toMatchObject({ saved: false, keyHint: null });
    const mine = { enabled: true, mode: "own", provider: "compatible", model: "mine", baseUrl: endpoint.base, apiKey: "personal-secret-4321" };
    expect((await b.api("savePersonalAiSettings", { ...mine, rule: "project" })).status).toBe(400);
    const saved = await b.api("savePersonalAiSettings", mine);
    expect(saved.body.value).toMatchObject({ saved: true, provider: "compatible", model: "mine", keyHint: "4321", status: { ready: true } });
    expect(JSON.stringify(saved.body)).not.toContain("personal-secret");
    expect((await b.api("testPersonalAiConnection")).body.value).toMatchObject({ ok: true });
    expect((await b.api("personalAiSettings")).body.value.lastTest).toMatchObject({ ok: true });
    const danas = (await b.api("search", { projectId, question: "labels", scope: { status: "all", screen: null } })).body.value;
    expect(danas).toMatchObject({ mode: "ai", notice: null });
    expect(endpoint.requests.every((request) => request.authorization === "Bearer personal-secret-4321")).toBe(true);

    // Lee has no AI of his own and doesn't see Dana's.
    who.current = { id: "2", name: "Lee", email: "lee@acme.test" };
    expect((await b.api("personalAiSettings")).body.value).toMatchObject({ saved: false, keyHint: null });
    const lees = (await b.api("search", { projectId, question: "labels", scope: { status: "all", screen: null } })).body.value;
    expect(lees).toMatchObject({ mode: "basic", noticeCode: "setup-ai", notice: "AI unavailable: basic search. Set up your AI to use this." });

    who.current = { id: "1", name: "Dana", email: "dana@acme.test" };
    expect((await b.api("removePersonalAiSettings")).body.value).toMatchObject({ saved: false });
    expect((await b.api("search", { projectId, question: "labels", scope: { status: "all", screen: null } })).body.value).toMatchObject({ noticeCode: "setup-ai" });
    // A self-hosted server has no plans, so there is no Critiqs AI usage to show.
    expect((await b.api("personalAiUsage", { day: "2026-11-23" })).body).toEqual({ value: null });
    expect((await b.api("personalAiUsage", { day: 20261123 })).status).toBe(400);
    who.current = null;
    expect((await b.api("personalAiSettings")).status).toBe(401);
    expect((await b.api("personalAiUsage")).status).toBe(401);
  } finally {
    endpoint.stop();
  }
});

test("a server lists providers' models for a project's owner and for each person, and tells people which models they may choose", async () => {
  const requests: string[] = [];
  const aiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    return Response.json({ data: [{ id: "gpt-test" }, { id: "gpt-big" }] });
  }) as typeof fetch;
  const who = { current: { id: "1", name: "Dana", email: "dana@acme.test" } as HostUser | null };
  const { handler } = await server({ identify: () => who.current, ai: { encryptionKey: "k".repeat(40) }, aiFetch });
  const b = browser(handler);
  const projectId = (await b.api("createProject", { name: "Pilot" })).body.value;
  const saved = await b.api("saveAiSettings", { projectId, enabled: true, mode: "own", provider: "openai", model: "gpt-test", models: ["gpt-test", "gpt-big"], apiKey: "sk-project-1111" });
  expect(saved.body.value.deployment.providers).toContain("openrouter");

  expect((await b.api("listAiModels", { projectId })).body.value).toEqual({ ok: true, models: [{ id: "gpt-big", label: null }, { id: "gpt-test", label: null }], truncated: false });
  expect(requests).toEqual(["https://api.openai.com/v1/models Bearer sk-project-1111"]);
  expect((await b.api("listAiModels", { projectId, draft: { provider: "openrouter", apiKey: "sk-or-2222" } })).body.value).toMatchObject({ ok: true });
  expect(requests.at(-1)).toBe("https://openrouter.ai/api/v1/models Bearer sk-or-2222");
  expect((await b.api("listAiModels", { projectId, draft: { provider: "elsewhere" } })).status).toBe(400);
  expect((await b.api("listPersonalAiModels", { draft: { provider: "openai", apiKey: "sk-mine-3333" } })).body.value).toMatchObject({ ok: true });
  expect(requests.at(-1)).toBe("https://api.openai.com/v1/models Bearer sk-mine-3333");
  // Typed keys are used for their request only.
  expect(JSON.stringify((await b.api("personalAiSettings")).body)).not.toContain("sk-mine");
  expect(JSON.stringify((await b.api("aiSettings", { projectId })).body)).not.toContain("sk-or");

  // Lee may not list the project's models, but sees which of them he may choose, without its key.
  who.current = { id: "2", name: "Lee", email: "lee@acme.test" };
  expect((await b.api("listAiModels", { projectId })).status).toBe(403);
  const choice = (await b.api("aiChoice", { projectId })).body.value;
  expect(choice).toEqual({ source: "project", models: [{ id: "gpt-test", label: "gpt-test" }, { id: "gpt-big", label: "gpt-big" }], defaultModel: "gpt-test" });
  expect(JSON.stringify(choice)).not.toContain("sk-");
});

test("checks a prototype's address for signed-in people, never connecting to private addresses, within hourly limits", async () => {
  const connected: string[] = [];
  const addressCheck: AddressCheckDeps = {
    resolve: async (hostname) => [{ address: hostname === "inside.example.com" ? "10.0.0.8" : "93.184.215.14", family: 4 }],
    fetchPinned: async ({ url }) => {
      connected.push(url.href);
      const html = '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>';
      return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode(html); })() };
    },
  };
  const who = { current: null as HostUser | null };
  const { handler } = await server({ identify: () => who.current, addressCheck });
  const b = browser(handler);
  expect((await b.api("checkPrototypeAddress", { address: "https://proto.example.com" })).status).toBe(401);
  expect(connected).toEqual([]);

  who.current = { id: "1", name: "Dana", email: "dana@acme.test" };
  expect((await b.api("checkPrototypeAddress", { address: "https://proto.example.com" })).body.value).toEqual({ kind: "public", stack: "next" });
  expect((await b.api("checkPrototypeAddress", { address: "https://inside.example.com" })).body.value).toEqual({ kind: "unreachable" });
  expect((await b.api("checkPrototypeAddress", { address: "http://localhost:3000" })).body.value).toEqual({ kind: "local" });
  expect(connected).toEqual(["https://proto.example.com/"]);

  // Invalid input is an error to show, and isn't counted.
  expect((await b.api("checkPrototypeAddress", { address: "https://dana:pw@proto.example.com" })).body.error).toEqual({
    code: "invalid",
    message: "Leave the username and password out of the address.",
  });
  expect((await b.api("checkPrototypeAddress", { address: 5 })).status).toBe(400);
  expect((await b.api("checkPrototypeAddress", { address: "https://proto.example.com", extra: 1 })).status).toBe(400);

  for (let used = 3; used < ADDRESS_CHECKS_PER_PERSON_PER_HOUR; used++) {
    expect((await b.api("checkPrototypeAddress", { address: "http://localhost:3000" })).status).toBe(200);
  }
  const limited = await b.api("checkPrototypeAddress", { address: "https://proto.example.com" });
  expect(limited).toMatchObject({ status: 429, body: { error: { code: "limit", message: "You've checked 20 addresses this hour. Try again later, or skip this step." } } });
  expect(connected).toHaveLength(1);
  // Someone else still can.
  who.current = { id: "2", name: "Lee", email: "lee@acme.test" };
  expect((await b.api("checkPrototypeAddress", { address: "http://localhost:3000" })).body.value).toEqual({ kind: "local" });
});

test("address checks stop for everyone past the deployment's hourly limit, and start again the next hour", async () => {
  const { handler } = await server();
  const person = (n: number) => ({ tokenIdentifier: `host|${n}`, name: `P${n}`, email: `p${n}@acme.test`, emailVerified: true, pictureUrl: null, profileVersion: null });
  const hour = Date.UTC(2026, 10, 25, 9);
  const people = ADDRESS_CHECKS_PER_HOUR / ADDRESS_CHECKS_PER_PERSON_PER_HOUR;
  for (let n = 0; n < people; n++) {
    for (let i = 0; i < ADDRESS_CHECKS_PER_PERSON_PER_HOUR; i++) await handler.store.transaction((s) => claimAddressCheck(s, person(n), hour + n * 1000));
  }
  const refused = await handler.store.transaction((s) => claimAddressCheck(s, person(people), hour + 3_599_000)).catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "limit", message: "Critiqs is checking a lot of addresses right now. Try again in a few minutes, or skip this step." });
  // The next hour, a full hour's worth of checks again.
  for (let i = 0; i < ADDRESS_CHECKS_PER_PERSON_PER_HOUR; i++) await handler.store.transaction((s) => claimAddressCheck(s, person(people), hour + 3_600_000));
});

test("a server can turn the address check off, and says so in its configuration", async () => {
  const { handler } = await server({ identify: () => ({ id: "1", name: "Dana", email: "dana@acme.test" }), addressCheck: false });
  expect((await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json()).addressCheck).toBe(false);
  const b = browser(handler);
  for (const address of ["https://proto.example.com", "http://localhost:3000"]) {
    expect(await b.api("checkPrototypeAddress", { address })).toEqual({
      status: 410,
      body: { error: { code: "unavailable", message: "This Critiqs server doesn't check prototype addresses." } },
    });
  }
  // Nothing was counted: the hourly limit is untouched.
  const person = { tokenIdentifier: "host|1", name: "Dana", email: "dana@acme.test", emailVerified: true, pictureUrl: null, profileVersion: null };
  for (let i = 0; i < ADDRESS_CHECKS_PER_PERSON_PER_HOUR; i++) await handler.store.transaction((s) => claimAddressCheck(s, person, Date.now()));
});

test("onboarding saves the person's answers and creates a project with its answers, stack, and starting tags", async () => {
  const { handler } = await server({ identify: () => ({ id: "1", name: "Dana", email: "dana@acme.test" }) });
  const b = browser(handler);
  expect(await b.api("saveAboutYou", { role: "designer", teamSize: "bogus" })).toEqual({ status: 200, body: { value: null } });
  expect(await handler.store.transaction((s) => s.users.byToken("host|1"))).toMatchObject({ role: "designer" });
  const created = await b.api("createProject", {
    name: "acme-proto.vercel.app",
    onboarding: { codeAccess: "teammate", feedbackFrom: ["clients"], purpose: "design-review" },
    stack: "nuxt",
  });
  expect(created.status).toBe(200);
  expect((await b.api("project", { projectId: created.body.value })).body.value.tags).toEqual(["Design change request", "UX copy change", "Bug", "User feedback"]);
  expect((await handler.store.transaction((s) => s.projects.get(created.body.value)))!.onboarding).toEqual({
    codeAccess: "teammate",
    feedbackFrom: ["clients"],
    purpose: "design-review",
    stack: "nuxt",
  });
  // Shapes are checked before anything runs, as Convex's validators check them.
  for (const [name, args] of [
    ["saveAboutYou", { role: 1 }],
    ["saveAboutYou", { admin: true }],
    ["createProject", { name: "X", onboarding: { purpose: 2 } }],
    ["createProject", { name: "X", onboarding: { feedbackFrom: Array(11).fill("team") } }],
    ["createProject", { name: "X", stack: ["next"] }],
  ] as const) {
    expect((await b.api(name, args)).status).toBe(400);
  }
});

/** People the host app signs in, chosen per request by a test header. */
const people: Record<string, HostUser> = {
  dana: { id: "1", name: "Dana", email: "dana@acme.test" },
  sam: { id: "2", name: "Sam", email: "sam@acme.test" },
  lee: { id: "3", name: "Lee", email: "lee@acme.test" },
};
const asPerson = (request: Request) => people[request.headers.get("X-Test-Person") ?? ""] ?? null;

function personBrowser(handler: CritiqsHandler, who: string) {
  const api = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler.fetch(
      new Request(`${SITE}/critiqs/api/${name}`, {
        method: "POST",
        headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json", Origin: SITE, "X-Test-Person": who },
        body: JSON.stringify(args),
      }),
    );
    return { status: response.status, body: (await response.json()) as { value?: any; error?: { code: string; message: string } } };
  };
  return { api };
}

test("a project's owner emails its setup steps; the developer opens the setup link; a report stops further emails", async () => {
  const { handler, sent } = await server({ identify: asPerson, webUrl: "https://critiqs.example/", publicUrl: "https://app.example.com/" });
  // A request from inside the network first: report links still use the configured public address.
  await handler.fetch(new Request("http://backend.internal.test/critiqs/critiqs/health"));
  expect((await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json()).developerEmails).toBe(true);
  const dana = personBrowser(handler, "dana");
  const projectId = (await dana.api("createProject", { name: "Acme", reviewUrl: "https://acme.example", onboarding: { codeAccess: "nobody" }, stack: "react" })).body.value;
  const result = await dana.api("sendDeveloperSetup", { projectId, emails: ["Sam@acme.test", "nope"] });
  expect(result.body.value).toEqual([
    { email: "sam@acme.test", status: "sent", sendId: expect.stringMatching(/^e_/), invite: "created" },
    { email: "nope", status: "invalid", message: "Enter a valid email address." },
  ]);
  const sendId = result.body.value[0].sendId;
  // Only the setup email goes out: the organization invite sends none of its own.
  expect(sent.map((email) => [email.to, email.fromName, email.replyTo, email.idempotencyKey])).toEqual([
    ["sam@acme.test", "Dana via Critiqs", "dana@acme.test", `critiqs-developer:${sendId}:0`],
  ]);
  expect(sent[0]!.text).toContain(`Setup steps: https://critiqs.example/setup/${sendId}`);
  expect((await dana.api("developerSends", { projectId })).body.value).toEqual([
    { sendId, email: "sam@acme.test", status: "sent", lastSentAt: expect.any(Number) },
  ]);
  // The developer, signed in with that address, sees the steps; someone else sees nothing, as for a send that doesn't exist.
  const shown = await personBrowser(handler, "sam").api("developerSetup", { sendId });
  expect(shown.body.value).toMatchObject({ projectId, projectName: "Acme", stack: { id: "react" }, installCommands: ["npm install critiqs-react", `npx critiqs-react init ${projectId}`], inviterName: "Dana" });
  const lee = personBrowser(handler, "lee");
  expect((await lee.api("developerSetup", { sendId })).status).toBe(404);
  // A copied message links to the project instead: anyone signed in sees it, as with `project`, but only its managers see the saved stack.
  expect((await lee.api("projectSetup", { projectId })).body.value).toEqual({
    projectId,
    projectName: "Acme",
    address: "https://acme.example/",
    stack: null,
    installCommands: ["npm install critiqs-react", `npx critiqs-react init ${projectId}`],
  });
  expect((await dana.api("projectSetup", { projectId })).body.value).toMatchObject({ stack: { id: "react", label: "React (Vite)", installable: true } });
  expect((await personBrowser(handler, "nobody").api("projectSetup", { projectId })).body.error?.code).toBe("unauthenticated");
  expect((await lee.api("developerSetup", { sendId: "e_00000000000000000000000000000000" })).body).toEqual((await lee.api("developerSetup", { sendId })).body);
  expect((await lee.api("developerSends", { projectId })).status).toBe(403);
  expect((await lee.api("sendDeveloperSetup", { projectId, emails: ["x@acme.test"] })).status).toBe(403);
  // The report link asks first, since mail scanners open links; confirming stops emails to that inbox.
  const reportUrl = /Report it: (\S+)/.exec(sent[0]!.text)![1]!;
  expect(reportUrl.startsWith("https://app.example.com/critiqs/developer-emails/report?token=")).toBe(true);
  const ask = await handler.fetch(new Request(reportUrl));
  expect(await ask.text()).toContain("Stop emails from Critiqs to this address?");
  const token = new URL(reportUrl).searchParams.get("token")!;
  const post = (value: string) =>
    handler.fetch(new Request(`${SITE}/critiqs/developer-emails/report`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: value }).toString() }));
  expect(await (await post(`${token}x`)).text()).toContain("Link not recognized");
  const leesProject = (await lee.api("createProject", { name: "Lee's" })).body.value;
  expect((await lee.api("sendDeveloperSetup", { projectId: leesProject, emails: ["sam+x@acme.test"] })).body.value[0].status).toBe("sent");
  expect(await (await post(token)).text()).toContain("Critiqs won&#39;t email this address again.");
  const other = (await lee.api("createProject", { name: "Another" })).body.value;
  expect((await lee.api("sendDeveloperSetup", { projectId: other, emails: ["sam@acme.test"] })).body.value).toEqual([{ email: "sam@acme.test", status: "suppressed" }]);
});

test("a setup email the mail service refuses is recorded as failed, and can be sent again at once", async () => {
  let refuse = true;
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: async (message) => {
      if (refuse) throw new MailError("The email service refused the message (422).", { confirmed: true });
      sent.push(message);
    },
  };
  const { handler } = await server({ identify: asPerson, webUrl: "https://critiqs.example", publicUrl: "https://app.example.com", mailer });
  const dana = personBrowser(handler, "dana");
  const projectId = (await dana.api("createProject", { name: "Acme" })).body.value;
  expect((await dana.api("sendDeveloperSetup", { projectId, emails: ["sam@acme.test"] })).body.value[0].status).toBe("sent");
  expect((await dana.api("developerSends", { projectId })).body.value[0].status).toBe("failed");
  refuse = false;
  expect((await dana.api("sendDeveloperSetup", { projectId, emails: ["sam@acme.test"] })).body.value[0].status).toBe("sent");
  expect((await dana.api("developerSends", { projectId })).body.value[0].status).toBe("sent");
  expect(sent.map((email) => email.idempotencyKey.endsWith(":1"))).toEqual([true]);
});

test("without webUrl or publicUrl a server sends no setup emails and reserves nothing; an invalid one stops it from starting", async () => {
  for (const missing of [{ publicUrl: "https://app.example.com" }, { webUrl: "https://critiqs.example" }]) {
    const { handler, sent } = await server({ identify: asPerson, ...missing });
    expect((await (await handler.fetch(new Request(`${SITE}/critiqs/critiqs/config`))).json()).developerEmails).toBe(false);
    const dana = personBrowser(handler, "dana");
    const projectId = (await dana.api("createProject", { name: "Acme" })).body.value;
    expect(await dana.api("sendDeveloperSetup", { projectId, emails: ["sam@acme.test"] })).toEqual({
      status: 410,
      body: { error: { code: "unavailable", message: "This Critiqs server can't send setup emails. Copy the message instead." } },
    });
    expect((await dana.api("developerSends", { projectId })).body.value).toEqual([]);
    expect(sent).toEqual([]);
  }
  const { handler } = await server({ identify: asPerson });
  const dana = personBrowser(handler, "dana");
  const projectId = (await dana.api("createProject", { name: "Acme" })).body.value;
  await expect(server({ webUrl: "http://critiqs.example" })).rejects.toThrow("webUrl must be an https:// address");
  await expect(server({ publicUrl: "http://app.example.com" })).rejects.toThrow("publicUrl must be an https:// address");
  await expect(server({ publicUrl: "https://app.example.com/?x=1" })).rejects.toThrow("publicUrl must be an https:// address");
  expect((await dana.api("sendDeveloperSetup", { projectId, emails: Array(4).fill("a@acme.test") })).status).toBe(400);
});

test("the report page's form posts back to its own address, so a proxy prefix in publicUrl survives", async () => {
  const { handler, sent } = await server({ identify: asPerson, webUrl: "https://critiqs.example", publicUrl: "https://example.test/outside" });
  // A proxy serves the app under /outside and strips it before the request reaches Critiqs.
  const outside = (url: URL, init?: RequestInit) =>
    url.origin === "https://example.test" && url.pathname.startsWith("/outside/")
      ? handler.fetch(new Request(`${SITE}${url.pathname.slice("/outside".length)}${url.search}`, init))
      : Promise.resolve(new Response("Not found", { status: 404 }));
  const dana = personBrowser(handler, "dana");
  const projectId = (await dana.api("createProject", { name: "Acme" })).body.value;
  await dana.api("sendDeveloperSetup", { projectId, emails: ["sam@acme.test"] });
  const reportUrl = new URL(/Report it: (\S+)/.exec(sent[0]!.text)![1]!);
  expect(reportUrl.pathname).toBe("/outside/critiqs/developer-emails/report");
  const page = await outside(reportUrl);
  const form = /<form method="post"(?: action="([^"]*)")?>/.exec(await page.text())!;
  // The browser resolves the form's action against the page's own address.
  const action = new URL(form[1] ?? "", reportUrl);
  const posted = await outside(action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: reportUrl.searchParams.get("token")! }).toString() });
  expect([action.pathname, posted.status]).toEqual(["/outside/critiqs/developer-emails/report", 200]);
  expect(await posted.text()).toContain("Critiqs won&#39;t email this address again.");
});
