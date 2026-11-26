// A real Nuxt app (create-nuxt's minimal template) installed from the packed
// critiqs, critiqs-vue, and critiqs-nuxt, given pages: its welcome page and
// /items/[id]. The Nuxt setup adapter adds the module to
// nuxt.config, first with a project ID and the stand-in backend, then reading
// NUXT_PUBLIC_CRITIQS_PROJECT_ID. Each is built with `nuxt build` and served
// with `node .output/server/index.mjs`. The server must render pages without
// errors and without Critiqs; Chrome checks that the toolbar appears and stays
// the only one after a client-side navigation, and that the same build started
// without the variable adds nothing and never downloads Critiqs. Last,
// `nuxi typecheck` checks the app's plugin using the critiqs:options hook,
// with the module listed by name and as ['critiqs-nuxt', { … }].
import assert from "node:assert/strict";
import { join } from "node:path";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import type { Plan, Settings } from "../../critiqs/bin/frameworks/types.d.mts";
import { chrome, expectToolbar, fakeBackend, PROJECT, packedDependencies, run, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";

const nuxt = FRAMEWORKS.find((adapter) => adapter.id === "nuxt")!;
const dir = await scratch("nuxt");
await run(["npx", "-y", "create-nuxt@4.1.0", "app", "--template", "minimal", "--no-install", "--no-gitInit", "--packageManager", "npm"], dir);
const app = join(dir, "app");
const appVue = await Bun.file(join(app, "app/app.vue")).text();
assert.ok(appVue.includes("<NuxtWelcome />"), "create-nuxt's app.vue still shows the welcome page");
await Bun.write(join(app, "app/app.vue"), appVue.replace("<NuxtWelcome />", '<nav><NuxtLink to="/items/42">Item 42</NuxtLink></nav>\n    <NuxtPage />'));
await Bun.write(join(app, "app/pages/index.vue"), "<template>\n  <NuxtWelcome />\n</template>\n");
await Bun.write(join(app, "app/pages/items/[id].vue"), '<template>\n  <h1 class="item">Item {{ $route.params.id }}</h1>\n</template>\n');
// The app's own plugin gives its getContext through the critiqs:options hook, and the page records that the hook ran.
await Bun.write(
  join(app, "app/plugins/critiqs.client.ts"),
  "export default defineNuxtPlugin((nuxtApp) => {\n  nuxtApp.hook('critiqs:options', (options) => {\n    options.getContext = () => ({ viewState: { tab: 'details' } })\n    ;(window as { critiqsHook?: boolean }).critiqsHook = true\n  })\n})\n",
);
const manifest = await Bun.file(join(app, "package.json")).json();
const packed = await packedDependencies(dir, { "critiqs-vue": "packages/vue", "critiqs-nuxt": "packages/nuxt" });
Object.assign(manifest.dependencies, packed.dependencies);
// critiqs-nuxt depends on critiqs-vue too: the packed one, not the registry's.
manifest.overrides = { ...packed.overrides, "critiqs-vue": packed.dependencies["critiqs-vue"] };
// What `nuxi typecheck` needs; vue-tsc runs on TypeScript 6, the last with a JavaScript API.
manifest.devDependencies = { ...manifest.devDependencies, "vue-tsc": "3.3.14", typescript: "6.0.3" };
// Nuxt's own vue-router range (^5.5.1) without 5.5.2: 5.5.2's bundler build
// reads a global __VUE_OPTIONS_API__ that only a bundler defines, and Nuxt's
// server loads it unbundled, so any Nuxt app with pages/ answers 500
// ("__VUE_OPTIONS_API__ is not defined"), with or without Critiqs. It came
// with vuejs/router#2944. npm installs 5.5.1 until a newer release exists,
// then that one; if it is still broken, this check fails again. Remove this
// once Nuxt's range no longer lets npm pick 5.5.2.
const VUE_ROUTER = "^5.5.1 <5.5.2 || ^5.5.3";
manifest.dependencies["vue-router"] = VUE_ROUTER;
manifest.overrides["vue-router"] = VUE_ROUTER;
await Bun.write(join(app, "package.json"), JSON.stringify(manifest, null, 2));
await run(["npm", "install", "--no-audit", "--no-fund"], app);
assert.equal(nuxt.detect(app), true);

/** Plans, writes the plan as the CLI would, and checks that planning again changes nothing. */
async function setUp(settings: Settings): Promise<Plan & { ok: true }> {
  const plan = nuxt.plan(app, settings, { entry: null });
  if (!plan.ok) throw new Error(`The Nuxt adapter refused: ${plan.message}`);
  for (const write of plan.writes) await Bun.write(write.file, write.source);
  const again = nuxt.plan(app, settings, { entry: null });
  assert.ok(again.ok && again.action === "unchanged", "planning again changes nothing");
  return plan;
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Starts the built server; checks that it renders the page without Critiqs and without errors. */
async function serve(env: Record<string, string | undefined>) {
  const port = freePort();
  const server = Bun.spawn(["node", ".output/server/index.mjs"], { cwd: app, env: { ...process.env, ...env, PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()]).then((parts) => parts.join(""));
  const url = `http://localhost:${port}/`;
  await waitForServer(url);
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 200, "the server renders the page");
  assert.ok(html.includes('<div id="__nuxt">'), "the server renders the app");
  assert.ok(!html.includes("critiqs-root"), "Critiqs never renders on the server");
  return {
    url,
    html,
    async stop() {
      server.kill();
      await server.exited;
      const printed = await output;
      assert.doesNotMatch(printed, /error|\[nuxt\]|\[nitro\].*warn/i, `the server printed problems:\n${printed}`);
      return printed;
    },
  };
}

const backend = fakeBackend();
try {
  // 1. A project ID in nuxt.config, with the stand-in backend.
  const installed = await setUp({ projectId: { literal: PROJECT }, requireProjectId: true, backend: backend.url });
  assert.equal(installed.action, "install");
  console.log(`Nuxt: setup changed ${installed.file}:\n${installed.preview}`);
  await run(["npx", "nuxt", "build"], app);
  const configured = await serve({});
  try {
    assert.ok(configured.html.includes(`critiqs:{projectId:"${PROJECT}",requireProjectId:true`), "the settings reach the browser in public runtime config");
    const { toolbar, errors } = await expectToolbar(configured.url, "nuxt-configured");
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    console.log(`Nuxt: the server renders without Critiqs or errors; in Chrome the toolbar appears (${JSON.stringify(toolbar)}).`);
    const navigated = await navigate(configured.url, "/items/42", "nuxt-route");
    assert.deepEqual(navigated, { errors: [], hosts: 1, heading: "Item 42", toolbar: true, hook: true });
    console.log("Nuxt: after a client-side navigation to /items/42, there is still exactly one critiqs-root with its toolbar.");
    console.log("Nuxt: the app's own plugin received the critiqs:options hook.");
  } finally {
    await configured.stop();
  }

  // 2. The project ID from NUXT_PUBLIC_CRITIQS_PROJECT_ID: one build, started without it and with it.
  const env = nuxt.env(app, "")!;
  const wired = await setUp({ projectId: { env }, requireProjectId: true, backend: backend.url });
  assert.equal(wired.action, "update");
  console.log(`Nuxt: setup changed ${wired.file} to read ${env.variable}:\n${wired.preview}`);
  await run(["npx", "nuxt", "build"], app, { ...process.env, [env.variable]: undefined });
  const unset = await serve({ [env.variable]: undefined });
  try {
    const page = await openWithoutCritiqs(unset.url);
    assert.deepEqual(page.errors, []);
    assert.equal(page.critiqsRoot, false);
    assert.ok(page.rendered, "the app itself renders");
    assert.equal(page.critiqsRequests.length, 0, `Critiqs is never downloaded: ${page.critiqsRequests.join(", ")}`);
    console.log(`Nuxt: started without ${env.variable}, the page renders with no critiqs-root and ${page.scripts} scripts, none of them Critiqs.`);
  } finally {
    await unset.stop();
  }
  const set = await serve({ [env.variable]: PROJECT });
  try {
    const { toolbar, errors } = await expectToolbar(set.url, "nuxt-env");
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    console.log(`Nuxt: the same build started with ${env.variable} shows the toolbar (${JSON.stringify(toolbar)}).`);
  } finally {
    await set.stop();
  }
} finally {
  backend.stop();
}

// 3. The app's plugin typechecks against Nuxt's generated types, wherever the module is listed.
const config = join(app, "nuxt.config.ts");
const listedByName = await Bun.file(config).text();
assert.ok(listedByName.includes("modules: ['critiqs-nuxt']"), "setup listed the module by name");
for (const [form, source] of [
  ["by name", listedByName],
  ["as ['critiqs-nuxt', { … }]", listedByName.replace("modules: ['critiqs-nuxt']", "modules: [['critiqs-nuxt', { router: true }]]")],
] as const) {
  await Bun.write(config, source);
  await run(["npx", "nuxi", "typecheck"], app);
  const references = (await Bun.file(join(app, ".nuxt/nuxt.d.ts")).text()).match(/^\/\/\/ <reference types="critiqs-nuxt" \/>$/gm);
  assert.equal(references?.length, 1, "the app's types load critiqs-nuxt once");
  console.log(`Nuxt: with the module listed ${form}, nuxi typecheck passes on the app's plugin using the critiqs:options hook.`);
}
await Bun.write(config, listedByName);

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
      hook: (window as { critiqsHook?: boolean }).critiqsHook === true,
    }));
    if (process.env.CRITIQS_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.CRITIQS_EVIDENCE_DIR, `${name}.png`) });
    return { errors, ...result };
  } finally {
    await browser.close();
  }
}

/** Opens `url` in Chrome, waits for the app and the network to settle, and reports what the page has and loaded. */
async function openWithoutCritiqs(url: string) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const scripts: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    page.on("response", async (response: { url(): string; text(): Promise<string> }) => {
      if (response.url().endsWith(".js")) scripts.push(await response.text().then((text) => (text.includes("critiqs-root") ? response.url() : "")));
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1_000);
    const result = await page.evaluate(() => ({
      critiqsRoot: document.querySelector("critiqs-root") !== null,
      rendered: (document.querySelector("#__nuxt")?.children.length ?? 0) > 0,
    }));
    return { ...result, errors, scripts: scripts.length, critiqsRequests: scripts.filter((name) => name !== "") };
  } finally {
    await browser.close();
  }
}
