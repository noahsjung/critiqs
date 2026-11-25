import { afterEach, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES } from "@critiqs/server";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup } from "./harness";
import { captureProvider, r2Config, r2Storage } from "../convex/lib/r2";
import { readCaptureBody } from "../convex/captureHttp";

const keys = ["CRITIQS_CAPTURE_STORAGE", "CRITIQS_R2_ACCOUNT_ID", "CRITIQS_R2_BUCKET", "CRITIQS_R2_ACCESS_KEY_ID", "CRITIQS_R2_SECRET_ACCESS_KEY", "CONVEX_SITE_URL", "RESEND_API_KEY", "CRITIQS_EMAIL_FROM", "CRITIQS_PLANS", "CRITIQS_AUTH_ISSUER"];
const original = new Map(keys.map(key => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function fixture() {
  Object.assign(process.env, { CRITIQS_CAPTURE_STORAGE: "r2", CRITIQS_R2_ACCOUNT_ID: "a".repeat(32), CRITIQS_R2_BUCKET: "critiqs-captures", CRITIQS_R2_ACCESS_KEY_ID: "test-access-key", CRITIQS_R2_SECRET_ACCESS_KEY: "test-secret-key", CONVEX_SITE_URL: "https://test.convex.site" });
  const objects = new Map<string, ArrayBuffer>();
  const methods: string[] = [];
  const failures = { put: false, get: false, remove: false };
  // Private in-process S3 fixture; the actual aws4fetch signer generates every request.
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const request = new Request(input, options);
    expect(new URL(request.url).hostname).toBe(`${"a".repeat(32)}.r2.cloudflarestorage.com`);
    expect(request.headers.get("Authorization")).toStartWith("AWS4-HMAC-SHA256 ");
    expect(request.headers.get("Authorization")).not.toContain("test-secret-key");
    expect(request.redirect).toBe("error");
    const key = new URL(request.url).pathname;
    methods.push(request.method);
    if (request.method === "PUT") {
      if (failures.put) return new Response("sensitive provider diagnostics", { status: 500 });
      const bytes = await request.arrayBuffer();
      // Convex doesn't infer this header from a signed Request's streamed body.
      if (request.headers.get("Content-Length") !== String(bytes.byteLength)) return new Response(null, { status: 411 });
      if (objects.has(key)) throw new Error("Evidence overwritten");
      objects.set(key, bytes);
      return new Response(null, { status: 200 });
    }
    if (request.method === "DELETE") {
      if (failures.remove) return new Response("sensitive provider diagnostics", { status: 500 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (failures.get) return new Response("sensitive provider diagnostics", { status: 503 });
    const bytes = objects.get(key);
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana")), lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "R2 pilot" });
  const reserve = async () => new URL(await dana.mutation(api.captures.generateUploadUrl, { projectId }));
  const upload = (url: URL, body: BodyInit = "original screenshot", type = "image/png") => dana.fetch(url.pathname + url.search, { method: "POST", headers: { "Content-Type": type }, body });
  const create = (storageId: Id<"captureFiles">) => dana.mutation(api.threads.create, { projectId, anchor, body: "Look", tags: [], capture: { status: "captured", storageId } });
  const ready = async () => (await (await upload(await reserve())).json()).storageId as Id<"captureFiles">;
  return { t, dana, lee, projectId, objects, methods, failures, reserve, upload, create, ready };
}

test("R2 roundtrip stores exact bytes outside Convex and checks every read", async () => {
  const f = await fixture();
  const fileId = await f.ready(), threadId = await f.create(fileId);
  expect(await f.t.run(ctx => ctx.db.get(fileId))).toMatchObject({ status: "attached", size: 19, contentType: "image/png" });
  expect(await f.t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(0);
  const response = await f.lee.fetch(`/capture?threadId=${threadId}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("original screenshot");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  expect((await f.t.fetch(`/capture?threadId=${threadId}`)).status).toBe(401);
  expect(f.methods).toEqual(["PUT", "GET"]);
  await f.dana.mutation(api.threads.remove, { threadId });
  expect((await f.lee.fetch(`/capture?threadId=${threadId}`)).status).toBe(404);
  expect(f.objects.size).toBe(1);
});

test("streamed screenshots reach R2 with an explicit byte length", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(131_767).fill(137);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 20_000));
    controller.enqueue(bytes.slice(20_000));
    controller.close();
  } });
  const response = await f.upload(await f.reserve(), body);
  expect(response.status).toBe(200);
  const threadId = await f.create((await response.json()).storageId);
  const image = await f.lee.fetch(`/capture?threadId=${threadId}`);
  expect(image.status).toBe(200);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
});

test("upload claims enforce identity and allow exactly one PUT under replay or concurrency", async () => {
  const f = await fixture(), url = await f.reserve();
  const args = { method: "POST" as const, body: "png", headers: { "Content-Type": "image/png" } };
  expect((await f.t.fetch(url.pathname + url.search, args)).status).toBe(401);
  expect((await f.lee.fetch(url.pathname + url.search, args)).status).toBe(400);
  const results = await Promise.all([f.upload(url), f.upload(url)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  expect((await f.upload(url, "overwrite")).status).toBe(400);
  expect(f.methods.filter(m => m === "PUT")).toHaveLength(1);
});

test("only completed images attach to their uploader and project, exactly once", async () => {
  const f = await fixture(), url = await f.reserve();
  await expect(f.create(url.searchParams.get("fileId") as Id<"captureFiles">)).rejects.toThrow("not uploaded by you");
  const storageId = await f.ready();
  const projectB = await f.dana.mutation(api.projects.create, { name: "B" });
  const args = { projectId: f.projectId, anchor, body: "x", tags: [], capture: { status: "captured" as const, storageId } };
  await expect(f.lee.mutation(api.threads.create, args)).rejects.toThrow("not uploaded by you");
  await expect(f.dana.mutation(api.threads.create, { ...args, projectId: projectB })).rejects.toThrow("not uploaded by you");
  await f.create(storageId);
  await expect(f.create(storageId)).rejects.toThrow("already belongs");
});

test("image types, empty files and actual streamed bytes are checked before R2", async () => {
  const f = await fixture();
  expect((await f.upload(await f.reserve(), "<svg/>", "image/svg+xml")).status).toBe(400);
  expect((await f.upload(await f.reserve(), new Uint8Array(MAX_IMAGE_BYTES + 1))).status).toBe(413);
  expect((await f.upload(await f.reserve(), "")).status).toBe(400);
  expect(f.objects.size).toBe(0);
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_IMAGE_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await expect(readCaptureBody(new Request("https://test.example", { method: "POST", body }))).rejects.toThrow("10 MB");
  expect(cancelled).toBe(true);
});

test("failed PUT cannot attach or leak provider errors", async () => {
  const f = await fixture(), url = await f.reserve(); f.failures.put = true;
  const response = await f.upload(url);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("sensitive provider");
  const file = (await f.t.run(ctx => ctx.db.query("captureFiles").collect()))[0]!;
  expect(file.status).toBe("uploading");
  await expect(f.create(file._id)).rejects.toThrow("not uploaded by you");
});

test("quota refusal rolls back thread, byte counts and attachment state together", async () => {
  const f = await fixture(); process.env.CRITIQS_PLANS = "enabled";
  await f.t.mutation(internal.plans.set, { name: "tiny", label: "Tiny", limits: [{ metric: "captureBytes", period: "total", max: 2 }] });
  await f.t.mutation(internal.plans.assign, { projectId: f.projectId, plan: "tiny" });
  const fileId = await f.ready();
  await expect(f.create(fileId)).rejects.toThrow("Tiny");
  expect(await f.t.run(ctx => ctx.db.query("threads").collect())).toHaveLength(0);
  expect((await f.t.run(ctx => ctx.db.get(fileId)))!.status).toBe("ready");
  const usage = await f.dana.query(api.projects.usage, { projectId: f.projectId, day: new Date().toISOString().slice(0, 10) });
  expect(usage?.rows.find(row => row.metric === "captureBytes")?.used).toBe(0);
});

test("cleanup claims are mutually exclusive with attachment and finalization; deletes retry", async () => {
  const f = await fixture(), fileId = await f.ready();
  const expire = () => f.t.run(ctx => ctx.db.patch(fileId, { cleanupAt: Date.now() - 1 }));
  await f.t.run(ctx => ctx.db.patch(fileId, { createdAt: Date.now() - 2 * 60 * 60_000 }));
  await expire();
  expect(await f.t.mutation(internal.captures.claimExpired, {})).toHaveLength(1);
  await expect(f.create(fileId)).rejects.toThrow("not uploaded by you");
  await expect(f.dana.mutation(internal.captures.finishUpload, { fileId, size: 19 })).rejects.toThrow("expired");
  await expire(); f.failures.remove = true;
  await f.t.action(internal.captures.cleanUp, {});
  expect(f.objects.size).toBe(1);
  expect((await f.t.run(ctx => ctx.db.get(fileId)))!.status).toBe("deleting");
  await expire(); f.failures.remove = false;
  await f.t.action(internal.captures.cleanUp, {});
  expect(f.objects.size).toBe(0);
  const tombstone = (await f.t.run(ctx => ctx.db.get(fileId)))!;
  expect(tombstone.status).toBe("deleting");
  // The original timed-out PUT can complete remotely after the first DELETE.
  f.objects.set(`/${tombstone.bucket}/${tombstone.key}`, new TextEncoder().encode("late PUT completion").buffer);
  await expire(); await f.t.action(internal.captures.cleanUp, {});
  expect(f.objects.size).toBe(0);
  expect((await f.t.run(ctx => ctx.db.get(fileId)))!.status).toBe("deleting");
  await f.t.run(ctx => ctx.db.patch(fileId, { createdAt: Date.now() - 25 * 60 * 60_000 }));
  await expire(); await f.t.action(internal.captures.cleanUp, {});
  expect(await f.t.run(ctx => ctx.db.get(fileId))).toBeNull();
});

test("attached and soft-deleted threads retain their evidence during cleanup", async () => {
  const f = await fixture(), fileId = await f.ready(), threadId = await f.create(fileId);
  await f.dana.mutation(api.threads.remove, { threadId });
  await f.t.run(ctx => ctx.db.patch(fileId, { cleanupAt: Date.now() - 1 }));
  await f.t.action(internal.captures.cleanUp, {});
  expect(f.objects.size).toBe(1);
  expect((await f.t.run(ctx => ctx.db.get(fileId)))!.cleanupAt).toBeUndefined();
});

test("R2 configuration fails closed and public diagnostics contain no keys", async () => {
  const f = await fixture(); delete process.env.CRITIQS_R2_SECRET_ACCESS_KEY;
  await expect(f.reserve()).rejects.toThrow("not configured");
  process.env.CRITIQS_AUTH_ISSUER = "https://test.convex.site";
  const health = await (await f.t.fetch("/critiqs/health")).json();
  expect(health.captures).toEqual({ provider: "r2", configured: false });
  expect(JSON.stringify(health)).not.toContain("test-access-key");
  expect(() => captureProvider({ CRITIQS_CAPTURE_STORAGE: "typo" })).toThrow("must be");
  expect(() => r2Config({ CRITIQS_R2_ACCOUNT_ID: "https://evil.test" })).toThrow("not configured");
});

test("reservations expire and the number of unfinished files is bounded", async () => {
  const f = await fixture(), url = await f.reserve();
  await f.t.run(ctx => ctx.db.patch(url.searchParams.get("fileId") as Id<"captureFiles">, { createdAt: 1 }));
  expect((await f.upload(url)).status).toBe(400);
  for (let i = 1; i < 20; i++) await f.reserve();
  await expect(f.reserve()).rejects.toThrow("Too many unfinished");
});

test("reads use the recorded bucket and refuse an unexpected account", async () => {
  const f = await fixture(), fileId = await f.ready(), threadId = await f.create(fileId);
  process.env.CRITIQS_R2_BUCKET = "next-bucket";
  expect(await (await f.lee.fetch(`/capture?threadId=${threadId}`)).text()).toBe("original screenshot");
  await expect(r2Storage(r2Config()).get({ accountId: "b".repeat(32), bucket: "x", key: "y" })).rejects.toThrow("another R2 account");
});

test("reviewer-supplied R2 screenshots attach after capture failure and legacy images still load", async () => {
  const f = await fixture();
  const threadId = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "x", tags: [], capture: { status: "failed", failureReason: "Capture blocked" } });
  const storageId = await f.ready();
  await f.dana.mutation(api.threads.attachScreenshot, { threadId, storageId });
  expect(await (await f.lee.fetch(`/capture?threadId=${threadId}`)).text()).toBe("original screenshot");
  const legacy = await f.t.run(ctx => ctx.storage.store(new Blob(["legacy bytes"], { type: "image/png" })));
  const oldThread = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "old", tags: [], capture: { status: "captured", storageId: legacy } });
  expect(await (await f.lee.fetch(`/capture?threadId=${oldThread}`)).text()).toBe("legacy bytes");
});

test("cleanup drains more than one bounded batch without deleting attached files", async () => {
  const f = await fixture();
  await f.t.run(async ctx => {
    const owner = (await ctx.db.query("users").first())!;
    for (let i = 0; i < 51; i++) await ctx.db.insert("captureFiles", { uploadedBy: owner._id, projectId: f.projectId, accountId: "a".repeat(32), bucket: "critiqs-captures", key: `abandoned/${i}`, status: "uploading", createdAt: Date.now() - 2 * 60 * 60_000, cleanupAt: Date.now() - 1 });
  });
  await f.t.action(internal.captures.cleanUp, {});
  await f.t.finishAllScheduledFunctions(() => {});
  const files = await f.t.run(ctx => ctx.db.query("captureFiles").collect());
  expect(files).toHaveLength(51);
  expect(files.every(file => file.status === "deleting" && file.cleanupAt! > Date.now())).toBe(true);
  expect(f.methods.filter(method => method === "DELETE")).toHaveLength(51);
});

/** A real upload and attached thread whose next reply mentions Lee. */
async function r2Mention() {
  const f = await fixture();
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <mentions@example.com>";
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
  const response = await f.upload(await f.reserve(), png);
  expect(response.status).toBe(200);
  const threadId = await f.create((await response.json()).storageId);
  // Only the mention is emailed here; reply emails have their own tests.
  await f.dana.mutation(api.notifications.setSettings, { projectId: f.projectId, replyEmails: false });
  await f.lee.mutation(api.threads.reply, { threadId, body: "Hi", revision: null });
  const [lee] = await f.dana.query(api.projects.participants, { projectId: f.projectId, query: "lee" });
  await f.dana.mutation(api.threads.reply, {
    threadId, body: "@Lee check the screenshot", revision: null,
    mentions: [{ userId: lee!._id as Id<"users">, label: "Lee" }],
  });
  const storageFetch = globalThis.fetch;
  const sent: { raw: string; key: string | null }[] = [];
  const mail = { status: 200 };
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const request = new Request(input, options);
    if (new URL(request.url).hostname !== "api.resend.com") return await storageFetch(input, options);
    sent.push({ raw: await request.text(), key: request.headers.get("Idempotency-Key") });
    return mail.status === 200 ? Response.json({ id: "email" }) : new Response(null, { status: mail.status });
  }) as typeof fetch;
  const deliver = async () => {
    await f.t.run(async ctx => {
      for (const row of await ctx.db.query("deliveries").collect()) {
        if (row.status === "pending") await ctx.db.patch(row._id, { dueAt: Date.now() - 1 });
      }
    });
    await f.t.action(internal.notificationEmails.deliver, {});
  };
  return { ...f, png, sent, mail, deliver };
}

test("mention emails read R2 captures privately and retry the identical prepared email", async () => {
  const f = await r2Mention();
  // A transient storage error must not freeze an email without its image.
  f.failures.get = true;
  await f.deliver();
  expect(f.sent).toHaveLength(0);
  const [delivery] = await f.t.run(ctx => ctx.db.query("deliveries").collect());
  expect(delivery).toMatchObject({ status: "pending", reason: "The capture couldn't be read." });
  expect(delivery!.payload).toBeUndefined();

  f.failures.get = false;
  f.mail.status = 503;
  await f.deliver();
  expect(f.sent).toHaveLength(1);
  const body = JSON.parse(f.sent[0]!.raw);
  expect(body.attachments).toEqual([
    { filename: "capture.png", content: btoa(String.fromCharCode(...f.png)), content_type: "image/png", content_id: "critiqs-capture" },
  ]);
  expect(body.html).toContain('src="cid:critiqs-capture"');
  expect(body.html).toContain("Hi");
  expect(body.text).toContain("@Lee check the screenshot");
  expect(f.sent[0]!.raw).not.toContain("cloudflarestorage.com");
  expect(f.sent[0]!.raw).not.toContain("test-access-key");
  // Once prepared, retries read the Convex email payload even if R2 is gone.
  f.objects.clear();
  f.mail.status = 200;
  await f.deliver();
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]).toEqual(f.sent[0]);
  expect((await f.t.run(ctx => ctx.db.query("deliveries").collect()))[0]).toMatchObject({ status: "sent" });
});

test("mention emails report a missing R2 capture without a broken image", async () => {
  const f = await r2Mention();
  f.objects.clear();
  await f.deliver();
  expect(f.sent).toHaveLength(1);
  const body = JSON.parse(f.sent[0]!.raw);
  expect(body.attachments).toBeUndefined();
  expect(body.html).not.toContain("cid:");
  expect(body.html).toContain("The capture couldn't be included in this email. Open the comment to see it.");
});
