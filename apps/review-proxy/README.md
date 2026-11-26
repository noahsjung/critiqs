# Review-link proxy

`@critiqs/review-proxy` serves a prototype inside a review page's frame. It
is a deployed app, never a published package.

## Serving frames

Each viewer's lease gets its own random frame host,
`v-<26 base32 characters>.<CRITIQS_PROXY_DOMAIN>`, which the proxy resolves
through a `ReviewDirectory` (`src/directory.ts`): the backend's answer says
which prototype origin and owner-approved origins the host serves, and for
how long. The prototype's origin is served at the host's root; review links
are read-only and credential-free (GET and HEAD only, no cookies or
`Authorization` either way, no WebSockets or service workers).

- `src/server.ts` checks, before fetching anything: the Host is the domain or
  one label under it (421 otherwise), header and URL sizes (Cookie aside),
  the method, no upgrade, a top-level open (a notice, never the prototype),
  the lease, and the lease's request window and read slots.
- `src/html.ts` parses pages with parse5, maps every address, removes
  `<base>`, CSP and refresh `<meta>` tags, nested frames, `srcdoc`, `ping` and
  `download`, and puts the runtime shim and the page layer first in `<head>`.
- `src/css.ts` maps every `url()` and `@import` with css-tree's tokenizer.
- `src/urls.ts` maps addresses: other sites' files only through
  `/__critiqs/a/<signature>/…` paths the proxy itself wrote (an HMAC over the
  lease, class and URL), owner-approved origins through `/__critiqs/o/<slot>/`,
  and links to other sites to a signed notice.
- `src/pages.ts` holds the proxy's own notices and the frame's
  Content-Security-Policy.
- `runtime/shim.ts` maps addresses scripts build at run time, keeps cookies
  in the document's memory, refuses service workers and follows GET forms;
  `runtime/layer.ts` runs the page layer for the review page around the frame.

`bun run serve` starts it (with `--max-http-header-size=65536`, so cookies a
sibling frame host planted can't make it refuse requests).
`bun run check:proxy` runs the Chrome check against local fixture sites.

## Network layer

- `src/config.ts` reads the settings (`CRITIQS_PROXY_DOMAIN`,
  `CRITIQS_WEB_ORIGINS`, `CRITIQS_PROXY_BACKEND`, `CRITIQS_PROXY_SECRET`,
  `CRITIQS_PROXY_EGRESS`, `CRITIQS_WEB_RISK_API_KEY`,
  `CRITIQS_PROXY_COOKIE_ISOLATION`) and refuses anything unsafe at start: on a
  public domain, plain `http://` for the website or the backend, and a missing
  cookie isolation setting (see "Before a public domain").
- Every host is compared in one form, `canonicalHost` from `@critiqs/core`
  (lowercase, punycode, dotted IPv4, no trailing dot; `a..b` and
  `localhost..` are no host at all). The policy, the reputation key, sign-in
  detection and the settings all use it.
- `src/egress.ts` is the only way out: every hop, redirects included, is a
  plain `http(s)` address on its default port, not a local name, not one of
  Critiqs's own hosts or egress addresses, safe by the reputation check, and
  resolved to public addresses only, then connected to the checked address
  with `@critiqs/server/public-web`'s pinned connector. Redirects are followed
  on the server, at most three, within one origin.
- `src/headers.ts` builds upstream request headers from scratch and passes
  only an allow list of response headers back. The one exception is the
  request headers Next.js's App Router sends with its data requests (`rsc`,
  `next-router-state-tree`, `next-router-prefetch`,
  `next-router-segment-prefetch`, `next-url`, `x-deployment-id`): on the
  prototype's own origin only, each by name and only with a value of the exact
  shape Next.js produces. Its server refuses data requests without them.
- `src/decompress.ts` reads bodies with wire and decompressed byte caps and
  idle and total deadlines, closing the upstream connection at once.
- `src/reputation.ts` checks the origin and path (never the query) with
  Google Web Risk, cached, failing closed. What is asked is a property of the
  egress (`reputationScope`), never of a request: the egress for a link's own
  and owner-approved origins checks every path, the one for third-party
  static files checks each host.
- `src/limits.ts` caps reads in flight per lease and per process, and
  requests and bytes per lease per window. Prefetches (Next.js's router, the
  browser's own) have a window of their own and at most half the reads in
  flight, so a page prefetching every link never locks the reviewer out of
  what they open; their bytes count in the lease's byte window.

`bun test` runs the unit tests and the attack tests against local servers;
no test reaches the internet.

## Before a public domain

Frame hosts run other people's pages with same-origin scripts. Until the
proxy's domain is on the [Public Suffix List](https://publicsuffix.org/), a
page on one frame host can set cookies on the whole domain from a child
`about:blank` frame, which the runtime shim can't cover. Firefox keeps well
over a megabyte of them in the review page's partition, and Chrome keeps as
many when they are marked `SameSite=None; Secure`; both send them (measured:
about 594 KB) with every other frame's requests. Any server refuses a
request that large, so every other review link stops loading for that viewer
until the cookies expire. The proxy never reads or sets cookies, so nothing
is read or stolen, but the links stop working.

On any domain that isn't `.localhost`, the proxy refuses to start until
`CRITIQS_PROXY_COOKIE_ISOLATION` says how this is handled:

- `public-suffix-list`: the domain is on the Public Suffix List's private
  section, so browsers refuse cookies for the whole domain. This is the fix.
- `ingress-drops-cookies`: the server in front of the proxy accepts request
  headers of at least 2 MiB and removes `Cookie` before passing the request
  on. Use it until the listing is live, and only with a front server you
  configure yourself (such as nginx, Envoy or Caddy with large header
  buffers). Many managed front servers and CDNs refuse a request with that
  much header (often above 32 KiB, with a 400 or 431) before any rule that
  removes a header runs, so the attack still works through them.

