// Drives Chrome's real side panel through the Chrome DevTools Protocol.
// Playwright doesn't list a side panel among a browser's pages, so the
// checklist run talks to the panel's own target over its WebSocket: real
// mouse and keyboard input, scripts, and screenshots.

/** One DevTools connection, to the browser or to one target. */
export class DevTools {
  #socket: WebSocket;
  #next = 0;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
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

  get closed(): boolean {
    return this.#closed;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("The DevTools connection is closed."));
    const id = ++this.#next;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    this.#socket.close();
  }
}

/** What the panel's page looks for: an element anywhere in its shadow roots. */
export type Find =
  | { heading: string }
  | { button: string | RegExp }
  | { field: string }
  | { css: string; text?: string };

/** Runs in the panel's page: finds the first visible element matching `find`, looking through every shadow root. */
function locate(find: { heading?: string; button?: string; buttonPattern?: string; field?: string; css?: string; text?: string }): Element | null {
  const all: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      all.push(element);
      if (element.shadowRoot !== null) walk(element.shadowRoot);
    }
  };
  walk(document);
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const name = (element: Element) => element.getAttribute("aria-label") ?? text(element);
  const matches = (element: Element): boolean => {
    if (find.heading !== undefined) return /^H[1-3]$/.test(element.tagName) && text(element).includes(find.heading);
    if (find.button !== undefined || find.buttonPattern !== undefined) {
      if (!(element.tagName === "BUTTON" || ["button", "switch"].includes(element.getAttribute("role") ?? ""))) return false;
      return find.button !== undefined ? name(element) === find.button : new RegExp(find.buttonPattern!).test(name(element));
    }
    if (find.field !== undefined) {
      if (element.tagName !== "LABEL" || !text(element).startsWith(find.field)) return false;
      return element.querySelector("input, textarea") !== null;
    }
    if (find.css !== undefined) return element.matches(find.css) && (find.text === undefined || text(element).includes(find.text));
    return false;
  };
  const found = all.find((element) => matches(element) && visible(element)) ?? null;
  return find.field !== undefined && found !== null ? found.querySelector("input, textarea") : found;
}

const serialize = (find: Find) =>
  "button" in find && find.button instanceof RegExp ? { buttonPattern: find.button.source } : (find as Record<string, string>);

/** Chrome's side panel for one tab, driven like a person would: it reads what shows, clicks, and types. */
export class SidePanel {
  private constructor(
    readonly targetId: string,
    readonly devtools: DevTools,
  ) {}

  static async attach(debuggingUrl: string, targetId: string): Promise<SidePanel> {
    const devtools = await DevTools.open(`${debuggingUrl.replace(/^http/, "ws")}/devtools/page/${targetId}`);
    await devtools.send("Page.enable");
    return new SidePanel(targetId, devtools);
  }

  /** Runs `fn(arg)` in the panel's page and returns its result. */
  async evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    const result = await this.devtools.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }

  /** The middle of the element `find` matches, or null while there is none (or, with `enabled`, while it is disabled). */
  async box(find: Find, enabled = false): Promise<{ x: number; y: number } | null> {
    return await this.evaluate(
      ([source, query, enabled]: [string, Record<string, string>, boolean]) => {
        const element = (0, eval)(`(${source})`)(query) as Element | null;
        if (element === null) return null;
        if (enabled && (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true")) return null;
        element.scrollIntoView({ block: "center", inline: "center" });
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      },
      [locate.toString(), serialize(find), enabled],
    );
  }

  async has(find: Find): Promise<boolean> {
    return (await this.box(find)) !== null;
  }

  /** Waits until the panel shows an element `find` matches, and with `enabled`, until it can be used. */
  async waitFor(find: Find, timeoutMs = 20_000, enabled = false): Promise<{ x: number; y: number }> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = await this.box(find, enabled).catch(() => null);
      if (found !== null) return found;
      await Bun.sleep(150);
    }
    throw new Error(`The side panel never showed ${JSON.stringify(serialize(find))}${enabled ? " enabled" : ""}. It shows: "${(await this.text().catch(() => "")).slice(0, 400)}"`);
  }

  /**
   * A real click: the mouse moves to the element and presses there, once it is
   * enabled. A control the panel shows disabled while it loads (the Settings
   * switch, until Chrome says whether the site is allowed) ignores a click.
   */
  async click(find: Find): Promise<void> {
    const { x, y } = await this.waitFor(find, 20_000, true);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.devtools.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
  }

  /** Clicks the element, then types `text` into it as keyboard input. */
  async type(find: Find, text: string): Promise<void> {
    await this.click(find);
    await this.devtools.send("Input.insertText", { text });
  }

  /** The panel's text, through its shadow roots. */
  async text(): Promise<string> {
    return await this.evaluate(() => {
      const parts: string[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const element of Array.from(root.querySelectorAll("*"))) if (element.shadowRoot !== null) walk(element.shadowRoot);
        if (root instanceof ShadowRoot) parts.push(Array.from(root.children).map((child) => child.textContent ?? "").join(" "));
      };
      walk(document);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    });
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.devtools.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  close() {
    this.devtools.close();
  }
}
