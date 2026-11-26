// What both entries share: start Critiqs after the first render, pass setting
// changes on, report the route, and remove Critiqs with the component. The
// shared `critiqs` package is loaded only in the browser, in its own chunk;
// the route helpers come from its small `critiqs/router` entry.
import * as Solid from "solid-js";
import type { CritiqsInstance, CritiqsOptions, HostContext, RestoreRequest } from "critiqs";
import { ROUTE_PARAM_PREFIX, routeContext, routePath } from "critiqs/router";

/** The settings, exactly as the shared package documents them. */
export type CritiqsProps = CritiqsOptions;

/** A matched route: its pattern in `:name` form and without the router's base, such as `/users/:id`, and its decoded parameters; a catch-all is its list of segments. */
export interface Route {
  pattern: string;
  params: Record<string, string | readonly string[] | undefined>;
}

/** What a router gives Critiqs: the route it shows now, and a way to show another. */
export interface Routes {
  /** Read reactively; null when no route matches. */
  current(): Route | null;
  /**
   * Shows `path`, a path under the router's base. Resolves true once the
   * router has settled, false when it couldn't start, was still loading after
   * three seconds, or `signal` aborted first.
   */
  navigate(path: string, signal: AbortSignal): Promise<boolean>;
}

/**
 * Solid 2 split `createEffect` into a tracked read and an untracked apply, and
 * renamed `onMount` to `onSettled`; Solid 1.9 has only the old forms. Apps on
 * both are current (SolidStart 2 still uses Solid 1.9), so the right form is
 * picked here. Only `createEffect`, which both export, is called: naming an
 * export one version lacks makes the app's bundler warn. `"onSettled" in
 * Solid` is settled when the app is bundled, so the other form is dropped.
 */
const solid2 = "onSettled" in Solid;
type Solid1Effect = (fn: () => void) => void;
type Solid2Effect = <T>(read: () => T, apply: (value: T) => void) => void;

/** Runs `apply` with `read()` after each change to what `read` reads. `apply` returns nothing: Solid 2 treats what an effect returns as its cleanup. */
export function watch<T>(read: () => T, apply: (value: T) => void): void {
  if (solid2) (Solid.createEffect as unknown as Solid2Effect)(read, apply);
  else (Solid.createEffect as unknown as Solid1Effect)(() => apply(read()));
}

/** Runs `fn` once, after the first render, in the browser only: Solid 1.9's `onMount`, an effect that tracks nothing. */
function afterRender(fn: () => void): void {
  watch(
    () => undefined,
    () => {
      Solid.untrack(fn);
    },
  );
}

/** Whether a route shows the thread's view: the same screen and the same route parameters. */
function shows(route: Route | null, request: RestoreRequest): boolean {
  if (route === null) return false;
  const here = routeContext(route.pattern, route.params);
  if (here.screen !== request.screen) return false;
  const keys = new Set([...Object.keys(here.viewState), ...Object.keys(request.viewState)].filter((key) => key.startsWith(ROUTE_PARAM_PREFIX)));
  return [...keys].every((key) => here.viewState[key] === request.viewState[key]);
}

/**
 * Runs Critiqs for one component: `props` are its settings, and `routes`,
 * when given, reports each route with `setContext` and shows a thread's route
 * again unless the app passes its own `restoreContext`. Returns what the
 * component renders: nothing.
 *
 * The same calls run on the server and in the browser, so Solid's hydration
 * keys line up; only the browser runs the callback that loads Critiqs.
 */
export function useCritiqs(props: CritiqsProps, routes?: Routes): null {
  let instance: CritiqsInstance | undefined;
  let removed = false;

  const restore =
    routes &&
    (async (request: RestoreRequest): Promise<false | void> => {
      if (request.signal.aborted) return false;
      const path = routePath(request);
      // A screen that isn't a route pattern, or a path that keeps a pattern's tokens (`users/:year-:month`), names no page.
      if (path === null || path.includes(":")) return false;
      if (shows(routes.current(), request)) return;
      if (!(await routes.navigate(path, request.signal))) return false;
      // A guard may have kept the page, or the path may now lead to another route (a catch-all) or none.
      return shows(routes.current(), request) ? undefined : false;
    });
  const options = (): CritiqsOptions => ({
    projectId: props.projectId,
    requireProjectId: props.requireProjectId,
    backend: props.backend,
    version: props.version,
    getContext: props.getContext,
    restoreContext: props.restoreContext ?? restore,
  });
  const context = (route: Route | null): HostContext => (route === null ? {} : routeContext(route.pattern, route.params));

  afterRender(() => {
    import("critiqs").then(
      (loaded) => {
        if (removed) return;
        // Read now: the settings and the route may have changed while Critiqs loaded.
        instance = loaded.mountCritiqs(options());
        if (routes) instance.setContext(context(Solid.untrack(routes.current)));
      },
      (error: unknown) => console.error("Critiqs: couldn't load Critiqs.", error),
    );
  });
  watch(options, (next) => {
    instance?.update(next);
  });
  if (routes) {
    watch(routes.current, (route) => {
      instance?.setContext(context(route));
    });
  }
  Solid.onCleanup(() => {
    removed = true;
    instance?.destroy();
    instance = undefined;
  });
  return null;
}
