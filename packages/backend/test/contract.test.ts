import { defineContract, type ContractBackend } from "@critiqs/server/contract";
import { defineAiContract } from "@critiqs/server/contract-ai";
import { defineDeveloperEmailContract, defineOnboardingContract } from "@critiqs/server/contract-onboarding";
import type { Plan } from "@critiqs/server";
import { afterEach } from "bun:test";
import type { Id } from "../convex/_generated/dataModel";
import { convexStore } from "../convex/lib/store";
import { setup } from "./harness";

afterEach(() => {
  delete process.env.CRITIQS_PLANS;
});

function convexBackend(plans?: Record<string, Plan>): ContractBackend {
  // Convex's per-transaction limits apply, as on a deployment.
  const t = setup({ limits: true });
  const ready =
    plans === undefined
      ? Promise.resolve()
      : t.run(async (ctx) => {
          for (const plan of Object.values(plans)) await ctx.db.insert("plans", plan);
        });
  // Critiqs Cloud turns plans on for its whole deployment.
  const withEnv = async <T,>(work: () => Promise<T>) => {
    await ready;
    if (plans !== undefined) process.env.CRITIQS_PLANS = "enabled";
    else delete process.env.CRITIQS_PLANS;
    return await work();
  };
  return {
    recordsContentType: false,
    run: (operation) => withEnv(() => t.run((ctx) => operation(convexStore(ctx)))),
    saveFile: (contentType, bytes = 64) =>
      withEnv(() => t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)], contentType === null ? {} : { type: contentType })))),
    storeFile: (data) => withEnv(() => t.run((ctx) => ctx.storage.store(data))),
    readFile: async (fileId) => {
      const bytes = await t.run(async (ctx) => (await (await ctx.storage.get(fileId as Id<"_storage">))?.arrayBuffer()) ?? null);
      return bytes === null ? null : new Blob([bytes]);
    },
    withPlans: (next) => convexBackend(next),
    changePlans: async (next) => {
      await t.run(async (ctx) => {
        for (const plan of await ctx.db.query("plans").collect()) await ctx.db.delete(plan._id);
        for (const plan of Object.values(next)) await ctx.db.insert("plans", plan);
      });
    },
  };
}

defineContract("Convex", () => convexBackend());
defineAiContract("Convex", () => convexBackend());
defineOnboardingContract("Convex", () => convexBackend());
defineDeveloperEmailContract("Convex", () => convexBackend());
