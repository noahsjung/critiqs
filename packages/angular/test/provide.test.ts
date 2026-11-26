import { calls, waitForCalls } from "./fake-critiqs.ts";
import { beforeEach, expect, test } from "bun:test";
import { ApplicationRef, InjectionToken, inject, PLATFORM_ID, provideZonelessChangeDetection, signal } from "@angular/core";
import { createApplication } from "@angular/platform-browser";
import { provideCritiqs } from "../src/index.ts";

beforeEach(() => {
  calls.length = 0;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("mounts Critiqs once in the browser with the given settings, and removes it with the app", async () => {
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideCritiqs({ projectId: "p1", requireProjectId: true })] });
  await waitForCalls(1);
  expect(calls).toEqual([{ method: "mount", options: { projectId: "p1", requireProjectId: true }, inZone: false }]);
  app.destroy();
  expect(calls.map((call) => call.method)).toEqual(["mount", "destroy"]);
});

test("does nothing on the server", async () => {
  const app = await createApplication({
    providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: "server" }, provideCritiqs({ projectId: "p1" })],
  });
  await settle();
  app.destroy();
  expect(calls).toEqual([]);
});

test("a function of signals updates the settings when they change", async () => {
  const projectId = signal("p1");
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideCritiqs(() => ({ projectId: projectId() }))] });
  await waitForCalls(1);
  expect(calls[0]).toMatchObject({ method: "mount", options: { projectId: "p1" } });

  projectId.set("p2");
  await app.injector.get(ApplicationRef).whenStable();
  await waitForCalls(2);
  expect(calls[1]).toMatchObject({ method: "update", options: { projectId: "p2" } });
  app.destroy();
  expect(calls.at(-1)?.method).toBe("destroy");
});

test("a signal works as the settings", async () => {
  const settings = signal({ projectId: "p1" });
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideCritiqs(settings)] });
  await waitForCalls(1);
  settings.set({ projectId: "p2" });
  await waitForCalls(2);
  expect(calls.map((call) => [call.method, call.options?.projectId])).toEqual([
    ["mount", "p1"],
    ["update", "p2"],
  ]);
  app.destroy();
});

const NAVIGATOR = new InjectionToken("navigator", { providedIn: "root", factory: () => ({ visited: [] as string[] }) });

test("a function can inject services for restoreContext", async () => {
  const app = await createApplication({
    providers: [
      provideZonelessChangeDetection(),
      provideCritiqs(() => {
        const navigator = inject(NAVIGATOR);
        return { restoreContext: ({ screen }) => void navigator.visited.push(screen) };
      }),
    ],
  });
  await waitForCalls(1);
  const restore = calls[0]?.options?.restoreContext;
  void restore?.({ threadId: "t", screen: "/users/2", viewState: {}, recordKey: null, scope: "shared", signal: new AbortController().signal });
  expect(app.injector.get(NAVIGATOR).visited).toEqual(["/users/2"]);
  app.destroy();
});

test("an app destroyed before Critiqs loads never mounts it", async () => {
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideCritiqs({ projectId: "p1" })] });
  app.destroy();
  await settle();
  expect(calls).toEqual([]);
});
