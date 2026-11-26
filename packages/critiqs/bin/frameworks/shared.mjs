// Small file helpers adapters share. Adapters stay pure: they read, never write.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The app's package.json, or null when it has none or it can't be parsed. */
export function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Whether package.json lists `name` in dependencies or devDependencies. */
export function dependsOn(root, name) {
  const manifest = readPackageJson(root);
  return manifest !== null && (name in (manifest.dependencies ?? {}) || name in (manifest.devDependencies ?? {}));
}

/** A file's text, or null when it doesn't exist or can't be read. */
export function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** A plan for frameworks whose setup isn't automated yet: the manual instructions. */
export function manualPlan(adapter, settings) {
  return { ok: false, reason: "manual", message: adapter.manual(settings) };
}

/** How settings read in instructions: the ID or the variable that holds it. */
export function describeProjectId(settings) {
  return "literal" in settings.projectId ? settings.projectId.literal : settings.projectId.env.expression;
}
