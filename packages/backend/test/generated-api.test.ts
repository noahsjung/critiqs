import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// `convex dev` and `convex codegen` rewrite convex/_generated/api.d.ts from the files in convex/, but both
// need a deployment, so nothing in the checks regenerates it. This fails when a module was added, renamed or
// removed without regenerating: run `bunx convex dev --once` (a local deployment is enough) and commit the file.
const CONVEX = join(import.meta.dir, "..", "convex");
const EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"];

/** The modules Convex generates an `api` entry for, with Convex's own rules (`entryPoints` in convex/bundler). */
async function convexModules(dir = CONVEX): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const relPath = relative(CONVEX, path);
    if (entry.isDirectory()) {
      if (relPath === "_generated" || (await readdir(path)).includes("convex.config.ts")) continue;
      found.push(...(await convexModules(path)));
      continue;
    }
    const name = entry.name;
    if (!EXTENSIONS.some((extension) => name.endsWith(extension))) continue;
    if (name.startsWith(".") || name.startsWith("#") || name === "schema.ts" || name === "schema.js") continue;
    if ((name.match(/\./g) ?? []).length > 1 || relPath.includes(" ")) continue;
    if (/\.tsx?$/.test(name) && !/^\s{0,100}(import|export)/m.test(await readFile(path, "utf8"))) continue;
    found.push(relPath.replace(/\.[^.]+$/, ""));
  }
  return found;
}

test("convex/_generated/api.d.ts lists exactly the modules in convex/", async () => {
  const generated = await readFile(join(CONVEX, "_generated", "api.d.ts"), "utf8");
  const listed = [...generated.matchAll(/^import type \* as \w+ from "\.\.\/(.+)\.js";$/gm)].map((match) => match[1]);
  expect(listed.sort()).toEqual((await convexModules()).sort());
});
