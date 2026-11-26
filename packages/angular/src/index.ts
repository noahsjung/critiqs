// Critiqs for Angular: one provider for the app's config. Critiqs's interface
// lives in a shadow root on the page's body, outside every component, so a
// provider (not a component) adds it once for the whole app.
import { isPlatformBrowser, Location } from "@angular/common";
import {
  DestroyRef,
  type EnvironmentProviders,
  effect,
  Injector,
  inject,
  makeEnvironmentProviders,
  NgZone,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  runInInjectionContext,
  untracked,
} from "@angular/core";
import {
  type ActivatedRouteSnapshot,
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationStart,
  PRIMARY_OUTLET,
  Router,
  ROUTES,
  type Routes,
} from "@angular/router";
import type { CritiqsInstance, CritiqsOptions, RestoreRequest } from "critiqs";
import { routeContext, routePath } from "critiqs/router";

export type { CritiqsOptions, HostContext, RestoreRequest } from "critiqs";

/** The settings `provideCritiqs` takes: the shared `critiqs` settings, plus `router`. */
export interface CritiqsAngularOptions extends CritiqsOptions {
  /**
   * In an app with Angular Router (`provideRouter`), Critiqs reports each
   * route's pattern as the screen (`users/:id`) and its parameters as view
   * state (`route.id`), and, unless `restoreContext` is set, shows a thread
   * by navigating to its route. `false` turns this off. Defaults to `true`.
   */
  router?: boolean;
}

type Settings = CritiqsAngularOptions | (() => CritiqsAngularOptions);
/** The `critiqs` module with Critiqs's interface, loaded after the app starts; only its types and the route helpers are imported up front. */
type Critiqs = typeof import("critiqs");

/**
 * Adds Critiqs to the app: its toolbar, sidebar, and pins, above the app.
 * Put it in the providers of `app.config.ts`:
 *
 *     provideCritiqs({ projectId: "…" })
 *
 * `options` is the settings, or a function that returns them. A function runs
 * in an injection context, so it can `inject(Router)` for `restoreContext`,
 * and runs again whenever a signal it reads changes, so a signal also works.
 *
 * With Angular Router, each navigation reports its route, and a thread's
 * route is shown again with `router.navigateByUrl` (see `router`).
 *
 * Critiqs runs only in the browser: on the server (SSR, prerendering) this
 * does nothing. It loads as its own chunk after the app starts, runs outside
 * Angular's zone so its work never triggers change detection, and is removed
 * when the app is destroyed. `restoreContext` runs inside the zone, so the
 * navigation it starts updates the app.
 */
export function provideCritiqs(options: Settings): EnvironmentProviders {
  return makeEnvironmentProviders([provideEnvironmentInitializer(() => startCritiqs(options))]);
}

function startCritiqs(options: Settings): void {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
  const zone = inject(NgZone);
  const injector = inject(Injector);
  let settings: CritiqsAngularOptions | null = null;
  let critiqs: Critiqs | null = null;
  let instance: CritiqsInstance | null = null;
  let destroyed = false;
  let reported = false;

  // Pushes the current route; clears one pushed before when there is none to report.
  const report = () => {
    if (instance === null || routes === null) return;
    const route = settings?.router === false ? null : routes.current();
    if (route === null && !reported) return;
    reported = route !== null;
    const context = route === null ? {} : routeContext(route.pattern, route.params);
    const target = instance;
    zone.runOutsideAngular(() => target.setContext(context));
  };
  const routes = trackRoutes(report);

  // Mounts once both the settings and the module are ready; afterwards replaces the settings.
  const apply = () => {
    if (destroyed || settings === null || critiqs === null) return;
    const { router = true, ...shared } = settings;
    const { mountCritiqs } = critiqs;
    if (router && routes !== null) shared.restoreContext ??= routes.restore;
    const next = restoreInZone(zone, shared);
    zone.runOutsideAngular(() => {
      if (instance === null) instance = mountCritiqs(next);
      else instance.update(next);
    });
    routes?.follow(router);
    report();
  };

  if (typeof options === "function") {
    effect(() => {
      settings = runInInjectionContext(injector, options);
      untracked(apply);
    });
  } else {
    settings = options;
  }

  // Outside the zone, so loading Critiqs never delays the app becoming stable.
  zone
    .runOutsideAngular(() => import("critiqs"))
    .then(
      (module) => {
        critiqs = module;
        apply();
      },
      (error: unknown) => console.error("Critiqs: couldn't load critiqs.", error),
    );

  inject(DestroyRef).onDestroy(() => {
    destroyed = true;
    instance?.destroy();
    instance = null;
  });
}

interface RouteTracker {
  /** The activated route, or null before the first navigation and on routes without a pattern (`**`, `matcher`). */
  current(): Route | null;
  /** Calls `onNavigate` after each navigation while `on`. */
  follow(on: boolean): void;
  /** The default `restoreContext`: navigates to the thread's route, resolving once there, or false when it can't. */
  restore(request: RestoreRequest): Promise<boolean>;
}

/** A route's pattern in `:name` form (`users/:id`) and the parameters it names. */
interface Route {
  pattern: string;
  params: Record<string, string>;
}

/**
 * Follows Angular Router; null in an app without a router. `Router` itself
 * can always be injected, since it is provided in root, so the app's routes
 * (from `provideRouter` or `RouterModule.forRoot`) tell whether the app routes.
 */
function trackRoutes(onNavigate: () => void): RouteTracker | null {
  if (inject(ROUTES, { optional: true }) === null) return null;
  const router = inject(Router);
  const location = inject(Location);
  let subscription: { unsubscribe(): void } | null = null;
  inject(DestroyRef).onDestroy(() => subscription?.unsubscribe());
  const current = () => (router.navigated ? routeOf(router.routerState.snapshot.root) : null);
  return {
    current,
    follow(on) {
      if (on && subscription === null) {
        subscription = router.events.subscribe((event) => {
          if (event instanceof NavigationEnd) onNavigate();
        });
      } else if (!on) {
        subscription?.unsubscribe();
        subscription = null;
      }
    },
    async restore(request) {
      if (request.signal.aborted) return false;
      if (shows(current(), request)) return true;
      const path = routePath(request);
      // Only a route of the app's own can show the thread: a path that only `**` matches would open the app's "not found" page.
      if (path === null || !routable(router.config, request.screen)) return false;
      // Off the record until the route is checked: a lazily loaded route, a guard or a redirect can still land elsewhere, and only a verified arrival may touch history.
      const from = router.url;
      const fromState = location.getState();
      const there = await navigateAlone(router, () => router.navigateByUrl(path, { skipLocationChange: true }));
      // A newer navigation owns the router and the address bar now.
      if (there.overtaken) return false;
      // Once arrived, or once the reviewer has moved on (no way back then), the address bar records where the router is: one history entry.
      const arrived = there.arrived && shows(current(), request);
      if (arrived || request.signal.aborted) {
        if (router.url !== from) await navigateAlone(router, () => router.navigateByUrl(router.url));
        return arrived && !request.signal.aborted && shows(current(), request);
      }
      // Elsewhere: back to the reviewer's page, also off the record, so neither the address bar nor history ever moved.
      if (router.url !== from && (await navigateAlone(router, () => router.navigateByUrl(from, { skipLocationChange: true }))).overtaken) return false;
      // When the reviewer's own page refuses to be entered again, Angular writes the router's URL to the address bar: the reviewer's stays.
      if (location.path(true) !== from) location.replaceState(from, "", fromState);
      return false;
    },
  };
}

/**
 * Runs `navigate` and tells whether the navigation it starts arrived, and
 * whether another navigation started after it. Angular starts a navigation
 * synchronously, so its first `NavigationStart` is ours; a guard's redirect
 * continues it under a new id.
 */
async function navigateAlone(router: Router, navigate: () => Promise<boolean>): Promise<{ arrived: boolean; overtaken: boolean }> {
  let ours: number | null = null;
  let starting = true;
  let redirected = false;
  let overtaken = false;
  const subscription = router.events.subscribe((event) => {
    if (event instanceof NavigationStart) {
      if ((starting && ours === null) || redirected) ours = event.id;
      else overtaken = true;
      redirected = false;
    } else if (event instanceof NavigationCancel && event.id === ours && event.code === NavigationCancellationCode.Redirect) {
      redirected = true;
    }
  });
  try {
    const navigation = navigate();
    starting = false;
    const arrived = await navigation.catch(() => false);
    return { arrived, overtaken };
  } finally {
    subscription.unsubscribe();
  }
}

/** Whether `route` is the thread's screen with the same route parameters. */
function shows(route: Route | null, request: RestoreRequest): boolean {
  if (route === null) return false;
  const { screen, viewState } = routeContext(route.pattern, route.params);
  return screen === request.screen && Object.entries(viewState).every(([key, value]) => request.viewState[key] === value);
}

/**
 * Whether one of `config`'s primary routes has the pattern `screen`, skipping
 * `**`, `matcher`, redirect and named-outlet routes. Routes loaded later
 * (`loadChildren`) might, when `screen` is under them; the navigation itself
 * then tells.
 */
function routable(config: Routes, screen: string, prefix = ""): boolean {
  return config.some((route) => {
    if (route.path === undefined || route.path === "**" || route.redirectTo !== undefined) return false;
    if ((route.outlet ?? PRIMARY_OUTLET) !== PRIMARY_OUTLET) return false;
    const pattern = routeContext(`${prefix}/${route.path}`, {}).screen;
    if (pattern === screen || (route.children !== undefined && routable(route.children, screen, pattern))) return true;
    return route.loadChildren !== undefined && route.children === undefined && (pattern === "/" || screen.startsWith(`${pattern}/`));
  });
}

/**
 * The activated route: its configs' paths from root to leaf along the
 * primary outlet (`users/:id`), and the parameters they name; null on a
 * route without a pattern, a `**` wildcard or a custom `matcher`, where the
 * screen stays the URL path.
 */
function routeOf(root: ActivatedRouteSnapshot): Route | null {
  const paths: string[] = [];
  const params: Record<string, string> = {};
  for (let route: ActivatedRouteSnapshot | undefined = root; route !== undefined; route = route.children.find((child) => child.outlet === PRIMARY_OUTLET)) {
    if (route.routeConfig === null) continue;
    const { path } = route.routeConfig;
    if (path === undefined || path === "**") return null;
    if (path === "") continue;
    paths.push(path);
    // Each parameter from the URL segment it matched: Angular's `params` also holds matrix parameters (`;id=99`), which win over the path's own.
    path.split("/").forEach((part, index) => {
      const segment = route.url[index];
      if (part.startsWith(":") && segment !== undefined) params[part.slice(1)] = segment.path;
    });
  }
  return { pattern: paths.join("/"), params };
}

/** Critiqs calls `restoreContext` from outside the zone; navigation it starts must run inside it. */
function restoreInZone(zone: NgZone, options: CritiqsOptions): CritiqsOptions {
  const { restoreContext } = options;
  if (restoreContext === undefined) return options;
  return { ...options, restoreContext: (request) => zone.run(() => restoreContext(request)) };
}
