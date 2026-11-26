import { expect, test } from "bun:test";
import { buildLookup, buildOrigin, buildPathProblem, checkBuildManifest, isBuildOrigin, manifestDigest, newBuildPublicId } from "../src/review-builds.ts";
import { parseReviewResolution } from "../src/review-links.ts";

// Shared builds' rules: the path a frame asks for, the build's address in
// saved evidence, and what a resolution for a shared build may hold.

test("a frame's path is a build file, its clean address, then a single-page app's index or the 404 page", () => {
  expect(buildLookup("/", false)).toEqual({ candidates: ["index.html"], fallbacks: [{ path: "404.html", status: 404 }] });
  expect(buildLookup("/docs/", true)).toEqual({ candidates: ["docs/index.html"], fallbacks: [{ path: "index.html", status: 200 }, { path: "404.html", status: 404 }] });
  expect(buildLookup("/about", true)?.candidates).toEqual(["about", "about.html", "about/index.html"]);
  expect(buildLookup("/caf%C3%A9.svg", false)?.candidates).toEqual(["café.svg"]);
  // A missing asset is never the app's page.
  expect(buildLookup("/assets/x.js", true)?.fallbacks).toEqual([{ path: "404.html", status: 404 }]);
  for (const path of ["/../index.html", "/a/%2e%2e/b", "/%2e%2e", "/.env", "/a/.git/x", "/a//b", "/%2fetc", "/a%5cb", "/%00", "/%E0%A4%A", "relative"]) expect([path, buildLookup(path, true)]).toEqual([path, null]);
});

test("a build's saved address is its own unresolvable .build.invalid name", () => {
  const id = newBuildPublicId();
  expect(id).toMatch(/^b[a-z2-7]{20}$/);
  expect(isBuildOrigin(buildOrigin(id))).toBe(true);
  for (const origin of ["https://shop.example.com", `http://${id}.build.invalid`, `https://${id}.build.invalid.example.com`, `https://x.build.invalid`]) expect(isBuildOrigin(origin)).toBe(false);
});

test("the manifest's digest depends on its files and SPA setting, not their order", async () => {
  const files = [
    { path: "index.html", size: 1, sha256: "a".repeat(64) },
    { path: "app.js", size: 2, sha256: "b".repeat(64) },
  ];
  const digest = await manifestDigest(checkBuildManifest(files), false);
  expect(await manifestDigest(checkBuildManifest([...files].reverse()), false)).toBe(digest);
  expect(await manifestDigest(checkBuildManifest(files), true)).not.toBe(digest);
  expect(buildPathProblem("app.js")).toBeNull();
});

test("a shared build's resolution is refused unless it names only a .build.invalid origin, with no other origins or tokens", () => {
  const base = { v: 1, kind: "share", linkId: "l", leaseId: "x", origin: buildOrigin(newBuildPublicId()), assetOrigins: [], allow: [], expiresAt: 10, cacheUntil: 5 };
  expect(parseReviewResolution(base)?.kind).toBe("share");
  expect(parseReviewResolution({ ...base, origin: "https://shop.example.com" })).toBeNull();
  expect(parseReviewResolution({ ...base, assetOrigins: [{ slot: 1, origin: "https://api.example.com" }] })).toBeNull();
  expect(parseReviewResolution({ ...base, allow: [{ origin: base.origin, token: "a".repeat(43) }] })).toBeNull();
  // A live link can never claim a build's name.
  expect(parseReviewResolution({ ...base, kind: "site" })).toBeNull();
  expect(parseReviewResolution({ ...base, kind: "other" })).toBeNull();
});

test("the proxy keeps a build file's bytes only when they are the SHA-256 the backend named, and only an answer of a type builds hold", async () => {
  const { convexDirectory } = await import("../src/review-directory.ts");
  const { sha256Hex } = await import("../src/review-builds.ts");
  const good = new TextEncoder().encode("console.log(1)");
  const sha = await sha256Hex(good);
  let body: Uint8Array = good;
  let answer: unknown = { status: 200, sha256: sha, size: good.byteLength, contentType: "text/javascript; charset=utf-8" };
  const directory = convexDirectory({
    backend: "https://backend.example",
    secret: "s".repeat(40),
    fetch: async (url) => (url.endsWith("/build-file") ? Response.json(answer) : new Response(body as Uint8Array<ArrayBuffer>)),
  });
  const label = `v-${"a".repeat(26)}`;
  expect(await directory.buildFile(label, "/app.js")).toEqual(answer as never);
  expect(await directory.buildBlob(label, sha)).toEqual(good);
  body = new TextEncoder().encode("console.log(2)");
  expect(await directory.buildBlob(label, sha)).toBeNull();
  for (const bad of [{ ...(answer as object), contentType: "text/html" }, { ...(answer as object), status: 500 }, { ...(answer as object), sha256: "x" }, { ...(answer as object), size: 17 * 1024 * 1024 }]) {
    answer = bad;
    expect(await directory.buildFile(label, "/app.js")).toBeNull();
  }
  expect(await directory.buildFile("not-a-label", "/")).toBeNull();
});
