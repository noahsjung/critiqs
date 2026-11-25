import { CritiqsError, fail } from "../errors.ts";
import { ceilingOf, type OrganizationPlan, requireRoom, usageKey, useQuota, utcDay } from "../limits.ts";
import { type Coverage, personalQuota, projectQuota } from "../organizations.ts";
import { crossedLine, owePlanAlert } from "../plan-alerts.ts";
import type { Store } from "../store.ts";
import type { Generated, ModelUsage, StructuredModel, StructuredRequest } from "./model.ts";
import type { ChosenConnection } from "./settings.ts";

// What Critiqs AI requests cost, and who pays. A model with a price costs
// what its request really used, at twice the API cost; a model without one
// costs its flat credits. Credits count as `aiCredits` against the
// organization of the project when the project pays, or the person's home
// organization when they pay. Own keys cost nothing here. Before its model
// is asked, a request holds the most it could cost, and starts only if that
// fits in what its payer may still spend, extra credits included, after
// everything already counted and held. Once the model answers, the hold is
// released and the real cost counted in full; a failed request costs
// nothing. Holds expire, so a request that never finishes frees its credits.

/** A Critiqs AI model's price, in US dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** 1 credit is 1 cent of what people pay, and they pay twice the API cost. */
export const CREDITS_PER_USD = 200;

/** The request a priced model's shown credits assume. */
export const REFERENCE_USAGE: ModelUsage = { inputTokens: 2_000, outputTokens: 1_000 };

/**
 * Credits for one request on a priced model: its cost as the provider
 * reported it, otherwise its tokens at the model's price, times
 * `CREDITS_PER_USD`, rounded up, at least 1.
 */
export function pricedCredits(price: ModelPrice, usage: ModelUsage): number {
  const usd = usage.costUsd ?? (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  // Rounded to a millionth first, so floating-point error (0.07 × 200 = 14.000000000000002) doesn't add a credit.
  return Math.max(1, Math.ceil(Math.round(usd * CREDITS_PER_USD * 1_000_000) / 1_000_000));
}

/** How long a hold lasts: longer than any request's model call, short enough that a lost request frees its credits soon. */
export const HOLD_MS = 10 * 60_000;

/** Input tokens a request may use beyond its text: message framing, and the tool wrapping some providers give structured output. */
const FRAMING_TOKENS = 500;

/** Each token is at least one byte of UTF-8 in the providers' tokenizers, so counting bytes can't undercount a request's tokens. */
export function worstCaseCredits(chosen: Pick<ChosenConnection, "credits" | "price">, request: Pick<StructuredRequest<unknown>, "system" | "prompt" | "schema" | "maxOutputTokens">): number {
  if (chosen.price === null) return chosen.credits;
  const bytes = new TextEncoder().encode(request.system + request.prompt + JSON.stringify(request.schema)).length;
  return pricedCredits(chosen.price, { inputTokens: bytes + FRAMING_TOKENS, outputTokens: request.maxOutputTokens });
}

/** Who pays for a Critiqs AI request: a project (by its ID) or a person (by theirs). */
export interface CreditPayer {
  payer: "project" | "person";
  ownerId: string;
}

/** Who pays for one finished request, and how many credits. */
export interface CreditCharge extends CreditPayer {
  credits: number;
}

/** What a finished request on a chosen connection costs its payer; null for an own key. */
export function chargeFor(chosen: Pick<ChosenConnection, "payer" | "ownerId" | "credits" | "price">, usage: ModelUsage): CreditCharge | null {
  if (chosen.payer === "none") return null;
  return { payer: chosen.payer, ownerId: chosen.ownerId, credits: chosen.price === null ? chosen.credits : pricedCredits(chosen.price, usage) };
}

/** Whether a plan lets a person pay for Critiqs AI themselves; true where plans are off. */
export function includesPersonalAi(plan: OrganizationPlan | null): boolean {
  return plan === null || !plan.limits.some((limit) => limit.metric === "aiCredits" && ceilingOf(limit) === 0);
}

export const NO_PERSONAL_AI = "Your plan doesn't include Critiqs AI. Connect your own key in Your AI, or choose a plan that includes it.";

/** Where a payer's credits count: the plan, the organization (or a stand-in's ID), the organization itself when there is one, and the project. */
async function creditsQuota(store: Store, payer: CreditCharge["payer"], ownerId: string) {
  if (payer === "project") {
    const project = await store.projects.get(ownerId);
    if (project === null) throw new Error("A project pays only for its own requests.");
    return await projectQuota(store, project);
  }
  return { ...(await personalQuota(store, ownerId)), projectId: null };
}

async function usedThisMonth(store: Store, accountId: string, now: number): Promise<number> {
  return (await store.usage.find(usageKey("aiCredits", "month", accountId, utcDay(now))))?.count ?? 0;
}

/** Owes the organization's admins the alert for the line `amount` more credits cross on top of `before`, if any; see `crossedLine`. */
async function owePlanAlerts(store: Store, quota: Coverage & { projectId: string | null }, before: number, amount: number, allowed: boolean, now: number) {
  const { plan, organizationId, projectId } = quota;
  const month = plan?.limits.find((limit) => limit.metric === "aiCredits" && limit.period === "month");
  if (plan === null || month === undefined || organizationId === null) return;
  const kind = crossedLine(month, before, amount, allowed);
  if (kind !== null) await owePlanAlert(store, { organizationId, kind, month: utcDay(now).slice(0, 7), plan, limit: month, projectId, now });
}

function refusal(payer: CreditCharge["payer"], plan: OrganizationPlan | null): string {
  if (payer === "project") return "The project's AI allowance is used up for now.";
  return includesPersonalAi(plan) ? "Your Critiqs AI allowance is used up for now." : NO_PERSONAL_AI;
}

/** Holds a request's credits, or says why it can't start. `hold` is null when nothing needs holding: an own key, or no plans. */
export type Reserved = { ok: true; hold: string | null } | { ok: false; reason: string };

/**
 * Holds `credits` for a request about to ask its model, when they fit in
 * what its payer may still spend once everything counted and held is taken
 * off. Otherwise refuses, holding nothing, with the reason to show; when the
 * credits already counted leave no room for it, the organization's admins
 * are owed the email that none are left. One transaction.
 */
export async function reserveCredits(store: Store, payer: Pick<ChosenConnection, "payer" | "ownerId">, credits: number, now: number): Promise<Reserved> {
  if (payer.payer === "none") return { ok: true, hold: null };
  const quota = await creditsQuota(store, payer.payer, payer.ownerId);
  if (quota.plan === null) return { ok: true, hold: null };
  const scope = `aiCredits:${quota.accountId}`;
  try {
    await requireRoom(store, { ...quota, metric: "aiCredits", now, amount: (await store.creditHolds.held(scope, now)) + credits });
  } catch (error) {
    if (!(error instanceof CritiqsError && error.code === "limit")) throw error;
    await owePlanAlerts(store, quota, await usedThisMonth(store, quota.accountId, now), credits, false, now);
    return { ok: false, reason: refusal(payer.payer, quota.plan) };
  }
  return { ok: true, hold: await store.creditHolds.insert({ scope, credits, expiresAt: now + HOLD_MS }, now) };
}

/**
 * Releases a request's hold and counts what it really cost, if anything,
 * past the allowance if need be: the work is done. When the count crosses
 * the line where the plan's included credits run out, or where none are
 * left, the organization's admins are owed an email. Where the deployment
 * bills, the credits are recorded for billing too. One transaction.
 */
export async function settleCredits(store: Store, hold: string | null, charge: CreditCharge | null, now: number): Promise<void> {
  if (hold !== null) await store.creditHolds.delete(hold);
  if (charge === null || charge.credits <= 0) return;
  const quota = await creditsQuota(store, charge.payer, charge.ownerId);
  const before = await usedThisMonth(store, quota.accountId, now);
  await useQuota(store, { ...quota, metric: "aiCredits", now, amount: charge.credits, overrun: true });
  if (quota.plan !== null && quota.organizationId !== null) await store.billedCredits?.add({ organizationId: quota.organizationId, credits: charge.credits, now });
  await owePlanAlerts(store, quota, before, charge.credits, true, now);
}

/** What asking Critiqs AI needs from a backend: a transaction before the model call, and one after. */
export interface CreditSteps {
  /** See `reserveCredits`. */
  reserve(payer: CreditPayer, credits: number): Promise<Reserved>;
  /** See `settleCredits`. */
  settle(hold: string | null, charge: CreditCharge | null): Promise<void>;
}

/**
 * Asks a chosen connection's model, holding the request's worst case while
 * it answers and then counting what it really cost. Refuses with a `limit`
 * error, without asking, when the payer can't cover the worst case. Own keys
 * skip both steps.
 */
export async function askPaid<T>(steps: CreditSteps, chosen: ChosenConnection, model: StructuredModel, request: StructuredRequest<T>): Promise<Generated<T>> {
  if (chosen.payer === "none") return await model.generate(request);
  const reserved = await steps.reserve({ payer: chosen.payer, ownerId: chosen.ownerId }, worstCaseCredits(chosen, request));
  if (!reserved.ok) fail("limit", reserved.reason);
  return await askHeld(steps, reserved.hold, chosen, model, request);
}

/** Asks the model while `hold` keeps the request's credits, then releases it, counting the real cost, or nothing when the model fails. */
export async function askHeld<T>(
  steps: Pick<CreditSteps, "settle">,
  hold: string | null,
  chosen: ChosenConnection,
  model: StructuredModel,
  request: StructuredRequest<T>,
): Promise<Generated<T>> {
  let generated: Generated<T>;
  try {
    generated = await model.generate(request);
  } catch (error) {
    if (hold !== null) await steps.settle(hold, null);
    throw error;
  }
  const charge = chargeFor(chosen, generated.usage);
  if (hold !== null || charge !== null) await steps.settle(hold, charge);
  return generated;
}
