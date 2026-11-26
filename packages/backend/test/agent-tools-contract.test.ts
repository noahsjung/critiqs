import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../../critiqs/bin/mcp.mjs";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup } from "./harness";

// The MCP server's tools for reading feedback, against the real Convex
// functions and sign-in routes: the code approval, the session kept on this
// computer and its renewal, filters, and screenshots. Only the JWT signature
// check is left out: queries run as the reviewer the issued token names.

const BACKEND = "http://127.0.0.1:3210";
const SITE = "http://127.0.0.1:3211";
const folders: string[] = [];

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  process.env.CRITIQS_AUTH_PRIVATE_KEY = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
});

afterEach(() => {
  delete process.env.CRITIQS_DEV_SIGN_IN;
  delete process.env.CRITIQS_AUTH_ISSUER;
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

type Test = ReturnType<typeof setup>;

function claimsOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

/** Answers what the tools fetch: sign-in routes and captures over HTTP, queries through Convex's HTTP API. */
function bridge(t: Test) {
  const calls: string[] = [];
  const identityOf = (init?: RequestInit) => {
    const header = new Headers(init?.headers).get("Authorization");
    if (header === null) return null;
    const claims = claimsOf(header.replace(/^Bearer /, ""));
    return { subject: claims.sub, tokenIdentifier: `${claims.iss}|${claims.sub}`, name: claims.name, email: claims.email, email_verified: true };
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === SITE) {
      const identity = identityOf(init);
      const path = `${url.pathname}${url.search}`;
      calls.push(url.pathname);
      return identity === null ? await t.fetch(path, init) : await t.withIdentity(identity).fetch(path, init);
    }
    if (url.origin === BACKEND && (url.pathname === "/api/query" || url.pathname === "/api/mutation")) {
      const { path, args } = JSON.parse(String(init?.body));
      calls.push(path);
      const [module, name] = path.split(":");
      const identity = identityOf(init);
      const client = identity === null ? t : t.withIdentity(identity);
      const fn = (api as any)[module][name];
      try {
        const value = url.pathname === "/api/query" ? await client.query(fn, args) : await client.mutation(fn, args);
        return Response.json({ status: "success", value });
      } catch (error) {
        const data = (error as { data?: { message?: string } }).data;
        return Response.json({ status: "error", errorMessage: String(error), errorData: data });
      }
    }
    throw new Error(`Unexpected request to ${url}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function form(t: Test, path: string, fields: Record<string, string>, cookie = "") {
  return t.fetch(path, { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(fields).toString() });
}

/** The person: types the code in a browser, signs in as Dana, and approves. */
async function approve(t: Test, userCode: string) {
  const entered = await form(t, "/auth/device", { user_code: userCode });
  const cookie = (entered.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const attempt = /name="attempt" value="([^"]+)"/.exec(await entered.text())?.[1] ?? "";
  const sent = await (await form(t, "/auth/email", { attempt, email: "dana@example.com" }, cookie)).text();
  const code = /id="development-code">(\d{6})</.exec(sent)?.[1] ?? "";
  let page = await (await form(t, "/auth/code", { attempt, code }, cookie)).text();
  if (page.includes("Choose your display name")) page = await (await form(t, "/auth/name", { attempt, name: "Dana" }, cookie)).text();
  expect(page).toContain("Approve Critiqs access?");
  const consent = /name="consent" value="([^"]+)"/.exec(page)?.[1] ?? "";
  return await (await form(t, "/auth/device/decision", { attempt, consent, decision: "approve" }, cookie)).text();
}

const JAN = Date.parse("2026-01-05T10:00:00Z");
const MAR = Date.parse("2026-03-01T10:00:00Z");

/** A project with three threads, written by two reviewers both named Dana and one named Lee. */
async function feedback(t: Test) {
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const otherDana = t.withIdentity({ ...reviewer("Dana"), subject: "dana-two", tokenIdentifier: "https://auth.example|dana-two", email: "dana.two@example.com" });
  const projectId = await dana.mutation(api.projects.create, { name: "Adi Planner", reviewUrl: "https://planner.example/review" });
  const failed = { status: "failed" as const, failureReason: "Tainted canvas" };
  const department = await dana.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: ["Bug"], capture: failed });
  await lee.mutation(api.users.sync, {});
  const reply = await lee.mutation(api.threads.reply, { threadId: department, body: "Agreed, it should say Sales", revision: "def456" });
  const leeId = await t.run(async (ctx) => (await ctx.db.query("users").collect()).find((user) => user.name === "Lee")!._id);
  const mention = await dana.mutation(api.threads.reply, {
    threadId: department,
    body: "@Lee can you fix it?",
    revision: "def456",
    mentions: [{ userId: leeId, label: "Lee" }],
  });
  await lee.mutation(api.threads.toggleReaction, { messageId: mention, emoji: "👍" });

  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["png-bytes"], { type: "image/png" })));
  const spacing = await lee.mutation(api.threads.create, {
    projectId,
    anchor: { ...anchor, screen: "settings", target: { ...anchor.target, purposeId: "settings.save" } },
    body: "Spacing is too tight #layout",
    tags: [],
    capture: { status: "captured", storageId },
  });
  await dana.mutation(api.threads.setStatus, { threadId: spacing, status: "resolved" });
  const same = await otherDana.mutation(api.threads.create, { projectId, anchor, body: "Same name, different person", tags: [], capture: failed });

  // The department thread is from January; the spacing thread from March 1, and the last an hour later.
  const baseOf = (threadId: string) => (threadId === department ? JAN : threadId === spacing ? MAR : MAR + 3_600_000);
  await t.run(async (ctx) => {
    for (const message of await ctx.db.query("messages").collect()) {
      const thread = await ctx.db.get(message.threadId);
      const base = baseOf(message.threadId);
      await ctx.db.patch(message._id, { createdAt: base + (message.createdAt - thread!.createdAt) });
    }
    for (const thread of await ctx.db.query("threads").collect()) {
      const base = baseOf(thread._id);
      await ctx.db.patch(thread._id, { createdAt: base, lastMessageAt: base + (thread.lastMessageAt - thread.createdAt) });
    }
  });
  return { projectId, department, spacing, same, reply, mention };
}

function local() {
  process.env.CRITIQS_AUTH_ISSUER = SITE;
  process.env.CRITIQS_DEV_SIGN_IN = "enabled";
  const t = setup();
  const config = mkdtempSync(join(tmpdir(), "critiqs-agent-"));
  folders.push(config);
  const env = { CRITIQS_CONFIG_DIR: config };
  const { fetchFn, calls } = bridge(t);
  const tools = (now = Date.now) =>
    createTools({ cwd: config, env, fetchFn, now, open: () => {}, sleep: () => new Promise((done) => setTimeout(done, 5)) });
  return { t, config, env, fetchFn, calls, tools };
}

async function signIn(t: Test, tools: ReturnType<typeof createTools>) {
  const started = await tools.call("critiqs_sign_in", { signIn: "remote", backend: BACKEND });
  const code = /code ([A-Z]{4}-[A-Z]{4})/.exec(started.content[0]!.text!)?.[1] ?? "";
  expect(started.content[0]!.text).toContain(`${SITE}/auth/device`);
  expect(await approve(t, code)).toContain("Access approved");
  return await tools.call("critiqs_sign_in_finish", { waitSeconds: 20 });
}

const data = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent as any;

/** As if the saved 15-minute access token had run out. */
function expireToken(config: string) {
  const file = join(config, "sign-in.v2.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.services[SITE].accessExpiresAt = Date.now() - 1;
  writeFileSync(file, JSON.stringify(stored));
}

test("an agent signs this computer in once, then reads a project's feedback with its context", async () => {
  const { t, config, tools } = local();
  const ids = await feedback(t);
  const agent = tools();

  const before = await agent.call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND });
  expect(before.isError).toBe(true);
  expect(before.content[0]!.text).toContain("isn't signed in");
  expect(before.content[0]!.text).toContain("critiqs_sign_in");

  const finished = await signIn(t, agent);
  expect(finished.isError).toBeUndefined();
  expect(finished.content[0]!.text).toContain("as Dana (dana@example.com)");
  const file = join(config, "sign-in.v2.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).services)).toEqual([SITE]);
  // Signing in again is refused unless asked.
  expect((await agent.call("critiqs_sign_in", { backend: BACKEND })).content[0]!.text).toContain("already signed in to Critiqs as Dana");

  // A later session on this computer reads without signing in again.
  const result = await tools().call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]!.text).toBe('2 threads in "Adi Planner" match (open).');
  expect(JSON.parse(result.content[1]!.text!)).toEqual(data(result));
  const { project, threads, total, truncated } = data(result);
  expect(project).toEqual({ id: ids.projectId, name: "Adi Planner", reviewUrl: "https://planner.example/review" });
  expect({ total, truncated }).toEqual({ total: 2, truncated: false });
  // Newest activity first.
  expect(threads.map((thread: any) => thread.id)).toEqual([ids.same, ids.department]);
  const department = threads[1];
  expect(department).toMatchObject({
    status: "open",
    tags: ["Bug"],
    link: `https://planner.example/review?critiqs=${ids.department}`,
    startedBy: { name: "Dana" },
    createdAt: "2026-01-05T10:00:00.000Z",
    messageCount: 3,
    hasScreenshot: false,
    context: {
      screen: "user-details",
      viewState: { tab: "permissions" },
      scope: "record",
      target: { purposeId: "user.department", recordKey: "user:alex", label: "Sales", role: null, tagName: "span", path: "main:1/span:1" },
      page: {
        url: "https://proto.example/users/alex?tab=permissions",
        viewport: { width: 1440, height: 900 },
        persona: "Admin",
        revision: "abc123",
        browser: "Mozilla/5.0 (Macintosh) Chrome/140",
        marker: { x: 10, y: 20, width: 100, height: 24 },
      },
      movedTo: null,
    },
  });
  expect(department.messages.map((message: any) => [message.author, message.body, message.revision])).toEqual([
    ["Dana", "Department is wrong", "abc123"],
    ["Lee", "Agreed, it should say Sales", "def456"],
    ["Dana", "@Lee can you fix it?", "def456"],
  ]);
  expect(department.messages[1].link).toBe(`https://planner.example/review?critiqs=${ids.department}.${ids.reply}`);
  expect(department.messages.every((message: any) => typeof message.authorId === "string")).toBe(true);
  expect(department.messages[0].matches).toBeUndefined();
});

test("filters: status, author by name or ID, time, tag, screen, text, and limit", async () => {
  const { t, tools, calls } = local();
  const ids = await feedback(t);
  const agent = tools();
  await signIn(t, agent);
  const read = async (args: Record<string, unknown>) => {
    const result = await agent.call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND, ...args });
    if (result.isError) throw new Error(result.content[0]!.text);
    return data(result);
  };
  const threadIds = (result: any) => result.threads.map((thread: any) => thread.id);

  expect(threadIds(await read({ status: "resolved" }))).toEqual([ids.spacing]);
  expect(threadIds(await read({ status: "all" }))).toEqual([ids.same, ids.spacing, ids.department]);

  // Lee wrote the spacing thread and replied in the department thread; the matching message is marked.
  const byLee = await read({ status: "all", author: "lee" });
  expect(threadIds(byLee)).toEqual([ids.spacing, ids.department]);
  expect(byLee.threads[1].messages.map((message: any) => message.matches)).toEqual([false, true, false]);

  // Two people are named Dana: a name is refused with both IDs, and an ID picks one.
  const ambiguous = await agent.call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND, author: "Dana" });
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.content[0]!.text).toContain('2 people are named "Dana"');
  const all = await read({ status: "all" });
  const otherDanaId = all.threads[0].messages[0].authorId;
  expect(ambiguous.content[0]!.text).toContain(otherDanaId);
  expect(threadIds(await read({ author: otherDanaId }))).toEqual([ids.same]);

  // Messages written in a time range; a date alone as `until` includes that day.
  expect(threadIds(await read({ status: "all", since: "2026-02-01" }))).toEqual([ids.same, ids.spacing]);
  expect(threadIds(await read({ status: "all", until: "2026-01-05" }))).toEqual([ids.department]);
  expect(threadIds(await read({ status: "all", since: "2026-01-01", until: "2026-01-31T23:59:59Z" }))).toEqual([ids.department]);

  expect(threadIds(await read({ tag: "#bug" }))).toEqual([ids.department]);
  expect(threadIds(await read({ status: "all", tag: "Layout" }))).toEqual([ids.spacing]);
  expect(threadIds(await read({ status: "all", screen: "settings" }))).toEqual([ids.spacing]);
  expect(threadIds(await read({ status: "all", text: "SALES" }))).toEqual([ids.department]);

  // Without message filters, only the discussions returned are read.
  calls.length = 0;
  const limited = await read({ status: "all", limit: 1 });
  expect({ total: limited.total, returned: limited.returned, truncated: limited.truncated }).toEqual({ total: 3, returned: 1, truncated: true });
  expect(threadIds(limited)).toEqual([ids.same]);
  expect(calls.filter((call) => call === "threads:exportThreads")).toHaveLength(1);
  // With one, every candidate is read to decide.
  calls.length = 0;
  const lee = await read({ status: "all", author: "Lee", limit: 1 });
  expect({ total: lee.total, returned: lee.returned }).toEqual({ total: 2, returned: 1 });
  expect(calls.filter((call) => call === "threads:exportThreads")).toHaveLength(3);

  for (const [args, message] of [
    [{ status: "closed" }, 'status must be "open", "resolved", or "all"'],
    [{ since: "last tuesday" }, "since must be a date"],
    [{ since: "2026-03-01", until: "2026-01-01" }, "since must be before until"],
    [{ limit: 0 }, "limit must be a whole number"],
  ] as const) {
    const refused = await agent.call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND, ...args });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain(message);
  }
});

test("mockup threads aren't among the feedback agents read", async () => {
  const { t, tools } = local();
  const ids = await feedback(t);
  const dana = t.withIdentity(reviewer("Dana"));
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["<html><body></body></html>"], { type: "text/html" })));
  const source = { url: "https://planner.example/review", screen: "user-details", viewState: {}, revision: null, persona: null };
  const snapshot = { storageId, width: 1440, height: 900, scrollY: 0, viewportHeight: 900, capturedAt: 1 };
  const mockupId = await dana.action(api.mockups.create, { projectId: ids.projectId, title: "Department fix", source, snapshot });
  const failed = { status: "failed" as const, failureReason: "x" };
  const mockup = { mockupId, snapshotId: null, node: null };
  await dana.mutation(api.threads.create, { projectId: ids.projectId, anchor, body: "Department is wrong here too #Bug", tags: ["Bug"], capture: failed, mockup });
  const agent = tools();
  await signIn(t, agent);
  const result = data(await agent.call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND, status: "all", text: "Department" }));
  expect(result.threads.map((thread: any) => thread.id)).toEqual([ids.department]);
  expect(data(await agent.call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND, status: "all" })).total).toBe(3);
});

const COPY =
  '<!DOCTYPE html><html><head><style>button[data-critiqs-node="3"] { color: red }</style></head><body data-critiqs-node="1">' +
  '<!-- was: <p> > <b data-critiqs-node="5">Old</b> --><main data-critiqs-node="2" data-critiqs-id="settings.form">' +
  '<button data-critiqs-node="3" class="btn primary" type="submit">Save <span data-critiqs-node="4">changes</span></button>' +
  '<p data-critiqs-node="5">Last saved &amp; synced</p></main></body></html>';

/** A mockup of the project's settings page with three versions, a phone-width copy, a mockup thread, and a linked feedback thread. */
async function mockupOf(t: Test, ids: Awaited<ReturnType<typeof feedback>>) {
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const copy = async (width: number) => ({
    storageId: await t.run((ctx) => ctx.storage.store(new Blob([COPY], { type: "text/html" }))),
    width,
    height: 2000,
    scrollY: 0,
    viewportHeight: 900,
    capturedAt: Date.parse("2026-03-02T09:00:00Z"),
  });
  const source = { url: "https://proto.example/settings", screen: "settings", viewState: { tab: "profile" }, revision: "abc123", persona: "Admin" };
  const mockupId = await dana.action(api.mockups.create, { projectId: ids.projectId, title: "Clearer save button", source, snapshot: await copy(1440) });
  const desktop = (await dana.query(api.mockups.get, { mockupId })).snapshots[0]!._id as Id<"mockupSnapshots">;
  const phone = await dana.action(api.mockups.addSnapshot, { mockupId, snapshot: await copy(390) });
  await dana.mutation(api.mockups.link, { mockupId, threadId: ids.department });
  const failed = { status: "failed" as const, failureReason: "x" };
  const thread = await lee.mutation(api.threads.create, {
    projectId: ids.projectId,
    anchor,
    body: "Make Save stand out and add Cancel",
    tags: [],
    capture: failed,
    mockup: { mockupId, snapshotId: desktop, node: 3 },
  });
  // Two Critiqs AI turns that Lee asked for, then Dana restores the first.
  const turn = (head: number, summary: string, edits: unknown[]) =>
    lee.mutation(internal.mockups.finishAi, {
      threadId: thread,
      head,
      answer: { reply: `Done: ${summary}`, summary, edits: [{ snapshotId: desktop, edits: edits as any }], remaining: false },
    });
  await turn(0, "Bolder Save, Cancel beside it", [
    { kind: "css", css: "button { font-weight: 700 }" },
    { kind: "text", node: 5, text: "Saved" },
    { kind: "insert", node: 3, position: "after", html: '<a href="/cancel">Cancel</a>' },
  ]);
  await turn(1, "Cancel as a link", [{ kind: "attribute", node: 6, name: "class", value: "link" }]);
  await dana.mutation(api.mockups.restore, { mockupId, number: 1, expectedHead: 2 });
  // A second, older mockup on another screen.
  const other = await lee.action(api.mockups.create, { projectId: ids.projectId, title: "Department picker", source: { ...source, screen: "user-details" }, snapshot: await copy(1024) });
  await t.run(async (ctx) => ctx.db.patch(other, { updatedAt: 1 }));
  return { mockupId, other, desktop, phone, thread };
}

test("an agent lists a project's mockups, newest first, filtered by screen and title", async () => {
  const { t, tools } = local();
  const ids = await feedback(t);
  const made = await mockupOf(t, ids);
  const agent = tools();
  await signIn(t, agent);

  const all = await agent.call("critiqs_mockups", { projectId: ids.projectId, backend: BACKEND });
  expect(all.isError).toBeUndefined();
  expect(all.content[0]!.text).toBe('2 mockups in "Adi Planner".');
  expect(JSON.parse(all.content[1]!.text!)).toEqual(data(all));
  const result = data(all);
  expect(result).toMatchObject({ project: { id: ids.projectId, name: "Adi Planner" }, total: 2, returned: 2, truncated: false });
  expect(result.mockups.map((mockup: any) => mockup.id)).toEqual([made.mockupId, made.other]);
  expect(result.mockups[0]).toEqual({
    id: made.mockupId,
    title: "Clearer save button",
    source: { url: "https://proto.example/settings", screen: "settings", viewState: { tab: "profile" }, revision: "abc123", persona: "Admin" },
    createdBy: "Dana",
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    versionCount: 3,
    threadCount: 1,
    copies: [
      { id: made.desktop, width: 1440 },
      { id: made.phone, width: 390 },
    ],

    threads: [{ id: made.thread, status: "open", firstMessage: "Make Save stand out and add Cancel", author: "Lee", lastMessageAt: expect.any(String) }],
  });

  const ids_ = async (args: Record<string, unknown>) =>
    data(await agent.call("critiqs_mockups", { projectId: ids.projectId, backend: BACKEND, ...args })).mockups.map((mockup: any) => mockup.id);
  expect(await ids_({ screen: "user-details" })).toEqual([made.other]);
  expect(await ids_({ text: "SAVE" })).toEqual([made.mockupId]);
  expect(await ids_({ screen: "settings", text: "picker" })).toEqual([]);
  const limited = data(await agent.call("critiqs_mockups", { projectId: ids.projectId, backend: BACKEND, limit: 1 }));
  expect({ total: limited.total, returned: limited.returned, truncated: limited.truncated }).toEqual({ total: 2, returned: 1, truncated: true });
  expect((await agent.call("critiqs_mockups", { projectId: ids.projectId, backend: BACKEND, limit: 101 })).content[0]!.text).toContain("limit must be a whole number from 1 to 100");
  expect((await agent.call("critiqs_mockups", { backend: BACKEND })).content[0]!.text).toContain("Give the project's ID");
});

test("an agent reads a mockup to build it: each change with the element it changes, the history, its threads, and the feedback it answers", async () => {
  const { t, config, tools } = local();
  const ids = await feedback(t);
  const made = await mockupOf(t, ids);
  const agent = tools();
  await signIn(t, agent);

  const latest = await agent.call("critiqs_mockup", { mockup: made.mockupId, backend: BACKEND });
  expect(latest.isError).toBeUndefined();
  expect(latest.content[0]!.text).toBe(
    'Mockup "Clearer save button" in "Adi Planner", version 3 (latest) by Dana: 3 changes across 2 page copies; 1 mockup thread, 1 linked thread.',
  );
  const result = data(latest);
  expect(result.mockup).toMatchObject({ id: made.mockupId, title: "Clearer save button", createdBy: "Dana", versionCount: 3, source: { screen: "settings", revision: "abc123" } });
  // The restore is the latest version, by a person, and holds version 1's changes.
  expect(result.version).toMatchObject({ number: 3, latest: true, summary: "Restored version 1", author: "Dana", byAi: false, restoredFrom: 1 });
  const [desktop, phone] = result.copies;
  expect(phone).toEqual({ id: made.phone, width: 390, height: 2000, capturedAt: "2026-03-02T09:00:00.000Z", edits: [] });
  expect(desktop.edits).toEqual([
    { kind: "css", css: "button { font-weight: 700 }" },
    // The original markup, without Critiqs's number; the commented-out element numbered 5 doesn't count.
    { kind: "text", node: 5, text: "Saved", original: { tag: "p", markup: "<p>", text: "Last saved & synced", purposeId: "settings.form" } },
    {
      kind: "insert",
      node: 3,
      position: "after",
      html: '<a href="/cancel">Cancel</a>',
      original: { tag: "button", markup: '<button class="btn primary" type="submit">', text: "Save changes", purposeId: "settings.form" },
    },
  ]);
  expect(result.versions).toEqual([
    { number: 1, summary: "Bolder Save, Cancel beside it", author: "Critiqs AI", byAi: true, askedBy: "Lee", createdAt: expect.any(String), restoredFrom: null },
    { number: 2, summary: "Cancel as a link", author: "Critiqs AI", byAi: true, askedBy: "Lee", createdAt: expect.any(String), restoredFrom: null },
    { number: 3, summary: "Restored version 1", author: "Dana", byAi: false, createdAt: expect.any(String), restoredFrom: 1 },
  ]);
  // The mockup thread's whole discussion, Critiqs AI's replies marked with the version each made.
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]).toMatchObject({
    id: made.thread,
    status: "open",
    messageCount: 3,
    pin: { copyId: made.desktop, node: 3, original: { tag: "button", text: "Save changes" } },
  });
  expect(result.threads[0].messages.map((message: any) => [message.author, message.body, message.via ?? null, message.askedBy ?? null, message.mockupVersion ?? null])).toEqual([
    ["Lee", "Make Save stand out and add Cancel", null, null, null],
    ["Critiqs AI", "Done: Bolder Save, Cancel beside it", "ai", "Lee", 1],
    ["Critiqs AI", "Done: Cancel as a link", "ai", "Lee", 2],
  ]);
  expect(result.linkedThreads).toEqual([
    {
      id: ids.department,
      link: `https://planner.example/review?critiqs=${ids.department}`,
      status: "open",
      screen: "user-details",
      messageCount: 3,
      firstMessage: { author: "Dana", body: "Department is wrong", createdAt: "2026-01-05T10:00:00.000Z" },
    },
  ]);
  expect(result.saved).toBeNull();
  expect(existsSync(join(config, "mockups"))).toBe(false);

  // An earlier version; its changes name an element an earlier change added.
  const second = data(await agent.call("critiqs_mockup", { mockup: made.mockupId, version: 2, backend: BACKEND }));
  expect(second.version).toMatchObject({ number: 2, latest: false, author: "Critiqs AI", askedBy: "Lee", threadId: made.thread });
  expect(second.copies[0].edits.at(-1)).toEqual({ kind: "attribute", node: 6, name: "class", value: "link", original: null, addedByChange: true });
  // Version 0 is the original copies.
  const original = await agent.call("critiqs_mockup", { mockup: made.mockupId, version: 0, backend: BACKEND });
  expect(original.content[0]!.text).toContain("the original page copies");
  expect(data(original).copies.map((copy: any) => copy.edits)).toEqual([[], []]);
  const missing = await agent.call("critiqs_mockup", { mockup: made.mockupId, version: 4, backend: BACKEND });
  expect(missing.isError).toBe(true);
  expect(missing.content[0]!.text).toContain("versions 1 to 3");

  // Saved copies are the original HTML, beside the version's changes.
  const saved = data(await agent.call("critiqs_mockup", { mockup: made.mockupId, version: 2, saveCopies: "mockups", backend: BACKEND }));
  const folder = join(config, "mockups", made.mockupId);
  expect(saved.saved).toEqual({
    folder,
    copies: [join(folder, `${made.desktop}.html`), join(folder, `${made.phone}.html`)],
    edits: join(folder, "edits-v2.json"),
  });
  expect(readFileSync(join(folder, `${made.desktop}.html`), "utf8")).toBe(COPY);
  const edits = JSON.parse(readFileSync(join(folder, "edits-v2.json"), "utf8"));
  expect(edits.version.number).toBe(2);
  expect(edits.copies.map((copy: any) => [copy.file, copy.edits.length])).toEqual([
    [`${made.desktop}.html`, 4],
    [`${made.phone}.html`, 0],
  ]);
});

test("mockups are read only when signed in, and a deleted mockup or unknown project is refused", async () => {
  const { t, tools } = local();
  const ids = await feedback(t);
  const made = await mockupOf(t, ids);
  const agent = tools();
  const before = await agent.call("critiqs_mockup", { mockup: made.mockupId, backend: BACKEND });
  expect(before.isError).toBe(true);
  expect(before.content[0]!.text).toContain("isn't signed in");
  await signIn(t, agent);
  await t.withIdentity(reviewer("Lee")).mutation(api.mockups.remove, { mockupId: made.other });
  const gone = await agent.call("critiqs_mockup", { mockup: made.other, backend: BACKEND });
  expect(gone.isError).toBe(true);
  expect(gone.content[0]!.text).toContain("This mockup does not exist");
  await t.run(async (ctx) => ctx.db.delete(ids.projectId as Id<"projects">));
  const project = await agent.call("critiqs_mockups", { projectId: ids.projectId, backend: BACKEND });
  expect(project.isError).toBe(true);
  expect(project.content[0]!.text).toContain("This project does not exist");
});

test("a thread by ID or link, with mentions, reactions, and who resolved it; and its screenshot", async () => {
  const { t, config, tools } = local();
  const ids = await feedback(t);
  const agent = tools();
  await signIn(t, agent);

  const linked = await agent.call("critiqs_thread", { thread: `https://planner.example/review?critiqs=${ids.department}.${ids.mention}`, backend: BACKEND });
  expect(linked.content[0]!.text).toBe(`Thread ${ids.department} in "Adi Planner": open, 3 messages.`);
  const { thread } = data(linked);
  expect(thread.messages[2]).toMatchObject({
    id: ids.mention,
    linked: true,
    mine: false,
    mentions: [{ name: "Lee", as: "Lee" }],
    reactions: [{ emoji: "👍", count: 1, mine: false }],
  });
  expect(thread.messages[0].linked).toBeUndefined();
  expect(thread.screenshot).toEqual({ status: "failed", failureReason: "Tainted canvas" });

  const resolved = data(await agent.call("critiqs_thread", { thread: ids.spacing, backend: BACKEND })).thread;
  expect(resolved).toMatchObject({ status: "resolved", statusChangedBy: "Dana", screenshot: { status: "captured" }, tags: ["layout"] });
  expect(resolved.context.target.purposeId).toBe("settings.save");

  const shot = await agent.call("critiqs_screenshot", { thread: ids.spacing, file: "shots/spacing.png", backend: BACKEND });
  expect(shot.isError).toBeUndefined();
  expect(shot.content[0]!.text).toContain("with the commented element outlined");
  const image = shot.content.find((item) => item.type === "image")!;
  expect(image.mimeType).toBe("image/png");
  expect(Buffer.from(image.data!, "base64").toString()).toBe("png-bytes");
  expect(data(shot)).toMatchObject({ threadId: ids.spacing, kind: "captured automatically", marker: { x: 10, y: 20, width: 100, height: 24 } });
  expect(readFileSync(join(config, "shots/spacing.png"), "utf8")).toBe("png-bytes");

  const none = await agent.call("critiqs_screenshot", { thread: ids.department, backend: BACKEND });
  expect(none.isError).toBe(true);
  expect(none.content[0]!.text).toContain("no screenshot: Tainted canvas");
  expect((await agent.call("critiqs_thread", { thread: "https://planner.example/review", backend: BACKEND })).content[0]!.text).toContain("no Critiqs thread");
});

test("the kept sign-in renews when its token runs out, once even for agents reading at the same time, and signing out ends it", async () => {
  const { t, config, tools, calls } = local();
  const ids = await feedback(t);
  await signIn(t, tools());
  const stored = () => JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services[SITE];
  const first = stored();

  // The 15-minute token has run out; two agents read at once.
  expireToken(config);
  calls.length = 0;
  const [a, b] = await Promise.all([
    tools().call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND }),
    tools().call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND }),
  ]);
  expect([a.isError, b.isError]).toEqual([undefined, undefined]);
  expect(calls.filter((call) => call === "/auth/refresh")).toHaveLength(1);
  expect(stored().refreshToken).not.toBe(first.refreshToken);
  expect(existsSync(join(config, "sign-in.v2.json.lock"))).toBe(false);

  const out = await tools().call("critiqs_sign_out", { backend: BACKEND });
  expect(out.content[0]!.text).toBe("Signed this computer out of Critiqs (Dana).");
  expect(await t.run(async (ctx) => await ctx.db.query("sessions").collect())).toEqual([]);
  expect(JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services).toEqual({});
  const after = await tools().call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND });
  expect(after.isError).toBe(true);
  expect(after.content[0]!.text).toContain("isn't signed in");
});

test("a session that ended elsewhere is forgotten, and the agent is told to sign in again", async () => {
  const { t, config, tools } = local();
  const ids = await feedback(t);
  await signIn(t, tools());
  await t.run(async (ctx) => {
    for (const session of await ctx.db.query("sessions").collect()) await ctx.db.delete(session._id);
  });
  expireToken(config);
  const result = await tools().call("critiqs_comments", { projectId: ids.projectId, backend: BACKEND });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain("sign-in ended");
  expect(JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services).toEqual({});
});

test("signing out cancels a sign-in still waiting for approval, and a late approval keeps no session", async () => {
  const { t, config, tools } = local();
  await signIn(t, tools());
  const agent = tools();
  const started = await agent.call("critiqs_sign_in", { signIn: "remote", force: true, backend: BACKEND });
  const code = /code ([A-Z]{4}-[A-Z]{4})/.exec(started.content[0]!.text!)?.[1] ?? "";
  expect((await agent.call("critiqs_sign_out", { backend: BACKEND })).content[0]!.text).toBe("Signed this computer out of Critiqs (Dana).");
  expect(await approve(t, code)).toContain("Access approved");
  // The cancelled sign-in's poll may still receive the approval; it ends that session instead of keeping it.
  await new Promise((done) => setTimeout(done, 200));
  expect((await agent.call("critiqs_sign_in_finish", {})).content[0]!.text).toContain("No sign-in is waiting");
  expect(JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services).toEqual({});
  const grants = await t.run(async (ctx) => await ctx.db.query("deviceGrants").collect());
  const sessions = await t.run(async (ctx) => await ctx.db.query("sessions").collect());
  // Either the grant was never redeemed, or it was and its session was ended.
  expect(sessions).toEqual([]);
  expect(grants.every((grant) => grant.status === "approved")).toBe(true);
});

test("signing out says so when the service has no session for this computer, such as after a renewal's answer was lost", async () => {
  const { t, config, tools } = local();
  await signIn(t, tools());
  const { origin, refreshToken } = JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services[SITE];
  // The service renews the session, but its answer never reaches this computer.
  const renewed = await t.fetch("/auth/refresh", { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ refreshToken }) });
  expect(renewed.status).toBe(200);
  const out = await tools().call("critiqs_sign_out", { backend: BACKEND });
  expect(out.content[0]!.text).toContain("The service had no session for it");
  expect(out.content[0]!.text).toContain("ends after 30 days without use");
  expect(JSON.parse(readFileSync(join(config, "sign-in.v2.json"), "utf8")).services).toEqual({});
});

test("an agent replies as the signed-in person, marked as an agent, mentioning people by name or ID, and everyone in the thread is told", async () => {
  const { t, tools } = local();
  const ids = await feedback(t);
  const agent = tools();
  await signIn(t, agent);

  // Lee by name; the text gains "@Lee" since the agent didn't write it.
  const posted = await agent.call("critiqs_reply", { thread: ids.department, body: "Fixed in abc123: the field now says Sales. Please check.", mention: ["lee"], revision: "abc123", backend: BACKEND });
  expect(posted.isError).toBeUndefined();
  const result = data(posted);
  expect(result).toMatchObject({
    threadId: ids.department,
    body: "@Lee Fixed in abc123: the field now says Sales. Please check.",
    revision: "abc123",
    via: "agent",
    mentioned: [{ name: "Lee" }],
    link: `https://planner.example/review?critiqs=${ids.department}.${result.messageId}`,
  });
  expect(posted.content[0]!.text).toContain("mentioning Lee");

  // Everyone sees it as the signed-in person's, written by an agent.
  const thread = data(await agent.call("critiqs_thread", { thread: ids.department, backend: BACKEND })).thread;
  expect(thread.messages.at(-1)).toMatchObject({ id: result.messageId, author: "Dana", via: "agent", revision: "abc123", mentions: [{ name: "Lee" }] });
  expect(thread.messages[0].via).toBeUndefined();

  // Lee, mentioned and already in the thread, is owed it as both (one email, as a mention);
  // the thread's starter (the other Dana) hears about the reply.
  // The email worker queues reply emails before sending; run its steps.
  while (await t.mutation(internal.notifications.replyEmailStep, {})) {}
  const notices = await t.run(async (ctx) => {
    const rows = [];
    for (const notification of await ctx.db.query("notifications").collect()) {
      if (notification.messageId !== result.messageId) continue;
      rows.push([(await ctx.db.get(notification.recipientId))!.name, notification.kind ?? "mention"]);
    }
    return rows.sort();
  });
  expect(notices).toEqual([["Dana", "reply"], ["Lee", "mention"], ["Lee", "reply"]]);

  // By author ID, from critiqs_thread.
  const leeId = thread.messages.find((message: any) => message.author === "Lee").authorId;
  const byId = data(await agent.call("critiqs_reply", { thread: ids.department, body: "@Lee one more thing", mention: [leeId], backend: BACKEND }));
  expect(byId).toMatchObject({ body: "@Lee one more thing", mentioned: [{ id: leeId, name: "Lee" }] });

  // Two other people are named Dana: a name they share is refused with their IDs; an unknown name too.
  const shared = await agent.call("critiqs_reply", { thread: ids.department, body: "x", mention: ["Dana"], backend: BACKEND });
  expect(shared.isError).toBe(true);
  expect(shared.content[0]!.text).toContain('2 people are named "Dana"');
  const unknown = await agent.call("critiqs_reply", { thread: ids.department, body: "x", mention: ["Zed"], backend: BACKEND });
  expect(unknown.content[0]!.text).toContain('No one named "Zed" has commented in this project');
  const empty = await agent.call("critiqs_reply", { thread: ids.department, body: "  ", backend: BACKEND });
  expect(empty.content[0]!.text).toContain("Write the reply's text in body");
  // Refused replies posted nothing.
  expect(await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((message) => message.via === "agent").length)).toBe(2);
});

test("a name two people share is refused even when newer people with similar names would hide one", async () => {
  const { t, tools } = local();
  const ids = await feedback(t);
  const otherLee = t.withIdentity({ ...reviewer("Lee"), subject: "lee-two", tokenIdentifier: "https://auth.example|lee-two", email: "lee.two@example.com" });
  await otherLee.mutation(api.threads.create, { projectId: ids.projectId, anchor, body: "Hi", tags: [], capture: { status: "failed", failureReason: "x" } });
  for (const name of ["Leela", "Lee Ann", "Kalee", "Leeroy", "Ashlee", "Leeds", "Haylee", "Lee Two"]) {
    await t.withIdentity(reviewer(name)).mutation(api.threads.create, { projectId: ids.projectId, anchor, body: "Hi", tags: [], capture: { status: "failed", failureReason: "x" } });
  }
  const agent = tools();
  await signIn(t, agent);
  const refused = await agent.call("critiqs_reply", { thread: ids.department, body: "Fixed", mention: ["Lee"], backend: BACKEND });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toContain('2 people are named "Lee"');
  // Riley-like unique names still resolve.
  const ok = await agent.call("critiqs_reply", { thread: ids.department, body: "Fixed", mention: ["Leeroy"], backend: BACKEND });
  expect(data(ok).mentioned).toEqual([{ id: expect.any(String), name: "Leeroy" }]);
});
