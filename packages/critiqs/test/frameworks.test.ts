import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-framework-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

test("every adapter has a unique id", () => {
  const ids = FRAMEWORKS.map((adapter) => adapter.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test.each([
  ["next", { "package.json": pkg({ next: "16", react: "19", "react-dom": "19" }) }],
  ["react", { "package.json": pkg({ react: "19", "react-dom": "19", vite: "7" }) }],
  ["nuxt", { "package.json": pkg({ nuxt: "4", vue: "3" }) }],
  ["vue", { "package.json": pkg({ vue: "3" }) }],
  ["sveltekit", { "package.json": pkg({ "@sveltejs/kit": "2", svelte: "5" }) }],
  ["svelte", { "package.json": pkg({ svelte: "5" }) }],
  ["angular", { "package.json": pkg({ "@angular/core": "21" }) }],
  ["astro", { "package.json": pkg({ astro: "5" }) }],
  ["solid", { "package.json": pkg({ "solid-js": "1" }) }],
  ["rails", { Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 8.1"\n' }],
  ["django", { "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'site.settings')\nfrom django.core.management import execute_from_command_line\n" }],
  ["flask", { "requirements.txt": "Flask==3.1\n" }],
] as const)("detects %s apps", (id, files) => {
  expect(detectApp(app(files))?.id).toBe(id);
});

test("an app setup doesn't recognize has no framework", () => {
  expect(detectApp(app({ "README.md": "hello" }))).toBeNull();
});
