import { MOCKUP_NODE_ATTRIBUTE, type MockupEdit, type Rect } from "@critiqs/core";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useFrameValue } from "../../hooks.ts";
import { renderSnapshot } from "../../mockup/render.ts";
import type { ElementChoice } from "../../mockup/state.ts";
import { initials } from "../format.ts";

/** What the canvas shows: a copy's HTML with a version's changes. `key` names it, so the same copy and version isn't shown twice. */
export interface CanvasContent {
  key: string;
  html: string;
  edits: readonly MockupEdit[];
  /** Where to scroll the first time this copy is shown. */
  scrollY: number;
  /** The copy shown, so a new version keeps its scroll position and a new copy starts at its own. */
  copyKey: string;
}

export interface CanvasPin {
  threadId: string;
  node: number;
  authorName: string;
  unread: boolean;
  resolved: boolean;
}

/** Reads the copy as shown, for describing it to Critiqs AI. */
export interface CanvasHandle {
  /** The document showing `key`, once it has finished showing; null otherwise. */
  documentFor(key: string): Document | null;
}

/**
 * The page copy, covering the whole window beneath Critiqs's panels so the
 * prototype can't be used. Nothing in the copy runs or navigates: the frame
 * has no scripts, and clicks and form submissions are stopped. Hovering
 * outlines an element and clicking one chooses it. A new version is drawn in
 * a second frame and swapped in once ready, so the copy never flashes blank.
 */
export function Canvas({
  content,
  hidden,
  choosing,
  onChoose,
  pins,
  selectedThreadId,
  onPin,
  exposedRight,
  working,
  handle,
}: {
  content: CanvasContent | null;
  /** The Original control is held: the live prototype shows through, still not usable. */
  hidden: boolean;
  /** Hovering and clicking choose elements; off while a composer is open. */
  choosing: boolean;
  onChoose: (choice: ElementChoice) => void;
  pins: CanvasPin[];
  selectedThreadId: string | null;
  onPin: (threadId: string) => void;
  /** The right edge not covered by the panel; outlines and pins stay left of it. */
  exposedRight: number;
  /** Critiqs AI is changing this copy: a light sweeps over it until the new version arrives. */
  working: boolean;
  handle: Ref<CanvasHandle>;
}) {
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)] as const;
  const [front, setFront] = useState<{ index: 0 | 1; key: string | null }>({ index: 0, key: null });
  const frontRef = useRef(front);
  frontRef.current = front;
  const [hovered, setHovered] = useState<Rect | null>(null);
  const choosingRef = useRef({ choosing, onChoose });
  choosingRef.current = { choosing, onChoose };

  const frontDocument = useCallback(() => frames[frontRef.current.index].current?.contentDocument ?? null, []);

  useImperativeHandle(
    handle,
    () => ({ documentFor: (key) => (frontRef.current.key === key ? frontDocument() : null) }),
    [frontDocument],
  );

  // Shows new content in the hidden frame, then swaps it to the front.
  const shownCopy = useRef<string | null>(null);
  useEffect(() => {
    if (content === null) return;
    let cancelled = false;
    const back = frontRef.current.key === null ? frontRef.current.index : ((1 - frontRef.current.index) as 0 | 1);
    const frame = frames[back].current;
    if (frame === null) return;
    const sameCopy = shownCopy.current === content.copyKey;
    const scrollY = sameCopy ? (frontDocument()?.defaultView?.scrollY ?? content.scrollY) : content.scrollY;
    void renderSnapshot(frame, content.html, content.edits, scrollY).then(() => {
      if (cancelled) return;
      const doc = frame.contentDocument;
      if (doc !== null) guard(doc, (element) => choose(element, frame), setHovered);
      shownCopy.current = content.copyKey;
      setHovered(null);
      setFront({ index: back, key: content.key });
    });
    return () => {
      cancelled = true;
    };
  }, [content?.key]);

  /** Chooses an element of the copy, unless choosing is off. */
  const choose = (element: Element, frame: HTMLIFrameElement) => {
    const { choosing, onChoose } = choosingRef.current;
    if (!choosing) return;
    const node = Number(element.getAttribute(MOCKUP_NODE_ATTRIBUTE));
    onChoose({ node, label: labelOf(element), rect: windowRect(element, frame) });
  };

  // Pins follow the copy's layout and scrolling; a thread whose element is gone has none.
  const readPins = useCallback(() => {
    const doc = frontDocument();
    const frame = frames[frontRef.current.index].current;
    if (doc === null || frame === null || hidden) return [];
    const placed: { threadId: string; x: number; y: number }[] = [];
    const stacked = new Map<number, number>();
    for (const pin of pins) {
      const element = doc.querySelector(`[${MOCKUP_NODE_ATTRIBUTE}="${pin.node}"]`);
      if (element === null) continue;
      const rect = windowRect(element, frame);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const position = stacked.get(pin.node) ?? 0;
      stacked.set(pin.node, position + 1);
      const x = Math.min(rect.x + rect.width, exposedRight - 16) - position * 22;
      if (rect.y + rect.height < 0 || rect.y > window.innerHeight || x < 0) continue;
      placed.push({ threadId: pin.threadId, x, y: Math.max(rect.y, 16) });
    }
    return placed;
  }, [pins, hidden, exposedRight, frontDocument]);
  const placed = useFrameValue(readPins, pins.length > 0 && front.key !== null, samePins);

  const shownHover = choosing && !hidden ? hovered : null;
  return (
    <div className={`mockup-canvas${hidden ? " original" : ""}`} data-testid="mockup-canvas">
      {frames.map((ref, index) => (
        <iframe
          key={index}
          ref={ref}
          title={index === front.index ? "Page copy" : "Next page copy"}
          sandbox="allow-same-origin"
          aria-hidden={index !== front.index || undefined}
          className={index === front.index && front.key !== null ? "shown" : undefined}
          tabIndex={index === front.index ? 0 : -1}
        />
      ))}
      {working && !hidden && front.key !== null && (
        <div className="ai-scan" style={{ width: exposedRight }} aria-hidden="true">
          <div className="ai-scan-chip">
            <span className="spinner" />
            Critiqs AI is editing this copy
          </div>
        </div>
      )}
      {shownHover !== null && shownHover.x < exposedRight && (
        <div
          className="target-box"
          style={{ left: shownHover.x, top: shownHover.y, width: Math.min(shownHover.width, exposedRight - shownHover.x), height: shownHover.height }}
        />
      )}
      {!hidden &&
        placed.map(({ threadId, x, y }) => {
          // Placed as of the last frame: a pin whose thread has just gone waits for the next one.
          const pin = pins.find((entry) => entry.threadId === threadId);
          if (pin === undefined) return null;
          const classes = ["pin", pin.unread && "unread", pin.resolved && "resolved", threadId === selectedThreadId && "selected"].filter(Boolean).join(" ");
          return (
            <button
              key={threadId}
              type="button"
              className={classes}
              style={{ left: x, top: y }}
              aria-label={`Mockup thread by ${pin.authorName}`}
              title={pin.authorName}
              onClick={() => onPin(threadId)}
            >
              {initials(pin.authorName)}
            </button>
          );
        })}
    </div>
  );
}

function samePins(a: { threadId: string; x: number; y: number }[], b: { threadId: string; x: number; y: number }[]): boolean {
  return a.length === b.length && a.every((pin, index) => pin.threadId === b[index]!.threadId && pin.x === b[index]!.x && pin.y === b[index]!.y);
}

/**
 * Keeps the copy inert and reports what the pointer is over. Listeners run in
 * Critiqs's own window, since the frame runs no scripts. Keys pressed while
 * the copy has focus are passed to Critiqs's window, so shortcuts still work.
 */
function guard(doc: Document, onChoose: (element: Element) => void, onHover: (rect: Rect | null) => void) {
  const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // Pressing the pointer would focus the copy's fields, which then take keys meant for Critiqs.
  for (const type of ["mousedown", "submit", "auxclick", "dblclick", "contextmenu", "dragstart"]) doc.addEventListener(type, stop, true);
  doc.addEventListener(
    "click",
    (event) => {
      stop(event);
      const element = chosenElement(event.target);
      if (element !== null) onChoose(element);
    },
    true,
  );
  doc.addEventListener("mousemove", (event) => {
    const element = chosenElement(event.target);
    onHover(element === null || frame === null ? null : windowRect(element, frame));
  });
  doc.addEventListener("mouseleave", () => onHover(null));
  doc.defaultView?.addEventListener("scroll", () => onHover(null), { passive: true });
  for (const type of ["keydown", "keyup"] as const) {
    doc.addEventListener(type, (event) => {
      // Typing into the copy's fields does nothing, since nothing in it runs.
      const forwarded = new KeyboardEvent(type, {
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true,
      });
      if (!window.dispatchEvent(forwarded)) event.preventDefault();
    });
  }
}

/** The numbered element an event is about; the page's body and root count as nothing chosen. */
function chosenElement(target: EventTarget | null): Element | null {
  const element = target instanceof Element || (target !== null && (target as Node).nodeType === 1) ? (target as Element) : null;
  const numbered = element?.closest(`[${MOCKUP_NODE_ATTRIBUTE}]`) ?? null;
  if (numbered === null || numbered.localName === "body") return null;
  return numbered;
}

/** An element of the copy's box in Critiqs's window. */
function windowRect(element: Element, frame: HTMLIFrameElement): Rect {
  const inner = element.getBoundingClientRect();
  const outer = frame.getBoundingClientRect();
  return { x: inner.x + outer.x, y: inner.y + outer.y, width: inner.width, height: inner.height };
}

/** How a composer names an element: its tag and a few words of its label or text. */
export function labelOf(element: Element): string {
  const text = (element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  const words = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return words === "" ? element.localName : `${element.localName} "${words}"`;
}
