import { afterEach, expect, test } from "bun:test";
import { createApp, h, nextTick, reactive } from "vue";
import { Critiqs, type CritiqsProps } from "../src/index.ts";

// The real `critiqs` package (its built dist), against a stand-in server that knows PROJECT.
const BACKEND = "http://localhost:9999/critiqs";
const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const requests: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push(url);
  if (url.endsWith("/critiqs/config")) return Response.json({ protocol: 5, transport: "http", signIn: "host", signInUrl: BACKEND });
  if (url.includes("/critiqs/health")) return Response.json({ protocol: 5, signIn: "host", project: "found" });
  if (url.endsWith("/me")) return Response.json({ reviewer: null });
  if (url.endsWith("/changes")) return Response.json({ version: 1 });
  return Response.json({ error: { code: "not-found", message: "Unknown request." } }, { status: 404 });
}) as typeof fetch;

afterEach(() => {
  document.body.innerHTML = "";
  requests.length = 0;
});

const settle = async (ms = 60) => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, ms));
};
const critiqsRoot = () => document.querySelector("critiqs-root");

/** Mounts <Critiqs> with reactive settings the test can change, as a parent component's state would. */
function render(initial: CritiqsProps) {
  const state = reactive({ ...initial });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ render: () => h(Critiqs, { ...state }) });
  app.mount(container);
  return { state, container, unmount: () => app.unmount() };
}

test("adds Critiqs above the app, renders nothing in place, and removes it on unmount", async () => {
  const { container, unmount } = render({ projectId: PROJECT, backend: BACKEND });
  await settle();
  expect(critiqsRoot()).not.toBeNull();
  expect(critiqsRoot()?.parentElement).toBe(document.body);
  expect(container.innerHTML).toBe("<!---->");
  unmount();
  await settle();
  expect(critiqsRoot()).toBeNull();
});

test("with requireProjectId, Critiqs follows the project ID as it changes", async () => {
  const { state, unmount } = render({ backend: BACKEND, requireProjectId: true });
  await settle();
  expect(critiqsRoot()).toBeNull();
  expect(requests).toEqual([]);
  state.projectId = PROJECT;
  await settle();
  expect(critiqsRoot()).not.toBeNull();
  state.projectId = "";
  await settle();
  expect(critiqsRoot()).toBeNull();
  unmount();
});

test("unmounting before Critiqs loads adds nothing", async () => {
  const { unmount } = render({ projectId: PROJECT, backend: BACKEND });
  unmount();
  await settle();
  expect(critiqsRoot()).toBeNull();
});
