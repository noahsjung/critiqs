import type { HostContext, RestoreRequest, ViewState } from "critiqs-react";
import { useLayoutEffect, useRef, useState } from "react";
import { users } from "./data.ts";
import { type PilotView, scrollTopRevealing, userIndexOf } from "./view.ts";

// Connects the pilot's view state to Critiqs: what the reviewer is looking at
// (context) and how to show a thread's view again (restore context).

export interface CritiqsIntegration {
  getContext: () => HostContext;
  /** Returns false when the view cannot be shown; Critiqs then shows saved context. */
  restoreContext: (request: RestoreRequest) => boolean;
}

/**
 * Returns stable functions for Critiqs's `getContext` and `restoreContext`
 * props. They read the latest view through a ref, so Critiqs can call them at
 * any time without the App re-creating them on every render.
 */
export function useCritiqsIntegration(
  view: PilotView,
  setView: (view: PilotView) => void,
): CritiqsIntegration {
  const latest = useRef({ view, setView });
  useLayoutEffect(() => {
    latest.current = { view, setView };
  });

  const [integration] = useState<CritiqsIntegration>(() => ({
    getContext: () => contextOf(latest.current.view),
    restoreContext: (request) => {
      if (hasUnsavedChanges()) return false;
      const next = restoredView(latest.current.view, request);
      if (next === null) return false;
      latest.current.view = next;
      latest.current.setView(next);
      return true;
    },
  }));
  return integration;
}

/**
 * The pilot has no editable forms. A host with unsaved edits would report them
 * here, so restoring a thread's view never discards someone's work.
 */
function hasUnsavedChanges(): boolean {
  return false;
}

/** The list scroll position is left out: it is not meaningful context. */
function contextOf(view: PilotView): HostContext {
  if (view.screen.name === "user-list") {
    return { screen: "user-list", viewState: {}, persona: view.persona };
  }
  const viewState: ViewState = { tab: view.tab };
  if (view.dialog !== null) viewState.dialog = view.dialog;
  return { screen: "user-details", viewState, persona: view.persona };
}

/**
 * The view that shows a thread's target, or null if it cannot be shown.
 * Shared feedback keeps the current record when already on its screen;
 * record-specific feedback, or feedback from another screen, shows the
 * original record.
 */
function restoredView(current: PilotView, request: RestoreRequest): PilotView | null {
  const { screen, viewState, recordKey, scope } = request;
  const keepRecord = scope === "shared" && current.screen.name === screen;

  if (screen === "user-details") {
    const userId =
      keepRecord && current.screen.name === "user-details"
        ? current.screen.userId
        : users[userIndexOf(recordKey)]?.id;
    if (userId === undefined) return null;
    return {
      ...current,
      screen: { name: "user-details", userId },
      tab: viewState.tab === "permissions" ? "permissions" : "profile",
      dialog: viewState.dialog === "revoke" ? "revoke" : null,
    };
  }

  if (screen === "user-list") {
    const index = userIndexOf(recordKey);
    if (scope === "record" && recordKey !== null && index === -1) return null;
    // Rows render only when scrolled into view, so reveal the thread's row.
    const listScrollTop =
      keepRecord || index === -1 ? current.listScrollTop : scrollTopRevealing(index, current.listScrollTop);
    return { ...current, screen: { name: "user-list" }, dialog: null, listScrollTop };
  }

  return null;
}
