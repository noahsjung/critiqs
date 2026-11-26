import {
  type ExportPageLoader,
  exportThread,
  loadExport,
  type NewTicket,
  type TicketDestination,
  type TicketDraft,
  type TicketLinkInput,
  type TicketLinkView,
  type TicketRef,
  type TicketSearchResult,
  ticketBody,
  ticketLinkComment,
  ticketText,
  type TrackerId,
  type WebAddress,
  webAddress,
} from "@critiqs/core";
import { fail } from "../errors.ts";
import { reviewAddressLink } from "../notify.ts";
import { MAX_THREAD_TICKET_ROWS, MAX_THREAD_TICKETS, requireThread, requireUser, ticketView } from "../operations.ts";
import { projectAccess } from "../organizations.ts";
import type { Identity, ProjectRecord, Store, ThreadRecord, TicketLinkRecord, UserRecord } from "../store.ts";
import { requireOffered, type TicketsDeployment, ticketStore, trackerAdapter, trackerLabel } from "./accounts.ts";
import { type CreatedTicket, fetchUntil, type TicketImage, type TrackerAdapter, TrackerRefusal, type TrackerToken } from "./trackers/index.ts";

// Tickets linked to threads: creating one in the person's tracker from a
// thread, linking a thread to a ticket that already exists, and unlinking.
// Each person works through their own tracker account, so a ticket is created
// as them and search shows only what they can see there. Calls to trackers
// run between store steps, each its own transaction that checks who is asking
// again; see docs/tickets.md.

export const MAX_TICKET_TITLE_LENGTH = 255;
export const MAX_TICKET_BODY_LENGTH = 50_000;
export const MAX_TICKET_SEARCH_LENGTH = 200;

type Tickets = NonNullable<Store["tickets"]>;

/**
 * A thread's link for tickets: on the project's review address, which its
 * owner sets, as emails link; null without a usable one. Never the page the
 * thread was left on: its author sends that address, so it could name any
 * site, and its query can carry a prototype's sign-in token.
 */
export function ticketThreadLink(project: ProjectRecord, thread: ThreadRecord): WebAddress | null {
  const link = reviewAddressLink(project, { threadId: thread._id, messageId: null });
  return link === null ? null : webAddress(link);
}

/** How many times a minute one person may list where tickets go or search their tracker: each calls it. */
export const TRACKER_READS_PER_MINUTE = 60;
/** How many times a minute one person may create or link a ticket, retries included. */
export const TICKET_WRITES_PER_MINUTE = 20;
/** The most threads one ticket can be linked to, so a status update for it saves within one transaction. */
export const MAX_TICKET_THREADS = 50;
/** The most links to one ticket read at once: every thread's, with room for those being added. */
export const MAX_TICKET_LINK_ROWS = 2 * MAX_TICKET_THREADS;

/** Refuses a person's next tracker call past the minute's limit for its kind. */
async function requireTrackerRoom(store: Store, kind: "read" | "write", userId: string, now: number): Promise<void> {
  const limit = kind === "read" ? TRACKER_READS_PER_MINUTE : TICKET_WRITES_PER_MINUTE;
  if (!(await store.rateLimits.hit(`tracker-${kind}:${userId}`, limit, 60_000, now))) {
    fail("limit", kind === "read" ? "Too many tracker requests. Wait a minute, then try again." : "Too many tickets created or linked. Wait a minute, then try again.");
  }
}

/** The first line of a thread's first message, to name the thread on the ticket. */
function threadTitle(body: string | undefined): string {
  const line = body?.split("\n")[0]?.trim() ?? "";
  return line === "" ? "Critiqs thread" : line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The signed-in person and their account in a tracker; refused without one. */
async function requireAccount(store: Store, identity: Identity | null, tracker: TrackerId) {
  const tickets = ticketStore(store);
  requireOffered(tracker);
  const user = await requireUser(store, identity);
  const account = await tickets.accounts.find(user._id, tracker);
  if (account === null) fail("not-found", `Connect ${trackerLabel(tracker)} in Your trackers first.`);
  return { tickets, user, account };
}

/**
 * A thread tickets can be made from or linked to, for a person who may review
 * its project; mockup threads can't yet.
 */
async function ticketThread(store: Store, user: UserRecord, threadId: string) {
  const { thread, project } = await requireThread(store, user, threadId);
  if (thread.mockup !== undefined) fail("invalid", "Tickets can't be created or linked from mockup threads yet.");
  return { thread, project };
}

/**
 * Refuses a thread's next ticket, created or linked: past the most a thread
 * links to, counting creations under way but not parked ones; or past the
 * most links it holds of any kind, parked ones included.
 */
async function requireRoom(tickets: Tickets, threadId: string, now: number): Promise<void> {
  const linked = await tickets.links.listForThread(threadId, "linked", MAX_THREAD_TICKET_ROWS);
  const pending = await tickets.links.listForThread(threadId, "pending", MAX_THREAD_TICKET_ROWS);
  const underWay = pending.filter((link) => creationState(link, now) !== "parked");
  if (linked.length + underWay.length >= MAX_THREAD_TICKETS) {
    fail("limit", `A thread can link to at most ${MAX_THREAD_TICKETS} tickets. Unlink one first.`);
  }
  if (linked.length + pending.length >= MAX_THREAD_TICKET_ROWS) {
    fail("limit", "Too many tickets on this thread didn't finish being created or linked. Whoever started one finishes it by creating or linking it here again.");
  }
}

/** The person's creation on the thread with this tracker account that isn't linked yet; at most one. */
async function unfinishedCreation(tickets: Tickets, who: { threadId: string; userId: string; tracker: TrackerId; accountId: string }): Promise<TicketLinkRecord | null> {
  const pending = await tickets.links.listForThread(who.threadId, "pending", MAX_THREAD_TICKET_ROWS);
  return pending.find((link) => link.creationId !== undefined && link.linkedBy === who.userId && link.tracker === who.tracker && link.creatorAccountId === who.accountId) ?? null;
}

// ---------------------------------------------------------------------------
// Where tickets go, and finding existing ones: the person's own account.

/**
 * A person and the tracker account (the tracker's ID for it) a request checked
 * they use. Their token is read only for that account, so a request never
 * calls the tracker as an account it didn't check, even when they reconnect
 * another one meanwhile.
 */
export interface TrackerPerson {
  userId: string;
  accountId: string;
}

/** The signed-in person who uses their tracker account, before it is called; refused without one. */
export async function requireTrackerAccount(store: Store, identity: Identity | null, args: { tracker: TrackerId }, now: number): Promise<TrackerPerson> {
  const { user, account } = await requireAccount(store, identity, args.tracker);
  await requireTrackerRoom(store, "read", user._id, now);
  return { userId: user._id, accountId: account.accountId };
}

/** The steps of calling a tracker as the person: checking they have an account there, then reading their token for it. */
export interface TrackerSteps {
  requirePerson(): Promise<TrackerPerson>;
  token(person: TrackerPerson): Promise<TrackerToken>;
}

/** Where the person can create tickets in a tracker, such as their Linear teams. */
export async function listTicketDestinations(steps: TrackerSteps, deployment: TicketsDeployment, args: { tracker: TrackerId }, fetchFn: typeof fetch = fetch): Promise<TicketDestination[]> {
  const person = await steps.requirePerson();
  return await trackerAdapter(args.tracker, deployment, fetchFn).destinations(await steps.token(person));
}

/** Tickets the person can see in their tracker, by key (such as `ENG-123`) or words. */
export async function searchTickets(steps: TrackerSteps, deployment: TicketsDeployment, args: { tracker: TrackerId; query: string }, fetchFn: typeof fetch = fetch): Promise<TicketSearchResult[]> {
  const query = args.query.trim();
  if (query === "") return [];
  if (query.length > MAX_TICKET_SEARCH_LENGTH) fail("invalid", `Search with up to ${MAX_TICKET_SEARCH_LENGTH} characters.`);
  const person = await steps.requirePerson();
  return await trackerAdapter(args.tracker, deployment, fetchFn).search(await steps.token(person), query);
}

// ---------------------------------------------------------------------------
// A new ticket's draft, filled from the thread without AI.

/** What a draft needs, after checking the person may make a ticket from the thread. */
export interface DraftContext {
  projectId: string;
  threadId: string;
  /** The thread's link; null when the project has no review address. */
  link: WebAddress | null;
  createdFromCritiqs: boolean;
  resumeSubmissionId: string | null;
}

/**
 * Checks the person may create a ticket from the thread in this tracker, for
 * its draft, with the ticket they started there and haven't finished, if any.
 */
export async function prepareTicketDraft(store: Store, identity: Identity | null, args: { threadId: string; tracker: TrackerId }): Promise<DraftContext> {
  const { tickets, user, account } = await requireAccount(store, identity, args.tracker);
  const { thread, project } = await ticketThread(store, user, args.threadId);
  const unfinished = await unfinishedCreation(tickets, { threadId: thread._id, userId: user._id, tracker: args.tracker, accountId: account.accountId });
  return {
    projectId: project._id,
    threadId: thread._id,
    link: ticketThreadLink(project, thread),
    createdFromCritiqs: account.attribution,
    resumeSubmissionId: unfinished?.creationId ?? null,
  };
}

/**
 * A new ticket's title and text from the thread's export, as the Markdown
 * export reads it, for the person to edit. The line saying it came from
 * Critiqs isn't in the text: creating the ticket adds it, as they choose.
 */
export async function ticketDraft(steps: { prepare(): Promise<DraftContext>; loadPage: ExportPageLoader }, args: { tracker: TrackerId }): Promise<TicketDraft> {
  const context = await steps.prepare();
  const data = await loadExport(steps.loadPage, context.projectId, [context.threadId], () => false);
  const [entry] = data.threads;
  if (entry === undefined) fail("unavailable", "This thread was deleted.");
  // The export's own links aren't in ticket text; only `context.link` is.
  const thread = exportThread(entry, () => context.link ?? "");
  // Linear takes the capture into the ticket; other trackers link to the thread for it.
  const { title, body } = ticketText(thread, { attribution: null, link: context.link, captureNote: args.tracker === "linear" ? "uploaded" : "link" });
  return { title, body, createdFromCritiqs: context.createdFromCritiqs, resumeSubmissionId: context.resumeSubmissionId };
}

// ---------------------------------------------------------------------------
// Creating a ticket.
//
// The Create dialog names each submission with a UUID v4 and sends it with
// each of its tries. That submission ID is the creation's ID: the new ticket
// takes it in the tracker (Linear accepts it as the issue's ID), and the link
// keeps it once linked, so no retry makes a second ticket, even after a try
// that finished but whose answer was lost. A creation belongs to its creator,
// thread, and tracker account. Only the creator's own requests work on it,
// with their own token for that account, and the link back recorded when they
// submitted it.
//
// The server decides which submission the dialog sends: a person has at most
// one unfinished creation per thread and tracker account. The draft names it
// (`resumeSubmissionId`), and the dialog submits under that ID; a new
// submission is refused while it is unfinished.
//
// A creation is a pending link, saved before the tracker is called. One
// attempt at a time works on it, under a lease; only that attempt calls the
// tracker for it, finishes it, or releases it:
//
//   (none) ──claim, with no unfinished creation of the person's──▶ attempting
//   attempting ──created, or found──▶ linked (or dropped into the thread's link to the same ticket)
//   attempting ──refused: the tracker made nothing──▶ (none)
//   attempting ──outcome unknown, or the lease ran out──▶ idle
//   attempting ──the tracker refused the creator's token while checking──▶ parked
//   attempting ──another attempt──▶ refused as still creating; the tracker isn't called
//   idle ──IDLE_CREATION_MS──▶ parked: it stops counting toward the thread's tickets
//   idle or parked ──the same submission again (a retry, or the reopened dialog)──▶
//          attempting: asks the tracker for the creation ID first, archived issues
//          included; found ▶ linked, even past the thread's most; else creates
//          under the same ID
//   any unfinished ──a new submission by its creator, same thread and account──▶ refused
//   linked ──the same submission again──▶ that link; the tracker isn't called
//
// An attempt's calls to the tracker end before its lease does, so it can
// still save what happened, and none starts after that. A linked ticket whose
// link back the tracker didn't add says so, and its creator can add it again.

/** How long an attempt holds a creation. */
export const CREATION_LEASE_MS = 60_000;
/** How long before its lease ends an attempt's calls to the tracker are cut off, to save what happened. */
export const CREATION_FINISH_MS = 10_000;
/** How long a creation sits idle before it is parked, so it stops counting toward the thread's tickets. */
export const IDLE_CREATION_MS = 10 * 60_000;

/** A Create dialog's submission ID: a UUID v4. */
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Where a pending link's creation stands: an attempt holds it; it waits for its creator; or it is set aside and no longer counts toward the thread's tickets. */
export type CreationState = "attempting" | "idle" | "parked";

/** When a pending link's last attempt ended, or, before any ended, when it was submitted. */
const idleSince = (link: TicketLinkRecord) => link.leaseUntil ?? link.linkedAt;

export function creationState(link: TicketLinkRecord, now: number): CreationState {
  if (link.claimToken !== undefined && (link.leaseUntil ?? 0) > now) return "attempting";
  return link.parked === true || idleSince(link) + IDLE_CREATION_MS <= now ? "parked" : "idle";
}

/** An attempt's hold on a pending link, a creation or a link being added: the link, the attempt's lease token, and when the lease ends. */
export interface TicketHold {
  linkId: string;
  threadId: string;
  holder: string;
  leaseUntil: number;
}

/** A creation held by this attempt, with what its creator recorded when they submitted it. */
export interface HeldCreation extends TicketHold {
  /** The ID the new ticket takes; the same across the creation's attempts. */
  creationId: string;
  /** The link back to the thread, as recorded at submission; null when the project had no review address. */
  linkBack: { url: WebAddress; title: string } | null;
}

/** The person's creation, held by this attempt and checked. */
export interface ClaimedCreation extends HeldCreation {
  /** An earlier attempt may have reached the tracker, so it is asked first. */
  resumed: boolean;
  /** For "Created from Critiqs by …". */
  name: string;
  /** The thread's capture, to put in the ticket; null without one. */
  captureFileId: string | null;
}

/** A submission claimed: held for this attempt, or linked already by an earlier try. */
export type CreationClaim = { status: "claimed"; creation: ClaimedCreation } | { status: "linked"; view: TicketLinkView };

/**
 * What an attempt learned when it gives a creation up: the tracker made
 * nothing, so it goes; it can't tell, so it waits for its creator; or the
 * tracker refused the creator's token while checking, so it is parked.
 */
export type CreationEnd = "nothing" | "unknown" | "parked";

export function parseNewTicket(input: NewTicket): NewTicket {
  const submissionId = input.submissionId.toLowerCase();
  if (!SUBMISSION_ID.test(submissionId)) fail("invalid", "Critiqs couldn't tell this ticket apart from others. Close the dialog and create the ticket again.");
  const title = input.title.replace(/\s+/g, " ").trim();
  if (title === "") fail("invalid", "Give the ticket a title.");
  if (title.length > MAX_TICKET_TITLE_LENGTH) fail("invalid", `Keep the title under ${MAX_TICKET_TITLE_LENGTH} characters.`);
  if (input.body.length > MAX_TICKET_BODY_LENGTH) fail("invalid", `Keep the text under ${MAX_TICKET_BODY_LENGTH.toLocaleString("en-US")} characters.`);
  if (input.destinationId.trim() === "") fail("invalid", "Choose where the ticket goes.");
  return { ...input, submissionId, title };
}

/**
 * Checks the person may create a ticket from the thread in this tracker:
 * signed in, the thread open to tickets, and their own account connected.
 * Runs before anything in their request calls the tracker. One transaction.
 */
export async function requireTicketCreator(store: Store, identity: Identity | null, args: { threadId: string; tracker: TrackerId }): Promise<TrackerPerson> {
  const { user, account } = await requireAccount(store, identity, args.tracker);
  await ticketThread(store, user, args.threadId);
  return { userId: user._id, accountId: account.accountId };
}

/** Refuses a creation whose creator's connected account isn't the one they started it with. */
function requireSameAccount(link: TicketLinkRecord, account: { accountId: string }, tracker: TrackerId, what: string): void {
  if (link.creatorAccountId !== account.accountId) {
    const label = trackerLabel(tracker);
    fail("invalid", `You started ${what} with another ${label} account. Connect that account in Your trackers again to finish it.`);
  }
}

/**
 * Claims a submission of the Create dialog for this attempt (`holder`), as the
 * person's `accountId` (the account their request read its token for): a new
 * creation under the submission's ID, or that submission's creation resumed.
 * A submission already linked answers with its link. Refused while another
 * attempt holds it, and when it is someone else's, another thread's, or
 * started with another account. One transaction.
 */
export async function claimTicketCreation(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; tracker: TrackerId; creationId: string; holder: string; accountId: string },
  now: number,
): Promise<CreationClaim> {
  const { tickets, user, account } = await requireAccount(store, identity, args.tracker);
  const { thread, project } = await ticketThread(store, user, args.threadId);
  if (account.accountId !== args.accountId) fail("unavailable", `Your ${trackerLabel(args.tracker)} connection changed. Try again.`);
  await requireTrackerRoom(store, "write", user._id, now);
  const leaseUntil = now + CREATION_LEASE_MS;
  const common = {
    threadId: thread._id,
    holder: args.holder,
    leaseUntil,
    creationId: args.creationId,
    name: user.name,
    captureFileId: thread.capture.status === "failed" ? null : thread.capture.fileId,
  };
  const earlier = await tickets.links.findByCreation(args.creationId);
  if (earlier !== null) {
    if (earlier.threadId !== thread._id || earlier.linkedBy !== user._id || earlier.tracker !== args.tracker) {
      fail("invalid", "This ticket was started somewhere else. Close the dialog and create the ticket again.");
    }
    if (earlier.state === "linked") return { status: "linked", view: await ticketView(store, earlier, { userId: user._id, owner: false }) };
    if (creationState(earlier, now) === "attempting" && earlier.claimToken !== args.holder) {
      fail("unavailable", `Critiqs is still creating this ticket in ${trackerLabel(args.tracker)}. Try again in a moment.`);
    }
    requireSameAccount(earlier, account, args.tracker, "this ticket");
    await tickets.links.patch(earlier._id, { claimToken: args.holder, leaseUntil });
    // Every creation records its link back when it is submitted, unless the project had no review address.
    const url = earlier.linkBack === undefined ? null : webAddress(earlier.linkBack.url);
    return { status: "claimed", creation: { ...common, linkId: earlier._id, linkBack: url === null ? null : { url, title: earlier.linkBack!.title }, resumed: true } };
  }
  if ((await unfinishedCreation(tickets, { threadId: thread._id, userId: user._id, tracker: args.tracker, accountId: account.accountId })) !== null) {
    fail("invalid", "You started a ticket on this thread that isn't finished yet. Close this dialog and choose Create ticket again to finish it.");
  }
  await requireRoom(tickets, thread._id, now);
  const url = ticketThreadLink(project, thread);
  const linkBack = url === null ? null : { url, title: threadTitle((await store.messages.first(thread._id))?.body) };
  const linkId = await tickets.links.insert({
    projectId: project._id,
    threadId: thread._id,
    tracker: args.tracker,
    externalId: "",
    key: "",
    url: "",
    title: "",
    state: "pending",
    creationId: args.creationId,
    creatorAccountId: account.accountId,
    ...(linkBack === null ? {} : { linkBack: { ...linkBack, added: false } }),
    claimToken: args.holder,
    leaseUntil,
    linkedBy: user._id,
    linkedAt: now,
    createdFromCritiqs: true,
  });
  return { status: "claimed", creation: { ...common, linkId, linkBack, resumed: false } };
}

/**
 * Saves the ticket a held creation made, which becomes linked, with whether
 * the tracker added its link back; when the thread links that ticket already,
 * the creation is dropped into that link. A parked creation is saved even
 * past the thread's most tickets: the ticket exists. Only the attempt holding
 * the creation may. One transaction.
 */
export async function finishTicketCreation(
  store: Store,
  identity: Identity | null,
  args: { linkId: string; threadId: string; holder: string; ticket: CreatedTicket; linkBackAdded: boolean },
  now: number,
): Promise<TicketLinkView> {
  const tickets = ticketStore(store);
  const user = await requireUser(store, identity);
  await requireThread(store, user, args.threadId);
  const { ticket } = args;
  const view = (link: TicketLinkRecord) => ticketView(store, link, { userId: user._id, owner: false });
  const existing = await existingLink(tickets, args.threadId, ticket.tracker, ticket.externalId);
  const creation = await tickets.links.get(args.linkId);
  if (creation === null || creation.state !== "pending" || creation.claimToken !== args.holder) {
    // Another attempt took the creation over and saved it.
    if (existing !== null) return await view(existing);
    fail("unavailable", "Another attempt is saving this ticket. It will show on the thread in a moment.");
  }
  if (existing !== null) {
    await tickets.links.delete(creation._id);
    return await view(existing);
  }
  await tickets.links.patch(creation._id, {
    externalId: ticket.externalId,
    key: ticket.key,
    url: ticket.url,
    title: ticket.title,
    site: ticket.site,
    state: "linked",
    claimToken: null,
    leaseUntil: null,
    parked: null,
    ...(creation.linkBack === undefined ? {} : { linkBack: { ...creation.linkBack, added: args.linkBackAdded } }),
    status: ticket.status,
    statusCheckedAt: now,
    linkedAt: now,
  });
  return await view((await tickets.links.get(creation._id))!);
}

/**
 * Gives a held creation or link up: removed when the tracker made nothing;
 * kept, waiting for a retry, when the outcome is unknown; kept and parked when
 * the tracker refused the creator's token while checking it. Nothing changes
 * unless this attempt holds it. One transaction.
 */
export async function releaseTicketHold(store: Store, identity: Identity | null, args: { linkId: string; holder: string; end: CreationEnd }, now: number): Promise<void> {
  const tickets = ticketStore(store);
  await requireUser(store, identity);
  const creation = await tickets.links.get(args.linkId);
  if (creation === null || creation.state !== "pending" || creation.claimToken !== args.holder) return;
  if (args.end === "nothing") await tickets.links.delete(creation._id);
  else await tickets.links.patch(creation._id, { claimToken: null, leaseUntil: now, parked: args.end === "parked" ? true : null });
}

/** The steps of creating a ticket; each store step is its own transaction. */
export interface CreateSteps {
  /** Checks the person may create a ticket from the thread, before any call to the tracker. */
  requireCreator(): Promise<TrackerPerson>;
  /** Their token, only while they are connected as the account they were checked with. */
  token(creator: TrackerPerson): Promise<TrackerToken>;
  claim(ids: { creationId: string; holder: string; accountId: string }): Promise<CreationClaim>;
  finish(hold: TicketHold, ticket: CreatedTicket, linkBackAdded: boolean): Promise<TicketLinkView>;
  release(hold: TicketHold, end: CreationEnd): Promise<void>;
  /** The thread's capture image; null when it can't be read. */
  capture(fileId: string): Promise<{ data: Blob; contentType: string } | null>;
  now(): number;
  /** A fresh random ID, for an attempt's lease. */
  newId(): string;
}

/** The tracker's adapter for a held creation or link: its requests end before the lease does. */
function heldAdapter(steps: { now(): number }, tracker: TrackerId, deployment: TicketsDeployment, fetchFn: typeof fetch, hold: TicketHold) {
  return trackerAdapter(tracker, deployment, fetchUntil(fetchFn, hold.leaseUntil - CREATION_FINISH_MS, () => steps.now()));
}

/**
 * Links the ticket a held creation made, after adding the link back to the
 * thread recorded at submission; that link is safe to repeat. A link back the
 * tracker didn't add is saved as missing, for the creator to add again; the
 * ticket is linked either way, never created again.
 */
async function linkCreated(steps: CreateSteps, adapter: TrackerAdapter, token: TrackerToken, hold: HeldCreation, ticket: CreatedTicket) {
  // Without a review address there is no link back to add.
  if (hold.linkBack === null) return await steps.finish(hold, ticket, true);
  const added = await adapter.linkBack(token, ticket, hold.linkBack).then(
    () => true,
    () => false,
  );
  return await steps.finish(hold, ticket, added);
}

/** Runs an attempt's work on a held creation; anything unexpected gives it up as `end`, since the tracker may have made the ticket. */
async function holding<T>(steps: CreateSteps, hold: TicketHold, end: Exclude<CreationEnd, "nothing">, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await steps.release(hold, end).catch(() => undefined);
    throw error;
  }
}

/** A refusal of the person's token itself, rather than of what was asked. */
const tokenRefused = (error: unknown) => error instanceof TrackerRefusal && (error.code === "invalid" || error.code === "forbidden");

/**
 * Creates a ticket from a thread in the person's tracker, as them: the text
 * they edited, the thread's capture where the tracker takes images, and,
 * when they chose it, the line saying it came from Critiqs. The thread's link
 * is added to the ticket, and the ticket shows on the thread.
 */
export async function createTicket(steps: CreateSteps, deployment: TicketsDeployment, input: NewTicket, fetchFn: typeof fetch = fetch): Promise<TicketLinkView> {
  const ticket = parseNewTicket(input);
  const label = trackerLabel(ticket.tracker);
  const creator = await steps.requireCreator();
  const token = await steps.token(creator);
  const claim = await steps.claim({ creationId: ticket.submissionId, holder: steps.newId(), accountId: creator.accountId });
  if (claim.status === "linked") return claim.view;
  const held = claim.creation;
  const adapter = heldAdapter(steps, ticket.tracker, deployment, fetchFn, held);
  const found = async () => {
    try {
      return await adapter.findCreated(token, { creationId: held.creationId, link: held.linkBack?.url ?? null });
    } catch (error) {
      if (!tokenRefused(error)) throw error;
      // Critiqs can't tell whether the ticket exists, and can't until the person connects again: set aside, so it holds no place on the thread.
      await steps.release(held, "parked");
      fail("invalid", `${label} didn't accept your connection, so Critiqs couldn't check whether it created this ticket. Connect ${label} again in Your trackers, then try again.`);
    }
  };
  return await holding(steps, held, "unknown", async () => {
    if (held.resumed) {
      const made = await found();
      if (made !== null) return await linkCreated(steps, adapter, token, held, made);
    }
    const capture = held.captureFileId === null || adapter.uploadImage === undefined ? null : await uploadCapture(steps, adapter.uploadImage, token, held.captureFileId);
    const body = ticketBody(ticket.body, { capture, attribution: ticket.createdFromCritiqs ? { name: held.name } : null, link: held.linkBack?.url ?? null });
    const outcome = await adapter.create(token, { destinationId: ticket.destinationId, title: ticket.title, body, labels: [], creationId: held.creationId });
    switch (outcome.status) {
      case "created":
        return await linkCreated(steps, adapter, token, held, outcome.ticket);
      case "refused": {
        // A tracker refuses an ID it has already: an earlier attempt's request may have landed after all.
        const made = held.resumed ? await found() : null;
        if (made !== null) return await linkCreated(steps, adapter, token, held, made);
        await steps.release(held, "nothing");
        throw outcome.error;
      }
      case "unknown":
        throw outcome.error;
    }
  });
}

/** The capture uploaded into the tracker, or `missing` when it couldn't be read or uploaded; the ticket is created either way. */
async function uploadCapture(
  steps: CreateSteps,
  upload: (token: TrackerToken, image: TicketImage) => Promise<WebAddress>,
  token: TrackerToken,
  fileId: string,
): Promise<{ url: WebAddress } | "missing"> {
  try {
    const image = await steps.capture(fileId);
    if (image === null) return "missing";
    const extension = image.contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    return { url: await upload(token, { data: image.data, contentType: image.contentType, name: `critiqs-capture.${extension}` }) };
  } catch {
    return "missing";
  }
}

// ---------------------------------------------------------------------------
// Adding a created ticket's link back again.

/** A created ticket's missing link back, checked, to add; `added` when the tracker has it already. */
export type PreparedLinkBack =
  | { status: "ready"; person: TrackerPerson; tracker: TrackerId; ticket: TicketRef; linkBack: { url: WebAddress; title: string } }
  | { status: "added"; view: TicketLinkView };

/**
 * Checks the person may add a created ticket's link back to its thread: they
 * created it, the thread is open to tickets, and they have the account they
 * created it with. One transaction.
 */
export async function prepareTicketLinkBack(store: Store, identity: Identity | null, args: { linkId: string }): Promise<PreparedLinkBack> {
  const tickets = ticketStore(store);
  const user = await requireUser(store, identity);
  const link = await tickets.links.get(args.linkId);
  if (link === null || link.state !== "linked") fail("not-found", "This ticket isn't linked to the thread any more.");
  if (link.linkedBy !== user._id || link.linkBack === undefined) fail("forbidden", "Only the person who created this ticket can add its link back to the thread.");
  const { account } = await requireAccount(store, identity, link.tracker);
  await ticketThread(store, user, link.threadId);
  if (link.linkBack.added) return { status: "added", view: await ticketView(store, link, { userId: user._id, owner: false }) };
  requireSameAccount(link, account, link.tracker, link.key);
  return {
    status: "ready",
    person: { userId: user._id, accountId: account.accountId },
    tracker: link.tracker,
    ticket: { tracker: link.tracker, externalId: link.externalId, key: link.key, url: link.url, title: link.title },
    linkBack: { url: webAddress(link.linkBack.url) ?? fail("invalid", "This ticket's link back to the thread isn't a web address."), title: link.linkBack.title },
  };
}

/** Saves that a created ticket has its link back. One transaction. */
export async function saveTicketLinkBack(store: Store, identity: Identity | null, args: { linkId: string }): Promise<TicketLinkView> {
  const tickets = ticketStore(store);
  const user = await requireUser(store, identity);
  const link = await tickets.links.get(args.linkId);
  if (link === null || link.state !== "linked") fail("not-found", "This ticket isn't linked to the thread any more.");
  await requireThread(store, user, link.threadId);
  if (link.linkBack !== undefined && !link.linkBack.added) await tickets.links.patch(link._id, { linkBack: { ...link.linkBack, added: true } });
  return await ticketView(store, (await tickets.links.get(link._id))!, { userId: user._id, owner: false });
}

/** The steps of adding a link back; each store step is its own transaction. */
export interface LinkBackSteps {
  prepare(): Promise<PreparedLinkBack>;
  /** The creator's token, only while they are connected as the account they created the ticket with. */
  token(person: TrackerPerson, tracker: TrackerId): Promise<TrackerToken>;
  save(): Promise<TicketLinkView>;
}

/**
 * Adds a created ticket's link back to its thread, which the tracker didn't
 * add when the ticket was created: the address and title recorded when it
 * was submitted, as its creator. Safe to repeat: the tracker keeps one link.
 */
export async function addTicketLinkBack(steps: LinkBackSteps, deployment: TicketsDeployment, fetchFn: typeof fetch = fetch): Promise<TicketLinkView> {
  const prepared = await steps.prepare();
  if (prepared.status === "added") return prepared.view;
  const token = await steps.token(prepared.person, prepared.tracker);
  await trackerAdapter(prepared.tracker, deployment, fetchFn).linkBack(token, prepared.ticket, prepared.linkBack);
  return await steps.save();
}

// ---------------------------------------------------------------------------
// Linking an existing ticket.
//
// Linking holds the thread's place for the ticket before anything is written
// to the tracker: a pending link to that ticket (its `externalId`, no
// creation ID), which counts toward the thread's tickets as a creation does,
// so two links can't both write to the tracker for the last place. One
// attempt at a time works on it, under the same lease as creations:
//
//   (none) ──claim, with room on the thread──▶ attempting
//   attempting ──link back added──▶ linked (or dropped into the thread's link to the
//          same ticket); then the summary comment, when asked
//   attempting ──refused, or failed before the link back was sent──▶ (none)
//   attempting ──the link back's outcome unknown, or the lease ran out──▶ idle
//   attempting ──another link of the same ticket──▶ refused as still linking; the tracker isn't called
//   idle ──IDLE_CREATION_MS──▶ parked: it stops counting toward the thread's tickets
//   idle or parked ──anyone on the thread links the same ticket──▶ replaced by their attempt

/** A link to an existing ticket, held for this attempt; `existing` when the thread links to it already. */
export type LinkClaim =
  | { status: "claimed"; hold: TicketHold; person: TrackerPerson; link: WebAddress | null; linkTitle: string; summary: string; attribution: { name: string } | null }
  | { status: "existing"; view: TicketLinkView };

/** The thread's link to this ticket, if it has one. */
async function existingLink(tickets: Tickets, threadId: string, tracker: TrackerId, externalId: string): Promise<TicketLinkRecord | null> {
  const links = await tickets.links.findByExternal(tracker, externalId, MAX_TICKET_LINK_ROWS);
  return links.find((link) => link.threadId === threadId && link.state === "linked") ?? null;
}

/**
 * Checks the person may link the thread to a ticket in their tracker, and
 * holds the thread's place for it for this attempt (`holder`), before anything
 * is written to the tracker. Refused when the thread has no room, or while
 * another attempt is linking the same ticket. One transaction.
 */
export async function claimTicketLink(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; tracker: TrackerId; externalId: string; holder: string },
  now: number,
): Promise<LinkClaim> {
  const { tickets, user, account } = await requireAccount(store, identity, args.tracker);
  const { thread, project } = await ticketThread(store, user, args.threadId);
  if (args.externalId.trim() === "") fail("invalid", "Choose a ticket to link.");
  await requireTrackerRoom(store, "write", user._id, now);
  const links = await tickets.links.findByExternal(args.tracker, args.externalId, MAX_TICKET_LINK_ROWS);
  const onThread = links.filter((link) => link.threadId === thread._id);
  const linked = onThread.find((link) => link.state === "linked");
  if (linked !== undefined) return { status: "existing", view: await ticketView(store, linked, { userId: user._id, owner: false }) };
  if (links.length - onThread.length >= MAX_TICKET_THREADS) fail("limit", `A ticket can be linked to at most ${MAX_TICKET_THREADS} threads, and this one is already.`);
  for (const pending of onThread.filter((link) => link.state === "pending")) {
    if (creationState(pending, now) === "attempting") fail("unavailable", `Critiqs is still linking this ticket in ${trackerLabel(args.tracker)}. Try again in a moment.`);
    // An earlier attempt that ended without knowing; its link back is safe to add again.
    await tickets.links.delete(pending._id);
  }
  await requireRoom(tickets, thread._id, now);
  const leaseUntil = now + CREATION_LEASE_MS;
  const linkId = await tickets.links.insert({
    projectId: project._id,
    threadId: thread._id,
    tracker: args.tracker,
    externalId: args.externalId,
    key: "",
    url: "",
    title: "",
    state: "pending",
    claimToken: args.holder,
    leaseUntil,
    linkedBy: user._id,
    linkedAt: now,
    createdFromCritiqs: false,
  });
  const first = await store.messages.first(thread._id);
  return {
    status: "claimed",
    hold: { linkId, threadId: thread._id, holder: args.holder, leaseUntil },
    person: { userId: user._id, accountId: account.accountId },
    link: ticketThreadLink(project, thread),
    linkTitle: threadTitle(first?.body),
    summary: first?.body ?? "",
    attribution: account.attribution ? { name: user.name } : null,
  };
}

/**
 * Saves the link a held link's attempt added to the ticket the tracker
 * confirmed; when the thread links that ticket already, the hold is dropped
 * into that link. `created` is true only for the call that saved the link,
 * the one call that may add the summary comment. Only the attempt holding the
 * link may. One transaction.
 */
export async function finishTicketLink(
  store: Store,
  identity: Identity | null,
  args: { linkId: string; threadId: string; holder: string; ticket: CreatedTicket },
  now: number,
): Promise<{ view: TicketLinkView; created: boolean }> {
  const tickets = ticketStore(store);
  const user = await requireUser(store, identity);
  await requireThread(store, user, args.threadId);
  const { ticket } = args;
  const view = (link: TicketLinkRecord) => ticketView(store, link, { userId: user._id, owner: false });
  const existing = await existingLink(tickets, args.threadId, ticket.tracker, ticket.externalId);
  const held = await tickets.links.get(args.linkId);
  if (held === null || held.state !== "pending" || held.claimToken !== args.holder) {
    // Another attempt took the link over and saved it.
    if (existing !== null) return { view: await view(existing), created: false };
    fail("unavailable", "Another attempt is saving this link. It will show on the thread in a moment.");
  }
  if (existing !== null) {
    await tickets.links.delete(held._id);
    return { view: await view(existing), created: false };
  }
  await tickets.links.patch(held._id, {
    externalId: ticket.externalId,
    key: ticket.key,
    url: ticket.url,
    title: ticket.title,
    site: ticket.site,
    state: "linked",
    claimToken: null,
    leaseUntil: null,
    parked: null,
    status: ticket.status,
    statusCheckedAt: now,
    linkedAt: now,
  });
  return { view: await view((await tickets.links.get(held._id))!), created: true };
}

/** The steps of linking a ticket; each store step is its own transaction. */
export interface LinkSteps {
  /** Checks the person may link the ticket and holds the thread's place for it, before any call to the tracker. */
  claim(holder: string): Promise<LinkClaim>;
  /** Their token, only while they are connected as the account they were checked with. */
  token(person: TrackerPerson): Promise<TrackerToken>;
  finish(hold: TicketHold, ticket: CreatedTicket): Promise<{ view: TicketLinkView; created: boolean }>;
  release(hold: TicketHold, end: CreationEnd): Promise<void>;
  now(): number;
  /** A fresh random ID, for an attempt's lease. */
  newId(): string;
}

/**
 * Links a thread to a ticket the person can see in their tracker: holds the
 * thread's place for it, adds the thread's link to the ticket, shows the
 * ticket on the thread, and, when asked, adds a comment with the thread's
 * summary, at most once: only the call that saved the link comments, so a
 * repeat or a retry never comments again. Linking a ticket the thread
 * already links to changes nothing.
 */
export async function linkTicket(steps: LinkSteps, deployment: TicketsDeployment, input: TicketLinkInput, fetchFn: typeof fetch = fetch): Promise<TicketLinkView> {
  const claim = await steps.claim(steps.newId());
  if (claim.status === "existing") return claim.view;
  const { hold } = claim;
  const release = (end: CreationEnd) => steps.release(hold, end).catch(() => undefined);
  const adapter = heldAdapter(steps, input.tracker, deployment, fetchFn, hold);
  let token: TrackerToken;
  let ticket: CreatedTicket;
  try {
    token = await steps.token(claim.person);
    // Read from the tracker, never taken from the request, so a link shows only what the tracker says.
    ticket = await adapter.get(token, input.externalId);
  } catch (error) {
    // Nothing was written to the tracker yet.
    await release("nothing");
    throw error;
  }
  try {
    // Safe to repeat: the tracker keeps one link to the thread. Without a review address there is none to add.
    if (claim.link !== null) await adapter.linkBack(token, ticket, { url: claim.link, title: claim.linkTitle });
  } catch (error) {
    // A refusal added nothing; otherwise the link back may be there, and the place stays held for a retry.
    await release(error instanceof TrackerRefusal ? "nothing" : "unknown");
    throw error;
  }
  const { view, created } = await steps.finish(hold, ticket);
  if (!created || !input.comment) return view;
  try {
    await adapter.comment(token, ticket, ticketLinkComment(claim.summary, { link: claim.link, attribution: claim.attribution }));
  } catch (error) {
    const label = trackerLabel(input.tracker);
    fail(
      "unavailable",
      error instanceof TrackerRefusal
        ? `Linked ${ticket.key}, but ${label} didn't add the comment. ${error.message}`
        : `Linked ${ticket.key}, but Critiqs couldn't tell whether ${label} added the comment. Check the ticket before adding it yourself.`,
    );
  }
  return view;
}

// ---------------------------------------------------------------------------
// Unlinking.

/** Removes a ticket's link from its thread, in Critiqs only: for the person who linked it or a project owner. */
export async function unlinkTicket(store: Store, identity: Identity | null, args: { linkId: string }): Promise<void> {
  const tickets = ticketStore(store);
  const user = await requireUser(store, identity);
  const link = await tickets.links.get(args.linkId);
  if (link === null || link.state !== "linked") fail("not-found", "This ticket isn't linked to the thread any more.");
  const { project } = await requireThread(store, user, link.threadId);
  if (link.linkedBy !== user._id) {
    if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", "Only the person who linked this ticket or the project's owner can unlink it.");
  }
  await tickets.links.delete(link._id);
}

/** An image's type from its first bytes: PNG, JPEG, GIF, or WebP; null for anything else. */
export function imageTypeOf(head: Uint8Array): string | null {
  const starts = (bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}
