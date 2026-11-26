// What npm and readers see of the package: its peer ranges and its README.
import { expect, test } from "bun:test";
import { join } from "node:path";

const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
const readme = await Bun.file(join(import.meta.dir, "../README.md")).text();

test("installs beside every SvelteKit 2 and 3: the plain component needs none of 2.26's modules", () => {
  const range = manifest.peerDependencies["@sveltejs/kit"];
  for (const version of ["2.0.0", "2.25.0", "2.26.0", "3.4.0"]) expect(Bun.semver.satisfies(version, range)).toBe(true);
  expect(manifest.peerDependenciesMeta["@sveltejs/kit"].optional).toBe(true);
});

test("the README's Settings table is one table naming every property", () => {
  const section = readme.split("## Settings")[1]!.split("\n## ")[0]!;
  const lines = section.trim().split("\n");
  const table = lines.slice(0, lines.findIndex((line) => !line.startsWith("|")));
  const properties = table.slice(2).map((row) => /^\| `(\w+)` \|/.exec(row)?.[1]);
  expect(properties).toEqual(["projectId", "requireProjectId", "backend", "version", "getContext", "restoreContext", "router"]);
});
