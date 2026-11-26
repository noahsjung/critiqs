import { parseCidr, type PublicWebPolicy } from "@critiqs/server/public-web";

// The proxy's settings, all from the environment, so the domain, the website
// and the backend are chosen at deploy time. Anything unsafe stops the
// process at start rather than serving with a hole.

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** How much one lease, one process and one response may use. Every number can be lowered per deployment. */
export interface ProxyLimits {
  /** Upstream reads at once for one lease, and for the whole process. Past either, 503 at once: there is no queue. */
  concurrentPerLease: number;
  concurrentPerProcess: number;
  /** Requests and bytes one lease may use per window. */
  windowMs: number;
  requestsPerWindow: number;
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
  concurrentPerProcess: 64,
  windowMs: 10 * 60_000,
  requestsPerWindow: 300,
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
  /** Shared with the backend for its internal routes, and the key for signed asset and leave URLs (CRITIQS_PROXY_SECRET, 32 bytes or more). */
  secret: string;
  /** The proxy's own outbound address blocks (CRITIQS_PROXY_EGRESS): published for Allow Critiqs, and refused as destinations. */
  egress: readonly string[];
  /** `Critiqs-Review/1 (+<website>/allow-critiqs)`. */
  userAgent: string;
  assetUserAgent: string;
  /** Google Web Risk's key (CRITIQS_WEB_RISK_API_KEY), or null. Without one, only a `.localhost` domain serves, with the test fixture. */
  webRiskKey: string | null;
  /** Whether the domain is a `.localhost` one: a computer's own test stack. */
  local: boolean;
  limits: ProxyLimits;
}

const MIN_SECRET_BYTES = 32;

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
  return url;
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * A host's site, for telling whether two hosts can share cookies. Without the
 * Public Suffix List this is the last two labels (`app.critiqs.app` →
 * `critiqs.app`), which treats `co.uk` names as one site: it refuses more
 * than needed, never less.
 */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.+$/, "").split(".");
  return labels.slice(-2).join(".");
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
    .map((text) => origin(text, "CRITIQS_WEB_ORIGINS").origin);
  if (webOrigins.length === 0) throw new ConfigError("Set CRITIQS_WEB_ORIGINS to the website origins that show review links.");

  const backendText = env.CRITIQS_PROXY_BACKEND;
  if (backendText === undefined || backendText === "") throw new ConfigError("Set CRITIQS_PROXY_BACKEND to the backend's HTTP address.");
  const backend = origin(backendText, "CRITIQS_PROXY_BACKEND");

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
    egress,
    userAgent: `${REVIEW_USER_AGENT_TOKEN} (+${website}/allow-critiqs)`,
    assetUserAgent: ASSET_USER_AGENT,
    webRiskKey,
    local,
    limits,
  };
}

/**
 * What the proxy never fetches, beyond private addresses: itself (its domain
 * and every lease host under it, the website, the backend, its own egress
 * addresses), so no link can loop through the proxy or reach Critiqs's own
 * services, and NAT64 and 6to4 addresses, whose IPv4 side it can't see.
 */
export function proxyPolicy(config: Pick<ProxyConfig, "domain" | "webOrigins" | "backend" | "egress">): PublicWebPolicy {
  return {
    blockedHosts: [config.domain.hostname, ...config.webOrigins.map((text) => new URL(text).hostname), config.backend.hostname],
    blockedCidrs: config.egress,
    denyTransitionIpv6: true,
  };
}
