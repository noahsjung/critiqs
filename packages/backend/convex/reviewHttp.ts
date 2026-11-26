import { HOST_HASH, proxyAuthorized, REVIEW_LINK_LIMITS } from "@critiqs/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { reviewSetup } from "./reviewLinks";

// The routes only the review proxy calls (`/internal/review/v1/*`). Each
// needs `Authorization: Bearer <CRITIQS_PROXY_SECRET>`, compared in constant
// time; without it, with review links off, or for anything that serves
// nothing, the answer is the same bare 404, so the routes reveal nothing to
// anyone else, not even that they exist.

/** The largest body either route reads: a full batch of usage reports. */
const MAX_BODY = 128 * 1024;

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/** The request's JSON body when the proxy sent it and review links are on; null for anything else. */
async function proxyBody(request: Request): Promise<unknown> {
  // During a rotation the proxy may still send the previous secret (CRITIQS_PROXY_SECRET_PREVIOUS); remove it once every proxy has the new one.
  if (!(await proxyAuthorized(request.headers.get("Authorization"), process.env.CRITIQS_PROXY_SECRET, process.env.CRITIQS_PROXY_SECRET_PREVIOUS))) return null;
  if (reviewSetup() === null) return null;
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `POST /internal/review/v1/resolve` `{ hostHash }` → `ReviewResolution`, or 404. */
export const resolve = httpAction(async (ctx, request) => {
  const body = (await proxyBody(request)) as { hostHash?: unknown } | null;
  if (body === null || typeof body !== "object" || typeof body.hostHash !== "string" || !HOST_HASH.test(body.hostHash)) return notFound();
  const resolution = await ctx.runQuery(internal.reviewLinks.resolveHost, { hostHash: body.hostHash });
  if (resolution === null) return notFound();
  return Response.json(resolution, { headers: { "Cache-Control": "no-store" } });
});

/** `POST /internal/review/v1/usage` `{ reports: { linkId, requests, bytes }[] }` → `{ paused: linkId[] }`, or 404. */
export const usage = httpAction(async (ctx, request) => {
  const body = (await proxyBody(request)) as { reports?: unknown } | null;
  if (body === null || typeof body !== "object" || !Array.isArray(body.reports) || body.reports.length > REVIEW_LINK_LIMITS.usageReports) {
    return notFound();
  }
  const reports: { linkId: string; requests: number; bytes: number }[] = [];
  for (const entry of body.reports as unknown[]) {
    if (entry === null || typeof entry !== "object") return notFound();
    const { linkId, requests, bytes } = entry as Record<string, unknown>;
    if (typeof linkId !== "string" || linkId.length > 64 || !Number.isSafeInteger(requests) || !Number.isSafeInteger(bytes)) return notFound();
    if ((requests as number) < 0 || (bytes as number) < 0) return notFound();
    reports.push({ linkId, requests: requests as number, bytes: bytes as number });
  }
  const result = await ctx.runMutation(internal.reviewLinks.recordUsage, { reports });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
});
