import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useSyncExternalStore } from "react";

// The right-hand sidebar's width, which people set by dragging its left edge.
// One width for every panel (comments, project, mockups), remembered in this
// browser. Pins, the thread window, and mockup copies stay clear of it.

/** The width a sidebar opens at until someone resizes it. */
export const SIDEBAR_WIDTH = 360;
export const SIDEBAR_MIN = 300;
export const SIDEBAR_MAX = 720;
/** How far one arrow key press moves the edge. */
const STEP = 24;
const KEY = "critiqs:sidebar-width";

/** The strip of the page the sidebar leaves beside it, where the panel is drawn over the page. */
let pageStrip = 160;

/**
 * For a panel with a window of its own and no page beside the sidebar, such
 * as the browser extension's side panel: the sidebar may fill the window.
 */
export function sidebarFillsWindow() {
  pageStrip = 0;
}

/** The widths this window allows: the limits, never wider than leaves a strip of the page beside the sidebar, nor than the window. */
export function sidebarLimits(): { min: number; max: number } {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - pageStrip));
  return { min: Math.min(SIDEBAR_MIN, window.innerWidth), max: Math.min(max, window.innerWidth) };
}

function clamp(width: number): number {
  const { min, max } = sidebarLimits();
  return Math.round(Math.min(max, Math.max(min, width)));
}

function stored(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : SIDEBAR_WIDTH;
  } catch {
    return SIDEBAR_WIDTH;
  }
}

/** The width chosen in this page; null until read from storage, and again when another tab changes it. */
let chosen: number | null = null;
const listeners = new Set<() => void>();

/** The sidebar's width now, in pixels. */
export function sidebarWidth(): number {
  chosen ??= stored();
  return clamp(chosen);
}

export function setSidebarWidth(width: number) {
  chosen = clamp(width);
  try {
    localStorage.setItem(KEY, String(chosen));
  } catch {
    // Without storage the width lasts until the page reloads.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's choice applies here too.
  const fromStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    chosen = null;
    listener();
  };
  window.addEventListener("resize", listener);
  window.addEventListener("storage", fromStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("resize", listener);
    window.removeEventListener("storage", fromStorage);
  };
}

function subscribeWindow(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** The window's width, re-rendering when it changes, for placing things beside the sidebar. */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeWindow, () => window.innerWidth, () => 0);
}

/** The sidebar's width, re-rendering when it changes. */
export function useSidebarWidth(): number {
  return useSyncExternalStore(subscribe, sidebarWidth, () => SIDEBAR_WIDTH);
}

/**
 * The sidebar's left edge, dragged to resize it. Arrow keys move it by a step,
 * Home and End go to the limits, and a double click restores the default.
 */
export function SidebarResizer() {
  const width = useSidebarWidth();
  // The limits follow the window even when the width itself doesn't change.
  useWindowWidth();
  // A drag still under way when the edge goes away, as when the panel closes, ends with it.
  const ending = useRef<(() => void) | null>(null);
  useEffect(() => () => ending.current?.(), []);
  const { min, max } = sidebarLimits();
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    // One drag at a time, with the main button of the main pointer.
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    // A drag left over from before ends first.
    ending.current?.();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    try {
      handle.setPointerCapture(pointer);
    } catch {
      // Without capture the drag still follows the pointer while it stays over the edge.
    }
    handle.classList.add("dragging");
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointer) setSidebarWidth(window.innerWidth - next.clientX);
    };
    // Released, cancelled, or capture lost (Critiqs hidden, the window left): the drag ends.
    const end = () => {
      ending.current = null;
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("lostpointercapture", stop);
      for (const type of ["pointerup", "pointercancel"] as const) window.removeEventListener(type, stop, true);
      try {
        if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
      } catch {
        // Already released.
      }
    };
    const stop = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointer) end();
    };
    ending.current = end;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", stop);
    // Released anywhere ends it, even where capture was refused and the pointer left the edge.
    for (const type of ["pointerup", "pointercancel"] as const) window.addEventListener(type, stop, true);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "ArrowLeft" ? width + STEP : event.key === "ArrowRight" ? width - STEP : event.key === "Home" ? min : event.key === "End" ? max : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    setSidebarWidth(next);
  };
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={drag}
      onKeyDown={keys}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH)}
    />
  );
}
