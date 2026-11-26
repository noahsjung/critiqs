import { type TicketSettingsView, type TicketStatus, ticketFinished, type TrackerId } from "@critiqs/core";
import { CritiqsError, fail } from "../errors.ts";
import { currentReviewer, MAX_THREAD_TICKET_ROWS, requireProject, requireThread, requireUser } from "../operations.ts";
import { projectAccess } from "../organizations.ts";
import type { Identity, Store, TicketLinkChanges, TicketLinkRecord } from "../store.ts";
import { type TicketsDeployment, ticketStore, type TokenUse, trackerAdapter } from "./accounts.ts";
import { lastKnownStatus, linkerAccount } from "./current.ts";
import { MAX_TICKET_LINK_ROWS } from "./links.ts";
import { checkedStatus, type TicketStatusReading, type TicketStatusUpdate, TrackerRefusal, type TrackerToken, trackerId } from "./trackers/index.ts";

// Tickets' status coming back from trackers: webhooks, for every link to the
// ticket, and a check when someone opens the thread, for the checked link
// only, both saved by the same rules; and Resolve when done,
// which resolves a thread once every ticket linked to it is done. See
// docs/tickets.md, "Status from the tracker".

/**
 * How old a ticket's status may be before opening its thread checks it again,
 * and how often a check of one link may start, whether or not the last one
 * finished.
 */
export const STATUS_CHECK_MS = 5 * 60_000;

const same = (a: TicketStatus | undefined, b: TicketStatus) => a !== undefined && a.label === b.label && a.category === b.category;

/**
 * A ticket's status as Critiqs reads it: from a webhook or from a check (when
 * linking, or when a thread opens), as of the tracker's own time, and whether
 * the tracker deleted the ticket.
 */
export interface StatusReading {
  source: "webhook" | "check";
  asOf: number;
  status: TicketStatus;
  deleted: boolean;
}

/** The reading a link holds; `asOf` is missing when the tracker gave no time. */
export interface HeldReading {
  asOf: number | undefined;
  status: TicketStatus;
  deleted: boolean;
}

/**
 * What a new reading does to the one a link holds, the one rule for webhooks,
 * checks, and links being finished:
 *
 * - `replace`: it is newer; or, at the same time, it is a deletion and the
 *   held one isn't, since a deletion is the last thing that happens to a
 *   ticket; or, at the same time, a check read another status, since a check
 *   reads the ticket as it is now. Also when the link holds no reading, or
 *   none with a time.
 * - `refresh`: a check read the same reading again. Only when the status was
 *   last read changes: it was read fresh.
 * - `keep`: anything else. It is older; or an update at the time of a held
 *   deletion; or a webhook's other status at the same time (the first one
 *   saved stays); or a webhook's same reading again, a replay, which changes
 *   nothing at all.
 */
export function decideReading(held: HeldReading | null, reading: StatusReading): "replace" | "refresh" | "keep" {
  if (held === null || held.asOf === undefined || reading.asOf > held.asOf) return "replace";
  if (reading.asOf < held.asOf) return "keep";
  if (reading.deleted !== held.deleted) return reading.deleted ? "replace" : "keep";
  if (reading.source === "webhook") return "keep";
  return same(held.status, reading.status) ? "refresh" : "replace";
}

/** The reading a link holds, if any. */
export function heldReading(link: TicketLinkRecord): HeldReading | null {
  return link.status === undefined ? null : { asOf: link.statusAsOf, status: link.status, deleted: link.statusDeleted === true };
}

/**
 * How many times a minute one tracker site's webhooks (a Linear workspace's,
 * a GitHub repository's, a Jira site's) may change tickets Critiqs links.
 * Past it, the webhook route answers 429, so a tracker that retries sends it
 * again later; the check when a thread opens catches up either way.
 */
export const WEBHOOK_UPDATES_PER_MINUTE = 300;

/** What a webhook delivery did: the links it updated, the threads it resolved, and whether its site was over its minute's limit. */
export interface WebhookResult {
  updated: number;
  resolved: string[];
  limited?: true;
}

/** Takes one of the site's webhook updates for this minute; false when it has none left. */
export async function webhookRoom(store: Store, tracker: TrackerId, site: string | null, now: number): Promise<boolean> {
  return await store.rateLimits.hit(`tracker-webhook:${tracker}:${site ?? ""}`, WEBHOOK_UPDATES_PER_MINUTE, 60_000, now);
}

/**
 * Saves a ticket's status, from a webhook, on every thread that links it,
 * and on links to it still being added, which weigh it against what they
 * read when they finish (`linkedReading`). Each link takes it only as
 * `decideReading` says, so late,
 * repeated, or replayed deliveries change nothing. Then, in each open thread
 * where this update made a ticket done or canceled, Resolve when done
 * resolves the thread when it is on and every ticket the thread links is now
 * done or canceled. A ticket reopened later never reopens the thread. Each
 * delivery that reaches links takes one of its site's updates for the minute
 * (`WEBHOOK_UPDATES_PER_MINUTE`); past them, it changes nothing and says it
 * was limited. One transaction. Returns the threads it resolved.
 */
export async function applyTicketStatus(store: Store, update: TicketStatusUpdate, now: number): Promise<WebhookResult> {
  const externalId = trackerId(update.externalId);
  if (externalId === null) return { updated: 0, resolved: [] };
  // Only links in the workspace the update names: a link saves its workspace (a pending one, its linker's), and an
  // update that names none, or another, never reaches a link in one. Keys and IDs are unique only per workspace.
  const site = update.site === null ? null : trackerId(update.site);
  // A site Critiqs can't keep is still a site: never "none", which would reach links without one.
  if (update.site !== null && site === null) return { updated: 0, resolved: [] };
  const links = (await ticketStore(store).links.findByExternal(update.tracker, externalId, MAX_TICKET_LINK_ROWS)).filter((link) => (link.site ?? null) === site);
  if (links.length === 0) return { updated: 0, resolved: [] };
  if (!(await webhookRoom(store, update.tracker, site, now))) return { updated: 0, resolved: [], limited: true };
  return await saveStatus(store, links, { source: "webhook", asOf: update.asOf ?? now, status: checkedStatus(update.status), deleted: update.deleted }, now);
}

/**
 * Saves what a check read of one linked ticket's status on that link alone:
 * the check used its linker's token, which says nothing about other links to
 * the same ticket, such as one whose linker can't check it any more. Saved
 * and resolved as `applyTicketStatus` does. One transaction.
 */
export async function applyCheckedStatus(store: Store, args: { linkId: string; reading: TicketStatusReading }, now: number): Promise<{ updated: number; resolved: string[] }> {
  const link = await ticketStore(store).links.get(args.linkId);
  const reading: StatusReading = { source: "check", asOf: args.reading.asOf ?? now, status: args.reading.status, deleted: false };
  const linked = link === null || link.state !== "linked" ? null : link;
  // The ticket moved, or was renamed, at the tracker: the same ticket by its permanent ID, so the link follows it.
  const place = args.reading.place;
  if (linked !== null && place !== undefined && (place.key !== linked.key || place.url !== linked.url || place.title !== linked.title || (place.site !== undefined && place.site !== (linked.site ?? null)))) {
    await ticketStore(store).links.patch(linked._id, { key: place.key, url: place.url, title: place.title, ...(place.site === undefined ? {} : { site: place.site }) });
  }
  return await saveStatus(store, linked === null ? [] : [linked], reading, now);
}

async function saveStatus(store: Store, links: TicketLinkRecord[], reading: StatusReading, now: number): Promise<{ updated: number; resolved: string[] }> {
  const tickets = ticketStore(store);
  let updated = 0;
  const finishedIn = new Set<string>();
  for (const link of links) {
    const decision = decideReading(heldReading(link), reading);
    if (decision === "keep") continue;
    updated++;
    if (decision === "refresh") {
      await tickets.links.patch(link._id, { statusCheckedAt: now, statusStale: null });
      continue;
    }
    const changed = !same(link.status, reading.status);
    await tickets.links.patch(link._id, {
      status: reading.status,
      statusAsOf: reading.asOf,
      statusDeleted: reading.deleted ? true : null,
      statusCheckedAt: now,
      statusStale: null,
      ...(changed ? { statusChangedAt: reading.asOf } : {}),
    });
    if (link.state === "linked" && changed && !ticketFinished(link.status) && ticketFinished(reading.status)) finishedIn.add(link.threadId);
  }
  const resolved: string[] = [];
  for (const threadId of finishedIn) {
    if (await resolveWhenDone(store, threadId, now)) resolved.push(threadId);
  }
  return { updated, resolved };
}

/**
 * The status a link saves when its linking or creation finishes: what the
 * tracker said when the attempt read the ticket, unless a webhook delivered
 * while the link was pending holds a reading that wins over it by
 * `decideReading`, such as the ticket's deletion. `finished` is true when
 * that webhook's reading made the ticket done or canceled, so Resolve when
 * done looks at the thread once the link is saved.
 */
export function linkedReading(pending: TicketLinkRecord, read: TicketStatusReading, now: number): { changes: TicketLinkChanges; finished: boolean } {
  const delivered = heldReading(pending);
  // A read without the tracker's time loses to a webhook with one, as a saved status without a time does.
  const deliveredWins = delivered !== null && (read.asOf === null || decideReading(delivered, { source: "check", asOf: read.asOf, status: read.status, deleted: false }) === "keep");
  if (!deliveredWins) {
    return { changes: { status: read.status, statusAsOf: read.asOf, statusDeleted: null, statusChangedAt: null, statusCheckedAt: now }, finished: false };
  }
  const changed = !same(read.status, delivered.status);
  return {
    changes: {
      status: delivered.status,
      statusAsOf: delivered.asOf ?? null,
      statusDeleted: delivered.deleted ? true : null,
      statusChangedAt: changed ? (delivered.asOf ?? null) : null,
      statusCheckedAt: now,
    },
    finished: changed && !ticketFinished(read.status) && ticketFinished(delivered.status),
  };
}

/**
 * Resolves an open thread whose project has Resolve when done on, when every
 * ticket it links is done or canceled; recorded as resolved by its tickets.
 * With `current`, only on statuses Critiqs can still check (`lastKnownStatus`),
 * for a catch-up, which acts on statuses read who knows when.
 */
export async function resolveWhenDone(store: Store, threadId: string, now: number, current = false): Promise<boolean> {
  const tickets = ticketStore(store);
  const thread = await store.threads.get(threadId);
  if (thread === null || thread.status !== "open") return false;
  if ((await tickets.settings.find(thread.projectId))?.resolveWhenDone !== true) return false;
  const linked = await tickets.links.listForThread(threadId, "linked", MAX_THREAD_TICKET_ROWS);
  if (linked.length === 0 || !linked.every((link) => ticketFinished(link.status))) return false;
  if (current) {
    const lastKnown = lastKnownStatus(store);
    for (const link of linked) if (await lastKnown(link)) return false;
  }
  await store.threads.patch(threadId, { status: "resolved", statusChangedAt: now, statusChangedByTickets: true });
  return true;
}

/**
 * When someone opens a thread: claims a check of each linked ticket whose
 * status is older than `STATUS_CHECK_MS`, unless one started within that
 * time, so each link is checked at most once every few minutes however many
 * people open it. Anyone who can read the thread may ask. Returns the links
 * to check. One transaction.
 */
export async function claimStatusChecks(store: Store, identity: Identity | null, args: { threadId: string }, now: number): Promise<string[]> {
  const { user } = await currentReviewer(store, identity);
  const { thread } = await requireThread(store, user, args.threadId);
  if (store.tickets === undefined) return [];
  const due = (await store.tickets.links.listForThread(thread._id, "linked", MAX_THREAD_TICKET_ROWS)).filter(
    (link) => now - (link.statusCheckedAt ?? 0) >= STATUS_CHECK_MS && now - (link.statusCheckStartedAt ?? 0) >= STATUS_CHECK_MS,
  );
  for (const link of due) await store.tickets.links.patch(link._id, { statusCheckStartedAt: now });
  return due.map((link) => link._id);
}

/** A check of one link's status, as the person who linked it. */
export type StatusCheck =
  | {
      status: "check";
      person: { userId: string; accountId: string };
      /** The project the link is in: the linker's token is read only while they may review it. */
      projectId: string;
      tracker: TrackerId;
      ticket: { tracker: TrackerId; externalId: string; key: string; url: string; title: string; site: string | null };
      /** When the check began: a refusal marks the status stale only if nothing was saved since. */
      startedAt: number;
    }
  /** Nothing to check: the link is gone. */
  | { status: "skip" }
  /** The linker can't check it, so its status was marked stale. */
  | { status: "stale" };

/**
 * Reads what a status check needs: the person who linked the ticket and the
 * tracker account they linked it with. Only that account's token is ever
 * used, never anyone else's. When they have disconnected, are connected as
 * another account, or may no longer review the project, the link's status is
 * marked stale instead. One transaction.
 */
export async function prepareStatusCheck(store: Store, args: { linkId: string }, now: number): Promise<StatusCheck> {
  const tickets = ticketStore(store);
  const link = await tickets.links.get(args.linkId);
  if (link === null || link.state !== "linked") return { status: "skip" };
  const person = await linkerAccount(store, link);
  if (person === null) {
    await tickets.links.patch(link._id, { statusStale: true });
    return { status: "stale" };
  }
  const { tracker, externalId, key, url, title } = link;
  return { status: "check", person, projectId: link.projectId, tracker, ticket: { tracker, externalId, key, url, title, site: link.site ?? null }, startedAt: now };
}

/**
 * Marks a link's status stale: Critiqs can't check it as the person who
 * linked it. Not when a reading was saved after the check began
 * (`startedAt`), such as a webhook's while the check waited on the tracker:
 * that status is current, not last known. One transaction.
 */
export async function markStatusStale(store: Store, args: { linkId: string; startedAt: number }): Promise<void> {
  const tickets = ticketStore(store);
  const link: TicketLinkRecord | null = await tickets.links.get(args.linkId);
  if (link === null || link.state !== "linked" || (link.statusCheckedAt ?? 0) > args.startedAt) return;
  await tickets.links.patch(link._id, { statusStale: true });
}

/** The steps of checking a link's status; each store step is its own transaction. */
export interface StatusCheckSteps {
  prepare(): Promise<StatusCheck>;
  /** The linker's token, only while they are connected as the account they linked the ticket with, and may review `use`'s project. */
  token(person: { userId: string; accountId: string }, tracker: TrackerId, use: TokenUse): Promise<TrackerToken>;
  /** Saves the status read on the checked link only. */
  save(reading: TicketStatusReading): Promise<unknown>;
  /** Marks the status stale, unless a reading was saved after `startedAt`. */
  stale(startedAt: number): Promise<void>;
}

/** Whether a failure means the linker can't check the ticket any more, rather than a passing problem such as Linear being unreachable. */
const linkerCannot = (error: unknown) =>
  (error instanceof TrackerRefusal && (error.code === "invalid" || error.code === "forbidden")) ||
  (error instanceof CritiqsError && !(error instanceof TrackerRefusal) && (error.code === "not-found" || error.code === "invalid" || error.code === "forbidden"));

/**
 * Checks one linked ticket's status in its tracker with the token of the
 * person who linked it, and saves it on that link only, as a webhook's would
 * be. When their connection no longer works for it (disconnected, another
 * account, signed out, or the ticket hidden from them), the last status
 * stays, marked stale, unless a newer one was saved while the check ran. A passing failure changes nothing; the next opening
 * checks again. Returns what happened.
 */
export async function checkTicketStatus(steps: StatusCheckSteps, deployment: TicketsDeployment, fetchFn: typeof fetch = fetch): Promise<"updated" | "stale" | "skipped" | "failed"> {
  const check = await steps.prepare();
  if (check.status !== "check") return check.status === "stale" ? "stale" : "skipped";
  try {
    // Checked again where the token is read: the linker may still review the project.
    const token = await steps.token(check.person, check.tracker, { by: "job", projects: [check.projectId] });
    await steps.save(await trackerAdapter(check.tracker, deployment, fetchFn).status(token, check.ticket));
    return "updated";
  } catch (error) {
    if (!linkerCannot(error)) return "failed";
    await steps.stale(check.startedAt);
    return "stale";
  }
}

/** A project's ticket settings, for its owners. */
export async function ticketSettings(store: Store, identity: Identity | null, args: { projectId: string }): Promise<TicketSettingsView> {
  const tickets = ticketStore(store);
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user?._id ?? null)) !== "manage") fail("forbidden", "Only the person who set up this project can change its ticket settings.");
  return { resolveWhenDone: (await tickets.settings.find(project._id))?.resolveWhenDone ?? false };
}

/** Turns Resolve when done on or off for a project; only its owners may. Turning it on resolves nothing at once: threads resolve on their tickets' next status update. */
export async function setResolveWhenDone(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; on: boolean },
  now: number,
  /** Called when this turned the setting on, to catch up the project's threads (`catchUpResolveWhenDone`), in the same transaction. */
  turnedOn: (projectId: string) => Promise<void> = async () => undefined,
): Promise<TicketSettingsView> {
  const tickets = ticketStore(store);
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", "Only the person who set up this project can change its ticket settings.");
  const settings = await tickets.settings.find(project._id);
  if (settings === null) {
    await tickets.settings.insert({ projectId: project._id, templates: [], resolveWhenDone: args.on, defaults: [], updatedBy: user._id, updatedAt: now });
  } else if (settings.resolveWhenDone !== args.on) {
    await tickets.settings.patch(settings._id, { resolveWhenDone: args.on, updatedBy: user._id, updatedAt: now });
  }
  if (args.on && settings?.resolveWhenDone !== true) await turnedOn(project._id);
  return { resolveWhenDone: args.on };
}

/** How many of a project's threads one step of the catch-up looks at. */
export const RESOLVE_CATCH_UP_PAGE = 50;

/**
 * After Resolve when done was turned on at `since`: resolves the open threads
 * in a page of the project's threads whose every linked ticket is already
 * done or canceled, with a status Critiqs can still check, as a ticket
 * finishing would have (`resolveWhenDone`), so
 * turning it on catches up. A thread whose status someone changed since is
 * left as they set it, and nothing happens once the setting is off again.
 * Returns the threads it resolved and the next page's cursor, null after the
 * last. One transaction.
 */
export async function catchUpResolveWhenDone(store: Store, args: { projectId: string; since: number; cursor: string | null }, now: number): Promise<{ resolved: string[]; cursor: string | null }> {
  const page = await store.threads.listVisible(args.projectId, { numItems: RESOLVE_CATCH_UP_PAGE, cursor: args.cursor });
  const resolved: string[] = [];
  for (const thread of page.page) {
    if (thread.status !== "open" || (thread.statusChangedAt ?? 0) >= args.since) continue;
    // A ticket marked Done whose status is only last known may have been reopened since: it doesn't resolve the thread.
    if (await resolveWhenDone(store, thread._id, now, true)) resolved.push(thread._id);
  }
  return { resolved, cursor: page.isDone ? null : page.continueCursor };
}
