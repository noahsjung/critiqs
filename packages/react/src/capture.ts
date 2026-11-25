import type { Rect } from "@critiqs/core";
import { createContext, destroyContext, domToForeignObjectSvg, type Context } from "modern-screenshot";
import { HOST_TAG, MASK_ATTRIBUTE } from "./constants.ts";

const CAPTURE_TIMEOUT_MS = 10_000;
/** How long copying the page runs before the page gets a turn to handle input and timers. */
const SLICE_MS = 30;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MARKER_COLOR = "#0d63f3";
const MASK_COLOR = "#6b7280";
const TOO_LONG = "The capture took too long.";

export type CaptureResult = { status: "captured"; image: Blob } | { status: "failed"; reason: string };

/**
 * Captures what the reviewer sees, rendered from the page's structure (DOM),
 * with the target outlined. Critiqs's own interface is left out: `exclude` and
 * every other mounted Critiqs, such as a second `<Critiqs />` or one still
 * being removed, are skipped while the page is copied, so nothing on screen is
 * hidden or changed. Elements marked with `data-critiqs-mask` are covered in
 * the copy itself, wherever they are when it is made. The page keeps
 * responding while it is copied, and a
 * capture that runs past its time limit stops and fails. DOM rendering can
 * miss embedded content and drawn graphics, so failures are reported for the
 * reviewer to supply a screenshot instead.
 */
export async function captureView(
  exclude: Element,
  marker: Rect | null,
  timeoutMs = CAPTURE_TIMEOUT_MS,
): Promise<CaptureResult> {
  const render: Render = { context: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const image = await Promise.race([
      renderViewport(exclude, marker, performance.now() + timeoutMs, render),
      // The renderer can wait on media that never loads, where no check of the
      // time limit runs; stop waiting for it at the limit all the same.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(TOO_LONG)), timeoutMs);
      }),
    ]);
    if (image.size > MAX_CAPTURE_BYTES) return { status: "failed", reason: "The capture was too large to save." };
    return { status: "captured", image };
  } catch (error) {
    return { status: "failed", reason: describeFailure(error) };
  } finally {
    clearTimeout(timer);
    if (render.context !== null) destroyContext(render.context);
  }
}

/** The renderer's state for one capture, so it is removed however the capture ends. */
type Render = { context: Context | null };

async function renderViewport(exclude: Element, marker: Rect | null, deadline: number, render: Render): Promise<Blob> {
  const { scrollX, scrollY, innerWidth, innerHeight } = window;
  const scale = Math.min(window.devicePixelRatio || 1, 2);

  // The page is copied in one chain of promise callbacks, which leaves no turn
  // for input, timers, or the time limit until it ends. Check the limit at
  // every copied element and phase, and yield to the page between slices.
  const checkTime = () => {
    if (performance.now() > deadline) throw new Error(TOO_LONG);
  };
  let sliceStart = performance.now();
  const pace = async (copy?: Node) => {
    // Masked content is covered as the element is copied, so a masked element
    // that moves while the page is copied is covered where it was copied.
    if (isElement(copy) && copy.hasAttribute(MASK_ATTRIBUTE)) cover(copy);
    checkTime();
    if (performance.now() - sliceStart < SLICE_MS) return;
    await delay(0);
    sliceStart = performance.now();
    checkTime();
  };

  const styleFrame = document.createElement("iframe");
  const context = await createContext(document.documentElement, {
    scale,
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    filter: (node) => {
      if (node === exclude || node === styleFrame || isCritiqsHost(node) || isInsideMask(node)) return false;
      // The renderer replaces these source nodes without their attributes.
      // Its public clone callback cannot identify the replacement reliably:
      // fail before reading the media instead of returning an unmasked image.
      // A marked containing element still covers the whole region normally.
      if (isElement(node) && node.hasAttribute(MASK_ATTRIBUTE) && /^(canvas|video|iframe)$/.test(node.localName)) {
        throw new Error("The browser could not safely hide the private media in this page.");
      }
      return true;
    },
    features: { restoreScrollPosition: true },
    timeout: Math.max(0, deadline - performance.now()),
    includeStyleProperties: standardProperties(),
    onCloneEachNode: pace,
    onCloneNode: checkTime,
    onEmbedNode: checkTime,
    onCreateForeignObjectSvg: checkTime,
  });
  let page: HTMLImageElement;
  try {
    render.context = context;
    checkTime();
    // The renderer reads default styles from a frame it would otherwise add
    // mid-copy; once the copy yields, that frame could finish loading and
    // replace its document while being read. Add it loaded instead.
    context.sandbox = styleFrame;
    await loadStyleFrame(styleFrame, deadline);
    checkTime();
    page = await decodeSvg(await domToForeignObjectSvg(context), deadline);
    checkTime();
  } finally {
    destroyContext(context);
  }

  // Keep only the visible part of the page. `restoreScrollPosition` already
  // shifts the page by the document's scroll (and keeps nested scroll
  // containers scrolled), so its top left is the view.
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(innerWidth * scale);
  canvas.height = Math.round(innerHeight * scale);
  const drawing = canvas.getContext("2d");
  if (drawing === null) throw new Error("The browser could not create a drawing surface.");
  const drawPage = () => {
    drawing.clearRect(0, 0, canvas.width, canvas.height);
    drawing.drawImage(page, 0, 0, context.width * scale, context.height * scale);
  };
  drawPage();
  // Browsers can paint images inside the page's SVG only on a later draw, so
  // draw again once per image, as the renderer does.
  for (let index = 0; index < context.drawImageCount; index++) {
    await delay(index + 100);
    checkTime();
    drawPage();
  }

  drawing.scale(scale, scale);
  if (marker !== null) {
    drawing.strokeStyle = MARKER_COLOR;
    drawing.lineWidth = 3;
    drawing.strokeRect(marker.x - scrollX - 2, marker.y - scrollY - 2, marker.width + 4, marker.height + 4);
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("The capture could not be encoded.")) : resolve(blob)), "image/png");
  });
}

function loadStyleFrame(frame: HTMLIFrameElement, deadline: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
    frame.addEventListener("load", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    frame.width = "0";
    frame.height = "0";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position: fixed; visibility: hidden; border: 0;";
    frame.srcdoc = '<!DOCTYPE html><meta charset="UTF-8"><title></title><body>';
    document.body.appendChild(frame);
  });
}

/**
 * Loads the copied page as an image. Unlike the renderer, which draws an
 * image that failed to load as nothing, a page that can't be decoded in time
 * fails the capture instead of saving a blank one.
 */
async function decodeSvg(svg: SVGElement, deadline: number): Promise<HTMLImageElement> {
  const markup = new XMLSerializer()
    .serializeToString(svg)
    .replace(/[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF￾￿]/gu, "");
  const image = new Image();
  image.decoding = "sync";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      image.decode().catch(() => {
        throw new Error("The browser could not draw the copied page.");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          image.src = "";
          reject(new Error(TOO_LONG));
        }, Math.max(0, deadline - performance.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return image;
}

/**
 * The CSS properties copied onto each element: every standard property, but no
 * custom properties (`--name`). Computed values already have `var()` resolved,
 * and design systems define thousands of custom properties that every element
 * inherits; copying them onto each element made captures take tens of seconds.
 */
function standardProperties(): string[] {
  const style = getComputedStyle(document.documentElement);
  const names: string[] = [];
  for (let index = 0; index < style.length; index++) {
    const name = style.item(index);
    if (!name.startsWith("--")) names.push(name);
  }
  return names;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a node is inside a masked element, through shadow roots and the
 * slots that show it, so none of its text, images, or controls is copied.
 */
function isInsideMask(node: Node): boolean {
  for (let current = composedParent(node); current !== null; current = composedParent(current)) {
    if (isElement(current) && current.hasAttribute(MASK_ATTRIBUTE)) return true;
  }
  return false;
}

function composedParent(node: Node): Node | null {
  const slot = (node as Element | Text).assignedSlot;
  if (slot) return slot;
  const parent = node.parentNode;
  return parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in parent ? (parent as ShadowRoot).host : parent;
}

/**
 * Covers a masked element's copy: it keeps its box, but none of its content,
 * attributes (such as an image source or a field's value), or classes (which
 * carry generated text), and is filled with the mask color.
 */
function cover(copy: Element): void {
  copy.replaceChildren();
  for (const name of copy.getAttributeNames()) if (name !== "style") copy.removeAttribute(name);
  const style = (copy as HTMLElement | SVGElement).style;
  style.setProperty("background", MASK_COLOR, "important");
  style.setProperty("color", "transparent", "important");
  style.setProperty("-webkit-text-fill-color", "transparent", "important");
  style.setProperty("border-color", MASK_COLOR, "important");
  style.setProperty("box-shadow", "none", "important");
  style.setProperty("text-shadow", "none", "important");
  style.setProperty("outline", "none", "important");
}

function isCritiqsHost(node: Node): boolean {
  return isElement(node) && node.localName === HOST_TAG;
}

/** Nodes inside a same-origin frame belong to another window's constructors. */
function isElement(node: Node | undefined): node is Element {
  return node?.nodeType === Node.ELEMENT_NODE;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/tainted|SecurityError|cross-origin/i.test(message)) {
    return "The page shows content from another site that the browser does not allow Critiqs to capture.";
  }
  return message === "" ? "The page could not be captured." : message;
}
