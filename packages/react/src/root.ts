import { createContext, useContext } from "react";

/**
 * Critiqs's own shadow root, as the code that made it passes it in: a closed
 * root, as the browser extension draws in, is hidden from `host.shadowRoot`.
 * And whether keys a page's scripts make up are ignored (`trustedEventsOnly`).
 */
export interface CritiqsRoot {
  shadow: ShadowRoot | null;
  trustedEventsOnly: boolean;
}

export const CritiqsRootContext = createContext<CritiqsRoot>({ shadow: null, trustedEventsOnly: false });

export const useCritiqsRoot = (): CritiqsRoot => useContext(CritiqsRootContext);

/** A key event a page's script made, where only the person's own keys count. */
export function madeUp(event: Event, trustedEventsOnly: boolean): boolean {
  return trustedEventsOnly && event.isTrusted === false;
}

/**
 * The event's composed path as a listener inside `shadow` would see it. A
 * listener outside a closed root, such as one on the window, sees an event
 * from inside start at the root's host; there it started at the element under
 * the pointer, or, for keys, at the root's focused element. Open roots, and
 * events from outside the root, keep the browser's path.
 */
export function eventPath(event: Event, shadow: ShadowRoot | null): EventTarget[] {
  const path = event.composedPath();
  if (shadow === null || shadow.mode !== "closed" || path[0] !== shadow.host) return path;
  const inner = innerTarget(event, shadow);
  if (inner === null) return path;
  const within: EventTarget[] = [];
  for (let node: Node | null = inner; node !== null && node !== shadow; node = node.parentNode) within.push(node);
  return [...within, shadow, ...path];
}

function innerTarget(event: Event, shadow: ShadowRoot): Element | null {
  if (event instanceof MouseEvent && typeof shadow.elementFromPoint === "function") {
    const under = shadow.elementFromPoint(event.clientX, event.clientY);
    if (under !== null && under !== shadow.host) return under;
  }
  return shadow.activeElement;
}
