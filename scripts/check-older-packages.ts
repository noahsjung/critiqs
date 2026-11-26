// Older published packages against the current backends. For every version
// the support window keeps supported (scripts/support-window.ts, read from the
// registries), it installs that version from its registry into a small app and
// drives the real flow in Chrome against a fresh local Convex deployment of
// packages/backend and against the self-hosted server from packages/server:
// sign in with a development code, create a project, post a comment with its
// capture, reply, then reload and read the thread, the reply, and the capture
// back. It fails when the current backends break anything one of those
// versions relies on.
//
//   bun scripts/check-older-packages.ts [--backend convex|self-hosted] [--only <package>@<version>] [--current]
//
// --current runs the same flows with the workspace's own packed packages
// instead, which proves each driver works before a version needs it.
// Needs the npm registry, Chrome (CHROME_PATH), and, for Convex, the Convex
// CLI's local backend (downloaded on first use). CRITIQS_EVIDENCE_DIR keeps
// screenshots; CRITIQS_PORT_BASE makes it use ports from that one up. Run `bun run build` first for --current.
import assert from "node:assert/strict";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chrome, pack, playwright, ROOT, run, scratch, waitForServer } from "./consumer-kit.ts";
import { supportedPackages } from "./support-window.ts";

type Backend = "convex" | "self-hosted";

/**
 * How a package's version reaches a browser. critiqs-react ships its own
 * client; every other Critiqs package ships the `critiqs` element at the same
 * shared version (the framework wrappers on npm depend on it exactly, and the
 * Rails, Django, and Flask packages bundle its element.js), so testing
 * `critiqs@<version>` tests the backend calls of all of them.
 */
type Client = "react" | "element";
const clientOf = (name: string): Client => (name === "critiqs-react" ? "react" : "element");

interface Target {
  /** What the log and evidence name it by, such as critiqs-react@0.3.0. */
  label: string;
  client: Client;
  /** npm install specifiers: registry versions, or packed tarballs with --current. */
  install: string[];
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const backends: Backend[] = option("backend") ? [option("backend") as Backend] : ["convex", "self-hosted"];
assert(backends.every((b) => b === "convex" || b === "self-hosted"), "--backend is convex or self-hosted");
const evidence = process.env.CRITIQS_EVIDENCE_DIR;
const work = await scratch("older-packages");
const stops: (() => Promise<void> | void)[] = [];
const results: string[] = [];

let nextPort = Number(process.env.CRITIQS_PORT_BASE ?? 0);

/** A port nothing listens on yet: the next from CRITIQS_PORT_BASE when it is set, otherwise any. */
function freePort(): number {
  if (nextPort > 0) return nextPort++;
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port!;
}

async function targets(): Promise<Target[]> {
  if (args.includes("--current")) {
    const shared = `file:${await pack("packages/critiqs", work)}`;
    const react = `file:${await pack("packages/react", work)}`;
    return [
      { label: "workspace critiqs-react", client: "react", install: [shared, react] },
      { label: "workspace critiqs", client: "element", install: [shared] },
    ];
  }
  const found: Target[] = [];
  const byClient = new Map<string, Target>();
  for (const { pkg, registryName, supported } of await supportedPackages(ROOT)) {
    for (const { version, line, until } of supported) {
      const client = clientOf(pkg.name);
      console.log(`${registryName}@${version} (${pkg.registry}) is supported: line ${line}, ${until === null ? "the newest line" : `until ${until.toISOString().slice(0, 10)}`}.`);
      // Packages that share the element at one version are tested once.
      const key = `${client}@${version}`;
      if (byClient.has(key)) continue;
      const target: Target = client === "react"
        ? { label: `critiqs-react@${version}`, client, install: [`critiqs-react@${version}`] }
        : { label: `critiqs@${version}`, client, install: [`critiqs@${version}`] };
      byClient.set(key, target);
      found.push(target);
    }
  }
  const only = option("only");
  return only === undefined ? found : found.filter((t) => t.label === only);
}

// ---------------------------------------------------------------- the app

/** The page: some content to comment on, and Critiqs, whose backend the server sets in window.CRITIQS_BACKEND. */
const PAGE_CONTENT = `<main style="font: 16px system-ui; padding: 48px; max-width: 720px">
  <h1>Older package check</h1>
  <p id="target" style="padding: 24px; background: #eef">A paragraph a reviewer comments on.</p>
</main>`;

const ENTRY: Record<Client, string> = {
  react: `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Critiqs } from "critiqs-react";
const mount = document.createElement("div");
document.body.append(mount);
createRoot(mount).render(createElement(Critiqs, { backend: window.CRITIQS_BACKEND }));
`,
  element: `import "critiqs/element";
const element = document.createElement("critiqs-app");
element.setAttribute("backend", window.CRITIQS_BACKEND);
document.body.append(element);
`,
};

/** Installs the target from its registry (or the packed files) into an app and bundles it; returns the app's folder. */
async function buildApp(target: Target): Promise<string> {
  const dir = join(work, target.label.replace(/[^a-z0-9.@-]+/gi, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "older-package-app", private: true, type: "module" }));
  const react = target.client === "react" ? ["react@19", "react-dom@19"] : [];
  await run(["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts", ...target.install, ...react], dir);
  await writeFile(join(dir, "entry.js"), ENTRY[target.client]);
  const built = await Bun.build({
    entrypoints: [join(dir, "entry.js")],
    outdir: join(dir, "dist"),
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!built.success) throw new Error(`${target.label}: the app didn't build:\n${built.logs.join("\n")}`);
  const installed = await Bun.file(join(dir, "node_modules", target.client === "react" ? "critiqs-react" : "critiqs", "package.json")).json();
  console.log(`${target.label}: installed ${installed.name}@${installed.version} and built the app.`);
  return dir;
}

/** Serves the app at `/`, with the page's backend setting, and `extra` for anything else it answers. */
function serveApp(dir: string, backend: string, extra?: (request: Request) => Promise<Response | null>) {
  const html = `<!doctype html><meta charset="utf-8"><title>Older package check</title>
<script>window.CRITIQS_BACKEND = ${JSON.stringify(backend)};</script>
${PAGE_CONTENT}<script type="module" src="/entry.js"></script>`;
  const port = freePort();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const answer = await extra?.(request);
      if (answer) return answer;
      const { pathname } = new URL(request.url);
      if (pathname === "/entry.js") return new Response(Bun.file(join(dir, "dist/entry.js")), { headers: { "content-type": "text/javascript" } });
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${port}/`;
}

// ---------------------------------------------------------------- the backends

/** The current self-hosted server (what critiqs-react/server and critiqs/server bundle), with development sign-in. */
async function selfHosted(dir: string): Promise<string> {
  const { createCritiqsHandler } = await import(join(ROOT, "packages/server/src/http/index.ts"));
  const data = join(work, `self-hosted-${Date.now()}`);
  await mkdir(data, { recursive: true });
  const critiqs = await createCritiqsHandler({ database: join(data, "critiqs.sqlite"), developmentSignIn: true });
  return serveApp(dir, "/critiqs", async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== "/critiqs" && !pathname.startsWith("/critiqs/")) return null;
    return critiqs.fetch(request, { remoteAddress: "127.0.0.1" });
  });
}

let convexUrl: Promise<string> | null = null;

/**
 * A fresh local Convex deployment of packages/backend, set up as its own
 * sign-in service with development sign-in. It runs from a copy, so a
 * developer's own deployment settings in packages/backend are never touched,
 * and keeps its state in that copy.
 */
function convex(): Promise<string> {
  convexUrl ??= (async () => {
    const dir = join(work, "convex");
    await mkdir(dir, { recursive: true });
    for (const entry of ["convex", "scripts", "package.json"]) await cp(join(ROOT, "packages/backend", entry), join(dir, entry), { recursive: true });
    await rm(join(dir, "convex/_generated"), { recursive: true, force: true }).catch(() => {});
    await cp(join(ROOT, "packages/backend/convex/_generated"), join(dir, "convex/_generated"), { recursive: true });
    await symlink(join(ROOT, "packages/backend/node_modules"), join(dir, "node_modules"));
    const [cloud, site] = [freePort(), freePort()];
    const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous", CONVEX_TMPDIR: process.env.TMPDIR };
    const log = Bun.file(join(dir, "convex.log"));
    const child = Bun.spawn(
      ["node_modules/.bin/convex", "dev", "--local-cloud-port", String(cloud), "--local-site-port", String(site), "--typecheck", "disable", "--tail-logs", "always"],
      // Its own process group: the CLI starts the local backend as a child that outlives it otherwise.
      { cwd: dir, env, stdout: log, stderr: log, stdin: "ignore", detached: true },
    );
    stops.push(async () => {
      const group = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      };
      group("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      await Bun.sleep(500);
      group("SIGKILL");
    });
    const until = async (pattern: RegExp, seconds: number) => {
      for (let i = 0; i < seconds * 2; i++) {
        if (pattern.test(await log.text().catch(() => ""))) return;
        if (child.exitCode !== null) break;
        await Bun.sleep(500);
      }
      throw new Error(`Convex didn't print ${pattern} within ${seconds} s:\n${(await log.text().catch(() => "")).slice(-3000)}`);
    };
    await until(/CONVEX_SITE_URL|Preparing Convex functions/, 180);
    for (let i = 0; i < 60 && !(await Bun.file(join(dir, ".env.local")).exists()); i++) await Bun.sleep(500);
    await run(["bun", "scripts/setup-local.ts"], dir, env);
    await until(/Convex functions ready/, 180);
    await waitForServer(`http://127.0.0.1:${site}/.well-known/jwks.json`);
    console.log(`Convex: a fresh local deployment of packages/backend at http://127.0.0.1:${cloud} (sign-in at :${site}).`);
    return `http://127.0.0.1:${cloud}`;
  })();
  return convexUrl;
}

// ---------------------------------------------------------------- the flow

/** Playwright's page and locator, loosely: the check uses a small part of them. */
type Page = any;

const RUN = Date.now().toString(36);

async function shot(page: Page, name: string) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`) }).catch(() => {});
}

/** The visible text of Critiqs's sidebar and thread window. */
const critiqsText = (page: Page): Promise<string> =>
  page.evaluate(() => [...document.querySelectorAll("critiqs-root")]
    .flatMap((h) => [...(h.shadowRoot?.querySelectorAll("aside, .thread-window") ?? [])].map((el) => (el as HTMLElement).innerText))
    .join("\n"));

/** The sign-in window: email, the development code it shows, a name, and allowing the site. */
async function signInWindow(popup: Page, email: string, name: string, label: string) {
  // The window closes itself once sign-in finishes, sometimes during the last step's action.
  const ignoreClosed = (error: Error) => {
    if (!popup.isClosed()) throw error;
  };
  await popup.waitForLoadState("load").catch(() => {});
  const done = new Set<string>();
  for (let i = 0; i < 60 && !popup.isClosed(); i++) {
    await Bun.sleep(500);
    if (popup.isClosed()) break;
    const text: string = await popup.evaluate(() => document.body.innerText).catch(() => "");
    if (!done.has("email") && (await popup.locator("input[name=email]:visible").count().catch(() => 0))) {
      done.add("email");
      await popup.locator("input[name=email]").fill(email).catch(ignoreClosed);
      await popup.getByRole("button", { name: /Send code|Continue/ }).first().click().catch(ignoreClosed);
    } else if (!done.has("code") && (await popup.locator("input[name=code]:visible").count().catch(() => 0))) {
      const code = (/Development code:\s*(\d{6})/.exec(text) ?? /\b(\d{6})\b/.exec(text))?.[1]
        ?? (/(?:\d[ \u2009\u00a0]?){6}/.exec(text)?.[0] ?? "").replace(/\D/g, "");
      if (code.length !== 6) continue;
      done.add("code");
      await shot(popup, `${label}-sign-in-code`);
      await popup.locator("input[name=code]").fill(code).catch(ignoreClosed);
      await popup.locator("input[name=code]").press("Enter").catch(ignoreClosed);
    } else if (!done.has("name") && (await popup.locator("input[name=name]:visible").count().catch(() => 0))) {
      done.add("name");
      await popup.locator("input[name=name]").fill(name).catch(ignoreClosed);
      await popup.locator("input[name=name]").press("Enter").catch(ignoreClosed);
    } else {
      const allow = popup.getByRole("button", { name: /^(Allow|Continue|Approve)/ });
      if (await allow.count().catch(() => 0)) await allow.first().click().catch(() => {});
    }
  }
  if (!popup.isClosed()) {
    await shot(popup, `${label}-sign-in-stuck`);
    throw new Error(`The sign-in window stayed open: ${(await popup.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 400)}`);
  }
}

/** Waits until `condition` holds in the page, or throws `message` with Critiqs's text. */
async function expectIn(page: Page, label: string, message: string, condition: () => Promise<boolean>, seconds = 30) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await condition().catch(() => false)) return;
    await Bun.sleep(250);
  }
  await shot(page, `${label}-failed`);
  throw new Error(`${label}: ${message}. Critiqs shows: ${(await critiqsText(page).catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`);
}

/**
 * Sign in, create a project, comment with a capture, reply; then a new page
 * in the same browser reads the thread, reply, and capture back.
 */
async function flow(url: string, label: string) {
  const { chromium } = await playwright();
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => errors.push(String(error)));
    page.on("dialog", (dialog: { accept(): Promise<void> }) => dialog.accept());
    await page.goto(url);
    const critiqs = page.locator("critiqs-root");
    await critiqs.locator("[role=toolbar]").first().waitFor({ timeout: 30_000 });
    await shot(page, `${label}-1-loaded`);

    // Sign in.
    const popupOpened = context.waitForEvent("page", { timeout: 15_000 });
    await critiqs.getByRole("button", { name: "Sign in" }).first().click();
    await signInWindow(await popupOpened, `older+${RUN}@example.com`, "Olive Older", label);
    await critiqs.getByRole("button", { name: /Signed in as/ }).first().waitFor({ timeout: 30_000 });
    await shot(page, `${label}-2-signed-in`);

    // Create a project.
    await critiqs.getByRole("button", { name: "Set up Critiqs" }).first().click();
    await critiqs.getByLabel("Project name").fill(`Older package ${RUN}`);
    await critiqs.getByRole("button", { name: "Create project" }).click();
    await expectIn(page, label, "the project wasn't created", async () => /Project created/.test(await critiqsText(page)));
    await shot(page, `${label}-3-project`);
    await critiqs.getByRole("button", { name: "Start commenting" }).click().catch(() => {});

    // Comment on the paragraph; the component captures the screen with it.
    const comment = `Older comment ${RUN}`;
    if (!(await critiqs.locator(".mode-hint").count())) await critiqs.getByRole("button", { name: "Comment mode" }).click();
    const box = await page.locator("#target").boundingBox();
    await page.mouse.move(box.x + 4, box.y + 4, { steps: 4 });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await critiqs.locator(".tag-field").first().waitFor({ timeout: 10_000 });
    await page.keyboard.type(comment);
    await critiqs.getByRole("button", { name: "Comment", exact: true }).click();
    await critiqs.locator(".pin").first().waitFor({ timeout: 30_000 });
    const thread = critiqs.locator(".thread-window");
    await thread.waitFor({ timeout: 15_000 });
    await shot(page, `${label}-4-commented`);

    // Reply.
    const reply = `Older reply ${RUN}`;
    await thread.locator(".tag-field").last().click();
    await page.keyboard.type(reply);
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expectIn(page, label, "the reply didn't post", async () =>
      (await thread.getByText(reply).count()) > 0 && (await thread.locator(".tag-field").last().evaluate((el: HTMLElement) => el.textContent?.trim() ?? "")) === "");
    await expectIn(page, label, "the comment's capture didn't appear", async () => capturesShown(page), 60);
    await shot(page, `${label}-5-replied`);

    // Read it all back in a new page: from the backend, not from this page's memory.
    const again = await context.newPage();
    again.on("pageerror", (error: Error) => errors.push(String(error)));
    await again.goto(url);
    const root = again.locator("critiqs-root");
    await root.getByRole("button", { name: /Signed in as/ }).first().waitFor({ timeout: 30_000 });
    await expectIn(again, label, "the pin didn't come back after a reload", async () => (await root.locator(".pin").count()) > 0);
    await root.locator(".pin").first().click();
    await expectIn(again, label, "the thread didn't come back after a reload", async () => {
      const text = await critiqsText(again);
      return text.includes(comment) && text.includes(reply);
    });
    await expectIn(again, label, "the capture didn't come back after a reload", async () => capturesShown(again), 60);
    // Open the saved context, where the capture is, for the screenshot.
    await root.locator(".thread-window summary", { hasText: "Saved context" }).first().click({ timeout: 2_000 }).catch(() => {});
    await shot(again, `${label}-6-read-back`);
    assert.deepEqual(errors, [], `${label}: page errors`);
  } finally {
    await browser.close();
  }
}

/** Whether the thread window has the comment's capture, loaded from the backend and decoded (not a broken image). */
const capturesShown = (page: Page): Promise<boolean> =>
  page.evaluate(() => [...document.querySelectorAll("critiqs-root")].some((h) =>
    [...(h.shadowRoot?.querySelectorAll(".thread-window img.capture") ?? [])].some((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 1)));

// ---------------------------------------------------------------- run

try {
  const list = await targets();
  if (list.length === 0) {
    console.log("No supported published version to check: nothing in the release group has a stable release in its support window.");
  }
  for (const target of list) {
    const dir = await buildApp(target);
    for (const backend of backends) {
      const label = `${target.label.replace(/[^a-z0-9.@-]+/gi, "-")}-${backend}`;
      const started = performance.now();
      const url = backend === "self-hosted" ? await selfHosted(dir) : serveApp(dir, await convex());
      await flow(url, label);
      results.push(`${target.label} against the current ${backend === "convex" ? "Convex backend" : "self-hosted server"}: signed in, created a project, commented with a capture, replied, and read all three back (${Math.round((performance.now() - started) / 1000)} s)`);
      console.log(results.at(-1));
    }
  }
  console.log(`Older packages passed: ${results.length} flows.`);
} finally {
  for (const stop of stops.reverse()) await stop();
  if (!process.env.CRITIQS_KEEP) await rm(work, { recursive: true, force: true }).catch(() => {});
}
