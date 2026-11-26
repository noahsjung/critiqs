// The proxy's live check in Chrome (H2). A fixture single-page app, a CDN and
// a font host run on local ports; the proxy runs in this process on
// `review.localhost`, reaching the fixtures through an injected test network
// (there is no setting that lets a deployed proxy reach local addresses). A
// review page on `web.localhost` frames a lease host with
// `sandbox="allow-scripts allow-same-origin"` and runs Critiqs's real panel
// against a SQLite backend. Chrome checks:
//
// - the page loads through the proxy with its third-party stylesheet, font and
//   image rewritten and fetched; single-page navigation and fetch work;
// - the page layer connects over windowTransport, a comment is picked,
//   written and saved with a DOM capture that covers the masked field;
// - AT-13: a third origin can't frame a lease host;
// - AT-14: frame-busting, popups, POST forms, static srcdoc frames and service
//   workers are blocked, each beside a positive control that shows the same
//   action working where the protection is absent;
// - AT-15: cookies planted on the shared parent domain reach the proxy but
//   never upstream, another lease's document doesn't see them, and 32 KiB of
//   them doesn't make the proxy refuse the request.
//
// Run with `bun --max-http-header-size=65536 scripts/check-proxy.ts` (as
// `bun run serve` does). CRITIQS_EVIDENCE_DIR keeps screenshots and a summary.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { createCritiqsHandler } from "../../../packages/server/src/http/index.ts";
import { chrome, playwright, scratch } from "../../../scripts/consumer-kit.ts";
import { parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { listen, testWeb, v4 } from "../test/fixtures.ts";
import { buildAssets } from "./build-assets.ts";

const PORTS = { web: 5110, stranger: 5112, proxy: 5120, shop: 5130, cdn: 5131, fonts: 5132 };
const WEB = `http://web.localhost:${PORTS.web}`;
const STRANGER = `http://stranger.localhost:${PORTS.stranger}`;
const DOMAIN = `http://review.localhost:${PORTS.proxy}`;
const base32 = (seed: string) => `v-${seed.repeat(26).slice(0, 26)}`;
const LEASE_1 = base32("lease2abc");
const LEASE_2 = base32("other7xyz");
const frameOrigin = (label: string) => `http://${label}.review.localhost:${PORTS.proxy}`;

const evidence = process.env.CRITIQS_EVIDENCE_DIR ?? "";
const here = fileURLToPath(new URL("./check-proxy/", import.meta.url));
const dir = await scratch("check-proxy");
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
const results: { check: string; result: "pass" | "fail"; value: string }[] = [];
const record = (check: string, value: string) => {
  results.push({ check, result: "pass", value });
  console.log(`pass  ${check}: ${value}`);
};

// ---------------------------------------------------------------------------
// Fixture sites

/** A solid-color PNG. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const FONT = ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);

const SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture shop</title>
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="http://fonts.fixture.test/css?family=Fixture">
</head><body>
<nav><a href="/" data-link>Home</a> · <a href="/products/42" data-link id="product-link">Product 42</a> · <a href="http://elsewhere.fixture.test/deals?ref=shop" id="elsewhere">Elsewhere</a></nav>
<main><h1 id="title">Loading</h1><p id="stock"></p><div class="hero"></div>
<img id="logo" src="http://cdn.fixture.test/logo.png" width="120" height="40" alt="Logo">
<p><input data-critiqs-mask value="sk-not-for-captures" aria-label="API key"></p>
<p><button data-critiqs-id="buy" id="buy">Buy now</button></p>
<form id="search" action="/search" method="get"><input name="q" value="shoes"><button id="search-btn">Search</button></form>
<form id="login" action="/login" method="post"><input name="user" value="dana"><input type="password" name="password" value="hunter2"><button id="login-btn">Sign in</button></form>
<iframe id="static-srcdoc" srcdoc="<p>srcdoc</p><script>parent.srcdocRan = true</script>" width="200" height="60"></iframe>
</main>
<script src="/app.js"></script></body></html>`;

const APP_JS = `
const titles = { "/": "Home", "/products/42": "Product 42", "/search": "Search" };
async function render() {
  document.querySelector("#title").textContent = titles[location.pathname] ?? location.pathname;
  if (location.pathname === "/products/42") {
    // An absolute address on the prototype's own origin, as apps build from config.
    const stock = await (await fetch("http://shop.fixture.test/api/stock/42")).json();
    document.querySelector("#stock").textContent = "In stock: " + stock.count;
  }
}
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link) return;
  event.preventDefault();
  history.pushState(null, "", link.getAttribute("href"));
  render();
});
addEventListener("popstate", render);
render();
`;

const seen: { host: string; path: string; method: string; userAgent: string; cookie: string | undefined }[] = [];
const fixture = (handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) =>
  http.createServer((request, response) => {
    seen.push({ host: request.headers.host ?? "", path: request.url ?? "", method: request.method ?? "", userAgent: request.headers["user-agent"] ?? "", cookie: request.headers.cookie });
    handler(request, response);
  });
const shop = fixture((request, response) => {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  if (path === "/app.css") {
    response.writeHead(200, { "Content-Type": "text/css" });
    return response.end(`body{font:16px Fixture,system-ui;margin:24px}.hero{width:240px;height:24px;background:url(http://cdn.fixture.test/hero.png)}`);
  }
  if (path === "/app.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return response.end(APP_JS);
  }
  if (path === "/sw.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return response.end("self.addEventListener('fetch', () => {});");
  }
  if (path.startsWith("/api/stock/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end('{"count":7}');
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "shop_session=1; Path=/", "X-Frame-Options": "DENY" });
  response.end(SHELL);
});
const cdn = fixture((request, response) => {
  const path = request.url ?? "/";
  if (path === "/logo.png" || path === "/hero.png") {
    response.writeHead(200, { "Content-Type": "image/png" });
    return response.end(png(path === "/logo.png" ? 120 : 240, path === "/logo.png" ? 40 : 24, path === "/logo.png" ? [14, 116, 144] : [250, 204, 21]));
  }
  response.writeHead(404);
  response.end();
});
const fonts = fixture((request, response) => {
  if ((request.url ?? "").startsWith("/css")) {
    response.writeHead(200, { "Content-Type": "text/css" });
    return response.end(`@font-face{font-family:'Fixture';src:url(http://fontfiles.fixture.test/fixture.ttf) format('truetype')}`);
  }
  if (request.url === "/fixture.ttf" && FONT !== undefined) {
    response.writeHead(200, { "Content-Type": "font/ttf" });
    return response.end(readFileSync(FONT));
  }
  response.writeHead(404);
  response.end();
});
await Promise.all([
  new Promise<void>((resolve) => shop.listen(PORTS.shop, "127.0.0.1", resolve)),
  new Promise<void>((resolve) => cdn.listen(PORTS.cdn, "127.0.0.1", resolve)),
  new Promise<void>((resolve) => fonts.listen(PORTS.fonts, "127.0.0.1", resolve)),
]);
void listen;

// ---------------------------------------------------------------------------
// The proxy, in this process

const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: DOMAIN,
  CRITIQS_WEB_ORIGINS: WEB,
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "check-proxy-secret-that-is-long-enough-to-pass",
});
const PUBLIC = { shop: "93.184.215.20", cdn: "93.184.215.21", fonts: "93.184.215.22" };
const web = testWeb(
  { "shop.fixture.test": [v4(PUBLIC.shop)], "cdn.fixture.test": [v4(PUBLIC.cdn)], "fonts.fixture.test": [v4(PUBLIC.fonts)], "fontfiles.fixture.test": [v4(PUBLIC.fonts)], "elsewhere.fixture.test": [v4(PUBLIC.cdn)] },
  { [PUBLIC.shop]: PORTS.shop, [PUBLIC.cdn]: PORTS.cdn, [PUBLIC.fonts]: PORTS.fonts },
);
const reputation = cachedReputation(fixtureReputation());
const policy = proxyPolicy(config);
const lease = (label: string, n: number) => ({ label, linkId: "link-1", leaseId: `lease-${n}`, origin: "http://shop.fixture.test", assetOrigins: [], expiresAt: Date.now() + 3_600_000 });
const proxy = createReviewProxy(config, {
  directory: memoryDirectory([lease(LEASE_1, 1), lease(LEASE_2, 2)]),
  egress: {
    primary: createEgress({ web, policy, reputation, userAgent: config.userAgent, limits: config.limits }),
    asset: createEgress({ web, policy, reputation, userAgent: config.assetUserAgent, limits: config.limits }),
  },
  assets: await buildAssets(),
});
const proxied: { host: string; path: string; method: string; dest: string | null; cookieBytes: number; status: number; serviceWorker: boolean }[] = [];
const proxyServer = Bun.serve({
  port: PORTS.proxy,
  hostname: "127.0.0.1",
  async fetch(request) {
    const response = await proxy.fetch(request);
    const url = new URL(request.url);
    proxied.push({
      host: request.headers.get("host") ?? "",
      path: `${url.pathname}${url.search}`,
      method: request.method,
      dest: request.headers.get("sec-fetch-dest"),
      cookieBytes: (request.headers.get("cookie") ?? "").length,
      status: response.status,
      serviceWorker: request.headers.has("service-worker"),
    });
    return response;
  },
});

// ---------------------------------------------------------------------------
// The review page, with the real panel and a SQLite backend

const buildPanel = await Bun.build({
  entrypoints: [join(here, "panel.ts")],
  target: "browser",
  format: "iife",
  jsx: { runtime: "automatic", development: false },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!buildPanel.success) throw new AggregateError(buildPanel.logs, "The panel didn't build.");
const panelScript = await buildPanel.outputs[0]!.text();
const critiqs = await createCritiqsHandler({ database: join(dir, "critiqs.sqlite"), identify: () => ({ id: "dana", name: "Dana Reviewer", email: "dana@example.com" }) });
const created = await critiqs.fetch(
  new Request(`${WEB}/critiqs/api/createProject`, { method: "POST", headers: { "X-Critiqs-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Fixture shop" }) }),
);
const projectId = ((await created.json()) as { value: string }).value;

const webServer = Bun.serve({
  port: PORTS.web,
  hostname: "127.0.0.1",
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/critiqs" || url.pathname.startsWith("/critiqs/")) return critiqs.fetch(request, { remoteAddress: server.requestIP(request)?.address });
    if (url.pathname === "/panel.js") return new Response(panelScript, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/busted") return new Response("<h1>busted</h1>", { headers: { "content-type": "text/html" } });
    const label = url.searchParams.get("lease") ?? LEASE_1;
    // `?control` frames the same lease without the sandbox: the positive control for what the sandbox blocks.
    const sandbox = url.searchParams.has("control") ? "" : ' sandbox="allow-scripts allow-same-origin"';
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Review</title><style>body{margin:0;background:#f4f4f5}#prototype{position:fixed;left:0;top:0;width:calc(100% - 360px);height:100%;border:0;background:#fff}</style></head>
<body><iframe id="prototype" title="Prototype"${sandbox} src="${frameOrigin(label)}/"></iframe><script src="/panel.js" data-project-id="${projectId}"></script></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const strangerServer = Bun.serve({
  port: PORTS.stranger,
  hostname: "127.0.0.1",
  fetch: () => new Response(`<!doctype html><html><body><iframe id="prototype" src="${frameOrigin(LEASE_1)}/" style="width:800px;height:600px"></iframe></body></html>`, { headers: { "content-type": "text/html" } }),
});

// ---------------------------------------------------------------------------
// Chrome

type Frame = {
  url(): string;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  waitForFunction<A>(fn: (arg: A) => boolean, arg?: A, options?: { timeout: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
};
type Page = {
  goto(url: string): Promise<unknown>;
  url(): string;
  frames(): Frame[];
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  waitForFunction<A>(fn: (arg: A) => boolean, arg?: A, options?: { timeout: number }): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  on(event: string, listener: (value: { text(): string } & Error) => void): void;
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void> };
  locator(selector: string): { click(): Promise<void>; pressSequentially(text: string): Promise<void> };
  close(): Promise<void>;
};
type Context = { newPage(): Promise<Page>; pages(): Page[]; addCookies(cookies: object[]): Promise<void>; close(): Promise<void> };

const shots: string[] = [];
async function shot(page: Page, name: string) {
  if (evidence === "") return;
  await mkdir(evidence, { recursive: true });
  const path = join(evidence, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
}
const inPanel = <T, A = undefined>(page: Page, fn: (root: ShadowRoot, arg: A) => T, arg?: A) =>
  page.evaluate(([source, value]) => new Function("root", "arg", `return (${source})(root, arg)`)(document.querySelector("critiqs-root")!.shadowRoot, value) as T, [fn.toString(), arg] as const);
const frameOf = (page: Page, label: string) => page.frames().find((frame) => frame.url().startsWith(frameOrigin(label)))!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openReview(context: Context, query = "") {
  const page = await context.newPage();
  await page.goto(`${WEB}/${query}`);
  await page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null, undefined, { timeout: 30_000 });
  return page;
}

const { chromium } = await playwright();
const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
const errors: string[] = [];
try {
  const context: Context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // --- The walk: load, assets, single-page navigation, a comment with a capture.
  const page = await openReview(context);
  page.on("pageerror", (error) => errors.push(String(error)));
  let frame = frameOf(page, LEASE_1);
  await frame.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".layer") != null, undefined, { timeout: 30_000 });
  await frame.waitForFunction(() => document.querySelector("#title")?.textContent === "Home", undefined, { timeout: 10_000 });
  const loaded = await frame.evaluate(async () => {
    await document.fonts.ready;
    const logo = document.querySelector<HTMLImageElement>("#logo")!;
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    return {
      logo: logo.complete ? logo.naturalWidth : 0,
      logoSrc: logo.getAttribute("src"),
      hero: resources.some((name) => name.includes("/image/http/cdn.fixture.test/hero.png")),
      fontLoaded: document.fonts.check("16px Fixture"),
      fontRequested: resources.some((name) => name.includes("/font/http/fontfiles.fixture.test/fixture.ttf")),
      sandboxed: (() => {
        try {
          return window.top!.location.href === undefined ? "readable" : "readable";
        } catch {
          return "cross-origin";
        }
      })(),
      cookie: document.cookie,
    };
  });
  assert.equal(loaded.logo, 120, "the third-party logo loads through a signed asset path");
  assert.match(loaded.logoSrc ?? "", /^\/__critiqs\/a\/[^/]+\/image\/http\/cdn\.fixture\.test\/logo\.png$/);
  assert.ok(loaded.hero, "the stylesheet's third-party background loads");
  assert.ok(loaded.fontRequested, "the third-party stylesheet's font is requested through a signed path");
  if (FONT !== undefined) assert.ok(loaded.fontLoaded, "the third-party font loads");
  record("Page through the proxy", `logo ${loaded.logo}px wide via ${loaded.logoSrc!.slice(0, 32)}…; CSS background and ${FONT === undefined ? "font request" : "font"} through signed paths; X-Frame-Options: DENY upstream didn't stop the frame`);
  const userAgents = new Map<string, Set<string>>();
  for (const request of seen) userAgents.set(request.host.split(":")[0]!, (userAgents.get(request.host.split(":")[0]!) ?? new Set()).add(request.userAgent));
  assert.deepEqual([...userAgents.get("shop.fixture.test")!], [config.userAgent]);
  for (const host of ["cdn.fixture.test", "fonts.fixture.test", "fontfiles.fixture.test"]) assert.deepEqual([...userAgents.get(host)!], ["Critiqs-Asset/1"], `${host} sees only the asset user agent`);
  record("AT-10 in Chrome", `prototype saw "${config.userAgent}"; cdn, fonts and font files saw only "Critiqs-Asset/1"`);
  await shot(page, "h2-1-loaded");

  // Single-page navigation, with a fetch to the prototype's absolute address.
  const documentsBefore = proxied.filter((entry) => entry.dest === "iframe").length;
  await frame.click("#product-link");
  await frame.waitForFunction(() => document.querySelector("#stock")?.textContent === "In stock: 7", undefined, { timeout: 10_000 });
  const spa = await frame.evaluate(() => ({ path: location.pathname, title: document.querySelector("#title")!.textContent }));
  assert.deepEqual(spa, { path: "/products/42", title: "Product 42" });
  assert.equal(proxied.filter((entry) => entry.dest === "iframe").length, documentsBefore, "the router navigated without loading a page");
  assert.ok(proxied.some((entry) => entry.path === "/api/stock/42" && entry.status === 200), "the absolute fetch went through the frame host");
  record("Single-page navigation", "pushState to /products/42 without a page load; fetch of http://shop.fixture.test/api/stock/42 answered through the frame host");
  await shot(page, "h2-2-spa-navigation");

  // A comment: Comment mode, pick, write, save, pin, and the capture.
  await inPanel(page, (root) => root.querySelector<HTMLButtonElement>('[aria-label="Comment mode"]')!.click());
  await frame.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".mode-hint") !== null, undefined, { timeout: 10_000 });
  const box = await frame.evaluate(() => {
    const { x, y, width, height } = document.querySelector("#buy")!.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.mouse.move(box.x - 30, box.y + 60, { steps: 2 });
    await page.mouse.move(box.x, box.y, { steps: 4 });
    if (await frame.evaluate(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".target-box") !== null)) break;
    await sleep(100);
  }
  await shot(page, "h2-3-picking");
  await frame.click("#buy");
  await page.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".tag-field") !== null, undefined, { timeout: 10_000 });
  const composer = page.locator(".tag-field");
  await composer.click();
  await composer.pressSequentially("Make Buy now stand out");
  await inPanel(page, (root) => [...root.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((button) => button.textContent === "Comment")!.click());
  await frame.waitForFunction(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin") !== null, undefined, { timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".thread-window img") as HTMLImageElement | null)?.complete === true, undefined, { timeout: 20_000 });
  const maskBox = await frame.evaluate(() => {
    const { x, y, width, height } = document.querySelector("input[data-critiqs-mask]")!.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2, viewport: window.innerWidth, logoX: document.querySelector("#logo")!.getBoundingClientRect().x + 10, logoY: document.querySelector("#logo")!.getBoundingClientRect().y + 10 };
  });
  const pixels = await inPanel(
    page,
    (root, at: { x: number; y: number; viewport: number; logoX: number; logoY: number }) => {
      const image = root.querySelector(".thread-window img") as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const drawing = canvas.getContext("2d")!;
      drawing.drawImage(image, 0, 0);
      const scale = image.naturalWidth / at.viewport;
      const pixel = (x: number, y: number) => [...drawing.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
      return { width: image.naturalWidth, mask: pixel(at.x, at.y), logo: pixel(at.logoX, at.logoY) };
    },
    maskBox,
  );
  assert.deepEqual(pixels.mask, [107, 114, 128], "the capture covers the masked field");
  assert.deepEqual(pixels.logo, [14, 116, 144], "the capture includes the third-party logo, untainted");
  record("Comment with a DOM capture", `capture ${pixels.width}px wide; masked field covered (rgb ${pixels.mask.join(",")}); third-party logo drawn (rgb ${pixels.logo.join(",")})`);
  await shot(page, "h2-4-comment-saved");
  await inPanel(page, (root) => root.querySelector<HTMLButtonElement>('.thread-window [aria-label="Close comment"]')?.click());
  await inPanel(page, (root) => root.querySelector<HTMLButtonElement>('[aria-label="Browse mode"]')?.click());

  // --- AT-14 in the sandboxed review frame, with positive controls in an unsandboxed frame of the same lease.
  const srcdoc = await frame.evaluate(() => ({ ran: (window as { srcdocRan?: boolean }).srcdocRan === true, frames: document.querySelectorAll("iframe").length, placeholders: document.querySelectorAll("[data-critiqs-embed]").length }));
  assert.deepEqual(srcdoc, { ran: false, frames: 0, placeholders: 1 });

  const bust = await frame.evaluate(() => {
    try {
      window.top!.location.href = "http://web.localhost:5110/busted";
      return "no error";
    } catch (error) {
      return (error as Error).name;
    }
  });
  await sleep(500);
  assert.equal(page.url(), `${WEB}/`, "frame-busting didn't move the review page");

  const pagesBefore = context.pages().length;
  const popup = await frame.evaluate(() => {
    // The shim's window.open, and the browser's own from a fresh realm.
    const helper = document.createElement("iframe");
    document.body.append(helper);
    const native = helper.contentWindow!.open.call(window, "http://web.localhost:5110/busted");
    return { shim: window.open("http://web.localhost:5110/busted") === null, native: native === null };
  });
  await sleep(500);
  assert.equal(context.pages().length, pagesBefore, "no popup opened");
  assert.deepEqual(popup, { shim: true, native: true });

  const postsBefore = proxied.filter((entry) => entry.method === "POST").length;
  await frame.click("#login-btn");
  await page.waitForFunction(() => ((window as { frameMessages?: { kind: string; feature?: string }[] }).frameMessages ?? []).some((message) => message.kind === "unsupported" && message.feature === "password"), undefined, { timeout: 5_000 });
  await frame.evaluate(() => {
    const helper = document.createElement("iframe");
    document.body.append(helper);
    (helper.contentWindow as unknown as { HTMLFormElement: typeof HTMLFormElement }).HTMLFormElement.prototype.submit.call(document.querySelector<HTMLFormElement>("#login")!);
  });
  await sleep(800);
  assert.equal(proxied.filter((entry) => entry.method === "POST").length, postsBefore, "the POST form never submitted");
  assert.ok(!seen.some((request) => request.method === "POST"), "no POST reached the prototype");

  const worker = await frame.evaluate(async () => {
    const shim = await navigator.serviceWorker.register("/sw.js").then(
      () => "registered",
      () => "refused",
    );
    const native = await ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/sw.js").then(
      () => "registered",
      () => "refused",
    );
    return { shim, native };
  });
  assert.deepEqual(worker, { shim: "refused", native: "refused" });
  const workerScripts = proxied.filter((entry) => entry.serviceWorker);
  assert.ok(workerScripts.every((entry) => entry.status === 403), "a service worker script request is refused");

  // A GET search form is followed as a link.
  await frame.click("#search-btn");
  await page.waitForFunction((origin) => [...document.querySelectorAll("iframe")].some((element) => element.src.startsWith(origin)), frameOrigin(LEASE_1));
  await sleep(300);
  frame = frameOf(page, LEASE_1);
  await frame.waitForFunction(() => document.querySelector("#title")?.textContent === "Search", undefined, { timeout: 10_000 });
  const searched = await frame.evaluate(() => `${location.pathname}${location.search}`);
  assert.equal(searched, "/search?q=shoes");

  // A link to another site shows the leave notice and tells the review page.
  await frame.click("#elsewhere");
  await page.waitForFunction(() => ((window as { frameMessages?: { kind: string }[] }).frameMessages ?? []).some((message) => message.kind === "left"), undefined, { timeout: 10_000 });
  frame = frameOf(page, LEASE_1);
  const leave = await frame.evaluate(() => document.body.textContent ?? "");
  assert.match(leave, /linked to elsewhere\.fixture\.test/);
  assert.ok(!seen.some((request) => request.host.startsWith("elsewhere.fixture.test")), "the other site was never fetched");
  const messages = await page.evaluate(() => (window as { frameMessages?: unknown[] }).frameMessages);
  await shot(page, "h2-5-left-notice");

  // Positive controls: the same lease framed without the sandbox.
  const control = await openReview(context, "?control");
  const controlFrame = frameOf(control, LEASE_1);
  await controlFrame.waitForFunction(() => document.querySelector("#title")?.textContent === "Home", undefined, { timeout: 10_000 });
  const controlPages = context.pages().length;
  await controlFrame.evaluate(() => {
    const helper = document.createElement("iframe");
    document.body.append(helper);
    helper.contentWindow!.open.call(window, "http://web.localhost:5110/busted");
  });
  await sleep(800);
  const controlPopup = context.pages().length > controlPages;
  const control2 = await openReview(context, "?control");
  const bustFrame = frameOf(control2, LEASE_1);
  await bustFrame.waitForFunction(() => document.querySelector("#title")?.textContent === "Home", undefined, { timeout: 10_000 });
  await bustFrame.evaluate(() => {
    window.top!.location.href = "http://web.localhost:5110/busted";
  });
  await control2.waitForFunction(() => location.pathname === "/busted", undefined, { timeout: 5_000 }).catch(() => undefined);
  const controlBust = control2.url().endsWith("/busted");
  // The raw prototype, opened straight from its local server: its srcdoc frame runs, and a service worker registers.
  const raw = await context.newPage();
  await raw.goto(`http://127.0.0.1:${PORTS.shop}/`);
  await raw.waitForFunction(() => (window as { srcdocRan?: boolean }).srcdocRan === true, undefined, { timeout: 5_000 }).catch(() => undefined);
  const rawSrcdoc = await raw.evaluate(() => (window as { srcdocRan?: boolean }).srcdocRan === true);
  const rawWorker = await raw.evaluate(() => navigator.serviceWorker.register("/sw.js").then(() => "registered", (error: Error) => `refused: ${error.message}`));
  // And its POST form submits: without the sandbox and the frame's form-action policy, the same click sends it.
  const assertPostFree = !seen.some((request) => request.method === "POST");
  assert.ok(assertPostFree, "no POST reached the prototype through the review frame");
  await raw.evaluate(() => document.querySelector<HTMLFormElement>("#login")!.submit());
  await sleep(800);
  const controlPost = seen.some((request) => request.method === "POST" && request.path === "/login");
  assert.ok(controlPopup && controlPost && controlBust && rawSrcdoc && rawWorker === "registered", `positive controls: popup ${controlPopup}, post ${controlPost}, bust ${controlBust}, srcdoc ${rawSrcdoc}, worker ${rawWorker}`);
  record(
    "AT-14 in Chrome",
    `review frame: top navigation threw ${bust}, popups null (shim and native), POST form never sent (password notice posted), static srcdoc replaced (0 frames), service worker refused (shim and native, script request 403); controls without the protection: popup opened from an unsandboxed frame, top navigated from one, and on the raw prototype the POST form submitted, srcdoc ran and a worker ${rawWorker}`,
  );
  record("GET form and leave notice", `search form followed to ${searched}; link to elsewhere.fixture.test showed the notice, never fetched; frame messages ${JSON.stringify(messages)}`);
  await raw.close();
  await control.close();
  await control2.close();

  // --- AT-13: a third origin can't frame a lease host.
  const stranger = await context.newPage();
  const consoleLines: string[] = [];
  stranger.on("console", (message) => consoleLines.push(message.text()));
  await stranger.goto(`${STRANGER}/`);
  await sleep(1_500);
  const strangerFrame = stranger.frames().find((candidate) => candidate !== stranger.frames()[0]);
  const strangerHasLayer = await strangerFrame
    ?.evaluate(() => document.querySelector("critiqs-root") !== null)
    .catch(() => false);
  const blockedLine = consoleLines.find((line) => /frame-ancestors/.test(line)) ?? "";
  assert.ok(strangerHasLayer !== true, "the third origin's frame shows no prototype");
  assert.match(blockedLine, /frame-ancestors/);
  record("AT-13 in Chrome", `third origin framing refused: "${blockedLine.slice(0, 140)}"; the review page's own origin framed it (walk above)`);
  await stranger.close();

  // --- AT-15: cookies planted on the shared parent domain.
  const tossContext: Context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tosser = await openReview(tossContext, `?lease=${LEASE_1}`);
  const tossFrame = frameOf(tosser, LEASE_1);
  await tossFrame.waitForFunction(() => document.querySelector("#title")?.textContent === "Home", undefined, { timeout: 10_000 });
  const tossed = await tossFrame.evaluate(() => {
    document.cookie = "shimmed=1; domain=review.localhost; path=/";
    // Around the shim, from a fresh realm: the browser's own cookie setter,
    // planting cookies a cross-site frame sends (SameSite=None, partitioned
    // under the review page), 32 KiB in all, on the parent domain.
    const helper = document.createElement("iframe");
    document.body.append(helper);
    const setter = Object.getOwnPropertyDescriptor((helper.contentWindow as unknown as { Document: typeof Document }).Document.prototype, "cookie")!.set!;
    for (let index = 0; index < 8; index++) setter.call(document, `toss${index}=${"z".repeat(4000)}; domain=review.localhost; path=/; SameSite=None; Secure; Partitioned`);
    const native = Object.getOwnPropertyDescriptor((helper.contentWindow as unknown as { Document: typeof Document }).Document.prototype, "cookie")!.get!;
    return { visible: document.cookie, real: native.call(document).length };
  });
  // The worst case beyond what a frame can plant (Chrome caps partitioned
  // cookies near 10 KB per site): 32 KiB more, unpartitioned, as a browser
  // that allows third-party cookies would send.
  await tossContext.addCookies(Array.from({ length: 8 }, (_, index) => ({ name: `wide${index}`, value: "w".repeat(4000), domain: ".review.localhost", path: "/", sameSite: "None", secure: true })));
  const shopRequestsBefore = seen.length;
  const victim = await openReview(tossContext, `?lease=${LEASE_2}`);
  const victimFrame = frameOf(victim, LEASE_2);
  await victimFrame.waitForFunction(() => document.querySelector("#title")?.textContent === "Home", undefined, { timeout: 15_000 });
  const victimCookie = await victimFrame.evaluate(() => document.cookie);
  const victimRequests = proxied.filter((entry) => entry.host.startsWith(LEASE_2));
  const largest = Math.max(...victimRequests.map((entry) => entry.cookieBytes));
  assert.ok(largest >= tossed.real, `the planted cookies reached the proxy (${largest} bytes): the positive control`);
  assert.ok(victimRequests.every((entry) => entry.status !== 431), "no request was refused for its headers");
  assert.equal(victimCookie, "", "the other lease's document sees no cookies");
  assert.ok(seen.slice(shopRequestsBefore).every((request) => request.cookie === undefined), "no cookie reached any upstream");
  // Every request that came through the proxy (the raw control page, opened directly on 127.0.0.1, keeps its own cookie).
  const throughProxy = seen.filter((request) => !request.host.startsWith("127.0.0.1"));
  assert.ok(throughProxy.every((request) => request.cookie === undefined), "no cookie ever reached any upstream through the proxy");
  record("AT-15 in Chrome", `a frame planted ${tossed.real} bytes of real cookies on review.localhost around the shim (the shim kept its own write: "${tossed.visible}"); with 32 KiB more added, Chrome sent lease 2's requests up to ${largest} bytes of Cookie; lease 2 loaded (${victimRequests.length} requests, none 431), its document.cookie empty, upstream saw no Cookie header on any of the ${throughProxy.length} requests made through the proxy`);
  await shot(victim, "h2-6-cookie-tossing-victim-loads");
  await tossContext.close();
  await context.close();
} catch (error) {
  results.push({ check: "check-proxy", result: "fail", value: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  proxyServer.stop(true);
  webServer.stop(true);
  strangerServer.stop(true);
  for (const server of [shop, cdn, fonts]) {
    server.closeAllConnections();
    server.close();
  }
  if (evidence !== "") {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "check-proxy.json"), JSON.stringify({ results, errors, shots, proxied: proxied.length, upstream: seen.length }, null, 2));
  }
}
if (errors.length > 0) console.log(`Page errors: ${errors.join("; ")}`);
if (process.exitCode !== 1) console.log("The review proxy check passed.");
