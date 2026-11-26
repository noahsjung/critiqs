import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { clientKey } from "../src/clients.ts";
import { DEFAULT_LIMITS, parseProxyConfig, type ProxyConfig, proxyPolicy } from "../src/config.ts";
import { memoryDirectory, type MemoryLease, type ReviewDirectory } from "../src/directory.ts";
import { createEgress } from "../src/egress.ts";
import { frameCsp } from "../src/pages.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { createReviewProxy } from "../src/server.ts";
import { budget } from "../src/limits.ts";
import { limitedByProxy, passedByProxy, staysInFrame } from "../runtime/shim.ts";
import { close, listen, PUBLIC_A, testWeb, v4 } from "./fixtures.ts";

// How the proxy treats the people it serves, each reproduced against the real
// handler and pinned connector:
//
// - every viewer is its own client, whatever form its address arrives in, and
//   only a header that carries a client's address can name it;
// - a backend that can't be reached isn't a frame host that serves nothing;
// - a slow reader keeps its download, and a file over the cap says so;
// - the request budgets refill, keep a page's files apart from its pages and
//   data, and say when they refill;
// - a freed read goes to whoever holds the fewest;
// - the frame's policy lets WebAssembly run and still refuses workers.

const label = (index: number) => `v-${"abcdefghijklmnopqrstuvwxyz234567"[index]!.repeat(26)}`;
const LABEL = label(0);
const randomLabel = () => `v-${Array.from({ length: 26 }, () => "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(Math.random() * 32)]).join("")}`;
const DOMAIN = "review.localhost:5120";
const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: `http://${DOMAIN}`,
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
});
const RUNTIME = "runtime.0123456789abcdef.js";
const MIB = 1024 * 1024;

const SIZED = Buffer.alloc(3 * MIB, 7);
const primary = http.createServer((request, response) => {
  const path = request.url ?? "/";
  if (path.startsWith("/img/")) {
    response.writeHead(200, { "Content-Type": "image/png" });
    return void response.end("png");
  }
  if (path === "/sized.bin") {
    // A file whose length is known before its body.
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(SIZED.byteLength) });
    return void response.end(SIZED);
  }
  if (path === "/unsized.bin") {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    return void response.end(SIZED);
  }
  if (path === "/trickle.js") {
    // A slow site: a byte every 200 ms, for as long as it is read.
    response.writeHead(200, { "Content-Type": "text/javascript" });
    const timer = setInterval(() => response.write("/"), 200);
    response.on("close", () => clearInterval(timer));
    return;
  }
  if (path === "/page.html" || path === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void response.end("<!doctype html><p>page</p>");
  }
  if (path === "/as-image.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void response.end("<!doctype html><p>a page asked for as an image</p>");
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end("{}");
});

let port = 0;
beforeAll(async () => {
  port = await listen(primary);
});
afterAll(async () => {
  await close(primary);
});

const lease = (overrides: Partial<MemoryLease> = {}): MemoryLease => ({
  label: LABEL,
  linkId: "link-1",
  leaseId: "lease-1",
  origin: "http://proto.example.com",
  assetOrigins: [],
  expiresAt: Date.now() + 3_600_000,
  ...overrides,
});

interface Setup {
  config?: ProxyConfig;
  leases?: MemoryLease[];
  now?: () => number;
}

function setup(options: Setup = {}) {
  const settings = options.config ?? config;
  const web = testWeb({ "proto.example.com": [v4(PUBLIC_A)] }, { [PUBLIC_A]: port });
  const reputation = cachedReputation(fixtureReputation());
  const policy = proxyPolicy(settings);
  const directory = memoryDirectory(options.leases ?? [lease()], options.now);
  /** While true, the backend can't be reached: every question fails. */
  let down = false;
  let lookups = 0;
  const reachable: ReviewDirectory = {
    ...directory,
    resolve: async (name: string, signal?: AbortSignal) => {
      lookups++;
      if (down) throw new Error("The backend can't be reached.");
      return await directory.resolve(name);
    },
  };
  const proxy = createReviewProxy(settings, {
    directory: reachable,
    egress: {
      primary: createEgress({ web, policy, reputation, userAgent: settings.userAgent, limits: settings.limits, reputationScope: "path" }),
      asset: createEgress({ web, policy, reputation, userAgent: settings.assetUserAgent, limits: settings.limits, reputationScope: "origin" }),
    },
    assets: { runtime: { file: RUNTIME, body: "/* runtime */" }, layer: { file: "layer.0123456789abcdef.js", body: "/* layer */" } },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    proxy,
    directory,
    lookups: () => lookups,
    outage: (value: boolean) => {
      down = value;
    },
  };
}

type Ask = RequestInit & { host?: string; dest?: string | null; client?: string };
const ask = (proxy: ReturnType<typeof setup>["proxy"], path: string, init: Ask = {}) => {
  const headers = new Headers(init.headers);
  if (init.dest !== null) headers.set("sec-fetch-dest", init.dest ?? "iframe");
  const host = init.host ?? `${LABEL}.${DOMAIN}`;
  headers.set("host", host);
  return proxy.fetch(new Request(`http://${host}${path}`, { ...init, headers }), { client: init.client ?? "203.0.113.7" });
};
const statusOf = async (response: Response | Promise<Response>) => {
  const answer = await response;
  await answer.arrayBuffer().catch(() => undefined);
  return answer.status;
};

describe("clientKey", () => {
  test("one address, however it is written, is one key", () => {
    for (const raw of ["198.51.100.1", "::ffff:198.51.100.1", "::FFFF:c633:6401", "0:0:0:0:0:ffff:198.51.100.1", "198.51.100.1:443", "[::ffff:198.51.100.1]:443", " 10.0.0.1, 198.51.100.1 "]) expect(clientKey(raw)).toBe("198.51.100.1");
    for (const raw of ["2001:db8:1:2::10", "2001:DB8:1:2:ffff::1", "[2001:db8:1:2::9]:8080", "2001:db8:1:2::10%eth0"]) expect(clientKey(raw)).toBe("2001:db8:1:2::/64");
  });
  test("two addresses are two keys", () => {
    expect(clientKey("::ffff:198.51.100.1")).not.toBe(clientKey("::ffff:198.51.100.2"));
    expect(clientKey("2001:db8:1:2::1")).not.toBe(clientKey("2001:db8:1:3::1"));
    // Only ::ffff:0:0/96 is IPv4: other addresses ending in four bytes are IPv6.
    expect(clientKey("64:ff9b::198.51.100.1")).toBe("64:ff9b:0:0::/64");
  });
  test("anything that isn't an address is no key", () => {
    for (const raw of ["", "unknown", "example.com", "198.51.100", "198.51.100.1.5", "::ffff:198.51.100.1:443", null, undefined]) expect(clientKey(raw)).toBeNull();
  });
});

describe("a request budget", () => {
  test("refills evenly, and says how long until there is room", () => {
    let time = 0;
    const counts = budget({ capacity: 10, windowMs: 10_000 }, () => time);
    for (let index = 0; index < 10; index++) expect(counts.take("a")).toBe(true);
    expect(counts.take("a")).toBe(false);
    expect(counts.take("b")).toBe(true);
    expect(counts.waitMs("a")).toBe(1_000);
    time += 1_000;
    expect(counts.take("a")).toBe(true);
    expect(counts.take("a")).toBe(false);
    time += 60_000;
    for (let index = 0; index < 10; index++) expect(counts.take("a")).toBe(true);
    expect(counts.take("a")).toBe(false);
  });
});

describe("the frame's runtime", () => {
  test("keeps a navigation to a blob: or data: document from loading in the frame", () => {
    const here = "http://v-aaaaaaaaaaaaaaaaaaaaaaaaaa.review.localhost:5120";
    expect(staysInFrame(new URL(`${here}/next`), here)).toBe(true);
    expect(staysInFrame(new URL(`blob:${here}/5d9c1b9e-6a6f-4a5e-9b8f-3c2e1d0f9a7b`), here)).toBe(false);
    expect(staysInFrame(new URL("data:text/html,<a href=//evil.example>x</a>"), here)).toBe(false);
    expect(staysInFrame(new URL("http://evil.example/"), here)).toBe(false);
  });
  test("tells a file held back by the budget, and a file passed on as a success, by their Server-Timing entries", () => {
    expect(limitedByProxy({ serverTiming: [{ name: "critiqs-refused" }, { name: "critiqs-limit" }] })).toBe(true);
    expect(limitedByProxy({ serverTiming: [{ name: "critiqs-refused" }] })).toBe(false);
    expect(passedByProxy({ serverTiming: [{ name: "critiqs-file" }] })).toBe(true);
    expect(passedByProxy({ serverTiming: [{ name: "app" }] })).toBe(false);
  });
});

describe("every viewer is its own client", () => {
  // A listener on `::` sees an IPv4 viewer as ::ffff:a.b.c.d; a front server may write it that way, or with a port.
  const forms: [string, string, string][] = [
    ["IPv4-mapped IPv6, dotted", "::ffff:198.51.100.1", "::ffff:198.51.100.2"],
    ["IPv4-mapped IPv6, hex", "::ffff:c633:6401", "::ffff:c633:6402"],
    ["IPv4-mapped IPv6, written out", "0:0:0:0:0:ffff:198.51.100.1", "0:0:0:0:0:FFFF:198.51.100.2"],
    ["IPv4 with a port", "198.51.100.1:51234", "198.51.100.2:51234"],
    ["bracketed IPv6 with a port", "[2001:db8:1:1::9]:443", "[2001:db8:1:2::9]:443"],
  ];
  for (const [name, attacker, viewer] of forms) {
    test(`${name}: one client using up its misses leaves another's new link alone`, async () => {
      const { proxy } = setup({ leases: [lease(), lease({ label: label(1), leaseId: "lease-2", linkId: "link-2" })] });
      expect(await statusOf(ask(proxy, "/", { client: attacker }))).toBe(200);
      for (let index = 0; index < 40; index++) await statusOf(ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}`, client: attacker }));
      // A different viewer opens another link for the first time.
      expect(await statusOf(ask(proxy, "/", { host: `${label(1)}.${DOMAIN}`, client: viewer }))).toBe(200);
    });
  }
  test("an IPv4 viewer and its IPv4-mapped form are one client", async () => {
    const { proxy, lookups } = setup();
    for (let index = 0; index < 20; index++) await statusOf(ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}`, client: "198.51.100.1" }));
    for (let index = 0; index < 20; index++) await statusOf(ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}`, client: "::ffff:198.51.100.1" }));
    expect(lookups()).toBe(DEFAULT_LIMITS.lookupMissesPerClient);
  });
  test("a list from the front server is keyed by its last entry, the one the front added", async () => {
    const { proxy, lookups } = setup();
    for (let index = 0; index < 40; index++) await statusOf(ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}`, client: `203.0.113.${index}, 198.51.100.1` }));
    expect(lookups()).toBe(DEFAULT_LIMITS.lookupMissesPerClient);
  });

  const PUBLIC = {
    CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
    CRITIQS_WEB_ORIGINS: "https://critiqs.app",
    CRITIQS_PROXY_BACKEND: "https://brazen-snail-591.convex.site",
    CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
    CRITIQS_PROXY_SIGNING_KEY: "a-signing-key-that-is-long-enough-to-pass",
    CRITIQS_WEB_RISK_API_KEY: "test-key",
    CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list",
  };
  for (const header of ["host", "Host", "cookie", "user-agent", "referer", "origin", "accept", "x-custom-thing"]) {
    test(`${header} can't be the client-address header: a client sets it`, () => {
      expect(() => parseProxyConfig({ ...PUBLIC, CRITIQS_PROXY_CLIENT_IP_HEADER: header })).toThrow("CRITIQS_PROXY_CLIENT_IP_HEADER");
    });
  }
  for (const header of ["cf-connecting-ip", "x-forwarded-for", "X-Real-IP", "true-client-ip", "fly-client-ip", "connection"]) {
    test(`${header} can`, () => {
      expect(() => parseProxyConfig({ ...PUBLIC, CRITIQS_PROXY_CLIENT_IP_HEADER: header })).not.toThrow();
    });
  }
});

describe("a backend that can't be reached isn't a host that serves nothing", () => {
  test("after a short outage, a viewer whose page asked for 40 files is served again at once", async () => {
    let time = Date.now();
    const { proxy, outage } = setup({ now: () => time });
    expect(await statusOf(ask(proxy, "/"))).toBe(200);
    outage(true);
    for (let index = 0; index < 40; index++) await statusOf(ask(proxy, `/img/${index}.png`, { dest: "image" }));
    time += 3_000;
    outage(false);
    expect(await statusOf(ask(proxy, "/"))).toBe(200);
  });
  test("during an outage a frame host the proxy knows is served for at most 5 seconds from its last answer, then says Critiqs can't check it", async () => {
    let time = Date.now();
    const { proxy, outage } = setup({ now: () => time });
    expect(await statusOf(ask(proxy, "/"))).toBe(200);
    outage(true);
    time += 2_000;
    expect(await statusOf(ask(proxy, "/"))).toBe(200);
    time += 4_000;
    const page = await ask(proxy, "/");
    expect(page.status).toBe(503);
    const body = await page.text();
    expect(body).not.toContain("<p>page</p>");
    expect(body).not.toContain("isn't available");
    const file = await ask(proxy, "/img/1.png", { dest: "image" });
    expect(file.status).toBe(503);
    expect(file.headers.get("server-timing")).toContain("critiqs-refused");
  });
  test("a host it has never seen gets the same can't-check answer, not 'not found', and isn't counted as a miss", async () => {
    let time = Date.now();
    const { proxy, outage, lookups } = setup({ now: () => time });
    outage(true);
    for (let index = 0; index < 40; index++) expect(await statusOf(ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}` }))).toBe(503);
    // While it is down, unknown hosts aren't asked about at all: one try a second.
    expect(lookups()).toBe(1);
    outage(false);
    time += 1_000;
    // None of those counted: the next unknown hosts still reach the directory.
    const before = lookups();
    for (let index = 0; index < 5; index++) await statusOf(ask(proxy, "/", { host: `${randomLabel()}.${DOMAIN}` }));
    expect(lookups() - before).toBe(5);
    expect(await statusOf(ask(proxy, "/"))).toBe(200);
  });
});

describe("a slow reader keeps its download", () => {
  const slow = { ...config, limits: { ...DEFAULT_LIMITS, clientStallMs: 300 } };
  /** Reads `response` one chunk at a time, waiting `gapMs` between reads: a browser on a slow connection. */
  async function readSlowly(response: Response, gapMs: number): Promise<{ bytes: number; error: unknown }> {
    const reader = response.body!.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) return { bytes, error: null };
        bytes += step.value.byteLength;
        await Bun.sleep(gapMs);
      }
    } catch (error) {
      return { bytes, error };
    }
  }
  test("a reader that takes each chunk slower than the stall window still gets the whole file", async () => {
    const { proxy } = setup({ config: slow });
    const response = await ask(proxy, "/unsized.bin", { dest: "image" });
    expect(response.status).toBe(200);
    // 3 MiB in chunks of up to 64 KiB, one every 400 ms: about 160 KB/s.
    const result = await readSlowly(response, 400);
    expect(result.error).toBeNull();
    expect(result.bytes).toBe(SIZED.byteLength);
  }, 40_000);
  test("while it reads slowly it holds no read slot, so others aren't kept waiting", async () => {
    const { proxy } = setup({ config: slow });
    const response = await ask(proxy, "/unsized.bin", { dest: "image" });
    const reader = response.body!.getReader();
    await reader.read();
    expect(proxy.inFlight).toBe(1);
    await Bun.sleep(700);
    expect(proxy.inFlight).toBe(0);
    await reader.cancel();
  });
  test("a reader that stops is ended", async () => {
    const stop = { ...config, limits: { ...DEFAULT_LIMITS, clientStallMs: 200, slowReaderBytesPerSecond: 64 * 1024 * 1024 } };
    const { proxy } = setup({ config: stop });
    const response = await ask(proxy, "/unsized.bin", { dest: "image" });
    const reader = response.body!.getReader();
    await reader.read();
    await Bun.sleep(1_500);
    let failed = false;
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("a file over the size cap says so", () => {
  const capped = { ...config, limits: { ...DEFAULT_LIMITS, assetBytes: 1 * MIB } };
  test("a file whose length is over the cap is refused before any of it is sent, marked for the frame's notice", async () => {
    const { proxy } = setup({ config: capped });
    const response = await ask(proxy, "/sized.bin", { dest: "image" });
    expect(response.status).not.toBe(200);
    expect(response.headers.get("server-timing")).toContain("critiqs-refused");
    await response.arrayBuffer();
  });
  test("a file within the cap carries its length, so media know their duration", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/sized.bin", { dest: "video" });
    expect(response.headers.get("content-length")).toBe(String(SIZED.byteLength));
    expect((await response.arrayBuffer()).byteLength).toBe(SIZED.byteLength);
  });
  test("a file of unknown length cut at the cap is marked as the proxy's, so the frame's notice can tell", async () => {
    const { proxy } = setup({ config: capped });
    const response = await ask(proxy, "/unsized.bin", { dest: "image" });
    expect(response.headers.get("server-timing")).toContain("critiqs-file");
    await response.arrayBuffer().catch(() => undefined);
  });
});

describe("request budgets", () => {
  test("ten full loads of a page with 60 images in a few minutes are all served", async () => {
    let time = Date.now();
    const { proxy } = setup({ now: () => time });
    for (let load = 0; load < 10; load++) {
      expect(await statusOf(ask(proxy, "/page.html"))).toBe(200);
      const images = await Promise.all(Array.from({ length: 60 }, (_, index) => statusOf(ask(proxy, `/img/${index}.png`, { dest: "image" }))));
      expect(images.filter((status) => status !== 200)).toEqual([]);
      // Three data requests per load, as an app's own fetches.
      for (let call = 0; call < 3; call++) expect(await statusOf(ask(proxy, "/api/items", { dest: "empty" }))).toBe(200);
      time += 20_000;
    }
  });
  test("pages and data have the tight budget, and it refills while the viewer waits", async () => {
    let time = Date.now();
    const { proxy } = setup({ now: () => time });
    let served = 0;
    while ((await statusOf(ask(proxy, "/api/items", { dest: "empty" }))) === 200) served++;
    expect(served).toBe(DEFAULT_LIMITS.requestsPerWindow);
    const page = await ask(proxy, "/page.html");
    expect(page.status).toBe(429);
    const words = await page.text();
    // It says what helps: waiting, and for how long.
    expect(words).toMatch(/seconds|minute/);
    expect(page.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    // A minute later, some of the budget is back.
    time += 60_000;
    expect(await statusOf(ask(proxy, "/page.html"))).toBe(200);
  });
  test("a page asked for as an image can't use the files' budget to be a page", async () => {
    const { proxy } = setup();
    const response = await ask(proxy, "/as-image.html", { dest: "image" });
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(await response.text()).not.toContain(RUNTIME);
  });
  test("the files' budget is bounded too", async () => {
    const tight = { ...config, limits: { ...DEFAULT_LIMITS, fileRequestsPerWindow: 5 } };
    const { proxy } = setup({ config: tight });
    const statuses = [];
    for (let index = 0; index < 8; index++) statuses.push(await statusOf(ask(proxy, `/img/${index}.png`, { dest: "image" })));
    expect(statuses.filter((status) => status === 200).length).toBe(5);
  });
});

describe("a freed read goes to whoever holds the fewest", () => {
  test("one viewer holding its link's share can't keep another viewer of that link waiting until it gives up", async () => {
    const fair = { ...config, limits: { ...DEFAULT_LIMITS, concurrentPerLease: 2, concurrentPerLink: 2, queueTimeoutMs: 3_000 } };
    const { proxy } = setup({ config: fair, leases: [lease(), lease({ label: label(1), leaseId: "lease-2" })] });
    const controllers: AbortController[] = [];
    // The holder keeps both of the link's reads busy with a slow file, and asks again as soon as one ends.
    const hold = async () => {
      for (let round = 0; round < 4; round++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await ask(proxy, "/trickle.js", { dest: "script", signal: controller.signal });
        if (response.status !== 200) continue;
        await Bun.sleep(600);
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
      }
    };
    const holding = Array.from({ length: 10 }, hold);
    await Bun.sleep(100);
    const started = performance.now();
    const status = await statusOf(ask(proxy, "/img/1.png", { dest: "image", host: `${label(1)}.${DOMAIN}` }));
    expect(status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1_000);
    for (const controller of controllers) controller.abort();
    await Promise.all(holding);
  }, 15_000);
  test("waiting is bounded per lease and in all: past 256 waiting on one lease, or 4,096 in all, a read is refused at once", async () => {
    const lines = { ...config, limits: { ...DEFAULT_LIMITS, concurrentPerLease: 1, queuedPerLease: 3, queuedPerProcess: 5, queueTimeoutMs: 2_000 } };
    const { proxy } = setup({ config: lines, leases: [lease(), lease({ label: label(1), leaseId: "lease-2", linkId: "link-2" }), lease({ label: label(2), leaseId: "lease-3", linkId: "link-3" })] });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const held = await Promise.all([0, 1, 2].map((index) => ask(proxy, "/trickle.js", { dest: "script", host: `${label(index)}.${DOMAIN}`, signal: controllers[index]!.signal })));
    const waiting = [0, 1, 2].map(() => ask(proxy, "/img/1.png", { dest: "image" }));
    await Bun.sleep(50);
    // The lease's line is full: refused at once.
    let started = performance.now();
    expect(await statusOf(ask(proxy, "/img/2.png", { dest: "image" }))).toBe(503);
    expect(performance.now() - started).toBeLessThan(500);
    const others = [1, 2].map((index) => ask(proxy, "/img/1.png", { dest: "image", host: `${label(index)}.${DOMAIN}` }));
    await Bun.sleep(50);
    // The process's line is full: refused at once.
    started = performance.now();
    expect(await statusOf(ask(proxy, "/img/3.png", { dest: "image", host: `${label(2)}.${DOMAIN}` }))).toBe(503);
    expect(performance.now() - started).toBeLessThan(500);
    for (const controller of controllers) controller.abort();
    for (const response of held) await response.body?.cancel().catch(() => undefined);
    await Promise.all([...waiting, ...others].map(statusOf));
  });
});

describe("the frame's policy", () => {
  test("lets WebAssembly compile, and still refuses workers, eval, frames, objects and other sites", () => {
    const policy = frameCsp(["http://web.localhost:5110"]);
    const directive = (name: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
    expect(directive("worker-src")).toBe("worker-src 'none'");
    expect(directive("frame-src")).toBe("frame-src 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
  });
});
