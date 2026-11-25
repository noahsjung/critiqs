import type { MockupDetail, MockupEdit, MockupSnapshotInfo, MockupSource, MockupSummary, Rect, ThreadSummary, ViewState } from "@critiqs/core";
import type { FrozenPage } from "./freeze.ts";

// The Mockup panel's navigation, as one state the panel and the copy both
// read. It has two levels: the list of mockup threads from every page, over a
// fresh copy of the page; and one thread, over its own copy. A new thread is
// drafted over the list's copy and saved only with its first message. Each
// mockup thread is its own mockup, so a thread names both.

/** An element of the shown copy chosen for a new thread, with where it is in the window. */
export interface ElementChoice {
  node: number;
  /** How the composer names it, such as `button "Save"`. */
  label: string;
  rect: Rect;
}

/** A thread on another page, waiting for the reviewer to agree to go there. */
export interface PendingVisit {
  mockupId: string;
  threadId: string;
  screen: string;
  viewState: ViewState;
  recordKey: string | null;
  /** Asking, or asking the prototype to show the page. */
  status: "asking" | "going";
}

/**
 * The page frozen for a new thread, with the page it was frozen on: read
 * together, so a mockup never pairs one page's copy with another's details.
 */
export interface FrozenDraft {
  page: FrozenPage;
  source: MockupSource;
}

export type MockupState =
  | {
      view: "list";
      /** The page frozen into a copy for a new thread; null while freezing. */
      frozen: FrozenDraft | null;
      /** A new thread is open, not yet saved: it is saved with its first message. */
      drafting: boolean;
      /** An element of the copy the new thread asks about; only while drafting. */
      selection: ElementChoice | null;
      visit: PendingVisit | null;
    }
  | {
      view: "thread";
      mockupId: string;
      threadId: string;
      /** The copy shown; null until the mockup's copies are known. */
      snapshotId: string | null;
      /** The latest version, or an earlier one by number (0: the original copy). */
      viewing: "head" | number;
    };

export type MockupAction =
  | { type: "frozen"; frozen: FrozenDraft }
  /** Back to the list, over a fresh copy of the page. */
  | { type: "list" }
  /** Opens a new thread over the list's copy, and leaves it without saving. */
  | { type: "new-thread" }
  | { type: "end-draft" }
  | { type: "open"; mockupId: string; threadId: string; snapshotId?: string | null }
  | { type: "ask-visit"; visit: Omit<PendingVisit, "status"> }
  | { type: "visit-going" }
  /** Once the prototype was asked to show the page, it may have, so the list freezes the page again. */
  | { type: "cancel-visit" }
  | { type: "show-copy"; snapshotId: string }
  | { type: "view"; version: "head" | number }
  | { type: "select"; choice: ElementChoice }
  | { type: "deselect" }
  /** Closes the innermost thing; see `escapeTarget`. */
  | { type: "escape" };

export const INITIAL_STATE: MockupState = { view: "list", frozen: null, drafting: false, selection: null, visit: null };

export function mockupReducer(state: MockupState, action: MockupAction): MockupState {
  switch (action.type) {
    case "frozen":
      return state.view === "list" ? { ...state, frozen: action.frozen } : state;
    case "list":
      return INITIAL_STATE;
    case "new-thread":
      return state.view === "list" && state.visit === null ? { ...state, drafting: true } : state;
    case "end-draft":
      return state.view === "list" ? { ...state, drafting: false, selection: null } : state;
    case "open":
      return { view: "thread", mockupId: action.mockupId, threadId: action.threadId, snapshotId: action.snapshotId ?? null, viewing: "head" };
    case "ask-visit":
      return state.view === "list" && !state.drafting ? { ...state, selection: null, visit: { ...action.visit, status: "asking" } } : state;
    case "visit-going":
      return state.view === "list" && state.visit !== null ? { ...state, visit: { ...state.visit, status: "going" } } : state;
    case "cancel-visit":
      if (state.view !== "list" || state.visit === null) return state;
      return { ...state, visit: null, frozen: state.visit.status === "going" ? null : state.frozen };
    case "show-copy":
      return state.view === "thread" ? { ...state, snapshotId: action.snapshotId } : state;
    case "view":
      return state.view === "thread" ? { ...state, viewing: action.version } : state;
    case "select":
      return state.view === "list" && state.drafting ? { ...state, selection: action.choice } : state;
    case "deselect":
      return state.view === "list" ? { ...state, selection: null } : state;
    case "escape":
      return state.view === "list" && state.selection !== null ? { ...state, selection: null } : state;
  }
}

/** What Escape closes: a chosen element, then the panel. It never leaves Mockup mode, and an open thread stays open. */
export function escapeTarget(state: MockupState): "selection" | "panel" {
  return state.view === "list" && state.selection !== null ? "selection" : "panel";
}

/** A mockup thread as the list shows it, with the mockup that is its proposal. */
export interface ThreadRow {
  mockup: MockupSummary;
  thread: ThreadSummary;
}

/**
 * The list's groups: this page's threads first, then each other page's, the
 * most recently active first, by their mockups' `listedAt`, the order the
 * backend pages them in; every message in a mockup thread moves it.
 */
export interface ThreadGroup {
  screen: string;
  here: boolean;
  rows: ThreadRow[];
}

/**
 * A mockup's threads. Backends deployed before mockups carried their threads
 * send none, so such a mockup lists no threads until the backend is updated.
 */
export function mockupThreads(mockup: Pick<MockupSummary, "threads">): ThreadSummary[] {
  return (mockup.threads as ThreadSummary[] | undefined) ?? [];
}

export function groupThreads(mockups: readonly MockupSummary[], screen: string): ThreadGroup[] {
  const groups = new Map<string, ThreadRow[]>();
  for (const mockup of mockups) {
    for (const thread of mockupThreads(mockup)) {
      const rows = groups.get(mockup.source.screen) ?? [];
      rows.push({ mockup, thread });
      groups.set(mockup.source.screen, rows);
    }
  }
  const listed = (row: ThreadRow) => row.mockup.listedAt ?? 0;
  const newer = (a: ThreadRow, b: ThreadRow) => listed(b) - listed(a) || b.thread.lastMessageAt - a.thread.lastMessageAt;
  const latest = (rows: ThreadRow[]) => Math.max(...rows.map(listed));
  return [...groups]
    .map(([page, rows]) => ({ screen: page, here: page === screen, rows: rows.sort(newer) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || latest(b.rows) - latest(a.rows));
}

/** Longest title taken from a thread's first message; the backend allows 120 characters. */
const TITLE_CHARS = 80;

/** A new mockup's title: its thread's first message, on one line and shortened. */
export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/** The latest version's number; 0 when the mockup has only its original copies. */
export function headVersion(mockup: MockupDetail): number {
  return mockup.versions.at(-1)?.number ?? 0;
}

/** The version shown, by number; a version that doesn't exist (yet) shows the latest. */
export function shownVersion(mockup: MockupDetail, viewing: "head" | number): number {
  const head = headVersion(mockup);
  return viewing === "head" || viewing > head || viewing < 0 ? head : viewing;
}

/** A copy's changes in a version: every change from the original copy. */
export function editsAt(mockup: MockupDetail, snapshotId: string, version: number): MockupEdit[] {
  if (version === 0) return [];
  return mockup.versions.find((entry) => entry.number === version)?.edits[snapshotId] ?? [];
}

/** Below this width, pages usually switch to a phone layout. */
const NARROW = 768;
/** How far the window can be from a copy's width, as a share of it, before a copy at the window's width is offered. */
const WIDTH_TOLERANCE = 0.15;

/** Whether a copy taken at `copyWidth` likely shows another layout than the page has at `windowWidth`. */
export function needsOtherCopy(windowWidth: number, copyWidth: number): boolean {
  const crosses = windowWidth < NARROW !== copyWidth < NARROW;
  return crosses || Math.abs(windowWidth - copyWidth) >= copyWidth * WIDTH_TOLERANCE;
}

/** The copy closest to a width, for opening a mockup at the window's width. */
export function closestCopy(snapshots: readonly MockupSnapshotInfo[], width: number): MockupSnapshotInfo | null {
  let best: MockupSnapshotInfo | null = null;
  for (const snapshot of snapshots) {
    if (best === null || Math.abs(snapshot.width - width) < Math.abs(best.width - width)) best = snapshot;
  }
  return best;
}

/**
 * What to offer when the window's width doesn't suit the shown copy: another
 * copy that suits it, or taking one at the window's width.
 */
export function copyHint(
  snapshots: readonly MockupSnapshotInfo[],
  shown: MockupSnapshotInfo,
  windowWidth: number,
): { kind: "switch"; snapshot: MockupSnapshotInfo } | { kind: "take"; width: number } | null {
  if (!needsOtherCopy(windowWidth, shown.width)) return null;
  const suits = snapshots.filter((snapshot) => snapshot._id !== shown._id && !needsOtherCopy(windowWidth, snapshot.width));
  const closest = closestCopy(suits, windowWidth);
  return closest !== null ? { kind: "switch", snapshot: closest } : { kind: "take", width: windowWidth };
}
