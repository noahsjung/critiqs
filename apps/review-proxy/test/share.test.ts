import { describe, expect, test } from "bun:test";
import { REVIEW_REFUSED_TIMING } from "@critiqs/core";
import { BUILD_TYPES } from "@critiqs/server/review-builds";
import type { BuildSource } from "../src/build-source.ts";
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

function setup(build: { spa?: boolean; files?: Record<string, string | Uint8Array<ArrayBuffer>>; builds?: BuildSource; config?: typeof config } = {}) {
  const directory = memoryDirectory([
    { label: LABEL, linkId: "link-share", leaseId: "lease-share", origin: ORIGIN, assetOrigins: [], expiresAt: Date.now() + 600_000, build: { spa: build.spa ?? false, files: build.files ?? FILES } },
  ]);
  const egress = { primary: trap(), asset: trap() };
  const proxy = createReviewProxy(build.config ?? config, { directory, egress, builds: build.builds, assets: { runtime: { file: "runtime.0123456789abcdef.js", body: "/* runtime */" }, layer: { file: "layer.0123456789abcdef.js", body: "/* layer */" } } });
  return { proxy, directory, egress };
}

const ask = (proxy: ReturnType<typeof setup>["proxy"], path: string, init: RequestInit & { dest?: string | null; host?: string; client?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.dest !== null) headers.set("sec-fetch-dest", init.dest ?? "iframe");
  const host = init.host ?? HOST;
  headers.set("host", host);
  return proxy.fetch(new Request(`http://${host}${path}`, { ...init, headers }), { client: init.client ?? "" });
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

/** What the frame's sandbox and the browser make of a file served to a navigation: it can't be a page unless it is the proxy's own rewritten one. */
function cannotBeAPage(response: Response) {
  return {
    type: response.headers.get("content-type"),
    attachment: response.headers.get("content-disposition"),
    nosniff: response.headers.get("x-content-type-options"),
    sandboxed: /\bsandbox\b/.test(response.headers.get("content-security-policy") ?? ""),
  };
}

describe("a shared build is served by the proxy's response rules", () => {
  test("every file type a static build carries loads as its own type, as a file a navigation can't open as a page", async () => {
    const files: Record<string, string> = {};
    for (const extension of Object.keys(BUILD_TYPES)) files[`f.${extension}`] = `file ${extension}`;
    const { proxy } = setup({ files });
    const dests: Record<string, string> = { html: "iframe", htm: "iframe", css: "style", js: "script", mjs: "script", json: "empty", webmanifest: "manifest", woff: "font", woff2: "font", ttf: "font", otf: "font", wasm: "empty", mp4: "video", webm: "video", mp3: "audio", txt: "empty", xml: "empty" };
    for (const [extension, type] of Object.entries(BUILD_TYPES)) {
      const response = await ask(proxy, `/f.${extension}`, { dest: dests[extension] ?? "image" });
      const body = await response.text();
      expect([extension, response.status, response.headers.get("x-content-type-options")]).toEqual([extension, 200, "nosniff"]);
      if (extension === "html" || extension === "htm") {
        // A page: the proxy's own, with the page layer and the frame's policy.
        expect([extension, response.headers.get("content-type"), response.headers.get("content-disposition"), body.startsWith("<html><head><script src=\"/__critiqs/runtime.")]).toEqual([extension, "text/html; charset=utf-8", null, true]);
        continue;
      }
      // Only the type the backend gave, exactly; the bytes as uploaded; a download if the frame navigates to it.
      expect([extension, response.headers.get("content-type"), body, response.headers.get("content-disposition"), response.headers.get("content-length")]).toEqual([extension, type.replace(/; charset=utf-8$/, "; charset=utf-8"), `file ${extension}`, "attachment", String(`file ${extension}`.length)]);
      expect([extension, cannotBeAPage(response).sandboxed]).toEqual([extension, true]);
    }
  });

  test("an uploaded file that reads as HTML, by its content, its extension or a stray type, is never served as a page unrewritten", async () => {
    const script = "<script>fetch('/ran')</script>";
    const { proxy } = setup({
      files: {
        "index.html": "<!doctype html><h1>Built</h1>",
        "evil.svg": `<svg xmlns="http://www.w3.org/2000/svg">${script.replace("<script>", '<script type="text/javascript">')}</svg>`,
        "evil.xml": `<html xmlns="http://www.w3.org/1999/xhtml"><body>${script}</body></html>`,
        "evil.txt": `<!doctype html><body>${script}</body>`,
        "evil.json": `<!doctype html><body>${script}</body>`,
        "evil.webmanifest": `<!doctype html><body>${script}</body>`,
        "evil.js": `<!doctype html><body>${script}</body>`,
        "evil.png": `<!doctype html><body>${script}</body>`,
      },
    });
    for (const path of ["/evil.svg", "/evil.xml", "/evil.txt", "/evil.json", "/evil.webmanifest", "/evil.js", "/evil.png"]) {
      for (const dest of ["iframe", "document", "empty", "image"]) {
        const response = await ask(proxy, path, { dest });
        if (dest === "document") {
          // Opened on its own, a frame host is a notice, never a file.
          expect([path, response.status]).toEqual([path, 403]);
          continue;
        }
        const seen = cannotBeAPage(response);
        expect([path, dest, seen.type?.startsWith("text/html") ?? false, seen.attachment, seen.nosniff, seen.sandboxed]).toEqual([path, dest, false, "attachment", "nosniff", true]);
      }
    }
  });

  test("a type the backend gives is read as a browser reads it: the type that wins decides, and only it is sent", async () => {
    const body = new TextEncoder().encode("<!doctype html><h1>Built</h1>");
    const typeOf: Record<string, string> = {
      "/a": "image/svg+xml, text/html",
      "/b": 'text/plain; x="a,text/html"',
      "/c": "TEXT/HTML; charset=utf-8, application/xml",
      "/d": "",
      "/e": "nonsense",
    };
    const builds: BuildSource = { file: async (_label, path) => ({ status: 200, contentType: typeOf[path]!, sha256: "0".repeat(64), body }) };
    const { proxy } = setup({ builds });
    // The last valid type wins (text/html): the proxy's page, with the page layer.
    const a = await ask(proxy, "/a");
    expect([a.headers.get("content-type"), (await a.text()).includes("/__critiqs/runtime.")]).toEqual(["text/html; charset=utf-8", true]);
    // A quoted comma is part of a parameter, not a second type: plain text, as a file.
    const b = await ask(proxy, "/b");
    expect([b.headers.get("content-type"), b.headers.get("content-disposition")]).toEqual(["text/plain", "attachment"]);
    // XML wins over HTML here, so it is a file, never a page.
    const c = await ask(proxy, "/c");
    expect([c.headers.get("content-type"), c.headers.get("content-disposition"), c.headers.get("x-content-type-options")]).toEqual(["application/xml", "attachment", "nosniff"]);
    // No type, or one that isn't a type: nothing claimed, and still a file that can't be sniffed into a page.
    for (const path of ["/d", "/e"]) {
      const response = await ask(proxy, path);
      expect([path, response.headers.get("content-type"), response.headers.get("content-disposition"), response.headers.get("x-content-type-options")]).toEqual([path, null, "attachment", "nosniff"]);
    }
  });
});

describe("a shared build within the proxy's limits", () => {
  test("its reads wait their turn in the same line as a live link's, at most a lease's share at once, and all load", async () => {
    let now = 0;
    let most = 0;
    const builds: BuildSource = {
      file: async () => {
        most = Math.max(most, ++now);
        await Bun.sleep(15);
        now--;
        return { status: 200, contentType: "image/png", sha256: "0".repeat(64), body: new Uint8Array(16) };
      },
    };
    const { proxy } = setup({ builds });
    const answers = await Promise.all(Array.from({ length: 40 }, (_, index) => ask(proxy, `/img-${index}.png`, { dest: "image" })));
    expect(answers.map((response) => response.status)).toEqual(new Array(40).fill(200));
    expect(most).toBe(config.limits.concurrentPerLease);
  });

  test("a refused file is marked as the proxy's refusal, so the review page can say part of the page didn't load", async () => {
    const tight = { ...config, limits: { ...config.limits, requestsPerWindow: 1, fileRequestsPerWindow: 2, prefetchRequestsPerWindow: 1 } };
    const { proxy } = setup({ config: tight });
    expect((await ask(proxy, "/")).status).toBe(200);
    expect((await ask(proxy, "/assets/app.js", { dest: "script" })).status).toBe(200);
    expect((await ask(proxy, "/assets/app.css", { dest: "style" })).status).toBe(200);
    const refused = await ask(proxy, "/assets/app.js", { dest: "script" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("server-timing")).toContain(REVIEW_REFUSED_TIMING);
    // A page past its budget is the proxy's notice saying when pages open again, not a bare refusal.
    const page = await ask(proxy, "/");
    expect([page.status, page.headers.get("content-type")]).toEqual([429, "text/html; charset=utf-8"]);
  });

  test("prefetches count apart, as a live link's do: a framework prefetching every route can't use up what the reviewer opens", async () => {
    const tight = { ...config, limits: { ...config.limits, prefetchRequestsPerWindow: 2 } };
    const { proxy } = setup({ config: tight });
    const prefetch = () => ask(proxy, "/about.html", { dest: "empty", headers: { "sec-purpose": "prefetch" } });
    expect([(await prefetch()).status, (await prefetch()).status]).toEqual([200, 200]);
    const third = await prefetch();
    expect(third.status).toBe(429);
    expect(third.headers.get("server-timing")).toContain(REVIEW_REFUSED_TIMING);
    expect((await ask(proxy, "/about")).status).toBe(200);
  });

  test("a browser that stops reading a shared file holds no read slot", async () => {
    const { proxy } = setup({ files: { "big.png": new Uint8Array(4 * 1024 * 1024) } });
    const unread = await Promise.all(Array.from({ length: 30 }, () => ask(proxy, "/big.png", { dest: "image" })));
    expect(unread.map((response) => response.status)).toEqual(new Array(30).fill(200));
    expect(proxy.inFlight).toBe(0);
  });

  test("its frame host is looked up within a client's misses, like any frame host; once seen live it keeps serving", async () => {
    const { proxy } = setup();
    const flooder = "198.51.100.7";
    for (let index = 0; index < config.limits.lookupMissesPerClient; index++) {
      const label = `v-${index.toString(32).padStart(26, "a").replace(/[^a-z2-7]/g, "a")}`;
      expect((await ask(proxy, "/", { host: `${label}.review.localhost:5120`, client: flooder })).status).toBe(404);
    }
    // Over its misses, a host this proxy hasn't seen live isn't asked about for that client.
    expect((await ask(proxy, "/", { client: flooder })).status).toBe(404);
    // Another viewer opens the build; from then on the flooded client's frames load too.
    expect((await ask(proxy, "/", { client: "203.0.113.9" })).status).toBe(200);
    expect((await ask(proxy, "/", { client: flooder })).status).toBe(200);
  });
});
