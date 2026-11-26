// When more than one setup adapter could connect an app, setup uses the one
// whose plan can: a Nuxt app's existing <Critiqs> from critiqs-vue is updated
// by the Vue adapter rather than refused by Nuxt's, and an --entry that names
// a React root in an Astro app goes to the React adapter. The fake Vue, Nuxt
// and Astro adapters mirror what the real ones (on their framework branches)
// do in these cases; the React and Next.js adapters are the real ones.
import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { next } from "../bin/frameworks/next.mjs";
import { react } from "../bin/frameworks/react.mjs";
import type { FrameworkAdapter, Plan, Settings, Usage } from "../bin/frameworks/types.d.mts";

const OLD = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const NEW = "k57a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";

const depends = (root: string, name: string) => {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return name in { ...manifest.dependencies, ...manifest.devDependencies };
  } catch {
    return false;
  }
};
const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;
const idOf = (settings: Settings) => ("literal" in settings.projectId ? settings.projectId.literal : "");

/** Every .vue file under `root`, outside node_modules and dot folders. */
function vueFiles(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name.startsWith(".") || entry.name === "node_modules" ? [] : vueFiles(root, join(dir, entry.name))) : entry.name.endsWith(".vue") ? [join(dir, entry.name)] : [],
  );
}

/** Vue, as the real adapter: finds <Critiqs> from critiqs-vue in any .vue file, updates the one there, and refuses an --entry elsewhere. */
const vue: FrameworkAdapter = {
  id: "vue",
  name: "Vue",
  install: { ecosystem: "npm", packages: ["critiqs-vue"] },
  detect: (root) => depends(root, "vue"),
  env: () => null,
  find(root): Usage[] {
    return vueFiles(root).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const at = source.indexOf("<Critiqs");
      if (!source.includes("critiqs-vue") || at < 0) return [];
      const id = /<Critiqs project-id="([^"]*)"/.exec(source)?.[1];
      return [{ file, line: lineOf(source, at), projectId: id === undefined ? null : { kind: "literal", value: id }, backend: null, requireProjectId: false }];
    });
  },
  plan(root, settings, options): Plan {
    const usages = vue.find(root);
    const file = resolve(root, options.entry ?? "src/App.vue");
    const [usage] = usages;
    if (usage === undefined || usages.length > 1) return { ok: false, reason: "manual", message: vue.manual(settings) };
    if (options.entry !== null && usage.file !== file) {
      return { ok: false, reason: "ambiguous", message: `Critiqs is already in ${relative(root, usage.file)}:${usage.line}, not ${options.entry}, so nothing was changed. Run setup without an entry to update it there, or move it yourself.` };
    }
    const original = readFileSync(usage.file, "utf8");
    const source = original.replace(/<Critiqs project-id="[^"]*"/, `<Critiqs project-id="${idOf(settings)}"`);
    const action = source === original ? "unchanged" : "update";
    return { ok: true, action, writes: action === "unchanged" ? [] : [{ file: usage.file, original, source }], file: usage.file, line: usage.line, changed: action === "unchanged" ? [] : ["projectId"], preview: "", next: [] };
  },
  manual: (settings) => `Add <Critiqs project-id="${idOf(settings)}" /> from critiqs-vue to the root component.`,
};

/** Nuxt, as the real adapter: sees the Vue components too, and refuses to add its module beside them (nuxt.mjs plan). */
const nuxt: FrameworkAdapter = {
  id: "nuxt",
  name: "Nuxt",
  install: { ecosystem: "npm", packages: ["critiqs-nuxt"] },
  detect: (root) => depends(root, "nuxt"),
  env: (_root, suffix) => ({
    variable: `NUXT_PUBLIC_CRITIQS_PROJECT_ID${suffix}`,
    expression: "useRuntimeConfig().public.critiqs.projectId",
    readsAt: "runtime",
    localFile: ".env",
    deploymentAdvice: "Set it where each deployment's server runs.",
  }),
  find: (root) => vue.find(root),
  plan(root, settings): Plan {
    const components = vue.find(root);
    if (components.length > 0) {
      return {
        ok: false,
        reason: "ambiguous",
        message: `This app already adds Critiqs with <Critiqs> from critiqs-vue (${components.map((u) => `${relative(root, u.file)}:${u.line}`).join(", ")}), so nothing was changed. Remove it to use critiqs-nuxt instead, then run setup again.`,
      };
    }
    return { ok: false, reason: "manual", message: nuxt.manual(settings) };
  },
  manual: (settings) => `Add critiqs-nuxt to modules in nuxt.config.ts with projectId ${idOf(settings)}.`,
};

/** Astro, as the real adapter: an --entry names the config file to edit, and a file that isn't an Astro config is refused. */
const astro: FrameworkAdapter = {
  id: "astro",
  name: "Astro",
  install: { ecosystem: "npm", packages: ["critiqs-astro"] },
  detect: (root) => depends(root, "astro"),
  env: () => null,
  find: () => [],
  plan(root, settings, options): Plan {
    const file = resolve(root, options.entry ?? "astro.config.mjs");
    if (!existsSync(file)) return { ok: false, reason: "unreadable", message: `${options.entry} doesn't exist in this app.` };
    const original = readFileSync(file, "utf8");
    if (!original.includes("integrations: [")) return { ok: false, reason: "unreadable", message: `Setup can't edit ${file} safely: it has no Astro configuration.\n${astro.manual(settings)}` };
    const source = original.replace('import { defineConfig } from "astro/config";\n', 'import { defineConfig } from "astro/config";\nimport critiqs from "critiqs-astro";\n').replace("integrations: [", `integrations: [critiqs({ projectId: "${idOf(settings)}" }), `);
    return { ok: true, action: "install", writes: [{ file, original, source }], file, line: 1, changed: ["projectId"], preview: "", next: [] };
  },
  manual: (settings) => `Add critiqs({ projectId: "${idOf(settings)}" }) from critiqs-astro to integrations in astro.config.mjs.`,
};

/** Every .svelte file under `root`'s src. */
const svelteFiles = (root: string, dir = join(root, "src")): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? svelteFiles(root, join(dir, entry.name)) : entry.name.endsWith(".svelte") ? [join(dir, entry.name)] : []))
    : [];
const KIT_LAYOUT = "src/routes/+layout.svelte";
const KIT_VARIABLE = "PUBLIC_CRITIQS_PROJECT_ID";

/**
 * Svelte and SvelteKit, as the real adapters: both read <Critiqs /> from
 * critiqs-svelte (or its /kit module) in any .svelte file and install the same
 * package; SvelteKit reads a variable declared in src/env.ts, plain Svelte
 * Vite's `import.meta.env`, so each sees the other's variable as code.
 */
function svelteFamily(read: (text: string) => Usage["projectId"]) {
  return (root: string): Usage[] =>
    svelteFiles(root).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const at = source.indexOf("<Critiqs");
      if (!/from ['"]critiqs-svelte(\/kit)?['"]/.test(source) || at < 0) return [];
      const text = /<Critiqs projectId=\{([^}]*)\}/.exec(source)?.[1];
      return [{ file, line: lineOf(source, at), projectId: text === undefined ? null : read(text), backend: null, requireProjectId: source.includes("requireProjectId") }];
    });
}
/** Writes `projectId={code} requireProjectId` on the one <Critiqs />, or adds it to `entry` (default: the root layout). */
function planSvelte(root: string, code: string, options: { entry: string | null }, module: string): Plan {
  const [usage] = svelteFamily(() => null)(root);
  const file = usage?.file ?? resolve(root, options.entry ?? KIT_LAYOUT);
  const original = readFileSync(file, "utf8");
  const tag = `<Critiqs projectId={${code}} requireProjectId />`;
  const source =
    usage === undefined
      ? original.replace("<script>\n", `<script>\n\timport { Critiqs } from '${module}';\n`).replace("{@render", `${tag}\n{@render`)
      : original.replace(/<Critiqs [^>]*\/>/, tag);
  const action = source === original ? "unchanged" : usage === undefined ? "install" : "update";
  return { ok: true, action, writes: action === "unchanged" ? [] : [{ file, original, source }], file, line: 1, changed: action === "unchanged" ? [] : ["projectId"], preview: tag, next: [] };
}
const sveltekit: FrameworkAdapter = {
  id: "sveltekit",
  name: "SvelteKit",
  install: { ecosystem: "npm", packages: ["critiqs-svelte"] },
  detect: (root) => depends(root, "@sveltejs/kit"),
  env: (_root, suffix) => ({ variable: `${KIT_VARIABLE}${suffix}`, expression: `${KIT_VARIABLE}${suffix}`, readsAt: "runtime", localFile: ".env.local", deploymentAdvice: "Set it where each deployment runs." }),
  find: svelteFamily((text) => (text.startsWith("PUBLIC_") ? { kind: "env", variable: text } : { kind: "expression", text })),
  plan(root, settings, options): Plan {
    if (!("env" in settings.projectId)) return { ok: false, reason: "manual", message: sveltekit.manual(settings) };
    const { variable } = settings.projectId.env;
    // SvelteKit 3 reads only variables src/env.ts declares; one that isn't public never reaches the browser.
    const declared = existsSync(join(root, "src/env.ts")) ? readFileSync(join(root, "src/env.ts"), "utf8") : "";
    if (declared.includes(`${variable}: {`) && !declared.includes("public: true")) {
      return { ok: false, reason: "manual", message: `src/env.ts declares ${variable}, but not as public: true, so the browser can't read it and setup didn't change it. Make it public and optional.` };
    }
    return planSvelte(root, variable, options, "critiqs-svelte/kit");
  },
  manual: () => "Add <Critiqs /> from critiqs-svelte/kit to src/routes/+layout.svelte.",
};
const svelte: FrameworkAdapter = {
  id: "svelte",
  name: "Svelte",
  install: { ecosystem: "npm", packages: ["critiqs-svelte"] },
  detect: (root) => depends(root, "svelte"),
  env: (root, suffix) =>
    depends(root, "vite") ? { variable: `VITE_CRITIQS_PROJECT_ID${suffix}`, expression: `import.meta.env.VITE_CRITIQS_PROJECT_ID${suffix}`, readsAt: "build", localFile: ".env.local", deploymentAdvice: "Set it in each build." } : null,
  find: svelteFamily((text) => (text.startsWith("import.meta.env.") ? { kind: "env", variable: text.slice("import.meta.env.".length) } : { kind: "expression", text })),
  plan: (root, settings, options) => ("env" in settings.projectId ? planSvelte(root, settings.projectId.env.expression, options, "critiqs-svelte") : { ok: false, reason: "manual", message: svelte.manual(settings) }),
  manual: () => "Add <Critiqs /> from critiqs-svelte to src/App.svelte.",
};

// Detection order as in the real registry: meta-frameworks before the libraries they build on.
const FRAMEWORKS = [next, nuxt, sveltekit, astro, react, vue, svelte];
mock.module("../bin/frameworks/index.mjs", () => ({
  FRAMEWORKS,
  detectApp: (root: string) => FRAMEWORKS.find((adapter) => adapter.detect(root)) ?? null,
}));
const { runInit } = await import("../bin/init.mjs");
const { chooseWiring } = await import("../bin/app.mjs");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder with these files; a `.git` folder makes it a repository root. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-select-"));
  folders.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const init = (root: string, ...args: string[]) => {
  const lines: string[] = [];
  const code = runInit(["init", ...args], { cwd: root, print: (line) => void lines.push(line), env: {} });
  return { code, output: lines.join("\n") };
};

const appVue = (id: string) => `<script setup lang="ts">\nimport { Critiqs } from "critiqs-vue";\n</script>\n\n<template>\n  <div>\n    <NuxtRouteAnnouncer />\n    <NuxtWelcome />\n    <Critiqs project-id="${id}" />\n  </div>\n</template>\n`;
const NUXT_CONFIG = `// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  compatibilityDate: "2026-11-01",\n  devtools: { enabled: true },\n});\n`;
/** A Nuxt app as `npm create nuxt` makes it, whose app.vue renders Critiqs from critiqs-vue; no critiqs-nuxt module. */
const nuxtWithVue = () =>
  tree({
    "package.json": JSON.stringify({ name: "shop", private: true, type: "module", dependencies: { nuxt: "^4.4.0", vue: "^3.6.0", "vue-router": "^4.6.0", "critiqs-vue": "0.3.0" } }),
    "nuxt.config.ts": NUXT_CONFIG,
    "app/app.vue": appVue(OLD),
  });

test("a Nuxt app's <Critiqs> from critiqs-vue is updated by the Vue adapter, not refused by Nuxt's", () => {
  const root = nuxtWithVue();
  expect(chooseWiring(root).adapter.id).toBe("vue");
  const { code, output } = init(root, NEW);
  expect(code).toBe(0);
  expect(output).toBe("Set the project ID in app/app.vue:9.");
  expect(read(root, "app/app.vue")).toBe(appVue(NEW));
  expect(read(root, "nuxt.config.ts")).toBe(NUXT_CONFIG);
  expect(init(root, NEW)).toEqual({ code: 0, output: "app/app.vue:9 already uses this project ID." });
});

test("when no adapter's plan can connect the app, the app's framework's refusal is the one shown", () => {
  const root = nuxtWithVue();
  mkdirSync(join(root, "app/pages"));
  writeFileSync(join(root, "app/pages/index.vue"), appVue(OLD));
  const { code, output } = init(root, NEW);
  expect(code).toBe(1);
  expect(output).toMatch(/^This app already adds Critiqs with <Critiqs> from critiqs-vue \(app\/(app\.vue|pages\/index\.vue):9, app\/(app\.vue|pages\/index\.vue):9\), so nothing was changed\. Remove it to use critiqs-nuxt instead/);
  expect(read(root, "app/app.vue")).toBe(appVue(OLD));
});

test("a stale --entry doesn't stop a non-React adapter from updating the setup the code has", () => {
  const root = nuxtWithVue();
  const { code } = init(root, NEW, "--entry", "app/old-app.vue");
  expect(code).toBe(0);
  expect(read(root, "app/app.vue")).toBe(appVue(NEW));
  // An entry that exists still says where Critiqs should be, so no adapter moves it there.
  writeFileSync(join(root, "app/other.vue"), "<template><div /></template>\n");
  expect(init(root, OLD, "--entry", "app/other.vue")).toMatchObject({ code: 1, output: expect.stringContaining("so nothing was changed") });
  expect(read(root, "app/app.vue")).toBe(appVue(NEW));
});

const MAIN = `import { createRoot } from "react-dom/client";\nimport App from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`;
const ASTRO_CONFIG = `import { defineConfig } from "astro/config";\nimport react from "@astrojs/react";\n\nexport default defineConfig({\n  integrations: [react()],\n});\n`;
/** An Astro app with the React integration that also renders a React root of its own from src/main.tsx. */
const astroWithReactRoot = () =>
  tree({
    "package.json": JSON.stringify({ name: "site", type: "module", dependencies: { astro: "^6.0.0", "@astrojs/react": "^5.0.0", react: "^19.3.0", "react-dom": "^19.3.0" } }),
    "astro.config.mjs": ASTRO_CONFIG,
    "src/main.tsx": MAIN,
    "src/App.tsx": "export default function App() {\n  return <h1>Site</h1>;\n}\n",
  });

test("an --entry that renders a React root goes to the React adapter in an Astro app", () => {
  const root = astroWithReactRoot();
  expect(chooseWiring(root, { entry: "src/main.tsx" }).adapter.id).toBe("react");
  const { code, output } = init(root, NEW, "--entry", "src/main.tsx");
  expect(code).toBe(0);
  expect(output).toStartWith("Added Critiqs to src/main.tsx:5:");
  expect(read(root, "src/main.tsx")).toContain(`<Critiqs projectId="${NEW}" />`);
  expect(read(root, "astro.config.mjs")).toBe(ASTRO_CONFIG);
});

test("in the same Astro app, no --entry or an Astro config --entry still goes to Astro", () => {
  for (const args of [[], ["--entry", "astro.config.mjs"]]) {
    const root = astroWithReactRoot();
    expect(chooseWiring(root, { entry: args[1] ?? null }).adapter.id).toBe("astro");
    expect(init(root, NEW, ...args).code).toBe(0);
    expect(read(root, "astro.config.mjs")).toContain(`critiqs({ projectId: "${NEW}" })`);
    expect(read(root, "src/main.tsx")).toBe(MAIN);
  }
  // An entry no adapter can use gets the app's framework's refusal.
  const root = astroWithReactRoot();
  writeFileSync(join(root, "src/util.ts"), "export const x = 1;\n");
  expect(init(root, NEW, "--entry", "src/util.ts")).toMatchObject({ code: 1, output: expect.stringContaining("Setup can't edit") });
});

// A refusal from the adapter that owns the integration stands: another
// adapter that installs the same package would wire it with settings the
// app's framework doesn't read.

const KIT_LAYOUT_SOURCE = `<script>\n\timport { Critiqs } from 'critiqs-svelte/kit';\n\timport { ${KIT_VARIABLE} } from '$app/env/public';\n\tlet { children } = $props();\n</script>\n\n<Critiqs projectId={${KIT_VARIABLE}} requireProjectId />\n{@render children()}\n`;
const PRIVATE_ENV = `import { defineEnvVars } from '@sveltejs/kit/env';\n\nexport const variables = defineEnvVars({\n\t${KIT_VARIABLE}: {\n\t\tpublic: false,\n\t\tschema: (value) => value\n\t}\n});\n`;
/** A SvelteKit 3 app as `sv create` makes it, whose src/env.ts keeps the project ID variable private. */
const kitApp = (layout: string) =>
  tree({
    "package.json": JSON.stringify({ name: "kit", private: true, type: "module", devDependencies: { "@sveltejs/kit": "^3.0.0", svelte: "^5.40.0", vite: "^8.0.0", "critiqs-svelte": "0.3.0" } }),
    "svelte.config.js": "export default {};\n",
    "src/env.ts": PRIVATE_ENV,
    [KIT_LAYOUT]: layout,
  });

test("SvelteKit's refusal of its own <Critiqs /> stands: plain Svelte doesn't rewire it to a VITE_ variable", () => {
  const root = kitApp(KIT_LAYOUT_SOURCE);
  const { code, output } = init(root, NEW);
  expect(code).toBe(1);
  expect(output).toStartWith(`src/env.ts declares ${KIT_VARIABLE}, but not as public: true`);
  expect(read(root, KIT_LAYOUT)).toBe(KIT_LAYOUT_SOURCE);
  expect(existsSync(join(root, ".env.local"))).toBe(false);
});

test("SvelteKit's refusal of an --entry stands when the app has no Critiqs yet", () => {
  const layout = "<script>\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n";
  const root = kitApp(layout);
  const { code, output } = init(root, NEW, "--entry", KIT_LAYOUT);
  expect(code).toBe(1);
  expect(output).toStartWith(`src/env.ts declares ${KIT_VARIABLE}, but not as public: true`);
  expect(read(root, KIT_LAYOUT)).toBe(layout);
  expect(existsSync(join(root, ".env.local"))).toBe(false);
});

test("a Next.js app that lists Vite keeps Next.js's refusal of a VITE_ variable, as critiqs-react 0.3.0 did", () => {
  const layout = `import { Critiqs } from "critiqs-react";\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Critiqs projectId={import.meta.env.VITE_REVIEW} requireProjectId />\n      </body>\n    </html>\n  );\n}\n`;
  const root = tree({
    "package.json": JSON.stringify({ name: "web", dependencies: { next: "^16.0.0", react: "^19.3.0", "react-dom": "^19.3.0", "critiqs-react": "0.3.0" }, devDependencies: { vite: "^8.0.0" } }),
    "app/layout.tsx": layout,
  });
  const { code, output } = init(root, NEW);
  expect(code).toBe(1);
  expect(output).toStartWith("app/layout.tsx:8 sets projectId from code, so nothing was changed. Set it to: {process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID}");
  expect(read(root, "app/layout.tsx")).toBe(layout);
  expect(existsSync(join(root, ".env.local"))).toBe(false);
});

test("a Nuxt app whose manifest doesn't list vue still has its critiqs-vue <Critiqs> updated by the Vue adapter", () => {
  const root = nuxtWithVue();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop", private: true, type: "module", dependencies: { nuxt: "^4.4.0", "critiqs-vue": "0.3.0" } }));
  expect(chooseWiring(root).adapter.id).toBe("vue");
  const { code, output } = init(root, NEW);
  expect(code).toBe(0);
  expect(output).toBe("Set the project ID in app/app.vue:9.");
  expect(read(root, "app/app.vue")).toBe(appVue(NEW));
});
