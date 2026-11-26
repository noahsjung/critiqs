// An adapter whose convention writes Vite's .env.local without listing the
// files Vite loads (as the Vue and Svelte adapters do) still gets every one of
// them, in Vite's order: setup writes the file whose value Vite uses, reads
// the value Vite uses, and stops at a file it can't read. The fake adapters
// mirror the real ones on their framework branches.
import { afterEach, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EnvConvention, FrameworkAdapter, Plan, Settings, Usage } from "../bin/frameworks/types.d.mts";

const OLD = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const NEW = "k57a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";
const APP = "src/App.vue";

const depends = (root: string, name: string) => {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return name in { ...manifest.dependencies, ...manifest.devDependencies };
  } catch {
    return false;
  }
};
const expressionOf = (settings: Settings) => ("env" in settings.projectId ? settings.projectId.env.expression : JSON.stringify(settings.projectId.literal));

/** An adapter that reads and writes `<Critiqs :project-id="…" require-project-id />` from `pkg` in src/App.vue. */
function componentAdapter(id: "vue" | "nuxt", name: string, pkg: string, env: FrameworkAdapter["env"], prefix: string): FrameworkAdapter {
  const adapter: FrameworkAdapter = {
    id,
    name,
    install: { ecosystem: "npm", packages: [pkg] },
    detect: (root) => depends(root, id),
    env,
    find(root): Usage[] {
      const file = join(root, APP);
      const source = existsSync(file) ? readFileSync(file, "utf8") : "";
      const at = source.indexOf("<Critiqs");
      if (!source.includes(pkg) || at < 0) return [];
      const text = /:project-id="([^"]*)"/.exec(source)?.[1];
      const variable = text?.startsWith(prefix) ? text.slice(prefix.length) : null;
      return [{ file, line: source.slice(0, at).split("\n").length, projectId: variable === null ? null : { kind: "env", variable }, backend: null, requireProjectId: true }];
    },
    plan(root, settings): Plan {
      const file = join(root, APP);
      const original = readFileSync(file, "utf8");
      const tag = `<Critiqs :project-id="${expressionOf(settings)}" require-project-id />`;
      const source = original.includes("<Critiqs")
        ? original.replace(/<Critiqs [^>]*\/>/, tag)
        : original.replace("<script setup>\n", `<script setup>\nimport { Critiqs } from "${pkg}";\n`).replace("</template>", `  ${tag}\n</template>`);
      const action = source === original ? "unchanged" : original.includes("<Critiqs") ? "update" : "install";
      return { ok: true, action, writes: action === "unchanged" ? [] : [{ file, original, source }], file, line: source.slice(0, source.indexOf("<Critiqs")).split("\n").length, changed: action === "unchanged" ? [] : ["projectId"], preview: tag, next: [] };
    },
    manual: (settings) => `Add <Critiqs :project-id="${expressionOf(settings)}" require-project-id /> from ${pkg} to ${APP}.`,
  };
  return adapter;
}

/** Vue, as the real adapter: Vite's VITE_ variable, written to .env.local, with no `loads`. */
const vue = componentAdapter(
  "vue",
  "Vue",
  "critiqs-vue",
  (root, suffix): EnvConvention | null =>
    depends(root, "vite")
      ? { variable: `VITE_CRITIQS_PROJECT_ID${suffix}`, expression: `import.meta.env.VITE_CRITIQS_PROJECT_ID${suffix}`, readsAt: "build", localFile: ".env.local", deploymentAdvice: "Set it in each deployment's build settings." }
      : null,
  "import.meta.env.",
);
/** A framework whose server loads only `.env` (as Nuxt does), even when the app also lists Vite. */
const nuxt = componentAdapter(
  "nuxt",
  "Nuxt",
  "critiqs-nuxt",
  (_root, suffix) => ({ variable: `NUXT_PUBLIC_CRITIQS_PROJECT_ID${suffix}`, expression: `$config.public.critiqs${suffix}`, readsAt: "runtime", localFile: ".env", deploymentAdvice: "Set it where each deployment's server runs." }),
  "$config.public.",
);

const FRAMEWORKS = [nuxt, vue];
mock.module("../bin/frameworks/index.mjs", () => ({
  FRAMEWORKS,
  detectApp: (root: string) => FRAMEWORKS.find((adapter) => adapter.detect(root)) ?? null,
}));
const { runInit } = await import("../bin/init.mjs");
const { chooseWiring, envTargetOf, readLocalValue } = await import("../bin/app.mjs");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const APP_SOURCE = `<script setup>\nimport HelloWorld from "./components/HelloWorld.vue";\n</script>\n\n<template>\n  <HelloWorld msg="You did it!" />\n</template>\n`;
/** A Vue app as `npm create vue` makes it, with these .env files; `.git` makes it a repository root. */
function vueApp(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-vite-env-"));
  folders.push(root);
  mkdirSync(join(root, ".git"));
  const all = {
    "package.json": JSON.stringify({ name: "shop", private: true, type: "module", dependencies: { vue: "^3.6.0" }, devDependencies: { vite: "^8.0.0", "@vitejs/plugin-vue": "^6.0.0" } }),
    ".gitignore": "node_modules\ndist\n*.local\n",
    [APP]: APP_SOURCE,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
/** The app's wiring, which reads its project ID from a variable. */
const envWiring = (root: string) => {
  const wiring = chooseWiring(root);
  if (wiring.mode !== "env") throw new Error("expected an environment-backed wiring");
  return wiring;
};
const init = (root: string, ...args: string[]) => {
  const lines: string[] = [];
  const code = runInit(["init", ...args], { cwd: root, print: (line) => void lines.push(line), env: {} });
  return { code, output: lines.join("\n") };
};

test("Vite's files are the ones setup reads, in Vite's order, for a convention that names only .env.local", () => {
  const wiring = chooseWiring(vueApp());
  expect(wiring.mode === "env" && wiring.env.loads).toEqual([".env.development.local", ".env.development", ".env.local", ".env"]);
  const root = vueApp({ ".env.local": `VITE_CRITIQS_PROJECT_ID=${OLD}\n`, ".env.development": `VITE_CRITIQS_PROJECT_ID=${NEW}\n` });
  // Vite gives .env.development precedence over .env.local.
  expect(readLocalValue(envWiring(root))).toEqual({ value: NEW, file: join(root, ".env.development") });
});

test("an ID already in .env.development.local is replaced there, not hidden behind a new one in .env.local", () => {
  const root = vueApp({ ".env.development.local": `VITE_CRITIQS_PROJECT_ID=${OLD}\n` });
  const { code, output } = init(root, NEW);
  expect(code).toBe(0);
  expect(output).toContain(`Set VITE_CRITIQS_PROJECT_ID=${NEW} in .env.development.local for this computer.`);
  expect(read(root, ".env.development.local")).toBe(`VITE_CRITIQS_PROJECT_ID=${NEW}\n`);
  expect(existsSync(join(root, ".env.local"))).toBe(false);
  const again = init(root, NEW);
  expect(again.code).toBe(0);
  expect(again.output).toStartWith("src/App.vue:8 already uses this project ID (VITE_CRITIQS_PROJECT_ID in .env.development.local).");
});

test("an ID in a shared .env.development, which Vite reads before .env.local, is overridden from .env.development.local", () => {
  const root = vueApp({ ".env.development": `VITE_CRITIQS_PROJECT_ID=${OLD}\n` });
  expect(envTargetOf(chooseWiring(root))?.local).toBe(join(root, ".env.development.local"));
  expect(init(root, NEW).code).toBe(0);
  expect(read(root, ".env.development.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${NEW}\n`);
  expect(read(root, ".env.development")).toBe(`VITE_CRITIQS_PROJECT_ID=${OLD}\n`);
  expect(existsSync(join(root, ".env.local"))).toBe(false);
  expect(readLocalValue(envWiring(root))).toEqual({ value: NEW, file: join(root, ".env.development.local") });
});

test("an unreadable .env file Vite loads first stops setup, naming it; nothing is written", () => {
  const root = vueApp({ ".env.development": `VITE_CRITIQS_PROJECT_ID=${OLD}\n` });
  chmodSync(join(root, ".env.development"), 0o000);
  try {
    const { code, output } = init(root, NEW);
    expect(code).toBe(1);
    expect(output).toStartWith("Couldn't read .env.development, a .env file this app loads, so nothing was changed");
    expect(read(root, APP)).toBe(APP_SOURCE);
    expect(existsSync(join(root, ".env.local"))).toBe(false);
    expect(existsSync(join(root, ".env.development.local"))).toBe(false);
  } finally {
    chmodSync(join(root, ".env.development"), 0o644);
  }
});

test("a convention that writes .env, as a server that loads only .env does, keeps its own file even when the app lists Vite", () => {
  const root = vueApp();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop", private: true, dependencies: { nuxt: "^4.4.0", vue: "^3.6.0" }, devDependencies: { vite: "^8.0.0" } }));
  writeFileSync(join(root, ".env.local"), `NUXT_PUBLIC_CRITIQS_PROJECT_ID=${OLD}\n`);
  const wiring = chooseWiring(root);
  expect(wiring.adapter.id).toBe("nuxt");
  expect(envTargetOf(wiring)).toMatchObject({ files: [join(root, ".env")], local: join(root, ".env") });
});
