import { locateTarget } from "./anchor.ts";
import type { LocateResult, Scope, Target } from "./types.ts";

/** How often `ready` is checked again, since the app's state can change without a page change. */
const READY_POLL_MS = 50;

/**
 * Waits for a target to appear after the host app restores a view: content may
 * load, dialogs may open, and rows may render only once scrolled into view.
 * With `ready`, a target counts only once `ready` also holds, such as once the
 * app reports the restored view, so a matching element in another view is not
 * taken for it. Resolves with the last result when the target is found or time
 * runs out; callers check `ready` again to tell which condition was missing.
 */
export function waitForTarget(
  target: Target,
  scope: Scope,
  root: Element,
  {
    timeoutMs = 3000,
    signal,
    isCandidate,
    ready,
  }: {
    timeoutMs?: number;
    signal?: AbortSignal;
    isCandidate?: (element: Element) => boolean;
    ready?: () => boolean;
  } = {},
): Promise<LocateResult> {
  return new Promise((resolve) => {
    const isReady = () => ready === undefined || ready();
    let last = locateTarget(target, scope, root, isCandidate);
    if ((last.status === "found" && isReady()) || signal?.aborted) return resolve(last);

    const check = () => {
      last = locateTarget(target, scope, root, isCandidate);
      if (last.status === "found" && isReady()) finish();
    };
    const finish = () => {
      observer.disconnect();
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", finish);
      resolve(last);
    };
    const observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    const poll = ready === undefined ? undefined : setInterval(check, READY_POLL_MS);
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish);
  });
}
