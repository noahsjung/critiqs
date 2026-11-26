import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { usePageVersion } from "../src/hooks.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

const frames = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

test("page changes are noticed after a client router replaces <body>", async () => {
  const seen: number[] = [];
  function Probe() {
    seen.push(usePageVersion());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const swapped = document.createElement("body");
  document.documentElement.replaceChild(swapped, document.body);
  await frames();
  const afterSwap = seen.at(-1)!;
  expect(afterSwap).toBeGreaterThan(0);
  swapped.append(document.createElement("section"));
  await frames();
  expect(seen.at(-1)!).toBeGreaterThan(afterSwap);
  await act(async () => root.unmount());
});
