// A real create-vue app (TypeScript, Vite, Vue Router) installed from the
// packed critiqs and critiqs-vue, with a second route, /items/:id. The Vue
// setup adapter adds <Critiqs> to App.vue, first with a project ID and the
// stand-in backend, then reading VITE_CRITIQS_PROJECT_ID. Each version is
// built for production (vue-tsc type-checks it) and served, and Chrome checks
// that the toolbar appears and stays the only one after a client-side
// navigation, and that a build without the variable adds nothing to the page
// and never downloads Critiqs.
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import type { Plan, Settings } from "../../critiqs/bin/frameworks/types.d.mts";
import { chrome, expectToolbar, fakeBackend, PROJECT, packedDependencies, run, scratch } from "../../../scripts/consumer-kit.ts";

const vue = FRAMEWORKS.find((adapter) => adapter.id === "vue")!;
const dir = await scratch("vue");
await run(["npx", "-y", "create-vue@3.24.0", "--ts", "--router", "app"], dir);
const app = join(dir, "app");
/** Replaces `from` in one of the starter's files, failing if the starter changed. */
async function change(file: string, from: string, to: string) {
  const text = await Bun.file(join(app, file)).text();
  assert.ok(text.includes(from), `${file} no longer has ${JSON.stringify(from)}`);
  await Bun.write(join(app, file), text.replace(from, to));
}
await change("src/router/index.ts", "  ],\n})", "    {\n      path: '/items/:id',\n      name: 'item',\n      component: () => import('../views/ItemView.vue'),\n    },\n  ],\n})");
await Bun.write(join(app, "src/views/ItemView.vue"), '<template>\n  <h1 class="item">Item {{ $route.params.id }}</h1>\n</template>\n');
await change("src/App.vue", '<RouterLink to="/about">About</RouterLink>', '<RouterLink to="/about">About</RouterLink>\n        <RouterLink to="/items/42">Item 42</RouterLink>');
const manifest = await Bun.file(join(app, "package.json")).json();
const packed = await packedDependencies(dir, { "critiqs-vue": "packages/vue" });
Object.assign(manifest.dependencies, packed.dependencies);
manifest.overrides = packed.overrides;
await Bun.write(join(app, "package.json"), JSON.stringify(manifest, null, 2));
await run(["npm", "install", "--no-audit", "--no-fund"], app);
assert.equal(vue.detect(app), true);

/** Plans, writes the plan as the CLI would, and checks that planning again changes nothing. */
async function setUp(settings: Settings): Promise<Plan & { ok: true }> {
  const plan = vue.plan(app, settings, { entry: null });
  if (!plan.ok) throw new Error(`The Vue adapter refused: ${plan.message}`);
  for (const write of plan.writes) await Bun.write(write.file, write.source);
  const again = vue.plan(app, settings, { entry: null });
  assert.ok(again.ok && again.action === "unchanged", "planning again changes nothing");
  return plan;
}

/** Builds the app for production and serves dist/ as a single-page app; returns its address and what it served. */
async function buildAndServe(env: Record<string, string | undefined> = {}) {
  await rm(join(app, "dist"), { recursive: true, force: true });
  await run(["npm", "run", "build"], app, { ...process.env, ...env });
  const served: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      served.push(path);
      const file = Bun.file(join(app, "dist", path));
      return path !== "/" && (await file.exists()) ? new Response(file) : new Response(Bun.file(join(app, "dist/index.html")));
    },
  });
  return { url: `http://localhost:${server.port}/`, served, stop: () => server.stop(true) };
}

const backend = fakeBackend();
try {
  // 1. A project ID written into the component, with the stand-in backend.
  const installed = await setUp({ projectId: { literal: PROJECT }, requireProjectId: true, backend: backend.url });
  assert.equal(installed.action, "install");
  console.log(`Vue: setup added to ${installed.file}:\n${installed.preview}`);
  const configured = await buildAndServe();
  try {
    const { toolbar, errors } = await expectToolbar(configured.url, "vue-configured");
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    console.log(`Vue: toolbar appears in the production build (${JSON.stringify(toolbar)}).`);
    const navigated = await navigate(configured.url, "/items/42", "vue-route");
    assert.deepEqual(navigated, { errors: [], hosts: 1, heading: "Item 42", toolbar: true });
    console.log(`Vue: after a client-side navigation to /items/42, there is still exactly one critiqs-root with its toolbar.`);
  } finally {
    configured.stop();
  }

  // 2. The project ID read from VITE_CRITIQS_PROJECT_ID; built without it, then with it in .env.local.
  const env = vue.env(app, "")!;
  const wired = await setUp({ projectId: { env }, requireProjectId: true, backend: backend.url });
  assert.equal(wired.action, "update");
  const unset = await buildAndServe({ [env.variable]: undefined });
  try {
    const page = await openWithoutCritiqs(unset.url);
    assert.deepEqual(page.errors, []);
    assert.equal(page.critiqsRoot, false);
    assert.ok(page.appText.length > 0, "the app itself renders");
    const chunks = (await readdir(join(app, "dist/assets"))).filter((name) => name.endsWith(".js"));
    assert.ok(chunks.length >= 2, "Critiqs is a separate chunk");
    assert.equal(unset.served.filter((path) => path.endsWith(".js")).length, 1, "only the app's own chunk is downloaded");
    console.log(`Vue: built without ${env.variable}, the page renders (${JSON.stringify(page.appText.slice(0, 40))}…) with no critiqs-root and downloads 1 of ${chunks.length} chunks.`);
  } finally {
    unset.stop();
  }
  await Bun.write(join(app, env.localFile!), `${env.variable}=${PROJECT}\n`);
  const fromEnv = await buildAndServe({ [env.variable]: undefined });
  try {
    const { toolbar, errors } = await expectToolbar(fromEnv.url, "vue-env");
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    console.log(`Vue: with ${env.variable} in ${env.localFile}, the toolbar appears (${JSON.stringify(toolbar)}).`);
  } finally {
    fromEnv.stop();
  }
} finally {
  backend.stop();
}

/** Chrome through Playwright, installed in its own folder as the consumer kit does. */
async function launch() {
  const tools = await scratch("browser");
  await Bun.write(join(tools, "package.json"), JSON.stringify({ private: true }));
  await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], tools);
  const { chromium } = await import(join(tools, "node_modules/playwright-core/index.mjs"));
  return chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
}

/** Opens `url`, waits for Critiqs's toolbar, follows the app's link to `path`, and counts Critiqs's roots on the new route. */
async function navigate(url: string, path: string, name: string) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    await page.goto(url);
    const hasToolbar = () => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null;
    await page.waitForFunction(hasToolbar, null, { timeout: 20_000 });
    await page.click(`a[href="${path}"]`);
    await page.waitForURL(`**${path}`);
    await page.waitForSelector(".item");
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => ({
      hosts: document.querySelectorAll("critiqs-root").length,
      heading: document.querySelector(".item")?.textContent?.trim() ?? "",
      toolbar: document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null,
    }));
    if (process.env.CRITIQS_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.CRITIQS_EVIDENCE_DIR, `${name}.png`) });
    return { errors, ...result };
  } finally {
    await browser.close();
  }
}

/** Opens `url` in Chrome, waits for the app and the network to settle, and reports what the page has. */
async function openWithoutCritiqs(url: string) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1_000);
    const result = await page.evaluate(() => ({ critiqsRoot: document.querySelector("critiqs-root") !== null, appText: document.querySelector("#app")?.textContent ?? "" }));
    return { ...result, errors };
  } finally {
    await browser.close();
  }
}
