// Reads and drives Critiqs's interface on a page the way a person meets it.
// Critiqs draws into a closed shadow root, which neither the page's own
// scripts nor DevTools' default context can see into, so every read runs in
// the content script's own world (the extension's isolated world, through
// DevTools `Runtime.evaluate` with that context) and opens the root with
// `chrome.dom.openOrClosedShadowRoot`, which content scripts have. Every action
// is the real mouse or keyboard (`page.mouse`, `page.keyboard`): no
// `element.click()` and no made-up events, which Critiqs refuses by design.
import { EXTENSION_ID, type Page, type Tab, waitUntil } from "./browser.ts";

/** Something on Critiqs's interface, found the way a person names it. */
export type Find =
  | { button: string | { pattern: string } }
  | { heading: string }
  | { field: string }
  | { text: string }
  | { menuItem: string | { pattern: string } }
  | { css: string; text?: string }
  | { dialog: string | true };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a person sees of Critiqs on the page at one moment. */
export interface Seen {
  /** Critiqs's content script has run on the page (its world exists). */
  script: boolean;
  roots: number;
  toolbar: Rect | null;
  mode: "browse" | "comment" | "mockup" | null;
  pins: Rect[];
  pinLabels: string[];
  outline: Rect | null;
  threadWindow: Rect | null;
  /** The new comment's box: its text field, while it shows. */
  commentBox: Rect | null;
  commentText: string | null;
  focusInCommentBox: boolean;
  sidebar: Rect | null;
  mockupPanel: Rect | null;
  /** The frozen copy of the page in Mockup mode, while it shows. */
  copy: Rect | null;
  dialogs: string[];
  headings: string[];
  text: string;
  viewport: { width: number; height: number };
}

/**
 * Runs in the content script's world. Everything it uses is defined inside it,
 * since it is sent to the page as source.
 */
function helpers() {
  const runtime = (globalThis as any).chrome;
  const openRoot = (host: Element): ShadowRoot | null => runtime?.dom?.openOrClosedShadowRoot?.(host) ?? host.shadowRoot ?? null;
  const hosts = () => Array.from(document.querySelectorAll("critiqs-root"));
  /** Critiqs's own root: the one with its toolbar or a card, else the first one drawn. */
  const root = (): ShadowRoot | null => {
    const roots = hosts().map(openRoot).filter((found): found is ShadowRoot => found !== null);
    return roots.find((found) => found.querySelector('[role="toolbar"]') !== null) ?? roots.find((found) => (found.textContent ?? "").trim() !== "") ?? roots[0] ?? null;
  };
  const all = (from: ParentNode | null): Element[] => (from === null ? [] : Array.from(from.querySelectorAll("*")));
  const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const name = (element: Element) => (element.getAttribute("aria-label") ?? text(element)).replace(/\s+/g, " ").trim();
  const shown = (element: Element | null): boolean => {
    if (element === null || !element.isConnected) return false;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    for (let at: Element | null = element; at !== null; at = at.parentElement ?? ((at.getRootNode() as ShadowRoot).host ?? null)) {
      const style = getComputedStyle(at);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (at.hasAttribute("hidden")) return false;
    }
    return true;
  };
  const rect = (element: Element | null) => {
    if (element === null) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const matches = (value: string, wanted: string | { pattern: string }) => (typeof wanted === "string" ? value === wanted : new RegExp(wanted.pattern).test(value));
  const labelOf = (field: Element): string => {
    const own = field.getAttribute("aria-label");
    if (own !== null) return own;
    const label = field.closest("label");
    if (label !== null) return text(label);
    const id = field.getAttribute("id");
    const named = id === null ? null : (field.getRootNode() as ShadowRoot | Document).querySelector(`label[for="${id}"]`);
    return named === null ? (field.getAttribute("placeholder") ?? "") : text(named);
  };
  const find = (spec: any, within: ParentNode | null = root()): Element | null => {
    const candidates = all(within).filter(shown);
    if ("button" in spec) return candidates.find((element) => element.matches("button, [role=button]") && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true" && matches(name(element), spec.button)) ?? null;
    if ("menuItem" in spec) return candidates.find((element) => element.matches('[role^="menuitem"], [role=menu] button') && matches(name(element), spec.menuItem)) ?? null;
    if ("heading" in spec) return candidates.find((element) => element.matches("h1, h2, h3, h4, [role=heading]") && text(element).includes(spec.heading)) ?? null;
    if ("field" in spec) return candidates.find((element) => element.matches("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox]") && labelOf(element).includes(spec.field)) ?? null;
    if ("dialog" in spec) return candidates.find((element) => element.matches('[role=dialog], dialog') && (spec.dialog === true || name(element).includes(spec.dialog))) ?? null;
    if ("text" in spec) {
      const holding = candidates.filter((element) => text(element).includes(spec.text));
      return holding.find((element) => !Array.from(element.children).some((child) => text(child).includes(spec.text))) ?? null;
    }
    return candidates.find((element) => element.matches(spec.css) && (spec.text === undefined || text(element).includes(spec.text))) ?? null;
  };
  /** Whether a person clicking the middle of `element` would hit it (nothing of Critiqs's on top). */
  const onTop = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const owner = element.getRootNode() as ShadowRoot | Document;
    const hit = owner.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  };
  const seen = () => {
    const shadow = root();
    const one = (selector: string) => all(shadow).find((element) => element.matches(selector) && shown(element)) ?? null;
    const toolbar = one('[role="toolbar"]');
    const pressed = toolbar === null ? [] : Array.from(toolbar.querySelectorAll('[aria-pressed="true"]')).map(name);
    const mode = pressed.includes("Mockup mode") ? "mockup" : pressed.includes("Comment mode") ? "comment" : pressed.includes("Browse mode") ? "browse" : null;
    const pins = all(shadow).filter((element) => element.matches(".pin") && shown(element));
    const form = one('form[aria-label="New comment"]');
    const box = form === null ? null : (Array.from(form.querySelectorAll(".tag-field, textarea, [contenteditable=true]"))[0] ?? null);
    const thread = one(".thread-window");
    const active = shadow?.activeElement ?? null;
    const copy = all(shadow).find((element) => element instanceof HTMLIFrameElement && shown(element) && element.closest('[aria-label="Mockup"]') === null && element.getBoundingClientRect().width > 200) ?? null;
    return {
      script: true,
      roots: hosts().length,
      toolbar: rect(toolbar),
      mode,
      pins: pins.map(rect),
      pinLabels: pins.map((pin) => pin.getAttribute("aria-label") ?? ""),
      outline: rect(one(".target-box")),
      threadWindow: rect(thread),
      commentBox: rect(form),
      commentText: box === null ? null : ((box as HTMLTextAreaElement).value ?? box.textContent ?? ""),
      focusInCommentBox: form !== null && active !== null && form.contains(active),
      sidebar: rect(one("aside.sidebar:not(.mockup-panel), aside[aria-label='Critiqs project'], aside[aria-label='Comments']")),
      mockupPanel: rect(one('aside[aria-label="Mockup"]')),
      copy: rect(copy),
      dialogs: all(shadow).filter((element) => element.matches("[role=dialog], dialog") && shown(element)).map(name).map((label) => label.slice(0, 60)),
      headings: all(shadow).filter((element) => element.matches("h1, h2, h3") && shown(element)).map(text),
      text: Array.from(shadow?.children ?? []).filter((child) => child.localName !== "style").map(text).join(" ").slice(0, 3000),
      viewport: { width: innerWidth, height: innerHeight },
    };
  };
  return { openRoot, hosts, root, all, text, name, shown, rect, find, onTop, seen, labelOf };
}
export type Helpers = ReturnType<typeof helpers>;

/** Missing pieces, said the way the results say them. */
export class Missing extends Error {}

/** Critiqs on one tab: reads through the content script's world, acts with the real mouse and keyboard. */
export class Overlay {
  #contexts = new Map<number, { origin: string; frameId: string; isolated: boolean }>();
  #mainFrame = "";

  private constructor(
    readonly tab: Tab,
    readonly cdp: any,
  ) {}

  static async attach(tab: Tab): Promise<Overlay> {
    const cdp = await tab.page.context().newCDPSession(tab.page);
    const overlay = new Overlay(tab, cdp);
    cdp.on("Runtime.executionContextCreated", ({ context }: any) =>
      overlay.#contexts.set(context.id, { origin: context.origin, frameId: context.auxData?.frameId ?? "", isolated: context.auxData?.type === "isolated" }),
    );
    cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }: any) => overlay.#contexts.delete(executionContextId));
    cdp.on("Runtime.executionContextsCleared", () => overlay.#contexts.clear());
    const { frameTree } = await cdp.send("Page.getFrameTree");
    overlay.#mainFrame = frameTree.frame.id;
    await cdp.send("Runtime.enable");
    return overlay;
  }

  get page(): Page {
    return this.tab.page;
  }

  /** The newest world of the extension's content script in the page's top frame, if it has run there. */
  #world(): number | null {
    let found: number | null = null;
    for (const [id, context] of this.#contexts) {
      if (context.isolated && context.origin === `chrome-extension://${EXTENSION_ID}` && context.frameId === this.#mainFrame) found = id;
    }
    return found;
  }

  /** Whether Critiqs's content script has run in the page. */
  hasScript(): boolean {
    return this.#world() !== null;
  }

  /**
   * Runs `fn` in the content script's world with the reading helpers. Rejects
   * with Missing when the content script isn't on the page.
   */
  async read<T, A = undefined>(fn: (h: Helpers, arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    const world = this.#world();
    if (world === null) throw new Missing("Critiqs's content script isn't on the page (no world of the extension's in its top frame)");
    const expression = `(async () => { const h = (${helpers.toString()})(); return await (${fn.toString()})(h, ${JSON.stringify(arg ?? null)}); })()`;
    const answer = await this.cdp.send("Runtime.evaluate", { contextId: world, expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails !== undefined) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result.value as T;
  }

  /** Evaluates source text in the content script's world as is (for checks that use the extension's own APIs). */
  async evaluate(expression: string): Promise<{ value?: unknown; error?: string }> {
    const world = this.#world();
    if (world === null) throw new Missing("Critiqs's content script isn't on the page");
    const answer = await this.cdp.send("Runtime.evaluate", { contextId: world, expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails !== undefined) return { error: answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text };
    return { value: answer.result.value };
  }

  /** What a person sees of Critiqs now; `script: false` when its content script never ran here. */
  async seen(): Promise<Seen> {
    if (!this.hasScript()) {
      const roots = await this.page.evaluate(() => document.querySelectorAll("critiqs-root").length).catch(() => 0);
      return { script: false, roots, toolbar: null, mode: null, pins: [], pinLabels: [], outline: null, threadWindow: null, commentBox: null, commentText: null, focusInCommentBox: false, sidebar: null, mockupPanel: null, copy: null, dialogs: [], headings: [], text: "", viewport: { width: 0, height: 0 } };
    }
    return (await this.read((h) => h.seen())) as Seen;
  }

  /** Waits until `check` holds for what is seen; throws Missing naming `what` with the last thing seen. */
  async waitFor(what: string, check: (seen: Seen) => boolean, timeoutMs = 10_000): Promise<Seen> {
    const end = Date.now() + timeoutMs;
    let last: Seen | null = null;
    while (Date.now() < end) {
      last = await this.seen().catch(() => last);
      if (last !== null && check(last)) return last;
      await Bun.sleep(80);
    }
    throw new Missing(`${what} (after ${(timeoutMs / 1000).toFixed(1)} s; ${describe(last)})`);
  }

  /** The toolbar, once shown. */
  toolbar(timeoutMs = 10_000) {
    return this.waitFor("no Critiqs toolbar on the page", (seen) => seen.toolbar !== null, timeoutMs);
  }

  /** Finds an element of Critiqs's that a person can see; its rectangle and whether it is on top. */
  async locate(spec: Find): Promise<{ rect: Rect; onTop: boolean; text: string } | null> {
    if (!this.hasScript()) return null;
    return await this.read((h, wanted) => {
      const element = h.find(wanted);
      return element === null ? null : { rect: h.rect(element)!, onTop: h.onTop(element), text: h.text(element).slice(0, 200) };
    }, spec);
  }

  async has(spec: Find): Promise<boolean> {
    return (await this.locate(spec).catch(() => null)) !== null;
  }

  /** Waits until a person could see `spec`. */
  async expect(spec: Find, timeoutMs = 10_000): Promise<Rect> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = await this.locate(spec).catch(() => null);
      if (found !== null) return found.rect;
      await Bun.sleep(100);
    }
    const seen = await this.seen().catch(() => null);
    throw new Missing(`${label(spec)} doesn't show on the page (after ${(timeoutMs / 1000).toFixed(1)} s; ${describe(seen)})`);
  }

  /** Clicks `spec` with the real mouse, at its middle, once it shows and nothing covers it. */
  async click(spec: Find, timeoutMs = 10_000): Promise<Rect> {
    const end = Date.now() + timeoutMs;
    let covered = false;
    while (Date.now() < end) {
      const found = await this.locate(spec).catch(() => null);
      if (found !== null && found.onTop) {
        await this.page.mouse.click(found.rect.x + found.rect.width / 2, found.rect.y + found.rect.height / 2);
        return found.rect;
      }
      covered = found !== null;
      await Bun.sleep(100);
    }
    const seen = await this.seen().catch(() => null);
    throw new Missing(`${label(spec)} ${covered ? "is covered, so it can't be clicked" : "doesn't show on the page"} (after ${(timeoutMs / 1000).toFixed(1)} s; ${describe(seen)})`);
  }

  /** Clicks a field with the real mouse, clears it with the keyboard, and types `text` key by key. */
  async fill(spec: Find, text: string) {
    await this.click(spec);
    await this.page.keyboard.press("Control+A");
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.type(text);
  }

  /** Moves the real mouse onto an element of the page until Comment mode outlines it; returns the element's rectangle. */
  async hover(selector: string): Promise<Rect> {
    const box = await this.page.locator(selector).first().boundingBox();
    if (box === null) throw new Error(`The page has no ${selector}.`);
    for (let attempt = 0; attempt < 30; attempt++) {
      await this.page.mouse.move(box.x - 30, box.y + box.height + 40, { steps: 2 });
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      const seen = await this.seen().catch(() => null);
      if (seen?.outline != null && overlaps(seen.outline, box)) return box;
      await Bun.sleep(100);
    }
    throw new Missing(`Comment mode never outlined ${selector} under the mouse`);
  }

  /** Picks an element of the page in Comment mode, as a person does: hover until outlined, then click it. */
  async pick(selector: string): Promise<Rect> {
    const box = await this.hover(selector);
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return box;
  }

  async detach() {
    await this.cdp.detach().catch(() => undefined);
  }
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The gap between two rectangles in pixels: 0 when they touch or overlap. */
export function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

export const box = (rect: Rect | null) => (rect === null ? "none" : `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);

export function label(spec: Find): string {
  if ("button" in spec) return `the ${typeof spec.button === "string" ? `"${spec.button}"` : `/${spec.button.pattern}/`} button`;
  if ("menuItem" in spec) return `the menu item ${typeof spec.menuItem === "string" ? `"${spec.menuItem}"` : `/${spec.menuItem.pattern}/`}`;
  if ("heading" in spec) return `"${spec.heading}"`;
  if ("field" in spec) return `the ${spec.field} field`;
  if ("dialog" in spec) return spec.dialog === true ? "a dialog" : `the ${spec.dialog} dialog`;
  if ("text" in spec) return `"${spec.text}"`;
  return `${spec.css}${spec.text === undefined ? "" : ` with "${spec.text}"`}`;
}

/** One line on what Critiqs shows, for failure messages. */
export function describe(seen: Seen | null): string {
  if (seen === null) return "nothing could be read";
  if (!seen.script) return `Critiqs's content script isn't on the page; ${seen.roots} critiqs-root`;
  const parts = [
    `${seen.roots} critiqs-root`,
    seen.toolbar === null ? "no toolbar" : `toolbar at ${box(seen.toolbar)}${seen.mode === null ? "" : `, ${seen.mode} mode`}`,
    `${seen.pins.length} pins`,
  ];
  if (seen.threadWindow !== null) parts.push(`thread window at ${box(seen.threadWindow)}`);
  if (seen.commentBox !== null) parts.push(`comment box at ${box(seen.commentBox)}`);
  if (seen.sidebar !== null) parts.push(`sidebar at ${box(seen.sidebar)}`);
  if (seen.dialogs.length > 0) parts.push(`dialogs ${JSON.stringify(seen.dialogs)}`);
  if (seen.headings.length > 0) parts.push(`headings ${JSON.stringify(seen.headings.slice(0, 4))}`);
  if (seen.text !== "") parts.push(`text "${seen.text.slice(0, 160)}"`);
  return parts.join("; ");
}
