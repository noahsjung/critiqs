import { describe, expect, test } from "bun:test";
import { parseProxyConfig } from "../src/config.ts";
import { memoryDirectory } from "../src/directory.ts";
import type { Egress } from "../src/egress.ts";
import { createReviewProxy } from "../src/server.ts";
import { assetPath, leavePath } from "../src/urls.ts";

// A shared build through the proxy (`critiqs share`): its frame host passes
// every check a live link's does, then serves the build's own files from the
// backend, with the page layer put in its pages and nothing else changed.
// AT-29: no request on a shared build's frame host ever reaches the network.

const LABEL = `v-${"c".repeat(26)}`;
const HOST = `${LABEL}.review.localhost:5120`;
const ORIGIN = `https://b${"q".repeat(20)}.build.invalid`;
const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});

const INDEX = `<!doctype html><html><head><title>Acme build</title><link rel="stylesheet" href="/assets/app.css"><meta http-equiv="Content-Security-Policy" content="default-src *"></head>
<body><h1>Built</h1><img src="https://cdn.example.net/logo.png"><a href="https://elsewhere.example.net/x">out</a><script src="/assets/app.js"></script></body></html>`;
const FILES = {
  "index.html": INDEX,
  "about.html": "<!doctype html><h1>About</h1>",
  "assets/app.css": ".hero{background:url(https://cdn.example.net/hero.png)}",
  "assets/app.js": "document.title = 'ran'",
  "404.html": "<!doctype html><h1>Lost</h1>",
};

/** An egress that records every call and never answers: a shared build must never use one. */
function trap(): Egress & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(request) {
      calls.push(request.url.href);
      throw new Error("A shared build reached the network.");
    },
  } as Egress & { calls: string[] };
}

function setup(build: { spa?: boolean; files?: Record<string, string | Uint8Array<ArrayBuffer>> } = {}) {
  const directory = memoryDirectory([
    { label: LABEL, linkId: "link-share", leaseId: "lease-share", origin: ORIGIN, assetOrigins: [], expiresAt: Date.now() + 600_000, build: { spa: build.spa ?? false, files: build.files ?? FILES } },
  ]);
  const egress = { primary: trap(), asset: trap() };
  const proxy = createReviewProxy(config, { directory, egress, assets: { runtime: { file: "runtime.0123456789abcdef.js", body: "/* runtime */" }, layer: { file: "layer.0123456789abcdef.js", body: "/* layer */" } } });
  return { proxy, directory, egress };
}

const ask = (proxy: ReturnType<typeof setup>["proxy"], path: string, init: RequestInit & { dest?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.dest !== null) headers.set("sec-fetch-dest", init.dest ?? "iframe");
  headers.set("host", HOST);
  return proxy.fetch(new Request(`http://${HOST}${path}`, { ...init, headers }));
};

describe("a shared build through the proxy", () => {
  test("its pages get the page layer first in <head> and nothing else changes; the frame's policy still holds", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors http://web.localhost:5110");
    expect(csp).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toMatch(/^<!DOCTYPE html><html><head><script src="\/__critiqs\/runtime\.0123456789abcdef\.js" data-critiqs-map="[^"]*"><\/script><script src="\/__critiqs\/layer\.0123456789abcdef\.js" defer="" data-panel-origins="\[&quot;http:\/\/web\.localhost:5110&quot;\]" data-channel="review-link"><\/script><title>/);
    // The build's own addresses, other sites' addresses, and its markup are served as uploaded.
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css">');
    expect(html).toContain('<img src="https://cdn.example.net/logo.png">');
    expect(html).toContain('<a href="https://elsewhere.example.net/x">out</a>');
    expect(html).toContain('<script src="/assets/app.js"></script>');
    // The runtime knows the build's .build.invalid name only, never the lease or a key.
    expect(html).toContain(`&quot;primary&quot;:&quot;${ORIGIN}&quot;`);
  });

  test("its other files are served as uploaded, typed by the backend, inert as pages", async () => {
    const { proxy } = setup();
    const css = await ask(proxy, "/assets/app.css", { dest: "style" });
    expect([css.status, css.headers.get("content-type"), await css.text()]).toEqual([200, "text/css; charset=utf-8", FILES["assets/app.css"]]);
    expect(css.headers.get("content-security-policy")).toContain("frame-ancestors http://web.localhost:5110");
    const js = await ask(proxy, "/assets/app.js", { dest: "script" });
    expect([js.status, js.headers.get("content-type"), await js.text()]).toEqual([200, "text/javascript; charset=utf-8", FILES["assets/app.js"]]);
    // Clean addresses and the build's 404 page.
    expect(await (await ask(proxy, "/about")).text()).toContain("<h1>About</h1>");
    const lost = await ask(proxy, "/nowhere");
    expect([lost.status, (await lost.text()).includes("<h1>Lost</h1>")]).toEqual([404, true]);
    // HEAD carries no body.
    const head = await ask(proxy, "/assets/app.js", { method: "HEAD", dest: "script" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
  });

  test("AT-29: no request on a shared build's frame host opens a connection, even one the proxy signed for this lease", async () => {
    const { proxy, egress } = setup();
    const ctx = { primary: ORIGIN, slots: [], leaseId: "lease-share", secret: config.signingKey };
    const signed = assetPath(ctx, "image", new URL("https://cdn.example.net/logo.png"))!;
    const leave = leavePath(ctx, new URL("https://elsewhere.example.net/x"));
    for (const path of ["/", "/assets/app.css", "/assets/app.js", "/nowhere.js", signed, leave, "/__critiqs/o/1/x", "/%2F%2Fevil.example/x", "//evil.example/x"]) {
      const response = await ask(proxy, path, { dest: path === "/" ? "iframe" : "image" });
      if (path === signed || path === leave || path.startsWith("/__critiqs/o/")) expect([path, response.status]).toEqual([path, 404]);
    }
    expect([...egress.primary.calls, ...egress.asset.calls]).toEqual([]);
  });

  test("AT-29: with --spa a route is the app's index.html, and a missing file with an extension is still a 404", async () => {
    const { proxy } = setup({ spa: true, files: { "index.html": "<!doctype html><h1>App</h1>", "assets/app.js": "1" } });
    const route = await ask(proxy, "/products/42");
    expect([route.status, (await route.text()).includes("<h1>App</h1>")]).toEqual([200, true]);
    const asset = await ask(proxy, "/assets/missing.js", { dest: "script" });
    expect([asset.status, await asset.text()]).toEqual([404, ""]);
    const page = await ask(proxy, "/missing.html");
    expect(page.status).toBe(404);
  });

  test("AT-29: a deleted or expired build stops on the next request, even for a file the proxy holds", async () => {
    const { proxy, directory } = setup();
    expect((await ask(proxy, "/assets/app.js", { dest: "script" })).status).toBe(200);
    // The backend stops answering for the host, as it does once a build is deleted or expires.
    directory.paused.add("link-share");
    expect((await ask(proxy, "/assets/app.js", { dest: "script" })).status).toBe(404);
    expect((await ask(proxy, "/")).status).toBe(404);
  });

  test("the checks before serving still hold: top-level opens, writes, upgrades and service workers get nothing of the build", async () => {
    const { proxy, directory } = setup();
    const top = await ask(proxy, "/", { dest: "document" });
    expect([top.status, (await top.text()).includes("Built")]).toEqual([403, false]);
    expect((await ask(proxy, "/", { method: "POST", body: "x" })).status).toBe(405);
    expect((await ask(proxy, "/", { headers: { upgrade: "websocket" } })).status).toBe(403);
    expect((await ask(proxy, "/sw.js", { headers: { "service-worker": "script" } })).status).toBe(403);
    expect(directory.asked).toEqual([]);
  });

  test("a page that isn't UTF-8 gets the proxy's notice, not the bytes", async () => {
    const { proxy } = setup({ files: { "index.html": new Uint8Array([0xff, 0xfe, 0x3c, 0x00]) } });
    const response = await ask(proxy, "/");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).not.toContain("ÿ");
  });
});
