// Angular Router integration: each navigation reports its route, and a
// thread's route is shown again by navigating, unless the app says otherwise.
import { calls, waitForCalls } from "./fake-critiqs.ts";
import { beforeEach, expect, test } from "bun:test";
import { ApplicationRef, inject, provideZonelessChangeDetection, signal } from "@angular/core";
import { createApplication } from "@angular/platform-browser";
import { NavigationEnd, NavigationStart, provideRouter, Router, type Routes } from "@angular/router";
import type { RestoreRequest } from "critiqs";
import { type CritiqsAngularOptions, provideCritiqs } from "../src/index.ts";

// A page that refuses to be entered again, as a guard on unsaved work or a one-time link would.
let usersOpen = true;

const routes: Routes = [
  { path: "", children: [] },
  { path: "users/:id", canActivate: [() => usersOpen], children: [{ path: "chat", outlet: "aside", children: [] }] },
  { path: "admin", canActivate: [() => inject(Router).parseUrl("/")], children: [] },
  { path: "teams/:team", children: [{ path: "members/:member", children: [] }] },
  { matcher: (segments) => (segments[0]?.path === "files" ? { consumed: segments } : null), children: [] },
  { path: "lazy", loadChildren: () => Promise.resolve([{ path: "known", children: [] }]) },
  { path: "old", redirectTo: "/" },
  { path: "chat", outlet: "aside", children: [] },
  { path: "**", children: [] },
];

beforeEach(() => {
  calls.length = 0;
  usersOpen = true;
  history.replaceState(null, "", "/");
});

async function start(settings: CritiqsAngularOptions | (() => CritiqsAngularOptions)) {
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideRouter(routes), provideCritiqs(settings)] });
  await waitForCalls(1);
  return { app, router: app.injector.get(Router) };
}

const pushed = () => calls.filter((call) => call.method === "setContext").map((call) => call.context);
const restoreOf = () => calls.findLast((call) => call.options !== undefined)?.options?.restoreContext;
const request = (screen: string, viewState: Record<string, string> = {}): RestoreRequest => ({
  threadId: "t",
  screen,
  viewState,
  recordKey: null,
  scope: "shared",
  signal: new AbortController().signal,
});

test("each navigation reports the route's pattern and parameters", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42;tab=info?q=1");
  await router.navigateByUrl("/teams/design/members/ada");
  await router.navigateByUrl("/");
  expect(pushed()).toEqual([
    { screen: "users/:id", viewState: { "route.id": "42" } },
    { screen: "teams/:team/members/:member", viewState: { "route.team": "design", "route.member": "ada" } },
    { screen: "/", viewState: {} },
  ]);
  expect(calls.filter((call) => call.method === "setContext").every((call) => !call.inZone)).toBe(true);
  app.destroy();
});

test("the default restoreContext navigates to the thread's route and resolves once it has", async () => {
  const { app, router } = await start({ projectId: "p1" });
  const restore = restoreOf()!;
  expect(await restore(request("teams/:team/members/:member", { "route.team": "design", "route.member": "ada b" }))).toBe(true);
  expect(router.url).toBe("/teams/design/members/ada%20b");
  expect(pushed().at(-1)).toEqual({ screen: "teams/:team/members/:member", viewState: { "route.team": "design", "route.member": "ada b" } });

  // Already there: nothing to navigate.
  const navigations = pushed().length;
  expect(await restore(request("teams/:team/members/:member", { "route.team": "design", "route.member": "ada b" }))).toBe(true);
  expect(pushed().length).toBe(navigations);

  expect(await restore(request("/users/42"))).toBe(false);
  expect(await restore(request("users/:id"))).toBe(false);
  expect(await restore(request("nowhere/:id", { "route.id": "1" }))).toBe(false);
  expect(router.url).toBe("/teams/design/members/ada%20b");
  app.destroy();
});

test("routes without a pattern, a ** wildcard or a custom matcher, report no route, so the screen is the URL path", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42");
  await router.navigateByUrl("/no/such/page");
  await router.navigateByUrl("/users/43");
  await router.navigateByUrl("/files/a/b");
  expect(pushed()).toEqual([{ screen: "users/:id", viewState: { "route.id": "42" } }, {}, { screen: "users/:id", viewState: { "route.id": "43" } }, {}]);
  app.destroy();
});

test("the route follows the primary outlet, not a named one", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42/(aside:chat)");
  expect(router.url).toBe("/users/42/(aside:chat)");
  expect(pushed()).toEqual([{ screen: "users/:id", viewState: { "route.id": "42" } }]);
  app.destroy();
});

test("the default restoreContext only opens the app's own routes, and checks it arrived", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42");
  const restore = restoreOf()!;
  // A screen the app's getContext reported, a removed route, and a redirect would all reach only the ** page.
  expect(await restore(request("billing-settings"))).toBe(false);
  expect(await restore(request("removed/:id", { "route.id": "1" }))).toBe(false);
  expect(await restore(request("old"))).toBe(false);
  expect(router.url).toBe("/users/42");
  expect(await restore(request("lazy/known"))).toBe(true);
  expect(router.url).toBe("/lazy/known");
  expect(await restore(request("teams/:team", { "route.team": "design" }))).toBe(true);
  expect(router.url).toBe("/teams/design");
  app.destroy();
});

test("a restore that can't reach the thread's route leaves the reviewer where they were", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42;tab=info?q=1");
  const restore = restoreOf()!;
  const started: string[] = [];
  const subscription = router.events.subscribe((event) => event instanceof NavigationStart && started.push(event.url));
  // Routes only a named outlet shows are no primary route: nothing to navigate to.
  expect(await restore(request("chat"))).toBe(false);
  expect(await restore(request("users/:id/chat", { "route.id": "42" }))).toBe(false);
  expect(started).toEqual([]);
  // Under a lazily loaded route only the navigation tells; when it lands on the ** page, the reviewer is taken back.
  expect(await restore(request("lazy/unknown"))).toBe(false);
  expect(router.url).toBe("/users/42;tab=info?q=1");
  expect(`${location.pathname}${location.search}`).toBe("/users/42;tab=info?q=1");
  expect(pushed().at(-1)).toEqual({ screen: "users/:id", viewState: { "route.id": "42" } });
  subscription.unsubscribe();
  app.destroy();
});

test("a restore that lands elsewhere moves neither the address bar nor history", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42;tab=info?q=1");
  const restore = restoreOf()!;
  const entries = history.length;
  // A lazily loaded route's ** page, and a guard that redirects.
  expect(await restore(request("lazy/unknown"))).toBe(false);
  expect(await restore(request("admin"))).toBe(false);
  expect(router.url).toBe("/users/42;tab=info?q=1");
  expect(`${location.pathname}${location.search}`).toBe("/users/42;tab=info?q=1");
  expect(history.length).toBe(entries);
  app.destroy();
});

test("when the reviewer's own page refuses to be entered again, a failed restore still leaves the address bar on it", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42");
  usersOpen = false;
  const entries = history.length;
  const state = history.state;
  expect(await restoreOf()!(request("lazy/unknown"))).toBe(false);
  expect(location.pathname).toBe("/users/42");
  expect(history.length).toBe(entries);
  expect(history.state).toEqual(state);
  app.destroy();
});

test("a restore that reaches its route adds exactly one history entry", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42");
  const entries = history.length;
  expect(await restoreOf()!(request("teams/:team", { "route.team": "design" }))).toBe(true);
  expect(router.url).toBe("/teams/design");
  expect(location.pathname).toBe("/teams/design");
  expect(history.length).toBe(entries + 1);
  app.destroy();
});

test("an aborted restore never undoes a navigation that started after it", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/1");
  const restore = restoreOf()!;
  for (const target of [request("lazy/unknown"), request("teams/:team", { "route.team": "design" })]) {
    // The reviewer moves on as the restore's navigation ends, and the app navigates on its own.
    const controller = new AbortController();
    let newer: Promise<boolean> | null = null;
    const subscription = router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd) || newer !== null) return;
      controller.abort();
      newer = router.navigateByUrl("/users/2");
    });
    expect(await restore({ ...target, signal: controller.signal })).toBe(false);
    subscription.unsubscribe();
    expect(await newer!).toBe(true);
    expect(router.url).toBe("/users/2");
    expect(location.pathname).toBe("/users/2");
    await router.navigateByUrl("/users/1");
  }
  app.destroy();
});

test("a restore aborted while it navigates goes no further, and the address bar shows where the router is", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/1");
  const controller = new AbortController();
  const subscription = router.events.subscribe((event) => event instanceof NavigationStart && controller.abort());
  const started: string[] = [];
  const log = router.events.subscribe((event) => event instanceof NavigationStart && started.push(event.url));
  expect(await restoreOf()!({ ...request("lazy/unknown"), signal: controller.signal })).toBe(false);
  subscription.unsubscribe();
  log.unsubscribe();
  // Its own navigation only: no way back once the reviewer has moved on.
  expect(started.filter((url) => url === "/users/1")).toEqual([]);
  expect(location.pathname).toBe(router.url);
  app.destroy();
});

test("matrix parameters never replace the route's own parameters", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42;id=99");
  await router.navigateByUrl("/teams/design;team=x/members/ada;member=y");
  expect(pushed()).toEqual([
    { screen: "users/:id", viewState: { "route.id": "42" } },
    { screen: "teams/:team/members/:member", viewState: { "route.team": "design", "route.member": "ada" } },
  ]);
  expect(await restoreOf()!(request("teams/:team/members/:member", { "route.team": "design", "route.member": "ada" }))).toBe(true);
  expect(router.url).toBe("/teams/design;team=x/members/ada;member=y");
  app.destroy();
});

test("the default restoreContext stays on a page that already shows the thread's route, matrix parameters and all", async () => {
  const { app, router } = await start({ projectId: "p1" });
  await router.navigateByUrl("/users/42;tab=info?q=1");
  const navigations = pushed().length;
  expect(await restoreOf()!(request("users/:id", { "route.id": "42", "app.tab": "x" }))).toBe(true);
  expect(router.url).toBe("/users/42;tab=info?q=1");
  expect(pushed().length).toBe(navigations);
  expect(await restoreOf()!(request("users/:id", { "route.id": "7" }))).toBe(true);
  expect(router.url).toBe("/users/7");
  app.destroy();
});

test("the app's own restoreContext replaces the default, and its getContext is kept", async () => {
  const restored: string[] = [];
  const getContext = () => ({ persona: "admin" });
  const { app, router } = await start({ getContext, restoreContext: ({ screen }) => void restored.push(screen) });
  void restoreOf()!(request("users/:id", { "route.id": "7" }));
  expect(restored).toEqual(["users/:id"]);
  expect(router.url).toBe("/");
  expect(calls[0]?.options?.getContext).toBe(getContext);

  await router.navigateByUrl("/users/7");
  expect(pushed().at(-1)).toEqual({ screen: "users/:id", viewState: { "route.id": "7" } });
  app.destroy();
});

test("router: false reports no routes and adds no restoreContext", async () => {
  const { app, router } = await start({ projectId: "p1", router: false });
  await router.navigateByUrl("/users/42");
  expect(calls[0]?.options).toEqual({ projectId: "p1" });
  // Not even an empty context: nothing listens to the router.
  expect(pushed()).toEqual([]);
  app.destroy();
});

test("turning router integration off clears the reported route", async () => {
  const router = signal(true);
  const { app, router: angularRouter } = await start(() => ({ projectId: "p1", router: router() }));
  await angularRouter.navigateByUrl("/users/42");
  expect(pushed().at(-1)).toEqual({ screen: "users/:id", viewState: { "route.id": "42" } });

  const before = calls.length;
  router.set(false);
  await app.injector.get(ApplicationRef).whenStable();
  await waitForCalls(before + 2);
  expect(calls.at(-2)).toMatchObject({ method: "update", options: { projectId: "p1" } });
  expect(calls.at(-2)?.options?.restoreContext).toBeUndefined();
  expect(pushed().at(-1)).toEqual({});
  app.destroy();
});

test("an app without a router gets no route context and no default restoreContext", async () => {
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideCritiqs({ projectId: "p1" })] });
  await waitForCalls(1);
  expect(calls).toEqual([{ method: "mount", options: { projectId: "p1" }, inZone: false }]);
  app.destroy();
});
