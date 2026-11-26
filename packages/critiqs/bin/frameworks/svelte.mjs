// Svelte setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const svelte = {
  id: "svelte",
  name: "Svelte",
  install: { ecosystem: "npm", packages: ["critiqs-svelte"] },
  detect: (root) => dependsOn(root, "svelte"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(svelte, settings);
  },
  manual: (settings) => `Add Critiqs to this Svelte app with project ID ${describeProjectId(settings)}; see the critiqs-svelte README.`,
};
