import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@critiqs/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { r2Config, r2Storage } from "./lib/r2";
import { readUploadBody, storeUpload } from "./uploads";

// Bearer-token requests, without cookies, can come from any host prototype.
export const CAPTURE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  Vary: "Authorization",
};

function failure(error: unknown) {
  if (error instanceof ConvexError) {
    const data = error.data as { code: string; message: string };
    const status = ({ unauthenticated: 401, "email-unverified": 403, forbidden: 403, "not-found": 404, unavailable: 404, "too-large": 413, invalid: 400, "plan-limit": 429 } as Record<string, number>)[data.code] ?? 400;
    return new Response(data.message, { status, headers: CAPTURE_CORS });
  }
  // Provider responses and request signatures must never appear in errors.
  return new Response("Screenshot storage is unavailable. Try again shortly.", { status: 503, headers: CAPTURE_CORS });
}

/** Bounded streaming read of an image: Content-Length is only an early check, never trusted. */
export async function readCaptureBody(request: Request): Promise<ArrayBuffer> {
  return await readUploadBody(request, MAX_IMAGE_BYTES, "Images are limited to 10 MB.");
}

export const uploadCapture = httpAction(async (ctx, request): Promise<Response> => {
  try {
    // An upload reserved in Convex's own storage.
    if (new URL(request.url).searchParams.has("uploadId")) return stored(await storeUpload(ctx, request, "capture"));
    const fileId = new URL(request.url).searchParams.get("fileId");
    if (fileId === null) throw new ConvexError({ code: "invalid", message: "Missing fileId." });
    const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    const file = await ctx.runMutation(internal.captures.beginUpload, { fileId, contentType });
    const body = await readCaptureBody(request);
    await r2Storage(r2Config()).put(file, body, contentType);
    await ctx.runMutation(internal.captures.finishUpload, { fileId: file._id, size: body.byteLength });
    return Response.json({ storageId: file._id }, { headers: { ...CAPTURE_CORS, "Cache-Control": "no-store" } });
  } catch (error) {
    // The reservation remains discoverable for cleanup even if PUT succeeded but finalization failed.
    return failure(error);
  }
});

/** Stores a mockup's page copy, reserved by `mockups.generateUploadUrl`, in Convex's own storage. */
export const uploadSnapshot = httpAction(async (ctx, request): Promise<Response> => {
  try {
    return stored(await storeUpload(ctx, request, "pageCopy"));
  } catch (error) {
    return failure(error);
  }
});

function stored(storageId: string): Response {
  return Response.json({ storageId }, { headers: { ...CAPTURE_CORS, "Cache-Control": "no-store" } });
}

const DOWNLOAD_HEADERS = {
  ...CAPTURE_CORS,
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cache-Control": "private, no-store",
};

/**
 * A thread's image, by its thread's ID (`threadId`) or by its thread page's
 * key (`threadPage`), each after the same checks as reading the thread or
 * opening the page. Access is checked before a file is fetched and again once
 * it has been, right before any of it is returned: access, or the file
 * itself, can change while storage answers. A thread's image is returned only
 * if the thread still uses that same file.
 */
export const downloadCapture = httpAction(async (ctx, request): Promise<Response> => {
  try {
    const params = new URL(request.url).searchParams;
    const threadId = params.get("threadId");
    const key = params.get("threadPage");
    if (threadId === null && key === null) return new Response("Missing threadId", { status: 400, headers: CAPTURE_CORS });
    const authorized = async () =>
      key !== null
        ? await ctx.runQuery(internal.captures.authorizedPageCapture, { key })
        : await ctx.runQuery(internal.captures.authorizedCapture, { threadId: threadId! });
    const fileId = await authorized();
    const missing = () => new Response("No capture", { status: 404, headers: DOWNLOAD_HEADERS });
    if (fileId === null) return missing();
    const stillUsed = async () => (await authorized()) === fileId;
    const location = await ctx.runQuery(internal.captures.fileLocation, { fileId: fileId as Id<"_storage"> | Id<"captureFiles"> });
    if (location !== null) {
      if (location.status !== "attached") return missing();
      const response = await r2Storage(r2Config()).get(location);
      if (response === null) return missing();
      // Read the whole image (at most 10 MB) before checking again, so none of it is sent unless access still holds once storage has finished.
      const bytes = await new Response(response.body).arrayBuffer();
      const current = await ctx.runQuery(internal.captures.fileLocation, { fileId: location._id });
      if (!(await stillUsed()) || current?.status !== "attached") return missing();
      return new Response(bytes, { headers: { ...DOWNLOAD_HEADERS, "Content-Type": location.contentType ?? "application/octet-stream" } });
    }
    const image = await ctx.storage.get(fileId as Id<"_storage">);
    if (image === null || !(await stillUsed())) return missing();
    return new Response(image, { headers: { ...DOWNLOAD_HEADERS, "Content-Type": IMAGE_TYPES.includes(image.type) ? image.type : "application/octet-stream" } });
  } catch (error) {
    return failure(error);
  }
});

/** A mockup's page copy as HTML text, for reviewers who can read its project; never rendered from here. Checked again once fetched, like captures. */
export const downloadSnapshot = httpAction(async (ctx, request): Promise<Response> => {
  try {
    const snapshotId = new URL(request.url).searchParams.get("snapshotId");
    if (snapshotId === null) return new Response("Missing snapshotId", { status: 400, headers: CAPTURE_CORS });
    const storageId = await ctx.runQuery(internal.mockups.authorizedSnapshot, { snapshotId });
    const file = await ctx.storage.get(storageId);
    // Throws, as before the fetch, if access ended or the copy was deleted meanwhile.
    const still = file === null ? null : await ctx.runQuery(internal.mockups.authorizedSnapshot, { snapshotId });
    return file === null || still !== storageId
      ? new Response("No page copy", { status: 404, headers: DOWNLOAD_HEADERS })
      : new Response(file, { headers: { ...DOWNLOAD_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    return failure(error);
  }
});
