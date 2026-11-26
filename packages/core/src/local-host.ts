// Host names that only work on one computer or private network. Two rules,
// for two jobs, kept here together:
//
// - `isPrivateHost`: who can open an address. Review addresses warn about it
//   (`isPrivateReviewAddress`), and onboarding won't fetch it (`isLocalAddress`).
// - `isLocalHost`: which AI endpoints need the operator to allow local ones.
//
// They agree on IPv4. `isLocalHost` is not the same rule: it doesn't count names
// without a dot (a Docker service such as `http://ollama:11434` an operator
// lists), `home.arpa`, or `ts.net` as local, and it refuses every IPv4-mapped
// IPv6 address and matches IPv6 ranges by their leading characters, which also
// catches a few public addresses. Neither rule contains the other, so the AI
// endpoint check keeps its own, unchanged.

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
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

/** IPv6 ranges only a computer or private network reaches, by their exact prefixes. */
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

/**
 * Whether a URL's host name only opens on one computer or private network,
 * such as `localhost`, `192.168.1.4`, or `devbox` (a name without a dot,
 * resolved on the local network). A name not recognized as private isn't
 * thereby known to be public.
 *
 * Tailscale: `*.ts.net` names are a tailnet's MagicDNS names, which only that
 * tailnet's devices resolve. Tailscale Funnel can publish one of them on the
 * internet, and a Funnel address can't be told from a private one by its
 * name, so every `*.ts.net` name counts as private: a review address there
 * gets the warning, and onboarding asks for another way in instead of fetching it.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.includes(":")) return isPrivateIpv6(host);
  if (/^\d+(?:\.\d+){3}$/.test(host)) return isPrivateIpv4(host);
  return host === "localhost" || !host.includes(".") || /\.(localhost|local|internal|home\.arpa|ts\.net)$/.test(host);
}

/** For AI endpoints: IPv6 ranges matched by their leading characters, and every IPv4-mapped address refused. */
function isLocalIpv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!address.includes(":")) return false;
  if (address === "::" || address === "::1") return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  // Mapped addresses written in hex, such as ::ffff:7f00:1, are refused outright.
  if (address.startsWith("::ffff:")) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(address);
}

/** Whether an AI endpoint's host names this computer or a private network, by name or address. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateIpv4(host) ||
    isLocalIpv6(host)
  );
}
