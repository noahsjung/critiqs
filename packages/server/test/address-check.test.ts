import { describe, expect, test } from "bun:test";
import {
  ADDRESS_CHECK_TIMEOUT_MS,
  ADDRESS_CHECK_USER_AGENT,
  type AddressCheckDeps,
  checkAddress,
  checkPrototypeAddress,
  isPublicAddress,
  MAX_ADDRESS_BODY_BYTES,
  MAX_CONCURRENT_ADDRESS_CHECKS,
  type PinnedRequest,
  type PinnedResponse,
} from "../src/address-check.ts";
import { CritiqsError } from "../src/errors.ts";

// The address check with a fake resolver and fake connections: what it
// connects to, what it refuses, and what it reports. The real connection is
// tested in address-pinning.test.ts.

interface FakePage {
  status: number;
  headers?: Record<string, string | string[]>;
  /** Text, or chunks produced on demand. Default: a small HTML page, since core counts an empty body as no page. */
  body?: string | (() => AsyncGenerator<Uint8Array>);
}

/** A fake internet: DNS answers by name, and a page for each URL. */
function network(dns: Record<string, string[]>, pages: Record<string, FakePage>) {
  const lookups: string[] = [];
  const requests: PinnedRequest[] = [];
  const deps: AddressCheckDeps = {
    resolve: async (hostname) => {
      lookups.push(hostname);
      const answers = dns[hostname];
      if (answers === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
    },
    fetchPinned: async (request) => {
      requests.push(request);
      const page = pages[request.url.href];
      if (page === undefined) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return response(page);
    },
  };
  return { deps, lookups, requests };
}

function response(page: FakePage): PinnedResponse {
  const body = page.body ?? "<html></html>";
  return {
    status: page.status,
    headers: page.headers ?? {},
    body: typeof body === "string" ? (async function* () { yield new TextEncoder().encode(body); })() : body(),
  };
}

const PUBLIC_IP = "93.184.215.14";
const NEXT_PAGE = '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>';

describe("what an address is", () => {
  test("a page that loads publicly, with its stack", async () => {
    const net = network({ "proto.example.com": [PUBLIC_IP] }, { "https://proto.example.com/": { status: 200, body: NEXT_PAGE } });
    expect(await checkAddress("https://proto.example.com", net.deps)).toEqual({ kind: "public", stack: "next" });
  });

  test("a redirect to an identity provider is a sign-in, at that host", async () => {
    const net = network(
      { "proto.example.com": [PUBLIC_IP], "accounts.google.com": ["142.250.80.13"] },
      {
        "https://proto.example.com/": { status: 302, headers: { Location: "https://accounts.google.com/o/oauth2/auth?client_id=1" } },
        "https://accounts.google.com/o/oauth2/auth?client_id=1": { status: 200, body: "<html>Sign in</html>" },
      },
    );
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "sign-in", via: "redirect", host: "accounts.google.com", stack: null });
  });

  test("Basic Auth is a password sign-in", async () => {
    const net = network({ "proto.example.com": [PUBLIC_IP] }, { "https://proto.example.com/": { status: 401, headers: { "WWW-Authenticate": 'Basic realm="staging"' } } });
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "sign-in", via: "password", host: null, stack: null });
  });

  test("bot protection is blocked, read from headers in any case", async () => {
    const net = network(
      { "proto.example.com": [PUBLIC_IP] },
      { "https://proto.example.com/": { status: 403, headers: { "CF-Mitigated": "challenge", Server: "cloudflare" }, body: "<title>Just a moment...</title>" } },
    );
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "blocked" });
  });

  test("a server error, a name that doesn't resolve, and a refused connection are unreachable", async () => {
    const net = network({ "proto.example.com": [PUBLIC_IP], "down.example.com": [PUBLIC_IP] }, { "https://proto.example.com/": { status: 500 } });
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "unreachable" });
    expect(await checkAddress("https://missing.example.com/", net.deps)).toEqual({ kind: "unreachable" });
    expect(await checkAddress("https://down.example.com/", net.deps)).toEqual({ kind: "unreachable" });
  });

  test("an address on this computer or a private network is local, without any network access", async () => {
    const net = network({}, {});
    for (const address of ["http://localhost:3000", "http://127.0.0.1:1", "http://169.254.169.254/", "http://devbox:8080/", "http://[::1]:5173/", "http://192.168.1.20/", "http://app.local/", "http://0x7f.1/"]) {
      expect(await checkAddress(address, net.deps)).toEqual({ kind: "local" });
    }
    expect(net.lookups).toEqual([]);
    expect(net.requests).toEqual([]);
  });

  test("sends a GET with Critiqs's user agent, to the first IPv4 address, keeping the URL's host", async () => {
    const net = network({ "proto.example.com": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", PUBLIC_IP] }, { "http://proto.example.com/a?b=1": { status: 200 } });
    await checkAddress("  http://proto.example.com/a?b=1  ", net.deps);
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]!.url.href).toBe("http://proto.example.com/a?b=1");
    expect(net.requests[0]!.address).toEqual({ address: PUBLIC_IP, family: 4 });
    expect(net.requests[0]!.headers).toMatchObject({ "User-Agent": ADDRESS_CHECK_USER_AGENT, Accept: "text/html" });
  });

  test("hands core lowercase header names, joining repeated ones", async () => {
    const net = network(
      { "proto.example.com": [PUBLIC_IP] },
      { "https://proto.example.com/": { status: 200, headers: { "Set-Cookie": ["XSRF-TOKEN=a; Path=/", "shop_session=b; HttpOnly"] }, body: "<html></html>" } },
    );
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "public", stack: "laravel" });
  });
});

describe("addresses it refuses to connect to", () => {
  // Each resolved for a public name, so only the resolved-address rule can refuse it.
  const PRIVATE = [
    ["loopback", "127.0.0.1"],
    ["loopback", "127.255.255.254"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 172.16/12", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["carrier-grade NAT", "100.127.255.255"],
    ["link-local", "169.254.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["multicast", "224.0.0.1"],
    ["multicast", "239.255.255.250"],
    ["unspecified", "0.0.0.0"],
    ["this network", "0.1.2.3"],
    ["broadcast", "255.255.255.255"],
    ["reserved", "240.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique local", "fc00::1"],
    ["IPv6 unique local", "fd12:3456:789a::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 link-local with a zone", "fe80::1%en0"],
    ["IPv6 link-local", "febf:ffff::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback in hex", "::ffff:7f00:1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped metadata in hex", "::ffff:a9fe:a9fe"],
    ["IPv4-mapped public", "::ffff:93.184.215.14"],
    ["IPv4-mapped public in hex", "::ffff:5db8:d70e"],
    ["IPv4-mapped, written in full", "0:0:0:0:0:ffff:808:808"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["IPv4-compatible private", "::a00:1"],
    ["IPv4-compatible public", "::93.184.215.14"],
    ["NAT64 of a private address", "64:ff9b::a00:1"],
    ["6to4 of a private address", "2002:a00:1::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["not an address", "not-an-ip"],
  ] as const;

  for (const [kind, ip] of PRIVATE) {
    test(`${kind}: ${ip}`, async () => {
      expect(isPublicAddress(ip)).toBe(false);
      const net = network({ "proto.example.com": [ip] }, { "https://proto.example.com/": { status: 200 } });
      expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "unreachable" });
      expect(net.requests).toEqual([]);
    });
  }

  test("public addresses next to those ranges are allowed", () => {
    for (const ip of [PUBLIC_IP, "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "169.253.255.255", "223.255.255.255", "2606:4700::1111", "64:ff9b::808:808", "2002:808:808::1"]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    }
  });

  test("a name with any private address among public ones is refused", async () => {
    const net = network({ "proto.example.com": [PUBLIC_IP, "10.0.0.7"] }, { "https://proto.example.com/": { status: 200 } });
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "unreachable" });
    expect(net.requests).toEqual([]);
  });

  test("an IPv6 literal carrying a private IPv4 address is refused without a lookup", async () => {
    const net = network({}, {});
    expect(await checkAddress("http://[64:ff9b::a9fe:a9fe]/", net.deps)).toEqual({ kind: "unreachable" });
    expect(net.lookups).toEqual([]);
    expect(net.requests).toEqual([]);
  });

  test("connects to the address it checked, even when a later DNS answer differs", async () => {
    let answers = 0;
    const requests: PinnedRequest[] = [];
    const deps: AddressCheckDeps = {
      // A rebinding name: public the first time, private after.
      resolve: async () => [{ address: answers++ === 0 ? PUBLIC_IP : "127.0.0.1", family: 4 }],
      fetchPinned: async (request) => {
        requests.push(request);
        return response({ status: 200 });
      },
    };
    await checkAddress("https://rebind.example.com/", deps);
    expect(answers).toBe(1);
    expect(requests.map((request) => request.address.address)).toEqual([PUBLIC_IP]);
  });
});

describe("ports", () => {
  test("an address on a port other than its scheme's default is unreachable, without a lookup or a connection", async () => {
    for (const address of ["https://example.com:8080/", "http://proto.example.com:8080/", "https://proto.example.com:80/", "http://proto.example.com:443/", "https://proto.example.com:22/", "http://93.184.215.14:6379/"]) {
      const net = network({ "example.com": [PUBLIC_IP], "proto.example.com": [PUBLIC_IP] }, { [new URL(address).href]: { status: 200, body: NEXT_PAGE } });
      expect([address, await checkAddress(address, net.deps)]).toEqual([address, { kind: "unreachable" }]);
      expect(net.lookups).toEqual([]);
      expect(net.requests).toEqual([]);
    }
  });

  test("the default port, written or implied, is allowed", async () => {
    for (const address of ["https://proto.example.com:443/", "http://proto.example.com:80/", "https://proto.example.com/", "http://proto.example.com/"]) {
      const net = network({ "proto.example.com": [PUBLIC_IP] }, { [new URL(address).href]: { status: 200, body: NEXT_PAGE } });
      expect([address, await checkAddress(address, net.deps)]).toEqual([address, { kind: "public", stack: "next" }]);
    }
  });

  test("a redirect to another port is unreachable, without a lookup or a connection for that hop", async () => {
    for (const location of ["https://proto.example.com:8443/", "http://proto.example.com:3000/", "https://other.example.com:80/", "//other.example.com:9000/x"]) {
      const net = network(
        { "proto.example.com": [PUBLIC_IP], "other.example.com": [PUBLIC_IP] },
        { "https://proto.example.com/": { status: 302, headers: { location } }, [new URL(location, "https://proto.example.com/").href]: { status: 200, body: NEXT_PAGE } },
      );
      expect([location, await checkAddress("https://proto.example.com/", net.deps)]).toEqual([location, { kind: "unreachable" }]);
      expect(net.lookups).toEqual(["proto.example.com"]);
      expect(net.requests.map((request) => request.url.href)).toEqual(["https://proto.example.com/"]);
    }
  });
});

describe("redirects", () => {
  test("a redirect to a private address on the second hop is unreachable, without connecting to it", async () => {
    const net = network(
      { "proto.example.com": [PUBLIC_IP], "internal.example.com": ["10.0.0.5"] },
      { "https://proto.example.com/": { status: 302, headers: { location: "https://internal.example.com/admin" } }, "https://internal.example.com/admin": { status: 200 } },
    );
    expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "unreachable" });
    expect(net.lookups).toEqual(["proto.example.com", "internal.example.com"]);
    expect(net.requests.map((request) => request.url.href)).toEqual(["https://proto.example.com/"]);
  });

  test("a redirect to localhost or a single-label name is refused without a lookup", async () => {
    for (const location of ["http://localhost:8080/", "http://intranet/", "http://127.0.0.1/", "http://[::1]/"]) {
      const net = network({ "proto.example.com": [PUBLIC_IP], intranet: [PUBLIC_IP] }, { "https://proto.example.com/": { status: 307, headers: { location } } });
      expect(await checkAddress("https://proto.example.com/", net.deps)).toEqual({ kind: "unreachable" });
      expect(net.lookups).toEqual(["proto.example.com"]);
    }
  });

  test("follows at most 3 redirects, re-resolving each hop", async () => {
    const hop = (n: number) => `https://h${n}.example.com/`;
    const dns = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`h${n}.example.com`, [PUBLIC_IP]]));
    const pages: Record<string, FakePage> = Object.fromEntries([1, 2, 3, 4].map((n) => [hop(n), { status: 301, headers: { location: hop(n + 1) } }]));
    pages[hop(5)] = { status: 200 };
    const tooMany = network(dns, pages);
    expect(await checkAddress(hop(1), tooMany.deps)).toEqual({ kind: "unreachable" });
    expect(tooMany.requests.map((request) => request.url.href)).toEqual([hop(1), hop(2), hop(3), hop(4)]);
    expect(tooMany.lookups).toEqual(["h1.example.com", "h2.example.com", "h3.example.com", "h4.example.com"]);

    // Three redirects reach the page.
    pages[hop(4)] = { status: 200, body: NEXT_PAGE };
    expect(await checkAddress(hop(1), network(dns, pages).deps)).toEqual({ kind: "public", stack: "next" });
  });

  test("a fourth redirect is unreachable, and its destination, never checked, isn't reported", async () => {
    const lookups: string[] = [];
    const requests: string[] = [];
    const result = await checkAddress("https://prototype.example.test/step1", {
      resolve: async (host) => {
        lookups.push(host);
        return [{ address: PUBLIC_IP, family: 4 }];
      },
      fetchPinned: async ({ url }) => {
        requests.push(url.href);
        const step = Number(url.pathname.slice(5));
        return response({ status: 302, headers: { location: step < 4 ? `/step${step + 1}` : "https://login.example.test/" } });
      },
    });
    expect(result).toEqual({ kind: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("login.example.test");
    expect(requests).toEqual([1, 2, 3, 4].map((step) => `https://prototype.example.test/step${step}`));
    expect(lookups).toEqual(new Array(4).fill("prototype.example.test"));
  });

  test("a relative Location resolves against the hop's address", async () => {
    const net = network(
      { "proto.example.com": [PUBLIC_IP] },
      {
        "https://proto.example.com/team/": { status: 302, headers: { location: "../app/?from=root" } },
        "https://proto.example.com/app/?from=root": { status: 302, headers: { location: "/app/home" } },
        "https://proto.example.com/app/home": { status: 200, body: NEXT_PAGE },
      },
    );
    expect(await checkAddress("https://proto.example.com/team/", net.deps)).toEqual({ kind: "public", stack: "next" });
    expect(net.requests.map((request) => request.url.href)).toEqual(["https://proto.example.com/team/", "https://proto.example.com/app/?from=root", "https://proto.example.com/app/home"]);
  });

  test("a redirect to another scheme, or with a password, ends the check as unreachable", async () => {
    for (const location of ["ftp://proto.example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "https://user:pass@proto.example.com/", "http://[::1"]) {
      const net = network({ "proto.example.com": [PUBLIC_IP] }, { "https://proto.example.com/": { status: 302, headers: { location } } });
      expect([location, await checkAddress("https://proto.example.com/", net.deps)]).toEqual([location, { kind: "unreachable" }]);
      expect(net.requests).toHaveLength(1);
    }
  });
});

describe("limits", () => {
  test(`the whole check, DNS included, stops after ${ADDRESS_CHECK_TIMEOUT_MS / 1000} seconds by default`, async () => {
    const started = performance.now();
    const result = await checkAddress("https://slow-dns.example.com/", { resolve: () => new Promise(() => undefined), fetchPinned: () => Promise.reject(new Error("never")) });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ kind: "unreachable" });
    expect(elapsed).toBeGreaterThanOrEqual(ADDRESS_CHECK_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(ADDRESS_CHECK_TIMEOUT_MS + 1_000);
  }, 10_000);

  test("tells the resolver to stop at the deadline, so no lookup outlives the check", async () => {
    let lookupSignal: AbortSignal | undefined;
    let completed = false;
    let requests = 0;
    const result = await checkAddress("https://prototype.example.test/", {
      timeoutMs: 30,
      // A lookup that answers after 150 ms unless it's stopped.
      resolve: (_hostname, signal) =>
        new Promise((resolve, reject) => {
          lookupSignal = signal;
          const answer = setTimeout(() => {
            completed = true;
            resolve([{ address: PUBLIC_IP, family: 4 }]);
          }, 150);
          signal?.addEventListener("abort", () => {
            clearTimeout(answer);
            reject(signal.reason);
          });
        }),
      fetchPinned: async () => {
        requests++;
        throw new Error("Unexpected request");
      },
    });
    expect(result).toEqual({ kind: "unreachable" });
    expect(lookupSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect({ completed, requests }).toEqual({ completed: false, requests: 0 });
  });

  test("the deadline covers a connection that never answers and a body that stalls, and aborts the request", async () => {
    let signal: AbortSignal | null = null;
    const hung = await checkAddress("https://proto.example.com/", {
      timeoutMs: 100,
      resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
      fetchPinned: (request) => {
        signal = request.signal;
        return new Promise(() => undefined);
      },
    });
    expect(hung).toEqual({ kind: "unreachable" });
    expect(signal!.aborted).toBe(true);

    const stalled = await checkAddress("https://proto.example.com/", {
      timeoutMs: 100,
      resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
      fetchPinned: async () =>
        response({
          status: 200,
          body: async function* () {
            yield new TextEncoder().encode(NEXT_PAGE);
            await new Promise(() => undefined);
          },
        }),
    });
    expect(stalled).toEqual({ kind: "unreachable" });
  });

  test(`reads at most ${MAX_ADDRESS_BODY_BYTES / 1024} KB of the page, then stops reading`, async () => {
    const CHUNK = 100 * 1024;
    /** An endless page with the Next.js marker at `at` bytes; counts chunks read and whether reading was stopped. */
    const endless = (at: number) => {
      const state = { chunks: 0, stopped: false };
      const page: FakePage = {
        status: 200,
        headers: { "content-type": "text/html" },
        body: async function* () {
          try {
            for (let offset = 0; ; offset += CHUNK) {
              state.chunks++;
              const chunk = new Uint8Array(CHUNK).fill(0x61);
              if (at >= offset && at < offset + CHUNK) chunk.set(new TextEncoder().encode('<script id="__NEXT_DATA__">').subarray(0, offset + CHUNK - at), at - offset);
              yield chunk;
            }
          } finally {
            state.stopped = true;
          }
        },
      };
      return { state, page };
    };
    const within = endless(MAX_ADDRESS_BODY_BYTES - 40);
    expect(await checkAddress("https://big.example.com/", network({ "big.example.com": [PUBLIC_IP] }, { "https://big.example.com/": within.page }).deps)).toEqual({ kind: "public", stack: "next" });
    expect(within.state).toEqual({ chunks: 3, stopped: true });

    const beyond = endless(MAX_ADDRESS_BODY_BYTES + 10);
    expect(await checkAddress("https://big.example.com/", network({ "big.example.com": [PUBLIC_IP] }, { "https://big.example.com/": beyond.page }).deps)).toEqual({ kind: "public", stack: null });
    expect(beyond.state).toEqual({ chunks: 3, stopped: true });
  });
});

describe("what someone can type", () => {
  const refused = async (input: string, message: RegExp) => {
    const net = network({}, {});
    const error = await checkAddress(input, net.deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CritiqsError);
    expect((error as CritiqsError).code).toBe("invalid");
    expect((error as CritiqsError).message).toMatch(message);
    expect(net.lookups).toEqual([]);
  };

  test("refuses a username or password in the address", async () => {
    await refused("https://user:secret@proto.example.com/", /username and password/);
    await refused("https://user@proto.example.com/", /username and password/);
  });

  test("refuses other schemes", async () => {
    for (const input of ["ftp://proto.example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ws://proto.example.com/", "localhost:3000"]) {
      await refused(input, /starts with https:\/\/ or http:\/\//);
    }
  });

  test("refuses empty, partial, and overlong input", async () => {
    await refused("   ", /Enter your prototype's address/);
    await refused("proto.example.com", /full address/);
    await refused(`https://proto.example.com/${"a".repeat(2_000)}`, /at most 2000 characters/);
  });
});

describe("the operation", () => {
  test("refuses invalid input before counting a check, and counts before fetching", async () => {
    const events: string[] = [];
    const net = network({ "proto.example.com": [PUBLIC_IP] }, { "https://proto.example.com/": { status: 200 } });
    const deps: AddressCheckDeps = { ...net.deps, resolve: async (host, signal) => (events.push("resolve"), await net.deps.resolve(host, signal)) };
    const claim = async () => void events.push("claim");
    await expect(checkPrototypeAddress({ claim, deps }, { address: "ftp://proto.example.com" })).rejects.toThrow(CritiqsError);
    expect(events).toEqual([]);
    expect(await checkPrototypeAddress({ claim, deps }, { address: "https://proto.example.com" })).toEqual({ kind: "public", stack: null });
    expect(events).toEqual(["claim", "resolve"]);
  });

  test(`runs at most ${MAX_CONCURRENT_ADDRESS_CHECKS} checks at once; another fails fast, uncounted`, async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let claims = 0;
    const claim = async () => void claims++;
    const deps: AddressCheckDeps = {
      resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
      fetchPinned: async () => {
        await gate;
        return response({ status: 200 });
      },
    };
    const check = (address: string) => checkPrototypeAddress({ claim, deps }, { address });
    const running = Array.from({ length: MAX_CONCURRENT_ADDRESS_CHECKS }, () => check("https://proto.example.com"));

    const error = await check("https://proto.example.com").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CritiqsError);
    expect(error).toMatchObject({ code: "limit", message: "Critiqs is busy checking other addresses. Try again in a moment, or skip this step." });
    expect(claims).toBe(MAX_CONCURRENT_ADDRESS_CHECKS);
    // A local address needs no network, so it isn't held back.
    expect(await check("http://localhost:3000")).toEqual({ kind: "local" });

    open();
    expect(await Promise.all(running)).toEqual(new Array(MAX_CONCURRENT_ADDRESS_CHECKS).fill({ kind: "public", stack: null }));
    expect(await check("https://proto.example.com")).toEqual({ kind: "public", stack: null });
  });

  test("a check that fails still frees its place", async () => {
    const deps: AddressCheckDeps = { resolve: async () => Promise.reject(new Error("SERVFAIL")), fetchPinned: async () => response({ status: 200 }) };
    const claim = async () => undefined;
    for (let i = 0; i < MAX_CONCURRENT_ADDRESS_CHECKS + 1; i++) {
      expect(await checkPrototypeAddress({ claim, deps }, { address: "https://proto.example.com" })).toEqual({ kind: "unreachable" });
    }
    const refused = () => Promise.reject(new CritiqsError("limit", "You've checked 20 addresses this hour."));
    for (let i = 0; i < MAX_CONCURRENT_ADDRESS_CHECKS + 1; i++) {
      await expect(checkPrototypeAddress({ claim: refused, deps }, { address: "https://proto.example.com" })).rejects.toThrow("20 addresses");
    }
    expect(await checkPrototypeAddress({ claim, deps: { ...deps, resolve: async () => [{ address: PUBLIC_IP, family: 4 }] } }, { address: "https://proto.example.com" })).toEqual({
      kind: "public",
      stack: null,
    });
  });

  test("a refused claim, such as a limit, fetches nothing", async () => {
    const net = network({ "proto.example.com": [PUBLIC_IP] }, {});
    const claim = () => Promise.reject(new CritiqsError("limit", "You've checked 20 addresses this hour."));
    await expect(checkPrototypeAddress({ claim, deps: net.deps }, { address: "https://proto.example.com" })).rejects.toThrow("20 addresses");
    expect(net.lookups).toEqual([]);
  });
});
