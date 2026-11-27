import { expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup, upload } from "./harness";

// Thread pages on Convex: the functions and the capture route a thread page
// uses, on top of the shared contract every backend passes.

const page = { numItems: 40, cursor: null };
const NOTHING = "This thread doesn't exist, or you can't open it.";

/**
 * Dana's captured thread in a project anyone may review: Lee replied, Riley
 * joined Dana's organization by invite, and Sam signed in but is neither.
 */
async function pagedThread() {
  const t = setup();
  const [dana, lee, riley, sam] = ["Dana", "Lee", "Riley", "Sam"].map((name) => t.withIdentity(reviewer(name)));
  const projectId = await dana!.mutation(api.projects.create, { name: "Pilot", reviewUrl: "https://proto.example/app" });
  const threadId = await dana!.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Spacing",
    tags: [],
    capture: { status: "captured", storageId: await upload(dana!, projectId, "png-bytes") },
  });
  await lee!.mutation(api.threads.reply, { threadId, body: "Agreed", revision: null });
  const [organization] = await dana!.query(api.organizations.mine, {});
  await dana!.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley!.mutation(api.users.sync, {});
  await sam!.mutation(api.users.sync, {});
  const key = await dana!.mutation(api.threads.pageKey, { threadId });
  return { t, dana: dana!, lee: lee!, riley: riley!, sam: sam!, projectId, threadId, organizationId: organization!.id, key };
}

/** What an attempt came to: "allowed", or its refusal's message. */
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "allowed";
  } catch (error) {
    const data = (error as { data?: { message?: string } }).data;
    return data?.message ?? (error as Error).message;
  }
}

test("a thread page opens through threads:page for the organization and the people in the thread, and nobody else", async () => {
  const f = await pagedThread();
  const shown = await f.riley.query(api.threads.page, { key: f.key, paginationOpts: page });
  expect(shown).toMatchObject({
    _id: f.threadId,
    project: { name: "Pilot", reviewUrl: "https://proto.example/app" },
    prototype: { pageUrl: anchor.evidence.url, screen: anchor.screen },
    capture: { status: "captured" },
  });
  expect(shown.page.map((message) => message.body)).toEqual(["Spacing", "Agreed"]);
  for (const who of [f.dana, f.lee]) expect(await outcome(who.query(api.threads.page, { key: f.key, paginationOpts: page }))).toBe("allowed");
  for (const who of [f.sam, f.t]) expect(await outcome(who.query(api.threads.page, { key: f.key, paginationOpts: page }))).toBe(NOTHING);
  expect(await outcome(f.dana.query(api.threads.page, { key: "AAAAAAAAAAAAAAAAAAAAAA", paginationOpts: page }))).toBe(NOTHING);
  expect(await outcome(f.dana.query(api.threads.page, { key: f.threadId, paginationOpts: page }))).toBe(NOTHING);
});

test("a thread page's image is served by its key only to those who may open the page, with the same refusal as no page", async () => {
  const f = await pagedThread();
  const path = `/capture?threadPage=${f.key}`;
  const member = await f.riley.fetch(path);
  expect(member.status).toBe(200);
  expect(await member.text()).toBe("png-bytes");
  expect(member.headers.get("Content-Security-Policy")).toContain("sandbox");
  for (const [who, at] of [[f.sam, path], [f.t, path], [f.dana, "/capture?threadPage=AAAAAAAAAAAAAAAAAAAAAA"]] as const) {
    const response = await who.fetch(at);
    expect([response.status, await response.text()]).toEqual([404, NOTHING]);
  }
  // Once Riley leaves the organization, the page and its image are closed to her.
  const rileyId = (await f.t.run((ctx) => ctx.db.query("users").collect())).find((user) => user.name === "Riley")!._id;
  await f.dana.mutation(api.organizations.removeMember, { organizationId: f.organizationId, userId: rileyId });
  expect((await f.riley.fetch(path)).status).toBe(404);
  await f.dana.mutation(api.threads.remove, { threadId: f.threadId as Id<"threads"> });
  const deleted = await f.dana.fetch(path);
  expect([deleted.status, await deleted.text()]).toEqual([404, "This thread was deleted."]);
});

test("replies from a thread page go through threads:reply with threadPage and follow the page's rule", async () => {
  const f = await pagedThread();
  const fromPage = (who: typeof f.lee, body: string) => who.mutation(api.threads.reply, { threadId: f.threadId, body, revision: null, threadPage: true });
  expect(await outcome(fromPage(f.riley, "From Riley"))).toBe("allowed");
  expect(await outcome(fromPage(f.sam, "From Sam"))).toBe(NOTHING);
  const thread = await f.dana.query(api.threads.get, { threadId: f.threadId, paginationOpts: page });
  expect(thread.page.map((message) => message.body)).toEqual(["Spacing", "Agreed", "From Riley"]);
});


test("a large thread from before people in threads were recorded answers within Convex's limits: the same refusal for outsiders, and its people once recorded", async () => {
  const t = setup({ limits: true });
  const [dana, lee, sam] = ["Dana", "Lee", "Sam"].map((name) => t.withIdentity(reviewer(name)));
  const projectId = await dana!.mutation(api.projects.create, { name: "Pilot" });
  for (const who of [lee!, sam!]) await who.mutation(api.users.sync, {});
  const users = await t.run((ctx) => ctx.db.query("users").collect());
  const idOf = (name: string) => users.find((user) => user.name === name)!._id;
  // As an older Critiqs stored it: no followers and no page key, with 500 of the longest comments (three bytes a
  // character), each mentioning the most people with the longest names: more than one Convex transaction may read.
  const body = "€".repeat(10_000);
  const mentioned = await t.run(async (ctx) => {
    const ids = [];
    for (let n = 0; n < 20; n++) ids.push(await ctx.db.insert("users", { tokenIdentifier: `https://auth.example|m${n}`, name: `M${n}`, email: `m${n}@example.com`, imageUrl: null }));
    return ids;
  });
  const mentions = mentioned.map((userId) => ({ userId, label: "€".repeat(80) }));
  const threadId = await t.run((ctx) =>
    ctx.db.insert("threads", { projectId, status: "open", anchor, tags: [], capture: { status: "failed", failureReason: "x" }, createdBy: idOf("Dana"), createdAt: 1, lastMessageAt: 500, messageCount: 500 }),
  );
  for (let batch = 0; batch < 500; batch += 25) {
    await t.run(async (ctx) => {
      for (let at = batch + 1; at <= batch + 25; at++) {
        await ctx.db.insert("messages", { threadId, authorId: idOf(at === 1 ? "Lee" : "Dana"), body, mentions, createdAt: at, editedAt: null, revision: null });
      }
    });
  }
  const key = await dana!.mutation(api.threads.pageKey, { threadId });
  const open = (who: typeof dana) => outcome(who!.query(api.threads.page, { key, paginationOpts: { numItems: 10, cursor: null } }));
  for (const at of [key, "AAAAAAAAAAAAAAAAAAAAAA"]) {
    expect(await outcome(sam!.query(api.threads.page, { key: at, paginationOpts: { numItems: 10, cursor: null } }))).toBe(NOTHING);
    const image = await sam!.fetch(`/capture?threadPage=${at}`);
    expect([image.status, await image.text()]).toEqual([404, NOTHING]);
  }
  expect(await open(dana)).toBe("allowed");
  // Lee wrote the first message; the email worker records that, a page at a time, before Lee gets in.
  expect(await open(lee)).toBe(NOTHING);
  for (let step = 0; step < 100 && (await t.mutation(internal.notifications.replyEmailStep, {})); step++);
  expect(await open(lee)).toBe("allowed");
  expect(await open(sam)).toBe(NOTHING);
  expect(await t.run((ctx) => ctx.db.query("deliveries").collect())).toEqual([]);
}, 60_000);

test("/critiqs/config reports the website for thread page links only where CRITIQS_WEB_URL names one", async () => {
  const t = setup();
  const config = async () => (await (await t.fetch("/critiqs/config")).json()) as { threadPages?: boolean; website?: string };
  process.env.CRITIQS_AUTH_ISSUER = "https://critiqs-auth.example";
  try {
    delete process.env.CRITIQS_WEB_URL;
    expect(await config()).toMatchObject({ threadPages: true });
    expect((await config()).website).toBeUndefined();
    // Not an address the website could be at: plain HTTP away from this computer.
    process.env.CRITIQS_WEB_URL = "http://critiqs.example";
    expect((await config()).website).toBeUndefined();
    // The website serves thread pages at /t/ on its own origin; under a path, the link would open onboarding instead.
    process.env.CRITIQS_WEB_URL = "https://critiqs.example/reviews";
    expect((await config()).website).toBeUndefined();
    process.env.CRITIQS_WEB_URL = "https://critiqs.example/";
    expect((await config()).website).toBe("https://critiqs.example");
  } finally {
    delete process.env.CRITIQS_WEB_URL;
    delete process.env.CRITIQS_AUTH_ISSUER;
  }
});

test("a thread page's image can be asked for with its key in a header, keeping the key out of the address", async () => {
  const f = await pagedThread();
  const preflight = await f.t.fetch("/capture", { method: "OPTIONS", headers: { Origin: "https://critiqs.example", "Access-Control-Request-Headers": "authorization, x-critiqs-thread-page" } });
  expect(preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("x-critiqs-thread-page");
  const image = await f.riley.fetch("/capture", { headers: { "X-Critiqs-Thread-Page": f.key } });
  expect(image.status).toBe(200);
  expect(await image.text()).toBe("png-bytes");
  // Outsiders, and someone signed out, get the same refusal as for no page.
  for (const who of [f.sam, f.t]) expect((await who.fetch("/capture", { headers: { "X-Critiqs-Thread-Page": f.key } })).status).toBe(404);
});

test("a thread page carries the thread's linked tickets to those who may open it, and nothing to anyone else", async () => {
  const f = await pagedThread();
  await f.t.run(async (ctx) => {
    const linkedBy = (await ctx.db.query("users").collect())[0]!._id;
    const base = { projectId: f.projectId, threadId: f.threadId, linkedBy, linkedAt: 1, createdFromCritiqs: true };
    await ctx.db.insert("ticketLinks", { ...base, state: "linked", tracker: "linear", externalId: "issue-1", key: "ENG-12", url: "https://linear.app/acme/issue/ENG-12", title: "Spacing", status: { label: "In Progress", category: "started" } });
    await ctx.db.insert("ticketLinks", { ...base, state: "pending", tracker: "github", externalId: "n1", key: "acme/web#9", url: "https://github.com/acme/web/issues/9", title: "Pending" });
  });
  const shown = await f.riley.query(api.threads.page, { key: f.key, paginationOpts: page });
  expect(shown.tickets?.map((ticket) => [ticket.tracker, ticket.key, ticket.status?.label, ticket.url])).toEqual([["linear", "ENG-12", "In Progress", "https://linear.app/acme/issue/ENG-12"]]);
  expect(await outcome(f.sam.query(api.threads.page, { key: f.key, paginationOpts: page }))).toBe(NOTHING);
});
