// Real Solid apps from the official generator (create-solid), installed from
// the packed packages, with Critiqs added by the Solid setup adapter. For each
// app: built with the brief's settings (a project ID, requireProjectId, and a
// stand-in backend), served for production, and checked in Chrome for the
// toolbar; then switched to the app's VITE_ variable, built with it unset, and
// checked to add nothing. Apps with Solid Router get an /items/:id route, and
// Chrome follows a link to it: the page changes without a reload, and there is
// still exactly one Critiqs. The apps cover Solid 1.9 and Solid 2, in the
// browser only and rendered on the server (Solid 2's own SSR and SolidStart).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chrome, expectToolbar, fakeBackend, PROJECT, packedDependencies, run, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import type { FileWrite, Plan, Settings } from "../../critiqs/bin/frameworks/types.d.mts";

const solid = FRAMEWORKS.find((adapter) => adapter.id === "solid")!;
const CREATE_SOLID = "create-solid@0.13.0";

interface Starter {
  name: string;
  /** create-solid's flags for this starter. */
  flags: string[];
  /** The file setup should add Critiqs to. */
  entry: string;
  /** The production server, on `port`. */
  serve: (port: number) => string[];
  /** Text the server's HTML has when it rendered the page itself. */
  rendered?: string;
  /** Where the app's file routes live, for apps with Solid Router. */
  routes?: string;
  /** A fix the starter needs before it builds at all. */
  repair?: (app: string) => Promise<void>;
}

/**
 * create-solid 0.13's --ssr writes `start: { node: true }`, which
 * @solidjs/vite-plugin 3.0.1 refuses ("`start.node` has been renamed to
 * `start.nodeServer`"), so the server-rendered starter doesn't build as made.
 */
async function renameNodeServer(app: string) {
  const file = join(app, "vite.config.ts");
  const config = await Bun.file(file).text();
  if (config.includes("start: { node: true }")) await Bun.write(file, config.replace("start: { node: true }", "start: { nodeServer: true }"));
}

/** Vite's own script, not npx, so stopping the server stops the process that serves. */
const vitePreview = (port: number) => ["node", "node_modules/vite/bin/vite.js", "preview", "--port", `${port}`, "--strictPort"];

/** A second route, in a form both Solid Router 1 and 2 read. */
const ITEM_ROUTE = `import { useParams } from "@solidjs/router";

export default function Item() {
  const params = useParams();
  return <main><h1>Item {params.id} details</h1></main>;
}
`;

const STARTERS: Starter[] = [
  { name: "vite-solid-1", flags: ["--vanilla", "--template", "basic", "--ts"], entry: "src/App.tsx", serve: (port) => vitePreview(port) },
  { name: "solid-2", flags: ["--solid", "--template", "basic", "--ts", "--no-ssr", "--no-devtools"], entry: "src/App.tsx", serve: (port) => vitePreview(port), routes: "src/routes" },
  { name: "solid-2-ssr", flags: ["--solid", "--template", "basic", "--ts", "--ssr", "--no-devtools"], entry: "src/App.tsx", serve: () => ["node", "dist/server/node.js"], rendered: "<nav", routes: "src/routes", repair: renameNodeServer },
  { name: "solidstart-2", flags: ["--solidstart", "--v2", "--template", "basic", "--ts"], entry: "src/app.tsx", serve: () => ["node", ".output/server/index.mjs"], rendered: "href=\"/about\">About</a>", routes: "src/routes" },
];

const only = process.env.CRITIQS_SOLID_STARTERS?.split(",");
const backend = fakeBackend();
const dir = await scratch("solid");
const { dependencies, overrides } = await packedDependencies(dir, { "critiqs-solid": "packages/solid" });
// Apps install with one npm everywhere: npm 9 (Debian's, for one) can't read
// a file: override ("Invalid comparator").
const tools = await scratch("npm");
await Bun.write(join(tools, "package.json"), JSON.stringify({ private: true }));
await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "npm@11.21.3"], tools);
const npm = ["node", join(tools, "node_modules/npm/bin/npm-cli.js")];

function apply(plan: Plan, action: string): FileWrite[] {
  if (!plan.ok) throw new Error(`Setup refused (${plan.reason}): ${plan.message}`);
  assert.equal(plan.action, action);
  for (const { file, source } of plan.writes) writeFileSync(file, source);
  return plan.writes;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port as number;
}

/** Builds the app for production with `env`, serves it, and runs `check` against its address. */
async function buildAndServe<T>(app: string, starter: Starter, env: Record<string, string | undefined>, check: (url: string) => Promise<T>): Promise<T> {
  await run([...npm, "run", "build"], app, env);
  const port = await freePort();
  const server = Bun.spawn(starter.serve(port), { cwd: app, env: { ...env, PORT: `${port}`, NITRO_PORT: `${port}`, HOST: "localhost" }, stdout: "pipe", stderr: "pipe" });
  const url = `http://localhost:${port}/`;
  try {
    await waitForServer(url);
    if (starter.rendered !== undefined) {
      const html = await (await fetch(url)).text();
      assert.ok(html.includes(starter.rendered), `${starter.name}'s server didn't render the page:\n${html.slice(0, 500)}`);
      assert.ok(!html.includes("critiqs-root"), `${starter.name}'s server rendered Critiqs`);
    }
    return await check(url);
  } finally {
    server.kill();
    await server.exited;
  }
}

let playwright: Promise<{ chromium: { launch(options: object): Promise<Browser> } }> | undefined;
interface Page {
  goto(url: string, options?: object): Promise<unknown>;
  waitForFunction(fn: () => boolean, arg: null, options: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  click(selector: string): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  on(event: string, listener: (value: never) => void): void;
}
interface Browser {
  newPage(options?: object): Promise<Page>;
  close(): Promise<void>;
}

/** Opens a page in Chrome, collecting page errors, console errors, and failed requests (a starter without a favicon is fine). */
async function withPage<T>(use: (page: Page, errors: string[]) => Promise<T>): Promise<T> {
  playwright ??= (async () => {
    const tools = await scratch("browser");
    // Its own package.json, or npm installs into the nearest parent folder with one.
    await Bun.write(join(tools, "package.json"), JSON.stringify({ private: true }));
    await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], tools);
    return import(join(tools, "node_modules/playwright-core/index.mjs"));
  })();
  const { chromium } = await playwright;
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
    });
    page.on("response", (response: { status(): number; url(): string }) => {
      if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) errors.push(`${response.status()} ${response.url()}`);
    });
    return await use(page, errors);
  } finally {
    await browser.close();
  }
}

/** Opens `url` once the app has rendered and gone quiet; returns whether Critiqs added anything. */
const critiqsAbsent = (url: string) =>
  withPage(async (page, errors) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.body.innerText.trim() !== "", null, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const absent = await page.evaluate(() => document.querySelector("critiqs-root") === null);
    return { absent, errors };
  });

/**
 * Opens `url`, waits for the toolbar, and follows a link to /items/42, which
 * the router handles in the page. Returns whether the page stayed the same
 * document, how many Critiqs it has afterwards, and whether the toolbar shows.
 */
const navigate = (url: string, name: string) =>
  withPage(async (page, errors) => {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null, null, { timeout: 30_000 });
    await page.evaluate(() => {
      (window as { critiqsCheck?: boolean }).critiqsCheck = true;
      const link = Object.assign(document.createElement("a"), { href: "/items/42", id: "critiqs-check-link", textContent: "Open item" });
      document.body.append(link);
    });
    await page.click("#critiqs-check-link");
    await page.waitForFunction(() => location.pathname === "/items/42" && (document.body.textContent ?? "").includes("Item 42 details"), null, { timeout: 20_000 });
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => ({
      sameDocument: (window as { critiqsCheck?: boolean }).critiqsCheck === true,
      roots: document.querySelectorAll("critiqs-root").length,
      toolbar: document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null,
    }));
    const evidence = process.env.CRITIQS_EVIDENCE_DIR;
    if (evidence !== undefined && evidence !== "") await page.screenshot({ path: join(evidence, `${name}.png`) });
    return { ...after, errors };
  });

const results: string[] = [];
try {
  for (const starter of STARTERS.filter(({ name }) => only === undefined || only.includes(name))) {
    const app = join(dir, starter.name);
    await run(["npx", "-y", CREATE_SOLID, "--project-name", starter.name, ...starter.flags], dir);
    // The starters pin pnpm; this check installs with npm, from the packed packages.
    await rm(join(app, "pnpm-lock.yaml"), { force: true });
    await rm(join(app, "pnpm-workspace.yaml"), { force: true });
    const manifest = await Bun.file(join(app, "package.json")).json();
    manifest.dependencies = { ...manifest.dependencies, ...dependencies };
    manifest.overrides = { ...manifest.overrides, ...overrides };
    await Bun.write(join(app, "package.json"), JSON.stringify(manifest, null, 2));
    await run([...npm, "install", "--no-audit", "--no-fund"], app);
    assert.equal(solid.detect(app), true);
    await starter.repair?.(app);
    if (starter.routes !== undefined) await Bun.write(join(app, starter.routes, "items/[id].tsx"), ITEM_ROUTE);

    // The brief's settings, written into the code.
    const configured: Settings = { projectId: { literal: PROJECT }, requireProjectId: true, backend: backend.url };
    const writes = apply(solid.plan(app, configured, { entry: null }), "install");
    assert.deepEqual(
      writes.map(({ file }) => file),
      [join(app, starter.entry)],
    );
    apply(solid.plan(app, configured, { entry: null }), "unchanged");
    const { toolbar, errors, navigated } = await buildAndServe(app, starter, process.env, async (url) => ({
      ...(await expectToolbar(url, `${starter.name}-configured`, { timeout: 30_000 })),
      navigated: starter.routes === undefined ? null : await navigate(url, `${starter.name}-navigated`),
    }));
    assert.deepEqual(errors, [], `${starter.name}: page errors`);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    if (navigated !== null) {
      assert.deepEqual(navigated, { sameDocument: true, roots: 1, toolbar: true, errors: [] }, `${starter.name}: after navigating to /items/42`);
    }

    // The app's variable, unset in this build: Critiqs adds nothing.
    const env = solid.env(app, "");
    assert.ok(env !== null, `${starter.name} has no VITE_ convention`);
    apply(solid.plan(app, { projectId: { env }, requireProjectId: true, backend: backend.url }, { entry: null }), "update");
    apply(solid.plan(app, { projectId: { env }, requireProjectId: true, backend: backend.url }, { entry: null }), "unchanged");
    const unset = { ...process.env, [env.variable]: undefined };
    const hidden = await buildAndServe(app, starter, unset, critiqsAbsent);
    assert.equal(hidden.absent, true, `${starter.name}: Critiqs appeared without ${env.variable}`);
    assert.deepEqual(hidden.errors, [], `${starter.name}: page errors without ${env.variable}`);

    const code = (await Bun.file(join(app, starter.entry)).text()).split("\n").find((line) => line.includes("<Critiqs"))!.trim();
    const routed = navigated === null ? "" : "; one Critiqs after navigating to /items/42 in the page";
    results.push(`${starter.name}: toolbar ${JSON.stringify(toolbar)} with the configured build${routed}; nothing with ${env.variable} unset (${starter.entry}: ${code})`);
  }
} finally {
  backend.stop();
}
assert.ok(results.length > 0, "No starters ran.");
console.log(`Solid consumer apps from ${CREATE_SOLID}:\n${results.map((line) => `- ${line}`).join("\n")}`);
