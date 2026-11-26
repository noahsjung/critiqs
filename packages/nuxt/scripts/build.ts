import { rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
await rm(`${directory}dist`, { recursive: true, force: true });
await rm(`${directory}build`, { recursive: true, force: true });

// The layout Nuxt modules ship: dist/module.mjs runs in Nuxt at build time;
// dist/runtime/ is added to the app, where Nuxt resolves `#app` and the app
// installs `critiqs`.
const builds: Bun.BuildConfig[] = [
  { entrypoints: [`${directory}src/module.ts`], outdir: `${directory}dist`, target: "node", naming: "[name].mjs", external: ["@nuxt/kit"] },
  { entrypoints: [`${directory}src/runtime/plugin.client.ts`], outdir: `${directory}dist/runtime`, target: "browser", naming: "[name].js", external: ["#app", "critiqs", "critiqs-vue", "critiqs-vue/router"] },
];
for (const options of builds) {
  const result = await Bun.build({ ...options, format: "esm" });
  if (!result.success) throw new AggregateError(result.logs, "critiqs-nuxt's build failed.");
}

const types = Bun.spawn(["bun", "run", "tsc", "-p", "tsconfig.build.json"], { cwd: directory, stdout: "inherit", stderr: "inherit" });
if ((await types.exited) !== 0) throw new Error("critiqs-nuxt's declaration build failed.");
await rename(`${directory}build/types/module.d.ts`, `${directory}dist/module.d.mts`);
await rm(`${directory}build`, { recursive: true, force: true });
console.error("Built critiqs-nuxt.");
