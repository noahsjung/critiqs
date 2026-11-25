import { ceilingOf, type OrganizationLimit, type OrganizationPlan } from "./limits.ts";
import { LEASE_MS, MAX_ATTEMPTS, RETRY_MINUTES } from "./notify.ts";
import { MailError, type Mailer, type MailMessage } from "./signin.ts";
import type { PlanAlertKind, PlanAlertRecord, Store } from "./store.ts";

// Emails to an organization's admins when its Critiqs AI credits run out:
// when the credits its plan includes are used and extra credits start being
// billed, and when no credits are left this month. Owed in the same
// transaction as the charge that crossed the line, at most once of each kind
// per organization, month, and plan, so an organization that changes plan
// hears about the new one; then sent by a worker like mention emails.

/** Most admins one alert emails. */
const MAX_ADMINS = 50;

/**
 * The line a month's credits cross when `amount` more is asked for on top of
 * `before`: counted when `allowed`, otherwise refused because it doesn't fit,
 * which leaves nothing for it. Crossing both at once is only `paused`.
 */
export function crossedLine(limit: OrganizationLimit, before: number, amount: number, allowed: boolean): PlanAlertKind | null {
  const ceiling = ceilingOf(limit);
  const after = before + amount;
  if (!allowed) return after > ceiling ? "paused" : null;
  if (Number.isFinite(ceiling) && before < ceiling && after >= ceiling) return "paused";
  if (ceiling > limit.max && before < limit.max && after >= limit.max) return "included";
  return null;
}

/** Owes an organization's admins an alert, unless one of that kind is already owed this month under the same plan. In the caller's transaction. */
export async function owePlanAlert(
  store: Store,
  args: { organizationId: string; kind: PlanAlertKind; month: string; plan: OrganizationPlan; limit: OrganizationLimit; projectId: string | null; now: number },
): Promise<void> {
  if ((await store.planAlerts.find(args.organizationId, args.kind, args.month, args.plan.name)) !== null) return;
  await store.planAlerts.insert({
    organizationId: args.organizationId,
    kind: args.kind,
    month: args.month,
    plan: args.plan.name,
    planLabel: args.plan.label,
    included: args.limit.max,
    ...(args.limit.overage === null ? {} : { overage: args.limit.overage }),
    ...(args.projectId === null ? {} : { projectId: args.projectId }),
    status: "pending",
    attempts: 0,
    dueAt: args.now,
    createdAt: args.now,
  });
}

/** Takes due alerts for one worker run, under its own token. */
export async function claimPlanAlerts(store: Store, now: number, limit: number, claimToken: string): Promise<string[]> {
  const claimed: string[] = [];
  for (const alert of await store.planAlerts.due(now, limit)) {
    if (alert.attempts >= MAX_ATTEMPTS) {
      await store.planAlerts.patch(alert._id, { status: "failed", finishedAt: now, reason: alert.reason ?? `Gave up after ${MAX_ATTEMPTS} attempts.` });
      continue;
    }
    await store.planAlerts.patch(alert._id, { status: "sending", claimToken, leaseUntil: now + LEASE_MS, attempts: alert.attempts + 1 });
    claimed.push(alert._id);
  }
  return claimed;
}

/** The emails a claimed alert sends, one per admin with an address; null when another worker holds it. */
export async function planAlertEmails(store: Store, args: { id: string; claimToken: string }): Promise<MailMessage[] | null> {
  const alert = await store.planAlerts.get(args.id);
  if (alert === null || alert.status !== "sending" || alert.claimToken !== args.claimToken) return null;
  const organization = await store.organizations.get(alert.organizationId);
  if (organization === null) return [];
  const project = alert.projectId === undefined ? null : await store.projects.get(alert.projectId);
  const email = alertEmail(alert, organization.name, project?.reviewUrl ?? null);
  const messages: MailMessage[] = [];
  for (const admin of await store.memberships.admins(organization._id, MAX_ADMINS)) {
    const to = (await store.users.get(admin.userId))?.email;
    if (to) messages.push({ to, ...email, idempotencyKey: `plan-alert-${alert._id}-${admin.userId}` });
  }
  return messages;
}

export type PlanAlertOutcome = { result: "sent" | "skipped" | "failed"; reason?: string };

/** Sends an alert's emails; a retry sends each again under the same key, so the mail service drops ones it already sent. */
export async function sendPlanAlert(mailer: Mailer | null, messages: MailMessage[]): Promise<PlanAlertOutcome> {
  if (mailer === null) return { result: "skipped", reason: "Email isn't set up for this deployment." };
  if (messages.length === 0) return { result: "skipped", reason: "The organization has no admin with an email address." };
  try {
    for (const message of messages) await mailer.send(message);
    return { result: "sent" };
  } catch (error) {
    if (!(error instanceof MailError)) throw error;
    return { result: "failed", reason: error.message };
  }
}

/** Records how sending went, only for alerts this worker still holds. Failures are retried after growing pauses. */
export async function completePlanAlerts(store: Store, outcomes: ({ id: string; claimToken: string } & PlanAlertOutcome)[], now: number): Promise<void> {
  for (const outcome of outcomes) {
    const alert = await store.planAlerts.get(outcome.id);
    if (alert === null || alert.status !== "sending" || alert.claimToken !== outcome.claimToken) continue;
    if (outcome.result === "sent") await store.planAlerts.patch(alert._id, { status: "sent", finishedAt: now });
    else if (outcome.result === "skipped") await store.planAlerts.patch(alert._id, { status: "skipped", finishedAt: now, reason: outcome.reason });
    else if (alert.attempts >= MAX_ATTEMPTS) await store.planAlerts.patch(alert._id, { status: "failed", finishedAt: now, reason: outcome.reason });
    else {
      const pause = RETRY_MINUTES[Math.min(alert.attempts - 1, RETRY_MINUTES.length - 1)]! * 60_000;
      await store.planAlerts.patch(alert._id, { status: "pending", dueAt: now + pause, reason: outcome.reason });
    }
  }
}

const count = (amount: number) => amount.toLocaleString("en-US");

/** The first day of the month after `month` (`YYYY-MM`), such as "December 1". */
function nextMonthStart(month: string): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, index, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The alert's subject and body: what ran out, what happens now, and where to see usage. */
export function alertEmail(
  alert: Pick<PlanAlertRecord, "kind" | "month" | "planLabel" | "included" | "overage">,
  organization: string,
  reviewUrl: string | null,
): { subject: string; text: string; html: string } {
  const cap = alert.overage?.cap ?? null;
  let subject: string;
  let what: string;
  let next: string;
  if (alert.kind === "included") {
    subject = `${organization} has used its included Critiqs AI credits`;
    what = `${organization} has used the ${count(alert.included)} Critiqs AI credits its ${alert.planLabel} plan includes this month.`;
    next =
      cap === null
        ? "Critiqs AI keeps working. Extra credits are billed at your plan's rate, with no cap. An admin can set a cap."
        : `Critiqs AI keeps working. Extra credits are billed at your plan's rate, up to ${count(cap)} extra credits this month. An admin can change that cap.`;
  } else {
    subject = `Critiqs AI is paused for ${organization}`;
    const extra = alert.overage === undefined ? "" : `, and its cap allows ${count(cap ?? 0)} extra`;
    what = `${organization} doesn't have enough Critiqs AI credits left this month. Its ${alert.planLabel} plan includes ${count(alert.included)} a month${extra}.`;
    const until = alert.overage === undefined ? "an admin upgrades the plan" : "an admin raises the cap on extra credits";
    next = `Critiqs AI is paused until ${nextMonthStart(alert.month)} (UTC), or until ${until}.`;
  }
  const where = reviewUrl === null ? "See usage in Critiqs setup, in any of the organization's projects." : "See usage in the project's Critiqs setup:";
  const why = `You get this email as an admin of ${organization}.`;
  const text = [what, next, reviewUrl === null ? where : `${where} ${reviewUrl}`, why].join("\n\n");
  const link = reviewUrl === null ? "" : ` <a href="${escapeHtml(reviewUrl)}">${escapeHtml(reviewUrl)}</a>`;
  const html = `<p>${escapeHtml(what)}</p><p>${escapeHtml(next)}</p><p>${escapeHtml(where)}${link}</p><p>${escapeHtml(why)}</p>`;
  return { subject, text, html };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
