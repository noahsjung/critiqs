// The review page's own frame policy. A prototype runs in the frame with its
// own scripts; nothing the proxy's runtime does can keep it from moving its
// frame to a document the runtime isn't in (a blob: or data: one it made, or
// another site), so the one wall is the review page's Content-Security-Policy
// `frame-src`, which only the website's host can send (site/vercel.json, and
// vite.config.ts for `vite` and `vite preview`). The page checks it before
// it shows a frame, and shows none without it.

/** A host-source with a scheme: `https://*.critiqs-review.net`, `http://*.review.localhost:5120`, an exact host. */
const HOST_SOURCE = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}|\*))?\/?$/;

/** Whether `source` (one source of a CSP source list, lowercased) matches the origin `lease`. */
function matches(source: string, lease: URL): boolean {
  const parsed = HOST_SOURCE.exec(source);
  if (parsed === null) return false;
  const [, scheme, wildcard, host, port] = parsed;
  if (`${scheme}:` !== lease.protocol) return false;
  if (wildcard !== undefined ? !lease.hostname.endsWith(`.${host}`) : lease.hostname !== host) return false;
  if (port === "*") return true;
  return (port ?? "") === lease.port;
}

/** The sources a policy lets frames come from: `frame-src`, else `child-src`, else `default-src`; null when it says nothing of frames. */
function frameSources(policy: string): string[] | null {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().toLowerCase().split(/\s+/);
    // A directive named twice keeps its first value, as browsers do.
    if (name !== undefined && name !== "" && !directives.has(name)) directives.set(name, sources);
  }
  return directives.get("frame-src") ?? directives.get("child-src") ?? directives.get("default-src") ?? null;
}

/**
 * Whether a Content-Security-Policy header value keeps the page's frames on
 * the review proxy: some policy in it allows frames only from host-sources
 * with a scheme (`'self'` and `'none'` aside), and one of them is the lease's
 * origin. Anything broader (no policy, `*`, a bare scheme, `blob:`, `data:`,
 * a host without a scheme) is no wall, and neither is one that refuses the
 * lease itself, which would leave the frame blank.
 */
export function framesOnlyFrom(header: string | null, leaseOrigin: string): boolean {
  if (header === null) return false;
  let lease: URL;
  try {
    lease = new URL(leaseOrigin);
  } catch {
    return false;
  }
  return header.split(",").some((policy) => {
    const sources = frameSources(policy);
    if (sources === null || sources.length === 0) return false;
    const narrow = sources.every((source) => source === "'self'" || source === "'none'" || HOST_SOURCE.test(source));
    return narrow && sources.some((source) => matches(source, lease));
  });
}

/** The Content-Security-Policy the website's host sends for this page, read by asking for it again. */
export async function ownFramePolicy(): Promise<string | null> {
  const response = await fetch(window.location.pathname, { method: "HEAD", cache: "no-store", credentials: "omit", redirect: "error" });
  return response.headers.get("content-security-policy");
}
