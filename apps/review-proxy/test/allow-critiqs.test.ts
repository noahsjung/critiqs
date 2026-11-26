import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allowProofLine } from "@critiqs/server/review-links";
import { parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { createProbe } from "../src/probe.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { assetPath } from "../src/urls.ts";
import { close, listen, PUBLIC_A, PUBLIC_B, recordingServer, testWeb, v4 } from "./fixtures.ts";

// Allow Critiqs through the proxy: the backend's check (`POST /__critiqs/probe`,
// AT-31) and a site whose firewall lets in only requests with its project's
// token (AT-32), against a local fixture that refuses everything else the way
// a bot wall does.

const SECRET = "a-test-secret-that-is-long-enough-to-pass";
const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: SECRET,
  CRITIQS_PROXY_EGRESS: "203.0.113.10/32,2001:db8::/48",
});
const TOKEN = "t".repeat(43);
const PROOF = "p".repeat(32);
const LABEL = `v-${"a".repeat(26)}`;
const OTHER = `v-${"b".repeat(26)}`;

/** A site behind a wall: everything is a challenge page unless the request carries its own token. */
const guarded = recordingServer((request, response) => {
  if (request.headers["critiqs-allow"] !== TOKEN) {
    response.writeHead(403, { "Content-Type": "text/html", Server: "cloudflare", "cf-mitigated": "challenge", "cf-ray": "8a1b2c3d4e5f-SJC" });
    return response.end("<title>Just a moment...</title><p>Checking your browser before accessing. Ray ID 8a1b2c3d4e5f from 198.51.100.7</p>");
  }
  if (request.url === "/.well-known/critiqs-allow.txt") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    return response.end(`# Critiqs\n${allowProofLine(PROOF)}\n`);
  }
  if (request.url === "/logo.png") {
    response.writeHead(200, { "Content-Type": "image/png" });
    return response.end("png");
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Staging</title><h1>Acme staging</h1>");
});
const other = recordingServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Other</title><h1>Other</h1>");
});
let ports = { guarded: 0, other: 0 };
beforeAll(async () => {
  ports = { guarded: await listen(guarded.server), other: await listen(other.server) };
});
afterAll(async () => {
  await Promise.all([close(guarded.server), close(other.server)]);
});

function setup(options: { unsafe?: string[]; perOriginPerMinute?: number } = {}) {
  const web = testWeb({ "staging.acme.example": [v4(PUBLIC_A)], "other.example": [v4(PUBLIC_B)] }, { [PUBLIC_A]: ports.guarded, [PUBLIC_B]: ports.other });
  const reputation = cachedReputation(fixtureReputation(options.unsafe ?? []));
  const policy = proxyPolicy(config);
  const egress = {
    primary: createEgress({ web, policy, reputation, userAgent: config.userAgent, limits: config.limits, sendsAllowTokens: true }),
    asset: createEgress({ web, policy, reputation, userAgent: config.assetUserAgent, limits: config.limits, reputationScope: "origin" }),
  };
  const probe = createProbe(config, { egress: egress.primary, limits: { perMinute: 60, perOriginPerMinute: options.perOriginPerMinute ?? 6 } });
  const directory = memoryDirectory([
    // The guarded site's own link: its lease carries the project's token for it.
    { label: LABEL, linkId: "link-1", leaseId: "lease-1", origin: "http://staging.acme.example", assetOrigins: [], allow: [{ origin: "http://staging.acme.example", token: TOKEN }], expiresAt: Date.now() + 600_000 },
    // Another customer's link whose pages use the guarded site's files.
    { label: OTHER, linkId: "link-2", leaseId: "lease-2", origin: "http://other.example", assetOrigins: [], expiresAt: Date.now() + 600_000 },
  ]);
  const proxy = createReviewProxy(config, { directory, egress, probe, assets: { runtime: { file: "runtime.0123456789abcdef.js", body: "" }, layer: { file: "layer.0123456789abcdef.js", body: "" } } });
  return { proxy, web };
}

const probeWith = (proxy: ReturnType<typeof setup>["proxy"], body: unknown, secret: string | null = SECRET, host = "review.localhost:5120") =>
  proxy.fetch(new Request(`http://${host}/__critiqs/probe`, { method: "POST", headers: { host, "content-type": "application/json", ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) }, body: JSON.stringify(body) }));

describe("AT-31: the Allow Critiqs check", () => {
  test("only the backend's secret gets an answer; anyone else gets the same 404 as a path that isn't there, and nothing is fetched", async () => {
    const { proxy, web } = setup();
    const unknown = await proxy.fetch(new Request("http://review.localhost:5120/nothing-here", { headers: { host: "review.localhost:5120" } }));
    const expected = [unknown.status, await unknown.text()];
    for (const secret of [null, "wrong-secret-that-is-also-long-enough-to-pass", `${SECRET}x`]) {
      const response = await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN }, secret);
      expect([response.status, await response.text()]).toEqual(expected);
    }
    expect(web.resolved).toEqual([]);
  });

  test("with the token the site lets the proxy in and the proof is found; without it, blocked; the answer says nothing else", async () => {
    const { proxy } = setup();
    const allowed = await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN, proof: PROOF });
    expect(await allowed.json()).toEqual({ result: "public", proof: true });
    const wrongProof = await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN, proof: "q".repeat(32) });
    expect(await wrongProof.json()).toEqual({ result: "public", proof: false });
    const blocked = await probeWith(proxy, { origin: "http://staging.acme.example", proof: PROOF });
    const text = await blocked.text();
    expect(JSON.parse(text)).toEqual({ result: "blocked", proof: false });
    // Never the site's status, headers, ray ID or addresses.
    for (const leak of ["403", "cloudflare", "8a1b2c3d4e5f", "198.51.100.7", PUBLIC_A, "Just a moment"]) expect(text).not.toContain(leak);
    expect(guarded.requests.at(-1)!.headers["user-agent"]).toContain("Critiqs-Review/1");
  });

  test("the check runs every check a review link does: no local, private or Critiqs address is ever looked up", async () => {
    const { proxy, web } = setup();
    for (const origin of ["http://localhost", "http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "http://review.localhost:5120", "http://v-aaaaaaaaaaaaaaaaaaaaaaaaaa.review.localhost:5120", "http://web.localhost:5110", "http://convex.localhost:5111"]) {
      const response = await probeWith(proxy, { origin, token: TOKEN });
      expect([origin, response.status === 400 ? "refused" : (await response.json()).result]).toEqual([origin, response.status === 400 ? "refused" : "unreachable"]);
    }
    for (const body of [{ origin: "http://staging.acme.example/path" }, { origin: "http://user:pw@staging.acme.example" }, { origin: "ftp://staging.acme.example" }, { origin: "http://staging.acme.example", token: "bad token\r\n" }, "not json"]) {
      expect((await probeWith(proxy, body)).status).toBe(400);
    }
    expect(web.connected).toEqual([]);
  });

  test("an unsafe reputation is named as unsafe, without fetching the site", async () => {
    const { proxy, web } = setup({ unsafe: ["http://staging.acme.example"] });
    expect(await (await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN })).json()).toEqual({ result: "unsafe", proof: false });
    expect(web.connected).toEqual([]);
  });

  test("checks are limited per origin", async () => {
    const { proxy } = setup({ perOriginPerMinute: 2 });
    for (let n = 0; n < 2; n++) expect((await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN })).status).toBe(200);
    const limited = await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN });
    expect([limited.status, await limited.text()]).toEqual([429, ""]);
    // Another origin still has its own.
    expect((await probeWith(proxy, { origin: "http://other.example" })).status).toBe(200);
  });

  test("a lease host never runs the check", async () => {
    const { proxy } = setup();
    const response = await probeWith(proxy, { origin: "http://staging.acme.example", token: TOKEN }, SECRET, `${LABEL}.review.localhost:5120`);
    // The probe is the backend's, wherever it is asked, but only with the secret; lease hosts are read-only for everything else.
    expect(response.status).toBe(200);
    const post = await proxy.fetch(new Request(`http://${LABEL}.review.localhost:5120/x`, { method: "POST", headers: { host: `${LABEL}.review.localhost:5120` }, body: "x" }));
    expect(post.status).toBe(405);
  });
});

describe("AT-32: a site that lets in only its own project's token", () => {
  test("its own link's pages come through; another customer's page using its files gets nothing from it", async () => {
    const { proxy } = setup();
    const page = await proxy.fetch(new Request(`http://${LABEL}.review.localhost:5120/`, { headers: { host: `${LABEL}.review.localhost:5120`, "sec-fetch-dest": "iframe" } }));
    expect([page.status, (await page.text()).includes("Acme staging")]).toEqual([200, true]);
    expect(guarded.requests.at(-1)!.headers["critiqs-allow"]).toBe(TOKEN);

    // The other customer's lease asks for the guarded site's file as a signed third-party asset: no token, so the wall refuses it.
    const signed = assetPath({ primary: "http://other.example", slots: [], leaseId: "lease-2", secret: config.signingKey }, "image", new URL("http://staging.acme.example/logo.png"))!;
    const asset = await proxy.fetch(new Request(`http://${OTHER}.review.localhost:5120${signed}`, { headers: { host: `${OTHER}.review.localhost:5120`, "sec-fetch-dest": "image" } }));
    expect([asset.status, await asset.text()]).toEqual([403, ""]);
    expect(guarded.requests.at(-1)!.url).toBe("/logo.png");
    expect(guarded.requests.at(-1)!.headers["critiqs-allow"]).toBeUndefined();
    expect(guarded.requests.at(-1)!.headers["user-agent"]).toBe("Critiqs-Asset/1");
  });
});

test("the proxy's domain publishes how to recognize it, and nothing that lets anyone in", async () => {
  const { proxy } = setup();
  const response = await proxy.fetch(new Request("http://review.localhost:5120/.well-known/critiqs-review.json", { headers: { host: "review.localhost:5120" } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    version: 1,
    userAgent: "Critiqs-Review/1",
    header: "Critiqs-Allow",
    proofPath: "/.well-known/critiqs-allow.txt",
    egress: ["203.0.113.10/32", "2001:db8::/48"],
    instructions: "http://web.localhost:5110/allow-critiqs",
  });
  // On a lease host the same path is the prototype's own.
  const onLease = await proxy.fetch(new Request(`http://${LABEL}.review.localhost:5120/.well-known/critiqs-review.json`, { headers: { host: `${LABEL}.review.localhost:5120`, "sec-fetch-dest": "empty" } }));
  expect((await onLease.text()).includes("Critiqs-Allow")).toBe(false);
});
