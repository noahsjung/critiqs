/**
 * Makes `composedPath()` leave out what's inside a closed shadow root for a
 * listener outside it, as browsers do and happy-dom doesn't: a window
 * listener then sees an event from inside Critiqs's closed root start at its
 * host. Returns a function that puts the original back.
 */
export function hideClosedShadowTrees(): () => void {
  const original = Event.prototype.composedPath;
  Event.prototype.composedPath = function (this: Event) {
    const path = original.call(this);
    const current = this.currentTarget;
    // happy-dom reads the path itself, outside any listener, to find the target.
    if (current === null) return path;
    // The shadow roots the listener's own node is inside, which it may see into.
    const seen = new Set<Node>();
    for (let node = current instanceof Node ? current : null; node !== null; ) {
      const root = node.getRootNode();
      seen.add(root);
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return path.filter((target) => {
      for (let node = target instanceof Node ? target : null; node !== null; ) {
        const root = node.getRootNode();
        if (root instanceof ShadowRoot && root.mode === "closed" && !seen.has(root)) return false;
        node = root instanceof ShadowRoot ? root.host : null;
      }
      return true;
    });
  };
  return () => {
    Event.prototype.composedPath = original;
  };
}

/** Events a page's script makes: browsers mark them untrusted; happy-dom marks none. */
export function madeUp<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: false });
  return event;
}

/** Events from the person's own keyboard and mouse. */
export function real<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}
