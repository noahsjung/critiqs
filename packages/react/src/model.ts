import { type LocateResult, locateTarget, type TargetLocation, type ThreadSummary } from "@critiqs/core";
import { describeViewState } from "./ui/format.ts";

export type { ProjectInfo as Project, ThreadDetail, ThreadSummary } from "@critiqs/core";

/** A thread with where its target is now relative to the reviewer's view. */
export interface LiveThread {
  summary: ThreadSummary;
  /** The current target: the reattachment, or else the original anchor. */
  location: TargetLocation;
  /** Null when the thread belongs to another screen. */
  located: LocateResult | null;
  /** Whether the thread's view state matches the one the reviewer is in. */
  sameView: boolean;
}

export function locationOf(thread: { anchor: TargetLocation; location?: TargetLocation | null; reattachment?: { location: TargetLocation } }): TargetLocation {
  const { screen, viewState, target, scope } = thread.reattachment?.location ?? thread.location ?? thread.anchor;
  return { screen, viewState, target, scope };
}

/**
 * Whether an element is rendered on screen. Apps may keep inactive tabs or
 * closed dialogs in the page but hidden; those are not live targets.
 */
export function isShown(element: Element): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true } as CheckVisibilityOptions);
  }
  return element.getClientRects().length > 0;
}

/** Locates a thread's current target among elements shown on screen. */
export function locateShown(location: TargetLocation): LocateResult {
  return locateTarget(location.target, location.scope, document.body, isShown);
}

export type TargetState = "live" | "other-view" | "other-record" | "ambiguous" | "missing" | "other-screen";

export function targetState(thread: LiveThread): TargetState {
  const located = thread.located;
  if (located === null) return "other-screen";
  switch (located.status) {
    case "found":
      return "live";
    case "wrong-record":
      return "other-record";
    case "ambiguous":
      return "ambiguous";
    case "not-found":
      return Object.keys(thread.location.viewState).length > 0 && !thread.sameView ? "other-view" : "missing";
  }
}

/** Plain description of where a thread's target is, for list entries and the thread's context. */
export function describeTargetState(thread: LiveThread): string {
  const { location } = thread;
  switch (targetState(thread)) {
    case "live":
      return "In this view";
    case "other-screen":
      return `On ${location.screen}`;
    case "other-view":
      return `In another view (${describeViewState(location.viewState)})`;
    case "other-record":
      return `Its record (${location.target.recordKey}) isn't shown here`;
    case "ambiguous":
      return "Matches several elements; Critiqs won't guess";
    case "missing":
      return "Not shown in this view; it may be hidden, changed, or removed";
  }
}
