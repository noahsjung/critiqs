"use node";

import { deliverOne, resendMailer, sendPlanAlert } from "@critiqs/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { linkSecret } from "./lib/links";
import { r2Config, r2Storage } from "./lib/r2";

// The mention email worker. It runs in Convex's Node runtime, whose actions
// have 512 MiB of memory: an email may carry a whole long discussion and a
// 10 MiB capture, up to the mail service's 40 MB, which the default runtime's
// 64 MiB could not hold alongside its copies.

/** Notifications one worker run takes on. */
const BATCH = 25;
/** Steps of queuing reply emails one run takes; a run that uses them all runs again at once. */
const MAX_REPLY_EMAIL_STEPS = 200;

/** Sends due mention emails, then runs again while more are waiting. */
export const deliver = internalAction({
  args: {},
  handler: async (ctx) => {
    // Replies' emails to everyone in their threads are queued first, a step per transaction; they are due a minute after each reply, like mentions.
    let moreReplies = false;
    for (let step = 0; step < MAX_REPLY_EMAIL_STEPS; step++) {
      moreReplies = await ctx.runMutation(internal.notifications.replyEmailStep, {});
      if (!moreReplies) break;
    }
    // Each run holds what it claims under its own token, so a run that outlives its lease can't overwrite another's work.
    const claimToken = crypto.randomUUID();
    const ids = await ctx.runMutation(internal.notifications.claim, { claimToken, limit: BATCH });
    if (ids.length === 0) {
      if (moreReplies) await ctx.scheduler.runAfter(0, internal.notificationEmails.deliver, {});
      return;
    }
    const secret = await linkSecret(ctx);
    type Outcome = { deliveryId: Id<"deliveries">; result: "sent" | "skipped" | "failed"; reason?: string };
    const outcomes: Outcome[] = [];
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.CRITIQS_EMAIL_FROM;
    for (const id of ids) {
      if (!apiKey || !from) {
        outcomes.push({ deliveryId: id, result: "skipped", reason: "Email isn't set up for this deployment." });
        continue;
      }
      const mailer = resendMailer({ apiKey, from });
      // Prepared emails are private files: captures are attached, never linked, since Convex storage links open for anyone who has them.
      const outcome = await deliverOne({
        begin: () => ctx.runQuery(internal.notifications.begin, { id, claimToken, secret }),
        page: ({ version, cursor }) => ctx.runQuery(internal.notifications.page, { id, claimToken, version, cursor }),
        stillMentions: (messageId) => ctx.runQuery(internal.notifications.mentioned, { id, claimToken, messageId: messageId as Id<"messages"> }),
        freeze: ({ version, fileId, to }) =>
          ctx.runMutation(internal.notifications.freeze, { id, claimToken, version, fileId: fileId as Id<"_storage">, to }),
        readFile: async (fileId) => {
          const location = await ctx.runQuery(internal.captures.fileLocation, { fileId: fileId as Id<"_storage"> | Id<"captureFiles"> });
          if (location === null) return await ctx.storage.get(fileId as Id<"_storage">);
          if (location.status !== "attached") return null;
          const response = await r2Storage(r2Config()).get(location);
          return response === null ? null : await response.blob();
        },
        saveFile: (body) => ctx.storage.store(body),
        deleteFile: async (fileId) => void (await ctx.runMutation(internal.notifications.removeFile, { fileId: fileId as Id<"_storage"> })),
        sendPrepared: (body, idempotencyKey) => mailer.sendPrepared!(body, idempotencyKey),
        sendMessage: (message) => mailer.send(message),
      });
      if (outcome !== null) outcomes.push({ deliveryId: id, ...outcome });
    }
    await ctx.runMutation(internal.notifications.complete, { claimToken, outcomes });
    if (ids.length === BATCH || moreReplies) await ctx.scheduler.runAfter(0, internal.notificationEmails.deliver, {});
  },
});

/** Sends due alert emails to organizations' admins about their Critiqs AI credits. */
export const deliverPlanAlerts = internalAction({
  args: {},
  handler: async (ctx) => {
    const claimToken = crypto.randomUUID();
    const ids = await ctx.runMutation(internal.planAlerts.claim, { claimToken, limit: BATCH });
    if (ids.length === 0) return;
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.CRITIQS_EMAIL_FROM;
    const mailer = apiKey && from ? resendMailer({ apiKey, from }) : null;
    const outcomes = [];
    for (const id of ids) {
      const messages = await ctx.runQuery(internal.planAlerts.emails, { id: id as Id<"planAlerts">, claimToken });
      if (messages !== null) outcomes.push({ id: id as Id<"planAlerts">, ...(await sendPlanAlert(mailer, messages)) });
    }
    await ctx.runMutation(internal.planAlerts.complete, { claimToken, outcomes });
    if (ids.length === BATCH) await ctx.scheduler.runAfter(0, internal.notificationEmails.deliverPlanAlerts, {});
  },
});
