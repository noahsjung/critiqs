import type { PersonalAiUsage, PlanIncludes, ProjectUsage } from "@critiqs/core";
import { fail } from "./errors.ts";
import type { Store } from "./store.ts";

// Critiqs Cloud's plans. A plan belongs to an organization and applies to
// every project it owns. A plan is configuration: a
// list of limits, each naming what it counts, over what period, and how much
// is allowed. Usage is always counted for every metric and period, whatever
// the plan's limits, so moving to another plan or changing a limit applies to
// usage so far. Counting happens in the same transaction as the change it
// limits, so concurrent or retried requests can't exceed it. Self-hosted
// deployments have no plans: their store reports limits as off. Critiqs AI
// is counted in credits (`aiCredits`), against the organization of the
// project that pays, or the home organization of the person who pays.

/** What a limit counts. */
export type Metric =
  /** Projects an organization has. */
  | "projects"
  /** Threads started in a project. */
  | "threads"
  /** Comments and replies posted in a project. */
  | "messages"
  /** Different reviewers who posted in a project. */
  | "reviewers"
  /** Bytes of captures and screenshots an organization stores. */
  | "captureBytes"
  /** Mention emails a project sends. */
  | "mentionEmails"
  /** Critiqs AI credits an organization uses: its projects' requests, and its members' own. */
  | "aiCredits"
  /** No longer counted or limited: Critiqs AI credits a project used, before `aiCredits`. */
  | "aiRequests"
  /** No longer counted or limited: a person's own Critiqs AI credits, before `aiCredits`. */
  | "personalAiRequests";

export interface Limit {
  metric: Metric;
  /** Counted over all time, or per calendar month or day (UTC). */
  period: Period;
  /** How much the plan includes. */
  max: number;
  /** Usage may go past `max`, billed as extra, by the organization's overage cap: `defaultCap` unless an admin chose another. */
  overage?: { defaultCap: number };
  /** Each add-on unit an organization buys raises `max` by `size`. */
  addOn?: { size: number };
}

export type Period = "total" | "month" | "day";
export const PERIODS: Period[] = ["total", "month", "day"];

/** Metrics counted per organization; the rest count per project. */
export const ORGANIZATION_METRICS: readonly Metric[] = ["projects", "aiCredits", "captureBytes"];
const isOrganizationMetric = (metric: Metric) => ORGANIZATION_METRICS.includes(metric);
/** Organization metrics each project counts too, so the organization's total can be recounted from its projects' (see `recountStorage`). */
export const ALSO_PER_PROJECT: readonly Metric[] = ["captureBytes"];

export interface Plan {
  name: string;
  /** Shown to project owners. */
  label: string;
  /** What the plan limits; a metric with no limit is unlimited. */
  limits: Limit[];
}

/** A plan's limit as it applies to one organization. */
export interface OrganizationLimit {
  metric: Metric;
  period: Period;
  /** What the plan includes, with the organization's add-ons. */
  max: number;
  /** Extra usage allowed past `max`; a null cap allows any. Null when the plan allows none. */
  overage: { cap: number | null } | null;
}

/** A plan as it applies to one organization. */
export interface OrganizationPlan {
  name: string;
  label: string;
  limits: OrganizationLimit[];
}

/** The most usage a limit allows: what the plan includes and the extra its cap allows. */
export function ceilingOf(limit: OrganizationLimit): number {
  if (limit.overage === null) return limit.max;
  return limit.overage.cap === null ? Number.POSITIVE_INFINITY : limit.max + limit.overage.cap;
}

/** The plan an organization has unless it was given another. */
export const DEFAULT_PLAN = "free";

/** Plans renamed since organizations were given them, and the plan they are now. */
const RENAMED_PLANS: Record<string, string> = { team: "plus" };

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/**
 * Critiqs Cloud's plans. A deployment can replace any of them without code
 * changes (see the store's `limits.plan`).
 */
export const DEFAULT_PLANS: Record<string, Plan> = {
  free: {
    name: "free",
    label: "Free",
    limits: [
      { metric: "aiCredits", period: "month", max: 200 },
      { metric: "projects", period: "total", max: 1 },
      { metric: "reviewers", period: "month", max: 5 },
      { metric: "messages", period: "month", max: 500 },
      { metric: "captureBytes", period: "total", max: 500 * MB },
      { metric: "mentionEmails", period: "day", max: 100 },
    ],
  },
  plus: {
    name: "plus",
    label: "Plus",
    limits: [
      { metric: "aiCredits", period: "month", max: 2_000, overage: { defaultCap: 2_000 } },
      { metric: "projects", period: "total", max: 10 },
      { metric: "reviewers", period: "month", max: 25 },
      { metric: "messages", period: "month", max: 5_000 },
      { metric: "captureBytes", period: "total", max: 10 * GB },
    ],
  },
  pro: {
    name: "pro",
    label: "Pro",
    limits: [
      { metric: "aiCredits", period: "month", max: 10_000, overage: { defaultCap: 10_000 } },
      { metric: "captureBytes", period: "total", max: 100 * GB, addOn: { size: 100 * GB } },
    ],
  },
};

const METRIC_WORDS: Record<Metric, { one: string; many: string }> = {
  projects: { one: "project", many: "projects" },
  threads: { one: "thread", many: "threads" },
  messages: { one: "comment", many: "comments" },
  reviewers: { one: "reviewer", many: "reviewers" },
  captureBytes: { one: "byte of images", many: "of images" },
  mentionEmails: { one: "mention email", many: "mention emails" },
  aiCredits: { one: "Critiqs AI credit", many: "Critiqs AI credits" },
  aiRequests: { one: "Critiqs AI credit", many: "Critiqs AI credits" },
  personalAiRequests: { one: "personal Critiqs AI credit", many: "personal Critiqs AI credits" },
};

/** What an organization holds that changes its plan's limits. */
export interface PlanHolder {
  plan?: string;
  overageCap?: number | null;
  extraStorageUnits?: number;
}

/** Whether a plan of this name exists on the deployment, configured or built in, including renamed ones. */
export async function planExists(store: Store, name: string): Promise<boolean> {
  return (await configuredOrBuiltIn(store, name)) !== null;
}

async function configuredOrBuiltIn(store: Store, name: string): Promise<Plan | null> {
  const configured = await store.limits.plan(name);
  if (configured !== null) return configured;
  const renamed = RENAMED_PLANS[name];
  return renamed === undefined ? (DEFAULT_PLANS[name] ?? null) : await configuredOrBuiltIn(store, renamed);
}

/**
 * The plan an organization has, as it applies to it, or null when this
 * deployment has no plans. No organization (null) has the default plan.
 */
export async function planFor(store: Store, holder: PlanHolder | null): Promise<OrganizationPlan | null> {
  if (!store.limits.enabled()) return null;
  const plan = (await configuredOrBuiltIn(store, holder?.plan ?? DEFAULT_PLAN)) ?? DEFAULT_PLANS[DEFAULT_PLAN]!;
  return {
    name: plan.name,
    label: plan.label,
    limits: plan.limits.map((limit) => ({
      metric: limit.metric,
      period: limit.period,
      max: limit.max + (limit.addOn === undefined ? 0 : limit.addOn.size * (holder?.extraStorageUnits ?? 0)),
      overage: limit.overage === undefined ? null : { cap: holder?.overageCap === undefined ? limit.overage.defaultCap : holder.overageCap },
    })),
  };
}

/** A UTC day as `YYYY-MM-DD`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The UTC day a usage query asks about, as `YYYY-MM-DD`; today when it names none. */
export function usageDay(day: string | undefined, now: number): string {
  if (day === undefined) return utcDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("invalid", "The day must be written as YYYY-MM-DD.");
  return day;
}

/** The counter key for a metric's usage in the period containing `day`. */
export function usageKey(metric: Metric, period: Period, scopeId: string, day: string): string {
  const when = period === "total" ? "total" : period === "month" ? day.slice(0, 7) : day;
  return `${metric}:${scopeId}:${when}`;
}

interface QuotaArgs {
  plan: OrganizationPlan | null;
  metric: Metric;
  /** Where organization-wide metrics count: the organization (or its stand-in, a person). */
  accountId: string;
  projectId: string | null;
  now: number;
}

/**
 * Counts `amount` of `metric`, in the current transaction, for every period.
 * With `member`, each member counts once per period, such as a reviewer
 * posting many comments in a month. Refuses with a `limit` error, counting
 * nothing, when any of the plan's limits would be exceeded past its overage;
 * `soft` returns false instead, for extras such as emails that can simply be
 * skipped. `overrun` counts past the limits, for work already done.
 */
export async function useQuota(store: Store, args: QuotaArgs & { amount?: number; member?: string; soft?: boolean; overrun?: boolean }): Promise<boolean> {
  if (args.plan === null) return true;
  const scopeId = isOrganizationMetric(args.metric) ? args.accountId : args.projectId;
  if (scopeId === null) return true;
  const day = utcDay(args.now);
  const counters = [];
  for (const period of PERIODS) {
    const key = usageKey(args.metric, period, scopeId, day);
    const counter = await store.usage.find(key);
    const counted = args.member !== undefined && (await store.usage.isMember(key, args.member));
    const amount = counted ? 0 : (args.amount ?? 1);
    counters.push({ period, key, counter, amount, next: (counter?.count ?? 0) + amount });
  }
  for (const limit of args.plan.limits) {
    if (limit.metric !== args.metric) continue;
    const counter = counters.find((candidate) => candidate.period === limit.period)!;
    if (counter.amount > 0 && counter.next > ceilingOf(limit) && !args.overrun) {
      if (args.soft) return false;
      fail("limit", limitMessage(args.plan, limit));
    }
  }
  for (const { key, counter, amount, next } of counters) {
    if (amount === 0) continue;
    if (counter === null) await store.usage.insert({ key, count: next });
    else await store.usage.patch(counter._id, { count: next });
    if (args.member !== undefined) await store.usage.addMember(key, args.member);
  }
  if (ALSO_PER_PROJECT.includes(args.metric) && args.projectId !== null) {
    for (const { period, amount } of counters) if (amount > 0) await addUsage(store, usageKey(args.metric, period, args.projectId, day), amount);
  }
  return true;
}

/** Adds `amount` to a usage counter, starting it if needed. */
export async function addUsage(store: Store, key: string, amount: number): Promise<void> {
  const counter = await store.usage.find(key);
  if (counter === null) await store.usage.insert({ key, count: amount });
  else await store.usage.patch(counter._id, { count: counter.count + amount });
}

/**
 * Counts one use under every key, in the current transaction, when each is
 * below its maximum; otherwise counts nothing and returns false. For limits
 * every deployment has, plans or not, such as emails per hour.
 */
export async function countWithinAll(store: Store, limits: [key: string, max: number][]): Promise<boolean> {
  const counters = [];
  for (const [key, max] of limits) {
    const counter = await store.usage.find(key);
    if ((counter?.count ?? 0) >= max) return false;
    counters.push({ key, counter });
  }
  for (const { key, counter } of counters) {
    if (counter === null) await store.usage.insert({ key, count: 1 });
    else await store.usage.patch(counter._id, { count: counter.count + 1 });
  }
  return true;
}

/**
 * Refuses when a limit is already reached past its overage, or `amount` more
 * would pass it, without counting anything.
 */
export async function requireRoom(store: Store, args: QuotaArgs & { amount?: number }): Promise<void> {
  if (args.plan === null) return;
  const scopeId = isOrganizationMetric(args.metric) ? args.accountId : args.projectId;
  if (scopeId === null) return;
  for (const limit of args.plan.limits) {
    if (limit.metric !== args.metric) continue;
    const counter = await store.usage.find(usageKey(limit.metric, limit.period, scopeId, utcDay(args.now)));
    if ((counter?.count ?? 0) + (args.amount ?? 1) > ceilingOf(limit)) fail("limit", limitMessage(args.plan, limit));
  }
}

function limitMessage(plan: OrganizationPlan, limit: OrganizationLimit): string {
  const words = METRIC_WORDS[limit.metric];
  const amount =
    limit.metric === "captureBytes" ? formatBytes(limit.max) : `${limit.max.toLocaleString("en-US")} ${limit.max === 1 ? words.one : words.many}`;
  const when = limit.period === "month" ? " this month" : limit.period === "day" ? " today" : "";
  const whose = limit.metric === "projects" ? "Your organization" : isOrganizationMetric(limit.metric) ? "This project's organization" : "This project";
  const extra = limit.overage === null || limit.overage.cap === null ? "" : ` and ${limit.overage.cap.toLocaleString("en-US")} extra`;
  const next = limit.overage === null ? "An admin of the organization can upgrade the plan." : "An admin of the organization can raise the cap on extra credits.";
  return `${whose} has reached the ${plan.label} plan's limit of ${amount}${extra}${when}. ${next}`;
}

function formatBytes(bytes: number): string {
  return bytes >= GB ? `${Math.round(bytes / GB)} GB of images` : `${Math.round(bytes / MB)} MB of images`;
}

/** What people are shown of a plan, in this order, and the period to report one over when the plan doesn't limit it. */
const UNLIMITED_PERIODS: { metric: UsageMetric; period: Period }[] = [
  { metric: "aiCredits", period: "month" },
  { metric: "projects", period: "total" },
  { metric: "captureBytes", period: "total" },
  { metric: "reviewers", period: "month" },
  { metric: "messages", period: "month" },
  { metric: "mentionEmails", period: "day" },
];

/** What the plan of this name includes, configured or built in (Free when there is no such plan), for pages that compare plans. */
export async function planIncludes(store: Store, name: string): Promise<PlanIncludes> {
  const plan = (await configuredOrBuiltIn(store, name)) ?? DEFAULT_PLANS[DEFAULT_PLAN]!;
  const limits: PlanIncludes["limits"] = [];
  for (const { metric, period } of UNLIMITED_PERIODS) {
    const set = plan.limits.filter((limit) => limit.metric === metric);
    if (set.length === 0) limits.push({ metric, period, max: null });
    for (const limit of set) limits.push({ metric, period: limit.period, max: limit.max, ...(limit.addOn === undefined ? {} : { addOn: limit.addOn.size }) });
  }
  return { label: plan.label, limits };
}

type UsageMetric = ProjectUsage["rows"][number]["metric"];
const isUsageMetric = (metric: Metric): metric is UsageMetric => metric !== "personalAiRequests";

/**
 * Usage in the periods containing `day`, a UTC day the caller chooses so a
 * reactive query can follow the clock. Without a project, only what counts
 * for the whole organization.
 */
export async function usageSummary(
  store: Store,
  quota: { plan: OrganizationPlan | null; accountId: string; projectId: string | null },
  day: string,
): Promise<ProjectUsage | null> {
  const { plan, projectId } = quota;
  if (plan === null) return null;
  const shown = (metric: Metric): metric is UsageMetric => isUsageMetric(metric) && (projectId !== null || isOrganizationMetric(metric));
  const used = async (metric: Metric, period: Period) =>
    (await store.usage.find(usageKey(metric, period, isOrganizationMetric(metric) ? quota.accountId : projectId!, day)))?.count ?? 0;
  const rows: ProjectUsage["rows"] = [];
  for (const limit of plan.limits) {
    if (!shown(limit.metric)) continue;
    rows.push({ metric: limit.metric, period: limit.period, used: await used(limit.metric, limit.period), max: limit.max, ...overageOf(limit) });
  }
  const unlimited: NonNullable<ProjectUsage["unlimited"]> = [];
  for (const { metric, period } of UNLIMITED_PERIODS) {
    if (!shown(metric) || plan.limits.some((limit) => limit.metric === metric)) continue;
    unlimited.push({ metric, period, used: await used(metric, period) });
  }
  return { plan: plan.label, rows, ...(unlimited.length === 0 ? {} : { unlimited }), ...upgradeOf(store) };
}

function overageOf(limit: OrganizationLimit): { overage?: { cap: number | null } } {
  return limit.overage === null ? {} : { overage: limit.overage };
}

/** Accepts an upgrade page's address only when it is https, so a typo can't send people somewhere unsafe. */
export function upgradeAddress(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The deployment's upgrade page (`CRITIQS_UPGRADE_URL`), when it names one, for answers that carry it. */
export function upgradeOf(store: Store): { upgradeUrl?: string } {
  const url = store.limits.upgradeUrl?.() ?? null;
  return url === null ? {} : { upgradeUrl: url };
}

/**
 * The Critiqs AI credits (`aiCredits`) counted where a person's own Critiqs
 * AI counts (see `personalQuota`), in the periods containing `day`, one row
 * per period the plan limits. Null when this deployment has no plans; a null
 * account, for someone not yet recorded, has used nothing.
 */
export async function personalUsageSummary(
  store: Store,
  quota: { plan: OrganizationPlan | null; accountId: string | null; organizationId?: string | null },
  day: string,
): Promise<PersonalAiUsage | null> {
  const { plan, accountId, organizationId } = quota;
  if (plan === null) return null;
  const rows: PersonalAiUsage["rows"] = [];
  for (const limit of plan.limits) {
    if (limit.metric !== "aiCredits") continue;
    const counter = accountId === null ? null : await store.usage.find(usageKey(limit.metric, limit.period, accountId, day));
    rows.push({ period: limit.period, used: counter?.count ?? 0, max: limit.max, ...overageOf(limit) });
  }
  return { plan: plan.label, ...(organizationId == null ? {} : { organizationId }), rows, ...upgradeOf(store) };
}
