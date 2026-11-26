import type { Rect, Scope, Target, TargetLocation, ViewState } from "../types.ts";
import {
  array,
  blob,
  boolean,
  type Check,
  finite,
  integer,
  isRecord,
  literal,
  none,
  nullable,
  object,
  oneOf,
  ProtocolError,
  record,
  text,
  variants,
  webAddress,
} from "./check.ts";

// The messages between Critiqs's two halves:
//
// - The page layer runs in the prototype's page. It owns everything that
//   touches the page: picking elements, pins and highlights drawn on it,
//   locating targets, the host's getContext and restoreContext, captures,
//   page copies, and masks.
// - The panel is the toolbar, sidebar, thread window, sign-in, and backend
//   connection. It may run in the same document (installed), in a page
//   around the prototype's frame (review link), or in Chrome's side panel
//   (extension).
//
// The panel sends requests and the page layer answers them; the page layer
// sends events. In the frame and extension cases the other side is a
// different document, so every message is checked on arrival
// (`parsePageMessage`), and a message that fails the check is never handled.

/** The protocol version both halves speak. A message with another version is refused. */
export const PAGE_PROTOCOL = 1;
/** Marks Critiqs's messages among everything else a window receives. */
export const PAGE_MESSAGE_TAG = "critiqs:page-layer";

declare const elementRefBrand: unique symbol;
/**
 * The page layer's handle for one element on the page. The panel never sees
 * elements, only these; the page layer turns them back into elements while
 * the element is still on the page.
 */
export type ElementRef = string & { readonly [elementRefBrand]: true };

/** The view the prototype reports, with the URL path standing in for a missing screen. */
export interface PageContext {
  screen: string;
  viewState: ViewState;
  persona: string | null;
}

/** One element a thread's target matched, such as one row of a shared thread. */
export interface Occurrence {
  ref: ElementRef;
  recordKey: string | null;
}

/** Where a thread's target is on the page now; `LocateResult` with handles instead of elements. */
export type Located =
  | { status: "found"; occurrences: Occurrence[] }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: number }
  | { status: "wrong-record" };

/** What the panel knows about the page. The page layer sends it again whenever the page changes. */
export interface PageState {
  /**
   * Names this page layer, one per document: a frame or tab that loads
   * another page starts a new one. Handles and requests belong to it.
   */
  document: string;
  /** Increases every time the page changes: elements, URL, or size. */
  version: number;
  url: string;
  context: PageContext;
  viewport: { width: number; height: number };
  /** Whether the host can show a thread's view (`restoreContext`). */
  restores: boolean;
  /** Each watched thread by ID; null when the thread is on another screen. */
  located: Record<string, Located | null>;
}

/** A thread whose target the page layer locates every time the page changes. */
export interface WatchedThread {
  threadId: string;
  location: TargetLocation;
}

export interface PinSpec {
  threadId: string;
  authorName: string;
  unread: boolean;
  resolved: boolean;
}

/**
 * Everything the page layer draws, sent whole each time it changes, so
 * applying it twice is the same as applying it once.
 */
export interface PageDisplay {
  /** Hides everything the page layer draws (Ctrl or Cmd + \). */
  hidden: boolean;
  /** Where the panel starts covering the page, such as the open sidebar's left edge; null when it covers none of it. */
  exposedRight: number | null;
  watch: WatchedThread[];
  /** Pins for these threads, beside each occurrence the page layer found. */
  pins: PinSpec[];
  /** The open thread, and which of its occurrences opened it. */
  selected: { threadId: string; ref: ElementRef | null } | null;
  /** Outlines a thread's target briefly; a new `id` outlines it again. */
  highlight: { id: number; location: TargetLocation } | null;
  /** Comment mode's element selection, with the hint shown at the top. */
  picking: { hint: string | null; paused: boolean } | null;
  /** The element a new comment is about, outlined by the page layer when the panel isn't drawn over the page. */
  picked: ElementRef | null;
}

export type RevealResult =
  | { status: "shown"; occurrence: Occurrence; rect: Rect }
  | {
      status: "failed";
      reason: string;
      /** Whether the occurrence the reviewer chose still applies; otherwise the thread window docks. */
      keepOccurrence: boolean;
    };

export interface PageMeasure {
  context: PageContext;
  url: string;
  viewport: { width: number; height: number };
  /** The element's box in page coordinates, or null when it's gone. */
  marker: Rect | null;
  userAgent: string;
}

export type CaptureOutcome = { status: "captured"; image: Blob } | { status: "failed"; reason: string };

/** A page copy for Mockup mode, with where it came from. */
export interface PageCopy {
  html: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollY: number;
  capturedAt: number;
  url: string;
  context: PageContext;
  recordKey: string | null;
}

/** Each request the panel can make, with what it sends and what it gets back. */
export interface PageMethods {
  /** First message: checks the version and returns the page as it is. Sent again after the page layer reloads. */
  connect: { params: { protocol: typeof PAGE_PROTOCOL }; result: { protocol: number; state: PageState } };
  /** Replaces what the page layer draws and watches; returns the page with the new threads located. */
  display: { params: PageDisplay; result: PageState };
  /** Shows a thread's view and target: restores the view if needed, waits for the target, and scrolls to it. Cancellable. */
  reveal: { params: { threadId: string; location: TargetLocation; chosen: Occurrence | null }; result: RevealResult };
  /** Asks the host to show a page by its screen, view state, and record, and waits until it does. Cancellable. */
  showPage: { params: { threadId: string; screen: string; viewState: ViewState; recordKey: string | null }; result: { shown: boolean } };
  /** The page's context, address, and size now, and where an element is. */
  measure: { params: { ref: ElementRef | null }; result: PageMeasure };
  /** Captures the view (masks covered, the marker drawn), from the page's DOM or from a supplied screenshot of it. */
  capture: { params: { marker: Rect | null; image: Blob | null }; result: CaptureOutcome };
  /** Hides what the page layer draws while a screenshot is taken from outside the page. */
  conceal: { params: { concealed: boolean }; result: null };
  /** A frozen copy of the page for Mockup mode. */
  copyPage: { params: Record<string, never>; result: PageCopy };
  /** Takes a shared link to a comment out of the page's address once it is open, without loading the page. */
  removeLink: { params: Record<string, never>; result: null };
}

/** Each event the page layer sends. */
export interface PageEvents {
  /** A page layer started, such as after the frame loaded another page. The panel connects again. */
  ready: { protocol: number };
  /** The page changed: its elements, address (navigation), size, or reported context. */
  state: PageState;
  /** The reviewer picked an element in Comment mode. */
  picked: { occurrence: Occurrence; target: Target; context: PageContext };
  /** A click on the page while picking is paused, such as beside an open composer. */
  outsideClick: Record<string, never>;
  /** The reviewer clicked a pin. */
  pin: { threadId: string; occurrence: Occurrence };
}

export type PageMethod = keyof PageMethods;
export type PageEvent = keyof PageEvents;
export type PageParams<M extends PageMethod> = PageMethods[M]["params"];
export type PageResult<M extends PageMethod> = PageMethods[M]["result"];

/** Why a request failed. `gone`: it was for a page layer that another document's has replaced. */
export type PageErrorCode = "bad-request" | "unknown-method" | "unsupported-version" | "cancelled" | "closed" | "gone" | "timeout" | "failed";

interface Envelope {
  tag: typeof PAGE_MESSAGE_TAG;
  v: typeof PAGE_PROTOCOL;
  /** Pairs one panel with one page layer where several share a window. */
  channel: string;
}

export type RequestMessage = {
  [M in PageMethod]: Envelope & {
    kind: "request";
    id: number;
    method: M;
    params: PageParams<M>;
    /**
     * The page layer this is for (`PageState.document`), so another document's
     * page layer that took its place refuses it; null for any, as when connecting.
     */
    document: string | null;
  };
}[PageMethod];
export type ResultMessage = Envelope & { kind: "result"; id: number; result: unknown };
export type ErrorMessage = Envelope & { kind: "error"; id: number; error: { code: PageErrorCode; message: string } };
export type CancelMessage = Envelope & { kind: "cancel"; id: number };
export type EventMessage = { [E in PageEvent]: Envelope & { kind: "event"; event: E; data: PageEvents[E] } }[PageEvent];
export type PageMessage = RequestMessage | ResultMessage | ErrorMessage | CancelMessage | EventMessage;

// ---------------------------------------------------------------------------
// Checks

/**
 * What the host app and the page report: screens, view state, labels,
 * addresses, page copies. Installed Critiqs never limited them, and the peer
 * is already the one origin allowed to talk, so they have no length limit of
 * their own; handles and IDs, which Critiqs makes, do.
 */
const MAX_TEXT = Number.POSITIVE_INFINITY;
const MAX_URL = Number.POSITIVE_INFINITY;
const MAX_COPY = Number.POSITIVE_INFINITY;
const id = text(256);
const ref = text(64) as Check<ElementRef>;
/** A page's address: the panel builds share links from it, so never one that runs code. */
const url = webAddress(MAX_URL);

const rect: Check<Rect> = object({ x: finite, y: finite, width: finite, height: finite });
const size = object<{ width: number; height: number }>({ width: finite, height: finite });
const viewValue = (value: unknown, path: string): string | number | boolean | null =>
  value === null || typeof value === "boolean" ? value : typeof value === "number" ? finite(value, path) : text(MAX_TEXT)(value, path);
// As many keys as the host reports, as installed Critiqs always took.
const viewState: Check<ViewState> = record(viewValue, Number.POSITIVE_INFINITY);
const scope: Check<Scope> = oneOf(["shared", "record"]);
const target: Check<Target> = object({
  purposeId: nullable(text(MAX_TEXT)),
  recordKey: nullable(text(MAX_TEXT)),
  clues: object({ tagName: text(256), role: nullable(text(256)), label: nullable(text(MAX_TEXT)), path: text(MAX_TEXT) }),
});
const location: Check<TargetLocation> = object({ screen: text(MAX_TEXT), viewState, target, scope });
const context: Check<PageContext> = object({ screen: text(MAX_TEXT), viewState, persona: nullable(text(MAX_TEXT)) });
const occurrence: Check<Occurrence> = object({ ref, recordKey: nullable(text(MAX_TEXT)) });
const located: Check<Located> = variants<"status", Located>("status", {
  found: object({ status: literal("found"), occurrences: array(occurrence, 100_000) }),
  "not-found": object({ status: literal("not-found") }),
  ambiguous: object({ status: literal("ambiguous"), candidates: integer }),
  "wrong-record": object({ status: literal("wrong-record") }),
});
const state: Check<PageState> = object({
  document: text(256),
  version: integer,
  url,
  context,
  viewport: size,
  restores: boolean,
  located: record(nullable(located)),
});
const empty: Check<Record<string, never>> = object({});

const display: Check<PageDisplay> = object({
  hidden: boolean,
  exposedRight: nullable(finite),
  watch: array(object<WatchedThread>({ threadId: id, location })),
  pins: array(object<PinSpec>({ threadId: id, authorName: text(MAX_TEXT), unread: boolean, resolved: boolean })),
  selected: nullable(object({ threadId: id, ref: nullable(ref) })),
  highlight: nullable(object({ id: integer, location })),
  picking: nullable(object({ hint: nullable(text(MAX_TEXT)), paused: boolean })),
  picked: nullable(ref),
});

/** Checks for what each request sends. Typed against `PageMethods`, so the two can't drift apart. */
export const PAGE_PARAMS: { [M in PageMethod]: Check<PageParams<M>> } = {
  connect: object({ protocol: literal(PAGE_PROTOCOL) }),
  display,
  reveal: object({ threadId: id, location, chosen: nullable(occurrence) }),
  showPage: object({ threadId: id, screen: text(MAX_TEXT), viewState, recordKey: nullable(text(MAX_TEXT)) }),
  measure: object({ ref: nullable(ref) }),
  capture: object({ marker: nullable(rect), image: nullable(blob) }),
  conceal: object({ concealed: boolean }),
  copyPage: empty,
  removeLink: empty,
};

/** Checks for what each request returns. */
export const PAGE_RESULTS: { [M in PageMethod]: Check<PageResult<M>> } = {
  connect: object({ protocol: integer, state }),
  display: state,
  reveal: variants<"status", RevealResult>("status", {
    shown: object({ status: literal("shown"), occurrence, rect }),
    failed: object({ status: literal("failed"), reason: text(MAX_TEXT), keepOccurrence: boolean }),
  }),
  showPage: object({ shown: boolean }),
  measure: object({ context, url, viewport: size, marker: nullable(rect), userAgent: text(MAX_TEXT) }),
  capture: variants<"status", CaptureOutcome>("status", {
    captured: object({ status: literal("captured"), image: blob }),
    failed: object({ status: literal("failed"), reason: text(MAX_TEXT) }),
  }),
  conceal: none,
  copyPage: object({
    html: text(MAX_COPY),
    width: finite,
    height: finite,
    viewportWidth: finite,
    viewportHeight: finite,
    scrollY: finite,
    capturedAt: finite,
    url,
    context,
    recordKey: nullable(text(MAX_TEXT)),
  }),
  removeLink: none,
};

/** Checks for what each event carries. */
export const PAGE_EVENTS: { [E in PageEvent]: Check<PageEvents[E]> } = {
  ready: object({ protocol: integer }),
  state,
  picked: object({ occurrence, target, context }),
  outsideClick: empty,
  pin: object({ threadId: id, occurrence }),
};

const PAGE_ERROR_CODES: readonly PageErrorCode[] = ["bad-request", "unknown-method", "unsupported-version", "cancelled", "closed", "gone", "timeout", "failed"];

/**
 * What arrived, once checked: a Critiqs message on this channel with every
 * field as the protocol says, or the reason it can't be handled. Results are
 * checked by the panel against the request they answer (`PAGE_RESULTS`).
 */
export type ParsedPageMessage =
  | { ok: true; message: PageMessage }
  /** Another program's message, or another channel's: ignored without a word. */
  | { ok: false; ignore: true }
  /**
   * A Critiqs message that can't be handled. A request among them gets this
   * error back; a reply among them fails the request it answers.
   */
  | { ok: false; ignore: false; reply: "request" | "answer" | null; id: number | null; code: PageErrorCode; reason: string };

export function parsePageMessage(raw: unknown, channel: string): ParsedPageMessage {
  if (!isRecord(raw) || raw.tag !== PAGE_MESSAGE_TAG || raw.channel !== channel) return { ok: false, ignore: true };
  const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : null;
  const reply = raw.kind === "request" ? "request" : raw.kind === "result" || raw.kind === "error" ? "answer" : null;
  if (raw.v !== PAGE_PROTOCOL) {
    return { ok: false, ignore: false, reply, id, code: "unsupported-version", reason: `This page layer speaks version ${PAGE_PROTOCOL} of Critiqs's page protocol, not ${String(raw.v)}.` };
  }
  try {
    return { ok: true, message: parseKnown(raw, channel) };
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    const unknownMethod = raw.kind === "request" && !(typeof raw.method === "string" && Object.hasOwn(PAGE_PARAMS, raw.method));
    return { ok: false, ignore: false, reply, id, code: unknownMethod ? "unknown-method" : "bad-request", reason: error.message };
  }
}

function parseKnown(raw: Record<string, unknown>, channel: string): PageMessage {
  const base = { tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel } as const;
  const keys = (allowed: string[]) => {
    for (const key of Object.keys(raw)) if (!["tag", "v", "channel", "kind", ...allowed].includes(key)) throw new ProtocolError(`${key} isn't part of a ${String(raw.kind)} message.`);
  };
  switch (raw.kind) {
    case "request": {
      keys(["id", "method", "params", "document"]);
      const method = raw.method;
      if (typeof method !== "string" || !Object.hasOwn(PAGE_PARAMS, method)) throw new ProtocolError(`There is no request named ${JSON.stringify(method)}.`);
      const check = PAGE_PARAMS[method as PageMethod] as Check<unknown>;
      return {
        ...base,
        kind: "request",
        id: integer(raw.id, "id"),
        method,
        params: check(raw.params, "params"),
        document: nullable(text(256))(raw.document, "document"),
      } as RequestMessage;
    }
    case "result":
      keys(["id", "result"]);
      return { ...base, kind: "result", id: integer(raw.id, "id"), result: raw.result };
    case "error": {
      keys(["id", "error"]);
      const error = object({ code: oneOf(PAGE_ERROR_CODES), message: text(MAX_TEXT) })(raw.error, "error");
      return { ...base, kind: "error", id: integer(raw.id, "id"), error };
    }
    case "cancel":
      keys(["id"]);
      return { ...base, kind: "cancel", id: integer(raw.id, "id") };
    case "event": {
      keys(["event", "data"]);
      const event = raw.event;
      if (typeof event !== "string" || !Object.hasOwn(PAGE_EVENTS, event)) throw new ProtocolError(`There is no event named ${JSON.stringify(event)}.`);
      const check = PAGE_EVENTS[event as PageEvent] as Check<unknown>;
      return { ...base, kind: "event", event, data: check(raw.data, "data") } as EventMessage;
    }
    default:
      throw new ProtocolError(`kind must be request, result, error, cancel, or event.`);
  }
}

/** Builds a message with the pageEnvelope filled in. */
export function pageEnvelope<T extends object>(channel: string, body: T): Envelope & T {
  return { tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel, ...body };
}
