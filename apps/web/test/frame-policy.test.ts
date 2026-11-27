import { describe, expect, test } from "bun:test";
import { framesOnlyFrom } from "../src/frame-policy.ts";

// The review page's check of its own Content-Security-Policy: frames only
// from the review proxy's lease hosts, or it shows no frame.

const FRAME = `http://v-${"abcdefghijklmnopqrstuvwxyz"}.review.localhost:5960`;
const WALLED = "frame-ancestors 'none'; frame-src http://*.review.localhost:5960";

describe("framesOnlyFrom", () => {
  test("a header that names only the proxy's lease hosts keeps frames there", () => {
    expect(framesOnlyFrom(WALLED, FRAME)).toBe(true);
    expect(framesOnlyFrom("frame-ancestors 'none'; frame-src https://*.critiqs-review.net", "https://v-abcdefghijklmnopqrstuvwxyz.critiqs-review.net")).toBe(true);
    // Two policies: the stricter one is the wall.
    expect(framesOnlyFrom("default-src *, frame-src http://*.review.localhost:5960", FRAME)).toBe(true);
    // child-src, then default-src, stand in for a missing frame-src.
    expect(framesOnlyFrom("child-src http://*.review.localhost:5960", FRAME)).toBe(true);
    expect(framesOnlyFrom("default-src 'self' http://*.review.localhost:5960", FRAME)).toBe(true);
  });
  test("no header, no frame-src, or one that also lets in blob:, data:, a scheme or any host is no wall", () => {
    for (const header of [
      null,
      "",
      "frame-ancestors 'none'",
      "frame-ancestors 'none'; frame-src *",
      "frame-src http://*.review.localhost:5960 blob:",
      "frame-src http://*.review.localhost:5960 data:",
      "frame-src http: https:",
      "frame-src *.review.localhost:5960",
      "frame-src http://*.review.localhost:*/x http://*",
      "frame-src https://*.other.example",
      "frame-src http://*.review.localhost:5961",
    ]) {
      expect([header, framesOnlyFrom(header, FRAME)]).toEqual([header, false]);
    }
  });
});
