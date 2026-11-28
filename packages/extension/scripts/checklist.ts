// The acceptance contract for Critiqs on the page, run in real Chrome: the
// built extension (not a test build) in Chrome for Testing, its icon's action
// run through the Chrome DevTools Protocol (`Extensions.triggerAction`, which
// Chrome handles as a click on the icon and grants the page for), Critiqs's
// closed shadow root read through the content script's own world, and every
// action done with the real mouse and keyboard. Cases A1 to A7, A9 and A10,
// each named by its number, end pass, fail, "not run" with the reason, or "not
// automatable" with the reason (those stay in MANUAL_TEST.md). Results go to
// results.md with a screenshot per case. check-overlay.ts runs A8, A11 and
// A12; test/documents.acceptance.ts runs A13.
//
//   CRITIQS_BACKEND=http://127.0.0.1:3210 bun run check:checklist
//
// Needs CRITIQS_BACKEND: a local Convex deployment with development sign-in
// (`bun run setup:local` in packages/backend) whose CRITIQS_EXTENSION_IDS lists
// the development ID. Optional: CHROME_PATH (Chrome for Testing or Chromium),
// PLAYWRIGHT_CORE (default: installed for the run), CRITIQS_EXTENSION_DIR (an
// extension already built, such as an older commit's, instead of building this
// one), CRITIQS_EVIDENCE_DIR (where results and screenshots go), CRITIQS_CASES
// (some cases only, such as `A4.3,A7`), CRITIQS_SITES_PORT and
// CRITIQS_DEVTOOLS_PORT (fixed ports), CRITIQS_CHROME_FLAGS. Exits with 1 when
// a case fails.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "@critiqs/backend/api";
import type { ConvexHttpClient } from "convex/browser";
import { Browser, EXTENSION_ID, waitUntil } from "./acceptance/browser.ts";
import { NotRun, Run } from "./acceptance/cases.ts";
import { beside, capturePixel, clickForToolbar, comment, commentMode, framePoint, type Open, openPage, pageView, savedThread, showCritiqs } from "./acceptance/flows.ts";
import { box, describe, gap, Missing, type Overlay, type Seen } from "./acceptance/overlay.ts";
import { asStoredReviewer, createProject, deployment, postThread, seedSession, signInDirectly, storedSession, thread, threadPage, threads } from "./acceptance/people.ts";
import { scratchRoot, startSites, TEAL } from "./acceptance/sites.ts";

const here = fileURLToPath(new URL("../", import.meta.url));
const backend = process.env.CRITIQS_BACKEND ?? "";
if (backend === "") throw new Error("Set CRITIQS_BACKEND to a local Convex deployment with development sign-in.");
const scratch = await mkdtemp(join(scratchRoot(), "critiqs-checklist-"));
process.once("exit", () => void rm(scratch, { recursive: true, force: true }));
const evidence = process.env.CRITIQS_EVIDENCE_DIR ?? join(scratch, "evidence");
await mkdir(evidence, { recursive: true });

let extensionDir = process.env.CRITIQS_EXTENSION_DIR ?? "";
if (extensionDir === "") {
  extensionDir = join(scratch, "extension");
  // The real build, as a person loads it: no test hooks and no site granted at install.
  const built = Bun.spawn(["bun", "scripts/build.ts"], { cwd: here, env: { ...process.env, CRITIQS_TEST: "", CRITIQS_EXTENSION_OUT: extensionDir }, stderr: "inherit" });
  if ((await built.exited) !== 0) throw new Error("The extension didn't build.");
}
const manifest = await Bun.file(join(extensionDir, "manifest.json")).json();

const where = await deployment(backend);
const elementScript = await Bun.file(join(here, "../critiqs/dist/element.js")).text().catch(() => "");
const sites = await startSites({ scratch, backend, elementScript });
const site = sites.site;
const browser = await Browser.launch({ extensionDir, scratch });
const run = new Run("Critiqs on the page: the acceptance checklist in real Chrome", evidence);
await run.start();

// ---------------------------------------------------------------------------
// People and projects. Erin is a second reviewer and the admin of an
// organization the reviewer (Dana) is an admin of too, so both reach its
// projects: the second reviewer's replies and comments land where Dana looks.

const stamp = Date.now();
const DANA = { email: `dana+${stamp}@example.com`, name: "Dana Reviewer" };
const erin = await signInDirectly(where, `erin+${stamp}@example.com`, "Erin Admin");
const acme = await createProject(erin, "Acme prototype", [site("proto"), site("strict"), site("two")]);
// Erin's first project makes her organization.
const organization = ((await erin.convex.query(api.organizations.mine, {})) as { id: string; name: string }[])[0]!;
await erin.convex.mutation(api.organizations.invite, { organizationId: organization.id as never, email: DANA.email, role: "admin" } as never);
const storefront = await createProject(erin, "Erin's storefront", []);
await createProject(erin, "Checkout (web)", [site("several")]);
await createProject(erin, "Checkout (mobile web)", [site("several")]);
await createProject(erin, "Local app", [sites.local]);
const installed = await createProject(erin, "Installed app", [site("installed")]);
sites.setInstalledProject(installed);
// A comment on another screen of the test page, for client-side navigation (A7.2).
await postThread(erin, acme, `${site("proto")}/second`, "On the billing screen", "team.billing");

/** Whether the extension holds Dana's session (signed in through Critiqs on the page, or by the run). */
const signedIn = async () => (await storedSession(browser, where).catch(() => null))?.reviewer?.email === DANA.email;
let seeded = "";
/** Dana's session in the extension: if signing in on the page didn't work, the run signs her in the way the worker would, so later cases still run. */
async function ensureSignedIn(): Promise<string> {
  if (await signedIn()) return "";
  const dana = await signInDirectly(where, DANA.email, DANA.name);
  await seedSession(browser, where, dana.signedIn);
  // The worker hears the stored session change; give it a moment before pages ask it.
  await Bun.sleep(1500);
  seeded = "Signed in by the run (sign-in on the page didn't finish), so the cases after A2 can run.";
  return seeded;
}
let joined = false;
/**
 * Dana joins Erin's organization the way any Critiqs she opens does on its first load (the package syncs the
 * reviewer, which accepts invites), so the lookup finds the organization's projects whichever case runs first.
 */
async function joinOrganization() {
  if (joined) return;
  const client = await asStoredReviewer(browser, where);
  if (client === null) return;
  await client.mutation(api.users.sync, {});
  joined = true;
}

/** A client acting as Dana, with the session the extension holds. */
async function asDana(): Promise<ConvexHttpClient> {
  await ensureSignedIn();
  const client = await asStoredReviewer(browser, where);
  if (client === null) throw new Error("The extension holds no session for the reviewer.");
  return client;
}
const danaToken = async () => (await storedSession(browser, where))!.accessToken;

/** Critiqs on a page Dana's project lists, signed in: opened with the icon, toolbar waited for. */
async function reviewing(url = site("proto")): Promise<Open> {
  await ensureSignedIn();
  await joinOrganization();
  const open = await showCritiqs(browser, url);
  run.page = open.tab.page;
  return open;
}

/** The menu behind the toolbar's avatar, opened with the real mouse. */
async function accountMenu(overlay: Overlay): Promise<string> {
  await overlay.click({ button: { pattern: "^Signed in as " } });
  await overlay.expect({ css: '[role="menu"]' }, 5000);
  return (await overlay.locate({ css: '[role="menu"]' }))!.text;
}

/** Signs in on the page with the card: email, code, and a name if asked. Returns the steps seen. */
async function signInOnPage(overlay: Overlay, name: string): Promise<{ askedName: boolean; code: string }> {
  await overlay.fill({ field: "Email" }, DANA.email);
  await overlay.click({ button: "Send code" });
  await overlay.expect({ heading: "Check your email" });
  const code = /Development code: (\d+)/.exec((await overlay.seen()).text)?.[1];
  if (code === undefined) throw new Missing("the card shows no development code");
  await overlay.fill({ field: "Code" }, code);
  await overlay.click({ button: "Continue" });
  const asked = await overlay.expect({ heading: "Choose your name" }, 2500).then(() => true, () => false);
  if (asked) {
    await overlay.fill({ field: "Name" }, name);
    await overlay.click({ button: "Continue" });
  }
  return { askedName: asked, code };
}

const notSignInCard = (seen: Seen) => !seen.headings.some((heading) => /Sign in to Critiqs|Check your email|Choose your name/.test(heading));
const panelTargets = async () => (await browser.targets()).filter((target) => target.url.startsWith(`chrome-extension://${EXTENSION_ID}/panel.html`));

/** What is wrong with a manifest against A1.1, as a list. */
function manifestProblems(found: Record<string, any>): string[] {
  const problems: string[] = [];
  const permissions = [...(found.permissions ?? [])].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(["activeTab", "scripting", "storage"])) problems.push(`permissions are ${JSON.stringify(permissions)}, not activeTab, scripting, storage`);
  if (JSON.stringify(found.optional_host_permissions) !== JSON.stringify(["<all_urls>"])) problems.push(`optional_host_permissions is ${JSON.stringify(found.optional_host_permissions)}`);
  if (found.host_permissions !== undefined) problems.push(`host_permissions is ${JSON.stringify(found.host_permissions)}`);
  if ("side_panel" in found) problems.push("it has side_panel");
  const resources = found.web_accessible_resources ?? [];
  const only = resources.length === 1 && JSON.stringify(resources[0].resources) === JSON.stringify(["allow.html"]) && resources[0].use_dynamic_url === true;
  if (!only) problems.push(`web_accessible_resources is ${JSON.stringify(resources)}, not only allow.html with use_dynamic_url`);
  return problems;
}

// ---------------------------------------------------------------------------
// A1. Install and the icon

await run.case("A1.1", "Manifest: development ID, no site in Site access, exactly activeTab/scripting/storage, optional <all_urls>, no side panel, only allow.html web-accessible with a dynamic URL", async () => {
  const info = await browser.extensionInfo();
  const granted = await browser.inWorker(() => (globalThis as any).chrome.permissions.getAll());
  const problems = manifestProblems(manifest);
  if (info.id !== EXTENSION_ID) problems.push(`Chrome loaded it as ${info.id}`);
  if (info.sites.length > 0 || granted.origins.length > 0) problems.push(`Site access lists ${JSON.stringify(info.sites)}; granted origins ${JSON.stringify(granted.origins)}`);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `ID ${info.id}, version ${info.version}; Site access lists nothing; permissions ${JSON.stringify(manifest.permissions)}; optional ${JSON.stringify(manifest.optional_host_permissions)}; web-accessible ${JSON.stringify(manifest.web_accessible_resources)}`;
});

let first = null as Open | null;
await run.case("A1.2", "First click, signed out: within 1.5 s the toolbar at the bottom centre and Sign in to Critiqs above it; no side panel; one critiqs-root, closed to the page", async (shots) => {
  first = await openPage(browser, site("proto"));
  run.page = first.tab.page;
  const clicked = Date.now();
  await browser.clickIcon(first.tab);
  let seen: Seen | null = null;
  let card: { rect: { y: number } } | null = null;
  while (Date.now() - clicked < 1500) {
    seen = await first.overlay.seen().catch(() => seen);
    card = seen?.toolbar != null ? await first.overlay.locate({ heading: "Sign in to Critiqs" }).catch(() => null) : null;
    if (seen?.toolbar != null && card !== null) break;
    await Bun.sleep(25);
  }
  const ms = Date.now() - clicked;
  await run.shoot("first-click", shots);
  const problems: string[] = [];
  if (seen?.toolbar == null) problems.push(`no Critiqs toolbar on the page 1.5 s after the click (${seen === null ? "nothing read" : seen.script ? `content script ran; ${seen.roots} critiqs-root, ${seen.pins.length} pins` : "Critiqs's content script isn't on the page"})`);
  else {
    const { toolbar, viewport } = seen;
    const centre = toolbar.x + toolbar.width / 2;
    if (Math.abs(centre - viewport.width / 2) > 48 || viewport.height - (toolbar.y + toolbar.height) > 120) problems.push(`the toolbar is at ${box(toolbar)}, not at the bottom centre of ${viewport.width}×${viewport.height}`);
    if (card === null) problems.push(`no "Sign in to Critiqs" card on the page (${seen.headings.length === 0 ? "no headings" : `headings ${JSON.stringify(seen.headings)}`})`);
    else if (card.rect.y > toolbar.y) problems.push("the sign-in card isn't above the toolbar");
  }
  const panels = await panelTargets();
  if (panels.length > 0) problems.push(`a side panel opened (${panels.map((target) => target.url).join(", ")})`);
  const view = await pageView(first.tab);
  if (view.roots !== 1) problems.push(`${view.roots} critiqs-root on the page`);
  if (view.openRoots > 0) problems.push("the page's own scripts can read critiqs-root's shadowRoot (it isn't closed)");
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Toolbar at ${box(seen!.toolbar)} and "Sign in to Critiqs" above it ${ms} ms after the click; no panel.html target; 1 critiqs-root, its shadowRoot null to the page`;
});

await run.case("A1.3", "Click the icon again: Critiqs hides (no toolbar, no pins); again: it shows in the mode it was in; still one critiqs-root", async () => {
  const open = first ?? (await openPage(browser, site("proto")));
  if (first === null) await clickForToolbar(browser, open);
  run.page = open.tab.page;
  const before = await open.overlay.toolbar(3000);
  if (await open.overlay.has({ button: "Comment mode" })) await open.overlay.click({ button: "Comment mode" });
  const mode = (await open.overlay.seen()).mode;
  await browser.clickIcon(open.tab);
  const hidden = await open.overlay.waitFor("Critiqs still shows after the second click on the icon", (seen) => seen.toolbar === null && seen.pins.length === 0 && seen.commentBox === null, 3000);
  await browser.clickIcon(open.tab);
  const back = await open.overlay.waitFor("Critiqs didn't show again after the third click", (seen) => seen.toolbar !== null, 3000);
  const view = await pageView(open.tab);
  if (back.mode !== mode) throw new Error(`It came back in ${back.mode} mode, not ${mode}.`);
  if (view.roots !== 1) throw new Error(`${view.roots} critiqs-root after toggling.`);
  if (mode === "comment") await open.overlay.click({ button: "Browse mode" }).catch(() => undefined);
  return `Toolbar at ${box(before.toolbar)}; hidden after the second click (${hidden.pins.length} pins); back in ${back.mode} mode after the third; 1 critiqs-root`;
});

await run.person("A1.4", "Alt+Shift+C on a page does what the icon does", "DevTools key events go to the page, not to Chrome's own shortcuts, so a script can't press Chrome's extension shortcut.");

// ---------------------------------------------------------------------------
// A2. Signing in, on the page

let code = "";
const signInTab = async () => {
  if (first !== null && !first.tab.page.isClosed()) return first;
  first = await openPage(browser, site("proto"));
  await clickForToolbar(browser, first, 5000).catch(() => undefined);
  return first;
};

await run.case("A2.1", "Enter an email and choose Send code: the card says Check your email, with the development code from a local backend", async () => {
  const open = await signInTab();
  run.page = open.tab.page;
  await open.overlay.fill({ field: "Email" }, DANA.email);
  await open.overlay.click({ button: "Send code" });
  await open.overlay.expect({ heading: "Check your email" });
  code = /Development code: (\d+)/.exec((await open.overlay.seen()).text)?.[1] ?? "";
  if (code === "") throw new Missing("the card says Check your email but shows no development code");
  return `Check your email; development code ${code}`;
});

await run.case("A2.3", "A wrong code says \"That code isn't right. N tries left.\"; Send a new code and Use another email work", async () => {
  const open = await signInTab();
  run.page = open.tab.page;
  if (!(await open.overlay.has({ field: "Code" }))) throw new Missing("no Code field on the page (A2.1 didn't reach Check your email)");
  const wrong = code.replace(/\d/g, (digit) => String((Number(digit) + 1) % 10)) || "000000";
  await open.overlay.fill({ field: "Code" }, wrong);
  await open.overlay.click({ button: "Continue" });
  const said = await open.overlay.expect({ text: "That code isn't right." }).then(async () => (await open.overlay.locate({ text: "That code isn't right." }))!.text);
  if (!/That code isn't right\. \d+ tr(y|ies) left\./.test(said)) throw new Error(`It said "${said}".`);
  await open.overlay.click({ button: "Send a new code" });
  await waitUntil("the wrong-code message to clear after Send a new code", async () => !(await open.overlay.has({ text: "That code isn't right." })) && (await open.overlay.has({ button: "Use another email" })), 10_000);
  const again = /Development code: (\d+)/.exec((await open.overlay.seen()).text)?.[1] ?? "";
  await open.overlay.click({ button: "Use another email" });
  await open.overlay.expect({ field: "Email" });
  await open.overlay.fill({ field: "Email" }, DANA.email);
  await open.overlay.click({ button: "Send code" });
  await open.overlay.expect({ heading: "Check your email" });
  code = /Development code: (\d+)/.exec((await open.overlay.seen()).text)?.[1] ?? "";
  return `"${said}"; Send a new code showed code ${again}; Use another email went back to the Email field; sent again (code ${code})`;
});

await run.case("A2.2", "Enter the code (and a name on a first sign-in): the card goes; the project step or the avatar shows; the worker holds the session; every /auth/* request came from the worker with the extension's Origin, none from the page", async () => {
  const open = await signInTab();
  run.page = open.tab.page;
  if (!(await open.overlay.has({ field: "Code" })) || code === "") throw new Missing("no Code field with a development code on the page (A2.1 didn't reach Check your email)");
  const startedAt = Date.now();
  await open.overlay.fill({ field: "Code" }, code);
  await open.overlay.click({ button: "Continue" });
  const askedName = await open.overlay.expect({ heading: "Choose your name" }, 4000).then(() => true, () => false);
  if (askedName) {
    await open.overlay.fill({ field: "Name" }, DANA.name);
    await open.overlay.click({ button: "Continue" });
  }
  const after = await open.overlay.waitFor("the sign-in card didn't go away", (seen) => notSignInCard(seen) && (seen.headings.some((heading) => /project/i.test(heading)) || /Signed in as/.test(seen.text) || seen.toolbar !== null), 10_000);
  const avatar = await open.overlay.has({ button: { pattern: "^Signed in as " } });
  await waitUntil("the session in the extension", signedIn, 5000).catch(() => undefined);
  const stored = await storedSession(browser, where);
  const auth = browser.requests.filter((request) => request.at >= startedAt - 60_000 && /\/auth\//.test(new URL(request.url).pathname));
  const fromPages = auth.filter((request) => request.from !== "worker");
  const fromWorker = auth.filter((request) => request.from === "worker");
  const problems: string[] = [];
  if (stored?.reviewer?.email !== DANA.email) problems.push(`the worker's stored session has ${JSON.stringify(stored?.reviewer ?? null)}`);
  if (fromPages.length > 0) problems.push(`pages sent ${fromPages.map((request) => `${new URL(request.url).pathname} (Origin ${request.origin})`).join(", ")}`);
  const wrongOrigin = fromWorker.filter((request) => request.origin !== `chrome-extension://${EXTENSION_ID}`);
  if (wrongOrigin.length > 0) problems.push(`the worker sent ${wrongOrigin.map((request) => `${new URL(request.url).pathname} with Origin ${request.origin}`).join(", ")}`);
  if (fromWorker.length === 0) problems.push("no /auth/* request seen from the worker");
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Name asked: ${askedName}; then ${avatar ? "the avatar" : `"${after.headings[0]}"`}; the worker holds ${stored!.reviewer.email}; ${fromWorker.length} /auth/* requests from the worker (${[...new Set(fromWorker.map((request) => new URL(request.url).pathname))].join(", ")}), all Origin chrome-extension://${EXTENSION_ID}; none from pages`;
});

await ensureSignedIn();
await (first as Open | null)?.tab.page.close().catch(() => undefined);

await run.case("A2.5", "Change display name… in the account menu: the new name shows in the menu and on the next comment", async (shots) => {
  const { overlay, tab } = await reviewing();
  await accountMenu(overlay);
  await overlay.click({ menuItem: "Change display name…" });
  await overlay.fill({ field: "Display name" }, "Dana Renamed");
  await overlay.click({ button: "Save" });
  await overlay.waitFor("the name dialog didn't close", (seen) => !seen.dialogs.some((dialog) => /display name/i.test(dialog)), 5000);
  const menu = await accountMenu(overlay);
  await run.shoot("renamed-menu", shots);
  await tab.page.keyboard.press("Escape");
  if (!menu.includes("Dana Renamed")) throw new Error(`The menu says "${menu.slice(0, 120)}".`);
  const made = await comment(overlay, '[data-critiqs-id="team.save"]', "Named after the rename");
  const labels = made.after.pinLabels.filter((pin) => pin.includes("Dana Renamed"));
  if (labels.length === 0) throw new Error(`The new comment's pin says ${JSON.stringify(made.after.pinLabels)}.`);
  await tab.page.keyboard.press("Escape");
  await tab.page.close();
  return `The menu shows "Dana Renamed"; the next comment's pin says "${labels[0]}"`;
});

await run.case("A2.4", "Sign out from the account menu: the sign-in card shows, and within 2 s every other tab with Critiqs shows it signed out; signing in again with the same email skips the name", async (shots) => {
  const one = await reviewing();
  const two = await reviewing(site("two"));
  run.page = one.tab.page;
  await one.tab.page.bringToFront();
  await accountMenu(one.overlay);
  await one.overlay.click({ menuItem: "Sign out" });
  const signedOutAt = Date.now();
  await one.overlay.expect({ heading: "Sign in to Critiqs" }, 5000);
  let other = -1;
  while (Date.now() - signedOutAt < 2000 && other < 0) {
    const out = !(await two.overlay.has({ button: { pattern: "^Signed in as " } })) && ((await two.overlay.has({ heading: "Sign in to Critiqs" })) || (await two.overlay.has({ button: "Sign in" })));
    if (out) other = Date.now() - signedOutAt;
    else await Bun.sleep(80);
  }
  if (other < 0) throw new Missing(`the other tab still shows the reviewer signed in 2 s after signing out (${describe(await two.overlay.seen())})`);
  await run.shoot("signed-out", shots);
  await one.tab.page.bringToFront();
  const again = await signInOnPage(one.overlay, DANA.name);
  if (again.askedName) throw new Error("Signing in again asked for a name.");
  await one.overlay.waitFor("the card didn't go after signing in again", notSignInCard, 10_000);
  await one.tab.page.close();
  await two.tab.page.close();
  return `The card showed after Sign out; the other tab showed signed out after ${other} ms; signing in again went from the code straight in (no name step)`;
});

// ---------------------------------------------------------------------------
// A3. The page's project

/** Opens `url` and clicks the icon; returns once Critiqs shows anything (a card or the toolbar). */
async function clickOpen(url: string): Promise<Open> {
  await ensureSignedIn();
  await joinOrganization();
  const open = await openPage(browser, url);
  run.page = open.tab.page;
  await browser.clickIcon(open.tab);
  await open.overlay.waitFor("nothing of Critiqs on the page after the click", (seen) => seen.toolbar !== null || seen.headings.length > 0, 10_000);
  return open;
}
/** The sidebar's header, opened with the toolbar's sidebar button. */
async function sidebarTitle(overlay: Overlay): Promise<string> {
  if ((await overlay.seen()).sidebar === null) await overlay.click({ button: { pattern: "^(Project|Comments)" } });
  await overlay.expect({ css: ".sidebar-header" }, 5000);
  return (await overlay.locate({ css: ".sidebar-header h2" }))?.text ?? "";
}

await run.case("A3.1", "A site no project lists: No project for this site yet → Start reviewing this site shows the toolbar, and the sidebar's header names the new project", async () => {
  const { overlay, tab } = await clickOpen(site("fresh"));
  await overlay.expect({ heading: "No project for this site yet" });
  await overlay.click({ button: "Start reviewing this site" });
  await overlay.toolbar();
  const title = await sidebarTitle(overlay);
  const expected = `fresh.critiqs.test:${sites.port}`;
  await tab.page.close();
  if (!title.includes(expected)) throw new Error(`The sidebar's header says "${title}", not "${expected}".`);
  return `No project for this site yet → Start reviewing this site → toolbar; the sidebar's header says "${title}"`;
});

await run.case("A3.2", "Add to a project lists your projects and your organization's, named by organization; choosing one shows the toolbar; a new tab on the site shows it without asking", async (shots) => {
  const { overlay, tab } = await clickOpen(site("other"));
  await overlay.expect({ heading: "No project for this site yet" });
  await overlay.click({ button: "Add to a project" });
  await overlay.expect({ button: { pattern: "Erin's storefront" } });
  const listed = (await overlay.seen()).text;
  await run.shoot("add-to-project", shots);
  await overlay.click({ button: { pattern: "Erin's storefront" } });
  await overlay.toolbar();
  await tab.page.close();
  const again = await clickOpen(site("other"));
  await again.overlay.toolbar(5000);
  const title = await sidebarTitle(again.overlay);
  await again.tab.page.close();
  const problems: string[] = [];
  if (!listed.includes(`fresh.critiqs.test:${sites.port}`)) problems.push("the project Dana created isn't listed");
  if (!listed.includes(organization.name)) problems.push(`the organization's name "${organization.name}" isn't shown`);
  if (!title.includes("Erin's storefront")) problems.push(`a new tab's sidebar says "${title}"`);
  if (problems.length > 0) throw new Error(`${problems.join("; ")}. The card listed: "${listed.slice(0, 300)}"`);
  return `Listed "${listed.slice(0, 200)}"; chose Erin's storefront; a new tab on the site shows "${title}" without asking`;
});

await run.case("A3.3", "A site two projects list asks Which project is this?; the choice is remembered; Change project for this site asks again", async () => {
  const { overlay, tab } = await clickOpen(site("several"));
  await overlay.expect({ heading: "Which project is this?" });
  await overlay.click({ button: { pattern: "^Checkout \\(web\\)" } });
  await overlay.toolbar();
  await tab.page.close();
  const again = await clickOpen(site("several"));
  await again.overlay.toolbar(5000);
  const title = await sidebarTitle(again.overlay);
  await accountMenu(again.overlay);
  await again.overlay.click({ menuItem: "Change project for this site" });
  await again.overlay.expect({ heading: "Which project is this?" });
  await again.overlay.click({ button: { pattern: "^Checkout \\(web\\)" } });
  await again.tab.page.close();
  if (!title.includes("Checkout (web)")) throw new Error(`Remembered as "${title}".`);
  return `Asked, chose Checkout (web); a new tab showed "${title}" without asking; Change project for this site asked again`;
});

await run.case("A3.4", "A localhost page asks once, then remembers", async () => {
  const { overlay, tab } = await clickOpen(sites.local);
  await overlay.expect({ heading: "Which project is this?" });
  await overlay.click({ button: { pattern: "^Local app" } });
  await overlay.toolbar();
  await tab.page.close();
  const again = await clickOpen(sites.local);
  const seen = await again.overlay.toolbar(5000);
  const asked = await again.overlay.has({ heading: "Which project is this?" });
  await again.tab.page.close();
  if (asked) throw new Error("It asked again.");
  return `${sites.local} asked once (Local app); the next tab went straight to the toolbar at ${box(seen.toolbar)}`;
});

await run.case("A3.5", "The worker answers the lookup from Chrome's tab address: a content-script message naming another origin gets the tab's own project", async () => {
  const { overlay, tab } = await reviewing();
  const named = site("several");
  const answer = await overlay.evaluate(`chrome.runtime.sendMessage({ type: "critiqs:project", origin: ${JSON.stringify(named)}, url: ${JSON.stringify(`${named}/`)} }).then((value) => JSON.stringify(value), (error) => "error: " + error.message)`);
  await tab.page.close();
  const text = String(answer.value ?? answer.error);
  if (!text.includes("Acme prototype") && !text.includes(acme)) throw new Error(`The answer to critiqs:project naming ${named} was ${text.slice(0, 300)}.`);
  if (text.includes("Checkout")) throw new Error(`The answer named the other origin's project: ${text.slice(0, 300)}.`);
  return `Asked from ${site("proto")} naming ${named}: ${text.slice(0, 200)}`;
});

// ---------------------------------------------------------------------------
// A4. Commenting, as installed

const TYPED = "Check move, colour and overlay: c v m o";
let a4: Open | null = null;
let saved: any = null;
const a4Tab = async () => {
  if (a4 === null || a4.tab.page.isClosed()) a4 = await reviewing();
  run.page = a4.tab.page;
  return a4;
};
let target = { x: 0, y: 0, width: 0, height: 0 };

await run.case("A4.1", "Press C: Comment mode; moving the mouse over the button outlines it", async () => {
  const { overlay } = await a4Tab();
  const seen = await commentMode(overlay);
  target = await overlay.hover('[data-critiqs-id="team.save"]');
  const outline = (await overlay.seen()).outline!;
  return `${seen.mode} mode after C; the button at ${box(target)} outlined at ${box(outline)}`;
});

await run.case("A4.2", "Click the button: the comment box opens within 24 px of it and has focus", async () => {
  const { overlay, tab } = await a4Tab();
  await commentMode(overlay);
  target = await overlay.hover('[data-critiqs-id="team.save"]');
  await tab.page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  const seen = await overlay.waitFor("no comment box opened after clicking the button in Comment mode", (now) => now.commentBox !== null, 5000);
  const wrong = beside("comment box", seen.commentBox, target);
  if (wrong !== null) throw new Error(wrong);
  if (!seen.focusInCommentBox) throw new Error("The comment box doesn't have focus.");
  return `Comment box at ${box(seen.commentBox)}, ${Math.round(gap(seen.commentBox!, target))} px from the button; focus is in it`;
});

await run.case("A4.3", "Type the comment right away with the real keyboard and send: a pin beside the button, the thread window beside the pin, the saved text exactly as typed, Comment mode kept while typing", async () => {
  const { overlay, tab } = await a4Tab();
  let seen = await overlay.seen();
  if (seen.commentBox === null) {
    await commentMode(overlay);
    target = await overlay.pick('[data-critiqs-id="team.save"]');
    seen = await overlay.waitFor("no comment box opened after clicking the button in Comment mode", (now) => now.commentBox !== null, 5000);
  }
  const pinsBefore = seen.pins.length;
  await tab.page.keyboard.type(TYPED);
  const typing = await overlay.seen();
  await tab.page.keyboard.press("Control+Enter");
  const after = await overlay.waitFor(`no new pin and thread window after sending (the box held "${typing.commentText}", mode while typing ${typing.mode})`, (now) => now.pins.length > pinsBefore && now.threadWindow !== null, 15_000);
  saved = await savedThread(await asDana(), acme, TYPED);
  const problems: string[] = [];
  if (typing.mode !== "comment") problems.push(`the mode while typing was ${typing.mode}`);
  const pin = after.pins.map((rect) => ({ rect, distance: gap(rect, target) })).sort((a, b) => a.distance - b.distance)[0]!;
  if (pin.distance > 24) problems.push(`the nearest pin is ${Math.round(pin.distance)} px from the button`);
  if (gap(after.threadWindow!, pin.rect) > 24) problems.push(`the thread window at ${box(after.threadWindow)} is ${Math.round(gap(after.threadWindow!, pin.rect))} px from the pin`);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Saved "${saved.page[0].body}" (exactly as typed); pin at ${box(pin.rect)}, thread window at ${box(after.threadWindow)}; Comment mode while typing`;
});

await run.case("A4.4", "The saved thread's capture is captured, and its image shows the other site's frame in its real colour", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const { tab } = await a4Tab();
  const at = await framePoint(tab);
  const { pixel, status, size } = await capturePixel(browser, where, await danaToken(), saved._id, at);
  if (saved.capture?.status !== "captured") throw new Error(`The capture is ${JSON.stringify(saved.capture)}.`);
  if (pixel === null) throw new Error(`The capture didn't download (HTTP ${status}).`);
  if (JSON.stringify(pixel) !== JSON.stringify(TEAL)) throw new Error(`The pixel under the other site's frame is ${JSON.stringify(pixel)}, not teal ${JSON.stringify(TEAL)}.`);
  return `capture.status "captured"; the ${size?.join("×")} image shows ${JSON.stringify(pixel)} under the frame (teal: real pixels)`;
});

await run.case("A4.5", "The saved thread has madeWith: extension", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const { madeWith } = await threadPage(await asDana(), saved._id);
  if (madeWith !== "extension") throw new Error(`The thread's madeWith is ${JSON.stringify(madeWith)}.`);
  return `madeWith "${madeWith}"`;
});

await run.case("A4.6", "In the thread window: reply, react, Resolve, reopen; each change saved and shown", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const { overlay, tab } = await a4Tab();
  if ((await overlay.seen()).threadWindow === null) await clickPin(overlay, 0);
  const dana = await asDana();
  await overlay.click({ field: "Reply" });
  await tab.page.keyboard.type("A reply from the page");
  await overlay.click({ css: ".thread-window button", text: "Reply" });
  await overlay.expect({ css: ".thread-window .message", text: "A reply from the page" });
  await waitUntil("the reply saved", async () => (await thread(dana, saved._id)).page.some((message: any) => message.body === "A reply from the page"), 10_000);
  await overlay.click({ css: ".thread-window .message", text: TYPED });
  await overlay.click({ button: "Add reaction" });
  await overlay.click({ button: { pattern: "^React " } });
  await overlay.expect({ css: ".thread-window [aria-label*='including you']" });
  const firstMessage = (await thread(dana, saved._id)).page[0]._id;
  const reactions = (await dana.query(api.threads.listReactions, { threadId: saved._id, paginationOpts: { numItems: 20, cursor: null } } as never)) as any;
  if ((reactions.page ?? []).length === 0) throw new Error(`No reaction saved for message ${firstMessage}.`);
  await overlay.click({ button: { pattern: "Resolve" } });
  await overlay.expect({ heading: "Resolved comment" });
  await waitUntil("the thread resolved", async () => (await thread(dana, saved._id)).status === "resolved", 10_000);
  await overlay.click({ button: "Reopen" });
  await overlay.expect({ heading: "Comment" });
  await waitUntil("the thread reopened", async () => (await thread(dana, saved._id)).status === "open", 10_000);
  return `Reply shown and saved; reaction shown and saved (${reactions.page.length}); Resolved then reopened, each saved`;
});

async function clickPin(overlay: Overlay, index: number) {
  const seen = await overlay.waitFor("no pin on the page", (now) => now.pins.length > index, 10_000);
  const pin = seen.pins[index]!;
  await overlay.page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2);
  return await overlay.waitFor("no thread window after clicking a pin", (now) => now.threadWindow !== null, 5000);
}

await run.case("A4.7", "A second reviewer replies through the API: the reply shows in the open thread window within 5 s", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const { overlay } = await a4Tab();
  if ((await overlay.seen()).threadWindow === null) await clickPin(overlay, 0);
  const sent = Date.now();
  await erin.convex.mutation(api.threads.reply, { threadId: saved._id, body: "Erin's reply from elsewhere", revision: null } as never);
  await overlay.expect({ css: ".thread-window", text: "Erin's reply from elsewhere" }, 5000);
  return `Shown ${Date.now() - sent} ms after the API reply`;
});

await run.case("A4.8", "Escape closes the innermost thing first: the comment box, then the thread window", async () => {
  const { overlay, tab } = await a4Tab();
  await commentMode(overlay);
  await overlay.pick('[data-critiqs-id="team.save"]');
  await overlay.waitFor("no comment box opened", (seen) => seen.commentBox !== null, 5000);
  await tab.page.keyboard.press("Escape");
  const boxGone = await overlay.waitFor("the comment box stayed open after Escape", (seen) => seen.commentBox === null, 3000);
  await clickPin(overlay, 0);
  await tab.page.keyboard.press("Escape");
  const windowGone = await overlay.waitFor("the thread window stayed open after Escape", (seen) => seen.threadWindow === null, 3000);
  if (windowGone.toolbar === null) throw new Error("Escape hid the toolbar.");
  return `Escape closed the comment box (toolbar ${boxGone.mode} mode), then the thread window (${windowGone.mode} mode kept)`;
});

// ---------------------------------------------------------------------------
// A5. Sidebar, menus, Mockup mode

/** Critiqs back on a reloaded tab: by itself, or after a click when it doesn't come back. */
async function afterReload(open: Open): Promise<string> {
  await open.tab.page.reload();
  const back = await open.overlay.toolbar(3000).then(() => "came back by itself", () => null);
  if (back !== null) return back;
  await clickForToolbar(browser, open);
  return "needed a click to come back";
}

await run.case("A5.1", "The sidebar button slides the sidebar over the page's right edge; dragging its edge changes the width, the same after a reload", async () => {
  const open = await a4Tab();
  const { overlay, tab } = open;
  await tab.page.keyboard.press("v");
  if ((await overlay.seen()).sidebar === null) await overlay.click({ button: { pattern: "^(Project|Comments)" } });
  const shown = await overlay.waitFor("no sidebar after the toolbar's sidebar button", (seen) => seen.sidebar !== null, 5000);
  if (Math.abs(shown.sidebar!.x + shown.sidebar!.width - shown.viewport.width) > 2) throw new Error(`The sidebar at ${box(shown.sidebar)} isn't at the right edge of ${shown.viewport.width}.`);
  const edge = await overlay.expect({ css: ".sidebar-resize" });
  const from = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
  await tab.page.mouse.move(from.x, from.y);
  await tab.page.mouse.down();
  await tab.page.mouse.move(from.x - 120, from.y, { steps: 8 });
  await tab.page.mouse.up();
  const dragged = await overlay.waitFor("the sidebar's width didn't change after dragging its edge", (seen) => seen.sidebar !== null && Math.abs(seen.sidebar.width - shown.sidebar!.width) > 60, 3000);
  const how = await afterReload(open);
  if ((await overlay.seen()).sidebar === null) await overlay.click({ button: { pattern: "^(Project|Comments)" } });
  const reloaded = await overlay.waitFor("no sidebar after the reload", (seen) => seen.sidebar !== null, 5000);
  if (Math.abs(reloaded.sidebar!.width - dragged.sidebar!.width) > 2) throw new Error(`The width was ${Math.round(dragged.sidebar!.width)} px, ${Math.round(reloaded.sidebar!.width)} px after the reload.`);
  return `Sidebar at the right edge, ${Math.round(shown.sidebar!.width)} px; dragged to ${Math.round(dragged.sidebar!.width)} px; after the reload (Critiqs ${how}) ${Math.round(reloaded.sidebar!.width)} px`;
});

await run.case("A5.2", "The sidebar lists the comment; choosing it opens its thread beside its pin", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const { overlay } = await a4Tab();
  if ((await overlay.seen()).sidebar === null) await overlay.click({ button: { pattern: "^(Project|Comments)" } });
  await overlay.page.keyboard.press("c");
  await overlay.click({ css: ".sidebar button", text: TYPED.slice(0, 20) });
  const seen = await overlay.waitFor("no thread window after choosing the comment in the sidebar", (now) => now.threadWindow !== null, 5000);
  const near = seen.pins.map((pin) => gap(pin, seen.threadWindow!)).sort((a, b) => a - b)[0];
  if (near === undefined || near > 24) throw new Error(`The thread window at ${box(seen.threadWindow)} isn't beside a pin (nearest ${near === undefined ? "none" : `${Math.round(near)} px`}).`);
  await overlay.page.keyboard.press("Escape");
  return `Chose the comment in the sidebar; its thread window at ${box(seen.threadWindow)} is ${Math.round(near)} px from its pin`;
});

await run.case("A5.3", "The account menu shows the name and email, Project setup, Change display name…, Show comments here automatically (with its state), Change project for this site (only with a choice), Sign out", async () => {
  const { overlay, tab } = await a4Tab();
  const menu = await accountMenu(overlay);
  const items = await overlay.read((h) => h.all(h.root()!.querySelector('[role="menu"]')).filter((element) => element.matches('[role^="menuitem"]')).map((element) => ({ name: h.name(element), checked: element.getAttribute("aria-checked") })));
  await tab.page.keyboard.press("Escape");
  const several = await reviewing(site("several"));
  const severalMenu = await accountMenu(several.overlay);
  await several.tab.page.close();
  run.page = tab.page;
  const names = items.map((item) => item.name);
  const problems: string[] = [];
  for (const wanted of ["Project setup", "Change display name…", "Sign out"]) if (!names.includes(wanted)) problems.push(`no "${wanted}"`);
  const automatic = items.find((item) => item.name.startsWith("Show comments here automatically"));
  if (automatic === undefined) problems.push(`no "Show comments here automatically"`);
  else if (automatic.checked === null && !/\b(on|off)\b/i.test(automatic.name)) problems.push("Show comments here automatically doesn't show its state");
  if (!menu.includes(DANA.email)) problems.push(`no email (${DANA.email})`);
  if (names.includes("Change project for this site")) problems.push("Change project for this site shows on a site only one project lists");
  if (!severalMenu.includes("Change project for this site")) problems.push("no Change project for this site on a site two projects list");
  if (problems.length > 0) throw new Error(`${problems.join("; ")}. Items: ${JSON.stringify(names)}`);
  return `Items ${JSON.stringify(names)}; automatic ${automatic!.checked ?? automatic!.name}; Change project for this site only on the site two projects list`;
});

await run.case("A5.4", "Project setup, Tags and AI, and Your trackers open their dialogs over the page and close with Escape", async () => {
  const { overlay, tab } = await a4Tab();
  const opened: string[] = [];
  const dialog = async (name: string, open: () => Promise<unknown>) => {
    await open();
    const seen = await overlay.waitFor(`no ${name} dialog`, (now) => now.dialogs.length > 0, 5000);
    await tab.page.keyboard.press("Escape");
    await overlay.waitFor(`the ${name} dialog stayed open after Escape`, (now) => now.dialogs.length === 0, 3000);
    opened.push(`${name} (dialog "${seen.dialogs[0]}", closed with Escape)`);
  };
  // Installed, Project setup is the panel over the page's right edge, which its Close button closes.
  await accountMenu(overlay);
  await overlay.click({ menuItem: "Project setup" });
  const setup = await overlay.waitFor("no Project setup over the page", (now) => now.dialogs.length > 0 || (now.sidebar !== null && now.headings.includes("Project setup")), 5000);
  await tab.page.keyboard.press("Escape");
  const escaped = await overlay.waitFor("", (now) => now.dialogs.length === 0 && !now.headings.includes("Project setup"), 1500).then(() => true, () => false);
  if (!escaped) await overlay.click({ button: "Close sidebar" });
  await overlay.waitFor("Project setup didn't close", (now) => now.dialogs.length === 0 && !now.headings.includes("Project setup"), 3000);
  opened.push(`Project setup (${setup.dialogs.length > 0 ? "dialog" : "panel over the right edge"}, closed with ${escaped ? "Escape" : "its Close button; Escape doesn't close it, as installed"})`);
  const menu = await accountMenu(overlay);
  if (menu.includes("Your trackers…")) await dialog("Your trackers", () => overlay.click({ menuItem: "Your trackers…" }));
  else {
    await tab.page.keyboard.press("Escape");
    opened.push("Your trackers not checked: this backend offers no trackers, so the account menu has no Your trackers… (installed too)");
  }
  await dialog("Tags and AI", async () => {
    await tab.page.keyboard.press("c");
    if ((await overlay.seen()).sidebar === null) await overlay.click({ button: { pattern: "^Comments" } });
    await overlay.click({ button: "Tags and AI settings" });
  });
  await tab.page.keyboard.press("v");
  return opened.join("; ");
});

/** The middle of an element of the frozen copy, in the page's coordinates. */
const inCopy = (overlay: Overlay, selector: string) =>
  overlay.read((h, query) => {
    const frame = h.all(h.root()).find((element) => element instanceof HTMLIFrameElement && h.shown(element) && element.getBoundingClientRect().width > 200) as HTMLIFrameElement | undefined;
    const element = frame?.contentDocument?.querySelector(query);
    if (frame === undefined || element == null) return null;
    const shown = frame.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return { x: shown.x + rect.x + rect.width / 2, y: shown.y + rect.y + rect.height / 2 };
  }, selector);

let mockupTab: Open | null = null;
/** What Critiqs AI says when it answers: a new version, or why it can't. Its progress steps ("Read the page") are neither. */
const ANSWER = /\bversion\b|isn't set up|not set up|can't|couldn't|unavailable|out of credits|failed/i;
await run.case("A5.5", "Press M: the frozen copy, the Mockup panel on the right, Mockup mode; New thread, click an element of the copy, ask, Send: the thread shows it, and Critiqs AI answers or says why it can't", async (shots) => {
  mockupTab = await reviewing();
  const { overlay, tab } = mockupTab;
  await tab.page.keyboard.press("m");
  const seen = await overlay.waitFor("no Mockup mode after pressing M (copy, Mockup panel and Mockup mode)", (now) => now.mode === "mockup" && now.copy !== null && now.mockupPanel !== null, 15_000);
  await overlay.click({ button: "New thread" });
  await waitUntil("the button in the copy", async () => (await inCopy(overlay, '[data-critiqs-id="team.save"]')) !== null, 10_000);
  const point = (await inCopy(overlay, '[data-critiqs-id="team.save"]'))!;
  for (let attempt = 0; attempt < 10; attempt++) {
    await tab.page.mouse.move(point.x - 40, point.y + 40, { steps: 2 });
    await tab.page.mouse.move(point.x, point.y, { steps: 4 });
  }
  await tab.page.mouse.click(point.x, point.y);
  await overlay.click({ field: "Ask for a change to this element" });
  await tab.page.keyboard.type("Make this button green");
  await overlay.click({ css: "form button", text: "Send" });
  await overlay.expect({ css: 'aside[aria-label="Mockup"]', text: "Make this button green" }, 15_000);
  await run.shoot("mockup-sent", shots);
  let answer = "";
  await waitUntil("an answer from Critiqs AI", async () => {
    const text = (await overlay.locate({ css: 'aside[aria-label="Mockup"]' }))?.text ?? "";
    answer = text;
    return ANSWER.test(text.split("Make this button green").slice(1).join(" "));
  }, 30_000).catch(() => undefined);
  const after = answer.split("Make this button green").slice(1).join(" ").trim();
  if (!ANSWER.test(after)) throw new Error(`No answer and no reason after the message; the panel says "${answer.slice(0, 300)}".`);
  return `Mockup mode: copy at ${box(seen.copy)}, panel at ${box(seen.mockupPanel)}; the thread shows the message; then "${after.slice(0, 160)}"`;
});

await run.case("A5.7", "Holding O shows the live page; letting go shows the copy again", async () => {
  if (mockupTab === null || (await mockupTab.overlay.seen()).copy === null) throw new NotRun("Mockup mode isn't showing (A5.5)");
  const { overlay, tab } = mockupTab;
  await overlay.click({ css: 'aside[aria-label="Mockup"] h2' }).catch(() => undefined);
  await tab.page.mouse.click(5, 5);
  await tab.page.keyboard.down("o");
  const live = await overlay.waitFor("the copy still shows while O is held", (seen) => seen.copy === null, 2000);
  await tab.page.keyboard.up("o");
  const copy = await overlay.waitFor("the copy didn't come back after letting go of O", (seen) => seen.copy !== null, 2000);
  return `Holding O hid the copy (${live.mode} mode); letting go showed it at ${box(copy.copy)}`;
});

await run.case("A5.8", "V leaves Mockup mode; the page is live and clickable again", async () => {
  if (mockupTab === null) throw new NotRun("Mockup mode isn't showing (A5.5)");
  const { overlay, tab } = mockupTab;
  await tab.page.keyboard.press("v");
  const seen = await overlay.waitFor("still in Mockup mode after V", (now) => now.mode !== "mockup" && now.copy === null, 3000);
  const before = await tab.page.evaluate(() => (window as any).__clicks);
  const button = (await tab.page.locator('[data-critiqs-id="team.save"]').boundingBox())!;
  await tab.page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  const after = await tab.page.evaluate(() => (window as any).__clicks);
  await tab.page.close();
  if (after !== before + 1) throw new Error(`The page's button got ${after - before} clicks from a real click.`);
  return `${seen.mode} mode, no copy; a real click reached the page's button (${before} → ${after})`;
});

await run.case("A5.6", "On the strict page, the copy keeps the page's styles: its body font family equals the live page's", async () => {
  const { overlay, tab } = await reviewing(site("strict"));
  await tab.page.keyboard.press("m");
  await overlay.waitFor("no frozen copy after pressing M on the strict page", (seen) => seen.copy !== null, 15_000);
  const fonts = await overlay.read((h) => {
    const frame = h.all(h.root()).find((element) => element instanceof HTMLIFrameElement && element.getBoundingClientRect().width > 200) as HTMLIFrameElement | undefined;
    const body = frame?.contentDocument?.body;
    return { live: getComputedStyle(document.body).fontFamily, copy: body == null ? null : getComputedStyle(body).fontFamily };
  });
  await tab.page.keyboard.press("v");
  await tab.page.close();
  if (fonts.copy !== fonts.live) throw new Error(`The copy's body font is ${JSON.stringify(fonts.copy)}, the live page's ${JSON.stringify(fonts.live)}.`);
  return `Both ${fonts.live}`;
});

// ---------------------------------------------------------------------------
// A6. Links, keyboard, narrow windows

await run.case("A6.1", "⋯ → Copy link says Link to thread copied; the clipboard holds the thread's website link (or the page's address with the comment)", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const { overlay, tab } = await reviewing();
  await clickPinFor(overlay, saved._id);
  await browser.devtools.send("Browser.grantPermissions", { origin: site("proto"), permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await overlay.click({ button: "More actions" });
  await overlay.click({ menuItem: "Copy link" });
  await overlay.expect({ text: "Link to thread copied" }, 5000);
  const copied = String(await tab.page.evaluate(() => navigator.clipboard.readText()));
  await tab.page.close();
  const website = where.website;
  const expected = website === undefined ? new RegExp(`[?&]critiqs=${saved._id}`) : new RegExp(`^${website.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/t[#/][A-Za-z0-9_-]+$`);
  if (!expected.test(copied)) throw new Error(`The clipboard holds "${copied}".`);
  return `"Link to thread copied"; the clipboard holds ${copied}`;
});

/** Opens the thread window of one saved thread by clicking pins until it shows. */
async function clickPinFor(overlay: Overlay, threadId: string) {
  const body = (await thread(await asDana(), threadId)).page[0].body as string;
  const seen = await overlay.waitFor("no pin on the page", (now) => now.pins.length > 0, 10_000);
  for (let index = 0; index < seen.pins.length; index++) {
    await clickPin(overlay, index);
    if (await overlay.expect({ css: ".thread-window", text: body }, 4000).then(() => true, () => false)) return;
  }
  throw new Missing(`no pin opens the thread "${body}"`);
}

await run.case("A6.2", "Open the page address with ?critiqs=… in a new tab and click the icon: the thread opens beside its pin", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  await ensureSignedIn();
  await joinOrganization();
  const open = await openPage(browser, `${site("proto")}/?critiqs=${saved._id}`);
  run.page = open.tab.page;
  await clickForToolbar(browser, open);
  const seen = await open.overlay.waitFor("the linked thread didn't open", (now) => now.threadWindow !== null && now.text.includes(TYPED), 10_000);
  const near = seen.pins.map((pin) => gap(pin, seen.threadWindow!)).sort((a, b) => a - b)[0];
  await open.tab.page.close();
  if (near === undefined || near > 24) throw new Error(`The thread window at ${box(seen.threadWindow)} isn't beside a pin.`);
  return `The linked thread opened at ${box(seen.threadWindow)}, ${Math.round(near)} px from its pin`;
});

await run.case("A6.3", "Keys typed into Critiqs's fields never reach the page's own key listeners (0); C, V, M, Escape and the hide shortcut work as installed", async () => {
  const { overlay, tab } = await reviewing();
  await commentMode(overlay);
  await overlay.pick('[data-critiqs-id="team.save"]');
  await overlay.waitFor("no comment box", (seen) => seen.commentBox !== null, 5000);
  await tab.page.evaluate(() => ((window as any).__pageKeys = []));
  await tab.page.keyboard.type("keys stay in Critiqs: c v m");
  const reached = (await tab.page.evaluate(() => (window as any).__pageKeys)) as string[];
  await tab.page.keyboard.press("Escape");
  await overlay.waitFor("Escape didn't close the comment box", (seen) => seen.commentBox === null, 3000);
  const modes: string[] = [];
  for (const [key, wanted] of [["v", "browse"], ["c", "comment"], ["v", "browse"], ["m", "mockup"], ["v", "browse"]] as const) {
    await tab.page.keyboard.press(key);
    await overlay.waitFor(`${key.toUpperCase()} didn't turn on ${wanted} mode`, (seen) => seen.mode === wanted, 15_000);
    modes.push(`${key.toUpperCase()}→${wanted}`);
  }
  await tab.page.keyboard.press("Control+Backslash");
  await overlay.waitFor("Ctrl+\\ didn't hide Critiqs", (seen) => seen.toolbar === null, 3000);
  await tab.page.keyboard.press("Control+Backslash");
  await overlay.waitFor("Ctrl+\\ didn't show Critiqs again", (seen) => seen.toolbar !== null, 3000);
  await tab.page.close();
  if (reached.length > 0) throw new Error(`The page's own listeners got ${reached.length} keys typed into Critiqs: ${reached.slice(0, 10).join(", ")}.`);
  return `0 keys reached the page's listeners; ${modes.join(", ")}; Escape closed the comment box; Ctrl+\\ hid and showed Critiqs`;
});

await run.case("A6.4", "In a 600 px wide window: the sidebar fills the window, the toolbar fits, the comment box stays inside the viewport", async () => {
  const { overlay, tab } = await reviewing();
  await tab.page.setViewportSize({ width: 600, height: 800 });
  try {
    const seen = await overlay.toolbar();
    if (seen.toolbar!.x < 0 || seen.toolbar!.x + seen.toolbar!.width > 600) throw new Error(`The toolbar at ${box(seen.toolbar)} doesn't fit 600 px.`);
    await overlay.click({ button: { pattern: "^(Project|Comments)" } });
    const open = await overlay.waitFor("no sidebar", (now) => now.sidebar !== null, 5000);
    if (open.sidebar!.width < 598) throw new Error(`The sidebar is ${Math.round(open.sidebar!.width)} px wide in a 600 px window.`);
    await overlay.click({ button: "Close sidebar" });
    await commentMode(overlay);
    await overlay.pick('[data-critiqs-id="team.save"]');
    const composing = await overlay.waitFor("no comment box", (now) => now.commentBox !== null, 5000);
    const r = composing.commentBox!;
    if (r.x < 0 || r.y < 0 || r.x + r.width > 600 || r.y + r.height > 800) throw new Error(`The comment box at ${box(r)} leaves the 600×800 viewport.`);
    return `Toolbar at ${box(seen.toolbar)}; sidebar ${Math.round(open.sidebar!.width)} px; comment box at ${box(r)}`;
  } finally {
    await tab.page.close();
  }
});

// ---------------------------------------------------------------------------
// A7. The page's life

let life: Open | null = null;
await run.case("A7.1", "Reload: Critiqs comes back by itself within 3 s, in Browse mode, with the pins drawn", async () => {
  life = await reviewing();
  await life.tab.page.keyboard.press("c");
  const reloaded = Date.now();
  await life.tab.page.reload();
  const seen = await life.overlay.waitFor("Critiqs didn't come back by itself within 3 s of the reload", (now) => now.toolbar !== null && now.pins.length > 0, 3000);
  if (seen.mode !== "browse") throw new Error(`It came back in ${seen.mode} mode.`);
  return `Back ${Date.now() - reloaded} ms after the reload, Browse mode, ${seen.pins.length} pins`;
});

await run.case("A7.2", "Client-side navigation (pushState): the toolbar stays and the pins change to the new screen's", async () => {
  const open = life ?? (await reviewing());
  run.page = open.tab.page;
  const before = await open.overlay.waitFor("no pins on the first screen", (seen) => seen.toolbar !== null && seen.pins.length > 0, 10_000);
  await open.tab.page.evaluate(() => (window as any).__go("/second"));
  const billing = (await open.tab.page.locator('[data-critiqs-id="team.billing"]').boundingBox())!;
  const after = await open.overlay.waitFor("the pins didn't change to the billing screen's", (seen) => seen.toolbar !== null && seen.pins.length === 1 && gap(seen.pins[0]!, billing) <= 24, 10_000);
  await open.tab.page.evaluate(() => (window as any).__go("/"));
  return `${before.pins.length} pins on /, then ${after.pins.length} beside the billing screen's button after pushState; toolbar kept`;
});

await run.case("A7.3", "Another site in the tab: nothing of Critiqs until its icon is clicked; clicking there works", async () => {
  const open = life ?? (await reviewing());
  run.page = open.tab.page;
  await open.tab.page.goto(site("elsewhere"));
  await Bun.sleep(2000);
  const view = await pageView(open.tab);
  if (view.roots > 0) throw new Error(`${view.roots} critiqs-root on the other site before any click.`);
  await browser.clickIcon(open.tab);
  const seen = await open.overlay.waitFor("nothing of Critiqs after clicking on the other site", (now) => now.toolbar !== null || now.headings.length > 0, 10_000);
  return `Nothing before the click; after it ${seen.toolbar !== null ? "the toolbar" : `"${seen.headings[0]}"`}`;
});

await run.case("A7.4", "Back to the first site in the same tab: nothing until the icon is clicked", async () => {
  const open = life ?? (await reviewing());
  run.page = open.tab.page;
  await open.tab.page.goto(site("proto"));
  await Bun.sleep(2500);
  const view = await pageView(open.tab);
  if (view.roots > 0) throw new Error(`${view.roots} critiqs-root back on the first site before any click.`);
  await clickForToolbar(browser, open);
  await open.tab.page.close();
  return "Nothing until the click; then the toolbar";
});

await run.person("A7.5", "Show comments here automatically → on: Chrome asks for that one site; a new tab on the site shows Critiqs within 3 s with no click", "Chrome's own permission prompt can't be answered through DevTools.");
await run.person("A7.6", "→ off: reloading shows nothing until a click, and Details → Site access no longer lists the site", "Follows A7.5, which needs Chrome's own prompt; whether Site access drops a site allowed through the prompt needs that prompt.");

await run.case("A7.7", "Two tabs, one project: a comment made in tab 1 appears as a pin in tab 2 within 5 s, with no click in tab 2", async () => {
  const one = await reviewing();
  const two = await reviewing(site("two"));
  run.page = one.tab.page;
  await one.tab.page.bringToFront();
  const before = (await two.overlay.seen()).pins.length;
  await comment(one.overlay, '[data-critiqs-id="team.save"]', "Seen in the other tab");
  const sent = Date.now();
  await two.overlay.waitFor("no new pin in tab 2 within 5 s", (seen) => seen.pins.length > before, 5000);
  await one.tab.page.close();
  await two.tab.page.close();
  return `Tab 2 went from ${before} to ${before + 1}+ pins ${Date.now() - sent} ms after tab 1's comment`;
});

await run.case("A7.8", "A site with Critiqs installed: the badge shows ✓, the title says Built in, and only the site's own critiqs-root is on the page", async () => {
  if (elementScript === "") throw new NotRun("the critiqs package isn't built (bun run build in packages/critiqs), so the page with Critiqs installed can't load");
  await ensureSignedIn();
  const open = await openPage(browser, site("installed"));
  run.page = open.tab.page;
  await open.tab.page.waitForFunction(() => document.querySelector("critiqs-app") != null, undefined, { timeout: 10_000 });
  await browser.clickIcon(open.tab);
  await Bun.sleep(2000);
  const badge = await browser.inWorker((tabId: number) => {
    const action = (globalThis as any).chrome.action;
    return Promise.all([action.getBadgeText({ tabId }), action.getTitle({ tabId })]);
  }, await browser.tabId(open.tab));
  const view = await pageView(open.tab);
  await open.tab.page.close();
  const problems: string[] = [];
  if (badge[0] !== "✓") problems.push(`the badge says ${JSON.stringify(badge[0])}`);
  if (!/Built in/.test(badge[1])) problems.push(`the title says ${JSON.stringify(badge[1])}`);
  if (view.roots !== 1) problems.push(`${view.roots} critiqs-root on the page`);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Badge ✓, title "${badge[1]}", 1 critiqs-root (the site's own)`;
});

await run.case("A7.9", "A page Chrome protects (chrome://version): the icon opens its popup, \"Critiqs can't open here\"; on a normal page afterwards the icon works as A1.2", async () => {
  const protectedTab = await browser.openTab("chrome://version");
  run.page = protectedTab.page;
  const before = new Set((await browser.targets()).map((target) => target.targetId));
  await browser.clickIcon(protectedTab);
  let popupText = "";
  await waitUntil("the icon's popup", async () => {
    const popup = (await browser.targets()).find((target) => !before.has(target.targetId) && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`) && target.type !== "service_worker");
    if (popup === undefined) return false;
    const { sessionId } = await browser.devtools.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true });
    const answer = await browser.devtools.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }, sessionId);
    popupText = String(answer.result?.value ?? "");
    return popupText.includes("Critiqs can't open here");
  }, 5000).catch(() => undefined);
  await protectedTab.page.close();
  if (!popupText.includes("Critiqs can't open here")) {
    const panels = await panelTargets();
    throw new Error(`No popup saying "Critiqs can't open here"${popupText === "" ? "" : ` (a popup said "${popupText.slice(0, 120)}")`}${panels.length > 0 ? `; a side panel opened instead (${panels[0]!.url})` : ""}.`);
  }
  const open = await reviewing();
  await open.tab.page.close();
  return `Popup: "${popupText.replace(/\s+/g, " ").slice(0, 120)}"; afterwards the icon showed the toolbar on a normal page in ${open.clickToToolbarMs} ms`;
});

await run.case("A7.10", "The extension reloads while Critiqs is open: within 5 s the old Critiqs removes itself, no error repeats in the page's console, and clicking the icon starts the new one", async () => {
  const open = await reviewing();
  const errors: string[] = [];
  open.tab.page.on("console", (message: any) => message.type() === "error" && errors.push(message.text()));
  const reloadedAt = Date.now();
  await browser.reloadExtension();
  await waitUntil("the old Critiqs to leave the page within 5 s", async () => (await pageView(open.tab)).roots === 0, 5000).catch(async () => {
    throw new Error(`The old Critiqs is still on the page 5 s after the extension reloaded (${(await pageView(open.tab)).roots} critiqs-root).`);
  });
  const goneMs = Date.now() - reloadedAt;
  await Bun.sleep(3000);
  const repeated = [...new Set(errors)].filter((text) => errors.filter((other) => other === text).length > 1);
  if (repeated.length > 0) throw new Error(`Repeated console errors: ${repeated.slice(0, 3).join(" | ")}.`);
  await clickForToolbar(browser, open);
  await open.tab.page.close();
  return `Gone ${goneMs} ms after the reload; ${errors.length} console errors, none repeated; the icon started the new one`;
});

// ---------------------------------------------------------------------------
// A9. What the package records

await run.case("A9.1", "Threads made from the extension have madeWith: extension", async () => {
  if (saved === null) throw new NotRun("no comment was saved in A4.3");
  const dana = await asDana();
  const made = await Promise.all((await threads(dana, acme)).filter((summary) => summary.preview?.authorName !== "Erin Admin").map(async (summary) => (await threadPage(dana, summary._id)).madeWith));
  const wrong = made.filter((value) => value !== "extension");
  if (made.length === 0) throw new Error("No thread from the extension to check.");
  if (wrong.length > 0) throw new Error(`${wrong.length} of ${made.length} threads made on the page say ${JSON.stringify([...new Set(wrong)])}.`);
  return `${made.length} threads made on the page, all madeWith "extension"`;
});

await run.case("A9.2", "Through the whole run, no request reaches /critiqs/connected from a page Critiqs is open on, and the project's connectedAt stays empty", async () => {
  const reports = browser.requests.filter((request) => request.url.includes("/critiqs/connected") && !request.from.includes("installed.critiqs.test"));
  const dana = await asDana();
  const any = (await threads(dana, acme))[0];
  const connectedAt = any === undefined ? null : (await threadPage(dana, any._id)).connectedAt;
  if (reports.length > 0) throw new Error(`${reports.length} Connected reports: ${reports.map((request) => `from ${request.from}`).slice(0, 3).join(", ")}; connectedAt ${connectedAt}.`);
  if (connectedAt !== null) throw new Error(`The project's connectedAt is ${new Date(connectedAt).toISOString()}.`);
  return `0 requests to /critiqs/connected from reviewed pages; Acme prototype's connectedAt is empty`;
});

await run.case("A9.3", "No regression: the installed Critiqs still reports Connected once and saves threads without madeWith", async () => {
  if (elementScript === "") throw new NotRun("the critiqs package isn't built (bun run build in packages/critiqs), so the page with Critiqs installed can't load");
  const page = await browser.context.newPage();
  run.page = page;
  const since = Date.now();
  // The installed Critiqs runs in the page's own world: count the reports it sends there, across loads.
  await page.addInitScript(() => {
    const sent = Number(sessionStorage.getItem("acceptance:connected") ?? 0);
    sessionStorage.setItem("acceptance:connected", String(sent));
    const original = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      if (String(input instanceof Request ? input.url : input).includes("/critiqs/connected")) sessionStorage.setItem("acceptance:connected", String(Number(sessionStorage.getItem("acceptance:connected")) + 1));
      return original.call(this, input, init);
    };
  });
  await page.goto(site("installed"));
  const widget = page.locator("critiqs-root").first();
  await widget.locator('[role="toolbar"]').first().waitFor({ timeout: 30_000 });
  await Bun.sleep(1500);
  const firstLoad = Number(await page.evaluate(() => sessionStorage.getItem("acceptance:connected")));
  await page.reload();
  await widget.locator('[role="toolbar"]').first().waitFor({ timeout: 30_000 });
  await Bun.sleep(1500);
  const reported = Number(await page.evaluate(() => sessionStorage.getItem("acceptance:connected")));
  const reports = browser.requests.filter((request) => request.at >= since && request.url.includes("/critiqs/connected") && request.from.includes("installed.critiqs.test"));
  // Sign in to the installed Critiqs through its own sign-in window, then comment with the real mouse and keyboard.
  const popup = browser.context.waitForEvent("page", { timeout: 15_000 });
  await widget.getByRole("button", { name: "Sign in" }).first().click();
  const window = await popup;
  for (let attempt = 0; attempt < 60 && !window.isClosed(); attempt++) {
    await Bun.sleep(500);
    if (window.isClosed()) break;
    if ((await window.locator("input[name=email]:visible").count().catch(() => 0)) > 0 && (await window.locator("input[name=email]").inputValue().catch(() => "")) === "") {
      await window.locator("input[name=email]").fill(DANA.email);
      await window.getByRole("button", { name: /Send code/ }).click().catch(() => undefined);
    } else if ((await window.locator("input[name=code]:visible").count().catch(() => 0)) > 0 && (await window.locator("input[name=code]").inputValue().catch(() => "")) === "") {
      const found = /Development code:\s*(\d{6})/.exec(await window.locator("body").innerText().catch(() => ""))?.[1];
      if (found !== undefined) await window.locator("input[name=code]").fill(found).then(() => window.locator("input[name=code]").press("Enter"));
    } else {
      const allow = window.getByRole("button", { name: /^(Allow this site|Allow|Continue|Approve)/ });
      if ((await allow.count().catch(() => 0)) > 0) await allow.first().click().catch(() => undefined);
    }
  }
  await widget.getByRole("button", { name: /Signed in as/ }).waitFor({ timeout: 30_000 });
  await page.keyboard.press("c");
  const heading = (await page.locator("h1").boundingBox())!;
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.mouse.move(heading.x - 20, heading.y + 80, { steps: 2 });
    await page.mouse.move(heading.x + 20, heading.y + heading.height / 2, { steps: 4 });
    if ((await widget.locator(".target-box").count()) > 0) break;
  }
  await page.mouse.click(heading.x + 20, heading.y + heading.height / 2);
  await widget.locator('form[aria-label="New comment"]').waitFor({ timeout: 10_000 });
  await page.keyboard.type("Left on the installed page");
  await page.keyboard.press("Control+Enter");
  const made = await savedThread(await asDana(), installed, "Left on the installed page", 15_000);
  const recorded = await threadPage(await asDana(), made._id);
  await page.close();
  const problems: string[] = [];
  // "Once": the first load reports (the package may send again within that load when an answer fails), the next load doesn't.
  if (firstLoad < 1 || reported !== firstLoad) problems.push(`the installed Critiqs sent ${firstLoad} Connected reports on the first load and ${reported - firstLoad} on the second (the network log shows ${reports.length})`);
  if (recorded.madeWith === "extension") problems.push("the installed Critiqs's thread says madeWith extension");
  if (recorded.connectedAt === null) problems.push("the project's connectedAt is empty");
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Connected reported on the first load (${firstLoad} request${firstLoad === 1 ? "" : "s"}), none on the second (connectedAt ${new Date(recorded.connectedAt!).toISOString()}); the installed Critiqs's thread was sent without madeWith (recorded "${recorded.madeWith ?? "none"}")`;
});

// ---------------------------------------------------------------------------
// A10. The store's build

await run.case("A10.1", "bun run package twice gives the same bytes; the zip's manifest has no key and the permissions of A1.1", async () => {
  const digests: string[] = [];
  let zipped: Record<string, any> = {};
  for (const name of ["first", "second"]) {
    const release = join(scratch, `release-${name}`);
    const packaged = Bun.spawn(["bun", "scripts/package.ts"], { cwd: here, env: { ...process.env, CRITIQS_RELEASE_DIR: release }, stdout: "ignore", stderr: "pipe" });
    if ((await packaged.exited) !== 0) throw new Error(`bun run package failed: ${(await new Response(packaged.stderr).text()).slice(0, 300)}`);
    const zip = (await Array.fromAsync(new Bun.Glob("*.zip").scan(release)))[0]!;
    digests.push(new Bun.CryptoHasher("sha256").update(await Bun.file(join(release, zip)).arrayBuffer()).digest("hex"));
    zipped = JSON.parse((await Bun.$`unzip -p ${join(release, zip)} manifest.json`.quiet()).stdout.toString());
  }
  const problems = manifestProblems(zipped);
  if (digests[0] !== digests[1]) problems.unshift(`two builds differ (${digests.join(" ≠ ")})`);
  if ("key" in zipped) problems.push("the zip's manifest has a key");
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `Both zips sha256 ${digests[0]}; no key; permissions ${JSON.stringify(zipped.permissions)}`;
});

await run.case("A10.2", "store/listing.md's permission table names exactly the manifest's permissions (the manifest test)", async () => {
  const tested = Bun.spawn(["bun", "test", "test/manifest.test.ts"], { cwd: here, stdout: "pipe", stderr: "pipe" });
  const output = (await new Response(tested.stderr).text()) + (await new Response(tested.stdout).text());
  if ((await tested.exited) !== 0) throw new Error(`The manifest test failed: ${output.split("\n").filter((line) => /fail|error|expect/i.test(line)).slice(0, 6).join(" | ")}`);
  return output.split("\n").find((line) => /\d+ pass/.test(line))?.trim() ?? "passed";
});

// ---------------------------------------------------------------------------
// Report

const commit = (await Bun.$`git -C ${here} rev-parse --short HEAD`.nothrow().quiet()).stdout.toString().trim();
await run.write([
  `Commit ${commit}; extension ${manifest.version} from ${process.env.CRITIQS_EXTENSION_DIR ? extensionDir : "this checkout (real build)"}; ${browser.browser.version()}; backend ${backend}; ${new Date().toISOString()}.`,
  seeded === "" ? "" : `Note: ${seeded}`,
]);
await browser.close();
sites.stop();
process.exit(run.counts().fail > 0 ? 1 : 0);
