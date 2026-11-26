// React setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const react = {
  id: "react",
  name: "React",
  install: { ecosystem: "npm", packages: ["critiqs-react"] },
  detect: (root) => dependsOn(root, "react") && dependsOn(root, "react-dom"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(react, settings);
  },
  manual: (settings) => `Add Critiqs to this React app with project ID ${describeProjectId(settings)}; see the critiqs-react README.`,
};
