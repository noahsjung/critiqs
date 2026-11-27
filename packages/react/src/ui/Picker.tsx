import { useCallback, useEffect, useId, useRef, useState } from "react";
import { describeTarget, type Rect, type Scope, type Target } from "@critiqs/core";
import { useFrameValue } from "../hooks.ts";
import type { Reviewer } from "../session.ts";
import { describeViewState } from "./format.ts";
import type { ResolvedContext } from "../host.ts";
import { EMPTY_MENTION_TEXT, MentionInput, type MentionText } from "./MentionInput.tsx";
import { InfoIcon } from "./icons.tsx";
import { useHidden } from "./hidden.ts";
import { openLayer } from "./common.tsx";

export interface PickedTarget {
  element: Element;
  target: Target;
}

/**
 * Comment mode's element selection. While active, pointer events on the
 * prototype are intercepted so selecting an element never triggers it; the
 * nearest element with a purpose ID is highlighted and picked.
 */
export function Picker({
  host,
  hint,
  onPick,
  paused,
  onOutsideClick,
  exposedRight,
}: {
  host: Element;
  hint: string | null;
  /** Where an open sidebar starts; the hint centers in the page left of it. */
  exposedRight?: number;
  onPick: (picked: PickedTarget) => void;
  /** While a composer is open: keep blocking the prototype, but do not pick. */
  paused: boolean;
  onOutsideClick?: () => void;
}) {
  const [hovered, setHovered] = useState<PickedTarget | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onOutsideRef = useRef(onOutsideClick);
  onOutsideRef.current = onOutsideClick;

  useEffect(() => {
    if (paused) setHovered(null);
    const fromCritiqs = (event: Event) => event.composedPath().includes(host);
    const pick = (event: MouseEvent): PickedTarget | null => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (element === null || element === host || element === document.documentElement || element === document.body) return null;
      const { target, element: targetElement } = describeTarget(element, document.body);
      return { element: targetElement, target };
    };
    const onMove = (event: PointerEvent) => {
      if (paused || fromCritiqs(event)) return setHovered(null);
      setHovered(pick(event));
    };
    const block = (event: Event) => {
      if (fromCritiqs(event)) return;
      event.preventDefault();
      // With a Critiqs menu or dialog open, a key may arrive from the page when
      // focus left it, such as from a button disabled while saving. It is kept
      // from the prototype but still reaches that layer's own listener, so
      // Escape closes it.
      if (event instanceof KeyboardEvent && openLayer(host.shadowRoot)) event.stopPropagation();
      else event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (fromCritiqs(event)) return;
      block(event);
      if (paused) return onOutsideRef.current?.();
      const picked = pick(event);
      if (picked !== null) onPickRef.current(picked);
    };
    // Keys go to Critiqs's own controls only; the prototype must not react while commenting.
    const blocked = [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "dblclick",
      "contextmenu",
      "submit",
      "keydown",
      "keyup",
      "keypress",
    ] as const;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== host && focused !== document.body) focused.blur();
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("click", onClick, true);
    for (const type of blocked) window.addEventListener(type, block, true);
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("click", onClick, true);
      for (const type of blocked) window.removeEventListener(type, block, true);
      document.documentElement.style.cursor = previousCursor;
    };
  }, [host, paused]);

  const rect = useElementRect(hovered?.element ?? null);
  const label = hovered?.target.purposeId ?? hovered?.target.clues.label ?? hovered?.target.clues.tagName;

  return (
    <>
      {hint !== null && (
        <div className="mode-hint passive" style={exposedRight === undefined ? undefined : { left: exposedRight / 2, maxWidth: Math.max(0, exposedRight - 24) }}>
          {hint}
        </div>
      )}
      {rect !== null && hovered !== null && (
        <>
          <div className="target-box passive" style={boxStyle(rect)} />
          {label && (
            <div className="target-label passive" style={{ left: rect.x, top: Math.max(16, rect.y) }}>
              {label}
            </div>
          )}
        </>
      )}
    </>
  );
}

function boxStyle(rect: Rect) {
  return { left: rect.x - 2, top: rect.y - 2, width: rect.width + 4, height: rect.height + 4 };
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** Follows an element's position on screen as the page scrolls or changes. */
export function useElementRect(element: Element | null): Rect | null {
  const read = useCallback(() => {
    if (element === null || !element.isConnected) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return width === 0 && height === 0 ? null : { x, y, width, height };
  }, [element]);
  return useFrameValue(read, element !== null, sameRect);
}

export interface NewComment {
  body: MentionText;
  tags: string[];
  scope: Scope;
}

/** Record-specific by default, so feedback is never shown on a different record (F7). */
export function emptyComment(picked: Pick<PickedTarget, "target">): NewComment {
  return { body: EMPTY_MENTION_TEXT, tags: [], scope: picked.target.recordKey === null ? "shared" : "record" };
}

/** The popover for a new thread, beside the selected element. */
export function Composer({
  dismissHelpRef,
  picked,
  comment,
  onChange,
  context,
  projectId,
  reviewer,
  signInOnPost = false,
  saving,
  error,
  onSignIn,
  onSubmit,
  onCancel,
  rightEdge,
}: {
  /** Lets the global Escape handler dismiss hovered help without moving focus. */
  dismissHelpRef: { current: (() => void) | null };
  /** The element is null where the panel isn't drawn over the page; the popover then waits at the top. */
  picked: { element: Element | null; target: Target };
  comment: NewComment;
  onChange: (comment: NewComment) => void;
  context: ResolvedContext;
  /** For mention suggestions; null offers none. */
  projectId: string | null;
  reviewer: Reviewer | null;
  /** Write first, sign in on posting: a review link's reviewer, who is signed out until then. */
  signInOnPost?: boolean;
  saving: boolean;
  error: string | null;
  onSignIn: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** Right edge of the free area, left of an open sidebar. */
  rightEdge: number;
}) {
  const rect = useElementRect(picked.element);
  const { body, scope } = comment;
  const recordKey = picked.target.recordKey;
  const ref = useRef<HTMLFormElement>(null);
  const helpAnchor = useRef<HTMLSpanElement>(null);
  const helpPanel = useRef<HTMLDivElement>(null);
  const helpId = useId();
  // The choice whose help is open.
  const [help, setHelp] = useState<Scope | null>(null);
  const helpOpen = help !== null;
  const closeHelp = (choice: Scope) => setHelp((open) => (open === choice ? null : open));
  const hidden = useHidden();
  const setBody = (value: MentionText) => onChange({ ...comment, body: value });
  const setScope = (value: Scope) => onChange({ ...comment, scope: value });

  useEffect(() => {
    const dismiss = helpOpen ? () => setHelp(null) : null;
    dismissHelpRef.current = dismiss;
    return () => { if (dismissHelpRef.current === dismiss) dismissHelpRef.current = null; };
  }, [helpOpen, dismissHelpRef]);

  const helpPosition = useFrameValue(() => {
    if (!helpOpen || helpAnchor.current === null || helpPanel.current === null) return null;
    const anchor = helpAnchor.current.getBoundingClientRect();
    const panel = helpPanel.current;
    const below = Math.max(0, window.innerHeight - anchor.bottom - 8);
    const above = Math.max(0, anchor.top - 8);
    const wanted = panel.scrollHeight + 2;
    const useBelow = below >= wanted || below >= above;
    const maxHeight = useBelow ? below : above;
    return {
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - panel.offsetWidth - 8)),
      top: useBelow ? anchor.bottom : anchor.top - Math.min(wanted, maxHeight),
      maxHeight,
    };
  }, helpOpen && !hidden, sameHelpPosition);

  useEffect(() => {
    if (!helpOpen || hidden) return;
    const closeOutside = (event: PointerEvent) => {
      if (helpAnchor.current !== null && !event.composedPath().includes(helpAnchor.current)) setHelp(null);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    return () => window.removeEventListener("pointerdown", closeOutside, true);
  }, [helpOpen, hidden]);

  const submit = () => {
    if (body.text.trim() !== "" && !saving) onSubmit();
  };

  const viewState = describeViewState(context.viewState);
  const position = popoverPosition(rect, ref.current?.offsetHeight ?? 260, rightEdge, window.innerHeight);

  return (
    <>
      {rect !== null && <div className="target-box passive" style={boxStyle(rect)} />}
      <form
        ref={ref}
        className="popover"
        style={position}
        aria-label="New comment"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
      >
        <div className="context-line" title="Saved with the comment">
          {[context.screen, viewState, context.persona && `viewing as ${context.persona}`].filter(Boolean).join(" · ")}
        </div>
        {reviewer === null && !signInOnPost ? (
          <>
            <p className="note">Sign in to comment. Your selection stays here.</p>
            <div className="row end">
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={onSignIn}>
                Sign in
              </button>
            </div>
          </>
        ) : (
          <>
            <MentionInput
              projectId={projectId}
              className="field"
              placeholder="Add a comment. Type @ to mention someone, # to tag."
              aria-label="Comment"
              value={body}
              autoFocus
              onChange={setBody}
            />
            {recordKey !== null && (
              <div className="scope-choice" role="group" aria-label="Comment placement">
                {SCOPE_CHOICES.map((choice) => (
                  <div key={choice.scope} className={scope === choice.scope ? "scope-option selected" : "scope-option"}>
                    <button type="button" aria-pressed={scope === choice.scope} onClick={() => setScope(choice.scope)}>
                      {choice.label}
                    </button>
                    {/* Beside the choice, not inside it: opening help never changes the choice. */}
                    <span
                      ref={help === choice.scope ? helpAnchor : undefined}
                      className="scope-info"
                      onPointerOver={(event) => {
                        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHelp(choice.scope);
                      }}
                      onPointerOut={(event) => {
                        const anchor = event.currentTarget;
                        if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
                        const root = anchor.getRootNode();
                        const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
                        if (active === null || !anchor.contains(active)) closeHelp(choice.scope);
                      }}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) closeHelp(choice.scope);
                      }}
                    >
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={choice.about}
                        aria-expanded={help === choice.scope}
                        aria-describedby={help === choice.scope ? helpId : undefined}
                        onFocus={() => setHelp(choice.scope)}
                        onClick={() => setHelp(choice.scope)}
                      >
                        <InfoIcon />
                      </button>
                      {help === choice.scope && (
                        <div ref={helpPanel} id={helpId} className="scope-help" role="tooltip"
                          style={helpPosition === null ? { visibility: "hidden" } : helpPosition}>
                          {choice.help}
                        </div>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {signInOnPost && <p className="note">You'll sign in with your email when you post. Your comment stays here.</p>}
            {error !== null && <div className="error">{error}</div>}
            <div className="row end">
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={body.text.trim() === "" || saving}>
                {saving ? "Saving…" : "Comment"}
              </button>
            </div>
          </>
        )}
      </form>
    </>
  );
}

/** The two placements, each with help about the kind of feedback it suits. */
const SCOPE_CHOICES: { scope: Scope; label: string; about: string; help: string }[] = [
  {
    scope: "record",
    label: "This component",
    about: "About commenting on this component",
    help: "Feedback for this component here only, such as this button’s spacing or placement.",
  },
  {
    scope: "shared",
    label: "Matching components",
    about: "About commenting on matching components",
    help:
      "One shared discussion for this same component wherever your app shows it for other records, such as this button’s label everywhere it appears. " +
      "Your app decides which components are the same; who can read the comment doesn’t change.",
  },
];

type HelpPosition = { left: number; top: number; maxHeight: number } | null;
const sameHelpPosition = (a: HelpPosition, b: HelpPosition) => a === b ||
  (a !== null && b !== null && a.left === b.left && a.top === b.top && a.maxHeight === b.maxHeight);

/** Height reserved at the bottom of the window for the toolbar. */
const TOOLBAR_BAND = 72;
const POPOVER_WIDTH = 320;
const GAP = 12;
const EDGE = 8;

/** The free part of the window a floating panel may use. */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Places the popover beside the target when there is room; otherwise below it,
 * or above it when below would run into the toolbar's band. It never covers
 * the top edge, and covers the target only when the window is too small.
 */
export function popoverPosition(
  rect: Rect | null,
  height: number,
  rightEdge: number,
  viewportHeight: number,
): { left: number; top: number } {
  return placeBeside(rect, { width: POPOVER_WIDTH, height }, { left: 0, top: 0, right: rightEdge, bottom: viewportHeight - TOOLBAR_BAND });
}

/**
 * Places a panel beside a target within the free bounds: to its right when
 * there is room, then to its left, then below or above it in its column.
 * Without a target it is centered horizontally, a third of the way down.
 */
export function placeBeside(
  rect: Rect | null,
  size: { width: number; height: number },
  bounds: Bounds,
): { left: number; top: number } {
  const { width, height } = size;
  const minLeft = bounds.left + EDGE;
  const maxLeft = bounds.right - width - EDGE;
  const minTop = bounds.top + EDGE;
  const clampTop = (top: number) => Math.max(minTop, Math.min(top, bounds.bottom - height));
  if (rect === null) {
    return { left: Math.max(minLeft, (bounds.left + bounds.right) / 2 - width / 2), top: clampTop(bounds.top + (bounds.bottom - bounds.top) / 3) };
  }

  // Beside the target only where the panel fits horizontally within the bounds.
  const right = rect.x + rect.width + GAP;
  const left = right <= maxLeft ? right : rect.x - width - GAP;
  if (left >= minLeft && left <= maxLeft) return { left, top: clampTop(rect.y) };

  // No room beside the target: share its column, above or below it.
  const column = Math.max(minLeft, Math.min(rect.x, maxLeft));
  const below = rect.y + rect.height + GAP;
  const above = rect.y - GAP - height;
  // Each placement must fit entirely in the bounds; a target scrolled off-screen falls through.
  if (below >= minTop && below + height <= bounds.bottom) return { left: column, top: below };
  if (above >= minTop && above + height <= bounds.bottom) return { left: column, top: above };
  return { left: column, top: clampTop(below) };
}
