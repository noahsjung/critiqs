import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@critiqs/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { r2Config, r2Storage } from "./lib/r2";

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

/** Bounded streaming read: Content-Length is only an early check, never trusted. */
export async function readCaptureBody(request: Request): Promise<ArrayBuffer> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) {
    throw new ConvexError({ code: "too-large", message: "Images are limited to 10 MB." });
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ConvexError({ code: "invalid", message: "The image is empty." });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new ConvexError({ code: "too-large", message: "Images are limited to 10 MB." });
    }
    chunks.push(value);
  }
  if (size === 0) throw new ConvexError({ code: "invalid", message: "The image is empty." });
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body.buffer;
}

export const uploadCapture = httpAction(async (ctx, request): Promise<Response> => {
  try {
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

export const downloadCapture = httpAction(async (ctx, request): Promise<Response> => {
  try {
    const threadId = new URL(request.url).searchParams.get("threadId");
    if (threadId === null) return new Response("Missing threadId", { status: 400, headers: CAPTURE_CORS });
    const fileId = await ctx.runQuery(internal.captures.authorizedCapture, { threadId });
    if (fileId === null) return new Response("No capture", { status: 404, headers: CAPTURE_CORS });
    const location = await ctx.runQuery(internal.captures.fileLocation, { fileId: fileId as Id<"_storage"> | Id<"captureFiles"> });
    const headers = {
      ...CAPTURE_CORS,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    };
    if (location !== null) {
      if (location.status !== "attached") return new Response("No capture", { status: 404, headers });
      const response = await r2Storage(r2Config()).get(location);
      return response === null
        ? new Response("No capture", { status: 404, headers })
        : new Response(response.body, { headers: { ...headers, "Content-Type": location.contentType ?? "application/octet-stream" } });
    }
    const image = await ctx.storage.get(fileId as Id<"_storage">);
    return image === null
      ? new Response("No capture", { status: 404, headers })
      : new Response(image, { headers: { ...headers, "Content-Type": IMAGE_TYPES.includes(image.type) ? image.type : "application/octet-stream" } });
  } catch (error) {
    return failure(error);
  }
});

/** A mockup's page copy as HTML text, for reviewers who can read its project; never rendered from here. */
export const downloadSnapshot = httpAction(async (ctx, request): Promise<Response> => {
  try {
    const snapshotId = new URL(request.url).searchParams.get("snapshotId");
    if (snapshotId === null) return new Response("Missing snapshotId", { status: 400, headers: CAPTURE_CORS });
    const storageId = await ctx.runQuery(internal.mockups.authorizedSnapshot, { snapshotId });
    const headers = {
      ...CAPTURE_CORS,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    };
    const file = await ctx.storage.get(storageId);
    return file === null
      ? new Response("No page copy", { status: 404, headers })
      : new Response(file, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    return failure(error);
  }
});
