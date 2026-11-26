import { expect, test } from "bun:test";
import type * as Real from "@critiqs/server/http";
import type * as Published from "../src/server.d.ts";

// The published types are written by hand; they must stay interchangeable with the real ones.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Test-only options (`mailer`, `aiModel`, `aiFetch`, and the address check's fake network) stay out of the published types.
const options: Same<Omit<Published.CritiqsHandlerOptions, "database" | "addressCheck">, Omit<Real.CritiqsHandlerOptions, "database" | "mailer" | "aiModel" | "aiFetch" | "addressCheck">> = true;
// Optional properties don't affect assignability, so compare the option names too: a server option the published types forgot fails here.
const optionNames: Same<keyof Published.CritiqsHandlerOptions, Exclude<keyof Real.CritiqsHandlerOptions, "mailer" | "aiModel" | "aiFetch">> = true;
const addressCheck: Same<Published.CritiqsHandlerOptions["addressCheck"], false | undefined> = true;
const user: Same<Published.HostUser, Real.HostUser> = true;
const ai: Same<Published.CritiqsAiOptions, Real.CritiqsAiOptions> = true;
const handler: Same<Omit<Published.CritiqsHandler, never>, Omit<Real.CritiqsHandler, "store">> = true;

test("critiqs/server's published types match the server", () => {
  expect([options, optionNames, addressCheck, user, ai, handler]).toEqual([true, true, true, true, true, true]);
});
