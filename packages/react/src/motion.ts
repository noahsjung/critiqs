/** Follow the current target through finite transitions within one deadline, including replacements. */
export async function waitForViewMotion(getCurrent: () => Element | null, signal: AbortSignal, timeoutMs: number): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  const finished = new Set<Promise<Animation>>();
  while (!signal.aborted) {
    if (Date.now() >= deadline) return null;
    const element = getCurrent();
    if (element === null) return null;
    // Flush layout so newly applied CSS transitions are included by getAnimations.
    element.getBoundingClientRect();
    const pending = new Set<Promise<Animation>>();
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      for (const animation of current.getAnimations?.() ?? []) {
        if (animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
          const promise = animation.finished;
          if (!finished.has(promise)) pending.add(promise);
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    if (pending.size === 0) return element;
    if (!await settle(pending, signal, remaining)) return null;
    for (const promise of pending) finished.add(promise);
  }
  return null;
}

function settle(pending: Set<Promise<Animation>>, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.allSettled(pending).then(() => finish(!signal.aborted));
  });
}
