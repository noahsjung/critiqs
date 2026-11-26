import { expect, test } from "bun:test";
import {
  base32,
  deriveLinkKey,
  FRAME_LABEL,
  frameHostHash,
  frameOrigin,
  newFrameLabel,
  parseLiveAddress,
  parseProxyAddress,
  parseReviewResolution,
  proxyAuthorized,
  proxySeparate,
  REVIEW_LINK_KEY,
  reputationSubject,
  sameSecret,
  webRiskVerdict,
} from "../src/review-links.ts";

// The rules review links share between the backend, the proxy, and the
// website, without a backend.

test("base32 follows RFC 4648 in lowercase without padding", () => {
  const encode = (text: string) => base32(new TextEncoder().encode(text));
  expect(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(encode)).toEqual(["", "my", "mzxq", "mzxw6", "mzxw6yq", "mzxw6ytb", "mzxw6ytboi"]);
});

test("frame host labels are 128 random bits, and only their hashes travel", async () => {
  const labels = new Set(Array.from({ length: 200 }, newFrameLabel));
  expect(labels.size).toBe(200);
  for (const label of labels) expect(label).toMatch(FRAME_LABEL);
  const [label] = labels;
  expect(await frameHostHash(label!)).toBe(await frameHostHash(label!.toUpperCase()));
  expect(await frameHostHash(label!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await frameHostHash(label!)).not.toContain(label!.slice(2));
});

test("a link's key is derived from its ID and the key ring, so it can be copied again but not guessed from the ID", async () => {
  const key = await deriveLinkKey("ring-secret", "link-1", 1);
  expect(key).toMatch(REVIEW_LINK_KEY);
  expect(await deriveLinkKey("ring-secret", "link-1", 1)).toBe(key);
  expect(await deriveLinkKey("ring-secret", "link-2", 1)).not.toBe(key);
  expect(await deriveLinkKey("ring-secret", "link-1", 2)).not.toBe(key);
  expect(await deriveLinkKey("other-ring", "link-1", 1)).not.toBe(key);
});

test("the proxy's secret is checked as a bearer token, in full, and never accepted when the deployment's is too short", async () => {
  const secret = "s".repeat(32);
  expect(await proxyAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  for (const header of [null, "", secret, `bearer ${secret}`, `Bearer ${secret}x`, `Bearer ${secret.slice(1)}`, `Bearer  ${secret}`, `Basic ${secret}`]) {
    expect([header, await proxyAuthorized(header, secret)]).toEqual([header, false]);
  }
  expect(await proxyAuthorized("Bearer short", "short")).toBe(false);
  expect(await proxyAuthorized("Bearer ", undefined)).toBe(false);
  expect(await sameSecret("a", "a")).toBe(true);
  expect(await sameSecret("a", "b")).toBe(false);
});

test("the proxy's address is a bare origin: https anywhere, plain http only under localhost", () => {
  expect(parseProxyAddress("https://critiqs-review.net")).toEqual({ protocol: "https:", host: "critiqs-review.net", hostname: "critiqs-review.net" });
  expect(parseProxyAddress("http://review.localhost:5260/")).toEqual({ protocol: "http:", host: "review.localhost:5260", hostname: "review.localhost" });
  for (const value of [undefined, "", "review.net", "http://critiqs-review.net", "https://critiqs-review.net/path", "https://u:p@critiqs-review.net", "ftp://x.localhost"]) {
    expect([value, parseProxyAddress(value)]).toEqual([value, null]);
  }
  const proxy = parseProxyAddress("https://critiqs-review.net")!;
  expect(frameOrigin(proxy, "v-abc")).toBe("https://v-abc.critiqs-review.net");
});

test("the proxy's domain is kept apart from the website and the backend", () => {
  const proxy = (value: string) => parseProxyAddress(value)!;
  expect(proxySeparate(proxy("https://critiqs-review.net"), ["https://critiqs.app", "https://x.convex.site"])).toBe(true);
  expect(proxySeparate(proxy("https://review.critiqs.app"), ["https://critiqs.app"])).toBe(false);
  expect(proxySeparate(proxy("https://critiqs.app"), ["https://www.critiqs.app"])).toBe(false);
  expect(proxySeparate(proxy("https://critiqs.app"), ["https://critiqs.app"])).toBe(false);
  // localhost is a suffix nobody owns: these are separate sites, as browsers treat them.
  expect(proxySeparate(proxy("http://review.localhost:5260"), ["http://localhost:5212", "http://127.0.0.1:5211"])).toBe(true);
  expect(proxySeparate(proxy("http://review.localhost:5260"), ["http://app.review.localhost:5212"])).toBe(false);
});

test("a live address is https on the default port at a public name, and never one of Critiqs's own hosts", () => {
  expect(parseLiveAddress(" https://Proto.Example./a/b?c=1#frag ", [])).toEqual({ origin: "https://proto.example", path: "/a/b?c=1" });
  const refused = ["critiqs-review.net", "critiqs.app", "abc.convex.site"];
  for (const address of [
    "https://critiqs-review.net/",
    "https://v-abc.critiqs-review.net/",
    "https://critiqs.app/r/x",
    "https://ABC.convex.site/",
    "http://proto.example",
    "https://proto.example:444",
    "https://proto.example:443x",
    "https://u@proto.example",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.1.2.3",
    "https://metadata.google.internal",
    "https://foo.ts.net",
    "https://devbox",
    "https://proto.example/__critiqs/leave",
    `https://proto.example/${"x".repeat(2000)}`,
  ]) {
    expect(() => parseLiveAddress(address, refused)).toThrow();
  }
  // The default port written out is the same address.
  expect(parseLiveAddress("https://proto.example:443/", refused)).toEqual({ origin: "https://proto.example", path: "/" });
});

test("reputation is asked about the origin and path only", () => {
  expect(reputationSubject("https://proto.example", "/a/b?token=secret")).toBe("https://proto.example/a/b");
});

test("Google Web Risk's answers map to clean, unsafe, or unknown, and nothing unclear counts as clean", async () => {
  const asked: string[] = [];
  const answer = (response: Response | Error) =>
    (async (input: string | URL | Request) => {
      asked.push(String(input));
      if (response instanceof Error) throw response;
      return response.clone();
    }) as typeof fetch;
  const verdict = (response: Response | Error) => webRiskVerdict("https://proto.example/a", { apiKey: "key", fetch: answer(response) });
  expect(await verdict(Response.json({}))).toBe("clean");
  expect(await verdict(Response.json({ threat: { threatTypes: ["SOCIAL_ENGINEERING"], expireTime: "2026-11-26T00:00:00Z" } }))).toBe("unsafe");
  expect(await verdict(new Response("quota", { status: 429 }))).toBe("unknown");
  expect(await verdict(new Response("not json", { status: 200 }))).toBe("unknown");
  expect(await verdict(new Response("null", { status: 200 }))).toBe("unknown");
  expect(await verdict(new TypeError("offline"))).toBe("unknown");
  const url = new URL(asked[0]!);
  expect(url.origin + url.pathname).toBe("https://webrisk.googleapis.com/v1/uris:search");
  expect(url.searchParams.getAll("threatTypes")).toEqual(["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]);
  expect(url.searchParams.get("uri")).toBe("https://proto.example/a");
});

test("the proxy accepts only a well-formed resolution", () => {
  const good = { v: 1, kind: "site", linkId: "l", leaseId: "s", origin: "https://proto.example", assetOrigins: [{ slot: 1, origin: "https://api.example" }], expiresAt: 10, cacheUntil: 5 };
  expect(parseReviewResolution(good)).toEqual(good as never);
  expect(parseReviewResolution({ ...good, extra: "dropped" })).toEqual(good as never);
  for (const bad of [
    null,
    "x",
    { ...good, v: 2 },
    { ...good, kind: "share" },
    { ...good, origin: "https://proto.example/path" },
    { ...good, origin: "javascript:alert(1)" },
    { ...good, cacheUntil: 11 },
    { ...good, expiresAt: -1 },
    { ...good, linkId: 1 },
    { ...good, assetOrigins: [{ slot: 0, origin: "https://api.example" }] },
    { ...good, assetOrigins: [{ slot: 5, origin: "https://api.example" }] },
    { ...good, assetOrigins: [{ slot: 1, origin: "file:///etc/passwd" }] },
    { ...good, assetOrigins: Array.from({ length: 5 }, (_, index) => ({ slot: 1 + (index % 4), origin: "https://api.example" })) },
  ]) {
    expect([bad, parseReviewResolution(bad)]).toEqual([bad, null]);
  }
});
