import {
  DEVELOPER_INVITES_PER_PERSON_PER_DAY,
  DEVELOPER_RESEND_AFTER_MS,
  MAX_DEVELOPER_RESENDS,
  type DeveloperInvite,
  type DeveloperLimit,
  type DeveloperSendResult,
  type DeveloperSendStatus,
  type DeveloperSendSummary,
  type DeveloperSetup,
  installCommands,
  listOr,
  MAX_DEVELOPER_INVITES_PER_PROJECT,
  PACKAGE_STACK_NAMES,
  type ProjectSetup,
  SCRIPT_TAG_GUIDE,
  STACKS,
  type StackId,
  type StackInfo,
} from "@critiqs/core";
import { fail } from "./errors.ts";
import { countOrRefuse, countWithinAll, utcDay } from "./limits.ts";
import { currentReviewer, requireProject, requireUser } from "./operations.ts";
import { hasMemberAt, inboxOf, inviteAddress, inviteEmailLimits, inviteLimit, projectAccess, projectRole, shorten } from "./organizations.ts";
import { escapeHtml, MailError, type MailMessage, sameDigest } from "./signin.ts";
import type { DeveloperAttempt, DeveloperSendRecord, Identity, ProjectRecord, StoredMail, Store } from "./store.ts";

// Sending a project's setup steps to its developers, on the person's behalf.
// See the install-free review research. A send
// belongs to the project, not to an organization invite: each project keeps
// one record per developer address, each address gets one email, and an
// email goes out only after one transaction has checked and counted every
// limit and reserved it.

/** Where setup links go when a deployment names no website: Critiqs's own. */
export const DEFAULT_WEB_URL = "https://critiqs.app";

/**
 * The Critiqs website's address that setup links start with: `value` without
 * a trailing slash, or `fallback` when it is unset. Null when it isn't an
 * HTTPS address (HTTP only on this computer) without credentials, a query, or
 * a hash, or when it is unset with no fallback; then setup emails can't go out.
 */
export function webBase(value: string | undefined | null, fallback: string | null): string | null {
  const raw = value?.trim() || fallback;
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // As review addresses allow: plain HTTP only on this computer.
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
  const secure = url.protocol === "https:" || (url.protocol === "http:" && local);
  if (!secure || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The page a setup email links to, which shows the developer the project's install steps once they sign in. */
export function setupUrl(base: string, sendId: string): string {
  return `${base}/setup/${encodeURIComponent(sendId)}`;
}

/** Where a developer reports a setup email as unwanted, relative to the backend's own address. */
export const REPORT_PATH = "/developer-emails/report";

/** The idempotency key of a send's email number `number`, counted from 0: an email that replaces a failed one gets its own. */
export function developerEmailKey(sendId: string, number: number): string {
  return `critiqs-developer:${sendId}:${number}`;
}

/**
 * How long after an email's first attempt a retry under its key may still go
 * to the mail service. The mail service keeps a key for 24 hours from when it
 * first gets it; retries stop an hour sooner, so a slow request can't arrive
 * after it forgets the key and sends a second email.
 */
export const RETRY_WINDOW_MS = 23 * 60 * 60_000;

/**
 * A send's status, from its email's attempts: `sent` once the mail service
 * accepted one; `failed` when every one was refused, none left unanswered,
 * so it certainly wasn't delivered; otherwise `uncertain`, since an
 * unanswered attempt may have been.
 */
export function sendStatus(attempts: readonly DeveloperAttempt[]): DeveloperSendStatus {
  if (attempts.some((attempt) => attempt.answer === "accepted")) return "sent";
  if (attempts.length > 0 && attempts.every((attempt) => attempt.answer === "refused")) return "failed";
  return "uncertain";
}

/**
 * Whether an uncertain email goes to the mail service again under its key
 * at `now`: never tried, or within `RETRY_WINDOW_MS` of its first attempt.
 * Past that it counts as possibly delivered and is never sent again.
 */
function retryable(attempts: readonly DeveloperAttempt[], now: number): boolean {
  return sendStatus(attempts) === "uncertain" && (attempts.length === 0 || now < attempts[0]!.at + RETRY_WINDOW_MS);
}

/**
 * How long an attempt still waiting for the mail service's answer holds its
 * email: no other attempt is claimed meanwhile, so presses of Send at once
 * send one email even through a mail service that ignores idempotency keys.
 * Longer than any send runs (a Convex action stops after 10 minutes), so it
 * only frees an email whose sender stopped mid-send.
 */
export const DEVELOPER_ATTEMPT_CLAIM_MS = 15 * 60_000;

/** Whether an attempt may be claimed at `now`: the email is retryable, and no attempt is still waiting for an answer. */
function claimable(attempts: readonly DeveloperAttempt[], now: number): boolean {
  const last = attempts.at(-1);
  return retryable(attempts, now) && (last === undefined || last.answer !== null || now >= last.at + DEVELOPER_ATTEMPT_CLAIM_MS);
}

/** A link's scheme, or `www.`. */
const LINK_START = /:\/\/|www\./i;
/** A run of characters a domain-like name is made of, split at spaces, `@`, `/`, and other punctuation. */
const NAME_TOKEN = /[\p{L}\p{N}_.-]+/gu;
/** A label after a dot that starts with two letters, as a top-level domain does. */
const TLD_LIKE = /^\p{L}{2}/u;

/**
 * File endings that real product and file names use, such as `Next.js`,
 * `Vue.js`, or `index.html`. None is a delegated top-level domain in IANA's
 * root list (https://data.iana.org/TLD/tlds-alpha-by-domain.txt, checked
 * 2026-11-25, version 2026112402), so none can end a real web address.
 * `.md`, `.rs`, and `.py` are left out because they are country domains.
 */
const CODE_FILE_ENDINGS: ReadonlySet<string> = new Set(
  ["js", "ts", "jsx", "tsx", "mjs", "cjs", "rb", "go", "css", "html", "json", "yml", "yaml", "vue", "svelte"],
);

/**
 * Whether `text` has a web address in it: `://`, `www.`, or a domain-like
 * `name.tld`. A version such as `2.0` isn't one, since a top-level domain is
 * letters, and neither is a name whose every letter label after a dot is a
 * code file's ending, such as `Next.js`. Linear time: each character is in
 * at most one token, and each test reads its token once.
 */
export function hasWebAddress(text: string): boolean {
  if (LINK_START.test(text)) return true;
  for (const [token] of text.matchAll(NAME_TOKEN)) {
    // A label counts only after a name, so `.NET` isn't a domain.
    const labels = token.split(".");
    if (labels.some((label, index) => index > 0 && labels[index - 1] !== "" && TLD_LIKE.test(label) && !CODE_FILE_ENDINGS.has(label.toLowerCase()))) return true;
  }
  return false;
}

const LIMIT_MESSAGES: Record<DeveloperLimit, (email: string) => string> = {
  developers: () => `A project can send setup steps to ${MAX_DEVELOPER_INVITES_PER_PROJECT} developers. Copy the message instead.`,
  person: () => `You've sent ${DEVELOPER_INVITES_PER_PERSON_PER_DAY} developer emails today. Copy the message instead.`,
  inbox: (email) => `${email} got as many emails from Critiqs as it can today. Try again tomorrow, or copy the message instead.`,
  deployment: () => "Critiqs is sending a lot of emails right now. Try again later, or copy the message instead.",
  wait: (email) => `${email} got the steps less than a day ago. You can send them again 24 hours after the last email.`,
  resends: (email) => `${email} was already sent the steps again ${MAX_DEVELOPER_RESENDS} times. Copy the message instead.`,
};

/** When a send's current email went out: the attempt the mail service accepted, else its first attempt, else when it was reserved. */
function sentAt(send: DeveloperSendRecord): number {
  return (send.attempts.find((attempt) => attempt.answer === "accepted") ?? send.attempts[0])?.at ?? send.reservedAt;
}

/** When the steps can go to a send's address again, or null when they can't (see `DeveloperSendSummary`). */
export function resendAt(send: DeveloperSendRecord): number | null {
  if (sendStatus(send.attempts) === "failed" || (send.resends ?? 0) >= MAX_DEVELOPER_RESENDS) return null;
  return sentAt(send) + DEVELOPER_RESEND_AFTER_MS;
}

/** An email reserved in the transaction, for the email path to deliver once it commits. */
export interface ReservedEmail {
  sendId: string;
  idempotencyKey: string;
}

/**
 * Reserves a setup email to each address, for the people who manage the
 * project. A project or sender name with a web address in it refuses the
 * whole request (`invalid`), since plain-text emails would show it as a
 * link; so does an organization name with one, when a new email in the
 * request would name it: the sender is its admin, whose send invites, or that
 * developer already has an invite to it waiting. Otherwise every address is decided on its own, in order: an invalid
 * or suppressed address, one that already got this project's email (or may
 * have), a project at its developers, or a full limit refuses that address,
 * recording nothing and counting nothing. An email waiting for a retry is
 * retried under its key, counting nothing again. Otherwise its send is
 * recorded, new or replacing a failed email, and counted against the
 * person's day, the inbox's day, and the deployment's hour (the last two
 * shared with invite emails), in this transaction. When the sender is an
 * admin of the project's organization, a newly reserved email invites the
 * developer to it as a member, unless they are already in it or invited;
 * each `sent` result's `invite` says which happened. A retried email never
 * invites: its `invite` is the developer's state now, so an invite withdrawn
 * since stays withdrawn.
 *
 * With `resend`, an address whose email went out (or may have) is sent the
 * steps again instead of answering `already-sent`: 24 hours after that email
 * (`DEVELOPER_RESEND_AFTER_MS`), at most `MAX_DEVELOPER_RESENDS` times, as a
 * new email under the next key, counted against the person's day, the
 * inbox's day, and the deployment's hour like any other. Too soon, or past
 * the resends, refuses that address (`limit`, `wait` or `resends`). It
 * doesn't count against the project's developers, and never invites.
 */
export async function reserveDeveloperSends(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; emails: string[]; resend?: boolean },
  now: number,
): Promise<{ results: DeveloperSendResult[]; reserved: ReservedEmail[] }> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const { access, organization } = await projectRole(store, project, user._id);
  if (access !== "manage") fail("forbidden", "Only the people who manage this project can send its setup steps.");
  if (args.emails.length === 0 || args.emails.length > MAX_DEVELOPER_INVITES_PER_PROJECT) {
    fail("invalid", `Send to 1 to ${MAX_DEVELOPER_INVITES_PER_PROJECT} developers at a time.`);
  }
  if (hasWebAddress(project.name)) fail("invalid", "Project names in setup emails can't contain web addresses. Rename the project and try again.");
  if (hasWebAddress(user.name)) fail("invalid", "Names in setup emails can't contain web addresses. Change your name and try again.");
  /** The organization's name, when it has a web address in it and so can't be in an email. */
  const unsafeOrganization = organization !== null && hasWebAddress(organization.name) ? organization : null;
  const inviteTo = organization?.role === "admin" ? organization.id : null;
  const invite = async (email: string): Promise<DeveloperInvite> => (inviteTo === null ? "none" : await inviteDeveloper(store, inviteTo, email, user._id, now));
  const inviteNow = async (email: string): Promise<DeveloperInvite> => (inviteTo === null ? "none" : ((await inviteState(store, inviteTo, email)) ?? "none"));
  const results: DeveloperSendResult[] = [];
  const reserved: ReservedEmail[] = [];
  /** Each address's result in this request: the same address again, in any case, is the same email and result. */
  const decided = new Map<string, DeveloperSendResult>();
  for (const raw of args.emails) {
    const email = inviteAddress(raw);
    if (email === null) {
      results.push({ email: raw.trim(), status: "invalid", message: "Enter a valid email address." });
      continue;
    }
    const earlier = decided.get(email);
    if (earlier !== undefined) {
      results.push(earlier);
      continue;
    }
    const result = await decide(email);
    decided.set(email, result);
    results.push(result);
  }
  return { results, reserved };

  async function namesOrganization(organizationId: string, email: string): Promise<boolean> {
    if (await joins(store, organizationId, email)) return true;
    return inviteTo !== null && !(await hasMemberAt(store, organizationId, email));
  }

  async function decide(email: string): Promise<DeveloperSendResult> {
    const inbox = inboxOf(email);
    if (await store.emailSuppressions.has(inbox)) return { email, status: "suppressed" };
    const existing = await store.developerSends.find(project._id, email);
    if (existing !== null && retryable(existing.attempts, now)) {
      reserved.push({ sendId: existing._id, idempotencyKey: developerEmailKey(existing._id, existing.emailNumber) });
      return { email, status: "sent", sendId: existing._id, invite: await inviteNow(email) };
    }
    /** Sending the steps again to an address whose email went out, or may have: asked for, 24 hours after it, at most twice. */
    const again = existing !== null && sendStatus(existing.attempts) !== "failed";
    if (again && args.resend !== true) return { email, status: "already-sent", sendId: existing._id };
    if (again && (existing.resends ?? 0) >= MAX_DEVELOPER_RESENDS) return { email, status: "limit", limit: "resends", message: LIMIT_MESSAGES.resends(email) };
    if (again && now < sentAt(existing) + DEVELOPER_RESEND_AFTER_MS) return { email, status: "limit", limit: "wait", message: LIMIT_MESSAGES.wait(email) };
    if (existing === null && (await store.developerSends.forProject(project._id, MAX_DEVELOPER_INVITES_PER_PROJECT)).length >= MAX_DEVELOPER_INVITES_PER_PROJECT) {
      return { email, status: "limit", limit: "developers", message: LIMIT_MESSAGES.developers(email) };
    }
    // Counted now, on the UTC day and hour the email is queued, and never
    // again when it's delivered or retried, so no day queues more than its
    // cap. One queued just before midnight still counts toward that day when
    // the mail service gets it just after.
    const shared = inviteEmailLimits(inbox, now);
    const refused = await countOrRefuse<DeveloperLimit>(store, [
      [`developerEmails:${user._id}:${utcDay(now)}`, DEVELOPER_INVITES_PER_PERSON_PER_DAY, "person"],
      [...shared.inbox, "inbox"],
      [...shared.hour, "deployment"],
    ]);
    if (refused !== null) return { email, status: "limit", limit: refused, message: LIMIT_MESSAGES[refused](email) };
    // A new email names the organization when the developer joins it: the sender is its admin, whose send invites
    // anyone not already a member, or an invite already waits. Refusing throws, so the transaction keeps nothing from
    // this request, its counts included.
    if (unsafeOrganization !== null && (await namesOrganization(unsafeOrganization.id, email))) {
      fail(
        "invalid",
        inviteTo !== null
          ? "Organization names in setup emails can't contain web addresses. Rename the organization and try again."
          : "Organization names in setup emails can't contain web addresses. Ask an admin to rename it, or copy the message instead.",
      );
    }
    const next = await reserve(store, existing, { projectId: project._id, email, sentBy: user._id }, now, again);
    reserved.push(next);
    // Sending again never invites: the developer's state now, so an invite withdrawn since stays withdrawn.
    return { email, status: "sent", sendId: next.sendId, invite: again ? await inviteNow(email) : await invite(email) };
  }
}

/**
 * Records a new email for the address: its first, creating its record, or,
 * under the next key, one that replaces a failed email or, `again`, sends the
 * steps again after one went out, which counts as one of its resends.
 */
async function reserve(
  store: Store,
  existing: DeveloperSendRecord | null,
  fields: Pick<DeveloperSendRecord, "projectId" | "email" | "sentBy">,
  now: number,
  again = false,
): Promise<ReservedEmail> {
  if (existing === null) {
    const sendId = await store.developerSends.insert({ ...fields, createdAt: now, reservedAt: now, emailNumber: 0, attempts: [] });
    return { sendId, idempotencyKey: developerEmailKey(sendId, 0) };
  }
  const emailNumber = existing.emailNumber + 1;
  await store.developerSends.patch(existing._id, {
    sentBy: fields.sentBy,
    reservedAt: now,
    emailNumber,
    attempts: [],
    message: null,
    ...(again ? { resends: (existing.resends ?? 0) + 1 } : {}),
  });
  return { sendId: existing._id, idempotencyKey: developerEmailKey(existing._id, emailNumber) };
}

/**
 * Invites the developer to the organization as a member, sending no invite
 * email of its own: the setup email says they join. Nothing happens when
 * they are already in it or invited, or past the organization's invites
 * for the day; the setup email still goes out.
 */
async function inviteDeveloper(store: Store, organizationId: string, email: string, invitedBy: string, now: number): Promise<Exclude<DeveloperInvite, "none">> {
  const state = await inviteState(store, organizationId, email);
  if (state !== null) return state;
  if (!(await countWithinAll(store, [inviteLimit(organizationId, now)]))) return "limit";
  await store.invites.insert({ organizationId, email, role: "member", invitedBy, createdAt: now });
  return "created";
}

/** Whether the address is already in the organization or invited to it; null when neither. */
async function inviteState(store: Store, organizationId: string, email: string): Promise<"member" | "pending" | null> {
  if (await hasMemberAt(store, organizationId, email)) return "member";
  if ((await store.invites.findPending(organizationId, email)) !== null) return "pending";
  return null;
}

/** Whether the address has an invite to the organization waiting, so it joins when it signs in. */
async function joins(store: Store, organizationId: string | undefined, email: string): Promise<boolean> {
  return organizationId !== undefined && (await store.invites.findPending(organizationId, email)) !== null;
}

/** A prepared email and the number of the attempt it was claimed as, for recording its answer. */
export interface PreparedEmail {
  message: MailMessage;
  attempt: number;
}

/**
 * Claims an attempt at the reserved email under `idempotencyKey` at `now`,
 * returning it exactly as first prepared. Null unless the email may go to
 * the mail service (`retryable`) and no other attempt is still waiting for
 * its answer (`claimable`), or when its inbox reported
 * Critiqs's email as unwanted, which is checked again here, at delivery. An
 * opted-out email never tried certainly wasn't sent, so its claim is
 * recorded as refused, which settles it `failed`; one already tried may have
 * gone out, so it stays uncertain and isn't tried again. The same goes for
 * an email whose sender or organization was renamed to hold a web address
 * after it was queued: the first attempt reads the names again, and settles
 * it `failed` rather than sending it.
 *
 * The first attempt prepares the email from the project as it is now and
 * keeps it, so every retry sends the same request. Each attempt is recorded,
 * unanswered, before the mail service is asked.
 */
export async function prepareDeveloperEmail(
  store: Store,
  args: { sendId: string; idempotencyKey: string; setupUrl: string; reportUrl: string },
  now: number,
): Promise<PreparedEmail | null> {
  const send = await store.developerSends.get(args.sendId);
  if (send === null || developerEmailKey(send._id, send.emailNumber) !== args.idempotencyKey || !claimable(send.attempts, now)) return null;
  if (await store.emailSuppressions.has(inboxOf(send.email))) {
    if (send.attempts.length === 0) await store.developerSends.patch(send._id, { attempts: [{ at: now, answer: "refused" }] });
    return null;
  }
  const attempts = [...send.attempts, { at: now, answer: null }];
  const attempt = attempts.length - 1;
  if (send.message !== undefined) {
    await store.developerSends.patch(send._id, { attempts });
    return { message: { ...send.message, idempotencyKey: args.idempotencyKey }, attempt };
  }
  const project = await store.projects.get(send.projectId);
  const sender = await store.users.get(send.sentBy);
  if (project === null || sender === null || sender.email === null) return null;
  const organization = project.organizationId === undefined ? null : await store.organizations.get(project.organizationId);
  const joining = organization !== null && (await joins(store, organization._id, send.email)) ? organization.name : null;
  // The sender or organization renamed to hold a web address since the email was queued (project names don't change):
  // never tried, so it certainly wasn't sent, and sending again says why.
  if (hasWebAddress(sender.name) || (joining !== null && hasWebAddress(joining))) {
    await store.developerSends.patch(send._id, { attempts: [{ at: now, answer: "refused" }] });
    return null;
  }
  const { idempotencyKey, ...message } = developerSetupMessage({
    to: send.email,
    inviterName: sender.name,
    inviterEmail: sender.email,
    projectName: project.name,
    projectId: project._id,
    stack: project.onboarding?.stack ?? null,
    someoneElseChangesCode: project.onboarding?.codeAccess === "teammate" || project.onboarding?.codeAccess === "nobody",
    setupUrl: args.setupUrl,
    reportUrl: args.reportUrl,
    joining,
    idempotencyKey: args.idempotencyKey,
  });
  const stored: StoredMail = message;
  await store.developerSends.patch(send._id, { message: stored, attempts });
  return { message: { ...stored, idempotencyKey }, attempt };
}

/**
 * Records the mail service's answer to attempt number `attempt` at the email
 * under `idempotencyKey`, returning the send's status after it.
 * Only an attempt's first answer counts; null when this one changes nothing,
 * such as an answer for an email a newer one replaced.
 */
export async function recordDeveloperEmail(
  store: Store,
  args: { sendId: string; idempotencyKey: string; attempt: number; answer: "accepted" | "refused" | "unknown" },
): Promise<DeveloperSendStatus | null> {
  const send = await store.developerSends.get(args.sendId);
  if (send === null || developerEmailKey(send._id, send.emailNumber) !== args.idempotencyKey || send.attempts[args.attempt]?.answer !== null) return null;
  const attempts = send.attempts.map((each, index) => (index === args.attempt ? { ...each, answer: args.answer } : each));
  await store.developerSends.patch(send._id, { attempts });
  return sendStatus(attempts);
}

/** How one delivery ended: `skipped` when there was nothing to send under its key any more. */
export type DeveloperDelivery = "sent" | "failed" | "uncertain" | "skipped";

/**
 * Sends one reserved email, each step in its own transaction: claim an
 * attempt, send it through the mail service under the email's key, then
 * record the answer. An answer that never came (`unknown`), or a refusal
 * after an earlier attempt that may have gone out, leaves the send
 * `uncertain`, for a retry under the same key. Errors other than the mail
 * service's propagate, leaving the attempt claimed until
 * `DEVELOPER_ATTEMPT_CLAIM_MS` passes.
 */
export async function deliverDeveloperEmail(steps: {
  prepare: () => Promise<PreparedEmail | null>;
  send: (message: MailMessage) => Promise<void>;
  record: (attempt: number, answer: "accepted" | "refused" | "unknown") => Promise<DeveloperSendStatus | null>;
}): Promise<DeveloperDelivery> {
  const prepared = await steps.prepare();
  if (prepared === null) return "skipped";
  try {
    await steps.send(prepared.message);
  } catch (error) {
    if (!(error instanceof MailError)) throw error;
    // Ended without an answer: it may have gone out, and a retry under the same key may claim the email again.
    if (!error.confirmed) return (await steps.record(prepared.attempt, "unknown"), "uncertain");
    return (await steps.record(prepared.attempt, "refused")) === "failed" ? "failed" : "uncertain";
  }
  await steps.record(prepared.attempt, "accepted");
  return "sent";
}

/**
 * The setup email: from Critiqs's address, shown as "{inviter} via Critiqs",
 * with replies going to the inviter. Text the sender controls is on one line,
 * without control characters, shortened, and escaped, and never a link. The
 * prototype's address isn't in it at all: the sender typed it, and mail apps
 * turn plain-text addresses into links, so only the setup page, after sign-in,
 * shows it. A stack with no Critiqs package gets the script tag's guide in
 * place of commands.
 */
export function developerSetupMessage(parts: {
  to: string;
  inviterName: string;
  inviterEmail: string;
  projectName: string;
  projectId: string;
  stack: StackId | null;
  someoneElseChangesCode: boolean;
  setupUrl: string;
  reportUrl: string;
  /** The organization the developer joins when they sign in, or null. */
  joining: string | null;
  idempotencyKey: string;
}): MailMessage & { fromName: string; replyTo: string } {
  const inviter = shorten(parts.inviterName) || "Someone";
  const project = shorten(parts.projectName) || "the prototype";
  const stack: StackInfo | null = STACKS.find((candidate) => candidate.id === parts.stack) ?? null;
  const commands = installCommands(parts.projectId, stack?.id ?? null);
  const why = parts.someoneElseChangesCode ? "They said someone else changes its code, so they asked us to send you the setup steps." : "They asked us to send you the setup steps.";
  const intro = (who: string, email: string) => `${who} (${email}) is setting up Critiqs so your team can comment right on the prototype. ${why}`;
  const facts: [string, string][] = [
    ["Project", project],
    ["Built with", stack?.label ?? "Not confirmed"],
  ];
  const addressNote = "The setup page shows the prototype's address once you sign in.";
  const how =
    commands === null
      ? `${stack!.label} has no Critiqs package, so Critiqs goes in with a script tag on every page. This guide shows the tag; give it this project ID:`
      : stack === null
        ? `Run this in the prototype's folder. It already has the project ID, finds the framework (${listOr(PACKAGE_STACK_NAMES)}), and adds Critiqs:`
        : "Run these in the prototype's folder. They already have the project ID:";
  const joining = parts.joining === null ? null : shorten(parts.joining);
  const closing = (show: (text: string) => string) =>
    `You don't need anyone's approval.${joining === null ? "" : ` Sign in to Critiqs with ${show(parts.to)} to join ${show(joining)}.`} Reply to this email to reach ${show(inviter)}.`;
  const preheader = "How to add Critiqs to the prototype, so your team can comment on it.";
  const text = [
    intro(inviter, parts.inviterEmail),
    facts.map(([label, value]) => `${label}: ${value}`).join("\n"),
    `${how}\n\n${commands === null ? `${SCRIPT_TAG_GUIDE}\nProject ID: ${parts.projectId}` : commands.join("\n")}`,
    `Setup steps: ${parts.setupUrl}\n${addressNote}`,
    closing((plain) => plain),
    `Didn't expect this? Report it: ${parts.reportUrl}`,
  ].join("\n\n");
  const html = `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;color:#1a1a1a">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
<p>${intro(inert(inviter), inert(parts.inviterEmail))}</p>
<p>${facts.map(([label, value]) => `${escapeHtml(label)}: <strong>${inert(value)}</strong>`).join("<br>")}</p>
<p>${escapeHtml(how)}</p>
${commands === null ? `<p><a href="${escapeHtml(SCRIPT_TAG_GUIDE)}">How to add the script tag</a><br>Project ID: <code>${escapeHtml(parts.projectId)}</code></p>` : `<pre style="background:#f4f4f5;padding:12px;border-radius:6px">${commands.map(escapeHtml).join("\n")}</pre>`}
<p><a href="${escapeHtml(parts.setupUrl)}">Open the setup steps</a><br>${escapeHtml(addressNote)}</p>
<p>${closing(inert)}</p>
<p style="color:#666">Didn't expect this? <a href="${escapeHtml(parts.reportUrl)}">Report it</a>.</p>
</body></html>`;
  return {
    to: parts.to,
    subject: `${inviter} asked you to add Critiqs to ${project}`,
    text,
    html,
    fromName: `${inviter} via Critiqs`,
    replyTo: parts.inviterEmail,
    idempotencyKey: parts.idempotencyKey,
  };
}

/**
 * Text the sender controls as HTML that mail apps won't turn into a link:
 * escaped, with an empty element after each `.`, `:`, `/`, and `@`, which
 * link detection stops at and copying leaves out.
 */
function inert(text: string): string {
  return escapeHtml(text).replace(/[.:/@]/g, (char) => `${char}<span></span>`);
}

/** Who a project sent setup steps to, for the people who manage it: each address and its email's status. */
export async function listDeveloperSends(store: Store, identity: Identity | null, args: { projectId: string }): Promise<DeveloperSendSummary[]> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user?._id ?? null)) !== "manage") fail("forbidden", "Only the people who manage this project can see who it sent setup steps to.");
  const sends = await store.developerSends.forProject(project._id, MAX_DEVELOPER_INVITES_PER_PROJECT);
  return sends.map((send) => ({
    sendId: send._id,
    email: send.email,
    status: sendStatus(send.attempts),
    lastSentAt: sentAt(send),
    resendAt: resendAt(send),
  }));
}

const NO_SETUP = "This setup link doesn't exist, or it was sent to another address.";

/**
 * What a setup link shows: the project, its address, stack, install
 * commands, and who asked. Only for the developer it was sent to, signed in
 * with exactly the send's address, fixed when it was created (ignoring case
 * and surrounding spaces, but not a `+tag`: the inbox limits count by, which
 * can be shared), and the
 * people who manage the project; to anyone else a send looks the same as one
 * that doesn't exist.
 */
export async function getDeveloperSetup(store: Store, identity: Identity | null, args: { sendId: string }): Promise<DeveloperSetup> {
  const { identity: signedIn, user } = await currentReviewer(store, identity);
  const id = store.normalizeId("developerSends", args.sendId);
  const send = id === null ? null : await store.developerSends.get(id);
  const project = send === null ? null : await store.projects.get(send.projectId);
  if (send === null || project === null) fail("not-found", NO_SETUP);
  const theirs = sameAddress(signedIn.email!, send.email);
  if (!theirs && (await projectAccess(store, project, user?._id ?? null)) !== "manage") fail("not-found", NO_SETUP);
  const inviter = await store.users.get(send.sentBy);
  const manages = theirs ? (await projectAccess(store, project, user?._id ?? null)) === "manage" : true;
  return { ...setupOf(project, true, manages), inviterName: shorten(inviter?.name ?? "") || "Someone" };
}

/**
 * What a project's setup page shows, for a message someone copied, which
 * links to the project rather than a send. Any signed-in reviewer with the
 * project's ID may see it, the same rule as `getProject`, but only the
 * people who manage it see its saved stack: to anyone else it shows as
 * unknown, with the commands for an unknown stack.
 */
export async function getProjectSetup(store: Store, identity: Identity | null, args: { projectId: string }): Promise<ProjectSetup> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const manages = (await projectAccess(store, project, user?._id ?? null)) === "manage";
  return setupOf(project, manages, manages);
}

/**
 * A project's setup, with its saved stack and the origin Critiqs connected on
 * when `showStack`; otherwise as if its stack were unknown, and with when it
 * connected but not where. `manages`: the reader may clear Connected.
 */
function setupOf(project: ProjectRecord, showStack: boolean, manages: boolean): ProjectSetup {
  const stack = (showStack && STACKS.find((candidate) => candidate.id === project.onboarding?.stack)) || null;
  return {
    projectId: project._id,
    projectName: project.name,
    address: project.reviewUrl ?? null,
    stack,
    installCommands: installCommands(project._id, stack?.id ?? null),
    connected:
      project.connectedAt === undefined ? null : { at: project.connectedAt, origin: showStack ? (project.connectedOrigin ?? null) : null, ...(manages ? { clearable: true } : {}) },
  };
}

/** Whether two addresses are the same, ignoring only case and surrounding spaces. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Reporting unwanted email. The link carries a token signed with the
// deployment's link key, so only the email's own link reports it.

/** The token in a setup email's report link: the send, signed. */
export async function reportToken(secret: string, sendId: string): Promise<string> {
  return `${sendId}.${await sign(secret, sendId)}`;
}

/** The send a report link's token names, or null when it isn't one Critiqs signed. */
export async function readReportToken(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || token.length > 300) return null;
  const sendId = token.slice(0, dot);
  return sameDigest(await sign(secret, sendId), token.slice(dot + 1)) ? sendId : null;
}

/** Adds the reported send's inbox to the suppression list: no more developer or invite emails reach it. */
export async function reportUnwantedEmail(store: Store, args: { sendId: string }, now: number): Promise<void> {
  const id = store.normalizeId("developerSends", args.sendId);
  const send = id === null ? null : await store.developerSends.get(id);
  if (send !== null) await store.emailSuppressions.add(inboxOf(send.email), now);
}

/** The report page's question, before anything changes, since mail scanners open links. */
export const REPORT_QUESTION = "Stop emails from Critiqs to this address? Nobody will be able to send you setup steps or invites through Critiqs.";
export const REPORT_DONE = "Critiqs won't email this address again.";

async function sign(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(`critiqs-developer-report:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
