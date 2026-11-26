import { IMAGE_TYPES, MAX_IMAGE_BYTES, operations, UPLOAD_MINUTES, type Identity } from "@critiqs/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { captureProvider, r2Config, r2Storage } from "./lib/r2";
import { convexStore, identityOf, run } from "./lib/store";
import { captureFileValidator } from "./lib/validators";
import { checkUpload, markUploadAttached, reserveUpload } from "./uploads";

const UPLOAD_MS = UPLOAD_MINUTES * 60_000;
const RETRY_MS = 10 * 60_000;
const TOMBSTONE_MS = 24 * 60 * 60_000;

function invalid(message: string): never {
  throw new ConvexError({ code: "invalid", message });
}

/** A fresh one-use reservation: in R2, or in Convex's own storage (see `uploads.ts`). */
export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<string> => run(async () => {
    const store = convexStore(ctx);
    const identity = await identityOf(ctx);
    await operations.authorizeUpload(store, identity, args);
    const user = await operations.requireUser(store, identity);
    if (captureProvider() === "convex") return await reserveUpload(ctx, { projectId: args.projectId, userId: user._id as Id<"users">, purpose: "capture" });
    const config = r2Config();
    let pending = 0;
    for (const status of ["reserved", "uploading", "ready"] as const) {
      pending += (await ctx.db.query("captureFiles")
        .withIndex("by_uploader_status", q => q.eq("uploadedBy", user._id as Id<"users">).eq("status", status))
        .take(20)).length;
    }
    if (pending >= 20) invalid("Too many unfinished screenshots. Try again after unused uploads expire.");
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new Error("CONVEX_SITE_URL is not configured.");
    const now = Date.now();
    const id = await ctx.db.insert("captureFiles", {
      projectId: args.projectId, uploadedBy: user._id as Id<"users">,
      accountId: config.accountId, bucket: config.bucket, key: "",
      status: "reserved", createdAt: now, cleanupAt: now + UPLOAD_MS,
    });
    await ctx.db.patch(id, { key: `captures/${id}` });
    return `${site.replace(/\/$/, "")}/capture/upload?fileId=${id}`;
  }),
});

/** Atomically claims a reservation before any body is read or bytes are written. */
export const beginUpload = internalMutation({
  args: { fileId: v.string(), contentType: v.string() },
  handler: async (ctx, args): Promise<Doc<"captureFiles">> => run(async () => {
    const identity = await identityOf(ctx);
    const user = await operations.requireUser(convexStore(ctx), identity);
    const id = ctx.db.normalizeId("captureFiles", args.fileId);
    const file = id === null ? null : await ctx.db.get(id);
    if (file === null || file.uploadedBy !== user._id) invalid("This upload is unavailable.");
    if (file.status !== "reserved" || file.createdAt + UPLOAD_MS <= Date.now()) invalid("Start a new screenshot upload.");
    if (!IMAGE_TYPES.includes(args.contentType)) invalid("Captures and screenshots must be PNG, JPEG, WebP, or GIF images.");
    await operations.authorizeUpload(convexStore(ctx), identity, { projectId: file.projectId });
    const config = r2Config();
    if (captureProvider() !== "r2" || file.accountId !== config.accountId || file.bucket !== config.bucket) {
      invalid("Screenshot storage changed. Start a new upload.");
    }
    await ctx.db.patch(file._id, { status: "uploading", contentType: args.contentType });
    return file;
  }),
});

/**
 * Metadata becomes attachable only after the server's R2 PUT has succeeded,
 * and only if the uploader may still add to the project: access can end while
 * the image is stored. A refused upload stays `uploading` until its cleanup
 * time, when the object is deleted.
 */
export const finishUpload = internalMutation({
  args: { fileId: v.id("captureFiles"), size: v.number() },
  handler: async (ctx, args): Promise<void> => run(async () => {
    const store = convexStore(ctx);
    const identity = await identityOf(ctx);
    const user = await operations.requireUser(store, identity);
    const file = await ctx.db.get(args.fileId);
    if (file === null || file.uploadedBy !== user._id || file.status !== "uploading" || file.createdAt + UPLOAD_MS <= Date.now()) {
      invalid("This screenshot upload expired. Upload it again.");
    }
    await operations.authorizeUpload(store, identity, { projectId: file.projectId });
    if (!Number.isSafeInteger(args.size) || args.size <= 0 || args.size > MAX_IMAGE_BYTES) invalid("Images are limited to 10 MB.");
    await ctx.db.patch(file._id, { status: "ready", size: args.size });
  }),
});

/** Checks bindings in the same transaction as attachment, quota charging, and status change. */
export async function checkAttachment(ctx: MutationCtx, fileId: string, projectId: string, identity: Identity | null) {
  const id = ctx.db.normalizeId("captureFiles", fileId);
  const user = await operations.requireUser(convexStore(ctx), identity);
  if (id === null) {
    const storageId = ctx.db.system.normalizeId("_storage", fileId);
    if (storageId === null) invalid("The uploaded image was not found.");
    return await checkUpload(ctx, storageId, { projectId, userId: user._id, purpose: "capture" });
  }
  const file = await ctx.db.get(id);
  if (file?.status === "attached") invalid("This image already belongs to a thread.");
  if (file === null || file.status !== "ready" || file.projectId !== projectId || file.uploadedBy !== user._id) {
    invalid("This screenshot was not uploaded by you for this project.");
  }
}

export async function markAttached(ctx: MutationCtx, fileId: string) {
  const id = ctx.db.normalizeId("captureFiles", fileId);
  if (id !== null) await ctx.db.patch(id, { status: "attached", cleanupAt: undefined });
  const storageId = ctx.db.system.normalizeId("_storage", fileId);
  if (storageId !== null) await markUploadAttached(ctx, storageId);
}

/** Both legacy Convex IDs and R2 metadata IDs remain valid. */
export const authorizedCapture = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, args) => run(async () =>
    await operations.authorizedCapture(convexStore(ctx), await identityOf(ctx), args)),
});

export const fileLocation = internalQuery({
  args: { fileId: captureFileValidator },
  handler: async (ctx, { fileId }) => {
    const id = ctx.db.normalizeId("captureFiles", fileId);
    return id === null ? null : await ctx.db.get(id);
  },
});

/** Claim deletion transactionally so attachment or finalization cannot race it. */
export const claimExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<Doc<"captureFiles">[]> => {
    const now = Date.now();
    const files = await ctx.db.query("captureFiles")
      .withIndex("by_cleanup", q => q.gt("cleanupAt", 0).lte("cleanupAt", now)).take(40);
    const claimed: Doc<"captureFiles">[] = [];
    for (const file of files) {
      const thread = await ctx.db.query("threads").withIndex("by_capture_storage", q => q.eq("capture.storageId", file._id)).first();
      if (thread !== null || file.status === "attached") {
        // Deleted threads retain their original evidence too.
        await ctx.db.patch(file._id, { status: "attached", cleanupAt: undefined });
      } else {
        await ctx.db.patch(file._id, { status: "deleting", cleanupAt: now + RETRY_MS });
        claimed.push(file);
      }
    }
    return claimed;
  },
});

export const deletedObject = internalMutation({
  args: { fileId: v.id("captureFiles") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (file?.status !== "deleting") return;
    // Keep a tombstone and repeat deletion for a day, covering an uncertain/late PUT.
    if (file.createdAt + TOMBSTONE_MS <= Date.now()) await ctx.db.delete(fileId);
    else await ctx.db.patch(fileId, { cleanupAt: Date.now() + UPLOAD_MS });
  },
});

export const cleanUp = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    // Do not lose metadata when credentials are unavailable; report the failure to the scheduler.
    if (captureProvider() === "convex" && !process.env.CRITIQS_R2_ACCOUNT_ID) return;
    const storage = r2Storage(r2Config());
    const files = await ctx.runMutation(internal.captures.claimExpired, {});
    for (let offset = 0; offset < files.length; offset += 4) {
      await Promise.all(files.slice(offset, offset + 4).map(async file => {
        try {
          await storage.remove(file);
          await ctx.runMutation(internal.captures.deletedObject, { fileId: file._id });
        } catch {
          // The deleting row's lease expires and a later cron retries this exact object.
        }
      }));
    }
    if (files.length === 40) await ctx.scheduler.runAfter(0, internal.captures.cleanUp, {});
  },
});
