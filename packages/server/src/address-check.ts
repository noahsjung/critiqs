import type { Resolver } from "node:dns/promises";
import type http from "node:http";
import type https from "node:https";
import { type AddressCheck, classifyAddress, type FetchedAddress, isLocalAddress, MAX_REVIEW_URL_LENGTH, type PageHop } from "@critiqs/core";
import { fail } from "./errors.ts";

// Onboarding's address check: Critiqs's server fetches an address anyone
// signed in can type, and reports what it found (core's `classifyAddress`).
// So the fetch must never reach Critiqs's own network or probe other
// services. Only ports 80 and 443 are allowed. Every host is resolved
// first and refused when any of its addresses isn't public; the connection
// then goes to the address that was checked, so a second DNS answer can't
// swap in a private one. Redirects are checked the same way, hop by hop.
// Callers learn only the coarse result, never addresses, statuses, or errors.
// The connections use Node's networking modules, which callers pass in
// (`nodeNetwork`): this file also ships in Convex's default runtime, which has
// none. The SQLite server (Bun or Node) and Convex's "use node" actions do.

export const ADDRESS_CHECK_TIMEOUT_MS = 5_000;
export const MAX_ADDRESS_REDIRECTS = 3;
export const MAX_ADDRESS_BODY_BYTES = 256 * 1024;
export const ADDRESS_CHECK_USER_AGENT = "Critiqs-Check/1 (+https://critiqs.app)";
/**
 * Address checks one process runs at once. The hourly limits
 * (`claimAddressCheck`) use fixed UTC hours, so a burst at an hour's edge can
 * spend two hours' worth; this cap bounds what runs at any moment.
 */
export const MAX_CONCURRENT_ADDRESS_CHECKS = 16;

const REQUEST_HEADERS = { "User-Agent": ADDRESS_CHECK_USER_AGENT, Accept: "text/html", "Accept-Encoding": "identity" };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** One GET to `url`, connecting only to `address`, with `url`'s host in the Host header and for TLS. */
export interface PinnedRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  /** Aborts the request at the check's deadline. */
  signal: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  /** As received; `checkAddress` lowercases the names. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The body in chunks. Ending the iteration early stops the transfer. */
  body: AsyncIterable<Uint8Array>;
}

export interface AddressCheckDeps {
  /** Every address a host name resolves to. Stops, settling, when `signal` aborts at the check's deadline. */
  resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]>;
  fetchPinned(request: PinnedRequest): Promise<PinnedResponse>;
  /** The whole check's deadline, DNS included. Default `ADDRESS_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The address someone typed, checked before anything is fetched. Refuses with
 * an `invalid` error, for the caller to show, anything but a plain `http:` or
 * `https:` address without a username or password.
 */
export function parsePrototypeAddress(input: string): URL {
  const text = input.trim();
  if (text === "") fail("invalid", "Enter your prototype's address.");
  if (text.length > MAX_REVIEW_URL_LENGTH) fail("invalid", `An address can have at most ${MAX_REVIEW_URL_LENGTH} characters.`);
  const url = acceptable(text);
  if (url === "malformed") fail("invalid", "Enter the full address, starting with https://.");
  if (url === "scheme") fail("invalid", "Enter an address that starts with https:// or http://.");
  if (url === "credentials") fail("invalid", "Leave the username and password out of the address.");
  return url;
}

function acceptable(text: string, base?: URL): URL | "malformed" | "scheme" | "credentials" {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    return "malformed";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  return url;
}

/**
 * What's at an address someone typed: `local` without any network access for
 * an address on their computer or network, otherwise what core's
 * `classifyAddress` makes of the responses. Anything refused or failed is
 * `unreachable`. Invalid input throws (see `parsePrototypeAddress`).
 */
export async function checkAddress(input: string | URL, deps: AddressCheckDeps): Promise<AddressCheck> {
  const url = typeof input === "string" ? parsePrototypeAddress(input) : input;
  if (isLocalAddress(url)) return { kind: "local" };
  const signal = AbortSignal.timeout(deps.timeoutMs ?? ADDRESS_CHECK_TIMEOUT_MS);
  try {
    const fetched = await fetchAddress(url, deps, signal);
    return fetched === null ? { kind: "unreachable" } : classifyAddress(fetched);
  } catch {
    // A network or TLS error, the deadline, or a misbehaving server. Never reported in detail.
    return { kind: "unreachable" };
  }
}

let checksRunning = 0;

/**
 * The onboarding operation: checks the address, counts the check with
 * `claim` (`claimAddressCheck` in its own transaction, which requires sign-in
 * and applies the hourly limits), then fetches. An invalid address, or one
 * past `MAX_CONCURRENT_ADDRESS_CHECKS`, is refused before anything is counted.
 */
export async function checkPrototypeAddress(
  run: { claim: () => Promise<void>; deps: AddressCheckDeps },
  args: { address: string },
): Promise<AddressCheck> {
  const url = parsePrototypeAddress(args.address);
  if (isLocalAddress(url)) {
    await run.claim();
    return { kind: "local" };
  }
  if (checksRunning >= MAX_CONCURRENT_ADDRESS_CHECKS) fail("limit", "Critiqs is busy checking other addresses. Try again in a moment, or skip this step.");
  checksRunning++;
  try {
    await run.claim();
    return await checkAddress(url, run.deps);
  } finally {
    checksRunning--;
  }
}

/**
 * The responses, following at most `MAX_ADDRESS_REDIRECTS` redirects; null
 * when a hop is refused or there are more redirects. `hops` holds only
 * addresses that passed every check and were fetched.
 */
async function fetchAddress(start: URL, deps: AddressCheckDeps, signal: AbortSignal): Promise<FetchedAddress | null> {
  const hops: PageHop[] = [];
  let url = start;
  for (;;) {
    // Only the scheme's default port (80 for http, 443 for https; URL leaves
    // `port` empty for it, written or not), so the check can't probe other services.
    if (url.port !== "") return null;
    const address = await beforeDeadline(publicAddress(url, deps.resolve, signal), signal);
    if (address === null) return null;
    const response = await beforeDeadline(deps.fetchPinned({ url, address, headers: REQUEST_HEADERS, signal }), signal);
    const hop: PageHop = { url: url.href, status: response.status, headers: lowercaseHeaders(response.headers) };
    hops.push(hop);
    const redirect = hop.status >= 300 && hop.status < 400 ? hop.headers.location : undefined;
    if (redirect !== undefined) {
      stop(response.body);
      // Past the limit, unreachable. Core reads every Location in `hops`, and
      // this one's destination was never checked, so it mustn't reach core.
      if (hops.length > MAX_ADDRESS_REDIRECTS) return null;
      const next = acceptable(redirect, url);
      if (typeof next === "string" || isLocalAddress(next)) return null;
      url = next;
      continue;
    }
    if (!NEEDS_BODY(hop.status)) {
      stop(response.body);
      return { hops, html: null };
    }
    return { hops, html: await readCapped(response.body, MAX_ADDRESS_BODY_BYTES, signal) };
  }
}

/** Responses `classifyAddress` reads a body for: pages, and refusals that may be a sign-in page or a bot wall. */
const NEEDS_BODY = (status: number) => (status >= 200 && status < 300) || [401, 403, 429, 503].includes(status);

/**
 * The address to connect to, when every address the host resolves to is
 * public; IPv4 first. A public name that resolves to a private address is
 * unreachable, not local, on purpose: the caller never learns which names
 * point inside a network.
 */
async function publicAddress(url: URL, resolve: AddressCheckDeps["resolve"], signal: AbortSignal): Promise<ResolvedAddress | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal: ResolvedAddress["family"] | null = ipv4(host) !== null ? 4 : ipv6(host) !== null ? 6 : null;
  const answers: readonly ResolvedAddress[] = literal !== null ? [{ address: host, family: literal }] : await resolve(host, signal);
  if (answers.length === 0 || !answers.every((answer) => isPublicAddress(answer.address))) return null;
  return answers.find((answer) => answer.family === 4) ?? answers[0]!;
}

function lowercaseHeaders(raw: PinnedResponse["headers"]): Record<string, string> {
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

/** Reads at most `max` bytes, then stops the transfer. */
async function readCapped(body: AsyncIterable<Uint8Array>, max: number, signal: AbortSignal): Promise<string> {
  const chunks = body[Symbol.asyncIterator]();
  const kept: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await beforeDeadline(chunks.next(), signal);
      if (done) break;
      const part = value.subarray(0, max - size);
      kept.push(part);
      size += part.byteLength;
    }
  } finally {
    // Not awaited: a body stuck at the deadline may never answer.
    void chunks.return?.()?.catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function stop(body: AsyncIterable<Uint8Array>): void {
  void body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
}

/** `work`, or a rejection at the deadline even when `work` ignores the signal. */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

// Which addresses are public.

/** IPv4 blocks that aren't the public internet, as [first address, prefix length]. */
const PRIVATE_IPV4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network", including the unspecified 0.0.0.0
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including cloud metadata at 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // former 6to4 relays
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including the broadcast address 255.255.255.255
];

const PRIVATE_IPV4_BLOCKS = PRIVATE_IPV4.map(([first, bits]) => ({ first: ipv4(first)!, bits }));

/** An IPv4 address in dotted decimal as a 32-bit number, or null. */
function ipv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

/** An IPv6 address as its eight 16-bit groups, or null. Accepts a trailing dotted IPv4 part and a zone. */
function ipv6(text: string): number[] | null {
  let address = text.toLowerCase().split("%")[0]!;
  const last = address.lastIndexOf(":");
  if (last === -1) return null;
  const tail = address.slice(last + 1);
  if (tail.includes(".")) {
    const embedded = ipv4(tail);
    if (embedded === null) return null;
    address = `${address.slice(0, last + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  return missing < 1 ? null : [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isPublicIpv4(value: number): boolean {
  return !PRIVATE_IPV4_BLOCKS.some(({ first, bits }) => value >>> (32 - bits) === first >>> (32 - bits));
}

function isPublicIpv6(groups: number[]): boolean {
  const [a, b] = groups as [number, number];
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const embedded = (high: number, low: number) => isPublicIpv4(groups[high]! * 0x10000 + groups[low]!);
  // IPv4-mapped addresses (::ffff:0:0/96) are refused whatever IPv4 address
  // they carry: no public name needs one, since its A record serves IPv4, and
  // the socket would connect to the IPv4 address inside.
  if (zeros(0, 5) && groups[5] === 0xffff) return false;
  // NAT64 (64:ff9b::a.b.c.d) reaches the IPv4 address it carries.
  if (a === 0x64 && b === 0xff9b && zeros(2, 6)) return embedded(6, 7);
  // 6to4 (2002::/16) carries an IPv4 address in its next 32 bits.
  if (a === 0x2002) return embedded(1, 2);
  // Only global unicast (2000::/3) is public. That leaves out ::, ::1, IPv4-compatible
  // addresses (::a.b.c.d), unique local (fc00::/7), link-local (fe80::/10), and multicast (ff00::/8).
  if ((a & 0xe000) !== 0x2000) return false;
  // Special blocks inside it: IETF assignments including Teredo (2001::/23), and documentation (2001:db8::/32).
  return !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}

/** Whether an IP address is on the public internet, so the check may connect to it. */
export function isPublicAddress(address: string): boolean {
  const value = ipv4(address);
  if (value !== null) return isPublicIpv4(value);
  const groups = ipv6(address);
  return groups !== null && isPublicIpv6(groups);
}

// The real network.

/** Node's networking modules, from a caller that runs in Node or Bun. */
export interface NodeNetwork {
  http: typeof http;
  https: typeof https;
  /** node:dns/promises's `Resolver`. */
  Resolver: typeof Resolver;
}

/** DNS answers that mean a name has no address of that family. Bun says ENOTFOUND where Node says ENODATA. */
const NO_ADDRESSES = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * The real resolver and connections. Names are resolved with A and AAAA
 * queries that are cancelled at the check's deadline (`dns.lookup` can't be
 * stopped once started). Each GET goes over node:http or node:https and
 * connects only to the pinned address; the URL's host still goes in the Host
 * header, in TLS's server name (SNI), and in the certificate check. For
 * tests, `forTests.ca` adds trusted certificates and `forTests.dnsServers`
 * replaces the system's DNS servers.
 */
export function nodeNetwork(node: NodeNetwork, forTests: { ca?: string; dnsServers?: readonly string[] } = {}): AddressCheckDeps {
  const family = async (answers: Promise<string[]>, family: ResolvedAddress["family"]): Promise<ResolvedAddress[]> => {
    try {
      return (await answers).map((address) => ({ address, family }));
    } catch (error) {
      if (NO_ADDRESSES.has((error as { code?: string }).code ?? "")) return [];
      throw error;
    }
  };
  return {
    resolve: async (hostname, signal) => {
      signal.throwIfAborted();
      const resolver = new node.Resolver({ timeout: 2_000, tries: 2 });
      if (forTests.dnsServers !== undefined) resolver.setServers(forTests.dnsServers);
      const cancel = () => resolver.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const [v4, v6] = await Promise.all([family(resolver.resolve4(hostname), 4), family(resolver.resolve6(hostname), 6)]);
        return [...v4, ...v6];
      } finally {
        signal.removeEventListener("abort", cancel);
        // Also stops the other query when one failed.
        resolver.cancel();
      }
    },
    fetchPinned: ({ url, address, headers, signal }) =>
      new Promise((resolve, reject) => {
        const secure = url.protocol === "https:";
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const named = ipv4(host) === null && ipv6(host) === null;
        const options: https.RequestOptions = {
          method: "GET",
          host,
          port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, Host: url.host, Connection: "close" },
          agent: false,
          signal,
          // The only answer a lookup can give, whatever DNS says now.
          lookup: (_hostname, lookupOptions, callback) =>
            lookupOptions.all ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family),
          ...(secure && named ? { servername: host } : {}),
          ...(secure && forTests.ca !== undefined ? { ca: forTests.ca } : {}),
        };
        const request = (secure ? node.https : node.http).request(options, (response) => {
          // Errors after the response surface through the body's iteration.
          response.on("error", () => undefined);
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: chunksOf(response, () => request.destroy()) });
        });
        request.on("error", reject);
        request.end();
      }),
  };
}

function chunksOf(response: http.IncomingMessage, end: () => void): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      const chunks = response[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
      return {
        next: () => chunks.next(),
        return: async () => {
          end();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
