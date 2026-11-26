import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { DEFAULT_LIMITS, parseProxyConfig, type ProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory, type MemoryLease } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { rewriteCss } from "../src/css.ts";
import { rewriteHtml } from "../src/html.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { assetPath, mapUrl, type UrlContext } from "../src/urls.ts";
import { runtimeUrl } from "../runtime/shim.ts";
import { close, listen, PUBLIC_A, PUBLIC_B, PUBLIC_C, recordingServer, testWeb, v4 } from "./fixtures.ts";

// Attacks the two security reviews of the proxy found, each reproduced
// against the real handler, rewriter and pinned connector:
//
// - F-H2-1: a `//host` or `/\host` path on the prototype's origin must never
//   come out as a protocol-relative address that leaves the frame host;
// - F-H2-2: what the client says a request is for (`Sec-Fetch-Dest`) must not
//   decide whether HTML is rewritten, capped and checked;
// - F-H2-3: a third-party or owner-approved response's file type is checked
//   whatever its status;
// - F-H2-4: every response on a frame host may be framed only by the website;
// - Opus N1, N2, N4 and N9, Gemini notes 9 and 11, and the smaller notes.

const LABEL = `v-${"a".repeat(26)}`;
const label = (index: number) => `v-${"abcdefghijklmnopqrstuvwxyz234567"[index]!.repeat(26)}`;
const DOMAIN = "review.localhost:5120";
const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: `http://${DOMAIN}`,
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});

const primary = recordingServer((request, response) => {
  const html = (body: string, status = 200) => {
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  };
  switch (request.url) {
    case "/phish":
      return html("<!doctype html><h1>UNSAFE PHISH PAGE</h1>");
    case "/signin":
      return html("<!doctype html><h1>SECRET SIGNIN HTML</h1>", 401);
    case "/big":
      return html(`<p>${"x".repeat(3 * 1024 * 1024)}</p>`);
    case "/escape":
      return html(
        '<!doctype html><head><meta http-equiv="refresh" content="0; url=http://proto.example.com//evil.localhost:6459/refreshed"></head><body><a id="a" href="http://proto.example.com//evil.example/a">a</a><a id="b" href="/\\evil.example/b">b</a></body>',
      );
    case "/to-double-slash":
      response.writeHead(302, { Location: "//proto.example.com//evil.example/landed" });
      return response.end();
    case "//evil.example/landed":
      return html("<p>landed</p>");
    case "/many-links":
      return html(`<!doctype html>${Array.from({ length: 4_000 }, (_, index) => `<img src="http://cdn.example.net/${index}.png">`).join("")}`);
    case "/api/data":
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end('{"secret":"json-data"}');
    case "/logo.png":
      response.writeHead(200, { "Content-Type": "image/png" });
      return response.end("png");
    default:
      return html(`<p>${request.url}</p>`);
  }
});
const cdn = recordingServer((request, response) => {
  if (request.url === "/err-png") {
    response.writeHead(404, { "Content-Type": "image/png" });
    return void response.end("SECRET IMAGE-TYPED ERROR BODY");
  }
  if (request.url === "/err404") {
    response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    return void response.end("<html><body>THIRD-PARTY 404 HTML SECRET</body></html>");
  }
  if (request.url?.endsWith(".css")) {
    const next = Number(/(\d+)\.css/.exec(request.url)?.[1] ?? 0) + 1;
    response.writeHead(200, { "Content-Type": "text/css" });
    return void response.end(`@import url("http://cdn.example.net/${next}.css");\n.x${next}{color:red}`);
  }
  response.writeHead(200, { "Content-Type": "image/png" });
  response.end("png");
});
const api = recordingServer((request, response) => {
  if (request.url === "/error-page") {
    response.writeHead(500, { "Content-Type": "text/html" });
    return void response.end("<html><body>SLOT ERROR PAGE SECRET</body></html>");
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end('{"error":"not found"}');
});
/** A site that sends one byte every 8 seconds and never finishes. */
const slow = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/javascript" });
  response.flushHeaders();
  response.write("/");
  const timer = setInterval(() => response.write("/"), 8_000);
  response.on("close", () => clearInterval(timer));
});
const SLOW = "93.184.215.20";

let ports = { primary: 0, cdn: 0, api: 0, slow: 0 };
beforeAll(async () => {
  ports = { primary: await listen(primary.server), cdn: await listen(cdn.server), api: await listen(api.server), slow: await listen(slow) };
});
afterAll(async () => {
  slow.closeAllConnections();
  await Promise.all([close(primary.server), close(cdn.server), close(api.server), close(slow)]);
});

const lease = (overrides: Partial<MemoryLease> = {}): MemoryLease => ({
  label: LABEL,
  linkId: "link-1",
  leaseId: "lease-1",
  origin: "http://proto.example.com",
  assetOrigins: [{ slot: 1, origin: "http://api.example.com" }],
  expiresAt: Date.now() + 600_000,
  ...overrides,
});

function setup(options: { config?: ProxyConfig; unsafe?: string[]; leases?: MemoryLease[] } = {}) {
  const settings = options.config ?? config;
  const web = testWeb(
    { "proto.example.com": [v4(PUBLIC_A)], "cdn.example.net": [v4(PUBLIC_B)], "api.example.com": [v4(PUBLIC_C)], "slow.example": [v4(SLOW)], "slow2.example": [v4(SLOW)], "slow3.example": [v4(SLOW)], "slow4.example": [v4(SLOW)], "slow5.example": [v4(SLOW)], "victim.example": [v4(PUBLIC_A)] },
    { [PUBLIC_A]: ports.primary, [PUBLIC_B]: ports.cdn, [PUBLIC_C]: ports.api, [SLOW]: ports.slow },
  );
  const reputation = cachedReputation(fixtureReputation(options.unsafe ?? []));
  const policy = proxyPolicy(settings);
  const directory = memoryDirectory(options.leases ?? [lease()]);
  let lookups = 0;
  const counted = { ...directory, resolve: async (name: string) => (lookups++, await directory.resolve(name)) };
  const proxy = createReviewProxy(settings, {
    directory: counted,
    egress: {
      primary: createEgress({ web, policy, reputation, userAgent: settings.userAgent, limits: settings.limits, reputationScope: "path" }),
      asset: createEgress({ web, policy, reputation, userAgent: settings.assetUserAgent, limits: settings.limits, reputationScope: "origin" }),
    },
    assets: { runtime: { file: "runtime.0123456789abcdef.js", body: "/* runtime */" }, layer: { file: "layer.0123456789abcdef.js", body: "/* layer */" } },
  });
  return { proxy, lookups: () => lookups };
}

type Ask = RequestInit & { host?: string; dest?: string | null; client?: string };
const ask = (proxy: ReturnType<typeof setup>["proxy"], path: string, init: Ask = {}) => {
  const headers = new Headers(init.headers);
  if (init.dest !== null) headers.set("sec-fetch-dest", init.dest ?? "iframe");
  const host = init.host ?? `${LABEL}.${DOMAIN}`;
  headers.set("host", host);
  return (proxy.fetch as (request: Request, info?: { client: string }) => Promise<Response>)(new Request(`http://${host}${path}`, { ...init, headers }), { client: init.client ?? "203.0.113.7" });
};

const CTX: UrlContext = { primary: "http://proto.example.com", slots: [{ slot: 1, origin: "http://api.example.com" }], leaseId: "lease-1", secret: config.signingKey };
const BASE = new URL("http://proto.example.com/page");
/** Whether a path the browser is given would leave the frame host: read against it, does it keep its origin? */
const staysOnFrameHost = (path: string) => new URL(path, `http://${LABEL}.${DOMAIN}/page`).origin === `http://${LABEL}.${DOMAIN}`;

describe("F-H2-1: a // path never leaves the frame host", () => {
  // `/\evil.example/x` resolves to another site, which the page itself names: the rewriter sends it to the leave notice, and the shim leaves it for the frame's policy and navigation guard.
  for (const raw of ["http://proto.example.com//evil.example/phish", "http://proto.example.com/\\evil.example/phish", "//proto.example.com//evil.example/x", "/\\evil.example/x", "http://proto.example.com/%2F/evil.example/x"]) {
    test(`mapUrl(${raw})`, () => {
      for (const as of ["page", "image", "script"] as const) expect(staysOnFrameHost(mapUrl(CTX, raw, BASE, as))).toBe(true);
    });
  }
  for (const raw of ["http://proto.example.com//evil.example/phish", "http://proto.example.com/\\evil.example/phish", "//proto.example.com//evil.example/x", "http://proto.example.com/%2F/evil.example/x"]) {
    test(`runtimeUrl(${raw})`, () => {
      expect(staysOnFrameHost(runtimeUrl({ primary: CTX.primary, slots: [...CTX.slots], path: null }, raw, BASE.href, `http://${LABEL}.${DOMAIN}`))).toBe(true);
    });
  }
  test("a rewritten page's refresh and links stay on the frame host", () => {
    const html = rewriteHtml(CTX, '<meta http-equiv="refresh" content="0; url=http://proto.example.com//evil.example/r"><a href="http://proto.example.com//evil.example/a">a</a><a href="/\\evil.example/b">b</a>', BASE, {
      runtime: "runtime.x.js",
      layer: "layer.x.js",
      panelOrigins: [],
      finalPath: null,
    });
    const refresh = /content="0; url=([^"]+)"/.exec(html)?.[1];
    if (refresh !== undefined) expect(staysOnFrameHost(refresh)).toBe(true);
    for (const [, href] of html.matchAll(/<a href="([^"]+)"/g)) expect(staysOnFrameHost(href!.replaceAll("&amp;", "&"))).toBe(true);
  });
  test("a redirect that lands on a // path gives the runtime a path that stays", async () => {
    const { proxy } = setup();
    const html = await (await ask(proxy, "/to-double-slash")).text();
    const map = JSON.parse(/data-critiqs-map="([^"]+)"/.exec(html)![1]!.replaceAll("&quot;", '"')) as { path: string };
    expect(staysOnFrameHost(map.path)).toBe(true);
  });
  test("a frame path that starts with // still fetches that path on the prototype", async () => {
    const { proxy } = setup();
    primary.requests.length = 0;
    const response = await ask(proxy, "/.//evil.example/landed");
    expect(await response.text()).toContain("landed");
    expect(primary.requests.at(-1)!.url).toBe("//evil.example/landed");
  });
});

describe("F-H2-2: a client's header never turns the page checks off", () => {
  for (const dest of ["empty", "script", "image", "style", "json", null]) {
    test(`an unsafe path asked for as ${dest ?? "nothing"} is refused`, async () => {
      const { proxy } = setup({ unsafe: ["http://proto.example.com/phish"] });
      const response = await ask(proxy, "/phish", { dest });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("UNSAFE PHISH PAGE");
    });
  }
  test("a sign-in page asked for with fetch() is named, not shown", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/signin", { dest: "empty" });
    expect(await response.text()).not.toContain("SECRET SIGNIN HTML");
  });
  test("HTML asked for with fetch() is rewritten and capped like a page", async () => {
    const { proxy } = setup();
    const page = await (await ask(proxy, "/escape", { dest: "empty" })).text();
    expect(page).toContain("/__critiqs/runtime.0123456789abcdef.js");
    const big = await ask(proxy, "/big", { dest: "empty" });
    expect(big.status).toBe(502);
    expect((await big.text()).length).toBeLessThan(10_000);
  });
});

describe("F-H2-3: other sites' file types are checked whatever the status", () => {
  test("a signed image whose host answers 404 HTML gets no body", async () => {
    const { proxy } = setup();
    const path = assetPath(CTX, "image", new URL("http://cdn.example.net/err404"))!;
    const response = await ask(proxy, path, { dest: "image" });
    expect(await response.text()).not.toContain("SECRET");
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  });
  test("a signed image whose host answers 404 with an image type still gets no body", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, assetPath(CTX, "image", new URL("http://cdn.example.net/err-png"))!, { dest: "image" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
  test("an owner-approved origin's HTML error page gets no body; its JSON error passes", async () => {
    const { proxy } = setup();
    const page = await ask(proxy, "/__critiqs/o/1/error-page", { dest: "empty" });
    expect(await page.text()).not.toContain("SECRET");
    const json = await ask(proxy, "/__critiqs/o/1/missing", { dest: "empty" });
    expect(json.status).toBe(404);
    expect(await json.text()).toBe('{"error":"not found"}');
  });
});

describe("F-H2-4: every response may be framed only by the website", () => {
  for (const [path, dest] of [
    ["/api/data", "iframe"],
    ["/logo.png", "iframe"],
    ["/api/data", "empty"],
    ["/__critiqs/nothing", "iframe"],
    ["/__critiqs/runtime.0123456789abcdef.js", "script"],
    ["/__critiqs/o/1/missing", "empty"],
  ] as const) {
    test(`${path} as ${dest}`, async () => {
      const { proxy } = setup();
      const response = await ask(proxy, path, { dest });
      expect(response.headers.get("content-security-policy") ?? "").toMatch(/frame-ancestors http:\/\/web\.localhost:5110(;|$)/);
    });
  }
  test("a host that serves nothing", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/", { host: `${label(9)}.${DOMAIN}` });
    expect(response.headers.get("content-security-policy") ?? "").toContain("frame-ancestors");
  });
});

describe("Opus N1: one slow link or site can't hold every upstream read", () => {
  test("eight leases of one link reading a slow site leave room for another link", async () => {
    const leases = [...Array.from({ length: 8 }, (_, index) => lease({ label: label(index), leaseId: `evil-${index}`, linkId: "evil-link", origin: "http://slow.example", assetOrigins: [] })), lease({ label: label(20), leaseId: "victim", linkId: "victim-link", origin: "http://victim.example", assetOrigins: [] })];
    const { proxy } = setup({ leases });
    const held = new AbortController();
    const reads: Promise<Response>[] = [];
    for (let index = 0; index < 8; index++) for (let file = 0; file < 8; file++) reads.push(ask(proxy, `/s${file}.js`, { host: `${label(index)}.${DOMAIN}`, dest: "script", signal: held.signal }));
    await Promise.allSettled(reads);
    try {
      expect(proxy.inFlight).toBeLessThanOrEqual(DEFAULT_LIMITS.concurrentPerProcess - DEFAULT_LIMITS.concurrentPerLease);
      const victim = await ask(proxy, "/", { host: `${label(20)}.${DOMAIN}` });
      expect(victim.status).toBe(200);
      await victim.text();
    } finally {
      held.abort();
      for (const read of reads) void read.then((response) => response.body?.cancel()).catch(() => undefined);
    }
  });
  test("one link reading slowly from several sites holds at most its link's share", async () => {
    const slots = [2, 3, 4, 5].map((index) => ({ slot: index - 1, origin: `http://slow${index}.example` }));
    const leases = [...Array.from({ length: 8 }, (_, index) => lease({ label: label(index), leaseId: `evil-${index}`, linkId: "evil-link", origin: "http://slow.example", assetOrigins: slots })), lease({ label: label(20), leaseId: "victim", linkId: "victim-link", origin: "http://victim.example", assetOrigins: [] })];
    const { proxy } = setup({ leases });
    const held = new AbortController();
    const reads: Promise<Response>[] = [];
    for (let index = 0; index < 8; index++) {
      for (let file = 0; file < 8; file++) {
        const path = file % 5 === 0 ? `/s${file}.js` : `/__critiqs/o/${file % 5}/s${file}.js`;
        reads.push(ask(proxy, path, { host: `${label(index)}.${DOMAIN}`, dest: file % 5 === 0 ? "script" : "empty", signal: held.signal }));
      }
    }
    await Promise.allSettled(reads);
    try {
      expect(proxy.inFlight).toBeLessThanOrEqual(DEFAULT_LIMITS.concurrentPerLink);
      const victim = await ask(proxy, "/", { host: `${label(20)}.${DOMAIN}` });
      expect(victim.status).toBe(200);
      await victim.text();
    } finally {
      held.abort();
      for (const read of reads) void read.then((response) => response.body?.cancel()).catch(() => undefined);
    }
  });
  test("several links to one slow site share that site's room", async () => {
    const leases = Array.from({ length: 8 }, (_, index) => lease({ label: label(index), leaseId: `l-${index}`, linkId: `link-${index}`, origin: "http://slow.example", assetOrigins: [] }));
    const { proxy } = setup({ leases });
    const held = new AbortController();
    const reads: Promise<Response>[] = [];
    for (let index = 0; index < 8; index++) for (let file = 0; file < 8; file++) reads.push(ask(proxy, `/s${file}.js`, { host: `${label(index)}.${DOMAIN}`, dest: "script", signal: held.signal }));
    await Promise.allSettled(reads);
    try {
      expect(proxy.inFlight).toBeLessThan(DEFAULT_LIMITS.concurrentPerProcess / 2);
    } finally {
      held.abort();
      for (const read of reads) void read.then((response) => response.body?.cancel()).catch(() => undefined);
    }
  });
});

describe("Opus N4: unknown frame hosts are bounded per client before the backend", () => {
  test("a client asking for random hosts stops reaching the directory", async () => {
    const { proxy, lookups } = setup();
    for (let index = 0; index < 200; index++) {
      const random = `v-${Array.from({ length: 26 }, () => "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(Math.random() * 32)]).join("")}`;
      expect((await ask(proxy, "/", { host: `${random}.${DOMAIN}` })).status).toBe(404);
    }
    expect(lookups()).toBeLessThanOrEqual(100);
    // Another client is unaffected, and a real lease still opens for it.
    expect((await ask(proxy, "/", { client: "198.51.100.9" })).status).toBe(200);
  });
});

describe("Opus N9: the rewritten page's size is capped", () => {
  test("a page that grows past htmlOutputBytes when rewritten gets the too-large notice", async () => {
    const small = { ...config, limits: { ...DEFAULT_LIMITS, htmlOutputBytes: 64 * 1024 } };
    const { proxy } = setup({ config: small });
    const response = await ask(proxy, "/many-links");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("too large");
  });
});

describe("Gemini note 9: third-party @import chains stop at depth 2", () => {
  test("a chain of imported stylesheets stops being signed after two hops", async () => {
    const { proxy } = setup();
    let path = assetPath(CTX, "style", new URL("http://cdn.example.net/0.css"))!;
    let hops = 0;
    for (; hops < 6; hops++) {
      const css = await (await ask(proxy, path, { dest: "style" })).text();
      const next = /url\("?(\/__critiqs\/a\/[^")]+)"?\)/.exec(css)?.[1];
      if (next === undefined) break;
      path = next;
    }
    expect(hops).toBeLessThanOrEqual(2);
  });
  test("a page's own stylesheet still imports another site's", () => {
    expect(rewriteCss(CTX, '@import url("http://cdn.example.net/a.css");', BASE)).toContain("/__critiqs/a/");
  });
});

describe("Gemini note 11: every SVG link attribute is mapped", () => {
  test("href and xlink:href on one element", () => {
    const html = rewriteHtml(CTX, '<svg><image href="http://cdn.example.net/a.png" xlink:href="http://169.254.169.254/latest"></image></svg>', BASE, { runtime: "r.js", layer: "l.js", panelOrigins: [], finalPath: null });
    expect(html).not.toContain('href="http://');
    expect([...html.matchAll(/href="\/__critiqs\/a\//g)].length).toBe(2);
  });
});

describe("smaller notes", () => {
  test("Gemini, Next.js headers: a protocol-relative next-url never passes", async () => {
    const { frameworkHeaders } = await import("../src/headers.ts");
    expect(frameworkHeaders(new Headers({ "next-url": "//evil.example/x" }))).toEqual({});
    expect(frameworkHeaders(new Headers({ "next-url": "/blog" }))).toEqual({ "next-url": "/blog" });
    for (const name of ["x-middleware-subrequest", "x-invoke-path", "x-nextjs-data", "x-forwarded-host", "next-action"]) expect(frameworkHeaders(new Headers({ [name]: "1" }))).toEqual({});
  });
  test("Opus: a top-level open spelled Document still gets the notice", async () => {
    const { proxy, lookups } = setup();
    const response = await ask(proxy, "/", { dest: "Document" });
    expect(response.status).toBe(403);
    expect(lookups()).toBe(0);
  });
});

describe("Opus N2: no developer error page on any method or malformed request", () => {
  const serve = async () => {
    const port = 6460 + Math.floor(Math.random() * 20);
    const child = Bun.spawn(["bun", "--max-http-header-size=65536", "bin/serve.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        PORT: String(port),
        CRITIQS_PROXY_DOMAIN: `http://review.localhost:${port}`,
        CRITIQS_WEB_ORIGINS: "http://web.localhost:6499",
        CRITIQS_PROXY_BACKEND: "http://127.0.0.1:6498",
        CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
        CRITIQS_PROXY_DEV_LEASES: "[]",
        NODE_ENV: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const started = Date.now();
    let out = "";
    while (!out.includes("Review proxy for") && Date.now() - started < 15_000) out += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    return { port, child };
  };
  const raw = (port: number, text: string) =>
    new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
      let reply = "";
      socket.on("data", (chunk) => (reply += chunk));
      socket.on("close", () => resolve(reply));
      socket.on("error", () => resolve(reply));
      setTimeout(() => socket.destroy(), 3_000);
    });
  test("CONNECT, an absolute target, and a malformed path", async () => {
    const { port, child } = await serve();
    try {
      for (const request of [
        "CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n",
        `GET http://evil.example/ HTTP/1.1\r\nHost: ${LABEL}.review.localhost:${port}\r\nConnection: close\r\n\r\n`,
        `GET /%%% HTTP/1.1\r\nHost: ${LABEL}.review.localhost:${port}\r\nConnection: close\r\n\r\n`,
        "TRACE / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      ]) {
        const reply = await raw(port, request);
        expect(reply).not.toContain("cwd");
        expect(reply).not.toContain("stack");
        expect(reply).not.toContain(process.cwd());
        expect(reply.length).toBeLessThan(2_000);
      }
    } finally {
      child.kill();
    }
  }, 30_000);
});
