// A real Astro app: `npm create astro` with the minimal template, installed
// from the packed packages, with Critiqs added by the setup adapter's plan.
// A layout with <ClientRouter /> serves `/` and `/items/[id]`. Each site is
// built for production and served as static files, and Chrome checks that
// Critiqs's toolbar appears, that a client-side navigation, Back, and the
// default restoreContext opening another item keep exactly one Critiqs (the
// same element), that restoring an item the site doesn't build reports false
// once the host's custom 404 page is shown at its URL, and that a build
// without the project ID variable shows no Critiqs.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { chrome, expectToolbar, fakeBackend, PROJECT, packedDependencies, run, scratch } from "../../../scripts/consumer-kit.ts";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import type { Settings } from "../../critiqs/bin/frameworks/types.d.mts";

const astro = FRAMEWORKS.find((adapter) => adapter.id === "astro")!;

const dir = await scratch("astro");
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
// create-astro and its template at fixed versions, as the other checks pin
// their starters: unpinned, both follow each day's newest release.
await run(["npm", "create", "--yes", "astro@5.3.2", "--", "site", "--template", "minimal", "--ref", "astro@7.4.13", "--no-install", "--no-git", "--skip-houston", "--yes"], dir);
const app = join(dir, "site");

const manifest = await Bun.file(join(app, "package.json")).json();
const { dependencies, overrides } = await packedDependencies(dir, { "critiqs-astro": "packages/astro" });
await Bun.write(join(app, "package.json"), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, ...dependencies }, overrides }, null, 2));
await run(["npm", "install", "--no-audit", "--no-fund"], app);

// Two routes under one layout with <ClientRouter />.
const layout = `---
import { ClientRouter } from 'astro:transitions';
const { title } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
    <ClientRouter />
  </head>
  <body>
    <nav><a id="home" href="/">Home</a> <a id="item" href="/items/1">Item 1</a></nav>
    <slot />
    <script>
      // For this check: Critiqs's default restoreContext, which shows a thread's page.
      import { restoreRoute } from 'critiqs-astro/client';
      (window as unknown as { restoreRoute: typeof restoreRoute }).restoreRoute = restoreRoute;
    </script>
  </body>
</html>
`;
await mkdir(join(app, "src/layouts"), { recursive: true });
await mkdir(join(app, "src/pages/items"), { recursive: true });
await Bun.write(join(app, "src/layouts/Layout.astro"), layout);
await Bun.write(join(app, "src/pages/index.astro"), `---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title="Home"><h1>Home</h1></Layout>\n`);
// A custom 404 page, which static hosts serve, with status 404, at any URL the site didn't build.
await Bun.write(join(app, "src/pages/404.astro"), `---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title="Not found"><h1>Not found</h1></Layout>\n`);
await Bun.write(
  join(app, "src/pages/items/[id].astro"),
  `---\nimport Layout from '../../layouts/Layout.astro';\nexport function getStaticPaths() {\n  return [{ params: { id: '1' } }, { params: { id: '2' } }];\n}\nconst { id } = Astro.params;\n---\n<Layout title={\`Item \${id}\`}><h1>Item {id}</h1></Layout>\n`,
);
const starterConfig = await Bun.file(join(app, "astro.config.mjs")).text();

/** Adds Critiqs with the adapter's plan, as `critiqs init` will, and checks planning again changes nothing. */
async function setUp(settings: Settings) {
  await Bun.write(join(app, "astro.config.mjs"), starterConfig);
  const plan = astro.plan(app, settings, { entry: null });
  assert.ok(plan.ok, plan.ok ? "" : plan.message);
  assert.equal(plan.action, "install");
  for (const write of plan.writes) await Bun.write(write.file, write.source);
  const again = astro.plan(app, settings, { entry: null });
  assert.ok(again.ok && again.action === "unchanged", "planning again should change nothing");
  return plan.preview;
}

/** Builds the site and serves `dist` as a static host does. */
async function buildAndServe(env: Record<string, string | undefined> = {}) {
  await run(["npx", "astro", "build"], app, { ...process.env, PUBLIC_CRITIQS_PROJECT_ID: undefined, ...env });
  const dist = join(app, "dist");
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      for (const candidate of [join(dist, path), join(dist, path, "index.html")]) {
        const file = Bun.file(candidate);
        if (!candidate.endsWith("/") && (await file.exists())) return new Response(file);
      }
      return new Response(Bun.file(join(dist, "404.html")), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

/** Text of every built script, to check what the page script carries. */
async function builtScripts(): Promise<string> {
  const assets = join(app, "dist/_astro");
  const names = (await readdir(assets)).filter((name) => name.endsWith(".js"));
  return (await Promise.all(names.map((name) => Bun.file(join(assets, name)).text()))).join("\n");
}

/** Playwright in its own folder with a package.json, as the consumer kit installs it. */
async function browser() {
  const tools = await scratch("browser");
  process.once("exit", () => rmSync(tools, { recursive: true, force: true }));
  await Bun.write(join(tools, "package.json"), JSON.stringify({ private: true }));
  await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], tools);
  const { chromium } = await import(join(tools, "node_modules/playwright-core/index.mjs"));
  return chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
}

const evidence = process.env.CRITIQS_EVIDENCE_DIR;
const backend = fakeBackend();
const chromium = await browser();
try {
  // A written project ID, required, with a backend: the toolbar on the first page.
  const preview = await setUp({ projectId: { literal: PROJECT }, requireProjectId: true, backend: backend.url });
  let site = await buildAndServe();
  try {
    const scripts = await builtScripts();
    assert.match(scripts, /pattern"?:\s*["'`]\/items\/:id["'`]/, "the page script carries the route list");
    const { toolbar, errors } = await expectToolbar(`${site.url}/`, "astro");
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);

    // A client-side navigation and Back: the same single Critiqs, no page load.
    const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
    await page.goto(`${site.url}/`);
    const shown = () => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null;
    await page.waitForFunction(shown, null, { timeout: 20_000 });
    await page.evaluate(() => {
      (window as unknown as { visit: object; host: Element | null }).visit = {};
      (window as unknown as { host: Element | null }).host = document.querySelector("critiqs-root");
    });
    // Astro removes data-astro-transition once the view transition's animation ends.
    const settled = () => page.waitForFunction(() => !document.documentElement.hasAttribute("data-astro-transition"), null, { timeout: 10_000 });
    const check = () =>
      page.evaluate(() => {
        const w = window as unknown as { visit?: object; host?: Element | null };
        const hosts = document.querySelectorAll("critiqs-root");
        return {
          path: location.pathname,
          heading: document.querySelector("h1")?.textContent,
          sameVisit: w.visit !== undefined,
          roots: hosts.length,
          sameRoot: hosts[0] === w.host,
          inBody: hosts[0]?.parentElement === document.body,
          toolbar: hosts[0]?.shadowRoot?.querySelector(".toolbar") != null,
        };
      });
    assert.deepEqual(await check(), { path: "/", heading: "Home", sameVisit: true, roots: 1, sameRoot: true, inBody: true, toolbar: true });
    await page.click("#item");
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Item 1", null, { timeout: 10_000 });
    await settled();
    const afterNavigation = await check();
    if (evidence !== undefined && evidence !== "") await page.screenshot({ path: join(evidence, "astro-after-navigation.png") });
    assert.deepEqual(afterNavigation, { path: "/items/1", heading: "Item 1", sameVisit: true, roots: 1, sameRoot: true, inBody: true, toolbar: true });
    await page.goBack();
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Home", null, { timeout: 10_000 });
    await settled();
    const afterBack = await check();
    assert.deepEqual(afterBack, { path: "/", heading: "Home", sameVisit: true, roots: 1, sameRoot: true, inBody: true, toolbar: true });
    // Opening a thread left on another item: Critiqs's default restoreContext navigates there with <ClientRouter />.
    const restore = (screen: string, viewState: Record<string, string>) =>
      page.evaluate(
        async ([screen, viewState]: readonly [string, Record<string, string>]) => {
          const { restoreRoute } = window as unknown as { restoreRoute: (request: object) => Promise<boolean | void> };
          return await restoreRoute({ threadId: "t1", screen, viewState, recordKey: null, scope: "shared", signal: new AbortController().signal });
        },
        [screen, viewState] as const,
      );
    assert.equal(await restore("items/:id", { "route.id": "2" }), true);
    await settled();
    const afterRestore = await check();
    assert.deepEqual(afterRestore, { path: "/items/2", heading: "Item 2", sameVisit: true, roots: 1, sameRoot: true, inBody: true, toolbar: true });
    assert.equal(await restore("items/:id", { "route.id": "2" }), true, "the page already shown");
    assert.equal(await restore("users/:id", { "route.id": "2" }), false, "a screen this site has no page for");
    assert.deepEqual(await check(), afterRestore);
    // An item removed from getStaticPaths: <ClientRouter /> shows the 404 page at its URL, and restore says it couldn't show the thread.
    assert.equal(await restore("items/:id", { "route.id": "deleted" }), false, "an item the site doesn't build shows the 404 page");
    await settled();
    const afterMissing = await check();
    if (evidence !== undefined && evidence !== "") await page.screenshot({ path: join(evidence, "astro-restore-missing.png") });
    assert.deepEqual(afterMissing, { path: "/items/deleted", heading: "Not found", sameVisit: true, roots: 1, sameRoot: true, inBody: true, toolbar: true });
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="critiqs-astro-route"]')?.getAttribute("content")), "/404");
    // Back to a real item from there.
    assert.equal(await restore("items/:id", { "route.id": "1" }), true);
    await settled();
    assert.equal((await check()).heading, "Item 1");
    assert.deepEqual(pageErrors, []);
    await page.close();
    console.log(`Astro: Critiqs's toolbar appears (${JSON.stringify(toolbar)}) and stays, once, across a ClientRouter navigation, Back, and the default restoreContext opening another item; restoring an item the site doesn't build reports false on the 404 page.`);
    console.log(`Setup wrote:\n${preview}`);
  } finally {
    site.stop();
  }

  // The project ID from PUBLIC_CRITIQS_PROJECT_ID: unset, no Critiqs; set, the toolbar.
  const settings: Settings = { projectId: { env: astro.env(app, "")! }, requireProjectId: true, backend: backend.url };
  await setUp(settings);
  site = await buildAndServe();
  try {
    const page = await chromium.newPage();
    await page.goto(`${site.url}/items/2`);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Item 2", null, { timeout: 10_000 });
    await Bun.sleep(1500);
    assert.equal(await page.evaluate(() => document.querySelectorAll("critiqs-root").length), 0, "a build without the variable shows no Critiqs");
    await page.close();
  } finally {
    site.stop();
  }
  site = await buildAndServe({ PUBLIC_CRITIQS_PROJECT_ID: PROJECT });
  try {
    const { toolbar, errors } = await expectToolbar(`${site.url}/items/2`, "astro-env");
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    console.log("Astro: a build without PUBLIC_CRITIQS_PROJECT_ID shows no Critiqs; with it, the toolbar appears.");
  } finally {
    site.stop();
  }
} finally {
  await chromium.close();
  backend.stop();
}
