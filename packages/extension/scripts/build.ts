// Builds the unpacked extension into dist/: the worker, the content script
// (Critiqs's page layer), the side panel, and the Mockup tab, each one
// self-contained file, plus the manifest and icons. Load dist/ with "Load unpacked" in
// chrome://extensions.
//
// CRITIQS_BACKEND names another Convex deployment than Critiqs Cloud, such as
// a local one. CRITIQS_TEST=1 makes a test build for the automated Chrome
// run: it exposes the worker's click handling to the test, and grants the
// hosts in CRITIQS_TEST_HOSTS at install, which a real build never does.
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
const out = process.env.CRITIQS_EXTENSION_OUT ?? `${directory}dist`;
const test = process.env.CRITIQS_TEST === "1";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [`${directory}src/worker.ts`, `${directory}src/page.ts`, `${directory}src/panel/main.tsx`, `${directory}src/mockup/main.tsx`],
  outdir: out,
  naming: "[dir]/[name].js",
  target: "browser",
  // A classic script for each: content scripts can't be modules.
  format: "iife",
  minify: !test,
  jsx: { runtime: "automatic", development: false },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    CRITIQS_BACKEND: JSON.stringify(process.env.CRITIQS_BACKEND ?? ""),
    CRITIQS_TEST_HOOKS: JSON.stringify(test),
  },
});
if (!result.success) throw new AggregateError(result.logs, "The extension didn't build.");
// Chrome refuses a content script holding Unicode noncharacters, such as the
// U+FFFE a screenshot library's regular expression names, as "isn't UTF-8
// encoded". The bundler writes them out raw; written as escapes they mean the same.
const escapeNoncharacters = (code: string) =>
  code.replace(/[\uFDD0-\uFDEF\uFFFE\uFFFF]/g, (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase()}`);
for (const [from, to] of [["worker.js", "worker.js"], ["page.js", "page.js"], ["panel/main.js", "panel.js"], ["mockup/main.js", "mockup.js"]] as const) {
  await Bun.write(`${out}/${to}`, escapeNoncharacters(await Bun.file(`${out}/${from}`).text()));
}
await rm(`${out}/panel`, { recursive: true });
await rm(`${out}/mockup`, { recursive: true });

const manifest = await Bun.file(`${directory}static/manifest.json`).json();
if (test) {
  const hosts = (process.env.CRITIQS_TEST_HOSTS ?? "").split(",").filter(Boolean);
  manifest.name = "Critiqs (test build)";
  manifest.host_permissions = hosts;
}
await Bun.write(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
await cp(`${directory}static/panel.html`, `${out}/panel.html`);
await cp(`${directory}static/mockup.html`, `${out}/mockup.html`);
await cp(`${directory}static/icons`, `${out}/icons`, { recursive: true });
console.error(`Built the Critiqs extension in ${out}${test ? " (test build)" : ""}.`);
