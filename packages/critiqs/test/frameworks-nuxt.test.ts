import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";
import type { Plan, Settings } from "../bin/frameworks/types.d.mts";

const nuxt = FRAMEWORKS.find((adapter) => adapter.id === "nuxt")!;
const PROJECT = "j12345678901234567890123456789012";
const OTHER = "k98765432109876543210987654321098";
const BACKEND = "https://critiqs.example.com/critiqs";

// The files `npm create nuxt@latest -- --template minimal` (create-nuxt 4.1) writes.
const PACKAGE_JSON = JSON.stringify(
  {
    name: "nuxt-app",
    type: "module",
    private: true,
    scripts: { build: "nuxt build", dev: "nuxt dev", generate: "nuxt generate", preview: "nuxt preview", postinstall: "nuxt prepare" },
    dependencies: { nuxt: "^4.6.4", vue: "^3.5.45", "vue-router": "^5.4.0" },
  },
  null,
  2,
);
const CONFIG = `// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true }
})
`;
const APP_VUE = `<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtWelcome />
  </div>
</template>
`;

function app(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-nuxt-"));
  for (const [name, text] of Object.entries({ "package.json": PACKAGE_JSON, "nuxt.config.ts": CONFIG, "app/app.vue": APP_VUE, ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const config = (root: string, name = "nuxt.config.ts") => readFileSync(join(root, name), "utf8");
const literal = (id = PROJECT, extra: Partial<Settings> = {}): Settings => ({ projectId: { literal: id }, requireProjectId: true, ...extra });
const fromEnv = (root: string, suffix = ""): Settings => ({ projectId: { env: nuxt.env(root, suffix)! }, requireProjectId: true });

/** Throws when `source` isn't valid TypeScript, as Bun's parser reads it. */
const parse = (source: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(source);

/** Writes a plan's files, as the CLI does, checking each one still parses. */
function apply(plan: Plan) {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  for (const write of plan.writes) {
    parse(write.source);
    writeFileSync(write.file, write.source);
  }
  return plan;
}
function setUp(root: string, settings: Settings, entry: string | null = null) {
  const plan = apply(nuxt.plan(root, settings, { entry }));
  expect(nuxt.plan(root, settings, { entry })).toMatchObject({ ok: true, action: "unchanged", writes: [] });
  return plan;
}

test("a Nuxt app is set up as Nuxt, not Vue", () => {
  expect(detectApp(app())?.id).toBe("nuxt");
});

test("NUXT_PUBLIC_CRITIQS_PROJECT_ID reaches runtime config when the server starts; another name is read when nuxt.config builds", () => {
  const root = app();
  expect(nuxt.env(root, "")).toEqual({
    variable: "NUXT_PUBLIC_CRITIQS_PROJECT_ID",
    expression: "useRuntimeConfig().public.critiqs.projectId",
    readsAt: "runtime",
    localFile: ".env",
    deploymentAdvice: expect.stringContaining("server starts"),
  });
  expect(nuxt.env(root, "_WEB")).toMatchObject({ variable: "NUXT_PUBLIC_CRITIQS_PROJECT_ID_WEB", expression: "process.env.NUXT_PUBLIC_CRITIQS_PROJECT_ID_WEB", readsAt: "build", localFile: ".env" });
});

test("with the project ID from the environment, setup only adds the module to the starter's config", () => {
  const root = app();
  expect(nuxt.find(root)).toEqual([]);
  const plan = setUp(root, fromEnv(root));
  expect(plan).toMatchObject({ action: "install", file: join(root, "nuxt.config.ts"), line: 5, changed: ["projectId", "requireProjectId"] });
  expect(plan.next).toEqual(["Restart nuxt dev so it reads NUXT_PUBLIC_CRITIQS_PROJECT_ID from .env."]);
  expect(config(root)).toBe(`// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['critiqs-nuxt']
})
`);
  expect(plan.preview).toBe("-   devtools: { enabled: true }\n+   devtools: { enabled: true },\n+   modules: ['critiqs-nuxt']");
  expect(nuxt.find(root)).toEqual([{ file: join(root, "nuxt.config.ts"), line: 5, projectId: { kind: "env", variable: "NUXT_PUBLIC_CRITIQS_PROJECT_ID" }, backend: null, requireProjectId: true }]);
});

test("writes a project ID, backend, and requireProjectId: false under critiqs", () => {
  const root = app();
  setUp(root, literal(PROJECT, { requireProjectId: false, backend: BACKEND }));
  expect(config(root)).toBe(`// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['critiqs-nuxt'],
  critiqs: {
    projectId: '${PROJECT}',
    requireProjectId: false,
    backend: '${BACKEND}'
  }
})
`);
  expect(nuxt.find(root)[0]).toMatchObject({ projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: BACKEND }, requireProjectId: false });
});

test("adds to the modules already listed, single-line or one per line, keeping trailing commas", () => {
  const inline = app({ "nuxt.config.ts": CONFIG.replace("  devtools: { enabled: true }\n", "  devtools: { enabled: true },\n  modules: ['@nuxt/eslint']\n") });
  setUp(inline, literal());
  expect(config(inline)).toContain(`  modules: ['@nuxt/eslint', 'critiqs-nuxt'],\n  critiqs: { projectId: '${PROJECT}' }\n})`);

  const listed = app({
    "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: [\n    "@nuxt/eslint",\n    "@nuxt/ui",\n  ],\n  devtools: { enabled: true },\n});\n`,
  });
  setUp(listed, literal());
  expect(config(listed)).toBe(`export default defineNuxtConfig({\n  modules: [\n    "@nuxt/eslint",\n    "@nuxt/ui",\n    "critiqs-nuxt",\n  ],\n  devtools: { enabled: true },\n  critiqs: { projectId: "${PROJECT}" },\n});\n`);

  const empty = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: [],\n})\n" });
  setUp(empty, fromEnv(empty));
  expect(config(empty)).toBe("export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n})\n");
});

test("updates the settings already there, keeping the developer's own, and removes the block when the environment takes over", () => {
  const root = app();
  setUp(root, literal(OTHER));
  const toProject = setUp(root, literal(PROJECT, { backend: BACKEND }));
  expect(toProject).toMatchObject({ action: "update", changed: ["projectId", "backend"] });
  expect(config(root)).toContain(`  critiqs: {\n    projectId: '${PROJECT}',\n    backend: '${BACKEND}'\n  }\n})`);

  writeFileSync(join(root, "nuxt.config.ts"), config(root).replace(`backend: '${BACKEND}'`, `backend: '${BACKEND}',\n    version: process.env.COMMIT_SHA`));
  const toEnv = setUp(root, fromEnv(root));
  expect(toEnv.changed).toEqual(["projectId", "backend"]);
  expect(config(root)).toContain("  modules: ['critiqs-nuxt'],\n  critiqs: { version: process.env.COMMIT_SHA }\n})");

  const named = setUp(root, fromEnv(root, "_WEB"));
  expect(named.changed).toEqual(["projectId"]);
  expect(config(root)).toContain("critiqs: {\n    projectId: process.env.NUXT_PUBLIC_CRITIQS_PROJECT_ID_WEB,\n    version: process.env.COMMIT_SHA\n  }");
  expect(nuxt.find(root)[0]?.projectId).toEqual({ kind: "env", variable: "NUXT_PUBLIC_CRITIQS_PROJECT_ID_WEB" });

  const bare = app();
  setUp(bare, literal());
  setUp(bare, fromEnv(bare));
  expect(config(bare)).toBe(CONFIG.replace("  devtools: { enabled: true }\n", "  devtools: { enabled: true },\n  modules: ['critiqs-nuxt']\n"));
  expect(config(bare).match(/critiqs-nuxt/g)).toHaveLength(1);
});

test("uses the config file the person chose", () => {
  const root = app({ "nuxt.config.js": "export default defineNuxtConfig({})\n" });
  const plan = setUp(root, literal(), "nuxt.config.js");
  expect(plan.file).toBe(join(root, "nuxt.config.js"));
  expect(config(root, "nuxt.config.js")).toBe(`export default defineNuxtConfig({ modules: ['critiqs-nuxt'], critiqs: { projectId: '${PROJECT}' } })\n`);
  expect(config(root)).toBe(CONFIG);
});

test("every config it writes still parses, even when the critiqs block goes as modules arrive", () => {
  expect(() => parse("export default defineNuxtConfig({,\n})")).toThrow();
  const lone = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  critiqs: { projectId: '${OTHER}' }\n})\n` });
  setUp(lone, fromEnv(lone));
  expect(config(lone)).toBe("export default defineNuxtConfig({\n  modules: ['critiqs-nuxt']\n})\n");

  const trailing = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  devtools: { enabled: true },\n  critiqs: { projectId: '${OTHER}' },\n})\n` });
  setUp(trailing, fromEnv(trailing));
  expect(config(trailing)).toBe("export default defineNuxtConfig({\n  devtools: { enabled: true },\n  modules: ['critiqs-nuxt'],\n})\n");
});

test("edits the real config, not one in a comment", () => {
  const source = `// Was: export default defineNuxtConfig({ ssr: false })\n/* defineNuxtConfig({ */\nexport default defineNuxtConfig({\n  devtools: { enabled: true }\n})\n`;
  const root = app({ "nuxt.config.ts": source });
  setUp(root, fromEnv(root));
  expect(config(root)).toBe(source.replace("  devtools: { enabled: true }\n", "  devtools: { enabled: true },\n  modules: ['critiqs-nuxt']\n"));
});

test("keeps comments in an empty config, and an explicit requireProjectId: true", () => {
  const commented = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  // Add modules here.\n})\n" });
  setUp(commented, fromEnv(commented));
  expect(config(commented)).toBe("export default defineNuxtConfig({\n  // Add modules here.\n  modules: ['critiqs-nuxt']\n})\n");

  const explicit = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: { projectId: '${OTHER}', requireProjectId: true },\n})\n` });
  expect(setUp(explicit, literal())).toMatchObject({ action: "update", changed: ["projectId"] });
  expect(config(explicit)).toContain(`critiqs: {\n    projectId: '${PROJECT}',\n    requireProjectId: true,\n  },`);
});

test("finds critiqs-nuxt given its options inline", () => {
  const root = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: [\n    ['critiqs-nuxt', { projectId: '${PROJECT}', backend: '${BACKEND}' }],\n  ],\n})\n` });
  expect(nuxt.find(root)).toEqual([{ file: join(root, "nuxt.config.ts"), line: 3, projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: BACKEND }, requireProjectId: true }]);
});

test("refuses, with instructions, what it can't edit safely", () => {
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: [['critiqs-nuxt', { projectId: 'x' }]],\n})\n" }, "expression", "options inline"],
    [{ "nuxt.config.ts": "const modules = ['@nuxt/ui']\nexport default defineNuxtConfig({\n  modules,\n})\n" }, "expression", "sets modules from code"],
    [{ "nuxt.config.ts": "export default defineNuxtConfig({\n  ...base,\n})\n" }, "unreadable", "Couldn't read"],
    [{ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: base.modules,\n})\n" }, "expression", "sets modules from code"],
    [{ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: { projectId: ids.web },\n})\n" }, "expression", "sets critiqs.projectId from code"],
    [{ "nuxt.config.ts": "export default defineNuxtConfig({\n  runtimeConfig: { public: { critiqs: { projectId: '' } } },\n})\n" }, "expression", "runtimeConfig.public.critiqs"],
    [{ "nuxt.config.ts": "export default createConfig()\n" }, "unreadable", "Couldn't read"],
    [{ "app/app.vue": APP_VUE.replace("  </div>", "    <Critiqs project-id=\"x\" />\n  </div>") }, "ambiguous", "app/app.vue:5"],
  ];
  for (const [files, reason, text] of cases) {
    const plan = nuxt.plan(app(files), literal(), { entry: null });
    if (plan.ok) throw new Error(`Expected a refusal for ${JSON.stringify(files)}`);
    expect(plan.reason).toBe(reason as typeof plan.reason);
    expect(plan.message).toContain(text);
    if (reason !== "ambiguous") expect(plan.message).toContain(`critiqs: { projectId: '${PROJECT}' }`);
  }
  const none = app();
  rmSync(join(none, "nuxt.config.ts"));
  expect(nuxt.plan(none, literal(), { entry: null })).toMatchObject({ ok: false, reason: "manual", message: expect.stringContaining("modules: ['critiqs-nuxt']") });
});

test("manual instructions name the package, the module, and the variable", () => {
  const root = app();
  const text = nuxt.manual(fromEnv(root));
  expect(text).toContain("npm install critiqs-nuxt");
  expect(text).toContain("modules: ['critiqs-nuxt'],");
  expect(text).toContain("NUXT_PUBLIC_CRITIQS_PROJECT_ID=<project ID> in .env");
  expect(nuxt.manual(literal(PROJECT, { backend: BACKEND }))).toContain(`critiqs: { projectId: '${PROJECT}', backend: '${BACKEND}' },`);
});

test("a trailing comment after the last property or module stays a comment: the separator goes after the code", () => {
  const property = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  devtools: { enabled: true } // keep this\n})\n" });
  setUp(property, fromEnv(property));
  expect(config(property)).toBe("export default defineNuxtConfig({\n  devtools: { enabled: true }, // keep this\n  modules: ['critiqs-nuxt']\n})\n");

  const moduleItem = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: [\n    '@nuxt/ui' // keep this\n  ]\n})\n" });
  setUp(moduleItem, fromEnv(moduleItem));
  expect(config(moduleItem)).toBe("export default defineNuxtConfig({\n  modules: [\n    '@nuxt/ui', // keep this\n    'critiqs-nuxt'\n  ]\n})\n");

  const afterComma = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  devtools: { enabled: true }, // keep this\n})\n" });
  setUp(afterComma, literal());
  expect(config(afterComma)).toBe(`export default defineNuxtConfig({\n  devtools: { enabled: true }, // keep this\n  modules: ['critiqs-nuxt'],\n  critiqs: { projectId: '${PROJECT}' },\n})\n`);

  // Comments in Critiqs's own block survive its rewrite.
  const block = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: {\n    // Staging\n    projectId: '${OTHER}', // old\n    version: process.env.COMMIT_SHA // keep this\n  }\n})\n` });
  setUp(block, literal(PROJECT, { backend: BACKEND }));
  expect(config(block)).toBe(`export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: {\n    // Staging\n    projectId: '${PROJECT}', // old\n    backend: '${BACKEND}',\n    version: process.env.COMMIT_SHA // keep this\n  }\n})\n`);
});

test("edits the default-exported config, not another defineNuxtConfig call or one in a string", () => {
  const other = app({ "nuxt.config.ts": "const example = defineNuxtConfig({})\n\nexport default defineNuxtConfig({\n  devtools: { enabled: true }\n})\n" });
  setUp(other, fromEnv(other));
  expect(config(other)).toBe("const example = defineNuxtConfig({})\n\nexport default defineNuxtConfig({\n  devtools: { enabled: true },\n  modules: ['critiqs-nuxt']\n})\n");

  const text = app({ "nuxt.config.ts": "const note = 'defineNuxtConfig({})'\n\nexport default defineNuxtConfig({\n  devtools: { enabled: true }\n})\n" });
  setUp(text, fromEnv(text));
  expect(config(text)).toBe("const note = 'defineNuxtConfig({})'\n\nexport default defineNuxtConfig({\n  devtools: { enabled: true },\n  modules: ['critiqs-nuxt']\n})\n");

  // A config named, then exported.
  const named = app({ "nuxt.config.ts": "const config = defineNuxtConfig({\n  devtools: { enabled: true }\n})\n\nexport default config\n" });
  setUp(named, fromEnv(named));
  expect(config(named)).toContain("  devtools: { enabled: true },\n  modules: ['critiqs-nuxt']\n})\n\nexport default config\n");
});

test("reads a module listed with a comment beside it, and refuses settings spread into critiqs", () => {
  const commented = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: ['critiqs-nuxt' /* review */],\n})\n" });
  expect(nuxt.find(commented)).toHaveLength(1);
  setUp(commented, fromEnv(commented));
  expect(config(commented).match(/critiqs-nuxt/g)).toHaveLength(1);

  const spread = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: { ...defaults, projectId: 'old' },\n})\n" });
  const plan = nuxt.plan(spread, literal(), { entry: null });
  if (plan.ok) throw new Error("Expected a refusal");
  expect(plan.reason).toBe("expression");
  expect(plan.message).toContain("nuxt.config.ts:3 spreads other settings into critiqs");
  expect(plan.message).toContain(`critiqs: { projectId: '${PROJECT}' }`);
});

test("every config it writes parses and settles, with comments wherever a person might put them", () => {
  // Each slot gets a line comment, a block comment, or nothing; every combination is set up both ways.
  const shapes = [
    (c: string[]) => `export default defineNuxtConfig({${c[0]}\n  devtools: { enabled: true }${c[1]}${c[2]}\n})\n`,
    (c: string[]) => `export default defineNuxtConfig({\n  modules: [${c[0]}\n    '@nuxt/ui'${c[1]}\n  ],${c[2]}\n})\n`,
    (c: string[]) => `export default defineNuxtConfig({\n  modules: ['critiqs-nuxt',${c[0]}\n  ],\n  critiqs: {${c[1]}\n    projectId: '${OTHER}'${c[2]}\n  }\n})\n`,
    (c: string[]) => `export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: { backend: '${BACKEND}',${c[0]}\n    version: 'v1'${c[1]}\n  }${c[2]}\n})\n`,
  ];
  const fills = ["", " // note", " /* note */"];
  let checked = 0;
  for (const shape of shapes) {
    for (const a of fills) for (const b of fills) for (const c of fills) {
      for (const settings of [(root: string) => fromEnv(root), () => literal(PROJECT, { backend: BACKEND })]) {
        const root = app({ "nuxt.config.ts": shape([a, b, c]) });
        setUp(root, settings(root));
        expect(config(root).match(/critiqs-nuxt/g)).toHaveLength(1);
        // A comment goes only with the critiqs block it's in, when the environment takes over; a removed setting's stays while the block does.
        const text = config(root);
        const kept = shape === shapes[2] && !text.includes("critiqs:") ? [a] : [a, b, c];
        expect(text.match(/note/g)?.length ?? 0).toBe(kept.filter(Boolean).length);
        checked++;
      }
    }
  }
  expect(checked).toBe(shapes.length * 27 * 2);
});

test("edits the real export, not a decoy in a regular expression, and reads past quotes and brackets inside one", () => {
  const decoy = app({ "nuxt.config.ts": "const example = /export default defineNuxtConfig({})/\n\nexport default defineNuxtConfig({\n  devtools: { enabled: true }\n})\n" });
  setUp(decoy, fromEnv(decoy));
  expect(config(decoy)).toBe("const example = /export default defineNuxtConfig({})/\n\nexport default defineNuxtConfig({\n  devtools: { enabled: true },\n  modules: ['critiqs-nuxt']\n})\n");

  const inside = app({ "nuxt.config.ts": "export default defineNuxtConfig({\n  vite: { define: { quote: /['\"{[]/.source } },\n  devtools: { enabled: true }\n})\n" });
  setUp(inside, literal());
  expect(config(inside)).toBe(`export default defineNuxtConfig({\n  vite: { define: { quote: /['"{[]/.source } },\n  devtools: { enabled: true },\n  modules: ['critiqs-nuxt'],\n  critiqs: { projectId: '${PROJECT}' }\n})\n`);
});

test("reads quoted keys, and refuses when runtimeConfig or a spread or import in modules could already hold Critiqs", () => {
  const quotedKeys = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  'modules': ['critiqs-nuxt'],\n  "critiqs": { 'projectId': '${OTHER}' },\n  runtimeConfig: { "public": { apiBase: '/api' } }\n})\n` });
  expect(setUp(quotedKeys, literal())).toMatchObject({ action: "update", changed: ["projectId"] });
  expect(config(quotedKeys).match(/critiqs-nuxt/g)).toHaveLength(1);
  expect(config(quotedKeys)).toContain(`critiqs: { projectId: '${PROJECT}' }`);

  const cases: Array<[string, string]> = [
    ["  runtimeConfig: { public: { 'critiqs': { projectId: 'old' } } },\n", "nuxt.config.ts:2 sets runtimeConfig.public.critiqs"],
    ["  runtimeConfig: { 'public': { \"critiqs\": { projectId: 'old' } } },\n", "nuxt.config.ts:2 sets runtimeConfig.public.critiqs"],
    ["  runtimeConfig: shared,\n", "nuxt.config.ts:2 sets runtimeConfig from code"],
    ["  runtimeConfig: { public: { ...shared } },\n", "nuxt.config.ts:2 sets runtimeConfig from code"],
    ["  modules: [...optionalModules],\n", "nuxt.config.ts:2 spreads other modules into modules"],
    ["  modules: ['@nuxt/ui', ...extra],\n", "nuxt.config.ts:2 spreads other modules into modules"],
    ["  modules: [isDev ? 'critiqs-nuxt' : '@nuxt/ui'],\n", "nuxt.config.ts:2 sets modules from code"],
  ];
  for (const [entry, text] of cases) {
    const plan = nuxt.plan(app({ "nuxt.config.ts": `export default defineNuxtConfig({\n${entry}})\n` }), literal(), { entry: null });
    if (plan.ok) throw new Error(`Expected a refusal for ${entry}`);
    expect(plan.reason).toBe("expression");
    expect(plan.message).toContain(text);
    expect(plan.message).toContain(`critiqs: { projectId: '${PROJECT}' }`);
  }
  const imported = nuxt.plan(app({ "nuxt.config.ts": "import critiqs from 'critiqs-nuxt'\n\nexport default defineNuxtConfig({\n  modules: [critiqs],\n})\n" }), literal(), { entry: null });
  expect(imported).toMatchObject({ ok: false, reason: "expression", message: expect.stringContaining("nuxt.config.ts imports critiqs-nuxt") });
  // An import written in a comment or string is no import.
  const mentioned = app({ "nuxt.config.ts": "// import critiqs from 'critiqs-nuxt'\nconst note = \"import critiqs from 'critiqs-nuxt'\"\n\nexport default defineNuxtConfig({\n  modules: [],\n})\n" });
  expect(setUp(mentioned, fromEnv(mentioned))).toMatchObject({ action: "install" });
});

test("a removed setting's comment stays while the critiqs block does", () => {
  const root = app({ "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: {\n    // Staging until launch\n    projectId: '${OTHER}', // from the dashboard\n    version: 'v1'\n  }\n})\n` });
  setUp(root, fromEnv(root));
  expect(config(root)).toBe("export default defineNuxtConfig({\n  modules: ['critiqs-nuxt'],\n  critiqs: {\n    // Staging until launch\n    // from the dashboard\n    version: 'v1'\n  }\n})\n");
});
