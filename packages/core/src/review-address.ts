/**
 * A project's review address (F13): the page mention emails open, set by the
 * project's owner. Every copy of the prototype (local, preview, deployed)
 * shares one project, so emails link to this one page rather than to the copy
 * a comment was left on.
 */
import { LINK_PARAMETER } from "./links.ts";

/** Longest review address a project can save. */
export const MAX_REVIEW_URL_LENGTH = 2000;

/**
 * The address as it is saved, or null if mention emails can't link to it:
 * HTTPS, or plain HTTP on this computer, without a username or password.
 * The page's path, parameters, and hash route are kept; a Critiqs link
 * parameter copied with it is removed.
 */
export function validReviewUrl(value: string): string | null {
  if (value.length > MAX_REVIEW_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.searchParams.has(LINK_PARAMETER)) url.searchParams.delete(LINK_PARAMETER);
    const saved = url.toString();
    return saved.length > MAX_REVIEW_URL_LENGTH ? null : saved;
  } catch {
    return null;
  }
}

/**
 * Whether an address names this computer or a private network, such as
 * `http://localhost:5173`, `http://192.168.1.4:3000`, or a Tailscale address
 * (`*.ts.net`, `100.64.0.0/10`), so only people on that computer or network can
 * open it. Private review addresses are allowed; this only informs. An address
 * that isn't recognized as private isn't thereby known to be public.
 */
export function isPrivateReviewAddress(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host.includes(":")) return isPrivateIpv6(host);
  if (/^\d+(?:\.\d+){3}$/.test(host)) return isPrivateIpv4(host);
  return (
    host === "localhost" ||
    // A name without a dot, such as `http://devbox:3000`, is resolved on the local network.
    !host.includes(".") ||
    /\.(localhost|local|internal|home\.arpa|ts\.net)$/.test(host)
  );
}

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    // Shared address space, which Tailscale assigns to devices.
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  // An IPv4 address written as IPv6, such as ::ffff:7f00:1 for 127.0.0.1.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Unique local (fc00::/7, including Tailscale's fd7a:115c:a1e0::/48), link-local (fe80::/10), and multicast (ff00::/8).
  const first = Number.parseInt(host.split(":")[0]!, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}
