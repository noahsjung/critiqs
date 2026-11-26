import { MailError, resendMailer } from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { emailConfigured } from "./lib/email";

/**
 * Emails a new invite once. A deployment without email, or a failed send,
 * leaves the invite waiting: the person still joins when they sign in with
 * the invited address.
 */
export const sendInvite = internalAction({
  args: { inviteId: v.id("invites"), projectId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    if (!emailConfigured()) return;
    const apiKey = process.env.RESEND_API_KEY!;
    const from = process.env.CRITIQS_EMAIL_FROM!;
    const message = await ctx.runMutation(internal.organizations.claimInviteEmail, args);
    if (message === null) return;
    try {
      await resendMailer({ apiKey, from }).send(message);
    } catch (error) {
      if (!(error instanceof MailError)) throw error;
      console.error("Critiqs couldn't send an invite email:", error.message);
    }
  },
});
