import type { BillingChange, BillingPlan, BillingPrices, BillingStatus, OrganizationSummary, OrganizationUsage, PlanIncludes } from "@critiqs/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type BillingTransport, errorMessage, useTransport } from "../transport.ts";
import { Dialog } from "./common.tsx";
import { DialogHeader, Meter, NavRow, Select, SettingRow, usePageFocus } from "./ds.tsx";
import { amount, ceilingOf, USAGE_NAMES, type UsageRow, usageName, usageText } from "./usage.ts";

// What each plan includes comes with the billing status, from the
// deployment's plan configuration, which sets the limits; its prices come
// from Autumn's catalog, which charges them.
const PLAN_ORDER: readonly BillingPlan[] = ["free", "plus", "pro"];
/** How long to wait for a payment to reach Critiqs before saying it is taking longer. */
export const ARRIVAL_TIMEOUT_MS = 60_000;

/**
 * Plan and billing, where the deployment takes payment, for Upgrade buttons;
 * null elsewhere. `open` shows it on an organization, or on `organizationId`
 * (the project's) when none is given.
 */
export interface OpenBilling {
  open: (organizationId?: string) => void;
  organizationId: string | null;
}

export const OpenBillingContext = createContext<OpenBilling | null>(null);

/**
 * Upgrade: opens Plan and billing where the deployment takes payment, once
 * the organization it opens on is known to have a higher plan to move to;
 * otherwise the deployment's upgrade page when it names one.
 */
export function UpgradeButton({ upgradeUrl, organizationId, className }: { upgradeUrl?: string; organizationId?: string; className: string }) {
  const openBilling = useContext(OpenBillingContext);
  const billing = useTransport().billing;
  if (openBilling !== null) {
    // The organization Plan and billing opens on, so the plan checked is the one it shows.
    const opensOn = organizationId ?? openBilling.organizationId;
    if (billing === undefined || opensOn === null) return null;
    return (
      <IfHigherPlan billing={billing} organizationId={opensOn}>
        <button type="button" className={className} onClick={() => openBilling.open(opensOn)}>
          Upgrade
        </button>
      </IfHigherPlan>
    );
  }
  if (upgradeUrl === undefined) return null;
  return (
    <a className={className} href={upgradeUrl} target="_blank" rel="noreferrer noopener">
      Upgrade
    </a>
  );
}

/**
 * What Change plan offers for a plan: the one billed (or, with nothing
 * billed, the one in effect) is current; one Critiqs set is marked so; the
 * scheduled one says when it starts; otherwise an upgrade above the current
 * plan or a switch below it. Free has no row of its own while nothing is
 * billed.
 */
type PlanOffer = "current" | "set-by-critiqs" | "scheduled" | "upgrade" | "switch" | null;
function planOffer(status: BillingStatus, name: BillingPlan): PlanOffer {
  const billed = billedPlan(status);
  if (name === billed && billed !== "free") return "current";
  if (name === status.plan) return status.plan === billed ? "current" : "set-by-critiqs";
  if (name === (status.subscription?.scheduledPlan ?? null)) return "scheduled";
  if (name === "free" && billed === "free") return null;
  return PLAN_ORDER.indexOf(name) > PLAN_ORDER.indexOf(billed === "free" ? status.plan : billed) ? "upgrade" : "switch";
}

/** Whether Change plan offers an upgrade, which Upgrade buttons open it for. */
export const hasHigherPlan = (status: BillingStatus) => PLAN_ORDER.some((name) => planOffer(status, name) === "upgrade");

/** Its children once the organization's plan is known not to be the highest; nothing while it loads or when it can't be read. */
function IfHigherPlan({ billing, organizationId, children }: { billing: BillingTransport; organizationId: string; children: ReactNode }) {
  const status = billing.useStatus(organizationId);
  return status.status === "ready" && status.data !== null && hasHigherPlan(status.data) ? children : null;
}

const BILLING_PARAMETER = "critiqs-billing";

/** What a return from Stripe waits to see: a plan, the storage add-on, or nothing, as from the payment portal. */
export type Awaiting = BillingPlan | "storage" | null;

/** Where Stripe sends the person back to: this page, reopening Plan and billing for the organization. */
export function billingReturnUrl(href: string, organizationId: string, awaiting: Awaiting): string {
  const url = new URL(href);
  url.searchParams.set(BILLING_PARAMETER, awaiting === null ? organizationId : `${organizationId}.${awaiting}`);
  return url.toString();
}

/** A return from Stripe in a page address, or null. */
export function parseBillingReturn(href: string): { organizationId: string; awaiting: Awaiting } | null {
  const value = new URL(href).searchParams.get(BILLING_PARAMETER);
  if (value === null || value === "") return null;
  const [organizationId, what] = value.split(".");
  const awaiting = what === "plus" || what === "pro" || what === "storage" ? what : null;
  return organizationId === undefined || organizationId === "" ? null : { organizationId, awaiting };
}

/** The same address without the billing parameter. */
export function removeBillingReturn(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(BILLING_PARAMETER);
  return url.toString();
}

type Change =
  | { kind: "upgrade"; plan: BillingPlan }
  | { kind: "downgrade"; plan: BillingPlan }
  | { kind: "cancel" }
  | { kind: "add-storage" }
  | { kind: "remove-storage" };

type PageRequest = { name: "main" } | { name: "plans" } | { name: "cap" } | { name: "confirm"; change: Change };
type Page = { name: "main" } | (Exclude<PageRequest, { name: "main" }> & { organizationId: string });
const MAIN: Page = { name: "main" };

const dollars = (amount: number) => `$${amount.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
/** What extra Critiqs AI credits cost on a plan, or null when there are no prices to say it. */
type CreditPrice = NonNullable<BillingPrices["plans"][BillingPlan]["extraCredits"]> | null;
const creditPriceOf = (status: BillingStatus): CreditPrice => status.prices?.plans[status.plan].extraCredits ?? null;
const creditsCost = (price: NonNullable<CreditPrice>, credits: number) => dollars((credits * price.amount) / price.credits);
/** A plan's price as "<dollars> a month", or null without prices. */
const monthlyOf = (prices: BillingPrices | null, plan: BillingPlan) => (prices === null ? null : `${dollars(prices.plans[plan].monthly)} a month`);
const count = (value: number) => value.toLocaleString("en-US");
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const size = (bytes: number) => (bytes >= GB ? `${count(Math.round((bytes / GB) * 10) / 10)} GB` : `${count(Math.round(bytes / MB))} MB`);
const INCLUDED_NAMES: Record<PlanIncludes["limits"][number]["metric"], [one: string, many: string]> = {
  aiCredits: ["AI credit", "AI credits"],
  aiRequests: ["AI credit", "AI credits"],
  projects: ["project", "projects"],
  threads: ["thread", "threads"],
  captureBytes: ["image storage", "image storage"],
  reviewers: ["reviewer", "reviewers"],
  messages: ["comment", "comments"],
  mentionEmails: ["mention email", "mention emails"],
};
const PER: Record<PlanIncludes["limits"][number]["period"], string> = { total: "", month: " a month", day: " a day" };
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** What a plan includes in words, such as "2,000 AI credits a month, 10 projects, …; unlimited mention emails". */
function includesText(plan: PlanIncludes): string {
  const limited: string[] = [];
  const unlimited: string[] = [];
  for (const { metric, period, max } of plan.limits) {
    const [one, many] = INCLUDED_NAMES[metric];
    if (max === null) unlimited.push(many);
    else limited.push(metric === "captureBytes" ? `${size(max)} of image storage` : `${count(max)} ${max === 1 ? one : many}${PER[period]}`);
  }
  return [limited.join(", "), unlimited.length === 0 ? "" : `unlimited ${andList(unlimited)}`].filter((part) => part !== "").join("; ");
}

/** Pro's image storage and what each storage add-on adds, in bytes, from the plan configuration; null where it says none. */
function proStorage(status: BillingStatus): { base: number | null; addOn: number | null } {
  const limit = status.plans.pro.limits.find((entry) => entry.metric === "captureBytes");
  return { base: limit?.max ?? null, addOn: limit?.addOn ?? null };
}

/** Without prices, changes that charge the card on file wait: no one is charged an amount they weren't shown. Stripe Checkout shows its own. */
const PAUSED = "Prices can't be shown right now, so plan changes are paused. Try again shortly.";
/** Plus and Pro renew at the start of each month in UTC (Autumn's `anchor_to_month_start`), so the day shown is UTC's wherever the reader is. */
const dateOf = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const onEnd = (end: number | null) => (end === null ? "at the end of this billing period" : `on ${dateOf(end)}`);

function arrived(status: BillingStatus, awaiting: Awaiting): boolean {
  if (awaiting === null) return true;
  if (awaiting === "storage") return status.storageAddOns > 0;
  return (status.subscription?.plan ?? "free") === awaiting;
}

const billedPlan = (status: BillingStatus): BillingPlan => status.subscription?.plan ?? "free";

function pendingText(status: BillingStatus): string | null {
  const subscription = status.subscription;
  if (subscription === null || (!subscription.cancelAtPeriodEnd && subscription.scheduledPlan === null)) return null;
  const paid = status.plans[subscription.plan].label;
  return subscription.scheduledPlan === null || subscription.scheduledPlan === "free"
    ? `${paid} cancels ${onEnd(subscription.currentPeriodEnd)}.`
    : `${paid} changes to ${status.plans[subscription.scheduledPlan].label} ${onEnd(subscription.currentPeriodEnd)}.`;
}

/**
 * An organization's Critiqs Cloud plan and what it has used, for its
 * members; its admins change the plan, the cap on extra credits, the storage
 * add-on, and payment details. Changes that charge a saved card or end
 * something are confirmed on their own page first; buying with nothing
 * billed goes to Stripe Checkout, which returns here.
 */
export function BillingDialog({
  billing,
  organizationId: initialId,
  awaiting: initialAwaiting = null,
  onClose,
  notify,
}: {
  billing: BillingTransport;
  /** The organization to show first, such as the project's; the first one otherwise. */
  organizationId: string | null;
  /** Back from Stripe: what the page waits to see until the payment reaches Critiqs. */
  awaiting?: Awaiting;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const transport = useTransport();
  const organizations = transport.useMyOrganizations(true);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const list = organizations.status === "ready" ? organizations.data : [];
  const organization =
    list.find((entry) => entry.id === chosenId) ?? list.find((entry) => entry.id === initialId) ?? list[0] ?? null;
  const id = organization?.id ?? null;
  const status = billing.useStatus(id);
  const usage = billing.useUsage(id);
  const [page, setPage] = useState<Page>({ name: "main" });
  const [awaiting, setAwaiting] = useState<Awaiting>(initialAwaiting);
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  usePageFocus(pageRef, page.name);

  const ready = status.status === "ready" && status.data !== null ? status.data : null;
  const waiting = ready !== null && !arrived(ready, awaiting);
  const askedForPrices = useRef(false);
  useEffect(() => {
    if (ready === null || ready.prices !== null || askedForPrices.current) return;
    askedForPrices.current = true;
    billing.loadPrices().catch(() => undefined);
  }, [ready]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), ARRIVAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  useEffect(() => {
    if (ready === null || awaiting === null || !arrived(ready, awaiting)) return;
    notify(awaiting === "storage" ? "Extra storage added" : `${organization?.name ?? "The organization"} is on ${ready.plans[awaiting].label}`);
    setAwaiting(null);
  }, [ready, awaiting]);

  const stale = page.name !== "main" && page.organizationId !== id;
  useEffect(() => {
    if (!stale) return;
    setPage(MAIN);
    setError(null);
  }, [stale]);

  const go = (next: PageRequest) => {
    setError(null);
    setPage(next.name === "main" || id === null ? MAIN : { ...next, organizationId: id });
  };

  const act = async (request: () => Promise<BillingChange>, done: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const { url } = await request();
      if (url !== null) {
        window.location.assign(url);
        return;
      }
      notify(done);
      setPage(MAIN);
    } catch (failure) {
      setError(errorMessage(failure));
    }
    running.current = false;
    setBusy(false);
  };

  const shell = (title: string, body: ReactNode, onBack?: () => void) => (
    <Dialog label="Plan and billing" onClose={onClose}>
      <div ref={pageRef} className="ds-page">
        <DialogHeader title={title} onBack={onBack} onClose={onClose} />
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {body}
      </div>
    </Dialog>
  );

  if (organizations.status === "error") return shell("Plan and billing", <p className="error">{organizations.message}</p>);
  if (organizations.status === "loading") return shell("Plan and billing", <p className="note">Loading…</p>);
  if (organization === null) return shell("Plan and billing", <p className="note">Plans belong to organizations. Yours is created with your first project.</p>);
  if (status.status === "error") return shell("Plan and billing", <p className="error">{status.message}</p>);
  if (usage.status === "error") return shell("Plan and billing", <p className="error">{usage.message}</p>);
  if (ready === null || usage.status === "loading") return shell("Plan and billing", <p className="note">Loading…</p>);

  const returnUrl = (what: Awaiting) => billingReturnUrl(removeBillingReturn(window.location.href), organization.id, what);
  const context: BillingContext = { organization, status: ready, usage: usage.data, locked: busy || waiting, act, go, billing, returnUrl };
  const shown = stale ? MAIN : page;

  if (shown.name === "plans") return shell("Change plan", <PlansPage {...context} />, () => go(MAIN));
  if (shown.name === "cap") return shell("Cap on extra credits", <CapPage {...context} notify={notify} />, () => go(MAIN));
  if (shown.name === "confirm") return shell(changeTitle(shown.change, ready), <ConfirmPage {...context} change={shown.change} />, () => go(shown.change.kind.endsWith("storage") ? MAIN : { name: "plans" }));

  return shell(
    "Plan and billing",
    <>
      {list.length > 1 && (
        <SettingRow label="Organization">
          {(labelId) => (
            <Select
              value={organization.id}
              options={list.map((entry) => ({ value: entry.id, label: entry.name, detail: entry.role === "admin" ? "Admin" : "Member" }))}
              labelledBy={labelId}
              disabled={busy}
              onChange={(next) => {
                setChosenId(next);
                setAwaiting(null);
                setError(null);
              }}
            />
          )}
        </SettingRow>
      )}
      {waiting && (
        <p className={slow ? "warning" : "note"} role="status">
          {slow
            ? `${awaiting === "storage" ? "Extra storage" : ready.plans[awaiting as BillingPlan].label} hasn't reached Critiqs yet. Payments can take a few minutes; this page updates when it arrives.`
            : "Updating your plan… You can change it again once it arrives."}
        </p>
      )}
      <MainPage {...context} />
    </>,
  );
}

interface BillingContext {
  organization: OrganizationSummary;
  status: BillingStatus;
  usage: OrganizationUsage | null;
  locked: boolean;
  act: (request: () => Promise<BillingChange>, done: string) => Promise<void>;
  go: (page: PageRequest) => void;
  billing: BillingTransport;
  returnUrl: (what: Awaiting) => string;
}

function MainPage({ organization, status, usage, locked, act, go, billing, returnUrl }: BillingContext) {
  const plan = status.plans[status.plan];
  const subscription = status.subscription;
  const paid = subscription === null ? null : status.plans[subscription.plan];
  const setByCritiqs = status.plan !== billedPlan(status);
  const admin = status.canManage;
  const pending = pendingText(status);
  const keep = () =>
    void act(
      () => billing.changePlan({ organizationId: organization.id, from: subscription!.plan, plan: subscription!.plan, returnUrl: returnUrl(null) }),
      `Keeping ${paid!.label}`,
    );
  const portal = () => void act(async () => await billing.openPortal({ organizationId: organization.id, returnUrl: returnUrl(null) }), "");
  const credits = usage?.rows.find((row) => row.metric === "aiCredits");
  const ending = endingStorageText(status);
  const creditPrice = creditPriceOf(status);
  const monthly = monthlyOf(status.prices, status.plan);
  return (
    <>
      {subscription?.status === "past_due" && (
        <div className="warning row between" role="status">
          <span>The last payment for {paid!.label} didn't go through. Update the payment method to keep {paid!.label}.</span>
          {admin && (
            <button type="button" className="btn small" disabled={locked} onClick={portal}>
              Manage billing
            </button>
          )}
        </div>
      )}
      {pending !== null && (
        <div className="warning row between" role="status">
          <span>{pending}</span>
          {admin && (
            <button type="button" className="btn small" disabled={locked} onClick={keep}>
              Keep my plan
            </button>
          )}
        </div>
      )}
      <div className="ds-group">
        <SettingRow label="Plan">
          {() => <span>{setByCritiqs ? `${plan.label} · set by Critiqs` : monthly === null || status.plan === "free" ? plan.label : `${plan.label} · ${monthly}`}</span>}
        </SettingRow>
        {subscription?.currentPeriodEnd != null && (
          <SettingRow label={pending !== null ? "Period ends" : "Renews"}>{() => <span>{dateOf(subscription.currentPeriodEnd!)}</span>}</SettingRow>
        )}
        {admin && <NavRow label={status.plan === "free" ? "Upgrade" : "Change plan"} disabled={locked} onClick={() => go({ name: "plans" })} />}
        {admin && subscription !== null && <NavRow label="Manage billing" value="Payment method and invoices" disabled={locked} onClick={portal} />}
      </div>
      {admin && subscription !== null && status.prices === null && <p className="note">{PAUSED}</p>}
      {setByCritiqs && (
        <p className="note">
          {paid === null
            ? `Critiqs set this plan for ${organization.name}, at no charge. Buying a plan starts a subscription, paid on Stripe Checkout, that replaces it.`
            : `Critiqs set this plan for ${organization.name}; the subscription pays for ${paid.label}.`}
        </p>
      )}
      {usage !== null && (
        <>
          <hr className="ds-divider" />
          <div className="ds-group billing-usage">
            {usage.rows.map((row) => (
              <UsageRow key={`${row.metric}-${row.period}`} row={row} creditPrice={creditPrice} />
            ))}
            {usage.unlimited?.map((row) => (
              <SettingRow key={`${row.metric}-${row.period}`} label={USAGE_NAMES[row.metric]}>
                {() => <span className="note">{amount(row.metric, row.used)} · Unlimited</span>}
              </SettingRow>
            ))}
            {credits?.overage !== undefined &&
              (admin ? (
                <NavRow label="Cap on extra credits" value={capText(credits.overage.cap, creditPrice)} disabled={locked} onClick={() => go({ name: "cap" })} />
              ) : (
                <SettingRow label="Cap on extra credits">{() => <span className="note">{capText(credits.overage!.cap, creditPrice)}</span>}</SettingRow>
              ))}
            {subscription?.plan === "pro" &&
              (admin ? (
                <NavRow
                  label="Extra storage"
                  value={storageText(status)}
                  disabled={locked || (status.storageAddOns === 0 && status.prices === null)}
                  onClick={() => go({ name: "confirm", change: { kind: status.storageAddOns > 0 ? "remove-storage" : "add-storage" } })}
                />
              ) : (
                <SettingRow label="Extra storage">{() => <span className="note">{storageText(status)}</span>}</SettingRow>
              ))}
          </div>
          {ending !== null && <p className="note">{ending}</p>}
        </>
      )}
      {!admin && <p className="note">Only admins of {organization.name} can change its plan.</p>}
    </>
  );
}

function UsageRow({ row, creditPrice }: { row: UsageRow; creditPrice: CreditPrice }) {
  const name = usageName(row);
  const { text, tone } = usageText(row, (extra) => (creditPrice === null ? "" : ` (${creditsCost(creditPrice, extra)})`));
  return (
    <div className="billing-usage-row">
      <div className="row between">
        <span>{name}</span>
        <span className={tone}>{text}</span>
      </div>
      <Meter value={row.used} max={row.max} ceiling={ceilingOf(row)} label={name} valueText={text} />
    </div>
  );
}

const capText = (cap: number | null, price: CreditPrice) =>
  cap === null ? "No cap" : cap === 0 ? "None" : price === null ? count(cap) : `${count(cap)} · up to ${creditsCost(price, cap)}`;
/** The storage add-ons that renew: what they add, and what they cost when there are prices. */
function storageText(status: BillingStatus): string {
  const units = status.storageAddOns;
  if (units === 0) return "Off";
  const { addOn } = proStorage(status);
  const added = addOn === null ? `${units} add-on${units === 1 ? "" : "s"}` : size(units * addOn);
  return status.prices === null ? added : `${added} · ${dollars(units * status.prices.storageAddOn.monthly)} a month`;
}

/**
 * Storage add-ons that no longer renew but last until their own period ends,
 * as after Remove: when each ends, and, where that end lowers the image
 * storage, how much is left then, from the plan in effect at that time (the
 * scheduled one from the end of the plan's period) and the add-ons still
 * going. An end that changes nothing, such as one after a move to a plan
 * without add-ons, says no amount; nor does one whose order against the
 * other ends or the plan change isn't known yet. Null when none is ending.
 */
function endingStorageText(status: BillingStatus): string | null {
  const ending = status.endingStorageAddOns ?? [];
  const { addOn } = proStorage(status);
  if (ending.length === 0 || addOn === null) return null;
  const next = status.subscription?.scheduledPlan ?? null;
  // When the scheduled plan takes over: undefined without one, null while its date isn't known.
  const change = next === null ? undefined : (status.subscription?.currentPeriodEnd ?? null);
  const storageOf = (plan: BillingPlan, addOns: number): number | null => {
    const limit = status.plans[plan].limits.find((entry) => entry.metric === "captureBytes");
    return limit === undefined || limit.max === null ? null : limit.max + (limit.addOn ?? 0) * addOns;
  };
  /** The image storage in effect just before `end`, and from it on, or null when the order of what changes it isn't known. */
  const around = (end: number | null): { before: number | null; after: number | null } | null => {
    if (end === null) {
      // Only ends not known yet and no plan change: whenever they come, what is left is the renewing add-ons on this plan.
      // Several unknown ends may fall on different days, so their order isn't known either.
      if (change !== undefined || ending.length > 1 || ending.some((one) => one.endsAt !== null)) return null;
      return { before: storageOf(status.plan, status.storageAddOns + ending.length), after: storageOf(status.plan, status.storageAddOns) };
    }
    if (change === null || ending.some((one) => one.endsAt === null)) return null;
    const planWhen = (changed: boolean) => (changed ? next! : status.plan);
    const going = (still: (endsAt: number) => boolean) => status.storageAddOns + ending.filter((one) => still(one.endsAt!)).length;
    return {
      before: storageOf(planWhen(change !== undefined && change < end), going((endsAt) => endsAt >= end)),
      after: storageOf(planWhen(change !== undefined && change <= end), going((endsAt) => endsAt > end)),
    };
  };
  // Soonest first; an end not known yet sorts last.
  const ends = [...new Set(ending.map((one) => one.endsAt))].sort((a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY));
  const sentences = ends.map((end) => {
    const units = ending.filter((one) => one.endsAt === end).length;
    const storage = around(end);
    const until = end === null ? "until the end of its billing period" : `until ${dateOf(end)}`;
    const what = ends.length === 1 && status.storageAddOns === 0 ? "Extra storage" : `${size(units * addOn)} of extra storage`;
    const left = storage?.after ?? null;
    const drops = left !== null && (storage!.before === null || left < storage!.before);
    return drops ? `${what} stays ${until}, then image storage goes down to ${size(left)}.` : `${what} stays ${until}.`;
  });
  return sentences.join(" ");
}

function PlansPage({ organization, status, locked, act, go, billing, returnUrl }: BillingContext) {
  const [buying, setBuying] = useState<BillingPlan | null>(null);
  const billed = billedPlan(status);
  const choose = (target: BillingPlan, offer: "upgrade" | "switch") => {
    if (billed === "free") {
      setBuying(target);
      void act(() => billing.changePlan({ organizationId: organization.id, from: "free", plan: target, returnUrl: returnUrl(target) }), `Moved to ${status.plans[target].label}`);
      return;
    }
    if (target === "free") go({ name: "confirm", change: { kind: "cancel" } });
    else go({ name: "confirm", change: { kind: offer === "upgrade" ? "upgrade" : "downgrade", plan: target } });
  };
  const action = (name: BillingPlan): ReactNode => {
    const offer = planOffer(status, name);
    if (offer === null) return null;
    if (offer === "current") return <span className="note">Current plan</span>;
    if (offer === "set-by-critiqs") return <span className="note">Set by Critiqs</span>;
    if (offer === "scheduled") return <span className="note">From {status.subscription?.currentPeriodEnd == null ? "next period" : dateOf(status.subscription.currentPeriodEnd)}</span>;
    const label = `${offer === "upgrade" ? "Upgrade to" : "Switch to"} ${status.plans[name].label}`;
    const chargesCard = billed !== "free" && name !== "free";
    return (
      <button type="button" className="btn small" disabled={locked || (chargesCard && status.prices === null)} onClick={() => choose(name, offer)}>
        {locked && buying === name ? "Opening checkout…" : label}
      </button>
    );
  };
  return (
    <>
      <div className="ds-group billing-plans">
        {PLAN_ORDER.map((name) => {
          const plan = status.plans[name];
          const monthly = monthlyOf(status.prices, name);
          return (
            <SettingRow
              key={name}
              label={
                <span className="stacked billing-plan">
                  <span>{plan.label}</span>
                  <span className="note">{monthly === null ? includesText(plan) : `${monthly} · ${includesText(plan)}`}</span>
                </span>
              }
            >
              {() => action(name)}
            </SettingRow>
          );
        })}
      </div>
      {status.prices === null && <p className="note">{billed === "free" ? "Prices can't be shown right now. Stripe Checkout shows the price before you pay." : PAUSED}</p>}
    </>
  );
}

function changeTitle(change: Change, status: BillingStatus): string {
  switch (change.kind) {
    case "upgrade":
      return `Upgrade to ${status.plans[change.plan].label}`;
    case "downgrade":
      return `Switch to ${status.plans[change.plan].label}`;
    case "cancel":
      return `Switch to ${status.plans.free.label}`;
    case "add-storage":
      return "Add extra storage";
    case "remove-storage":
      return "Remove extra storage";
  }
}

function ConfirmPage({ organization, status, locked, act, billing, returnUrl, change }: BillingContext & { change: Change }) {
  const from = billedPlan(status);
  const current = status.plans[from];
  const end = onEnd(status.subscription?.currentPeriodEnd ?? null);
  const storage = from === "pro" && status.storageAddOns > 0 ? ` Extra storage ends with ${status.plans.pro.label}.` : "";
  const pending = pendingText(status);
  const { id: organizationId, name } = organization;
  const { prices } = status;
  const [lines, run, done] = ((): [string, (() => Promise<BillingChange>) | null, string] => {
    switch (change.kind) {
      case "upgrade": {
        if (prices === null) return [PAUSED, null, ""];
        const plan = status.plans[change.plan];
        return [
          `${name} moves to ${plan.label} now, at ${monthlyOf(prices, change.plan)}. You'll be charged a prorated amount now for the rest of this billing period, on the card on file.`,
          () => billing.changePlan({ organizationId, from, plan: change.plan, returnUrl: returnUrl(change.plan) }),
          `Upgraded to ${plan.label}`,
        ];
      }
      case "downgrade": {
        if (prices === null) return [PAUSED, null, ""];
        const plan = status.plans[change.plan];
        return [
          `${name} changes to ${plan.label} ${end}. ${current.label} stays until then; from then ${plan.label} is ${monthlyOf(prices, change.plan)}, with ${includesText(plan)}.${storage}`,
          () => billing.changePlan({ organizationId, from, plan: change.plan, returnUrl: returnUrl(null) }),
          `Changes to ${plan.label} ${end}`,
        ];
      }
      case "cancel":
        return [
          `${current.label} ends ${end}, then ${name} moves to ${status.plans.free.label}: ${includesText(status.plans.free)}. You won't be charged for the plan again; extra credits used before then are on the last invoice.${storage}`,
          () => billing.changePlan({ organizationId, from, plan: "free", returnUrl: returnUrl(null) }),
          `${current.label} cancels ${end}`,
        ];
      case "add-storage": {
        if (pending !== null) return [`${pending} Keep ${status.plans.pro.label} first, then add storage.`, null, ""];
        if (prices === null) return [PAUSED, null, ""];
        const { addOn } = proStorage(status);
        return [
          `Adds ${addOn === null ? "extra image storage" : `${size(addOn)} of image storage`} to ${name} for ${dollars(prices.storageAddOn.monthly)} a month. You'll be charged a prorated amount now for the rest of this billing period, on the card on file.`,
          () => billing.setStorageAddOn({ organizationId, enabled: true, returnUrl: returnUrl("storage") }),
          "Extra storage added",
        ];
      }
      case "remove-storage": {
        const units = status.storageAddOns;
        const { base, addOn } = proStorage(status);
        const after = base === null ? null : size(base + (addOn ?? 0) * (units - 1));
        const remove = () => billing.setStorageAddOn({ organizationId, enabled: false, returnUrl: returnUrl(null) });
        const done = "Extra storage ends at the end of this billing period";
        if (units > 1) {
          return [
            `One of ${name}'s ${units} storage add-ons stays until the end of this billing period${after === null ? "" : `, then image storage goes down to ${after}`}. You won't be charged for that one again.`,
            remove,
            done,
          ];
        }
        return [
          `${name}'s extra storage stays until the end of this billing period${after === null ? "" : `, then image storage goes back to ${after}`}. You won't be charged for it again.`,
          remove,
          done,
        ];
      }
    }
  })();
  const title = changeTitle(change, status);
  return (
    <>
      <p className="billing-confirm">{lines}</p>
      {run !== null && (
        <div className="ds-actions">
          <button type="button" className="btn primary" disabled={locked} onClick={() => void act(run, done)}>
            {locked ? "Working…" : title}
          </button>
        </div>
      )}
    </>
  );
}

type CapChoice = "default" | "none" | "number";

function CapPage({ organization, status, usage, locked, notify, go }: BillingContext & { notify: (message: string) => void }) {
  const transport = useTransport();
  const credits = usage?.rows.find((row) => row.metric === "aiCredits");
  const extra = usage?.extraCredits;
  const cap = credits?.overage?.cap ?? null;
  const [choice, setChoice] = useState<CapChoice>(extra?.usesDefault !== false ? "default" : cap === null ? "none" : "number");
  const [typed, setTyped] = useState(cap === null ? "" : String(cap));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (credits === undefined || extra === undefined) return null;
  const number = /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : null;
  const value: number | null | "default" | undefined = choice === "default" ? "default" : choice === "none" ? null : (number ?? undefined);
  const save = async () => {
    if (value === undefined || savingRef.current || locked) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await transport.setOverageCap({ organizationId: organization.id, cap: value });
      notify("Cap saved");
      go(MAIN);
    } catch (failure) {
      setError(errorMessage(failure));
      savingRef.current = false;
      setSaving(false);
    }
  };
  const most = choice === "default" ? extra.defaultCap : choice === "number" ? number : null;
  const price = creditPriceOf(status);
  const each = price === null ? null : `each ${count(price.credits)} credits cost ${dollars(price.amount)}`;
  return (
    <form
      className="ds-page"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="note">
        The plan includes {count(credits.max)} credits a month. Past them, {each ?? "extra credits are billed"}, up to the cap.
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ds-group">
        <SettingRow label="Cap">
          {(labelId) => (
            <Select
              value={choice}
              labelledBy={labelId}
              options={[
                { value: "default", label: "Plan default", detail: `${count(extra.defaultCap)} credits` },
                { value: "none", label: "No cap" },
                { value: "number", label: "Set a number" },
              ]}
              onChange={(next) => setChoice(next as CapChoice)}
            />
          )}
        </SettingRow>
        {choice === "number" && (
          <SettingRow label="Extra credits">
            {(labelId) => (
              <input className="field billing-cap-field" inputMode="numeric" aria-labelledby={labelId} value={typed} onChange={(event) => setTyped(event.target.value)} />
            )}
          </SettingRow>
        )}
      </div>
      <p className={choice === "number" && number === null ? "error" : "note"} role="status">
        {choice === "number" && number === null
          ? "Enter a whole number of credits, such as 5000."
          : most === null
            ? `Extra credits have no cap${price === null ? "" : `; each ${count(price.credits)} cost ${dollars(price.amount)}`}.`
            : most === 0
              ? "AI stops when the included credits run out."
              : `Up to ${count(most)} extra credits${price === null ? "" : `, at most ${creditsCost(price, most)}`} a month.`}
      </p>
      <div className="ds-actions">
        <button type="submit" className="btn primary" disabled={saving || locked || value === undefined}>
          {saving ? "Saving…" : "Save cap"}
        </button>
      </div>
    </form>
  );
}
