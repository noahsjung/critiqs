// In-memory limits for one proxy process: how many upstream reads run at once
// (per lease and in all), and how many requests and bytes a lease may use per
// window. Nothing waits in a queue: past a limit a request is refused at once.
// Per-account, per-link and creation limits live in the backend; these keep
// one process and one lease from being overrun between its reports.

export interface Slots {
  /** A slot, or null when all are taken. Releasing twice is harmless. */
  take(): (() => void) | null;
  readonly used: number;
}

export function slots(max: number): Slots {
  let used = 0;
  return {
    take() {
      if (used >= max) return null;
      used++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        used--;
      };
    },
    get used() {
      return used;
    },
  };
}

/** Slots per key, each key with `max`; keys with nothing in use are forgotten. */
export function keyedSlots(max: number): { take(key: string): (() => void) | null; used(key: string): number } {
  const byKey = new Map<string, Slots>();
  return {
    take(key) {
      const group = byKey.get(key) ?? slots(max);
      byKey.set(key, group);
      const release = group.take();
      if (release === null) {
        if (group.used === 0) byKey.delete(key);
        return null;
      }
      return () => {
        release();
        if (group.used === 0 && byKey.get(key) === group) byKey.delete(key);
      };
    },
    used: (key) => byKey.get(key)?.used ?? 0,
  };
}

export interface WindowLimits {
  windowMs: number;
  requests: number;
  bytes: number;
}

/**
 * Requests and bytes per key in fixed windows. `admit` counts a request and
 * says whether it is within both limits; `addBytes` counts bytes served. At
 * most `maxKeys` keys are kept; the oldest window goes first.
 */
export function windowCounter(limits: WindowLimits, now: () => number = Date.now, maxKeys = 100_000) {
  const windows = new Map<string, { start: number; requests: number; bytes: number }>();
  const current = (key: string) => {
    const time = now();
    let entry = windows.get(key);
    if (entry === undefined || time - entry.start >= limits.windowMs) {
      windows.delete(key);
      entry = { start: time, requests: 0, bytes: 0 };
      windows.set(key, entry);
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
    }
    return entry;
  };
  return {
    admit(key: string): boolean {
      const entry = current(key);
      if (entry.requests >= limits.requests || entry.bytes >= limits.bytes) return false;
      entry.requests++;
      return true;
    },
    addBytes(key: string, bytes: number): void {
      current(key).bytes += bytes;
    },
    usage(key: string): { requests: number; bytes: number } {
      const entry = windows.get(key);
      return entry === undefined || now() - entry.start >= limits.windowMs ? { requests: 0, bytes: 0 } : { requests: entry.requests, bytes: entry.bytes };
    },
  };
}

export type WindowCounter = ReturnType<typeof windowCounter>;
