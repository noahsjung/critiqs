// Stands in for the shared `critiqs` package: records what Critiqs would be
// told. The route helpers are the shared package's own, from its source, so
// the tests don't need it built.
import { mock } from "bun:test";
import type { CritiqsOptions, HostContext } from "critiqs";
import * as SharedRouter from "../../critiqs/src/router.ts";

const { ROUTE_PARAM_PREFIX, routeContext, routePath } = SharedRouter;
mock.module("critiqs/router", () => SharedRouter);

export type Call = ["mount" | "update", CritiqsOptions] | ["setContext", HostContext] | ["destroy"];
export const calls: Call[] = [];
export const loads = { count: 0 };

mock.module("critiqs", () => {
  loads.count++;
  return {
    ROUTE_PARAM_PREFIX,
    routeContext,
    routePath,
    mountCritiqs(options: CritiqsOptions) {
      calls.push(["mount", options]);
      return {
        update: (next: CritiqsOptions) => calls.push(["update", next]),
        setContext: (context: HostContext) => calls.push(["setContext", context]),
        destroy: () => calls.push(["destroy"]),
      };
    },
  };
});

/** The settings Critiqs was last given. */
export function lastOptions(): CritiqsOptions {
  const last = calls.findLast((call) => call[0] === "mount" || call[0] === "update");
  if (last === undefined) throw new Error("Critiqs was never started.");
  return last[1] as CritiqsOptions;
}

/** The contexts pushed with setContext, in order. */
export const pushed = () => calls.filter((call) => call[0] === "setContext").map((call) => call[1]);

/** Waits for Solid's effects, the router, and the dynamic import, as many turns as they take. */
export async function settle(flush?: () => void, turns = 5) {
  for (let i = 0; i < turns; i++) {
    flush?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
