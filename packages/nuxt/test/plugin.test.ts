import { beforeEach, expect, mock, test } from "bun:test";
import type { CritiqsOptions, HostContext, RestoreRequest } from "critiqs";
import { critiqsOptions } from "../src/runtime/options.ts";

const UNSET = { projectId: undefined, requireProjectId: true, backend: undefined, version: undefined, router: true };

test("reads runtime config as Critiqs's settings: empty is unset, and a project ID and routes are on unless turned off", () => {
  expect(critiqsOptions({ projectId: "", requireProjectId: true, backend: "", version: "", router: true })).toEqual(UNSET);
  expect(critiqsOptions({ projectId: " j1 ", backend: "https://b.example", version: "v2" })).toEqual({ ...UNSET, projectId: "j1", backend: "https://b.example", version: "v2" });
  // NUXT_PUBLIC_CRITIQS_… =false arrives as false, or as the text when Nuxt doesn't parse it.
  expect(critiqsOptions({ requireProjectId: false, router: "false" })).toMatchObject({ requireProjectId: false, router: false });
  expect(critiqsOptions(undefined)).toEqual(UNSET);
});

// The client plugin, with Nuxt's runtime and mountCritiqs stood in for; the
// route helpers are critiqs-vue/router's and the shared package's own.
let config: Record<string, unknown> = {};
let router: unknown = null;
let mounted: CritiqsOptions | null = null;
const pushed: HostContext[] = [];
let hooks: Record<string, Array<(...args: unknown[]) => unknown>> = {};
mock.module("#app", () => ({
  defineNuxtPlugin: (plugin: unknown) => plugin,
  useRuntimeConfig: () => ({ public: { critiqs: config } }),
}));
mock.module("critiqs", () => ({
  mountCritiqs(options: CritiqsOptions) {
    mounted = options;
    return { update() {}, destroy() {}, setContext: (context: HostContext) => pushed.push(context) };
  },
}));
const { default: plugin } = (await import("../src/runtime/plugin.client.ts")) as unknown as { default: { setup: (app: unknown) => void } };

/** A router with Vue Router's shape, on `/items/:id()` as Nuxt's pages name it. */
function pagesRouter() {
  const route = (path: string) => ({ matched: [{ path: path === "/" ? "/" : "/items/:id()" }], params: path === "/" ? {} : { id: path.split("/").pop()! }, path });
  const guards: Array<(to: unknown, from: unknown) => void> = [];
  const current = { value: route("/") };
  return {
    currentRoute: current,
    getRoutes: () => [{}, {}],
    resolve: route,
    afterEach: (guard: (to: unknown, from: unknown) => void) => (guards.push(guard), () => {}),
    beforeResolve: () => () => {},
    async push(path: string) {
      const from = current.value;
      current.value = route(path);
      for (const guard of guards) guard(current.value, from);
    },
  };
}
const request = (screen: string, viewState: Record<string, string>): RestoreRequest => ({ threadId: "t", screen, viewState, recordKey: null, scope: "record" as RestoreRequest["scope"], signal: new AbortController().signal });
/** Runs the plugin, then `appPlugin` (an app's own plugin, which runs after the module's), then mounts the app. */
async function start(appPlugin?: (app: { hook: (name: string, fn: (...args: never[]) => unknown) => void }) => void) {
  hooks = {};
  const app = {
    $router: router,
    hook: (name: string, fn: (...args: never[]) => unknown) => void (hooks[name] ??= []).push(fn as (...args: unknown[]) => unknown),
    callHook: async (name: string, ...args: unknown[]) => {
      for (const fn of hooks[name] ?? []) await fn(...args);
    },
  };
  plugin.setup(app);
  appPlugin?.(app);
  await app.callHook("app:mounted");
}
beforeEach(() => {
  mounted = null;
  pushed.length = 0;
  router = null;
});

test("loads nothing without a required project ID, and starts Critiqs once the app has mounted", async () => {
  config = { projectId: "", requireProjectId: true, backend: "", version: "", router: true };
  await start();
  expect(hooks).toEqual({});
  expect(mounted).toBeNull();

  config = { projectId: "j12345678901234567890123456789012", requireProjectId: true, backend: "http://localhost:1/critiqs", version: "", router: true };
  await start();
  expect(mounted).toEqual({ projectId: "j12345678901234567890123456789012", requireProjectId: true, backend: "http://localhost:1/critiqs", version: undefined, restoreContext: undefined });
  expect(pushed).toEqual([]);
});

test("with pages, reports each route and restores a thread's route with the router", async () => {
  config = { projectId: "j1", requireProjectId: false, router: true };
  const pages = pagesRouter();
  router = pages;
  await start();
  expect(pushed).toEqual([{ screen: "/", viewState: {} }]);
  await pages.push("/items/42");
  expect(pushed.at(-1)).toEqual({ screen: "items/:id", viewState: { "route.id": "42" } });
  expect(await mounted!.restoreContext!(request("items/:id", { "route.id": "7" }))).toBe(true);
  expect(pages.currentRoute.value.path).toBe("/items/7");
  expect(await mounted!.restoreContext!(request("settings", {}))).toBe(false);
  expect(pages.currentRoute.value.path).toBe("/items/7");
});

test("router: false, or no pages, means no route context and no default restore", async () => {
  config = { projectId: "j1", requireProjectId: false, router: false };
  router = pagesRouter();
  await start();
  expect(pushed).toEqual([]);
  expect(mounted!.restoreContext).toBeUndefined();

  // Nuxt's stand-in router for apps without pages has no routes.
  config = { projectId: "j1", requireProjectId: false, router: true };
  router = { ...pagesRouter(), getRoutes: () => [] };
  await start();
  expect(pushed).toEqual([]);
  expect(mounted!.restoreContext).toBeUndefined();
});

test("an app's plugin gives its own getContext and restoreContext through the critiqs:options hook", async () => {
  config = { projectId: "j1", requireProjectId: false, router: true };
  const pages = pagesRouter();
  router = pages;
  const getContext = () => ({ viewState: { tab: "billing" } });
  const restoreContext = async () => true;
  await start((app) => app.hook("critiqs:options", (options: { getContext?: unknown; restoreContext?: unknown }) => Object.assign(options, { getContext, restoreContext })));
  expect(mounted!.getContext).toBe(getContext);
  expect(mounted!.restoreContext).toBe(restoreContext);
  // The route is still pushed, so getContext's keys combine with it as setContext documents.
  expect(pushed).toEqual([{ screen: "/", viewState: {} }]);
  expect(await mounted!.restoreContext!(request("settings", {}))).toBe(true);
  expect(pages.currentRoute.value.path).toBe("/");

  // Only getContext: restoring still uses the router.
  await start((app) => app.hook("critiqs:options", (options: { getContext?: unknown }) => void (options.getContext = getContext)));
  expect(mounted!.getContext).toBe(getContext);
  expect(await mounted!.restoreContext!(request("items/:id", { "route.id": "3" }))).toBe(true);
  expect(pages.currentRoute.value.path).toBe("/items/3");
});
