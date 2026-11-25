import { describePage, type MockupEdit, type PageDescription } from "@critiqs/core";
import { renderSnapshot } from "./render.ts";

/** Characters of one copy's description sent to Critiqs AI; the backend accepts up to 80,000. */
export const DESCRIPTION_BUDGET = 60_000;

/** Describes a shown copy from `top` (page coordinates), one window's height at a time. */
export function describeShown(doc: Document, top: number | null): PageDescription {
  const view = doc.defaultView;
  return describePage(doc, { top: top ?? view?.scrollY ?? 0, height: view?.innerHeight ?? window.innerHeight, budget: DESCRIPTION_BUDGET });
}

/**
 * Describes a copy that isn't shown, laid out in a hidden frame at its own
 * width, so the description has the copy's real layout there.
 */
export async function describeHidden(
  parent: Node,
  copy: { html: string; edits: readonly MockupEdit[]; width: number },
  top: number,
): Promise<PageDescription> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  const style = frame.style;
  style.setProperty("position", "fixed");
  style.setProperty("left", "0");
  style.setProperty("top", "0");
  style.setProperty("width", `${copy.width}px`);
  style.setProperty("height", `${window.innerHeight}px`);
  style.setProperty("border", "0");
  style.setProperty("visibility", "hidden");
  style.setProperty("pointer-events", "none");
  parent.appendChild(frame);
  try {
    await renderSnapshot(frame, copy.html, copy.edits, 0);
    const doc = frame.contentDocument;
    if (doc === null) throw new Error("The page copy couldn't be laid out.");
    return describePage(doc, { top, height: window.innerHeight, budget: DESCRIPTION_BUDGET });
  } finally {
    frame.remove();
  }
}
