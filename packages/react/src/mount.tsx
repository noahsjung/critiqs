import type { Root } from "react-dom/client";
import { Connect, mountShadowRoot } from "./connect.tsx";
import { HOST_TAG } from "./constants.ts";
import { PROJECT_ID_PATTERN } from "./deployment.ts";
import { inReviewFrame, type ViewState } from "@critiqs/core";
import type { CritiqsProps, HostContext } from "./host.ts";

/** A mounted Critiqs: change its settings, or remove it and everything it added. */
export interface CritiqsInstance {
  /** Replaces every setting, as a component re-rendered with new properties would. */
  update(options: CritiqsProps): void;
  /**
   * Reports the view the reviewer is on, for apps without a component tree
   * to read it from (server-rendered pages, plain HTML) or that learn it from
   * router events. Each call replaces what was pushed before; `{}` clears it.
   * When `getContext` is also set, each key it reports wins over the pushed
   * one, and pushed keys fill in the rest, view state key by key; the screen
   * still defaults to the URL path.
   */
  setContext(context: HostContext): void;
  /** Removes Critiqs from the page. Later calls to `update` and `setContext` do nothing. */
  destroy(): void;
}

/**
 * Adds Critiqs to the page: its toolbar, sidebar, and pins, above the app in
 * a shadow root on the page's body, with its own sign-in, backend connection,
 * and styles. Its own React root, rather than a portal, keeps events inside
 * Critiqs from bubbling through the host app's components and host contexts
 * from leaking in. With `requireProjectId`, it adds nothing to the page until
 * `projectId` is a valid project ID, and removes everything it added when the
 * ID goes away. In a review link's frame it adds nothing, quietly: the
 * review proxy runs Critiqs's page layer there, for the review page around
 * the frame, and the frame can reach no backend. Runs only in the browser.
 */
export function mountCritiqs(initial: CritiqsProps = {}): CritiqsInstance {
  if (typeof document === "undefined") {
    throw new Error("Critiqs: mountCritiqs runs only in the browser. Call it once the page has loaded, such as in a component's mounted hook.");
  }
  let mounted: { root: Root; host: HTMLElement } | null = null;
  let warned: string | null = null;
  let destroyed = false;
  let options = initial;
  let pushed: HostContext = {};
  let waitingForBody = false;
  // The same function each time, so the document keeps one listener however many Critiqs mount.
  document.addEventListener("turbo:before-render", dropCopiedHosts);

  const unmount = () => {
    if (mounted === null) return;
    const { root, host } = mounted;
    mounted = null;
    // Unmounting a root while a host app is rendering is not allowed; wait a tick.
    setTimeout(() => {
      root.unmount();
      host.remove();
    });
  };

  const render = () => {
    if (destroyed) return;
    if (inReviewFrame()) return unmount();
    const required = options.requireProjectId === true;
    const projectId = required ? requiredProjectId(options.projectId) : options.projectId;
    const active = !required || projectId !== undefined;
    // A value that is set but isn't a project ID is a mistake worth telling the developer about; an unset one is how Critiqs is turned off.
    const malformed = required && !active && typeof options.projectId === "string" && options.projectId.trim() !== "" ? options.projectId : null;
    if (malformed !== warned) {
      warned = malformed;
      if (malformed !== null) {
        console.warn(
          `Critiqs: ${JSON.stringify(malformed.slice(0, 80))} is not a Critiqs project ID, so Critiqs stays hidden. ` +
            "Set this app's project ID setting to the ID from project setup in the Critiqs sidebar, or run npx critiqs doctor.",
        );
      }
    }
    if (!active) {
      unmount();
      return;
    }
    // A script in <head> can run before <body> exists; mount once it does.
    if (mounted === null && document.body === null) {
      if (!waitingForBody) {
        waitingForBody = true;
        document.addEventListener("DOMContentLoaded", () => {
          waitingForBody = false;
          render();
        }, { once: true });
      }
      return;
    }
    mounted ??= mountShadowRoot();
    // A new function on each change, so the interface reads the context again.
    const getContext = combineContext(pushed, options.getContext);
    mounted.root.render(<Connect props={{ ...options, getContext, ...(required ? { projectId } : {}) }} host={mounted.host} />);
  };

  render();
  return {
    update(next) {
      options = next;
      render();
    },
    setContext(context) {
      pushed = { ...context };
      render();
    },
    destroy() {
      unmount();
      destroyed = true;
    },
  };
}

/** Pushed context under what `getContext` reports, key by key; `getContext` itself when nothing was pushed. */
export function combineContext(pushed: HostContext, getContext: CritiqsProps["getContext"]): CritiqsProps["getContext"] {
  if (Object.keys(pushed).length === 0) return getContext;
  if (getContext === undefined) return () => pushed;
  return () => {
    let reported: HostContext = {};
    try {
      reported = getContext() ?? {};
    } catch (error) {
      console.error("Critiqs: getContext failed", error);
    }
    const combined: HostContext = { ...pushed };
    if (reported.screen !== undefined) combined.screen = reported.screen;
    if (reported.persona !== undefined) combined.persona = reported.persona;
    // View state merges key by key too, so route parameters pushed by a router stay beside the app's own tabs and dialogs.
    if (reported.viewState != null) combined.viewState = { ...pushed.viewState, ...definedEntries(reported.viewState) };
    return combined;
  };
}

/** View state without keys whose value is undefined, which a host's getContext may report by mistake. */
function definedEntries(value: ViewState): ViewState {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** A required project ID, trimmed, or undefined when it is missing or isn't a project ID. */
function requiredProjectId(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return PROJECT_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Turbo keeps a copy of each page's body and shows it on Back, or as a
 * preview. A copied host has no shadow root and no Critiqs behind it, so it
 * is taken out of any body Turbo is about to show; the page's own
 * <critiqs-app> mounts a live one. Pages without Turbo never fire the event.
 * (Marking the host `data-turbo-temporary` instead would remove the live
 * Critiqs: Turbo strips those from the page itself before keeping a copy,
 * even when only a frame changes.)
 */
function dropCopiedHosts(event: Event) {
  const body = (event as CustomEvent<{ newBody?: unknown }>).detail?.newBody;
  if (body instanceof Element) for (const host of body.querySelectorAll(HOST_TAG)) host.remove();
}
