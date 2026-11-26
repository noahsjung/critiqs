import { canonicalHost, hostOf, isHostWithin, isLocalAddress, MAX_REVIEW_URL_LENGTH, siteOf } from "@critiqs/core";
import { fail } from "./errors.ts";
import { isPublicAddress } from "./public-web.ts";

// Review links: the rules the backend, the review proxy, and the website
// agree on. A review link is a durable, unguessable key on the Critiqs
// website (`<website>/r/<key>`); the backend stores only its hash and derives
// it again from the link's ID when an owner copies it. Opening a link mints a
// short lease for one viewer: a fresh random frame host on the proxy domain
// (`v-<label>.<proxy domain>`), stored only as a hash. The proxy asks the
// backend what a frame host stands for on every request it can't answer from
// a cache of at most five seconds, and the backend checks the link, the
// project's review access, its address list, the reputation verdict, the deny
// list, and usage each time. Nothing here touches the network except
// `webRiskVerdict`, which asks Google Web Risk about one address.

/** A review link's key: 26 characters of base32 (130 bits), the `<key>` in `<website>/r/<key>`. */
export const REVIEW_LINK_KEY = /^[a-z2-7]{26}$/;
/** A frame host's first label: `v-` and 26 characters of base32 from 128 random bits. */
export const FRAME_LABEL = /^v-[a-z2-7]{26}$/;
/** What the backend and proxy exchange for a frame host: base64url SHA-256 of its label. */
export const HOST_HASH = /^[A-Za-z0-9_-]{43}$/;
/** An Allow Critiqs token: base64url, as an HMAC gives it. */
export const ALLOW_TOKEN = /^[A-Za-z0-9_-]{22,86}$/;

/** A lease lasts this long unless renewed. */
export const REVIEW_LEASE_MS = 10 * 60_000;
/** How often the review page renews its lease. */
export const RENEW_EVERY_MS = 5 * 60_000;
/** A lease never lasts longer than this after it was issued, however often it is renewed. */
export const REVIEW_LEASE_MAX_MS = 8 * 60 * 60_000;
/** The longest the proxy may reuse an answer about a frame host. */
export const RESOLUTION_CACHE_MS = 5_000;
/** A clean reputation verdict is trusted this long; after it, the link waits for a new check. */
export const REPUTATION_MAX_AGE_MS = 48 * 60 * 60_000;
/** Active links are checked again once their verdict is this old. */
export const REPUTATION_RECHECK_MS = 24 * 60 * 60_000;
/** The shortest proxy secret accepted. */
export const MIN_PROXY_SECRET = 32;

/** Pilot ceilings, until plans set their own. */
export const REVIEW_LINK_LIMITS = {
  /** Links in a project being checked or active at once. */
  activePerProject: 20,
  /** Live links one person may create in a day (UTC). */
  createsPerPersonPerDay: 10,
  /** Leases one link may mint in an hour. */
  leasesPerLinkPerHour: 60,
  /** Requests the proxy may serve for one link in a day (UTC) before it pauses until the next. */
  requestsPerLinkPerDay: 50_000,
  /** Bytes the proxy may serve for one link in a day (UTC) before it pauses until the next. */
  bytesPerLinkPerDay: 5 * 1024 ** 3,
  /** Origins besides its own a link's pages may read from (`/__critiqs/o/<slot>/…`). */
  assetOrigins: 4,
  /** Usage reports in one request from the proxy. */
  usageReports: 500,
} as const;

// ---------------------------------------------------------------------------
// Keys, hashes, and secrets

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, without padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** A fresh frame host label: `v-` and 128 random bits. */
export function newFrameLabel(): string {
  return `v-${base32(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** A random one-use secret, such as a lease's renewal secret. */
export function newSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Hash of a frame host label, as the proxy sends it and the backend stores it. */
export async function frameHostHash(label: string): Promise<string> {
  return base64url(await sha256(`critiqs-frame-host:${label.toLowerCase()}`));
}

/** Hash of a link key, as the backend stores it. */
export async function linkKeyHash(key: string): Promise<string> {
  return base64url(await sha256(`critiqs-review-link:${key}`));
}

/** Hash of a renewal secret, as the backend stores it. */
export async function renewalHash(secret: string): Promise<string> {
  return base64url(await sha256(`critiqs-review-renewal:${secret}`));
}

/**
 * A link's key, derived from its ID with the deployment's own key ring, so the
 * key itself is never stored and an owner can still copy the link again.
 */
export async function deriveLinkKey(ringSecret: string, linkId: string, version: number): Promise<string> {
  return base32(await hmac(ringSecret, `critiqs-review-link\n${linkId}\n${version}`)).slice(0, 26);
}

/** Compares two strings in time that doesn't depend on where they differ. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/**
 * Whether a request from the proxy carries the shared secret
 * (`Authorization: Bearer <secret>`), or during a rotation the previous one.
 * A secret shorter than `MIN_PROXY_SECRET` characters never matches.
 */
export async function proxyAuthorized(authorization: string | null, secret: string | undefined, previous?: string): Promise<boolean> {
  const given = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? "";
  let matched = false;
  for (const candidate of [secret, previous]) {
    if (candidate !== undefined && candidate.length >= MIN_PROXY_SECRET && (await sameSecret(given, candidate))) matched = true;
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Addresses

/** Where the proxy serves frames: `https://<proxy domain>`, or plain HTTP under `localhost` on one computer. */
export interface ProxyAddress {
  protocol: "https:" | "http:";
  /** The proxy domain with its port, such as `critiqs-review.net` or `review.localhost:5260`. */
  host: string;
  hostname: string;
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** The proxy's address from its setting, or null when it isn't a bare origin the frames can use. */
export function parseProxyAddress(value: string | undefined): ProxyAddress | null {
  if (value === undefined || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return null;
  const hostname = hostOf(url);
  if (hostname === null) return null;
  if (url.protocol === "http:" && !isLocalhostName(hostname)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.startsWith("[")) url.hostname = hostname;
  return { protocol: url.protocol, host: url.host, hostname };
}

/**
 * Whether the proxy domain is its own site, apart from the website's and the
 * backend's: a frame host on a shared site (the same host, one under the
 * other, or siblings such as `proxy.critiqs.app` and `app.critiqs.app`)
 * could set cookies the website reads. Sites are compared as `siteOf` does,
 * the same rule the proxy refuses to start with.
 */
export function proxySeparate(proxy: ProxyAddress, others: readonly string[]): boolean {
  for (const other of others) {
    let hostname: string | null;
    try {
      hostname = hostOf(new URL(other));
    } catch {
      continue;
    }
    if (hostname === null || siteOf(hostname) === siteOf(proxy.hostname)) return false;
  }
  return true;
}

/** A frame host's origin on the proxy. */
export function frameOrigin(proxy: ProxyAddress, label: string): string {
  return `${proxy.protocol}//${label}.${proxy.host}`;
}

/** A live link's prototype: its exact origin and the path the link opens at. */
export interface LiveAddress {
  origin: string;
  /** Path and query, without a fragment; `/` at least. */
  path: string;
}

const SELF = "Critiqs's own addresses can't be reviewed through a review link.";

/**
 * A prototype address a live review link may serve: `https:` on the default
 * port, a public host name, no username or password. Hosts that are, or are
 * under, Critiqs's own (`refusedHosts`: the proxy domain, the website, the
 * backend) are refused, so the proxy never fetches itself.
 */
export function parseLiveAddress(input: string, refusedHosts: readonly string[]): LiveAddress {
  const text = input.trim();
  if (text === "") fail("invalid", "Enter your prototype's address.");
  if (text.length > MAX_REVIEW_URL_LENGTH) fail("invalid", `An address can have at most ${MAX_REVIEW_URL_LENGTH} characters.`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail("invalid", "Enter the full address, starting with https://.");
  }
  if (url.username !== "" || url.password !== "") fail("invalid", "Leave the username and password out of the address.");
  if (url.protocol !== "https:") fail("invalid", "A review link needs an address that starts with https://.");
  if (url.port !== "") fail("invalid", "A review link needs an address on the usual port, without :port.");
  // One spelling of the host for every check below and for what is stored.
  const host = hostOf(url);
  if (host === null) fail("invalid", "Enter the full address, starting with https://.");
  if (!url.hostname.startsWith("[")) url.hostname = host;
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  if (isLocalAddress(url) || !host.includes(".") || (literal && !isPublicAddress(host))) {
    fail("invalid", "This address is on a computer or private network. Share a build or use the browser extension instead.");
  }
  // `.invalid` never resolves (RFC 6761); shared builds' addresses use it, and none is a live site.
  if (isHostWithin(host, "invalid")) fail("invalid", "This address can't be reached on the internet. Use your prototype's public https:// address.");
  for (const refused of refusedHosts) {
    const name = canonicalHost(refused);
    if (name !== null && isHostWithin(host, name)) fail("invalid", SELF);
  }
  if (url.pathname.startsWith("/__critiqs/")) fail("invalid", "Paths starting with /__critiqs/ are reserved for review links.");
  if (url.pathname.startsWith("//")) fail("invalid", "Enter an address whose path starts with a single /.");
  return { origin: url.origin, path: `${url.pathname}${url.search}` };
}

/** What a reputation provider is asked about: the origin and path, never the query or fragment. */
export function reputationSubject(origin: string, path: string): string {
  const url = new URL(path, origin);
  return `${url.origin}${url.pathname}`;
}

// ---------------------------------------------------------------------------
// Reputation

export type ReputationVerdict = "clean" | "unsafe" | "unknown";

/** Threat types asked about. */
const THREATS = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"];

/**
 * Google Cloud Web Risk's Lookup API verdict for one address (origin and path
 * only). Anything but a clear answer is `unknown`, which callers treat as not
 * safe to serve.
 */
export async function webRiskVerdict(
  subject: string,
  options: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<ReputationVerdict> {
  const url = new URL("https://webrisk.googleapis.com/v1/uris:search");
  for (const threat of THREATS) url.searchParams.append("threatTypes", threat);
  url.searchParams.set("uri", subject);
  try {
    // The key goes in a header, so it never appears in a logged URL.
    const response = await (options.fetch ?? fetch)(url, { signal: options.signal ?? AbortSignal.timeout(5_000), redirect: "error", headers: { "X-Goog-Api-Key": options.apiKey } });
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { threat?: { threatTypes?: unknown } };
    if (body === null || typeof body !== "object") return "unknown";
    return body.threat === undefined ? "clean" : "unsafe";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// What the backend tells the proxy (`/internal/review/v1/*`)

/** What a frame host stands for, while every check still passes. */
export interface ReviewResolution {
  v: 1;
  kind: "site";
  linkId: string;
  leaseId: string;
  /** The prototype's origin, served at the root of the frame host. */
  origin: string;
  /** Owner-approved origins the pages may read from, by slot (`/__critiqs/o/<slot>/…`). */
  assetOrigins: { slot: number; origin: string }[];
  /**
   * Allow Critiqs tokens, one per origin of this lease that has one: the proxy
   * sends an origin's token (`Critiqs-Allow`) only on requests to that origin,
   * never to another site, so a site's firewall rule that requires its own
   * token lets only its own project's links through. Empty until Allow Critiqs
   * issues them.
   */
  allow: { origin: string; token: string }[];
  /** When the lease ends unless renewed. */
  expiresAt: number;
  /** The proxy may reuse this answer until then: at most `RESOLUTION_CACHE_MS` from when it was given, never past `expiresAt`. */
  cacheUntil: number;
}

/** One link's traffic since the proxy's last report. */
export interface ReviewUsageReport {
  linkId: string;
  requests: number;
  bytes: number;
}

function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A resolution from the backend, or null for anything else. The proxy serves nothing on null. */
export function parseReviewResolution(raw: unknown): ReviewResolution | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || value.kind !== "site") return null;
  if (typeof value.linkId !== "string" || typeof value.leaseId !== "string" || !isOrigin(value.origin)) return null;
  if (!count(value.expiresAt) || !count(value.cacheUntil) || value.cacheUntil > value.expiresAt) return null;
  if (!Array.isArray(value.assetOrigins) || value.assetOrigins.length > REVIEW_LINK_LIMITS.assetOrigins) return null;
  const assetOrigins: ReviewResolution["assetOrigins"] = [];
  for (const entry of value.assetOrigins as unknown[]) {
    if (entry === null || typeof entry !== "object") return null;
    const { slot, origin } = entry as Record<string, unknown>;
    if (!count(slot) || slot < 1 || slot > REVIEW_LINK_LIMITS.assetOrigins || !isOrigin(origin)) return null;
    assetOrigins.push({ slot, origin });
  }
  const allow: ReviewResolution["allow"] = [];
  if (value.allow !== undefined) {
    if (!Array.isArray(value.allow) || value.allow.length > 1 + REVIEW_LINK_LIMITS.assetOrigins) return null;
    const origins = new Set([value.origin, ...assetOrigins.map((entry) => entry.origin)]);
    for (const entry of value.allow as unknown[]) {
      if (entry === null || typeof entry !== "object") return null;
      const { origin, token } = entry as Record<string, unknown>;
      if (typeof origin !== "string" || !origins.has(origin) || typeof token !== "string" || !ALLOW_TOKEN.test(token)) return null;
      allow.push({ origin, token });
    }
  }
  return {
    v: 1,
    kind: "site",
    linkId: value.linkId,
    leaseId: value.leaseId,
    origin: value.origin,
    assetOrigins,
    allow,
    expiresAt: value.expiresAt,
    cacheUntil: value.cacheUntil,
  };
}

// ---------------------------------------------------------------------------
// What the website gets from `reviewLinks:*`

/** A lease, as the review page holds it. `renewalSecret` stays in the page's memory and is never sent to the frame. */
export interface ReviewEntry {
  /** The frame host's origin, `https://v-<label>.<proxy domain>`. */
  origin: string;
  /** The path the frame opens at. */
  path: string;
  leaseId: string;
  renewalSecret: string;
  expiresAt: number;
  renewEveryMs: number;
}

/**
 * What opening a link gives. Signed out, anything that isn't ready is
 * `sign-in`; signed in, it is `unavailable`, so a key that opens nothing, a
 * removed link, and one limited to an organization the person isn't in look
 * the same. `pending` (reputation not yet checked) and `limited` (too many
 * opens this hour) only reach someone who may open the link.
 */
export type ReviewOpen =
  | { kind: "sign-in" }
  | { kind: "unavailable" }
  | { kind: "pending" }
  | { kind: "limited" }
  | {
      kind: "ready";
      entry: ReviewEntry;
      /** Null until the viewer has signed in. */
      projectId: string | null;
      projectName: string | null;
      source: { kind: "site"; origin: string };
    };

export type ReviewRenewal = { kind: "renewed"; expiresAt: number } | { kind: "ended" };
export type ReviewAdoption = { kind: "adopted"; projectId: string; projectName: string } | { kind: "ended" };

export type ReviewLinkStatus = "checking" | "active" | "blocked" | "revoked";

/** A link as its project's owners see it. Never its key: `reviewLinks:copy` derives that on request. */
export interface ReviewLinkSummary {
  linkId: string;
  kind: "site";
  origin: string;
  startPath: string;
  assetOrigins: string[];
  status: ReviewLinkStatus;
  /** Past today's usage ceiling: paused until the next day (UTC). */
  paused: boolean;
  createdAt: number;
  createdByName: string;
  usageToday: { requests: number; bytes: number };
}

/** The capability `/critiqs/config` reports, absent when the deployment has no review proxy. */
export interface ReviewLinksCapability {
  version: 1;
  live: boolean;
  builds: boolean;
  allowCritiqs: boolean;
}
