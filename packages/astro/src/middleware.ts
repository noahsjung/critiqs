// Marks each page with the route Astro rendered it from, so the browser can
// tell a page from the 404 page shown at its URL: <ClientRouter /> swaps in
// whatever HTML a navigation gets, whatever its status, and the URL then
// matches the route asked for. Static pages are marked when the site builds.
import type { MiddlewareHandler } from "astro";
import { ROUTE_META } from "./marker.js";

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();
  const type = response.headers.get("content-type") ?? "";
  if (response.body === null || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(type)) return response;
  // Read after the page renders: a rewrite changes the route.
  const meta = `<meta name="${ROUTE_META}" content="${escapeAttribute(context.routePattern)}">`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(response.body.pipeThrough(afterHead(meta)), { status: response.status, statusText: response.statusText, headers });
};

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Puts `text` straight after the document's `<head>` tag, streaming the rest through. A page without one is passed on unchanged. */
export function afterHead(text: string): TransformStream<Uint8Array | string, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // What has come before the `<head>` tag; null once the text is in.
  let pending: string | null = "";
  return new TransformStream({
    transform(chunk, controller) {
      const decoded = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      if (pending === null) {
        if (decoded !== "") controller.enqueue(encoder.encode(decoded));
        return;
      }
      pending += decoded;
      const head = /<head(?:\s[^>]*)?>/i.exec(pending);
      if (head === null) return;
      const at = head.index + head[0].length;
      controller.enqueue(encoder.encode(pending.slice(0, at) + text + pending.slice(at)));
      pending = null;
    },
    flush(controller) {
      const rest = (pending ?? "") + decoder.decode();
      if (rest !== "") controller.enqueue(encoder.encode(rest));
    },
  });
}
