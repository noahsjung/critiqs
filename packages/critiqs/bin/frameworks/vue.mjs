// Vue setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const vue = {
  id: "vue",
  name: "Vue",
  install: { ecosystem: "npm", packages: ["critiqs-vue"] },
  detect: (root) => dependsOn(root, "vue"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(vue, settings);
  },
  manual: (settings) => `Add Critiqs to this Vue app with project ID ${describeProjectId(settings)}; see the critiqs-vue README.`,
};
