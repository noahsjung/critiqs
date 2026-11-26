import { canonicalHost, classifyAddress, type ReviewFailure } from "@critiqs/core";
import type { ProxyConfig } from "./config.ts";
import { rewriteCss } from "./css.ts";
import { BodyError, boundedChunks, readDecoded } from "./decompress.ts";
import { FRAME_LABEL, type ReviewDirectory, type ReviewResolution, type ReviewUsageReport } from "./directory.ts";
import type { Egress, EgressOutcome } from "./egress.ts";
import { charsetOf, frameworkHeaders, inboundHeaders, isPrefetch, mediaType, type RequestClass, requestHeaderBytes } from "./headers.ts";
import { decodeHtml, rewriteHtml } from "./html.ts";
import { keyedSlots, slots, windowCounter } from "./limits.ts";
import { failurePage, frameCsp, inertCsp, leavePage, topLevelPage } from "./pages.ts";
import { framePath } from "./paths.ts";
import { type AssetClass, type ProxyRoute, routeRequest, type UrlContext } from "./urls.ts";

// The proxy's HTTP handler. It answers only its own domain: each frame host
// (`v-<label>.<domain>`) serves one viewer's lease of one prototype, read-only
// and without credentials. In order, before anything is fetched: the Host
// must be the domain or one label under it; header and URL sizes are capped
// (cookies aside, which are never read); only GET and HEAD, never an upgrade
// or a service worker; a top-level open gets a notice, not the prototype;
// the lease must resolve now (a client asking about hosts that serve nothing
// is bounded before the backend is asked); and the lease's request window and
// read slots, its link's and its upstream host's, must have room. Then the
// path picks the route (urls.ts), and every upstream read goes through an
// egress (egress.ts) within the body limits. How a response is served is
// decided by `handlingOf`, from the route and the response itself, never from
// what the client says a request is for.

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
  import: (type) => type === "text/css",
  script: (type) => ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript", "application/wasm"].includes(type),
  media: (type) => type.startsWith("audio/") || type.startsWith("video/") || type === "text/vtt",
};

/** What an owner-approved origin may answer: data and static files, never a page. */
function slotMime(type: string): boolean {
  return type === "application/json" || type.endsWith("+json") || (Object.keys(MIME) as AssetClass[]).some((assetClass) => MIME[assetClass](type));
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * What the browser says a request on the prototype's own origin is for. Only
 * a hint: it picks the Accept header upstream, whether framework headers may
 * pass, and which of the proxy's own notices answers a failure. Nothing that
 * keeps a viewer safe depends on it (see `handlingOf`).
 */
function hintOf(request: Request): RequestClass {
  switch (destination(request)) {
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

/** `Sec-Fetch-Dest`, lowercased. */
function destination(request: Request): string {
  return (request.headers.get("sec-fetch-dest") ?? "").toLowerCase();
}

/**
 * How a response is served, from what the proxy itself knows: the route
 * (the proxy wrote every signed asset's class) and the response's own type
 * and status. A page is any HTML on the prototype's origin, however it was
 * asked for, so it is always capped, checked for a sign-in or bot wall and
 * rewritten. Another site's file must have its class's type at any status,
 * and only a success carries a body; an owner-approved origin's answer must
 * be data or a static file at any status.
 */
type Handling = { kind: "page" } | { kind: "style"; imports: "style" | "import" | null } | { kind: "pass"; cap: number } | { kind: "refuse"; status: number };

function handlingOf(route: Extract<ProxyRoute, { kind: "primary" | "slot" | "asset" }>, status: number, type: string, limits: ProxyConfig["limits"]): Handling {
  const ok = status >= 200 && status < 300;
  if (route.kind === "primary") {
    if (HTML_TYPES.has(type)) return { kind: "page" };
    if (type === "text/css" && ok) return { kind: "style", imports: "style" };
    return { kind: "pass", cap: limits.assetBytes };
  }
  const allowed = route.kind === "asset" ? MIME[route.assetClass](type) : slotMime(type);
  if (!allowed) return { kind: "refuse", status: ok ? 502 : status };
  if (route.kind === "slot") return { kind: "pass", cap: type === "application/json" || type.endsWith("+json") ? limits.dataBytes : limits.assetBytes };
  if (!ok) return { kind: "refuse", status };
  if (route.assetClass === "style" || route.assetClass === "import") return { kind: "style", imports: route.assetClass === "style" ? "import" : null };
  return { kind: "pass", cap: limits.assetBytes };
}

/** A client's key for per-client limits: its IPv4 address, or its IPv6 /64, which one subscriber usually holds whole. */
function clientKey(address: string): string {
  const host = canonicalHost(address) ?? address;
  if (!host.includes(":")) return host;
  const groups = host.split("::");
  const head = groups[0]!.split(":").filter((group) => group !== "");
  const tail = groups.length > 1 ? groups[1]!.split(":").filter((group) => group !== "") : [];
  const full = [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/** What the listener knows about a request that the request itself doesn't say. */
export interface RequestInfo {
  /** The viewer's address, from the connection or the trusted header the server in front sets. */
  client: string;
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
  const linkSlots = keyedSlots(limits.concurrentPerLink);
  const hostSlots = keyedSlots(limits.concurrentPerUpstreamHost);
  const lookupMisses = windowCounter({ windowMs: limits.lookupWindowMs, requests: limits.lookupMissesPerClient, bytes: Number.POSITIVE_INFINITY }, now);
  const prefetchSlots = keyedSlots(Math.min(limits.concurrentPrefetchPerLease, limits.concurrentPerLease));
  const windows = windowCounter({ windowMs: limits.windowMs, requests: limits.requestsPerWindow, bytes: limits.bytesPerWindow }, now);
  // Prefetches have their own count, so a framework prefetching every link
  // can't use up what the reviewer opens; their bytes count in `windows`.
  const prefetchWindows = windowCounter({ windowMs: limits.windowMs, requests: limits.prefetchRequestsPerWindow, bytes: Number.POSITIVE_INFINITY }, now);
  const usage = new Map<string, { requests: number; bytes: number }>();

  /** Headers every response carries; anything that isn't one of the proxy's documents is inert and may be framed only by the website. */
  const common = (headers: Headers) => {
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-robots-tag", "noindex, nofollow");
    if (!headers.has("content-security-policy")) headers.set("content-security-policy", inertCsp(config.webOrigins));
    return headers;
  };
  const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
    new Response(text, { status, headers: common(new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra })) });
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
    return headers;
  };

  const bodyFailure = (error: unknown): ReviewFailure => (error instanceof BodyError ? (error.reason === "too-large" ? "too-large" : error.reason === "timeout" ? "timeout" : "unsupported") : "unreachable");

  const refusal = (outcome: Exclude<EgressOutcome, { kind: "response" }>): ReviewFailure => (outcome.kind === "refused" && outcome.reason === "unsafe" ? "unsafe" : "unreachable");

  /** What a request that got no upstream response is answered with: a notice in the frame for a navigation, a bare status otherwise. */
  const refused = (outcome: Exclude<EgressOutcome, { kind: "response" }>, asPage: boolean, head: boolean): Response => {
    if (!asPage) return plain(outcome.kind === "refused" && outcome.reason === "unsafe" ? 403 : 502, "");
    if (outcome.kind === "left") return document(200, leavePage(outcome.url, outcome.signIn, config.webOrigins), head);
    return failure(refusal(outcome), head);
  };

  /** HTML from the prototype's origin, however it was asked for: capped, checked, rewritten and capped again. */
  async function servePage(ctx: UrlContext, lease: ReviewResolution, outcome: Extract<EgressOutcome, { kind: "response" }>, requestedPath: string, signal: AbortSignal, head: boolean): Promise<Response> {
    if (head) {
      void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
      return document(outcome.status, "", true);
    }
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
    const finalPath = framePath(new URL(`${outcome.url.pathname}${outcome.url.search}`, outcome.url));
    const html = rewriteHtml(ctx, text, outcome.url, {
      runtime: deps.assets.runtime.file,
      layer: deps.assets.layer.file,
      panelOrigins: config.webOrigins,
      finalPath: finalPath === requestedPath ? null : finalPath,
    });
    const encoded = new TextEncoder().encode(html);
    if (encoded.byteLength > limits.htmlOutputBytes) return failure("too-large");
    const headers = inboundHeaders(outcome.headers);
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", frameCsp(config.webOrigins));
    return new Response(encoded, { status: outcome.status, headers: common(headers) });
  }

  /** A stylesheet that `handlingOf` accepted: decompressed, rewritten, capped. */
  async function serveStyle(ctx: UrlContext, lease: ReviewResolution, outcome: Extract<EgressOutcome, { kind: "response" }>, imports: "style" | "import" | null, signal: AbortSignal, head: boolean): Promise<Response> {
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
    const css = new TextEncoder().encode(rewriteCss(ctx, text, outcome.url, imports));
    if (css.byteLength > limits.cssOutputBytes) return plain(502, "");
    return new Response(css, { status: outcome.status, headers });
  }

  /** Takes a read slot from every pool a request counts against, or none. */
  const takeSlots = (lease: ReviewResolution, upstreamHost: string, prefetch: boolean): (() => void) | null => {
    const taken: (() => void)[] = [];
    const take = (release: (() => void) | null) => {
      if (release !== null) taken.push(release);
      return release !== null;
    };
    const all =
      take(processSlots.take()) &&
      take(linkSlots.take(lease.linkId)) &&
      take(hostSlots.take(upstreamHost)) &&
      (!prefetch || take(prefetchSlots.take(lease.leaseId))) &&
      take(leaseSlots.take(lease.leaseId));
    if (!all) {
      for (const release of taken) release();
      return null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of taken) release();
    };
  };

  /** The lease a frame host stands for, asking the backend only while this client's misses are within their limit. */
  const leaseFor = async (label: string, client: string, signal: AbortSignal): Promise<ReviewResolution | null> => {
    const key = clientKey(client);
    if (lookupMisses.usage(key).requests >= limits.lookupMissesPerClient) {
      // Over the limit, only hosts the directory already knows still answer; it is asked only after the window.
      return null;
    }
    const lease = await deps.directory.resolve(label, signal);
    if (lease === null) lookupMisses.admit(key);
    return lease;
  };

  async function handle(request: Request, info: RequestInfo = { client: "" }): Promise<Response> {
    // Read-only and credential-free: no method that changes anything, checked before the request's target is even parsed.
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Review links are read-only", { allow: "GET, HEAD" });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400, "Bad request");
    }
    const host = (request.headers.get("host") ?? url.host).toLowerCase();
    // Only the proxy's own domain is answered: another Host is a misdirected request.
    if (host === apex) return notFound();
    if (!host.endsWith(`.${apex}`)) return plain(421, "Misdirected request");
    const label = host.slice(0, -(apex.length + 1));
    if (!FRAME_LABEL.test(label)) return notFound();

    if (requestHeaderBytes(request.headers) > limits.requestHeaderBytes) return plain(431, "Request headers too large");
    if (url.pathname.length + url.search.length > limits.urlBytes) return plain(414, "Address too long");
    // No upgrade (WebSocket) and no service worker.
    if (request.headers.has("upgrade")) return plain(403, "Not supported in review links");
    if (request.headers.has("service-worker")) return plain(403, "Service workers don't run in review links");
    const dest = destination(request);
    // Opened on its own, a frame host shows a notice: never the prototype outside a review page.
    if (dest === "document") return document(403, topLevelPage(), request.method === "HEAD");

    const lease = await leaseFor(label, info.client, request.signal);
    if (lease === null || lease.expiresAt <= now()) return notFound();
    const ctx: UrlContext = { primary: lease.origin, slots: lease.assetOrigins, leaseId: lease.leaseId, secret: config.signingKey, previousSecret: config.previousSigningKey };
    const route = routeRequest(ctx, url);
    if (route.kind === "none") return notFound();
    if (route.kind === "static") {
      const asset = route.file === deps.assets.runtime.file ? deps.assets.runtime : route.file === deps.assets.layer.file ? deps.assets.layer : null;
      if (asset === null) return notFound();
      return new Response(request.method === "HEAD" ? null : asset.body, {
        headers: common(new Headers({ "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=86400, immutable" })),
      });
    }
    const head = request.method === "HEAD";
    if (route.kind === "leave") return document(200, leavePage(route.to, false, config.webOrigins), head);

    // What the browser says the request is for, as a hint only (see `hintOf`).
    const hint: RequestClass = route.kind === "primary" ? hintOf(request) : route.kind === "asset" ? (route.assetClass === "import" ? "style" : route.assetClass) : "data";
    const asPage = route.kind === "primary" && hint === "document";
    // Other sites' files are never pages.
    if (route.kind !== "primary" && ["iframe", "frame", "document", "embed", "object"].includes(dest)) return notFound();

    // A page is never a prefetch here: the frame's own navigation is what the reviewer opened.
    const prefetch = !asPage && isPrefetch(request.headers);
    if (prefetch) {
      // Out of prefetches, or out of bytes: refused without fetching; the framework fetches again when the reviewer navigates.
      if (windows.usage(lease.leaseId).bytes >= limits.bytesPerWindow || !prefetchWindows.admit(lease.leaseId)) return plain(429, "Too many prefetches");
    } else if (!windows.admit(lease.leaseId)) return asPage ? failure("busy", head) : plain(429, "Too many requests");
    const entry = usage.get(lease.linkId) ?? { requests: 0, bytes: 0 };
    entry.requests++;
    usage.set(lease.linkId, entry);
    const release = takeSlots(lease, canonicalHost(route.upstream.hostname) ?? route.upstream.hostname, prefetch);
    if (release === null) return asPage ? failure("busy", head) : plain(503, "Busy", { "retry-after": "2" });

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limits.headersTimeoutMs + limits.bodyTimeoutMs)]);
    const method = head ? "HEAD" : "GET";
    let streaming = false;
    try {
      const egress = route.kind === "asset" ? deps.egress.asset : deps.egress.primary;
      // The prototype's own data requests may carry its framework's headers, each checked by name and shape.
      const framework = route.kind === "primary" && hint === "data" ? frameworkHeaders(request.headers) : {};
      const origin = route.kind === "primary" ? lease.origin : route.upstream.origin;
      const outcome = await egress.fetch({ url: route.upstream, method, class: hint, origin, framework, signal });
      if (outcome.kind !== "response") return refused(outcome, asPage, head);
      const handling = handlingOf(route, outcome.status, mediaType(outcome.headers["content-type"]), limits);
      if (handling.kind === "page") return await servePage(ctx, lease, outcome, framePath(new URL(`${url.pathname}${url.search}`, url)), signal, head);
      if (handling.kind === "style") return await serveStyle(ctx, lease, outcome, handling.imports, signal, head);
      if (handling.kind === "refuse") {
        // Never a page, JSON or text from another site's address, whatever it claims or answers.
        void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        return plain(handling.status, "");
      }
      streaming = true;
      return stream(outcome.status, passHeaders(outcome.headers), outcome.body, handling.cap, signal, lease, release, head);
    } catch (error) {
      return asPage ? failure(bodyFailure(error), head) : plain(502, "");
    } finally {
      if (!streaming) release();
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
