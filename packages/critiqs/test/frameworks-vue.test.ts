import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FRAMEWORKS } from "../bin/frameworks/index.mjs";
import type { Plan, Settings } from "../bin/frameworks/types.d.mts";

const vue = FRAMEWORKS.find((adapter) => adapter.id === "vue")!;
const PROJECT = "j12345678901234567890123456789012";
const OTHER = "k98765432109876543210987654321098";

// The files create-vue 3.24 writes (`npm create vue@latest -- --default`,
// `--ts --router`, `--ts --bare`), with each App.vue's styles shortened.
const PACKAGE_JSON = JSON.stringify(
  {
    name: "vue-app",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: 'run-p type-check "build-only {@}" --', "build-only": "vite build", "type-check": "vue-tsc --build" },
    dependencies: { vue: "^3.5.42" },
    devDependencies: { "@vitejs/plugin-vue": "^6.0.8", typescript: "~6.0.0", vite: "^8.2.2", "vue-tsc": "^3.3.11" },
  },
  null,
  2,
);
const VITE_CONFIG = `import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
})
`;
const DEFAULT_APP = `<script setup lang="ts">
import HelloWorld from './components/HelloWorld.vue'
import TheWelcome from './components/TheWelcome.vue'
</script>

<template>
  <header>
    <img alt="Vue logo" class="logo" src="./assets/logo.svg" width="125" height="125" />

    <div class="wrapper">
      <HelloWorld msg="You did it!" />
    </div>
  </header>

  <main>
    <TheWelcome />
  </main>
</template>

<style scoped>
header {
  line-height: 1.5;
}
</style>
`;
const ROUTER_APP = `<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import HelloWorld from './components/HelloWorld.vue'
</script>

<template>
  <header>
    <img alt="Vue logo" class="logo" src="@/assets/logo.svg" width="125" height="125" />

    <div class="wrapper">
      <HelloWorld msg="You did it!" />

      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/about">About</RouterLink>
      </nav>
    </div>
  </header>

  <RouterView />
</template>

<style scoped>
header {
  line-height: 1.5;
  max-height: 100vh;
}
</style>
`;
const BARE_APP = `<script setup lang="ts"></script>

<template>
  <h1>You did it!</h1>
  <p>
    Visit <a href="https://vuejs.org/" target="_blank" rel="noopener">vuejs.org</a> to read the
    documentation
  </p>
</template>

<style scoped></style>
`;

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-vue-"));
  const all = { "package.json": PACKAGE_JSON, "vite.config.ts": VITE_CONFIG, "tsconfig.json": "{}\n", ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const read = (root: string, name = "src/App.vue") => readFileSync(join(root, name), "utf8");
const literal = (id = PROJECT, extra: Partial<Settings> = {}): Settings => ({ projectId: { literal: id }, requireProjectId: false, ...extra });
const fromEnv = (root: string, suffix = ""): Settings => ({ projectId: { env: vue.env(root, suffix)! }, requireProjectId: true });

/** The parts of Vue's compiler these tests use; this package doesn't depend on Vue, so its types aren't available here. */
interface SfcCompiler {
  parse(source: string, options: { filename: string }): {
    descriptor: { script: unknown; scriptSetup: unknown; template: { content: string } | null };
    errors: unknown[];
  };
  compileScript(descriptor: unknown, options: { id: string; inlineTemplate: boolean }): { content: string; imports?: Record<string, { source: string }> };
  compileTemplate(options: { source: string; filename: string; id: string }): { errors: unknown[] };
}

// Vue's own compiler, from critiqs-vue's dependencies.
const sfc = (await import(Bun.resolveSync("vue/compiler-sfc", join(import.meta.dir, "../../vue")))) as SfcCompiler;

/**
 * Throws unless Vue compiles `source`: its blocks, its script (then parsed as
 * TypeScript), and its template. Returns the names its script setup imports
 * from critiqs-vue, and the components its template looks up globally rather
 * than from the script's bindings.
 */
function compile(source: string, filename: string) {
  const { descriptor, errors } = sfc.parse(source, { filename });
  if (errors.length > 0) throw errors[0];
  const imported: string[] = [];
  const global: string[] = [];
  if (descriptor.script !== null || descriptor.scriptSetup !== null) {
    const script = sfc.compileScript(descriptor, { id: "check", inlineTemplate: descriptor.scriptSetup !== null });
    new Bun.Transpiler({ loader: "ts" }).transformSync(script.content);
    for (const [local, binding] of Object.entries(script.imports ?? {})) if (binding.source === "critiqs-vue") imported.push(local);
    if (descriptor.scriptSetup !== null) for (const [, name] of script.content.matchAll(/resolveComponent\("([^"]+)"/g)) global.push(name!);
  }
  if (descriptor.template !== null) {
    const template = sfc.compileTemplate({ source: descriptor.template.content, filename, id: "check" });
    if (template.errors.length > 0) throw template.errors[0];
  }
  return { imported, global };
}

/** Writes a plan's files, as the CLI does, checking Vue still compiles each one, and returns the plan. */
function apply(plan: Plan) {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  for (const write of plan.writes) {
    const { imported, global } = compile(write.source, write.file);
    // Critiqs imported from critiqs-vue is the component the template uses, never a global of that name.
    expect(global.filter((name) => imported.includes(name))).toEqual([]);
    writeFileSync(write.file, write.source);
  }
  return plan;
}
/** Plans, applies, and checks a second plan changes nothing. */
function setUp(root: string, settings: Settings, entry: string | null = null) {
  const plan = apply(vue.plan(root, settings, { entry }));
  const again = vue.plan(root, settings, { entry });
  expect(again).toMatchObject({ ok: true, action: "unchanged", writes: [] });
  return plan;
}

test("reads Vite's public variables, unless the app renames their prefix or doesn't use Vite", () => {
  const root = app({ "src/App.vue": DEFAULT_APP });
  expect(vue.env(root, "")).toEqual({
    variable: "VITE_CRITIQS_PROJECT_ID",
    expression: "import.meta.env.VITE_CRITIQS_PROJECT_ID",
    readsAt: "build",
    localFile: ".env.local",
    deploymentAdvice: expect.stringContaining("next build"),
  });
  expect(vue.env(root, "_WEB")?.variable).toBe("VITE_CRITIQS_PROJECT_ID_WEB");
  expect(vue.env(app({ "vite.config.ts": "export default { envPrefix: 'APP_' }\n" }), "")).toBeNull();
  expect(vue.env(app({ "package.json": JSON.stringify({ dependencies: { vue: "3" } }) }), "")).toBeNull();
});

test("adds Critiqs with a project ID to create-vue's App.vue, keeping the rest of the file", () => {
  const root = app({ "src/App.vue": DEFAULT_APP });
  expect(vue.find(root)).toEqual([]);
  const plan = setUp(root, literal());
  expect(plan).toMatchObject({ action: "install", file: join(root, "src/App.vue"), line: 19, changed: ["projectId"] });
  expect(read(root)).toBe(
    DEFAULT_APP.replace("import TheWelcome from './components/TheWelcome.vue'\n", "import TheWelcome from './components/TheWelcome.vue'\nimport { Critiqs } from 'critiqs-vue'\n").replace(
      "  </main>\n</template>",
      `  </main>\n  <Critiqs project-id="${PROJECT}" />\n</template>`,
    ),
  );
  expect(plan.preview).toContain(`+   <Critiqs project-id="${PROJECT}" />`);
  expect(vue.find(root)).toEqual([{ file: join(root, "src/App.vue"), line: 19, projectId: { kind: "literal", value: PROJECT }, backend: null, requireProjectId: false }]);
});

test("reads the project ID from .env.local's variable in the router starter", () => {
  const root = app({ "src/App.vue": ROUTER_APP });
  const plan = setUp(root, fromEnv(root));
  expect(plan.changed).toEqual(["projectId", "requireProjectId"]);
  expect(plan.next).toEqual(["Restart the Vite dev server so it reads VITE_CRITIQS_PROJECT_ID."]);
  expect(read(root)).toBe(
    ROUTER_APP.replace(
      "import HelloWorld from './components/HelloWorld.vue'\n",
      "import HelloWorld from './components/HelloWorld.vue'\nimport { Critiqs } from 'critiqs-vue'\nconst critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID\n",
    ).replace("  <RouterView />\n</template>", '  <RouterView />\n  <Critiqs :project-id="critiqsProjectId" require-project-id />\n</template>'),
  );
  expect(vue.find(root)[0]).toMatchObject({ projectId: { kind: "env", variable: "VITE_CRITIQS_PROJECT_ID" }, requireProjectId: true, backend: null });
});

test("fills the bare starter's empty <script setup> and adds a backend", () => {
  const root = app({ "src/App.vue": BARE_APP });
  setUp(root, literal(PROJECT, { requireProjectId: true, backend: "https://critiqs.example.com/critiqs" }));
  expect(read(root)).toBe(`<script setup lang="ts">
import { Critiqs } from 'critiqs-vue'
</script>

<template>
  <h1>You did it!</h1>
  <p>
    Visit <a href="https://vuejs.org/" target="_blank" rel="noopener">vuejs.org</a> to read the
    documentation
  </p>
  <Critiqs project-id="${PROJECT}" require-project-id backend="https://critiqs.example.com/critiqs" />
</template>

<style scoped></style>
`);
  expect(vue.find(root)[0]).toMatchObject({ backend: { kind: "literal", value: "https://critiqs.example.com/critiqs" }, requireProjectId: true });
});

test("updates the component already there instead of adding a second, in either direction", () => {
  const root = app({ "src/App.vue": DEFAULT_APP });
  setUp(root, literal());
  const toEnv = setUp(root, fromEnv(root));
  expect(toEnv).toMatchObject({ action: "update", changed: ["projectId", "requireProjectId"] });
  expect(read(root)).toContain('<Critiqs :project-id="critiqsProjectId" require-project-id />');
  expect(read(root)).toContain("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID\n");

  const renamed = setUp(root, fromEnv(root, "_WEB"));
  expect(renamed.action).toBe("update");
  expect(read(root)).toContain("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID_WEB\n");

  const back = setUp(root, literal(OTHER, { backend: "https://critiqs.example.com/critiqs" }));
  expect(back.changed).toEqual(["projectId", "requireProjectId", "backend"]);
  expect(read(root)).not.toContain("critiqsProjectId");
  expect(read(root).match(/<Critiqs/g)).toHaveLength(1);
  expect(read(root)).toContain(`<Critiqs project-id="${OTHER}" backend="https://critiqs.example.com/critiqs" />`);

  setUp(root, literal(OTHER));
  expect(read(root)).toContain(`<Critiqs project-id="${OTHER}" />`);
});

test("keeps the developer's own attributes and layout when updating", () => {
  const source = DEFAULT_APP.replace(
    "  </main>\n</template>",
    `  </main>\n  <Critiqs\n    project-id="${OTHER}"\n    :get-context="() => ({ screen: route.name > '' ? route.name : 'home' })"\n    version="v1"\n  />\n</template>`,
  ).replace("import TheWelcome from './components/TheWelcome.vue'\n", "import TheWelcome from './components/TheWelcome.vue'\nimport { Critiqs } from 'critiqs-vue'\n");
  const root = app({ "src/App.vue": source });
  setUp(root, literal(PROJECT, { requireProjectId: true }));
  expect(read(root)).toBe(
    source.replace(`project-id="${OTHER}"`, `project-id="${PROJECT}"`).replace('    version="v1"\n', '    version="v1"\n    require-project-id\n'),
  );
});

test("follows the file's import style when adding to <script setup>", () => {
  const root = app({ "src/App.vue": '<script setup>\nimport { ref } from "vue";\n\nconst count = ref(0);\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n</template>\n' });
  setUp(root, fromEnv(root));
  expect(read(root)).toBe(
    '<script setup>\nimport { ref } from "vue";\nimport { Critiqs } from "critiqs-vue";\nconst critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID;\n\nconst count = ref(0);\n</script>\n\n<template>\n  <button @click="count++">{{ count }}</button>\n  <Critiqs :project-id="critiqsProjectId" require-project-id />\n</template>\n',
  );
});

test("adds a <script setup> to a component without one", () => {
  const root = app({ "src/App.vue": "<template>\n  <RouterView />\n</template>\n" });
  setUp(root, literal());
  expect(read(root)).toBe(`<script setup lang="ts">\nimport { Critiqs } from 'critiqs-vue'\n</script>\n\n<template>\n  <RouterView />\n  <Critiqs project-id="${PROJECT}" />\n</template>\n`);
});

test("puts Critiqs in the component the person chose", () => {
  const root = app({ "src/App.vue": DEFAULT_APP, "src/layouts/Shell.vue": BARE_APP });
  const plan = setUp(root, literal(), "src/layouts/Shell.vue");
  expect(plan.file).toBe(join(root, "src/layouts/Shell.vue"));
  expect(read(root)).toBe(DEFAULT_APP);
  expect(read(root, "src/layouts/Shell.vue")).toContain(`<Critiqs project-id="${PROJECT}" />`);
});

test("refuses, with instructions, what it can't edit safely", () => {
  const twice = app({ "src/App.vue": BARE_APP.replace("</template>", "  <Critiqs />\n</template>"), "src/components/Other.vue": "<template>\n  <Critiqs />\n</template>\n" });
  expect(vue.plan(twice, literal(), { entry: null })).toMatchObject({ ok: false, reason: "ambiguous", message: expect.stringContaining("src/components/Other.vue:2") });

  const computed = app({ "src/App.vue": BARE_APP.replace("</template>", '  <Critiqs :project-id="config.critiqs" />\n</template>') });
  const expression = vue.plan(computed, literal(), { entry: null });
  expect(expression).toMatchObject({ ok: false, reason: "expression", message: expect.stringContaining(`<Critiqs project-id="${PROJECT}" />`) });
  expect(vue.find(computed)[0]?.projectId).toEqual({ kind: "expression", text: "config.critiqs" });

  const options = app({ "src/App.vue": "<script>\nexport default { name: 'App' }\n</script>\n\n<template>\n  <div />\n</template>\n" });
  expect(vue.plan(options, literal(), { entry: null })).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringContaining("import { Critiqs } from 'critiqs-vue'") });

  const pug = app({ "src/App.vue": '<template lang="pug">\ndiv\n</template>\n' });
  expect(vue.plan(pug, literal(), { entry: null })).toMatchObject({ ok: false, reason: "unreadable" });

  const taken = app({ "src/App.vue": "<script setup>\nimport Critiqs from './Critiqs.vue'\n</script>\n\n<template>\n  <div />\n</template>\n" });
  expect(vue.plan(taken, literal(), { entry: null })).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringContaining("already uses the name Critiqs") });

  const missing = app({});
  const manual = vue.plan(missing, fromEnv(missing), { entry: null });
  expect(manual).toMatchObject({ ok: false, reason: "manual" });
  if (!manual.ok) {
    expect(manual.message).toContain("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID");
    expect(manual.message).toContain('<Critiqs :project-id="critiqsProjectId" require-project-id />');
  }
});

test("follows an aliased import of Critiqs, updating its tag or adding one under that name", () => {
  const aliased = BARE_APP.replace('<script setup lang="ts"></script>', "<script setup lang=\"ts\">\nimport { Critiqs as Feedback } from 'critiqs-vue'\n</script>");
  const root = app({ "src/App.vue": aliased.replace("</template>", `  <Feedback project-id="${OTHER}" />\n</template>`) });
  expect(vue.find(root)).toMatchObject([{ file: join(root, "src/App.vue"), line: 11, projectId: { kind: "literal", value: OTHER } }]);
  expect(setUp(root, literal())).toMatchObject({ action: "update", changed: ["projectId"] });
  expect(read(root)).toBe(aliased.replace("</template>", `  <Feedback project-id="${PROJECT}" />\n</template>`));

  const untagged = app({ "src/App.vue": aliased });
  expect(setUp(untagged, literal())).toMatchObject({ action: "install" });
  expect(read(untagged)).toBe(aliased.replace("</template>", `  <Feedback project-id="${PROJECT}" />\n</template>`));
});

test("leaves the app's own Critiqs component alone", () => {
  const own = "<script setup>\nimport Critiqs from './components/Critiqs.vue'\n</script>\n\n<template>\n  <Critiqs title=\"Reviews\" />\n</template>\n";
  const root = app({ "src/App.vue": own, "src/components/Critiqs.vue": "<template>\n  <aside>Reviews</aside>\n</template>\n" });
  expect(vue.find(root)).toEqual([]);
  const plan = vue.plan(root, literal(), { entry: null });
  expect(plan).toMatchObject({ ok: false, reason: "unreadable" });
  // The instructions import Critiqs under another name, since the app's component has this one.
  if (!plan.ok) expect(plan.message).toContain("already uses the name Critiqs for something else, so nothing was changed. To add Critiqs by hand, in src/App.vue:\n1. In <script setup>, add: import { Critiqs as CritiqsFeedback } from 'critiqs-vue'");

  // Registered globally or auto-imported, with no import in App.vue: still the app's, since it has a Critiqs.vue.
  const global = app({ "src/App.vue": "<template>\n  <Critiqs title=\"Reviews\" />\n</template>\n", "src/components/Critiqs.vue": "<template>\n  <aside />\n</template>\n" });
  expect(vue.find(global)).toEqual([]);
  expect(vue.plan(global, literal(), { entry: null })).toMatchObject({ ok: false, reason: "unreadable" });
});

test("installs Critiqs instead of editing a commented-out tag or import", () => {
  const source = BARE_APP.replace('<script setup lang="ts"></script>', "<script setup lang=\"ts\">\n// import { Critiqs } from 'critiqs-vue'\n</script>").replace(
    "</template>",
    `  <!-- <Critiqs project-id="${OTHER}" /> -->\n</template>`,
  );
  const root = app({ "src/App.vue": source });
  expect(vue.find(root)).toEqual([]);
  expect(setUp(root, literal())).toMatchObject({ action: "install" });
  expect(read(root)).toBe(
    source.replace("// import { Critiqs } from 'critiqs-vue'\n", "import { Critiqs } from 'critiqs-vue'\n// import { Critiqs } from 'critiqs-vue'\n").replace(
      `  <!-- <Critiqs project-id="${OTHER}" /> -->\n</template>`,
      `  <!-- <Critiqs project-id="${OTHER}" /> -->\n  <Critiqs project-id="${PROJECT}" />\n</template>`,
    ),
  );
});

test("refuses rather than declare critiqsProjectId a second time", () => {
  const source = "<script setup>\nimport { useConfig } from './config'\nconst critiqsProjectId = useConfig().critiqs\n</script>\n\n<template>\n  <main />\n</template>\n";
  const root = app({ "src/App.vue": source });
  const plan = vue.plan(root, fromEnv(root), { entry: null });
  expect(plan).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringContaining("critiqsProjectId") });
  expect(read(root)).toBe(source);
  // A project ID written into the tag needs no binding, so it goes ahead.
  expect(vue.plan(root, literal(), { entry: null })).toMatchObject({ ok: true, action: "install" });
});

test("refuses an entry other than the component that already has Critiqs", () => {
  const root = app({ "src/App.vue": DEFAULT_APP, "src/layouts/Shell.vue": BARE_APP });
  setUp(root, literal());
  expect(vue.plan(root, literal(OTHER), { entry: "src/layouts/Shell.vue" })).toMatchObject({ ok: false, reason: "ambiguous", message: expect.stringContaining("src/App.vue:19") });
  expect(setUp(root, literal(OTHER), "src/App.vue")).toMatchObject({ action: "update" });
});

test("writes the variable to Vite's envDir", () => {
  const root = app({ "src/App.vue": DEFAULT_APP, "vite.config.ts": VITE_CONFIG.replace("  plugins: [", "  envDir: './config',\n  plugins: [") });
  expect(vue.env(root, "")).toMatchObject({ variable: "VITE_CRITIQS_PROJECT_ID", localFile: "config/.env.local" });
  expect(vue.env(app({ "vite.config.ts": "export default { envDir: process.env.ENV_DIR }\n" }), "")).toBeNull();
});

test("manual instructions name the package, the import, and the component", () => {
  const text = vue.manual(literal(PROJECT, { requireProjectId: true }));
  expect(text).toContain("npm install critiqs-vue");
  expect(text).toContain("import { Critiqs } from 'critiqs-vue'");
  expect(text).toContain(`<Critiqs project-id="${PROJECT}" require-project-id />`);
});

test("compile check: a broken component doesn't pass", () => {
  expect(() => compile("<script setup>\nconst a = 1\n  ?? 2\n  ?? \n</script>\n<template><p /></template>\n", "Broken.vue")).toThrow();
  expect(() => compile("<template><p></template>\n", "Broken.vue")).toThrow();
});

test("finds an aliased import of Critiqs after another import", () => {
  const script = `<script setup lang="ts">\nimport { ref } from 'vue'\nimport { Critiqs as Feedback } from 'critiqs-vue'\n\nconst open = ref(false)\n</script>\n\n<template>\n  <main v-if="open" />\n`;
  const root = app({ "src/App.vue": `${script}  <Feedback project-id="${OTHER}" />\n</template>\n` });
  expect(vue.find(root)).toMatchObject([{ line: 10, projectId: { kind: "literal", value: OTHER } }]);
  expect(setUp(root, literal())).toMatchObject({ action: "update", changed: ["projectId"] });
  expect(read(root)).toBe(`${script}  <Feedback project-id="${PROJECT}" />\n</template>\n`);

  const untagged = app({ "src/App.vue": `${script}</template>\n` });
  expect(setUp(untagged, literal())).toMatchObject({ action: "install" });
  expect(read(untagged)).toBe(`${script}  <Feedback project-id="${PROJECT}" />\n</template>\n`);
});

test("switching to a literal removes only the binding setup wrote, whole, and only when nothing else uses it", () => {
  const component = (declaration: string, extra = "") =>
    `<script setup lang="ts">\nimport { Critiqs } from 'critiqs-vue'\n${declaration}\n</script>\n\n<template>\n  <main>${extra}</main>\n  <Critiqs :project-id="critiqsProjectId" require-project-id />\n</template>\n`;
  const continued = "const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID\n  ?? 'j00000000000000000000000000000000'";
  const multiline = app({ "src/App.vue": component(continued) });
  setUp(multiline, literal(PROJECT, { requireProjectId: true }));
  expect(read(multiline)).toContain(`${continued}\n</script>`);
  expect(read(multiline)).toContain(`<Critiqs project-id="${PROJECT}" require-project-id />`);

  const shown = app({ "src/App.vue": component("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID", "{{ critiqsProjectId }}") });
  setUp(shown, literal(PROJECT, { requireProjectId: true }));
  expect(read(shown)).toContain("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID\n</script>");
  expect(read(shown)).toContain("<main>{{ critiqsProjectId }}</main>");

  const own = app({ "src/App.vue": component("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID;") });
  setUp(own, literal(PROJECT, { requireProjectId: true }));
  expect(read(own)).not.toContain("critiqsProjectId");
});

test("resolves envDir from Vite's root, as Vite does", async () => {
  const cases: Array<[string, string]> = [
    ["export default { root: 'client', envDir: 'env' }\n", "client/env/.env.local"],
    ["export default { root: 'client' }\n", "client/.env.local"],
    ["export default { root: './client/', envDir: '../config' }\n", "config/.env.local"],
    ["export default { envDir: 'env' }\n", "env/.env.local"],
    ["// Served from the project root.\nexport default { plugins: [] }\n", ".env.local"],
  ];
  // Vite's own resolveConfig, from the copy Nuxt builds with.
  const nuxtDir = dirname(Bun.resolveSync("nuxt/package.json", join(import.meta.dir, "../../nuxt")));
  const vite = (await import(Bun.resolveSync("vite", dirname(Bun.resolveSync("@nuxt/vite-builder", nuxtDir))))) as { resolveConfig(config: { configFile: string; logLevel: "silent" }, command: "build"): Promise<{ envDir: unknown }> };
  const cwd = process.cwd();
  for (const [config, localFile] of cases) {
    const root = app({ "vite.config.ts": config });
    expect(vue.env(root, "")?.localFile).toBe(localFile);
    process.chdir(root);
    try {
      const resolved = await vite.resolveConfig({ configFile: join(root, "vite.config.ts"), logLevel: "silent" }, "build");
      expect(join(resolved.envDir as string, ".env.local")).toBe(join(realpathSync(root), localFile));
    } finally {
      process.chdir(cwd);
    }
  }
  expect(vue.env(app({ "vite.config.ts": "export default { root: process.env.APP_ROOT }\n" }), "")).toBeNull();
  expect(vue.env(app({ "vite.config.ts": "const root = 'client'\nexport default { root }\n" }), "")).toBeNull();
});

test("adds the import after the real imports, never into a string, template, or regular expression that looks like one", () => {
  const body = (decoy: string) => `<script setup lang="ts">\nimport { ref } from 'vue'\n${decoy}\nconst open = ref(false)\n</script>\n\n<template>\n  <main v-if="open" />\n</template>\n`;
  const decoys = [
    "const help = `\nimport nothing from 'here'\n`",
    "const docs = `\nimport { Critiqs } from 'critiqs-vue'\n`",
    "const quote = /'/\n// import { Critiqs } from 'critiqs-vue'",
    "const both = [`${'`'}`, /[/'`]/]\nconst sample = '\\nimport x from \"y\"'",
  ];
  for (const decoy of decoys) {
    const root = app({ "src/App.vue": body(decoy) });
    setUp(root, literal());
    const written = read(root);
    expect(written).toBe(body(decoy).replace("import { ref } from 'vue'\n", "import { ref } from 'vue'\nimport { Critiqs } from 'critiqs-vue'\n").replace("</template>", `  <Critiqs project-id="${PROJECT}" />\n</template>`));
    // The tag resolves to the import, not to a component registered globally.
    expect(compile(written, "App.vue")).toEqual({ imported: ["Critiqs"], global: [] });
  }
});

test("changes the variable only of a project ID binding setup wrote and nothing else uses; otherwise it refuses", () => {
  const component = (extraScript = "", extraTemplate = "") =>
    `<script setup lang="ts">\nimport { Critiqs } from 'critiqs-vue'\nconst critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID\n${extraScript}</script>\n\n<template>\n  <main>${extraTemplate}</main>\n  <Critiqs :project-id="critiqsProjectId" require-project-id />\n</template>\n`;
  const own = app({ "src/App.vue": component() });
  expect(setUp(own, fromEnv(own, "_STAGING"))).toMatchObject({ action: "update" });
  expect(read(own)).toBe(component().replace("VITE_CRITIQS_PROJECT_ID", "VITE_CRITIQS_PROJECT_ID_STAGING"));

  for (const shared of [component("console.log(critiqsProjectId)\n"), component("", "{{ critiqsProjectId }}"), component("const label = `id ${critiqsProjectId}`\n")]) {
    const root = app({ "src/App.vue": shared });
    const plan = vue.plan(root, fromEnv(root, "_STAGING"), { entry: null });
    if (plan.ok) throw new Error(`Expected a refusal for:\n${shared}`);
    expect(plan.reason).toBe("expression");
    expect(plan.message).toContain("uses critiqsProjectId for more than <Critiqs>'s project ID");
    expect(plan.message).toContain("import.meta.env.VITE_CRITIQS_PROJECT_ID_STAGING");
  }
  // A use written only inside a string isn't a use.
  const quoted = app({ "src/App.vue": component("const note = 'critiqsProjectId'\n") });
  setUp(quoted, fromEnv(quoted, "_STAGING"));
  expect(read(quoted)).toContain("const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID_STAGING\n");
});
