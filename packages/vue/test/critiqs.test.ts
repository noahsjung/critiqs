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

const critiqsRoot = () => document.querySelector("critiqs-root");

/** Waits until `ready()` holds, however long loading Critiqs takes on a busy machine, and fails after 5 s. */
async function until(ready: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${ready}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Lets a load the component started finish: `import("critiqs")` resolves here only after it has for the component. */
async function loaded() {
  await nextTick();
  await import("critiqs");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
  await until(() => critiqsRoot() !== null);
  expect(critiqsRoot()?.parentElement).toBe(document.body);
  expect(container.innerHTML).toBe("<!---->");
  unmount();
  await until(() => critiqsRoot() === null);
});

test("with requireProjectId, Critiqs follows the project ID as it changes", async () => {
  const { state, unmount } = render({ backend: BACKEND, requireProjectId: true });
  await loaded();
  expect(critiqsRoot()).toBeNull();
  expect(requests).toEqual([]);
  state.projectId = PROJECT;
  await until(() => critiqsRoot() !== null);
  state.projectId = "";
  await until(() => critiqsRoot() === null);
  unmount();
});

test("unmounting before Critiqs loads adds nothing", async () => {
  const { unmount } = render({ projectId: PROJECT, backend: BACKEND });
  unmount();
  await loaded();
  expect(critiqsRoot()).toBeNull();
});
