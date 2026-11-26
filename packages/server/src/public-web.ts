import type { Resolver } from "node:dns/promises";
import type http from "node:http";
import type https from "node:https";
import { MAX_REVIEW_URL_LENGTH } from "@critiqs/core";
import { fail } from "./errors.ts";

// Reaching the public web, and only the public web, from Critiqs's servers.
// Two callers fetch addresses people type: onboarding's address check
// (`address-check.ts`) and the review-link proxy (`apps/review-proxy`). Both
// resolve a host first, refuse it when any of its addresses isn't public, and
// then connect only to the address they checked, so a second DNS answer can't
// swap in a private one (DNS rebinding). The connection uses Node's networking
// modules, which callers pass in (`nodeNetwork`): this file also ships in
// Convex's default runtime, which has none.

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** One request to `url`, connecting only to `address`, with `url`'s host in the Host header and for TLS. */
export interface PinnedRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  /** Aborts the request, including a body still arriving. */
  signal: AbortSignal;
  /** GET unless given. The proxy also sends HEAD; nothing here sends a body. */
  method?: "GET" | "HEAD";
}

export interface PinnedResponse {
  status: number;
  /** As received; callers lowercase the names. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The body in chunks. Ending the iteration early stops the transfer. */
  body: AsyncIterable<Uint8Array>;
}

/** The network a public-web fetch uses: DNS and pinned connections. Tests pass their own. */
export interface PublicWeb {
  /** Every address a host name resolves to. Stops, settling, when `signal` aborts. */
  resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]>;
  fetchPinned(request: PinnedRequest): Promise<PinnedResponse>;
}

// Addresses people type.

/**
 * The address someone typed, checked before anything is fetched. Refuses with
 * an `invalid` error, for the caller to show, anything but a plain `http:` or
 * `https:` address without a username or password.
 */
export function parsePrototypeAddress(input: string): URL {
  const text = input.trim();
  if (text === "") fail("invalid", "Enter your prototype's address.");
  if (text.length > MAX_REVIEW_URL_LENGTH) fail("invalid", `An address can have at most ${MAX_REVIEW_URL_LENGTH} characters.`);
  const url = acceptableAddress(text);
  if (url === "malformed") fail("invalid", "Enter the full address, starting with https://.");
  if (url === "scheme") fail("invalid", "Enter an address that starts with https:// or http://.");
  if (url === "credentials") fail("invalid", "Leave the username and password out of the address.");
  return url;
}

/** `text` read against `base`, when it is a plain `http:` or `https:` address without a username or password; otherwise why not. */
export function acceptableAddress(text: string, base?: URL): URL | "malformed" | "scheme" | "credentials" {
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

/** NAT64 (64:ff9b::/96) and 6to4 (2002::/16): IPv6 addresses that reach the IPv4 address they carry. */
function isTransitionIpv6(groups: number[]): boolean {
  const [a, b] = groups as [number, number];
  return (a === 0x64 && b === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) || a === 0x2002;
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

// A caller's own refusals, on top of the public rule.

/**
 * More that a caller refuses beyond private addresses. The review-link proxy
 * refuses itself (its own domain, the website, its backend, its egress
 * addresses), so a link can't make it fetch through itself, and the IPv6
 * transition blocks, whose IPv4 side it can't see.
 */
export interface PublicWebPolicy {
  /** Host names refused, with every name under them. Compared without case or a trailing dot. */
  blockedHosts?: readonly string[];
  /** Address blocks refused, such as `203.0.113.10/32` or `2001:db8::/48`. */
  blockedCidrs?: readonly string[];
  /** Refuse NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses even when the IPv4 address they carry is public. */
  denyTransitionIpv6?: boolean;
}

/** An address block, parsed. */
export interface Cidr {
  family: 4 | 6;
  /** The address as 32-bit (IPv4) or 128-bit (IPv6) number. */
  value: bigint;
  bits: number;
}

/** `203.0.113.0/24` or `2001:db8::/32` (a bare address is one address), or null when it isn't one. */
export function parseCidr(text: string): Cidr | null {
  const [address, length, ...extra] = text.trim().split("/");
  if (address === undefined || extra.length > 0) return null;
  const value4 = ipv4(address);
  const groups = value4 === null ? ipv6(address) : null;
  if (value4 === null && groups === null) return null;
  const family = value4 !== null ? 4 : 6;
  const max = family === 4 ? 32 : 128;
  if (length !== undefined && !/^\d{1,3}$/.test(length)) return null;
  const bits = length === undefined ? max : Number(length);
  if (bits > max) return null;
  const value = value4 !== null ? BigInt(value4) : groups!.reduce((sum, group) => (sum << 16n) | BigInt(group), 0n);
  return { family, value, bits };
}

function addressValue(address: string): { family: 4 | 6; value: bigint } | null {
  const value4 = ipv4(address);
  if (value4 !== null) return { family: 4, value: BigInt(value4) };
  const groups = ipv6(address);
  return groups === null ? null : { family: 6, value: groups.reduce((sum, group) => (sum << 16n) | BigInt(group), 0n) };
}

/** Whether `address` is inside `cidr`. */
export function inCidr(address: string, cidr: Cidr): boolean {
  const parsed = addressValue(address);
  if (parsed === null || parsed.family !== cidr.family) return false;
  const shift = BigInt((cidr.family === 4 ? 32 : 128) - cidr.bits);
  return parsed.value >> shift === cidr.value >> shift;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** Whether a host name is one the policy refuses, or under one. */
export function isBlockedHost(hostname: string, policy: PublicWebPolicy = {}): boolean {
  const host = bareHost(hostname);
  return (policy.blockedHosts ?? []).some((blocked) => {
    const name = bareHost(blocked);
    return name !== "" && (host === name || host.endsWith(`.${name}`));
  });
}

/** Whether a resolved address may be connected to: public, and not refused by the policy. */
export function isAllowedAddress(address: string, policy: PublicWebPolicy = {}): boolean {
  if (!isPublicAddress(address)) return false;
  if (policy.denyTransitionIpv6 === true) {
    const groups = ipv6(address);
    if (groups !== null && isTransitionIpv6(groups)) return false;
  }
  for (const text of policy.blockedCidrs ?? []) {
    const cidr = parseCidr(text);
    // A policy block that doesn't parse refuses everything: a typo must not open a hole.
    if (cidr === null || inCidr(address, cidr)) return false;
  }
  return true;
}

/**
 * The address to connect to, when the host isn't refused by name and every
 * address it resolves to is allowed; IPv4 first. A public name that resolves
 * to a private address is refused, not reported as local, on purpose: the
 * caller never learns which names point inside a network.
 */
export async function resolvePublicAddress(
  url: URL,
  resolve: PublicWeb["resolve"],
  signal: AbortSignal,
  policy: PublicWebPolicy = {},
): Promise<ResolvedAddress | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHost(host, policy)) return null;
  const literal: ResolvedAddress["family"] | null = ipv4(host) !== null ? 4 : ipv6(host) !== null ? 6 : null;
  const answers: readonly ResolvedAddress[] = literal !== null ? [{ address: host, family: literal }] : await resolve(host, signal);
  if (answers.length === 0 || !answers.every((answer) => isAllowedAddress(answer.address, policy))) return null;
  return answers.find((answer) => answer.family === 4) ?? answers[0]!;
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
 * queries that are cancelled when the signal aborts (`dns.lookup` can't be
 * stopped once started). Each request goes over node:http or node:https with
 * no shared agent and no proxy settings from the environment, and connects
 * only to the pinned address; the URL's host still goes in the Host header,
 * in TLS's server name (SNI), and in the certificate check. For tests,
 * `forTests.ca` adds trusted certificates and `forTests.dnsServers` replaces
 * the system's DNS servers.
 */
export function nodeNetwork(node: NodeNetwork, forTests: { ca?: string; dnsServers?: readonly string[] } = {}): PublicWeb {
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
    fetchPinned: ({ url, address, headers, signal, method = "GET" }) =>
      new Promise((resolve, reject) => {
        const secure = url.protocol === "https:";
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const named = ipv4(host) === null && ipv6(host) === null;
        const options: https.RequestOptions = {
          method,
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
