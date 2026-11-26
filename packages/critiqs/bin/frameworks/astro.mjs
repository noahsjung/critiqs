// Astro setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const astro = {
  id: "astro",
  name: "Astro",
  install: { ecosystem: "npm", packages: ["critiqs-astro"] },
  detect: (root) => dependsOn(root, "astro"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(astro, settings);
  },
  manual: (settings) => `Add Critiqs to this Astro app with project ID ${describeProjectId(settings)}; see the critiqs-astro README.`,
};
