// Critiqs in the browser, started by the script the integration adds to every
// page. With Astro's <ClientRouter />, a navigation replaces the page's whole
// <body>, which would take Critiqs with it. Critiqs asks Astro to carry it
// into each new body, as `transition:persist` does for a page's own elements,
// so it stays mounted (sidebar, sign-in, drafts) across navigations, once per
// page. Each page's route is reported as the screen, and a thread on another
// page is shown by navigating there.
import { type CritiqsInstance, type CritiqsOptions, type HostContext, mountCritiqs, ROUTE_PARAM_PREFIX, type RestoreRequest, routeContext, routePath } from "critiqs";
import { ROUTE_META } from "./marker.js";

/** The settings that are functions, so they come from a script on the page rather than astro.config. */
export type CritiqsHooks = Pick<CritiqsOptions, "getContext" | "restoreContext">;

type Settings = Omit<CritiqsOptions, keyof CritiqsHooks>;

/** The site's pages, as the integration writes them when the site builds. */
export interface RouteTable {
  /** Astro's `base`, such as `/` or `/docs`. */
  base: string;
  trailingSlash: "always" | "never" | "ignore";
  /**
   * In Astro's priority order, so the first match is the route Astro served.
   * `pattern` is in `:name` form (`/items/:id`), `route` is Astro's own
   * (`/items/[id]`), as the page's route marker names it.
   */
  routes: Route[];
}

type Route = { pattern: string; route: string; regex: string; params: string[] };
type RouteContext = Required<Pick<HostContext, "screen" | "viewState">>;

/** Routes for the current site, and the <ClientRouter /> navigation. */
export interface Router {
  routes: RouteTable;
  navigate: (href: string) => Promise<void>;
}

interface State {
  settings: Settings | null;
  hooks: CritiqsHooks;
  router: Router | null;
  instance: CritiqsInstance | null;
}

/** The element Critiqs puts its shadow root on, appended to the page's body. */
const HOST_TAG = "critiqs-root";
/** How Astro marks an element to carry into the next page's body; see `transition:persist`. */
const PERSIST_ATTRIBUTE = "data-astro-transition-persist";
const PERSIST_ID = "critiqs";

// One Critiqs per page, even when this module runs again, as it does when the
// dev server reloads it.
const store = globalThis as { [key: symbol]: State | undefined };
const KEY = Symbol.for("critiqs-astro");
const state: State = (store[KEY] ??= { settings: null, hooks: {}, router: null, instance: null });

/**
 * Starts Critiqs with the settings from astro.config, or updates it when it
 * has already started. Called by the script `critiqs()` adds to every page;
 * apps don't call it themselves. Without `router`, the screen is the URL path.
 */
export function startCritiqs(settings: Settings, router: Router | null = null): void {
  state.settings = settings;
  state.router = router;
  if (state.instance !== null) {
    render();
    reportRoute();
    return;
  }
  state.instance = mountCritiqs(options(settings));
  reportRoute();
  keepAcrossNavigations();
}

/**
 * Gives Critiqs `getContext` and `restoreContext`, which astro.config can't
 * hold because they are functions. Call it from a `<script>` in your layout;
 * it works whether it runs before or after Critiqs starts. Each call replaces
 * both, as `CritiqsOptions` documents them. Your `restoreContext` replaces
 * the one that opens a thread's page; what your `getContext` reports wins over
 * the route.
 */
export function configureCritiqs(hooks: CritiqsHooks): void {
  state.hooks = hooks;
  render();
}

function options(settings: Settings): CritiqsOptions {
  const restoreContext = state.hooks.restoreContext ?? (state.router === null ? undefined : restoreRoute);
  return { ...settings, getContext: state.hooks.getContext, restoreContext };
}

function render(): void {
  if (state.settings !== null) state.instance?.update(options(state.settings));
}

/** Tells Critiqs the current page's route, or nothing when it matches none, leaving the URL path. */
function reportRoute(): void {
  const shown = state.router === null ? null : matchRoute(state.router.routes, location.pathname);
  state.instance?.setContext(shown?.context ?? {});
}

/** Carries Critiqs into each new body when <ClientRouter /> swaps pages, and reports the new page's route. */
function keepAcrossNavigations(): void {
  let host: Element | null = null;
  document.addEventListener("astro:before-swap", (event) => {
    const next = (event as Event & { newDocument?: Document }).newDocument;
    host = document.body.querySelector(`:scope > ${HOST_TAG}`);
    if (host === null || next?.body == null) return;
    // Astro moves a persisted element into the new body in place of its match there, without taking it out of the page.
    host.setAttribute(PERSIST_ATTRIBUTE, PERSIST_ID);
    const placeholder = next.createElement("template");
    placeholder.setAttribute(PERSIST_ATTRIBUTE, PERSIST_ID);
    next.body.append(placeholder);
  });
  document.addEventListener("astro:after-swap", () => {
    // A site's own swap may skip persisted elements; move Critiqs over then.
    document.querySelector(`template[${PERSIST_ATTRIBUTE}="${PERSIST_ID}"]`)?.remove();
    if (host !== null && !host.isConnected) document.body.append(host);
    host = null;
    reportRoute();
  });
}

/** The route Astro serves `pathname` from, and its context as Critiqs reports it, or null. */
function matchRoute(table: RouteTable, pathname: string): { route: Route; context: RouteContext } | null {
  const relative = withoutBase(table.base, pathname);
  if (relative === null) return null;
  let path: string;
  try {
    path = decodeForMatching(relative);
  } catch {
    return null;
  }
  // Astro serves `/items/1.html` and `/items/1/index.html` as `/items/1` when it builds files.
  const stripped = path.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  for (const route of table.routes) {
    // As Astro's getParams: a page's parameters never end in `.html`, unless the route's own file name has it (`[slug].html.astro`).
    const candidates = route.pattern.includes(".html") ? [path] : [stripped, path];
    for (const candidate of candidates.flatMap((each) => [each, toggleSlash(each)])) {
      const match = new RegExp(route.regex).exec(candidate);
      if (match === null) continue;
      const params: Record<string, string | string[] | undefined> = {};
      for (const [index, name] of route.params.entries()) {
        const value = match[index + 1];
        if (!value) continue;
        const segments = decodeSegments(value);
        if (segments === null) return null;
        // A repeated parameter goes as its segments, so routeContext keeps a `/` within one (`a%2Fb`) apart from the `/` between them.
        params[name] = route.pattern.split("/").includes(`:${name}*`) ? segments : segments.join("/");
      }
      return { route, context: routeContext(route.pattern, params) };
    }
  }
  return null;
}

/** `/a` as `/a/` and back, since Astro's routes match one form or both depending on `trailingSlash`. */
function toggleSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) || "/" : `${path}/`;
}

/**
 * The path as Astro matches it, decoded with decodeURI, which keeps the
 * reserved characters (`/`, `@`, `+`, ...) encoded so segments stay apart.
 * `%25` stays encoded too, so decoding a parameter afterwards decodes each
 * character once.
 */
function decodeForMatching(path: string): string {
  return path
    .split(/(%25)/i)
    .map((part, index) => (index % 2 === 1 ? part : decodeURI(part)))
    .join("");
}

/** A parameter's `/`-separated segments as the page's URL means them, each decoded once; null when one isn't valid encoding. */
function decodeSegments(value: string): string[] | null {
  try {
    return value.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** `pathname` relative to Astro's `base`, starting with `/`, or null when it is outside it. */
function withoutBase(base: string, pathname: string): string | null {
  const prefix = base.replace(/\/+$/, "");
  if (prefix === "") return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
}

/** `path` under Astro's `base`, with the trailing slash `trailingSlash` asks for. */
function withBase(table: RouteTable, path: string): string {
  const prefix = table.base.replace(/\/+$/, "");
  if (prefix === "") return path === "/" || table.trailingSlash !== "always" ? path : `${path}/`;
  if (path === "/") return table.trailingSlash === "never" ? prefix : `${prefix}/`;
  return table.trailingSlash === "always" ? `${prefix}${path}/` : `${prefix}${path}`;
}

/** The route parameters of a context, to compare two. */
function routeKey(context: Pick<HostContext, "screen" | "viewState">): string {
  const params = Object.entries(context.viewState ?? {}).filter(([key]) => key.startsWith(ROUTE_PARAM_PREFIX));
  return JSON.stringify([context.screen, params.sort(([a], [b]) => (a < b ? -1 : 1))]);
}

/**
 * The default `restoreContext`: shows a thread's page by navigating to the
 * path its route and parameters build, with <ClientRouter /> where the page
 * has it and a page load otherwise, and resolves once the page is shown.
 * Returns false when no page of this site has that route, when routes are
 * off, or when the navigation settles on another page (a redirect, a newer
 * navigation, or the 404 page shown at that URL for a page that doesn't
 * exist). Call it from your own `restoreContext` to fall back to it.
 */
export async function restoreRoute(request: RestoreRequest): Promise<boolean | void> {
  const router = state.router;
  const path = router === null ? null : pathFor(router.routes, request);
  if (router === null || path === null) return false;
  if (showsRoute(router.routes, location.pathname, request, true)) return true;
  if (request.signal.aborted) return;
  const href = withBase(router.routes, path);
  if (document.querySelector('meta[name="astro-view-transitions-enabled"]') === null) {
    location.assign(href);
    return;
  }
  await router.navigate(href);
  return showsRoute(router.routes, location.pathname, request, true);
}

/**
 * Whether `pathname` is the page of the request's route with its parameters.
 * With `rendered`, the page shown must also be the one Astro rendered from
 * that route, as the integration marks each page: a URL can match a route
 * whose page doesn't exist and show the 404 page.
 */
function showsRoute(table: RouteTable, pathname: string, request: Pick<HostContext, "screen" | "viewState">, rendered = false): boolean {
  const shown = matchRoute(table, pathname);
  if (shown === null || routeKey(shown.context) !== routeKey(request)) return false;
  return !rendered || document.querySelector(`meta[name="${ROUTE_META}"]`)?.getAttribute("content") === shown.route.route;
}

/**
 * The path, within `base`, of the page that shows the request's route and
 * parameters, or null. The shared routePath builds most; a segment that
 * mixes parameters and text (`[slug].html`, `[lang]-[version]`) is built from
 * the route's own pattern. A path counts only when it leads back to the same
 * route and parameters, since values can blur where they share a segment.
 */
function pathFor(table: RouteTable, request: RestoreRequest): string | null {
  const root = { ...table, base: "/" };
  const shared = routePath(request);
  if (shared !== null && showsRoute(root, shared, request)) return shared;
  const route = table.routes.find((each) => routeContext(each.pattern, {}).screen === request.screen);
  const built = route === undefined ? null : buildPath(route, request.viewState);
  return built !== null && showsRoute(root, built, request) ? built : null;
}

/** The route's pattern with each `:name` (or repeated `:name*`) replaced by its encoded value, as routePath encodes them; null when a value is missing. */
function buildPath(route: RouteTable["routes"][number], viewState: RestoreRequest["viewState"]): string | null {
  if (route.params.length === 0) return route.pattern;
  // Longest names first, so `:idx` isn't read as `:id` followed by `x`.
  const names = [...route.params].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const token = new RegExp(`:(${names.join("|")})(\\*?)`, "g");
  let missing = false;
  const path = route.pattern.replace(token, (_, name: string, repeated: string) => {
    const value = viewState[`${ROUTE_PARAM_PREFIX}${name}`];
    if (typeof value !== "string" || value === "") {
      missing ||= repeated === "";
      return "";
    }
    if (repeated === "") return encodeURIComponent(value);
    // routeContext escapes each repeated value's own `/` and `%`.
    return value
      .split("/")
      .filter((part) => part !== "")
      .map((part) => encodeURIComponent(part.replace(/%2F/gi, "/").replaceAll("%25", "%")))
      .join("/");
  });
  return missing ? null : `/${path.split("/").filter((segment) => segment !== "").join("/")}`;
}
