import { describe, expect, test } from "bun:test";
import { frameHostHash } from "@critiqs/server/review-links";
import { ConfigError, parseProxyConfig } from "../src/config.ts";
import { directoryFor } from "../src/directory.ts";

// The serve entry's directory: the backend's, asked with the proxy secret,
// unless a `.localhost` stack names test leases.

const LABEL = `v-${"c".repeat(26)}`;
const env = {
  CRITIQS_PROXY_DOMAIN: "http://review.localhost:5120",
  CRITIQS_WEB_ORIGINS: "http://web.localhost:5110",
  CRITIQS_PROXY_BACKEND: "http://127.0.0.1:5111",
  CRITIQS_PROXY_SECRET: "a-test-secret-that-is-long-enough-to-pass",
};

describe("the serve entry's directory", () => {
  test("asks the backend's resolve route with the secret and the host's hash, never the label", async () => {
    const asked: { url: string; authorization: string | null; body: string }[] = [];
    const directory = directoryFor(parseProxyConfig(env), {}, {
      fetch: async (url, init) => {
        asked.push({ url, authorization: new Headers(init.headers).get("authorization"), body: String(init.body) });
        return Response.json({ v: 1, kind: "site", linkId: "l1", leaseId: "s1", origin: "https://shop.example.com", assetOrigins: [], expiresAt: Date.now() + 60_000, cacheUntil: Date.now() + 5_000 });
      },
    });
    const resolution = await directory.resolve(LABEL);
    expect(resolution?.origin).toBe("https://shop.example.com");
    expect(asked).toEqual([{ url: "http://127.0.0.1:5111/internal/review/v1/resolve", authorization: `Bearer ${env.CRITIQS_PROXY_SECRET}`, body: JSON.stringify({ hostHash: await frameHostHash(LABEL) }) }]);
    expect(asked[0]!.body).not.toContain(LABEL);
  });

  test("serves nothing when the backend refuses", async () => {
    const directory = directoryFor(parseProxyConfig(env), {}, { fetch: async () => new Response("Not found", { status: 404 }) });
    expect(await directory.resolve(LABEL)).toBeNull();
  });

  test("test leases only on a .localhost domain", async () => {
    const lease = { label: LABEL, linkId: "l1", leaseId: "s1", origin: "https://shop.example.com", assetOrigins: [], expiresAt: Date.now() + 60_000 };
    const local = directoryFor(parseProxyConfig(env), { CRITIQS_PROXY_DEV_LEASES: JSON.stringify([lease]) });
    expect((await local.resolve(LABEL))?.leaseId).toBe("s1");
    const deployed = parseProxyConfig({
      ...env,
      CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
      CRITIQS_WEB_ORIGINS: "https://critiqs.app",
      CRITIQS_PROXY_BACKEND: "https://brazen.convex.site",
      CRITIQS_WEB_RISK_API_KEY: "k",
      CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list",
    });
    expect(() => directoryFor(deployed, { CRITIQS_PROXY_DEV_LEASES: JSON.stringify([lease]) })).toThrow(ConfigError);
  });

  test("a deployed proxy's backend must use https: refused with the settings, before any directory", () => {
    expect(() =>
      parseProxyConfig({
        ...env,
        CRITIQS_PROXY_DOMAIN: "https://critiqs-review.net",
        CRITIQS_WEB_ORIGINS: "https://critiqs.app",
        CRITIQS_PROXY_BACKEND: "http://brazen.convex.site",
        CRITIQS_WEB_RISK_API_KEY: "k",
        CRITIQS_PROXY_COOKIE_ISOLATION: "public-suffix-list",
      }),
    ).toThrow(ConfigError);
  });
});
