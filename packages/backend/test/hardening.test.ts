import { afterEach, expect, spyOn, test } from "bun:test";
import type { Id } from "../convex/_generated/dataModel";
import { api, internal } from "../convex/_generated/api";
import { START_GLOBAL_LIMIT, START_ORIGIN_LIMIT, START_WINDOW_MS } from "../convex/signIn";
import { anchor, reviewer, setup } from "./harness";
import { exportAll, list, mine, pages, thread } from "./pages";

const prototype = "https://proto.example";
const page = { numItems: 2, cursor: null };
afterEach(() => { delete process.env.CRITIQS_DEV_SIGN_IN; });

test("a successful refresh atomically consumes the old token and rejects wrong origins, reuse and expiry", async () => {
  const t = setup();
  const subject = await t.run(ctx => ctx.db.insert("reviewers", { email: "dana@example.com", name: "Dana", nameVersion: 1, createdAt: Date.now() }));
  const profile = { subject: subject as string, name: "Dana", email: "dana@example.com", pictureUrl: null, profileVersion: 1 };
  const sessionId = await t.run(ctx => ctx.db.insert("sessions", {
    refreshHash: "first", origin: prototype, profile, createdAt: Date.now(), expiresAt: Date.now() + 1_000,
  }));
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "first", nextRefreshHash: "wrong", origin: "https://other.example" })).toBeNull();
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "first", nextRefreshHash: "second", origin: prototype })).toMatchObject({ profile });
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "second", nextRefreshHash: "third", origin: prototype })).toMatchObject({ profile });
  await t.run(ctx => ctx.db.patch(sessionId, { expiresAt: Date.now() - 1 }));
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "third", nextRefreshHash: "expired", origin: prototype })).toBeNull();
  // Reusing a replaced token ends the session, even for the token that replaced it.
  await t.run(ctx => ctx.db.insert("sessions", { refreshHash: "fourth", origin: prototype, profile, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "fourth", nextRefreshHash: "fifth", origin: prototype })).toMatchObject({ profile });
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "fourth", nextRefreshHash: "reused", origin: prototype })).toBeNull();
  expect(await t.mutation(internal.signIn.refreshSession, { refreshHash: "fifth", nextRefreshHash: "sixth", origin: prototype })).toBeNull();
});

test("a replaced token is remembered while its session can live, so clean-up never strands a repeat or hides reuse", async () => {
  const t = setup();
  const day = 24 * 60 * 60 * 1000;
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const subject = await t.run(ctx => ctx.db.insert("reviewers", { email: "dana@example.com", name: "Dana", nameVersion: 1, createdAt: now }));
    const profile = { subject: subject as string, name: "Dana", email: "dana@example.com", pictureUrl: null, profileVersion: 1 };
    await t.run(ctx => ctx.db.insert("sessions", { refreshHash: "first", origin: prototype, profile, createdAt: now, expiresAt: now + 30 * day, endsAt: now + 90 * day }));
    const refresh = (refreshHash: string, nextRefreshHash: string) => t.mutation(internal.signIn.refreshSession, { refreshHash, nextRefreshHash, origin: prototype });
    // Day 0: the answer is lost. Day 29: the repeat's answer is lost too, but it keeps the session alive.
    expect(await refresh("first", "second")).toMatchObject({ profile });
    now += 29 * day;
    expect(await refresh("first", "second")).toMatchObject({ profile });
    // Day 31: clean-up runs, then the page comes back and repeats the refresh once more.
    now += 2 * day;
    await t.mutation(internal.signIn.cleanUp, {});
    expect(await refresh("first", "second")).toMatchObject({ profile });
    // And reuse of the replaced token is still recognized after clean-up.
    expect(await refresh("second", "third")).toMatchObject({ profile });
    now += 2 * day;
    await t.mutation(internal.signIn.cleanUp, {});
    expect(await refresh("first", "stolen")).toBeNull();
    expect(await refresh("third", "fourth")).toBeNull();
  } finally { clock.mockRestore(); }
});

test("sign-in start counts origin and deployment limits, resets a window and stores no rejected attempt", async () => {
  const t = setup();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const start = (key: string, origin = prototype) => t.mutation(internal.signIn.startAttempt, {
    key, origin, clientState: "state", bindingHash: "binding",
  });
  try {
    for (let i = 0; i < START_ORIGIN_LIMIT; i++) expect((await start(String(i))).allowed).toBe(true);
    expect(await start("blocked")).toEqual({ allowed: false, retryAfter: 60, scope: "origin" });
    expect(await t.run(ctx => ctx.db.query("signInAttempts").withIndex("by_key", q => q.eq("key", "blocked")).unique())).toBeNull();
    for (let i = START_ORIGIN_LIMIT; i < START_GLOBAL_LIMIT; i++) await start(String(i), `https://site-${i}.example`);
    expect(await start("global-blocked", "https://new.example")).toMatchObject({ allowed: false, scope: "global" });
    now += START_WINDOW_MS;
    expect((await start("new-window")).allowed).toBe(true);
  } finally { clock.mockRestore(); }
});

test("HTTP sign-in limiting returns retry guidance and ignores spoofed IP headers", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "http://127.0.0.1:3211";
  process.env.CRITIQS_DEV_SIGN_IN = "enabled";
  const key = process.env.CRITIQS_AUTH_PRIVATE_KEY;
  process.env.CRITIQS_AUTH_PRIVATE_KEY ??= "{}";
  const t = setup();
  for (let i = 0; i < START_ORIGIN_LIMIT; i++) {
    const response = await t.fetch(`/auth/start?origin=${encodeURIComponent(prototype)}&state=${i}`, {
      headers: { "X-Forwarded-For": `192.0.2.${i}` },
    });
    expect(response.status).toBe(200);
  }
  const response = await t.fetch(`/auth/start?origin=${encodeURIComponent(prototype)}&state=blocked`, {
    headers: { "X-Forwarded-For": "192.0.2.250" },
  });
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  if (key === undefined) delete process.env.CRITIQS_AUTH_PRIVATE_KEY;
});

test("long projects/discussions/reactions/export paginate without losing access, read state or history", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projects = [];
  for (let i = 0; i < 5; i++) projects.push(await dana.mutation(api.projects.create, { name: `Prototype ${i}` }));
  const projectId = projects[0]!;
  const ids: Id<"threads">[] = [];
  for (let i = 0; i < 5; i++) ids.push(await dana.mutation(api.threads.create, {
    projectId, anchor, body: `Initial ${i}`, tags: [], capture: { status: "failed", failureReason: "Unavailable" },
  }));
  const threadId = ids[0]!;
  for (let i = 0; i < 5; i++) await lee.mutation(api.threads.reply, { threadId, body: `Reply ${i}`, revision: `v${i}` });
  await dana.mutation(api.threads.setStatus, { threadId: ids[1]!, status: "resolved" });
  await dana.mutation(api.threads.remove, { threadId: ids[2]! });
  expect(await mine(dana)).toHaveLength(5);
  expect(await mine(lee)).toHaveLength(0);
  expect((await pages(lee, api.threads.list, { projectId })).length).toBeGreaterThan(1);
  const summaries = await list(lee, { projectId });
  expect(summaries).toHaveLength(4);
  expect(summaries.find(row => row._id === ids[1])?.status).toBe("resolved");
  expect(summaries.every(row => row.unread)).toBe(true);
  const discussion = await thread(lee, { threadId });
  expect(discussion.messages.map(row => row.body)).toEqual(["Initial 0", ...Array.from({ length: 5 }, (_, i) => `Reply ${i}`)]);
  expect(discussion.messages.at(-1)?.revision).toBe("v4");
  for (let i = 0; i < 5; i++) {
    const user = t.withIdentity(reviewer(`Person${i}`));
    await user.mutation(api.threads.toggleReaction, { messageId: discussion.messages[0]!._id as Id<"messages">, emoji: "👍" });
  }
  expect((await pages(dana, api.threads.listReactions, { threadId })).length).toBe(3);
  expect((await thread(dana, { threadId })).messages[0]?.reactions).toEqual([{ emoji: "👍", count: 5, mine: false }]);
  const exported = await exportAll(lee, { projectId, threadIds: ids });
  expect(exported.threads).toHaveLength(4);
  expect(exported.threads.find(row => row._id === threadId)?.messages.map(row => row.body)).toEqual(discussion.messages.map(row => row.body));
  await lee.mutation(api.threads.markRead, { threadId, seenThrough: discussion.messages[1]!.createdAt });
  expect((await list(lee, { projectId })).find(row => row._id === threadId)?.unread).toBe(true);
  expect((await thread(lee, { threadId })).messages.at(-1)?._id).toBe(discussion.messages.at(-1)?._id);
  await expect(t.query(api.threads.list, { projectId, paginationOpts: page })).rejects.toThrow("Sign in");
  await expect(dana.query(api.threads.list, { projectId, paginationOpts: { numItems: 41, cursor: null } })).rejects.toThrow("40");
  await expect(dana.query(api.threads.get, { threadId, paginationOpts: { numItems: 1, cursor: "invalid" } })).rejects.toThrow();
});

test("bounded cleanup removes obsolete rate-limit counters beyond a batch", async () => {
  const t = setup();
  await t.run(async ctx => {
    for (let i = 0; i < 510; i++) await ctx.db.insert("signInLimits", { key: `old:${i}`, count: 1, expiresAt: Date.now() - 1 });
    await ctx.db.insert("signInLimits", { key: "live", count: 1, expiresAt: Date.now() + 60_000 });
  });
  await t.mutation(internal.signIn.cleanUp, {});
  await t.finishAllScheduledFunctions(() => {});
  const rows = await t.run(ctx => ctx.db.query("signInLimits").collect());
  expect(rows.map(row => row.key)).toEqual(["live"]);
});
