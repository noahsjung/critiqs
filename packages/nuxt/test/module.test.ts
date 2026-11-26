import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNuxt, writeTypes } from "@nuxt/kit";
import critiqs from "../src/module.ts";

const opened: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const nuxt of opened.splice(0)) await nuxt.close();
});

/** Loads a Nuxt app (without building it) that uses the module with this config. */
async function load(config: Record<string, unknown> = {}) {
  // Inside this package, so Nuxt resolves from its node_modules; .local is git-ignored.
  const base = join(import.meta.dir, "../.local");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "app-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const nuxt = await loadNuxt({ cwd: root, ready: true, overrides: { modules: [critiqs], telemetry: false, ...config } });
  opened.push(nuxt);
  return nuxt;
}

test("puts every setting in public runtime config, requiring a project ID by default", async () => {
  const nuxt = await load();
  expect(nuxt.options.runtimeConfig.public.critiqs).toEqual({ projectId: "", requireProjectId: true, backend: "", version: "", router: true });
  const plugin = nuxt.options.plugins.find((p) => typeof p === "object" && p.src.includes("plugin.client"));
  expect(plugin).toMatchObject({ mode: "client" });
});

test("nuxt.config's critiqs settings fill runtime config, and runtimeConfig set by the app wins", async () => {
  const nuxt = await load({
    critiqs: { projectId: "j12345678901234567890123456789012", requireProjectId: false, backend: "https://critiqs.example.com/critiqs", version: "v1", router: false },
  });
  expect(nuxt.options.runtimeConfig.public.critiqs).toEqual({ projectId: "j12345678901234567890123456789012", requireProjectId: false, backend: "https://critiqs.example.com/critiqs", version: "v1", router: false });

  const overridden = await load({ critiqs: { projectId: "from-module" }, runtimeConfig: { public: { critiqs: { projectId: "from-runtime-config" } } } });
  expect(overridden.options.runtimeConfig.public.critiqs).toMatchObject({ projectId: "from-runtime-config", requireProjectId: true });
});

test("@nuxt/kit allows every Nuxt the peer range allows, down to the lowest", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
  const lowest = /^\^(\d+\.\d+\.\d+)$/.exec(manifest.peerDependencies.nuxt)?.[1];
  expect(lowest).toBeDefined();
  // @nuxt/kit ships in step with nuxt, so an app on the lowest Nuxt has that kit.
  expect(Bun.semver.satisfies(lowest!, manifest.dependencies["@nuxt/kit"])).toBe(true);
  expect(critiqs.getMeta ? (await critiqs.getMeta()).compatibility?.nuxt : undefined).toBe(`>=${lowest}`);
});

test("the app's generated types load critiqs-nuxt, which types the critiqs:options hook, even when it isn't listed by name", async () => {
  // Listed as the imported module: Nuxt itself references only modules listed by name.
  // (By name, and as ['critiqs-nuxt', { … }], the consumer check typechecks a real app.)
  const nuxt = await load();
  await writeTypes(nuxt);
  const types = await Bun.file(join(nuxt.options.buildDir, "nuxt.d.ts")).text();
  expect(types.match(/^\/\/\/ <reference types="critiqs-nuxt" \/>$/gm)).toHaveLength(1);
});
