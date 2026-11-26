// Server rendering and prerendering, as SvelteKit does them: the components
// are compiled for the server and rendered to HTML with no DOM. Critiqs must
// output nothing and never load the `critiqs` bundle there.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, mock, test } from "bun:test";
import { render } from "svelte/server";

GlobalRegistrator.unregister();
globalThis.svelteGenerate = "server";

let imported = false;
mock.module("critiqs", () => {
  imported = true;
  return { mountCritiqs: () => ({ update() {}, destroy() {} }) };
});
mock.module("critiqs/router", () => import("../../critiqs/src/router.ts"));
// SvelteKit's modules as its server provides them.
mock.module("$app/state", () => ({ page: { route: { id: "/users/[id]" }, params: { id: "42" }, url: new URL("http://localhost/users/42") }, navigating: { type: null } }));
mock.module("$app/paths", () => ({ resolve: (path: string) => path }));
mock.module("$app/navigation", () => ({
  goto: () => Promise.reject(new Error("Cannot call goto on the server")),
  // SvelteKit registers it in onMount, which never runs on the server.
  beforeNavigate: () => {},
  preloadData: () => Promise.reject(new Error("Cannot call preloadData on the server")),
}));

const props = { projectId: "j12345678901234567890123456789012", requireProjectId: true };

test.each([
  ["critiqs-svelte", "../src/lib/Critiqs.svelte"],
  ["critiqs-svelte/kit", "../src/lib/kit/Critiqs.svelte"],
])("%s renders no HTML on the server and doesn't load critiqs", async (_name, path) => {
  const { default: Critiqs } = await import(path);
  const { head, body } = render(Critiqs, { props });
  expect(head).toBe("");
  expect(body.replace(/<!--.*?-->/g, "")).toBe("");
  await Bun.sleep(0);
  expect(imported).toBe(false);
});
