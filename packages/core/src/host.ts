// What a host is. Every check that compares, refuses, signs or looks up a
// host name uses `canonicalHost`, so no spelling of one host (case, a
// trailing dot, Unicode, a numeric IPv4 form) is a different host to one
// check and the same host to DNS.

/**
 * A host name in the one form every check compares: the WHATWG URL parser's
 * (lowercase, Unicode as punycode, IPv4 in dotted decimal, IPv6 without
 * brackets), without the root's trailing dot. Null for anything that isn't a
 * plain host: a port, a path or credentials, an empty label (`a..b`), or more
 * than one trailing dot (`localhost..`), which DNS reads as the same name but
 * no real address needs.
 */
export function canonicalHost(text: string): string | null {
  const raw = text.trim();
  if (raw === "" || /[/\\?#@\s]/.test(raw)) return null;
  // A bracketed address followed by a port: the parser drops a default port, so it is refused here.
  if (/^\[[^\]]*\]./.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(`http://${raw.startsWith("[") || !raw.includes(":") ? raw : `[${raw}]`}/`);
  } catch {
    return null;
  }
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  let host = url.hostname;
  if (host.startsWith("[")) return host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.split(".").some((label) => label === "")) return null;
  return host;
}

/** `url`'s host in canonical form, or null when it isn't a plain host. */
export function hostOf(url: URL): string | null {
  return canonicalHost(url.hostname);
}

/** Whether `host` is `parent` or a name under it, both canonical. */
export function isHostWithin(host: string, parent: string): boolean {
  return parent !== "" && (host === parent || host.endsWith(`.${parent}`));
}

/**
 * A host's site, for telling whether two hosts can share cookies. Without the
 * Public Suffix List this is the last two labels (`app.critiqs.app` →
 * `critiqs.app`), which treats `co.uk` names as one site: it refuses more
 * than needed, never less. An IP address is its own site.
 */
export function siteOf(host: string): string {
  const name = canonicalHost(host) ?? host.toLowerCase();
  if (name.includes(":") || /^\d+(?:\.\d+){3}$/.test(name)) return name;
  return name.split(".").slice(-2).join(".");
}
