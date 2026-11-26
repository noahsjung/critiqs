// MANUAL_TEST.md, run by a script in real Chrome: the built extension (not a
// test build) loaded in Chrome for Testing, its toolbar action run through the
// Chrome DevTools Protocol (`Extensions.triggerAction`, which Chrome handles
// as a click on the icon, granting the page for that click), and the real side
// panel driven over its own DevTools target. Every step of the checklist ends
// as pass, fail, or "not automatable" with the reason, in results.md with a
// screenshot of the page and the side panel.
//
//   CRITIQS_BACKEND=http://127.0.0.1:3210 bun run check:checklist
//
// Needs CRITIQS_BACKEND: a local Convex deployment with development sign-in
// (`bun run setup:local` in packages/backend) whose CRITIQS_EXTENSION_IDS lists
// the development ID. Optional: CHROME_PATH (Chrome for Testing or Chromium;
// branded Chrome no longer loads unpacked extensions from the command line,
// default: the newest Playwright Chromium), PLAYWRIGHT_CORE (default: installed
// for the run), CRITIQS_EXTENSION_DIR (an extension already built, such as an
// older commit's, instead of building this one), CRITIQS_EVIDENCE_DIR (where
// results and screenshots go). Exits with 1 when a step fails.
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "@critiqs/backend/api";
import { panelSignIn } from "@critiqs/core";
import { ConvexHttpClient } from "convex/browser";
import { resolveDeployment } from "../../react/src/deployment.ts";
import { DevTools, type Find, SidePanel } from "./side-panel.ts";

const here = fileURLToPath(new URL("../", import.meta.url));
const EXTENSION_ID = "pfdpnmmiemejphfghkalofichdcoandg";
const backend = process.env.CRITIQS_BACKEND ?? "";
if (backend === "") throw new Error("Set CRITIQS_BACKEND to a local Convex deployment with development sign-in.");
const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "critiqs-checklist-"));
process.once("exit", () => void rm(scratch, { recursive: true, force: true }));
const evidence = process.env.CRITIQS_EVIDENCE_DIR ?? join(scratch, "evidence");
await mkdir(join(evidence, "shots"), { recursive: true });

// Playwright is loaded from PLAYWRIGHT_CORE or installed for this run, so its types aren't available here.
type Page = any;
type Worker = any;

/** Chrome for Testing or Chromium: CHROME_PATH, or the newest Chromium Playwright installed. */
function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), ".cache/ms-playwright");
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((name) => join(cache, name, "chrome-linux64/chrome"))
    .find((path) => existsSync(path));
  if (found === undefined) throw new Error("Set CHROME_PATH to Chrome for Testing or Chromium (branded Chrome doesn't load unpacked extensions from the command line).");
  return found;
}

async function playwright() {
  let path = process.env.PLAYWRIGHT_CORE ?? "";
  if (path === "") {
    const tools = join(scratch, "tools");
    await mkdir(tools, { recursive: true });
    await Bun.write(join(tools, "package.json"), JSON.stringify({ private: true }));
    const installed = Bun.spawn(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1.57.0"], { cwd: tools, stdout: "ignore", stderr: "inherit" });
    if ((await installed.exited) !== 0) throw new Error("Couldn't install playwright-core; set PLAYWRIGHT_CORE.");
    path = join(tools, "node_modules/playwright-core");
  }
  return await import(join(path, "index.mjs"));
}

// ---------------------------------------------------------------------------
// Results

type Outcome = "pass" | "fail" | "not automatable";
interface Result {
  step: string;
  check: string;
  outcome: Outcome;
  measured: string;
  shots: string[];
}
const results: Result[] = [];
let shotCount = 0;

/** Runs one checklist step. `run` returns what was measured; a thrown error is a failure. */
async function step(id: string, check: string, run: (shots: string[]) => Promise<string | { outcome: Outcome; measured: string }>) {
  const shots: string[] = [];
  const started = Date.now();
  let result: Result;
  try {
    const answer = await run(shots);
    result = typeof answer === "string" ? { step: id, check, outcome: "pass", measured: answer, shots } : { step: id, check, ...answer, shots };
  } catch (error) {
    await shoot(`failed-${id}`, shots).catch(() => undefined);
    result = { step: id, check, outcome: "fail", measured: error instanceof Error ? error.message : String(error), shots };
  }
  results.push(result);
  console.log(`${result.outcome.toUpperCase().padEnd(15)} ${id.padEnd(4)} ${check} (${((Date.now() - started) / 1000).toFixed(1)} s)\n                ${result.measured}`);
}

// ---------------------------------------------------------------------------
// Test sites: HTTPS names on this computer, so their origins aren't ambiguous the way localhost is.

await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${scratch}/key.pem -out ${scratch}/cert.pem -days 2 -subj /CN=critiqs.test -addext ${"subjectAltName=DNS:*.critiqs.test"}`.quiet();
const elementScript = await Bun.file(join(here, "../critiqs/dist/element.js")).text();
const html = (text: string) => new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
let installedProject = "";
let sitesPort = 0;
const sites = Bun.serve({
  port: Number(process.env.CRITIQS_SITES_PORT ?? 0),
  hostname: "127.0.0.1",
  tls: { cert: Bun.file(`${scratch}/cert.pem`), key: Bun.file(`${scratch}/key.pem`) },
  fetch(request): Response {
    const { hostname, pathname } = new URL(request.url);
    if (pathname === "/element.js") return new Response(elementScript, { headers: { "content-type": "text/javascript" } });
    if (pathname === "/teal") return html(`<!doctype html><html><body style="margin:0;background:rgb(20,184,166)"></body></html>`);
    if (hostname === "installed.critiqs.test") {
      return html(`<!doctype html><html><head><title>Installed</title></head><body><h1>Installed</h1><critiqs-app project-id="${installedProject}" backend="${backend}"></critiqs-app><script type="module" src="/element.js"></script></body></html>`);
    }
    const title = hostname.split(".")[0]!.replace(/^\w/, (c) => c.toUpperCase());
    // A frame from another site, which only a real screenshot shows: a page's own capture can't read it.
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body { font: 16px system-ui; margin: 0; padding: 32px; background: #fff; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 24px; max-width: 520px; }
  button { font: inherit; padding: 8px 16px; }
</style></head><body>
  <h1>${title}</h1>
  <section><p>Members can invite others and change the team's name.</p>
    <button data-critiqs-id="team.save">Save changes</button>
    <iframe src="https://frame.critiqs.test:${sitesPort}/teal" style="display:block;margin-top:16px;width:280px;height:80px;border:0"></iframe></section>
</body></html>`);
  },
});
sitesPort = sites.port!;
const site = (name: string) => `https://${name}.critiqs.test:${sitesPort}`;

// ---------------------------------------------------------------------------
// The extension and Chrome

let extensionDir = process.env.CRITIQS_EXTENSION_DIR ?? "";
if (extensionDir === "") {
  extensionDir = join(scratch, "extension");
  // The real build, as a person loads it: no test hooks and no site granted at install.
  const built = Bun.spawn(["bun", "scripts/build.ts"], { cwd: here, env: { ...process.env, CRITIQS_TEST: "", CRITIQS_EXTENSION_OUT: extensionDir }, stderr: "inherit" });
  if ((await built.exited) !== 0) throw new Error("The extension didn't build.");
}
const manifest = await Bun.file(join(extensionDir, "manifest.json")).json();

const profile = join(scratch, "profile");
const chrome = Bun.spawn(
  [
    chromePath(),
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    // Lets DevTools run the extension's toolbar action (Extensions.triggerAction).
    "--enable-unsafe-extension-debugging",
    "--host-resolver-rules=MAP *.critiqs.test 127.0.0.1",
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,900",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
process.once("exit", () => chrome.kill());
let debugging = "";
for (let attempt = 0; attempt < 100 && debugging === ""; attempt++) {
  const port = await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => "");
  if (port.includes("\n")) debugging = `http://127.0.0.1:${port.split("\n")[0]}`;
  else await Bun.sleep(100);
}
if (debugging === "") throw new Error("Chrome didn't start.");

const { chromium } = await playwright();
const browser = await chromium.connectOverCDP(debugging);
const context = browser.contexts()[0];
const devtools = await DevTools.open((await (await fetch(`${debugging}/json/version`)).json()).webSocketDebuggerUrl);
const pageErrors: string[] = [];
context.on("page", (page: Page) => page.on("pageerror", (error: Error) => pageErrors.push(`${page.url()}: ${error.message}`)));

async function extensionWorker(): Promise<Worker> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const worker = context.serviceWorkers().find((candidate: Worker) => new URL(candidate.url()).host === EXTENSION_ID);
    if (worker !== undefined && (await worker.evaluate(() => typeof (globalThis as any).chrome?.sidePanel === "object").catch(() => false))) return worker;
    await Bun.sleep(100);
  }
  throw new Error(`Chrome didn't start the extension ${EXTENSION_ID}.`);
}
let worker: Worker = await extensionWorker();
/** Runs code in the extension's service worker, which Chrome may have stopped and started again since. */
async function inWorker<T, A>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  try {
    return await worker.evaluate(fn, arg);
  } catch {
    worker = await extensionWorker();
    return await worker.evaluate(fn, arg);
  }
}

const targets = async (): Promise<{ targetId: string; type: string; url: string }[]> => (await devtools.send("Target.getTargets", { filter: [{}] })).targetInfos;

interface Tab {
  page: Page;
  id: number;
}
/** Opens `url` in a new tab of the one window, in front, as a person does. */
async function openTab(url: string): Promise<Tab> {
  const page: Page = await context.newPage();
  await page.goto(url).catch(() => undefined);
  await page.bringToFront();
  const id: number = await inWorker(() => (globalThis as any).chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs: { id: number }[]) => tabs[0]!.id));
  return { page, id };
}

/** The click on the Critiqs icon for a tab: Chrome runs the extension's action as it does for the toolbar. */
async function clickIcon(tab: Tab) {
  await tab.page.bringToFront();
  const target = (await targets()).find((candidate) => candidate.type === "tab" && candidate.url === tab.page.url());
  if (target === undefined) throw new Error(`No tab target for ${tab.page.url()}.`);
  await devtools.send("Extensions.triggerAction", { id: EXTENSION_ID, targetId: target.targetId });
}

const panelTargets = async (tabId: number) => (await targets()).filter((target) => target.type === "page" && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/panel.html`) && new URL(target.url).searchParams.get("tab") === String(tabId));

/** The tab's side panel, once Chrome shows it. */
async function sidePanel(tab: Tab, timeoutMs = 10_000): Promise<SidePanel> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const [target] = await panelTargets(tab.id);
    if (target !== undefined) return await SidePanel.attach(debugging, target.targetId);
    await Bun.sleep(150);
  }
  throw new Error("Chrome didn't open the side panel.");
}

/** Closes the tab's side panel. Its X is Chrome's own button, which DevTools can't press; this closes the same panel. */
async function closePanel(tab: Tab) {
  for (const target of await panelTargets(tab.id)) await devtools.send("Target.closeTarget", { targetId: target.targetId });
  await waitUntil("the side panel to close", async () => (await panelTargets(tab.id)).length === 0, 10_000);
}

/** The page and the side panel beside it, as two images and one composed afterwards. */
let currentPanel: SidePanel | null = null;
let currentTab: Tab | null = null;
async function shoot(name: string, shots: string[]) {
  const file = `${String(++shotCount).padStart(2, "0")}-${name}`;
  if (currentTab !== null) await currentTab.page.screenshot({ path: join(evidence, "shots", `${file}.page.png`) }).catch(() => undefined);
  if (currentPanel !== null && !currentPanel.devtools.closed) {
    const image = await currentPanel.screenshot().catch(() => null);
    if (image !== null) await Bun.write(join(evidence, "shots", `${file}.panel.png`), image);
  }
  shots.push(file);
}

const pageRoots = (page: Page) => page.evaluate(() => document.querySelectorAll("critiqs-root").length);
const pins = (page: Page) => page.evaluate(() => [...document.querySelectorAll("critiqs-root")].reduce((count, host) => count + (host.shadowRoot?.querySelectorAll(".pin").length ?? 0), 0));
async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Moves the real mouse onto an element of the page until Comment mode outlines it, then clicks it. */
async function pick(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.mouse.move(box.x - 30, box.y + 60, { steps: 2 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    if (await page.evaluate(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".target-box") != null)) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Comment mode never outlined ${selector} on the page.`);
}

/** What Chrome says about the extension's access to a site: the extension's own answer, and the sites Details → Site access lists. */
async function siteAccess(pattern: string, shots?: string[]): Promise<{ active: boolean; listed: string[] }> {
  const active: boolean = await inWorker((origins: string[]) => (globalThis as any).chrome.permissions.contains({ origins }), [pattern]);
  const details = await openTab(`chrome://extensions/?id=${EXTENSION_ID}`);
  const info = await details.page.evaluate((id: string) => (globalThis as any).chrome.developerPrivate.getExtensionInfo(id), EXTENSION_ID);
  await Bun.sleep(1000);
  if (shots !== undefined) {
    const shown = { tab: currentTab, panel: currentPanel };
    focus(details, null);
    await shoot("site-access", shots);
    focus(shown.tab!, shown.panel);
  }
  await details.page.close();
  const listed = (info.permissions.runtimeHostPermissions?.hosts ?? []).filter((host: { granted: boolean }) => host.granted).map((host: { host: string }) => host.host);
  return { active, listed };
}

/** The colour, in the open comment's saved screenshot, of the page's point (x, y): what real pixels show there. */
async function threadPixel(at: { x: number; y: number; viewport: number }): Promise<number[] | null> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const pixel = await panel.evaluate(({ x, y, viewport }: { x: number; y: number; viewport: number }) => {
      const roots: ShadowRoot[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const element of Array.from(root.querySelectorAll("*"))) if (element.shadowRoot !== null) (roots.push(element.shadowRoot), walk(element.shadowRoot));
      };
      walk(document);
      const image = roots.map((root) => root.querySelector(".thread-window img") as HTMLImageElement | null).find((found) => found !== null && found.complete && found.naturalWidth > 0);
      if (image == null) return null;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const drawing = canvas.getContext("2d")!;
      drawing.drawImage(image, 0, 0);
      const scale = image.naturalWidth / viewport;
      return [...drawing.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
    }, at);
    if (pixel !== null) return pixel;
    await Bun.sleep(250);
  }
  return null;
}
const TEAL = "[20,184,166]";
/** Where the other site's frame is on the page: only a real screenshot shows its teal. */
const framePoint = (page: Page): Promise<{ x: number; y: number; viewport: number }> =>
  page.evaluate(() => {
    const { x, y, width, height } = document.querySelector("iframe")!.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2, viewport: window.innerWidth };
  });

const heading = (text: string): Find => ({ heading: text });
const button = (name: string | RegExp): Find => ({ button: name });

async function signIn(panel: SidePanel, email: string, name: string | null): Promise<string> {
  await panel.type({ field: "Email" }, email);
  await panel.click(button("Send code"));
  await panel.waitFor(heading("Check your email"));
  const code = /Development code: (\d+)/.exec(await panel.text())?.[1];
  if (code === undefined) throw new Error("The panel showed no development code; is development sign-in on for this backend?");
  await panel.type({ field: "Code" }, code);
  await panel.click(button("Continue"));
  if (name === null) return code;
  await panel.waitFor(heading("Choose your name"));
  await panel.type({ field: "Name" }, name);
  await panel.click(button("Continue"));
  return code;
}

/** Signs someone in through the sign-in service the way the side panel does, for data the checklist needs from a second person. */
async function signInDirectly(email: string, name: string): Promise<ConvexHttpClient> {
  const { signInUrl } = await resolveDeployment(backend);
  const client = panelSignIn(signInUrl, { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: `chrome-extension://${EXTENSION_ID}` } }) });
  const { attempt, developmentCode } = await client.sendCode(email);
  if (developmentCode === undefined) throw new Error("Development sign-in is off on this backend.");
  const checked = await client.checkCode(attempt, developmentCode);
  const signedIn = checked.status === "needs-name" ? await client.chooseName(attempt, name) : checked;
  const convex = new ConvexHttpClient(backend);
  convex.setAuth(signedIn.accessToken);
  return convex;
}

// ---------------------------------------------------------------------------
// The checklist

const stamp = Date.now();
const email = `dana+${stamp}@example.com`;
const chromeVersion: string = browser.version();
const proto: Tab = { page: null, id: -1 };
let panel: SidePanel = null as unknown as SidePanel;
const focus = (tab: Tab, side: SidePanel | null) => {
  currentTab = tab;
  currentPanel = side;
};

// A second person's organization, where the reviewer is an admin: step 19 lists its projects with the organization's name.
const erin = await signInDirectly(`erin+${stamp}@example.com`, "Erin Admin");
const erinProject = (await erin.mutation(api.projects.create, { name: "Erin's storefront", reviewUrl: null })) as string;
const erinOrganization = await erin.query(api.organizations.mine, {});
await erin.mutation(api.organizations.invite, { organizationId: erinOrganization[0]!.id, email, role: "admin" });

await step("0", "Before you start: Chrome shows the development ID, and Details → Site access says the extension has no access to sites", async (shots) => {
  const details = await openTab(`chrome://extensions/?id=${EXTENSION_ID}`);
  const info = await details.page.evaluate((id: string) => (globalThis as any).chrome.developerPrivate.getExtensionInfo(id), EXTENSION_ID);
  const granted = await inWorker(() => (globalThis as any).chrome.permissions.getAll());
  focus(details, null);
  await Bun.sleep(1000);
  await shoot("extension-details", shots);
  await details.page.close();
  const access = await siteAccess("<all_urls>");
  if (info.id !== EXTENSION_ID) throw new Error(`Chrome loaded the extension as ${info.id}.`);
  if (granted.origins.length > 0 || access.listed.length > 0) throw new Error(`The extension has site access at install: ${JSON.stringify(granted.origins)}.`);
  return `ID ${info.id}, version ${info.version}; Site access lists ${JSON.stringify(access.listed)}; granted origins ${JSON.stringify(granted.origins)}; permissions ${JSON.stringify(granted.permissions)}; Chrome ${chromeVersion}`;
});

await step("1", "Open the page and click the Critiqs icon: the side panel opens beside the page and shows Sign in to Critiqs", async (shots) => {
  Object.assign(proto, await openTab(site("proto")));
  await clickIcon(proto);
  panel = await sidePanel(proto);
  focus(proto, panel);
  await panel.waitFor(heading("Sign in to Critiqs"));
  const size = await panel.evaluate(() => [innerWidth, innerHeight]);
  await shoot("sign-in", shots);
  return `Chrome's side panel opened for the tab (panel.html?tab=${proto.id}, ${size[0]}×${size[1]} px) and shows Sign in to Critiqs; the page layer is on the page (${await pageRoots(proto.page)} critiqs-root)`;
});

let code = "";
await step("2", "Enter your email and choose Send code: Check your email, with the code shown by a local backend", async (shots) => {
  await panel.type({ field: "Email" }, email);
  await panel.click(button("Send code"));
  await panel.waitFor(heading("Check your email"));
  code = /Development code: (\d+)/.exec(await panel.text())?.[1] ?? "";
  await shoot("check-email", shots);
  if (code === "") throw new Error("No development code shown.");
  return `Check your email, development code ${code}`;
});

await step("3", "Enter the code, then a name on a first sign-in: the panel shows the project, or No project for this site yet", async (shots) => {
  await panel.type({ field: "Code" }, code);
  await panel.click(button("Continue"));
  await panel.waitFor(heading("Choose your name"));
  await shoot("choose-name", shots);
  await panel.type({ field: "Name" }, "Dana Reviewer");
  await panel.click(button("Continue"));
  await panel.waitFor(heading("No project for this site yet"));
  await shoot("no-project", shots);
  return "Choose your name, then No project for this site yet";
});

await step("4", "Start reviewing this site: Critiqs's panel shows with the site's name at the top and the toolbar at the bottom", async (shots) => {
  await panel.click(button("Start reviewing this site"));
  await panel.waitFor({ css: ".xt-title", text: `proto.critiqs.test:${sitesPort}` });
  await panel.waitFor(button("Comment mode"));
  const mockup = await panel.has(button("Mockup mode"));
  await shoot("review-panel", shots);
  return `Title "proto.critiqs.test:${sitesPort}", toolbar with Comment mode; Mockup mode button ${mockup ? "shown" : "absent"}`;
});

await step("5", "Choose Comment mode, then click an element on the page: it is outlined, and the new comment's box opens in the side panel", async (shots) => {
  await panel.click(button("Comment mode"));
  await waitUntil("Comment mode on the page", () => proto.page.evaluate(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".mode-hint") != null), 10_000);
  await pick(proto.page, '[data-critiqs-id="team.save"]');
  await panel.waitFor({ css: ".tag-field" }, 10_000);
  const outlined = await proto.page.evaluate(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".target-box") != null);
  await shoot("composing", shots);
  if (!outlined) throw new Error("The picked element isn't outlined on the page.");
  return "The button is outlined on the page; the comment box is open in the side panel";
});

await step("6", "Write a comment and choose Comment: a pin appears beside the element, and the comment opens in the side panel", async (shots) => {
  await panel.type({ css: ".tag-field" }, "Rename this to Save team");
  await panel.click(button("Comment"));
  await waitUntil("a pin on the page", async () => (await pins(proto.page)) === 1);
  await panel.waitFor({ css: ".thread-window" });
  const label = await proto.page.evaluate(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin")!.getAttribute("aria-label"));
  await shoot("comment-saved", shots);
  return `1 pin on the page ("${label}"); the comment is open in the side panel`;
});

await step("7", "The comment's screenshot is the page as on screen (real pixels), and no note about screenshots appears", async (shots) => {
  const frame = await framePoint(proto.page);
  const pixel = await threadPixel(frame);
  const note = await panel.has({ css: ".xt-notice" });
  await shoot("screenshot", shots);
  if (pixel === null) throw new Error("The comment's screenshot never loaded in the side panel.");
  const real = JSON.stringify(pixel) === TEAL;
  if (!real || note) throw new Error(`Pixel under the other site's frame ${JSON.stringify(pixel)} (teal is [20,184,166]); screenshot note ${note ? "shown" : "absent"}.`);
  return `The saved screenshot shows the cross-site frame's teal ${JSON.stringify(pixel)}, which only real pixels show; no screenshot note`;
});

await step("8", "Reload the page: the panel asks you to click the Critiqs icon on this page", async (shots) => {
  await proto.page.reload();
  await panel.waitFor(heading("Click the Critiqs icon on this page"), 15_000);
  const access = await inWorker((id: number) => (globalThis as any).chrome.scripting.executeScript({ target: { tabId: id }, func: () => 1 }).then(() => "still allowed", (error: Error) => `refused (${error.message})`), proto.id);
  await shoot("reload", shots);
  return `Click the Critiqs icon on this page. Chrome's access to the tab after the reload: ${access}`;
});

await step("9", "Click the Critiqs icon again: the pin comes back, and the panel shows the project again", async (shots) => {
  await clickIcon(proto);
  await panel.waitFor({ css: ".xt-title", text: `proto.critiqs.test:${sitesPort}` });
  await waitUntil("the pin again", async () => (await pins(proto.page)) === 1);
  await shoot("clicked-again", shots);
  return "The project's panel and 1 pin";
});

await step("10a", "Settings → Show comments here automatically: Chrome asks to allow Critiqs on this one site", async () => {
  return { outcome: "not automatable", measured: "Chrome shows its own permission prompt, which DevTools can't answer: a request from a real click in the side panel stays pending. 10b allows the site the way Details → Site access does instead, then turns the switch on." };
});

await step("10b", "Allow it: the switch stays on, and the page layer is registered for this one site", async (shots) => {
  const pattern = `${site("proto")}/*`;
  const extensions = await openTab("chrome://extensions");
  await extensions.page.evaluate(([id, host]: string[]) => (globalThis as any).chrome.developerPrivate.addHostPermission(id, host), [EXTENSION_ID, pattern]);
  await extensions.page.close();
  await proto.page.bringToFront();
  await panel.click(button("Settings"));
  await panel.click({ css: '[role="switch"]' });
  await panel.waitFor({ css: '[role="switch"][aria-checked="true"]' });
  await Bun.sleep(500);
  const on = await panel.has({ css: '[role="switch"][aria-checked="true"]' });
  const registered = await inWorker(() => (globalThis as any).chrome.scripting.getRegisteredContentScripts());
  await shoot("automatic-on", shots);
  const access = await siteAccess(pattern, shots);
  await proto.page.bringToFront();
  if (!on || !access.active) throw new Error(`The switch is ${on ? "on" : "off"}; permissions.contains is ${access.active}.`);
  return `The switch stays on; registered ${JSON.stringify(registered.map((script: { matches: string[] }) => script.matches))}; permissions.contains is true; Site access lists ${JSON.stringify(access.listed)}`;
});

await step("11", "With the side panel open, reload without clicking the icon and comment: the panel reconnects by itself and the comment saves; a screenshot Chrome refuses without a click falls back with a note shown once", async (shots) => {
  await panel.click({ css: ".xt-settings button[aria-label='Back']" }).catch(() => undefined);
  await proto.page.reload();
  await waitUntil("the pin after the reload", async () => (await pins(proto.page)) === 1);
  await panel.waitFor(button("Comment mode"));
  await panel.click(button("Comment mode"));
  await waitUntil("Comment mode on the page", () => proto.page.evaluate(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".mode-hint") != null), 10_000);
  await pick(proto.page, "h1");
  await panel.type({ css: ".tag-field" }, "A second comment after the reload");
  await panel.click(button("Comment"));
  await waitUntil("the second pin", async () => (await pins(proto.page)) === 2);
  const pixel = JSON.stringify(await threadPixel(await framePoint(proto.page)));
  const note = await panel.has({ css: ".xt-notice" });
  await shoot("reconnected", shots);
  const real = pixel === TEAL;
  // Chrome keeps the click's access through a reload of the same site, so the screenshot can still be real pixels; the note belongs only to the fallback.
  if (real === note) throw new Error(`Screenshot ${real ? "real pixels" : "from the page's own capture"} (${pixel} under the frame), and the note ${note ? "showed" : "didn't show"}.`);
  return `The panel reconnected by itself and the comment saved (2 pins). The screenshot is ${real ? `real pixels (${pixel} under the frame): Chrome kept the click's access through the same-site reload, so no note` : "the page's own capture, and the note showed once"}`;
});

await step("12", "Close the side panel and reload: pins show on the page without clicking the icon", async (shots) => {
  await closePanel(proto);
  panel.close();
  focus(proto, null);
  await proto.page.reload();
  await waitUntil("pins without the side panel", async () => (await pins(proto.page)) === 2);
  await shoot("pins-without-panel", shots);
  return "Closed through DevTools (its X is Chrome's own button); after the reload, 2 pins with no click";
});

await step("13", "Click a pin: write down what happens (the side panel opens, or nothing)", async (shots) => {
  const box = await proto.page.evaluate(() => {
    const pin = document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin")!.getBoundingClientRect();
    return { x: pin.x + pin.width / 2, y: pin.y + pin.height / 2 };
  });
  if ((await panelTargets(proto.id)).length > 0) throw new Error("A side panel was still open before the pin was clicked.");
  await proto.page.mouse.click(box.x, box.y);
  const opened = await sidePanel(proto, 5000).catch(() => null);
  if (opened !== null) {
    panel = opened;
    focus(proto, panel);
    await panel.waitFor({ css: ".thread-window" });
    await panel.waitFor({ css: ".xt-title", text: `proto.critiqs.test:${sitesPort}` });
    await waitUntil("the pins again", async () => (await pins(proto.page)) === 2);
  }
  await shoot("pin-clicked", shots);
  return opened === null ? "Nothing: Chrome didn't open the side panel from a click on a pin" : "The side panel opened on the pin's comment";
});

let listedAfterOff: string[] = [];
await step("14a", "Click the icon, turn the switch off, close the panel and reload: no pins until a click, and the extension no longer has the site", async (shots) => {
  await clickIcon(proto);
  panel = await sidePanel(proto);
  focus(proto, panel);
  await panel.click(button("Settings"));
  await panel.click({ css: '[role="switch"][aria-checked="true"]' });
  await panel.waitFor({ css: '[role="switch"][aria-checked="false"]' });
  await closePanel(proto);
  panel.close();
  focus(proto, null);
  await proto.page.reload();
  await Bun.sleep(2500);
  const roots = await pageRoots(proto.page);
  const registered = await inWorker(() => (globalThis as any).chrome.scripting.getRegisteredContentScripts());
  const access = await siteAccess(`${site("proto")}/*`, shots);
  listedAfterOff = access.listed;
  await proto.page.bringToFront();
  await shoot("automatic-off", shots);
  if (roots !== 0 || registered.length !== 0 || access.active) {
    throw new Error(`After turning it off: ${roots} critiqs-root, registered ${JSON.stringify(registered)}; permissions.contains is ${access.active}.`);
  }
  return "No page layer after the reload; nothing registered; permissions.contains is false for the site";
});

await step("14b", "…and chrome://extensions → Critiqs → Details → Site access no longer lists the site", async () => ({
  outcome: "not automatable",
  measured: `Details still lists ${JSON.stringify(listedAfterOff)} under "Automatically allow access on the following sites" (see the site-access screenshots in 10b and 14a). That list is the person's own Site access choice, which is how 10b had to allow the site in place of Chrome's prompt; Chrome keeps it when the extension gives the permission back. Whether a site allowed through the prompt leaves the list needs the prompt, so check this one by hand.`,
}));

await step("15", "A site with Critiqs installed: the panel says Built in, and only the site's own Critiqs is on the page", async (shots) => {
  const convex = new ConvexHttpClient(backend);
  const stored = await inWorker(() => (globalThis as any).chrome.storage.local.get(null));
  const session = Object.entries(stored as Record<string, { accessToken?: string }>).find(([key]) => key.startsWith("session:"))?.[1];
  convex.setAuth(session!.accessToken!);
  installedProject = (await convex.mutation(api.projects.create, { name: "Installed app", reviewUrl: null })) as string;
  await convex.mutation(api.projects.setAddresses, { projectId: installedProject as never, addresses: [site("installed")] });
  const installed = await openTab(site("installed"));
  await installed.page.waitForFunction(() => document.querySelector("critiqs-app") != null);
  await clickIcon(installed);
  panel = await sidePanel(installed);
  focus(installed, panel);
  await panel.waitFor(heading("Built in"));
  const roots = await pageRoots(installed.page);
  await shoot("built-in", shots);
  if (roots !== 1) throw new Error(`${roots} critiqs-root on the page.`);
  return "Built in; 1 critiqs-root on the page (the site's own)";
});

await step("16", "chrome://extensions: the panel says Critiqs can't open here", async (shots) => {
  const extensions = await openTab("chrome://extensions");
  await clickIcon(extensions);
  panel = await sidePanel(extensions);
  focus(extensions, panel);
  await panel.waitFor(heading("Critiqs can't open here"));
  await shoot("cant-open-here", shots);
  return "Critiqs can't open here";
});

await step("17", "Back on the first page, Settings → Sign out, then sign in again with the same email: no name step", async (shots) => {
  await clickIcon(proto);
  panel = await sidePanel(proto);
  focus(proto, panel);
  await panel.click(button("Settings"));
  await panel.click(button("Sign out"));
  await panel.waitFor(heading("Sign in to Critiqs"));
  await shoot("signed-out", shots);
  await signIn(panel, email, null);
  await panel.waitFor({ css: ".xt-title", text: `proto.critiqs.test:${sitesPort}` });
  await shoot("signed-in-again", shots);
  return "Sign in to Critiqs after signing out; signing in again went from the code straight to the project";
});

await step("18", "Press Alt+Shift+C on a page: same as clicking the icon", async (shots) => {
  const shortcut = await openTab(site("shortcut"));
  focus(shortcut, null);
  const commands = await inWorker(() => (globalThis as any).chrome.commands.getAll());
  await shortcut.page.keyboard.press("Alt+Shift+C");
  const opened = await sidePanel(shortcut, 4000).catch(() => null);
  await shoot("shortcut", shots);
  const assigned = commands.find((command: { name: string }) => command.name === "_execute_action")?.shortcut ?? "";
  if (opened !== null) return `The side panel opened; shortcut "${assigned}"`;
  return {
    outcome: "not automatable",
    measured: `DevTools key events go to the page, not to Chrome's own shortcuts: the key press opened nothing. Chrome reports the action's shortcut as "${assigned}"${assigned === "" ? " (unassigned in this Chrome for Testing profile)" : ""}.`,
  };
});

const other: Tab = { page: null, id: -1 };
await step("19", "A second site no project lists: Add to a project lists your projects and your organizations' projects, named by organization; the choice sticks", async (shots) => {
  Object.assign(other, await openTab(site("other")));
  await clickIcon(other);
  panel = await sidePanel(other);
  focus(other, panel);
  await panel.waitFor(heading("No project for this site yet"));
  await panel.click(button("Add to a project"));
  await panel.waitFor(heading("Add this site to a project"));
  await panel.waitFor({ css: ".ds-nav-row", text: "Erin's storefront" });
  const rows = await panel.evaluate(() => {
    const out: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (element.matches(".ds-nav-row")) out.push((element.textContent ?? "").replace(/\s+/g, " ").trim());
        if (element.shadowRoot !== null) walk(element.shadowRoot);
      }
    };
    walk(document);
    return out;
  });
  await shoot("add-to-project", shots);
  await panel.click({ css: ".ds-nav-row", text: "Erin's storefront" });
  await panel.waitFor({ css: ".xt-title", text: "Erin's storefront" });
  await closePanel(other);
  panel.close();
  await clickIcon(other);
  panel = await sidePanel(other);
  focus(other, panel);
  await panel.waitFor({ css: ".xt-title", text: "Erin's storefront" });
  await shoot("added", shots);
  const mine = rows.filter((row) => row.includes("proto.critiqs.test") || row.includes("Installed app"));
  const named = rows.some((row) => row.includes(erinOrganization[0]!.name));
  if (mine.length < 2 || !named) throw new Error(`Rows: ${JSON.stringify(rows)}`);
  return `Rows ${JSON.stringify(rows)}; chose Erin's storefront (project ${erinProject}); reopening the panel shows it again`;
});

let copied = "";
await step("20", "Comment, then choose ⋯ → Copy link on the comment: with a website set up for the deployment, it copies the thread's page link", async (shots) => {
  const { website } = await resolveDeployment(backend);
  await panel.click(button("Comment mode"));
  await waitUntil("Comment mode on the page", () => other.page.evaluate(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".mode-hint") != null), 10_000);
  await pick(other.page, '[data-critiqs-id="team.save"]');
  await panel.type({ css: ".tag-field" }, "Share this with the client");
  await panel.click(button("Comment"));
  await panel.waitFor({ css: ".thread-window" });
  // The comment's window grows upward when its screenshot loads, moving ⋯ to where the screenshot then is.
  await waitUntil("the comment's screenshot", () =>
    panel.evaluate(() => {
      const images: HTMLImageElement[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const element of Array.from(root.querySelectorAll("*"))) if (element.shadowRoot !== null) walk(element.shadowRoot);
        images.push(...(Array.from(root.querySelectorAll(".thread-window img")) as HTMLImageElement[]));
      };
      walk(document);
      return images.some((image) => image.complete && image.naturalWidth > 0);
    }),
  );
  await devtools.send("Browser.grantPermissions", { origin: `chrome-extension://${EXTENSION_ID}`, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await panel.click(button("More actions"));
  await panel.click(button("Copy link"));
  await waitUntil("the copied note", async () => (await panel.text()).includes("Link to thread copied"), 10_000);
  copied = await panel.evaluate(() => navigator.clipboard.readText());
  await shoot("copy-link", shots);
  if (website === undefined) return { outcome: "fail", measured: `The backend reports no website, so Copy link copied the prototype's link: ${copied}` };
  if (!new RegExp(`^${website.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/t/[A-Za-z0-9_-]+$`).test(copied)) throw new Error(`Copied "${copied}", not ${website}/t/<key>.`);
  return `"Link to thread copied"; the clipboard holds ${copied}`;
});

await step("20b", "The copied link opens the thread's page on the website", async (shots) => {
  if (copied === "") throw new Error("Nothing was copied in step 20.");
  const page = await context.newPage();
  await page.goto(copied);
  await page.bringToFront();
  focus({ page, id: -1 }, null);
  await page.getByRole("button", { name: "Sign in with email" }).waitFor({ timeout: 15_000 });
  await shoot("thread-page-signed-out", shots);
  // The page asks who is visiting, in Critiqs's sign-in window: the reviewer signs in with the same email.
  const opened = context.waitForEvent("page", { timeout: 10_000 });
  await page.getByRole("button", { name: "Sign in with email" }).click();
  const popup: Page = await opened;
  await popup.locator("input[name=email]").fill(email);
  await popup.getByRole("button", { name: /Send code/ }).click();
  await popup.locator("input[name=code]").waitFor();
  const popupCode = /Development code:\s*(\d+)/.exec(await popup.locator("body").innerText())?.[1] ?? "";
  await popup.locator("input[name=code]").fill(popupCode);
  await popup.locator("input[name=code]").press("Enter");
  for (let attempt = 0; attempt < 20 && !popup.isClosed(); attempt++) {
    const allow = popup.getByRole("button", { name: /^(Allow this site|Allow|Continue)/ });
    if ((await allow.count().catch(() => 0)) > 0) await allow.first().click().catch(() => undefined);
    await Bun.sleep(500);
  }
  await page.getByText("Share this with the client").first().waitFor({ timeout: 20_000 });
  await Bun.sleep(1000);
  await shoot("thread-page", shots);
  return `Opened ${copied}: Sign in to see this comment; after the reviewer signed in with the same email, the page shows the comment "Share this with the client"`;
});

await step("–", "No page errors in any tab during the run", async () => {
  if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
  return "None";
});

// ---------------------------------------------------------------------------
// Report

await browser.close().catch(() => undefined);
chrome.kill();
sites.stop();

// Each screenshot pair side by side, the page on the left and the side panel on the right, as Chrome shows them.
const composer = await chromium.launch({ executablePath: chromePath(), headless: true });
const sheet = await composer.newPage({ viewport: { width: 1800, height: 900 } });
for (const result of results) {
  for (const shot of result.shots) {
    const read = async (path: string) => ((await Bun.file(path).exists()) ? `data:image/png;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}` : null);
    const [left, right] = await Promise.all([read(join(evidence, "shots", `${shot}.page.png`)), read(join(evidence, "shots", `${shot}.panel.png`))]);
    if (left === null && right === null) continue;
    await sheet.setContent(`<body style="margin:0;background:#d4d4d8;display:flex;gap:2px;align-items:flex-start;width:max-content">${left === null ? "" : `<img src="${left}">`}${right === null ? "" : `<img src="${right}">`}</body>`);
    await sheet.locator("body").screenshot({ path: join(evidence, `${shot}.png`) });
  }
}
await composer.close();

const count = (outcome: Outcome) => results.filter((result) => result.outcome === outcome).length;
const counts = { pass: count("pass"), fail: count("fail"), "not automatable": count("not automatable") };
const commit = (await Bun.$`git -C ${here} rev-parse --short HEAD`.nothrow().quiet()).stdout.toString().trim();
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const report = [
  "# Critiqs extension: the manual test, run in real Chrome",
  "",
  `Commit ${commit}; extension ${manifest.version} from ${process.env.CRITIQS_EXTENSION_DIR ? extensionDir : "this checkout (real build)"}; ${chromeVersion}; backend ${backend}; ${new Date().toISOString()}.`,
  `Result: ${counts.pass} pass, ${counts.fail} fail, ${counts["not automatable"]} not automatable.`,
  "",
  "| Step | Check | Result | Measured | Screenshots |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((result) => `| ${result.step} | ${cell(result.check)} | ${result.outcome} | ${cell(result.measured)} | ${result.shots.map((shot) => `[${shot}](${shot}.png)`).join(" ")} |`),
  "",
].join("\n");
await Bun.write(join(evidence, "results.md"), report);
await Bun.write(join(evidence, "results.json"), `${JSON.stringify({ commit, chrome: chromeVersion, extension: manifest.version, results }, null, 2)}\n`);
console.log(`\n${counts.pass} pass, ${counts.fail} fail, ${counts["not automatable"]} not automatable. Results: ${join(evidence, "results.md")}`);
process.exit(counts.fail > 0 ? 1 : 0);
