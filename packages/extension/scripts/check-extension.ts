// The unpacked extension in Chrome for Testing, against a local Convex
// deployment: sign-in in the panel, the project lookup with one, several, and
// no projects, Start reviewing this site, Add to a project, a comment with its
// pin, Built in on a page with Critiqs installed, comments shown
// automatically on a later visit, sign-out, and the screenshot fallback.
//
// Automation can't click the toolbar icon or open Chrome's side panel, so a
// test build (CRITIQS_TEST=1) stands in for the click: it grants this run's
// test sites at install (a real build asks for no site at install) and lets
// the run call the worker's own click handler, which adds the page layer to
// the tab. The side panel's page is opened in a window of its own, at side
// panel width, for that tab. What this doesn't cover: the toolbar click
// itself, Chrome's side panel frame, and the access Chrome grants for a
// click (activeTab). The manual test script covers those.
//
// Needs: CRITIQS_BACKEND, a local Convex deployment with development sign-in
// (`bun run setup:local` in packages/backend) and CRITIQS_EXTENSION_IDS
// listing the development ID; CHROME_PATH (Chrome for Testing);
// PLAYWRIGHT_CORE, the path of a playwright-core package. CRITIQS_EVIDENCE_DIR
// keeps screenshots.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "@critiqs/backend/api";
import { ConvexHttpClient } from "convex/browser";
import type { GenericId as Id } from "convex/values";

const here = fileURLToPath(new URL("../", import.meta.url));
const backend = process.env.CRITIQS_BACKEND ?? "";
const chromePath = process.env.CHROME_PATH ?? "";
const playwrightPath = process.env.PLAYWRIGHT_CORE ?? "";
assert.ok(backend !== "" && chromePath !== "" && playwrightPath !== "", "Set CRITIQS_BACKEND, CHROME_PATH, and PLAYWRIGHT_CORE.");
const evidence = process.env.CRITIQS_EVIDENCE_DIR ?? "";
const EXTENSION_ID = "pfdpnmmiemejphfghkalofichdcoandg";
const { chromium } = await import(join(playwrightPath, "index.mjs"));

// Playwright is loaded from PLAYWRIGHT_CORE, so its types aren't available here.
type Page = any;
type Worker = any;
type Context = any;

const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "critiqs-extension-"));
process.once("exit", () => void rm(scratch, { recursive: true, force: true }));

// The test sites: HTTPS names on this computer, so their origins aren't ambiguous the way localhost is.
await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${scratch}/key.pem -out ${scratch}/cert.pem -days 2 -subj /CN=critiqs.test -addext ${"subjectAltName=DNS:*.critiqs.test"}`.quiet();
const elementScript = await Bun.file(join(here, "../critiqs/dist/element.js")).text();
const html = (text: string) => new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
const prototypePage = (title: string, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body { font: 16px system-ui; margin: 0; padding: 32px; background: #fff; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 24px; max-width: 520px; }
  button { font: inherit; padding: 8px 16px; }
</style></head><body>
  <h1>${title}</h1>
  <section><p>Members can invite others and change the team's name.</p>
    <button data-critiqs-id="team.save">Save changes</button>${extra}</section>
</body></html>`;
let installedProject = "";
let sitesPort = 0;
const sites = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  tls: { cert: Bun.file(`${scratch}/cert.pem`), key: Bun.file(`${scratch}/key.pem`) },
  fetch(request): Response {
    const { hostname, pathname } = new URL(request.url);
    if (pathname === "/element.js") return new Response(elementScript, { headers: { "content-type": "text/javascript" } });
    if (hostname === "installed.critiqs.test") {
      return html(`<!doctype html><html><body><h1>Installed</h1><critiqs-app project-id="${installedProject}" backend="${backend}"></critiqs-app><script type="module" src="/element.js"></script></body></html>`);
    }
    // A frame from another site, which only real pixels show: a page's own capture can't read it.
    const frame = hostname === "pixels.critiqs.test" ? `<iframe src="https://frame.critiqs.test:${sitesPort}/teal" style="display:block;margin-top:16px;width:280px;height:80px;border:0"></iframe>` : "";
    if (pathname === "/teal") return html(`<!doctype html><html><body style="margin:0;background:rgb(20,184,166)"></body></html>`);
    return html(prototypePage(hostname.split(".")[0]!.replace(/^\w/, (c) => c.toUpperCase()), frame));
  },
});
sitesPort = sites.port!;
const local = Bun.serve({ port: 0, hostname: "localhost", fetch: () => html(prototypePage("Local app")) });
const site = (name: string) => `https://${name}.critiqs.test:${sites.port}`;
const LOCAL = `http://localhost:${local.port}`;

async function build(out: string, hosts: string[]) {
  const built = Bun.spawn(["bun", "scripts/build.ts"], {
    cwd: here,
    env: { ...process.env, CRITIQS_TEST: "1", CRITIQS_TEST_HOSTS: hosts.join(","), CRITIQS_EXTENSION_OUT: out },
    stderr: "inherit",
  });
  assert.equal(await built.exited, 0, "the test build should succeed");
}

const shot = async (page: Page, name: string) => {
  if (evidence === "") return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`) });
};

async function launch(extension: string) {
  const context: Context = await chromium.launchPersistentContext(join(scratch, `profile-${Date.now()}`), {
    executablePath: chromePath,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--host-resolver-rules=MAP *.critiqs.test 127.0.0.1", "--ignore-certificate-errors"],
    viewport: { width: 1000, height: 760 },
  });
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  assert.equal(new URL(worker.url()).host, EXTENSION_ID, "Chrome should load the extension under its development ID");
  const errors: string[] = [];
  context.on("page", (page: Page) => page.on("pageerror", (error: Error) => errors.push(`${page.url()}: ${error.message}`)));
  return { context, worker, errors };
}

/** A tab with `url` in a window of its own, and its tab ID. */
async function openTab(context: Context, worker: Worker, url: string): Promise<{ page: Page; tabId: number }> {
  const opened = context.waitForEvent("page");
  const tabId = await worker.evaluate(async (address: string) => {
    const created = await (globalThis as any).chrome.windows.create({ url: address, focused: true });
    return created.tabs[0].id as number;
  }, url);
  const page: Page = await opened;
  await page.waitForLoadState("load");
  return { page, tabId };
}

/** What clicking the Critiqs icon does in the page: the worker's own handler adds the page layer. */
const click = (worker: Worker, tabId: number) => worker.evaluate((id: number) => (globalThis as any).critiqsTest.addPageLayer(id), tabId);

/** Each tab's open panel: Chrome shows one side panel per tab. */
const panels = new Map<number, Page>();

/** The side panel's page for the tab, at side panel width, in a window of its own. */
async function openPanel(context: Context, worker: Worker, tabId: number): Promise<Page> {
  const open = panels.get(tabId);
  if (open !== undefined && !open.isClosed()) await open.close();
  const { page } = await openTab(context, worker, `chrome-extension://${EXTENSION_ID}/panel.html?tab=${tabId}`);
  panels.set(tabId, page);
  await page.setViewportSize({ width: 380, height: 720 });
  return page;
}

/** Brings the reviewed tab's window to the front, as it is beside a real side panel. */
const front = (worker: Worker, tabId: number) =>
  worker.evaluate(async (id: number) => {
    const chrome = (globalThis as any).chrome;
    const tab = await chrome.tabs.get(id);
    await chrome.windows.update(tab.windowId, { focused: true });
  }, tabId);

async function expectHeading(panel: Page, text: string) {
  try {
    await panel.locator("h1", { hasText: text }).first().waitFor({ timeout: 20_000 });
  } catch (error) {
    await shot(panel, `failed-${text.replace(/\W+/g, "-")}`);
    throw new Error(`Expected "${text}"; the panel shows: ${await panel.evaluate(() => document.querySelector("critiqs-root")?.shadowRoot?.textContent)}`, { cause: error });
  }
}

async function signIn(panel: Page, email: string, name: string | null) {
  await expectHeading(panel, "Sign in to Critiqs");
  await shot(panel, name === null ? "sign-in-returning-1-email" : "sign-in-1-email");
  await panel.getByLabel("Email").fill(email);
  await panel.getByRole("button", { name: "Send code" }).click();
  await expectHeading(panel, "Check your email");
  const code = /\d+/.exec((await panel.getByText(/Development code:/).textContent()) ?? "")![0];
  await shot(panel, name === null ? "sign-in-returning-2-code" : "sign-in-2-code");
  await panel.getByLabel("Code").fill(code);
  await panel.getByRole("button", { name: "Continue" }).click();
  if (name === null) return;
  await expectHeading(panel, "Choose your name");
  await panel.getByLabel("Name").fill(name);
  await shot(panel, "sign-in-3-name");
  await panel.getByRole("button", { name: "Continue" }).click();
}

/** Waits for Critiqs's own panel on the chosen project. */
async function expectReview(panel: Page, project: string) {
  await panel.locator(".xt-title", { hasText: project }).waitFor({ timeout: 20_000 });
  await panel.getByRole("button", { name: "Comment mode" }).waitFor({ timeout: 20_000 });
}

/** Moves the real mouse onto an element of the page until Comment mode outlines it, then picks it. */
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
  throw new Error(`Comment mode never outlined ${selector}.`);
}

async function comment(panel: Page, page: Page, worker: Worker, tabId: number, text: string) {
  await panel.getByRole("button", { name: "Comment mode" }).click();
  await page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".mode-hint") != null, undefined, { timeout: 10_000 });
  await front(worker, tabId);
  await pick(page, '[data-critiqs-id="team.save"]');
  const field = panel.locator(".tag-field");
  await field.waitFor({ timeout: 10_000 });
  await field.click();
  await field.pressSequentially(text);
  await shot(panel, "review-2-composing");
  await front(worker, tabId);
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".pin") != null, undefined, { timeout: 20_000 });
}

const pinCount = (page: Page) => page.evaluate(() => [...document.querySelectorAll("critiqs-root")].reduce((count, host) => count + (host.shadowRoot?.querySelectorAll(".pin").length ?? 0), 0));

async function convexAs(worker: Worker) {
  const items = await worker.evaluate(() => (globalThis as any).chrome.storage.local.get(null));
  const session = Object.entries(items as Record<string, { accessToken?: string }>).find(([key]) => key.startsWith("session:"))?.[1];
  assert.ok(session?.accessToken, "the session should be kept in the extension's storage");
  const client = new ConvexHttpClient(backend);
  client.setAuth(session.accessToken);
  return client;
}

const results: string[] = [];
const note = (line: string) => {
  results.push(line);
  console.log(line);
};

const extensionDir = join(scratch, "extension");
await build(extensionDir, ["https://*.critiqs.test/*", "http://localhost/*"]);
const email = `dana+${Date.now()}@example.com`;

try {
  // Part 1: one site grant per test site, so screenshots fall back to the page's own capture.
  const { context, worker, errors } = await launch(extensionDir);
  try {
    // A site no project lists.
    const fresh = await openTab(context, worker, site("fresh"));
    await click(worker, fresh.tabId);
    let panel = await openPanel(context, worker, fresh.tabId);
    await signIn(panel, email, "Dana Reviewer");
    await expectHeading(panel, "No project for this site yet");
    await shot(panel, "lookup-none");
    note("Sign-in in the panel: email, code, and a name on a first sign-in; then the lookup found no project for the site.");

    await panel.getByRole("button", { name: "Start reviewing this site" }).click();
    await expectReview(panel, `fresh.critiqs.test:${sites.port}`);
    await shot(panel, "review-1-panel");
    const convex = await convexAs(worker);
    const mine = (await convex.query(api.projects.manageable, {})).projects;
    const started = mine.find((project: { name: string }) => project.name === `fresh.critiqs.test:${sites.port}`)!;
    assert.deepEqual(await convex.query(api.projects.addresses, { projectId: started._id as Id<"projects"> }), [site("fresh")]);
    note(`Start reviewing this site: created "${started.name}" with the address list [${site("fresh")}].`);
    // The panel kept its start key only until the start finished.
    const leftover = Object.keys(await worker.evaluate(() => (globalThis as any).chrome.storage.local.get(null))).filter((key) => key.startsWith("start:"));
    assert.deepEqual(leftover, []);
    // A create retried with its key, as after a lost response, returns the same project on this backend.
    const retryKey = `start-${crypto.randomUUID()}`;
    const once = await convex.mutation(api.projects.create, { name: "Retried start", reviewUrl: null, idempotencyKey: retryKey });
    const again = await convex.mutation(api.projects.create, { name: "Retried start", reviewUrl: null, idempotencyKey: retryKey });
    assert.equal(again, once);
    assert.equal((await convex.query(api.projects.manageable, {})).projects.filter((project: { name: string }) => project.name === "Retried start").length, 1);
    note(`Keyed create: sent twice with one key, it returned the same project (${once}); the panel left no pending start key behind.`);

    // Mockup mode draws over the page, which a side panel can't: it isn't offered.
    assert.equal(await panel.getByRole("button", { name: "Mockup mode" }).count(), 0);
    await comment(panel, fresh.page, worker, fresh.tabId, "Rename this to Save team");
    const pinLabel = await fresh.page.evaluate(() => document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".pin")!.getAttribute("aria-label"));
    assert.equal(pinLabel, "Open comment by Dana Reviewer");
    await panel.locator(".thread-window").waitFor({ timeout: 10_000 });
    await panel.locator(".xt-notice").waitFor({ timeout: 10_000 });
    await shot(panel, "review-3-thread-and-screenshot-note");
    await shot(fresh.page, "page-with-pin");
    note("Comment: picked the button in the tab, wrote the comment in the panel; its pin shows on the page. No Mockup mode button.");
    note(`Screenshot fallback: Chrome refused captureVisibleTab without a click, so the page's own capture was used, and the panel said once: "${(await panel.locator(".xt-notice span").textContent())!.trim()}"`);

    // Comments shown automatically: on, then a later visit with no panel open.
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await panel.getByRole("switch").click();
    await panel.locator('[role="switch"][aria-checked="true"]').waitFor({ timeout: 10_000 });
    await Bun.sleep(400);
    await shot(panel, "settings-automatic-on");
    await panel.close();
    await fresh.page.reload();
    await fresh.page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".pin") != null, undefined, { timeout: 20_000 });
    await shot(fresh.page, "later-visit-pins-without-panel");
    note(`Show comments here automatically: a later visit with no side panel open shows ${await pinCount(fresh.page)} pin with no click.`);

    // The panel opens again on that page: it takes over the page layer.
    panel = await openPanel(context, worker, fresh.tabId);
    await expectReview(panel, `fresh.critiqs.test:${sites.port}`);
    await fresh.page.waitForFunction(() => document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".pin") != null, undefined, { timeout: 20_000 });
    assert.equal(await pinCount(fresh.page), 1, "the panel's page layer replaces the one drawing pins alone");
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await panel.getByRole("switch").click();
    await panel.locator('[role="switch"][aria-checked="false"]').waitFor({ timeout: 10_000 });
    const registered = await worker.evaluate(() => (globalThis as any).chrome.scripting.getRegisteredContentScripts());
    assert.deepEqual(registered, [], "turning it off removes the site's script");
    await panel.close();
    await fresh.page.reload();
    await Bun.sleep(2500);
    assert.equal(await fresh.page.evaluate(() => document.querySelectorAll("critiqs-root").length), 0);
    note("Turned off: the registered script is gone, and the next visit shows nothing until a click.");

    // Projects for the other scenarios, made as the same reviewer.
    const create = async (name: string, addresses: string[]) => {
      const id = (await convex.mutation(api.projects.create, { name, reviewUrl: null })) as Id<"projects">;
      await convex.mutation(api.projects.setAddresses, { projectId: id, addresses });
      return id;
    };
    const acme = await create("Acme prototype", [site("proto")]);
    await create("Checkout (web)", [site("several")]);
    await create("Checkout (mobile web)", [site("several")]);
    await create("Local app", [LOCAL]);
    installedProject = await create("Installed app", [site("installed")]);

    // One project.
    const proto = await openTab(context, worker, site("proto"));
    await click(worker, proto.tabId);
    panel = await openPanel(context, worker, proto.tabId);
    await expectReview(panel, "Acme prototype");
    await shot(panel, "lookup-one");
    note("Lookup, one project: shown directly (Acme prototype).");

    // Several projects: asked, and the answer remembered for this person and origin.
    const several = await openTab(context, worker, site("several"));
    await click(worker, several.tabId);
    panel = await openPanel(context, worker, several.tabId);
    await expectHeading(panel, "Which project is this?");
    await shot(panel, "lookup-several");
    const offered = await panel.locator(".ds-nav-row .label").allTextContents();
    assert.deepEqual(offered, ["Checkout (mobile web)", "Checkout (web)"]);
    await panel.getByRole("button", { name: /Checkout \(web\)/ }).click();
    await expectReview(panel, "Checkout (web)");
    await panel.reload();
    await expectReview(panel, "Checkout (web)");
    // The remembered answer can be changed: Settings offers the projects it was chosen among.
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await panel.locator(".xt-settings .ds-nav-row", { hasText: "Checkout (web)" }).click();
    await expectHeading(panel, "Which project is this?");
    note(`Lookup, several projects: asked among [${offered.join(", ")}]; the answer was remembered when the panel opened again.`);

    // An ambiguous origin (this computer) asks even for one match.
    const localTab = await openTab(context, worker, LOCAL);
    await click(worker, localTab.tabId);
    panel = await openPanel(context, worker, localTab.tabId);
    await expectHeading(panel, "Which project is this?");
    assert.deepEqual(await panel.locator(".ds-nav-row .label").allTextContents(), ["Local app"]);
    await shot(panel, "lookup-ambiguous");
    note(`Lookup, ambiguous origin ${LOCAL}: asked, though one project lists it.`);

    // Add to a project.
    const other = await openTab(context, worker, site("other"));
    await click(worker, other.tabId);
    panel = await openPanel(context, worker, other.tabId);
    await expectHeading(panel, "No project for this site yet");
    await panel.getByRole("button", { name: "Add to a project" }).click();
    await expectHeading(panel, "Add this site to a project");
    await panel.locator(".ds-nav-row", { hasText: "Acme prototype" }).waitFor();
    await shot(panel, "add-to-project");
    await panel.locator(".ds-nav-row", { hasText: "Acme prototype" }).click();
    await expectReview(panel, "Acme prototype");
    assert.deepEqual(await convex.query(api.projects.addresses, { projectId: acme }), [site("proto"), site("other")]);
    note(`Add to a project: Acme prototype now lists [${site("proto")}, ${site("other")}].`);
    // Two panels adding at once, against the real backend: both addresses stay.
    const second = await convexAs(worker);
    await Promise.all([
      convex.mutation(api.projects.addAddress, { projectId: acme, address: site("one") }),
      second.mutation(api.projects.addAddress, { projectId: acme, address: site("two") }),
    ]);
    const afterBoth = await convex.query(api.projects.addresses, { projectId: acme });
    assert.deepEqual([...afterBoth].sort(), [site("one"), site("other"), site("proto"), site("two")].sort());
    note(`Two concurrent adds from separate clients: Acme prototype lists [${afterBoth.join(", ")}].`);

    // Built in.
    const installed = await openTab(context, worker, site("installed"));
    await installed.page.waitForFunction(() => document.querySelector("critiqs-app") != null);
    await click(worker, installed.tabId);
    panel = await openPanel(context, worker, installed.tabId);
    await expectHeading(panel, "Built in");
    await shot(panel, "built-in");
    assert.equal(await installed.page.evaluate(() => document.querySelectorAll("critiqs-root").length), 1, "only the site's own Critiqs is on the page");
    note("Built in: the page with Critiqs installed got no page layer from the extension, and the panel says Built in.");

    // Sign out, then sign in again as a returning reviewer (no name step).
    panel = await openPanel(context, worker, proto.tabId);
    await expectReview(panel, "Acme prototype");
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await shot(panel, "settings");
    await panel.getByRole("button", { name: "Sign out" }).click();
    await expectHeading(panel, "Sign in to Critiqs");
    // The session leaves storage once any renewal under way has finished.
    let kept = true;
    for (let attempt = 0; attempt < 50 && kept; attempt++) {
      const items = await worker.evaluate(() => (globalThis as any).chrome.storage.local.get(null));
      kept = Object.keys(items).some((key) => key.startsWith("session:"));
      if (kept) await Bun.sleep(100);
    }
    assert.equal(kept, false, "signing out removes the session");
    await signIn(panel, email, null);
    await expectReview(panel, "Acme prototype");
    note("Sign-out removed the session from the extension; signing in again skipped the name step.");
    // An address Chrome won't let an extension use.
    const blocked = await openTab(context, worker, "chrome://version");
    await click(worker, blocked.tabId);
    panel = await openPanel(context, worker, blocked.tabId);
    await expectHeading(panel, "Critiqs can't open here");
    await shot(panel, "unsupported-page");
    note("A chrome:// page: the panel says Critiqs can't open there.");
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await context.close();
  }

  // Part 2: with every site allowed (Chrome's "On all sites"), screenshots are real pixels.
  const allSites = join(scratch, "extension-all-sites");
  await build(allSites, ["<all_urls>"]);
  const second = await launch(allSites);
  try {
    const pixels = await openTab(second.context, second.worker, site("pixels"));
    await click(second.worker, pixels.tabId);
    const panel = await openPanel(second.context, second.worker, pixels.tabId);
    await signIn(panel, email, null);
    await expectHeading(panel, "No project for this site yet");
    await panel.getByRole("button", { name: "Start reviewing this site" }).click();
    await expectReview(panel, `pixels.critiqs.test:${sites.port}`);
    await comment(panel, pixels.page, second.worker, pixels.tabId, "Real pixels");
    const image = panel.locator(".thread-window img");
    await image.waitFor({ timeout: 20_000 });
    await panel.waitForFunction(() => {
      const shadow = document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".xt-review critiqs-root")!.shadowRoot!;
      return (shadow.querySelector(".thread-window img") as HTMLImageElement | null)?.complete === true;
    }, undefined, { timeout: 20_000 });
    const frameBox = await pixels.page.evaluate(() => {
      const { x, y, width, height } = document.querySelector("iframe")!.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2, viewport: window.innerWidth };
    });
    const pixel = await panel.evaluate(({ x, y, viewport }: { x: number; y: number; viewport: number }) => {
      const shadow = document.querySelector("critiqs-root")!.shadowRoot!.querySelector(".xt-review critiqs-root")!.shadowRoot!;
      const img = shadow.querySelector(".thread-window img") as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const drawing = canvas.getContext("2d")!;
      drawing.drawImage(img, 0, 0);
      const scale = img.naturalWidth / viewport;
      return [...drawing.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
    }, frameBox);
    assert.deepEqual(pixel, [20, 184, 166], "the saved capture should show the other site's frame, which only a real screenshot can");
    assert.equal(await panel.locator(".xt-notice").count(), 0, "no fallback note when Chrome allowed the screenshot");
    await shot(panel, "real-pixels-thread");
    note(`Real pixels: with every site allowed, captureVisibleTab was used; the saved capture shows the cross-site frame's teal ${JSON.stringify(pixel)}, and no fallback note.`);
    assert.deepEqual(second.errors, [], "no page errors");
  } finally {
    await second.context.close();
  }
  if (evidence !== "") await Bun.write(join(evidence, "run.txt"), `${results.join("\n")}\n`);
  console.log("The extension's Chrome run passed.");
} finally {
  sites.stop();
  local.stop();
}
