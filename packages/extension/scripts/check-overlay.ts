// What the page can and can't reach once Critiqs is on it, and how Critiqs
// lives with the worker, in real Chrome with the built extension: the strict
// page (a strict Content-Security-Policy and Trusted Types), the hostile page
// (patched globals, `* { all: unset !important }`, a key logger and a hunt
// for the session's tokens), the content script's storage refusal, made-up
// events and messages, the worker stopped while a second reviewer comments,
// the bundle's size and click-to-toolbar timing. Acceptance cases A8, A11 and
// A12, named by number, ending pass, fail or "not run" with the reason, in
// results.md with a screenshot per case. checklist.ts runs A1 to A10.
//
//   CRITIQS_BACKEND=http://127.0.0.1:3210 bun run check:overlay
//
// The reviewer is signed in by the run (through the sign-in service, from the
// extension's origin, and kept where the extension keeps its session):
// signing in on the page is checklist.ts's A2. Opt-in: CRITIQS_LIVE_MINUTES=17
// runs A11.2 and A11.3 (10 and 17 idle minutes); CRITIQS_REAL_SITES=1 runs
// A8.2 on github.com and accounts.google.com (needs the internet; Chrome runs
// with --disable-features=LocalNetworkAccessChecks so public pages reach a
// local backend). Other settings as checklist.ts: CHROME_PATH,
// PLAYWRIGHT_CORE, CRITIQS_EXTENSION_DIR, CRITIQS_EVIDENCE_DIR, CRITIQS_CASES,
// CRITIQS_SITES_PORT, CRITIQS_DEVTOOLS_PORT. Exits with 1 when a case fails.
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "@critiqs/backend/api";
import { Browser, EXTENSION_ID, waitUntil } from "./acceptance/browser.ts";
import { NotRun, Run } from "./acceptance/cases.ts";
import { beside, capturePixel, comment, type Open, showCritiqs } from "./acceptance/flows.ts";
import { box, Missing, type Overlay, type Seen } from "./acceptance/overlay.ts";
import { createProject, deployment, postThread, seedSession, signInDirectly, storedSession, threads } from "./acceptance/people.ts";
import { scratchRoot, startSites } from "./acceptance/sites.ts";

const here = fileURLToPath(new URL("../", import.meta.url));
const backend = process.env.CRITIQS_BACKEND ?? "";
if (backend === "") throw new Error("Set CRITIQS_BACKEND to a local Convex deployment with development sign-in.");
const scratch = await mkdtemp(join(scratchRoot(), "critiqs-overlay-"));
process.once("exit", () => void rm(scratch, { recursive: true, force: true }));
const evidence = process.env.CRITIQS_EVIDENCE_DIR ?? join(scratch, "evidence");
await mkdir(evidence, { recursive: true });
const liveMinutes = Number(process.env.CRITIQS_LIVE_MINUTES ?? 0);

let extensionDir = process.env.CRITIQS_EXTENSION_DIR ?? "";
if (extensionDir === "") {
  extensionDir = join(scratch, "extension");
  const built = Bun.spawn(["bun", "scripts/build.ts"], { cwd: here, env: { ...process.env, CRITIQS_TEST: "", CRITIQS_EXTENSION_OUT: extensionDir }, stderr: "inherit" });
  if ((await built.exited) !== 0) throw new Error("The extension didn't build.");
}
const manifest = await Bun.file(join(extensionDir, "manifest.json")).json();

// Another extension, which tries to ask Critiqs's worker for a token (A8.7).
const otherExtension = join(scratch, "other-extension");
await mkdir(otherExtension, { recursive: true });
await Bun.write(join(otherExtension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Another extension", version: "1.0.0", background: { service_worker: "worker.js" } }));
await Bun.write(join(otherExtension, "worker.js"), "self.addEventListener('install', () => self.skipWaiting());\n");

const where = await deployment(backend);
const sites = await startSites({ scratch, backend, elementScript: "" });
const site = sites.site;
const browser = await Browser.launch({ extensionDir, scratch, others: [otherExtension] });
const run = new Run("Critiqs on the page: strict and hostile pages, the worker's life, injection", evidence);
await run.start();

// People: Erin, a second reviewer, owns the project; Dana, the reviewer, is an admin of Erin's organization.
const stamp = Date.now();
const erin = await signInDirectly(where, `erin+${stamp}@example.com`, "Erin Admin");
const acme = await createProject(erin, "Acme prototype", [site("proto"), site("strict"), site("hostile"), "https://github.com", "https://accounts.google.com"]);
const organization = ((await erin.convex.query(api.organizations.mine, {})) as { id: string }[])[0]!;
const DANA = { email: `dana+${stamp}@example.com`, name: "Dana Reviewer" };
await erin.convex.mutation(api.organizations.invite, { organizationId: organization.id as never, email: DANA.email, role: "admin" } as never);
const dana = await signInDirectly(where, DANA.email, DANA.name);
await dana.convex.mutation(api.users.sync, {});
await seedSession(browser, where, dana.signedIn);
await Bun.sleep(1500);

async function reviewing(url = site("proto"), on = browser): Promise<Open> {
  const open = await showCritiqs(on, url);
  run.page = open.tab.page;
  return open;
}

/** What a person would notice changing: the mode, the open windows, the sidebar. */
const state = (seen: Seen) => JSON.stringify({ toolbar: seen.toolbar !== null, mode: seen.mode, thread: seen.threadWindow !== null, box: seen.commentBox !== null, sidebar: seen.sidebar !== null, copy: seen.copy !== null, dialogs: seen.dialogs.length, pins: seen.pins.length });
/** What was saved: each thread's status and message count. */
const savedState = async () => JSON.stringify((await threads(dana.convex, acme)).map((summary) => [summary._id, summary.status, summary.messageCount]));

/** A4.1 to A4.4 on a page, with what each showed. `pixels` checks the cross-site frame's colour in the capture. */
async function commentFlow(open: Open, text: string, { capture = true } = {}): Promise<string> {
  const made = await comment(open.overlay, '[data-critiqs-id="team.save"]', text);
  const wrong = beside("comment box", made.box, made.target);
  if (wrong !== null) throw new Error(`A4.2: ${wrong}`);
  if (made.modeWhileTyping !== "comment") throw new Error(`A4.3: the mode while typing was ${made.modeWhileTyping}`);
  const list = await threads(dana.convex, acme);
  const savedOne = list.find((summary) => summary.preview?.body === text);
  if (savedOne === undefined) throw new Error(`A4.3: no thread saved with exactly "${text}" (the box held "${made.textInBox}")`);
  if (!capture) return `A4.1–A4.3 pass: comment box at ${box(made.box)}, saved "${text}" exactly, pin and thread window shown`;
  const full = (await dana.convex.query(api.threads.get, { threadId: savedOne._id, paginationOpts: { numItems: 1, cursor: null } } as never)) as any;
  const image = await capturePixel(browser, where, (await storedSession(browser, where))!.accessToken, savedOne._id, { x: 10, y: 10, viewport: made.after.viewport.width });
  if (full.capture?.status !== "captured" || image.pixel === null) throw new Error(`A4.4: capture ${JSON.stringify(full.capture)}, image HTTP ${image.status}`);
  return `A4.1–A4.4 pass: comment box at ${box(made.box)}, saved "${text}" exactly, capture "captured" (${image.size?.join("×")} image)`;
}

// ---------------------------------------------------------------------------
// A8. Strict pages, and what the page can reach

await run.case("A8.1", "The strict page: A4.1–A4.4 pass; control: the same fetch, WebSocket, <style> and innerHTML from the page's own world are refused", async () => {
  const open = await reviewing(site("strict"));
  const control = await open.tab.page.evaluate(async (origin: string) => {
    const out: Record<string, string> = {};
    const attempt = async (name: string, work: () => Promise<string>) => {
      try {
        out[name] = await Promise.race([work(), new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 3000))]);
      } catch (error) {
        out[name] = `refused (${(error as Error).name})`;
      }
    };
    await attempt("fetch", async () => `allowed ${(await fetch(`${origin}/echo`)).status}`);
    await attempt("WebSocket", () => new Promise((resolve) => {
      const socket = new WebSocket(`${origin.replace("https", "wss")}/ws`);
      socket.onopen = () => resolve("allowed");
      socket.onerror = () => resolve("refused (error event)");
    }));
    await attempt("style", async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ".probe { color: rgb(1, 2, 3); }";
      const span = document.createElement("span");
      span.className = "probe";
      shadow.append(style, span);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const color = getComputedStyle(span).color;
      host.remove();
      return color === "rgb(1, 2, 3)" ? "allowed" : `refused (colour ${color})`;
    });
    await attempt("innerHTML", async () => {
      const div = document.createElement("div");
      div.innerHTML = "<i>x</i>";
      return "allowed";
    });
    return out;
  }, site("strict")) as Record<string, string>;
  const allowed = Object.entries(control).filter(([, value]) => !value.startsWith("refused"));
  if (allowed.length > 0) throw new Error(`The policy isn't live: from the page's own world ${allowed.map(([name, value]) => `${name} ${value}`).join(", ")}.`);
  const flow = await commentFlow(open, "Posted on the strict page");
  await open.tab.page.close();
  return `${flow}. Control from the page's own world: ${Object.entries(control).map(([name, value]) => `${name} ${value}`).join(", ")}`;
});

await run.case("A8.2", "Two real strict sites (github.com, accounts.google.com): the toolbar shows, the lookup answers, a comment posts on github.com with a captured screenshot", async () => {
  if (process.env.CRITIQS_REAL_SITES !== "1") throw new NotRun("set CRITIQS_REAL_SITES=1 to open github.com and accounts.google.com (needs the internet; Chrome then runs with --disable-features=LocalNetworkAccessChecks so public pages reach a local backend)");
  const real = await Browser.launch({ extensionDir, scratch, flags: ["--disable-features=LocalNetworkAccessChecks"] });
  try {
    await seedSession(real, where, dana.signedIn);
    await Bun.sleep(1500);
    const github = await reviewing("https://github.com/", real);
    const lookup = await github.overlay.has({ heading: "No project for this site yet" });
    if (lookup) throw new Error("github.com: the lookup didn't find the project that lists it.");
    const made = await comment(github.overlay, "h1", "Posted on github.com");
    const saved = (await threads(dana.convex, acme)).find((summary) => summary.preview?.body === "Posted on github.com");
    const full = saved === undefined ? null : ((await dana.convex.query(api.threads.get, { threadId: saved._id, paginationOpts: { numItems: 1, cursor: null } } as never)) as any);
    if (full?.capture?.status !== "captured") throw new Error(`github.com: the comment's capture is ${JSON.stringify(full?.capture ?? null)}.`);
    const google = await reviewing("https://accounts.google.com/", real);
    const googleSeen = await google.overlay.toolbar();
    return `github.com: toolbar, project found, comment posted with a captured screenshot (box at ${box(made.box)}); accounts.google.com: toolbar at ${box(googleSeen.toolbar)}. Chrome flag --disable-features=LocalNetworkAccessChecks`;
  } finally {
    run.page = null;
    await real.close();
  }
});

await run.case("A8.3", "The hostile page: A4.1–A4.3 pass despite the patched globals and * { all: unset !important }; the token hunt finds none of the session's tokens (whole, first or last 24 characters); the same search finds a planted token", async () => {
  const open = await reviewing(site("hostile"));
  await open.tab.page.evaluate(() => ((window as any).__loot.syntheticKey = "c"));
  const flow = await commentFlow(open, "Posted on the hostile page", { capture: false });
  // A planted token, where the page's sweep looks: the control that shows the search can find one.
  const planted = `eyJhbGciOiJSUzI1NiJ9.${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}.planted`;
  await open.tab.page.evaluate((token: string) => localStorage.setItem("planted", token), planted);
  await open.tab.page.evaluate(() => (window as any).__sweep());
  await Bun.sleep(3500);
  await open.tab.page.evaluate(() => (window as any).__sweep());
  const loot = String(await open.tab.page.evaluate(() => JSON.stringify((window as any).__loot)));
  await Bun.write(join(evidence, "hostile-loot.json"), loot);
  const stored = await storedSession(browser, where);
  const secrets = [stored?.accessToken, stored?.refreshToken, stored?.nextRefreshToken, dana.signedIn.accessToken, dana.signedIn.refreshToken].filter((secret): secret is string => typeof secret === "string" && secret.length > 24);
  const pieces = (secret: string) => [secret, secret.slice(0, 24), secret.slice(-24)];
  const found = secrets.flatMap(pieces).filter((piece) => loot.includes(piece));
  const control = pieces(planted).every((piece) => loot.includes(piece));
  await open.tab.page.close();
  if (!control) throw new Error("The search didn't find the planted token, so it can't be trusted.");
  if (found.length > 0) throw new Error(`The page gathered ${found.length} pieces of the session's tokens (see hostile-loot.json). ${flow}`);
  return `${flow}. Token hunt: ${secrets.length} tokens searched (whole, first and last 24 characters) in ${loot.length} characters the page gathered: none found; the planted token was found`;
});

await run.case("A8.4", "A content script can't read chrome.storage.local or chrome.storage.session, including right after the worker restarts", async () => {
  const open = await reviewing();
  const read = `Promise.all(["local", "session"].map((area) => chrome.storage[area].get(null).then((items) => area + ": read " + Object.keys(items).length + " keys", (error) => area + ": " + error.message)))`;
  const before = (await open.overlay.evaluate(read)).value as string[];
  await browser.stopWorker();
  // The content script's own message wakes the worker; storage is tried at once and for two seconds after.
  const after = (await open.overlay.evaluate(`(async () => {
    const seen = new Set();
    void chrome.runtime.sendMessage({ type: "critiqs:session" }).catch(() => undefined);
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      for (const line of await ${read}) seen.add(line.replace(/read \\d+ keys/, "read keys"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return [...seen];
  })()`)).value as string[];
  await open.tab.page.close();
  const refused = (line: string) => line.includes("Access to storage is not allowed from this context");
  const open_ = [...(before ?? []), ...(after ?? [])].filter((line) => !refused(line));
  if (open_.length > 0) throw new Error(`The content script could read storage: ${[...new Set(open_)].join("; ")} (before the restart: ${JSON.stringify(before)}).`);
  return `Before: ${JSON.stringify(before)}; right after the worker restarted: ${JSON.stringify(after)}`;
});

await run.case("A8.5", "In the page's own world chrome.runtime is undefined; sendMessage and connect to the extension's ID fail; fetching manifest.json, worker.js and allow.html fails", async () => {
  const open = await reviewing();
  const answers = await open.tab.page.evaluate(async (id: string) => {
    const out: Record<string, string> = { runtime: typeof (window as any).chrome?.runtime };
    for (const [name, attempt] of [
      ["sendMessage", () => (window as any).chrome.runtime.sendMessage(id, { type: "critiqs:token", force: false })],
      ["connect", () => (window as any).chrome.runtime.connect(id).postMessage({ type: "critiqs:token" })],
    ] as const) {
      try {
        out[name] = `answered ${JSON.stringify(await attempt())}`;
      } catch (error) {
        out[name] = `failed (${(error as Error).message.slice(0, 80)})`;
      }
    }
    for (const path of ["manifest.json", "worker.js", "allow.html"]) {
      try {
        out[path] = `fetched ${(await fetch(`chrome-extension://${id}/${path}`)).status}`;
      } catch (error) {
        out[path] = `failed (${(error as Error).message.slice(0, 60)})`;
      }
    }
    return out;
  }, EXTENSION_ID) as Record<string, string>;
  await open.tab.page.close();
  const problems = Object.entries(answers).filter(([name, value]) => (name === "runtime" ? value !== "undefined" : !value.startsWith("failed")));
  if (problems.length > 0) throw new Error(`From the page's own world: ${problems.map(([name, value]) => `${name} ${value}`).join(", ")}.`);
  return Object.entries(answers).map(([name, value]) => `${name}: ${value}`).join("; ");
});

await run.case("A8.6", "Made-up events from the page change nothing: click() and dispatchEvent on critiqs-root, made-up keydown for C, M, V and Escape", async () => {
  const open = await reviewing();
  const seen = await open.overlay.waitFor("no pin to open", (now) => now.pins.length > 0, 10_000);
  const pin = seen.pins[0]!;
  await open.tab.page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2);
  const before = await open.overlay.waitFor("no thread window after clicking a pin", (now) => now.threadWindow !== null, 5000);
  const data = await savedState();
  await open.tab.page.evaluate(() => {
    for (const host of document.querySelectorAll("critiqs-root")) {
      (host as HTMLElement).click();
      host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    }
    for (const key of ["c", "m", "v", "Escape"]) {
      for (const target of [document, window, document.body]) target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key === "Escape" ? "Escape" : `Key${key.toUpperCase()}`, bubbles: true, composed: true }));
    }
  });
  await Bun.sleep(1500);
  const after = await open.overlay.seen();
  const dataAfter = await savedState();
  await open.tab.page.close();
  if (state(after) !== state(before) || dataAfter !== data) throw new Error(`Before ${state(before)}, after ${state(after)}${dataAfter === data ? "" : "; saved data changed"}.`);
  return `Unchanged: ${state(after)}; saved data the same`;
});

await run.case("A8.7", "The worker ignores a message from a frame, from another extension, and (unit tests in worker.test.ts) a token request from a tab Critiqs isn't open in", async () => {
  const open = await reviewing();
  const jwt = /eyJ[\w-]{10,}\.[\w-]{10,}/;
  // A message from a frame of the page: the content script's world in the page's same-origin frame.
  const fromFrame = await browser.inWorker(async (tabId: number) => {
    const chrome = (globalThis as any).chrome;
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (globalThis as any).chrome.runtime.sendMessage({ type: "critiqs:token", force: false }).then((answer: unknown) => JSON.stringify(answer ?? null), (error: Error) => `refused: ${error.message}`),
    });
    return results.filter((result: { frameId: number }) => result.frameId !== 0).map((result: { result: string }) => result.result);
  }, await browser.tabId(open.tab));
  // A message from another extension's worker.
  const others = (await browser.targets()).filter((target) => target.type === "service_worker" && !target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`) && target.url.endsWith("/worker.js"));
  let fromExtension = "no other extension's worker";
  for (const other of others) {
    fromExtension = await browser.evaluateIn(other.targetId, (id: string) => (globalThis as any).chrome.runtime.sendMessage(id, { type: "critiqs:token", force: false }).then((answer: unknown) => JSON.stringify(answer ?? null), (error: Error) => `refused: ${error.message}`), EXTENSION_ID);
  }
  await open.tab.page.close();
  const tested = Bun.spawn(["bun", "test", "test/worker.test.ts"], { cwd: here, stdout: "pipe", stderr: "pipe" });
  const output = (await new Response(tested.stderr).text()) + (await new Response(tested.stdout).text());
  const passed = (await tested.exited) === 0;
  const names = output.split("\n").filter((line) => /^\s*\(pass\)|^\s*✓/.test(line)).join("\n");
  const unit = { frame: /frame/i.test(names), extension: /(another|other) extension/i.test(names), tab: /token/i.test(names) && /tab/i.test(names) && /(not|isn't|without|never)/i.test(names) };
  const problems: string[] = [];
  if (fromFrame.length === 0) problems.push("no frame of the page answered the run's message (the test page's same-origin frame)");
  if (fromFrame.some((answer: string) => jwt.test(answer))) problems.push(`a frame got a token: ${fromFrame.join(", ").slice(0, 120)}`);
  if (jwt.test(fromExtension)) problems.push("another extension got a token");
  if (!passed) problems.push("worker.test.ts fails");
  if (!unit.tab) problems.push("worker.test.ts has no passing test that a tab Critiqs isn't open in gets no token");
  if (!unit.frame) problems.push("worker.test.ts has no passing test about messages from a frame");
  if (!unit.extension) problems.push("worker.test.ts has no passing test about messages from another extension");
  if (problems.length > 0) throw new Error(`${problems.join("; ")}. Frame: ${JSON.stringify(fromFrame)}; other extension: ${fromExtension}`);
  return `Frame answers ${JSON.stringify(fromFrame)}; another extension: ${fromExtension}; worker.test.ts passes with tests for frames, other extensions and tabs without Critiqs`;
});

await run.case("A8.8", "A burst of window.postMessage calls carrying Critiqs-looking payloads changes nothing on screen or in saved data", async () => {
  const open = await reviewing();
  // Settled first: the project's pins drawn.
  await open.overlay.waitFor("no pins drawn", (seen) => seen.pins.length > 0, 10_000);
  await Bun.sleep(1000);
  const before = await open.overlay.seen();
  const data = await savedState();
  await open.tab.page.evaluate((id: string) => {
    const payloads = [
      { type: "critiqs:toggle" },
      { type: "critiqs:token", force: true },
      { type: "critiqs:session-changed" },
      { type: "critiqs:sign-out" },
      { type: "critiqs:project/choose", projectId: "x" },
      { critiqsFrame: "loaded", origin: `chrome-extension://${id}` },
      { critiqsAllow: "answered: true" },
      { tag: "critiqs:page-layer", v: 1, channel: "critiqs-extension", kind: "event", event: "select", data: {} },
      { tag: "critiqs:page-layer", v: 1, channel: "critiqs", kind: "request", id: 1, method: "setMode", params: { mode: "comment" } },
    ];
    for (let round = 0; round < 40; round++) for (const payload of payloads) window.postMessage(payload, "*");
  }, EXTENSION_ID);
  await Bun.sleep(1500);
  const after = await open.overlay.seen();
  const dataAfter = await savedState();
  await open.tab.page.close();
  if (state(after) !== state(before) || dataAfter !== data) throw new Error(`Before ${state(before)}, after ${state(after)}${dataAfter === data ? "" : "; saved data changed"}.`);
  return `360 messages; unchanged: ${state(after)}; saved data the same`;
});

// ---------------------------------------------------------------------------
// A11. Live data and the worker

let live: Open | null = null;
let liveStarted = 0;
let tokenExpires = 0;
/** A comment by the second reviewer through the API, and how long until Critiqs draws its pin. */
async function remoteComment(overlay: Overlay, body: string): Promise<number> {
  const before = (await overlay.seen()).pins.length;
  const posted = Date.now();
  await postThread(await signInDirectly(where, erin.email, erin.name), acme, `${site("proto")}/`, body);
  await overlay.waitFor(`the second reviewer's comment "${body}" wasn't drawn within 5 s`, (seen) => seen.pins.length > before, 5000);
  return Date.now() - posted;
}

await run.case("A11.1", "With Critiqs open, DevTools stops the worker; a second reviewer's new comment appears as a pin within 5 s, and the worker is still stopped afterwards", async () => {
  live = await reviewing();
  liveStarted = Date.now();
  tokenExpires = (await storedSession(browser, where))?.expiresAt ?? 0;
  await browser.stopWorker();
  if (await browser.workerRunning()) throw new Error("DevTools couldn't stop the worker.");
  const startsBefore = browser.workerStarts.length;
  const shown = await remoteComment(live.overlay, "Posted while the worker was stopped");
  const running = await browser.workerRunning();
  if (running || browser.workerStarts.length > startsBefore) throw new Error(`The comment showed after ${shown} ms, but the worker ran again.`);
  return `Shown ${shown} ms after the API comment; the worker stayed stopped`;
});

await run.case("A11.2", "After 10 idle minutes (the worker stopped at their start), a new comment appears within 5 s", async () => {
  if (liveMinutes < 10) throw new NotRun("set CRITIQS_LIVE_MINUTES=17 to run the 10- and 17-minute idle runs");
  if (live === null) throw new NotRun("A11.1 didn't open Critiqs");
  await browser.stopWorker();
  await waitUntil("10 idle minutes", () => Date.now() - liveStarted >= 10 * 60_000, 11 * 60_000, 5000);
  const shown = await remoteComment(live.overlay, "Posted after 10 idle minutes");
  return `Shown ${shown} ms after the API comment, ${((Date.now() - liveStarted) / 60_000).toFixed(1)} minutes after Critiqs opened`;
});

await run.case("A11.3", "After 17 minutes, past the 15-minute access token, a new comment appears within 5 s; still signed in; the worker started again only for the overlay's token", async () => {
  if (liveMinutes < 17) throw new NotRun("set CRITIQS_LIVE_MINUTES=17 to run the 17-minute idle run");
  if (live === null) throw new NotRun("A11.1 didn't open Critiqs");
  await browser.stopWorker();
  const stoppedAt = Date.now();
  await waitUntil("17 minutes", () => Date.now() - liveStarted >= liveMinutes * 60_000, (liveMinutes + 1) * 60_000, 5000);
  const shown = await remoteComment(live.overlay, `Posted after ${liveMinutes} minutes`);
  const signedIn = await live.overlay.has({ button: { pattern: "^Signed in as " } });
  const starts = browser.workerStarts.filter((at) => at > stoppedAt);
  const early = starts.filter((at) => at < tokenExpires - 120_000);
  if (!signedIn) throw new Error(`Shown after ${shown} ms, but the toolbar no longer shows the reviewer signed in.`);
  if (starts.length === 0) throw new Error(`Shown after ${shown} ms, but the worker never started again: the overlay didn't renew its token (it expired at ${new Date(tokenExpires).toISOString()}).`);
  if (early.length > 0) throw new Error(`The worker started at ${early.map((at) => new Date(at).toISOString()).join(", ")}, before the overlay's token was due (${new Date(tokenExpires).toISOString()}).`);
  return `Shown ${shown} ms after the API comment at ${liveMinutes} minutes; still signed in; the worker started again at ${starts.map((at) => new Date(at).toISOString().slice(11, 19)).join(", ")}, within 2 minutes before the token expired at ${new Date(tokenExpires).toISOString().slice(11, 19)}`;
});
if (live !== null) await (live as Open).tab.page.close().catch(() => undefined);

// ---------------------------------------------------------------------------
// A12. Injection

await run.case("A12.1", "overlay.js is at most 850 KB minified", async () => {
  const size = await stat(join(extensionDir, "overlay.js")).then((found) => found.size, () => null);
  if (size === null) {
    const pageScript = await stat(join(extensionDir, "page.js")).then((found) => found.size, () => null);
    throw new Missing(`no overlay.js in the build${pageScript === null ? "" : ` (it has page.js, ${pageScript.toLocaleString("en")} bytes)`}`);
  }
  if (size > 850_000) throw new Error(`overlay.js is ${size.toLocaleString("en")} bytes.`);
  return `overlay.js is ${size.toLocaleString("en")} bytes (${Bun.gzipSync(new Uint8Array(await Bun.file(join(extensionDir, "overlay.js")).arrayBuffer())).byteLength.toLocaleString("en")} gzipped)`;
});

await run.case("A12.2", "Click to toolbar on the test page, signed in: median of 5 at most 500 ms with the worker running; at most 1.5 s for the first click after the worker was stopped", async () => {
  const warm: number[] = [];
  for (let trial = 0; trial < 6; trial++) {
    const open = await reviewing();
    if (trial > 0) warm.push(open.clickToToolbarMs!);
    await open.tab.page.close();
  }
  await browser.stopWorker();
  const cold = await reviewing();
  await cold.tab.page.close();
  const median = [...warm].sort((a, b) => a - b)[2]!;
  if (median > 500 || cold.clickToToolbarMs! > 1500) throw new Error(`Warm median ${median} ms (${warm.join(", ")}); first click after the worker stopped ${cold.clickToToolbarMs} ms.`);
  return `Warm ${warm.join(", ")} ms (median ${median}); first click after the worker stopped ${cold.clickToToolbarMs} ms`;
});

const commit = (await Bun.$`git -C ${here} rev-parse --short HEAD`.nothrow().quiet()).stdout.toString().trim();
await run.write([
  `Commit ${commit}; extension ${manifest.version} from ${process.env.CRITIQS_EXTENSION_DIR ? extensionDir : "this checkout (real build)"}; ${browser.browser.version()}; backend ${backend}; ${new Date().toISOString()}.`,
  `The reviewer was signed in by the run. Long idle runs: ${liveMinutes >= 17 ? `${liveMinutes} minutes` : "off (CRITIQS_LIVE_MINUTES unset)"}; real sites: ${process.env.CRITIQS_REAL_SITES === "1" ? "on" : "off"}.`,
]);
await browser.close();
sites.stop();
process.exit(run.counts().fail > 0 ? 1 : 0);
