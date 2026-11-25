import type { Scope, ViewState } from "@critiqs/core";

/** What the prototype reports about the view a reviewer is looking at. */
export interface HostContext {
  /** Logical page, such as `user-details`. Defaults to the URL path. */
  screen?: string;
  /**
   * Tab, dialog, step, or filters needed to reveal elements. Report each key
   * whenever its part of the app is shown, with null when nothing is open, so
   * every thread names its whole view. A key an older thread lacks is left to
   * `restoreContext` once it has run.
   */
  viewState?: ViewState;
  /** Demo person or role shown in the prototype. Context only, never the author. */
  persona?: string | null;
}

/** Asks the prototype to show a thread's view again. */
export interface RestoreRequest {
  threadId: string;
  screen: string;
  viewState: ViewState;
  /** Record the target belongs to. Shared feedback may keep the current record. */
  recordKey: string | null;
  scope: Scope;
  /**
   * Aborted when the reviewer moves on (another thread, Back, sign-out). A
   * host that restores asynchronously should stop navigating once aborted.
   */
  signal: AbortSignal;
}

export interface CritiqsProps {
  /**
   * The Critiqs project for this prototype. Without it, the sidebar shows
   * project setup, unless `requireProjectId` is set.
   */
  projectId?: string | undefined;
  /**
   * Show Critiqs only where `projectId` is a valid project ID, such as one read
   * from a deployment's environment variable. Without one, Critiqs renders
   * nothing, contacts no backend, and never uses a project remembered in the
   * browser. Problems with the configured project are reported in the browser
   * console rather than shown to visitors.
   */
  requireProjectId?: boolean;
  /** A team's own Convex deployment URL. Defaults to Critiqs's hosted service. */
  backend?: string;
  /** Prototype version, such as a release label or Git commit, recorded with each message. */
  version?: string;
  /** Reports the current screen, view state, and demo persona. */
  getContext?: () => HostContext;
  /**
   * Shows a thread's view: navigate, select tabs, open dialogs, and scroll
   * rows into view, under the current reviewer's access. Return `false` when
   * the view cannot be shown, for example to protect unsaved work. Called
   * unless `getContext` already reports the thread's screen and view state.
   * Afterwards Critiqs waits up to three seconds for `getContext` to report
   * them and for the target to appear; return a promise to wait for slower
   * content first. Never replay clicks that could submit or change data.
   */
  restoreContext?: (request: RestoreRequest) => void | boolean | Promise<void | boolean>;
}

export interface ResolvedContext {
  screen: string;
  viewState: ViewState;
  persona: string | null;
}

export function readContext(getContext: CritiqsProps["getContext"]): ResolvedContext {
  let reported: HostContext = {};
  try {
    reported = getContext?.() ?? {};
  } catch (error) {
    console.error("Critiqs: getContext failed", error);
  }
  return {
    screen: reported.screen ?? window.location.pathname,
    viewState: reported.viewState ?? {},
    persona: reported.persona ?? null,
  };
}
