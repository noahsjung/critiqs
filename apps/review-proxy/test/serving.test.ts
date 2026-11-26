import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { DEFAULT_LIMITS, parseProxyConfig, type ProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory, type MemoryLease } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { markReviewFrame, refusedByProxy } from "../runtime/shim.ts";
import { close, listen, PUBLIC_A, PUBLIC_B, testWeb, v4 } from "./fixtures.ts";

// How the proxy serves what comes back, and how its limits treat real
// viewers, each reproduced against the real handler and pinned connector:
//
// - a response is a page if a browser would render it as a document,
//   whatever its label: the proxy reads the type the way a browser does (the
//   last valid type of a list, any case), rewrites HTML, and serves anything
//   else so that it can never be the frame's document;
// - every response says nosniff;
// - the per-client lookup limit holds under a burst, and never refuses a
//   frame host the proxy has seen live;
// - reads over a lease's share wait their turn, briefly, instead of failing,
//   while one link or one site still can't hold the whole process;
// - a browser that stops reading gives its read back within seconds;
// - a file the proxy refuses says so, for the frame's notice.

const LABEL = `v-${"a".repeat(26)}`;
const label = (index: number) => `v-${"abcdefghijklmnopqrstuvwxyz234567"[index]!.repeat(26)}`;
const randomLabel = () => `v-${Array.from({ length: 26 }, () => "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(Math.random() * 32)]).join("")}`;
const DOMAIN = "review.localhost:5120";
const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: `http://${DOMAIN}`,
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});
const RUNTIME = "runtime.0123456789abcdef.js";

const XHTML = '<html xmlns="http://www.w3.org/1999/xhtml"><body><a id="a" href="http://evil.example/clicked">leave</a></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="http://evil.example/svg"><text y="20">leave</text></a></svg>';
/** Content types a browser renders as a document, or that the proxy doesn't know: never served as one. */
const NOT_PAGES: Record<string, [string | null, string]> = {
  "/xml": ["text/xml", XHTML],
  "/app-xml": ["application/xml", XHTML],
  "/svg": ["image/svg+xml", SVG],
  "/rss": ["application/rss+xml", XHTML],
  "/xsl": ["application/xslt+xml", XHTML],
  "/mixed": ["multipart/x-mixed-replace; boundary=x", `--x\r\nContent-Type: text/html\r\n\r\n${XHTML}\r\n--x--`],
  "/pdf": ["application/pdf", "%PDF-1.4"],
  "/plain": ["text/plain", XHTML],
  "/none": [null, XHTML],
  "/unknown": ["application/x-critiqs-unknown", XHTML],
  "/html-then-plain": ["text/html, text/plain", XHTML],
  "/bad-type": ["html", XHTML],
};
/** Labels a browser reads as HTML: always the proxy's rewritten page. */
const PAGES: Record<string, string> = {
  "/comma": "text/plain, text/html",
  "/upper": "TEXT/HTML; Charset=UTF-8",
  "/quoted": 'text/plain;a="b,c", text/html',
  "/star-then-html": "*/*, text/html",
  "/xhtml": "application/xhtml+xml",
};

const BIG = Buffer.alloc(15 * 1024 * 1024, 7);
const primary = http.createServer((request, response) => {
  const path = request.url ?? "/";
  const notPage = NOT_PAGES[path];
  if (notPage !== undefined) {
    response.writeHead(200, notPage[0] === null ? {} : { "Content-Type": notPage[0] });
    return void response.end(notPage[1]);
  }
  if (PAGES[path] !== undefined) {
    response.writeHead(200, { "Content-Type": PAGES[path]! });
    return void response.end(XHTML);
  }
  if (path.startsWith("/img/")) {
    // An image that takes 60 ms, as a real one over the internet does.
    return void setTimeout(() => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end("png");
    }, 60);
  }
  if (path === "/big.bin") {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    return void response.end(BIG);
  }
  if (path === "/style.css") {
    response.writeHead(200, { "Content-Type": "text/css" });
    return void response.end("body{color:red}");
  }
  if (path === "/hang.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return void response.write("/");
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><p>page</p>");
});
const cdn = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<p>not an image</p>");
});

let ports = { primary: 0, cdn: 0 };
beforeAll(async () => {
  ports = { primary: await listen(primary), cdn: await listen(cdn) };
});
afterAll(async () => {
  await Promise.all([close(primary), close(cdn)]);
});

const lease = (overrides: Partial<MemoryLease> = {}): MemoryLease => ({
  label: LABEL,
  linkId: "link-1",
  leaseId: "lease-1",
  origin: "http://proto.example.com",
  assetOrigins: [],
  expiresAt: Date.now() + 600_000,
  ...overrides,
});

function setup(options: { config?: ProxyConfig; leases?: MemoryLease[]; lookupMs?: number } = {}) {
  const settings = options.config ?? config;
  const web = testWeb({ "proto.example.com": [v4(PUBLIC_A)], "cdn.example.net": [v4(PUBLIC_B)] }, { [PUBLIC_A]: ports.primary, [PUBLIC_B]: ports.cdn });
  const reputation = cachedReputation(fixtureReputation());
  const policy = proxyPolicy(settings);
  const directory = memoryDirectory(options.leases ?? [lease()]);
  let lookups = 0;
  const counted = {
    ...directory,
    resolve: async (name: string) => {
      lookups++;
      if (options.lookupMs !== undefined) await Bun.sleep(options.lookupMs);
      return await directory.resolve(name);
    },
  };
  const proxy = createReviewProxy(settings, {
    directory: counted,
    egress: {
      primary: createEgress({ web, policy, reputation, userAgent: settings.userAgent, limits: settings.limits, reputationScope: "path" }),
      asset: createEgress({ web, policy, reputation, userAgent: settings.assetUserAgent, limits: settings.limits, reputationScope: "origin" }),
    },
    assets: { runtime: { file: RUNTIME, body: "/* runtime */" }, layer: { file: "layer.0123456789abcdef.js", body: "/* layer */" } },
  });
  return { proxy, directory, lookups: () => lookups };
}

type Ask = RequestInit & { host?: string; dest?: string | null; client?: string };
const ask = (proxy: ReturnType<typeof setup>["proxy"], path: string, init: Ask = {}) => {
  const headers = new Headers(init.headers);
  if (init.dest !== null) headers.set("sec-fetch-dest", init.dest ?? "iframe");
  const host = init.host ?? `${LABEL}.${DOMAIN}`;
  headers.set("host", host);
  return proxy.fetch(new Request(`http://${host}${path}`, { ...init, headers }), { client: init.client ?? "203.0.113.7" });
};

describe("a response is a page if a browser would show it as one", () => {
  for (const [path, type] of Object.entries(PAGES)) {
    for (const dest of ["iframe", "empty", null] as const) {
      test(`${JSON.stringify(type)} asked for as ${dest ?? "nothing"} is the rewritten page`, async () => {
        const { proxy } = setup();
        const response = await ask(proxy, path, { dest });
        const body = await response.text();
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(body).toContain(RUNTIME);
        expect(body).toContain("/__critiqs/leave?");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(response.headers.get("content-disposition")).toBeNull();
      });
    }
  }
  for (const [path, [type]] of Object.entries(NOT_PAGES)) {
    for (const dest of ["iframe", "empty", "image", null] as const) {
      test(`${JSON.stringify(type)} asked for as ${dest ?? "nothing"} can't be the frame's document`, async () => {
        const { proxy } = setup();
        const response = await ask(proxy, path, { dest });
        const body = await response.text();
        // A navigation to it is a download, which the frame's sandbox refuses; files loaded by the page don't read this header.
        expect(response.headers.get("content-disposition")).toBe("attachment");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("content-security-policy")).toContain("sandbox");
        // The browser sees only the type the proxy read, never a list it could read differently.
        expect(response.headers.get("content-type") ?? "").not.toContain(",");
        expect(body).not.toContain(RUNTIME);
      });
    }
  }
  test("a file the page loads still works: an SVG image keeps its type and body", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/svg", { dest: "image" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toBe(SVG);
  });
  test("a charset is kept, other parameters are not", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/mixed", { dest: "empty" });
    expect(response.headers.get("content-type")).toBe("multipart/x-mixed-replace");
  });
});

describe("every response says nosniff", () => {
  const cases: [string, Ask & { path: string }][] = [
    ["a page", { path: "/" }],
    ["a stylesheet", { path: "/style.css", dest: "style" }],
    ["a file", { path: "/img/1.png", dest: "image" }],
    ["the runtime", { path: `/__critiqs/${RUNTIME}`, dest: "script" }],
    ["a top-level open", { path: "/", dest: "document" }],
    ["an unknown frame host", { path: "/", host: `${label(9)}.${DOMAIN}` }],
    ["another domain", { path: "/", host: "evil.example" }],
    ["a write", { path: "/", method: "POST", body: "x" }],
    ["an upgrade", { path: "/", headers: { upgrade: "websocket" } }],
    ["an address too long", { path: `/${"a".repeat(5_000)}` }],
  ];
  for (const [name, { path, ...init }] of cases) {
    test(name, async () => {
      const { proxy } = setup();
      const response = await ask(proxy, path, init);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await response.arrayBuffer();
    });
  }
});

describe("the per-client lookup limit", () => {
  test("holds under a burst: 150 random hosts at once reach the directory at most 30 times", async () => {
    const { proxy, lookups } = setup({ lookupMs: 40 });
    const statuses = await Promise.all(Array.from({ length: 150 }, () => ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}` }).then((response) => response.status)));
    expect(statuses.every((status) => status === 404)).toBe(true);
    expect(lookups()).toBeLessThanOrEqual(DEFAULT_LIMITS.lookupMissesPerClient);
  });
  test("never refuses a frame host the proxy has seen live, for the client that used up its misses", async () => {
    const { proxy } = setup();
    expect((await ask(proxy, "/")).status).toBe(200);
    for (let index = 0; index < 40; index++) await ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}` });
    expect((await ask(proxy, "/")).status).toBe(200);
  });
  test("nor for another viewer on the same IPv6 /64", async () => {
    const { proxy } = setup({ leases: [lease(), lease({ label: label(1), leaseId: "lease-2" })] });
    expect((await ask(proxy, "/", { client: "2001:db8:1:2::10" })).status).toBe(200);
    expect((await ask(proxy, "/", { host: `${label(1)}.${DOMAIN}`, client: "2001:db8:1:2::11" })).status).toBe(200);
    await Promise.all(Array.from({ length: 150 }, () => ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}`, client: "2001:db8:1:2::99" })));
    expect((await ask(proxy, "/", { client: "2001:db8:1:2::10" })).status).toBe(200);
    expect((await ask(proxy, "/", { host: `${label(1)}.${DOMAIN}`, client: "2001:db8:1:2::11" })).status).toBe(200);
  });
  test("a host seen live is still asked about, so a link turned off stops serving at once", async () => {
    const { proxy, directory } = setup();
    expect((await ask(proxy, "/")).status).toBe(200);
    for (let index = 0; index < 40; index++) await ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}` });
    directory.paused.add("link-1");
    expect((await ask(proxy, "/")).status).toBe(404);
  });
});

describe("a public proxy knows its viewers' addresses", () => {
  const PUBLIC = {
    CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
    CRITIQS_WEB_ORIGINS: "https://critiqs.app",
    CRITIQS_PROXY_BACKEND: "https://brazen-snail-591.convex.site",
    CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
    CRITIQS_PROXY_SIGNING_KEY: "a-signing-key-that-is-long-enough-to-pass",
    CRITIQS_WEB_RISK_API_KEY: "test-key",
    CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list",
    CRITIQS_PROXY_CLIENT_IP_HEADER: "cf-connecting-ip",
  };
  test("refuses to start without CRITIQS_PROXY_CLIENT_IP_HEADER", () => {
    const { CRITIQS_PROXY_CLIENT_IP_HEADER: _, ...without } = PUBLIC;
    expect(() => parseProxyConfig(without)).toThrow("CRITIQS_PROXY_CLIENT_IP_HEADER");
  });
  test("starts when the operator says viewers connect directly", () => {
    expect(parseProxyConfig({ ...PUBLIC, CRITIQS_PROXY_CLIENT_IP_HEADER: "connection" }).clientIpHeader).toBeNull();
  });
  test("refuses to start without its own signing key", () => {
    const { CRITIQS_PROXY_SIGNING_KEY: _, ...without } = PUBLIC;
    expect(() => parseProxyConfig(without)).toThrow("CRITIQS_PROXY_SIGNING_KEY");
  });
  test("starts with both", () => {
    expect(parseProxyConfig(PUBLIC).clientIpHeader).toBe("cf-connecting-ip");
  });
});

describe("reads over a lease's share wait their turn", () => {
  test("30 images at once on one lease all load", async () => {
    const { proxy } = setup();
    // As a browser does: each image is read as soon as it answers.
    const statuses = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const response = await ask(proxy, `/img/${index}.png`, { dest: "image" });
      await response.arrayBuffer();
      return response.status;
    }));
    expect(statuses.filter((status) => status === 200).length).toBe(30);
  });
  test("four viewers of one link, eight images each, all load", async () => {
    const leases = Array.from({ length: 4 }, (_, index) => lease({ label: label(index), leaseId: `viewer-${index}` }));
    const { proxy } = setup({ leases });
    const statuses = await Promise.all(leases.flatMap((entry) => Array.from({ length: 8 }, async (_, index) => {
      const response = await ask(proxy, `/img/${index}.png`, { dest: "image", host: `${entry.label}.${DOMAIN}` });
      await response.arrayBuffer();
      return response.status;
    })));
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });
  test("a wait is bounded: a read whose turn never comes is refused at its deadline", async () => {
    const short = { ...config, limits: { ...DEFAULT_LIMITS, concurrentPerLease: 1, concurrentPrefetchPerLease: 1, queueTimeoutMs: 300 } };
    const { proxy } = setup({ config: short });
    const held = new AbortController();
    const holding = await ask(proxy, "/hang.js", { dest: "script", signal: held.signal });
    const started = performance.now();
    const waiting = await ask(proxy, "/img/1.png", { dest: "image" });
    expect(waiting.status).toBe(503);
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(performance.now() - started).toBeLessThan(2_000);
    held.abort();
    await holding.body?.cancel().catch(() => undefined);
  });
  test("a browser that gives up on a waiting read takes it out of the line", async () => {
    const short = { ...config, limits: { ...DEFAULT_LIMITS, concurrentPerLease: 1, concurrentPrefetchPerLease: 1 } };
    const { proxy } = setup({ config: short });
    const held = new AbortController();
    const holding = await ask(proxy, "/hang.js", { dest: "script", signal: held.signal });
    const gone = new AbortController();
    const waiting = ask(proxy, "/img/1.png", { dest: "image", signal: gone.signal });
    await Bun.sleep(50);
    gone.abort();
    expect((await waiting).status).toBe(503);
    held.abort();
    await holding.body?.cancel().catch(() => undefined);
    // The line is empty again: the next read gets the slot at once.
    const next = await ask(proxy, "/img/2.png", { dest: "image" });
    expect(next.status).toBe(200);
    await next.arrayBuffer();
  });
});

describe("a browser that stops reading gives its read back", () => {
  test("24 never-read 15 MiB files release the host's share within seconds", async () => {
    const leases = Array.from({ length: 3 }, (_, index) => lease({ label: label(index), leaseId: `reader-${index}`, linkId: `link-${index}` }));
    const { proxy } = setup({ leases });
    const responses = await Promise.all(leases.flatMap((entry) => Array.from({ length: 8 }, () => ask(proxy, "/big.bin", { dest: "image", host: `${entry.label}.${DOMAIN}` }))));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(proxy.inFlight).toBe(24);
    const started = performance.now();
    while (proxy.inFlight > 0 && performance.now() - started < 9_000) await Bun.sleep(100);
    expect(proxy.inFlight).toBe(0);
    expect(performance.now() - started).toBeLessThan(DEFAULT_LIMITS.clientStallMs + 1_500);
    for (const response of responses) await response.body?.cancel().catch(() => undefined);
  }, 15_000);
});

describe("a file the proxy refuses says so", () => {
  test("another site's file of the wrong type", async () => {
    const { proxy } = setup();
    const { assetPath } = await import("../src/urls.ts");
    const path = assetPath({ primary: "http://proto.example.com", slots: [], leaseId: "lease-1", secret: config.signingKey }, "image", new URL("http://cdn.example.net/x.png"))!;
    const response = await ask(proxy, path, { dest: "image" });
    expect(response.status).toBe(502);
    expect(response.headers.get("server-timing")).toContain("critiqs-refused");
  });
  test("a read refused at its deadline", async () => {
    const short = { ...config, limits: { ...DEFAULT_LIMITS, concurrentPerLease: 1, concurrentPrefetchPerLease: 1, queueTimeoutMs: 100 } };
    const { proxy } = setup({ config: short });
    const held = new AbortController();
    const holding = await ask(proxy, "/hang.js", { dest: "script", signal: held.signal });
    const refused = await ask(proxy, "/img/1.png", { dest: "image" });
    expect(refused.headers.get("server-timing")).toContain("critiqs-refused");
    held.abort();
    await holding.body?.cancel().catch(() => undefined);
  });
  test("a file the prototype itself answers with an error doesn't", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/img/1.png", { dest: "image" });
    expect(response.headers.get("server-timing")).toBeNull();
    await response.arrayBuffer();
  });
});

describe("the frame's runtime", () => {
  test("marks the window as a review frame for good", () => {
    const scope: Record<symbol, unknown> = {};
    markReviewFrame(scope);
    const mark = Symbol.for("critiqs.review-frame");
    expect(scope[mark]).toBe(true);
    expect(() => {
      "use strict";
      scope[mark] = false;
    }).toThrow();
    expect(() => delete scope[mark]).toThrow();
    expect(scope[mark]).toBe(true);
  });
  test("knows a file the proxy refused by its Server-Timing entry", async () => {
    const { proxy } = setup();
    const { assetPath } = await import("../src/urls.ts");
    const path = assetPath({ primary: "http://proto.example.com", slots: [], leaseId: "lease-1", secret: config.signingKey }, "image", new URL("http://cdn.example.net/x.png"))!;
    const header = (await ask(proxy, path, { dest: "image" })).headers.get("server-timing")!;
    expect(refusedByProxy({ serverTiming: header.split(",").map((entry) => ({ name: entry.split(";")[0]!.trim() })) })).toBe(true);
    expect(refusedByProxy({ serverTiming: [{ name: "app" }] })).toBe(false);
    expect(refusedByProxy({})).toBe(false);
  });
});
