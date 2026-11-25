import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

/** The key that signs mute and unsubscribe links, generated once per deployment so it needs no setup. */
export async function linkSecret(ctx: Pick<ActionCtx, "runQuery" | "runMutation">): Promise<string> {
  const existing = await ctx.runQuery(internal.notifications.secretValue, {});
  if (existing !== null) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return await ctx.runMutation(internal.notifications.saveSecret, {
    value: btoa(String.fromCharCode(...bytes)),
  });
}
