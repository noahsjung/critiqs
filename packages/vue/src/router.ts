// Vue Router integration, shared by <Critiqs> and critiqs-nuxt (published as
// critiqs-vue/router): each navigation reports the route's pattern as the
// screen and its parameters as view state, and a thread's route is shown again
// with router.push. Typed by shape, so this package needs no Vue Router
// dependency; Nuxt's router has the same shape. The route helpers come from
// critiqs/router, which carries none of Critiqs's interface.
import type { CritiqsInstance, CritiqsOptions, RestoreRequest, ViewState } from "critiqs";
import { ROUTE_PARAM_PREFIX, routeContext, routePath } from "critiqs/router";

/** What Critiqs reads from a route: its matched records' paths and its parameters. */
export interface RouteLike {
  matched: ReadonlyArray<{ path: string }>;
  params: Record<string, string | readonly string[] | undefined>;
}

/** A route as a navigation guard sees it: where it leads, and the navigation a redirect came from. */
export interface GuardRouteLike extends RouteLike {
  fullPath: string;
  redirectedFrom?: { fullPath: string } | undefined;
}

/** What Critiqs uses of a Vue Router instance. */
export interface RouterLike {
  currentRoute: { value: RouteLike };
  resolve(to: string): GuardRouteLike;
  push(to: string): Promise<unknown>;
  afterEach(guard: (to: RouteLike, from: RouteLike, failure?: unknown) => unknown): () => void;
  beforeResolve(guard: (to: GuardRouteLike) => unknown): () => void;
  getRoutes(): readonly unknown[];
}

/** `NavigationFailureType.duplicated`: push to the route already showing. */
const DUPLICATED = 16;

/** The app's Vue Router, or null when it has none (or only Nuxt's stand-in for apps without pages). */
export function usableRouter(candidate: unknown): RouterLike | null {
  const router = candidate as Partial<RouterLike> | null | undefined;
  if (typeof router?.afterEach !== "function" || typeof router.beforeResolve !== "function" || typeof router.push !== "function" || typeof router.resolve !== "function") return null;
  if (typeof router.getRoutes !== "function" || router.currentRoute === undefined) return null;
  return router.getRoutes().length > 0 ? (router as RouterLike) : null;
}

/**
 * A Vue Router path in the shared `:name` form: custom parameter patterns go,
 * modifiers stay. `/users/:id(\\d+)` → `/users/:id`, `/:slug(.*)*` →
 * `/:slug*`, and Nuxt's `/users/:id()` → `/users/:id`.
 */
export function routePattern(path: string): string {
  return path.replace(/(:\w+)\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)/g, "$1");
}

/** The screen and view state for a route, or null when no route matched. */
export function routeOf(route: RouteLike): { screen: string; viewState: ViewState } | null {
  const record = route.matched.at(-1);
  return record === undefined ? null : routeContext(routePattern(record.path), route.params);
}

/** Reports the current route to Critiqs, and every route navigated to after it. Returns a function that stops. */
export function followRouter(router: RouterLike, instance: Pick<CritiqsInstance, "setContext">): () => void {
  const report = (route: RouteLike) => instance.setContext(routeOf(route) ?? {});
  report(router.currentRoute.value);
  return router.afterEach((to, _from, failure) => {
    if (failure === undefined) report(to);
  });
}

const routeParams = (viewState: ViewState) =>
  JSON.stringify(Object.entries(viewState).filter(([key]) => key.startsWith(ROUTE_PARAM_PREFIX)).sort(([a], [b]) => a.localeCompare(b)));

/** Whether `route` shows the target's screen with its route parameters. */
function shows(route: RouteLike, target: { screen: string; viewState: ViewState }): boolean {
  const current = routeOf(route);
  return current?.screen === target.screen && routeParams(current.viewState) === routeParams(target.viewState);
}

/**
 * A restoreContext that shows a thread's route with router.push, resolving
 * once the navigation has settled. False, without navigating, when Critiqs
 * aborted the request or the thread's screen isn't one of this app's routes
 * (a custom screen, a removed route, or a pattern the shared convention
 * can't build). False too when a navigation guard stops or redirects it, and
 * when Critiqs aborts it while a guard holds it, which cancels it.
 */
export function routerRestore(router: RouterLike): NonNullable<CritiqsOptions["restoreContext"]> {
  return async ({ screen, viewState, signal }: RestoreRequest) => {
    if (signal.aborted) return false;
    const path = routePath({ screen, viewState });
    // Parameter values are encoded, so a colon left in the path is a pattern the convention couldn't fill (`/blog/:slug-:id`).
    if (path === null || path.includes(":")) return false;
    // The route the path leads to must be the thread's: a catch-all or another route means the screen is gone.
    const resolved = router.resolve(path);
    const target = routeOf(resolved);
    if (target === null || target.screen !== screen) return false;
    if (shows(router.currentRoute.value, target)) return true;
    // Runs after every other guard, so the restore's navigation (or a redirect
    // of it) held by one stops here once Critiqs has aborted the request.
    // Navigations elsewhere, such as one the app starts meanwhile, go ahead.
    const ours = (to: GuardRouteLike) => to.fullPath === resolved.fullPath || to.redirectedFrom?.fullPath === resolved.fullPath;
    const cancel = router.beforeResolve((to) => (signal.aborted && ours(to) ? false : undefined));
    try {
      // Vue Router resolves push with a failure, rather than throwing, when a guard stops it.
      const failure = await router.push(path);
      if (signal.aborted) return false;
      if (failure instanceof Error && (failure as { type?: unknown }).type !== DUPLICATED) return false;
      // A guard may have redirected to another route.
      return shows(router.currentRoute.value, target);
    } finally {
      cancel();
    }
  };
}
