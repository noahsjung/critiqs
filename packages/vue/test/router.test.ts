import { beforeEach, expect, mock, test } from "bun:test";
import type { CritiqsOptions, HostContext, RestoreRequest } from "critiqs";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

// mountCritiqs stood in for, so the test sees every setting and pushed
// context; the route helpers are the shared package's own (critiqs/router).
let settings: CritiqsOptions = {};
const pushed: HostContext[] = [];
mock.module("critiqs", () => ({
  mountCritiqs(options: CritiqsOptions) {
    settings = options;
    return { update: (next: CritiqsOptions) => (settings = next), setContext: (context: HostContext) => pushed.push(context), destroy() {} };
  },
}));
const { Critiqs } = await import("../src/index.ts");
const { routePattern } = await import("../src/router.ts");

const Page = defineComponent({ render: () => h("p", "page") });
beforeEach(() => {
  settings = {};
  pushed.length = 0;
});
const settle = async () => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const request = (screen: string, viewState: Record<string, string> = {}, signal = new AbortController().signal): RestoreRequest => ({ threadId: "t1", screen, viewState, recordKey: null, scope: "record" as RestoreRequest["scope"], signal });

/** An app with Vue Router, routes `/` and `/items/:id` (plus `extra`), and <Critiqs> in its root component. */
async function routedApp(props: Record<string, unknown> = {}, extra: Array<{ path: string; component: typeof Page }> = []) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: Page }, { path: "/items/:id(\\d+)", component: Page }, ...extra],
  });
  const state = reactive<Record<string, unknown>>({ projectId: "p1", ...props });
  const app = createApp({ render: () => [h(RouterView), h(Critiqs, { ...state })] });
  app.use(router);
  await router.push("/");
  app.mount(document.createElement("div"));
  await settle();
  return { router, state, app };
}

test("reports each route as its pattern and parameters", async () => {
  const { router, app } = await routedApp();
  expect(pushed).toEqual([{ screen: "/", viewState: {} }]);
  await router.push("/items/42");
  expect(pushed.at(-1)).toEqual({ screen: "items/:id", viewState: { "route.id": "42" } });
  app.unmount();
});

test("restores a thread's route with router.push, and says when it can't", async () => {
  const { router, app } = await routedApp();
  const restore = settings.restoreContext!;
  expect(await restore(request("items/:id", { "route.id": "7" }))).toBe(true);
  expect(router.currentRoute.value.fullPath).toBe("/items/7");
  expect(await restore(request("items/:id", { "route.id": "7" }))).toBe(true);
  expect(await restore(request("/settings"))).toBe(false);
  expect(await restore(request("items/:id"))).toBe(false);

  router.beforeEach((to) => to.path !== "/");
  expect(await restore(request("/"))).toBe(false);
  expect(router.currentRoute.value.fullPath).toBe("/items/7");
  app.unmount();
});

test("restore says false, without navigating, for a screen that isn't a route of this app", async () => {
  const { router, app } = await routedApp({}, [
    { path: "/blog/:slug-:id", component: Page },
    { path: "/:pathMatch(.*)*", component: Page },
  ]);
  const restore = settings.restoreContext!;
  // A custom getContext screen and a removed route land on the catch-all, which isn't the thread's screen.
  expect(await restore(request("user-details"))).toBe(false);
  expect(await restore(request("settings"))).toBe(false);
  // Two parameters in one segment, or Nuxt's item-[id], can't be built back into a path.
  expect(await restore(request("blog/:slug-:id", { "route.slug": "hello", "route.id": "3" }))).toBe(false);
  expect(await restore(request("item-:id", { "route.id": "3" }))).toBe(false);
  expect(router.currentRoute.value.fullPath).toBe("/");
  app.unmount();

  const bare = await routedApp();
  expect(await settings.restoreContext!(request("settings"))).toBe(false);
  expect(bare.router.currentRoute.value.fullPath).toBe("/");
  bare.app.unmount();
});

test("restore says false when Critiqs aborts it, and true when the router is already there", async () => {
  const { router, app } = await routedApp();
  const restore = settings.restoreContext!;
  const aborted = new AbortController();
  aborted.abort();
  expect(await restore(request("items/:id", { "route.id": "7" }, aborted.signal))).toBe(false);
  expect(router.currentRoute.value.fullPath).toBe("/");

  await router.push("/items/7");
  // Same path, so Vue Router reports a duplicated navigation: the route is showing.
  expect(await restore(request("items/:id", { "route.id": "7", "route.stale": "x" }))).toBe(true);
  expect(router.currentRoute.value.fullPath).toBe("/items/7");
  app.unmount();
});

test("the app's own restoreContext and getContext win", async () => {
  const restoreContext = () => true;
  const getContext = () => ({ screen: "custom" });
  const { app } = await routedApp({ restoreContext, getContext });
  expect(settings.restoreContext).toBe(restoreContext);
  expect(settings.getContext).toBe(getContext);
  expect(pushed).toEqual([{ screen: "/", viewState: {} }]);
  app.unmount();
});

test(":router=\"false\" turns the integration off, and clears what it reported", async () => {
  const off = await routedApp({ router: false });
  expect(pushed).toEqual([]);
  expect(settings.restoreContext).toBeUndefined();
  off.app.unmount();

  const { router, state, app } = await routedApp();
  expect(pushed).toHaveLength(1);
  state.router = false;
  await settle();
  expect(pushed.at(-1)).toEqual({});
  expect(settings.restoreContext).toBeUndefined();
  await router.push("/items/3");
  expect(pushed).toHaveLength(2);
  app.unmount();
});

test("an app without Vue Router gets no route context and no default restore", async () => {
  const app = createApp({ render: () => h(Critiqs, { projectId: "p1" }) });
  app.mount(document.createElement("div"));
  await settle();
  expect(pushed).toEqual([]);
  expect(settings.restoreContext).toBeUndefined();
  app.unmount();
});

test("route patterns take the shared :name form", () => {
  expect(routePattern("/users/:id(\\d+)")).toBe("/users/:id");
  expect(routePattern("/:pathMatch(.*)*")).toBe("/:pathMatch*");
  expect(routePattern("/users/:id()")).toBe("/users/:id");
  expect(routePattern("/docs/:slug?/:rest+")).toBe("/docs/:slug?/:rest+");
  expect(routePattern("/a/:x([a-z](?:-[a-z])*)")).toBe("/a/:x");
});

test("aborting a pending restore cancels its navigation, wherever a guard holds it", async () => {
  let release = () => {};
  const hold = () => new Promise<void>((resolve) => (release = resolve));
  const { router, app } = await routedApp({}, [{ path: "/slow/:id", component: Page, beforeEnter: () => hold() } as never]);
  const restore = settings.restoreContext!;
  const removeGuard = router.beforeEach((to) => (to.path === "/items/42" ? hold() : undefined));

  for (const [screen, viewState] of [["items/:id", { "route.id": "42" }], ["slow/:id", { "route.id": "1" }]] as const) {
    const controller = new AbortController();
    const result = restore(request(screen, viewState, controller.signal));
    await settle();
    controller.abort();
    release();
    expect(await result).toBe(false);
    await settle();
    expect(router.currentRoute.value.fullPath).toBe("/");
  }

  // The guard goes with the restore: later navigations aren't stopped.
  removeGuard();
  await router.push("/items/42");
  expect(router.currentRoute.value.fullPath).toBe("/items/42");
  app.unmount();
});

test("restore returns to a repeated parameter whose value holds a slash", async () => {
  const { router, app } = await routedApp({}, [{ path: "/docs/:slug+", component: Page }]);
  await router.push("/docs/a%2Fb/c");
  expect(router.currentRoute.value.params.slug).toEqual(["a/b", "c"]);
  const saved = pushed.at(-1)!;
  expect(saved.screen).toBe("docs/:slug+");
  await router.push("/");
  expect(await settings.restoreContext!(request(saved.screen!, saved.viewState as Record<string, string>))).toBe(true);
  expect(router.currentRoute.value.fullPath).toBe("/docs/a%2Fb/c");
  expect(router.currentRoute.value.params.slug).toEqual(["a/b", "c"]);
  expect(router.currentRoute.value.matched.at(-1)?.path).toBe("/docs/:slug+");
  app.unmount();
});

test("restore says false when a guard redirects away from the thread's route", async () => {
  const { router, app } = await routedApp();
  router.beforeEach((to) => (to.path === "/items/9" ? "/items/1" : undefined));
  expect(await settings.restoreContext!(request("items/:id", { "route.id": "9" }))).toBe(false);
  expect(router.currentRoute.value.fullPath).toBe("/items/1");
  app.unmount();
});

test("an aborted restore held by a guard cancels only its own navigation, not one the app starts meanwhile", async () => {
  let release = () => {};
  const { router, app } = await routedApp({}, [{ path: "/link", component: Page }]);
  const restore = settings.restoreContext!;
  router.beforeEach((to) => (to.path === "/items/42" ? new Promise<void>((resolve) => (release = resolve)) : undefined));

  const controller = new AbortController();
  const result = restore(request("items/:id", { "route.id": "42" }, controller.signal));
  await settle();
  controller.abort();
  // The app navigates while the restore's navigation is still held.
  expect(await router.push("/link")).toBeUndefined();
  expect(router.currentRoute.value.fullPath).toBe("/link");
  release();
  expect(await result).toBe(false);
  await settle();
  expect(router.currentRoute.value.fullPath).toBe("/link");
  app.unmount();
});
