import type { BillingChange, BillingStatus } from "@critiqs/core";
import { assignPlan, DEFAULT_PLAN, fail, operations, planFor, planIncludes, setExtraStorage } from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalAction, internalMutation, internalQuery, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { type Autumn, autumn, billingFailure } from "./lib/autumn";
import {
  type AutumnCustomer,
  type BillingConfig,
  billingConfig,
  billingStateOf,
  billingStatusOf,
  leavingAtPeriodEnd,
  type PlanChange,
  planChange,
  pricesOf,
  requireShownPlan,
  retryAt,
  returnAddress,
  STORAGE_ADD_ON,
  sendableAt,
  renewingStorageOf,
  storageAddOnsOf,
  TOO_LATE_TO_SEND,
} from "./lib/billing";
import { convexStore, identityOf, run } from "./lib/store";
import { billingPricesValidator } from "./lib/validators";

// Critiqs Cloud takes payment through Autumn, which runs Stripe; Autumn's
// customer for an organization has the organization's ID. Autumn holds prices
// and subscriptions, Critiqs keeps enforcing every limit itself. An
// organization's admins buy or change its plan, the storage add-on, and their
// payment details; Autumn tells Critiqs what changed through its webhook
// (`/critiqs/billing/autumn` in `http.ts`), and a daily check catches anything
// a webhook missed. Critiqs AI credits paying organizations use are reported
// as soon as they are recorded, and again each minute until Autumn has them.
// All of it is off unless `CRITIQS_BILLING=autumn` and
// `AUTUMN_SECRET_KEY` are set.

const plan = v.union(v.literal("free"), v.literal("plus"), v.literal("pro"));
const state = v.object({
  plan,
  pastDue: v.boolean(),
  currentPeriodEnd: v.union(v.number(), v.null()),
  cancelAtPeriodEnd: v.boolean(),
  scheduledPlan: v.union(plan, v.null()),
  storageUnits: v.number(),
  storageRenewing: v.number(),
  storageEnding: v.optional(v.array(v.union(v.number(), v.null()))),
});

/** How long one billing change holds its organization; a second click meanwhile is refused instead of reaching Autumn twice. */
const BUSY_MS = 30_000;

/** Why a change that would charge the card on file is refused while Plan and billing can't show what it costs. */
const PRICES_UNSHOWN = "Prices can't be shown right now, so plan changes are paused. Try again shortly.";

function requireBilling(): BillingConfig {
  const config = billingConfig();
  if (config === null) fail("unavailable", "This deployment doesn't take payment.");
  return config;
}

async function accountOf(ctx: QueryCtx, organizationId: Id<"organizations">): Promise<Doc<"billingAccounts"> | null> {
  return await ctx.db
    .query("billingAccounts")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
}

/** An organization's plan and subscription, for its members; null on deployments that don't take payment. */
export const status = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args): Promise<BillingStatus | null> =>
    run(async () => {
      if (billingConfig() === null) return null;
      const store = convexStore(ctx);
      const { user } = await operations.currentReviewer(store, await identityOf(ctx));
      const id = ctx.db.normalizeId("organizations", args.organizationId);
      const organization = id === null ? null : await ctx.db.get(id);
      const membership = organization === null || user === null ? null : await store.memberships.find(organization._id, user._id);
      if (organization === null || membership === null) fail("forbidden", "Only members of the organization can see its plan.");
      const current = (await planFor(store, organization))?.name ?? organization.plan ?? DEFAULT_PLAN;
      const prices = (await ctx.db.query("billingPrices").first())?.prices ?? null;
      const plans = { free: await planIncludes(store, "free"), plus: await planIncludes(store, "plus"), pro: await planIncludes(store, "pro") };
      return billingStatusOf((await accountOf(ctx, organization._id))?.state ?? null, current, membership.role === "admin", prices, plans);
    }),
});

/** How often the page may ask for prices while none have been read. */
const ASK_FOR_PRICES_MS = 60_000;

/**
 * Reads Critiqs Cloud's prices from Autumn's catalog and keeps them to show.
 * When the catalog can't be read, or lacks a plan or price, the prices last
 * read stay: a stale price is better than a wrong one, and none is shown
 * until one is read.
 */
async function readPrices(ctx: ActionCtx, config: BillingConfig) {
  const readAt = Date.now();
  let catalog: unknown[];
  try {
    catalog = await autumn(config).listPlans();
  } catch (error) {
    console.error("Autumn's catalog couldn't be read:", error instanceof Error ? error.message : String(error));
    return;
  }
  const prices = pricesOf(catalog);
  if (prices === null) {
    console.error("Autumn's catalog lacks a plan or monthly price that Plan and billing shows (free, plus, pro, storage_100gb); keeping the prices last read.");
    return;
  }
  await ctx.runMutation(internal.billing.storePrices, { prices, readAt });
}

export const storePrices = internalMutation({
  args: { prices: billingPricesValidator, readAt: v.number() },
  handler: async (ctx, { prices, readAt }) => {
    const row = await ctx.db.query("billingPrices").first();
    if (row === null) await ctx.db.insert("billingPrices", { prices, readAt });
    else if (row.readAt === undefined || row.readAt <= readAt) await ctx.db.patch(row._id, { prices, readAt });
  },
});

/** Whether to read prices for the page now: none read yet, and none asked for in the last minute. */
export const askForPrices = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const row = await ctx.db.query("billingPrices").first();
    if (row?.prices !== undefined || (row?.askedAt !== undefined && now - row.askedAt < ASK_FOR_PRICES_MS)) return false;
    if (row === null) await ctx.db.insert("billingPrices", { askedAt: now });
    else await ctx.db.patch(row._id, { askedAt: now });
    return true;
  },
});

/** Reads prices for Plan and billing when none have been read yet, as on a new deployment; for signed-in people. */
export const loadPrices = action({
  args: {},
  handler: async (ctx): Promise<void> =>
    run(async () => {
      if ((await ctx.auth.getUserIdentity()) === null) fail("unauthenticated", "Sign in to see plan prices.");
      const config = billingConfig();
      if (config !== null && (await ctx.runMutation(internal.billing.askForPrices, {}))) await readPrices(ctx, config);
    }),
});

export const refreshPrices = internalAction({
  args: {},
  handler: async (ctx) => {
    const config = billingConfig();
    if (config !== null) await readPrices(ctx, config);
  },
});

/**
 * Starts a billing change for an admin: refuses anyone else, and a second
 * change while one is in progress. Returns who Autumn's customer is, and
 * whether Plan and billing has prices to show.
 */
export const begin = internalMutation({
  args: { organizationId: v.string() },
  handler: async (ctx, args) =>
    run(async () => {
      const store = convexStore(ctx);
      const user = await operations.requireUser(store, await identityOf(ctx));
      const id = ctx.db.normalizeId("organizations", args.organizationId);
      const organization = id === null ? null : await ctx.db.get(id);
      if (organization === null || (await store.memberships.find(organization._id, user._id))?.role !== "admin") {
        fail("forbidden", "Only an admin of the organization can change its plan or payment details.");
      }
      const now = Date.now();
      const account = await accountOf(ctx, organization._id);
      if (account?.busyUntil !== undefined && account.busyUntil > now) fail("unavailable", "Another billing change for this organization is in progress. Try again in a moment.");
      if (account === null) await ctx.db.insert("billingAccounts", { organizationId: organization._id, busyUntil: now + BUSY_MS });
      else await ctx.db.patch(account._id, { busyUntil: now + BUSY_MS });
      return {
        id: organization._id,
        name: organization.name,
        email: user.email ?? (await adminEmail(ctx, organization._id)),
        storageEndingWithPlan: account?.storageEndingWithPlan ?? [],
        pricesShown: (await ctx.db.query("billingPrices").first())?.prices !== undefined,
      };
    }),
});

async function adminEmail(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<string | null> {
  for (const membership of await convexStore(ctx).memberships.admins(organizationId, 10)) {
    const email = (await ctx.db.get(membership.userId as Id<"users">))?.email;
    if (email) return email;
  }
  return null;
}

export const finish = internalMutation({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const account = await accountOf(ctx, organizationId);
    if (account !== null) await ctx.db.patch(account._id, { busyUntil: undefined });
  },
});

/** Notes which storage add-ons are set to end only because Pro is. */
export const setStorageEndingWithPlan = internalMutation({
  args: { organizationId: v.id("organizations"), subscriptionIds: v.array(v.string()) },
  handler: async (ctx, { organizationId, subscriptionIds }) => {
    const account = await accountOf(ctx, organizationId);
    if (account !== null) await ctx.db.patch(account._id, { storageEndingWithPlan: subscriptionIds.length === 0 ? undefined : subscriptionIds });
  },
});

/**
 * Records an organization's subscription as Autumn reported it at `readAt`,
 * unless a later reading is already recorded. When the plan or the storage
 * add-ons changed since the last reading, the organization's plan and storage
 * change with them, and a new plan starts from its default cap on extra
 * credits. A plan an operator assigned stays until the subscription changes.
 * Once the plan is no longer set to end, neither is the add-on's tie to it.
 */
export const record = internalMutation({
  args: { organizationId: v.id("organizations"), state, readAt: v.number() },
  handler: async (ctx, { organizationId, state, readAt }) => {
    if ((await ctx.db.get(organizationId)) === null) return;
    const account = await accountOf(ctx, organizationId);
    if (account?.readAt !== undefined && account.readAt > readAt) return;
    const before = account?.state ?? { plan: "free", storageUnits: 0 };
    const store = convexStore(ctx);
    if (state.plan !== before.plan) await assignPlan(store, { organizationId, plan: state.plan }, Date.now());
    if (state.storageUnits !== before.storageUnits) await setExtraStorage(store, { organizationId, units: state.storageUnits });
    if (account === null) await ctx.db.insert("billingAccounts", { organizationId, state, readAt });
    else await ctx.db.patch(account._id, { state, readAt, ...(leavingAtPeriodEnd(state) ? {} : { storageEndingWithPlan: undefined }) });
  },
});

async function recordCustomer(ctx: ActionCtx, organizationId: Id<"organizations">, customer: AutumnCustomer, readAt: number) {
  await ctx.runMutation(internal.billing.record, { organizationId, state: billingStateOf(customer), readAt });
}

/**
 * Reads an organization's customer from Autumn again and records it; nothing
 * when Autumn has none. Storage add-ons still billing after the organization
 * left Pro outside Critiqs (Stripe ended the subscription, or it changed in
 * Autumn) are canceled at once, refunding the rest of their period, and logged.
 * Throws when Autumn can't be read or an add-on can't be canceled.
 */
export async function syncOrganization(ctx: ActionCtx, config: BillingConfig, organizationId: Id<"organizations">) {
  const client = autumn(config);
  const readAt = Date.now();
  const customer = await client.getCustomer(organizationId);
  if (customer === null) return;
  await recordCustomer(ctx, organizationId, customer, readAt);
  const { plan } = billingStateOf(customer);
  const renewing = renewingStorageOf(customer);
  if (plan === "pro" || renewing.length === 0) return;
  console.warn(`Organization ${organizationId} is on ${plan} while ${renewing.length} of Pro's storage add-ons still bill; canceling them now.`);
  for (const addOn of renewing) await client.update({ customerId: organizationId, subscriptionId: addOn.id, action: "cancel_immediately" });
  const after = Date.now();
  const updated = await client.getCustomer(organizationId);
  if (updated !== null) await recordCustomer(ctx, organizationId, updated, after);
}

export const sync = internalAction({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const config = billingConfig();
    if (config !== null) await syncOrganization(ctx, config, organizationId);
  },
});

/** The organization an Autumn customer ID names, if it is one of this deployment's. */
export const organizationOf = internalQuery({
  args: { customerId: v.union(v.string(), v.null()) },
  handler: async (ctx, { customerId }) => {
    const id = customerId === null ? null : ctx.db.normalizeId("organizations", customerId);
    return id !== null && (await ctx.db.get(id)) !== null ? id : null;
  },
});

async function billingChange(
  ctx: ActionCtx,
  organizationId: string,
  change: (
    client: Autumn,
    customer: AutumnCustomer,
    account: { name: string; storageEndingWithPlan: string[]; pricesShown: boolean },
  ) => Promise<{ url: string | null; changed: boolean }>,
): Promise<{ url: string | null }> {
  const client = autumn(requireBilling());
  const customer = await ctx.runMutation(internal.billing.begin, { organizationId });
  const id = customer.id as Id<"organizations">;
  try {
    const readAt = Date.now();
    const current = await client.getOrCreateCustomer(customer).catch(billingFailure);
    await recordCustomer(ctx, id, current, readAt);
    const result = await change(client, current, customer).catch(billingFailure);
    if (result.changed) {
      const after = Date.now();
      const updated = await client.getCustomer(id).catch(() => null);
      if (updated !== null) await recordCustomer(ctx, id, updated, after);
    }
    return { url: result.url };
  } finally {
    await ctx.runMutation(internal.billing.finish, { organizationId: id });
  }
}

/** `returnUrl` when it is on the site the caller signed in from; refuses anyone not signed in. */
async function returnAddressFor(ctx: ActionCtx, returnUrl: string): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) fail("unauthenticated", "Sign in to change billing.");
  return returnAddress(returnUrl, typeof identity.origin === "string" ? identity.origin : null);
}

/**
 * Moves an organization to Free, Plus, or Pro, for its admins, from `from`,
 * the plan they were shown as billed; refuses when Autumn bills another now.
 * From Free, returns Stripe Checkout to pay on, even with a card on file,
 * which sends the person back to `returnUrl`. Between Plus and Pro with a
 * card on file, Autumn charges an upgrade at once, prorated, and schedules a
 * downgrade for the end of the period; it returns a page only when the card
 * needs confirming. That is refused while the page has no prices to show, so
 * the card is never charged an amount nobody saw. Free cancels
 * the paid plan at the end of its period, dropping a scheduled downgrade;
 * choosing the paid plan again before then keeps it. Leaving Pro ends every
 * storage add-on with it; keeping Pro keeps those, but not one the admin
 * removed themselves.
 */
export const changePlan = action({
  args: { organizationId: v.string(), from: plan, plan, returnUrl: v.string() },
  handler: async (ctx, args): Promise<BillingChange> =>
    run(async () => {
      const successUrl = await returnAddressFor(ctx, args.returnUrl);
      return await billingChange(ctx, args.organizationId, async (client, customer, account) => {
        const state = billingStateOf(customer);
        requireShownPlan(state, args.from, account.name);
        const change = planChange(state, args.plan);
        if (change.kind === "attach" && !change.alwaysCheckout && !account.pricesShown) fail("unavailable", PRICES_UNSHOWN);
        const result = await applyPlanChange(client, customer.id, change, successUrl);
        if (state.plan !== "pro") return result;
        const organizationId = customer.id as Id<"organizations">;
        const renewing = renewingStorageOf(customer);
        if (args.plan !== "pro" && renewing.length > 0) {
          // Noted first, so keeping Pro restores any that were canceled even if a later cancel fails.
          const subscriptionIds = [...account.storageEndingWithPlan, ...renewing.map((addOn) => addOn.id)];
          await ctx.runMutation(internal.billing.setStorageEndingWithPlan, { organizationId, subscriptionIds });
          for (const addOn of renewing) await client.update({ customerId: customer.id, subscriptionId: addOn.id, action: "cancel_end_of_cycle" });
          return { url: result.url, changed: true };
        }
        const restore = storageAddOnsOf(customer).filter((addOn) => addOn.canceledAt !== null && account.storageEndingWithPlan.includes(addOn.id));
        if (change.kind !== "uncancel" || restore.length === 0) return result;
        for (const addOn of restore) await client.update({ customerId: customer.id, subscriptionId: addOn.id, action: "uncancel" });
        return { url: result.url, changed: true };
      });
    }),
});

async function applyPlanChange(client: Autumn, customerId: string, change: PlanChange, successUrl: string): Promise<{ url: string | null; changed: boolean }> {
  switch (change.kind) {
    case "none":
      return { url: null, changed: false };
    case "attach":
      return { ...(await client.attach({ customerId, planId: change.plan, successUrl, alwaysCheckout: change.alwaysCheckout })), changed: true };
    case "cancel":
      if (change.replacesScheduled) await client.update({ customerId, planId: change.plan, action: "uncancel" });
      return { ...(await client.update({ customerId, planId: change.plan, action: "cancel_end_of_cycle" })), changed: true };
    case "uncancel":
      return { ...(await client.update({ customerId, planId: change.plan, action: "uncancel" })), changed: true };
  }
}

/**
 * Adds or removes one of Pro's 100 GB storage add-ons, for an organization's
 * admins. Adding undoes the cancel of one set to end before buying one, and
 * does nothing while one renews; buying one, which charges the card on file,
 * is refused while the page has no prices to show. Removing cancels one renewing add-on at the
 * end of its period; an organization may have several, as Autumn stacks
 * add-ons attached elsewhere.
 */
export const setStorageAddOn = action({
  args: { organizationId: v.string(), enabled: v.boolean(), returnUrl: v.string() },
  handler: async (ctx, args): Promise<BillingChange> =>
    run(async () => {
      const successUrl = await returnAddressFor(ctx, args.returnUrl);
      return await billingChange(ctx, args.organizationId, async (client, customer, account) => {
        const renewing = renewingStorageOf(customer);
        if (args.enabled) {
          const state = billingStateOf(customer);
          if (state.plan !== "pro") fail("invalid", "Extra storage comes with Pro. Move to Pro first.");
          if (leavingAtPeriodEnd(state)) fail("invalid", "Your organization leaves Pro at the end of this period. Keep Pro first, then add storage.");
          if (renewing.length > 0) return { url: null, changed: false };
          const ending = storageAddOnsOf(customer).find((addOn) => addOn.canceledAt !== null);
          if (ending !== undefined) return { ...(await client.update({ customerId: customer.id, subscriptionId: ending.id, action: "uncancel" })), changed: true };
          if (!account.pricesShown) fail("unavailable", PRICES_UNSHOWN);
          return { ...(await client.attach({ customerId: customer.id, planId: STORAGE_ADD_ON, successUrl })), changed: true };
        }
        const addOn = renewing[0];
        if (addOn !== undefined) return { ...(await client.update({ customerId: customer.id, subscriptionId: addOn.id, action: "cancel_end_of_cycle" })), changed: true };
        // While Pro is set to end, every add-on is too: one removed by the admin stays removed if they keep Pro.
        if (account.storageEndingWithPlan.length > 0 && leavingAtPeriodEnd(billingStateOf(customer))) {
          await ctx.runMutation(internal.billing.setStorageEndingWithPlan, { organizationId: customer.id as Id<"organizations">, subscriptionIds: account.storageEndingWithPlan.slice(1) });
        }
        return { url: null, changed: false };
      });
    }),
});

/** Stripe's customer portal for an organization's admins: payment method, invoices, and receipts. */
export const portal = action({
  args: { organizationId: v.string(), returnUrl: v.string() },
  handler: async (ctx, args): Promise<{ url: string }> =>
    run(async () => {
      const returnUrl = await returnAddressFor(ctx, args.returnUrl);
      const { url } = await billingChange(ctx, args.organizationId, async (client, customer) => ({
        url: await client.portal({ customerId: customer.id, returnUrl }),
        changed: false,
      }));
      return { url: url! };
    }),
});

/**
 * Reads every organization with an Autumn customer, or on a paid plan, from
 * Autumn again, a page of organizations per run, spread out over time, and
 * the prices in Autumn's catalog.
 * Runs daily; run it by hand with `npx convex run billing:reconcile`.
 */
export const reconcile = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor = null }) => {
    if (billingConfig() === null) return { scheduled: 0 };
    if (cursor === null) await ctx.scheduler.runAfter(0, internal.billing.refreshPrices, {});
    const result = await ctx.db.query("organizations").paginate({ numItems: 100, cursor });
    let scheduled = 0;
    for (const organization of result.page) {
      const paid = organization.plan !== undefined && organization.plan !== DEFAULT_PLAN;
      if (!paid && (await accountOf(ctx, organization._id)) === null) continue;
      await ctx.scheduler.runAfter(scheduled * 200, internal.billing.sync, { organizationId: organization._id });
      scheduled++;
    }
    if (!result.isDone) await ctx.scheduler.runAfter(scheduled * 200, internal.billing.reconcile, { cursor: result.continueCursor });
    return { scheduled };
  },
});

const USAGE_BATCH = 100;
/** How long a run holds the reports it took before another may send them, with the same key. */
const USAGE_LEASE_MS = 2 * 60_000;

async function giveUp(ctx: MutationCtx, row: Doc<"billingUsage">, now: number, reason: string) {
  console.error(`Critiqs AI usage ${row._id} for ${row.organizationId} (${row.credits} credits) wasn't reported to Autumn: ${reason}`);
  await ctx.db.patch(row._id, { status: "failed", finishedAt: now, reason, claimToken: undefined, leaseUntil: undefined });
}

/**
 * Takes reports that are due, and those a run took but never finished, to send.
 * A report already tried and now too old is failed instead: Autumn may have
 * forgotten its key. One never tried is sent however old, with its own time,
 * though Autumn counts it in the period current when it arrives.
 */
export const claimUsage = internalMutation({
  args: { claimToken: v.string(), limit: v.number() },
  handler: async (ctx, { claimToken, limit }) => {
    const now = Date.now();
    const due = await ctx.db
      .query("billingUsage")
      .withIndex("by_status_due", (q) => q.eq("status", "pending").lte("dueAt", now))
      .take(limit);
    const abandoned = await ctx.db
      .query("billingUsage")
      .withIndex("by_status_lease", (q) => q.eq("status", "sending").lte("leaseUntil", now))
      .take(limit - due.length);
    const claimed = [];
    for (const row of [...due, ...abandoned]) {
      if (row.attempts > 0 && !sendableAt(row.createdAt, now)) {
        await giveUp(ctx, row, now, TOO_LATE_TO_SEND);
        continue;
      }
      await ctx.db.patch(row._id, { status: "sending", claimToken, leaseUntil: now + USAGE_LEASE_MS, attempts: row.attempts + 1 });
      claimed.push({ id: row._id, organizationId: row.organizationId, credits: row.credits, usedAt: row.createdAt });
    }
    return claimed;
  },
});

export const completeUsage = internalMutation({
  args: {
    claimToken: v.string(),
    outcomes: v.array(v.object({ id: v.id("billingUsage"), result: v.union(v.literal("done"), v.literal("retry"), v.literal("failed")), reason: v.optional(v.string()) })),
  },
  handler: async (ctx, { claimToken, outcomes }) => {
    const now = Date.now();
    for (const { id, result, reason } of outcomes) {
      const row = await ctx.db.get(id);
      if (row === null || row.status !== "sending" || row.claimToken !== claimToken) continue;
      const released = { claimToken: undefined, leaseUntil: undefined };
      if (result === "done") {
        await ctx.db.patch(id, { ...released, status: "sent", finishedAt: now, reason: undefined });
        continue;
      }
      const at = result === "retry" ? retryAt(row.attempts, row.createdAt, now) : null;
      if (at === null) await giveUp(ctx, row, now, reason ?? "unknown");
      else await ctx.db.patch(id, { ...released, status: "pending", dueAt: at, reason });
    }
  },
});

/** The `Idempotency-Key` for one usage report, the same on every attempt. */
export const usageKey = (id: string) => `critiqs-ai-credits-${id}`;

/** Reports paying organizations' Critiqs AI credits to Autumn, then runs again while more are waiting. */
export const reportUsage = internalAction({
  args: {},
  handler: async (ctx) => {
    const config = billingConfig();
    if (config === null) return;
    const claimToken = crypto.randomUUID();
    const rows = await ctx.runMutation(internal.billing.claimUsage, { claimToken, limit: USAGE_BATCH });
    if (rows.length === 0) return;
    const client = autumn(config);
    const outcomes = [];
    for (const row of rows) {
      const outcome = await client.track({ customerId: row.organizationId, credits: row.credits, usedAt: row.usedAt, key: usageKey(row.id) });
      outcomes.push({ id: row.id, ...outcome });
    }
    await ctx.runMutation(internal.billing.completeUsage, { claimToken, outcomes });
    if (rows.length === USAGE_BATCH) await ctx.scheduler.runAfter(0, internal.billing.reportUsage, {});
  },
});

/**
 * Critiqs AI usage that never reached Autumn and so was never billed, with
 * totals per organization. Run it with `npx convex run billing:failedUsage`.
 */
export const failedUsage = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("billingUsage")
      .withIndex("by_status_finished", (q) => q.eq("status", "failed"))
      .collect();
    const organizations = new Map<Id<"organizations">, { organizationId: Id<"organizations">; reports: number; credits: number }>();
    for (const row of rows) {
      const total = organizations.get(row.organizationId) ?? { organizationId: row.organizationId, reports: 0, credits: 0 };
      total.reports++;
      total.credits += row.credits;
      organizations.set(row.organizationId, total);
    }
    return {
      reports: rows.length,
      credits: rows.reduce((sum, row) => sum + row.credits, 0),
      organizations: [...organizations.values()],
      rows: rows.map((row) => ({ id: row._id, organizationId: row.organizationId, credits: row.credits, createdAt: row.createdAt, attempts: row.attempts, reason: row.reason ?? null })),
    };
  },
});

const BILLING_RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const cleanUp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const before = Date.now() - BILLING_RECORD_RETENTION_MS;
    const sent = await ctx.db
      .query("billingUsage")
      .withIndex("by_status_finished", (q) => q.eq("status", "sent").lt("finishedAt", before))
      .take(500);
    for (const row of sent) await ctx.db.delete(row._id);
    if (sent.length === 500) await ctx.scheduler.runAfter(0, internal.billing.cleanUp, {});
  },
});
