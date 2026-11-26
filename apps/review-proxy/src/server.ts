import { classifyAddress, type ReviewFailure } from "@critiqs/core";
import type { ProxyConfig } from "./config.ts";
import { rewriteCss } from "./css.ts";
import { BodyError, boundedChunks, readDecoded } from "./decompress.ts";
import { FRAME_LABEL, type ReviewDirectory, type ReviewResolution, type ReviewUsageReport } from "./directory.ts";
import type { Egress, EgressOutcome } from "./egress.ts";
import { charsetOf, frameworkHeaders, inboundHeaders, isPrefetch, mediaType, type RequestClass, requestHeaderBytes } from "./headers.ts";
import { decodeHtml, rewriteHtml } from "./html.ts";
import { keyedSlots, slots, windowCounter } from "./limits.ts";
import { ASSET_CSP, failurePage, frameCsp, leavePage, topLevelPage } from "./pages.ts";
import { type AssetClass, routeRequest, type UrlContext } from "./urls.ts";

// The proxy's HTTP handler. It answers only its own domain: each frame host
// (`v-<label>.<domain>`) serves one viewer's lease of one prototype, read-only
// and without credentials. In order, before anything is fetched: the Host
// must be the domain or one label under it; header and URL sizes are capped
// (cookies aside, which are never read); only GET and HEAD, never an upgrade
// or a service worker; a top-level open gets a notice, not the prototype;
// the lease must resolve now; and the lease's request window and read slots
// must have room. Then the path picks the route (urls.ts), and every upstream
// read goes through an egress (egress.ts) within the body limits.

/** The two scripts put in every page, built by `scripts/build-assets.ts`. */
export interface ProxyAssets {
  runtime: { file: string; body: string };
  layer: { file: string; body: string };
}

export interface ProxyDeps {
  directory: ReviewDirectory;
  /** `primary` sends the review user agent (a link's own and owner-approved origins); `asset` the non-privileged one (third-party files). */
  egress: { primary: Egress; asset: Egress };
  assets: ProxyAssets;
  now?: () => number;
}

const MIME: Record<AssetClass, (type: string) => boolean> = {
  image: (type) => type.startsWith("image/"),
  font: (type) => type.startsWith("font/") || /^application\/(?:x-)?font-/.test(type) || type === "application/vnd.ms-fontobject" || type === "application/octet-stream",
  style: (type) => type === "text/css",
  script: (type) => ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript", "application/wasm"].includes(type),
  media: (type) => type.startsWith("audio/") || type.startsWith("video/") || type === "text/vtt",
};

/** What an owner-approved origin may answer: data and static files, never a page. */
function slotMime(type: string): boolean {
  return type === "application/json" || type.endsWith("+json") || (Object.keys(MIME) as AssetClass[]).some((assetClass) => MIME[assetClass](type));
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** The class of a request on the prototype's own origin, from what the browser says it is for. */
function classOf(request: Request): RequestClass {
  switch (request.headers.get("sec-fetch-dest")) {
    case "style":
      return "style";
    case "script":
    case "worker":
    case "sharedworker":
    case "serviceworker":
    case "audioworklet":
    case "paintworklet":
      return "script";
    case "image":
      return "image";
    case "font":
      return "font";
    case "audio":
    case "video":
    case "track":
      return "media";
    case "empty":
    case "manifest":
    case "report":
    case "json":
      return "data";
    default:
      // A frame's navigation (`iframe`), or a client that doesn't say: treated as a page, which is rewritten.
      return "document";
  }
}

const STATUS: Record<ReviewFailure, number> = {
  unreachable: 502,
  blocked: 403,
  "needs-sign-in": 401,
  "too-large": 502,
  timeout: 504,
  unsafe: 403,
  unsupported: 502,
  busy: 503,
  "not-found": 404,
};

export function createReviewProxy(config: ProxyConfig, deps: ProxyDeps) {
  const now = deps.now ?? Date.now;
  const apex = config.domain.host.toLowerCase();
  const limits = config.limits;
  const processSlots = slots(limits.concurrentPerProcess);
  const leaseSlots = keyedSlots(limits.concurrentPerLease);
  const prefetchSlots = keyedSlots(Math.min(limits.concurrentPrefetchPerLease, limits.concurrentPerLease));
  const windows = windowCounter({ windowMs: limits.windowMs, requests: limits.requestsPerWindow, bytes: limits.bytesPerWindow }, now);
  // Prefetches have their own count, so a framework prefetching every link
  // can't use up what the reviewer opens; their bytes count in `windows`.
  const prefetchWindows = windowCounter({ windowMs: limits.windowMs, requests: limits.prefetchRequestsPerWindow, bytes: Number.POSITIVE_INFINITY }, now);
  const usage = new Map<string, { requests: number; bytes: number }>();

  const common = (headers: Headers) => {
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-robots-tag", "noindex, nofollow");
    return headers;
  };
  const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
    new Response(text, { status, headers: common(new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": ASSET_CSP, ...extra })) });
  const document = (status: number, html: string, head = false) =>
    new Response(head ? null : html, {
      status,
      headers: common(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": frameCsp(config.webOrigins) })),
    });
  const failure = (reason: ReviewFailure, head = false) => document(STATUS[reason], failurePage(reason, config.webOrigins), head);
  /** One answer for every host that serves nothing, so none can be told apart. */
  const notFound = () => plain(404, "Not found");

  const count = (lease: ReviewResolution, bytes: number) => {
    windows.addBytes(lease.leaseId, bytes);
    const entry = usage.get(lease.linkId) ?? { requests: 0, bytes: 0 };
    entry.bytes += bytes;
    usage.set(lease.linkId, entry);
  };

  /** A response streaming `body` within `wireBytes`, releasing `release` however it ends. */
  const stream = (status: number, headers: Headers, body: AsyncIterable<Uint8Array>, wireBytes: number, signal: AbortSignal, lease: ReviewResolution, release: () => void, head: boolean) => {
    if (head) {
      void body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
      release();
      return new Response(null, { status, headers });
    }
    const chunks = boundedChunks(body, { wireBytes, idleMs: limits.idleTimeoutMs, totalMs: limits.bodyTimeoutMs }, signal, (bytes) => count(lease, bytes))[Symbol.asyncIterator]();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      release();
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const step = await chunks.next();
            if (step.done) {
              finish();
              controller.close();
            } else controller.enqueue(step.value);
          } catch (error) {
            finish();
            controller.error(error);
          }
        },
        async cancel() {
          finish();
          await chunks.return?.(undefined);
        },
      }),
      { status, headers },
    );
  };

  /** Response headers for a file passed through unchanged: allowed upstream headers, its encoding, and inert as a page. */
  const passHeaders = (upstream: Record<string, string>) => {
    const headers = common(inboundHeaders(upstream));
    const encoding = upstream["content-encoding"];
    if (encoding !== undefined && /^(?:gzip|br)$/i.test(encoding.trim())) headers.set("content-encoding", encoding.trim().toLowerCase());
    headers.set("content-security-policy", ASSET_CSP);
    return headers;
  };

  const bodyFailure = (error: unknown): ReviewFailure => (error instanceof BodyError ? (error.reason === "too-large" ? "too-large" : error.reason === "timeout" ? "timeout" : "unsupported") : "unreachable");

  const refusal = (outcome: Exclude<EgressOutcome, { kind: "response" }>): ReviewFailure => (outcome.kind === "refused" && outcome.reason === "unsafe" ? "unsafe" : "unreachable");

  async function servePage(ctx: UrlContext, lease: ReviewResolution, outcome: EgressOutcome, requestedPath: string, signal: AbortSignal, head: boolean, release: () => void): Promise<Response> {
    if (outcome.kind === "left") {
      release();
      return outcome.signIn ? document(200, leavePage(outcome.url, true, config.webOrigins), head) : document(200, leavePage(outcome.url, false, config.webOrigins), head);
    }
    if (outcome.kind === "refused") {
      release();
      return failure(refusal(outcome), head);
    }
    const type = mediaType(outcome.headers["content-type"]);
    if (!HTML_TYPES.has(type)) {
      // A page that isn't HTML, such as an image opened in the frame: served as it is, inert as a document.
      return stream(outcome.status, passHeaders(outcome.headers), outcome.body, limits.assetBytes, signal, lease, release, head);
    }
    if (head) {
      void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
      release();
      return document(outcome.status, "", true);
    }
    try {
      let bytes: Uint8Array;
      try {
        bytes = await readDecoded(outcome.body, outcome.headers["content-encoding"], { wireBytes: limits.htmlInputBytes, decodedBytes: limits.htmlInputBytes, idleMs: limits.idleTimeoutMs, totalMs: limits.bodyTimeoutMs }, signal);
      } catch (error) {
        return failure(bodyFailure(error));
      }
      count(lease, bytes.byteLength);
      const text = decodeHtml(bytes, charsetOf(outcome.headers["content-type"]));
      if (text === null) return failure("unsupported");
      // Onboarding's own reading of a response: a bot wall or a sign-in page is named, not shown.
      const check = classifyAddress({ hops: [{ url: outcome.url.href, status: outcome.status, headers: outcome.headers }], html: text });
      if (check.kind === "blocked") return failure("blocked");
      if (check.kind === "sign-in" || outcome.status === 401) return failure("needs-sign-in");
      const finalPath = `${outcome.url.pathname}${outcome.url.search}`;
      const html = rewriteHtml(ctx, text, outcome.url, {
        runtime: deps.assets.runtime.file,
        layer: deps.assets.layer.file,
        panelOrigins: config.webOrigins,
        finalPath: finalPath === requestedPath ? null : finalPath,
      });
      const encoded = new TextEncoder().encode(html);
      if (encoded.byteLength > limits.htmlOutputBytes) return failure("too-large");
      const headers = common(inboundHeaders(outcome.headers));
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("content-security-policy", frameCsp(config.webOrigins));
      return new Response(encoded, { status: outcome.status, headers });
    } finally {
      release();
    }
  }

  async function serveStyle(ctx: UrlContext, lease: ReviewResolution, outcome: Extract<EgressOutcome, { kind: "response" }>, signal: AbortSignal, head: boolean, release: () => void): Promise<Response> {
    try {
      if (mediaType(outcome.headers["content-type"]) !== "text/css" || outcome.status < 200 || outcome.status >= 300) {
        void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        return plain(outcome.status >= 200 && outcome.status < 300 ? 502 : outcome.status, "");
      }
      const headers = passHeaders(outcome.headers);
      headers.delete("content-encoding");
      headers.set("content-type", "text/css; charset=utf-8");
      if (head) {
        void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        return new Response(null, { status: outcome.status, headers });
      }
      let bytes: Uint8Array;
      try {
        bytes = await readDecoded(outcome.body, outcome.headers["content-encoding"], { wireBytes: limits.cssInputBytes, decodedBytes: limits.cssInputBytes, idleMs: limits.idleTimeoutMs, totalMs: limits.bodyTimeoutMs }, signal);
      } catch {
        return plain(502, "");
      }
      count(lease, bytes.byteLength);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return plain(502, "");
      }
      const css = new TextEncoder().encode(rewriteCss(ctx, text, outcome.url));
      if (css.byteLength > limits.cssOutputBytes) return plain(502, "");
      return new Response(css, { status: outcome.status, headers });
    } finally {
      release();
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? url.host).toLowerCase();
    // Only the proxy's own domain is answered: another Host is a misdirected request.
    if (host === apex) return notFound();
    if (!host.endsWith(`.${apex}`)) return plain(421, "Misdirected request");
    const label = host.slice(0, -(apex.length + 1));
    if (!FRAME_LABEL.test(label)) return notFound();

    if (requestHeaderBytes(request.headers) > limits.requestHeaderBytes) return plain(431, "Request headers too large");
    if (url.pathname.length + url.search.length > limits.urlBytes) return plain(414, "Address too long");
    // Read-only and credential-free: no upgrade (WebSocket), no method that changes anything.
    if (request.headers.has("upgrade")) return plain(403, "Not supported in review links");
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Review links are read-only", { allow: "GET, HEAD" });
    if (request.headers.has("service-worker")) return plain(403, "Service workers don't run in review links");
    // Opened on its own, a frame host shows a notice: never the prototype outside a review page.
    if (request.headers.get("sec-fetch-dest") === "document") return document(403, topLevelPage(), request.method === "HEAD");

    const lease = await deps.directory.resolve(label, request.signal);
    if (lease === null || lease.expiresAt <= now()) return notFound();
    const ctx: UrlContext = { primary: lease.origin, slots: lease.assetOrigins, leaseId: lease.leaseId, secret: config.secret };
    const route = routeRequest(ctx, url);
    if (route.kind === "none") return notFound();
    if (route.kind === "static") {
      const asset = route.file === deps.assets.runtime.file ? deps.assets.runtime : route.file === deps.assets.layer.file ? deps.assets.layer : null;
      if (asset === null) return notFound();
      return new Response(request.method === "HEAD" ? null : asset.body, {
        headers: common(new Headers({ "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=86400, immutable", "content-security-policy": ASSET_CSP })),
      });
    }
    const head = request.method === "HEAD";
    if (route.kind === "leave") return document(200, leavePage(route.to, false, config.webOrigins), head);

    const requestClass = route.kind === "primary" ? classOf(request) : route.kind === "asset" ? route.assetClass : "data";
    const asPage = requestClass === "document";
    // Other sites' files are never pages.
    if (route.kind !== "primary" && ["iframe", "frame", "document", "embed", "object"].includes(request.headers.get("sec-fetch-dest") ?? "")) return notFound();

    // A page is never a prefetch here: the frame's own navigation is what the reviewer opened.
    const prefetch = !asPage && isPrefetch(request.headers);
    if (prefetch) {
      // Out of prefetches, or out of bytes: refused without fetching; the framework fetches again when the reviewer navigates.
      if (windows.usage(lease.leaseId).bytes >= limits.bytesPerWindow || !prefetchWindows.admit(lease.leaseId)) return plain(429, "Too many prefetches");
    } else if (!windows.admit(lease.leaseId)) return asPage ? failure("busy", head) : plain(429, "Too many requests");
    const entry = usage.get(lease.linkId) ?? { requests: 0, bytes: 0 };
    entry.requests++;
    usage.set(lease.linkId, entry);
    const releaseProcess = processSlots.take();
    const releasePrefetch = releaseProcess === null || !prefetch ? null : prefetchSlots.take(lease.leaseId);
    const releaseLease = releaseProcess === null || (prefetch && releasePrefetch === null) ? null : leaseSlots.take(lease.leaseId);
    if (releaseProcess === null || releaseLease === null) {
      releasePrefetch?.();
      releaseProcess?.();
      return asPage ? failure("busy", head) : plain(503, "Busy", { "retry-after": "2" });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releasePrefetch?.();
      releaseLease();
      releaseProcess();
    };

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limits.headersTimeoutMs + limits.bodyTimeoutMs)]);
    const method = head ? "HEAD" : "GET";
    try {
      if (route.kind === "primary") {
        // The prototype's own data requests may carry its framework's headers, each checked by name and shape.
        const framework = requestClass === "data" ? frameworkHeaders(request.headers) : {};
        const outcome = await deps.egress.primary.fetch({ url: route.upstream, method, class: requestClass, origin: lease.origin, framework, signal });
        if (asPage) return await servePage(ctx, lease, outcome, `${url.pathname}${url.search}`, signal, head, release);
        if (outcome.kind !== "response") {
          release();
          return plain(outcome.kind === "refused" && outcome.reason === "unsafe" ? 403 : 502, "");
        }
        if (requestClass === "style") return await serveStyle(ctx, lease, outcome, signal, head, release);
        return stream(outcome.status, passHeaders(outcome.headers), outcome.body, limits.assetBytes, signal, lease, release, head);
      }

      const egress = route.kind === "asset" ? deps.egress.asset : deps.egress.primary;
      const outcome = await egress.fetch({ url: route.upstream, method, class: requestClass, origin: route.upstream.origin, signal });
      if (outcome.kind !== "response") {
        release();
        return plain(outcome.kind === "refused" && outcome.reason === "unsafe" ? 403 : 502, "");
      }
      const type = mediaType(outcome.headers["content-type"]);
      const allowed = route.kind === "asset" ? MIME[route.assetClass](type) : slotMime(type);
      if (outcome.status >= 200 && outcome.status < 300 && !allowed) {
        // Never a page, JSON or text from another site's address, whatever it claims.
        void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        release();
        return plain(502, "");
      }
      if (route.kind === "asset" && route.assetClass === "style") return await serveStyle(ctx, lease, outcome, signal, head, release);
      const cap = route.kind === "slot" && (type === "application/json" || type.endsWith("+json")) ? limits.dataBytes : limits.assetBytes;
      return stream(outcome.status, passHeaders(outcome.headers), outcome.body, cap, signal, lease, release, head);
    } catch (error) {
      release();
      return asPage ? failure(bodyFailure(error), head) : plain(502, "");
    }
  }

  return {
    fetch: handle,
    /** Traffic per link since the last call, for the backend's daily limits. */
    takeUsage(): ReviewUsageReport[] {
      const reports = [...usage].map(([linkId, entry]) => ({ linkId, ...entry }));
      usage.clear();
      return reports;
    },
    /** Sends the traffic since the last report to the directory; kept for the next try if it fails. */
    async reportUsage(): Promise<void> {
      const reports = [...usage].map(([linkId, entry]) => ({ linkId, ...entry }));
      if (reports.length === 0) return;
      usage.clear();
      try {
        await deps.directory.report(reports);
      } catch {
        for (const report of reports) {
          const entry = usage.get(report.linkId) ?? { requests: 0, bytes: 0 };
          entry.requests += report.requests;
          entry.bytes += report.bytes;
          usage.set(report.linkId, entry);
        }
      }
    },
    /** Reads in flight, for tests and health checks. */
    get inFlight() {
      return processSlots.used;
    },
  };
}

export type ReviewProxy = ReturnType<typeof createReviewProxy>;
