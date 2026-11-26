// Flask setup. Stub: detection only, until this framework's setup is automated.
import { join } from "node:path";
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const flask = {
  id: "flask",
  name: "Flask",
  install: { ecosystem: "pypi", package: "flask-critiqs" },
  detect: (root) => /^\s*flask\b/im.test(readText(join(root, "requirements.txt")) ?? "") || /["']flask\b/i.test(readText(join(root, "pyproject.toml")) ?? ""),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(flask, settings);
  },
  manual: (settings) => `Add Critiqs to this Flask app with project ID ${describeProjectId(settings)}; see the flask-critiqs README.`,
};
