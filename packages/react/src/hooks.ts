import { useEffect, useRef, useState } from "react";
import { eventPath } from "./root.ts";

/**
 * Increments whenever the prototype's page changes: elements added or
 * removed, attributes changed, the URL changed, or resizing. Critiqs's own shadow
 * root is not observed. Changes within a frame are combined.
 */
export function usePageVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion((value) => value + 1);
      });
    };
    const observer = new MutationObserver(bump);
    // The whole document, not today's <body>: client routers such as Astro's replace the body on navigation.
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    window.addEventListener("popstate", bump);
    window.addEventListener("hashchange", bump);
    window.addEventListener("resize", bump);
    // pushState and replaceState fire no event, so notice URL changes by checking.
    let href = window.location.href;
    const poll = setInterval(() => {
      if (window.location.href === href) return;
      href = window.location.href;
      bump();
    }, 500);
    return () => {
      clearInterval(poll);
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("popstate", bump);
      window.removeEventListener("hashchange", bump);
      window.removeEventListener("resize", bump);
    };
  }, []);
  return version;
}

/** Calls `read` every frame while active and re-renders when its result changes. */
export function useFrameValue<T>(read: () => T, active: boolean, equal: (a: T, b: T) => boolean): T {
  const [value, setValue] = useState(read);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      const next = readRef.current();
      setValue((previous) => (equal(previous, next) ? previous : next));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [active, equal]);
  return value;
}

/** Stores a small JSON value in this site's local storage. */
export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const read = (): T => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  };
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: read() }));
  // Another key, such as another project's, reads its own stored value.
  const value = state.key === key ? state.value : read();
  if (state.key !== key) setState({ key, value });
  const store = (next: T) => {
    // Storing the same value again changes nothing, as with useState, so an effect that stores it doesn't render again.
    setState((current) => (current.key === key && Object.is(current.value, next) ? current : { key, value: next }));
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage may be unavailable; the value still applies to this page.
    }
  };
  return [value, store];
}

/**
 * Whether keyboard input is going to a text field, so shortcuts stay out of
 * the way. `shadow` is Critiqs's own root, which a listener outside a closed
 * root can't see into on its own.
 */
export function isTyping(event: KeyboardEvent, shadow: ShadowRoot | null = null): boolean {
  const target = eventPath(event, shadow)[0];
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** Today's UTC day as `YYYY-MM-DD`, changing at UTC midnight. */
export function useUtcDay(): string {
  const today = () => new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(today);
  useEffect(() => {
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const timer = setTimeout(() => setDay(today()), midnight - now.getTime() + 1000);
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}

/**
 * Ctrl or Cmd with \ (or |, as Shift turns it on many keyboards): hides or
 * shows Critiqs. Matched by the physical key first, so other layouts work.
 */
export function isHideShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey)) return false;
  return event.code === "Backslash" || event.key === "\\" || event.key === "|";
}
