import { expect, test } from "bun:test";
import { internal } from "../convex/_generated/api";
import { setup } from "./harness";

test("cleanup removes every expired sign-in attempt, beyond one batch", async () => {
  const t = setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 501; i++) {
      await ctx.db.insert("signInAttempts", {
        key: `k${i}`,
        origin: "https://proto.example",
        clientState: "s",
        bindingHash: "b",
        createdAt: 0,
      });
    }
  });
  await t.mutation(internal.signIn.cleanUp, {});
  await t.finishAllScheduledFunctions(() => {});
  expect(await t.run((ctx) => ctx.db.query("signInAttempts").collect())).toEqual([]);
});
