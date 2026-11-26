import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ADDRESS_CHECK_USER_AGENT, type AddressCheckDeps, checkAddress, nodeNetwork, type PinnedResponse } from "../src/address-check.ts";
import { dnsServer } from "./dns-server.ts";

// The address check's real connection, over local servers. Written with
// node:test so the same file runs under both runtimes the check runs in:
// `bun test` (the SQLite server on Bun) and `node --test` (Convex's Node
// actions, and the SQLite server on Node); see this package's `test` script.

const network = nodeNetwork({ http, https, Resolver });
const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
const HEADERS = { "User-Agent": ADDRESS_CHECK_USER_AGENT, Accept: "text/html" };

interface Seen {
  host: string | undefined;
  path: string | undefined;
  userAgent: string | undefined;
  accept: string | undefined;
  servername: string | undefined;
}

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function record(seen: Seen[]) {
  return (request: http.IncomingMessage, response: http.ServerResponse) => {
    seen.push({
      host: request.headers.host,
      path: request.url,
      userAgent: request.headers["user-agent"],
      accept: request.headers.accept,
      servername: (request.socket as { servername?: string }).servername,
    });
    response.end("<html>pinned</html>");
  };
}

async function text(response: PinnedResponse): Promise<string> {
  let body = "";
  for await (const chunk of response.body) body += Buffer.from(chunk).toString("utf8");
  return body;
}

const seen: Seen[] = [];
const plain = http.createServer(record(seen));
let plainPort = 0;

// A certificate for pinned.test only, made for this run.
const directory = mkdtempSync(join(tmpdir(), "critiqs-pinning-"));
function makeCertificate(): { key: Buffer; cert: Buffer } | null {
  try {
    const [key, cert] = [join(directory, "key.pem"), join(directory, "cert.pem")];
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=pinned.test", "-addext", "subjectAltName=DNS:pinned.test"], {
      stdio: "ignore",
    });
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } catch {
    return null;
  }
}
const certificates = makeCertificate();
const secure = certificates === null ? null : https.createServer(certificates, record(seen));
let securePort = 0;

before(async () => {
  plainPort = await listen(plain);
  if (secure !== null) securePort = await listen(secure);
});

after(() => {
  plain.close();
  secure?.close();
  rmSync(directory, { recursive: true, force: true });
});

test(`${runtime}: connects to the pinned address, not where the name resolves, keeping the name in the Host header`, async () => {
  seen.length = 0;
  // example.com resolves to public addresses; reaching this local server proves the pinned address was used.
  const response = await network.fetchPinned({
    url: new URL(`http://example.com:${plainPort}/app?step=2`),
    address: { address: "127.0.0.1", family: 4 },
    headers: HEADERS,
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  assert.equal(await text(response), "<html>pinned</html>");
  assert.deepEqual(seen, [{ host: `example.com:${plainPort}`, path: "/app?step=2", userAgent: ADDRESS_CHECK_USER_AGENT, accept: "text/html", servername: undefined }]);
});

test(`${runtime}: over HTTPS, sends the name for TLS and checks the certificate against it, not the pinned address`, { skip: certificates === null ? "openssl isn't available" : false }, async () => {
  seen.length = 0;
  const fetch = nodeNetwork({ http, https, Resolver }, { ca: certificates!.cert.toString("utf8") }).fetchPinned;
  const response = await fetch({
    url: new URL(`https://pinned.test:${securePort}/`),
    address: { address: "127.0.0.1", family: 4 },
    headers: HEADERS,
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  assert.equal(await text(response), "<html>pinned</html>");
  assert.equal(seen[0]?.host, `pinned.test:${securePort}`);
  assert.equal(seen[0]?.servername, "pinned.test");
  // The same server and pinned address, under a name its certificate doesn't cover.
  await assert.rejects(
    fetch({ url: new URL(`https://other.test:${securePort}/`), address: { address: "127.0.0.1", family: 4 }, headers: HEADERS, signal: AbortSignal.timeout(3_000) }),
    (error: { code?: string }) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
  );
});

test(`${runtime}: ending the body early closes the connection, so a huge page stops downloading`, async () => {
  let closed: () => void = () => undefined;
  const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
  let written = 0;
  const endless = http.createServer((_request, response) => {
    response.on("close", () => closed());
    const chunk = Buffer.alloc(64 * 1024, "a");
    const write = () => {
      while (!response.destroyed && response.write(chunk)) written += chunk.length;
      if (!response.destroyed) response.once("drain", write);
    };
    write();
  });
  const port = await listen(endless);
  try {
    const response = await network.fetchPinned({ url: new URL(`http://endless.test:${port}/`), address: { address: "127.0.0.1", family: 4 }, headers: HEADERS, signal: AbortSignal.timeout(3_000) });
    let read = 0;
    for await (const chunk of response.body) {
      read += chunk.byteLength;
      if (read >= 128 * 1024) break;
    }
    await Promise.race([connectionClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("the server kept sending")), 2_000))]);
    assert.ok(written < 64 * 1024 * 1024, `the server wrote ${written} bytes`);
  } finally {
    endless.close();
  }
});

test(`${runtime}: the check stops downloading the body of a redirect, a 404, and a server error`, async () => {
  // Each of these responses sends an endless body, so the server sees its connection close only if the check closes it.
  const closed = new Map<string, Promise<number>>();
  const server = http.createServer((request, response) => {
    if (request.url === "/page") return void response.end("<html>page</html>");
    const status = request.url === "/redirect" ? 302 : request.url === "/missing" ? 404 : 500;
    response.writeHead(status, status === 302 ? { Location: "/page" } : {});
    let written = 0;
    closed.set(request.url!, new Promise((resolve) => response.on("close", () => resolve(written))));
    const chunk = Buffer.alloc(64 * 1024, "a");
    const write = () => {
      while (!response.destroyed && response.write(chunk)) written += chunk.length;
      if (!response.destroyed) response.once("drain", write);
    };
    write();
  });
  const port = await listen(server);
  // The check refuses 127.0.0.1 and any port but 80, so DNS answers a public address and the connection is sent here.
  const deps: AddressCheckDeps = {
    resolve: async () => [{ address: "93.184.215.14", family: 4 }],
    fetchPinned: (request) => {
      const url = new URL(request.url);
      url.port = String(port);
      return network.fetchPinned({ ...request, url, address: { address: "127.0.0.1", family: 4 } });
    },
  };
  try {
    for (const [path, expected] of [
      ["/redirect", { kind: "public", stack: null }],
      ["/missing", { kind: "unreachable" }],
      ["/error", { kind: "unreachable" }],
    ] as const) {
      assert.deepEqual(await checkAddress(`http://proto.example.test${path}`, deps), expected);
      const written = await Promise.race([closed.get(path)!, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the connection for ${path} stayed open`)), 2_000))]);
      assert.ok(written < 16 * 1024 * 1024, `the server wrote ${written} bytes for ${path}`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test(`${runtime}: the deadline's signal aborts a request the server never answers`, async () => {
  const silent = http.createServer(() => undefined);
  const port = await listen(silent);
  try {
    const started = Date.now();
    await assert.rejects(
      network.fetchPinned({ url: new URL(`http://silent.test:${port}/`), address: { address: "127.0.0.1", family: 4 }, headers: HEADERS, signal: AbortSignal.timeout(200) }),
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
});

test(`${runtime}: resolves a name's IPv4 and IPv6 addresses, with a name that has only one family`, async () => {
  const dns = await dnsServer({
    "both.test": { A: ["93.184.215.14", "93.184.215.15"], AAAA: ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"] },
    "v4.test": { A: ["93.184.215.14"] },
    "none.test": {},
  });
  try {
    const { resolve } = nodeNetwork({ http, https, Resolver }, { dnsServers: [dns.server] });
    const signal = AbortSignal.timeout(3_000);
    assert.deepEqual(await resolve("both.test", signal), [
      { address: "93.184.215.14", family: 4 },
      { address: "93.184.215.15", family: 4 },
      { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
    ]);
    assert.deepEqual(await resolve("v4.test", signal), [{ address: "93.184.215.14", family: 4 }]);
    assert.deepEqual(await resolve("none.test", signal), []);
  } finally {
    dns.close();
  }
});

test(`${runtime}: cancels its DNS queries at the deadline, so none is still pending when the check returns`, async () => {
  // A DNS server that never answers.
  const dns = await dnsServer({});
  let pending = 0;
  let requests = 0;
  const track = (query: Promise<string[]>) => {
    pending++;
    query.then(
      () => pending--,
      () => pending--,
    );
    return query;
  };
  class TrackedResolver extends Resolver {
    constructor(options?: ConstructorParameters<typeof Resolver>[0]) {
      super(options);
      const [resolve4, resolve6] = [this.resolve4.bind(this), this.resolve6.bind(this)];
      this.resolve4 = ((hostname: string) => track(resolve4(hostname))) as Resolver["resolve4"];
      this.resolve6 = ((hostname: string) => track(resolve6(hostname))) as Resolver["resolve6"];
    }
  }
  try {
    const real = nodeNetwork({ http, https, Resolver: TrackedResolver }, { dnsServers: [dns.server] });
    const started = Date.now();
    const result = await checkAddress("https://prototype.example.test/", {
      ...real,
      fetchPinned: async () => {
        requests++;
        throw new Error("Unexpected request");
      },
      timeoutMs: 100,
    });
    assert.deepEqual(result, { kind: "unreachable" });
    assert.ok(Date.now() - started < 1_000);
    assert.ok(dns.queries.length > 0, "the resolver asked the test server");
    // Cancelled queries settle on the next turns of the event loop, far sooner than the resolver's own 2-second timeout.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual({ pending, requests }, { pending: 0, requests: 0 });
  } finally {
    dns.close();
  }
});
