import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { DEFAULT_LIMITS, parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { createEgress } from "../src/egress.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { certificate, close, closedWithin, listen, PUBLIC_A, testWeb, text, v4 } from "./fixtures.ts";

// H1's live check, under Bun: a benign TLS site fetched through the egress
// and the real pinned node:https connector. The certificate is checked
// against the site's name while the socket goes to the pinned address; a
// name the certificate doesn't cover fails; a site that never answers is
// cut at the hop deadline and a browser going away cuts the request, each
// seen closing at both ends; and proxy settings in the environment are never
// used.

const certs = certificate(["secure.example.com"]);
const seen: { servername: string | undefined; host: string | undefined; path: string | undefined }[] = [];
const server = certs === null ? null : https.createServer(certs, (request, response) => {
  seen.push({ servername: (request.socket as { servername?: string }).servername, host: request.headers.host, path: request.url });
  if (request.url === "/silent") return; // Never answers.
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<html>secure</html>");
});
const serverClosed: Promise<void>[] = [];
server?.on("connection", (socket) => serverClosed.push(new Promise((resolve) => socket.on("close", () => resolve()))));

// A proxy server that counts connections, standing for HTTP_PROXY.
let proxied = 0;
const envProxy = http.createServer((_request, response) => {
  proxied++;
  response.end("via proxy");
});
envProxy.on("connect", (_request, socket) => {
  proxied++;
  socket.destroy();
});

let port = 0;
let proxyPort = 0;
beforeAll(async () => {
  if (server !== null) port = await listen(server);
  proxyPort = await listen(envProxy);
});
afterAll(async () => {
  if (server !== null) await close(server);
  await close(envProxy);
});

const policy = proxyPolicy(
  parseProxyConfig({
    CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
    CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
    CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
    CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
  }),
);

function egress(limits = DEFAULT_LIMITS) {
  const web = testWeb({ "secure.example.com": [v4(PUBLIC_A)], "other.example.com": [v4(PUBLIC_A)] }, { [PUBLIC_A]: port }, { ca: certs!.cert.toString("utf8") });
  return { web, egress: createEgress({ web, policy, reputation: cachedReputation(fixtureReputation()), userAgent: "Critiqs-Review/1 (+test)", limits }) };
}

describe.skipIf(certs === null)("the pinned TLS connection under Bun", () => {
  test("verifies the certificate for the name, connecting to the pinned address", async () => {
    seen.length = 0;
    const { web, egress: out } = egress();
    const outcome = await out.fetch({ url: new URL("https://secure.example.com/hello"), method: "GET", class: "document", origin: "https://secure.example.com", signal: AbortSignal.timeout(5_000) });
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(await text(outcome.body)).toBe("<html>secure</html>");
    expect(seen).toEqual([{ servername: "secure.example.com", host: `secure.example.com:${port}`, path: "/hello" }]);
    expect(web.connected).toEqual([PUBLIC_A]);
  });

  test("a name the certificate doesn't cover is refused", async () => {
    seen.length = 0;
    const { egress: out } = egress();
    expect(await out.fetch({ url: new URL("https://other.example.com/"), method: "GET", class: "document", origin: "https://other.example.com", signal: AbortSignal.timeout(5_000) })).toEqual({ kind: "refused", reason: "unreachable" });
    // The handshake failed before any request was sent.
    expect(seen).toEqual([]);
  });

  test("a site that never answers is cut at the hop deadline, and its connection closes", async () => {
    serverClosed.length = 0;
    const { egress: out } = egress({ ...DEFAULT_LIMITS, hopTimeoutMs: 300 });
    const started = performance.now();
    expect(await out.fetch({ url: new URL("https://secure.example.com/silent"), method: "GET", class: "document", origin: "https://secure.example.com", signal: AbortSignal.timeout(5_000) })).toEqual({ kind: "refused", reason: "unreachable" });
    expect(performance.now() - started).toBeLessThan(1_500);
    await closedWithin(Promise.all(serverClosed), 2_000, "the silent connection");
  });

  test("a browser going away cuts the request, and the connection closes at the site", async () => {
    serverClosed.length = 0;
    const { egress: out } = egress();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("gone")), 200);
    const started = performance.now();
    expect(await out.fetch({ url: new URL("https://secure.example.com/silent"), method: "GET", class: "document", origin: "https://secure.example.com", signal: controller.signal })).toEqual({ kind: "refused", reason: "unreachable" });
    expect(performance.now() - started).toBeLessThan(1_500);
    await closedWithin(Promise.all(serverClosed), 2_000, "the aborted connection");
  });

  test("HTTP_PROXY and HTTPS_PROXY in the environment are never used", async () => {
    const saved = { ...process.env };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) process.env[name] = `http://127.0.0.1:${proxyPort}`;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      seen.length = 0;
      const { egress: out } = egress();
      const outcome = await out.fetch({ url: new URL("https://secure.example.com/env"), method: "GET", class: "document", origin: "https://secure.example.com", signal: AbortSignal.timeout(5_000) });
      expect(outcome.kind === "response" && (await text(outcome.body))).toBe("<html>secure</html>");
      expect(seen.map((request) => request.path)).toEqual(["/env"]);
      expect(proxied).toBe(0);
    } finally {
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});
