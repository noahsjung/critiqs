import { expect, test } from "bun:test";
import type * as Real from "@critiqs/server/http";
import type * as Published from "../src/server.d.ts";

// The published types are written by hand; they must stay interchangeable with the real ones.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const options: Same<Omit<Published.CritiqsHandlerOptions, "database">, Omit<Real.CritiqsHandlerOptions, "database" | "mailer" | "aiModel">> = true;
const user: Same<Published.HostUser, Real.HostUser> = true;
const ai: Same<Published.CritiqsAiOptions, Real.CritiqsAiOptions> = true;
const handler: Same<Omit<Published.CritiqsHandler, never>, Omit<Real.CritiqsHandler, "store">> = true;

test("critiqs-react/server's published types match the server", () => {
  expect([options, user, ai, handler]).toEqual([true, true, true, true]);
});
