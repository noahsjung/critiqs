// Angular setup. Stub: detection only, until this framework's setup is automated.
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const angular = {
  id: "angular",
  name: "Angular",
  install: { ecosystem: "npm", packages: ["critiqs-angular"] },
  detect: (root) => dependsOn(root, "@angular/core"),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(angular, settings);
  },
  manual: (settings) => `Add Critiqs to this Angular app with project ID ${describeProjectId(settings)}; see the critiqs-angular README.`,
};
