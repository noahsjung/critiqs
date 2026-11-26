import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
await rm(`${directory}dist`, { recursive: true, force: true });

// Vue and Critiqs stay imports: the app provides Vue, and `critiqs` is this
// package's dependency, loaded only in the browser. critiqs-vue/router is its
// own entry, which the component shares rather than copies.
const result = await Bun.build({
  entrypoints: [`${directory}src/index.ts`, `${directory}src/router.ts`],
  outdir: `${directory}dist`,
  target: "browser",
  format: "esm",
  splitting: true,
  external: ["vue", "critiqs", "critiqs/router"],
});
if (!result.success) throw new AggregateError(result.logs, "critiqs-vue's build failed.");

const types = Bun.spawn(["bun", "run", "tsc", "-p", "tsconfig.build.json"], { cwd: directory, stdout: "inherit", stderr: "inherit" });
if ((await types.exited) !== 0) throw new Error("critiqs-vue's declaration build failed.");
// Declarations name the files they ship beside, not the TypeScript sources.
for (const name of ["index", "router"]) {
  const file = `${directory}dist/${name}.d.ts`;
  await Bun.write(file, (await Bun.file(file).text()).replace(/(from\s+"\.\/[\w-]+)\.ts"/g, '$1.js"'));
}
console.error("Built critiqs-vue.");
