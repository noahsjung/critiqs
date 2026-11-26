import { IMAGE_TYPES, MAX_IMAGE_BYTES, MOCKUP_RULES, operations } from "@critiqs/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalMutation, type MutationCtx } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { hashSecret, randomSecret } from "./lib/tokens";

// Files people upload to Convex's own storage: captures and screenshots (when
// R2 isn't set up) and mockups' page copies. Each upload is reserved first by
// someone who may add to the project, for one purpose, like R2's
// `captureFiles`, and goes through the deployment's own route, which records
// the stored file on its reservation. A file is attachable only by the person
// who reserved it, in that project, for that purpose, and only once, as a
// capture or a page copy. Files stored before reservations existed have none,
// so only their existing attachments keep working.
//
// The upload address carries a grant: a random one-use secret for that
// reservation alone, stored only as a hash. Released components post page
// copies without the reviewer's sign-in, so the route accepts the grant in its
// place; a request that does carry a sign-in must be the uploader's, and must
// carry the grant too. A grant works once, within `UPLOAD_MS`, and only stores
// a file that its uploader alone can attach.

/** How long a reservation waits for its file: the upload must start and finish within it. */
const UPLOAD_MS = 10 * 60_000;
/** How long a stored file waits to be attached before cleanup deletes it; as long as a page copy stays attachable. */
const READY_MS = MOCKUP_RULES.uploadMinutes * 60_000;
/** Unfinished uploads one person may have at a time: reserved, uploading, or stored and not yet attached. */
export const PENDING = 20;
/** Rows a project's unfinished uploads may have; past this, the project takes no more until some finish or expire. */
const PROJECT_PENDING_ROWS = 100;

export type UploadPurpose = Doc<"uploads">["purpose"];
const purposeValidator = v.union(v.literal("capture"), v.literal("pageCopy"));

/** The largest file each purpose stores. */
const MAX_BYTES: Record<UploadPurpose, number> = { capture: MAX_IMAGE_BYTES, pageCopy: MOCKUP_RULES.snapshotBytes };
/**
 * Bytes a project's unfinished uploads may hold at once: a stored file counts
 * its size, and a reservation not yet stored counts the most its purpose
 * allows. As much as one person's unfinished uploads at their largest.
 */
export const PROJECT_PENDING_BYTES = PENDING * Math.max(MAX_BYTES.capture, MAX_BYTES.pageCopy);

/** The route each purpose uploads through; the component sends its sign-in token only to these. */
const ROUTES: Record<UploadPurpose, string> = { capture: "/capture/upload", pageCopy: "/mockup/upload" };
const WHAT: Record<UploadPurpose, string> = { capture: "screenshot", pageCopy: "page copy" };

/**
 * Refuses an upload. With `reupload`, the file can never be attached, but a
 * new upload of it can: components that see it upload the file again and
 * retry once.
 */
function invalid(message: string, reupload = false): never {
  throw new ConvexError({ code: "invalid", message, ...(reupload ? { reupload: true } : {}) });
}

type Unfinished = Exclude<Doc<"uploads">["status"], "attached">;
const UNFINISHED: readonly Unfinished[] = ["reserved", "uploading", "ready"];

/** The oldest creation time at which an upload in `status` still counts: reservations until they expire; stored files until cleanup deletes them. */
function countsSince(status: Unfinished, now: number): number {
  return status === "ready" ? 0 : now - UPLOAD_MS;
}

/** Reserves an upload for `purpose` in a project, after the caller's checks; returns the address to post the file to. */
export async function reserveUpload(ctx: MutationCtx, args: { projectId: Id<"projects">; userId: Id<"users">; purpose: UploadPurpose }): Promise<string> {
  const now = Date.now();
  let mine = 0;
  for (const status of UNFINISHED) {
    mine += (
      await ctx.db
        .query("uploads")
        .withIndex("by_uploader_status", (q) => q.eq("uploadedBy", args.userId).eq("status", status).gt("createdAt", countsSince(status, now)))
        .take(PENDING)
    ).length;
  }
  if (mine >= PENDING) invalid("Too many unfinished uploads. Try again in a few minutes.");
  let rows = 0;
  let bytes = MAX_BYTES[args.purpose];
  for (const status of UNFINISHED) {
    const pending = await ctx.db
      .query("uploads")
      .withIndex("by_project_status", (q) => q.eq("projectId", args.projectId).eq("status", status).gt("createdAt", countsSince(status, now)))
      .take(PROJECT_PENDING_ROWS);
    rows += pending.length;
    for (const upload of pending) bytes += status === "ready" ? (upload.size ?? MAX_BYTES[upload.purpose]) : MAX_BYTES[upload.purpose];
  }
  if (rows >= PROJECT_PENDING_ROWS || bytes > PROJECT_PENDING_BYTES) invalid("This project has too many unfinished uploads. Try again in a few minutes.");
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is not configured.");
  const grant = randomSecret();
  const id = await ctx.db.insert("uploads", {
    projectId: args.projectId,
    uploadedBy: args.userId,
    purpose: args.purpose,
    status: "reserved",
    grantHash: await hashSecret(grant),
    createdAt: now,
  });
  return `${site.replace(/\/$/, "")}${ROUTES[args.purpose]}?uploadId=${id}&grant=${grant}`;
}

/**
 * Claims a reservation before any of the file is read: fresh, for this
 * purpose and type, in a project its uploader may still add to, with its
 * grant, and from its uploader if the request is signed in. A request
 * without a sign-in needs the grant; one with a sign-in needs both.
 */
export const begin = internalMutation({
  args: { uploadId: v.string(), grant: v.union(v.string(), v.null()), purpose: purposeValidator, contentType: v.string() },
  handler: async (ctx, args): Promise<Id<"uploads">> =>
    run(async () => {
      const store = convexStore(ctx);
      const identity = await identityOf(ctx);
      const id = ctx.db.normalizeId("uploads", args.uploadId);
      const upload = id === null ? null : await ctx.db.get(id);
      if (upload === null || upload.purpose !== args.purpose) invalid("This upload is unavailable.");
      const granted = upload.grantHash !== undefined && args.grant !== null && (await hashSecret(args.grant)) === upload.grantHash;
      if (identity === null) {
        if (!granted) invalid("This upload is unavailable.");
      } else {
        const user = await operations.requireUser(store, identity);
        // Reservations made before grants existed need the sign-in alone.
        if (user._id !== upload.uploadedBy || (upload.grantHash !== undefined && !granted)) invalid("This upload is unavailable.");
      }
      if (upload.status !== "reserved" || upload.createdAt + UPLOAD_MS <= Date.now()) invalid(`Start a new ${WHAT[args.purpose]} upload.`);
      if (args.purpose === "capture" && !IMAGE_TYPES.includes(args.contentType)) invalid("Captures and screenshots must be PNG, JPEG, WebP, or GIF images.");
      if (args.purpose === "pageCopy" && args.contentType !== "text/html") invalid("A page copy must be uploaded as text/html.");
      await operations.authorizeUploadBy(store, { _id: upload.uploadedBy }, { projectId: upload.projectId });
      await ctx.db.patch(upload._id, { status: "uploading" });
      return upload._id;
    }),
});

/**
 * Records the stored file on the reservation `begin` claimed, if its uploader
 * may still add to the project; otherwise the route deletes the file. Only
 * the upload route calls it, with the ID `begin` returned.
 */
export const finish = internalMutation({
  args: { uploadId: v.id("uploads"), storageId: v.id("_storage"), size: v.number() },
  handler: async (ctx, args): Promise<void> =>
    run(async () => {
      const upload = await ctx.db.get(args.uploadId);
      if (upload === null || upload.status !== "uploading" || upload.createdAt + UPLOAD_MS <= Date.now()) {
        invalid("This upload expired. Upload it again.");
      }
      await operations.authorizeUploadBy(convexStore(ctx), { _id: upload.uploadedBy }, { projectId: upload.projectId });
      // From here `createdAt` is when the file was stored, so the hour to attach it (`READY_MS`) counts from then.
      await ctx.db.patch(upload._id, { status: "ready", storageId: args.storageId, size: args.size, createdAt: Date.now() });
    }),
});

/** Uploads cleanup reads per status in one run; a full batch runs it again at once. */
const CLEANUP_BATCH = 100;

/**
 * Removes expired reservations, and deletes stored files nothing attached
 * within `READY_MS`, with their reservations, in one transaction each run, so
 * an attachment can't race the deletion. A file something uses after all is
 * marked attached instead. Runs every 10 minutes.
 */
export const cleanUp = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();
    let full = false;
    for (const status of ["reserved", "uploading"] as const) {
      const expired = await ctx.db
        .query("uploads")
        .withIndex("by_status", (q) => q.eq("status", status).lte("createdAt", now - UPLOAD_MS))
        .take(CLEANUP_BATCH);
      // An upload still in progress then fails to finish, and its route deletes the file.
      for (const upload of expired) await ctx.db.delete(upload._id);
      full ||= expired.length === CLEANUP_BATCH;
    }
    const unused = await ctx.db
      .query("uploads")
      .withIndex("by_status", (q) => q.eq("status", "ready").lte("createdAt", now - READY_MS))
      .take(CLEANUP_BATCH);
    for (const upload of unused) {
      const storageId = upload.storageId;
      if (storageId !== undefined && (await usedFile(ctx, storageId))) {
        await ctx.db.patch(upload._id, { status: "attached" });
        continue;
      }
      if (storageId !== undefined && (await ctx.db.system.get(storageId)) !== null) await ctx.storage.delete(storageId);
      await ctx.db.delete(upload._id);
    }
    if (full || unused.length === CLEANUP_BATCH) await ctx.scheduler.runAfter(0, internal.uploads.cleanUp, {});
  },
});

/** Bounded streaming read: Content-Length is only an early check, never trusted. */
export async function readUploadBody(request: Request, limit: number, tooLarge: string): Promise<ArrayBuffer> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ConvexError({ code: "too-large", message: tooLarge });
  const reader = request.body?.getReader();
  if (!reader) throw new ConvexError({ code: "invalid", message: "The upload is empty." });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ConvexError({ code: "too-large", message: tooLarge });
    }
    chunks.push(value);
  }
  if (size === 0) throw new ConvexError({ code: "invalid", message: "The upload is empty." });
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/** Stores a reserved upload's file in Convex storage, for an upload route; returns its storage ID. */
export async function storeUpload(ctx: ActionCtx, request: Request, purpose: UploadPurpose): Promise<Id<"_storage">> {
  const params = new URL(request.url).searchParams;
  const uploadId = params.get("uploadId");
  if (uploadId === null) throw new ConvexError({ code: "invalid", message: "Missing uploadId." });
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  const id = await ctx.runMutation(internal.uploads.begin, { uploadId, grant: params.get("grant"), purpose, contentType });
  const body = await readUploadBody(request, MAX_BYTES[purpose], purpose === "capture" ? "Images are limited to 10 MB." : "Page copies are limited to 10 MB.");
  const storageId = await ctx.storage.store(new Blob([body], { type: contentType }));
  try {
    await ctx.runMutation(internal.uploads.finish, { uploadId: id, storageId, size: body.byteLength });
  } catch (error) {
    // Never left behind unbound: nothing could attach it.
    await ctx.storage.delete(storageId);
    throw error;
  }
  return storageId;
}

/**
 * Checks a stored file may be attached as `purpose`: its upload was reserved
 * by this person, in this project, for this purpose, and nothing uses it yet
 * as a capture or a page copy, and it was stored within `READY_MS`. Files
 * without a reservation are refused.
 */
export async function checkUpload(ctx: MutationCtx, storageId: Id<"_storage">, args: { projectId: string; userId: string; purpose: UploadPurpose }): Promise<void> {
  const upload = await ctx.db.query("uploads").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  if (upload?.status === "attached" || (await usedFile(ctx, storageId))) {
    invalid(args.purpose === "capture" ? "This image already belongs to a thread." : "This page copy already belongs to a mockup.");
  }
  // A file stored without a reservation, as through an address an older backend gave just before this one was deployed.
  if (upload === null) invalid(`Upload the ${WHAT[args.purpose]} again.`, true);
  if (upload.status !== "ready" || upload.purpose !== args.purpose || upload.projectId !== args.projectId || upload.uploadedBy !== args.userId) {
    invalid(`This ${WHAT[args.purpose]} was not uploaded by you for this project.`);
  }
  if (upload.createdAt + READY_MS <= Date.now()) invalid(`Upload the ${WHAT[args.purpose]} again.`, true);
}

/** Marks a checked file attached, so it can never be attached again. */
export async function markUploadAttached(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  const upload = await ctx.db.query("uploads").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  if (upload !== null) await ctx.db.patch(upload._id, { status: "attached" });
}

/** Whether a thread's capture or a page copy uses a stored file. */
export async function usedFile(ctx: MutationCtx, storageId: Id<"_storage">): Promise<boolean> {
  const capture = await ctx.db.query("threads").withIndex("by_capture_storage", (q) => q.eq("capture.storageId", storageId)).first();
  const copy = await ctx.db.query("mockupSnapshots").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
  return capture !== null || copy !== null;
}
