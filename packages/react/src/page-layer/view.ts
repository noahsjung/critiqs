import type { TargetLocation, ViewState } from "@critiqs/core";
import type { ResolvedContext } from "../host.ts";
import { describeViewState } from "../ui/format.ts";

/** How long Critiqs waits, after the host restores a view, for the app to report it and show the target. */
export const RESTORE_TIMEOUT_MS = 3000;

/**
 * Whether the app reports a thread's saved view state. A key either side lacks
 * counts as null, so state the thread doesn't name, such as an open dialog,
 * means another view. Once `restoreContext` has run, keys the thread lacks
 * entirely are left to the host: the thread was saved before the host reported
 * them, and the host restored its own reading of them. Keys the thread has,
 * null included, must still match.
 */
export function sameViewState(saved: ViewState, current: ViewState, { restored = false }: { restored?: boolean } = {}): boolean {
  const keys = restored ? Object.keys(saved) : new Set([...Object.keys(saved), ...Object.keys(current)]);
  return [...keys].every((key) => (saved[key] ?? null) === (current[key] ?? null));
}

/** Why a thread's target can't be shown in a prototype that doesn't restore views. */
export function notRestoredReason(location: TargetLocation, current: ResolvedContext): string {
  if (location.screen !== current.screen) {
    return `This comment is on ${location.screen}, and this prototype doesn't restore views automatically.`;
  }
  if (!sameViewState(location.viewState, current.viewState)) {
    return `This comment was left in another view (${describeViewState(location.viewState) || "default view"}), and this prototype doesn't restore views automatically.`;
  }
  return "This element isn't in the current view, and this prototype doesn't restore views automatically.";
}

/** Why a restore the host reported as done didn't reach the thread's saved view. */
export function wrongViewReason(location: TargetLocation, current: ResolvedContext): string {
  if (location.screen !== current.screen) return `The prototype didn't open ${location.screen}.`;
  return `The prototype didn't open the saved view (${describeViewState(location.viewState) || "default view"}).`;
}
