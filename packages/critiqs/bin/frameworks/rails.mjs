// Ruby on Rails setup. Stub: detection only, until this framework's setup is automated.
import { join } from "node:path";
import { dependsOn, describeProjectId, manualPlan, readText } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const rails = {
  id: "rails",
  name: "Ruby on Rails",
  install: { ecosystem: "rubygems", gem: "critiqs-rails" },
  detect: (root) => /^\s*gem\s+["']rails["']/m.test(readText(join(root, "Gemfile")) ?? ""),
  env: () => null,
  find: () => [],
  plan(root, settings) {
    return manualPlan(rails, settings);
  },
  manual: (settings) => `Add Critiqs to this Ruby on Rails app with project ID ${describeProjectId(settings)}; see the critiqs-rails README.`,
};
