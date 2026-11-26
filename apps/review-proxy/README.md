# Review-link proxy

`@critiqs/review-proxy` serves a prototype inside a review page's frame. It
is a deployed app, never a published package.

This first part is the proxy's network layer:

- `src/config.ts` reads the settings (`CRITIQS_PROXY_DOMAIN`,
  `CRITIQS_WEB_ORIGINS`, `CRITIQS_PROXY_BACKEND`, `CRITIQS_PROXY_SECRET`,
  `CRITIQS_PROXY_EGRESS`, `CRITIQS_WEB_RISK_API_KEY`) and refuses anything
  unsafe at start.
- `src/egress.ts` is the only way out: every hop, redirects included, is a
  plain `http(s)` address on its default port, not a local name, not one of
  Critiqs's own hosts or egress addresses, safe by the reputation check, and
  resolved to public addresses only, then connected to the checked address
  with `@critiqs/server/public-web`'s pinned connector. Redirects are followed
  on the server, at most three, within one origin.
- `src/headers.ts` builds upstream request headers from scratch and passes
  only an allow list of response headers back.
- `src/decompress.ts` reads bodies with wire and decompressed byte caps and
  idle and total deadlines, closing the upstream connection at once.
- `src/reputation.ts` checks the origin and path (never the query) with
  Google Web Risk, cached, failing closed.
- `src/limits.ts` caps reads in flight per lease and per process, and
  requests and bytes per lease per window.

`bun test` runs the unit tests and the attack tests against local servers;
no test reaches the internet.
