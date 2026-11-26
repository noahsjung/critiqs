// Two real Angular apps from `ng new`, installed from the packed packages and
// set up by the Angular setup adapter, each built for production with the
// Angular CLI's application builder (esbuild) and checked in Chrome:
// - a zoneless app (today's default), served as static files;
// - a zone.js app with server-side rendering, served by its own Node server,
//   whose server-rendered HTML must not contain Critiqs.
// Each app gets a second route, `items/:id`, and a link to it; after the
// client-side navigation the page must still have exactly one Critiqs.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chrome, expectToolbar, fakeBackend, PROJECT, packedDependencies, run, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";

const angular = FRAMEWORKS.find((adapter) => adapter.id === "angular")!;

const CLI = "@angular/cli@22.3.0";
const env = { ...process.env, NG_CLI_ANALYTICS: "false", NG_FORCE_TTY: "false", CI: "true" };

const dir = await scratch("angular");
const packed = await packedDependencies(dir, { "critiqs-angular": "packages/angular" });
const backend = fakeBackend();
const settings = { projectId: { literal: PROJECT }, requireProjectId: true, backend: backend.url };

/** Creates an app with `ng new`, installs the packed packages, and adds Critiqs with the adapter. */
async function createApp(name: string, flags: string[]): Promise<string> {
  await run(["npx", "-y", CLI, "new", name, "--defaults", "--skip-git", "--skip-install", "--package-manager", "npm", ...flags], dir, env);
  const app = join(dir, name);
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  manifest.dependencies = { ...manifest.dependencies, ...packed.dependencies };
  manifest.overrides = { ...manifest.overrides, ...packed.overrides };
  writeFileSync(join(app, "package.json"), JSON.stringify(manifest, null, 2));
  await run(["npm", "install", "--no-audit", "--no-fund"], app, env);

  assert.equal(angular.detect(app), true);
  const plan = angular.plan(app, settings, { entry: null });
  if (!plan.ok) throw new Error(plan.message);
  assert.equal(plan.action, "install");
  for (const write of plan.writes) writeFileSync(write.file, write.source);
  assert.equal((angular.plan(app, settings, { entry: null }) as { action?: string }).action, "unchanged");
  console.log(`${name}: setup added\n${plan.preview}`);

  addItemRoute(app);
  return app;
}

/** Adds the route `items/:id` beside the home page, and a router link to it above the starter's outlet. */
function addItemRoute(app: string) {
  const edit = (file: string, from: string, to: string) => {
    const path = join(app, "src/app", file);
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes(from), `${file} should contain ${from}`);
    writeFileSync(path, source.replace(from, to));
  };
  writeFileSync(
    join(app, "src/app/item.ts"),
    "import { Component } from '@angular/core';\n\n@Component({ selector: 'app-item', template: '<p id=\"item-page\">Item page</p>' })\nexport class Item {}\n",
  );
  edit("app.routes.ts", "export const routes: Routes = [];", "import { Item } from './item';\n\nexport const routes: Routes = [\n  { path: '', children: [] },\n  { path: 'items/:id', component: Item },\n];");
  edit("app.ts", "import { RouterOutlet } from '@angular/router';", "import { RouterLink, RouterOutlet } from '@angular/router';");
  edit("app.ts", "imports: [RouterOutlet]", "imports: [RouterLink, RouterOutlet]");
  edit("app.html", "<router-outlet />", '<a id="item-link" routerLink="/items/7">Item 7</a>\n<router-outlet />');
}

/** Follows the router link to `/items/7` without reloading the page, then counts Critiqs's roots. */
async function navigateToItem(url: string, name: string): Promise<void> {
  const tools = await scratch("browser-navigation");
  // Its own package.json, or npm installs into the nearest parent folder with node_modules.
  writeFileSync(join(tools, "package.json"), JSON.stringify({ private: true }));
  await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], tools);
  const { chromium } = await import(join(tools, "node_modules/playwright-core/index.mjs"));
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    await page.goto(url);
    const toolbar = () => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null;
    await page.waitForFunction(toolbar, null, { timeout: 20_000 });
    await page.evaluate(() => Object.assign(window, { samePage: true }));
    await page.click("#item-link");
    await page.waitForFunction(() => location.pathname === "/items/7" && document.querySelector("#item-page") !== null, null, { timeout: 10_000 });
    // Time for a second mount to show up, if navigation caused one.
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => ({
      samePage: (window as { samePage?: boolean }).samePage === true,
      roots: document.querySelectorAll("critiqs-root").length,
    }));
    assert.equal(await page.evaluate(toolbar), true, "the toolbar should still show after navigating");
    assert.deepEqual(after, { samePage: true, roots: 1 }, "a client-side navigation should keep one Critiqs");
    assert.deepEqual(errors, []);
    const evidence = process.env.CRITIQS_EVIDENCE_DIR;
    if (evidence !== undefined && evidence !== "") {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `${name}-item.png`) });
    }
    console.log(`${name}: after a client-side navigation to /items/7 the page has ${after.roots} critiqs-root.`);
  } finally {
    await browser.close();
  }
}

/** Critiqs is in a chunk of its own that the page doesn't load up front, so the starter's initial-bundle budget holds. */
function assertLazy(browserFiles: string, page: string) {
  const scripts = readdirSync(browserFiles).filter((file) => file.endsWith(".js"));
  const critiqs = scripts.filter((file) => readFileSync(join(browserFiles, file), "utf8").includes("critiqs-root"));
  assert.equal(critiqs.length, 1, `Critiqs should be in one chunk: ${critiqs.join(", ")}`);
  assert.doesNotMatch(critiqs[0]!, /^main-/);
  assert.ok(!page.includes(critiqs[0]!), "the page shouldn't load Critiqs up front");
}

async function checkPage(url: string, name: string): Promise<string> {
  const { toolbar, errors } = await expectToolbar(url, name);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(toolbar, /Set up Critiqs/);
  return toolbar;
}

const servers: { stop: () => void }[] = [backend];
try {
  // Zoneless, no server rendering: the build is static files.
  const browserApp = await createApp("shop", ["--ssr=false"]);
  await run(["npx", "ng", "build"], browserApp, env);
  const files = join(browserApp, "dist/shop/browser");
  assertLazy(files, readFileSync(join(files, "index.html"), "utf8"));
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(files, path));
      return path !== "/" && (await file.exists()) ? new Response(file) : new Response(Bun.file(join(files, "index.html")));
    },
  });
  servers.push(server);
  const zoneless = await checkPage(`http://localhost:${server.port}/`, "angular");
  await navigateToItem(`http://localhost:${server.port}/`, "angular");

  // zone.js with server-side rendering, rendered for each request by the app's Express server.
  const ssrApp = await createApp("shop-ssr", ["--ssr", "--zoneless=false"]);
  const routes = join(ssrApp, "src/app/app.routes.server.ts");
  writeFileSync(routes, readFileSync(routes, "utf8").replace("RenderMode.Prerender", "RenderMode.Server"));
  await run(["npx", "ng", "build"], ssrApp, env);
  const port = 4300 + Math.floor(Math.random() * 600);
  const node = Bun.spawn(["node", "dist/shop-ssr/server/server.mjs"], { cwd: ssrApp, env: { ...env, PORT: String(port), NG_ALLOWED_HOSTS: "localhost" }, stdout: "pipe", stderr: "pipe" });
  servers.push({ stop: () => node.kill() });
  const url = `http://localhost:${port}/`;
  await waitForServer(url);
  const html = await (await fetch(url)).text();
  assert.match(html, /<app-root[^>]*ng-server-context="ssr"/, "the page should be rendered on the server");
  assert.doesNotMatch(html, /critiqs-root/, "the server render must not add Critiqs");
  assertLazy(join(ssrApp, "dist/shop-ssr/browser"), html);
  const ssr = await checkPage(url, "angular-ssr");
  await navigateToItem(url, "angular-ssr");
  node.kill();
  const serverErrors = await new Response(node.stderr).text();
  assert.equal(serverErrors.trim(), "", serverErrors);

  console.log(`Angular: Critiqs's toolbar appears in a zoneless app (${JSON.stringify(zoneless)}) and in a zone.js SSR app (${JSON.stringify(ssr)}); the server render has no Critiqs.`);
} finally {
  for (const server of servers) server.stop();
}
