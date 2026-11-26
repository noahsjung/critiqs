// Browser walks for one verify-critiqs instance. Run through walk.sh, which sets Node 24 and the tools path.
//   walk.sh --data DIR --feature onboarding|comment|all --out DIR
// Each step saves a screenshot to OUT and a line to OUT/results.json: { step, ok, file, shown }.
// Exit code 1 when any step fails. Steps assert on visible text, never on rendered elements themselves.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FEATURES = ["onboarding", "comment"];
const usage = "usage: walk.sh --data DIR --feature onboarding|comment|all --out DIR";
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  const [flag, value] = [argv[i], argv[i + 1]];
  if (!["--data", "--feature", "--out"].includes(flag) || value === undefined) {
    console.error(`${flag} ${value === undefined ? "needs a value" : "is not an option"}\n${usage}`);
    process.exit(2);
  }
  args[flag.slice(2)] = value;
}
const { data: DATA, feature: FEATURE = "all", out: OUT } = args;
if (!DATA || !OUT || !(FEATURE === "all" || FEATURES.includes(FEATURE))) {
  console.error(usage);
  process.exit(2);
}
// stack.sh writes NAME=value lines with shell quoting; it only quotes values with spaces or symbols.
const env = Object.fromEntries(readFileSync(join(DATA, "stack.env"), "utf8").trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
if (Object.values(env).some((value) => /[\\'"$ ]/.test(value))) throw new Error(`keep the data folder path free of spaces and quotes: ${DATA}`);
const WEB = `http://127.0.0.1:${env.WEB_PORT}`;
const PILOT = `http://127.0.0.1:${env.PILOT_PORT}`;
const BACKEND = join(env.CHECKOUT, "packages/backend");
const { chromium } = await import(join(process.env.VERIFY_CRITIQS_TOOLS, "node_modules/playwright-core/index.mjs"));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = Date.now().toString(36);
const results = [];
let shotNumber = 0;
const convexData = (table) =>
  execFileSync("bunx", ["convex", "data", table, "--format", "jsonl", "--limit", "200"], { cwd: BACKEND, encoding: "utf8", env: process.env })
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
const has = async (locator) => (await locator.count().catch(() => 0)) > 0;

/** Visible text, including the widget's shadow root. */
const textOf = (page) =>
  page.evaluate(() => {
    const parts = [document.body.innerText];
    const walk = (node) => {
      for (const el of node.querySelectorAll("*")) if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) if (child.tagName !== "STYLE" && child.innerText) parts.push(child.innerText);
        walk(el.shadowRoot);
      }
    };
    walk(document);
    return parts.join("\n").replace(/\s+/g, " ").trim();
  });

async function shot(page, name) {
  await sleep(600);
  const file = `${String(++shotNumber).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: false });
  return file;
}

async function step(name, page, body) {
  try {
    const shown = await body();
    results.push({ step: name, ok: true, file: page ? await shot(page, name) : null, shown });
    console.log(`ok   ${name}: ${JSON.stringify(shown).slice(0, 200)}`);
    return shown;
  } catch (error) {
    results.push({ step: name, ok: false, file: page && !page.isClosed() ? await shot(page, `${name}-failed`).catch(() => null) : null, shown: String(error.message ?? error).slice(0, 400) });
    console.log(`FAIL ${name}: ${error.message ?? error}`);
    throw error;
  }
}

/** Finishes the backend's sign-in window: email, the development code shown on screen, a name, then allow. */
async function signInWindow(pop, email, name) {
  await pop.waitForLoadState("load").catch(() => {});
  const done = new Set();
  for (let i = 0; i < 60 && !pop.isClosed(); i++) {
    await sleep(500);
    if (pop.isClosed()) break;
    const text = await textOf(pop).catch(() => "");
    if (!done.has("email") && (await has(pop.locator("input[name=email]:visible")))) {
      done.add("email");
      await pop.locator("input[name=email]").fill(email);
      await pop.getByRole("button", { name: /Send code/ }).click().catch(() => {});
    } else if (!done.has("code") && (await has(pop.locator("input[name=code]:visible")))) {
      const code = (text.match(/Development code:\s*(\d{6})/) ?? [])[1];
      if (!code) continue;
      done.add("code");
      await pop.locator("input[name=code]").fill(code);
      await pop.locator("input[name=code]").press("Enter").catch(() => {});
    } else if (!done.has("name") && (await has(pop.locator("input[name=name]:visible")))) {
      done.add("name");
      await pop.locator("input[name=name]").fill(name);
      await pop.locator("input[name=name]").press("Enter").catch(() => {});
    } else {
      const allow = pop.getByRole("button", { name: /^(Allow this site|Allow|Continue|Approve)/ });
      if (await has(allow)) await allow.first().click().catch(() => {});
    }
  }
  if (!pop.isClosed()) throw new Error(`sign-in window stayed open: ${(await textOf(pop).catch(() => "")).slice(0, 200)}`);
}

async function signInThrough(context, click, email, name) {
  const popup = context.waitForEvent("page", { timeout: 15_000 });
  await click();
  await signInWindow(await popup, email, name);
}

async function onboarding(context) {
  const page = await context.newPage();
  const email = `owner-${run}@walk.example`;
  await step("onboarding-address", page, async () => {
    await page.goto(`${WEB}/start`);
    await page.getByText("What should your team review?").waitFor({ timeout: 30_000 });
    await page.getByLabel("Prototype link").fill(`https://prototype-${run}.example`);
    return { heading: "What should your team review?" };
  });
  await step("onboarding-sign-in", page, async () => {
    // Continue opens the sign-in window itself; "Sign in with email" shows only when that window was blocked.
    const popup = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
    await page.getByRole("button", { name: "Continue" }).click();
    let pop = await popup;
    if (!pop) {
      const again = context.waitForEvent("page", { timeout: 15_000 });
      await page.getByRole("button", { name: "Sign in with email" }).click();
      pop = await again;
    }
    await signInWindow(pop, email, "Walk Owner");
    await page.getByText("Who will add Critiqs to it?").waitFor({ timeout: 30_000 });
    return { signedInAs: email };
  });
  return step("onboarding-project-created", page, async () => {
    await page.getByRole("button", { name: /I will/ }).click();
    await page.getByText("Add Critiqs to your prototype").waitFor({ timeout: 30_000 });
    const projectId = (await textOf(page)).match(/npx critiqs-react init (\w+)/)?.[1];
    if (!projectId) throw new Error("the setup screen shows no `npx critiqs-react init <project ID>` command");
    const project = convexData("projects").find((row) => row._id === projectId);
    if (!project) throw new Error(`the command names project ${projectId}, which isn't saved`);
    if (!JSON.stringify(project).includes(`prototype-${run}.example`)) throw new Error(`project ${projectId} doesn't carry this run's address`);
    return { command: `npx critiqs-react init ${projectId}`, projectSaved: projectId };
  });
}

async function comment(context) {
  const page = await context.newPage();
  const widget = page.locator("critiq-root, critiqs-root");
  const email = `reviewer-${run}@walk.example`;
  await step("widget-sign-in", page, async () => {
    await page.goto(PILOT);
    await widget.locator("[role=toolbar]").first().waitFor({ timeout: 30_000 });
    await signInThrough(context, () => widget.getByRole("button", { name: "Sign in" }).first().click(), email, "Walk Reviewer");
    await widget.getByRole("button", { name: /Signed in as/ }).waitFor({ timeout: 30_000 });
    return { signedInAs: email };
  });
  await step("widget-project-created", page, async () => {
    await widget.getByRole("button", { name: "Set up Critiqs" }).first().click();
    await widget.getByLabel("Project name").fill(`Walk ${run}`);
    await widget.getByRole("button", { name: "Use this page" }).click().catch(() => {});
    await widget.getByRole("button", { name: "Create project" }).click();
    await widget.getByText("Project created").waitFor({ timeout: 30_000 });
    await widget.getByRole("button", { name: "Start commenting" }).click().catch(() => {});
    return { project: `Walk ${run}` };
  });
  const words = `Walk comment ${run}: this heading should be shorter.`;
  await step("widget-comment-posted", page, async () => {
    if (!(await has(widget.locator(".mode-hint")))) await widget.getByRole("button", { name: "Comment mode" }).click();
    const target = page.locator("h1, h2").first();
    const box = await target.boundingBox();
    if (!box) throw new Error("the sample app shows no heading to comment on");
    await page.mouse.move(box.x + 4, box.y + 4, { steps: 4 });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type(words, { delay: 3 });
    await widget.getByRole("button", { name: "Comment", exact: true }).click();
    await widget.locator(".thread-window").waitFor({ timeout: 30_000 });
    if (!(await textOf(page)).includes(words)) throw new Error("the thread window doesn't show the comment");
    return { comment: words };
  });
  const web = await context.newPage();
  return step("thread-page", web, async () => {
    // A comment's words are in `messages`; the thread page's key is on its `threads` row.
    const message = convexData("messages").find((row) => row.body === words);
    if (!message) throw new Error("the comment wasn't saved as a message");
    const thread = convexData("threads").find((row) => row._id === message.threadId);
    if (!thread?.pageKey) throw new Error(`thread ${message.threadId} has no page key`);
    await web.goto(`${WEB}/t/${thread.pageKey}`);
    for (let i = 0; i < 40 && !(await textOf(web)).includes(words); i++) {
      const signIn = web.getByRole("button", { name: /Sign in/ });
      if (await has(signIn)) await signInThrough(context, () => signIn.first().click(), email, "Walk Reviewer").catch(() => {});
      await sleep(500);
    }
    if (!(await textOf(web)).includes(words)) throw new Error(`thread page /t/${thread.pageKey} doesn't show the comment`);
    return { url: `/t/${thread.pageKey}` };
  });
}

const browser = await chromium.launch({ executablePath: process.env.CRITIQS_CHROME, chromiumSandbox: false });
let failed = false;
try {
  for (const [name, walk] of [["onboarding", onboarding], ["comment", comment]]) {
    if (FEATURE !== "all" && FEATURE !== name) continue;
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    try {
      await walk(context);
    } catch {
      failed = true;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ rev: env.REV_SHA, feature: FEATURE, results }, null, 2));
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} steps passed; evidence in ${OUT}`);
process.exit(failed || results.length === 0 ? 1 : 0);
