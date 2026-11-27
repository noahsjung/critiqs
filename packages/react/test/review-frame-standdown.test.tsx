import { afterEach, expect, test } from "bun:test";
import { REVIEW_FRAME_MARK } from "@critiqs/core";
import { HOST_TAG } from "../src/constants.ts";
import { mountCritiqs } from "../src/mount.tsx";

// A prototype with Critiqs installed the usual way, opened through a review
// link: the review proxy's runtime marks the frame's window before the
// prototype's scripts run, and the installed copy stays out, quietly. The
// proxy's own page layer serves the review page around the frame; an
// installed copy could only fail to reach its backend and say so.

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REVIEW_FRAME_MARK];
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  document.body.innerHTML = "";
});

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("in a review frame, an installed Critiqs adds nothing, asks nothing and says nothing", async () => {
  Object.defineProperty(globalThis, REVIEW_FRAME_MARK, { value: true, configurable: true });
  const calls: string[] = [];
  const said: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  console.warn = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  const instance = mountCritiqs({ projectId: "js71q5kzssedhq0rp6myv7zdf58gbb1t", backend: "http://127.0.0.1:7600" });
  instance.update({ projectId: "js71q5kzssedhq0rp6myv7zdf58gbb1t", backend: "http://127.0.0.1:7600" });
  await tick();
  expect(document.querySelectorAll(HOST_TAG).length).toBe(0);
  expect(calls).toEqual([]);
  expect(said).toEqual([]);
  instance.destroy();
});

test("outside a review frame it mounts as before", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  console.warn = () => undefined;
  console.error = () => undefined;
  const instance = mountCritiqs({ projectId: "js71q5kzssedhq0rp6myv7zdf58gbb1t", backend: "http://127.0.0.1:7600" });
  await tick();
  expect(document.querySelectorAll(HOST_TAG).length).toBe(1);
  instance.destroy();
  await tick();
});
