// The one rule for turning an address on the prototype's own origin into a
// path on its frame host, shared by the server's rewriter (urls.ts) and the
// runtime shim, so both always agree.

/**
 * `url`'s path, query and fragment as a path on the frame host. A path that
 * starts with `//` (the parser turns `/\` into it too) would read as another
 * host, a protocol-relative address that leaves the proxy, so it gets `/.` in
 * front: the browser drops the dot segment and asks the frame host for the
 * same path, which the proxy then fetches from the prototype.
 */
export function framePath(url: URL): string {
  const path = url.pathname.startsWith("//") ? `/.${url.pathname}` : url.pathname;
  return `${path}${url.search}${url.hash}`;
}
