// In-memory limits for one proxy process: how many upstream reads run at once
// (per lease and in all), and how many requests and bytes a lease may use per
// window. A read with no room waits its turn in a bounded line for a bounded
// time (`slotLine`); past a window's count a request is refused at once.
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

/** A slot to take now, or null when its pool is full. */
export type Claim = () => (() => void) | null;

interface Waiter {
  claims: readonly Claim[];
  line: string;
  done: (release: (() => void) | null) => void;
}

/**
 * Reads that need a slot in several pools at once (the process, a link, an
 * upstream host, a lease), all or none. One that can't have them all now
 * waits, first come first served, until every pool has room: each release
 * hands its room to the oldest waiter that can now take all of its slots. A
 * wait ends after `timeoutMs`, or when `signal` aborts, with null. At most
 * `maxPerLine` reads wait per line (a lease) and `maxWaiting` in all; past
 * either a read gets null at once. The pools' own sizes are the shares: a
 * line only decides who goes next, never how many run.
 */
export function slotLine(options: { maxWaiting: number; maxPerLine: number }) {
  const waiting: Waiter[] = [];
  const perLine = new Map<string, number>();
  const takeAll = (claims: readonly Claim[]): (() => void) | null => {
    const taken: (() => void)[] = [];
    for (const claim of claims) {
      const release = claim();
      if (release === null) {
        for (const undo of taken) undo();
        return null;
      }
      taken.push(release);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of taken) release();
      pump();
    };
  };
  const leave = (waiter: Waiter) => {
    const index = waiting.indexOf(waiter);
    if (index === -1) return false;
    waiting.splice(index, 1);
    const count = (perLine.get(waiter.line) ?? 1) - 1;
    if (count === 0) perLine.delete(waiter.line);
    else perLine.set(waiter.line, count);
    return true;
  };
  function pump() {
    for (let index = 0; index < waiting.length; ) {
      const waiter = waiting[index]!;
      const release = takeAll(waiter.claims);
      if (release === null) {
        index++;
        continue;
      }
      leave(waiter);
      waiter.done(release);
    }
  }
  return {
    /** Every claim's slot, as one release; null when the wait ran out, was aborted, or the line was full. */
    async take(claims: readonly Claim[], line: string, timeoutMs: number, signal: AbortSignal): Promise<(() => void) | null> {
      const now = takeAll(claims);
      if (now !== null) return now;
      if (signal.aborted || timeoutMs <= 0 || waiting.length >= options.maxWaiting || (perLine.get(line) ?? 0) >= options.maxPerLine) return null;
      return await new Promise<(() => void) | null>((resolve) => {
        const giveUp = () => {
          if (!leave(waiter)) return;
          clearTimeout(timer);
          signal.removeEventListener("abort", giveUp);
          resolve(null);
        };
        const waiter: Waiter = {
          claims,
          line,
          done: (release) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", giveUp);
            resolve(release);
          },
        };
        const timer = setTimeout(giveUp, timeoutMs);
        signal.addEventListener("abort", giveUp, { once: true });
        waiting.push(waiter);
        perLine.set(line, (perLine.get(line) ?? 0) + 1);
      });
    },
    /** Reads waiting now, for tests and health checks. */
    get waiting() {
      return waiting.length;
    },
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
