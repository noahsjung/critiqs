// SvelteKit setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const sveltekit = {
  id: "sveltekit",
  name: "SvelteKit",
  install: { ecosystem: "npm", packages: ["critiqs-svelte"] },
  detect: (root) => dependsOn(root, "@sveltejs/kit"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(sveltekit, settings);
  },
  manual: (settings) => `Add Critiqs to this SvelteKit app with project ID ${describeProjectId(settings)}; see the critiqs-svelte README.`,
};
