import { expect, test } from "bun:test";
import { combineContext } from "../../react/src/mount.tsx";
import { routeContext, routePath } from "../src/index.ts";

test("thread context can't send the router off the site", () => {
  expect(routePath({ screen: ":path*", viewState: { "route.path": "/evil.com" } })).toBe("/evil.com");
  expect(routePath({ screen: ":a/:b", viewState: { "route.a": "", "route.b": "evil.com" } })).toBeNull();
  expect(routePath({ screen: ":a?/:b", viewState: { "route.b": "evil.com" } })).toBe("/evil.com");
  expect(routePath({ screen: "a//b", viewState: {} })).toBeNull();
  expect(routePath({ screen: "a\\b", viewState: {} })).toBeNull();
  for (const control of ["\t", "\n", "\r"]) expect(routePath({ screen: `${control}/evil.com`, viewState: {} })).toBeNull();
  expect(routePath({ screen: "login?next=https:%2F%2Fevil.com", viewState: {} })).toBeNull();
  expect(routePath({ screen: "a#b", viewState: {} })).toBeNull();
  expect(routePath({ screen: "users/:id", viewState: { "route.id": "\t/evil.com" } })).toBe("/users/%09%2Fevil.com");
  expect(routePath({ screen: ":id", viewState: { "route.id": "//evil.com" } })).toBe("/%2F%2Fevil.com");
});

test("a single parameter is one segment, and empty values count as missing", () => {
  expect(routePath({ screen: "users/:id", viewState: { "route.id": "a/b" } })).toBe("/users/a%2Fb");
  expect(routePath({ screen: "users/:id", viewState: { "route.id": "" } })).toBeNull();
  expect(routePath({ screen: "docs/:path*", viewState: { "route.path": "" } })).toBe("/docs");
  expect(routePath(routeContext("/docs/:path*", { path: [] }))).toBe("/docs");
  expect(routePath({ screen: "docs/:path+", viewState: { "route.path": "" } })).toBeNull();
});

test("the app's view state keeps pushed route parameters", () => {
  const combined = combineContext(routeContext("/users/:id", { id: "42" }), () => ({ viewState: { tab: "billing" } }));
  const context = combined?.();
  expect(context).toEqual({ screen: "users/:id", viewState: { "route.id": "42", tab: "billing" } });
  expect(routePath({ screen: context!.screen!, viewState: context!.viewState! })).toBe("/users/42");
});

test("a getContext reporting viewState: null keeps the pushed view state", () => {
  const combined = combineContext(routeContext("/users/:id", { id: "42" }), () => ({ viewState: null as never, screen: "users/:id" }));
  expect(combined?.()).toEqual({ screen: "users/:id", viewState: { "route.id": "42" } });
});

test("a repeated parameter's values keep their own slashes and percent signs", () => {
  const context = routeContext("/docs/:slug+", { slug: ["a/b", "c", "100%", "x%2Fy"] });
  expect(context.viewState).toEqual({ "route.slug": "a%2Fb/c/100%25/x%252Fy" });
  expect(routePath(context)).toBe("/docs/a%2Fb/c/100%25/x%252Fy");
  expect(routePath(routeContext("/docs/:path*", { path: "guides/setup" }))).toBe("/docs/guides/setup");
});

test("a repeated parameter restores alike whether the router gives an array or a string", () => {
  // Vue Router gives segments; SvelteKit, Astro and Solid give one decoded string.
  const fromArray = routeContext("/docs/:slug+", { slug: ["a%2Fb", "c"] });
  const fromString = routeContext("/docs/[...slug]".replace("[...slug]", ":slug*"), { slug: "a%2Fb/c" });
  expect(fromArray.viewState["route.slug"]).toBe("a%252Fb/c");
  expect(fromString.viewState["route.slug"]).toBe("a%252Fb/c");
  expect(routePath(fromArray)).toBe("/docs/a%252Fb/c");
  expect(routePath(fromString)).toBe("/docs/a%252Fb/c");
  expect(routePath(routeContext("/files/:rest*", { rest: "100%/x" }))).toBe("/files/100%25/x");
  // A single parameter is stored as is and encoded whole.
  expect(routeContext("/users/:id", { id: "a%2Fb" }).viewState["route.id"]).toBe("a%2Fb");
  expect(routePath(routeContext("/users/:id", { id: "a%2Fb" }))).toBe("/users/a%252Fb");
});

test("typed parameters from matchers are reported as text", () => {
  const context = routeContext("/items/:id", { id: 42, draft: false, gone: null });
  expect(context.viewState).toEqual({ "route.id": "42", "route.draft": "false" });
  expect(routePath(context)).toBe("/items/42");
  expect(routeContext("/pages/:n+", { n: [1, 2] }).viewState).toEqual({ "route.n": "1/2" });
});
