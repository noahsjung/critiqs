// Next.js setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const next = {
  id: "next",
  name: "Next.js",
  install: { ecosystem: "npm", packages: ["critiqs-react"] },
  detect: (root) => dependsOn(root, "next"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(next, settings);
  },
  manual: (settings) => `Add Critiqs to this Next.js app with project ID ${describeProjectId(settings)}; see the critiqs-react README.`,
};
