import { canonicalHost, classifyAddress, REVIEW_FILE_TIMING, REVIEW_LIMITED_TIMING, REVIEW_REFUSED_TIMING, type ReviewFailure } from "@critiqs/core";
import { clientKey } from "./clients.ts";
import type { ProxyConfig } from "./config.ts";
import { rewriteCss } from "./css.ts";
import { BodyError, boundedChunks, readDecoded } from "./decompress.ts";
import { FRAME_LABEL, type ReviewDirectory, type ReviewResolution, type ReviewUsageReport } from "./directory.ts";
import type { Egress, EgressOutcome } from "./egress.ts";
import { type ContentType, charsetOf, contentType, contentTypeHeader, frameworkHeaders, inboundHeaders, isPrefetch, type RequestClass, requestHeaderBytes } from "./headers.ts";
import { decodeHtml, rewriteHtml } from "./html.ts";
import { budget, type Claim, keyedSlots, slotLine, slots, windowCounter } from "./limits.ts";
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
// is bounded before the backend is asked, except for hosts it has seen live;
// a backend that can't be asked is said so, never taken for "nothing here");
// and the lease's request budget must have room (pages and data, or files),
// and a read slot of its own, its link's and its upstream host's, waited for
// briefly when there is none.
// Then the path picks the route (urls.ts), and every upstream read goes
// through an egress (egress.ts) within the body limits. How a response is
// served is decided by `handlingOf`, from the route and the response's type
// as a browser reads it, never from what the client says a request is for:
// the only documents a frame host serves are the proxy's own pages.

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
 * and status, read as a browser reads it (`contentType`). A page is any HTML
 * on the prototype's origin, however it was asked for and however its type is
 * spelled, so it is always capped, checked for a sign-in or bot wall and
 * rewritten. Everything else passed through is served so that it can never
 * be a document in the frame (`passHeaders`): XML, SVG, a type the proxy
 * doesn't know, or none. Another site's file must have its class's type at
 * any status, and only a success carries a body; an owner-approved origin's
 * answer must be data or a static file at any status.
 */
type Handling = { kind: "page" } | { kind: "style"; imports: "style" | "import" | null } | { kind: "pass"; cap: number } | { kind: "refuse"; status: number };

/** What the browser says a page's own file is for: these count against the files' budget, not the pages'. */
const FILE_HINTS: ReadonlySet<RequestClass> = new Set(["image", "font", "style", "script", "media"]);

function handlingOf(route: Extract<ProxyRoute, { kind: "primary" | "slot" | "asset" }>, hint: RequestClass, status: number, parsed: ContentType | null, limits: ProxyConfig["limits"]): Handling {
  const ok = status >= 200 && status < 300;
  const type = parsed?.essence ?? "";
  if (route.kind === "primary") {
    // A request that said it was for a file got a page: served as a file that can't be a document, never rewritten, so the files' budget can't open pages.
    if (HTML_TYPES.has(type)) return FILE_HINTS.has(hint) ? { kind: "pass", cap: limits.assetBytes } : { kind: "page" };
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

/** What the listener knows about a request that the request itself doesn't say. */
export interface RequestInfo {
  /** The viewer's address as the trusted header the server in front sets it (a list's last entry counts), or else the connection's. */
  client: string;
  /** The connection's own address, used when `client` isn't an address. */
  peer?: string;
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
  limited: 429,
  offline: 503,
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
  const line = slotLine({ maxWaiting: limits.queuedPerProcess, maxPerLine: limits.queuedPerLease });
  // Per lease: pages and data, a page's own files, prefetches (so a framework
  // prefetching every link can't use up what the reviewer opens), and bytes
  // of all three. Each refills evenly over the window.
  const pageBudget = budget({ capacity: limits.requestsPerWindow, windowMs: limits.windowMs }, now);
  const fileBudget = budget({ capacity: limits.fileRequestsPerWindow, windowMs: limits.windowMs }, now);
  const prefetchBudget = budget({ capacity: limits.prefetchRequestsPerWindow, windowMs: limits.windowMs }, now);
  const byteBudget = budget({ capacity: limits.bytesPerWindow, windowMs: limits.windowMs }, now);
  /** Slow reads going on without a slot (see `stream`), in all and per lease. */
  let slowReads = 0;
  const slowPerLease = new Map<string, number>();
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
  /**
   * A file the proxy refused (busy, too many requests, unsafe, the wrong type,
   * unreachable), marked so the frame's runtime can tell it from the
   * prototype's own errors and say that part of the page didn't load.
   */
  const refusedFile = (status: number, extra: Record<string, string> = {}) => plain(status, "", { "server-timing": REVIEW_REFUSED_TIMING, ...extra });
  /** A file held back only by the viewer's budget: says when it would be served, so the review page can say to wait. */
  const limitedFile = (waitMs: number) => plain(429, "", { "server-timing": `${REVIEW_REFUSED_TIMING}, ${REVIEW_LIMITED_TIMING}`, "retry-after": String(Math.max(1, Math.ceil(waitMs / 1000))) });
  const document = (status: number, html: string, head = false) =>
    new Response(head ? null : html, {
      status,
      headers: common(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": frameCsp(config.webOrigins) })),
    });
  const failure = (reason: ReviewFailure, head = false) => document(STATUS[reason], failurePage(reason, config.webOrigins), head);
  /** A page held back by the viewer's budget, saying when pages open again. */
  const limitedPage = (waitMs: number, head: boolean) => {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    const response = document(STATUS.limited, failurePage("limited", config.webOrigins, seconds), head);
    response.headers.set("retry-after", String(seconds));
    return response;
  };
  /** One answer for every host that serves nothing, so none can be told apart. */
  const notFound = () => plain(404, "Not found");

  const count = (lease: ReviewResolution, bytes: number) => {
    byteBudget.spend(lease.leaseId, bytes);
    const entry = usage.get(lease.linkId) ?? { requests: 0, bytes: 0 };
    entry.bytes += bytes;
    usage.set(lease.linkId, entry);
  };

  /**
   * A response streaming `body` within `wireBytes`, releasing `release` (its
   * read slots) however it ends. A browser that leaves a chunk untaken for
   * `clientStallMs` gives its slots back and carries on as a slow read, so a
   * slow connection still gets the whole file without holding its link's and
   * site's shares; one that then goes longer than that plus a second per
   * `slowReaderBytesPerSecond` bytes sent without taking anything has
   * stopped, and is ended. Past the slow reads a lease or the process may
   * have, a stalled read is ended at once.
   */
  const stream = (status: number, headers: Headers, body: AsyncIterable<Uint8Array>, wireBytes: number, signal: AbortSignal, lease: ReviewResolution, release: () => void, head: boolean) => {
    if (head) {
      void body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
      release();
      return new Response(null, { status, headers });
    }
    const chunks = boundedChunks(body, { wireBytes, idleMs: limits.idleTimeoutMs, totalMs: limits.bodyTimeoutMs }, signal, (bytes) => count(lease, bytes))[Symbol.asyncIterator]();
    let done = false;
    let holding = true;
    let slow = false;
    let sent = 0;
    let stall: ReturnType<typeof setTimeout> | undefined;
    let stop: ReturnType<typeof setTimeout> | undefined;
    const giveBack = () => {
      if (!holding) return;
      holding = false;
      release();
    };
    const finish = () => {
      clearTimeout(stall);
      clearTimeout(stop);
      if (done) return;
      done = true;
      giveBack();
      if (slow) {
        slowReads--;
        const left = (slowPerLease.get(lease.leaseId) ?? 1) - 1;
        if (left > 0) slowPerLease.set(lease.leaseId, left);
        else slowPerLease.delete(lease.leaseId);
      }
    };
    const end = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (done) return;
      finish();
      void chunks.return?.(undefined)?.catch(() => undefined);
      controller.error(new Error("The browser stopped reading."));
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          clearTimeout(stall);
          clearTimeout(stop);
          try {
            const step = await chunks.next();
            if (step.done) {
              finish();
              controller.close();
              return;
            }
            controller.enqueue(step.value);
            sent += step.value.byteLength;
            stall = setTimeout(() => {
              if (done || slow) return;
              if (slowReads >= limits.slowReadsPerProcess || (slowPerLease.get(lease.leaseId) ?? 0) >= limits.slowReadsPerLease) return end(controller);
              slow = true;
              slowReads++;
              slowPerLease.set(lease.leaseId, (slowPerLease.get(lease.leaseId) ?? 0) + 1);
              giveBack();
            }, limits.clientStallMs);
            stop = setTimeout(() => end(controller), limits.clientStallMs + Math.ceil((sent / limits.slowReaderBytesPerSecond) * 1000));
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

  /**
   * Response headers for anything served that isn't one of the proxy's pages:
   * allowed upstream headers, its encoding, only the type the proxy read, and
   * never a document. `Content-Disposition: attachment` makes a navigation to
   * it a download, which the frame's sandbox refuses, while the page's own
   * images, scripts, styles, fonts, media and fetches ignore it; the inert
   * policy and nosniff (from `common`) cover any other way of opening it.
   */
  const passHeaders = (upstream: Record<string, string>, type: ContentType | null) => {
    const headers = inboundHeaders(upstream);
    headers.delete("content-type");
    if (type !== null) headers.set("content-type", contentTypeHeader(type));
    headers.set("content-disposition", "attachment");
    common(headers);
    const encoding = upstream["content-encoding"];
    if (encoding !== undefined && /^(?:gzip|br)$/i.test(encoding.trim())) headers.set("content-encoding", encoding.trim().toLowerCase());
    return headers;
  };

  /** The length an upstream body says it has on the wire, which the proxy sends unchanged; null when it doesn't say. */
  const wireLength = (upstream: Record<string, string>): number | null => {
    const text = upstream["content-length"]?.trim() ?? "";
    return /^[0-9]{1,15}$/.test(text) ? Number(text) : null;
  };

  const bodyFailure = (error: unknown): ReviewFailure => (error instanceof BodyError ? (error.reason === "too-large" ? "too-large" : error.reason === "timeout" ? "timeout" : "unsupported") : "unreachable");

  const refusal = (outcome: Exclude<EgressOutcome, { kind: "response" }>): ReviewFailure => (outcome.kind === "refused" && outcome.reason === "unsafe" ? "unsafe" : "unreachable");

  /** What a request that got no upstream response is answered with: a notice in the frame for a navigation, a bare status otherwise. */
  const refused = (outcome: Exclude<EgressOutcome, { kind: "response" }>, asPage: boolean, head: boolean): Response => {
    if (!asPage) return refusedFile(outcome.kind === "refused" && outcome.reason === "unsafe" ? 403 : 502);
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
    const headers = passHeaders(outcome.headers, { essence: "text/css", charset: "utf-8" });
    headers.delete("content-encoding");
    if (head) {
      void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
      return new Response(null, { status: outcome.status, headers });
    }
    let bytes: Uint8Array;
    try {
      bytes = await readDecoded(outcome.body, outcome.headers["content-encoding"], { wireBytes: limits.cssInputBytes, decodedBytes: limits.cssInputBytes, idleMs: limits.idleTimeoutMs, totalMs: limits.bodyTimeoutMs }, signal);
    } catch {
      return refusedFile(502);
    }
    count(lease, bytes.byteLength);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return refusedFile(502);
    }
    const css = new TextEncoder().encode(rewriteCss(ctx, text, outcome.url, imports));
    if (css.byteLength > limits.cssOutputBytes) return refusedFile(502);
    return new Response(css, { status: outcome.status, headers });
  }

  /**
   * A read slot from every pool a request counts against, all or none:
   * waited for in line, briefly, when one has no room (`slotLine`). The
   * shares stay what they were: a lease 8, a link and an upstream host 24, the
   * process 64; waiting only lets a page with more files than its share load
   * them in turns.
   */
  const takeSlots = (lease: ReviewResolution, upstreamHost: string, prefetch: boolean, signal: AbortSignal): Promise<(() => void) | null> => {
    const claims: Claim[] = [() => processSlots.take(), () => linkSlots.take(lease.linkId), () => hostSlots.take(upstreamHost), () => leaseSlots.take(lease.leaseId)];
    if (prefetch) claims.push(() => prefetchSlots.take(lease.leaseId));
    return line.take(claims, lease.leaseId, limits.queueTimeoutMs, signal);
  };

  /**
   * Frame hosts that resolved to a live lease, with the directory's last
   * answer, until that lease's end: their lookups never count against a
   * client's misses, so a viewer whose address someone else uses up (a
   * shared office or carrier address) keeps the frames it has open. They are
   * still asked about every time, so a revoked lease stops serving as soon
   * as the directory says so; only while the directory can't be asked is the
   * last answer served, until its `cacheUntil` (at most 5 seconds after it).
   */
  const live = new Map<string, ReviewResolution>();
  const MAX_LIVE = 100_000;
  /**
   * Frame hosts each client key is asking about now, with how many requests
   * wait on each. A host in flight counts as a miss until it answers, so a
   * burst of random hosts can't pass the limit before any miss is counted;
   * many requests for one host (a page's files, before its first answer)
   * count once.
   */
  const pending = new Map<string, Map<string, number>>();
  /** Until when the directory is taken to be unreachable: a host not seen live isn't asked about meanwhile. */
  let unreachableUntil = 0;

  type Lookup = { kind: "lease"; lease: ReviewResolution } | { kind: "none" } | { kind: "unavailable" };

  /**
   * The lease a frame host stands for. The backend is asked about a host not
   * seen live only while this client's misses, with the hosts it is asking
   * about, are within their limit. A directory that can't be asked is
   * `unavailable`, never a miss: a known host serves its last answer until
   * that answer's `cacheUntil`, and every other host is told to try again.
   */
  const leaseFor = async (label: string, key: string, signal: AbortSignal): Promise<Lookup> => {
    const seen = live.get(label);
    const known = seen !== undefined && seen.expiresAt > now();
    const asking = pending.get(key) ?? new Map<string, number>();
    const first = !asking.has(label);
    if (!known) {
      if (now() < unreachableUntil) return { kind: "unavailable" };
      if (first && lookupMisses.usage(key).requests + asking.size >= limits.lookupMissesPerClient) return { kind: "none" };
      asking.set(label, (asking.get(label) ?? 0) + 1);
      pending.set(key, asking);
    }
    try {
      let lease: ReviewResolution | null;
      try {
        lease = await deps.directory.resolve(label, signal);
      } catch {
        if (signal.aborted) return { kind: "unavailable" };
        unreachableUntil = now() + 1_000;
        return known && seen.cacheUntil > now() ? { kind: "lease", lease: seen } : { kind: "unavailable" };
      }
      if (lease === null) {
        live.delete(label);
        if (!known && first) lookupMisses.admit(key);
        return { kind: "none" };
      }
      live.delete(label);
      live.set(label, lease);
      if (live.size > MAX_LIVE) live.delete(live.keys().next().value!);
      return { kind: "lease", lease };
    } finally {
      if (!known) {
        const left = (asking.get(label) ?? 1) - 1;
        if (left > 0) asking.set(label, left);
        else asking.delete(label);
        if (asking.size === 0 && pending.get(key) === asking) pending.delete(key);
      }
    }
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

    const found = await leaseFor(label, clientKey(info.client) ?? clientKey(info.peer) ?? "unknown", request.signal);
    // Critiqs couldn't check the link: said as that, to try again, never as a host that serves nothing.
    if (found.kind === "unavailable") return hintOf(request) === "document" ? failure("offline", request.method === "HEAD") : refusedFile(503, { "retry-after": "5" });
    const lease = found.kind === "lease" ? found.lease : null;
    if (lease === null || lease.expiresAt <= now()) return notFound();
    const ctx: UrlContext = { primary: lease.origin, slots: lease.assetOrigins, leaseId: lease.leaseId, secret: config.signingKey, previousSecret: config.previousSigningKey };
    const route = routeRequest(ctx, url);
    if (route.kind === "none") return notFound();
    if (route.kind === "static") {
      const asset = route.file === deps.assets.runtime.file ? deps.assets.runtime : route.file === deps.assets.layer.file ? deps.assets.layer : null;
      if (asset === null) return notFound();
      return new Response(request.method === "HEAD" ? null : asset.body, {
        headers: common(new Headers({ "content-type": "text/javascript; charset=utf-8", "content-disposition": "attachment", "cache-control": "private, max-age=86400, immutable" })),
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
    // Out of a budget: refused without fetching, saying when there is room again. A framework prefetches again when the reviewer navigates.
    const pages = FILE_HINTS.has(hint) ? fileBudget : pageBudget;
    const spent = prefetch ? prefetchBudget : pages;
    if (byteBudget.left(lease.leaseId) <= 0) {
      const wait = byteBudget.waitMs(lease.leaseId, limits.bytesPerWindow / 20);
      return asPage ? limitedPage(wait, head) : limitedFile(wait);
    }
    if (!spent.take(lease.leaseId)) return asPage ? limitedPage(spent.waitMs(lease.leaseId), head) : limitedFile(spent.waitMs(lease.leaseId));
    const entry = usage.get(lease.linkId) ?? { requests: 0, bytes: 0 };
    entry.requests++;
    usage.set(lease.linkId, entry);
    const release = await takeSlots(lease, canonicalHost(route.upstream.hostname) ?? route.upstream.hostname, prefetch, request.signal);
    if (release === null) return asPage ? failure("busy", head) : refusedFile(503, { "retry-after": "2" });

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
      const type = contentType(outcome.headers["content-type"]);
      const handling = handlingOf(route, hint, outcome.status, type, limits);
      if (handling.kind === "page") return await servePage(ctx, lease, outcome, framePath(new URL(`${url.pathname}${url.search}`, url)), signal, head);
      if (handling.kind === "style") return await serveStyle(ctx, lease, outcome, handling.imports, signal, head);
      if (handling.kind === "refuse") {
        // Never a page, JSON or text from another site's address, whatever it claims or answers.
        void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        return refusedFile(handling.status);
      }
      const length = wireLength(outcome.headers);
      if (length !== null && length > handling.cap) {
        // Over the size cap: refused before any of it is sent, marked, so the review page says part of the page couldn't load.
        void outcome.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        return refusedFile(502);
      }
      const headers = passHeaders(outcome.headers, type);
      if (length !== null) headers.set("content-length", String(length));
      // A success the browser then can't use was cut on its way here (see REVIEW_FILE_TIMING).
      if (outcome.status >= 200 && outcome.status < 300) headers.set("server-timing", REVIEW_FILE_TIMING);
      streaming = true;
      return stream(outcome.status, headers, outcome.body, handling.cap, signal, lease, release, head);
    } catch (error) {
      return asPage ? failure(bodyFailure(error), head) : refusedFile(502);
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
