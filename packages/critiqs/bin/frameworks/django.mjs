// Django setup. Stub: detection only, until this framework's setup is automated.
import { join } from "node:path";
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const django = {
  id: "django",
  name: "Django",
  install: { ecosystem: "pypi", package: "django-critiqs" },
  detect: (root) => readText(join(root, "manage.py"))?.includes("django") === true,
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(django, settings);
  },
  manual: (settings) => `Add Critiqs to this Django app with project ID ${describeProjectId(settings)}; see the django-critiqs README.`,
};
