// Mockups: proposed changes shown on frozen page copies (snapshots). See
// docs/technical-direction.md#mockup-mode. Nothing here touches the DOM until
// called, so backends without one can import the types and `parseEdits`.

import type { ThreadSummary } from "./protocol.ts";
import type { Revision, ViewState } from "./types.ts";

/** Numbers every element of a page copy's body, so changes can name them. */
export const MOCKUP_NODE_ATTRIBUTE = "data-critiqs-node";

/** Marks the stylesheet that holds a mockup's CSS changes. */
export const MOCKUP_STYLE_ATTRIBUTE = "data-critiqs-mockup";

export const MOCKUP_LIMITS = {
  editsPerVersion: 400,
  /** Characters of HTML in one insert or replace. */
  htmlChars: 20_000,
  /** Characters of CSS in one change. */
  cssChars: 20_000,
  /** Characters of a text change or an attribute value. */
  textChars: 20_000,
  /** UTF-8 bytes of one copy's whole edit list, serialized as JSON. */
  versionBytes: 256 * 1024,
  /** Existing threads one mockup links, at most. */
  linkedThreads: 20,
} as const;

/** One change to a page copy. Elements are named by their `data-critiqs-node` number. */
export type MockupEdit =
  /** Rules added to the mockup's own stylesheet, after the page's; media queries allowed. */
  | { kind: "css"; css: string }
  /** Replaces the element's content with plain text. */
  | { kind: "text"; node: number; text: string }
  /** Sets an attribute, or removes it when `value` is null. */
  | { kind: "attribute"; node: number; name: string; value: string | null }
  | { kind: "insert"; node: number; position: InsertPosition; html: string }
  | { kind: "replace"; node: number; html: string }
  | { kind: "remove"; node: number };

export type InsertPosition = "before" | "after" | "prepend" | "append";

/** What a thread in a mockup is about: the mockup, and optionally one element of one copy. */
export interface ThreadMockup {
  mockupId: string;
  snapshotId: string | null;
  node: number | null;
}

/** The page a mockup was made from. */
export interface MockupSource {
  url: string;
  screen: string;
  viewState: ViewState;
  revision: Revision;
  persona: string | null;
  /**
   * The record the page showed (its one `data-critiqs-record`), so going back
   * opens the same record; null on pages with none or several; absent from
   * older mockups.
   */
  recordKey?: string | null;
}

/** One page copy of a mockup, taken at one width. */
export interface MockupSnapshotInfo {
  _id: string;
  width: number;
  height: number;
  capturedAt: number;
  createdByName: string;
}

export interface MockupVersionView {
  /** 1, 2, 3… in the order versions were saved. */
  number: number;
  createdAt: number;
  authorName: string;
  /** Made by Critiqs AI rather than a person. */
  byAi: boolean;
  summary: string;
  /** The thread and message that asked for this version, if any. */
  threadId: string | null;
  messageId: string | null;
  /** The version this one restored, if it is a restore. */
  restoredFrom: number | null;
  /** For each copy (by snapshot ID), every change from the original copy, in order. */
  edits: Record<string, MockupEdit[]>;
}

export interface MockupSummary {
  _id: string;
  projectId: string;
  title: string;
  source: MockupSource;
  createdAt: number;
  updatedAt: number;
  /**
   * `updatedAt` once the mockup's thread exists, null before: the Mockup
   * panel lists only mockups with a thread, most recently active first.
   */
  listedAt: number | null;
  createdByName: string;
  versionCount: number;
  threadCount: number;
  /** Each page copy's ID and width, oldest first. */
  snapshots: Pick<MockupSnapshotInfo, "_id" | "width">[];
  /**
   * The mockup's threads, oldest first. A mockup made in the panel has one:
   * each mockup thread is its own proposal. Mockups made before that may have more.
   */
  threads: ThreadSummary[];
}

/**
 * Which mockups one list page reads: one screen's, or every other screen's.
 * The Mockup panel reads this page's and the other pages' separately, so each
 * can load more on its own.
 */
export type MockupListScope = { screen: string } | { otherThan: string };

export type MockupDetail = Omit<MockupSummary, "snapshots"> & {
  snapshots: MockupSnapshotInfo[];
  /** Existing threads added to the mockup as instructions. */
  linkedThreadIds: string[];
  /** Oldest first. */
  versions: MockupVersionView[];
};

const POSITIONS: readonly InsertPosition[] = ["before", "after", "prepend", "append"];
const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "background", "cite", "data", "ping"]);
/**
 * Elements whose text a browser writes out unescaped when it serializes the
 * copy, so text set in them would be parsed as markup when the copy is shown.
 */
const RAW_TEXT_ELEMENTS = ["xmp", "noembed", "noframes", "plaintext"];
/** Elements whose content a parser reads as text up to their closing tag. */
const TEXT_CONTENT_ELEMENTS = new Set(["textarea", "title"]);
/** Elements that `sanitizeHtml` drops or that can run or load code; refused up front so the AI hears about it. */
const UNSAFE_ELEMENTS = new Set(
  [...RAW_TEXT_ELEMENTS, "script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "base", "meta", "link", "style", "template", "noscript", "animate", "animatemotion", "animatetransform", "set"],
);
const SPACE = /[\t\n\f\r ]/;
/** Image types a `data:` address may carry; anything else could hold a document or script. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif)[;,]/;

/**
 * Checks changes from outside (Critiqs AI, the network) and returns them in
 * their own objects, or null when any change is malformed, too large, or
 * unsafe. Inserted HTML is cleaned again by `sanitizeHtml` when shown.
 */
export function parseEdits(value: unknown): MockupEdit[] | null {
  if (!Array.isArray(value) || value.length > MOCKUP_LIMITS.editsPerVersion) return null;
  const edits: MockupEdit[] = [];
  for (const item of value) {
    const edit = parseEdit(item);
    if (edit === null) return null;
    edits.push(edit);
  }
  if (new TextEncoder().encode(JSON.stringify(edits)).length > MOCKUP_LIMITS.versionBytes) return null;
  return edits;
}

function parseEdit(item: unknown): MockupEdit | null {
  if (typeof item !== "object" || item === null) return null;
  const raw = item as Record<string, unknown>;
  if (raw.kind === "css") {
    return isText(raw.css, MOCKUP_LIMITS.cssChars) && cssProblem(raw.css) === null ? { kind: "css", css: raw.css } : null;
  }
  const node = raw.node;
  if (!isNodeId(node)) return null;
  switch (raw.kind) {
    case "text":
      return isText(raw.text, MOCKUP_LIMITS.textChars) ? { kind: "text", node, text: raw.text } : null;
    case "attribute": {
      const { name, value } = raw;
      if (typeof name !== "string" || !(value === null || isText(value, MOCKUP_LIMITS.textChars))) return null;
      return attributeProblem(name, value) === null ? { kind: "attribute", node, name, value } : null;
    }
    case "insert": {
      const position = POSITIONS.find((candidate) => candidate === raw.position);
      return position !== undefined && isMarkup(raw.html) ? { kind: "insert", node, position, html: raw.html } : null;
    }
    case "replace":
      return isMarkup(raw.html) ? { kind: "replace", node, html: raw.html } : null;
    case "remove":
      return { kind: "remove", node };
    default:
      return null;
  }
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isMarkup(value: unknown): value is string {
  return isText(value, MOCKUP_LIMITS.htmlChars) && markupProblem(value) === null;
}

/**
 * Checks each start tag's element and attributes with the same rules as
 * attribute changes; text between tags is never refused. Tags are read the
 * way an HTML parser reads them (a tag opens only at `<` followed by a letter,
 * and an unquoted value runs to whitespace or `>`), so quoting tricks can't
 * hide an attribute. Values that HTML parsers treat as errors are refused.
 */
function markupProblem(html: string): string | null {
  for (let index = html.indexOf("<"); index !== -1; index = html.indexOf("<", index + 1)) {
    // Comments and bogus comments end where a parser ends them, so quotes inside can't hide what follows.
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      if (end === -1) return "HTML has an unclosed comment.";
      index = end + 2;
      continue;
    }
    if (html[index + 1] === "!" || html[index + 1] === "?") {
      const end = html.indexOf(">", index);
      if (end === -1) return "HTML has an unclosed comment.";
      index = end;
      continue;
    }
    if (!/[a-zA-Z]/.test(html[index + 1] ?? "")) continue;
    const tag = readTag(html, index + 1);
    if (typeof tag === "string") return tag;
    const tagName = tag.name.toLowerCase();
    if (UNSAFE_ELEMENTS.has(tagName)) return `<${tag.name}> can't be added.`;
    for (const { name, value } of tag.attributes) {
      // `sanitizeHtml` removes element numbers the AI copies; they aren't a reason to refuse.
      if (name.toLowerCase() === MOCKUP_NODE_ATTRIBUTE) continue;
      const problem = attributeProblem(name, decodeReferences(value));
      if (problem !== null) return problem;
    }
    index = tag.end;
    if (TEXT_CONTENT_ELEMENTS.has(tagName)) {
      const close = html.toLowerCase().indexOf(`</${tagName}`, index);
      index = close === -1 ? html.length : close;
    }
  }
  return null;
}

type ReadTag = { name: string; attributes: { name: string; value: string }[]; end: number };

/** Reads one start tag from just after its `<`, or says why it can't be checked. */
function readTag(html: string, start: number): ReadTag | string {
  let at = start;
  while (at < html.length && !SPACE.test(html[at]!) && html[at] !== "/" && html[at] !== ">") at++;
  const tag: ReadTag = { name: html.slice(start, at), attributes: [], end: html.length };
  for (;;) {
    while (at < html.length && (SPACE.test(html[at]!) || html[at] === "/")) at++;
    if (at >= html.length) return "HTML has an unclosed tag.";
    if (html[at] === ">") {
      tag.end = at;
      return tag;
    }
    const nameStart = at;
    at++;
    while (at < html.length && !SPACE.test(html[at]!) && !"/>=".includes(html[at]!)) at++;
    const name = html.slice(nameStart, at);
    while (at < html.length && SPACE.test(html[at]!)) at++;
    let value = "";
    if (html[at] === "=") {
      at++;
      while (at < html.length && SPACE.test(html[at]!)) at++;
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, at + 1);
        if (close === -1) return "HTML has an unclosed attribute value.";
        value = html.slice(at + 1, close);
        at = close + 1;
      } else {
        const valueStart = at;
        while (at < html.length && !SPACE.test(html[at]!) && html[at] !== ">") at++;
        value = html.slice(valueStart, at);
        if (/["'<=`]/.test(value)) return `"${name}" has a malformed value.`;
      }
    }
    tag.attributes.push({ name, value });
  }
}

/** Decodes the character references that can spell a URL scheme, such as `&#x61;` or `&colon;`. */
function decodeReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_, decimal: string) => String.fromCodePoint(Math.min(Number.parseInt(decimal, 10), 0x10ffff)))
    .replace(/&(colon|tab|newline|lpar|rpar|sol|period|comma|semi);?/gi, (_, name: string) =>
      ({ colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")", sol: "/", period: ".", comma: ",", semi: ";" })[name.toLowerCase()]!,
    );
}

function isNodeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Why an attribute can't be set on a copy's element, or null when it can. */
function attributeProblem(name: string, value: string | null): string | null {
  if (!ATTRIBUTE_NAME.test(name)) return `"${name}" isn't an attribute name.`;
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || lower === "srcdoc") return `"${name}" would run code.`;
  if (lower === MOCKUP_NODE_ATTRIBUTE) return "Element numbers can't be changed.";
  if (value === null) return null;
  if (URL_ATTRIBUTES.has(lower) && isScriptUrl(value)) return `"${name}" would run code.`;
  if (lower === "style") return cssProblem(value);
  return null;
}

function isScriptUrl(value: string): boolean {
  // Browsers ignore whitespace and control characters inside a URL's scheme.
  const compact = value.replace(/[\u0000- ]/g, "").toLowerCase();
  // A named reference left in the scheme could still spell one, so it's refused rather than guessed.
  const scheme = compact.split(/[/?#]/, 1)[0] ?? "";
  const colon = scheme.indexOf(":");
  if (colon !== -1 && scheme.slice(0, colon).includes("&")) return true;
  if (compact.startsWith("data:")) return !DATA_IMAGE.test(compact);
  return compact.startsWith("javascript:") || compact.startsWith("vbscript:");
}

/**
 * Why CSS can't go in the mockup's stylesheet, or null when it can. All
 * changes share one stylesheet, so an unclosed block, string, or comment
 * would swallow the changes after it.
 */
function cssProblem(css: string): string | null {
  // Escapes such as `@\69 mport` spell the same words, so they're read before looking for them.
  const lower = css.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))).replace(/\\(.)/g, "$1").toLowerCase();
  if (lower.includes("</style")) return "CSS can't close its style element.";
  if (lower.includes("@import")) return "CSS can't import other stylesheets.";
  if (lower.includes("expression(") || lower.includes("javascript:")) return "CSS can't run code.";
  let depth = 0;
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === "\\") index++;
    else if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) return "CSS has an unclosed comment.";
      index = end + 1;
    } else if (char === '"' || char === "'") {
      let close = index + 1;
      while (close < css.length && css[close] !== char && css[close] !== "\n") close += css[close] === "\\" ? 2 : 1;
      if (css[close] !== char) return "CSS has an unclosed string.";
      index = close;
    } else if (char === "{") depth++;
    else if (char === "}" && --depth < 0) return "CSS closes a block it didn't open.";
  }
  return depth === 0 ? null : "CSS has an unclosed block.";
}

const DROPPED_ELEMENTS = new Set([
  ...RAW_TEXT_ELEMENTS, "script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "base", "meta", "link", "style", "template", "noscript", "animate", "animatemotion", "animatetransform", "set",
]);
const ANIMATED_URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "action", "formaction"]);

/**
 * Parses HTML for a page copy without anything that could run code, load
 * frames or other pages, or restyle the whole copy: scripts, frames, plugins,
 * `base`, `meta`, `link`, and `style` elements, event attributes, `srcdoc`,
 * and script addresses. Element numbers are removed; `applyEdits` assigns them.
 */
export function sanitizeHtml(html: string, doc: Document): DocumentFragment {
  const template = doc.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    if (DROPPED_ELEMENTS.has(element.localName) || animatesUrl(element)) {
      element.remove();
      continue;
    }
    for (const name of element.getAttributeNames()) {
      if (attributeProblem(name, element.getAttribute(name)) !== null) element.removeAttribute(name);
    }
  }
  return template.content;
}

/** An SVG animation that would set a link or event attribute. */
function animatesUrl(element: Element): boolean {
  const target = element.getAttribute("attributeName")?.trim().toLowerCase();
  return target !== undefined && (ANIMATED_URL_ATTRIBUTES.has(target) || target.startsWith("on"));
}

export interface SkippedEdit {
  /** The change's position in the list. */
  index: number;
  reason: string;
}

/**
 * Applies changes, in order, to a page copy as frozen. The same list on the
 * same copy always gives the same document: elements a change adds are
 * numbered in document order after the highest number already used, and a
 * change whose element is gone (removed by an earlier change, or never
 * there) is skipped rather than stopping the rest.
 */
export function applyEdits(doc: Document, edits: readonly MockupEdit[]): { skipped: SkippedEdit[] } {
  const nodes = new Map<number, Element>();
  let lastNode = 0;
  for (const element of Array.from(doc.querySelectorAll(`[${MOCKUP_NODE_ATTRIBUTE}]`))) {
    const id = Number(element.getAttribute(MOCKUP_NODE_ATTRIBUTE));
    if (!isNodeId(id)) continue;
    if (!nodes.has(id)) nodes.set(id, element);
    lastNode = Math.max(lastNode, id);
  }
  const numbered = (fragment: DocumentFragment): DocumentFragment => {
    for (const element of Array.from(fragment.querySelectorAll("*"))) {
      lastNode++;
      element.setAttribute(MOCKUP_NODE_ATTRIBUTE, String(lastNode));
      nodes.set(lastNode, element);
    }
    return fragment;
  };

  const css: string[] = [];
  const skipped: SkippedEdit[] = [];
  edits.forEach((edit, index) => {
    try {
      const reason = applyEdit(edit);
      if (reason !== null) skipped.push({ index, reason });
    } catch (error) {
      skipped.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  function applyEdit(edit: MockupEdit): string | null {
    if (edit.kind === "css") {
      const problem = cssProblem(edit.css);
      if (problem === null) css.push(edit.css);
      return problem;
    }
    const element = nodes.get(edit.node);
    if (element === undefined || !element.isConnected) return `Element #${edit.node} isn't on the page.`;
    const isBody = element === doc.body;
    switch (edit.kind) {
      case "text":
        if (isBody) return "The page's body can't be replaced with text.";
        // Their text is written out unescaped when the copy is shown, so it would become markup.
        if (RAW_TEXT_ELEMENTS.includes(element.localName)) return `Text in <${element.localName}> can't be changed.`;
        element.textContent = edit.text;
        return null;
      case "attribute": {
        const problem = attributeProblem(edit.name, edit.value);
        if (problem !== null) return problem;
        if (edit.value === null) element.removeAttribute(edit.name);
        else element.setAttribute(edit.name, edit.value);
        return null;
      }
      case "insert": {
        if (isBody && (edit.position === "before" || edit.position === "after")) return "Nothing can go outside the page's body.";
        const fragment = numbered(sanitizeHtml(edit.html, doc));
        if (edit.position === "before") element.before(fragment);
        else if (edit.position === "after") element.after(fragment);
        else if (edit.position === "prepend") element.prepend(fragment);
        else element.append(fragment);
        return null;
      }
      case "replace":
        if (isBody) return "The page's body can't be replaced.";
        element.replaceWith(numbered(sanitizeHtml(edit.html, doc)));
        return null;
      case "remove":
        if (isBody) return "The page's body can't be removed.";
        element.remove();
        return null;
      default:
        return "Unknown change.";
    }
  }

  for (const old of Array.from(doc.querySelectorAll(`style[${MOCKUP_STYLE_ATTRIBUTE}]`))) old.remove();
  if (css.length > 0) {
    const style = doc.createElement("style");
    style.setAttribute(MOCKUP_STYLE_ATTRIBUTE, "");
    style.textContent = css.join("\n");
    (doc.head ?? doc.documentElement).append(style);
  }
  return { skipped };
}

/**
 * Makes every declaration in a shown copy's mockup stylesheet `!important`, so
 * a change wins over the page's own rules however specific they are, as the
 * person who asked for it expects. Needs a document with style sheets, such
 * as the frame showing the copy; stored changes stay as written.
 */
export function prioritizeMockupStyles(doc: Document): void {
  const sheet = doc.querySelector<HTMLStyleElement>(`style[${MOCKUP_STYLE_ATTRIBUTE}]`)?.sheet;
  if (sheet) prioritize(sheet.cssRules);
}

function prioritize(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    // Only style rules: browsers ignore important declarations in @keyframes, and @font-face descriptors aren't in the cascade.
    if (rule.type === STYLE_RULE) {
      const { style } = rule as CSSStyleRule;
      for (const name of Array.from(style)) style.setProperty(name, style.getPropertyValue(name), "important");
    }
    const nested = (rule as Partial<CSSGroupingRule>).cssRules;
    if (nested !== undefined && rule.type !== KEYFRAMES_RULE) prioritize(nested);
  }
}

const STYLE_RULE = 1;
const KEYFRAMES_RULE = 7;

export interface PageDescription {
  text: string;
  /** Every element was described in detail within the budget. */
  complete: boolean;
  /** Where, in page coordinates, to look next for content below that wasn't described in detail. */
  nextTop: number | null;
}

const NOT_DESCRIBED = new Set(["script", "style", "template", "noscript", "link", "meta", "base"]);
/** Siblings outside the focus window shown one per line before the rest are summed up. */
const OUTLINED_SIBLINGS = 3;

/**
 * Describes a page copy for Critiqs AI as compact, indented pseudo-HTML: one
 * element per line with its number, and, for elements in the focus window
 * [top, top + height] (page coordinates), the styles that set it apart.
 * Elements wholly outside the window are summed up in one line each, and long
 * runs of them in one line. Elements without a box, such as when the copy
 * isn't laid out, are described from their children.
 */
export function describePage(doc: Document, options: { top: number; height: number; budget: number }): PageDescription {
  const view = doc.defaultView;
  const scrollY = view?.scrollY ?? 0;
  const windowEnd = options.top + options.height;
  const lines: string[] = [];
  const state = { length: 0, outOfBudget: false, collapsed: false, nextTop: null as number | null };

  const add = (depth: number, line: string): boolean => {
    const text = `${"  ".repeat(depth)}${line}`;
    if (state.length + text.length + 1 > options.budget) {
      state.outOfBudget = true;
      return false;
    }
    lines.push(text);
    state.length += text.length + 1;
    return true;
  };
  /** Content from `top` down still needs describing in detail. */
  const later = (top: number) => {
    if (top >= options.top) state.nextTop = state.nextTop === null ? top : Math.min(state.nextTop, top);
  };
  /** Where an element's box is, against the focus window; "unknown" when it has none. */
  const place = (element: Element): { at: "above" | "inside" | "below" | "unknown"; top: number; rect: DOMRect } => {
    const rect = element.getBoundingClientRect();
    const top = rect.top + scrollY;
    if (rect.width <= 0 || rect.height <= 0) return { at: "unknown", top, rect };
    if (top > windowEnd) return { at: "below", top, rect };
    return { at: rect.bottom + scrollY < options.top ? "above" : "inside", top, rect };
  };

  const visit = (element: Element, depth: number, inherited: Inherited | null): void => {
    const { at, top, rect } = place(element);
    const head = summary(element);
    if (at === "above" || at === "below") {
      state.collapsed = true;
      if (at === "below") later(top);
      add(depth, `${head} [${at}${count(descendants(element))}]`);
      return;
    }
    const style = view?.getComputedStyle(element);
    if (style?.display === "none") {
      add(depth, `${head} [hidden${count(descendants(element))}]`);
      return;
    }
    if (!add(depth, `${head}${at === "inside" && style !== undefined ? describeStyle(style, rect, inherited) : ""}`)) {
      later(top);
      return;
    }
    if (element.localName === "svg") {
      const inside = descendants(element);
      if (inside > 0) add(depth + 1, `[${inside} drawing elements]`);
      return;
    }
    const passed = style === undefined ? inherited : { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
    const children = Array.from(element.children).filter((child) => !NOT_DESCRIBED.has(child.localName));
    for (let index = 0; index < children.length && !state.outOfBudget; index++) {
      const run = outsideRun(children, index);
      if (run.length <= OUTLINED_SIBLINGS) {
        visit(children[index]!, depth + 1, passed);
        continue;
      }
      for (const outlined of run.slice(0, OUTLINED_SIBLINGS)) visit(outlined, depth + 1, passed);
      const rest = run.slice(OUTLINED_SIBLINGS).map(place);
      const restBelow = rest.filter((entry) => entry.at === "below");
      for (const entry of restBelow) later(entry.top);
      const elements = run.slice(OUTLINED_SIBLINGS);
      const total = elements.reduce((sum, sibling) => sum + 1 + descendants(sibling), 0);
      add(depth + 1, `… ${elements.length} more siblings ${nodeLabel(elements[0]!)}–${nodeLabel(elements.at(-1)!)} [${restBelow.length > 0 ? "below" : "above"}, ${total} elements]`);
      index += run.length - 1;
    }
  };

  /** The consecutive siblings from `index` whose boxes are wholly outside the window. */
  const outsideRun = (children: Element[], index: number): Element[] => {
    const run: Element[] = [];
    for (let at = index; at < children.length; at++) {
      const where = place(children[at]!).at;
      if (where !== "above" && where !== "below") break;
      run.push(children[at]!);
    }
    return run;
  };

  if (doc.body !== null) visit(doc.body, 0, null);

  let nextTop = state.nextTop;
  // Always move down, so a caller that keeps following `nextTop` stops.
  if (nextTop !== null && nextTop <= options.top) nextTop = windowEnd;
  // Past the page's end, or a page that isn't laid out, has nothing more to show.
  if (nextTop !== null && nextTop >= doc.documentElement.scrollHeight) nextTop = null;
  return { text: lines.join("\n"), complete: !state.outOfBudget && !state.collapsed, nextTop };
}

type Inherited = { color: string; fontSize: string; fontWeight: string };

function count(inside: number): string {
  return inside > 0 ? `, ${inside} inside` : "";
}

function summary(element: Element): string {
  const parts = [element.localName, nodeLabel(element)];
  const id = element.getAttribute("id");
  if (id) parts.push(`id=${clip(id, 40)}`);
  const classes = Array.from(element.classList).slice(0, 4).map((name) => clip(name, 32));
  if (classes.length > 0) parts.push(`.${classes.join(".")}${element.classList.length > 4 ? "…" : ""}`);
  for (const name of ["role", "aria-label", "type", "alt", "placeholder", "value", "href", "src"]) {
    const value = element.getAttribute(name);
    if (value === null || value === "") continue;
    parts.push(`${name}=${JSON.stringify(name === "href" || name === "src" ? shortUrl(value) : clip(value, 60))}`);
  }
  for (const flag of ["checked", "selected", "disabled"]) if (element.hasAttribute(flag)) parts.push(flag);
  const text = ownText(element);
  if (text !== "") parts.push(JSON.stringify(clip(text, 80)));
  return parts.join(" ");
}

function nodeLabel(element: Element): string {
  const id = element.getAttribute(MOCKUP_NODE_ATTRIBUTE);
  return id === null ? "#?" : `#${id}`;
}

/** The element's own text, with "…" where its child elements are, which get lines of their own. */
function ownText(element: Element): string {
  let text = "";
  let hasText = false;
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) {
      text += child.textContent ?? "";
      hasText ||= (child.textContent ?? "").trim() !== "";
    } else if (child.nodeType === 1 && !NOT_DESCRIBED.has((child as Element).localName)) text += " … ";
  }
  return hasText ? text.replace(/\s+/g, " ").replace(/(… )+…/g, "…").trim() : "";
}

function descendants(element: Element): number {
  return element.getElementsByTagName("*").length;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortUrl(value: string): string {
  if (value.startsWith("data:")) return `${value.slice(0, value.indexOf(",") + 1 || 20)}…`;
  return clip(value.replace(/^https?:\/\/[^/]+/, ""), 60) || "/";
}

function describeStyle(style: CSSStyleDeclaration, rect: DOMRect, inherited: Inherited | null): string {
  const notes: string[] = [];
  const note = (label: string, value: string, skip: (value: string) => boolean) => {
    if (value !== "" && !skip(value)) notes.push(`${label}:${shortColor(value)}`);
  };
  const zero = (value: string) => /^(0px ?)+$/.test(value);
  if (style.display !== "block" && style.display !== "inline") notes.push(style.display);
  note("pos", style.position, (value) => value === "static");
  note("color", style.color, (value) => value === inherited?.color);
  note("bg", style.backgroundColor, (value) => value === "transparent" || value === "rgba(0, 0, 0, 0)");
  note("font", style.fontSize, (value) => value === inherited?.fontSize);
  note("weight", style.fontWeight, (value) => value === inherited?.fontWeight);
  note("pad", style.padding, zero);
  note("margin", style.margin, zero);
  note("radius", style.borderRadius, zero);
  note("gap", style.gap, (value) => value === "normal" || value === "normal normal");
  notes.push(`${Math.round(rect.width)}x${Math.round(rect.height)}`);
  return ` {${notes.join("; ")}}`;
}

/** `rgb(13, 99, 243)` as `#0d63f3`; other values unchanged. */
function shortColor(value: string): string {
  return value.replace(/rgb\((\d+), (\d+), (\d+)\)/g, (_, r: string, g: string, b: string) =>
    `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`);
}
