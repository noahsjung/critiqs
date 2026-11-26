// An app that still uses zone.js: Critiqs runs outside Angular's zone, so its
// timers and events never trigger change detection, while `restoreContext`
// runs inside it, so the navigation it starts updates the app.
import "zone.js";
import { calls, waitForCalls } from "./fake-critiqs.ts";
import { expect, test } from "bun:test";
import { NgZone, provideZoneChangeDetection, signal } from "@angular/core";
import { createApplication } from "@angular/platform-browser";
import { provideRouter, Router } from "@angular/router";
import { provideCritiqs } from "../src/index.ts";

test("mounts and updates outside the zone, and restores context inside it", async () => {
  const restored: boolean[] = [];
  const projectId = signal("p1");
  const app = await createApplication({
    providers: [
      provideZoneChangeDetection(),
      provideCritiqs(() => ({ projectId: projectId(), restoreContext: () => void restored.push(NgZone.isInAngularZone()) })),
    ],
  });
  await waitForCalls(1);
  app.injector.get(NgZone).run(() => projectId.set("p2"));
  await waitForCalls(2);
  expect(calls.map(({ method, inZone }) => [method, inZone])).toEqual([
    ["mount", false],
    ["update", false],
  ]);

  // Critiqs calls restoreContext from its own (outside) code.
  const restore = calls[1]?.options?.restoreContext;
  app.injector.get(NgZone).runOutsideAngular(() =>
    restore?.({ threadId: "t", screen: "/", viewState: {}, recordKey: null, scope: "shared", signal: new AbortController().signal }),
  );
  expect(restored).toEqual([true]);
  app.destroy();
});

test("the default restoreContext navigates inside the zone", async () => {
  calls.length = 0;
  const guarded: boolean[] = [];
  const canActivate = [() => guarded.push(NgZone.isInAngularZone()) > 0];
  const app = await createApplication({
    providers: [provideZoneChangeDetection(), provideRouter([{ path: "items/:id", canActivate, children: [] }]), provideCritiqs({ projectId: "p1" })],
  });
  await waitForCalls(1);
  const restore = calls[0]?.options?.restoreContext;
  const restored = await app.injector
    .get(NgZone)
    .runOutsideAngular(() => restore?.({ threadId: "t", screen: "items/:id", viewState: { "route.id": "3" }, recordKey: null, scope: "shared", signal: new AbortController().signal }));
  expect(restored).toBe(true);
  expect(guarded).toEqual([true]);
  expect(app.injector.get(Router).url).toBe("/items/3");
  expect(calls.at(-1)).toEqual({ method: "setContext", context: { screen: "items/:id", viewState: { "route.id": "3" } }, inZone: false });
  app.destroy();
});
