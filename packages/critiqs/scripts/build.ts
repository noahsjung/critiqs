import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
await rm(`${directory}dist`, { recursive: true, force: true });
await rm(`${directory}build/types`, { recursive: true, force: true });

// Every entry carries everything it needs, React included, so a page can load
// `element.js` from a plain <script type="module"> with no build of its own.
// Without code splitting each file stands alone; bundlers import only one.
const result = await Bun.build({
  entrypoints: [`${directory}src/index.ts`, `${directory}src/element.ts`, `${directory}src/router.ts`],
  outdir: `${directory}dist`,
  target: "browser",
  format: "esm",
  minify: true,
  jsx: { runtime: "automatic", development: false },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) throw new AggregateError(result.logs, "Critiqs's browser build failed.");
// The script-tag build: a classic script, so `<script src=… async>` works
// without type="module". Served from npm CDNs at an exact version.
const script = await Bun.build({
  entrypoints: [`${directory}src/script.ts`],
  target: "browser",
  format: "iife",
  minify: true,
  jsx: { runtime: "automatic", development: false },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!script.success) throw new AggregateError(script.logs, "Critiqs's script-tag build failed.");
await Bun.write(`${directory}dist/critiqs.js`, script.outputs[0]!);

const types = Bun.spawn(["bun", "run", "tsc", "-p", "tsconfig.build.json"], { cwd: directory, stdout: "inherit", stderr: "inherit" });
if ((await types.exited) !== 0) throw new Error("Critiqs's declaration build failed.");

// Only the public declaration graph ships, flattened beside the bundles. The
// private workspace names become relative paths.
const emitted = `${directory}build/types/packages/`;
const flatten = (text: string) =>
  text
    .replaceAll('"@critiqs/core"', '"./core/types.js"')
    .replace(/"(?:\.\.\/\.\.\/react\/src\/|\.\/)([\w-]+)\.tsx?"/g, '"./$1.js"');
for (const [from, name] of [
  ["critiqs/src/index", "index"],
  ["critiqs/src/element", "element"],
  ["critiqs/src/router", "router"],
  ["react/src/mount", "mount"],
  ["react/src/host", "host"],
  ["react/src/constants", "constants"],
] as const) {
  await Bun.write(`${directory}dist/${name}.d.ts`, flatten(await Bun.file(`${emitted}${from}.d.ts`).text()));
}
await mkdir(`${directory}dist/core`, { recursive: true });
await Bun.write(`${directory}dist/core/types.d.ts`, Bun.file(`${emitted}core/src/types.d.ts`));
console.error("Built Critiqs's browser modules and public declarations.");
