// SvelteKit setup against apps shaped like `npx sv create --template minimal --types ts`.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";
import type { Plan, Settings } from "../bin/frameworks/types.d.mts";

const sveltekit = FRAMEWORKS.find((adapter) => adapter.id === "sveltekit")!;

// The app's own Svelte compiler reads its components; fixtures link the workspace's copy.
const SVELTE = join(import.meta.dir, "../../svelte/node_modules/svelte");
const PROJECT = "j12345678901234567890123456789012";

function app(files: Record<string, string | null>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-sveltekit-"));
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(SVELTE, join(root, "node_modules/svelte"));
  return root;
}

function apply(plan: Plan) {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  for (const write of plan.writes) {
    mkdirSync(dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.source);
  }
  return plan;
}

const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");

const LAYOUT = "<script lang=\"ts\">\n\timport favicon from '#lib/assets/favicon.svg';\n\timport type { LayoutProps } from './$types';\n\n\tlet { children }: LayoutProps = $props();\n</script>\n\n<svelte:head>\n\t<link rel=\"icon\" href={favicon} />\n</svelte:head>\n\n{@render children()}\n";

// What `sv create --template minimal --types ts` generates for SvelteKit 3, trimmed to the parts setup reads.
const KIT3 = {
  "package.json": JSON.stringify({
    name: "kit-ts",
    private: true,
    type: "module",
    scripts: { dev: "vite dev", build: "vite build", preview: "vite preview" },
    devDependencies: { "@sveltejs/adapter-auto": "^8.0.1", "@sveltejs/kit": "^3.2.0", "@sveltejs/vite-plugin-svelte": "^7.3.1", svelte: "^5.57.3", typescript: "^6.0.3", vite: "^8.3.8" },
  }),
  "tsconfig.json": '{\n\t"extends": "$app/tsconfig",\n\t"compilerOptions": {\n\t\t"strict": true\n\t},\n\t"include": ["src", "vite.config.ts"]\n}\n',
  "vite.config.ts": "import adapter from '@sveltejs/adapter-auto';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n\tplugins: [\n\t\tsveltekit({\n\t\t\tadapter: adapter()\n\t\t})\n\t]\n});\n",
  "src/app.html": '<!doctype html>\n<html lang="en">\n\t<head>\n\t\t%sveltekit.head%\n\t</head>\n\t<body data-sveltekit-preload-data="hover">\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n',
  "src/routes/+layout.svelte": LAYOUT,
  "src/routes/+page.svelte": '<h1>Welcome to SvelteKit</h1>\n<p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation</p>\n',
};

// SvelteKit 2's starter: config in svelte.config.js, the same layout.
const KIT2 = {
  ...KIT3,
  "package.json": JSON.stringify({ name: "kit2", private: true, type: "module", devDependencies: { "@sveltejs/adapter-auto": "^7.0.0", "@sveltejs/kit": "^2.70.0", svelte: "^5.57.3", vite: "^7.3.0" } }),
  "svelte.config.js": "import adapter from '@sveltejs/adapter-auto';\n\n/** @type {import('@sveltejs/kit').Config} */\nconst config = {\n\tkit: {\n\t\tadapter: adapter()\n\t}\n};\n\nexport default config;\n",
  "vite.config.ts": "import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n\tplugins: [sveltekit()]\n});\n",
};

const ENV_MODULE =
  "import { defineEnvVars } from '@sveltejs/kit/env';\n\nexport const variables = defineEnvVars({\n\tPUBLIC_CRITIQS_PROJECT_ID: {\n\t\tpublic: true,\n\t\t// Optional, so a deployment without it builds and shows no Critiqs.\n\t\tschema: (value) => value,\n\t\tdescription: 'The Critiqs project for this deployment. Critiqs stays hidden where it is unset.'\n\t}\n});\n";

const fromEnv = (root: string): Settings => ({ projectId: { env: sveltekit.env(root, "")! }, requireProjectId: true });
const literal: Settings = { projectId: { literal: PROJECT }, requireProjectId: false };
const noEntry = { entry: null };

describe("detect and env", () => {
  test("an sv create app is SvelteKit, not Svelte", () => {
    expect(detectApp(app(KIT3))?.id).toBe("sveltekit");
  });

  test("SvelteKit 3 reads PUBLIC_CRITIQS_PROJECT_ID from $app/env/public when the app runs", () => {
    expect(sveltekit.env(app(KIT3), "")).toMatchObject({ variable: "PUBLIC_CRITIQS_PROJECT_ID", expression: "PUBLIC_CRITIQS_PROJECT_ID", readsAt: "runtime", localFile: ".env.local" });
    expect(sveltekit.env(app(KIT3), "_DOCS")?.variable).toBe("PUBLIC_CRITIQS_PROJECT_ID_DOCS");
  });

  test("SvelteKit 2 reads it from $env/dynamic/public in the browser, unless explicit environment variables are on", () => {
    expect(sveltekit.env(app(KIT2), "")?.expression).toBe("browser ? env.PUBLIC_CRITIQS_PROJECT_ID : undefined");
    const explicit = app({ ...KIT2, "svelte.config.js": "export default { kit: { experimental: { explicitEnvironmentVariables: true } } };\n" });
    expect(sveltekit.env(explicit, "")?.expression).toBe("PUBLIC_CRITIQS_PROJECT_ID");
  });

  test("has no convention when the config moves the env folder or changes the public prefix", () => {
    expect(sveltekit.env(app({ ...KIT2, "svelte.config.js": "export default { kit: { env: { publicPrefix: 'APP_' } } };\n" }), "")).toBeNull();
    expect(sveltekit.env(app({ ...KIT3, "vite.config.ts": "export default { plugins: [sveltekit({ env: { dir: '../..' } })] };\n" }), "")).toBeNull();
  });
});

describe("plan", () => {
  test("SvelteKit 3: adds Critiqs to the root layout and declares the variable in src/env.ts; a second run changes nothing", () => {
    const root = app(KIT3);
    const plan = apply(sveltekit.plan(root, fromEnv(root), noEntry));
    expect(plan).toMatchObject({ action: "install", changed: ["projectId", "requireProjectId"], file: join(root, "src/routes/+layout.svelte"), line: 15 });
    expect(read(root, "src/routes/+layout.svelte")).toBe(
      "<script lang=\"ts\">\n\timport favicon from '#lib/assets/favicon.svg';\n\timport type { LayoutProps } from './$types';\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\timport { PUBLIC_CRITIQS_PROJECT_ID } from '$app/env/public';\n\n\tlet { children }: LayoutProps = $props();\n</script>\n\n<svelte:head>\n\t<link rel=\"icon\" href={favicon} />\n</svelte:head>\n\n{@render children()}\n<Critiqs projectId={PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />\n",
    );
    expect(read(root, "src/env.ts")).toBe(ENV_MODULE);
    expect(sveltekit.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: true, action: "unchanged", writes: [] });
    expect(sveltekit.find(root)).toEqual([
      { file: join(root, "src/routes/+layout.svelte"), line: 15, projectId: { kind: "env", variable: "PUBLIC_CRITIQS_PROJECT_ID" }, backend: null, requireProjectId: true },
    ]);
  });

  test("a written project ID needs no env file", () => {
    const root = app(KIT3);
    const plan = apply(sveltekit.plan(root, literal, noEntry));
    expect(plan.ok && plan.writes.map((write) => write.file)).toEqual([join(root, "src/routes/+layout.svelte")]);
    expect(read(root, "src/routes/+layout.svelte")).toEndWith(`{@render children()}\n<Critiqs projectId="${PROJECT}" />\n`);
    expect(existsSync(join(root, "src/env.ts"))).toBe(false);
  });

  test("adds the declaration to an existing src/env.ts in its own style", () => {
    const withComma = "import { defineEnvVars } from \"@sveltejs/kit/env\";\n\nexport const variables = defineEnvVars({\n  API_URL: {\n    public: false,\n  },\n});\n";
    const root = app({ ...KIT3, "src/env.ts": withComma });
    apply(sveltekit.plan(root, fromEnv(root), noEntry));
    expect(read(root, "src/env.ts")).toBe(
      'import { defineEnvVars } from "@sveltejs/kit/env";\n\nexport const variables = defineEnvVars({\n  API_URL: {\n    public: false,\n  },\n  PUBLIC_CRITIQS_PROJECT_ID: {\n    public: true,\n    // Optional, so a deployment without it builds and shows no Critiqs.\n    schema: (value) => value,\n    description: "The Critiqs project for this deployment. Critiqs stays hidden where it is unset."\n  },\n});\n',
    );
    expect(sveltekit.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: true, action: "unchanged" });

    const withoutComma = app({ ...KIT3, "src/env.js": "import { defineEnvVars } from '@sveltejs/kit/env';\n\nexport const variables = defineEnvVars({\n\tPORT: { schema: (v) => v }\n});\n" });
    apply(sveltekit.plan(withoutComma, fromEnv(withoutComma), noEntry));
    expect(read(withoutComma, "src/env.js")).toStartWith("import { defineEnvVars } from '@sveltejs/kit/env';\n\nexport const variables = defineEnvVars({\n\tPORT: { schema: (v) => v },\n\tPUBLIC_CRITIQS_PROJECT_ID: {\n\t\tpublic: true,\n");
    expect(existsSync(join(withoutComma, "src/env.ts"))).toBe(false);
  });

  test("src/env.ts: only a literal key declares the variable, and a spread after it refuses", () => {
    const declared = (text: string) => app({ ...KIT3, "src/env.ts": text });
    // A computed key names whatever its constant holds, so setup adds the declaration it wants.
    const computed = declared(
      "import { defineEnvVars } from '@sveltejs/kit/env';\n\nconst PUBLIC_CRITIQS_PROJECT_ID = 'PUBLIC_OTHER';\n\nexport const variables = defineEnvVars({\n\t[PUBLIC_CRITIQS_PROJECT_ID]: { public: true }\n});\n",
    );
    apply(sveltekit.plan(computed, fromEnv(computed), noEntry));
    expect(read(computed, "src/env.ts")).toContain("\t[PUBLIC_CRITIQS_PROJECT_ID]: { public: true },\n\tPUBLIC_CRITIQS_PROJECT_ID: {\n\t\tpublic: true,\n");
    expect(sveltekit.plan(computed, fromEnv(computed), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
    const quoted = declared("import { defineEnvVars } from '@sveltejs/kit/env';\nexport const variables = defineEnvVars({ 'PUBLIC_CRITIQS_PROJECT_ID': { 'public': true } });\n");
    expect(sveltekit.plan(quoted, fromEnv(quoted), noEntry)).toMatchObject({ ok: true, writes: [{ file: join(quoted, "src/routes/+layout.svelte") }] });

    // A spread after the declaration could replace it.
    const spread = declared("import { defineEnvVars } from '@sveltejs/kit/env';\nimport { shared } from './shared';\nexport const variables = defineEnvVars({ PUBLIC_CRITIQS_PROJECT_ID: { public: true }, ...shared });\n");
    const refused = sveltekit.plan(spread, fromEnv(spread), noEntry);
    expect(refused).toMatchObject({ ok: false, reason: "expression" });
    if (!refused.ok) expect(refused.message).toContain("PUBLIC_CRITIQS_PROJECT_ID: {");
    // One before it can't.
    const before = declared("import { defineEnvVars } from '@sveltejs/kit/env';\nimport { shared } from './shared';\nexport const variables = defineEnvVars({ ...shared, PUBLIC_CRITIQS_PROJECT_ID: { public: true } });\n");
    expect(sveltekit.plan(before, fromEnv(before), noEntry)).toMatchObject({ ok: true });
  });

  test("src/env.ts: a computed key or spread that could make the declaration private refuses", () => {
    const declared = (entries: string) =>
      app({ ...KIT3, "src/env.ts": `import { defineEnvVars } from '@sveltejs/kit/env';\nimport { settings } from './settings';\nconst name = 'PUBLIC_CRITIQS_PROJECT_ID';\nexport const variables = defineEnvVars({ ${entries} });\n` });
    for (const entries of [
      // A computed key after the declaration can name the same variable and replace it.
      "PUBLIC_CRITIQS_PROJECT_ID: { public: true }, [name]: { public: false }",
      // A spread or computed key inside it can turn public off.
      "PUBLIC_CRITIQS_PROJECT_ID: { public: true, ...settings }",
      "PUBLIC_CRITIQS_PROJECT_ID: { public: true, [name]: false }",
    ]) {
      const root = declared(entries);
      const refused = sveltekit.plan(root, fromEnv(root), noEntry);
      expect(refused, entries).toMatchObject({ ok: false, reason: "expression" });
      if (!refused.ok) expect(refused.message).toContain("PUBLIC_CRITIQS_PROJECT_ID: {");
    }
    // The last `public` is the one that counts.
    const overridden = declared("PUBLIC_CRITIQS_PROJECT_ID: { public: true, public: false }");
    expect(sveltekit.plan(overridden, fromEnv(overridden), noEntry)).toMatchObject({ ok: false, reason: "manual" });
    // Computed keys and spreads before the declaration, or before its own `public`, can't.
    const before = declared("[name]: { public: false }, ...settings, PUBLIC_CRITIQS_PROJECT_ID: { ...settings, public: true }");
    expect(sveltekit.plan(before, fromEnv(before), noEntry)).toMatchObject({ ok: true });
  });

  test("src/env.ts: keeps comments in an empty defineEnvVars, and Windows line endings", () => {
    const commented = app({ ...KIT3, "src/env.ts": "import { defineEnvVars } from '@sveltejs/kit/env';\n\nexport const variables = defineEnvVars({\n\t// Declare variables here.\n});\n" });
    apply(sveltekit.plan(commented, fromEnv(commented), noEntry));
    const text = read(commented, "src/env.ts");
    expect(text).toContain("\t// Declare variables here.\n");
    expect(text).toContain("\tPUBLIC_CRITIQS_PROJECT_ID: {\n\t\tpublic: true,\n");
    expect(sveltekit.plan(commented, fromEnv(commented), noEntry)).toMatchObject({ ok: true, action: "unchanged" });

    const crlf = app({
      ...KIT3,
      "src/routes/+layout.svelte": LAYOUT.replaceAll("\n", "\r\n"),
      "src/env.ts": "import { defineEnvVars } from '@sveltejs/kit/env';\r\n\r\nexport const variables = defineEnvVars({\r\n\tAPI_URL: { public: false }\r\n});\r\n",
    });
    apply(sveltekit.plan(crlf, fromEnv(crlf), noEntry));
    for (const name of ["src/env.ts", "src/routes/+layout.svelte"]) {
      const edited = read(crlf, name);
      expect(edited).toContain("PUBLIC_CRITIQS_PROJECT_ID");
      expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
    }
    expect(sveltekit.plan(crlf, fromEnv(crlf), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("leaves a public declaration alone, and refuses one the browser can't read or a file it can't follow", () => {
    const declared = (text: string) => app({ ...KIT3, "src/env.ts": text });
    const publicOne = declared("import { defineEnvVars } from '@sveltejs/kit/env';\nexport const variables = defineEnvVars({ PUBLIC_CRITIQS_PROJECT_ID: { public: true, static: true } });\n");
    const plan = sveltekit.plan(publicOne, fromEnv(publicOne), noEntry);
    expect(plan.ok && plan.writes.map((write) => write.file)).toEqual([join(publicOne, "src/routes/+layout.svelte")]);

    const privateOne = declared("import { defineEnvVars } from '@sveltejs/kit/env';\nexport const variables = defineEnvVars({ PUBLIC_CRITIQS_PROJECT_ID: {} });\n");
    expect(sveltekit.plan(privateOne, fromEnv(privateOne), noEntry)).toMatchObject({ ok: false, reason: "manual" });
    const computed = declared("import { all } from './vars';\nexport const variables = all;\n");
    const refused = sveltekit.plan(computed, fromEnv(computed), noEntry);
    expect(refused).toMatchObject({ ok: false, reason: "manual" });
    if (!refused.ok) expect(refused.message).toContain("PUBLIC_CRITIQS_PROJECT_ID: {");
  });

  test("SvelteKit 2: reads the variable from $env/dynamic/public only in the browser, so prerendering builds; reuses existing imports", () => {
    const root = app(KIT2);
    apply(sveltekit.plan(root, fromEnv(root), noEntry));
    const layout = read(root, "src/routes/+layout.svelte");
    expect(layout).toContain("\timport { env } from '$env/dynamic/public';\n\timport { browser } from '$app/environment';\n");
    expect(layout).toContain("<Critiqs projectId={browser ? env.PUBLIC_CRITIQS_PROJECT_ID : undefined} requireProjectId />");
    expect(existsSync(join(root, "src/env.ts"))).toBe(false);
    expect(sveltekit.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
    expect(sveltekit.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "PUBLIC_CRITIQS_PROJECT_ID" }, requireProjectId: true }]);

    const aliased = app({
      ...KIT2,
      "src/routes/+layout.svelte": LAYOUT.replace("\timport type", "\timport { env as publicEnv } from '$env/dynamic/public';\n\timport { browser as inBrowser } from '$app/environment';\n\timport type"),
    });
    apply(sveltekit.plan(aliased, fromEnv(aliased), noEntry));
    const edited = read(aliased, "src/routes/+layout.svelte");
    expect(edited).toContain("<Critiqs projectId={inBrowser ? publicEnv.PUBLIC_CRITIQS_PROJECT_ID : undefined} requireProjectId />");
    expect(edited.match(/\$env\/dynamic\/public/g)).toHaveLength(1);
    expect(edited.match(/\$app\/environment/g)).toHaveLength(1);
  });

  test("SvelteKit 2: a project ID read from $env/dynamic/public during server rendering is moved into the browser", () => {
    // SvelteKit 2 fails a prerendered page that reads $env/dynamic/public while it renders.
    const root = app({
      ...KIT2,
      "src/routes/+layout.svelte": "<script>\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\timport { env } from '$env/dynamic/public';\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n<Critiqs projectId={env.PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />\n",
    });
    const plan = apply(sveltekit.plan(root, fromEnv(root), noEntry));
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"] });
    expect(read(root, "src/routes/+layout.svelte")).toBe(
      "<script>\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\timport { env } from '$env/dynamic/public';\n\timport { browser } from '$app/environment';\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n<Critiqs projectId={browser ? env.PUBLIC_CRITIQS_PROJECT_ID : undefined} requireProjectId />\n",
    );
    expect(sveltekit.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("a type-only import is no value: setup imports the variable itself", () => {
    for (const typeImport of ["import type { PUBLIC_CRITIQS_PROJECT_ID as projectId } from '$app/env/public';", "import { type PUBLIC_CRITIQS_PROJECT_ID as projectId } from '$app/env/public';"]) {
      const root = app({ ...KIT3, "src/routes/+layout.svelte": LAYOUT.replace("\timport type", `\t${typeImport}\n\timport type`) });
      apply(sveltekit.plan(root, fromEnv(root), noEntry));
      const layout = read(root, "src/routes/+layout.svelte");
      expect(layout).toContain("\timport { PUBLIC_CRITIQS_PROJECT_ID } from '$app/env/public';\n");
      expect(layout).toContain("<Critiqs projectId={PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />");
      expect(sveltekit.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
    }
    const kit2 = app({ ...KIT2, "src/routes/+layout.svelte": LAYOUT.replace("\timport type", "\timport type { env as publicEnv } from '$env/dynamic/public';\n\timport type") });
    apply(sveltekit.plan(kit2, fromEnv(kit2), noEntry));
    expect(read(kit2, "src/routes/+layout.svelte")).toContain("<Critiqs projectId={browser ? env.PUBLIC_CRITIQS_PROJECT_ID : undefined} requireProjectId />");
    // Found as code, not as the variable: Svelte erases the import.
    const found = app({
      ...KIT3,
      "src/routes/+layout.svelte": "<script lang=\"ts\">\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\timport type { PUBLIC_CRITIQS_PROJECT_ID as id } from '$app/env/public';\n</script>\n\n<Critiqs projectId={id} requireProjectId />\n",
    });
    expect(sveltekit.find(found)).toMatchObject([{ projectId: { kind: "expression", text: "id" } }]);
  });

  test("reads a project ID from $env/static/public as the environment", () => {
    const root = app({
      ...KIT2,
      "src/routes/+layout.svelte": "<script>\n\timport { Critiqs } from 'critiqs-svelte';\n\timport { PUBLIC_CRITIQS_PROJECT_ID as id } from '$env/static/public';\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n<Critiqs projectId={id} requireProjectId />\n",
    });
    expect(sveltekit.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "PUBLIC_CRITIQS_PROJECT_ID" }, requireProjectId: true }]);
  });

  test("creates the root layout, like sv create's, when the app has none", () => {
    const root = app({ ...KIT3, "src/routes/+layout.svelte": null });
    const plan = apply(sveltekit.plan(root, literal, noEntry));
    expect(plan.ok && plan.writes[0]?.original).toBeNull();
    expect(read(root, "src/routes/+layout.svelte")).toBe(
      `<script lang="ts">\n\timport type { LayoutProps } from './$types';\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\n\tlet { children }: LayoutProps = $props();\n</script>\n\n{@render children()}\n<Critiqs projectId="${PROJECT}" />\n`,
    );
    expect(sveltekit.plan(root, literal, noEntry)).toMatchObject({ ok: true, action: "unchanged" });

    const js = app({ ...KIT3, "tsconfig.json": null, "jsconfig.json": "{}\n", "src/routes/+layout.svelte": null });
    apply(sveltekit.plan(js, fromEnv(js), noEntry));
    expect(read(js, "src/routes/+layout.svelte")).toBe(
      "<script>\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\timport { PUBLIC_CRITIQS_PROJECT_ID } from '$app/env/public';\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n<Critiqs projectId={PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />\n",
    );
    expect(read(js, "src/env.js")).toBe(ENV_MODULE);
  });

  test("refuses, with instructions, an app without src/routes", () => {
    const root = app({ "package.json": KIT3["package.json"] });
    const plan = sveltekit.plan(root, fromEnv(root), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    if (!plan.ok) {
      expect(plan.message).toContain("src/routes/+layout.svelte");
      expect(plan.message).toContain("import { PUBLIC_CRITIQS_PROJECT_ID } from '$app/env/public';");
      expect(plan.message).toContain("defineEnvVars");
    }
  });

  test("refuses when the variable's name already means something else in the layout", () => {
    const root = app({ ...KIT3, "src/routes/+layout.svelte": LAYOUT.replace("\tlet { children }", "\tconst PUBLIC_CRITIQS_PROJECT_ID = 'x';\n\tlet { children }") });
    expect(sveltekit.plan(root, fromEnv(root), noEntry)).toMatchObject({ ok: false, reason: "manual" });
  });

  test("imports critiqs-svelte/kit, with SvelteKit's router, from SvelteKit 2.26; older apps get the component without it", () => {
    const recent = app(KIT2);
    apply(sveltekit.plan(recent, literal, noEntry));
    expect(read(recent, "src/routes/+layout.svelte")).toContain("\timport { Critiqs } from 'critiqs-svelte/kit';\n");
    const old = app({ ...KIT2, "package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "~2.20.0", svelte: "^5.0.0" } }) });
    apply(sveltekit.plan(old, literal, noEntry));
    expect(read(old, "src/routes/+layout.svelte")).toContain("\timport { Critiqs } from 'critiqs-svelte';\n");
    expect(sveltekit.plan(old, literal, noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("instructions name the module this SvelteKit can use: critiqs-svelte before 2.26", () => {
    const old = app({ "package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "~2.20.0", svelte: "^5.0.0" } }) });
    const plan = sveltekit.plan(old, fromEnv(old), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    if (!plan.ok) {
      expect(plan.message).toContain("import { Critiqs } from 'critiqs-svelte';");
      expect(plan.message).not.toContain("critiqs-svelte/kit");
      expect(plan.message).toContain("import { browser } from '$app/environment';");
      expect(plan.message).toContain("<Critiqs projectId={browser ? env.PUBLIC_CRITIQS_PROJECT_ID : undefined} requireProjectId />");
    }
  });

  test("reads the installed SvelteKit's version from an app given by a relative path", () => {
    const root = app({ ...KIT2, "package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.5.0", svelte: "^5.0.0" } }) });
    mkdirSync(join(root, "node_modules/@sveltejs/kit"), { recursive: true });
    writeFileSync(join(root, "node_modules/@sveltejs/kit/package.json"), JSON.stringify({ name: "@sveltejs/kit", version: "2.30.0" }));
    apply(sveltekit.plan(relative(process.cwd(), root), literal, noEntry));
    expect(read(root, "src/routes/+layout.svelte")).toContain("\timport { Critiqs } from 'critiqs-svelte/kit';\n");
  });

  test("honours a chosen entry", () => {
    const root = app({ ...KIT3, "src/routes/(app)/+layout.svelte": "<script>\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n" });
    const plan = sveltekit.plan(root, literal, { entry: "src/routes/(app)/+layout.svelte" });
    expect(plan).toMatchObject({ ok: true, file: join(root, "src/routes/(app)/+layout.svelte") });
  });
});

test("manual instructions write a backend Svelte would read as code as a JavaScript string", () => {
  const text = sveltekit.manual({ ...literal, backend: "https://own.example/critiqs?team=a&b={c}" });
  expect(text).toContain(`<Critiqs projectId="${PROJECT}" backend={"https://own.example/critiqs?team=a&b={c}"} />`);
});
