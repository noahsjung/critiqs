import { expect, mock, test } from "bun:test";
import { createApp, defineComponent, h, nextTick, reactive, Suspense } from "vue";
import type { CritiqsOptions } from "critiqs";

// What <Critiqs> hands the shared package: every setting on mount, each change
// as an update (function settings included), and destroy on unmount.
const calls: Array<[string, CritiqsOptions?]> = [];
mock.module("critiqs", () => ({
  mountCritiqs(options: CritiqsOptions) {
    calls.push(["mount", options]);
    return { update: (next: CritiqsOptions) => calls.push(["update", next]), destroy: () => calls.push(["destroy"]) };
  },
}));
const { Critiqs, MASK_ATTRIBUTE } = await import("../src/index.ts");

const settle = async () => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("passes every setting through, updates on any change, and destroys on unmount", async () => {
  const first = () => ({ screen: "home" });
  const second = () => ({ screen: "settings" });
  const restore = () => true;
  const state = reactive<CritiqsOptions>({ projectId: "p1", backend: "https://example.test", version: "v1", getContext: first, restoreContext: restore });
  const app = createApp({ render: () => h(Critiqs, { ...state }) });
  app.mount(document.createElement("div"));
  await settle();
  expect(calls).toEqual([["mount", { projectId: "p1", requireProjectId: false, backend: "https://example.test", version: "v1", getContext: first, restoreContext: restore }]]);

  state.getContext = second;
  await settle();
  expect(calls.at(-1)).toEqual(["update", { projectId: "p1", requireProjectId: false, backend: "https://example.test", version: "v1", getContext: second, restoreContext: restore }]);

  state.version = "v2";
  state.requireProjectId = true;
  await settle();
  expect(calls.at(-1)?.[1]).toMatchObject({ version: "v2", requireProjectId: true, getContext: second });

  app.unmount();
  expect(calls.at(-1)).toEqual(["destroy"]);
});

test("a required project ID that is unset loads nothing until it is set", async () => {
  calls.length = 0;
  const state = reactive<CritiqsOptions>({ requireProjectId: true });
  const app = createApp({ render: () => h(Critiqs, { ...state }) });
  app.mount(document.createElement("div"));
  await settle();
  expect(calls).toEqual([]);
  state.projectId = "p2";
  await settle();
  expect(calls).toEqual([["mount", expect.objectContaining({ projectId: "p2", requireProjectId: true })]]);
  app.unmount();
});

test("a settings change before the component mounts, as inside a pending <Suspense>, loads nothing", async () => {
  calls.length = 0;
  let resume = () => {};
  const Slow = defineComponent({
    async setup() {
      await new Promise<void>((resolve) => (resume = resolve));
      return () => null;
    },
  });
  const state = reactive<CritiqsOptions>({ projectId: "p3" });
  const app = createApp({ render: () => h(Suspense, null, { default: () => h("div", [h(Slow), h(Critiqs, { ...state })]) }) });
  app.mount(document.createElement("div"));
  await settle();
  state.projectId = "p4";
  await settle();
  expect(calls).toEqual([]);
  resume();
  await settle();
  await settle();
  expect(calls).toEqual([["mount", expect.objectContaining({ projectId: "p4" })]]);
  app.unmount();
});

test("exports the shared package's mask attribute", async () => {
  const constants = await import("../../react/src/constants.ts");
  expect(MASK_ATTRIBUTE).toBe(constants.MASK_ATTRIBUTE);
});
