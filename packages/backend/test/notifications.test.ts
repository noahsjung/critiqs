import { afterEach, expect, spyOn, test } from "bun:test";
import { GATHER_MS } from "@critiqs/server";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup, upload } from "./harness";

const failed = { status: "failed" as const, failureReason: "Blocked" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.CRITIQS_EMAIL_FROM;
  delete process.env.CONVEX_SITE_URL;
  delete process.env.CRITIQS_WEB_URL;
});

/** Captures Resend requests, answering with `status`. */
function resend(status = 200) {
  const sent: any[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://api.resend.com/")) {
      const raw = await new Response(init?.body).text();
      sent.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(raw), raw });
      return status === 200 ? Response.json({ id: "email" }) : new Response("no", { status });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
  return sent;
}

async function mentionLee() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review", reviewUrl: "https://proto.example/" });
  const threadId = await dana.mutation(api.threads.create, { projectId, anchor, body: "Look", tags: [], capture: failed });
  // Only the mention is emailed here; reply emails have their own tests.
  await dana.mutation(api.notifications.setSettings, { projectId, replyEmails: false });
  await lee.mutation(api.threads.reply, { threadId, body: "Hi", revision: null });
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  await dana.mutation(api.threads.reply, {
    threadId,
    body: "@Lee can you check?",
    revision: null,
    mentions: [{ userId: leeId as Id<"users">, label: "Lee" }],
  });
  return { t, dana, lee, projectId, threadId };
}

test("the worker emails a mentioned reviewer through Resend once the gathering pause ends", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  const sent = resend();
  const { t, threadId } = await mentionLee();
  await t.action(internal.notificationEmails.deliver, {});
  expect(sent).toHaveLength(0);

  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  const [mail] = sent;
  expect(mail.headers.authorization).toBe("Bearer re_key");
  const [delivery] = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(mail.headers["idempotency-key"]).toBe(`critiqs-mention:${delivery!._id}`);
  expect(delivery).toMatchObject({ status: "sent" });
  expect(mail.body).toMatchObject({ to: ["lee@example.com"], subject: "Dana mentioned you: “Look” · Pilot review" });
  // The review address, not the page the comment was left on.
  expect(mail.body.text).toContain(`https://proto.example/?critiqs=${threadId}.`);
  expect(mail.body.text).not.toContain("/users/alex");
  expect(mail.body.text).toContain("https://backend.example.site/notifications/preferences?token=");
  // The whole discussion, including the comments that don't mention Lee.
  expect(mail.body.text).toMatch(/Dana · .* UTC\nLook[\s\S]*Lee · .* UTC\nHi[\s\S]*Dana · .* UTC · mentions you\n@Lee can you check\?/);
  expect(mail.body.attachments).toBeUndefined();
});

const realNow = Date.now;

test("with CRITIQS_WEB_URL, mention and reply emails link to the thread's page, an older thread's made as it is emailed", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  process.env.CRITIQS_WEB_URL = "https://critiqs.example/";
  const sent = resend();
  const { t, dana, lee, projectId, threadId } = await mentionLee();
  // An older thread, from before page keys, where Dana's reply mentions Lee and Lee gets the reply too.
  const older = await dana.mutation(api.threads.create, { projectId, anchor, body: "Older", tags: [], capture: failed });
  await lee.mutation(api.threads.reply, { threadId: older, body: "Mine too", revision: null });
  await t.run(async (ctx) => ctx.db.patch(older, { pageKey: undefined }));
  await dana.mutation(api.threads.reply, { threadId: older, body: "Still?", revision: null });
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(2);
  const keys = await t.run(async (ctx) => Object.fromEntries((await ctx.db.query("threads").collect()).map((thread) => [thread._id, thread.pageKey])));
  expect(keys[older]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const subjects = sent.map((mail) => mail.body.subject).sort();
  expect(subjects).toEqual(["Dana mentioned you: “Look” · Pilot review", "Dana replied: “Older” · Pilot review"]);
  for (const mail of sent) {
    const thread = mail.body.subject.startsWith("Dana mentioned") ? threadId : older;
    expect(mail.body.text).toContain(`Open the comment: https://critiqs.example/t/${keys[thread]}\n`);
    expect(mail.body.html).toContain(`href="https://critiqs.example/t/${keys[thread]}"`);
    expect(mail.raw).not.toContain("critiqs=");
    expect(mail.raw).not.toContain(thread);
  }
  // The key Share gives is the one emailed.
  expect(await dana.mutation(api.threads.pageKey, { threadId: older })).toBe(keys[older]!);
});

test("without CRITIQS_WEB_URL, emails link to the prototype and an older thread gets no page key", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const sent = resend();
  const { t, threadId } = await mentionLee();
  await t.run(async (ctx) => ctx.db.patch(threadId, { pageKey: undefined }));
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  expect(sent[0].body.text).toContain(`https://proto.example/?critiqs=${threadId}.`);
  expect(sent[0].raw).not.toContain("/t/");
  expect(await t.run(async (ctx) => "pageKey" in (await ctx.db.get(threadId))!)).toBe(false);
});

test("without an email key, owed emails are skipped rather than kept waiting", async () => {
  const sent = resend();
  const { t } = await mentionLee();
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(0);
  const rows = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(rows.map((row) => [row.status, row.reason])).toEqual([["skipped", "Email isn't set up for this deployment."]]);
});

test("a failed send is retried later", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const sent = resend(503);
  const { t } = await mentionLee();
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  const [row] = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(row).toMatchObject({ status: "pending", attempts: 1 });
  expect(row!.dueAt).toBeGreaterThan(realNow() + GATHER_MS + 60_000);
});

test("a mute link asks for confirmation, then mutes only that project", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  const sent = resend();
  const { t, lee, projectId } = await mentionLee();
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  const mute = /Mute Pilot review: (\S+)/.exec(sent[0].body.text)![1]!;
  const path = new URL(mute).pathname + new URL(mute).search;
  const confirm = await t.fetch(path);
  expect(await confirm.text()).toContain("Mute emails from this project?");
  // Opening the link changes nothing.
  expect(await lee.query(api.notifications.settings, { projectId })).toEqual({ mentionEmails: true, replyEmails: true, projectMuted: false });
  const token = new URL(mute).searchParams.get("token")!;
  const done = await t.fetch("/notifications/preferences", { method: "POST", body: new URLSearchParams({ token }).toString() });
  expect(done.status).toBe(200);
  expect(await lee.query(api.notifications.settings, { projectId })).toEqual({ mentionEmails: true, replyEmails: true, projectMuted: true });
  const forged = await t.fetch("/notifications/preferences", { method: "POST", body: new URLSearchParams({ token: `${token}x` }).toString() });
  expect(await forged.text()).toContain("Link not recognized");
});

test("existing commenters can be made mentionable by the participant backfill", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review" });
  await dana.mutation(api.threads.create, { projectId, anchor, body: "Look", tags: [], capture: failed });
  // As before mentions existed: no participant records.
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("participants").collect()) await ctx.db.delete(row._id);
  });
  const lee = t.withIdentity(reviewer("Lee"));
  expect(await lee.query(api.projects.participants, { projectId, query: "" })).toEqual([]);
  await t.mutation(internal.notifications.backfillParticipants, {});
  expect((await lee.query(api.projects.participants, { projectId, query: "" })).map((person) => person.name)).toEqual(["Dana"]);
});

/** Lee mentioned in Dana's captured thread; returns the email Resend received. */
async function captureEmail(prepare: (t: ReturnType<typeof setup>, storageId: Id<"_storage">) => Promise<void> = async () => {}) {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const sent = resend();
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review", reviewUrl: "https://proto.example/" });
  await lee.mutation(api.threads.create, { projectId, anchor, body: "Hi", tags: [], capture: failed });
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
  const storageId = await upload(dana, projectId, png);
  await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "@Lee spacing",
    tags: [],
    capture: { status: "captured", storageId },
    mentions: [{ userId: leeId as Id<"users">, label: "Lee" }],
  });
  await prepare(t, storageId);
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  return { mail: sent[0].body, png, storageId };
}

test("a mention email attaches the thread's capture inline from storage, never a storage link", async () => {
  const { mail, png } = await captureEmail();
  expect(mail.attachments).toEqual([
    { filename: "capture.png", content: btoa(String.fromCharCode(...png)), content_type: "image/png", content_id: "critiqs-capture" },
  ]);
  expect(mail.html).toContain(`<img src="cid:critiqs-capture"`);
  expect(mail.html).not.toContain("/api/storage");
});

test("a mention email whose capture is gone from storage says so instead of showing a broken image", async () => {
  const { mail } = await captureEmail(async (t, storageId) => await t.run((ctx) => ctx.storage.delete(storageId)));
  expect(mail.attachments).toBeUndefined();
  expect(mail.html).not.toContain("cid:");
  expect(mail.html).toContain("The capture for this thread is no longer available.");
});

test("a retry after the capture is gone sends the identical request, capture included", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review" });
  await lee.mutation(api.threads.create, { projectId, anchor, body: "Hi", tags: [], capture: failed });
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  const storageId = await upload(dana, projectId, new Uint8Array([137, 80, 78, 71, 1]));
  await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "@Lee spacing",
    tags: [],
    capture: { status: "captured", storageId },
    mentions: [{ userId: leeId as Id<"users">, label: "Lee" }],
  });
  const at = (offset: number) => spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const failing = resend(503);
  let clock = at(GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(failing[0].body.attachments).toHaveLength(1);
  await t.run((ctx) => ctx.storage.delete(storageId));
  const sent = resend();
  clock = at(GATHER_MS + 60 * 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  expect(sent[0].headers["idempotency-key"]).toBe(failing[0].headers["idempotency-key"]);
  expect(sent[0].raw).toBe(failing[0].raw);
  expect(sent[0].body.attachments).toHaveLength(1);
});

test("a discussion larger than one transaction may read is still emailed whole, within Convex's limits", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const sent = resend();
  const t = setup({ limits: true });
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review", reviewUrl: "https://proto.example/" });
  const threadId = await dana.mutation(api.threads.create, { projectId, anchor, body: "Look", tags: [], capture: failed });
  await dana.mutation(api.notifications.setSettings, { projectId, replyEmails: false });
  await lee.mutation(api.threads.reply, { threadId, body: "Hi", revision: null });
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  // 20 replies whose revision labels are 900,000 characters each: 18 MB of messages, more than one transaction may read.
  const revision = "r".repeat(900_000);
  for (let i = 0; i < 19; i++) await dana.mutation(api.threads.reply, { threadId, body: `Reply ${i}`, revision });
  await dana.mutation(api.threads.reply, {
    threadId,
    body: "@Lee last one",
    revision,
    mentions: [{ userId: leeId as Id<"users">, label: "Lee" }],
  });
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  for (let i = 0; i < 19; i++) expect(sent[0].body.text).toContain(`Reply ${i}\n`);
  expect(sent[0].body.text).toContain("@Lee last one");
  expect(sent[0].body.text).toContain("Thread (22 comments)");
  const [delivery] = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(delivery).toMatchObject({ status: "sent" });
});

/** A thread in a project with a 900,000-character name, or with a capture, and `count` comments of 10,000 characters ending in a mention of Lee. */
async function longMention(options: { projectName: string; count: number; capture?: Uint8Array }) {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const sent = resend();
  const t = setup({ limits: true });
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: options.projectName, reviewUrl: "https://proto.example/" });
  await lee.mutation(api.threads.create, { projectId, anchor, body: "Hi", tags: [], capture: failed });
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  const storageId =
    options.capture === undefined ? null : await upload(dana, projectId, options.capture as Uint8Array<ArrayBuffer>);
  const body = (i: number) => `#${i}#`.padEnd(10_000, "<");
  const threadId = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: body(0),
    tags: [],
    capture: storageId === null ? failed : { status: "captured", storageId },
  });
  for (let i = 1; i < options.count - 1; i++) await dana.mutation(api.threads.reply, { threadId, body: body(i), revision: null });
  await dana.mutation(api.threads.reply, {
    threadId,
    body: `@Lee ${body(options.count - 1)}`.slice(0, 10_000),
    revision: null,
    mentions: [{ userId: leeId as Id<"users">, label: "Lee" }],
  });
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  return { t, sent };
}

test("a project with a 900,000-character name still gets its 400-comment email, the name shortened", async () => {
  const { t, sent } = await longMention({ projectName: "<".repeat(900_000), count: 400 });
  expect(sent).toHaveLength(1);
  expect((sent[0].body.html.match(/Open this comment/g) ?? []).length).toBe(400);
  expect(sent[0].body.html).toContain(`${"&lt;".repeat(199)}…`);
  expect(sent[0].raw.length).toBeLessThanOrEqual(40_000_000);
  const [delivery] = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(delivery).toMatchObject({ status: "sent" });
}, 120_000);

test("320 long comments and a 10 MiB capture go out in one email with the capture attached", async () => {
  const capture = new Uint8Array(10 * 1024 * 1024);
  capture.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { sent } = await longMention({ projectName: "Pilot review", count: 320, capture });
  expect(sent).toHaveLength(1);
  expect((sent[0].body.html.match(/Open this comment/g) ?? []).length).toBe(320);
  expect(sent[0].body.attachments).toHaveLength(1);
  expect(sent[0].body.attachments[0].content.length).toBe(Math.ceil(capture.length / 3) * 4);
  expect(sent[0].raw.length).toBeLessThanOrEqual(40_000_000);
}, 120_000);

test("461 long comments and a 10 MiB capture, near the limit, still go out with the capture attached", async () => {
  const capture = new Uint8Array(10 * 1024 * 1024);
  capture.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { t, sent } = await longMention({ projectName: "Pilot review", count: 461, capture });
  expect(sent).toHaveLength(1);
  const { body, raw } = sent[0];
  expect((body.html.match(/Open this comment/g) ?? []).length).toBe(461);
  expect(body.attachments).toHaveLength(1);
  expect(body.attachments[0].content.length).toBe(Math.ceil(capture.length / 3) * 4);
  expect(body.html).not.toContain("The capture isn't included");
  expect(raw.length).toBeLessThanOrEqual(40_000_000);
  // As the mail service builds it: every part Base64 in 76-character lines, plus room for headers.
  const mime = (bytes: number) => Math.ceil(bytes / 3) * 4 + 2 * Math.ceil((Math.ceil(bytes / 3) * 4) / 76);
  const utf8 = (text: string) => new TextEncoder().encode(text).length;
  expect(mime(utf8(body.html)) + mime(utf8(body.text)) + mime(capture.length) + 16 * 1024).toBeLessThanOrEqual(40_000_000);
  const [delivery] = await t.run((ctx) => ctx.db.query("deliveries").collect());
  expect(delivery).toMatchObject({ status: "sent" });
}, 120_000);

test("with CRITIQS_WEB_URL, a full batch of emails about large threads is claimed and sent within Convex's limits", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  process.env.CRITIQS_WEB_URL = "https://critiqs.example";
  const sent = resend();
  const t = setup({ limits: true });
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review", reviewUrl: "https://proto.example/" });
  await lee.mutation(api.threads.create, { projectId, anchor, body: "Hi", tags: [], capture: failed });
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  // 25 threads, one worker batch, each saved with a view state near 1 MB: together more than one transaction may read.
  const large = { ...anchor, viewState: { note: "x".repeat(920_000) } };
  for (let i = 0; i < 25; i++) {
    await dana.mutation(api.threads.create, { projectId, anchor: large, body: `@Lee ${i}`, tags: [], capture: failed, mentions: [{ userId: leeId as Id<"users">, label: "Lee" }] });
  }
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(25);
  for (const mail of sent) expect(mail.body.text).toMatch(/Open the comment: https:\/\/critiqs\.example\/t\/[A-Za-z0-9_-]{22}\n/);
}, 60_000);

test("with CRITIQS_WEB_URL, an email about a thread from before its people were recorded waits a minute for them, without using an attempt", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  process.env.CRITIQS_WEB_URL = "https://critiqs.example";
  const sent = resend();
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review", reviewUrl: "https://proto.example/" });
  await lee.mutation(api.threads.create, { projectId, anchor, body: "Hi", tags: [], capture: failed });
  const start = realNow();
  // Saved before page keys and before people in threads were recorded, with an email to Lee still owed on its last attempt.
  const { threadId, deliveryId } = await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const danaId = users.find((user) => user.name === "Dana")!._id;
    const leeId = users.find((user) => user.name === "Lee")!._id;
    const at = start - 60_000;
    const threadId = await ctx.db.insert("threads", { projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: at, lastMessageAt: at, messageCount: 1 });
    const messageId = await ctx.db.insert("messages", { threadId, authorId: danaId, body: "@Lee old question", createdAt: at, editedAt: null, revision: null, mentions: [{ userId: leeId, label: "Lee" }] });
    const deliveryId = await ctx.db.insert("deliveries", { recipientId: leeId, projectId, threadId, status: "pending", attempts: 5, dueAt: at, createdAt: at });
    await ctx.db.insert("notifications", { deliveryId, recipientId: leeId, messageId, authorId: danaId, createdAt: at });
    return { threadId, deliveryId };
  });
  await t.action(internal.notificationEmails.deliver, {});
  expect(sent).toHaveLength(0);
  const waiting = await t.run(async (ctx) => await ctx.db.get(deliveryId));
  expect(waiting).toMatchObject({ status: "pending", attempts: 5 });
  expect(waiting!.dueAt).toBeLessThanOrEqual(realNow() + 60_000);
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  expect(sent).toHaveLength(1);
  const key = await t.run(async (ctx) => (await ctx.db.get(threadId))!.pageKey);
  expect(sent[0].body.text).toContain(`Open the comment: https://critiqs.example/t/${key}\n`);
});

test("a deferred email is given back at once, not after the rest of its batch, so a slow send can't let another worker use up its attempts", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  process.env.CRITIQS_WEB_URL = "https://critiqs.example";
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot review", reviewUrl: "https://proto.example/" });
  await lee.mutation(api.threads.create, { projectId, anchor, body: "Hi", tags: [], capture: failed });
  const start = realNow();
  // Due first: an email about a thread whose people aren't recorded yet, which waits.
  const waitingId = await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const danaId = users.find((user) => user.name === "Dana")!._id;
    const leeId = users.find((user) => user.name === "Lee")!._id;
    const at = start - 120_000;
    const threadId = await ctx.db.insert("threads", { projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: at, lastMessageAt: at, messageCount: 1 });
    const messageId = await ctx.db.insert("messages", { threadId, authorId: danaId, body: "@Lee old question", createdAt: at, editedAt: null, revision: null, mentions: [{ userId: leeId, label: "Lee" }] });
    const deliveryId = await ctx.db.insert("deliveries", { recipientId: leeId, projectId, threadId, status: "pending", attempts: 5, dueAt: at, createdAt: at });
    await ctx.db.insert("notifications", { deliveryId, recipientId: leeId, messageId, authorId: danaId, createdAt: at });
    return deliveryId;
  });
  // Then an ordinary mention in the same batch, whose send is where the batch is slow.
  const [leeId] = (await dana.query(api.projects.participants, { projectId, query: "lee" })).map((person) => person._id);
  await dana.mutation(api.threads.create, { projectId, anchor, body: "@Lee now", tags: [], capture: failed, mentions: [{ userId: leeId as Id<"users">, label: "Lee" }] });
  const seenDuringSend: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://api.resend.com/")) {
      seenDuringSend.push(await t.run(async (ctx) => (await ctx.db.get(waitingId))!.status));
      return Response.json({ id: "email" });
    }
    return realFetch(input as Request, init);
  }) as typeof fetch;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + GATHER_MS + 60_000);
  try {
    await t.action(internal.notificationEmails.deliver, {});
  } finally {
    clock.mockRestore();
  }
  // While the other email was still being sent, the waiting one was already back in line, with its attempt given back.
  expect(seenDuringSend).toEqual(["pending"]);
  expect(await t.run(async (ctx) => await ctx.db.get(waitingId))).toMatchObject({ status: "pending", attempts: 5 });
});
