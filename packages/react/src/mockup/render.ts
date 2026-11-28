import { applyEdits, MOCKUP_STYLE_ATTRIBUTE, type MockupEdit, prioritizeMockupSheet, prioritizeMockupStyles, type SkippedEdit } from "@critiqs/core";
import { SCROLL_ATTRIBUTE } from "./freeze.ts";

/** Longest wait for the copy's images and stylesheets before scrolling it anyway. */
const LOAD_TIMEOUT_MS = 10_000;

/**
 * Shows a page copy with a version's changes in `iframe`, where nothing in the
 * copy can run: the frame is sandboxed without scripts. The changes are
 * applied before the copy loads, so the unchanged copy never flashes. The
 * frame stays scrolled where it was unless `scrollY` is given.
 */
export async function renderSnapshot(
  iframe: HTMLIFrameElement,
  html: string,
  edits: readonly MockupEdit[],
  scrollY?: number,
): Promise<{ skipped: SkippedEdit[] }> {
  // A parsed document has no window, so nothing in it loads or runs.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const { skipped } = applyEdits(doc, edits);
  const top = scrollY ?? iframe.contentWindow?.scrollY ?? 0;

  iframe.setAttribute("sandbox", "allow-same-origin");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
    iframe.addEventListener("load", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    iframe.srcdoc = `${doc.doctype === null ? "" : "<!DOCTYPE html>"}${doc.documentElement.outerHTML}`;
  });

  const shown = iframe.contentDocument;
  if (shown !== null) {
    prioritizeMockupStyles(shown);
    applyRefusedStyles(shown);
    for (const element of Array.from(shown.querySelectorAll(`[${SCROLL_ATTRIBUTE}]`))) {
      const [left = 0, scrollTop = 0] = (element.getAttribute(SCROLL_ATTRIBUTE) ?? "").split(",").map(Number);
      element.scrollTo(left, scrollTop);
    }
    shown.defaultView?.scrollTo(0, top);
  }
  return { skipped };
}

/**
 * Applies the copy's styles that the page's Content-Security-Policy refused.
 * A `srcdoc` copy takes the page's policy, and a strict `style-src` refuses
 * its <style> elements (their `sheet` stays null) and its style attributes
 * (their declarations stay empty). Constructed stylesheets and declarations
 * set through the CSS object model aren't governed by it. Only what was
 * refused moves, each refused <style> into a stylesheet adopted by its own
 * root, in order and with its media, so a copy the policy let through stays
 * exactly as it was.
 */
function applyRefusedStyles(doc: Document): void {
  const view = doc.defaultView;
  if (view === null || !("replaceSync" in view.CSSStyleSheet.prototype)) return;
  for (const root of [doc, ...shadowRoots(doc)]) {
    const refused = Array.from(root.querySelectorAll("style")).filter((style) => style.sheet === null);
    if (refused.length > 0) {
      const sheets = refused.map((style) => {
        const sheet = new view.CSSStyleSheet({ media: style.media });
        sheet.replaceSync(style.textContent ?? "");
        // A version's changes win over the page's own rules, as they do when the policy allows them.
        if (style.hasAttribute(MOCKUP_STYLE_ATTRIBUTE)) prioritizeMockupSheet(sheet);
        return sheet;
      });
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...sheets];
      for (const style of refused) style.remove();
    }
    for (const element of Array.from(root.querySelectorAll("[style]"))) {
      if (!(element instanceof view.HTMLElement || element instanceof view.SVGElement)) continue;
      const declared = element.getAttribute("style") ?? "";
      if (element.style.length === 0 && declared.trim() !== "") element.style.cssText = declared;
    }
  }
}

/** The open shadow roots in the copy, such as those its frozen web components declare, at any depth. */
function shadowRoots(doc: Document): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const visit = (scope: ParentNode) => {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      if (element.shadowRoot === null) continue;
      found.push(element.shadowRoot);
      visit(element.shadowRoot);
    }
  };
  visit(doc);
  return found;
}
