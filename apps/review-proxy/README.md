# Review-link proxy

`@critiqs/review-proxy` serves a prototype inside a review page's frame. It
is a deployed app, never a published package.

## Serving frames

Each viewer's lease gets its own random frame host,
`v-<26 base32 characters>.<CRITIQS_PROXY_DOMAIN>`, which the proxy resolves
through a `ReviewDirectory` (`src/directory.ts`, the backend's
`convexDirectory`, which asks `CRITIQS_PROXY_BACKEND`'s
`/internal/review/v1/resolve` with `CRITIQS_PROXY_SECRET`): the backend's answer says
which prototype origin and owner-approved origins the host serves, and for
how long. The prototype's origin is served at the host's root; review links
are read-only and credential-free (GET and HEAD only, no cookies or
`Authorization` either way, no WebSockets or service workers).

- `src/server.ts` checks, before fetching anything: the method (before the
  request's target is even parsed), the Host is the domain or one label under
  it (421 otherwise), header and URL sizes (Cookie aside), no upgrade, a
  top-level open (a notice, never the prototype), the lease (a client whose
  lookups keep finding nothing stops reaching the backend for a minute; hosts
  in flight count as misses until they answer, and a host the proxy has seen
  live is always asked about), the lease's request budget, and read slots for
  the lease, its link and the upstream host, each a share of the process so
  one slow site can't hold every read. A read with no room waits its turn
  for up to 8 seconds (a browser over HTTP/2 asks for every image of a page
  at once); a freed slot goes to the viewer holding the fewest, so one
  viewer's queued reads can't keep another waiting. A browser that takes
  nothing for 3 seconds gives its read slot back and keeps its download as a
  slow read; one that then takes nothing for 3 seconds plus a second per
  4 KiB already sent has stopped, and is ended. A file being passed on has
  no overall deadline of its own beyond the upstream's, and `bin/serve.ts`
  keeps an idle connection for 255 seconds (Bun's own default, 10, ends a
  slow download): a slow connection gets a large file whole.
- When the backend can't be asked (down, or answering with an error), that
  is never taken for a host that serves nothing and never counts as a miss.
  A host the proxy saw live keeps serving its last answer until that
  answer's `cacheUntil` (at most 5 seconds, the same bound as a revoked
  link); after that, and for any other host, a page says Critiqs can't check
  the link right now and a file gets 503 with `Retry-After`. While the
  backend is unreachable, hosts not seen live are asked about once a second
  at most.
- How a response is served is decided in one place, `handlingOf`, from the
  route and the response's own type and status, never from what the browser
  says a request is for. The type is read as a browser reads it (the last
  valid type of a comma list, any case; `contentType` in `src/headers.ts`),
  and the browser is sent only that. Any HTML on the prototype's origin is a
  page (capped, checked, rewritten); everything else passed through, XML, SVG,
  an unknown type or none included, is sent with
  `Content-Disposition: attachment`, so the frame can't open it as its
  document (the sandbox refuses the download) while the page's own images,
  scripts and fetches still load it. Another site's file must have its
  class's type at any status.
- Every response carries `X-Content-Type-Options: nosniff` and
  `frame-ancestors` with the website's origins: pages get the frame policy,
  everything else an inert one. A file the proxy refuses carries
  `Server-Timing: critiqs-refused` (and `critiqs-limit` when only the
  viewer's budget held it back), and a file it passes on as a success carries
  `critiqs-file`; the runtime reads these to tell the review page that part
  of the page couldn't load, or that waiting loads the rest. A file whose
  `Content-Length` is over the size cap is refused before any of it is sent;
  a file within it is sent with its length.
- The frame's policy allows WebAssembly (`'wasm-unsafe-eval'`), which reaches
  nothing a script can't; JavaScript `eval`, workers, frames, objects and
  other sites stay refused.
- Signed addresses use `CRITIQS_PROXY_SIGNING_KEY`, which only the proxy
  holds (required on a public domain; derived from the shared secret on
  `.localhost`), and still accept `CRITIQS_PROXY_SIGNING_KEY_PREVIOUS` during
  a rotation.
- `CRITIQS_PROXY_CLIENT_IP_HEADER` names the header the server in front
  overwrites with the viewer's address. It is required on a public domain:
  without it every viewer is one client to the lookup limit. Set it to
  `connection` when viewers connect to the proxy directly. Only a header
  front servers use for that is accepted (`cf-connecting-ip`,
  `x-forwarded-for`, `x-real-ip`, `true-client-ip` and the others in
  `src/clients.ts`), never one a client writes, such as `host`. Every
  address, from the header or the connection, is keyed by `clientKey`: an
  IPv4 address as itself, also in its IPv4-mapped IPv6 form (a listener on
  `::` sees IPv4 viewers that way), and an IPv6 address by its /64.
- `src/html.ts` parses pages with parse5, maps every address, removes
  `<base>`, CSP and refresh `<meta>` tags, nested frames, `srcdoc`, `ping` and
  `download`, and puts the runtime shim and the page layer first in `<head>`.
- `src/css.ts` maps every `url()` and `@import` with css-tree's tokenizer.
- `src/urls.ts` maps addresses: other sites' files only through
  `/__critiqs/a/<signature>/…` paths the proxy itself wrote (an HMAC over the
  lease, class and URL), owner-approved origins through `/__critiqs/o/<slot>/`,
  and links to other sites to a signed notice. Another site's stylesheet's
  `@import`s are signed as `import`, whose own imports are never signed, so a
  chain of other sites' stylesheets stops two deep.
- `src/paths.ts` turns an address on the prototype's origin into a frame
  path, for the rewriter and the runtime shim alike: a path starting with
  `//` gets `/.` in front, so it can never read as another host.
- `src/pages.ts` holds the proxy's own notices and the frame's
  Content-Security-Policy.
- `runtime/shim.ts` maps addresses scripts build at run time, keeps cookies
  in the document's memory, refuses service workers and follows GET forms.
  It marks the window as a review frame before the prototype's scripts run,
  so a copy of Critiqs the prototype installed stays out, and tells the
  review page once when part of the page couldn't load (a web socket,
  another site the frame's policy refused, a file the proxy refused or the
  browser couldn't read). `runtime/layer.ts` runs the page layer for the
  review page around the frame.

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
- `src/limits.ts` caps reads in flight per lease and per process, keeps the
  bounded line reads wait in (`slotLine`), and keeps each lease's budgets
  (`budget`), which refill evenly over 10 minutes: 300 pages and data
  requests, 1,200 of a page's own files (images, scripts, styles, fonts,
  media), 600 prefetches and 80 MiB. A file request answered with a page is
  served as a file, never rewritten, so the files' budget can't open pages.
  Past a budget a page says when pages open again, and a file carries
  `Retry-After`. Prefetches (Next.js's router, the browser's own) also have
  at most half the reads in flight, so a page prefetching every link never
  locks the reviewer out of what they open.

`bun test` runs the unit tests and the attack tests against local servers;
no test reaches the internet.

## Outgoing identity

Every request the proxy makes upstream carries a user agent it chose:
`Critiqs-Review/1 (+<website>/allow-critiqs)` for a link's own origin and
its owner-approved origins (`egress.primary`), and `Critiqs-Asset/1` for
other sites' static files (`egress.asset`). That user agent and the proxy's
egress addresses are the same for every Critiqs customer, and any owner can
create a link to any public origin or name one as an owner-approved origin:
an address list proves nothing about who owns a site. So a site's firewall
rule that lets `Critiqs-Review/1` from the egress addresses through would
let every Critiqs customer read that site, its staging pages and its APIs,
from a frame's scripts.

The rule for Allow Critiqs, which the proxy's side already follows:

- A site lets Critiqs through by matching its own token, never by user agent
  and address alone. The user agent and egress addresses only tell a bot wall
  the request is Critiqs; they are not an authentication boundary.
- A token is issued per project and per origin (an HMAC under a backend key
  over the project and the exact origin), shown to that project's owners for
  that origin only, and revocable by issuing a new one.
- The backend returns a lease's tokens in its resolution (`allow`, one entry
  per origin of the lease, checked against the lease's own origins by
  `parseReviewResolution`). Until Allow Critiqs issues them it returns none.
- The proxy sends an origin's token in `Critiqs-Allow` only on requests to
  that exact origin, through `egress.primary` (`sendsAllowTokens`), and only
  while every redirect hop stays on that origin. The asset egress never sends
  one. A project that names another customer's origin therefore sends that
  origin nothing it would accept.
- Before a token is issued for an origin, the owner should prove control of
  it (a DNS TXT record or a well-known file), so a token can't be minted for
  someone else's site and handed to them as if it were theirs.

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

Also before a public domain:

- Set `CRITIQS_PROXY_CLIENT_IP_HEADER` to the header the server in front
  overwrites with the viewer's address (or `connection` when viewers connect
  directly), so the per-client lookup limit sees viewers and not the
  ingress. The proxy refuses to start without it.
- Set `CRITIQS_PROXY_SIGNING_KEY` on the proxy only, so the backend's copy
  of `CRITIQS_PROXY_SECRET` can't sign asset addresses. The proxy refuses to
  start without it.
- A per-client limit on opening links (each open mints a lease, at most 60
  an hour per link) belongs at the website's edge: the backend can't see a
  viewer's address.

