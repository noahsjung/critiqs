import { expect, test } from "bun:test";
import { routePattern } from "../src/lib/kit/route.ts";

test.each([
  ["/", "/"],
  ["/users/[id]", "/users/:id"],
  ["/(app)/items/[id=integer]", "/items/:id"],
  ["/[[lang]]/about", "/:lang?/about"],
  ["/docs/[...path]", "/docs/:path*"],
  ["/(marketing)", "/"],
  ["/blog/[slug]-[id]", "/blog/:slug-:id"],
])("SvelteKit route %s is %s", (id, pattern) => {
  expect(routePattern(id)).toBe(pattern);
});

test("no matched route has no pattern", () => {
  expect(routePattern(null)).toBeNull();
});

test("hyphenated parameter and matcher names keep their hyphens", () => {
  expect(routePattern("/shop/[item-id]")).toBe("/shop/:item-id");
  expect(routePattern("/shop/[item-id=slug-like]/[[sort-by]]/[...rest-of]")).toBe("/shop/:item-id/:sort-by?/:rest-of*");
});
