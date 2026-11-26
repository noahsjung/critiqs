import type { Rect } from "@critiqs/core";
import { HOST_TAG, MASK_ATTRIBUTE } from "./constants.ts";
import type { CaptureResult } from "./capture.ts";

const MARKER_COLOR = "#0d63f3";
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/**
 * Whether the page has anything marked `data-critiqs-mask` outside Critiqs,
 * including inside open shadow roots, whether or not it shows.
 */
export function hasMasks(root: ParentNode = document): boolean {
  const visit = (scope: ParentNode): boolean => {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      if (element.localName === HOST_TAG) continue;
      if (element.hasAttribute(MASK_ATTRIBUTE)) return true;
      if (element.shadowRoot !== null && visit(element.shadowRoot)) return true;
    }
    return false;
  };
  return visit(root);
}

/**
 * A screenshot of the view taken outside the page, such as an extension's
 * `captureVisibleTab`, with the target outlined as the page's own capture
 * outlines it. Only for pages with nothing masked: a screenshot shows masked
 * content wherever it was at that instant, including what overflows the
 * marked element, so pages with masks use the page's own capture, which
 * leaves masked content out as it copies the page. The screenshot is the
 * visible view at the device's pixel ratio; it is scaled from its own width.
 */
export async function markSuppliedCapture(
  image: Blob,
  { marker, scroll, viewport }: { marker: Rect | null; scroll: { x: number; y: number }; viewport: { width: number; height: number } },
): Promise<CaptureResult> {
  try {
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const drawing = canvas.getContext("2d");
    if (drawing === null) return { status: "failed", reason: "The browser could not create a drawing surface." };
    drawing.drawImage(bitmap, 0, 0);
    bitmap.close();
    const scale = canvas.width / Math.max(1, viewport.width);
    drawing.scale(scale, scale);
    if (marker !== null) {
      drawing.strokeStyle = MARKER_COLOR;
      drawing.lineWidth = 3;
      drawing.strokeRect(marker.x - scroll.x - 2, marker.y - scroll.y - 2, marker.width + 4, marker.height + 4);
    }
    const marked = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (marked === null) return { status: "failed", reason: "The capture could not be encoded." };
    if (marked.size > MAX_CAPTURE_BYTES) return { status: "failed", reason: "The capture was too large to save." };
    return { status: "captured", image: marked };
  } catch {
    return { status: "failed", reason: "The supplied screenshot couldn't be read." };
  }
}
