import { ALLOW_HEADER, ALLOW_PROOF_PATH } from "@critiqs/server/review-links";
import { type ProxyConfig, REVIEW_USER_AGENT_TOKEN } from "./config.ts";

// `/.well-known/critiqs-review.json` on the proxy's own domain: what a site
// owner needs to recognize the proxy, for Allow Critiqs. The addresses are
// the proxy's validated egress blocks (CRITIQS_PROXY_EGRESS) and the user
// agent its review token; neither lets anyone in alone. A site's rule must
// match its own project's token in `header`, which only that project's leases
// carry, and only once the site publishes the project's proof at `proofPath`.

export function wellKnown(config: Pick<ProxyConfig, "egress" | "webOrigins">): Response {
  const body = {
    version: 1,
    userAgent: REVIEW_USER_AGENT_TOKEN,
    header: ALLOW_HEADER,
    proofPath: ALLOW_PROOF_PATH,
    egress: [...config.egress],
    instructions: `${config.webOrigins[0]}/allow-critiqs`,
  };
  return Response.json(body, {
    headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
  });
}
