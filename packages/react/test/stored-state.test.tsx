import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useStoredState } from "../src/hooks.ts";

// A value kept in local storage under a key, such as the model last chosen in
// one project's Mockup mode: another key reads its own value, never the last one's.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => localStorage.clear());

test("a stored value follows its key, and each key keeps its own", async () => {
  localStorage.setItem("critiqs:mockup-model:a", '"strong"');
  let shown: { value: string | null; store: (value: string | null) => void } | null = null;
  let renders = 0;
  function Probe({ project }: { project: string }) {
    renders++;
    const [value, store] = useStoredState<string | null>(`critiqs:mockup-model:${project}`, null);
    shown = { value, store };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe project="a" />));
  expect(shown!.value).toBe("strong");
  await act(async () => root.render(<Probe project="b" />));
  expect(shown!.value).toBeNull();
  await act(async () => shown!.store("fast"));
  expect(shown!.value).toBe("fast");
  expect(localStorage.getItem("critiqs:mockup-model:b")).toBe('"fast"');
  await act(async () => root.render(<Probe project="a" />));
  expect(shown!.value).toBe("strong");
  // Storing the same value again doesn't render again.
  renders = 0;
  await act(async () => shown!.store("strong"));
  expect(renders).toBe(0);
  // Storage that can't be read falls back to the initial value.
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    await act(async () => root.render(<Probe project="c" />));
    expect(shown!.value).toBeNull();
  } finally {
    Storage.prototype.getItem = original;
  }
  await act(async () => root.unmount());
});
