// critiqs-solid/router under a real Solid Router, run against whichever Solid
// and router the calling file loads. Routes: `/`, `/users/:id`,
// `/files/*rest` (a SolidStart `[...rest]` file), `/slow` (a route whose
// code never loads), `/later` (a route whose code loads when a test calls
// `later.load()`), `/team` with a child `/:member`, and a catch-all `*404`.
import { expect, test } from "bun:test";
import type { RestoreRequest } from "critiqs";
import type { CritiqsProps } from "../src/router.ts";
import { calls, lastOptions, pushed, settle } from "./recorder.ts";

export interface Harness {
  /** Renders `element` inside the router's layout, starting at `path`, under `base` when given; null `path` renders it with no router. */
  mount(path: string | null, element: () => unknown, base?: string): { go(path: string): void; back(): void; location(): string; dispose(): void };
  createComponent<T>(component: (props: T) => unknown, props: T): unknown;
  /** Called inside the router: refuses every navigation away, as an app guarding unsaved work does with `useBeforeLeave`. */
  blockLeaving(): void;
  flush?: () => void;
}

/** A lazy route's code: each mount gets a fresh one, which loads `component` when a test calls `load`. */
function deferred() {
  let load = () => {};
  return {
    /** What the route's lazy component waits for. */
    next(component: () => unknown): Promise<{ default: () => unknown }> {
      return new Promise((resolve) => {
        load = () => resolve({ default: component });
      });
    },
    load: () => load(),
  };
}

/** The code of the `/later` route. */
export const later = deferred();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const request = (screen: string, viewState: Record<string, string> = {}, signal = new AbortController().signal): RestoreRequest => ({
  threadId: "t1",
  screen,
  viewState,
  recordKey: null,
  scope: "record" as RestoreRequest["scope"],
  signal,
});

export function routesSuite(label: string, harness: Harness) {
  const { Critiqs } = require("../src/router.ts") as typeof import("../src/router.ts");
  const render = (path: string | null, props: CritiqsProps = { projectId: "p1" }, options: { base?: string; blockLeaving?: boolean } = {}) => {
    calls.length = 0;
    return harness.mount(
      path,
      () => {
        if (options.blockLeaving) harness.blockLeaving();
        return harness.createComponent(Critiqs, props);
      },
      options.base,
    );
  };
  const settle_ = () => settle(harness.flush, 8);

  test(`${label}: reports the route pattern and parameters on the first page and each navigation`, async () => {
    const app = render("/users/42");
    await settle_();
    expect(pushed()).toEqual([{ screen: "users/:id", viewState: { "route.id": "42" } }]);
    app.go("/files/specs/v2.pdf");
    await settle_();
    app.go("/");
    await settle_();
    expect(pushed().slice(1)).toEqual([
      { screen: "files/:rest*", viewState: { "route.rest": "specs/v2.pdf" } },
      { screen: "/", viewState: {} },
    ]);
    app.dispose();
  });

  test(`${label}: parameters are reported as the app reads them, decoded, and restore encodes them once`, async () => {
    const app = render("/users/caf%C3%A9%20menu");
    await settle_();
    expect(pushed()).toEqual([{ screen: "users/:id", viewState: { "route.id": "café menu" } }]);
    app.go("/files/r%C3%A9sum%C3%A9/2026%20draft.pdf");
    await settle_();
    expect(pushed().at(-1)).toEqual({ screen: "files/:rest*", viewState: { "route.rest": "résumé/2026 draft.pdf" } });
    const restore = lastOptions().restoreContext!;
    expect(await restore(request("users/:id", { "route.id": "café menu" }))).toBeUndefined();
    expect(app.location()).toBe("/users/caf%C3%A9%20menu");
    const before = pushed().length;
    // Already shown: restore doesn't navigate again.
    expect(await restore(request("users/:id", { "route.id": "café menu" }))).toBeUndefined();
    await settle_();
    expect(pushed().length).toBe(before);
    expect(app.location()).toBe("/users/caf%C3%A9%20menu");
    app.dispose();
  });

  test(`${label}: a nested route reports its whole pattern`, async () => {
    const app = render("/team/ana");
    await settle_();
    expect(pushed()).toEqual([{ screen: "team/:member", viewState: { "route.member": "ana" } }]);
    app.dispose();
  });

  test(`${label}: opening a thread from another route navigates there with the router, then resolves`, async () => {
    const app = render("/");
    await settle_();
    const restore = lastOptions().restoreContext!;
    const result = await restore(request("users/:id", { "route.id": "7", tab: "billing" }));
    expect(result).toBeUndefined();
    expect(app.location()).toBe("/users/7");
    await settle_();
    expect(pushed().at(-1)).toEqual({ screen: "users/:id", viewState: { "route.id": "7" } });
    app.dispose();
  });

  test(`${label}: a thread on the route already shown doesn't navigate; one with no route path returns false`, async () => {
    const app = render("/users/7");
    await settle_();
    const restore = lastOptions().restoreContext!;
    const before = pushed().length;
    expect(await restore(request("users/:id", { "route.id": "7" }))).toBeUndefined();
    await settle_();
    expect(pushed().length).toBe(before);
    expect(await restore(request("/legacy/page"))).toBe(false);
    expect(app.location()).toBe("/users/7");
    app.dispose();
  });

  test(`${label}: under a base path, routes are reported without the base and restore navigates under it once`, async () => {
    const app = render("/demo/users/42", undefined, { base: "/demo" });
    await settle_();
    expect(pushed()).toEqual([{ screen: "users/:id", viewState: { "route.id": "42" } }]);
    app.go("/demo");
    await settle_();
    expect(pushed().at(-1)).toEqual({ screen: "/", viewState: {} });
    const restore = lastOptions().restoreContext!;
    expect(await restore(request("users/:id", { "route.id": "7" }))).toBeUndefined();
    expect(app.location()).toBe("/demo/users/7");
    expect(await restore(request("/"))).toBeUndefined();
    expect(app.location()).toBe("/demo");
    app.dispose();
  });

  test(`${label}: a thread whose route is gone lands on the catch-all, and restore says it can't show it`, async () => {
    const app = render("/");
    await settle_();
    expect(await lastOptions().restoreContext!(request("old/:id", { "route.id": "1" }))).toBe(false);
    app.dispose();
  });

  test(`${label}: a guard that keeps the page makes restore return false`, async () => {
    const app = render("/users/1", undefined, { blockLeaving: true });
    await settle_();
    expect(await lastOptions().restoreContext!(request("users/:id", { "route.id": "2" }))).toBe(false);
    expect(app.location()).toBe("/users/1");
    app.dispose();
  });

  test(`${label}: a screen whose path keeps pattern tokens returns false without navigating`, async () => {
    const app = render("/");
    await settle_();
    expect(await lastOptions().restoreContext!(request("users/:year-:month", { "route.year": "2026", "route.month": "11" }))).toBe(false);
    expect(app.location()).toBe("/");
    app.dispose();
  });

  test(`${label}: an already-aborted request doesn't navigate`, async () => {
    const app = render("/");
    await settle_();
    const aborted = new AbortController();
    aborted.abort();
    expect(await lastOptions().restoreContext!(request("users/:id", { "route.id": "7" }, aborted.signal))).toBe(false);
    expect(app.location()).toBe("/");
    app.dispose();
  });

  test(`${label}: aborting while the route loads stops waiting and returns false`, async () => {
    const app = render("/");
    await settle_();
    const controller = new AbortController();
    const started = Date.now();
    const result = lastOptions().restoreContext!(request("slow", {}, controller.signal));
    setTimeout(() => controller.abort(), 100);
    expect(await result).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    app.dispose();
  });

  test(`${label}: once restore is aborted, Critiqs doesn't navigate again: a route that loads later shows, with one history entry`, async () => {
    const app = render("/");
    await settle_();
    app.go("/users/1");
    await settle_();
    const controller = new AbortController();
    const result = lastOptions().restoreContext!(request("later", {}, controller.signal));
    await sleep(100);
    controller.abort();
    expect(await result).toBe(false);
    expect(app.location()).toBe("/users/1");
    later.load();
    await settle_();
    await sleep(100);
    await settle_();
    expect(app.location()).toBe("/later");
    expect(pushed().at(-1)).toEqual({ screen: "later", viewState: {} });
    app.back();
    await settle_();
    expect(app.location()).toBe("/users/1");
    app.back();
    await settle_();
    expect(app.location()).toBe("/");
    app.dispose();
  });

  test(`${label}: a route that loads after restore stopped waiting shows, and Critiqs doesn't navigate again`, async () => {
    const app = render("/users/1");
    await settle_();
    expect(await lastOptions().restoreContext!(request("later"))).toBe(false);
    later.load();
    await settle_();
    await sleep(100);
    await settle_();
    expect(app.location()).toBe("/later");
    app.dispose();
  }, 10_000);

  test(`${label}: under a base path, a route that loads after an aborted restore shows once under the base, and the next restore still navigates`, async () => {
    const app = render("/demo?query=yes#anchor", undefined, { base: "/demo" });
    await settle_();
    const controller = new AbortController();
    const result = lastOptions().restoreContext!(request("later", {}, controller.signal));
    await sleep(100);
    controller.abort();
    expect(await result).toBe(false);
    later.load();
    await settle_();
    await sleep(100);
    await settle_();
    expect(app.location()).toBe("/demo/later");
    expect(await lastOptions().restoreContext!(request("users/:id", { "route.id": "7" }))).toBeUndefined();
    expect(app.location()).toBe("/demo/users/7");
    app.dispose();
  });

  test(`${label}: a navigation the app starts after an aborted restore is kept`, async () => {
    const app = render("/users/1");
    await settle_();
    const controller = new AbortController();
    const result = lastOptions().restoreContext!(request("later", {}, controller.signal));
    await sleep(100);
    controller.abort();
    expect(await result).toBe(false);
    app.go("/users/2");
    later.load();
    await settle_();
    await sleep(100);
    await settle_();
    expect(app.location()).toBe("/users/2");
    expect(pushed().at(-1)).toEqual({ screen: "users/:id", viewState: { "route.id": "2" } });
    app.dispose();
  });

  test(`${label}: a catch-all keeps an encoded / inside a segment apart from the / between segments, and restore rebuilds it`, async () => {
    const app = render("/files/one%2Ftwo/leaf%252Fname");
    await settle_();
    // Two segments, `one/two` and `leaf%2Fname`, each escaped as the shared convention stores a list.
    expect(pushed()).toEqual([{ screen: "files/:rest*", viewState: { "route.rest": "one%2Ftwo/leaf%252Fname" } }]);
    const viewState = (pushed()[0] as { viewState: Record<string, string> }).viewState;
    app.go("/");
    await settle_();
    expect(await lastOptions().restoreContext!(request("files/:rest*", viewState))).toBeUndefined();
    expect(app.location()).toBe("/files/one%2Ftwo/leaf%252Fname");
    app.dispose();
  });

  test(`${label}: after an aborted restore, the app navigating to the same route on its own is kept`, async () => {
    const app = render("/users/1");
    await settle_();
    const controller = new AbortController();
    const result = lastOptions().restoreContext!(request("later", {}, controller.signal));
    await sleep(100);
    controller.abort();
    expect(await result).toBe(false);
    await settle_();
    app.go("/later");
    later.load();
    await settle_();
    await sleep(100);
    await settle_();
    expect(app.location()).toBe("/later");
    app.dispose();
  });

  test(`${label}: a route that never finishes loading returns false once the wait runs out`, async () => {
    const app = render("/");
    await settle_();
    expect(await lastOptions().restoreContext!(request("slow"))).toBe(false);
    app.dispose();
  }, 10_000);

  test(`${label}: the app's own restoreContext replaces the default, and its getContext is passed on`, async () => {
    const restoreContext = () => true;
    const getContext = () => ({ screen: "custom" });
    const app = render("/users/1", { projectId: "p1", restoreContext, getContext });
    await settle_();
    expect(lastOptions().restoreContext).toBe(restoreContext);
    expect(lastOptions().getContext).toBe(getContext);
    expect(pushed()).toEqual([{ screen: "users/:id", viewState: { "route.id": "1" } }]);
    app.dispose();
  });

  test(`${label}: router={false} reports no route and restores nothing`, async () => {
    const app = render("/users/1", { projectId: "p1", router: false });
    await settle_();
    app.go("/users/2");
    await settle_();
    expect(calls.map(([kind]) => kind)).toEqual(["mount"]);
    expect(lastOptions().restoreContext).toBeUndefined();
    app.dispose();
  });

  test(`${label}: outside a router it runs as critiqs-solid does`, async () => {
    const app = render(null);
    await settle_();
    expect(calls.map(([kind]) => kind)).toEqual(["mount"]);
    expect(lastOptions().restoreContext).toBeUndefined();
    app.dispose();
  });
}
