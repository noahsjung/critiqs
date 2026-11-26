// Shared pieces of the consumer checks: each framework package's
// `check:consumer` script builds a real app of its framework against the
// packed packages (never the workspace sources) and checks in Chrome that
// Critiqs's toolbar appears. Set CHROME_PATH to choose the browser and
// CRITIQS_EVIDENCE_DIR to keep screenshots. With CRITIQS_PACKED set to the
// folder `bun scripts/publish.ts pack` wrote, the checks install those packed
// files instead of packing or building their own.
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packedFile } from "./package-tarball.ts";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Project IDs that look real; consumer apps never reach a backend that knows them. */
export const PROJECT = "j12345678901234567890123456789012";

/** Runs a command, returning its output, or throws with everything it printed. */
export async function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}) in ${cwd}:\n${stdout}\n${stderr}`);
  return stdout;
}

/** A new empty folder for one check's apps. */
export async function scratch(name: string): Promise<string> {
  const base = process.env.TMPDIR ?? tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `critiqs-${name}-`));
}

/**
 * Packs a built workspace package (such as `packages/critiqs`) into `dest`,
 * returning the tarball's path; with CRITIQS_PACKED set, returns its packed
 * tarball there instead.
 */
export async function pack(packageDir: string, dest: string): Promise<string> {
  const { name, version } = await Bun.file(join(ROOT, packageDir, "package.json")).json();
  const prepacked = packedFile("npm", name, version);
  if (prepacked !== null) return prepacked;
  const [packed] = JSON.parse(await run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", dest], join(ROOT, packageDir)));
  return join(dest, packed.filename);
}

/**
 * Packs the shared `critiqs` package and the given packages, returning the
 * `dependencies` and `overrides` a consumer's package.json needs, so packages
 * that depend on `critiqs` resolve to the packed one, not the registry.
 */
export async function packedDependencies(dest: string, packages: Record<string, string>): Promise<{ dependencies: Record<string, string>; overrides: Record<string, string> }> {
  const dependencies: Record<string, string> = { critiqs: `file:${await pack("packages/critiqs", dest)}` };
  for (const [name, dir] of Object.entries(packages)) dependencies[name] = `file:${await pack(dir, dest)}`;
  return { dependencies, overrides: { critiqs: dependencies.critiqs! } };
}

/** The browser to drive: CHROME_PATH, or a usual Chrome or Chromium location. */
export function chrome(): string {
  const found = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => path !== undefined && path !== "" && existsSync(path));
  if (found === undefined) throw new Error("The consumer checks need Chrome or Chromium: set CHROME_PATH to its executable.");
  return found;
}

let playwrightTools: Promise<string> | null = null;

/** Playwright, installed once per run in its own folder. */
async function playwright() {
  playwrightTools ??= (async () => {
    const tools = await scratch("browser");
    // Its own package.json, or npm installs into the nearest parent folder with node_modules.
    await Bun.write(join(tools, "package.json"), JSON.stringify({ private: true }));
    await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], tools);
    process.once("exit", () => rmSync(tools, { recursive: true, force: true }));
    return tools;
  })();
  return import(join(await playwrightTools, "node_modules/playwright-core/index.mjs"));
}

/** The part of Playwright's page the consumer checks use. */
export interface BrowserPage {
  goto(url: string): Promise<unknown>;
  goBack(): Promise<unknown>;
  click(selector: string): Promise<void>;
  url(): string;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction<A>(fn: (arg: A) => boolean, arg: A, options: { timeout: number }): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>;
  screenshot(options: { path: string }): Promise<unknown>;
  on(event: "pageerror", listener: (error: Error) => void): void;
}

/** Opens Chrome with one page, runs `steps` with it and the page errors so far, and always closes Chrome. */
export async function inChrome<T>(steps: (page: BrowserPage, errors: string[]) => Promise<T>): Promise<T> {
  const { chromium } = await playwright();
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  try {
    const page: BrowserPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    return await steps(page, errors);
  } finally {
    await browser.close();
  }
}

/** Saves `<name>.png` to CRITIQS_EVIDENCE_DIR when it is set. */
async function keepScreenshot(page: BrowserPage, name: string) {
  const evidence = process.env.CRITIQS_EVIDENCE_DIR;
  if (evidence === undefined || evidence === "") return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`) });
}

/** Throws unless Critiqs's toolbar is styled: a blocked stylesheet leaves an unstyled, invisible toolbar. */
async function expectStyled(page: BrowserPage) {
  const position = await page.evaluate(() => getComputedStyle(document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".toolbar")!).position);
  if (position !== "fixed") throw new Error(`Critiqs's toolbar is on ${page.url()} but unstyled (position: ${position}); its stylesheet was blocked.`);
}

/**
 * Opens `url` in Chrome and waits for Critiqs's toolbar in its shadow root,
 * styled.
 * Returns the toolbar's text and any page errors; saves `<name>.png` to
 * CRITIQS_EVIDENCE_DIR when it is set.
 */
export async function expectToolbar(url: string, name: string, { timeout = 20_000 } = {}): Promise<{ toolbar: string; errors: string[] }> {
  return inChrome(async (page, errors) => {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar") != null, null, { timeout });
    const toolbar = await page.evaluate(() => (document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".toolbar") as HTMLElement).innerText);
    await expectStyled(page);
    await keepScreenshot(page, name);
    return { toolbar, errors };
  });
}

/**
 * Waits until the page shows exactly one Critiqs (one `critiqs-root`, its
 * toolbar styled and on screen) and still does a moment later, for checks
 * that navigate within a page. Returns the toolbar's text; saves `<name>.png`
 * to CRITIQS_EVIDENCE_DIR when it is set. Throws with the number of
 * `critiqs-root` elements found otherwise.
 */
export async function expectOneToolbar(page: BrowserPage, name: string, { timeout = 20_000 } = {}): Promise<string> {
  const one = () => {
    const roots = document.querySelectorAll("critiqs-root");
    const toolbar = roots[0]?.shadowRoot?.querySelector(".toolbar");
    return roots.length === 1 && toolbar != null && toolbar.getBoundingClientRect().width > 0;
  };
  const count = () => page.evaluate(() => document.querySelectorAll("critiqs-root").length);
  try {
    await page.waitForFunction(one, undefined, { timeout });
    // Removing an old Critiqs waits a tick, and a copy from a page cache arrives with the page: look again.
    await Bun.sleep(500);
    await page.waitForFunction(one, undefined, { timeout: 100 });
  } catch {
    throw new Error(`${name}: expected exactly one Critiqs with its toolbar on ${page.url()}, found ${await count()} critiqs-root.`);
  }
  await expectStyled(page);
  await keepScreenshot(page, name);
  return page.evaluate(() => (document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".toolbar") as HTMLElement).innerText);
}

/** Waits until `url` answers, for a dev or preview server started in the background. */
export async function waitForServer(url: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`${url} didn't answer within ${timeout / 1000} seconds.`);
}

/**
 * A stand-in for a Critiqs server in the host app that knows every project
 * and no reviewer, so a consumer app configured with `PROJECT` and
 * `requireProjectId` shows Critiqs without a real backend. Pass `url` as the
 * app's `backend` setting; it answers from any origin.
 */
export function fakeBackend(): { url: string; stop: () => void } {
  let url = "";
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const origin = request.headers.get("origin") ?? "*";
      const cors = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const { pathname } = new URL(request.url);
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
      if (pathname.endsWith("/critiqs/config")) return json({ protocol: 5, transport: "http", signIn: "host", signInUrl: url });
      if (pathname.endsWith("/critiqs/health")) return json({ protocol: 5, signIn: "host", project: "found" });
      if (pathname.endsWith("/me")) return json({ reviewer: null });
      if (pathname.endsWith("/changes")) return json({ version: 1 });
      return json({ error: { code: "not-found", message: "Unknown request." } }, 404);
    },
  });
  // A path keeps it an HTTP backend: a bare localhost origin reads as a local Convex deployment.
  url = `http://localhost:${server.port}/critiqs`;
  return { url, stop: () => server.stop(true) };
}
