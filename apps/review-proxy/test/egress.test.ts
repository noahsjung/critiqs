import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { createEgress, type EgressOutcome, type EgressRequest } from "../src/egress.ts";
import { cachedReputation, fixtureReputation, noReputation, type ReputationProvider } from "../src/reputation.ts";
import { close, listen, PUBLIC_A, PUBLIC_B, recordingServer, testWeb, text, type TestWeb, v4, v6 } from "./fixtures.ts";

// The egress attack tests (AT-1 to AT-5 and AT-8 in the review-link design):
// every refusal happens before any socket opens to a refused address, and the
// counting listener behind 127.0.0.1 is never reached.

const config = parseProxyConfig({
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
  CRITIQS_PROXY_EGRESS: "8.8.8.0/24,2001:4860::/32",
});
const policy = proxyPolicy(config);

// The prototype ("public"), and a listener standing for every private address.
const site = recordingServer((request, response) => {
  const path = request.url ?? "/";
  const kind = path.startsWith("/redirect/") ? path.split("/")[2]! : "";
  if (path.startsWith("/redirect/") && kind !== "landed") {
    const target: Record<string, string> = {
      same: "/landed",
      relative: "landed",
      private: "http://169.254.169.254/latest/meta-data/",
      loopback: "http://127.0.0.1/",
      port: "http://proto.example.com:8080/",
      cross: "https://elsewhere.example.net/page",
      upgrade: "https://proto.example.com/landed",
      signin: "https://accounts.google.com/o/oauth2/auth?client_id=secret-query",
      loop: "/redirect/loop",
      chain1: "/redirect/chain2",
      chain2: "/redirect/chain3",
      chain3: "/landed",
      chain4: "/redirect/chain1",
      scheme: "ftp://proto.example.com/",
    };
    response.writeHead(302, { Location: target[kind] ?? "/landed" });
    return void response.end();
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<html>${path}</html>`);
});
const privateListener = recordingServer((_request, response) => response.end("private"));
let sitePort = 0;
let privatePort = 0;

beforeAll(async () => {
  sitePort = await listen(site.server);
  privatePort = await listen(privateListener.server);
});
afterAll(async () => {
  await close(site.server);
  await close(privateListener.server);
});

function network(names: Record<string, Parameters<typeof testWeb>[0][string]> = {}): TestWeb {
  return testWeb(
    { "proto.example.com": [v4(PUBLIC_A)], ...names },
    // The "public" address reaches the site; every private one would reach the counting listener.
    { [PUBLIC_A]: sitePort, [PUBLIC_B]: sitePort, "127.0.0.1": privatePort, "::1": privatePort, "169.254.169.254": privatePort, "10.0.0.1": privatePort },
  );
}

function egress(web: TestWeb, provider: ReputationProvider = fixtureReputation()) {
  return createEgress({ web, policy, reputation: cachedReputation(provider), userAgent: config.userAgent, limits: DEFAULT_LIMITS });
}

function get(url: string, overrides: Partial<EgressRequest> = {}): EgressRequest {
  const parsed = new URL(url);
  return { url: parsed, method: "GET", class: "document", origin: parsed.origin, signal: AbortSignal.timeout(5_000), ...overrides };
}

async function body(outcome: EgressOutcome): Promise<string | EgressOutcome> {
  return outcome.kind === "response" ? await text(outcome.body) : outcome;
}

describe("AT-1: private and special addresses are refused before any socket", () => {
  const literals = [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://0x7f.1/",
    "http://2130706433/",
    "http://100.64.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:8.8.4.4]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    // Transition addresses carrying a public IPv4 address: refused too, by the proxy's policy.
    "http://[64:ff9b::5db8:d70e]/",
    "http://[2002:5db8:d70e::]/",
    "http://[fd7a:115c:a1e0::1]/",
    "http://[fe80::1]/",
    "http://foo.ts.net/",
    "http://devbox/",
    "http://x.internal/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://printer.local/",
    "http://localhost/",
    "http://app.localhost/",
  ];
  for (const address of literals) {
    test(address, async () => {
      const web = network();
      expect(await egress(web).fetch(get(address))).toEqual({ kind: "refused", reason: "unreachable" });
      // Refused by the address or name alone: no DNS question, no connection.
      expect(web.resolved).toEqual([]);
      expect(web.connected).toEqual([]);
    });
  }

  for (const [name, answers] of [
    ["a public name pointing at loopback", [v4("127.0.0.1")]],
    ["a public name pointing at cloud metadata", [v4("169.254.169.254")]],
    ["a public name pointing at a private network", [v4("10.0.0.1")]],
    ["a public name pointing at CGNAT", [v4("100.64.1.2")]],
    ["a public name pointing at unique-local IPv6", [v6("fd00::1")]],
    ["a public name pointing at NAT64", [v6("64:ff9b::5db8:d70e")]],
    ["a public name with no addresses", []],
  ] as const) {
    test(name, async () => {
      const web = network({ "trick.example.com": answers });
      expect(await egress(web).fetch(get("http://trick.example.com/"))).toEqual({ kind: "refused", reason: "unreachable" });
      expect(web.resolved).toEqual(["trick.example.com"]);
      expect(web.connected).toEqual([]);
      expect(privateListener.requests).toHaveLength(0);
    });
  }

  test("a positive control: a public name reaches the site", async () => {
    const web = network();
    expect(await body(await egress(web).fetch(get("http://proto.example.com/hello")))).toBe("<html>/hello</html>");
    expect(web.connected).toEqual([PUBLIC_A]);
  });
});

describe("AT-2: DNS rebinding reaches only the checked address", () => {
  test("a name that answers public, then private, is resolved once and connected to the public address", async () => {
    const web = network({ "rebind.example.com": (call) => (call === 1 ? [v4(PUBLIC_A)] : [v4("127.0.0.1")]) });
    expect(await body(await egress(web).fetch(get("http://rebind.example.com/")))).toBe("<html>/</html>");
    expect(web.resolved).toEqual(["rebind.example.com"]);
    expect(web.connected).toEqual([PUBLIC_A]);
    expect(privateListener.requests).toHaveLength(0);
  });

  test("a name with a public A record and a private AAAA record is refused", async () => {
    const web = network({ "mixed.example.com": [v4(PUBLIC_A), v6("::1")] });
    expect(await egress(web).fetch(get("http://mixed.example.com/"))).toEqual({ kind: "refused", reason: "unreachable" });
    expect(web.connected).toEqual([]);
    expect(privateListener.requests).toHaveLength(0);
  });

  test("each redirect hop is resolved again and checked again", async () => {
    // The first hop is public; by the second, the name points inside.
    const web = network({ "proto.example.com": (call) => (call === 1 ? [v4(PUBLIC_A)] : [v4("10.0.0.1")]) });
    expect(await egress(web).fetch(get("http://proto.example.com/redirect/same"))).toEqual({ kind: "refused", reason: "unreachable" });
    expect(web.connected).toEqual([PUBLIC_A]);
    expect(privateListener.requests).toHaveLength(0);
  });
});

describe("AT-3: the proxy never fetches itself or Critiqs's own services", () => {
  for (const address of [
    "http://review.localhost/",
    "https://v-abcdefghijklmnopqrstuvwxyz.review.localhost/",
    "http://web.localhost/",
    "http://convex.localhost/",
  ]) {
    test(address, async () => {
      const web = network();
      expect(await egress(web).fetch(get(address))).toEqual({ kind: "refused", reason: "unreachable" });
      expect(web.resolved).toEqual([]);
      expect(web.connected).toEqual([]);
    });
  }

  test("public deployment names for the proxy, website and backend are refused by name, before DNS", async () => {
    const production = proxyPolicy(
      parseProxyConfig({
        CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
        CRITIQS_WEB_ORIGINS: "https://critiqs.app",
        CRITIQS_PROXY_BACKEND: "https://brazen-snail-591.convex.site",
        CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
        CRITIQS_WEB_RISK_API_KEY: "test",
      }),
    );
    for (const address of ["https://critiqs-review.net/", "https://v-x.critiqs-review.net/", "https://critiqs.app/r/key", "https://brazen-snail-591.convex.site/internal/review/v1/resolve", "https://CRITIQS.APP./"]) {
      const web = network({ "critiqs-review.net": [v4(PUBLIC_A)], "critiqs.app": [v4(PUBLIC_A)], "brazen-snail-591.convex.site": [v4(PUBLIC_A)] });
      const out = createEgress({ web, policy: production, reputation: cachedReputation(fixtureReputation()), userAgent: "x", limits: DEFAULT_LIMITS });
      expect(await out.fetch(get(address))).toEqual({ kind: "refused", reason: "unreachable" });
      expect(web.resolved).toEqual([]);
    }
  });

  test("a name resolving into the proxy's own egress blocks is refused", async () => {
    for (const answers of [[v4("8.8.8.8")], [v6("2001:4860:4860::8888")]]) {
      const web = network({ "loop.example.com": answers });
      expect(await egress(web).fetch(get("http://loop.example.com/"))).toEqual({ kind: "refused", reason: "unreachable" });
      expect(web.connected).toEqual([]);
    }
  });
});

describe("AT-4: other ports, credentials and schemes are refused", () => {
  for (const address of ["http://proto.example.com:22/", "http://proto.example.com:8080/", "https://proto.example.com:8443/", "http://user:pass@proto.example.com/", "http://user@proto.example.com/", "ftp://proto.example.com/", "file:///etc/passwd", "gopher://proto.example.com/"]) {
    test(address, async () => {
      const web = network();
      expect(await egress(web).fetch(get(address, { origin: "http://proto.example.com" }))).toEqual({ kind: "refused", reason: "unreachable" });
      expect(web.resolved).toEqual([]);
      expect(web.connected).toEqual([]);
    });
  }
});

describe("AT-5: redirects are followed on the server, at most three, within one origin", () => {
  test("a same-origin redirect is followed and the final URL reported", async () => {
    const web = network();
    const outcome = await egress(web).fetch(get("http://proto.example.com/redirect/same"));
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.url.href).toBe("http://proto.example.com/landed");
    expect(outcome.status).toBe(200);
    // The upstream Location never reaches the caller as a header to pass on.
    expect(await text(outcome.body)).toBe("<html>/landed</html>");
  });

  test("a relative Location resolves against the hop that sent it", async () => {
    const outcome = await egress(network()).fetch(get("http://proto.example.com/redirect/relative"));
    expect(outcome.kind === "response" && outcome.url.href).toBe("http://proto.example.com/redirect/landed");
  });

  test("three hops are followed; a fourth is refused", async () => {
    const three = await egress(network()).fetch(get("http://proto.example.com/redirect/chain1"));
    expect(three.kind === "response" && three.url.pathname).toBe("/landed");
    const web = network();
    expect(await egress(web).fetch(get("http://proto.example.com/redirect/chain4"))).toEqual({ kind: "refused", reason: "unreachable" });
    expect(web.connected).toHaveLength(4);
    expect(await egress(network()).fetch(get("http://proto.example.com/redirect/loop"))).toEqual({ kind: "refused", reason: "unreachable" });
  });

  for (const [kind, expected] of [
    ["private", { kind: "left", url: "http://169.254.169.254", signIn: false }],
    ["loopback", { kind: "left", url: "http://127.0.0.1", signIn: false }],
    ["port", { kind: "left", url: "http://proto.example.com:8080", signIn: false }],
    ["cross", { kind: "left", url: "https://elsewhere.example.net", signIn: false }],
    ["upgrade", { kind: "left", url: "https://proto.example.com", signIn: false }],
    ["signin", { kind: "left", url: "https://accounts.google.com", signIn: true }],
    ["scheme", { kind: "refused", reason: "unreachable" }],
  ] as const) {
    test(`a page redirected to ${kind} stops without dialing it`, async () => {
      const web = network({ "elsewhere.example.net": [v4(PUBLIC_B)], "accounts.google.com": [v4(PUBLIC_B)] });
      expect(await egress(web).fetch(get(`http://proto.example.com/redirect/${kind}`))).toEqual(expected as EgressOutcome);
      // Only the first hop was dialed; the target never was, and the query of a sign-in URL never leaves.
      expect(web.connected).toEqual([PUBLIC_A]);
      expect(web.resolved).toEqual(["proto.example.com"]);
      expect(privateListener.requests).toHaveLength(0);
    });
  }

  test("an asset redirected to another origin is refused, not reported", async () => {
    const web = network({ "elsewhere.example.net": [v4(PUBLIC_B)] });
    expect(await egress(web).fetch(get("http://proto.example.com/redirect/cross", { class: "image" }))).toEqual({ kind: "refused", reason: "unreachable" });
    expect(web.connected).toEqual([PUBLIC_A]);
  });
});

describe("AT-8: the reputation check fails closed", () => {
  test("an address the provider calls unsafe is never dialed", async () => {
    const web = network();
    expect(await egress(web, fixtureReputation(["http://proto.example.com/phish"])).fetch(get("http://proto.example.com/phish"))).toEqual({ kind: "refused", reason: "unsafe" });
    expect(web.resolved).toEqual([]);
    expect(web.connected).toEqual([]);
  });

  test("a redirect into an unsafe path is stopped at that hop", async () => {
    const web = network();
    expect(await egress(web, fixtureReputation(["http://proto.example.com/landed"])).fetch(get("http://proto.example.com/redirect/same"))).toEqual({ kind: "refused", reason: "unsafe" });
    expect(web.connected).toEqual([PUBLIC_A]);
  });

  test("an asset host the provider calls unsafe is refused for every file on it", async () => {
    const web = network();
    expect(await egress(web, fixtureReputation(["http://proto.example.com"])).fetch(get("http://proto.example.com/logo.png", { class: "image" }))).toEqual({ kind: "refused", reason: "unsafe" });
    expect(web.connected).toEqual([]);
  });

  test("with no provider, or one that is down, nothing uncached is fetched", async () => {
    for (const provider of [noReputation, { lookup: async () => Promise.reject(new Error("503")) }, { lookup: async () => new Map() }]) {
      const web = network();
      expect(await egress(web, provider).fetch(get("http://proto.example.com/"))).toEqual({ kind: "refused", reason: "unsafe" });
      expect(web.connected).toEqual([]);
    }
  });

  test("the provider sees the origin and path, never the query or fragment", async () => {
    const asked: string[] = [];
    const provider: ReputationProvider = { lookup: async (keys) => (asked.push(...keys), new Map(keys.map((key) => [key, "safe"] as const))) };
    await egress(network(), provider).fetch(get("http://proto.example.com/account?token=secret#frag"));
    expect(asked).toEqual(["http://proto.example.com/account"]);
  });
});

test("a browser that goes away aborts the request", async () => {
  const controller = new AbortController();
  controller.abort();
  const web = network();
  expect(await egress(web).fetch(get("http://proto.example.com/", { signal: controller.signal }))).toEqual({ kind: "refused", reason: "unreachable" });
  expect(web.connected).toEqual([]);
});
