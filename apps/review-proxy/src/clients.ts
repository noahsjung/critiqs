import { isIPv4, isIPv6 } from "node:net";

// Who a request comes from, for per-client limits. The address comes from the
// connection, or from the one header the server in front sets to the
// viewer's address. Both go through `clientKey`, so every way of writing one
// address gives one key and two addresses never share one by accident.

/**
 * Request headers that carry a client's address as set by a front server.
 * Any other name (Host, Cookie, User-Agent, a made-up one) is a header the
 * client writes itself, so the proxy refuses to start with it.
 */
export const CLIENT_ADDRESS_HEADERS: readonly string[] = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fly-client-ip",
  "fastly-client-ip",
  "x-azure-clientip",
  "x-appengine-user-ip",
  "x-envoy-external-address",
  "x-vercel-forwarded-for",
  "do-connecting-ip",
];

/** An IPv6 address's eight 16-bit groups, or null when it isn't one. */
function groupsOf(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address.toLowerCase();
  // An IPv4 tail (`::ffff:1.2.3.4`) is two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const parts = dotted[2]!.split(".").map(Number);
    text = `${dotted[1]}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...front, ...new Array<string>(8 - front.length - back.length).fill("0"), ...back].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** One address as written by a connection or a front server: a port, brackets or an IPv6 zone removed; null when it isn't an address. */
function addressOf(raw: string): string | null {
  let text = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed !== null) text = bracketed[1]!;
  else if (/^\d+\.\d+\.\d+\.\d+:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  text = text.replace(/%[0-9a-z._~-]+$/i, "");
  return isIPv4(text) || isIPv6(text) ? text : null;
}

/**
 * A client's key for per-client limits, from a connection's address or a
 * front server's header value (a list is read by its last entry, the one the
 * front added): an IPv4 address as itself, also when it arrives as an
 * IPv4-mapped IPv6 address (a listener on `::` sees IPv4 viewers that way);
 * an IPv6 address by its /64, which one subscriber usually holds whole. Null
 * when the value isn't an address.
 */
export function clientKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const address = addressOf(raw.split(",").at(-1) ?? "");
  if (address === null) return null;
  if (isIPv4(address)) return address.split(".").map(Number).join(".");
  const groups = groupsOf(address);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
