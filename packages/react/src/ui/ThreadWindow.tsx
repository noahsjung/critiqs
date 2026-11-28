import { type Rect, recordKeyOf } from "@critiqs/core";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useFrameValue } from "../hooks.ts";
import { useCritiqsRoot } from "../root.ts";
import { type Bounds, placeBeside } from "./Picker.tsx";
import { useHidden } from "./hidden.ts";
import { visibleRect } from "./Pins.tsx";
import { SIDEBAR_WIDTH, sidebarWidth } from "./sidebar-width.tsx";

/** The sidebar's default width; it can be resized (sidebar-width.tsx). */
export { SIDEBAR_WIDTH };
/** Matches `.thread-window` in styles.ts. */
const WINDOW_WIDTH = 340;
/** Below this window width, such as on phones, the thread is always a panel along the bottom. */
const NARROW_WIDTH = 640;
const EDGE = 8;
/** A panel narrower than this covers the sidebar too, rather than sitting beside it. */
const MIN_PANEL_WIDTH = 280;
/** Half a pin: pins sit on the target's top-right corner. */
const PIN_REACH = 13;

export interface Layout {
  /** The visible part of the target, or null when it can't be shown. */
  anchor: Rect | null;
  /** The pin that opened the window, when shown. */
  pin: Rect | null;
  toolbar: Rect | null;
  width: number;
  height: number;
  /** Space the on-screen keyboard takes at the bottom of the window. */
  keyboard: number;
  /** The sidebar's width when open; the default width when left out. */
  sidebar?: number;
}

/**
 * A thread's discussion in a small window beside its pin, as in Figma. When
 * the target can't be shown, the window sits beside the sidebar instead; where
 * there is no room beside the sidebar it is a panel along the bottom. It follows the target as the
 * page scrolls, keeps clear of the sidebar and toolbar, and closes on Escape
 * or a click in the prototype. Clicks in Critiqs's own interface keep it open.
 */
export function ThreadWindow({
  anchor,
  sidebarOpen,
  host,
  selectionId,
  returnFocus,
  onClose,
  children,
}: {
  /** The element whose pin opened the thread; null or hidden docks the window. */
  anchor: Element | null;
  sidebarOpen: boolean;
  host: HTMLElement;
  /** Changes each time the thread is opened, including from another of its pins. */
  selectionId: number;
  /** Where focus goes when the window closes, such as the pin or list entry that opened it. */
  returnFocus: HTMLElement | null;
  onClose: () => void;
  /** Renders the thread; `targetShown` is false when the target can't be shown beside it. */
  children: (targetShown: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  const { shadow } = useCritiqsRoot();

  const read = useCallback(
    (): Layout => ({
      // The target counts only where the open sidebar doesn't cover it.
      anchor: anchor === null ? null : visibleRect(anchor, sidebarOpen ? window.innerWidth - sidebarWidth() : window.innerWidth),
      pin: shownRect(shadow?.querySelector('.pin[aria-expanded="true"]') ?? null),
      toolbar: shadow?.querySelector(".toolbar")?.getBoundingClientRect() ?? null,
      width: window.innerWidth,
      height: window.innerHeight,
      keyboard: keyboardInset(),
      sidebar: sidebarWidth(),
    }),
    [anchor, shadow, sidebarOpen],
  );
  const layout = useFrameValue(read, true, sameLayout);

  // The window's own height decides where it fits; measure it as content changes.
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Escape and clicks in the prototype close the window. Menus and dialogs
  // inside it handle their own Escape first and stop it.
  const close = useRef(onClose);
  close.current = onClose;
  // While Critiqs is hidden, clicks on the page belong to it and keep the window for later.
  const hidden = useHidden();
  useEffect(() => {
    if (hidden) return;
    const onPointer = (event: PointerEvent) => {
      if (!event.composedPath().includes(host)) close.current();
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [host, hidden]);

  // Take focus each time the thread is opened, without remounting it, so a reply
  // in progress keeps its state. Closing gives focus back to the latest opener,
  // unless the reviewer moved on.
  const back = useRef(returnFocus);
  useEffect(() => {
    back.current = returnFocus;
    ref.current?.focus({ preventScroll: true });
  }, [selectionId]);
  useEffect(() => {
    const element = ref.current;
    return () => {
      const active = shadow?.activeElement ?? null;
      const focusLost = active === null || element?.contains(active) === true || !active.isConnected;
      if (focusLost && back.current?.isConnected) back.current.focus({ preventScroll: true });
    };
  }, [shadow]);

  const { mode, style } = windowLayout(layout, sidebarOpen, height);

  return (
    <section
      ref={ref}
      className={`thread-window${mode === "beside" ? "" : ` ${mode}`}`}
      style={style}
      aria-label="Comment thread"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.stopPropagation();
        onClose();
      }}
    >
      {children(layout.anchor !== null)}
    </section>
  );
}

/**
 * Where the thread window goes: beside its pin; beside the sidebar when the
 * target can't be shown; or, when the free area is too narrow for it, as a
 * panel along the bottom, above the toolbar and the on-screen keyboard.
 */
export function windowLayout(
  layout: Layout,
  sidebarOpen: boolean,
  windowHeight: number,
): { mode: "beside" | "docked" | "panel"; style: CSSProperties } {
  const bounds = freeBounds(layout, sidebarOpen);
  const freeWidth = bounds.right - bounds.left;
  if (layout.width < NARROW_WIDTH || freeWidth < WINDOW_WIDTH + 2 * EDGE) {
    // Beside an open sidebar when there is room for a usable panel; otherwise over it.
    const right = freeWidth >= MIN_PANEL_WIDTH ? layout.width - bounds.right : 0;
    const bottom = Math.max(layout.keyboard, layout.height - bounds.bottom);
    const maxHeight = Math.round((layout.height - bottom - bounds.top) * 0.75);
    return { mode: "panel", style: { left: 0, right, bottom, maxHeight } };
  }
  const maxHeight = Math.max(160, bounds.bottom - bounds.top - 2 * EDGE);
  if (layout.anchor === null) {
    return { mode: "docked", style: { left: bounds.right - WINDOW_WIDTH - EDGE, top: bounds.top + EDGE, maxHeight } };
  }
  // Beside the pin that opened it, never covering it. Until the pin is placed, its
  // spot on the target's top-right corner stands in.
  const { x, y, width } = layout.anchor;
  const pin = layout.pin ?? { x: x + width - PIN_REACH, y: y - PIN_REACH, width: 2 * PIN_REACH, height: 2 * PIN_REACH };
  const size = { width: WINDOW_WIDTH, height: Math.min(windowHeight, maxHeight) };
  return { mode: "beside", style: { ...placeBeside(pin, size, bounds), maxHeight } };
}

/**
 * The occurrence a thread window should stay beside, after the prototype
 * re-renders: the chosen element while it still matches, else the match on the
 * same record. When that record is no longer shown, there is none, so the
 * window docks rather than moving to another record.
 */
export function followOccurrence(
  chosen: { element: Element; recordKey: string | null } | null,
  elements: Element[],
): Element | null {
  if (chosen === null) return elements[0] ?? null;
  if (elements.includes(chosen.element)) return chosen.element;
  return elements.find((element) => recordKeyOf(element) === chosen.recordKey) ?? null;
}

/** A band at the top of the window that thread windows stay below, such as a review link's bar; none when installed. */
let topBand = 0;

/** Keeps thread windows below the top `pixels` of the window, where the page around the panel has its own bar. */
export function keepThreadWindowsBelow(pixels: number) {
  topBand = Math.max(0, pixels);
}

/**
 * The part of the window the thread window may use: left of an open sidebar,
 * below a band the page keeps for itself, and clear of the toolbar at the top or bottom.
 */
export function freeBounds(layout: Pick<Layout, "toolbar" | "width" | "height" | "sidebar">, sidebarOpen: boolean): Bounds {
  const bounds = { left: 0, top: topBand, right: sidebarOpen ? layout.width - (layout.sidebar ?? SIDEBAR_WIDTH) : layout.width, bottom: layout.height };
  const bar = layout.toolbar;
  if (bar !== null && bar.width > 0) {
    if (bar.y + bar.height / 2 > layout.height / 2) bounds.bottom = Math.min(bounds.bottom, bar.y - EDGE);
    else bounds.top = Math.max(bounds.top, bar.y + bar.height + EDGE);
  }
  return bounds;
}

function shownRect(element: Element | null): Rect | null {
  const rect = element?.getBoundingClientRect();
  return rect === undefined || (rect.width === 0 && rect.height === 0) ? null : rect;
}

function keyboardInset(): number {
  const viewport = window.visualViewport;
  if (viewport == null) return 0;
  return Math.max(0, Math.round(window.innerHeight - viewport.offsetTop - viewport.height));
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

function sameLayout(a: Layout, b: Layout) {
  return (
    sameRect(a.anchor, b.anchor) &&
    sameRect(a.pin, b.pin) &&
    sameRect(a.toolbar, b.toolbar) &&
    a.width === b.width &&
    a.height === b.height &&
    a.keyboard === b.keyboard &&
    a.sidebar === b.sidebar
  );
}
