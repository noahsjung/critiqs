import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isIdentityProvider, isLocalAddress } from "@critiqs/core";
import { acceptableAddress, isBlockedHost } from "@critiqs/server/public-web";
import { ConfigError, DEFAULT_LIMITS, parseProxyConfig, proxyPolicy } from "../src/config.ts";
import { createEgress, type EgressRequest, refusedLocally } from "../src/egress.ts";
import { cachedReputation, fixtureReputation, type ReputationProvider, reputationKey } from "../src/reputation.ts";
import { close, listen, PUBLIC_A, recordingServer, testWeb, v4 } from "./fixtures.ts";

// Attacks the two security reviews of the network layer found, each one
// reproduced here against the real egress, policy and settings:
//
// - a host written with trailing dots (`evil.example.`, `localhost..`) is the
//   same host to DNS, so it must be the same host to every check;
// - a request's class must not decide whether the reputation check looks at
//   the path: a primary-origin fetch of any kind is checked by its path;
// - settings for a public deployment refuse plain http for the website and
//   the backend;
// - the backend's deployment is refused under both of Convex's names.

const LOCAL = {
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
};
const PUBLIC = {
  CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
  CRITIQS_WEB_ORIGINS: "https://critiqs.app",
  CRITIQS_PROXY_BACKEND: "https://brazen-snail-591.convex.site",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
  CRITIQS_WEB_RISK_API_KEY: "test-key",
  CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list",
  CRITIQS_PROXY_SIGNING_KEY: "a-signing-key-that-is-long-enough-to-pass",
  CRITIQS_PROXY_CLIENT_IP_HEADER: "cf-connecting-ip",
};

const config = parseProxyConfig(LOCAL);
const policy = proxyPolicy(config);
const site = recordingServer((request, response) => {
  if (request.url === "/to-sign-in") {
    response.writeHead(302, { Location: "https://accounts.google.com./o/oauth2/auth" });
    return void response.end();
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<h1>served</h1>");
});
let port = 0;
beforeAll(async () => {
  port = await listen(site.server);
});
afterAll(async () => {
  await close(site.server);
});

const web = () => testWeb({ "proto.example.com": [v4(PUBLIC_A)], "proto.example.com.": [v4(PUBLIC_A)], "evil.example": [v4(PUBLIC_A)], "evil.example.": [v4(PUBLIC_A)] }, { [PUBLIC_A]: port });
const egress = (provider: ReputationProvider, scope?: "path" | "origin") =>
  createEgress({ web: web(), policy, reputation: cachedReputation(provider), userAgent: config.userAgent, limits: DEFAULT_LIMITS, ...(scope === undefined ? {} : { reputationScope: scope }) } as never);
const get = (url: string, overrides: Partial<EgressRequest> = {}): EgressRequest => {
  const parsed = new URL(url);
  return { url: parsed, method: "GET", class: "document", origin: parsed.origin, signal: AbortSignal.timeout(5_000), ...overrides };
};

describe("one host, however it is written (F-H1-2, note 7)", () => {
  test("a trailing dot doesn't get past an unsafe verdict on the host", async () => {
    const outcome = await egress(fixtureReputation(["https://evil.example"])).fetch(get("https://evil.example./page"));
    expect(outcome).toEqual({ kind: "refused", reason: "unsafe" });
  });
  test("a trailing dot doesn't get past an unsafe verdict on a path", async () => {
    const outcome = await egress(fixtureReputation(["https://evil.example/phish"])).fetch(get("https://evil.example./phish"));
    expect(outcome).toEqual({ kind: "refused", reason: "unsafe" });
  });
  test("a redirect to an identity provider written with a trailing dot is still a sign-in", async () => {
    const outcome = await egress(fixtureReputation()).fetch(get("http://proto.example.com/to-sign-in"));
    expect(outcome).toEqual({ kind: "left", url: "https://accounts.google.com", signIn: true });
  });
  for (const address of ["http://localhost../", "http://devbox../", "http://printer.local../"]) {
    test(`${address} is refused before DNS`, () => {
      expect(refusedLocally(new URL(address), policy)).toBe("unreachable");
      expect(isLocalAddress(new URL(address))).toBe(true);
    });
  }
  test("a host with an empty label is refused, and is no address at all", () => {
    expect(refusedLocally(new URL("https://proto..example.com/"), policy)).toBe("unreachable");
    expect(acceptableAddress("https://proto..example.com/")).toBe("malformed");
    expect(acceptableAddress("http://localhost../")).toBe("malformed");
    expect((acceptableAddress("https://Proto.Example.com./a") as URL).href).toBe("https://proto.example.com/a");
  });
  test("the proxy's own hosts written with two trailing dots are refused", () => {
    expect(isBlockedHost("v-aaaaaaaaaaaaaaaaaaaaaaaaaa.review.localhost..", policy)).toBe(true);
  });
  test("the reputation key is the same for every spelling of a host, asked directly", async () => {
    expect(reputationKey(new URL("https://Evil.Example./page"))).toBe(reputationKey(new URL("https://evil.example/page")));
    expect(await cachedReputation(fixtureReputation(["https://evil.example"])).allows(new URL("https://evil.example./page"), AbortSignal.timeout(1_000))).toBe(false);
  });
  test("an identity provider's host with a trailing dot is one", () => {
    expect(isIdentityProvider(new URL("https://accounts.google.com./x"))).toBe(true);
    expect(isIdentityProvider(new URL("https://tenant.okta.com./x"))).toBe(true);
  });
});

describe("the path is checked on every primary-origin request (F-H1-1)", () => {
  for (const requestClass of ["data", "script", "style", "image", "font", "media"] as const) {
    test(`a ${requestClass} request for an unsafe path on a clean origin is refused`, async () => {
      const outcome = await egress(fixtureReputation(["https://proto.example.com/phish"]), "path").fetch(get("https://proto.example.com/phish", { class: requestClass }));
      expect(outcome).toEqual({ kind: "refused", reason: "unsafe" });
    });
  }
});

describe("a public deployment's settings (F-H1-3)", () => {
  test("refuse a plain-http website origin", () => {
    expect(() => parseProxyConfig({ ...PUBLIC, CRITIQS_WEB_ORIGINS: "http://critiqs.app" })).toThrow(ConfigError);
    expect(() => parseProxyConfig({ ...PUBLIC, CRITIQS_WEB_ORIGINS: "https://critiqs.app,http://www.critiqs.app" })).toThrow(ConfigError);
  });
  test("refuse a plain-http backend", () => {
    expect(() => parseProxyConfig({ ...PUBLIC, CRITIQS_PROXY_BACKEND: "http://brazen-snail-591.convex.site" })).toThrow(ConfigError);
  });
  test("refuse a website on the proxy's site written with a trailing dot", () => {
    expect(() => parseProxyConfig({ ...PUBLIC, CRITIQS_WEB_ORIGINS: "https://critiqs-review.net." })).toThrow(ConfigError);
  });
});

describe("the backend under both of Convex's names (N3)", () => {
  test("a .convex.site backend also refuses its .convex.cloud name", () => {
    const deployed = proxyPolicy(parseProxyConfig(PUBLIC));
    expect(isBlockedHost("brazen-snail-591.convex.site", deployed)).toBe(true);
    expect(isBlockedHost("brazen-snail-591.convex.cloud", deployed)).toBe(true);
    expect(isBlockedHost("other-deployment-1.convex.cloud", deployed)).toBe(false);
  });
});
