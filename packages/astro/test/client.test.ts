// The browser side against Critiqs's real mountCritiqs (the built `critiqs`
// package; the workspace's typecheck builds it first) and Astro's real body
// swap, in one page whose tests run in order, as one visit to an Astro site
// with <ClientRouter />.
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { dirname } from "node:path";
import * as critiqs from "critiqs";
import type { CritiqsOptions, HostContext, RestoreRequest } from "critiqs";
import type { RouteTable, Router } from "../src/client.ts";

// What the package tells Critiqs: the settings it mounts with and the context it pushes.
let latest: CritiqsOptions = {};
const pushed: HostContext[] = [];
// Taken before mocking: the mock replaces the module's exports in place.
const realMount = critiqs.mountCritiqs;
mock.module("critiqs", () => ({
  ...critiqs,
  mountCritiqs(options: CritiqsOptions) {
    latest = options;
    const instance = realMount(options);
    return {
      ...instance,
      update(next: CritiqsOptions) {
        latest = next;
        instance.update(next);
      },
      setContext(context: HostContext) {
        pushed.push(context);
        instance.setContext(context);
      },
    };
  },
}));
const { configureCritiqs, restoreRoute, startCritiqs } = await import("../src/client.ts");

// Astro's own swap, as <ClientRouter /> runs it.
const astroDir = dirname(Bun.resolveSync("astro/package.json", import.meta.dir));
const { swapBodyElement } = (await import(Bun.resolveSync("@astrojs/runtime/_internal/transitions/swap-functions.js", astroDir))) as {
  swapBodyElement: (next: HTMLElement, old: HTMLElement) => void;
};
// The regular expression Astro matches a route with, for its `trailingSlash`.
const { getPattern } = (await import(Bun.resolveSync("./dist/core/routing/pattern.js", astroDir))) as {
  getPattern: (segments: Part[][], base: string, trailingSlash: RouteTable["trailingSlash"]) => RegExp;
};
type Part = { content: string; dynamic: boolean; spread: boolean };
const text = (content: string): Part => ({ content, dynamic: false, spread: false });
const param = (content: string): Part => ({ content, dynamic: true, spread: content.startsWith("...") });

/** A route table as the integration writes it, with Astro's own regular expressions. */
function astroRoutes(base: string, trailingSlash: RouteTable["trailingSlash"], routes: [string, Part[][]][]): RouteTable {
  return {
    base,
    trailingSlash,
    routes: routes.map(([pattern, segments]) => ({
      pattern,
      route: "/" + segments.map((segment) => segment.map((part) => (part.dynamic ? `[${part.content}]` : part.content)).join("")).join("/"),
      regex: getPattern(segments, base, trailingSlash).source,
      params: segments.flat().filter((part) => part.dynamic).map((part) => part.content.replace(/^\.\.\./, "")),
    })),
  };
}

const BACKEND = "http://localhost:9999/critiqs";
const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const SETTINGS = { projectId: PROJECT, requireProjectId: true, backend: BACKEND };
const realFetch = globalThis.fetch;

/** A server in the host app that knows `PROJECT` and no reviewer. */
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/critiqs/config")) return Response.json({ protocol: 5, transport: "http", signIn: "host", signInUrl: BACKEND });
  if (url.includes("/critiqs/health")) return Response.json({ protocol: 5, signIn: "host", project: "found" });
  if (url.endsWith("/me")) return Response.json({ reviewer: null });
  if (url.endsWith("/changes")) return Response.json({ version: 1 });
  return Response.json({ error: { code: "not-found", message: "Unknown request." } }, { status: 404 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** What the integration writes for `src/pages/index.astro`, `items/[id].astro` and `docs/[...slug].astro`, in Astro's priority order. */
const ROUTES: RouteTable = {
  base: "/",
  trailingSlash: "ignore",
  routes: [
    { pattern: "/items/:id", route: "/items/[id]", regex: "^\\/items\\/([^/]+?)\\/?$", params: ["id"] },
    { pattern: "/docs/:slug*", route: "/docs/[...slug]", regex: "^\\/docs(?:\\/(.*?))?\\/?$", params: ["slug"] },
    { pattern: "/", route: "/", regex: "^\\/$", params: [] },
  ],
};

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `ready()` holds, however long React takes to render Critiqs on a busy machine, and fails after 5 s. */
async function until(ready: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${ready}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const hosts = () => [...document.querySelectorAll("critiqs-root")];
const toolbar = () => hosts()[0]?.shadowRoot?.querySelector(".toolbar") ?? null;
const lastPushed = () => pushed[pushed.length - 1];

/** The route marker the integration's middleware puts in the page's head, naming the route Astro rendered the page from. */
function mark(route: string) {
  document.head.querySelector('meta[name="critiqs-astro-route"]')?.remove();
  document.head.insertAdjacentHTML("beforeend", `<meta name="critiqs-astro-route" content="${route}">`);
}

/** Marks the page as Astro's server renders `href`: from the first route whose regular expression matches its path, or the 404 page. */
function land(table: RouteTable, href: string) {
  const path = decodeURI(href.slice(table.base.replace(/\/+$/, "").length) || "/");
  const candidates = [path, path.endsWith("/") ? path.slice(0, -1) || "/" : `${path}/`];
  mark(table.routes.find((each) => candidates.some((candidate) => new RegExp(each.regex).test(candidate)))?.route ?? "/404");
}

/** What <ClientRouter /> does on a navigation: before-swap with the new page, Astro's body swap (or the site's own), the new URL, after-swap. */
async function clientNavigate(path: string, heading: string, swap = swapBodyElement) {
  const newDocument = new DOMParser().parseFromString(`<!doctype html><html><head></head><body><h1>${heading}</h1></body></html>`, "text/html");
  document.dispatchEvent(Object.assign(new Event("astro:before-swap"), { newDocument }));
  swap(newDocument.body, document.body);
  history.pushState(null, "", path);
  land(ROUTES, path);
  document.dispatchEvent(new Event("astro:after-swap"));
}

const navigations: string[] = [];
const router: Router = {
  routes: ROUTES,
  navigate: async (href) => {
    navigations.push(href);
    await clientNavigate(href, href);
  },
};

/** A <ClientRouter /> navigate that records each visit and moves the URL there, without a page swap, landing on the page `table` routes it to. */
const visiting = (visits: string[], table: RouteTable) => async (href: string) => {
  visits.push(href);
  history.pushState(null, "", href);
  land(table, href);
};

function restore(screen: string, viewState: Record<string, string> = {}) {
  const request: RestoreRequest = { threadId: "t1", screen, viewState, recordKey: null, scope: "page" as RestoreRequest["scope"], signal: new AbortController().signal };
  return latest.restoreContext!(request);
}

test("Critiqs starts on the first page and reports its route, with functions given before it starts", async () => {
  history.replaceState(null, "", "/items/42");
  land(ROUTES, "/items/42");
  document.body.innerHTML = "<h1>Item 42</h1>";
  const getContext = () => ({ persona: "Admin" });
  configureCritiqs({ getContext });
  startCritiqs(SETTINGS, router);
  await until(() => toolbar() !== null);
  expect(hosts()).toHaveLength(1);
  expect(lastPushed()).toEqual({ screen: "items/:id", viewState: { "route.id": "42" } });
  expect(latest.getContext).toBe(getContext);
});

test("Critiqs stays mounted, once, across a client-side navigation, and reports the new route", async () => {
  const [before] = hosts();
  const shown = toolbar();
  let carried = false;
  await clientNavigate("/docs/guide/setup", "Setup", (next, old) => {
    swapBodyElement(next, old);
    // Astro carried it into the new body itself, never taking it out of the page.
    carried = before!.parentElement === next;
  });
  await settle();
  expect(carried).toBe(true);
  expect(document.querySelector("h1")?.textContent).toBe("Setup");
  expect(hosts()).toEqual([before!]);
  expect(before!.parentElement).toBe(document.body);
  // The same interface, not a new one: its state lives on.
  expect(toolbar()).toBe(shown);
  expect(document.querySelector("template")).toBeNull();
  expect(lastPushed()).toEqual({ screen: "docs/:slug*", viewState: { "route.slug": "guide/setup" } });
});

test("a site's own swap that skips persisted elements still keeps Critiqs, once", async () => {
  const [before] = hosts();
  await clientNavigate("/", "Home", (next, old) => old.replaceWith(next));
  expect(hosts()).toEqual([before!]);
  expect(document.querySelector("template")).toBeNull();
  expect(lastPushed()).toEqual({ screen: "/", viewState: {} });
});

test("starting again, as the page's script does when the dev server reloads it, adds no second Critiqs", async () => {
  startCritiqs(SETTINGS, router);
  await clientNavigate("/items/1", "Item 1");
  startCritiqs(SETTINGS, router);
  await settle();
  expect(hosts()).toHaveLength(1);
});

test("a page outside every route leaves the screen to the URL path", async () => {
  await clientNavigate("/nowhere/at/all", "Lost");
  expect(lastPushed()).toEqual({});
});

test("restore opens a thread's page with <ClientRouter /> and resolves once it is shown", async () => {
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  await restore("items/:id", { "route.id": "7", tab: "billing" });
  expect(navigations).toEqual(["/items/7"]);
  expect(location.pathname).toBe("/items/7");
  expect(lastPushed()).toEqual({ screen: "items/:id", viewState: { "route.id": "7" } });
});

test("restore on the page already shown navigates nowhere", async () => {
  await restore("items/:id", { "route.id": "7" });
  expect(navigations).toEqual(["/items/7"]);
});

test("restore declines screens this site can't show", async () => {
  expect(await restore("/legacy/path")).toBe(false);
  expect(await restore("items/:id")).toBe(false);
  expect(await restore("users/:id", { "route.id": "1" })).toBe(false);
  expect(navigations).toEqual(["/items/7"]);
});

test("without <ClientRouter />, restore loads the page", async () => {
  document.head.innerHTML = "";
  const assign = spyOn(location, "assign").mockImplementation(() => {});
  await restore("docs/:slug*", { "route.slug": "a/b" });
  expect(assign).toHaveBeenCalledWith("/docs/a/b");
  expect(navigations).toEqual(["/items/7"]);
  assign.mockRestore();
});

test("a site under a base path reports routes within it and restores to it", async () => {
  history.replaceState(null, "", "/shop/items/3");
  const shopNavigations: string[] = [];
  startCritiqs(SETTINGS, { routes: { ...ROUTES, base: "/shop/", trailingSlash: "always" }, navigate: visiting(shopNavigations, { ...ROUTES, base: "/shop/" }) });
  expect(lastPushed()).toEqual({ screen: "items/:id", viewState: { "route.id": "3" } });
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  await restore("items/:id", { "route.id": "9" });
  expect(shopNavigations).toEqual(["/shop/items/9/"]);
  startCritiqs(SETTINGS, router);
});

test("parameters with reserved characters are reported decoded, and restore to their page", async () => {
  const visits: string[] = [];
  const routes = astroRoutes("/", "ignore", [
    ["/users/:id", [[text("users")], [param("id")]]],
    ["/files/:path*", [[text("files")], [param("...path")]]],
  ]);
  history.replaceState(null, "", "/users/user%40example.com");
  startCritiqs(SETTINGS, { routes, navigate: visiting(visits, routes) });
  expect(lastPushed()).toEqual({ screen: "users/:id", viewState: { "route.id": "user@example.com" } });
  history.replaceState(null, "", "/users/a%2Fb%2Bc%3Ad");
  startCritiqs(SETTINGS, { routes, navigate: visiting(visits, routes) });
  expect(lastPushed()).toEqual({ screen: "users/:id", viewState: { "route.id": "a/b+c:d" } });
  // A literal `%` is decoded once: `%2540` is `%40`, not `@`. A repeated parameter keeps each segment's own `%` escaped, as routeContext stores it.
  history.replaceState(null, "", "/files/100%2540/caf%C3%A9%20menu");
  startCritiqs(SETTINGS, { routes, navigate: visiting(visits, routes) });
  expect(lastPushed()).toEqual({ screen: "files/:path*", viewState: { "route.path": "100%2540/café menu" } });

  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  expect(await restore("users/:id", { "route.id": "user@example.com" })).toBe(true);
  expect(await restore("users/:id", { "route.id": "a/b+c:d" })).toBe(true);
  expect(visits).toEqual(["/users/user%40example.com", "/users/a%2Fb%2Bc%3Ad"]);
  startCritiqs(SETTINGS, router);
});

test("a repeated parameter keeps its segments apart, a / within one included", async () => {
  const visits: string[] = [];
  const routes = astroRoutes("/", "ignore", [
    ["/files/:path*", [[text("files")], [param("...path")]]],
    ["/", []],
  ]);
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  for (const [path, value] of [
    // Two segments, the first holding a `/`: not the three of /files/a/b/c.
    ["/files/a%2Fb/c", "a%2Fb/c"],
    // Two segments, the first holding the text `%2F`.
    ["/files/a%252Fb/c", "a%252Fb/c"],
  ] as const) {
    history.replaceState(null, "", path);
    land(routes, path);
    startCritiqs(SETTINGS, { routes, navigate: visiting(visits, routes) });
    expect(lastPushed()).toEqual({ screen: "files/:path*", viewState: { "route.path": value } });
    // Restored from another page, to the same page.
    history.replaceState(null, "", "/");
    land(routes, "/");
    expect(await restore("files/:path*", { "route.path": value })).toBe(true);
    expect(location.pathname).toBe(path);
  }
  expect(visits).toEqual(["/files/a%2Fb/c", "/files/a%252Fb/c"]);
  startCritiqs(SETTINGS, router);
});

test("each route is tried with and without a trailing slash, in Astro's order", async () => {
  // With trailingSlash "never", Astro's catch-all matches `/about/`, which only the `/about` page should claim.
  const routes = astroRoutes("/", "never", [
    ["/about", [[text("about")]]],
    ["/:slug*", [[param("...slug")]]],
  ]);
  history.replaceState(null, "", "/about/");
  startCritiqs(SETTINGS, { routes, navigate: async () => {} });
  expect(lastPushed()).toEqual({ screen: "about", viewState: {} });
  history.replaceState(null, "", "/guides/setup");
  startCritiqs(SETTINGS, { routes, navigate: async () => {} });
  expect(lastPushed()).toEqual({ screen: ":slug*", viewState: { "route.slug": "guides/setup" } });
  startCritiqs(SETTINGS, router);
});

test("the home page under a base path follows trailingSlash", async () => {
  const pages: [string, Part[][]][] = [
    ["/items/:id", [[text("items")], [param("id")]]],
    ["/", []],
  ];
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  for (const [trailingSlash, home, item] of [
    ["never", "/shop", "/shop/items/2"],
    ["always", "/shop/", "/shop/items/2/"],
    ["ignore", "/shop/", "/shop/items/2"],
  ] as const) {
    const visits: string[] = [];
    history.replaceState(null, "", "/shop/items/1");
    const routes = astroRoutes("/shop", trailingSlash, pages);
    startCritiqs(SETTINGS, { routes, navigate: visiting(visits, routes) });
    await restore("/");
    await restore("items/:id", { "route.id": "2" });
    expect(visits).toEqual([home, item]);
  }
  startCritiqs(SETTINGS, router);
});

test("pages built as .html files report their route, and a route whose file name has .html keeps it", async () => {
  const routes = astroRoutes("/", "ignore", [
    ["/posts/:slug.html", [[text("posts")], [param("slug"), text(".html")]]],
    ["/items/:id", [[text("items")], [param("id")]]],
    ["/about", [[text("about")]]],
  ]);
  for (const [path, context] of [
    ["/posts/hello.html", { screen: "posts/:slug.html", viewState: { "route.slug": "hello" } }],
    // As Astro's getParams gives the page: a page parameter never ends in `.html`.
    ["/items/7.html", { screen: "items/:id", viewState: { "route.id": "7" } }],
    ["/about/index.html", { screen: "about", viewState: {} }],
  ] as const) {
    history.replaceState(null, "", path);
    startCritiqs(SETTINGS, { routes, navigate: async () => {} });
    expect(lastPushed()).toEqual(context);
  }
  startCritiqs(SETTINGS, router);
});

test("restore builds a path whose segment mixes parameters and text from the route itself", async () => {
  const visits: string[] = [];
  const routes = astroRoutes("/", "ignore", [
    ["/posts/:slug.html", [[text("posts")], [param("slug"), text(".html")]]],
    ["/docs/:lang-:version", [[text("docs")], [param("lang"), text("-"), param("version")]]],
    ["/files/:path*", [[text("files")], [param("...path")]]],
  ]);
  history.replaceState(null, "", "/files/a");
  startCritiqs(SETTINGS, { routes, navigate: visiting(visits, routes) });
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  expect(await restore("posts/:slug.html", { "route.slug": "hello world" })).toBe(true);
  expect(await restore("docs/:lang-:version", { "route.lang": "en", "route.version": "v1" })).toBe(true);
  // Values that blur where they share a segment, and a missing one, can't be shown.
  expect(await restore("docs/:lang-:version", { "route.lang": "en-us", "route.version": "v1" })).toBe(false);
  expect(await restore("posts/:slug.html")).toBe(false);
  expect(visits).toEqual(["/posts/hello%20world.html", "/docs/en-v1"]);
  startCritiqs(SETTINGS, router);
});

test("restore reports false when the navigation settles on another page", async () => {
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  history.replaceState(null, "", "/");
  const stays: Router = { routes: ROUTES, navigate: async () => {} };
  startCritiqs(SETTINGS, stays);
  expect(await restore("items/:id", { "route.id": "4" })).toBe(false);
  expect(location.pathname).toBe("/");
  // A redirect to another item.
  startCritiqs(SETTINGS, { routes: ROUTES, navigate: async () => history.pushState(null, "", "/items/5") });
  expect(await restore("items/:id", { "route.id": "4" })).toBe(false);
  startCritiqs(SETTINGS, { routes: ROUTES, navigate: visiting([], ROUTES) });
  expect(await restore("items/:id", { "route.id": "4" })).toBe(true);
  startCritiqs(SETTINGS, router);
});

test("restore reports false when the URL shows the 404 page, as a static site does for an item it didn't build", async () => {
  document.head.innerHTML = '<meta name="astro-view-transitions-enabled" content="true">';
  history.replaceState(null, "", "/");
  land(ROUTES, "/");
  const visits: string[] = [];
  // <ClientRouter /> swaps in the 404 page the host serves at /items/deleted; the URL still matches items/:id.
  const missing: Router = {
    routes: ROUTES,
    navigate: async (href) => {
      visits.push(href);
      history.pushState(null, "", href);
      mark("/404");
    },
  };
  startCritiqs(SETTINGS, missing);
  expect(await restore("items/:id", { "route.id": "deleted" })).toBe(false);
  expect(location.pathname).toBe("/items/deleted");
  // Already on that URL: still not the item's page.
  expect(await restore("items/:id", { "route.id": "deleted" })).toBe(false);
  expect(visits).toEqual(["/items/deleted", "/items/deleted"]);
  startCritiqs(SETTINGS, router);
});

test("a navigation to a page without a body leaves Critiqs as it is", async () => {
  const errors: unknown[] = [];
  const onError = (event: Event) => errors.push((event as ErrorEvent).error ?? event);
  window.addEventListener("error", onError);
  // An XML page, or one whose <body> a site's script removed before the swap.
  const newDocument = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
  newDocument.body.remove();
  expect(newDocument.body).toBeNull();
  expect(() => document.dispatchEvent(Object.assign(new Event("astro:before-swap"), { newDocument }))).not.toThrow();
  window.removeEventListener("error", onError);
  expect(errors).toEqual([]);
  document.dispatchEvent(new Event("astro:after-swap"));
  expect(hosts()).toHaveLength(1);
});

test("the app's own restoreContext replaces the default", async () => {
  const restoreContext = () => true;
  configureCritiqs({ restoreContext });
  expect(latest.restoreContext).toBe(restoreContext);
  expect(latest.getContext).toBeUndefined();
  configureCritiqs({});
  expect(latest.restoreContext).toBe(restoreRoute);
});

test("with routes off, the screen is the URL path and nothing restores by default", async () => {
  history.replaceState(null, "", "/items/5");
  startCritiqs(SETTINGS, null);
  expect(lastPushed()).toEqual({});
  expect(latest.restoreContext).toBeUndefined();
  await clientNavigate("/items/6", "Item 6");
  expect(lastPushed()).toEqual({});
  expect(hosts()).toHaveLength(1);
});

test("without a project ID, Critiqs leaves the page as it is, also after a navigation", async () => {
  startCritiqs({ projectId: undefined, requireProjectId: true, backend: BACKEND }, router);
  await settle();
  expect(hosts()).toHaveLength(0);
  await clientNavigate("/items/8", "Item 8");
  await settle();
  expect(hosts()).toHaveLength(0);
});
