import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { nodeNetwork } from "@critiqs/server/public-web";
import { buildAssets } from "../scripts/build-assets.ts";
import { ConfigError, parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { directoryFor } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { createProbe } from "../src/probe.ts";
import { cachedReputation, fixtureReputation, webRiskProvider } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";

// Runs the proxy: `bun run serve` (which passes --max-http-header-size=65536).
// Settings come from the environment (src/config.ts). It listens on
// CRITIQS_PROXY_LISTEN (default 127.0.0.1) and PORT (default the domain's
// port, or 5120), behind an ingress that terminates TLS for the wildcard domain.

/** Request headers the server accepts, Cookie included, so cookies a sibling frame host planted can't make it refuse a request. */
const HEADER_BYTES = 64 * 1024;

/** Sends this server a request with 32 KiB of cookies and checks it isn't refused for its headers. */
async function headersAccepted(port: number, hostname: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect(port, hostname, () => socket.end(`GET / HTTP/1.1\r\nHost: self-check.invalid\r\nCookie: c=${"x".repeat(32 * 1024)}\r\nConnection: close\r\n\r\n`));
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("close", () => resolve(!reply.startsWith("HTTP/1.1 431")));
    socket.on("error", () => resolve(false));
  });
}

try {
  const env = process.env;
  const config = parseProxyConfig(env);
  const web = nodeNetwork({ http, https, Resolver });
  const reputation = cachedReputation(config.webRiskKey !== null ? webRiskProvider(config.webRiskKey) : fixtureReputation());
  const policy = proxyPolicy(config);
  const egress = {
    // A link's own and owner-approved origins are checked by path; third-party static files by host.
    primary: createEgress({ web, policy, reputation, userAgent: config.userAgent, limits: config.limits, reputationScope: "path", sendsAllowTokens: true }),
    asset: createEgress({ web, policy, reputation, userAgent: config.assetUserAgent, limits: config.limits, reputationScope: "origin" }),
  };
  // Allow Critiqs' check goes out the same way a link's own requests do.
  const probe = createProbe(config, { egress: egress.primary });
  const proxy = createReviewProxy(config, { directory: directoryFor(config, env), egress, assets: await buildAssets(), probe });
  const hostname = env.CRITIQS_PROXY_LISTEN ?? "127.0.0.1";
  const port = Number(env.PORT ?? (config.domain.port || 5120));
  const server = Bun.serve({
    hostname,
    port,
    // Never Bun's developer error page (it shows the working directory and a stack): an error is a bare 500.
    development: false,
    // Bun's default (10 seconds) ends a request whose browser is draining a large file slowly, as if it had
    // left: a 4 MiB file read at 30 KB/s was cut after 12 seconds. The longest Bun allows; a browser that
    // has stopped reading is ended by the proxy's own rule (`stream` in src/server.ts).
    idleTimeout: 255,
    error: () => new Response("", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } }),
    fetch: (request, bunServer) => {
      // The header the server in front sets (read by `clientKey`, a list by its last entry), else the connection's own address.
      const peer = bunServer.requestIP(request)?.address ?? "";
      const forwarded = config.clientIpHeader === null ? null : request.headers.get(config.clientIpHeader);
      return proxy.fetch(request, { client: forwarded ?? peer, peer });
    },
  });
  if (!(await headersAccepted(port, hostname))) {
    server.stop(true);
    throw new ConfigError(`Start the proxy with bun --max-http-header-size=${HEADER_BYTES} (bun run serve), so a frame host's planted cookies can't make it refuse other frames.`);
  }
  setInterval(() => void proxy.reportUsage(), 60_000).unref();
  console.log(`Review proxy for ${config.domain.origin} on http://${hostname}:${port}`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
