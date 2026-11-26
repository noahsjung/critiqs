import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
await rm(`${directory}dist`, { recursive: true, force: true });
await rm(`${directory}build/types`, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${directory}src/index.ts`],
  outdir: `${directory}dist`,
  target: "browser",
  format: "esm",
  jsx: { runtime: "automatic", development: false },
  external: ["react", "react-dom", "convex", "modern-screenshot"],
});
if (!result.success) throw new AggregateError(result.logs, "Critiqs's browser build failed.");
// The component runs only in the browser. Frameworks with React Server
// Components (such as Next.js's App Router) read this directive and render
// <Critiqs /> as a client component, so a server layout can import it directly
// and the rest of the host's tree stays on the server. Other React apps ignore it.
const entry = `${directory}dist/index.js`;
const built = await Bun.file(entry).text();
await Bun.write(entry, `"use client";\n${built.replace(/^(["'])use client\1;?\n?/, "")}`);

const types = Bun.spawn(["bun", "run", "tsc", "-p", "tsconfig.build.json"], {
  cwd: directory, stdout: "inherit", stderr: "inherit",
});
if (await types.exited !== 0) throw new Error("Critiqs's declaration build failed.");

// Only the public declaration graph ships. Internal Convex declarations name
// the private backend workspace and must not become consumer dependencies.
for (const name of ["index", "Critiqs", "host", "constants"]) {
  const declaration = await Bun.file(`${directory}build/types/packages/react/src/${name}.d.ts`).text();
  await Bun.write(`${directory}dist/${name}.d.ts`, declaration
    .replaceAll('"@critiqs/core"', '"./core/types.js"')
    .replace(/(from\s+"\.\/[^"\n]+)\.tsx?"/g, '$1.js"'));
}
await mkdir(`${directory}dist/core`, { recursive: true });
await Bun.write(`${directory}dist/core/types.d.ts`, Bun.file(`${directory}build/types/packages/core/src/types.d.ts`));
console.error("Built Critiqs's browser module and public declarations.");

// critiqs-react/server is the shared package's server, under the name host
// apps already import; the CLI, backend bundle, and server live in critiqs.
await mkdir(`${directory}dist/server`, { recursive: true });
await Bun.write(`${directory}dist/server/index.js`, 'export * from "critiqs/server";\n');
await Bun.write(`${directory}dist/server/index.d.ts`, 'export * from "critiqs/server";\n');
console.error("Re-exported critiqs/server as critiqs-react/server.");

// Agents read the guide in the package they installed. Package managers that
// don't place critiqs beside it (pnpm) leave a pointer to critiqs's copy
// unresolvable, so critiqs-react ships the guide itself, from its one source.
const guide = await Bun.file(`${directory}../critiqs/AGENT_SETUP.md`).text();
await Bun.write(`${directory}AGENT_SETUP.md`, `<!-- Generated from packages/critiqs/AGENT_SETUP.md when critiqs-react is built; edit that file. -->\n${guide}`);
console.error("Copied critiqs's AGENT_SETUP.md into critiqs-react.");
