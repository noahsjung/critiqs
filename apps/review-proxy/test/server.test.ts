import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import { DEFAULT_LIMITS, parseProxyConfig, type ProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { close, listen, PUBLIC_A, PUBLIC_B, PUBLIC_C, recordingServer, testWeb, v4 } from "./fixtures.ts";

// The proxy's HTTP handler end to end, against local upstream sites through
// the real pinned connector: AT-7 (on the wire), AT-9 to AT-12 and AT-20.

const LABEL = `v-${"a".repeat(26)}`;
const OTHER = `v-${"b".repeat(26)}`;
const HOST = `${LABEL}.review.localhost:5120`;

const baseConfig = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});

const BIG = "x".repeat(3 * 1024 * 1024);
const primary = recordingServer((request, response) => {
  const path = request.url ?? "/";
  const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "upstream=1; Domain=review.localhost", ...headers });
    response.end(body);
  };
  switch (path) {
    case "/":
      return html(`<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="http://cdn.example.net/lib.css"></head>
<body><h1>Home</h1><img src="http://cdn.example.net/logo.png"><a href="https://elsewhere.example.net/x">out</a></body></html>`);
    case "/site.css":
      response.writeHead(200, { "Content-Type": "text/css", "Content-Encoding": "gzip" });
      return response.end(zlib.gzipSync(".hero{background:url(http://cdn.example.net/hero.png)}"));
    case "/api/items":
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end('{"items":[1,2,3]}');
    case "/old":
      response.writeHead(301, { Location: "/new?from=old" });
      return response.end();
    case "/new?from=old":
      return html("<p>new</p>");
    case "/signin":
      response.writeHead(302, { Location: "https://accounts.google.com/o/oauth2/auth?client_id=secret" });
      return response.end();
    case "/private":
      return html("<p>who are you</p>", 401, { "WWW-Authenticate": "Basic" });
    case "/bot":
      return html("<title>Just a moment...</title><p>Checking your browser</p>", 403, { Server: "cloudflare", "cf-mitigated": "challenge" });
    case "/big":
      return html(`<p>${BIG}</p>`);
    case "/latin1":
      response.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" });
      return response.end(Buffer.from("<p>caf\xe9</p>", "latin1"));
    case "/missing":
      return html("<h1>Not here</h1>", 404);
    default:
      return html(`<p>${path}</p>`);
  }
});
const cdn = recordingServer((request, response) => {
  const path = request.url ?? "/";
  const types: Record<string, string> = {
    "/logo.png": "image/png",
    "/hero.png": "image/png",
    "/lib.css": "text/css",
    "/font.woff2": "font/woff2",
    "/page.html": "text/html",
    "/data.json": "application/json",
    "/notes.txt": "text/plain",
    "/lib.js": "text/javascript",
  };
  response.writeHead(200, { "Content-Type": types[path] ?? "application/octet-stream", "Set-Cookie": "tracker=1", "Access-Control-Allow-Origin": "*" });
  response.end(path === "/lib.css" ? "@font-face{font-family:F;src:url(font.woff2)}" : `bytes of ${path}`);
});
const api = recordingServer((request, response) => {
  if (request.url === "/page") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end("<p>a page</p>");
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end('{"me":"dana"}');
});

let ports = { primary: 0, cdn: 0, api: 0 };
beforeAll(async () => {
  ports = { primary: await listen(primary.server), cdn: await listen(cdn.server), api: await listen(api.server) };
});
afterAll(async () => {
  await Promise.all([close(primary.server), close(cdn.server), close(api.server)]);
});

function setup(options: { config?: ProxyConfig; unsafe?: string[]; now?: () => number } = {}) {
  const config = options.config ?? baseConfig;
  const web = testWeb(
    { "proto.example.com": [v4(PUBLIC_A)], "cdn.example.net": [v4(PUBLIC_B)], "api.example.com": [v4(PUBLIC_C)], "elsewhere.example.net": [v4(PUBLIC_B)] },
    { [PUBLIC_A]: ports.primary, [PUBLIC_B]: ports.cdn, [PUBLIC_C]: ports.api },
  );
  const reputation = cachedReputation(fixtureReputation(options.unsafe ?? []));
  const policy = proxyPolicy(config);
  const directory = memoryDirectory(
    [{ label: LABEL, linkId: "link-1", leaseId: "lease-1", origin: "http://proto.example.com", assetOrigins: [{ slot: 1, origin: "http://api.example.com" }], expiresAt: Date.now() + 600_000 }],
    options.now,
  );
  const proxy = createReviewProxy(config, {
    directory,
    egress: {
      primary: createEgress({ web, policy, reputation, userAgent: config.userAgent, limits: config.limits }),
      asset: createEgress({ web, policy, reputation, userAgent: config.assetUserAgent, limits: config.limits }),
    },
    assets: { runtime: { file: "runtime.0123456789abcdef.js", body: "/* runtime */" }, layer: { file: "layer.0123456789abcdef.js", body: "/* layer */" } },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { proxy, web, directory };
}

const ask = (proxy: ReturnType<typeof setup>["proxy"], path: string, init: RequestInit & { host?: string; dest?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.dest !== null) headers.set("sec-fetch-dest", init.dest ?? "iframe");
  // The Host header is what the proxy reads, as behind an ingress.
  headers.set("host", init.host ?? HOST);
  return proxy.fetch(new Request(`http://${HOST}${path}`, { ...init, headers }));
};

describe("pages through the proxy", () => {
  test("a page is rewritten, with the scripts, the frame policy and none of the upstream's cookies", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors http://web.localhost:5110");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain('<script src="/__critiqs/runtime.0123456789abcdef.js"');
    expect(html).toContain('<link rel="stylesheet" href="/site.css">');
    expect(html).toMatch(/<img src="\/__critiqs\/a\/[^/]+\/image\/http\/cdn\.example\.net\/logo\.png">/);
    expect(html).toMatch(/<a href="\/__critiqs\/leave\?to=https%3A%2F%2Felsewhere\.example\.net&amp;s=/);
  });

  test("the browser's own headers never go upstream (AT-7, on the wire)", async () => {
    const { proxy } = setup();
    primary.requests.length = 0;
    await ask(proxy, "/", {
      headers: {
        cookie: "session=reviewer; __Host-critiqs=1",
        authorization: "Bearer reviewer-token",
        "x-forwarded-for": "10.0.0.1",
        "x-real-ip": "10.0.0.1",
        forwarded: "for=10.0.0.1",
        origin: "http://web.localhost:5110",
        referer: "http://web.localhost:5110/r/key",
        "user-agent": "Mozilla/5.0 reviewer fingerprint",
        "accept-language": "en-GB",
        connection: "keep-alive, X-Secret",
        "x-secret": "1",
      },
    }).then((response) => response.text());
    const seen = primary.requests.at(-1)!.headers;
    expect(Object.keys(seen).sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"]);
    expect(seen["user-agent"]).toBe("Critiqs-Review/1 (+http://web.localhost:5110/allow-critiqs)");
  });

  test("a stylesheet on the prototype is decompressed and rewritten", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/site.css", { dest: "style" });
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toMatch(/^\.hero\{background:url\("\/__critiqs\/a\/[^/]+\/image\/http\/cdn\.example\.net\/hero\.png"\)\}$/);
  });

  test("data on the prototype's origin passes through, inert as a page", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/api/items", { dest: "empty" });
    expect(await response.text()).toBe('{"items":[1,2,3]}');
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a redirect is followed on the server and the final path given to the runtime", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/old");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("&quot;path&quot;:&quot;/new?from=old&quot;");
  });

  for (const [path, reason, status] of [
    ["/signin", "This prototype signs in elsewhere", 200],
    ["/private", "This page needs a sign-in", 401],
    ["/bot", "This page blocked Critiqs", 403],
    ["/big", "This page is too large", 502],
    ["/latin1", "This page can&#39;t be shown here", 502],
  ] as const) {
    test(`${path} shows the proxy's own notice`, async () => {
      const { proxy } = setup();
      const response = await ask(proxy, path);
      expect(response.status).toBe(status);
      const html = await response.text();
      expect(html).toContain(reason);
      expect(html).toContain("critiqs:review-frame");
      expect(html).not.toContain("client_id");
    });
  }

  test("an app's own 404 page is shown as the app's", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/missing");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<h1>Not here</h1>");
  });

  test("an unsafe page is never fetched", async () => {
    const { proxy, web } = setup({ unsafe: ["http://proto.example.com/phish"] });
    const response = await ask(proxy, "/phish");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("This page can&#39;t be shown");
    expect(web.connected).toEqual([]);
  });

  test("HEAD answers headers only", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("usage is counted per link and reported", async () => {
    const { proxy, directory } = setup();
    await (await ask(proxy, "/")).text();
    await (await ask(proxy, "/api/items", { dest: "empty" })).text();
    await proxy.reportUsage();
    expect(directory.reports).toHaveLength(1);
    expect(directory.reports[0]!.linkId).toBe("link-1");
    expect(directory.reports[0]!.requests).toBe(2);
    expect(directory.reports[0]!.bytes).toBeGreaterThan(100);
  });
});

describe("AT-9: not an open proxy", () => {
  test("an unsigned, tampered or other-lease asset path is refused before any lookup", async () => {
    const { proxy, web } = setup();
    const home = await (await ask(proxy, "/")).text();
    const signed = /src="(\/__critiqs\/a\/[^"]+)"/.exec(home)![1]!;
    for (const path of [
      "/__critiqs/a/image/http/cdn.example.net/logo.png",
      signed.replace("logo.png", "secret.png"),
      signed.replace("cdn.example.net", "internal.example.net"),
      signed.replace(/\/a\/[^/]+\//, "/a/AAAAAAAAAAAAAAAAAAAAAA/"),
      "/__critiqs/a/AAAAAAAAAAAAAAAAAAAAAA/image/https/169.254.169.254/latest/meta-data/",
      "/__critiqs/o/9/anything",
      "/__critiqs/fetch?u=https://example.org/",
    ]) {
      web.resolved.length = 0;
      // Even with the headers a same-origin fetch would carry.
      const response = await ask(proxy, path, { dest: "image", headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" } });
      expect(response.status).toBe(404);
      expect(web.resolved).toEqual([]);
    }
    // The positive control: the signed path itself works.
    expect((await ask(proxy, signed, { dest: "image" })).status).toBe(200);
  });

  test("the same signed path is refused on another lease", async () => {
    const { proxy, directory } = setup();
    directory.leases.set(OTHER, { ...directory.leases.get(LABEL)!, label: OTHER, leaseId: "lease-2" });
    const home = await (await ask(proxy, "/")).text();
    const signed = /src="(\/__critiqs\/a\/[^"]+)"/.exec(home)![1]!;
    expect((await ask(proxy, signed, { dest: "image", host: `${OTHER}.review.localhost:5120` })).status).toBe(404);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]) {
    test(`${method} is refused, even claiming to be same-origin`, async () => {
      const { proxy, web } = setup();
      const response = await ask(proxy, "/api/items", { method, dest: "empty", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, ...(method === "GET" ? {} : {}) });
      expect(response.status).toBe(405);
      expect(web.connected).toEqual([]);
    });
  }

  test("a WebSocket upgrade is refused", async () => {
    const { proxy, web } = setup();
    const response = await ask(proxy, "/socket", { dest: "websocket", headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(response.status).toBe(403);
    expect(web.connected).toEqual([]);
  });

  test("a service worker script request is refused", async () => {
    const { proxy, web } = setup();
    const response = await ask(proxy, "/sw.js", { dest: "serviceworker", headers: { "service-worker": "script" } });
    expect(response.status).toBe(403);
    expect(web.connected).toEqual([]);
  });

  test("an owner-approved slot serves data, never a page", async () => {
    const { proxy } = setup();
    const data = await ask(proxy, "/__critiqs/o/1/me", { dest: "empty" });
    expect(await data.text()).toBe('{"me":"dana"}');
    expect((await ask(proxy, "/__critiqs/o/1/page", { dest: "empty" })).status).toBe(502);
    expect((await ask(proxy, "/__critiqs/o/1/me", { dest: "iframe" })).status).toBe(404);
  });
});

describe("AT-10: third-party assets", () => {
  test("never send the review user agent", async () => {
    const { proxy } = setup();
    cdn.requests.length = 0;
    const home = await (await ask(proxy, "/")).text();
    for (const [, path] of home.matchAll(/(?:src|href)="(\/__critiqs\/a\/[^"]+)"/g)) await (await ask(proxy, path!.replaceAll("&amp;", "&"), { dest: path!.includes("/style/") ? "style" : "image" })).text();
    expect(cdn.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of cdn.requests) {
      expect(request.headers["user-agent"]).toBe("Critiqs-Asset/1");
      expect(request.headers["user-agent"]).not.toContain("Critiqs-Review");
    }
  });

  test("a third-party stylesheet is rewritten, and its fonts signed in turn", async () => {
    const { proxy } = setup();
    const home = await (await ask(proxy, "/")).text();
    const sheet = /href="(\/__critiqs\/a\/[^"]+\/style\/[^"]+)"/.exec(home)![1]!;
    const css = await (await ask(proxy, sheet, { dest: "style" })).text();
    const font = /url\("(\/__critiqs\/a\/[^"]+\/font\/http\/cdn\.example\.net\/font\.woff2)"\)/.exec(css)![1]!;
    const response = await ask(proxy, font, { dest: "font" });
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("refuses HTML, JSON and text, whatever the path's class", async () => {
    const { proxy } = setup();
    // Signed as images, as a page could make the proxy sign any address it links as an image.
    const { assetPath } = await import("../src/urls.ts");
    const ctx = { primary: "http://proto.example.com", slots: [], leaseId: "lease-1", secret: baseConfig.secret };
    for (const [file, assetClass] of [
      ["/page.html", "image"],
      ["/data.json", "image"],
      ["/notes.txt", "script"],
      ["/page.html", "style"],
      ["/logo.png", "script"],
    ] as const) {
      const path = assetPath(ctx, assetClass, new URL(`http://cdn.example.net${file}`))!;
      const response = await ask(proxy, path, { dest: assetClass });
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("");
    }
  });
});

describe("AT-11: host confusion", () => {
  for (const host of ["evil.example", `${LABEL}.review.localhost:5120.evil.example`, "review.localhost:5121", `${LABEL}.review.localhost`, "localhost:5120", "web.localhost:5110"]) {
    test(`Host ${host} gets 421`, async () => {
      const { proxy, web } = setup();
      const response = await ask(proxy, "/", { host });
      expect(response.status).toBe(421);
      expect(web.connected).toEqual([]);
    });
  }
});

describe("AT-12: a frame host never shows the prototype top-level", () => {
  test("a top-level open gets the notice, and nothing is fetched or resolved", async () => {
    const { proxy, web } = setup();
    const response = await ask(proxy, "/", { dest: "document", headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Open this from its review link");
    expect(web.resolved).toEqual([]);
    expect(web.connected).toEqual([]);
  });
});

describe("AT-20: hosts that serve nothing all look the same", () => {
  test("unknown, malformed, expired and paused lease hosts, and the bare domain, get one identical 404", async () => {
    let time = Date.now();
    const { proxy, directory } = setup({ now: () => time });
    directory.leases.set(OTHER, { ...directory.leases.get(LABEL)!, label: OTHER, linkId: "link-2", leaseId: "lease-2" });
    const bodies = new Set<string>();
    const statuses = new Set<number>();
    const record = async (response: Response) => {
      statuses.add(response.status);
      bodies.add(`${response.headers.get("content-type")}|${await response.text()}`);
    };
    await record(await ask(proxy, "/", { host: `v-${"c".repeat(26)}.review.localhost:5120` }));
    await record(await ask(proxy, "/", { host: "v-short.review.localhost:5120" }));
    await record(await ask(proxy, "/", { host: `x-${"a".repeat(26)}.review.localhost:5120` }));
    await record(await ask(proxy, "/", { host: `a.${LABEL}.review.localhost:5120` }));
    await record(await ask(proxy, "/", { host: "review.localhost:5120" }));
    directory.paused.add("link-2");
    await record(await ask(proxy, "/", { host: `${OTHER}.review.localhost:5120` }));
    time += 3_600_000;
    await record(await ask(proxy, "/"));
    expect([...statuses]).toEqual([404]);
    expect(bodies.size).toBe(1);
  });
});

describe("limits", () => {
  test("a lease past its request window gets the busy notice", async () => {
    const config = { ...baseConfig, limits: { ...DEFAULT_LIMITS, requestsPerWindow: 2 } };
    const { proxy } = setup({ config });
    expect((await ask(proxy, "/api/items", { dest: "empty" })).status).toBe(200);
    expect((await ask(proxy, "/api/items", { dest: "empty" })).status).toBe(200);
    expect((await ask(proxy, "/api/items", { dest: "empty" })).status).toBe(429);
    const page = await ask(proxy, "/");
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Critiqs is busy");
  });

  test("past the lease's reads in flight, 503 at once, and the slot frees when the body ends", async () => {
    const config = { ...baseConfig, limits: { ...DEFAULT_LIMITS, concurrentPerLease: 1 } };
    const { proxy } = setup({ config });
    const first = await ask(proxy, "/api/items", { dest: "empty" });
    expect(proxy.inFlight).toBe(1);
    expect((await ask(proxy, "/api/items", { dest: "empty" })).status).toBe(503);
    await first.text();
    expect(proxy.inFlight).toBe(0);
    expect((await ask(proxy, "/api/items", { dest: "empty" })).status).toBe(200);
  });

  test("oversized URLs and headers are refused; a large Cookie header is ignored, not refused (AT-15)", async () => {
    const { proxy } = setup();
    expect((await ask(proxy, `/${"a".repeat(3_000)}`)).status).toBe(414);
    expect((await ask(proxy, "/", { headers: { "x-big": "y".repeat(20 * 1024) } })).status).toBe(431);
    primary.requests.length = 0;
    const tossed = Array.from({ length: 8 }, (_, index) => `toss${index}=${"z".repeat(4000)}`).join("; ");
    const response = await ask(proxy, "/", { headers: { cookie: tossed } });
    expect(response.status).toBe(200);
    await response.text();
    expect(primary.requests.at(-1)!.headers.cookie).toBeUndefined();
  });
});
