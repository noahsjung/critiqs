import { useCallback, useEffect, useState } from "react";
import type { Rect, TargetLocation, TicketBadge } from "@critiqs/core";
import { locateShown } from "../model.ts";
import { useFrameValue } from "../hooks.ts";
import { initials } from "./format.ts";
import { TicketIcon } from "./icons.tsx";
import { ticketText, trackerLabel } from "./Tickets.tsx";

export interface PinTarget {
  threadId: string;
  elements: Element[];
  authorName: string;
  unread: boolean;
  resolved: boolean;
  /** Linked tickets, shown as a small mark with their keys and status in the pin's name. */
  tickets?: TicketBadge[];
}

const PIN_SPACING = 22;

interface PlacedPin {
  key: string;
  threadId: string;
  /** The occurrence this pin marks; a shared thread can have several. */
  element: Element;
  x: number;
  y: number;
}

/**
 * Pins beside targets that can currently be located. They follow layout
 * changes and scrolling. Seeing a pin does not mark its thread read.
 */
export function Pins({
  targets,
  selectedThreadId,
  selectedElement,
  exposedRight,
  onSelect,
}: {
  targets: PinTarget[];
  /** The right edge of the page not covered by Critiqs, such as the open sidebar; pins stay left of it. */
  exposedRight: number;
  selectedThreadId: string | null;
  /** The occurrence whose thread window is open, among a shared thread's pins. */
  selectedElement: Element | null;
  onSelect: (threadId: string, element: Element) => void;
}) {
  const read = useCallback(() => {
    const placed: PlacedPin[] = [];
    // Several threads on one element are fanned out so each pin stays clickable.
    const stacked = new Map<Element, number>();
    for (const target of targets) {
      target.elements.forEach((element, index) => {
        const rect = visibleRect(element, exposedRight);
        if (rect === null) return;
        const position = stacked.get(element) ?? 0;
        stacked.set(element, position + 1);
        // Leftwards along the top edge, wrapping into further rows before leaving the window.
        const perRow = Math.max(1, Math.floor((rect.right - 16) / PIN_SPACING) + 1);
        const x = rect.right - (position % perRow) * PIN_SPACING;
        // Rows go downward while they fit, then continue upward above the target.
        const row = Math.floor(position / perRow);
        const rowsBelow = Math.max(0, Math.floor((window.innerHeight - 16 - rect.top) / PIN_SPACING));
        const y = row <= rowsBelow ? rect.top + row * PIN_SPACING : rect.top - (row - rowsBelow) * PIN_SPACING;
        placed.push({ key: `${target.threadId}:${index}`, threadId: target.threadId, element, x, y });
      });
    }
    return placed;
  }, [targets, exposedRight]);
  const pins = useFrameValue(read, targets.length > 0, samePins);
  const byThread = new Map(targets.map((target) => [target.threadId, target]));

  return (
    <>
      {pins.map((pin) => {
        const target = byThread.get(pin.threadId);
        if (target === undefined) return null;
        const open = pin.threadId === selectedThreadId && pin.element === selectedElement;
        const classes = ["pin", target.unread && "unread", target.resolved && "resolved", open && "selected"];
        const tickets = target.tickets ?? [];
        const ticketNames = tickets.map((ticket) => `${trackerLabel(ticket.tracker)} ${ticketText(ticket)}`).join(", ");
        const name = `comment by ${target.authorName}${target.unread ? ", unread" : ""}${ticketNames === "" ? "" : `, ticket ${ticketNames}`}`;
        return (
          <button
            key={pin.key}
            type="button"
            className={classes.filter(Boolean).join(" ")}
            style={{ left: Math.min(pin.x, exposedRight - 16), top: Math.max(pin.y, 16) }}
            title={`Comment by ${target.authorName}${target.unread ? " (unread)" : ""}${ticketNames === "" ? "" : `\n${tickets.map(ticketText).join("\n")}`}`}
            aria-label={`Open ${name}`}
            aria-expanded={open}
            onClick={() => onSelect(pin.threadId, pin.element)}
          >
            {initials(target.authorName)}
            {tickets.length > 0 && (
              <span className="pin-ticket" aria-hidden="true">
                <TicketIcon size={9} />
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

/**
 * The part of an element that is actually visible: inside the window, left of
 * `right` (such as the edge of Critiqs's open sidebar), and not clipped by a
 * scrolling or overflow-hidden container. Null when hidden.
 */
export function visibleRect(element: Element, right = window.innerWidth): DOMRect | null {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const exposedRight = right;
  let { left, top, bottom } = rect;
  right = rect.right;
  for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!CLIPPING.test(style.overflowX) && !CLIPPING.test(style.overflowY)) continue;
    const clip = parent.getBoundingClientRect();
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, window.innerWidth, exposedRight);
  bottom = Math.min(bottom, window.innerHeight);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Overflow values that clip an element's content. */
const CLIPPING = /^(hidden|clip|scroll|auto)$/;

function samePins(a: PlacedPin[], b: PlacedPin[]) {
  return (
    a.length === b.length &&
    a.every((pin, i) => pin.key === b[i]!.key && pin.element === b[i]!.element && pin.x === b[i]!.x && pin.y === b[i]!.y)
  );
}

/**
 * Briefly outlines a thread's target after its view is restored. The target
 * is located again every frame, because the prototype may re-render it.
 */
export function Highlight({ location, onDone }: { location: TargetLocation; onDone: () => void }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDone();
    }, 2600);
    return () => clearTimeout(timer);
  }, [location, onDone]);
  const read = useCallback(() => {
    const located = locateShown(location);
    if (located.status !== "found") return [];
    return located.elements.flatMap((element) => {
      const rect = visibleRect(element);
      return rect === null ? [] : [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    });
  }, [location]);
  const rects = useFrameValue(read, visible, sameRects);
  if (!visible) return null;
  return (
    <>
      {rects.map((rect, index) => (
        <div
          key={index}
          className="highlight passive"
          style={{ left: rect.x - 4, top: rect.y - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ))}
    </>
  );
}

function sameRects(a: Rect[], b: Rect[]) {
  return (
    a.length === b.length &&
    a.every((rect, i) => rect.x === b[i]!.x && rect.y === b[i]!.y && rect.width === b[i]!.width && rect.height === b[i]!.height)
  );
}
