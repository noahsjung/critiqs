// In real Chrome: a content script can't read the extension's storage, which
// holds the reviewer's refresh token, not even while the worker is stopped or
// the moment it starts again. The real build (not a test build) is loaded in
// Chrome for Testing, the icon is clicked through the Chrome DevTools Protocol
// (`Extensions.triggerAction`, which Chrome handles as a click and so adds the
// content script to the page), and every read is made from the content
// script's own isolated world.
//
//   CHROME_PATH=/path/to/chrome-for-testing bun scripts/check-storage-lock.ts
//
// Optional: CRITIQS_SITES_PORT (the test page's port; default any free one),
// CRITIQS_EVIDENCE_DIR (where results.json goes). Nothing here reaches a
// backend: the build names an address where nothing listens. Exits with 1 when
// a check fails.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const EXTENSION_ID = "pfdpnmmiemejphfghkalofichdcoandg";
const REFUSED = "Access to storage is not allowed from this context";
const chromePath = process.env.CHROME_PATH ?? "";
if (chromePath === "") throw new Error("Set CHROME_PATH to Chrome for Testing or Chromium (branded Chrome doesn't load unpacked extensions from the command line).");
const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "critiqs-storage-lock-"));
process.once("exit", () => void rm(scratch, { recursive: true, force: true }));

// The test page.
const site = Bun.serve({
  port: Number(process.env.CRITIQS_SITES_PORT ?? 0),
  hostname: "127.0.0.1",
  fetch: () => new Response(`<!doctype html><title>Storage lock</title><h1>A page</h1><button data-critiqs-id="team.save">Save</button>`, { headers: { "content-type": "text/html" } }),
});
const pageUrl = `http://127.0.0.1:${site.port}/`;

// The real build, against a backend address where nothing listens.
const extensionDir = join(scratch, "extension");
const built = Bun.spawn(["bun", "scripts/build.ts"], { cwd: here, env: { ...process.env, CRITIQS_TEST: "", CRITIQS_STORE: "", CRITIQS_BACKEND: "http://127.0.0.1:9", CRITIQS_EXTENSION_OUT: extensionDir }, stderr: "inherit" });
if ((await built.exited) !== 0) throw new Error("The extension didn't build.");
const extensionName: string = (await Bun.file(join(extensionDir, "manifest.json")).json()).name;

const profile = join(scratch, "profile");
const chrome = Bun.spawn(
  [
    chromePath,
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
process.once("exit", () => chrome.kill());
let port = "";
for (let attempt = 0; attempt < 100 && port === ""; attempt++) {
  const text = await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => "");
  if (text.includes("\n")) port = text.split("\n")[0]!;
  else await Bun.sleep(100);
}
if (port === "") throw new Error("Chrome didn't start.");
const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };

// A small DevTools client: one connection to the browser, sessions per target.
const socket = new WebSocket(webSocketDebuggerUrl);
await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
let nextId = 0;
const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const listeners: ((message: any) => void)[] = [];
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) call?.reject(new Error(message.error.message));
    else call?.resolve(message.result);
  } else for (const listener of listeners) listener(message);
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
};
const targets = async (): Promise<{ targetId: string; type: string; url: string }[]> => (await send("Target.getTargets", { filter: [{}] })).targetInfos;
const workerTarget = async () => (await targets()).find((target) => target.type === "service_worker" && target.url === `chrome-extension://${EXTENSION_ID}/worker.js`);

async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Runs an expression in a target's default context (the worker) and returns its value. */
async function evaluateIn(targetId: string, expression: string): Promise<unknown> {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return answer.result?.value ?? answer.exceptionDetails?.exception?.description ?? null;
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

/** Runs an expression in the extension's content script world on the page: DevTools can; the page's own scripts can't. */
async function inContentScript(pageTarget: string, expression: string): Promise<unknown> {
  const { sessionId } = await send("Target.attachToTarget", { targetId: pageTarget, flatten: true });
  const contexts: { id: number; name: string; auxData?: { type?: string } }[] = [];
  const listener = (message: any) => {
    if (message.sessionId === sessionId && message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
  };
  listeners.push(listener);
  try {
    await send("Runtime.enable", {}, sessionId);
    const world = await waitFor("the content script's world", async () => contexts.filter((context) => context.auxData?.type === "isolated" && context.name === extensionName).at(-1), 5_000).catch((error: Error) => {
      throw new Error(`${error.message} Worlds on the page: ${JSON.stringify(contexts.map((context) => [context.name, context.auxData?.type]))}`);
    });
    const answer = await send("Runtime.evaluate", { contextId: world.id, expression, awaitPromise: true, returnByValue: true }, sessionId);
    return answer.result?.value ?? answer.exceptionDetails?.exception?.description ?? null;
  } finally {
    listeners.splice(listeners.indexOf(listener), 1);
    await send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

/** Reads both storage areas from the content script: what Chrome answers each. */
const READ_BOTH = `(async () => {
  const read = (area) => chrome.storage[area].get(null).then((items) => "read " + Object.keys(items).length + " keys", (error) => "refused: " + error.message);
  const attempt = (area) => { try { return read(area); } catch (error) { return Promise.resolve("refused: " + error.message); } };
  return { local: await attempt("local"), session: await attempt("session") };
})()`;
/** Wakes the worker with a request it answers without any backend, then reads both areas at once. */
const WAKE_THEN_READ = `(async () => {
  const read = (area) => { try { return chrome.storage[area].get(null).then((items) => "read " + Object.keys(items).length + " keys", (error) => "refused: " + error.message); } catch (error) { return Promise.resolve("refused: " + error.message); } };
  // Read in the same moment the message starts the worker, before it can have run anything.
  const [racedLocal, racedSession] = await Promise.all([read("local"), read("session")]);
  const answer = await chrome.runtime.sendMessage({ type: "critiqs:auto" }).then((value) => JSON.stringify(value), (error) => "no answer: " + error.message);
  return { racedLocal, racedSession, answer, local: await read("local"), session: await read("session") };
})()`;

interface Check {
  check: string;
  outcome: "pass" | "fail" | "measured";
  measured: string;
}
const checks: Check[] = [];
const record = (check: string, pass: boolean, measured: unknown) => {
  const line = typeof measured === "string" ? measured : JSON.stringify(measured);
  checks.push({ check, outcome: pass ? "pass" : "fail", measured: line });
  console.log(`${pass ? "PASS" : "FAIL"} ${check}\n     ${line}`);
};
/** A reading kept for the record that passes or fails nothing. */
const note = (check: string, measured: unknown) => {
  checks.push({ check, outcome: "measured", measured: JSON.stringify(measured) });
  console.log(`NOTE ${check}\n     ${JSON.stringify(measured)}`);
};
const refused = (value: unknown) => typeof value === "string" && value.includes(REFUSED);

try {
  const worker = await waitFor("the extension's worker", workerTarget);
  // Something worth stealing in each area, written by the worker, which may.
  await evaluateIn(worker.targetId, `Promise.all([chrome.storage.local.set({ "lock-check": "secret-local" }), chrome.storage.session.set({ "lock-check": "secret-session" })]).then(() => "ok")`);

  await send("Target.createTarget", { url: pageUrl });
  // The tab is what the icon acts on; the page inside it is where the content script runs.
  const tab = await waitFor("the test tab", async () => (await targets()).find((target) => target.type === "tab" && target.url === pageUrl));
  const page = (await waitFor("the test page", async () => (await targets()).find((target) => target.type === "page" && target.url === pageUrl))).targetId;
  // In front, as a person clicking the icon sees it.
  await send("Target.activateTarget", { targetId: page });
  await send("Extensions.triggerAction", { id: EXTENSION_ID, targetId: tab.targetId });
  const added = await waitFor("the click to add the content script", async () => {
    const state = (await evaluateIn((await workerTarget())!.targetId, `chrome.storage.session.get(null).then((items) => JSON.stringify(Object.fromEntries(Object.entries(items).filter(([key]) => key !== "lock-check"))))`)) as string;
    return /"overlay:\d+"/.test(state) && /"tab:\d+":\{\}/.test(state) ? state : /refused/.test(state) ? `refused ${state}` : undefined;
  }).catch((error: Error) => error.message);
  record("the icon's click adds Critiqs to the tab, and the worker marks it open", !added.startsWith("refused") && !added.startsWith("Timed out"), added);

  const first = (await inContentScript(page, READ_BOTH)) as { local: string; session: string };
  record("a content script can't read chrome.storage.local", refused(first.local), first.local);
  record("a content script can't read chrome.storage.session", refused(first.session), first.session);
  const trusted = await evaluateIn((await workerTarget())!.targetId, `chrome.storage.local.get("lock-check").then((items) => items["lock-check"])`);
  record("control: the worker itself still reads local storage", trusted === "secret-local", trusted);

  // Control: the same read succeeds when the lock is lifted, so the check can see an open store.
  const opened = await evaluateIn((await workerTarget())!.targetId, `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).then(() => "ok", (error) => error.message)`);
  const open = (await inContentScript(page, READ_BOTH)) as { local: string; session: string };
  record("control: with the lock lifted, the same content-script read succeeds", opened === "ok" && open.local.startsWith("read "), { setAccessLevel: opened, local: open.local });

  // Stop the worker: its start must close local storage again.
  for (let round = 1; round <= 2; round++) {
    const running = await waitFor("the worker", workerTarget);
    await send("Target.closeTarget", { targetId: running.targetId });
    await waitFor("the worker to stop", async () => (await workerTarget()) === undefined);
    const stopped = (await inContentScript(page, READ_BOTH)) as { local: string; session: string };
    if (round === 1) {
      // The lift above was the last word before this stop: what Chrome keeps while no worker runs.
      note("while stopped after the lift (what the next start must close)", stopped);
    } else {
      record(`while the worker is stopped (stop ${round}), a content script can't read either area`, refused(stopped.local) && refused(stopped.session), stopped);
    }
    const woke = (await inContentScript(page, WAKE_THEN_READ)) as { racedLocal: string; racedSession: string; answer: string; local: string; session: string };
    const restarted = await waitFor("the worker to start again", workerTarget);
    record(`after stop ${round}, the worker started again (${restarted.targetId !== running.targetId ? "new target" : "same target"}) and answered`, woke.answer.startsWith("{"), woke.answer);
    record(`right after the worker started again (stop ${round}), a content script can't read either area`, refused(woke.local) && refused(woke.session), { local: woke.local, session: woke.session });
    if (round === 2) record(`the moment the message starts the worker (stop ${round}), a content script can't read either area`, refused(woke.racedLocal) && refused(woke.racedSession), { local: woke.racedLocal, session: woke.racedSession });
  }
} catch (error) {
  record("the run itself", false, error instanceof Error ? error.message : String(error));
}

const evidence = process.env.CRITIQS_EVIDENCE_DIR;
if (evidence !== undefined) {
  await mkdir(evidence, { recursive: true });
  await Bun.write(join(evidence, "results.json"), `${JSON.stringify({ chrome: (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser, checks }, null, 2)}\n`);
}
const failed = checks.filter((check) => check.outcome === "fail").length;
console.log(`${checks.filter((check) => check.outcome === "pass").length} pass, ${failed} fail`);
socket.close();
site.stop(true);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
