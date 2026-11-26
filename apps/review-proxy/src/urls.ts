import { createHmac, timingSafeEqual } from "node:crypto";

// How addresses map between a prototype and its frame host. The prototype's
// own origin is served at the frame host's root, so paths stay the same and
// routers keep working. Owner-approved origins are served under
// `/__critiqs/o/<slot>/`. A static file on any other site is served under
// `/__critiqs/a/<signature>/<class>/<scheme>/<host>/<path>` only when the
// proxy itself wrote that address while rewriting a page or stylesheet: the
// signature is an HMAC over the lease, the class and the exact URL, checked
// before anything is resolved, so neither a person with a link nor the
// prototype's scripts can make the proxy fetch an address of their choosing.
// Links to other sites become a signed leave notice, never the site.

export type AssetClass = "image" | "font" | "style" | "script" | "media";
export const ASSET_CLASSES: readonly AssetClass[] = ["image", "font", "style", "script", "media"];

export interface UrlContext {
  /** The prototype's origin. */
  primary: string;
  /** Owner-approved origins by slot. */
  slots: readonly { slot: number; origin: string }[];
  /** Signatures are bound to the lease, so an address from one lease is refused on another. */
  leaseId: string;
  secret: string;
}

export const RESERVED = "/__critiqs/";

function mac(secret: string, text: string): Buffer {
  return createHmac("sha256", secret).update(text).digest().subarray(0, 16);
}

function matches(given: string, expected: Buffer): boolean {
  const bytes = Buffer.from(given, "base64url");
  return given.length === 22 && bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/** The URL as a signed path carries it: origin, path and query, without a fragment or an empty `?`. */
function canonical(url: URL): string {
  const copy = new URL(url.origin);
  copy.pathname = url.pathname;
  copy.search = url.search;
  return copy.href;
}

/** Whether a third-party URL can be served as a signed asset: http(s), default port, no credentials. */
function signable(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && url.port === "" && url.username === "" && url.password === "";
}

/** A signed asset path for `url`, or null when it can't be served (another port, credentials, another scheme). */
export function assetPath(ctx: UrlContext, assetClass: AssetClass, url: URL): string | null {
  if (!signable(url)) return null;
  const signature = mac(ctx.secret, `asset\n${ctx.leaseId}\n${assetClass}\n${canonical(url)}`).toString("base64url");
  return `${RESERVED}a/${signature}/${assetClass}/${url.protocol.slice(0, -1)}/${url.hostname}${url.pathname}${url.search}${url.hash}`;
}

/** The leave notice for a link to another site: only its origin, signed, so the notice can't be made to name any site. */
export function leavePath(ctx: UrlContext, url: URL): string {
  const signature = mac(ctx.secret, `leave\n${ctx.leaseId}\n${url.origin}`).toString("base64url");
  return `${RESERVED}leave?to=${encodeURIComponent(url.origin)}&s=${signature}`;
}

/** A URL on the prototype's own origin as a frame path: its path, query and fragment. */
function primaryPath(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where the browser should ask for `raw`, read against the upstream `base`.
 * `as` says whether it is a page (a link or form) or a static file of a class.
 * Anything that isn't an http(s) address (`data:`, `blob:`, a fragment,
 * `mailto:`) is returned unchanged, and so is a third-party file that can't be
 * signed: the frame's Content-Security-Policy then refuses it.
 */
export function mapUrl(ctx: UrlContext, raw: string, base: URL, as: "page" | AssetClass): string {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) return raw;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  if (url.origin === ctx.primary) return primaryPath(url);
  const slot = ctx.slots.find((entry) => entry.origin === url.origin);
  if (slot !== undefined) return `${RESERVED}o/${slot.slot}${url.pathname}${url.search}${url.hash}`;
  if (as === "page") return leavePath(ctx, url);
  return assetPath(ctx, as, url) ?? raw;
}

/** What a request on a frame host stands for. */
export type ProxyRoute =
  | { kind: "primary"; upstream: URL }
  | { kind: "slot"; slot: number; upstream: URL }
  | { kind: "asset"; assetClass: AssetClass; upstream: URL }
  | { kind: "leave"; to: string }
  | { kind: "static"; file: string }
  /** A reserved path that names nothing valid: a bad signature, an unknown slot, a malformed address. */
  | { kind: "none" };

/** Joins path segments after a reserved prefix back into a path, keeping its leading slash. */
function rest(segments: readonly string[]): string {
  return `/${segments.join("/")}`;
}

/**
 * The route for a request's path and query on a frame host. Every upstream
 * URL is built from a fixed origin and then checked to still have it, so no
 * path (`//evil.example/`, `/\evil.example`) can name another host.
 */
export function routeRequest(ctx: UrlContext, request: URL): ProxyRoute {
  const path = request.pathname;
  if (!path.startsWith(RESERVED)) {
    const upstream = new URL(ctx.primary);
    upstream.pathname = path;
    upstream.search = request.search;
    return upstream.origin === ctx.primary ? { kind: "primary", upstream } : { kind: "none" };
  }
  const segments = path.slice(RESERVED.length).split("/");
  const [head, ...tail] = segments;
  if (head === "leave" && tail.length === 0) {
    const to = request.searchParams.get("to") ?? "";
    const signature = request.searchParams.get("s") ?? "";
    let origin: string;
    try {
      const url = new URL(to);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== to) return { kind: "none" };
      origin = url.origin;
    } catch {
      return { kind: "none" };
    }
    return matches(signature, mac(ctx.secret, `leave\n${ctx.leaseId}\n${origin}`)) ? { kind: "leave", to: origin } : { kind: "none" };
  }
  if (head === "o" && tail.length >= 1) {
    const [slotText, ...pathSegments] = tail;
    const slot = ctx.slots.find((entry) => String(entry.slot) === slotText);
    if (slot === undefined) return { kind: "none" };
    const upstream = new URL(slot.origin);
    upstream.pathname = rest(pathSegments);
    upstream.search = request.search;
    return upstream.origin === slot.origin ? { kind: "slot", slot: slot.slot, upstream } : { kind: "none" };
  }
  if (head === "a" && tail.length >= 4) {
    const [signature, assetClass, scheme, host, ...pathSegments] = tail as [string, string, string, string, ...string[]];
    if (!ASSET_CLASSES.includes(assetClass as AssetClass) || (scheme !== "https" && scheme !== "http") || host === "") return { kind: "none" };
    let upstream: URL;
    try {
      upstream = new URL(`${scheme}://${host}`);
    } catch {
      return { kind: "none" };
    }
    // The host segment must be exactly a host: no port, credentials or path smuggled into it.
    if (upstream.hostname !== host || !signable(upstream)) return { kind: "none" };
    const origin = upstream.origin;
    upstream.pathname = rest(pathSegments);
    upstream.search = request.search;
    if (upstream.origin !== origin) return { kind: "none" };
    // Checked before anything about the address is looked up.
    if (!matches(signature, mac(ctx.secret, `asset\n${ctx.leaseId}\n${assetClass}\n${upstream.href}`))) return { kind: "none" };
    return { kind: "asset", assetClass: assetClass as AssetClass, upstream };
  }
  if (tail.length === 0 && /^(?:runtime|layer)\.[a-z0-9]{8,}\.js$/.test(head ?? "")) return { kind: "static", file: head! };
  return { kind: "none" };
}

/**
 * A `srcset` value's candidates: each URL with its descriptor text. Follows
 * HTML's parsing closely enough for real pages: URLs end at whitespace, a
 * trailing comma ends a candidate, and descriptors may hold parentheses.
 */
export function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const candidates: { url: string; descriptor: string }[] = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/.test(value[at]!)) at++;
    if (at >= value.length) break;
    let end = at;
    while (end < value.length && !/\s/.test(value[end]!)) end++;
    let url = value.slice(at, end);
    at = end;
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      const start = at;
      while (at < value.length && (value[at] !== "," || depth > 0)) {
        if (value[at] === "(") depth++;
        else if (value[at] === ")") depth = Math.max(0, depth - 1);
        at++;
      }
      descriptor = value.slice(start, at).trim();
      at++;
    }
    if (url !== "") candidates.push({ url, descriptor });
  }
  return candidates;
}

/** A `srcset` value with each URL mapped. */
export function mapSrcset(ctx: UrlContext, value: string, base: URL, as: AssetClass): string {
  return parseSrcset(value)
    .map(({ url, descriptor }) => [mapUrl(ctx, url, base, as), descriptor].filter((part) => part !== "").join(" "))
    .join(", ");
}
