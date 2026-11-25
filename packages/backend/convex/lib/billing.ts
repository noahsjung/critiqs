import type { BillingPlan, BillingPrices, BillingStatus } from "@critiqs/core";
import { fail } from "@critiqs/server";

export interface BillingConfig {
  secretKey: string;
  /** Verifies Autumn's webhooks (`whsec_…`); null until the operator sets it. */
  webhookSecret: string | null;
  apiUrl: string;
}

export const AUTUMN_API_URL = "https://api.useautumn.com";

export function billingConfig(): BillingConfig | null {
  const secretKey = process.env.AUTUMN_SECRET_KEY;
  if (process.env.CRITIQS_BILLING !== "autumn" || !secretKey) return null;
  return {
    secretKey,
    webhookSecret: process.env.AUTUMN_WEBHOOK_SECRET || null,
    apiUrl: (process.env.AUTUMN_API_URL || AUTUMN_API_URL).replace(/\/$/, ""),
  };
}

/** What `/critiqs/health` tells about billing, without any key. */
export function billingHealth(): false | { provider: "autumn"; environment: "sandbox" | "live" | "unknown"; webhook: boolean } {
  const config = billingConfig();
  if (config === null) return false;
  const environment = config.secretKey.startsWith("am_sk_test_") ? "sandbox" : config.secretKey.startsWith("am_sk_live_") ? "live" : "unknown";
  return { provider: "autumn", environment, webhook: config.webhookSecret !== null };
}

export const PAID_PLANS = ["plus", "pro"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export const isPaidPlan = (plan: string): plan is PaidPlan => (PAID_PLANS as readonly string[]).includes(plan);
const isBillingPlan = (plan: string): plan is BillingPlan => plan === "free" || isPaidPlan(plan);

/** Pro's 100 GB storage add-on in Autumn's catalog. */
export const STORAGE_ADD_ON = "storage_100gb";
/** The feature Pro's storage add-on grants, in GB. */
const STORAGE_FEATURE = "extra_storage_gb";

/**
 * The customer's storage add-ons while they last, whether or not they are set
 * to end with their period. Autumn makes each attach its own subscription, so
 * two add-ons are two of these, granting 200 GB.
 */
export function storageAddOnsOf(customer: AutumnCustomer): AutumnSubscription[] {
  return customer.subscriptions.filter((subscription) => subscription.addOn && subscription.planId === STORAGE_ADD_ON && subscription.status === "active");
}

/** The storage add-ons that renew: those not set to end with their period. */
export const renewingStorageOf = (customer: AutumnCustomer) => storageAddOnsOf(customer).filter((subscription) => subscription.canceledAt === null);

/** True when a downgrade or cancel will move the paid plan at the end of the period. */
export const leavingAtPeriodEnd = (state: BillingState) => state.cancelAtPeriodEnd || state.scheduledPlan !== null;

/** The metered feature Critiqs AI credits are reported to. */
export const CREDITS_FEATURE = "ai_credits";

/** One of a customer's recurring plans, as Autumn's `customers.get` reports it. */
export interface AutumnSubscription {
  /** Autumn's ID for this subscription, which `billing.update` can name when a customer has several of one plan. */
  id: string;
  planId: string;
  addOn: boolean;
  /** `scheduled`: starts later, such as a downgrade at the end of the period. */
  status: "active" | "scheduled";
  pastDue: boolean;
  canceledAt: number | null;
  currentPeriodEnd: number | null;
}

/** The parts of an Autumn customer Critiqs reads. */
export interface AutumnCustomer {
  id: string;
  subscriptions: AutumnSubscription[];
}

/** An organization's subscription as Critiqs keeps it, from its Autumn customer. */
export interface BillingState {
  plan: BillingPlan;
  pastDue: boolean;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: BillingPlan | null;
  /** 100 GB storage add-ons granting storage now, including those ending with the period. */
  storageUnits: number;
  /** The storage add-ons that renew, which people are shown and remove one at a time. */
  storageRenewing: number;
}

/**
 * What an Autumn customer has: the paid plan it is on (Pro when both are
 * active), which a renewal payment that failed (`past_due`) keeps, or Free
 * when no paid plan is active, as after a subscription is canceled or expires.
 * A plan ending with its period (`canceled_at`) goes back to Free only when
 * no lower plan is scheduled to follow it.
 */
export function billingStateOf(customer: AutumnCustomer): BillingState {
  const main = customer.subscriptions.filter((subscription) => !subscription.addOn);
  const paid = main.filter((subscription) => subscription.status === "active" && isPaidPlan(subscription.planId));
  const current = paid.find((subscription) => subscription.planId === "pro") ?? paid[0] ?? null;
  const scheduled = main.find((subscription) => subscription.status === "scheduled" && isBillingPlan(subscription.planId))?.planId ?? null;
  const cancelAtPeriodEnd = current !== null && current.canceledAt !== null && (scheduled === null || scheduled === "free");
  return {
    plan: (current?.planId ?? "free") as BillingPlan,
    pastDue: current?.pastDue ?? false,
    currentPeriodEnd: current?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd,
    scheduledPlan: current === null ? null : ((scheduled as BillingPlan | null) ?? (cancelAtPeriodEnd ? "free" : null)),
    storageUnits: storageAddOnsOf(customer).length,
    storageRenewing: renewingStorageOf(customer).length,
  };
}

/**
 * What people are shown: the plan whose limits apply (`plan`, the
 * organization's, which an operator may have set), and the subscription
 * Autumn last reported, with the plan it bills.
 */
export function billingStatusOf(state: BillingState | null, plan: string, canManage: boolean, prices: BillingPrices | null, plans: BillingStatus["plans"]): BillingStatus {
  return {
    plan: isPaidPlan(plan) ? plan : "free",
    subscription:
      state === null || state.plan === "free"
        ? null
        : {
            plan: state.plan,
            status: state.pastDue ? "past_due" : "active",
            currentPeriodEnd: state.currentPeriodEnd,
            cancelAtPeriodEnd: state.cancelAtPeriodEnd,
            scheduledPlan: state.scheduledPlan,
          },
    storageAddOns: state?.storageRenewing ?? 0,
    canManage,
    prices,
    plans,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Critiqs Cloud's prices from Autumn's catalog (`plans.list`): each plan's
 * price a month, none for Free, and its Critiqs AI credits' usage price; the
 * storage add-on's price and the storage it adds. Null when a plan or price
 * Critiqs shows is missing or not monthly, so no wrong price is shown.
 * What each plan includes stays Critiqs's own (the server's plans).
 */
export function pricesOf(catalog: unknown[]): BillingPrices | null {
  const plan = (id: string) => catalog.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === id) ?? null;
  const item = (entry: Record<string, unknown>, feature: string) =>
    (Array.isArray(entry.items) ? entry.items : []).find((row): row is Record<string, unknown> => isRecord(row) && row.feature_id === feature) ?? null;
  const monthly = (entry: Record<string, unknown> | null): number | null => {
    const price = entry?.price;
    return isRecord(price) && price.interval === "month" && isAmount(price.amount) ? price.amount : null;
  };
  const extraCredits = (entry: Record<string, unknown>): BillingPrices["plans"]["plus"]["extraCredits"] | undefined => {
    const price = item(entry, CREDITS_FEATURE)?.price;
    if (price === undefined || price === null) return null;
    if (!isRecord(price) || !isAmount(price.amount)) return undefined;
    const credits = price.billing_units ?? 1;
    return typeof credits === "number" && credits > 0 ? { amount: price.amount, credits } : undefined;
  };
  const plans: Partial<BillingPrices["plans"]> = {};
  for (const name of ["free", ...PAID_PLANS] as const) {
    const entry = plan(name);
    if (entry === null) return null;
    const price = name === "free" && entry.price === null ? 0 : monthly(entry);
    const extra = extraCredits(entry);
    if (price === null || extra === undefined) return null;
    plans[name] = { monthly: price, extraCredits: extra };
  }
  const storage = plan(STORAGE_ADD_ON);
  const storageMonthly = monthly(storage);
  const gb = storage === null ? null : item(storage, STORAGE_FEATURE)?.included;
  if (storageMonthly === null || typeof gb !== "number" || gb <= 0) return null;
  return { plans: plans as BillingPrices["plans"], storageAddOn: { gb, monthly: storageMonthly } };
}

const PLAN_LABELS: Record<BillingPlan, string> = { free: "Free", plus: "Plus", pro: "Pro" };

export function requireShownPlan(state: BillingState, shown: BillingPlan, organizationName: string) {
  if (state.plan !== shown) fail("invalid", `${organizationName} is on ${PLAN_LABELS[state.plan]} now, not ${PLAN_LABELS[shown]}. Check the plan, then choose again.`);
}

/** What moving an organization to `target` takes in Autumn, given what its customer has now. */
export type PlanChange =
  | { kind: "none" }
  /** Buy or switch to a paid plan. */
  | { kind: "attach"; plan: PaidPlan; alwaysCheckout: boolean }
  /** Go back to Free when the paid period ends, instead of the lower plan scheduled then, if any. */
  | { kind: "cancel"; plan: PaidPlan; replacesScheduled: boolean }
  /** Keep the paid plan after all: undo a cancel or a scheduled change. */
  | { kind: "uncancel"; plan: PaidPlan };

export function planChange(state: BillingState, target: BillingPlan): PlanChange {
  const pending = state.cancelAtPeriodEnd || state.scheduledPlan !== null;
  if (state.plan === "free") return target === "free" ? { kind: "none" } : { kind: "attach", plan: target, alwaysCheckout: true };
  if (target === "free") return state.scheduledPlan === "free" ? { kind: "none" } : { kind: "cancel", plan: state.plan, replacesScheduled: state.scheduledPlan !== null };
  if (target === state.plan) return pending ? { kind: "uncancel", plan: state.plan } : { kind: "none" };
  if (target === state.scheduledPlan) return { kind: "none" };
  return { kind: "attach", plan: target, alwaysCheckout: false };
}

/**
 * Where Stripe sends people back to: an address on `site`, the site the
 * person signed in from as their token names it. It is https, or http on
 * this computer for development. Anything else is refused.
 */
export function returnAddress(raw: string, site: string | null): string {
  const url = parseUrl(raw);
  const origin = site === null ? null : parseUrl(site)?.origin;
  const local = url?.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url === null || (url.protocol !== "https:" && !local) || url.username !== "" || url.password !== "" || url.origin !== origin) {
    fail("invalid", "The return address must be a full https address on the site you signed in from.");
  }
  return url.toString();
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** How long Autumn remembers an `Idempotency-Key`; a report is never sent again after its key could be forgotten. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;
/** Stop sending well inside that window. */
const LAST_SEND_MS = IDEMPOTENCY_WINDOW_MS - 4 * 60 * 60_000;

export const TOO_LATE_TO_SEND = `Not reported within ${LAST_SEND_MS / (60 * 60_000)} hours of use; sending it again could count it twice.`;

export const sendableAt = (createdAt: number, at: number) => at - createdAt <= LAST_SEND_MS;

/** When to send a usage report again after `attempts` failed tries, or null when it is too late to send it safely. */
export function retryAt(attempts: number, createdAt: number, now: number): number | null {
  const at = now + Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
  return sendableAt(createdAt, at) ? at : null;
}

/** Most a webhook's timestamp may differ from now, as Svix's own libraries allow. */
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export type WebhookCheck = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Checks that a webhook came from Autumn (Svix): an HMAC-SHA256 of
 * `id.timestamp.body` with the secret after `whsec_`, among the signatures
 * sent, and a timestamp within five minutes of now.
 */
export async function verifyWebhook(secret: string, headers: Headers, body: string, now: number): Promise<WebhookCheck> {
  const header = (name: string) => headers.get(`svix-${name}`) ?? headers.get(`webhook-${name}`);
  const id = header("id");
  const timestamp = header("timestamp");
  const signatures = header("signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "missing signature headers" };
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(now - seconds * 1000) > WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "timestamp outside tolerance" };
  const key = await crypto.subtle.importKey("raw", base64Bytes(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || signature === undefined) continue;
    let given: Uint8Array;
    try {
      given = base64Bytes(signature);
    } catch {
      continue;
    }
    if (constantTimeEqual(given, expected)) return { ok: true, id };
  }
  return { ok: false, reason: "no matching signature" };
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
