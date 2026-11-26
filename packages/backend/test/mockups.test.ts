import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { runMockupTurn } from "@critiqs/server";
import { createStructuredModel } from "@critiqs/server/ai-providers";
import type { ConvexError } from "convex/values";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { deployment } from "../convex/lib/ai";
import { anchor, reviewer, setup, upload as uploadFile } from "./harness";
import { pages } from "./pages";

// Mockups on Convex: page copies, versions, links, mockup threads, and
// Critiqs AI's turns through the real AI SDK path, against a local stand-in
// for an OpenAI-compatible endpoint configured as the deployment's provider.

const ENV = [
  "CRITIQS_AI_PROVIDER",
  "CRITIQS_AI_MODEL",
  "CRITIQS_AI_API_KEY",
  "CRITIQS_AI_BASE_URL",
  "CRITIQS_AI_ENCRYPTION_KEY",
  "CRITIQS_AI_ALLOWED_ENDPOINTS",
  "CRITIQS_AI_LOCAL_ENDPOINTS",
  "CRITIQS_MANAGED_AI",
  "CRITIQS_MANAGED_AI_PROVIDER",
  "CRITIQS_MANAGED_AI_MODEL",
  "CRITIQS_MANAGED_AI_MODELS",
  "CRITIQS_MANAGED_AI_PRICE",
  "CRITIQS_MANAGED_AI_API_KEY",
  "CRITIQS_MANAGED_AI_BASE_URL",
  "CRITIQS_PLANS",
];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  prompts.length = 0;
  answers.length = 0;
});

/** What the stand-in model answers next, in order, with the tokens it reports; each may first act, as someone else would meanwhile. */
const answers: { answer: unknown; usage?: { prompt_tokens: number; completion_tokens: number }; meanwhile?: () => Promise<unknown> }[] = [];
const prompts: { system: string; prompt: string; model: string; authorization: string | null }[] = [];
let endpoint: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string; messages: { role: string; content: string }[] };
      prompts.push({
        system: body.messages.find((message) => message.role === "system")?.content ?? "",
        prompt: body.messages.find((message) => message.role === "user")?.content ?? "",
        model: body.model,
        authorization: request.headers.get("Authorization"),
      });
      const next = answers.shift() ?? { answer: { reply: "Nothing to do.", summary: "", edits: [], remaining: false } };
      await next.meanwhile?.();
      return Response.json({
        id: "chat",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(next.answer) }, finish_reason: "stop" }],
        usage: next.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});
afterAll(() => endpoint.stop(true));

function withAi() {
  process.env.CRITIQS_AI_PROVIDER = "compatible";
  process.env.CRITIQS_AI_MODEL = "local-model";
  process.env.CRITIQS_AI_API_KEY = "deployment-key";
  process.env.CRITIQS_AI_BASE_URL = `http://127.0.0.1:${endpoint.port}/v1`;
}

const PAGE = '<html><head></head><body data-critiqs-node="1"><button data-critiqs-node="2">Save</button></body></html>';
const source = { url: "https://proto.example/users/alex", screen: "user-details", viewState: { tab: "permissions" }, revision: "abc123", persona: null };
const failed = { status: "failed" as const, failureReason: "x" };
const page = { numItems: 40, cursor: null };

async function mockupProject() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const sam = t.withIdentity(reviewer("Sam"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  type As = { who?: typeof dana; projectId?: Id<"projects"> };
  /** A page copy `who` (Dana unless given) uploads for a project (this one unless given). */
  const upload = (html = PAGE, as: As & { type?: string } = {}): Promise<Id<"_storage">> =>
    uploadFile(as.who ?? dana, as.projectId ?? projectId, html, { purpose: "pageCopy", ...(as.type === undefined ? {} : { type: as.type }) });
  const copy = async (width = 1440, as: As & { storageId?: Id<"_storage"> } = {}) => ({
    storageId: as.storageId ?? (await upload(PAGE, as)),
    width,
    height: 2000,
    scrollY: 0,
    viewportHeight: 900,
    capturedAt: 1,
  });
  const mockupId = await dana.action(api.mockups.create, { projectId, title: "  Bigger   save button ", source, snapshot: await copy() });
  const snapshotId = (await dana.query(api.mockups.get, { mockupId })).snapshots[0]!._id as Id<"mockupSnapshots">;
  /** The mockup's thread, which only its creator starts. */
  const mockupThread = (body = "Make the save button bigger", node: number | null = 2) =>
    dana.mutation(api.threads.create, { projectId, anchor, body, tags: [], capture: failed, mockup: { mockupId, snapshotId, node } });
  return { t, dana, lee, sam, projectId, upload, copy, mockupId, snapshotId, mockupThread };
}

const versions = async (f: Awaited<ReturnType<typeof mockupProject>>) => (await f.dana.query(api.mockups.get, { mockupId: f.mockupId })).versions;
const messages = async (f: Awaited<ReturnType<typeof mockupProject>>, threadId: Id<"threads">) =>
  (await f.lee.query(api.threads.get, { threadId, paginationOpts: page })).page;

test("a mockup starts from a page copy, and anyone in the project lists and opens it", async () => {
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const [listed, ...rest] = await f.lee.query(api.mockups.list, { projectId: f.projectId });
  expect(rest).toEqual([]);
  expect(listed).toMatchObject({ _id: f.mockupId, title: "Bigger save button", source, createdByName: "Dana", versionCount: 0, threadCount: 1 });
  expect(listed!.snapshots).toEqual([{ _id: f.snapshotId, width: 1440 }]);
  // The list carries the mockup's thread, so the panel lists threads in one query.
  expect(listed!.threads).toEqual([
    expect.objectContaining({
      _id: threadId,
      status: "open",
      unread: true,
      preview: { body: "Make the save button bigger", authorName: "Dana", authorImageUrl: null },
      mockup: { mockupId: f.mockupId, snapshotId: f.snapshotId, node: 2 },
    }),
  ]);
  expect((await f.dana.query(api.mockups.list, { projectId: f.projectId }))[0]!.threads[0]!.unread).toBe(false);
  const detail = await f.lee.query(api.mockups.get, { mockupId: f.mockupId });
  expect(detail).toMatchObject({ linkedThreadIds: [], versions: [], snapshots: [{ _id: f.snapshotId, width: 1440, height: 2000, capturedAt: 1, createdByName: "Dana" }] });

  const second = await f.lee.action(api.mockups.addSnapshot, { mockupId: f.mockupId, snapshot: await f.copy(390, { who: f.lee }) });
  expect((await f.dana.query(api.mockups.get, { mockupId: f.mockupId })).snapshots.map((snapshot) => snapshot._id)).toEqual([f.snapshotId, second]);
  expect((await f.dana.query(api.mockups.list, { projectId: f.projectId }))[0]!.snapshots.map((snapshot) => snapshot.width)).toEqual([1440, 390]);
  await f.lee.mutation(api.mockups.rename, { mockupId: f.mockupId, title: "Save, bigger" });
  expect((await f.dana.query(api.mockups.list, { projectId: f.projectId }))[0]!.title).toBe("Save, bigger");

  await expect(f.t.query(api.mockups.list, { projectId: f.projectId })).rejects.toThrow("Sign in");
  await expect(f.t.query(api.mockups.get, { mockupId: f.mockupId })).rejects.toThrow("Sign in");
});

test("the list keeps every mockup of the screen asked for, however many newer ones other screens have", async () => {
  const f = await mockupProject();
  // 100 mockups on another screen, all changed after the user-details one.
  await f.t.run(async (ctx) => {
    const first = (await ctx.db.get(f.mockupId))!;
    for (let index = 0; index < 100; index++) {
      const { _id: _ignored, _creationTime: _time, ...rest } = first;
      await ctx.db.insert("mockups", { ...rest, title: `Settings ${index}`, source: { ...source, screen: "settings" }, updatedAt: first.updatedAt + 1 + index });
    }
  });
  const newest = await f.dana.query(api.mockups.list, { projectId: f.projectId });
  expect(newest).toHaveLength(100);
  expect(newest.map((mockup) => mockup._id)).not.toContain(f.mockupId);

  const forScreen = await f.dana.query(api.mockups.list, { projectId: f.projectId, screen: "user-details" });
  expect(forScreen).toHaveLength(101);
  // Newest first, each once, with the screen's own mockup after the newer ones.
  expect(new Set(forScreen.map((mockup) => mockup._id)).size).toBe(101);
  expect(forScreen.at(-1)!._id).toBe(f.mockupId);
  expect(forScreen[0]!.title).toBe("Settings 99");
  // Asking for a screen whose mockups are among the newest lists them once.
  expect(await f.dana.query(api.mockups.list, { projectId: f.projectId, screen: "settings" })).toHaveLength(100);
});

/** Adds mockups like the first, on `screen`, one per `listedAt` (undefined: without a thread), and returns their IDs. */
async function addMockups(f: Awaited<ReturnType<typeof mockupProject>>, screen: string, times: (number | undefined)[]) {
  return await f.t.run(async (ctx) => {
    const { _id: _ignored, _creationTime: _time, listedAt: _listed, ...first } = (await ctx.db.get(f.mockupId))!;
    const ids = [];
    for (const listedAt of times) {
      const updatedAt = listedAt ?? first.updatedAt;
      ids.push(await ctx.db.insert("mockups", { ...first, title: `${screen} ${updatedAt}`, source: { ...source, screen }, updatedAt, ...(listedAt === undefined ? {} : { listedAt }) }));
    }
    return ids;
  });
}
const listed = (f: Awaited<ReturnType<typeof mockupProject>>, scope: { screen: string } | { otherThan: string }, numItems = 40) =>
  f.lee.query(api.mockups.listPage, { projectId: f.projectId, scope, paginationOpts: { numItems, cursor: null } });

test("the list's pages hold only mockups with a thread: listed once its thread starts, unlisted when it's deleted", async () => {
  const f = await mockupProject();
  const ids = async () => (await listed(f, { screen: "user-details" })).page.map((mockup) => mockup._id);
  expect(await ids()).toEqual([]);
  expect((await listed(f, { otherThan: "settings" })).page).toEqual([]);

  const threadId = await f.mockupThread();
  const [first] = (await listed(f, { screen: "user-details" })).page;
  expect(first).toMatchObject({ _id: f.mockupId, listedAt: first!.updatedAt });
  expect(first!.threads.map((thread) => thread._id)).toEqual([threadId]);
  // Each mockup comes with its threads, as `list` returns it.
  expect(first).toEqual((await f.lee.query(api.mockups.list, { projectId: f.projectId })).find((mockup) => mockup._id === f.mockupId)!);

  // Changes move `listedAt` with `updatedAt`.
  await f.lee.mutation(api.mockups.rename, { mockupId: f.mockupId, title: "Renamed" });
  const [renamed] = (await listed(f, { screen: "user-details" })).page;
  expect(renamed!.listedAt).toBe(renamed!.updatedAt);
  expect(renamed!.listedAt).toBeGreaterThanOrEqual(first!.listedAt!);

  await f.dana.mutation(api.threads.remove, { threadId });
  expect(await ids()).toEqual([]);

  // A mockup without a thread has no `listedAt`, and its changes don't add one.
  const loose = await f.dana.action(api.mockups.create, { projectId: f.projectId, title: "Loose", source, snapshot: await f.copy() });
  await f.dana.mutation(api.mockups.rename, { mockupId: loose, title: "Still loose" });
  expect((await f.lee.query(api.mockups.list, { projectId: f.projectId })).find((mockup) => mockup._id === loose)!.listedAt).toBeNull();
  expect(await ids()).toEqual([]);
});

test("the list reads in pages, newest first: one screen's, or every other screen's, with no gaps or repeats", async () => {
  const f = await mockupProject();
  await f.mockupThread();
  const base = (await f.t.run((ctx) => ctx.db.get(f.mockupId)))!.listedAt!;
  // 30 older settings mockups and 24 newer user-details ones, with mockups
  // without threads mixed in on both screens, which never show.
  const settings = (await addMockups(f, "settings", Array.from({ length: 30 }, (_, index) => base - 100 + index))).reverse();
  const details = [...(await addMockups(f, "user-details", Array.from({ length: 24 }, (_, index) => base + 1 + index))).reverse(), f.mockupId];
  await addMockups(f, "settings", Array.from({ length: 10 }, () => undefined));
  await addMockups(f, "user-details", Array.from({ length: 10 }, () => undefined));
  const read = async (scope: { screen: string } | { otherThan: string }, size: number) => {
    const result = await pages(f.lee, api.mockups.listPage, { projectId: f.projectId, scope }, size);
    return { sizes: result.map((page) => page.page.length), ids: result.flatMap((page) => page.page.map((mockup) => mockup._id)) };
  };

  expect(await read({ screen: "user-details" }, 10)).toEqual({ sizes: [10, 10, 5], ids: details });
  expect(await read({ otherThan: "user-details" }, 20)).toEqual({ sizes: [20, 10], ids: settings });
  expect(await read({ screen: "settings" }, 20)).toEqual({ sizes: [20, 10], ids: settings });
  expect((await read({ otherThan: "settings" }, 20)).ids).toEqual(details);
  expect((await read({ otherThan: "nowhere" }, 40)).ids).toEqual([...details, ...settings]);
  expect(await read({ screen: "nowhere" }, 20)).toEqual({ sizes: [0], ids: [] });

  // The same checks as the list, and bounded pages.
  const args = { projectId: f.projectId, scope: { screen: "user-details" }, paginationOpts: { numItems: 20, cursor: null } };
  await expect(f.t.query(api.mockups.listPage, args)).rejects.toThrow("Sign in");
  await expect(f.lee.query(api.mockups.listPage, { ...args, paginationOpts: { numItems: 41, cursor: null } })).rejects.toThrow("Request between 1 and 40");
  const gone = await f.t.run(async (ctx) => {
    const { _id: _ignored, _creationTime: _time, ...project } = (await ctx.db.get(f.projectId))!;
    const id = await ctx.db.insert("projects", project);
    await ctx.db.delete(id);
    return id;
  });
  await expect(f.lee.query(api.mockups.listPage, { ...args, projectId: gone })).rejects.toThrow("This project does not exist");
});

test("other screens' first page reads past many newer mockups of this screen and still returns the older ones", async () => {
  const f = await mockupProject();
  await f.mockupThread();
  const base = (await f.t.run((ctx) => ctx.db.get(f.mockupId)))!.listedAt!;
  const settings = (await addMockups(f, "settings", Array.from({ length: 25 }, (_, index) => base - 1000 + index))).reverse();
  await addMockups(f, "user-details", Array.from({ length: 300 }, (_, index) => base + 1 + index));
  const first = await listed(f, { otherThan: "user-details" }, 20);
  expect(first.page.map((mockup) => mockup._id)).toEqual(settings.slice(0, 20));
  expect(first.isDone).toBe(false);
  const rest = await f.lee.query(api.mockups.listPage, { projectId: f.projectId, scope: { otherThan: "user-details" }, paginationOpts: { numItems: 20, cursor: first.continueCursor } });
  expect(rest).toMatchObject({ isDone: true });
  expect(rest.page.map((mockup) => mockup._id)).toEqual(settings.slice(20));
});

test("every message in a mockup thread moves its mockup to the top of its page", async () => {
  withAi();
  const f = await mockupProject();
  const older = await f.mockupThread("Make the save button bigger");
  const newer = await f.dana.action(api.mockups.create, { projectId: f.projectId, title: "Rename save", source, snapshot: await f.copy() });
  await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Rename save", tags: [], capture: failed, mockup: { mockupId: newer, snapshotId: null, node: null } });
  const age = (mockupId: Id<"mockups">, at: number) => f.t.run((ctx) => ctx.db.patch(mockupId, { updatedAt: at, listedAt: at }));
  const reset = () => Promise.all([age(f.mockupId, 1), age(newer, 2)]);
  const first = async () => {
    const [top] = (await f.lee.query(api.mockups.listPage, { projectId: f.projectId, scope: { screen: "user-details" }, paginationOpts: { numItems: 1, cursor: null } })).page;
    return { mockupId: top!._id, listedAt: top!.listedAt, lastMessageAt: top!.threads[0]!.lastMessageAt };
  };
  await reset();
  expect((await first()).mockupId).toBe(newer);

  await f.dana.mutation(api.threads.reply, { threadId: older, body: "Bigger still", revision: null });
  const replied = await first();
  expect(replied).toEqual({ mockupId: f.mockupId, listedAt: replied.lastMessageAt, lastMessageAt: expect.any(Number) });

  // Critiqs AI's answer counts as a message too, with or without changes.
  await reset();
  answers.push({ answer: { reply: "Done.", summary: "", edits: [], remaining: false } });
  const copy = [{ snapshotId: f.snapshotId, description: "body #1", complete: true }];
  await f.lee.action(api.ai.mockupReply, { threadId: older, snapshots: copy, continuation: false });
  expect((await first()).mockupId).toBe(f.mockupId);
  await reset();
  answers.push({ answer: { reply: "Bolder.", summary: "Bold", edits: [{ copy: "S1", changes: [{ kind: "text", node: 2, text: "Save!" }] }], remaining: false } });
  await f.lee.action(api.ai.mockupReply, { threadId: older, snapshots: copy, continuation: false });
  expect((await first()).mockupId).toBe(f.mockupId);
});

test("mockups whose thread came before listedAt are listed by the backfill, and those without a thread aren't", async () => {
  const f = await mockupProject();
  await f.mockupThread();
  const [loose] = await addMockups(f, "user-details", [undefined]);
  const updatedAt = await f.t.run(async (ctx) => {
    await ctx.db.patch(f.mockupId, { listedAt: undefined });
    return (await ctx.db.get(f.mockupId))!.updatedAt;
  });
  expect((await listed(f, { screen: "user-details" })).page).toEqual([]);
  await f.t.mutation(internal.mockups.backfillListedAt, {});
  // Running it again changes nothing.
  await f.t.mutation(internal.mockups.backfillListedAt, {});
  expect((await listed(f, { screen: "user-details" })).page.map((mockup) => [mockup._id, mockup.listedAt])).toEqual([[f.mockupId, updatedAt]]);
  expect((await f.t.run((ctx) => ctx.db.get(loose!)))!.listedAt).toBeUndefined();
});

test("each mockup thread is its own proposal: a mockup refuses a second thread", async () => {
  const f = await mockupProject();
  const first = await f.mockupThread();
  await expect(f.mockupThread("Also make it green", null)).rejects.toThrow("This mockup already has its thread");
  await expect(
    f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Whole page", tags: [], capture: failed, mockup: { mockupId: f.mockupId, snapshotId: null, node: null } }),
  ).rejects.toThrow("Start a new mockup for another proposal");
  // The refused thread isn't kept.
  expect((await f.dana.query(api.mockups.threads, { mockupId: f.mockupId })).map((thread) => thread._id)).toEqual([first]);
  // Another mockup takes the next proposal.
  const other = await f.dana.action(api.mockups.create, { projectId: f.projectId, title: "Also make it green", source, snapshot: await f.copy() });
  await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Also make it green", tags: [], capture: failed, mockup: { mockupId: other, snapshotId: null, node: null } });
  expect((await f.dana.query(api.mockups.list, { projectId: f.projectId })).map((mockup) => mockup.threads.length)).toEqual([1, 1]);
});

test("page copies are served as text, only to signed-in reviewers", async () => {
  const f = await mockupProject();
  const path = `/mockup/snapshot?snapshotId=${f.snapshotId}`;
  const response = await f.lee.fetch(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  expect(await response.text()).toBe(PAGE);
  expect((await f.t.fetch(path)).status).toBe(401);
  expect((await f.t.fetch("/mockup/snapshot?snapshotId=not-an-id")).status).toBe(401);
  expect((await f.lee.fetch("/mockup/snapshot?snapshotId=not-an-id")).status).toBe(404);
});

test("an upload that isn't a page copy within the limits is refused and deleted", async () => {
  const f = await mockupProject();
  const exists = (id: Id<"_storage">) => f.t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);
  const files = () => f.t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
  const before = await files();
  // Too large or not HTML, it is refused as it arrives, and never stored.
  await expect(f.upload("x".repeat(10 * 1024 * 1024 + 1))).rejects.toThrow("limited to 10 MB");
  await expect(f.upload(PAGE, { type: "image/svg+xml" })).rejects.toThrow("must be uploaded as text/html");
  expect(await files()).toBe(before);
  // A copy refused once stored is deleted.
  const unusable = await f.upload();
  await expect(f.dana.action(api.mockups.create, { projectId: f.projectId, title: "Flat", source, snapshot: { ...(await f.copy(1440, { storageId: unusable })), height: 0 } })).rejects.toThrow("positive size");
  expect(await exists(unusable)).toBe(false);
  // A copy already in a mockup isn't taken again, nor deleted.
  const used = (await f.t.run((ctx) => ctx.db.get(f.snapshotId)))!.storageId;
  await expect(f.dana.action(api.mockups.addSnapshot, { mockupId: f.mockupId, snapshot: await f.copy(1440, { storageId: used }) })).rejects.toThrow("already belongs");
  expect(await exists(used)).toBe(true);
  // Someone who isn't signed in can't have an upload deleted.
  const fresh = await f.upload();
  await expect(f.t.action(api.mockups.addSnapshot, { mockupId: f.mockupId, snapshot: await f.copy(1440, { storageId: fresh }) })).rejects.toThrow("Sign in");
  expect(await exists(fresh)).toBe(true);
  for (let count = 1; count < 6; count++) await f.dana.action(api.mockups.addSnapshot, { mockupId: f.mockupId, snapshot: await f.copy(400 + count) });
  await expect(f.dana.action(api.mockups.addSnapshot, { mockupId: f.mockupId, snapshot: await f.copy(300) })).rejects.toThrow("up to 6 page copies");
});

test("an upload is attachable only by its uploader, in its project, for its purpose, and once", async () => {
  const f = await mockupProject();
  const exists = (id: Id<"_storage">) => f.t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);
  const startMockup = (who: typeof f.dana, storageId: Id<"_storage">, projectId = f.projectId) =>
    who.action(api.mockups.create, { projectId, title: "Bound", source, snapshot: { storageId, width: 1440, height: 2000, scrollY: 0, viewportHeight: 900, capturedAt: 1 } });
  const capture = (who: typeof f.dana, storageId: Id<"_storage">, projectId = f.projectId) =>
    who.mutation(api.threads.create, { projectId, anchor, body: "Look", tags: [], capture: { status: "captured", storageId } });

  // A screenshot isn't a page copy, nor a page copy a screenshot, even without a recorded type (convex-test records none).
  const screenshot: Id<"_storage"> = await uploadFile(f.dana, f.projectId, "png");
  const pageCopy = await f.upload();
  expect(await f.t.run(async (ctx) => [(await ctx.db.system.get(screenshot))?.contentType ?? null, (await ctx.db.system.get(pageCopy))?.contentType ?? null])).toEqual([null, null]);
  await expect(startMockup(f.dana, screenshot)).rejects.toThrow("This page copy was not uploaded by you for this project.");
  await expect(capture(f.dana, pageCopy)).rejects.toThrow("This screenshot was not uploaded by you for this project.");
  // A refused mockup leaves an upload meant for a screenshot alone.
  expect(await exists(screenshot)).toBe(true);

  // Nor is one person's upload another's, or one project's another's.
  const danas = await f.upload();
  await expect(startMockup(f.lee, danas)).rejects.toThrow("This page copy was not uploaded by you for this project.");
  // Lee's refused request doesn't delete Dana's upload.
  expect(await exists(danas)).toBe(true);
  const otherProject = await f.dana.mutation(api.projects.create, { name: "Other" });
  await expect(capture(f.dana, screenshot, otherProject)).rejects.toThrow("This screenshot was not uploaded by you for this project.");

  // Each file is attached once, whichever kind first took it.
  await capture(f.dana, screenshot);
  await expect(capture(f.dana, screenshot)).rejects.toThrow("already belongs to a thread");
  await startMockup(f.dana, danas);
  await expect(startMockup(f.dana, danas)).rejects.toThrow("already belongs to a mockup");
  // A file stored without a reservation, as before them, can't be attached anew.
  const unreserved = await f.t.run((ctx) => ctx.storage.store(new Blob([PAGE], { type: "text/html" })));
  await expect(startMockup(f.dana, unreserved)).rejects.toThrow("Upload the page copy again.");
});

test("deleting a mockup keeps a file that, from before uploads were reserved, is also a thread's capture", async () => {
  const f = await mockupProject();
  const shared = (await f.t.run((ctx) => ctx.db.get(f.snapshotId)))!.storageId;
  const threadId = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Old", tags: [], capture: failed });
  await f.t.run((ctx) => ctx.db.patch(threadId, { capture: { status: "captured", storageId: shared } }));
  await f.dana.mutation(api.mockups.remove, { mockupId: f.mockupId });
  expect(await f.t.run((ctx) => ctx.db.system.get(shared))).not.toBeNull();
  expect(await (await f.lee.fetch(`/capture?threadId=${threadId}`)).text()).toBe(PAGE);
});

test("mockup threads are only the mockup's: out of the thread list, search, and export, but open by ID", async () => {
  const f = await mockupProject();
  const normal = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Save is hard to find", tags: [], capture: failed });
  const threadId = await f.mockupThread("Make the save button easier to find");
  const listed = await f.dana.query(api.threads.list, { projectId: f.projectId, paginationOpts: page });
  expect(listed.page.map((thread) => thread._id)).toEqual([normal]);
  const own = await f.dana.query(api.mockups.threads, { mockupId: f.mockupId });
  expect(own).toMatchObject([{ _id: threadId, unread: false, mockup: { mockupId: f.mockupId, snapshotId: f.snapshotId, node: 2 }, preview: { authorName: "Dana" } }]);
  expect(await f.dana.query(api.threads.get, { threadId, paginationOpts: page })).toMatchObject({ mockup: { mockupId: f.mockupId, node: 2 } });

  const found = await f.dana.action(api.ai.search, { projectId: f.projectId, question: "save", scope: { status: "all", screen: null } });
  expect(found.results.map((result) => result.threadId)).toEqual([normal]);
  const exported = await f.dana.query(api.threads.exportThreads, { projectId: f.projectId, threadIds: [threadId], threadIndex: 0, paginationOpts: page });
  expect(exported.thread).toBeNull();

  // A mockup thread names a mockup and copy of its own project.
  const otherProject = await f.sam.mutation(api.projects.create, { name: "Other" });
  const elsewhere = { mockupId: f.mockupId, snapshotId: f.snapshotId, node: null };
  await expect(f.sam.mutation(api.threads.create, { projectId: otherProject, anchor, body: "x", tags: [], capture: failed, mockup: elsewhere })).rejects.toThrow("isn't in the project");
  const otherMockup = await f.sam.action(api.mockups.create, { projectId: otherProject, title: "Other", source, snapshot: await f.copy(1440, { who: f.sam, projectId: otherProject }) });
  const foreignCopy = (await f.sam.query(api.mockups.get, { mockupId: otherMockup })).snapshots[0]!._id as Id<"mockupSnapshots">;
  await expect(
    f.lee.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "x", tags: [], capture: failed, mockup: { mockupId: f.mockupId, snapshotId: foreignCopy, node: 1 } }),
  ).rejects.toThrow("isn't in the mockup");
  await expect(
    f.lee.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "x", tags: [], capture: failed, mockup: { mockupId: f.mockupId, snapshotId: null, node: 3 } }),
  ).rejects.toThrow("name the copy");
});

test("colors and selectors written in mockup threads never become project tags", async () => {
  const f = await mockupProject();
  const threadId = await f.mockupThread("Change #header to #f5f5f5");
  await f.lee.mutation(api.threads.reply, { threadId, body: "And #footer too", revision: null });
  const { tags } = await f.dana.query(api.tags.list, { projectId: f.projectId });
  expect(tags.map((tag) => tag.key).filter((key) => ["header", "f5f5f5", "footer"].includes(key))).toEqual([]);
  expect((await f.dana.query(api.mockups.threads, { mockupId: f.mockupId }))[0]!.tags).toEqual([]);
});

test("existing threads of the mockup's project are linked as instructions", async () => {
  const f = await mockupProject();
  const normal = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Save is hard to find", tags: [], capture: failed });
  await f.lee.mutation(api.mockups.link, { mockupId: f.mockupId, threadId: normal });
  await f.lee.mutation(api.mockups.link, { mockupId: f.mockupId, threadId: normal });
  expect((await f.dana.query(api.mockups.get, { mockupId: f.mockupId })).linkedThreadIds).toEqual([normal]);
  expect(await f.dana.query(api.mockups.forThread, { threadId: normal })).toEqual([{ _id: f.mockupId, title: "Bigger save button" }]);

  const mockupThread = await f.mockupThread();
  await expect(f.lee.mutation(api.mockups.link, { mockupId: f.mockupId, threadId: mockupThread })).rejects.toThrow("Only feedback threads");
  const otherProject = await f.sam.mutation(api.projects.create, { name: "Other" });
  const foreign = await f.sam.mutation(api.threads.create, { projectId: otherProject, anchor, body: "x", tags: [], capture: failed });
  await expect(f.lee.mutation(api.mockups.link, { mockupId: f.mockupId, threadId: foreign })).rejects.toThrow("own project");

  await f.dana.mutation(api.mockups.unlink, { mockupId: f.mockupId, threadId: normal });
  expect(await f.dana.query(api.mockups.forThread, { threadId: normal })).toEqual([]);
});

test("linking another project's thread tells nothing about it: deleted, limited to its organization, or not there, the refusal is the same", async () => {
  const f = await mockupProject();
  const otherProject = await f.sam.mutation(api.projects.create, { name: "Other" });
  const thread = () => f.sam.mutation(api.threads.create, { projectId: otherProject, anchor, body: "x", tags: [], capture: failed });
  const open = await thread();
  const deleted = await thread();
  await f.sam.mutation(api.threads.remove, { threadId: deleted });
  const missing = await f.t.run(async (ctx) => {
    const { _id: _ignored, _creationTime: _time, ...copy } = (await ctx.db.get(open))!;
    const id = await ctx.db.insert("threads", copy);
    await ctx.db.delete(id);
    return id;
  });
  // Limited to Sam's organization, which neither Lee nor Dana is in.
  const restricted = await thread();
  await f.sam.mutation(api.projects.setReviewAccess, { projectId: otherProject, reviewAccess: "organization" });
  const refusals = [];
  for (const threadId of [open, deleted, missing, restricted]) {
    refusals.push(await f.lee.mutation(api.mockups.link, { mockupId: f.mockupId, threadId }).catch((error: ConvexError<{ code: string; message: string }>) => error.data));
  }
  expect(refusals).toEqual(Array(4).fill({ code: "invalid", message: "Link threads from the mockup's own project." }));
  expect((await f.dana.query(api.mockups.get, { mockupId: f.mockupId })).linkedThreadIds).toEqual([]);
});

test("a new mockup links the comments added for it in the same step, or stores nothing when one can't be linked", async () => {
  const f = await mockupProject();
  const exists = (id: Id<"_storage">) => f.t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);
  const titles = async () => (await f.dana.query(api.mockups.list, { projectId: f.projectId })).map((mockup) => mockup.title);
  const normal = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Save is hard to find", tags: [], capture: failed });
  const linked = await f.lee.action(api.mockups.create, { projectId: f.projectId, title: "Linked", source, snapshot: await f.copy(1440, { who: f.lee }), linkedThreadIds: [normal, normal] });
  expect((await f.dana.query(api.mockups.get, { mockupId: linked })).linkedThreadIds).toEqual([normal]);

  const otherProject = await f.sam.mutation(api.projects.create, { name: "Other" });
  const foreign = await f.sam.mutation(api.threads.create, { projectId: otherProject, anchor, body: "x", tags: [], capture: failed });
  const mockupThread = await f.mockupThread();
  const deleted = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Gone", tags: [], capture: failed });
  await f.dana.mutation(api.threads.remove, { threadId: deleted });
  const many = [];
  for (let count = 0; count < 21; count++) {
    many.push(await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: `Comment ${count}`, tags: [], capture: failed }));
  }
  // Another project's thread is refused alike whether or not it was deleted, so nothing about it is told.
  const foreignDeleted = await f.sam.mutation(api.threads.create, { projectId: otherProject, anchor, body: "y", tags: [], capture: failed });
  await f.sam.mutation(api.threads.remove, { threadId: foreignDeleted });
  const refusals: [Id<"threads">[], string][] = [
    [[normal, foreign], "Link threads from the mockup's own project."],
    [[foreignDeleted], "Link threads from the mockup's own project."],
    [[mockupThread], "Only feedback threads"],
    [[deleted], "was deleted"],
    [many, "up to 20"],
  ];
  for (const [linkedThreadIds, reason] of refusals) {
    const storageId = await f.upload(PAGE, { who: f.lee });
    await expect(f.lee.action(api.mockups.create, { projectId: f.projectId, title: "Refused", source, snapshot: await f.copy(1440, { storageId }), linkedThreadIds })).rejects.toThrow(reason);
    // No half-made mockup, and the upload is gone.
    expect(await exists(storageId)).toBe(false);
  }
  expect(await titles()).not.toContain("Refused");
  expect(await f.dana.query(api.mockups.forThread, { threadId: normal })).toEqual([{ _id: linked, title: "Linked" }]);
});

test("Critiqs AI answers in a mockup thread with a reply and a version of cumulative changes, emailing nobody", async () => {
  withAi();
  const f = await mockupProject();
  const normal = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Save is hard to find on small screens", tags: [], capture: failed });
  await f.dana.mutation(api.mockups.link, { mockupId: f.mockupId, threadId: normal });
  const threadId = await f.mockupThread();
  // Dana is in the thread, so a person's reply here emails Lee and her as usual.
  await f.dana.mutation(api.threads.reply, { threadId, body: "Yes, and blue", revision: null });
  const emailsBefore = await f.t.run(async (ctx) => ({
    jobs: (await ctx.db.query("replyEmailJobs").collect()).length,
    deliveries: (await ctx.db.query("deliveries").collect()).length,
    followers: (await ctx.db.query("threadFollowers").collect()).length,
  }));

  const description = 'body #1\n  button #2 "Save" {12x30}';
  answers.push({
    answer: {
      reply: "I made the save button larger and blue.",
      summary: "Larger blue save button",
      edits: [{ copy: "S1", changes: [{ kind: "css", css: '[data-critiqs-node="2"] { padding: 12px; background: blue; }' }] }],
      remaining: true,
    },
  });
  const first = await f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ snapshotId: f.snapshotId, description, complete: false }], continuation: false });
  expect(first).toMatchObject({ version: 1, remaining: true });
  expect(prompts[0]!.prompt).toContain(JSON.stringify(description));
  expect(prompts[0]!.prompt).toContain(JSON.stringify("Make the save button bigger"));
  expect(prompts[0]!.prompt).toContain(JSON.stringify("Save is hard to find on small screens"));
  expect(prompts[0]!.prompt).toContain("the thread is about element #2");

  answers.push({
    answer: { reply: "Also renamed it.", summary: "Rename save", edits: [{ copy: "S1", changes: [{ kind: "text", node: 2, text: "Save changes" }] }], remaining: false },
  });
  const second = await f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ snapshotId: f.snapshotId, description, complete: false }], continuation: true });
  expect(second).toMatchObject({ version: 2, remaining: false });
  expect(prompts[1]!.prompt).toContain("continues your previous answer");

  const saved = await versions(f);
  expect(saved.map((version) => ({ number: version.number, byAi: version.byAi, summary: version.summary, threadId: version.threadId, authorName: version.authorName }))).toEqual([
    { number: 1, byAi: true, summary: "Larger blue save button", threadId, authorName: "Lee" },
    { number: 2, byAi: true, summary: "Rename save", threadId, authorName: "Lee" },
  ]);
  expect(saved[1]!.edits[f.snapshotId]).toEqual([
    { kind: "css", css: '[data-critiqs-node="2"] { padding: 12px; background: blue; }' },
    { kind: "text", node: 2, text: "Save changes" },
  ]);
  const [, , ai] = await messages(f, threadId);
  expect(ai).toMatchObject({ _id: first.messageId, body: "I made the save button larger and blue.", via: "ai", mockupVersion: 1, author: { name: "Lee" } });
  expect(saved[0]!.messageId).toBe(first.messageId);
  await expect(f.lee.mutation(api.threads.editMessage, { messageId: first.messageId, body: "Edited" })).rejects.toThrow("can't be edited");

  const emailsAfter = await f.t.run(async (ctx) => ({
    jobs: (await ctx.db.query("replyEmailJobs").collect()).length,
    deliveries: (await ctx.db.query("deliveries").collect()).length,
    followers: (await ctx.db.query("threadFollowers").collect()).length,
  }));
  expect(emailsAfter).toEqual(emailsBefore);

  // A question back saves the reply without a version.
  answers.push({ answer: { reply: "Which shade of blue?", summary: "", edits: [], remaining: false } });
  const question = await f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ snapshotId: f.snapshotId, description, complete: true }], continuation: false });
  expect(question).toMatchObject({ version: null, remaining: false });
  expect((await messages(f, threadId)).at(-1)).toMatchObject({ body: "Which shade of blue?", via: "ai" });
  expect(await versions(f)).toHaveLength(2);
});

test("restoring copies an earlier version into a new one, and a stale restore or AI answer is refused", async () => {
  withAi();
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const description = 'body #1\n  button #2 "Save"';
  const ask = () => f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ snapshotId: f.snapshotId, description, complete: true }], continuation: false });
  answers.push({ answer: { reply: "Removed it.", summary: "Remove save", edits: [{ copy: "S1", changes: [{ kind: "remove", node: 2 }] }], remaining: false } });
  await ask();

  expect(await f.dana.mutation(api.mockups.restore, { mockupId: f.mockupId, number: 0, expectedHead: 1 })).toBe(2);
  await expect(f.dana.mutation(api.mockups.restore, { mockupId: f.mockupId, number: 1, expectedHead: 1 })).rejects.toThrow("newer version");
  expect(await f.dana.mutation(api.mockups.restore, { mockupId: f.mockupId, number: 1, expectedHead: 2 })).toBe(3);
  const saved = await versions(f);
  expect(saved.map((version) => [version.number, version.restoredFrom, version.byAi, version.edits[f.snapshotId] ?? []])).toEqual([
    [1, null, true, [{ kind: "remove", node: 2 }]],
    [2, 0, false, []],
    [3, 1, false, [{ kind: "remove", node: 2 }]],
  ]);

  // Someone restores while Critiqs AI works: its answer is refused, not saved over the restore.
  const count = (await messages(f, threadId)).length;
  answers.push({
    answer: { reply: "Renamed it.", summary: "Rename", edits: [{ copy: "S1", changes: [{ kind: "text", node: 1, text: "x" }] }], remaining: false },
    meanwhile: () => f.dana.mutation(api.mockups.restore, { mockupId: f.mockupId, number: 0, expectedHead: 3 }),
  });
  await expect(ask()).rejects.toThrow("while Critiqs AI was working");
  expect((await versions(f)).map((version) => version.restoredFrom)).toEqual([null, 0, 1, 0]);
  expect(await messages(f, threadId)).toHaveLength(count);
});

test("a priced Critiqs AI turn costs its answer's tokens, even when its save is refused, and nothing when the answer is refused", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODEL = "managed-model";
  process.env.CRITIQS_MANAGED_AI_PRICE = JSON.stringify({ input: 4, output: 20 });
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = `http://127.0.0.1:${endpoint.port}/v1`;
  process.env.CRITIQS_PLANS = "enabled";
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const used = async () => (await f.dana.query(api.projects.usage, { projectId: f.projectId, day: new Date().toISOString().slice(0, 10), aiCredits: true }))!.rows.find((row) => row.metric === "aiCredits")!.used;
  const ask = () => f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ snapshotId: f.snapshotId, description: 'body #1\n  button #2 "Save"', complete: true }], continuation: false });
  // 10,000 input and 2,000 output tokens at $4 and $20 per million: $0.08, 16 credits.
  const tokens = { prompt_tokens: 10_000, completion_tokens: 2_000 };
  answers.push({ answer: { reply: "Removed it.", summary: "Remove save", edits: [{ copy: "S1", changes: [{ kind: "remove", node: 2 }] }], remaining: false }, usage: tokens });
  await ask();
  expect(await used()).toBe(16);
  answers.push({ answer: { reply: "Added a tracker.", summary: "Tracker", edits: [{ copy: "S1", changes: [{ kind: "insert", node: 1, position: "append", html: "<script>steal()</script>" }] }], remaining: false }, usage: tokens });
  await expect(ask()).rejects.toThrow("Critiqs AI couldn't answer");
  expect(await used()).toBe(16);
  answers.push({
    answer: { reply: "Renamed it.", summary: "Rename", edits: [{ copy: "S1", changes: [{ kind: "text", node: 1, text: "x" }] }], remaining: false },
    usage: tokens,
    meanwhile: () => f.dana.mutation(api.mockups.restore, { mockupId: f.mockupId, number: 0, expectedHead: 1 }),
  });
  await expect(ask()).rejects.toThrow("while Critiqs AI was working");
  expect(await used()).toBe(32);
});

test("changes the model may not make refuse its whole answer, and without AI the turn says why", async () => {
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const snapshots = [{ snapshotId: f.snapshotId, description: "body #1", complete: true }];
  const ask = () => f.lee.action(api.ai.mockupReply, { threadId, snapshots, continuation: false });
  await expect(ask()).rejects.toThrow("AI isn't set up");
  expect(prompts).toEqual([]);

  withAi();
  answers.push({
    answer: { reply: "Added a tracker.", summary: "Tracker", edits: [{ copy: "S1", changes: [{ kind: "insert", node: 1, position: "append", html: "<script>steal()</script>" }] }], remaining: false },
  });
  await expect(ask()).rejects.toThrow("Critiqs AI couldn't answer");
  expect(await versions(f)).toEqual([]);
  expect(await messages(f, threadId)).toHaveLength(1);

  // Only mockup threads, and only the mockup's own copies.
  const normal = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "x", tags: [], capture: failed });
  await expect(f.lee.action(api.ai.mockupReply, { threadId: normal, snapshots, continuation: false })).rejects.toThrow("only in mockup threads");
  const other = await f.dana.action(api.mockups.create, { projectId: f.projectId, title: "Other", source, snapshot: await f.copy() });
  const otherCopy = (await f.dana.query(api.mockups.get, { mockupId: other })).snapshots[0]!._id as Id<"mockupSnapshots">;
  await expect(f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ ...snapshots[0]!, snapshotId: otherCopy }], continuation: false })).rejects.toThrow(
    "isn't in this mockup",
  );
});

test("a mockup turn refused for want of credits still owes the organization's admins the email that none are left", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODELS = JSON.stringify([{ id: "big", label: "Big", model: "big-model", credits: 150 }]);
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = `http://127.0.0.1:${endpoint.port}/v1`;
  process.env.CRITIQS_PLANS = "enabled";
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const ask = () => f.lee.action(api.ai.mockupReply, { threadId, snapshots: [{ snapshotId: f.snapshotId, description: "body #1", complete: true }], continuation: false });
  await ask();
  await expect(ask()).rejects.toThrow("enough Critiqs AI credits left for this request");
  expect(prompts).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("planAlerts").collect())).toEqual([expect.objectContaining({ kind: "paused", plan: "free", planLabel: "Free", status: "pending" })]);
});

test("only a mockup's creator or the project's owner deletes it, with its versions, copies, links, and threads", async () => {
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const normal = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "x", tags: [], capture: failed });
  await f.dana.mutation(api.mockups.link, { mockupId: f.mockupId, threadId: normal });
  await f.dana.mutation(api.mockups.restore, { mockupId: f.mockupId, number: 0, expectedHead: 0 });
  const storageId = (await f.t.run((ctx) => ctx.db.get(f.snapshotId)))!.storageId;

  await expect(f.lee.mutation(api.mockups.remove, { mockupId: f.mockupId })).rejects.toThrow("Only the person who made this mockup");
  // Lee's own mockup in Dana's project: Dana owns the project, so she may delete it too.
  const leesMockup = await f.lee.action(api.mockups.create, { projectId: f.projectId, title: "Lee's", source, snapshot: await f.copy(1440, { who: f.lee }) });
  await f.dana.mutation(api.mockups.remove, { mockupId: leesMockup });

  await f.dana.mutation(api.mockups.remove, { mockupId: f.mockupId });
  expect(await f.dana.query(api.mockups.list, { projectId: f.projectId })).toEqual([]);
  await expect(f.dana.query(api.mockups.get, { mockupId: f.mockupId })).rejects.toThrow("does not exist");
  await expect(f.dana.query(api.threads.get, { threadId, paginationOpts: page })).rejects.toThrow("deleted");
  expect(await f.dana.query(api.mockups.forThread, { threadId: normal })).toEqual([]);
  const left = await f.t.run(async (ctx) => ({
    file: await ctx.db.system.get(storageId),
    versions: await ctx.db.query("mockupVersions").collect(),
    snapshots: await ctx.db.query("mockupSnapshots").collect(),
    links: await ctx.db.query("mockupLinks").collect(),
  }));
  expect(left).toEqual({ file: null, versions: [], snapshots: [], links: [] });
});

test("only a mockup's creator starts its thread: another reviewer, even one who manages the project, can't", async () => {
  const f = await mockupProject();
  const start = (who: typeof f.dana, body: string) =>
    who.mutation(api.threads.create, { projectId: f.projectId, anchor, body, tags: [], capture: failed, mockup: { mockupId: f.mockupId, snapshotId: f.snapshotId, node: null } });
  await expect(start(f.sam, "Try a darker button")).rejects.toThrow("Only the person who made this mockup can start its thread");
  const leesMockup = await f.lee.action(api.mockups.create, { projectId: f.projectId, title: "Lee's", source, snapshot: await f.copy(1440, { who: f.lee }) });
  // Dana manages the project, but the proposal is Lee's.
  await expect(
    f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Mine now", tags: [], capture: failed, mockup: { mockupId: leesMockup, snapshotId: null, node: null } }),
  ).rejects.toThrow("Only the person who made this mockup can start its thread");
  // Nothing was kept, and neither mockup is listed until its creator starts its thread.
  expect(await f.t.run((ctx) => ctx.db.query("threads").collect())).toEqual([]);
  expect((await listed(f, { screen: "user-details" })).page).toEqual([]);
  // The older list still shows both, as before their threads start.
  expect((await f.sam.query(api.mockups.list, { projectId: f.projectId })).map((mockup) => [mockup.title, mockup.threadCount]).sort()).toEqual([
    ["Bigger save button", 0],
    ["Lee's", 0],
  ]);
  const threadId = await start(f.dana, "Make the save button bigger");
  expect((await f.sam.query(api.mockups.threads, { mockupId: f.mockupId })).map((thread) => thread._id)).toEqual([threadId]);
  // Once the creator deletes it, the mockup's next thread is still theirs alone.
  await f.dana.mutation(api.threads.remove, { threadId });
  await expect(start(f.sam, "Now mine")).rejects.toThrow("Only the person who made this mockup can start its thread");
});

test("a mockup's creator can't delete it while it has a thread someone else started, and nothing is removed", async () => {
  const f = await mockupProject();
  const leesMockup = await f.lee.action(api.mockups.create, { projectId: f.projectId, title: "Lee's", source, snapshot: await f.copy(1440, { who: f.lee }) });
  const leesCopy = (await f.lee.query(api.mockups.get, { mockupId: leesMockup })).snapshots[0]!._id as Id<"mockupSnapshots">;
  // Sam, who can review the project but doesn't manage it, started the mockup's thread before only creators could.
  const samsThread = await f.lee.mutation(api.threads.create, {
    projectId: f.projectId,
    anchor,
    body: "Try a darker button",
    tags: [],
    capture: failed,
    mockup: { mockupId: leesMockup, snapshotId: leesCopy, node: null },
  });
  await f.sam.mutation(api.users.sync, {});
  await f.t.run(async (ctx) => {
    const sam = (await ctx.db.query("users").collect()).find((user) => user.name === "Sam")!._id;
    await ctx.db.patch(samsThread, { createdBy: sam });
    for (const message of await ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", samsThread)).collect()) await ctx.db.patch(message._id, { authorId: sam });
  });
  await expect(f.lee.mutation(api.mockups.remove, { mockupId: leesMockup })).rejects.toThrow(
    "Someone else started this mockup's thread. Only they or the project's owners can delete it.",
  );
  expect((await f.sam.query(api.threads.get, { threadId: samsThread, paginationOpts: page })).page.map((message) => message.body)).toEqual(["Try a darker button"]);
  expect((await f.lee.query(api.mockups.get, { mockupId: leesMockup })).snapshots).toHaveLength(1);
  // Once Sam deletes their thread, Lee may delete the mockup.
  await f.sam.mutation(api.threads.remove, { threadId: samsThread });
  await f.lee.mutation(api.mockups.remove, { mockupId: leesMockup });
  await expect(f.lee.query(api.mockups.get, { mockupId: leesMockup })).rejects.toThrow("does not exist");
});

test("a Critiqs AI turn whose project is limited to its organization after it is prepared sends the model nothing", async () => {
  withAi();
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  let asked = 0;
  const saved: unknown[] = [];
  const turn = runMockupTurn({
    prepare: async () => {
      const plan = await f.lee.mutation(internal.mockups.prepareAi, { threadId, snapshots: [{ snapshotId: f.snapshotId, description: "body #1", complete: true }], continuation: false });
      // The turn read the thread; then Dana limits the project to her organization, which Lee isn't in.
      await f.dana.mutation(api.projects.setReviewAccess, { projectId: f.projectId, reviewAccess: "organization" });
      return plan;
    },
    authorize: async () => void (await f.lee.query(internal.mockups.recheckAi, { threadId })),
    finalize: async (answer) => {
      saved.push(answer);
      return { messageId: "", version: null };
    },
    reserve: (payer, credits) => f.lee.mutation(internal.aiSettings.reserve, { ...payer, credits }),
    settle: async (hold, charge) => void (await f.lee.mutation(internal.aiSettings.settle, { hold, charge })),
    model: () => ({
      description: "never asked",
      // As the AI SDK path does, checks before sending.
      generate: async (request) => {
        await request.beforeSend?.();
        asked++;
        throw new Error("The model was asked.");
      },
    }),
    deployment: deployment(),
  });
  await expect(turn).rejects.toThrow("limited to members of its organization");
  expect(asked).toBe(0);
  expect(saved).toEqual([]);
});

test("a managed Critiqs AI turn whose project is limited to its organization while its credits are held sends the model nothing", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODEL = "managed-model";
  process.env.CRITIQS_MANAGED_AI_PRICE = JSON.stringify({ input: 4, output: 20 });
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = `http://127.0.0.1:${endpoint.port}/v1`;
  process.env.CRITIQS_PLANS = "enabled";
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  let reserved = 0;
  const turn = runMockupTurn({
    prepare: () => f.lee.mutation(internal.mockups.prepareAi, { threadId, snapshots: [{ snapshotId: f.snapshotId, description: "body #1", complete: true }], continuation: false }),
    authorize: async () => void (await f.lee.query(internal.mockups.recheckAi, { threadId })),
    finalize: async () => {
      throw new Error("Nothing was asked, so nothing is saved.");
    },
    // The turn's credits are held; then Dana limits the project to her organization, which Lee isn't in.
    reserve: async (payer, credits) => {
      const held = await f.lee.mutation(internal.aiSettings.reserve, { ...payer, credits });
      reserved++;
      await f.dana.mutation(api.projects.setReviewAccess, { projectId: f.projectId, reviewAccess: "organization" });
      return held;
    },
    settle: async (hold, charge) => void (await f.lee.mutation(internal.aiSettings.settle, { hold, charge })),
    // The real AI SDK path, against the local stand-in.
    model: (connection) => createStructuredModel(connection),
    deployment: deployment(),
  });
  await expect(turn).rejects.toThrow("limited to members of its organization");
  expect(reserved).toBe(1);
  expect(prompts).toEqual([]);
  // The hold was released.
  expect(await f.t.run((ctx) => ctx.db.query("creditHolds").collect())).toEqual([]);
});

test("Critiqs AI in a mockup thread follows the project's AI usage rule, with the person's own key and the model they name", async () => {
  withAi();
  const base = `http://127.0.0.1:${endpoint.port}/v1`;
  process.env.CRITIQS_AI_ENCRYPTION_KEY = "e".repeat(44);
  process.env.CRITIQS_AI_ALLOWED_ENDPOINTS = base;
  process.env.CRITIQS_AI_LOCAL_ENDPOINTS = "enabled";
  const f = await mockupProject();
  const threadId = await f.mockupThread();
  const ask = (model?: string) =>
    f.lee.action(api.ai.mockupReply, {
      threadId,
      snapshots: [{ snapshotId: f.snapshotId, description: 'body #1\n  button #2 "Save"', complete: true }],
      continuation: false,
      ...(model === undefined ? {} : { model }),
    });
  // Each person pays, and Lee has no AI of his own: refused with a code the component can offer Your AI for.
  await f.dana.action(api.ai.saveSettings, { projectId: f.projectId, enabled: true, mode: "own", rule: "personal" });
  const refused = await ask().catch((error: unknown) => error);
  expect((refused as { data?: unknown }).data).toEqual({ code: "setup-ai", message: "Set up your AI to use this." });
  expect(prompts).toEqual([]);
  await f.lee.action(api.ai.savePersonalSettings, { enabled: true, mode: "own", provider: "compatible", model: "lee-model", models: ["lee-big"], baseUrl: base, apiKey: "lee-key-1234" });
  await ask();
  await ask("lee-big");
  expect(prompts.map((entry) => `${entry.model} ${entry.authorization}`)).toEqual(["lee-model Bearer lee-key-1234", "lee-big Bearer lee-key-1234"]);
  // A model his connection doesn't offer is refused, never swapped for another.
  await expect(ask("gpt-5")).rejects.toThrow("doesn't offer that model");
  expect(prompts).toHaveLength(2);
});
