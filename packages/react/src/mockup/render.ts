import { applyEdits, type MockupEdit, prioritizeMockupStyles, type SkippedEdit } from "@critiqs/core";
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
    for (const element of Array.from(shown.querySelectorAll(`[${SCROLL_ATTRIBUTE}]`))) {
      const [left = 0, scrollTop = 0] = (element.getAttribute(SCROLL_ATTRIBUTE) ?? "").split(",").map(Number);
      element.scrollTo(left, scrollTop);
    }
    shown.defaultView?.scrollTo(0, top);
  }
  return { skipped };
}
