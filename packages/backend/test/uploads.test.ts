import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConvexError } from "convex/values";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import crons from "../convex/crons";
import { PENDING, PROJECT_PENDING_BYTES } from "../convex/uploads";
import { anchor, reviewer, setup, upload } from "./harness";

// Uploads to Convex's own storage: what a released component sends, how many
// a person and a project may have unfinished, cleanup of what nothing
// attached, and downloads that end while storage answers.

const PAGE = "<html><body>Page</body></html>";
const source = { url: "https://proto.example/users/alex", screen: "user-details", viewState: {}, revision: null, persona: null };
const failed = { status: "failed" as const, failureReason: "x" };

const site = process.env.CONVEX_SITE_URL;
beforeEach(() => {
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
});
afterEach(() => {
  if (site === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = site;
});

async function project() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const sam = t.withIdentity(reviewer("Sam"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const snapshot = (storageId: Id<"_storage">) => ({ storageId, width: 1440, height: 2000, scrollY: 0, viewportHeight: 900, capturedAt: 1 });
  const startMockup = (who: typeof dana, storageId: Id<"_storage">) => who.action(api.mockups.create, { projectId, title: "Bigger save", source, snapshot: snapshot(storageId) });
  const exists = (id: Id<"_storage">) => t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);
  return { t, dana, lee, sam, projectId, startMockup, exists };
}

/** Posts a file to an upload address as a component does: `token` is the sign-in a current one sends, and released ones send none for page copies. */
async function post(t: ReturnType<typeof setup>, address: string, body: BodyInit, type = "text/html", who?: { fetch: (path: string, init?: RequestInit) => Promise<Response> }) {
  const url = new URL(address);
  return await (who ?? t).fetch(url.pathname + url.search, { method: "POST", headers: { "Content-Type": type }, body });
}

test("a released component's page copy, posted without a sign-in, is stored through its upload grant and attaches as before", async () => {
  const f = await project();
  const address = await f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  // As the component released before reservations posts it: no Authorization header.
  const response = await post(f.t, address, PAGE);
  expect(response.status).toBe(200);
  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  // Through the address's grant, of which only the hash is kept.
  const url = new URL(address);
  expect(url.pathname).toBe("/mockup/upload");
  const grant = url.searchParams.get("grant")!;
  expect(grant.length).toBeGreaterThanOrEqual(43);
  expect(JSON.stringify(await f.t.run((ctx) => ctx.db.query("uploads").collect()))).not.toContain(grant);
  // The grant works once.
  expect((await post(f.t, address, PAGE)).status).toBe(400);
  // It stores a file only its uploader can attach.
  await expect(f.startMockup(f.lee, storageId)).rejects.toThrow("This page copy was not uploaded by you for this project.");
  const mockupId = await f.startMockup(f.dana, storageId);
  expect((await f.dana.query(api.mockups.get, { mockupId })).snapshots).toHaveLength(1);
});

test("an upload grant is the reservation's alone: without it, with another's sign-in, or late, nothing is stored", async () => {
  const f = await project();
  const files = () => f.t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
  const address = await f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  const url = new URL(address);
  const without = new URL(url);
  without.searchParams.delete("grant");
  const wrong = new URL(url);
  wrong.searchParams.set("grant", "x".repeat(43));
  // Neither a missing nor a wrong grant, without a sign-in or with the uploader's.
  for (const who of [undefined, f.dana]) {
    expect((await post(f.t, without.href, PAGE, "text/html", who)).status).toBe(400);
    expect((await post(f.t, wrong.href, PAGE, "text/html", who)).status).toBe(400);
  }
  // The right grant with someone else's sign-in.
  expect((await post(f.t, address, PAGE, "text/html", f.lee)).status).toBe(400);
  // A screenshot route doesn't take a page copy's grant.
  expect((await post(f.t, `${url.origin}/capture/upload${url.search}`, "png", "image/png")).status).toBe(400);
  expect(await files()).toBe(0);
  // Once the reservation has expired.
  const late = await f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  await f.t.run(async (ctx) => {
    for (const upload of await ctx.db.query("uploads").collect()) await ctx.db.patch(upload._id, { createdAt: upload.createdAt - 11 * 60_000 });
  });
  expect(await (await post(f.t, late, PAGE)).text()).toBe("Start a new page copy upload.");
  // A current component sends its sign-in and the grant; that works too.
  const current = await f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  expect((await post(f.t, current, PAGE, "text/html", f.dana)).status).toBe(200);
  expect(await files()).toBe(1);
});

test("a file stored through an address given before reservations is refused with a request to upload it again", async () => {
  const f = await project();
  // What an older backend's storage address stored, just before this one was deployed.
  const unbound = await f.t.run((ctx) => ctx.storage.store(new Blob([PAGE], { type: "text/html" })));
  const refusal = await f.startMockup(f.dana, unbound).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(ConvexError);
  expect((refusal as ConvexError<{ message: string; reupload?: boolean }>).data).toMatchObject({ code: "invalid", message: "Upload the page copy again.", reupload: true });
  const image = await f.t.run((ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
  const thread = await f.dana
    .mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Look", tags: [], capture: { status: "captured", storageId: image } })
    .catch((error: unknown) => error);
  expect((thread as ConvexError<{ reupload?: boolean }>).data).toMatchObject({ message: "Upload the screenshot again.", reupload: true });
  // Uploaded again, it attaches.
  await f.startMockup(f.dana, await upload(f.dana, f.projectId, PAGE, { purpose: "pageCopy" }));
});

test("a person's unfinished uploads count reserved, uploading, and stored but unattached ones, up to 20", async () => {
  const f = await project();
  const stored = [];
  for (let i = 0; i < 10; i++) stored.push(await upload(f.dana, f.projectId, PAGE, { purpose: "pageCopy" }));
  for (let i = 0; i < 10; i++) await f.dana.mutation(api.captures.generateUploadUrl, { projectId: f.projectId });
  // Five of the reservations have started uploading.
  await f.t.run(async (ctx) => {
    for (const upload of (await ctx.db.query("uploads").collect()).filter((upload) => upload.status === "reserved").slice(0, 5)) await ctx.db.patch(upload._id, { status: "uploading" });
  });
  expect(PENDING).toBe(20);
  await expect(f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId })).rejects.toThrow("Too many unfinished uploads");
  // Attaching one frees its place.
  await f.startMockup(f.dana, stored[0]!);
  await f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  // Others aren't held back by Dana's.
  await f.lee.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
});

test("a project's unfinished uploads stay within its pending-byte budget: reservations at their largest, stored files at their size", async () => {
  const f = await project();
  const reviewers = ["Ada", "Ben", "Cy", "Di"].map((name) => f.t.withIdentity(reviewer(name)));
  // 20 reservations of 10 MB each: the budget.
  expect(PROJECT_PENDING_BYTES).toBe(20 * 10 * 1024 * 1024);
  for (const who of reviewers) for (let i = 0; i < 5; i++) await who.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  await expect(f.sam.mutation(api.captures.generateUploadUrl, { projectId: f.projectId })).rejects.toThrow("This project has too many unfinished uploads");
  // Another project isn't affected.
  const other = await f.sam.mutation(api.projects.create, { name: "Other" });
  await f.sam.mutation(api.captures.generateUploadUrl, { projectId: other });
  // Stored, a small file counts only its size, so the project takes more.
  const reserved = (await f.t.run((ctx) => ctx.db.query("uploads").collect())).filter((upload) => upload.projectId === f.projectId);
  const small = await f.t.run((ctx) => ctx.storage.store(new Blob([PAGE])));
  await f.t.run(async (ctx) => {
    for (const upload of reserved.slice(0, 2)) await ctx.db.patch(upload._id, { status: "ready", storageId: small, size: PAGE.length });
  });
  await f.sam.mutation(api.captures.generateUploadUrl, { projectId: f.projectId });
  await expect(f.sam.mutation(api.captures.generateUploadUrl, { projectId: f.projectId })).rejects.toThrow("This project has too many unfinished uploads");
});

test("cleanup removes expired reservations and deletes files nothing attached within an hour, but never one that something uses", async () => {
  const f = await project();
  expect(JSON.stringify(crons)).toContain("uploads:cleanUp");
  const fresh = await upload(f.dana, f.projectId, PAGE, { purpose: "pageCopy" });
  const stale = await upload(f.dana, f.projectId, PAGE, { purpose: "pageCopy" });
  const attached = await upload(f.dana, f.projectId, PAGE, { purpose: "pageCopy" });
  await f.startMockup(f.dana, attached);
  // A stored file a thread's capture uses after all, as one from before reservations might.
  const used = await upload(f.dana, f.projectId, "png");
  const threadId = await f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Old", tags: [], capture: failed });
  await f.t.run((ctx) => ctx.db.patch(threadId, { capture: { status: "captured", storageId: used } }));
  await f.dana.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId });
  const expiring = await f.dana.mutation(api.captures.generateUploadUrl, { projectId: f.projectId });
  const uploads = () => f.t.run((ctx) => ctx.db.query("uploads").collect());
  const age = (filter: (upload: Awaited<ReturnType<typeof uploads>>[number]) => boolean, minutes: number) =>
    f.t.run(async (ctx) => {
      for (const upload of (await ctx.db.query("uploads").collect()).filter(filter)) await ctx.db.patch(upload._id, { createdAt: upload.createdAt - minutes * 60_000 });
    });
  // One reservation is past its 10 minutes; three stored files, one used, one attached, are past the hour.
  await age((upload) => upload._id === new URL(expiring).searchParams.get("uploadId"), 11);
  await age((upload) => upload.storageId === stale || upload.storageId === used || upload.storageId === attached, 61);

  await f.t.mutation(internal.uploads.cleanUp, {});
  const left = await uploads();
  expect(left.map((upload) => upload.status).sort()).toEqual(["attached", "attached", "ready", "reserved"]);
  expect(await f.exists(stale)).toBe(false);
  expect(await f.exists(fresh)).toBe(true);
  expect(await f.exists(used)).toBe(true);
  expect(await f.exists(attached)).toBe(true);
  expect(left.find((upload) => upload.storageId === used)?.status).toBe("attached");
  // The expired reservation can't be used, nor the deleted file attached.
  expect((await post(f.t, expiring, "png", "image/png", f.dana)).status).toBe(400);
  await expect(f.startMockup(f.dana, stale)).rejects.toThrow("The uploaded page copy was not found.");
  // A fresh one still attaches.
  await f.startMockup(f.dana, fresh);
});

test("a stored file waiting past the hour is no longer attachable, even before cleanup runs", async () => {
  const f = await project();
  const image = await upload(f.dana, f.projectId, "png");
  await f.t.run(async (ctx) => {
    const reservation = (await ctx.db.query("uploads").collect())[0]!;
    await ctx.db.patch(reservation._id, { createdAt: reservation.createdAt - 61 * 60_000 });
  });
  await expect(f.dana.mutation(api.threads.create, { projectId: f.projectId, anchor, body: "Late", tags: [], capture: { status: "captured", storageId: image } })).rejects.toThrow(
    "Upload the screenshot again.",
  );
});

test("the hour to attach a stored file counts from when it was stored, not from the reservation", async () => {
  const f = await project();
  const address = await f.dana.mutation(api.captures.generateUploadUrl, { projectId: f.projectId });
  const shift = (find: (upload: { _id: unknown; storageId?: unknown }) => boolean, minutes: number) =>
    f.t.run(async (ctx) => {
      const upload = (await ctx.db.query("uploads").collect()).find(find)!;
      await ctx.db.patch(upload._id, { createdAt: upload.createdAt - minutes * 60_000 });
    });
  // Reserved 9 minutes ago, stored now, then waiting 55 minutes: 64 minutes after the reservation, but within the hour of storing.
  await shift((upload) => String(upload._id) === new URL(address).searchParams.get("uploadId"), 9);
  const { storageId } = (await (await post(f.t, address, "png", "image/png", f.dana)).json()) as { storageId: string };
  await shift((upload) => upload.storageId === storageId, 55);
  await f.dana.mutation(api.threads.create, {
    projectId: f.projectId,
    anchor,
    body: "In time",
    tags: [],
    capture: { status: "captured", storageId: storageId as never },
  });
});

/**
 * Runs `meanwhile` once storage has handed a file to an HTTP action, before
 * the action answers, as when access ends while a download is in flight.
 */
async function whileStorageAnswers<T>(meanwhile: () => Promise<unknown>, request: () => Promise<T>): Promise<T> {
  const convex = (globalThis as unknown as { Convex: object }).Convex;
  const real = Object.getOwnPropertyDescriptor(convex, "jsSyscall")!;
  let ran = false;
  Object.defineProperty(convex, "jsSyscall", {
    configurable: true,
    get: () => {
      const syscall = real.get!.call(convex) as (op: string, args: unknown) => Promise<unknown>;
      return async (op: string, args: unknown) => {
        const result = await syscall(op, args);
        if (op === "storage/getBlob" && !ran) {
          ran = true;
          await meanwhile();
        }
        return result;
      };
    },
  });
  try {
    return await request();
  } finally {
    Object.defineProperty(convex, "jsSyscall", real);
  }
}

test("a capture or page copy whose access ends while storage fetches it is not returned", async () => {
  const f = await project();
  const threadId = await f.dana.mutation(api.threads.create, {
    projectId: f.projectId,
    anchor,
    body: "Spacing",
    tags: [],
    capture: { status: "captured", storageId: await upload(f.dana, f.projectId, "png-bytes") },
  });
  const mockupId = await f.startMockup(f.dana, await upload(f.dana, f.projectId, PAGE, { purpose: "pageCopy" }));
  const snapshotId = (await f.dana.query(api.mockups.get, { mockupId })).snapshots[0]!._id;
  const capture = `/capture?threadId=${threadId}`;
  const copy = `/mockup/snapshot?snapshotId=${snapshotId}`;
  expect(await (await f.lee.fetch(capture)).text()).toBe("png-bytes");
  expect(await (await f.lee.fetch(copy)).text()).toBe(PAGE);

  // Dana limits the project to her organization, which Lee isn't in, while storage reads each file for him.
  const limit = (reviewAccess: "organization" | "anyone") => () => f.dana.mutation(api.projects.setReviewAccess, { projectId: f.projectId, reviewAccess });
  for (const path of [capture, copy]) {
    const response = await whileStorageAnswers(limit("organization"), () => f.lee.fetch(path));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(path === capture ? "png-bytes" : "Page");
    await limit("anyone")();
  }
  // The thread is deleted meanwhile.
  const gone = await whileStorageAnswers(() => f.dana.mutation(api.threads.remove, { threadId }), () => f.lee.fetch(capture));
  expect(gone.status).toBe(404);
  expect(await gone.text()).not.toContain("png-bytes");
  // Its members still get both.
  expect(await (await f.dana.fetch(copy)).text()).toBe(PAGE);
});
