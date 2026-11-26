// What a Solid app sees of <Critiqs>, run against whichever Solid the calling
// file loads as "solid-js". The shared package is replaced with a recorder,
// so each test reads the calls Critiqs would receive.
import { expect, test } from "bun:test";
import type { CritiqsOptions } from "critiqs";
import { calls as recorded, loads, settle as settleAll } from "./recorder.ts";

/** This suite's components push no context, so every call is a mount, update, or destroy. */
const calls = recorded as (["mount" | "update", CritiqsOptions] | ["destroy"])[];

interface SolidApi {
  createRoot<T>(fn: (dispose: () => void) => T): T;
  createSignal<T>(value: T): [() => T, (value: T) => void];
  createComponent<T>(component: (props: T) => unknown, props: T): unknown;
  flush?: () => void;
}

const settle = (solid: SolidApi) => settleAll(solid.flush, 3);

export function critiqsSuite(label: string, solid: SolidApi) {
  const { Critiqs } = require("../src/index.ts") as typeof import("../src/index.ts");

  /** Renders <Critiqs> with reactive props, as JSX would: each read goes through a getter. */
  function render() {
    const [projectId, setProjectId] = solid.createSignal<string | undefined>("p1");
    const [version, setVersion] = solid.createSignal("v1");
    const getContext = () => ({ screen: "home" });
    let output: unknown = "not rendered";
    const dispose = solid.createRoot((dispose) => {
      output = solid.createComponent(Critiqs, {
        get projectId() {
          return projectId();
        },
        requireProjectId: true,
        backend: "https://backend.example/critiqs",
        get version() {
          return version();
        },
        getContext,
      });
      return dispose;
    });
    return { output, dispose, setProjectId, setVersion, getContext };
  }

  const reset = () => {
    calls.length = 0;
  };

  test(`${label}: renders nothing and starts Critiqs with every setting after the first render`, async () => {
    reset();
    const app = render();
    expect(app.output).toBeNull();
    await settle(solid);
    expect(calls).toEqual([
      ["mount", { projectId: "p1", requireProjectId: true, backend: "https://backend.example/critiqs", version: "v1", getContext: app.getContext, restoreContext: undefined }],
    ]);
    app.dispose();
  });

  test(`${label}: a changed property updates Critiqs with all settings`, async () => {
    reset();
    const app = render();
    await settle(solid);
    app.setProjectId("p2");
    await settle(solid);
    app.setVersion("v2");
    await settle(solid);
    expect(calls.slice(1).map(([kind, options]) => [kind, options?.projectId, options?.version, options?.requireProjectId])).toEqual([
      ["update", "p2", "v1", true],
      ["update", "p2", "v2", true],
    ]);
    app.dispose();
  });

  test(`${label}: a change while Critiqs loads starts it with the newest settings`, async () => {
    reset();
    const app = render();
    app.setProjectId("p3");
    await settle(solid);
    expect(calls.map(([kind, options]) => [kind, options?.projectId])).toEqual([["mount", "p3"]]);
    app.dispose();
  });

  test(`${label}: removing the component removes Critiqs`, async () => {
    reset();
    const app = render();
    await settle(solid);
    app.dispose();
    await settle(solid);
    app.setProjectId("p4");
    await settle(solid);
    expect(calls.map(([kind]) => kind)).toEqual(["mount", "destroy"]);
  });

  test(`${label}: removed before Critiqs loads, it never starts`, async () => {
    reset();
    const app = render();
    app.dispose();
    await settle(solid);
    expect(calls).toEqual([]);
  });
}

/** Server rendering: the component runs, and Critiqs is never loaded. */
export function serverSuite(label: string, solid: SolidApi) {
  test(`${label}: server rendering never loads Critiqs`, async () => {
    const before = loads.count;
    const { Critiqs } = require("../src/index.ts") as typeof import("../src/index.ts");
    calls.length = 0;
    const dispose = solid.createRoot((dispose) => {
      expect(solid.createComponent(Critiqs, { projectId: "p1" })).toBeNull();
      return dispose;
    });
    await settle(solid);
    dispose();
    expect(loads.count).toBe(before);
    expect(calls).toEqual([]);
  });
}
