import {
  claimAddressCheck as claimAddressCheckOp,
  DEFAULT_WEB_URL,
  deliverDeveloperEmail as deliver,
  fail,
  getDeveloperSetup,
  getProjectSetup,
  listDeveloperSends,
  prepareDeveloperEmail as prepare,
  recordDeveloperEmail as record,
  REPORT_PATH,
  reportToken,
  reportUnwantedEmail as report,
  reserveDeveloperSends,
  resendMailer,
  saveAboutYou as saveAboutYouOp,
  setupUrl,
  webBase,
} from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { linkSecret } from "./lib/links";
import { convexStore, identityOf, run } from "./lib/store";

// Onboarding on the Critiqs website. The address check fetches in
// `addressCheck:check`, a Node action; each check is counted here first.

/** Requires sign-in and counts one address check against the hourly limits. */
export const claimAddressCheck = internalMutation({
  args: {},
  handler: async (ctx) => run(async () => claimAddressCheckOp(convexStore(ctx), await identityOf(ctx), Date.now())),
});

/** Saves the signed-in person's "About you" answers. Unknown values are dropped; a skipped answer changes nothing. */
export const saveAboutYou = mutation({
  args: { role: v.optional(v.string()), teamSize: v.optional(v.string()) },
  handler: async (ctx, args) => run(async () => saveAboutYouOp(convexStore(ctx), await identityOf(ctx), args)),
});

// Developer setup emails. `CRITIQS_WEB_URL` names the Critiqs website that
// setup links open; unset, it is https://critiqs.app. Without Resend
// (`RESEND_API_KEY`, `CRITIQS_EMAIL_FROM`) or with an invalid website
// address, nothing is reserved and the call says setup emails are unavailable.

/** The website setup links start with, or null when setup emails can't go out. */
export function developerEmailSetup(): { apiKey: string; from: string; web: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CRITIQS_EMAIL_FROM;
  const web = webBase(process.env.CRITIQS_WEB_URL, DEFAULT_WEB_URL);
  return apiKey && from && web !== null ? { apiKey, from, web } : null;
}

/** Pauses before retrying an email whose result never arrived, under its own key, well within the mail service's 24 hours for one. */
const RETRY_DELAYS_MS = [60_000, 10 * 60_000];

/**
 * Emails a project's setup steps to up to three developers, for the people
 * who manage it, with a result for each address. Limits are checked and
 * counted, and each email reserved, in this transaction; the emails go out
 * right after, from `deliverDeveloperEmail`.
 */
export const sendDeveloperSetup = mutation({
  args: { projectId: v.string(), emails: v.array(v.string()) },
  handler: async (ctx, args) =>
    run(async () => {
      if (developerEmailSetup() === null) fail("unavailable", "This deployment can't send setup emails. Copy the message instead.");
      const { results, reserved } = await reserveDeveloperSends(convexStore(ctx), await identityOf(ctx), args, Date.now());
      for (const { sendId, idempotencyKey } of reserved) {
        await ctx.scheduler.runAfter(0, internal.onboarding.deliverDeveloperEmail, { sendId: sendId as Id<"developerSends">, idempotencyKey, attempt: 0 });
      }
      return results;
    }),
});

/** What a setup link shows the developer it was sent to: the project, address, stack, install commands, and who asked. */
export const developerSetup = query({
  args: { sendId: v.string() },
  handler: async (ctx, args) => run(async () => getDeveloperSetup(convexStore(ctx), await identityOf(ctx), args)),
});

/** What a copied message's setup page shows: the project, its address, and install commands, for anyone signed in, as `projects:get`; its saved stack only for the people who manage it. */
export const projectSetup = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => run(async () => getProjectSetup(convexStore(ctx), await identityOf(ctx), args)),
});

/** Who a project sent setup steps to, and each email's state; for the people who manage it. */
export const developerSends = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => run(async () => listDeveloperSends(convexStore(ctx), await identityOf(ctx), args)),
});

/** Sends one reserved email under its key, retrying an unknown result under the same key. */
export const deliverDeveloperEmail = internalAction({
  args: { sendId: v.id("developerSends"), idempotencyKey: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    const setup = developerEmailSetup();
    if (setup === null) return;
    const { sendId, idempotencyKey } = args;
    const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
    const reportUrl = `${site}${REPORT_PATH}?token=${encodeURIComponent(await reportToken(await linkSecret(ctx), sendId))}`;
    const outcome = await deliver({
      prepare: () => ctx.runMutation(internal.onboarding.prepareDeveloperEmail, { sendId, idempotencyKey, setupUrl: setupUrl(setup.web, sendId), reportUrl }),
      send: (message) => resendMailer({ apiKey: setup.apiKey, from: setup.from }).send(message),
      record: (attempt, answer) => ctx.runMutation(internal.onboarding.recordDeveloperEmail, { sendId, idempotencyKey, attempt, answer }),
    });
    const delay = RETRY_DELAYS_MS[args.attempt];
    if (outcome === "uncertain" && delay !== undefined) {
      await ctx.scheduler.runAfter(delay, internal.onboarding.deliverDeveloperEmail, { ...args, attempt: args.attempt + 1 });
    }
  },
});

/** Claims an attempt at the reserved email, as first prepared; null when it isn't waiting to be tried. */
export const prepareDeveloperEmail = internalMutation({
  args: { sendId: v.string(), idempotencyKey: v.string(), setupUrl: v.string(), reportUrl: v.string() },
  handler: async (ctx, args) => await prepare(convexStore(ctx), args, Date.now()),
});

/** Records the mail service's answer to one attempt at an email. */
export const recordDeveloperEmail = internalMutation({
  args: { sendId: v.string(), idempotencyKey: v.string(), attempt: v.number(), answer: v.union(v.literal("accepted"), v.literal("refused")) },
  handler: async (ctx, args) => await record(convexStore(ctx), args),
});

/** Stops Critiqs's email to a reported send's inbox, once the person confirms the report link. */
export const reportUnwantedEmail = internalMutation({
  args: { sendId: v.string() },
  handler: async (ctx, args) => await report(convexStore(ctx), args, Date.now()),
});
