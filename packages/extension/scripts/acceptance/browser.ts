// Chrome for Testing with a built extension, driven the way a person uses it:
// the icon's action through the Chrome DevTools Protocol
// (`Extensions.triggerAction`, which Chrome handles as a click on the icon and
// grants the page for, as `activeTab` does), and the real mouse and keyboard.
// Shared by the acceptance checks (checklist.ts, check-overlay.ts).
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The ID Chrome gives the development build (the manifest's `key`). */
export const EXTENSION_ID = "pfdpnmmiemejphfghkalofichdcoandg";

// Playwright is loaded from PLAYWRIGHT_CORE or installed for the run, so its types aren't available here.
export type Page = any;
type Listener = (params: any, sessionId?: string) => void;

/** One DevTools connection to the browser, with sessions for targets it attaches to (flattened). */
export class DevTools {
  #socket: WebSocket;
  #next = 0;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #listeners = new Map<string, Set<Listener>>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
        return;
      }
      const waiting = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      for (const waiting of this.#pending.values()) waiting.reject(new Error("The DevTools connection closed."));
      this.#pending.clear();
    });
  }

  static async open(url: string): Promise<DevTools> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Couldn't connect to ${url}.`)), { once: true });
    });
    return new DevTools(socket);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("The DevTools connection is closed."));
    const id = ++this.#next;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  on(method: string, listener: Listener): () => void {
    const set = this.#listeners.get(method) ?? new Set();
    set.add(listener);
    this.#listeners.set(method, set);
    return () => set.delete(listener);
  }

  close() {
    this.#socket.close();
  }
}

/** Chrome for Testing or Chromium: CHROME_PATH, or the newest Chromium Playwright installed. */
export function chromePath(): string {
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

/** playwright-core from PLAYWRIGHT_CORE, or installed into `scratch` for this run. */
export async function playwright(scratch: string) {
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

export interface Tab {
  page: Page;
  /** Chrome's tab ID, as the extension sees it. */
  id: number;
}

/** A request the run saw on the wire. */
export interface SeenRequest {
  at: number;
  url: string;
  method: string;
  origin: string | null;
  /** Where it was seen: a tab's page (with its own address) or the extension's worker. */
  from: string;
}

export interface LaunchOptions {
  extensionDir: string;
  /** Other unpacked extensions to load beside it. */
  others?: string[];
  scratch: string;
  /** Extra Chrome flags, such as --disable-features=LocalNetworkAccessChecks (CRITIQS_CHROME_FLAGS adds more). */
  flags?: string[];
  width?: number;
  height?: number;
}

/** Chrome with the extension loaded, a Playwright connection to it, and a DevTools connection to the browser. */
export class Browser {
  readonly requests: SeenRequest[] = [];
  readonly pageErrors: string[] = [];
  /** When Chrome started the extension's service worker, each time (milliseconds since 1970). */
  readonly workerStarts: number[] = [];
  #sessions = new Map<string, string>();

  private constructor(
    readonly chrome: ReturnType<typeof Bun.spawn>,
    readonly browser: any,
    readonly context: any,
    readonly devtools: DevTools,
    readonly chromium: any,
    readonly debugging: string,
  ) {}

  static async launch(options: LaunchOptions): Promise<Browser> {
    const profile = join(options.scratch, `profile-${Date.now()}`);
    const extensions = [options.extensionDir, ...(options.others ?? [])].join(",");
    const port = Number(process.env.CRITIQS_DEVTOOLS_PORT ?? 0);
    const chrome = Bun.spawn(
      [
        chromePath(),
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`,
        // Lets DevTools run the extension's toolbar action (Extensions.triggerAction).
        "--enable-unsafe-extension-debugging",
        "--host-resolver-rules=MAP *.critiqs.test 127.0.0.1",
        "--ignore-certificate-errors",
        "--no-first-run",
        "--no-default-browser-check",
        `--window-size=${options.width ?? 1400},${options.height ?? 900}`,
        ...(options.flags ?? []),
        ...(process.env.CRITIQS_CHROME_FLAGS ?? "").split(" ").filter(Boolean),
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    process.once("exit", () => chrome.kill());
    let debugging = "";
    for (let attempt = 0; attempt < 150 && debugging === ""; attempt++) {
      // Chrome writes DevToolsActivePort for a port it picks; a given port is asked directly.
      const active = port === 0 ? await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => "") : `${port}\n`;
      const candidate = active.includes("\n") ? `http://127.0.0.1:${active.split("\n")[0]}` : "";
      if (candidate !== "" && (await fetch(`${candidate}/json/version`).then((response) => response.ok, () => false))) debugging = candidate;
      else await Bun.sleep(100);
    }
    if (debugging === "") throw new Error("Chrome didn't start.");
    const { chromium } = await playwright(options.scratch);
    const browser = await chromium.connectOverCDP(debugging);
    const context = browser.contexts()[0];
    const devtools = await DevTools.open((await (await fetch(`${debugging}/json/version`)).json()).webSocketDebuggerUrl);
    const run = new Browser(chrome, browser, context, devtools, chromium, debugging);
    await run.#watch();
    await waitUntil(`Chrome to run the extension ${EXTENSION_ID}'s worker`, () => run.workerRunning(), 15_000);
    return run;
  }

  /** Records requests from every tab, page errors, and the worker's own requests and starts. */
  async #watch() {
    this.context.on("page", (page: Page) => this.#watchPage(page));
    for (const page of this.context.pages()) this.#watchPage(page);
    const sessions = new Set<string>();
    const extraInfo = new Map<string, string | null>();
    // The worker can stop and start again many times in a run: note each start (DevTools lists its target
    // while it runs) and watch its requests.
    let running: string | null = null;
    const look = async () => {
      const worker = (await this.targets().catch(() => [])).find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
      const id = worker?.targetId ?? null;
      if (id !== null && id !== running) {
        this.workerStarts.push(Date.now());
        await this.devtools
          .send("Target.attachToTarget", { targetId: id, flatten: true })
          .then(({ sessionId }) => (sessions.add(sessionId), this.devtools.send("Network.enable", {}, sessionId)))
          .catch(() => undefined);
      }
      running = id;
    };
    const poll = setInterval(() => void look(), 200);
    this.chrome.exited.then(() => clearInterval(poll));
    await look();
    this.devtools.on("Network.requestWillBeSent", (params, sessionId) => {
      if (sessionId === undefined || !sessions.has(sessionId)) return;
      const headers = params.request.headers ?? {};
      const origin = headers.Origin ?? headers.origin ?? extraInfo.get(params.requestId) ?? null;
      this.requests.push({ at: Date.now(), url: params.request.url, method: params.request.method, origin, from: "worker" });
    });
    this.devtools.on("Network.requestWillBeSentExtraInfo", (params, sessionId) => {
      if (sessionId === undefined || !sessions.has(sessionId)) return;
      const origin = params.headers?.Origin ?? params.headers?.origin ?? null;
      extraInfo.set(params.requestId, origin);
      const seen = this.requests.findLast((request) => request.from === "worker" && request.origin === null);
      if (seen !== undefined && origin !== null) seen.origin = origin;
    });
  }

  #watchPage(page: Page) {
    page.on("pageerror", (error: Error) => this.pageErrors.push(`${page.url()}: ${error.message}`));
    page.on("request", (request: any) => {
      const headers = request.headers();
      this.requests.push({ at: Date.now(), url: request.url(), method: request.method(), origin: headers.origin ?? null, from: page.url() });
    });
  }

  /** Runs `fn` in a target (a service worker) through DevTools and returns its value. */
  async evaluateIn<T, A>(targetId: string, fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    let sessionId = this.#sessions.get(targetId);
    if (sessionId === undefined) {
      sessionId = (await this.devtools.send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
      this.#sessions.set(targetId, sessionId);
    }
    const answer = await this.devtools.send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true }, sessionId);
    if (answer.exceptionDetails !== undefined) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result.value as T;
  }

  /** The extension's worker's target, if it runs. */
  async workerTarget(): Promise<string | null> {
    return (await this.targets()).find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`))?.targetId ?? null;
  }

  /** Runs code in the extension's worker (a context its storage stays open to), starting it through an extension page when Chrome stopped it. */
  async inWorker<T, A>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let target = await this.workerTarget();
      if (target === null) {
        await this.wakeWorker();
        target = await this.workerTarget();
      }
      if (target === null) throw new Error(`Chrome didn't run the extension ${EXTENSION_ID}'s worker.`);
      try {
        return await this.evaluateIn(target, fn, arg);
      } catch (error) {
        this.#sessions.delete(target);
        if (attempt >= 2) throw error;
        await Bun.sleep(300);
      }
    }
  }

  /** Starts the worker the way any extension page does, by messaging it; the page closes again. */
  async wakeWorker() {
    const page = await this.context.newPage();
    const end = Date.now() + 15_000;
    while (Date.now() < end && !(await this.workerRunning())) {
      await page.goto(`chrome-extension://${EXTENSION_ID}/manifest.json`).catch(() => undefined);
      await page.evaluate(() => (globalThis as any).chrome.runtime.sendMessage({ type: "critiqs:acceptance-wake" }).catch(() => undefined)).catch(() => undefined);
      await Bun.sleep(300);
    }
    await page.close();
  }

  async targets(): Promise<{ targetId: string; type: string; url: string; title: string }[]> {
    return (await this.devtools.send("Target.getTargets", { filter: [{}] })).targetInfos;
  }

  async workerRunning(): Promise<boolean> {
    return (await this.targets()).some((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
  }

  /** Stops the extension's worker as Chrome does when it is idle (DevTools closes its target). */
  async stopWorker() {
    for (const target of await this.targets()) {
      if (target.type === "service_worker" && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)) {
        await this.devtools.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
      }
    }
    const end = Date.now() + 5000;
    while (Date.now() < end && (await this.workerRunning())) await Bun.sleep(100);
  }

  /** Opens `url` in a new tab of the one window, in front, as a person does. */
  async openTab(url: string): Promise<Tab> {
    const page: Page = await this.context.newPage();
    await page.goto(url).catch(() => undefined);
    await page.bringToFront();
    // Chrome's tab ID comes from the worker, which a run mustn't wake by opening a tab: asked for with tabId().
    return { page, id: -1 };
  }

  /** Chrome's tab ID for a tab, as the extension sees it (asks the worker, starting it if needed). */
  async tabId(tab: Tab): Promise<number> {
    if (tab.id >= 0) return tab.id;
    await tab.page.bringToFront();
    tab.id = await this.inWorker(() => (globalThis as any).chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs: { id: number }[]) => tabs[0]!.id));
    return tab.id;
  }

  /** The click on the Critiqs icon for a tab: Chrome runs the extension's action as it does for the toolbar. */
  async clickIcon(tab: Tab) {
    await tab.page.bringToFront();
    const target = (await this.targets()).find((candidate) => candidate.type === "tab" && candidate.url === tab.page.url());
    if (target === undefined) throw new Error(`No tab target for ${tab.page.url()}.`);
    await this.devtools.send("Extensions.triggerAction", { id: EXTENSION_ID, targetId: target.targetId });
  }

  /** What chrome://extensions says about the extension, as Details shows it. */
  async extensionInfo(): Promise<{ id: string; version: string; sites: string[]; errors: unknown[] }> {
    const details = await this.context.newPage();
    await details.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
    const info = await details.evaluate((id: string) => (globalThis as any).chrome.developerPrivate.getExtensionInfo(id), EXTENSION_ID);
    await details.close();
    const sites = (info.permissions?.runtimeHostPermissions?.hosts ?? []).filter((host: { granted: boolean }) => host.granted).map((host: { host: string }) => host.host);
    return { id: info.id, version: info.version, sites, errors: [...(info.manifestErrors ?? []), ...(info.runtimeErrors ?? [])] };
  }

  /** Reloads the extension as chrome://extensions' reload button does, with developer mode on as it is for an unpacked extension. */
  async reloadExtension() {
    const details = await this.context.newPage();
    await details.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
    await details.evaluate(async (id: string) => {
      const chrome = (globalThis as any).chrome;
      // Without developer mode Chrome disables a reloaded unpacked extension ("unsupported developer extension").
      await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
      await chrome.developerPrivate.reload(id, { failQuietly: true });
    }, EXTENSION_ID);
    await details.close();
    // The reloaded extension's worker starts on its first event; wake it so the run can read the extension again.
    await this.wakeWorker();
  }

  async close() {
    await this.browser.close().catch(() => undefined);
    this.chrome.kill();
  }
}

/** Waits for `check` to hold, or throws with what was awaited. */
export async function waitUntil(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 20_000, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await Promise.resolve(check()).catch(() => false)) return;
    await Bun.sleep(everyMs);
  }
  throw new Error(`Timed out after ${(timeoutMs / 1000).toFixed(1)} s waiting for ${what}.`);
}
