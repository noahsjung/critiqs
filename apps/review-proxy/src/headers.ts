// Header rules. Nothing the reviewer's browser sends goes upstream: the
// proxy builds every outbound request's headers from scratch, so no cookie,
// authorization, client address or browser fingerprint can reach a
// prototype. Coming back, only an allow list of upstream response headers
// reaches the browser, so nothing upstream can set a cookie on a lease host,
// pin it to HTTPS, clear its storage, send reports, or change its framing
// rules.

/** What a request is for, which decides its Accept headers, its size limit and the content types allowed back. */
export type RequestClass = "document" | "style" | "script" | "image" | "font" | "media" | "data";

const ACCEPT: Record<RequestClass, string> = {
  document: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  style: "text/css,*/*;q=0.1",
  script: "*/*",
  image: "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
  font: "font/woff2,font/woff,*/*;q=0.5",
  media: "*/*",
  data: "application/json,*/*;q=0.5",
};

/** Classes whose bodies the proxy decompresses to read or rewrite. */
export function isRewritten(requestClass: RequestClass): boolean {
  return requestClass === "document" || requestClass === "style";
}

/**
 * The only headers an upstream request carries, besides the Host and
 * `Connection: close` the pinned connection adds. Built from the class and
 * the user agent, plus the framework headers `frameworkHeaders` checked one
 * by one: nothing else of the browser's request is an input.
 */
export function outboundHeaders(requestClass: RequestClass, userAgent: string, framework: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: ACCEPT[requestClass],
    // Rewritten bodies are decompressed with a hard cap (decompress.ts); others pass through as sent.
    "Accept-Encoding": isRewritten(requestClass) ? "gzip, br, deflate" : "gzip, br",
    ...framework,
  };
}

// Next.js's App Router fetches each page's data (React Server Components) with
// request headers that name what it wants, and its server answers a request
// whose `_rsc` query doesn't hash those headers with a redirect to one that
// does. Without them every client-side navigation and prefetch fails. These
// are the names its client sets in production (next 16.4,
// `client/components/app-router-headers.js`, `fetch-server-response.js`,
// `segment-cache/cache.js`, `shared/lib/deployment-id.js`); none carries a
// credential, and each value must have the exact shape the client produces.
// Development-only ones (hot reload, request IDs) are left out: review links
// don't run dev servers.

/** `next-router-state-tree`: `encodeURIComponent(JSON.stringify(tree))`, where the tree is an array. */
function routerStateTree(value: string): boolean {
  if (value.length > 8 * 1024 || !/^[A-Za-z0-9\-_.!~*'()%]+$/.test(value)) return false;
  try {
    return Array.isArray(JSON.parse(decodeURIComponent(value)));
  } catch {
    return false;
  }
}

const FRAMEWORK_HEADERS: Readonly<Record<string, (value: string) => boolean>> = {
  /** Asks for the page's server components instead of its HTML. */
  rsc: (value) => value === "1",
  "next-router-state-tree": routerStateTree,
  /** A prefetch, and which kind. */
  "next-router-prefetch": (value) => value === "1" || value === "2" || value === "3",
  /** One segment of a prefetch: `/`-separated keys of letters, digits, `-_@`, with `$` for parameters and `!` before base64url. Empty for the root. */
  "next-router-segment-prefetch": (value) => value.length <= 1024 && /^(?:\/[A-Za-z0-9\-_@$!]+)*$/.test(value),
  /** The path the router is on, for intercepted routes. */
  "next-url": (value) => value.length <= 2048 && /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(value),
  /** The build the page came from (skew protection). */
  "x-deployment-id": (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value),
};

/**
 * The framework headers a request on the prototype's own origin may carry
 * upstream: only the names above, each only with a value of its exact shape.
 * Any other header, and any of these with another value, is dropped.
 */
export function frameworkHeaders(browser: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, valid] of Object.entries(FRAMEWORK_HEADERS)) {
    const value = browser.get(name);
    if (value !== null && valid(value)) kept[name] = value;
  }
  return kept;
}

/**
 * Whether a request is a prefetch, which the proxy counts apart from what
 * the reviewer opens (limits.ts): Next.js's router prefetches, and the
 * browser's own `<link rel=prefetch>` and speculation rules.
 */
export function isPrefetch(browser: Headers): boolean {
  const router = browser.get("next-router-prefetch");
  if (router !== null && FRAMEWORK_HEADERS["next-router-prefetch"]!(router)) return true;
  return /\bprefetch\b/i.test(browser.get("sec-purpose") ?? browser.get("purpose") ?? "");
}

/**
 * Upstream response headers a browser may see, lowercased. Everything else is
 * dropped, including Set-Cookie, Clear-Site-Data, Strict-Transport-Security,
 * Alt-Svc, Report-To, Reporting-Endpoints, NEL, Link, Content-Location,
 * Access-Control-*, Cross-Origin-*, Service-Worker-Allowed, Set-Login,
 * Content-Security-Policy, X-Frame-Options, Location, Refresh and
 * Content-Disposition. Length and encoding are set by the proxy for what it sends.
 */
const PASSED = new Set(["content-type", "cache-control", "etag", "last-modified", "expires", "content-language"]);

/**
 * Response headers Next.js's App Router client reads (whether a response
 * depends on `next-url`, a postponed render, how long a prefetch stays fresh,
 * which build answered), each passed only with a value of its exact shape.
 */
const PASSED_SHAPED: Readonly<Record<string, RegExp>> = {
  vary: /^[A-Za-z0-9\-, ]{1,512}$/,
  "x-nextjs-postponed": /^[0-9]$/,
  "x-nextjs-stale-time": /^[0-9]{1,10}$/,
  "x-nextjs-deployment-id": /^[A-Za-z0-9_-]{1,128}$/,
};

/** The upstream headers kept for the browser, with `private` added to caching so no shared cache keeps a lease's response. */
export function inboundHeaders(upstream: Readonly<Record<string, string>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(upstream)) {
    const key = name.toLowerCase();
    const shape = PASSED_SHAPED[key];
    if (shape !== undefined) {
      if (shape.test(value)) headers.set(key, value);
      continue;
    }
    if (!PASSED.has(key)) continue;
    // Header values can't carry line breaks; a value that does is dropped, not repaired.
    if (/[\r\n\0]/.test(value)) continue;
    headers.set(key, value);
  }
  const kept = (headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && !/^(?:public|private|proxy-revalidate|s-maxage\b.*)$/i.test(directive));
  headers.set("cache-control", ["private", ...(kept.length > 0 ? kept : ["no-cache"])].join(", "));
  return headers;
}

/** Upstream headers as one lowercased string per name. */
export function lowercaseHeaders(raw: Readonly<Record<string, string | readonly string[] | undefined>>): Record<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    const text = typeof value === "string" ? value : value.join(", ");
    const before = headers.get(key);
    headers.set(key, before === undefined ? text : `${before}, ${text}`);
  }
  return Object.fromEntries(headers);
}

/** The media type of a Content-Type value, lowercased, without parameters; "" when there is none. */
export function mediaType(contentType: string | undefined | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/** The charset a Content-Type names, lowercased, or null. */
export function charsetOf(contentType: string | undefined | null): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return match === null ? null : match[1]!.toLowerCase();
}

/**
 * Bytes of the request's headers other than Cookie. A sibling lease host can
 * plant cookies on the shared parent domain until it is on the Public Suffix
 * List; the proxy ignores Cookie entirely, so those bytes don't count against
 * the limit and can't make it refuse another lease.
 */
export function requestHeaderBytes(headers: Headers): number {
  let bytes = 0;
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "cookie") return;
    bytes += name.length + value.length + 4;
  });
  return bytes;
}
