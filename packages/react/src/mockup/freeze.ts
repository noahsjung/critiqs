import { MOCKUP_NODE_ATTRIBUTE } from "@critiqs/core";
import { HOST_TAG, MASK_ATTRIBUTE } from "../constants.ts";

/** A page copy (snapshot): the page's HTML, styles, and state, with nothing that runs. */
export interface FrozenPage {
  html: string;
  /** The page's whole scrollable size when frozen. */
  width: number;
  height: number;
  /** The window's width when frozen: the width whose layout the copy shows. */
  viewportWidth: number;
  scrollY: number;
  viewportHeight: number;
  capturedAt: number;
}

/** Restores a scrolled container's position in the copy, as `left,top`. */
export const SCROLL_ATTRIBUTE = "data-critiqs-scroll";

/** The color captures cover masked elements with. */
const MASK_COLOR = "#6b7280";
const PLACEHOLDER_COLOR = "#e5e7eb";
const REMOVED = new Set([HOST_TAG, "script", "noscript", "template"]);
const FRAMES = new Set(["iframe", "frame", "object", "embed"]);
/** Layout properties a mask's cover keeps, so the page around it doesn't move. */
const COVER_LAYOUT = [
  "position", "top", "right", "bottom", "left", "float", "margin", "flex-grow", "flex-shrink", "flex-basis",
  "align-self", "justify-self", "grid-area", "vertical-align", "z-index", "border-radius",
];

/**
 * Freezes the page into a self-contained HTML document: the page's elements
 * without Critiqs, scripts, or event attributes; masked elements covered;
 * form values, canvases, open shadow roots, and scroll positions kept; and the
 * page's stylesheets as CSS text, so the copy reflows at other widths as the
 * page would. Every element of the body is numbered with `data-critiqs-node`.
 */
export async function freezePage(options: { document?: Document } = {}): Promise<FrozenPage> {
  const source = options.document ?? document;
  const view = source.defaultView ?? window;
  const capturedAt = Date.now();
  // Elements imported into a document without a window don't load images or media.
  const inert = source.implementation.createHTMLDocument("");
  const sheets = new Sheets(source.baseURI);

  const html = inert.importNode(source.documentElement, true);
  copyElement(source.documentElement, html, { inert, sheets, view });

  const head = html.querySelector("head") ?? html.insertBefore(inert.createElement("head"), html.firstChild);
  for (const sheet of source.adoptedStyleSheets ?? []) head.append(styleElement(inert, sheets.text(sheet), sheet.media.mediaText));
  for (const base of Array.from(head.querySelectorAll("base"))) base.remove();
  const base = inert.createElement("base");
  base.setAttribute("href", source.baseURI);
  head.prepend(base);
  if (head.querySelector('meta[name="viewport"]') === null) {
    const viewport = inert.createElement("meta");
    viewport.setAttribute("name", "viewport");
    viewport.setAttribute("content", "width=device-width, initial-scale=1");
    base.after(viewport);
  }

  const body = html.querySelector("body");
  if (body !== null) {
    // Shadow roots' templates are left out: they become shadow roots when the copy is shown.
    const elements = [body, ...Array.from(body.querySelectorAll("*"))].filter((element) => element.localName !== "template");
    elements.forEach((element, index) => element.setAttribute(MOCKUP_NODE_ATTRIBUTE, String(index + 1)));
  }

  const root = source.documentElement;
  return {
    html: `${source.compatMode === "BackCompat" ? "" : "<!DOCTYPE html>"}${html.outerHTML}`,
    width: Math.max(root.scrollWidth, source.body?.scrollWidth ?? 0),
    height: Math.max(root.scrollHeight, source.body?.scrollHeight ?? 0),
    viewportWidth: view.innerWidth,
    scrollY: view.scrollY,
    viewportHeight: view.innerHeight,
    capturedAt,
  };
}

interface Context {
  inert: Document;
  sheets: Sheets;
  view: Window;
}

/**
 * Fixes up `copy`, a deep import of `original`, from the live element: the
 * two trees have the same shape until this changes `copy`'s children, so
 * each child is visited before it is replaced.
 */
function copyElement(original: Element, copy: Element, context: Context): void {
  for (const name of copy.getAttributeNames()) {
    if (/^on/i.test(name) || name === "autofocus" || name === MOCKUP_NODE_ATTRIBUTE) copy.removeAttribute(name);
  }
  const scrolled = original.scrollLeft !== 0 || original.scrollTop !== 0;
  if (scrolled && original !== original.ownerDocument.documentElement) {
    copy.setAttribute(SCROLL_ATTRIBUTE, `${Math.round(original.scrollLeft)},${Math.round(original.scrollTop)}`);
  }
  keepState(original, copy, context);
  const copies = Array.from(copy.children);

  const shadow = original.shadowRoot;
  if (shadow !== null && original.localName !== HOST_TAG) {
    const template = context.inert.createElement("template");
    template.setAttribute("shadowrootmode", "open");
    if (shadow.delegatesFocus) template.setAttribute("shadowrootdelegatesfocus", "");
    for (const child of Array.from(shadow.childNodes)) {
      const childCopy = context.inert.importNode(child, true);
      template.content.append(childCopy);
      if (child.nodeType === 1) replaceChild(child as Element, childCopy as Element, context);
    }
    for (const sheet of shadow.adoptedStyleSheets ?? []) {
      template.content.append(styleElement(context.inert, context.sheets.text(sheet), sheet.media.mediaText));
    }
    copy.prepend(template);
  }

  const originals = original.children;
  for (let index = 0; index < originals.length; index++) {
    const childCopy = copies[index];
    if (childCopy !== undefined) replaceChild(originals[index]!, childCopy, context);
  }
}

/** Copies one child, or replaces or removes it in the copy. */
function replaceChild(original: Element, copy: Element, context: Context): void {
  const name = original.localName;
  if (REMOVED.has(name) || (name === "meta" && original.hasAttribute("http-equiv"))) {
    copy.remove();
  } else if (original.hasAttribute(MASK_ATTRIBUTE)) {
    copy.replaceWith(cover(original, context));
  } else if (FRAMES.has(name)) {
    copy.replaceWith(placeholder(original, context));
  } else if (name === "style" || name === "link") {
    const sheet = (original as HTMLStyleElement | HTMLLinkElement).sheet;
    const text = sheet ? context.sheets.text(sheet) : undefined;
    const media = original.getAttribute("media") ?? "";
    if (text === undefined) copy.remove();
    else if (text === null) {
      // A stylesheet from another site that the browser won't let pages read.
      const link = context.inert.createElement("link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", (sheet as CSSStyleSheet).href ?? "");
      if (media !== "") link.setAttribute("media", media);
      copy.replaceWith(link);
    } else copy.replaceWith(styleElement(context.inert, text, media));
  } else if (name === "canvas") {
    copy.replaceWith(canvasImage(original as HTMLCanvasElement, copy, context));
  } else {
    copyElement(original, copy, context);
  }
}

/** Form values, selections, images, and video frames as the page shows them now. */
function keepState(original: Element, copy: Element, context: Context): void {
  switch (original.localName) {
    case "input": {
      const input = original as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") toggle(copy, "checked", input.checked);
      else if (input.type === "password") copy.setAttribute("value", input.value === "" ? "" : "••••••••");
      else if (input.type !== "file") copy.setAttribute("value", input.value);
      break;
    }
    case "textarea":
      copy.textContent = (original as HTMLTextAreaElement).value;
      break;
    case "option":
      toggle(copy, "selected", (original as HTMLOptionElement).selected);
      break;
    case "img": {
      const image = original as HTMLImageElement;
      if (image.currentSrc !== "" && !image.currentSrc.startsWith("blob:")) copy.setAttribute("src", image.currentSrc);
      copy.removeAttribute("loading");
      break;
    }
    case "video":
    case "audio": {
      copy.removeAttribute("autoplay");
      const frame = original.localName === "video" ? videoFrame(original as HTMLVideoElement, context) : null;
      if (frame !== null) copy.setAttribute("poster", frame);
      break;
    }
  }
}

function toggle(element: Element, name: string, on: boolean): void {
  if (on) element.setAttribute(name, "");
  else element.removeAttribute(name);
}

function videoFrame(video: HTMLVideoElement, context: Context): string | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  try {
    const canvas = context.view.document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    // A video from another site can't be read.
    return null;
  }
}

/** A canvas as the image it shows, keeping its attributes for layout. */
function canvasImage(original: HTMLCanvasElement, copy: Element, context: Context): Element {
  let source: string;
  try {
    source = original.toDataURL("image/png");
  } catch {
    // Drawn from another site's images, so the browser won't let it be read.
    return placeholder(original, context);
  }
  const image = context.inert.createElement("img");
  for (const name of copy.getAttributeNames()) {
    if (!/^on/i.test(name)) image.setAttribute(name, copy.getAttribute(name)!);
  }
  image.setAttribute("src", source);
  image.setAttribute("width", String(original.width));
  image.setAttribute("height", String(original.height));
  return image;
}

/** An empty box the frame's size, where the copy can't show a frame. */
function placeholder(original: Element, context: Context): Element {
  const box = context.inert.createElement("div");
  for (const name of ["id", "class", "style"]) {
    const value = original.getAttribute(name);
    if (value !== null) box.setAttribute(name, value);
  }
  const rect = original.getBoundingClientRect();
  box.style.setProperty("display", "inline-block");
  // Never wider than its container, so the copy still reflows at narrower widths.
  box.style.setProperty("width", `min(${rect.width}px, 100%)`);
  box.style.setProperty("height", `${rect.height}px`);
  box.style.setProperty("background", PLACEHOLDER_COLOR);
  box.style.setProperty("border", "0");
  return box;
}

/**
 * Covers a masked element: a box of its size and place, with none of its
 * content, attributes, or classes (which can carry generated text).
 */
function cover(original: Element, context: Context): Element {
  const box = context.inert.createElement("div");
  box.setAttribute(MASK_ATTRIBUTE, "");
  const computed = context.view.getComputedStyle(original);
  for (const property of COVER_LAYOUT) box.style.setProperty(property, computed.getPropertyValue(property));
  const display = computed.display;
  box.style.setProperty("display", display === "inline" ? "inline-block" : display === "contents" ? "block" : display);
  const rect = original.getBoundingClientRect();
  box.style.setProperty("box-sizing", "border-box");
  // Never wider than its container, so the copy still reflows at narrower widths.
  box.style.setProperty("width", `min(${rect.width}px, 100%)`);
  box.style.setProperty("height", `${rect.height}px`);
  box.style.setProperty("background", MASK_COLOR);
  return box;
}

function styleElement(doc: Document, text: string | null | undefined, media: string): Element {
  const style = doc.createElement("style");
  if (media !== "") style.setAttribute("media", media);
  // Serialized, a "</style" inside a CSS string would end the element early; the escaped form means the same in CSS.
  style.textContent = (text ?? "").replace(/<\/(style)/gi, "<\\/$1");
  return style;
}

/**
 * The page's stylesheets as CSS text. Rules come from the CSS object model,
 * so rules a page added in scripts are kept; addresses are made absolute
 * against each sheet's own address, since the text moves into the copy.
 */
class Sheets {
  private readonly texts = new Map<CSSStyleSheet, string | null>();

  constructor(private readonly baseUrl: string) {}

  /** The sheet's CSS; null when the browser won't let pages read it; undefined when it's switched off. */
  text(sheet: CSSStyleSheet): string | null | undefined {
    if (sheet.disabled) return undefined;
    if (!this.texts.has(sheet)) this.texts.set(sheet, this.read(sheet));
    return this.texts.get(sheet);
  }

  private read(sheet: CSSStyleSheet): string | null {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return null;
    }
    const base = sheet.href ?? this.baseUrl;
    const imports: string[] = [];
    const body: string[] = [];
    for (const rule of Array.from(rules)) {
      if (!isImport(rule)) {
        body.push(absoluteUrls(rule.cssText, base));
        continue;
      }
      const inner = rule.styleSheet === null ? null : this.read(rule.styleSheet);
      const media = rule.media.mediaText;
      if (inner === null) {
        imports.push(`@import url(${JSON.stringify(resolve(rule.href, base))})${media === "" ? "" : ` ${media}`};`);
        continue;
      }
      let text = inner;
      if (media !== "") text = `@media ${media} {\n${text}\n}`;
      if (rule.layerName != null) text = `@layer ${rule.layerName} {\n${text}\n}`;
      body.push(text);
    }
    return [...imports, ...body].join("\n");
  }
}

function isImport(rule: CSSRule): rule is CSSImportRule {
  return "styleSheet" in rule && "href" in rule;
}

const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"'\s]+))\s*\)/g;

function absoluteUrls(css: string, base: string): string {
  if (!css.includes("url(")) return css;
  return css.replace(CSS_URL, (match, double?: string, single?: string, bare?: string) => {
    const url = double ?? single ?? bare ?? "";
    // `url(#id)` points into the document itself, such as an SVG filter.
    if (url.startsWith("#") || url.startsWith("data:")) return match;
    return `url(${JSON.stringify(resolve(url, base))})`;
  });
}

function resolve(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
