import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_LIMITS, parseProxyConfig, proxyPolicy, siteOf } from "../src/config.ts";
import { cachedReputation, fixtureReputation, noReputation, webRiskProvider, WEB_RISK_ENDPOINT } from "../src/reputation.ts";
import { keyedSlots, slots, windowCounter } from "../src/limits.ts";

const LOCAL = {
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://convex.localhost:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
};

describe("parseProxyConfig", () => {
  test("a local stack", () => {
    const config = parseProxyConfig(LOCAL);
    expect(config.domain.host).toBe("review.localhost:5120");
    expect(config.local).toBe(true);
    expect(config.webOrigins).toEqual(["http://web.localhost:5110"]);
    expect(config.userAgent).toBe("Critiqs-Review/1 (+http://web.localhost:5110/allow-critiqs)");
    expect(config.assetUserAgent).toBe("Critiqs-Asset/1");
    expect(config.webRiskKey).toBeNull();
    expect(config.limits).toEqual(DEFAULT_LIMITS);
  });

  const refused: [string, Record<string, string>][] = [
    ["no domain", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "" }],
    ["a domain with a path", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120/x" }],
    ["http on a public domain", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "http://critiqs-review.net", CRITIQS_WEB_RISK_API_KEY: "k" }],
    ["a single-label domain", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "http://localhost:5120" }],
    ["no website", { ...LOCAL, CRITIQS_WEB_ORIGINS: "" }],
    ["the website's own site", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "https://review.critiqs.app", CRITIQS_WEB_ORIGINS: "https://critiqs.app", CRITIQS_PROXY_BACKEND: "https://x.convex.site", CRITIQS_WEB_RISK_API_KEY: "k" }],
    ["the backend's own site", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "https://review.convex.site", CRITIQS_WEB_ORIGINS: "https://critiqs.app", CRITIQS_PROXY_BACKEND: "https://x.convex.site", CRITIQS_WEB_RISK_API_KEY: "k" }],
    ["a short secret", { ...LOCAL, CRITIQS_PROXY_SECRET: "short" }],
    ["a malformed egress block", { ...LOCAL, CRITIQS_PROXY_EGRESS: "203.0.113.10/33" }],
    ["a public domain without a reputation key", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net", CRITIQS_WEB_ORIGINS: "https://critiqs.app", CRITIQS_PROXY_BACKEND: "https://x.convex.site", CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list" }],
    ["a limit that isn't a number", { ...LOCAL, CRITIQS_PROXY_LIMIT_ASSET_BYTES: "lots" }],
    ["a public domain without a cookie isolation setting", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net", CRITIQS_WEB_ORIGINS: "https://critiqs.app", CRITIQS_PROXY_BACKEND: "https://x.convex.site", CRITIQS_WEB_RISK_API_KEY: "k" }],
    ["a public domain with an unknown cookie isolation setting", { ...LOCAL, CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net", CRITIQS_WEB_ORIGINS: "https://critiqs.app", CRITIQS_PROXY_BACKEND: "https://x.convex.site", CRITIQS_WEB_RISK_API_KEY: "k", CRITIQS_PROXY_COOKIE_ISOLATION: "yes" }],
  ];
  for (const [name, env] of refused) test(`refuses ${name}`, () => expect(() => parseProxyConfig(env)).toThrow(ConfigError));

  test("the cookie isolation refusal names every browser and the front servers that can't help", () => {
    let message = "";
    try {
      parseProxyConfig({ ...LOCAL, CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net", CRITIQS_WEB_ORIGINS: "https://critiqs.app", CRITIQS_PROXY_BACKEND: "https://x.convex.site", CRITIQS_WEB_RISK_API_KEY: "k" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Chrome");
    expect(message).toContain("Firefox");
    expect(message).toMatch(/managed|before .*rule/i);
  });

  test("a production stack", () => {
    const config = parseProxyConfig({
      CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
      CRITIQS_WEB_ORIGINS: "https://critiqs.app, https://www.critiqs.app",
      CRITIQS_PROXY_BACKEND: "https://brazen-snail-591.convex.site",
      CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
      CRITIQS_PROXY_EGRESS: "203.0.113.10/32, 2001:db8::/48",
      CRITIQS_WEB_RISK_API_KEY: "key",
      CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list",
    });
    expect(config.local).toBe(false);
    expect(config.cookieIsolation).toBe("public-suffix-list");
    expect(config.egress).toEqual(["203.0.113.10/32", "2001:db8::/48"]);
    expect(proxyPolicy(config)).toEqual({
      blockedHosts: ["critiqs-review.net", "critiqs.app", "www.critiqs.app", "brazen-snail-591.convex.site", "brazen-snail-591.convex.cloud"],
      blockedCidrs: ["203.0.113.10/32", "2001:db8::/48"],
      denyTransitionIpv6: true,
    });
  });

  test("settings can lower a limit, never raise it", () => {
    expect(parseProxyConfig({ ...LOCAL, CRITIQS_PROXY_LIMIT_ASSET_BYTES: "1024" }).limits.assetBytes).toBe(1024);
    expect(parseProxyConfig({ ...LOCAL, CRITIQS_PROXY_LIMIT_ASSET_BYTES: String(1024 ** 4) }).limits.assetBytes).toBe(DEFAULT_LIMITS.assetBytes);
  });

  test("siteOf", () => {
    expect(siteOf("v-abc.review.localhost")).toBe("review.localhost");
    expect(siteOf("web.localhost")).toBe("web.localhost");
    expect(siteOf("App.Critiqs.App.")).toBe("critiqs.app");
  });
});

describe("reputation", () => {
  test("Web Risk: a threat is unsafe, an empty answer is safe, the key stays out of the URL", async () => {
    const calls: { url: string; key: string | null }[] = [];
    const provider = webRiskProvider("secret-key", async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, key: new Headers(init?.headers).get("x-goog-api-key") });
      const unsafe = url.searchParams.get("uri") === "https://evil.example/login";
      return Response.json(unsafe ? { threat: { threatTypes: ["SOCIAL_ENGINEERING"], expireTime: "2026-12-01T00:00:00Z" } } : {});
    });
    const verdicts = await provider.lookup(["https://evil.example/login", "https://fine.example/"], AbortSignal.timeout(1_000));
    expect([...verdicts]).toEqual([
      ["https://evil.example/login", "unsafe"],
      ["https://fine.example/", "safe"],
    ]);
    expect(calls[0]!.url.startsWith(`${WEB_RISK_ENDPOINT}?`)).toBe(true);
    expect(calls[0]!.url).toContain("threatTypes=SOCIAL_ENGINEERING");
    expect(calls[0]!.url).not.toContain("secret-key");
    expect(calls[0]!.key).toBe("secret-key");
  });

  test("Web Risk errors fail closed", async () => {
    for (const reply of [new Response("no", { status: 503 }), new Response("not json"), Response.json(null)]) {
      const check = cachedReputation(webRiskProvider("k", async () => reply.clone()));
      expect(await check.allows(new URL("https://fine.example/"), AbortSignal.timeout(1_000))).toBe(false);
    }
  });

  test("answers are cached for their time; errors are not cached", async () => {
    let time = 0;
    let calls = 0;
    let down = false;
    const check = cachedReputation(
      {
        lookup: async (keys) => {
          calls++;
          if (down) throw new Error("down");
          return new Map(keys.map((key) => [key, "safe"] as const));
        },
      },
      { safeMs: 1_000, now: () => time },
    );
    const url = new URL("https://fine.example/a?x=1");
    expect(await check.allows(url, AbortSignal.timeout(1_000))).toBe(true);
    expect(await check.allows(new URL("https://fine.example/a?y=2"), AbortSignal.timeout(1_000))).toBe(true);
    expect(calls).toBe(1);
    time = 2_000;
    down = true;
    expect(await check.allows(url, AbortSignal.timeout(1_000))).toBe(false);
    down = false;
    expect(await check.allows(url, AbortSignal.timeout(1_000))).toBe(true);
    expect(calls).toBe(3);
  });

  test("no provider refuses everything; the fixture refuses what it lists", async () => {
    expect(await cachedReputation(noReputation).allows(new URL("https://fine.example/"), AbortSignal.timeout(1_000))).toBe(false);
    const fixture = cachedReputation(fixtureReputation(["https://evil.example"]));
    expect(await fixture.allows(new URL("https://evil.example/any"), AbortSignal.timeout(1_000))).toBe(false);
    expect(await fixture.allows(new URL("https://fine.example/"), AbortSignal.timeout(1_000))).toBe(true);
  });
});

describe("limits", () => {
  test("slots refuse past their maximum and free on release", () => {
    const pool = slots(2);
    const a = pool.take()!;
    pool.take();
    expect(pool.take()).toBeNull();
    a();
    a();
    expect(pool.used).toBe(1);
    expect(pool.take()).not.toBeNull();
  });

  test("keyed slots are per key", () => {
    const pool = keyedSlots(1);
    const a = pool.take("a")!;
    expect(pool.take("a")).toBeNull();
    expect(pool.take("b")).not.toBeNull();
    a();
    expect(pool.used("a")).toBe(0);
  });

  test("a window counts requests and bytes, and starts over", () => {
    let time = 0;
    const counter = windowCounter({ windowMs: 1_000, requests: 2, bytes: 100 }, () => time);
    expect(counter.admit("lease")).toBe(true);
    expect(counter.admit("lease")).toBe(true);
    expect(counter.admit("lease")).toBe(false);
    expect(counter.admit("other")).toBe(true);
    counter.addBytes("other", 100);
    expect(counter.admit("other")).toBe(false);
    time = 1_000;
    expect(counter.admit("lease")).toBe(true);
    expect(counter.usage("lease")).toEqual({ requests: 1, bytes: 0 });
  });
});
