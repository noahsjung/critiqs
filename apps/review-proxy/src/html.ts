import { type DefaultTreeAdapterMap, defaultTreeAdapter, html, parse, serialize } from "parse5";
import { rewriteCss } from "./css.ts";
import { type AssetClass, mapSrcset, mapUrl, type UrlContext } from "./urls.ts";

// Page rewriting. The page is parsed with parse5, which builds the same tree
// a browser does (a page without `<head>` still gets one), rewritten, and
// serialized again. Every address the page loads or links to is mapped
// (urls.ts); `<base>`, content-security and refresh `<meta>` tags, nested
// frames, `srcdoc`, `ping` and `download` are taken out; and two scripts are
// put first in `<head>`: the runtime shim, which rewrites addresses built at
// run time, and the page layer, which talks to the review page around the
// frame. Upstream text only ever reaches the page as attribute values and
// text that the serializer escapes, never inside an inline script.

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const SVG = html.NS.SVG;
const HTML_NS = html.NS.HTML;

export interface Injected {
  /** File names under `/__critiqs/`: `runtime.<hash>.js` and `layer.<hash>.js`. */
  runtime: string;
  layer: string;
  /** The website origins the page layer may answer. */
  panelOrigins: readonly string[];
  /** Where the browser should show the page when the proxy followed redirects to get it: its final path, or null. */
  finalPath: string | null;
}

/** The charset a page declares in its first 1024 bytes (`<meta charset>` or `http-equiv`), lowercased, or null. */
function declaredCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return match === null ? null : match[1]!.toLowerCase();
}

/**
 * The page as text, when it is UTF-8 (by its header, its `<meta>`, or by
 * default) and decodes without errors; null otherwise. Other charsets aren't
 * rewritten: the proxy shows its "can't show this page" notice instead.
 */
export function decodeHtml(bytes: Uint8Array, headerCharset: string | null): string | null {
  const utf8 = (name: string | null) => name === null || name === "utf-8" || name === "utf8" || name === "unicode-1-1-utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return null;
  if (!utf8(headerCharset) || (headerCharset === null && !utf8(declaredCharset(bytes)))) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name && attr.namespace === undefined)?.value;
}

function setAttribute(element: Element, name: string, value: string): void {
  const found = element.attrs.find((attr) => attr.name === name && attr.namespace === undefined);
  if (found !== undefined) found.value = value;
  else element.attrs.push({ name, value });
}

function removeAttributes(element: Element, names: readonly string[]): void {
  element.attrs = element.attrs.filter((attr) => !names.includes(attr.name));
}

function children(node: ParentNode): Node[] {
  const list: Node[] = [...node.childNodes];
  if (node.nodeName === "template") list.push(...defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterMap["template"]).childNodes);
  return list;
}

function* elements(node: ParentNode): Generator<Element> {
  for (const child of children(node)) {
    if (!defaultTreeAdapter.isElementNode(child)) continue;
    yield child;
    yield* elements(child);
  }
}

function textOf(element: Element): string {
  return element.childNodes.map((child) => (defaultTreeAdapter.isTextNode(child) ? child.value : "")).join("");
}

function setText(element: Element, text: string): void {
  for (const child of [...element.childNodes]) defaultTreeAdapter.detachNode(child);
  defaultTreeAdapter.insertText(element, text);
}

/** Element names whose content is another document; replaced by an empty box of the same size. */
const EMBEDS = new Set(["iframe", "frame", "object", "embed", "portal", "fencedframe", "applet"]);

/** `<link rel>` values that only warm up connections or fetch for later: dropped. */
const HINTS = new Set(["dns-prefetch", "preconnect", "prefetch", "prerender", "manifest", "serviceworker"]);

const AS_CLASS: Record<string, AssetClass> = { script: "script", style: "style", font: "font", image: "image", audio: "media", video: "media", track: "media" };

/** The class of a `<source>`: images in a picture, media in audio or video. */
function sourceClass(element: Element): AssetClass {
  const parent = element.parentNode as Element | null;
  return parent?.nodeName === "picture" ? "image" : "media";
}

/** An import map's addresses mapped as scripts; a malformed one is emptied, since the browser would reject it too. */
function rewriteImportMap(ctx: UrlContext, text: string, base: URL): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "{}";
  }
  if (typeof parsed !== "object" || parsed === null) return "{}";
  const map = (entries: unknown) =>
    typeof entries === "object" && entries !== null && !Array.isArray(entries)
      ? Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, typeof value === "string" ? mapUrl(ctx, value, base, "script") : value]))
      : entries;
  const value = parsed as { imports?: unknown; scopes?: unknown; integrity?: unknown };
  const result: Record<string, unknown> = {};
  if (value.imports !== undefined) result.imports = map(value.imports);
  if (value.scopes !== undefined && typeof value.scopes === "object" && value.scopes !== null) {
    result.scopes = Object.fromEntries(Object.entries(value.scopes).map(([scope, entries]) => [mapUrl(ctx, scope, base, "script"), map(entries)]));
  }
  // Import-map integrity names the original addresses; the rewritten ones would never match it.
  return JSON.stringify(result);
}

/** A same-origin refresh's target as a path, or null to drop the tag. */
function rewriteRefresh(ctx: UrlContext, content: string, base: URL): string | null {
  const match = /^\s*(\d+(?:\.\d*)?)\s*(?:[;,]\s*(?:url\s*=\s*)?["']?([^"']*)["']?)?\s*$/i.exec(content);
  if (match === null) return null;
  const [, delay, target] = match;
  if (target === undefined || target === "") return content;
  const mapped = mapUrl(ctx, target, base, "page");
  // Only a refresh to the prototype's own pages stays.
  return mapped.startsWith("/") && !mapped.startsWith("/__critiqs/") ? `${delay}; url=${mapped}` : null;
}

function placeholder(element: Element): Element {
  const width = attribute(element, "width");
  const height = attribute(element, "height");
  const size = [width === undefined ? "" : `width:${/^\d+$/.test(width) ? `${width}px` : "auto"}`, height === undefined ? "" : `height:${/^\d+$/.test(height) ? `${height}px` : "auto"}`]
    .filter((part) => part !== "")
    .join(";");
  const attrs = element.attrs.filter((attr) => attr.name === "class" || attr.name === "id" || attr.name === "style");
  const box = defaultTreeAdapter.createElement("div", HTML_NS, [...attrs, { name: "data-critiqs-embed", value: "" }]);
  const style = box.attrs.find((attr) => attr.name === "style");
  if (size !== "") {
    if (style === undefined) box.attrs.push({ name: "style", value: size });
    else style.value = `${style.value};${size}`;
  }
  return box;
}

/**
 * The page rewritten for a frame host. `documentUrl` is the page's final
 * upstream address, after any redirects the proxy followed.
 */
export function rewriteHtml(ctx: UrlContext, source: string, documentUrl: URL, injected: Injected): string {
  const document = parse(source);

  // The first <base href> on the prototype's own origin sets where relative
  // addresses point, as the browser would; then every <base> goes, since the
  // rewritten addresses are already absolute paths on the frame host.
  let base = documentUrl;
  const all = [...elements(document)];
  for (const element of all) {
    if (element.nodeName !== "base" || element.namespaceURI !== HTML_NS) continue;
    const href = attribute(element, "href");
    if (href === undefined) continue;
    try {
      const candidate = new URL(href, documentUrl);
      if (candidate.origin === documentUrl.origin) base = candidate;
    } catch {
      // Ignored, as the browser would.
    }
    break;
  }

  const map = (element: Element, name: string, as: "page" | AssetClass) => {
    const value = attribute(element, name);
    if (value !== undefined) setAttribute(element, name, mapUrl(ctx, value, base, as));
  };
  const mapSet = (element: Element, name: string, as: AssetClass) => {
    const value = attribute(element, name);
    if (value !== undefined) setAttribute(element, name, mapSrcset(ctx, value, base, as));
  };

  for (const element of all) {
    if (element.parentNode === null) continue; // Already replaced.
    const name = element.nodeName;
    const inline = attribute(element, "style");
    if (inline !== undefined) setAttribute(element, "style", rewriteCss(ctx, inline, base));
    // Never ping trackers or force downloads from a frame host.
    removeAttributes(element, ["ping", "download"]);

    if (element.namespaceURI === SVG) {
      const href = element.attrs.find((attr) => attr.name === "href");
      if (href !== undefined && !href.value.trim().startsWith("#")) {
        href.value = mapUrl(ctx, href.value, base, name === "a" ? "page" : name === "script" ? "script" : "image");
      }
      if (name === "style") setText(element, rewriteCss(ctx, textOf(element), base));
      continue;
    }
    if (element.namespaceURI !== HTML_NS) continue;

    if (EMBEDS.has(name)) {
      defaultTreeAdapter.insertBefore(element.parentNode, placeholder(element), element);
      defaultTreeAdapter.detachNode(element);
      continue;
    }
    switch (name) {
      case "base":
        defaultTreeAdapter.detachNode(element);
        break;
      case "html":
        removeAttributes(element, ["manifest"]);
        break;
      case "meta": {
        const equiv = (attribute(element, "http-equiv") ?? "").toLowerCase();
        if (equiv.startsWith("content-security-policy")) defaultTreeAdapter.detachNode(element);
        else if (equiv === "refresh") {
          const content = rewriteRefresh(ctx, attribute(element, "content") ?? "", base);
          if (content === null) defaultTreeAdapter.detachNode(element);
          else setAttribute(element, "content", content);
        }
        break;
      }
      case "a":
      case "area":
        map(element, "href", "page");
        break;
      case "link": {
        const rel = new Set((attribute(element, "rel") ?? "").toLowerCase().split(/\s+/).filter((token) => token !== ""));
        if ([...rel].some((token) => HINTS.has(token))) {
          defaultTreeAdapter.detachNode(element);
          break;
        }
        let as: "page" | AssetClass | null = "page";
        if (rel.has("stylesheet")) as = "style";
        else if (rel.has("icon") || rel.has("apple-touch-icon") || rel.has("apple-touch-icon-precomposed") || rel.has("mask-icon")) as = "image";
        else if (rel.has("modulepreload")) as = "script";
        else if (rel.has("preload")) as = AS_CLASS[(attribute(element, "as") ?? "").toLowerCase()] ?? null;
        if (as === null) {
          defaultTreeAdapter.detachNode(element);
          break;
        }
        map(element, "href", as);
        if (as !== "page") mapSet(element, "imagesrcset", "image");
        // The stylesheet's bytes change when rewritten, so its integrity can't hold.
        if (as === "style") removeAttributes(element, ["integrity"]);
        break;
      }
      case "script":
        if ((attribute(element, "type") ?? "").toLowerCase() === "importmap") setText(element, rewriteImportMap(ctx, textOf(element), base));
        map(element, "src", "script");
        break;
      case "style":
        setText(element, rewriteCss(ctx, textOf(element), base));
        break;
      case "img":
        map(element, "src", "image");
        mapSet(element, "srcset", "image");
        removeAttributes(element, ["longdesc"]);
        break;
      case "source":
        map(element, "src", sourceClass(element));
        mapSet(element, "srcset", "image");
        break;
      case "video":
        map(element, "src", "media");
        map(element, "poster", "image");
        break;
      case "audio":
      case "track":
        map(element, "src", "media");
        break;
      case "input":
        if ((attribute(element, "type") ?? "").toLowerCase() === "image") map(element, "src", "image");
        map(element, "formaction", "page");
        break;
      case "button":
        map(element, "formaction", "page");
        break;
      case "form":
        map(element, "action", "page");
        break;
      case "body":
      case "table":
      case "td":
      case "th":
        map(element, "background", "image");
        break;
    }
  }

  const head = [...elements(document)].find((element) => element.nodeName === "head" && element.namespaceURI === HTML_NS)!;
  const runtime = defaultTreeAdapter.createElement("script", HTML_NS, [
    { name: "src", value: `/__critiqs/${injected.runtime}` },
    { name: "data-critiqs-map", value: JSON.stringify({ primary: ctx.primary, slots: ctx.slots, path: injected.finalPath }) },
  ]);
  const layer = defaultTreeAdapter.createElement("script", HTML_NS, [
    { name: "src", value: `/__critiqs/${injected.layer}` },
    { name: "defer", value: "" },
    { name: "data-panel-origins", value: JSON.stringify(injected.panelOrigins) },
    { name: "data-channel", value: "review-link" },
  ]);
  const first = head.childNodes[0];
  if (first === undefined) {
    defaultTreeAdapter.appendChild(head, runtime);
    defaultTreeAdapter.appendChild(head, layer);
  } else {
    defaultTreeAdapter.insertBefore(head, runtime, first);
    defaultTreeAdapter.insertBefore(head, layer, first);
  }
  return serialize(document);
}
