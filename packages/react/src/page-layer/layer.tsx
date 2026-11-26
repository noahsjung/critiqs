import {
  type ElementRef,
  type Located,
  type LocateResult,
  type Occurrence,
  PAGE_PROTOCOL,
  type PageContext,
  type PageDisplay,
  type PageHandlers,
  type PageLayerEndpoint,
  pageLayerEndpoint,
  type PageState,
  type PageTransport,
  type Rect,
  recordKeyOf,
  removeLink,
  type RevealResult,
  type TargetLocation,
  type ViewState,
  waitForTarget,
} from "@critiqs/core";
import { useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { captureView } from "../capture.ts";
import { hasMasks, markSuppliedCapture } from "../capture-supplied.ts";
import type { CritiqsProps, HostContext } from "../host.ts";
import { readContext } from "../host.ts";
import { freezePage, pageRecordKey } from "../mockup/freeze.ts";
import { isShown, locateShown } from "../model.ts";
import { waitForViewMotion } from "../motion.ts";
import { Highlight, Pins, type PinTarget } from "../ui/Pins.tsx";
import { type PickedTarget, Picker, useElementRect } from "../ui/Picker.tsx";
import { notRestoredReason, RESTORE_TIMEOUT_MS, sameViewState, wrongViewReason } from "./view.ts";

/** The host app's functions the page layer calls. Changing them is a page-side setting, never a message. */
export interface PageHost {
  getContext?: (() => HostContext) | undefined;
  restoreContext?: CritiqsProps["restoreContext"];
}

/** A running page layer, as the page side sees it. */
export interface PageLayer {
  /** Replaces the host's functions; the panel hears the context they report. */
  setHost(host: PageHost): void;
  /** The page as the panel would see it now. */
  state(): PageState;
  /** The element a handle stands for, while it exists; for a panel in the same document only. */
  element(ref: ElementRef): Element | null;
  /** Stops answering, removes what it drew, and stops watching the page. */
  destroy(): void;
}

const NO_DISPLAY: PageDisplay = {
  hidden: false,
  exposedRight: null,
  watch: [],
  pins: [],
  selected: null,
  highlight: null,
  picking: null,
  picked: null,
};

/**
 * Starts the page layer on this page: it watches the page, draws pins,
 * highlights, and Comment mode's selection into `container` (a `.layer`
 * inside a Critiqs shadow root), and answers the panel over `transport`.
 * `host` is the Critiqs element on the page; its contents are never picked,
 * captured, or copied.
 */
export function createPageLayer({
  transport,
  channel,
  host,
  container,
  pageHost = {},
}: {
  transport: PageTransport;
  channel: string;
  host: HTMLElement;
  container: HTMLElement;
  pageHost?: PageHost;
}): PageLayer {
  let current = pageHost;
  /** Names this page layer for the panel; a new document gets a new one. */
  const documentId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  /** The view when the pins were hidden for a screenshot from outside the page, and how many page changes there had been. */
  let shot: { view: ViewShot; changes: number } | null = null;
  /** Counts every change to the page as it happens, including scrolling anywhere in it. */
  let changes = 0;
  const noteChange = () => void changes++;
  let display = NO_DISPLAY;
  let concealed = false;
  let version = 0;
  let destroyed = false;
  /** Where each watched thread's target is, with the elements kept here. */
  let located = new Map<string, LocateResult | null>();
  let state: PageState;

  // Elements become handles the panel can hold; a handle never keeps its element alive.
  let nextRef = 0;
  const refs = new WeakMap<Element, ElementRef>();
  const elements = new Map<ElementRef, WeakRef<Element>>();
  const refOf = (element: Element): ElementRef => {
    let ref = refs.get(element);
    if (ref === undefined) {
      ref = `e${++nextRef}` as ElementRef;
      refs.set(element, ref);
      elements.set(ref, new WeakRef(element));
    }
    return ref;
  };
  const elementOf = (ref: ElementRef | null): Element | null => {
    if (ref === null) return null;
    const element = elements.get(ref)?.deref() ?? null;
    if (element === null) elements.delete(ref);
    return element;
  };
  const occurrenceOf = (element: Element): Occurrence => ({ ref: refOf(element), recordKey: recordKeyOf(element) });
  const prune = () => {
    if (elements.size < 1000) return;
    for (const [ref, weak] of elements) if (weak.deref() === undefined) elements.delete(ref);
  };

  const context = (): PageContext => cleanContext(readContext(current.getContext));

  /** Locates every watched thread and remembers the page as the panel will see it. */
  const measure = (): PageState => {
    const now = context();
    located = new Map(display.watch.map(({ threadId, location }) => [threadId, location.screen === now.screen ? locateShown(location) : null]));
    prune();
    const shown: Record<string, Located | null> = {};
    for (const [threadId, result] of located) shown[threadId] = result === null ? null : toLocated(result);
    state = {
      document: documentId,
      version: ++version,
      url: window.location.href,
      context: now,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      restores: current.restoreContext !== undefined,
      located: shown,
    };
    return state;
  };
  const toLocated = (result: LocateResult): Located =>
    result.status === "found" ? { status: "found", occurrences: result.elements.map(occurrenceOf) } : result;

  // ---------------------------------------------------------------------------
  // Drawing

  const root: Root = createRoot(container);
  const draw = () => {
    if (destroyed) return;
    const pins: PinTarget[] = display.pins.flatMap((pin) => {
      const result = located.get(pin.threadId);
      return result?.status === "found" ? [{ ...pin, elements: result.elements }] : [];
    });
    root.render(
      <Overlay
        host={host}
        display={display}
        concealed={concealed}
        pins={pins}
        selectedElement={elementOf(display.selected?.ref ?? null)}
        picked={elementOf(display.picked)}
        onPin={(threadId, element) => endpoint.emit("pin", { threadId, occurrence: occurrenceOf(element) })}
        onPick={(picked) => endpoint.emit("picked", { occurrence: occurrenceOf(picked.element), target: picked.target, context: context() })}
        onOutsideClick={() => endpoint.emit("outsideClick", {})}
      />,
    );
  };

  /** The page changed: tell the panel and move what's drawn with it. */
  const changed = () => {
    if (destroyed) return;
    endpoint.emit("state", measure());
    draw();
  };

  // ---------------------------------------------------------------------------
  // Requests

  const handlers: PageHandlers = {
    connect: () => ({ protocol: PAGE_PROTOCOL, state }),
    display(next) {
      display = next;
      changed();
      return state;
    },
    reveal: ({ threadId, location, chosen }, signal) => reveal(threadId, location, chosen, signal),
    showPage: async ({ threadId, screen, viewState, recordKey }, signal) => {
      const { restoreContext } = current;
      if (restoreContext === undefined) return { shown: false };
      const shown = await restoreContext({ threadId, screen, viewState, recordKey, scope: recordKey === null ? "shared" : "record", signal });
      if (shown === false) return { shown: false };
      const deadline = Date.now() + RESTORE_TIMEOUT_MS;
      for (;;) {
        const now = context();
        const shownRecord = recordKey === null || pageRecordKey(document.body) === recordKey;
        if (now.screen === screen && sameViewState(viewState, now.viewState, { restored: true }) && shownRecord) return { shown: true };
        if (signal.aborted || Date.now() > deadline) return { shown: false };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    measure({ ref }) {
      const element = elementOf(ref);
      const box = element?.isConnected ? element.getBoundingClientRect() : null;
      const marker: Rect | null = box === null ? null : { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height };
      return {
        context: context(),
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        marker,
        userAgent: navigator.userAgent,
      };
    },
    async capture({ marker, image }) {
      // A screenshot from outside the page is used only when the page has
      // nothing masked, then or now: it would show masked content, and what
      // overflows it, wherever it was at that instant. And only when nothing
      // changed since the pins were hidden, so the marker is where the target
      // was. Otherwise the page's own capture, which leaves masked content out.
      const before = shot;
      shot = null;
      const still = before !== null && before.changes === changes && !hasMasks(document) && sameShot(before.view, viewShot());
      if (image === null || !still) return await captureView(host, marker);
      return await markSuppliedCapture(image, { marker, ...before.view });
    },
    async conceal({ concealed: next }) {
      concealed = next;
      draw();
      if (!next) return null;
      // The view as the screenshot is about to be taken, once the hidden pins are painted.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      shot = hasMasks(document) ? null : { view: viewShot(), changes };
      return null;
    },
    async copyPage() {
      const now = context();
      const url = window.location.href;
      const recordKey = pageRecordKey(document.body);
      const page = await freezePage();
      return { ...page, url, context: now, recordKey };
    },
    removeLink() {
      // From the address as it is now, so another change to it, such as a checkout return being removed, stays.
      const next = removeLink(window.location.href);
      if (next !== window.location.href) window.history.replaceState(window.history.state, "", next);
      return null;
    },
  };

  /**
   * Shows a thread's target where it was left: its saved screen and view
   * state, then the target itself. A matching element in another view doesn't
   * count, so the host restores the view unless it is already shown.
   */
  async function reveal(_threadId: string, location: TargetLocation, chosen: Occurrence | null, signal: AbortSignal): Promise<RevealResult> {
    const inSavedView = ({ restored = false }: { restored?: boolean } = {}) => {
      const now = context();
      return now.screen === location.screen && sameViewState(location.viewState, now.viewState, { restored });
    };
    const inRestoredView = () => inSavedView({ restored: true });
    const fail = (reason: string, keepOccurrence: boolean): RevealResult => ({ status: "failed", reason, keepOccurrence });
    const aborted = (): RevealResult => fail("The reviewer moved on.", true);

    let result: LocateResult = inSavedView() ? locateShown(location) : { status: "not-found" };
    if (result.status !== "found") {
      const { restoreContext } = current;
      if (restoreContext === undefined) return fail(notRestoredReason(location, context()), true);
      try {
        const shown = await restoreContext({
          threadId: _threadId,
          screen: location.screen,
          viewState: location.viewState,
          recordKey: location.target.recordKey,
          scope: location.scope,
          signal,
        });
        if (signal.aborted) return aborted();
        if (shown === false) return fail("The prototype couldn't show this view right now.", true);
      } catch (error) {
        if (signal.aborted) return aborted();
        return fail(`The prototype couldn't show this view${error instanceof Error ? `: ${error.message}` : "."}`, true);
      }
      // Wait for the app to report the saved view and for its content to render.
      result = await waitForTarget(location.target, location.scope, document.body, {
        timeoutMs: RESTORE_TIMEOUT_MS,
        signal,
        isCandidate: isShown,
        ready: inRestoredView,
      });
      if (signal.aborted) return aborted();
      if (!inRestoredView()) return fail(wrongViewReason(location, context()), false);
    }

    if (result.status === "found") {
      // Keep the occurrence the reviewer chose, such as a clicked pin, while it still matches.
      const chosenElement = chosen === null ? null : { element: elementOf(chosen.ref), recordKey: chosen.recordKey };
      const getCurrent = () => {
        const now = locateShown(location);
        return now.status === "found" ? (follow(chosenElement, now.elements) ?? now.elements[0]!) : null;
      };
      const element = await waitForViewMotion(getCurrent, signal, RESTORE_TIMEOUT_MS);
      if (signal.aborted) return aborted();
      if (element === null || !inRestoredView() || getCurrent() !== element) {
        return fail("The prototype is still changing its view. Try showing this comment again once it has settled.", false);
      }
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const { x, y, width, height } = element.getBoundingClientRect();
      return { status: "shown", occurrence: occurrenceOf(element), rect: { x, y, width, height } };
    }
    return fail(
      {
        "not-found": "The element couldn't be found after restoring the view. It may have changed or been removed.",
        "wrong-record": `This comment is about record ${location.target.recordKey}, which isn't shown.`,
        ambiguous: "Several elements match, so Critiqs won't guess which one.",
      }[result.status],
      false,
    );
  }

  const endpoint: PageLayerEndpoint = pageLayerEndpoint(transport, { channel, handlers, document: documentId });
  // A panel that went away, such as a closed side panel, leaves nothing behind
  // on the page: no pins, and no Comment mode keeping clicks from the page.
  const stopClosing = transport.onClose(() => {
    display = NO_DISPLAY;
    concealed = false;
    shot = null;
    draw();
  });
  measure();
  draw();

  // ---------------------------------------------------------------------------
  // Watching the page: elements added or removed, attributes, the URL, and
  // resizing, combined per frame. Critiqs's own shadow roots aren't observed.

  let frame = 0;
  const bump = () => {
    if (frame !== 0 || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      changed();
    });
  };
  const observer = new MutationObserver(() => {
    noteChange();
    bump();
  });
  // The whole document, not today's <body>: client routers such as Astro's replace the body on navigation.
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  window.addEventListener("popstate", bump);
  window.addEventListener("hashchange", bump);
  window.addEventListener("resize", bump);
  // Scrolling moves masked content without changing the page; scroll events from any element reach here while capturing.
  window.addEventListener("scroll", noteChange, true);
  window.addEventListener("resize", noteChange);
  // pushState and replaceState fire no event, so notice URL changes by checking.
  let href = window.location.href;
  const poll = setInterval(() => {
    if (window.location.href === href) return;
    href = window.location.href;
    bump();
  }, 500);

  endpoint.emit("ready", { protocol: PAGE_PROTOCOL });

  return {
    setHost(next) {
      current = next;
      changed();
    },
    state: () => state,
    element: (ref) => elementOf(ref),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopClosing();
      endpoint.close();
      clearInterval(poll);
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("popstate", bump);
      window.removeEventListener("hashchange", bump);
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", noteChange, true);
      window.removeEventListener("resize", noteChange);
      // Right after the panel's own change finishes: a root can't be unmounted
      // while another is rendering, and Comment mode's listeners on the page
      // must be gone before anything else happens there.
      queueMicrotask(() => root.unmount());
    },
  };
}

/** The view's scroll and size. */
interface ViewShot {
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
}

function viewShot(): ViewShot {
  return {
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

function sameShot(a: ViewShot, b: ViewShot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The host's context as the protocol carries it: view state values a host may
 * report by mistake, such as NaN, become null rather than a message the panel
 * would refuse.
 */
function cleanContext(context: PageContext): PageContext {
  // Built from entries, so every key the host reports is kept as its own, `__proto__` included.
  const viewState: ViewState = Object.fromEntries(
    Object.entries(context.viewState ?? {}).map(([key, value]) => [
      key,
      value === null || typeof value === "string" || typeof value === "boolean" ? value : typeof value === "number" && Number.isFinite(value) ? value : null,
    ]),
  );
  return {
    screen: String(context.screen),
    viewState,
    persona: typeof context.persona === "string" ? context.persona : null,
  };
}

/**
 * The occurrence to stay with after the prototype re-renders: the chosen
 * element while it still matches, else the match on the same record.
 */
function follow(chosen: { element: Element | null; recordKey: string | null } | null, elements: Element[]): Element | null {
  if (chosen === null) return elements[0] ?? null;
  if (chosen.element !== null && elements.includes(chosen.element)) return chosen.element;
  return elements.find((element) => recordKeyOf(element) === chosen.recordKey) ?? null;
}

/** What the page layer draws over the page. */
function Overlay({
  host,
  display,
  concealed,
  pins,
  selectedElement,
  picked,
  onPin,
  onPick,
  onOutsideClick,
}: {
  host: HTMLElement;
  display: PageDisplay;
  concealed: boolean;
  pins: PinTarget[];
  selectedElement: Element | null;
  picked: Element | null;
  onPin: (threadId: string, element: Element) => void;
  onPick: (picked: PickedTarget) => void;
  onOutsideClick: () => void;
}) {
  const highlight = useStableHighlight(display.highlight);
  const width = display.exposedRight;
  return (
    <div className="layer page-layer" aria-hidden={display.hidden || concealed || undefined} style={display.hidden || concealed ? { visibility: "hidden" } : undefined}>
      <Pins
        targets={pins}
        selectedThreadId={display.selected?.threadId ?? null}
        selectedElement={selectedElement}
        exposedRight={width ?? window.innerWidth}
        onSelect={onPin}
      />
      {highlight !== null && <Highlight key={highlight.id} location={highlight.location} onDone={highlight.done} />}
      {display.picking !== null && (
        <Picker
          host={host}
          exposedRight={width ?? undefined}
          hint={display.picking.hint}
          paused={display.picking.paused}
          onPick={onPick}
          onOutsideClick={onOutsideClick}
        />
      )}
      {picked !== null && <PickedBox element={picked} />}
    </div>
  );
}

/** The outline around the element a new comment is about, when the panel isn't drawn over the page to show it. */
function PickedBox({ element }: { element: Element }) {
  const rect = useElementRect(element);
  if (rect === null) return null;
  return <div className="target-box passive" style={{ left: rect.x - 2, top: rect.y - 2, width: rect.width + 4, height: rect.height + 4 }} />;
}

/**
 * The highlight to draw, kept as the same object while its `id` stays the
 * same, so a new display with the same highlight doesn't restart it, and
 * dropped once it has finished.
 */
function useStableHighlight(highlight: PageDisplay["highlight"]): { id: number; location: TargetLocation; done: () => void } | null {
  const [kept, setKept] = useState<{ id: number; location: TargetLocation } | null>(null);
  const [finished, setFinished] = useState<number | null>(null);
  if (highlight === null && kept !== null) setKept(null);
  if (highlight !== null && kept?.id !== highlight.id) setKept(highlight);
  const id = kept?.id ?? null;
  const done = useCallback(() => setFinished(id), [id]);
  if (kept === null || finished === kept.id) return null;
  return { id: kept.id, location: kept.location, done };
}
