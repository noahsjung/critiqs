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
 * the user agent alone: the browser's request is not an input.
 */
export function outboundHeaders(requestClass: RequestClass, userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: ACCEPT[requestClass],
    // Rewritten bodies are decompressed with a hard cap (decompress.ts); others pass through as sent.
    "Accept-Encoding": isRewritten(requestClass) ? "gzip, br, deflate" : "gzip, br",
  };
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

/** The upstream headers kept for the browser, with `private` added to caching so no shared cache keeps a lease's response. */
export function inboundHeaders(upstream: Readonly<Record<string, string>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(upstream)) {
    const key = name.toLowerCase();
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
