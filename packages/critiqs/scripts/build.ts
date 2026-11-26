import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
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

// Critiqs's Convex functions, so `critiqs init` can deploy them to a team's own
// Convex deployment. The shared server rules are bundled beside them, since
// the private workspace packages are not published.
const backend = `${directory}dist/backend/convex/`;
const vendor = `${backend}lib/vendor/`;
// The shipped Convex sources resolve their S3 signer without another install.
const signing = await Bun.build({
  entrypoints: [Bun.resolveSync("aws4fetch", fileURLToPath(new URL("../../backend/", import.meta.url)))],
  target: "browser", format: "esm",
});
if (!signing.success) throw new AggregateError(signing.logs, "R2 signing build failed.");
await mkdir(vendor, { recursive: true });
await Bun.write(`${vendor}aws4fetch.js`, signing.outputs[0]!);
// Model calls (the AI SDK and its providers) are a separate bundle, imported
// only by the Node actions in ai.ts, so other functions stay small.
const providers = await Bun.build({
  entrypoints: [`${directory}../server/src/ai/providers.ts`],
  target: "node",
  format: "esm",
});
if (!providers.success) throw new AggregateError(providers.logs, "Critiqs's AI provider build failed.");
await Bun.write(`${vendor}critiqs_ai.js`, providers.outputs[0]!);
for (const [entry, name] of [
  ["../core/src/index.ts", "critiqs_core.js"],
  ["../server/src/index.ts", "critiqs_server.js"],
] as const) {
  const bundle = await Bun.build({ entrypoints: [`${directory}${entry}`], target: "browser", format: "esm", external: ["@critiqs/core"] });
  if (!bundle.success) throw new AggregateError(bundle.logs, `Critiqs's ${name} build failed.`);
  await mkdir(vendor, { recursive: true });
  await Bun.write(`${vendor}${name}`, (await bundle.outputs[0]!.text()).replaceAll('"@critiqs/core"', '"./critiqs_core.js"'));
}
const functions = fileURLToPath(new URL("../../backend/convex/", import.meta.url));
for (const entry of await readdir(functions, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name === "tsconfig.json") continue;
  const from = `${entry.parentPath}/${entry.name}`;
  const to = `${backend}${relative(functions, from)}`;
  await mkdir(dirname(to), { recursive: true });
  if (!/\.tsx?$/.test(entry.name)) {
    await cp(from, to);
    continue;
  }
  const fromHere = relative(dirname(to), vendor);
  const toVendor = fromHere.startsWith(".") ? fromHere : `./${fromHere}`;
  const source = (await readFile(from, "utf8"))
    .replaceAll('"@critiqs/server/ai-providers"', `"${toVendor}/critiqs_ai.js"`)
    .replaceAll('"@critiqs/server"', `"${toVendor}/critiqs_server.js"`)
    .replaceAll('"@critiqs/core"', `"${toVendor}/critiqs_core.js"`)
    .replaceAll('"aws4fetch"', `"${toVendor}/aws4fetch.js"`);
  if (/["']@critiqs\//.test(source)) throw new Error(`${from} imports a workspace package the backend bundle doesn't include.`);
  await writeFile(to, source);
}
console.error("Bundled Critiqs's Convex functions for own deployments.");

// The server for self-hosting inside the host app (critiqs/server), with
// Critiqs's server rules bundled in. Its public types are written by hand in
// server.d.ts, so they don't name the private workspace packages. The AI SDK
// is split into its own chunk, loaded only once a model is called.
const server = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../../server/src/http/index.ts", import.meta.url))],
  outdir: `${directory}dist/server`,
  target: "node",
  format: "esm",
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  external: ["bun:sqlite", "node:sqlite"],
});
if (!server.success) throw new AggregateError(server.logs, "Critiqs's server build failed.");
await cp(`${directory}src/server.d.ts`, `${directory}dist/server/index.d.ts`);
console.error("Built Critiqs's server for self-hosting.");
