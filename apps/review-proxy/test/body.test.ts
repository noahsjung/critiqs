import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import zlib from "node:zlib";
import { DEFAULT_LIMITS, parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { BodyError, boundedChunks, readBounded, readDecoded } from "../src/decompress.ts";
import { createEgress } from "../src/egress.ts";
import { keyedSlots, slots } from "../src/limits.ts";
import { cachedReputation, fixtureReputation } from "../src/reputation.ts";
import { close, closedWithin, listen, PUBLIC_A, testWeb, v4 } from "./fixtures.ts";

// AT-6: compression bombs, endless bodies and slow bodies are cut at their
// limit, the upstream connection closes at once, and the slots they held are
// released. Through the real pinned connector to local servers.

const MiB = 1024 * 1024;
const limits = { wireBytes: 2 * MiB, decodedBytes: 3 * MiB, idleMs: 300, totalMs: 2_000 };

const gzipBomb = zlib.gzipSync(Buffer.alloc(64 * MiB, 0));
const brotliBomb = zlib.brotliCompressSync(Buffer.alloc(64 * MiB, 0));
const page = Buffer.from("<html>" + "a".repeat(10_000) + "</html>");

const closed = new Map<string, Promise<number>>();
const server = http.createServer((request, response) => {
  let written = 0;
  closed.set(request.url!, new Promise((resolve) => response.on("close", () => resolve(written))));
  const endless = (chunk: Buffer, headers: http.OutgoingHttpHeaders = {}) => {
    response.writeHead(200, headers);
    const write = () => {
      while (!response.destroyed && response.write(chunk)) written += chunk.length;
      if (!response.destroyed) response.once("drain", write);
    };
    write();
  };
  switch (request.url) {
    case "/gzip-bomb":
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      return void response.end(gzipBomb);
    case "/br-bomb":
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "br" });
      return void response.end(brotliBomb);
    case "/gzip-page":
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      return void response.end(zlib.gzipSync(page));
    case "/br-page":
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "br" });
      return void response.end(zlib.brotliCompressSync(page));
    case "/deflate-page":
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "deflate" });
      return void response.end(zlib.deflateSync(page));
    case "/endless":
      return endless(Buffer.alloc(64 * 1024, "a"));
    case "/endless-gzip": {
      // Compressed bytes forever: the wire limit stops it even while decoding.
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      const gzip = zlib.createGzip({ level: 0 });
      gzip.pipe(response);
      const random = Buffer.alloc(64 * 1024);
      const write = () => {
        for (let i = 0; i < random.length; i++) random[i] = (Math.random() * 256) | 0;
        if (!response.destroyed && gzip.write(random)) setImmediate(write);
        else if (!response.destroyed) gzip.once("drain", write);
      };
      return write();
    }
    case "/slow":
      // One chunk, then silence.
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.write("<html>");
    case "/trickle": {
      // A byte every 100 ms: never idle long, but never done.
      response.writeHead(200, { "Content-Type": "text/html" });
      const timer = setInterval(() => (response.destroyed ? clearInterval(timer) : response.write("a")), 100);
      return;
    }
    case "/lying-gzip":
      // Labelled gzip, but plain bytes: a misconfigured server, not an attack.
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      return void response.end(page);
    case "/zstd":
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "zstd" });
      return void response.end("not really");
    default:
      response.end(page);
  }
});
let port = 0;
beforeAll(async () => {
  port = await listen(server);
});
afterAll(() => close(server));

const policy = proxyPolicy(
  parseProxyConfig({
    CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
    CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
    CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
    CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
  }),
);

async function open(path: string) {
  const web = testWeb({ "proto.example.com": [v4(PUBLIC_A)] }, { [PUBLIC_A]: port });
  const egress = createEgress({ web, policy, reputation: cachedReputation(fixtureReputation()), userAgent: "test", limits: DEFAULT_LIMITS });
  const outcome = await egress.fetch({ url: new URL(`http://proto.example.com${path}`), method: "GET", class: "document", origin: "http://proto.example.com", signal: AbortSignal.timeout(10_000) });
  if (outcome.kind !== "response") throw new Error(`expected a response, got ${JSON.stringify(outcome)}`);
  return outcome;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof BodyError) return error.reason;
    throw error;
  }
  return "read";
}

describe("AT-6: bounded decompression", () => {
  for (const [path, encoding] of [
    ["/gzip-bomb", "gzip"],
    ["/br-bomb", "br"],
  ] as const) {
    test(`a ${encoding} bomb (${(path === "/gzip-bomb" ? gzipBomb : brotliBomb).length} bytes expanding to 64 MiB) stops at the decoded limit`, async () => {
      const response = await open(path);
      const before = process.memoryUsage().rss;
      const started = performance.now();
      expect(await failure(readDecoded(response.body, response.headers["content-encoding"], limits, AbortSignal.timeout(5_000)))).toBe("too-large");
      expect(performance.now() - started).toBeLessThan(2_000);
      // Far less than the 64 MiB it would have expanded to.
      expect(process.memoryUsage().rss - before).toBeLessThan(48 * MiB);
      await closedWithin(closed.get(path)!, 2_000, `the ${path} connection`);
    });
  }

  test("compressed bytes that never end stop at the wire limit while decoding", async () => {
    const response = await open("/endless-gzip");
    expect(await failure(readDecoded(response.body, "gzip", { ...limits, decodedBytes: 64 * MiB }, AbortSignal.timeout(5_000)))).toBe("too-large");
    await closedWithin(closed.get("/endless-gzip")!, 2_000, "the endless gzip connection");
  });

  for (const path of ["/gzip-page", "/br-page", "/deflate-page", "/plain"]) {
    test(`a normal page decodes (${path})`, async () => {
      const response = await open(path);
      const bytes = await readDecoded(response.body, response.headers["content-encoding"], limits, AbortSignal.timeout(5_000));
      expect(Buffer.from(bytes).equals(page)).toBe(true);
    });
  }

  test("an encoding the proxy didn't ask for is refused and the connection closed", async () => {
    const response = await open("/zstd");
    expect(await failure(readDecoded(response.body, response.headers["content-encoding"], limits, AbortSignal.timeout(5_000)))).toBe("unsupported");
  });

  test("a body whose encoding is a lie fails at once instead of hanging", async () => {
    const response = await open("/lying-gzip");
    const started = performance.now();
    expect(await failure(readDecoded(response.body, response.headers["content-encoding"], { ...limits, idleMs: 5_000, totalMs: 10_000 }, AbortSignal.timeout(20_000)))).toBe("unsupported");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a body without an encoding counts against the smaller of the two limits", async () => {
    const response = await open("/endless");
    expect(await failure(readDecoded(response.body, undefined, { ...limits, wireBytes: 8 * MiB, decodedBytes: MiB }, AbortSignal.timeout(5_000)))).toBe("too-large");
    await closedWithin(closed.get("/endless")!, 2_000, "the endless connection");
  });
});

describe("AT-6: endless and slow bodies", () => {
  test("an endless body is cut at the wire limit and its connection closed", async () => {
    const response = await open("/endless");
    expect(await failure(readBounded(response.body, limits, AbortSignal.timeout(5_000)))).toBe("too-large");
    const written = (await closedWithin(closed.get("/endless")!, 2_000, "the endless connection")) as number;
    expect(written).toBeLessThan(16 * MiB);
  });

  test("a body that goes quiet times out at the idle limit and its connection closes", async () => {
    const response = await open("/slow");
    const started = performance.now();
    expect(await failure(readBounded(response.body, limits, AbortSignal.timeout(5_000)))).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1_000);
    await closedWithin(closed.get("/slow")!, 2_000, "the slow connection");
  });

  test("a body that trickles forever times out at the total limit", async () => {
    const response = await open("/trickle");
    const started = performance.now();
    expect(await failure(readBounded(response.body, { ...limits, totalMs: 700 }, AbortSignal.timeout(5_000)))).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1_500);
    await closedWithin(closed.get("/trickle")!, 2_000, "the trickling connection");
  });

  test("a browser that goes away mid-body closes the upstream connection", async () => {
    const response = await open("/endless");
    const controller = new AbortController();
    const reading = failure(readBounded(response.body, { ...limits, wireBytes: 1024 * MiB }, controller.signal));
    setTimeout(() => controller.abort(new Error("gone")), 50);
    await expect(reading).rejects.toThrow("gone");
    await closedWithin(closed.get("/endless")!, 2_000, "the endless connection");
  });

  test("slots held for a request are released when its body is cut", async () => {
    const process = slots(2);
    const leases = keyedSlots(1);
    const release = [process.take()!, leases.take("lease-1")!];
    expect(leases.take("lease-1")).toBeNull();
    const response = await open("/endless");
    try {
      for await (const _ of boundedChunks(response.body, limits, AbortSignal.timeout(5_000)));
    } catch {
      // Too large.
    } finally {
      for (const done of release) done();
    }
    expect(process.used).toBe(0);
    expect(leases.used("lease-1")).toBe(0);
    expect(leases.take("lease-1")).not.toBeNull();
  });
});
