import { createHmac } from "node:crypto";
import { canonicalHost, siteOf } from "@critiqs/core";
import { parseCidr, type PublicWebPolicy } from "@critiqs/server/public-web";
import { CLIENT_ADDRESS_HEADERS } from "./clients.ts";

export { siteOf };

// The proxy's settings, all from the environment, so the domain, the website
// and the backend are chosen at deploy time. Anything unsafe stops the
// process at start rather than serving with a hole.

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** How much one lease, one process and one response may use. Every number can be lowered per deployment. */
export interface ProxyLimits {
  /**
   * Upstream reads at once for one lease, and for the whole process. A read
   * past a share waits its turn for up to `queueTimeoutMs`, then gets 503.
   */
  concurrentPerLease: number;
  /** Of a lease's reads at once, how many may be prefetches, so what the reviewer opens always has room. */
  concurrentPrefetchPerLease: number;
  concurrentPerProcess: number;
  /**
   * Reads at once for all of one link's leases, and for one upstream host
   * across every link: a share of the process, so one link whose site answers
   * slowly, opened in many tabs or by many links, can't hold every read.
   */
  concurrentPerLink: number;
  concurrentPerUpstreamHost: number;
  /**
   * Frame hosts one client may ask about that turn out to serve nothing, per
   * `lookupWindowMs`. Past it, that client's uncached hosts get the same 404
   * without asking the backend, so random hosts can't make the proxy call it.
   */
  lookupMissesPerClient: number;
  lookupWindowMs: number;
  /**
   * How long a read waits for its turn when its lease, link, upstream host or
   * the process has no room, and how many reads may wait per lease and in
   * all; past either count a read is refused at once. A browser over HTTP/2
   * asks for every image of a page at once, so a page with more images than
   * a lease's share loads in turns instead of failing.
   */
  queueTimeoutMs: number;
  queuedPerLease: number;
  queuedPerProcess: number;
  /**
   * How long a response may wait for the browser to read on before it gives
   * back its read slot: a browser on a slow connection keeps its download
   * (it carries on without a slot, as one of at most `slowReadsPerLease` and
   * `slowReadsPerProcess`), and its link's and upstream host's shares are
   * free for others. A response whose browser goes longer than this, plus a
   * second for every `slowReaderBytesPerSecond` bytes already sent, without
   * taking anything has stopped, and is ended. Past either count of slow
   * reads, a browser that stops reading is ended at once.
   */
  clientStallMs: number;
  slowReaderBytesPerSecond: number;
  slowReadsPerLease: number;
  slowReadsPerProcess: number;
  /**
   * What one lease may use per `windowMs`, as budgets that refill evenly
   * across the window, so a viewer who waits gets some back and the notice can
   * say when. Pages and data requests (fetch, XHR, an owner-approved origin's
   * data) share `requestsPerWindow`; a page's own files (images, scripts,
   * styles, fonts, media, by what the browser says they are) share the larger
   * `fileRequestsPerWindow`. A file request answered with a page is never
   * served as one, so the larger budget can't open pages.
   */
  windowMs: number;
  requestsPerWindow: number;
  fileRequestsPerWindow: number;
  /**
   * Prefetches (Next.js's router, the browser's own) per lease per window,
   * counted apart from `requestsPerWindow`: a framework prefetching every link
   * on a page uses these up, and is then refused, while what the reviewer
   * opens still has its own. Bytes count against `bytesPerWindow` either way.
   */
  prefetchRequestsPerWindow: number;
  bytesPerWindow: number;
  /** Bytes read from upstream (on the wire) and after decompression, for HTML and CSS that are rewritten. */
  htmlInputBytes: number;
  htmlOutputBytes: number;
  cssInputBytes: number;
  cssOutputBytes: number;
  /** A JSON or other data response from an owner-approved origin. */
  dataBytes: number;
  /** An image, font, script or media file passed through unchanged. */
  assetBytes: number;
  /** One hop's connection and response headers; every hop, redirects and reputation included, to the final headers; the gap between body chunks; the whole body. */
  hopTimeoutMs: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  bodyTimeoutMs: number;
  maxRedirects: number;
  /** Request headers other than Cookie, which the proxy ignores. */
  requestHeaderBytes: number;
  /** A request's path and query. */
  urlBytes: number;
}

export const DEFAULT_LIMITS: ProxyLimits = {
  concurrentPerLease: 8,
  concurrentPrefetchPerLease: 4,
  concurrentPerProcess: 64,
  concurrentPerLink: 24,
  concurrentPerUpstreamHost: 24,
  lookupMissesPerClient: 30,
  lookupWindowMs: 60_000,
  queueTimeoutMs: 8_000,
  queuedPerLease: 256,
  queuedPerProcess: 4_096,
  clientStallMs: 3_000,
  slowReaderBytesPerSecond: 4 * 1024,
  slowReadsPerLease: 8,
  slowReadsPerProcess: 256,
  windowMs: 10 * 60_000,
  requestsPerWindow: 300,
  fileRequestsPerWindow: 1_200,
  prefetchRequestsPerWindow: 600,
  bytesPerWindow: 80 * 1024 * 1024,
  htmlInputBytes: 2 * 1024 * 1024,
  htmlOutputBytes: 3 * 1024 * 1024,
  cssInputBytes: 1024 * 1024,
  cssOutputBytes: 2 * 1024 * 1024,
  dataBytes: 2 * 1024 * 1024,
  assetBytes: 16 * 1024 * 1024,
  hopTimeoutMs: 5_000,
  headersTimeoutMs: 12_000,
  idleTimeoutMs: 10_000,
  bodyTimeoutMs: 60_000,
  maxRedirects: 3,
  requestHeaderBytes: 16 * 1024,
  urlBytes: 2_048,
};

/** The user agent token site owners match in a firewall rule. Sent only on requests for a link's own address. */
export const REVIEW_USER_AGENT_TOKEN = "Critiqs-Review/1";
/** Sent on third-party asset requests instead, so a rule matching the review token never lets an asset fetch through. */
export const ASSET_USER_AGENT = "Critiqs-Asset/1";

export interface ProxyConfig {
  /** Where frames are served: `https://critiqs-review.net`, or `http://review.localhost:5120` on one computer. Lease hosts are one label under it. */
  domain: URL;
  /** The website origins allowed to frame a lease and to talk to its page layer (CRITIQS_WEB_ORIGINS). The first is the review page's. */
  webOrigins: readonly string[];
  /** The Convex deployment's HTTP address the proxy asks about leases (CRITIQS_PROXY_BACKEND). */
  backend: URL;
  /** Shared with the backend for its internal routes (CRITIQS_PROXY_SECRET, 32 bytes or more). */
  secret: string;
  /**
   * The key for signed asset and leave addresses (CRITIQS_PROXY_SIGNING_KEY,
   * 32 bytes or more), which only the proxy holds, so the backend's copy of
   * the shared secret can't sign them. Required on a public domain; on a
   * `.localhost` one it may be derived from the shared secret under its own
   * label.
   */
  signingKey: string;
  /** The previous signing key during a rotation (CRITIQS_PROXY_SIGNING_KEY_PREVIOUS): addresses it signed are still accepted, never written. */
  previousSigningKey: string | null;
  /**
   * The request header the server in front of the proxy sets to the viewer's
   * address (CRITIQS_PROXY_CLIENT_IP_HEADER, such as `cf-connecting-ip`), or
   * null to use the connection's own address. Behind an ingress without it,
   * every viewer looks like one client, so one client's lookups could use up
   * everyone's: on a public domain the setting is required, and `connection`
   * says the proxy faces viewers directly.
   */
  clientIpHeader: string | null;
  /** The proxy's own outbound address blocks (CRITIQS_PROXY_EGRESS): published for Allow Critiqs, and refused as destinations. */
  egress: readonly string[];
  /** `Critiqs-Review/1 (+<website>/allow-critiqs)`. */
  userAgent: string;
  assetUserAgent: string;
  /** Google Web Risk's key (CRITIQS_WEB_RISK_API_KEY), or null. Without one, only a `.localhost` domain serves, with the test fixture. */
  webRiskKey: string | null;
  /** Whether the domain is a `.localhost` one: a computer's own test stack. */
  local: boolean;
  /**
   * How a deployment keeps one frame host's cookies from reaching the others
   * (CRITIQS_PROXY_COOKIE_ISOLATION), required on a public domain. Frame hosts
   * run other people's pages with same-origin scripts, and until the domain is
   * on the Public Suffix List those scripts can set cookies on the whole
   * domain; the browser (Firefox, and Chrome for cookies marked
   * `SameSite=None; Secure`) then sends up to a megabyte of them with every
   * other frame's requests, which a server refuses for their size. `public-suffix-list`: the domain is listed, so browsers refuse such
   * cookies. `ingress-drops-cookies`: the server in front accepts request
   * headers of at least 2 MiB and removes Cookie before the proxy. `local`: a
   * `.localhost` test stack.
   */
  cookieIsolation: CookieIsolation;
  limits: ProxyLimits;
}

export type CookieIsolation = "public-suffix-list" | "ingress-drops-cookies" | "local";
const COOKIE_ISOLATION: readonly CookieIsolation[] = ["public-suffix-list", "ingress-drops-cookies"];

const MIN_SECRET_BYTES = 32;

/** An origin setting, its host in canonical form. */
function origin(text: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`${name} must be an address such as https://example.com.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`${name} must start with https://.`);
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(`${name} must be an origin only, without a path, query, or credentials.`);
  }
  const host = canonicalHost(url.hostname);
  if (host === null) throw new ConfigError(`${name} must be an address such as https://example.com.`);
  if (!url.hostname.startsWith("[")) url.hostname = host;
  return url;
}

function isLocalhost(host: string): boolean {
  const name = canonicalHost(host) ?? "";
  return name === "localhost" || name.endsWith(".localhost");
}

/** On a deployed domain, plain http would let anyone on the network read or change what it carries. */
function secure(url: URL, name: string, local: boolean): URL {
  if (!local && url.protocol !== "https:") throw new ConfigError(`${name} must use https:// when CRITIQS_PROXY_DOMAIN isn't a .localhost domain.`);
  return url;
}

function numberSetting(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const text = env[name];
  if (text === undefined || text === "") return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${name} must be a whole number above 0.`);
  // Settings can only lower a limit.
  return Math.min(value, fallback);
}

/** The proxy's settings from the environment. Throws a `ConfigError` naming the setting for anything missing or unsafe. */
export function parseProxyConfig(env: Record<string, string | undefined>): ProxyConfig {
  const domainText = env.CRITIQS_PROXY_DOMAIN;
  if (domainText === undefined || domainText === "") throw new ConfigError("Set CRITIQS_PROXY_DOMAIN to the domain review frames are served on.");
  const domain = origin(domainText, "CRITIQS_PROXY_DOMAIN");
  const local = isLocalhost(domain.hostname);
  if (!local && domain.protocol !== "https:") throw new ConfigError("CRITIQS_PROXY_DOMAIN must use https:// except on a .localhost domain.");
  if (domain.hostname.split(".").length < 2) throw new ConfigError("CRITIQS_PROXY_DOMAIN must be a domain with a dot, such as review.localhost or critiqs-review.net.");

  const webOrigins = (env.CRITIQS_WEB_ORIGINS ?? "")
    .split(",")
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .map((text) => secure(origin(text, "CRITIQS_WEB_ORIGINS"), "CRITIQS_WEB_ORIGINS", local).origin);
  if (webOrigins.length === 0) throw new ConfigError("Set CRITIQS_WEB_ORIGINS to the website origins that show review links.");

  const backendText = env.CRITIQS_PROXY_BACKEND;
  if (backendText === undefined || backendText === "") throw new ConfigError("Set CRITIQS_PROXY_BACKEND to the backend's HTTP address.");
  const backend = secure(origin(backendText, "CRITIQS_PROXY_BACKEND"), "CRITIQS_PROXY_BACKEND", local);

  // The frames' domain must be its own site: lease hosts run other people's
  // pages with same-origin scripts, so they must never share cookies with the
  // website or the backend.
  const proxySite = siteOf(domain.hostname);
  for (const [name, host] of [...webOrigins.map((text) => ["CRITIQS_WEB_ORIGINS", new URL(text).hostname] as const), ["CRITIQS_PROXY_BACKEND", backend.hostname] as const]) {
    if (siteOf(host) === proxySite) throw new ConfigError(`CRITIQS_PROXY_DOMAIN must be a different site from ${name} (${host}).`);
  }

  const secret = env.CRITIQS_PROXY_SECRET ?? "";
  if (new TextEncoder().encode(secret).byteLength < MIN_SECRET_BYTES) throw new ConfigError(`CRITIQS_PROXY_SECRET must be at least ${MIN_SECRET_BYTES} bytes.`);

  const egress = (env.CRITIQS_PROXY_EGRESS ?? "")
    .split(",")
    .map((text) => text.trim())
    .filter((text) => text !== "");
  for (const block of egress) if (parseCidr(block) === null) throw new ConfigError(`CRITIQS_PROXY_EGRESS has ${JSON.stringify(block)}, which isn't an address block such as 203.0.113.10/32.`);

  const signingKey = env.CRITIQS_PROXY_SIGNING_KEY ?? "";
  if (signingKey !== "" && new TextEncoder().encode(signingKey).byteLength < MIN_SECRET_BYTES) throw new ConfigError(`CRITIQS_PROXY_SIGNING_KEY must be at least ${MIN_SECRET_BYTES} bytes.`);
  if (signingKey === "" && !local) {
    throw new ConfigError(`Set CRITIQS_PROXY_SIGNING_KEY (${MIN_SECRET_BYTES} bytes or more, held only by the proxy): without it, the backend's copy of CRITIQS_PROXY_SECRET could sign asset addresses.`);
  }
  const previousSigningKey = env.CRITIQS_PROXY_SIGNING_KEY_PREVIOUS ?? "";
  if (previousSigningKey !== "" && new TextEncoder().encode(previousSigningKey).byteLength < MIN_SECRET_BYTES) {
    throw new ConfigError(`CRITIQS_PROXY_SIGNING_KEY_PREVIOUS must be at least ${MIN_SECRET_BYTES} bytes.`);
  }
  const clientIpText = env.CRITIQS_PROXY_CLIENT_IP_HEADER?.trim().toLowerCase() || null;
  if (clientIpText === null && !local) {
    throw new ConfigError(
      "Set CRITIQS_PROXY_CLIENT_IP_HEADER to the header the server in front sets to the viewer's address (such as cf-connecting-ip), or to connection when viewers connect to the proxy directly: otherwise every viewer looks like one client, and one client's lookups use up everyone's.",
    );
  }
  const clientIpHeader = clientIpText === "connection" ? null : clientIpText;
  // Only a header a front server writes with the viewer's address: any other (Host, Cookie, a made-up name) is the client's own words.
  if (clientIpHeader !== null && !CLIENT_ADDRESS_HEADERS.includes(clientIpHeader)) {
    throw new ConfigError(`CRITIQS_PROXY_CLIENT_IP_HEADER must be a header the server in front sets to the viewer's address (${CLIENT_ADDRESS_HEADERS.join(", ")}), or connection.`);
  }

  const isolationText = env.CRITIQS_PROXY_COOKIE_ISOLATION?.trim() ?? "";
  let cookieIsolation: CookieIsolation;
  if (local) cookieIsolation = "local";
  else if ((COOKIE_ISOLATION as readonly string[]).includes(isolationText)) cookieIsolation = isolationText as CookieIsolation;
  else {
    throw new ConfigError(
      `Set CRITIQS_PROXY_COOKIE_ISOLATION to public-suffix-list once ${domain.hostname} is on the Public Suffix List, or to ingress-drops-cookies when the server in front accepts request headers of 2 MiB and removes Cookie: until then one frame host's cookies can stop every other review link for its viewer, in Chrome and Firefox alike. Many managed front servers refuse such large headers before any rule can remove them; check yours first.`,
    );
  }

  const webRiskKey = env.CRITIQS_WEB_RISK_API_KEY?.trim() || null;
  if (webRiskKey === null && !local) throw new ConfigError("Set CRITIQS_WEB_RISK_API_KEY: without a URL reputation check, review links serve only on a .localhost domain.");

  const website = webOrigins[0]!;
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [key, numberSetting(env, `CRITIQS_PROXY_LIMIT_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`, fallback)]),
  ) as unknown as ProxyLimits;

  return {
    domain,
    webOrigins,
    backend,
    secret,
    signingKey: signingKey !== "" ? signingKey : createHmac("sha256", secret).update("critiqs-review-proxy signing key").digest("base64url"),
    previousSigningKey: previousSigningKey !== "" ? previousSigningKey : null,
    clientIpHeader,
    egress,
    userAgent: `${REVIEW_USER_AGENT_TOKEN} (+${website}/allow-critiqs)`,
    assetUserAgent: ASSET_USER_AGENT,
    webRiskKey,
    local,
    cookieIsolation,
    limits,
  };
}

/**
 * Convex serves one deployment under two names, `<name>.convex.cloud` (its
 * API) and `<name>.convex.site` (its HTTP actions): both are the backend.
 */
function backendNames(hostname: string): string[] {
  const convex = /^([a-z0-9-]+)\.convex\.(?:site|cloud)$/.exec(hostname);
  return convex === null ? [hostname] : [`${convex[1]}.convex.site`, `${convex[1]}.convex.cloud`];
}

/**
 * What the proxy never fetches, beyond private addresses: itself (its domain
 * and every lease host under it, the website, the backend, its own egress
 * addresses), so no link can loop through the proxy or reach Critiqs's own
 * services, and NAT64 and 6to4 addresses, whose IPv4 side it can't see.
 */
export function proxyPolicy(config: Pick<ProxyConfig, "domain" | "webOrigins" | "backend" | "egress">): PublicWebPolicy {
  return {
    blockedHosts: [config.domain.hostname, ...config.webOrigins.map((text) => new URL(text).hostname), ...backendNames(config.backend.hostname)],
    blockedCidrs: config.egress,
    denyTransitionIpv6: true,
  };
}
