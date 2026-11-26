import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { flushSync, mount, onMount, unmount } from "svelte";
import type { CritiqsOptions, HostContext, RestoreRequest } from "critiqs";
import * as router from "../../critiqs/src/router.ts";
import { navigating, page } from "./page.svelte.js";
import { reactiveProps } from "./props.svelte.js";

/** An app's own router with routes `/` and `/items/:id`, recording where it navigated. */
function ownRouter() {
  const state = {
    visited: [] as string[],
    redirect: null as string | null,
    fail: false,
    pattern: "/" as string | null,
    params: {} as Record<string, string>,
  };
  return Object.assign(state, {
    router: {
      get pattern() {
        return state.pattern;
      },
      get params() {
        return state.params;
      },
      async navigate(path: string) {
        if (state.fail) throw new Error("No such route");
        const to = state.redirect ?? path;
        state.visited.push(to);
        const id = /^\/items\/([^/]+)$/.exec(to)?.[1];
        state.pattern = id === undefined ? "/" : "/items/:id";
        state.params = id === undefined ? {} : { id };
      },
    },
  });
}

// `critiqs` stands in for the real bundle: each mount records its settings and pushed context.
interface Mounted {
  options: CritiqsOptions[];
  pushed: HostContext[];
  destroyed: boolean;
}
let mounted: Mounted[] = [];
mock.module("critiqs", () => ({
  ...router,
  mountCritiqs(options: CritiqsOptions) {
    const record: Mounted = { options: [options], pushed: [], destroyed: false };
    mounted.push(record);
    return {
      update: (next: CritiqsOptions) => record.options.push(next),
      setContext: (context: HostContext) => record.pushed.push(context),
      destroy: () => {
        record.destroyed = true;
      },
    };
  },
}));
mock.module("critiqs/router", () => router);
// SvelteKit's modules, for critiqs-svelte/kit, behaving as SvelteKit does for an app with these routes.
// `[id=integer]` uses a typed matcher, so SvelteKit 3 gives its parameter as a number.
const ROUTES = ["/", "/(app)/users/[id]", "/docs/[...path]", "/items/[id=integer]", "/shop/[item-id]"];
/** Set to give the app a catch-all route, `src/routes/[...rest]`, that matches any other path. */
let catchAll = false;
function matchRoute(href: string): { id: string; params: Record<string, string | number> } | null {
  const url = new URL(href, "http://localhost");
  const path = url.pathname.replace(/^\/base/, "") || "/";
  for (const id of catchAll ? [...ROUTES, "/[...rest]"] : ROUTES) {
    const params: [string, string | undefined][] = [];
    const source = id
      .split("/")
      .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment))
      .map((segment) =>
        segment.replace(/\[(\.\.\.)?([\w-]+)(?:=(\w+))?\]/, (_, rest, name, matcher) => (params.push([name, matcher]), rest ? "(.+)" : matcher === "integer" ? "(\\d+)" : "([^/]+)")),
      )
      .join("/");
    const match = new RegExp(`^/${source}$`).exec(path);
    // As SvelteKit does: each parameter is decoded once, and a typed matcher parses it.
    if (match !== null) return { id, params: Object.fromEntries(params.map(([name, matcher], i) => [name, matcher === "integer" ? Number(match[i + 1]) : decodeURIComponent(match[i + 1]!)])) };
  }
  return null;
}
const navigations: string[] = [];
/** The options each `goto` was given, in order. */
const gotoOptions: object[] = [];
/** Set to make the next navigations be cancelled, as a `beforeNavigate` guard does. */
let guarded = false;
let afterNavigate: () => void = () => {};
/** Runs while preloadData loads; returns what it resolves to instead of a loaded page, such as an error page. */
let preloading: () => object | void = () => {};
/** Every mounted component's `beforeNavigate` callback, as SvelteKit keeps them. */
const beforeNavigateCallbacks = new Set<(navigation: object) => void>();
/** Makes `@sveltejs/kit` report this SvelteKit version. */
const kitVersion = (version: string) => mock.module("@sveltejs/kit", () => ({ VERSION: version }));
kitVersion("3.4.0");
mock.module("$app/state", () => ({ page, navigating }));
mock.module("$app/paths", () => ({ resolve: (path: string) => `/base${path}` }));
mock.module("$app/navigation", () => ({
  preloadData: async (href: string) => {
    if (matchRoute(href) === null) throw new Error(`Attempted to preload a URL that does not belong to this app: ${href}`);
    await Bun.sleep(5);
    return preloading() ?? { type: "loaded", status: 200, data: {} };
  },
  beforeNavigate(callback: (navigation: object) => void) {
    onMount(() => {
      beforeNavigateCallbacks.add(callback);
      return () => beforeNavigateCallbacks.delete(callback);
    });
  },
  goto: async (href: string, options: object = {}) => {
    gotoOptions.push(options);
    const route = matchRoute(href);
    let cancelled = false;
    const navigation = { type: "goto", to: { route: { id: route?.id ?? null }, params: route?.params ?? null, url: new URL(href, "http://localhost") }, cancel: () => (cancelled = true) };
    // SvelteKit skips beforeNavigate while another navigation is under way.
    if (navigating.type === null) for (const callback of beforeNavigateCallbacks) callback(navigation);
    if (cancelled) return;
    const previous = navigating.type;
    navigating.type = "goto";
    await Bun.sleep(5);
    afterNavigate();
    // An app navigation that started meanwhile is still under way.
    if (navigating.type === "goto") navigating.type = previous;
    if (guarded) return;
    navigations.push(href);
    page.route.id = route?.id ?? null;
    page.params = route?.params ?? {};
    page.url = new URL(href, "http://localhost");
  },
}));

const { default: Critiqs } = await import("../src/lib/Critiqs.svelte");
const { default: KitCritiqs } = await import("../src/lib/kit/Critiqs.svelte");
const PROJECT = "j12345678901234567890123456789012";

let target: HTMLElement;
beforeEach(() => {
  mounted = [];
  navigations.length = 0;
  gotoOptions.length = 0;
  guarded = false;
  kitVersion("3.4.0");
  navigating.type = null;
  catchAll = false;
  afterNavigate = () => {};
  preloading = () => {};
  page.route.id = "/";
  page.params = {};
  page.url = new URL("http://localhost/base/");
  target = document.createElement("div");
  document.body.append(target);
});
afterEach(() => target.remove());

/** Lets the lazy `import("critiqs")` finish and Svelte run its effects. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await Bun.sleep(0);
  flushSync();
}

const request = (screen: string, viewState: Record<string, string>, signal = new AbortController().signal): RestoreRequest => ({
  threadId: "t1",
  screen,
  viewState,
  recordKey: null,
  scope: "page" as RestoreRequest["scope"],
  signal,
});
const latest = () => mounted[0]!.options.at(-1)!;

describe("Critiqs", () => {
  test("renders nothing in place and mounts Critiqs once with its settings", async () => {
    const getContext = () => ({ screen: "home" });
    const component = mount(Critiqs, { target, props: { projectId: PROJECT, backend: "https://example.convex.cloud", version: "v1", getContext } });
    await settle();
    expect(target.innerHTML).toBe("");
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.options[0]).toEqual({
      projectId: PROJECT,
      requireProjectId: undefined,
      backend: "https://example.convex.cloud",
      version: "v1",
      getContext,
      restoreContext: undefined,
    });
    // Without a router, nothing is pushed and nothing is restored for the app.
    expect(mounted[0]!.pushed).toEqual([{}]);
    unmount(component);
  });

  test("passes changed settings to update, and destroys on unmount", async () => {
    const props = reactiveProps({ projectId: PROJECT, version: "v1" });
    const component = mount(Critiqs, { target, props });
    await settle();
    props.version = "v2";
    flushSync();
    expect(mounted).toHaveLength(1);
    expect(latest()).toMatchObject({ projectId: PROJECT, version: "v2" });
    unmount(component);
    flushSync();
    expect(mounted[0]!.destroyed).toBe(true);
  });

  test("unmounted before the bundle loads: never mounts", async () => {
    const component = mount(Critiqs, { target, props: { projectId: PROJECT } });
    flushSync();
    unmount(component);
    await settle();
    expect(mounted).toHaveLength(0);
  });

  test("with requireProjectId and no project ID, loads nothing until one is set", async () => {
    const props = reactiveProps<CritiqsOptions>({ projectId: undefined, requireProjectId: true });
    const component = mount(Critiqs, { target, props });
    await settle();
    expect(mounted).toHaveLength(0);
    props.projectId = PROJECT;
    flushSync();
    await settle();
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.options[0]).toMatchObject({ projectId: PROJECT, requireProjectId: true });
    unmount(component);
  });
});

describe("Critiqs with the app's own router", () => {
  test("restores only when the router then shows the thread's route, and false when navigate throws", async () => {
    const route = ownRouter();
    const component = mount(Critiqs, { target, props: { projectId: PROJECT, router: route.router } });
    await settle();
    const restore = latest().restoreContext!;
    expect(await restore(request("items/:id", { "route.id": "3" }))).toBe(true);
    expect(route.visited).toEqual(["/items/3"]);
    // A router whose navigation lands elsewhere (a redirect) didn't show the thread's route.
    route.redirect = "/";
    expect(await restore(request("items/:id", { "route.id": "4" }))).toBe(false);
    route.redirect = null;
    route.fail = true;
    expect(await restore(request("items/:id", { "route.id": "5" }))).toBe(false);
    unmount(component);
  });
});

test("MASK_ATTRIBUTE is critiqs's own, without loading the critiqs bundle", async () => {
  const { MASK_ATTRIBUTE } = await import("../src/lib/index.ts");
  const shared = await import("../../react/src/constants.ts");
  expect(MASK_ATTRIBUTE).toBe(shared.MASK_ATTRIBUTE);
});

describe("critiqs-svelte/kit: SvelteKit's router", () => {
  test("reports the route on mount and on every navigation", async () => {
    page.route.id = "/(app)/users/[id]";
    page.params = { id: "42" };
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    expect(mounted[0]!.pushed.at(-1)).toEqual({ screen: "users/:id", viewState: { "route.id": "42" } });
    page.route.id = "/docs/[...path]";
    page.params = { path: "guides/setup" };
    flushSync();
    expect(mounted[0]!.pushed.at(-1)).toEqual({ screen: "docs/:path*", viewState: { "route.path": "guides/setup" } });
    // No route matched (a 404): the screen falls back to the URL path.
    page.route.id = null;
    page.params = {};
    flushSync();
    expect(mounted[0]!.pushed.at(-1)).toEqual({});
    unmount(component);
  });

  test("restores a thread's route with goto, under the base path, once the navigation settles", async () => {
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    expect(await restore(request("users/:id", { "route.id": "7", tab: "notes" }))).toBe(true);
    expect(navigations).toEqual(["/base/users/7"]);
    expect(page.route.id).toBe("/(app)/users/[id]");
    // Already there: no navigation.
    expect(await restore(request("users/:id", { "route.id": "7" }))).toBe(true);
    expect(navigations).toHaveLength(1);
    expect(await restore(request("docs/:path*", { "route.path": "guides/setup" }))).toBe(true);
    expect(navigations.at(-1)).toBe("/base/docs/guides/setup");
    // A screen that isn't a route pattern can't be built into a path.
    expect(await restore(request("/legacy/path", {}))).toBe(false);
    // Nor can a segment with several parameters (`/blog/[slug]-[id]`).
    expect(await restore(request("blog/:slug-:id", { "route.slug": "hello", "route.id": "3" }))).toBe(false);
    expect(navigations).toHaveLength(2);
    unmount(component);
  });

  test("a screen that isn't one of the app's routes stays put: no 404, and false", async () => {
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    // An app's own getContext screen, such as `user-details`, builds the path /user-details, which no route matches.
    expect(await restore(request("user-details", {}))).toBe(false);
    expect(navigations).toEqual([]);
    expect(page.route.id).toBe("/");
    unmount(component);
  });

  test("a navigation a beforeNavigate guard cancels is not a restore", async () => {
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    guarded = true;
    expect(await latest().restoreContext!(request("users/:id", { "route.id": "7" }))).toBe(false);
    expect(page.route.id).toBe("/");
    unmount(component);
  });

  test("an aborted request doesn't navigate, and one aborted while navigating gives false", async () => {
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    expect(await restore(request("users/:id", { "route.id": "7" }, AbortSignal.abort()))).toBe(false);
    expect(navigations).toEqual([]);
    const reviewer = new AbortController();
    afterNavigate = () => reviewer.abort();
    expect(await restore(request("users/:id", { "route.id": "8" }, reviewer.signal))).toBe(false);
    unmount(component);
  });

  test("a request aborted while its route preloads doesn't navigate", async () => {
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const reviewer = new AbortController();
    preloading = () => reviewer.abort();
    expect(await latest().restoreContext!(request("users/:id", { "route.id": "7" }, reviewer.signal))).toBe(false);
    expect(navigations).toEqual([]);
    expect(page.route.id).toBe("/");
    unmount(component);
  });

  test("a route that loads into an error page stays put: no navigation, and false", async () => {
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    // SvelteKit 3 reports a load that fails as an error; SvelteKit 2 as the error page it loaded.
    preloading = () => ({ type: "error", status: 404, error: { message: "Not Found" } });
    expect(await restore(request("users/:id", { "route.id": "404" }))).toBe(false);
    preloading = () => ({ type: "loaded", status: 404, data: {} });
    expect(await restore(request("users/:id", { "route.id": "404" }))).toBe(false);
    preloading = () => ({ type: "redirect", status: 307, location: "/" });
    expect(await restore(request("users/:id", { "route.id": "1" }))).toBe(false);
    expect(navigations).toEqual([]);
    expect(page.route.id).toBe("/");
    unmount(component);
  });

  test("with a catch-all route, a screen that isn't one of the app's routes stays put", async () => {
    catchAll = true;
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    // /user-details loads, but as src/routes/[...rest], not as a `user-details` route.
    expect(await restore(request("user-details", {}))).toBe(false);
    expect(navigations).toEqual([]);
    expect(page.route.id).toBe("/");
    // The app's other navigations go ahead.
    expect(await restore(request("users/:id", { "route.id": "7" }))).toBe(true);
    expect(navigations).toEqual(["/base/users/7"]);
    unmount(component);
  });

  test("a typed matcher's parameter, a number in SvelteKit 3, is reported and restored as text", async () => {
    page.route.id = "/items/[id=integer]";
    page.params = { id: 42 };
    page.url = new URL("http://localhost/base/items/42");
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    expect(mounted[0]!.pushed.at(-1)).toEqual({ screen: "items/:id", viewState: { "route.id": "42" } });
    const restore = latest().restoreContext!;
    expect(await restore(request("items/:id", { "route.id": "42" }))).toBe(true);
    expect(navigations).toEqual([]);
    expect(await restore(request("items/:id", { "route.id": "7" }))).toBe(true);
    expect(navigations).toEqual(["/base/items/7"]);
    expect(page.params).toEqual({ id: 7 });
    expect(mounted[0]!.pushed.at(-1)).toEqual({ screen: "items/:id", viewState: { "route.id": "7" } });
    unmount(component);
  });

  test("a catch-all parameter holding an escaped slash opens the same address again", async () => {
    // At /docs/a%252Fb/c, SvelteKit decodes the parameter once: "a%2Fb/c".
    page.route.id = "/docs/[...path]";
    page.params = { path: "a%2Fb/c" };
    page.url = new URL("http://localhost/base/docs/a%252Fb/c");
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const reported = mounted[0]!.pushed.at(-1)!;
    expect(reported).toEqual({ screen: "docs/:path*", viewState: { "route.path": "a%252Fb/c" } });
    page.route.id = "/";
    page.params = {};
    flushSync();
    expect(await latest().restoreContext!(request(reported.screen!, reported.viewState as Record<string, string>))).toBe(true);
    expect(navigations).toEqual(["/base/docs/a%252Fb/c"]);
    expect(page.params).toEqual({ path: "a%2Fb/c" });
    unmount(component);
  });

  test("a hyphenated parameter name, `[item-id]`, is reported and restored", async () => {
    page.route.id = "/shop/[item-id]";
    page.params = { "item-id": "lamp" };
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    expect(mounted[0]!.pushed.at(-1)).toEqual({ screen: "shop/:item-id", viewState: { "route.item-id": "lamp" } });
    expect(await latest().restoreContext!(request("shop/:item-id", { "route.item-id": "desk" }))).toBe(true);
    expect(navigations).toEqual(["/base/shop/desk"]);
    unmount(component);
  });

  test("during another navigation, a restore stays put: SvelteKit would skip the catch-all check", async () => {
    catchAll = true;
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    // An app navigation held in onNavigate (a view transition, say).
    navigating.type = "link";
    expect(await restore(request("removed", {}))).toBe(false);
    expect(await restore(request("users/:id", { "route.id": "7" }))).toBe(false);
    expect(navigations).toEqual([]);
    expect(page.route.id).toBe("/");
    // One that starts while the thread's route preloads.
    navigating.type = null;
    preloading = () => void (navigating.type = "link");
    expect(await restore(request("removed", {}))).toBe(false);
    expect(navigations).toEqual([]);
    // Once it has settled, restores go ahead and the catch-all check holds again.
    navigating.type = null;
    preloading = () => {};
    expect(await restore(request("removed", {}))).toBe(false);
    expect(navigations).toEqual([]);
    expect(await restore(request("users/:id", { "route.id": "7" }))).toBe(true);
    expect(navigations).toEqual(["/base/users/7"]);
    unmount(component);
  });

  test("a request aborted after its navigation began goes back to where the reviewer was, unless the app navigated since", async () => {
    page.url = new URL("http://localhost/base/?tab=notes#top");
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT } });
    await settle();
    const restore = latest().restoreContext!;
    let reviewer = new AbortController();
    afterNavigate = () => reviewer.abort();
    expect(await restore(request("users/:id", { "route.id": "8" }, reviewer.signal))).toBe(false);
    // The navigation committed after the abort, so it is replaced by the page the reviewer was on.
    expect(navigations).toEqual(["/base/users/8", "/base/?tab=notes#top"]);
    expect(gotoOptions.at(-1)).toEqual({ replace: true });
    expect(page.route.id).toBe("/");
    // SvelteKit 2 names the option replaceState.
    kitVersion("2.26.0");
    reviewer = new AbortController();
    expect(await restore(request("users/:id", { "route.id": "8" }, reviewer.signal))).toBe(false);
    expect(gotoOptions.at(-1)).toEqual({ replaceState: true });
    expect(page.route.id).toBe("/");
    // An app navigation that began meanwhile is left to finish.
    navigations.length = 0;
    reviewer = new AbortController();
    afterNavigate = () => {
      reviewer.abort();
      navigating.type = "link";
    };
    expect(await restore(request("users/:id", { "route.id": "9" }, reviewer.signal))).toBe(false);
    expect(navigations).toEqual(["/base/users/9"]);
    unmount(component);
  });

  test("the app's own callbacks win: its restoreContext replaces goto, its getContext is passed on", async () => {
    const restoreContext = () => true;
    const getContext = () => ({ persona: "Admin" });
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT, restoreContext, getContext } });
    await settle();
    expect(latest().restoreContext).toBe(restoreContext);
    expect(latest().getContext).toBe(getContext);
    unmount(component);
  });

  test("router={false} turns router integration off", async () => {
    page.route.id = "/users/[id]";
    page.params = { id: "42" };
    const component = mount(KitCritiqs, { target, props: { projectId: PROJECT, router: false } });
    await settle();
    expect(latest().restoreContext).toBeUndefined();
    expect(mounted[0]!.pushed).toEqual([{}]);
    unmount(component);
  });
});
