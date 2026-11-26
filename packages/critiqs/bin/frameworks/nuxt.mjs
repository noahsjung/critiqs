// Nuxt setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const nuxt = {
  id: "nuxt",
  name: "Nuxt",
  install: { ecosystem: "npm", packages: ["critiqs-nuxt"] },
  detect: (root) => dependsOn(root, "nuxt"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(nuxt, settings);
  },
  manual: (settings) => `Add Critiqs to this Nuxt app with project ID ${describeProjectId(settings)}; see the critiqs-nuxt README.`,
};
