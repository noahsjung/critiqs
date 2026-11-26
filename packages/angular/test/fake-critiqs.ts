// Stands in for the `critiqs` module, recording each call and whether it ran in Angular's zone.
import { mock } from "bun:test";
import type { CritiqsOptions, HostContext } from "critiqs";

export interface Call {
  method: "mount" | "update" | "setContext" | "destroy";
  options?: CritiqsOptions;
  context?: HostContext;
  inZone: boolean;
}

export const calls: Call[] = [];
const inZone = () => (globalThis as { Zone?: { current: { name: string } } }).Zone?.current.name === "angular";

const critiqs = await import("critiqs");

// The real route helpers; only mounting is faked.
mock.module("critiqs", () => ({
  routeContext: critiqs.routeContext,
  routePath: critiqs.routePath,
  mountCritiqs(options: CritiqsOptions) {
    calls.push({ method: "mount", options, inZone: inZone() });
    return {
      update: (next: CritiqsOptions) => calls.push({ method: "update", options: next, inZone: inZone() }),
      setContext: (context: HostContext) => calls.push({ method: "setContext", context, inZone: inZone() }),
      destroy: () => calls.push({ method: "destroy", inZone: inZone() }),
    };
  },
}));

/** Resolves once `count` calls have been recorded, or fails after a second. */
export async function waitForCalls(count: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (calls.length < count) {
    if (Date.now() > deadline) throw new Error(`Expected ${count} calls, got ${JSON.stringify(calls.map((call) => call.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
