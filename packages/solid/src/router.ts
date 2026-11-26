// <Critiqs> for apps with Solid Router (1 or 2; older routers run without routes): besides what `critiqs-solid`
// does, it reports each route, so threads name `users/:id` rather than
// `/users/42`, and shows a thread's route again with the router's navigate.
import * as Router from "@solidjs/router";
import * as Solid from "solid-js";
import { type CritiqsProps as Settings, type Route, type Routes, useCritiqs } from "./core.js";

export type { HostContext, RestoreRequest } from "critiqs";

export interface CritiqsProps extends Settings {
  /**
   * Reports routes and shows a thread's route again. On by default; `false`
   * turns both off. Read once, when the component is created.
   */
  router?: boolean;
}

interface Match {
  params: Record<string, string | undefined>;
  /** The URL path the route's own segments matched, as the URL writes it: everything before a catch-all. */
  path?: string;
  route: { pattern: string };
}
/**
 * What Solid Router 1 and 2 share in the router context they export: the
 * current matches, outermost first, and the `base` path every pattern starts
 * with, which resolves paths as the router's navigate does.
 */
interface RouterState {
  matches(): Match[];
  base?: { path(): string; resolvePath?(to: string): string | undefined };
}

/**
 * A Solid Router pattern in the shared `:name` form: a named rest (`*rest`,
 * as SolidStart's `[...rest]` files become) is `:rest*`.
 */
export function routePattern(pattern: string): string {
  return pattern.replace(/(^|\/)\*([\w-]+)/g, "$1:$2*");
}

/** A matched pattern as the app's routes write it: the router puts its `base` (`/demo`) in front of each. */
function withoutBase(pattern: string, base: string): string {
  if (base === "" || base === "/") return pattern;
  if (pattern === base) return "/";
  return pattern.startsWith(`${base}/`) ? pattern.slice(base.length) : pattern;
}

/**
 * What to pass the router's navigate to show `path`, a path under its base.
 * Router 1 puts the base in front of a path starting with `/`; Router 2 reads
 * such a path as the whole URL path, so it is given the base too.
 */
function navigationPath(path: string, base: RouterState["base"]): string {
  const prefix = base === undefined || base.path() === "/" ? "" : base.path();
  const full = `${prefix}${path === "/" && prefix !== "" ? "" : path}`;
  return base?.resolvePath?.(path) === full ? path : full;
}

/** One path segment decoded, as Router 2 decodes it; a malformed escape is kept as written. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A match's parameters, decoded. Router 2 decodes each parameter (`café
 * menu`); Router 1 gives it as the URL writes it (`caf%C3%A9%20menu`), so it
 * is decoded here as Router 2 does. Both join a catch-all's segments with `/`
 * after decoding them, which loses where a segment held an encoded `/`
 * (`one%2Ftwo`), so a catch-all is read again from the URL `pathname`: the
 * segments after the ones the route's own segments matched, each decoded once.
 */
const decodesParams = "useRouteMatches" in Router;
function matchParams(match: Match, pathname: string): Route["params"] {
  const params: Route["params"] = decodesParams ? { ...match.params } : Object.fromEntries(Object.entries(match.params).map(([key, value]) => [key, value === undefined ? value : decodeSegment(value)]));
  const splat = match.route.pattern.split("/*", 2)[1];
  if (!splat || match.path === undefined || match.params[splat] === undefined) return params;
  const segments = (path: string) => path.split("/").filter((segment) => segment !== "");
  const own = segments(match.path).length;
  const all = segments(pathname);
  // The router matched another spelling of the path (an app's `transformUrl`): keep what it reported.
  if (all.length < own) return params;
  params[splat] = all.slice(own).map(decodeSegment);
  return params;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How long restore waits for the router to load a route, as long as Critiqs waits for the view. */
const SETTLE_MS = 3000;

/**
 * The router this component is rendered under, or undefined outside one.
 * Router 1's `useCurrentMatches` and Router 2's `useRouteMatches` both read
 * the matches from the router context; it is read here directly, since naming
 * a hook one version lacks makes the app's bundler warn.
 */
function routes(): Routes | undefined {
  let router: RouterState | undefined;
  try {
    router = Solid.useContext(Router.RouterContext as unknown as Solid.Context<RouterState | undefined>);
  } catch {
    // Router 2 throws outside a router; Router 1 reads undefined.
  }
  if (router === undefined) return undefined;
  const state = router;
  const navigate = Router.useNavigate();
  const isRouting = Router.useIsRouting();
  const location = Router.useLocation();

  return {
    current(): Route | null {
      const leaf = state.matches().at(-1);
      if (leaf === undefined) return null;
      return { pattern: routePattern(withoutBase(leaf.route.pattern, state.base?.path() ?? "")), params: matchParams(leaf, location.pathname) };
    },
    // Restore only starts a navigation and waits for it. Once it aborts or
    // stops waiting, the router may still finish loading the route and show
    // it. Navigating again to cancel it would add a history entry under
    // Router 2, which makes any navigation started meanwhile a redirect of the
    // pending one, pushed as it was; and it could undo a navigation the app
    // made itself.
    async navigate(path, signal) {
      try {
        navigate(navigationPath(path, state.base));
      } catch {
        // The router throws for a path it can't route.
        return false;
      }
      const deadline = Date.now() + SETTLE_MS;
      for (;;) {
        await sleep(16);
        if (signal.aborted) return false;
        if (!isRouting()) return true;
        if (Date.now() >= deadline) return false;
      }
    },
  };
}

/**
 * Adds Critiqs to the page, as `critiqs-solid`'s `<Critiqs>` does, and, under
 * a Solid Router, reports each route with its pattern as the screen (such as
 * `users/:id`) and its parameters as view state (`route.id`). Opening a
 * thread from another route navigates there, unless the app passes its own
 * `restoreContext`. The app's `getContext` still wins for each key it
 * reports. Outside a router it works as `critiqs-solid` does.
 */
export function Critiqs(props: CritiqsProps): null {
  return useCritiqs(props, props.router === false ? undefined : routes());
}
