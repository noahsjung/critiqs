import { describe, expect, test } from "bun:test";
import { convexDirectory } from "../src/review-directory.ts";
import { frameHostHash, parseLiveAddress, parseProxyAddress, parseReviewResolution, proxySeparate, webRiskVerdict } from "../src/review-links.ts";

// Attacks the two security reviews found in the backend's review-link rules
// and the proxy's directory, each reproduced against the real functions.

const REFUSED = ["critiqs-review.net", "critiqs.app", "prod.convex.site", "prod.convex.cloud"];
const refusedMessage = (input: string) => {
  try {
    parseLiveAddress(input, REFUSED);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("F-H3-1: the proxy domain is its own site", () => {
  const cases: [string, string[]][] = [
    ["https://proxy.critiqs.app", ["https://app.critiqs.app"]],
    ["https://other.convex.site", ["https://prod.convex.site"]],
    ["https://critiqs.app.", ["https://critiqs.app"]],
    ["https://critiqs-review.net", ["https://www.critiqs-review.net."]],
  ];
  for (const [proxy, others] of cases) {
    test(`${proxy} beside ${others.join(", ")}`, () => {
      const address = parseProxyAddress(proxy);
      expect(address === null || !proxySeparate(address, others)).toBe(true);
    });
  }
  test("a separate site, and a .localhost proxy beside a localhost website, are fine", () => {
    expect(proxySeparate(parseProxyAddress("https://critiqs-review.net")!, ["https://critiqs.app", "https://prod.convex.site"])).toBe(true);
    expect(proxySeparate(parseProxyAddress("http://review.localhost:5260")!, ["http://localhost:5173"])).toBe(true);
  });
});

describe("F-H3-2 and Gemini note 5: a live address is one canonical public host", () => {
  for (const input of ["https://critiqs-review.net../", "https://unsafe.example../", "https://critiqs.app../x", "https://a..b.example/"]) {
    test(`${input} is refused`, () => expect(refusedMessage(input)).not.toBeNull());
  }
  for (const input of ["https://192.0.2.1/", "https://203.0.113.1/", "https://192.88.99.1/", "https://192.0.0.1/", "https://198.51.100.7/", "https://[2001:db8::1]/", "https://[64:ff9b::7f00:1]/"]) {
    test(`a non-public address ${input} is refused`, () => expect(refusedMessage(input)).not.toBeNull());
  }
  test("a start path beginning with // is refused", () => {
    expect(refusedMessage("https://proto.example//evil.example/x")).not.toBeNull();
  });
  test("a trailing dot is the same host", () => {
    expect(parseLiveAddress("https://Proto.Example./start", REFUSED)).toEqual({ origin: "https://proto.example", path: "/start" });
  });
  test("a Critiqs host under the backend's .convex.cloud name is refused", () => {
    expect(refusedMessage("https://prod.convex.cloud./x")).not.toBeNull();
  });
});

describe("Opus N6 and Gemini note 1: the Web Risk key never goes in a URL", () => {
  test("it is sent as a header", async () => {
    const seen: { url: string; key: string | null }[] = [];
    await webRiskVerdict("https://proto.example/", {
      apiKey: "TEST_SECRET_KEY_12345",
      fetch: (async (input: URL | string, init?: RequestInit) => {
        seen.push({ url: String(input), key: new Headers(init?.headers).get("x-goog-api-key") });
        return Response.json({});
      }) as typeof fetch,
    });
    expect(seen[0]!.url).not.toContain("TEST_SECRET_KEY_12345");
    expect(seen[0]!.key).toBe("TEST_SECRET_KEY_12345");
  });
});

const LABEL = `v-${"d".repeat(26)}`;
const resolution = () => ({ v: 1, kind: "site", linkId: "l1", leaseId: "s1", origin: "https://shop.example.com", assetOrigins: [], expiresAt: Date.now() + 60_000, cacheUntil: Date.now() + 5_000 });

describe("Opus N10 and Gemini note 2: one caller going away doesn't fail the others", () => {
  test("a lookup shared by two requests survives the first one's abort", async () => {
    let release: () => void = () => undefined;
    const directory = convexDirectory({
      backend: "http://127.0.0.1:6455",
      secret: "s".repeat(40),
      fetch: (_url, init) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          release = () => resolve(Response.json(resolution()));
        }),
    });
    const first = new AbortController();
    const a = directory.resolve(LABEL, first.signal);
    const b = directory.resolve(LABEL, new AbortController().signal);
    await Bun.sleep(5);
    first.abort();
    await Bun.sleep(5);
    release();
    expect(await a).toBeNull();
    expect((await b)?.leaseId).toBe("s1");
  });
});

describe("Gemini note 8: unknown hosts can't push known ones out of the cache", () => {
  test("after 20,000 misses, a live host is still answered from the cache", async () => {
    let asked = 0;
    const known = await frameHostHash(LABEL);
    const directory = convexDirectory({
      backend: "http://127.0.0.1:6455",
      secret: "s".repeat(40),
      fetch: async (_url, init) => {
        asked++;
        const { hostHash } = JSON.parse(String(init.body)) as { hostHash: string };
        return hostHash === known ? Response.json(resolution()) : new Response("Not found", { status: 404 });
      },
    });
    expect((await directory.resolve(LABEL))?.leaseId).toBe("s1");
    const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
    const labelOf = (index: number) => `v-${Array.from({ length: 26 }, (_, digit) => ALPHABET[Math.floor(index / 32 ** digit) % 32]).join("")}`;
    for (let index = 1; index <= 20_000; index++) await directory.resolve(labelOf(index));
    const before = asked;
    expect((await directory.resolve(LABEL))?.leaseId).toBe("s1");
    expect(asked).toBe(before);
  });
});

describe("Opus N8: a lease's privileged identity is per origin", () => {
  test("a resolution carries allow tokens only for its own origins, each of a fixed shape", () => {
    const base = { ...resolution(), assetOrigins: [{ slot: 1, origin: "https://api.example.com" }] };
    const token = "t".repeat(43);
    expect(parseReviewResolution({ ...base, allow: [{ origin: "https://shop.example.com", token }] })?.allow).toEqual([{ origin: "https://shop.example.com", token }]);
    expect(parseReviewResolution({ ...base, allow: [{ origin: "https://other.example.com", token }] })).toBeNull();
    expect(parseReviewResolution({ ...base, allow: [{ origin: "https://shop.example.com", token: "bad token\r\n" }] })).toBeNull();
    expect(parseReviewResolution(base)?.allow).toEqual([]);
  });
});
