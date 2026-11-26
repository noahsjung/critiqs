import { expect, test } from "bun:test";
import { routeContext, routePath } from "../src/index.ts";

test("a route's pattern is the screen and its parameters are view state", () => {
  expect(routeContext("/users/:id", { id: "42" })).toEqual({ screen: "users/:id", viewState: { "route.id": "42" } });
  expect(routeContext("/", {})).toEqual({ screen: "/", viewState: {} });
  expect(routeContext("/docs/:path*", { path: ["guides", "setup"], missing: undefined })).toEqual({ screen: "docs/:path*", viewState: { "route.path": "guides/setup" } });
});

test("a thread's route is built again from its screen and parameters", () => {
  expect(routePath({ screen: "users/:id", viewState: { "route.id": "42", tab: "billing" } })).toBe("/users/42");
  expect(routePath({ screen: "/", viewState: {} })).toBe("/");
  expect(routePath({ screen: "docs/:path*", viewState: { "route.path": "guides/setup" } })).toBe("/docs/guides/setup");
  expect(routePath({ screen: "search/:q?", viewState: {} })).toBe("/search");
  expect(routePath({ screen: "users/:id", viewState: { "route.id": "a b" } })).toBe("/users/a%20b");
});

test("screens that aren't route patterns, or lack a parameter, have no path", () => {
  expect(routePath({ screen: "users/:id", viewState: {} })).toBeNull();
  expect(routePath({ screen: "/users/42", viewState: {} })).toBeNull();
  expect(routePath({ screen: "", viewState: {} })).toBeNull();
});
