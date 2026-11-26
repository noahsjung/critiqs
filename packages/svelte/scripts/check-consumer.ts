// Real apps from the official starters, installed from the packed packages and
// set up by Critiqs's own setup adapters:
// - a Svelte app from `create-vite --template svelte-ts`, built and served by `vite preview`;
// - a SvelteKit app from `sv create` with adapter-node, built and served by `node build`,
//   with a prerendered page and an /items/[id] route beside its server-rendered one,
//   and a page checking what critiqs-svelte/kit's restore relies on: SvelteKit's
//   preloadData rejects a path that is none of the app's routes;
// - a SvelteKit 2.25 app from that time's `sv create`, fully prerendered with adapter-static
//   (SvelteKit 2 fails a prerendered page that reads $env/dynamic/public while rendering).
// Each is set up first with a written project ID, then switched to the
// environment variable: a build with it unset must add no Critiqs, and one
// with it set must show the toolbar. A second plan must change nothing.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chrome, expectToolbar, fakeBackend, PROJECT, packedDependencies, run, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import type { FrameworkAdapter, Plan, Settings } from "../../critiqs/bin/frameworks/types.d.mts";

const CREATE_VITE = "create-vite@9.3.4";
const SV = "sv@1.7.1";
// The `sv create` of July 2025, when SvelteKit 2.25 was current.
const SV_KIT2 = "sv@0.8.19";
const KIT2 = "2.25.1";

const adapter = (id: string): FrameworkAdapter => FRAMEWORKS.find((candidate) => candidate.id === id)!;
const dir = await scratch("svelte");
const packed = await packedDependencies(dir, { "critiqs-svelte": "packages/svelte" });
const backend = fakeBackend();
const servers: Bun.Subprocess[] = [];

/** Adds the packed packages to a starter's package.json and installs everything. */
async function install(app: string) {
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  manifest.dependencies = { ...manifest.dependencies, ...packed.dependencies };
  manifest.overrides = { ...manifest.overrides, ...packed.overrides };
  writeFileSync(join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await run(["npm", "install", "--no-audit", "--no-fund"], app);
}

/** Plans with the adapter, writes the plan, and checks that planning again changes nothing. */
function setUp(id: string, app: string, settings: Settings, action: "install" | "update"): Plan & { ok: true } {
  const plan = adapter(id).plan(app, settings, { entry: null });
  if (!plan.ok) throw new Error(`${id} setup refused (${plan.reason}): ${plan.message}`);
  assert.equal(plan.action, action);
  for (const write of plan.writes) {
    mkdirSync(dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.source);
  }
  const again = adapter(id).plan(app, settings, { entry: null });
  assert.ok(again.ok && again.action === "unchanged", `${id}: a second plan should change nothing, got ${JSON.stringify(again)}`);
  return plan;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

/** Starts a server in the background and waits until it answers. */
async function serve(command: string[], cwd: string, port: number, env: Record<string, string> = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  servers.push(child);
  const url = `http://localhost:${port}`;
  await waitForServer(url);
  return {
    url,
    stop: async () => {
      child.kill();
      await child.exited;
    },
  };
}

let playwright: Promise<{ chromium: { launch(options: object): Promise<any> } }> | null = null;

/** Chrome through Playwright, installed once in its own folder (with its own package.json, so npm doesn't climb to a parent). */
async function withPage<T>(use: (page: any, errors: string[]) => Promise<T>): Promise<T> {
  playwright ??= (async () => {
    const tools = await scratch("browser");
    writeFileSync(join(tools, "package.json"), JSON.stringify({ private: true }));
    await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], tools);
    return import(join(tools, "node_modules/playwright-core/index.mjs"));
  })();
  const { chromium } = await playwright;
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    return await use(page, errors);
  } finally {
    await browser.close();
  }
}

/** Opens `url` once the app has rendered `ready`, and asserts that Critiqs added nothing and the page had no errors. */
async function expectNoCritiqs(url: string, ready: string) {
  await withPage(async (page, errors) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(ready);
    await Bun.sleep(1500);
    assert.equal(await page.evaluate(() => document.querySelector("critiqs-root") === null), true, `${url} added Critiqs with no project ID`);
    assert.deepEqual(errors, []);
  });
}

/**
 * Opens `url`, waits for the toolbar, follows the link to `to` inside the app
 * (a client-side navigation: the page isn't reloaded), and asserts that there
 * is still exactly one Critiqs with its toolbar.
 */
async function expectOneCritiqsAfterNavigation(url: string, to: string, name: string) {
  await withPage(async (page, errors) => {
    const toolbar = () => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null;
    await page.goto(url);
    await page.waitForFunction(toolbar, null, { timeout: 20_000 });
    await page.evaluate(() => Object.assign(window, { notReloaded: true }));
    await page.click(`a[href="${to}"]`);
    await page.waitForURL(`**${to}`);
    await page.waitForSelector("h1:has-text('Item')");
    await page.waitForFunction(toolbar, null, { timeout: 20_000 });
    await Bun.sleep(500);
    assert.equal(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded), true, "the navigation reloaded the page");
    assert.equal(await page.evaluate(() => document.querySelectorAll("critiqs-root").length), 1);
    assert.deepEqual(errors, []);
    const evidence = process.env.CRITIQS_EVIDENCE_DIR;
    if (evidence !== undefined && evidence !== "") await page.screenshot({ path: join(evidence, `${name}.png`) });
  });
}

async function expectConfiguredToolbar(url: string, name: string) {
  const { toolbar, errors } = await expectToolbar(url, name);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(toolbar, /Set up Critiqs/);
  return toolbar;
}

/** Checks that setup names the `.env` folder the app's own Vite reads, for configs that move its root or env folder. */
async function expectViteEnvDirs(vite: string) {
  const resolveConfig = pathToFileURL(join(vite, "node_modules/vite/dist/node/index.js")).href;
  const configs = ["", "envDir: '../shared'", "root: 'web'", "root: 'web', envDir: 'config'", "root: './web', envDir: '../shared'"];
  for (const [i, config] of configs.entries()) {
    const app = join(dir, `vite-env-${i}`);
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "vite.config.mjs"), `export default { ${config} };\n`);
    const localFile = adapter("svelte").env(app, "")?.localFile;
    assert.ok(typeof localFile === "string", `svelte setup has no env convention for { ${config} }`);
    const script = `const { resolveConfig } = await import(${JSON.stringify(resolveConfig)}); console.log((await resolveConfig({ logLevel: "silent" }, "build")).envDir);`;
    const envDir = (await run(["node", "--input-type=module", "-e", script], app)).trim();
    assert.equal(resolve(app, dirname(localFile)), envDir, `{ ${config} }: setup says ${localFile}, Vite reads ${envDir}`);
  }
}

const written: Settings = { projectId: { literal: PROJECT }, requireProjectId: true, backend: backend.url };
const fromEnv = (id: string, app: string): Settings => ({ projectId: { env: adapter(id).env(app, "")! }, requireProjectId: true, backend: backend.url });

try {
  // Svelte with Vite.
  await run(["npx", "-y", CREATE_VITE, "vite-app", "--template", "svelte-ts", "--no-interactive"], dir);
  const vite = join(dir, "vite-app");
  await install(vite);
  await expectViteEnvDirs(vite);
  setUp("svelte", vite, written, "install");
  await run(["npm", "run", "build"], vite);
  const vitePort = await freePort();
  let server = await serve([join(vite, "node_modules/.bin/vite"), "preview", "--port", String(vitePort), "--strictPort"], vite, vitePort);
  const viteToolbar = await expectConfiguredToolbar(server.url, "svelte-vite");
  await server.stop();

  const viteEnv = fromEnv("svelte", vite);
  assert.equal(viteEnv.projectId && "env" in viteEnv.projectId && viteEnv.projectId.env.variable, "VITE_CRITIQS_PROJECT_ID");
  setUp("svelte", vite, viteEnv, "update");
  await run(["npm", "run", "build"], vite, { ...process.env, VITE_CRITIQS_PROJECT_ID: "" });
  server = await serve([join(vite, "node_modules/.bin/vite"), "preview", "--port", String(vitePort), "--strictPort"], vite, vitePort);
  await expectNoCritiqs(server.url, "#app h1");
  await server.stop();
  await run(["npm", "run", "build"], vite, { ...process.env, VITE_CRITIQS_PROJECT_ID: PROJECT });
  server = await serve([join(vite, "node_modules/.bin/vite"), "preview", "--port", String(vitePort), "--strictPort"], vite, vitePort);
  await expectConfiguredToolbar(server.url, "svelte-vite-env");
  await server.stop();
  console.log(`Svelte (Vite): setup added Critiqs; toolbar ${JSON.stringify(viteToolbar)}; none without VITE_CRITIQS_PROJECT_ID; .env folders match Vite's resolveConfig.`);

  // SvelteKit with adapter-node, a server-rendered page and a prerendered one.
  await run(["npx", "-y", SV, "create", "kit-app", "--template", "minimal", "--types", "ts", "--add", "sveltekit-adapter=adapter:node", "--no-install"], dir);
  const kit = join(dir, "kit-app");
  mkdirSync(join(kit, "src/routes/about"), { recursive: true });
  writeFileSync(join(kit, "src/routes/about/+page.ts"), "export const prerender = true;\n");
  writeFileSync(join(kit, "src/routes/about/+page.svelte"), "<h1>About</h1>\n");
  mkdirSync(join(kit, "src/routes/items/[id]"), { recursive: true });
  writeFileSync(join(kit, "src/routes/items/[id]/+page.svelte"), "<script lang=\"ts\">\n\timport { page } from '$app/state';\n</script>\n\n<h1>Item {page.params.id}</h1>\n");
  writeFileSync(join(kit, "src/routes/+page.svelte"), `${readFileSync(join(kit, "src/routes/+page.svelte"), "utf8")}<a href="/items/42">Item 42</a>\n`);
  mkdirSync(join(kit, "src/routes/preload"), { recursive: true });
  writeFileSync(
    join(kit, "src/routes/preload/+page.svelte"),
    // In onMount: preloadData exists only in the browser, once SvelteKit's router has started.
    "<script lang=\"ts\">\n\timport { onMount } from 'svelte';\n\timport { preloadData } from '$app/navigation';\n\n\tlet text = $state('');\n\tconst outcome = (href: string) => Promise.resolve().then(() => preloadData(href)).then(() => 'loaded', () => 'rejected');\n\tonMount(async () => {\n\t\ttext = (await Promise.all([outcome('/user-details'), outcome('/items/7')])).join(' ');\n\t});\n</script>\n\n{#if text}<output>{text}</output>{/if}\n",
  );
  await install(kit);
  setUp("sveltekit", kit, written, "install");
  await run(["npm", "run", "build"], kit);
  const kitPort = await freePort();
  const start = (env: Record<string, string> = {}) => serve(["node", "build"], kit, kitPort, { PORT: String(kitPort), HOST: "127.0.0.1", ...env });
  server = await start();
  const ssrHtml = await (await fetch(server.url)).text();
  assert.doesNotMatch(ssrHtml, /critiqs-root/);
  const kitToolbar = await expectConfiguredToolbar(server.url, "sveltekit");
  await expectConfiguredToolbar(`${server.url}/about`, "sveltekit-prerendered");
  await server.stop();

  const kitEnv = fromEnv("sveltekit", kit);
  const plan = setUp("sveltekit", kit, kitEnv, "update");
  assert.deepEqual(plan.writes.map((write) => write.file.slice(kit.length + 1)).sort(), ["src/env.ts", "src/routes/+layout.svelte"]);
  // The starter's own type check passes with the declared variable.
  await run(["npm", "run", "check"], kit);
  const unset = { ...process.env };
  delete unset.PUBLIC_CRITIQS_PROJECT_ID;
  await run(["npm", "run", "build"], kit, unset);
  server = await start();
  await expectNoCritiqs(server.url, "h1");
  await expectNoCritiqs(`${server.url}/about`, "h1");
  await server.stop();
  // The same build, started with the variable: SvelteKit reads it when the server starts.
  server = await start({ PUBLIC_CRITIQS_PROJECT_ID: PROJECT });
  await expectConfiguredToolbar(server.url, "sveltekit-env");
  await expectConfiguredToolbar(`${server.url}/about`, "sveltekit-env-prerendered");
  // SvelteKit's router: after a client-side navigation to /items/42, still one Critiqs.
  await expectOneCritiqsAfterNavigation(server.url, "/items/42", "sveltekit-navigated");
  // restoreContext's route check: a screen such as `user-details` that is no route is refused before goto, a real route loads.
  await withPage(async (page, errors) => {
    await page.goto(`${server.url}/preload`);
    const shown = await page.waitForSelector("output", { timeout: 20_000 }).catch(async () => {
      throw new Error(`/preload showed no result: ${(await page.content()).slice(0, 2000)}`);
    });
    assert.equal(await shown.textContent(), "rejected loaded");
    assert.deepEqual(errors, []);
  });
  await server.stop();
  console.log(`SvelteKit: setup added Critiqs to the root layout; toolbar ${JSON.stringify(kitToolbar)} on server-rendered and prerendered pages; none without PUBLIC_CRITIQS_PROJECT_ID, then shown by the same build started with it, and still one after navigating to /items/42; preloadData rejects /user-details and loads /items/7.`);

  // SvelteKit 2, every page prerendered by adapter-static, the project ID from the environment.
  await run(["npx", "-y", SV_KIT2, "create", "kit2-app", "--template", "minimal", "--types", "ts", "--no-add-ons", "--no-install"], dir);
  const kit2 = join(dir, "kit2-app");
  const kit2Manifest = JSON.parse(readFileSync(join(kit2, "package.json"), "utf8"));
  delete kit2Manifest.devDependencies["@sveltejs/adapter-auto"];
  kit2Manifest.devDependencies["@sveltejs/adapter-static"] = "^3.0.8";
  kit2Manifest.devDependencies["@sveltejs/kit"] = KIT2;
  writeFileSync(join(kit2, "package.json"), `${JSON.stringify(kit2Manifest, null, "\t")}\n`);
  writeFileSync(join(kit2, "svelte.config.js"), readFileSync(join(kit2, "svelte.config.js"), "utf8").replace("@sveltejs/adapter-auto", "@sveltejs/adapter-static"));
  writeFileSync(join(kit2, "src/routes/+layout.ts"), "export const prerender = true;\n");
  await install(kit2);
  assert.equal(JSON.parse(readFileSync(join(kit2, "node_modules/@sveltejs/kit/package.json"), "utf8")).version, KIT2);
  const kit2Env = fromEnv("sveltekit", kit2);
  setUp("sveltekit", kit2, kit2Env, "install");
  const kit2Layout = readFileSync(join(kit2, "src/routes/+layout.svelte"), "utf8");
  assert.match(kit2Layout, /<Critiqs projectId=\{browser \? env\.PUBLIC_CRITIQS_PROJECT_ID : undefined\} requireProjectId /);
  await run(["npm", "run", "check"], kit2);
  const kit2Port = await freePort();
  const preview = () => serve([join(kit2, "node_modules/.bin/vite"), "preview", "--port", String(kit2Port), "--strictPort"], kit2, kit2Port);
  // Unset: the build succeeds and the static site shows no Critiqs.
  await run(["npm", "run", "build"], kit2, unset);
  assert.match(readFileSync(join(kit2, "build/index.html"), "utf8"), /Welcome to SvelteKit/);
  server = await preview();
  await expectNoCritiqs(server.url, "h1");
  await server.stop();
  // Set: the static site takes the value its build had.
  await run(["npm", "run", "build"], kit2, { ...unset, PUBLIC_CRITIQS_PROJECT_ID: PROJECT });
  assert.doesNotMatch(readFileSync(join(kit2, "build/index.html"), "utf8"), /critiqs-root/);
  server = await preview();
  const kit2Toolbar = await expectConfiguredToolbar(server.url, "sveltekit2-prerendered-env");
  await server.stop();
  console.log(`SvelteKit ${KIT2} (adapter-static, every page prerendered): setup read PUBLIC_CRITIQS_PROJECT_ID in the browser; built with it unset and showed no Critiqs; built with it set and showed the toolbar ${JSON.stringify(kit2Toolbar)}.`);
} finally {
  for (const child of servers) child.kill();
  backend.stop();
}
