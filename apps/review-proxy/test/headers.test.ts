import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { createEgress } from "../src/egress.ts";
import { inboundHeaders, outboundHeaders, requestHeaderBytes, type RequestClass } from "../src/headers.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { close, listen, PUBLIC_A, recordingServer, testWeb, text, v4 } from "./fixtures.ts";

// AT-7: no header the browser sends reaches upstream, and the upstream
// headers that could harm a lease host never reach the browser.

const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});

const upstream = recordingServer((_request, response) => {
  response.writeHead(200, [
    ["Content-Type", "text/html; charset=utf-8"],
    ["Set-Cookie", "session=1; Domain=review.localhost; Path=/"],
    ["Set-Cookie", "other=2"],
    ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
    ["Clear-Site-Data", '"*"'],
    ["Alt-Svc", 'h3=":443"'],
    ["Cache-Control", "public, max-age=60"],
  ]);
  response.end("<html>ok</html>");
});
let port = 0;
beforeAll(async () => {
  port = await listen(upstream.server);
});
afterAll(() => close(upstream.server));

describe("AT-7: outbound headers are built from scratch", () => {
  test("the upstream request carries only the proxy's own headers", async () => {
    const web = testWeb({ "proto.example.com": [v4(PUBLIC_A)] }, { [PUBLIC_A]: port });
    const egress = createEgress({ web, policy: proxyPolicy(config), reputation: cachedReputation(fixtureReputation()), userAgent: config.userAgent, limits: DEFAULT_LIMITS });
    // There is no way to hand the egress a browser's headers; the request it builds is checked on the wire.
    const outcome = await egress.fetch({ url: new URL("http://proto.example.com/page"), method: "GET", class: "document", origin: "http://proto.example.com", signal: AbortSignal.timeout(5_000) });
    expect(outcome.kind).toBe("response");
    if (outcome.kind === "response") await text(outcome.body);
    const seen = upstream.requests.at(-1)!;
    expect(Object.keys(seen.headers).sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"]);
    expect(seen.headers["user-agent"]).toBe("Critiqs-Review/1 (+http://web.localhost:5110/allow-critiqs)");
    expect(seen.headers.connection).toBe("close");
    expect(seen.headers.host).toBe(`proto.example.com:${port}`);
    for (const name of ["cookie", "authorization", "x-forwarded-for", "x-real-ip", "forwarded", "via", "origin", "referer", "sec-fetch-site", "x-custom"]) expect(seen.headers[name]).toBeUndefined();
  });

  test("each class asks for what it needs; only rewritten classes accept deflate", () => {
    const classes: RequestClass[] = ["document", "style", "script", "image", "font", "media", "data"];
    for (const requestClass of classes) {
      const headers = outboundHeaders(requestClass, "Critiqs-Asset/1");
      expect(Object.keys(headers)).toEqual(["User-Agent", "Accept", "Accept-Encoding"]);
      expect(headers["User-Agent"]).toBe("Critiqs-Asset/1");
      expect(headers["Accept-Encoding"]).toBe(requestClass === "document" || requestClass === "style" ? "gzip, br, deflate" : "gzip, br");
    }
  });
});

describe("AT-7: inbound headers are an allow list", () => {
  const dangerous = {
    "set-cookie": "session=1; Domain=review.localhost",
    "clear-site-data": '"*"',
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "alt-svc": 'h3=":443"',
    "report-to": '{"group":"x"}',
    "reporting-endpoints": 'x="https://evil.example/r"',
    nel: '{"report_to":"x"}',
    link: "</evil.js>; rel=preload",
    "content-location": "https://evil.example/",
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "service-worker-allowed": "/",
    "set-login": "logged-in",
    "content-security-policy": "frame-ancestors *",
    "content-security-policy-report-only": "default-src 'none'",
    "x-frame-options": "DENY",
    location: "https://evil.example/",
    refresh: "0; url=https://evil.example/",
    "content-disposition": "attachment; filename=evil.exe",
    "content-length": "999",
    "content-encoding": "gzip",
    "transfer-encoding": "chunked",
    "x-powered-by": "Express",
  };

  test("every dangerous header is dropped; content type and caching stay", () => {
    const headers = inboundHeaders({ ...dangerous, "content-type": "text/html; charset=utf-8", etag: '"abc"', "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" });
    expect([...headers.keys()].sort()).toEqual(["cache-control", "content-type", "etag", "last-modified"]);
    for (const name of Object.keys(dangerous)) expect(headers.get(name)).toBeNull();
  });

  test("caching is always private", () => {
    expect(inboundHeaders({ "cache-control": "public, max-age=60, s-maxage=600" }).get("cache-control")).toBe("private, max-age=60");
    expect(inboundHeaders({}).get("cache-control")).toBe("private, no-cache");
    expect(inboundHeaders({ "cache-control": "no-store" }).get("cache-control")).toBe("private, no-store");
  });

  test("the upstream's Set-Cookie, HSTS, Clear-Site-Data and Alt-Svc from a real response never pass", async () => {
    const web = testWeb({ "proto.example.com": [v4(PUBLIC_A)] }, { [PUBLIC_A]: port });
    const egress = createEgress({ web, policy: proxyPolicy(config), reputation: cachedReputation(fixtureReputation()), userAgent: config.userAgent, limits: DEFAULT_LIMITS });
    const outcome = await egress.fetch({ url: new URL("http://proto.example.com/"), method: "GET", class: "document", origin: "http://proto.example.com", signal: AbortSignal.timeout(5_000) });
    if (outcome.kind !== "response") throw new Error("expected a response");
    await text(outcome.body);
    expect(outcome.headers["set-cookie"]).toContain("session=1");
    const passed = inboundHeaders(outcome.headers);
    for (const name of ["set-cookie", "strict-transport-security", "clear-site-data", "alt-svc"]) expect(passed.get(name)).toBeNull();
    expect(passed.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("a header value with a line break is dropped", () => {
    expect(inboundHeaders({ "content-type": "text/html\r\nSet-Cookie: x=1" }).get("content-type")).toBeNull();
  });
});

test("request header size leaves Cookie out", () => {
  const headers = new Headers({ "user-agent": "x".repeat(100), cookie: "c=".concat("y".repeat(32 * 1024)) });
  expect(requestHeaderBytes(headers)).toBeLessThan(200);
});
