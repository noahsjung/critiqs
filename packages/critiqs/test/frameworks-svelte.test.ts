// Svelte (Vite) setup against apps shaped like `npm create vite@latest -- --template svelte-ts`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";
import type { FileWrite, Plan, Settings } from "../bin/frameworks/types.d.mts";

const svelte = FRAMEWORKS.find((adapter) => adapter.id === "svelte")!;

// The app's own Svelte compiler reads its components; fixtures link the workspace's copy.
const SVELTE = join(import.meta.dir, "../../svelte/node_modules/svelte");
const PROJECT = "j12345678901234567890123456789012";
const OTHER = "k98765432109876543210987654321098";

export function app(files: Record<string, string>, { svelteDir = SVELTE }: { svelteDir?: string | null } = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-svelte-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  if (svelteDir !== null) {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(svelteDir, join(root, "node_modules/svelte"));
  }
  return root;
}

export function apply(plan: Plan): FileWrite[] {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  for (const write of plan.writes) {
    mkdirSync(dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.source);
  }
  return plan.writes;
}

const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");

// What create-vite's svelte-ts template generates, trimmed to the parts setup reads.
const STARTER = {
  "package.json": JSON.stringify({
    name: "vite-ts",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build" },
    devDependencies: { "@sveltejs/vite-plugin-svelte": "^7.3.1", svelte: "^5.57.3", typescript: "~6.0.3", vite: "^8.3.6" },
  }),
  "vite.config.ts": "import { svelte } from '@sveltejs/vite-plugin-svelte'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [svelte()],\n})\n",
  "svelte.config.js": '/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */\nexport default {}\n',
  "index.html": '<!doctype html>\n<html lang="en">\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n',
  "src/main.ts": "import { mount } from 'svelte'\nimport './app.css'\nimport App from './App.svelte'\n\nconst app = mount(App, {\n  target: document.getElementById('app')!,\n})\n\nexport default app\n",
  "src/App.svelte":
    "<script>\n  import svelteLogo from './assets/svelte.svg'\n  import Counter from './lib/Counter.svelte'\n</script>\n\n<section id=\"center\">\n  <img src={svelteLogo} class=\"framework\" alt=\"Svelte logo\" />\n  <Counter />\n</section>\n\n<div class=\"ticks\"></div>\n<section id=\"spacer\"></section>\n",
  "src/lib/Counter.svelte": "<script lang=\"ts\">\n  let count: number = $state(0)\n</script>\n\n<button class=\"counter\" onclick={() => count++}>\n  Count is {count}\n</button>\n",
};

const literal = (id = PROJECT, extra: Partial<Settings> = {}): Settings => ({ projectId: { literal: id }, requireProjectId: false, ...extra });
const fromEnv = (root: string): Settings => ({ projectId: { env: svelte.env(root, "")! }, requireProjectId: true });
const noEntry = { entry: null };

describe("detect and env", () => {
  test("a create-vite Svelte app is Svelte", () => {
    expect(detectApp(app(STARTER))?.id).toBe("svelte");
  });

  test("reads the project ID from VITE_CRITIQS_PROJECT_ID, set in .env.local", () => {
    const root = app(STARTER);
    expect(svelte.env(root, "")).toMatchObject({
      variable: "VITE_CRITIQS_PROJECT_ID",
      expression: "import.meta.env.VITE_CRITIQS_PROJECT_ID",
      readsAt: "build",
      localFile: ".env.local",
    });
    expect(svelte.env(root, "_WEB")?.variable).toBe("VITE_CRITIQS_PROJECT_ID_WEB");
  });

  test("follows a literal envDir, and has no convention when envPrefix changes which names reach the browser", () => {
    const config = (body: string) => app({ ...STARTER, "vite.config.ts": `export default { plugins: [], ${body} }\n` });
    expect(svelte.env(config("envDir: '../shared'"), "")?.localFile).toBe("../shared/.env.local");
    expect(svelte.env(config("envDir: process.env.DIR"), "")).toBeNull();
    expect(svelte.env(config("envPrefix: 'APP_'"), "")).toBeNull();
  });

  test("resolves envDir from the Vite root, as Vite does", () => {
    const config = (body: string) => app({ ...STARTER, "vite.config.ts": `export default { plugins: [], ${body} }\n` });
    expect(svelte.env(config("root: 'web', envDir: 'config'"), "")?.localFile).toBe("web/config/.env.local");
    expect(svelte.env(config("root: 'web'"), "")?.localFile).toBe("web/.env.local");
    expect(svelte.env(config("root: './web', envDir: '../shared'"), "")?.localFile).toBe("shared/.env.local");
    expect(svelte.env(config("root: process.env.ROOT"), "")).toBeNull();
  });

  test("has no convention in a Svelte app built without Vite (Rollup, webpack, esbuild)", () => {
    const COMPONENT = { "src/App.svelte": "<h1>Hello</h1>\n" };
    const built = (devDependencies: Record<string, string>, config: Record<string, string>) =>
      app({ "package.json": JSON.stringify({ name: "app", private: true, devDependencies: { svelte: "^5.57.3", ...devDependencies } }), ...config, ...COMPONENT });
    const rollup = built({ rollup: "^4.0.0", "rollup-plugin-svelte": "^7.2.0" }, { "rollup.config.js": "import svelte from 'rollup-plugin-svelte';\nexport default { input: 'src/main.js', plugins: [svelte()] };\n" });
    const webpack = built({ webpack: "^5.0.0", "svelte-loader": "^3.2.0" }, { "webpack.config.js": "module.exports = { module: { rules: [{ test: /\\.svelte$/, use: 'svelte-loader' }] } };\n" });
    const esbuild = built({ esbuild: "^0.25.0", "esbuild-svelte": "^0.9.0" }, { "build.js": "import esbuild from 'esbuild';\n" });
    for (const root of [rollup, webpack, esbuild]) expect(svelte.env(root, "")).toBeNull();
    // A Vite app with no vite.config file still has Vite's convention.
    const { "vite.config.ts": _, ...noConfig } = STARTER;
    expect(svelte.env(app(noConfig), "")?.variable).toBe("VITE_CRITIQS_PROJECT_ID");
  });
});

describe("plan", () => {
  test("adds Critiqs to src/App.svelte in the file's own style, and a second run changes nothing", () => {
    const root = app(STARTER);
    const plan = svelte.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: true, action: "install", changed: ["projectId"], file: join(root, "src/App.svelte"), line: 14 });
    apply(plan);
    expect(read(root, "src/App.svelte")).toBe(
      "<script>\n  import svelteLogo from './assets/svelte.svg'\n  import Counter from './lib/Counter.svelte'\n  import { Critiqs } from 'critiqs-svelte'\n</script>\n\n" +
        '<section id="center">\n  <img src={svelteLogo} class="framework" alt="Svelte logo" />\n  <Counter />\n</section>\n\n<div class="ticks"></div>\n<section id="spacer"></section>\n' +
        `<Critiqs projectId="${PROJECT}" />\n`,
    );
    expect(svelte.plan(root, literal(), noEntry)).toMatchObject({ ok: true, action: "unchanged", writes: [], changed: [] });
    expect(svelte.find(root)).toEqual([{ file: join(root, "src/App.svelte"), line: 14, projectId: { kind: "literal", value: PROJECT }, backend: null, requireProjectId: false }]);
  });

  test("reads an environment-backed project ID with requireProjectId", () => {
    const root = app(STARTER);
    apply(svelte.plan(root, fromEnv(root), noEntry));
    expect(read(root, "src/App.svelte")).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />\n");
    expect(svelte.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
    expect(svelte.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "VITE_CRITIQS_PROJECT_ID" }, requireProjectId: true }]);
  });

  test("updates the existing Critiqs instead of adding a second, changing only what differs", () => {
    const root = app({
      ...STARTER,
      "src/routes/Shell.svelte": `<script lang="ts">\n\timport { Critiqs as Feedback } from 'critiqs-svelte';\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n<Feedback\n\tprojectId="${PROJECT}"\n\tversion="v1"\n/>\n`,
    });
    const plan = svelte.plan(root, literal(OTHER, { backend: "https://example.convex.cloud" }), noEntry);
    expect(plan).toMatchObject({ ok: true, action: "update", changed: ["projectId", "backend"], file: join(root, "src/routes/Shell.svelte"), line: 7 });
    apply(plan);
    expect(read(root, "src/routes/Shell.svelte")).toBe(
      `<script lang="ts">\n\timport { Critiqs as Feedback } from 'critiqs-svelte';\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n<Feedback\n\tprojectId="${OTHER}"\n\tversion="v1"\n\tbackend="https://example.convex.cloud"\n/>\n`,
    );
    expect(read(root, "src/App.svelte")).toBe(STARTER["src/App.svelte"]);
  });

  test("switches a written ID to the environment variable", () => {
    const root = app(STARTER);
    apply(svelte.plan(root, literal(), noEntry));
    const plan = svelte.plan(root, fromEnv(root), noEntry);
    expect(plan).toMatchObject({ ok: true, action: "update", changed: ["projectId", "requireProjectId"] });
    apply(plan);
    expect(read(root, "src/App.svelte")).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />");
  });

  test("turns requireProjectId={false} on, and leaves a backend it wasn't given", () => {
    const root = app({ ...STARTER, "src/App.svelte": `<script>\n  import { Critiqs } from 'critiqs-svelte'\n</script>\n\n<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId={false} backend="https://own.example" />\n` });
    apply(svelte.plan(root, fromEnv(root), noEntry));
    expect(read(root, "src/App.svelte")).toContain('<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId backend="https://own.example" />');
  });

  test("refuses a requireProjectId set from code, and reads only bare or {true} as set", () => {
    const component = (value: string) => `<script>\n  import { Critiqs } from 'critiqs-svelte'\n  const isProd = import.meta.env.PROD\n</script>\n\n<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} ${value} />\n`;
    const computed = app({ ...STARTER, "src/App.svelte": component("requireProjectId={isProd}") });
    expect(svelte.find(computed)[0]?.requireProjectId).toBe(false);
    const plan = svelte.plan(computed, fromEnv(computed), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "expression" });
    if (!plan.ok) expect(plan.message).toContain("sets requireProjectId to {isProd}, which setup can't read as true or false");
    expect(read(computed, "src/App.svelte")).toContain("requireProjectId={isProd}");

    const text = app({ ...STARTER, "src/App.svelte": component('requireProjectId="yes"') });
    expect(svelte.find(text)[0]?.requireProjectId).toBe(false);
    expect(svelte.plan(text, fromEnv(text), noEntry)).toMatchObject({ ok: false, reason: "expression" });

    const written = app({ ...STARTER, "src/App.svelte": component("requireProjectId={true}") });
    expect(svelte.find(written)[0]?.requireProjectId).toBe(true);
    expect(svelte.plan(written, fromEnv(written), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("matches the component's quotes and semicolons around import attributes and spaces, and edits a one-line <script>", () => {
    const withAttributes = app({ ...STARTER, "src/App.svelte": '<script>\n  import data from "./data.json" with { type: "json" };\n</script>\n\n<p>{data.title}</p>\n' });
    apply(svelte.plan(withAttributes, literal(), noEntry));
    expect(read(withAttributes, "src/App.svelte")).toContain('  import data from "./data.json" with { type: "json" };\n  import { Critiqs } from "critiqs-svelte";\n');

    const spaced = app({ ...STARTER, "src/App.svelte": "<script>\n  import Counter from './lib/Counter.svelte' ;\n</script>\n\n<Counter />\n" });
    apply(svelte.plan(spaced, literal(), noEntry));
    expect(read(spaced, "src/App.svelte")).toContain("  import Counter from './lib/Counter.svelte' ;\n  import { Critiqs } from 'critiqs-svelte';\n");

    const oneLine = app({ ...STARTER, "src/App.svelte": "<script>let count = $state(0)</script>\n\n<button onclick={() => count++}>{count}</button>\n" });
    const plan = svelte.plan(oneLine, literal(), noEntry);
    expect(plan).toMatchObject({ ok: true, action: "install" });
    apply(plan);
    expect(read(oneLine, "src/App.svelte")).toStartWith("<script>\n\timport { Critiqs } from 'critiqs-svelte';\n\tlet count = $state(0)</script>\n");
    expect(svelte.plan(oneLine, literal(), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("keeps a comment at the end of the last import's line on that line", () => {
    const root = app({ ...STARTER, "src/App.svelte": "<script>\n  import Counter from './lib/Counter.svelte' // the demo counter\n</script>\n\n<Counter />\n" });
    apply(svelte.plan(root, literal(), noEntry));
    expect(read(root, "src/App.svelte")).toBe(
      `<script>\n  import Counter from './lib/Counter.svelte' // the demo counter\n  import { Critiqs } from 'critiqs-svelte'\n</script>\n\n<Counter />\n<Critiqs projectId="${PROJECT}" />\n`,
    );
    expect(svelte.plan(root, literal(), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("keeps a component's Windows line endings", () => {
    const root = app({ ...STARTER, "src/App.svelte": STARTER["src/App.svelte"].replaceAll("\n", "\r\n") });
    apply(svelte.plan(root, literal(), noEntry));
    const edited = read(root, "src/App.svelte");
    expect(edited).toContain("import { Critiqs } from 'critiqs-svelte'\r\n");
    expect(edited).toEndWith(`<section id="spacer"></section>\r\n<Critiqs projectId="${PROJECT}" />\r\n`);
    expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
    expect(svelte.plan(root, literal(), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
    apply(svelte.plan(root, literal(OTHER), noEntry));
    expect(read(root, "src/App.svelte")).toBe(edited.replace(PROJECT, OTHER));
  });

  test("refuses, with complete instructions, a project ID set from other code", () => {
    const root = app({ ...STARTER, "src/App.svelte": `<script>\n  import { Critiqs } from 'critiqs-svelte'\n  const id = '${PROJECT}'\n</script>\n\n<Critiqs projectId={id} />\n` });
    const plan = svelte.plan(root, literal(OTHER), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "expression" });
    if (plan.ok) return;
    expect(plan.message).toContain("src/App.svelte:6 sets projectId from code (id)");
    expect(plan.message).toContain(`<Critiqs projectId="${OTHER}" />`);
    expect(svelte.find(root)).toMatchObject([{ projectId: { kind: "expression", text: "id" } }]);
  });

  test("refuses a setting a later spread could override", () => {
    const root = app({ ...STARTER, "src/App.svelte": `<script>\n  import { Critiqs } from 'critiqs-svelte'\n  let rest = {}\n</script>\n\n<Critiqs projectId="${PROJECT}" {...rest} />\n` });
    expect(svelte.plan(root, literal(OTHER), noEntry)).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  test("refuses two Critiqs components, naming both", () => {
    const usage = `<script>\n  import { Critiqs } from 'critiqs-svelte'\n</script>\n\n<Critiqs projectId="${PROJECT}" />\n`;
    const root = app({ ...STARTER, "src/App.svelte": usage, "src/Other.svelte": usage });
    const plan = svelte.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!plan.ok) expect(plan.message).toContain("src/App.svelte:5\n  src/Other.svelte:5");
  });

  test("refuses a component that loads critiqs-svelte without a <Critiqs> setup can read", () => {
    const root = app({ ...STARTER, "src/App.svelte": `<script>\n  import * as C from 'critiqs-svelte'\n  import { Critiqs } from 'critiqs-svelte'\n  const Component = Critiqs\n</script>\n\n<Component />\n` });
    expect(svelte.plan(root, literal(), noEntry)).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  test("refuses when Critiqs already names something else in the component", () => {
    const root = app({ ...STARTER, "src/App.svelte": "<script>\n  import Critiqs from './Critiqs.svelte'\n</script>\n\n<Critiqs />\n" });
    expect(svelte.plan(root, literal(), noEntry)).toMatchObject({ ok: false, reason: "manual" });
  });

  test("honours a chosen entry, and refuses one that isn't a component", () => {
    const root = app({ ...STARTER, "src/Shell.svelte": "<main><slot /></main>\n" });
    const plan = svelte.plan(root, literal(), { entry: "src/Shell.svelte" });
    expect(plan).toMatchObject({ ok: true, file: join(root, "src/Shell.svelte") });
    apply(plan);
    expect(read(root, "src/Shell.svelte")).toBe(`<script>\n\timport { Critiqs } from 'critiqs-svelte';\n</script>\n\n<main><slot /></main>\n<Critiqs projectId="${PROJECT}" />\n`);
    expect(svelte.plan(root, literal(), { entry: "src/main.ts" })).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(svelte.plan(app(STARTER), literal(), { entry: "src/main.ts" })).toMatchObject({ ok: false, reason: "manual" });
  });

  test("without src/App.svelte, finds the component index.html's script mounts", () => {
    const { "src/App.svelte": _, ...rest } = STARTER;
    const root = app({
      ...rest,
      "src/main.ts": "import { mount } from 'svelte'\nimport Root from './Root.svelte'\n\nmount(Root, { target: document.body })\n",
      "src/Root.svelte": '<script lang="ts">\n\tlet name = "world";\n</script>\n\n<h1>Hello {name}</h1>\n\n<style>\n\th1 { color: red; }\n</style>\n',
    });
    apply(svelte.plan(root, literal(), noEntry));
    expect(read(root, "src/Root.svelte")).toBe(
      `<script lang="ts">\n\timport { Critiqs } from 'critiqs-svelte';\n\tlet name = "world";\n</script>\n\n<h1>Hello {name}</h1>\n<Critiqs projectId="${PROJECT}" />\n\n<style>\n\th1 { color: red; }\n</style>\n`,
    );
  });

  test("writes text Svelte would read as code as a JavaScript string", () => {
    const root = app(STARTER);
    apply(svelte.plan(root, literal(PROJECT, { backend: "https://own.example/critiqs?team=a&b={c}" }), noEntry));
    expect(read(root, "src/App.svelte")).toContain('backend={"https://own.example/critiqs?team=a&b={c}"}');
    expect(svelte.find(root)[0]?.backend).toEqual({ kind: "literal", value: "https://own.example/critiqs?team=a&b={c}" });
  });

  test("refuses, with instructions, when Svelte isn't installed, is older than 5, or can't parse the component", () => {
    const missing = svelte.plan(app(STARTER, { svelteDir: null }), literal(), noEntry);
    expect(missing).toMatchObject({ ok: false, reason: "unreadable" });
    if (!missing.ok) expect(missing.message).toContain("import { Critiqs } from 'critiqs-svelte';");

    const old = app({ "package.json": JSON.stringify({ name: "svelte", exports: { "./compiler": { require: "./compiler.cjs" } } }), "compiler.cjs": "exports.VERSION = '4.2.19';\n" }, { svelteDir: null });
    const root = app(STARTER, { svelteDir: old });
    const plan = svelte.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "unreadable" });
    if (!plan.ok) expect(plan.message).toContain("needs Svelte 5");

    const broken = app({ ...STARTER, "src/App.svelte": "<script>\n  import { Critiqs } from 'critiqs-svelte'\n</script>\n\n<Critiqs projectId={ />\n" });
    expect(svelte.plan(broken, literal(), noEntry)).toMatchObject({ ok: false, reason: "unreadable" });
  });
});

test("manual instructions name the file, the import, and the settings", () => {
  const root = app(STARTER);
  expect(svelte.manual(fromEnv(root))).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />");
  expect(svelte.manual(literal())).toContain("src/App.svelte");
});
