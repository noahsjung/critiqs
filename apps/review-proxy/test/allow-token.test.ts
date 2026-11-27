import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { assetPath } from "../src/urls.ts";
import { close, listen, PUBLIC_A, PUBLIC_B, PUBLIC_C, recordingServer, testWeb, v4 } from "./fixtures.ts";

// N8: the user agent and egress address are the same for every Critiqs
// customer, so a firewall rule on them would let any owner's link read any
// allowlisted site. A lease carries one Allow Critiqs token per origin it was
// issued for; the proxy sends an origin's token only on requests to that
// origin, never to another site, never on the third-party asset egress.

const LABEL = `v-${"a".repeat(26)}`;
const HOST = `${LABEL}.review.localhost:5120`;
const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});
const PRIMARY_TOKEN = "p".repeat(43);
const SLOT_TOKEN = "s".repeat(43);
const site = recordingServer((request, response) => {
  response.writeHead(200, { "Content-Type": request.url?.endsWith(".png") ? "image/png" : "application/json" });
  response.end("{}");
});
const cdn = recordingServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "image/png" });
  response.end("png");
});
const api = recordingServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end("{}");
});
let ports = { site: 0, cdn: 0, api: 0 };
beforeAll(async () => {
  ports = { site: await listen(site.server), cdn: await listen(cdn.server), api: await listen(api.server) };
});
afterAll(async () => {
  await Promise.all([close(site.server), close(cdn.server), close(api.server)]);
});

function proxyWith(allow: { origin: string; token: string }[]) {
  const web = testWeb({ "proto.example.com": [v4(PUBLIC_A)], "cdn.example.net": [v4(PUBLIC_B)], "api.example.com": [v4(PUBLIC_C)] }, { [PUBLIC_A]: ports.site, [PUBLIC_B]: ports.cdn, [PUBLIC_C]: ports.api });
  const reputation = cachedReputation(fixtureReputation());
  const policy = proxyPolicy(config);
  return createReviewProxy(config, {
    directory: memoryDirectory([{ label: LABEL, linkId: "l", leaseId: "lease-1", origin: "http://proto.example.com", assetOrigins: [{ slot: 1, origin: "http://api.example.com" }], allow, expiresAt: Date.now() + 600_000 }]),
    egress: {
      primary: createEgress({ web, policy, reputation, userAgent: config.userAgent, limits: config.limits, sendsAllowTokens: true }),
      // Even if this egress were handed a token, it never sends one.
      asset: createEgress({ web, policy, reputation, userAgent: config.assetUserAgent, limits: config.limits, reputationScope: "origin" }),
    },
    assets: { runtime: { file: "runtime.0123456789abcdef.js", body: "" }, layer: { file: "layer.0123456789abcdef.js", body: "" } },
  });
}
const get = (proxy: ReturnType<typeof proxyWith>, path: string, dest: string) => proxy.fetch(new Request(`http://${HOST}${path}`, { headers: { host: HOST, "sec-fetch-dest": dest } }), { client: "203.0.113.7" });

test("each origin gets only its own token; other sites get none", async () => {
  const proxy = proxyWith([
    { origin: "http://proto.example.com", token: PRIMARY_TOKEN },
    { origin: "http://api.example.com", token: SLOT_TOKEN },
  ]);
  await (await get(proxy, "/data.json", "empty")).text();
  await (await get(proxy, "/__critiqs/o/1/me", "empty")).text();
  const signed = assetPath({ primary: "http://proto.example.com", slots: [], leaseId: "lease-1", secret: config.signingKey }, "image", new URL("http://cdn.example.net/logo.png"))!;
  expect((await get(proxy, signed, "image")).status).toBe(200);
  expect(site.requests.at(-1)!.headers["critiqs-allow"]).toBe(PRIMARY_TOKEN);
  expect(api.requests.at(-1)!.headers["critiqs-allow"]).toBe(SLOT_TOKEN);
  expect(cdn.requests.at(-1)!.headers["critiqs-allow"]).toBeUndefined();
});

test("a lease without tokens sends none", async () => {
  const proxy = proxyWith([]);
  await (await get(proxy, "/data.json", "empty")).text();
  expect(site.requests.at(-1)!.headers["critiqs-allow"]).toBeUndefined();
});

test("the third-party asset egress never sends a token, even when handed one", async () => {
  const web = testWeb({ "cdn.example.net": [v4(PUBLIC_B)] }, { [PUBLIC_B]: ports.cdn });
  const egress = createEgress({ web, policy: proxyPolicy(config), reputation: cachedReputation(fixtureReputation()), userAgent: config.assetUserAgent, limits: config.limits, reputationScope: "origin" });
  const outcome = await egress.fetch({ url: new URL("http://cdn.example.net/x.png"), method: "GET", class: "image", origin: "http://cdn.example.net", allowToken: PRIMARY_TOKEN, signal: AbortSignal.timeout(5_000) });
  expect(outcome.kind).toBe("response");
  expect(cdn.requests.at(-1)!.headers["critiqs-allow"]).toBeUndefined();
});

test("a request's token goes only to the origin it is for, even when the request's address is on another", async () => {
  const web = testWeb({ "cdn.example.net": [v4(PUBLIC_B)] }, { [PUBLIC_B]: ports.cdn });
  const egress = createEgress({ web, policy: proxyPolicy(config), reputation: cachedReputation(fixtureReputation()), userAgent: config.userAgent, limits: config.limits, sendsAllowTokens: true });
  const outcome = await egress.fetch({ url: new URL("http://cdn.example.net/x.png"), method: "GET", class: "image", origin: "http://proto.example.com", allowToken: PRIMARY_TOKEN, signal: AbortSignal.timeout(5_000) });
  expect(outcome.kind).toBe("response");
  expect(cdn.requests.at(-1)!.headers["critiqs-allow"]).toBeUndefined();
});
