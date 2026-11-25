import type { ExportThread } from "./export.ts";
import { markdownLink, markdownText, unresolvedText } from "./markdown-text.ts";
import { contextLines, discussionLines, quoted, summarize, TICKET_STYLE } from "./thread-markdown.ts";

// Tickets in a team's tracker, created from a thread or linked to one. Each
// person uses their own tracker account; see docs/tickets.md.

export type TrackerId = "linear" | "github" | "jira";

/** The trackers Critiqs can create tickets in, in the order it offers them. */
export const TRACKERS: readonly { id: TrackerId; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "github", label: "GitHub Issues" },
  { id: "jira", label: "Jira" },
];

/**
 * The longest text Critiqs keeps from a tracker, checked where its answers
 * arrive (the server's tracker adapters): IDs and keys longer than these are
 * refused, names, titles, and status labels cut. The page layer shows a
 * ticket's key only up to `key` characters.
 */
export const TRACKER_LIMITS = {
  /** A tracker's ID for anything: an account, a site, a destination, a ticket, a label. */
  id: 256,
  /** A ticket's key, such as `ENG-123`, or a destination's. */
  key: 256,
  /** A person's, site's, destination's, template's, or label's name. */
  name: 200,
  /** A ticket's title. */
  title: 255,
  /** A ticket's status, such as "In Progress". */
  status: 100,
  /** An address, such as a ticket's. */
  address: 2048,
  /** Items in one list, such as destinations or labels. */
  list: 500,
} as const;

/** A tracker's state for a ticket, normalized so Critiqs can tell "done" across trackers. */
export type TicketStatusCategory = "open" | "started" | "done" | "canceled" | "unknown";

/** A ticket's status: the tracker's own name for it, such as "In Progress", and its category. */
export interface TicketStatus {
  label: string;
  category: TicketStatusCategory;
}

/** A ticket as a tracker reports it. */
export interface TicketRef {
  tracker: TrackerId;
  /** The tracker's permanent ID for the ticket, which status updates match on. */
  externalId: string;
  /** What people call it, such as `ENG-123` or `#42`. */
  key: string;
  url: string;
  title: string;
}

/** Where a new ticket goes: a Linear team, a GitHub repository, or a Jira project. */
export interface TicketDestination {
  id: string;
  name: string;
  /** A short key, such as a Linear team's or Jira project's; null where the tracker has none. */
  key: string | null;
}

/** One ticket linked to a thread, as the thread window shows it. */
export interface TicketLinkView {
  _id: string;
  threadId: string;
  tracker: TrackerId;
  /** The tracker's permanent ID for the ticket; its key can change, such as when it moves to another team. */
  externalId: string;
  key: string;
  url: string;
  title: string;
  /** The last status Critiqs knew, or null before it has read one. */
  status: TicketStatus | null;
  /** When Critiqs last read the status, or null before it has. */
  statusCheckedAt: number | null;
  /** Whether Critiqs created the ticket, rather than linking one that already existed. */
  createdFromCritiqs: boolean;
  linkedByName: string;
  linkedAt: number;
  /** Whether the person asking may unlink it: they linked it, or they own the project. */
  canUnlink: boolean;
  /** Whether the person asking created it and the tracker didn't add its link back to the thread, so they can add it. */
  canAddLinkBack: boolean;
}

/** A ticket found by searching a tracker, to link a thread to. */
export interface TicketSearchResult extends TicketRef {
  status: TicketStatus;
}

/** A new ticket's title and text, filled from the thread, for the person to edit before creating it. */
export interface TicketDraft {
  title: string;
  /** Markdown, without the line saying it came from Critiqs, which `createdFromCritiqs` adds when the ticket is created. */
  body: string;
  /** The person's default for saying the ticket came from Critiqs (Your trackers). */
  createdFromCritiqs: boolean;
  /**
   * The submission ID of a ticket the person started on this thread, with
   * this tracker account, that isn't linked yet: its answer was lost, or the
   * tracker refused their connection while Critiqs checked it. The Create
   * dialog submits under this ID, which finishes that ticket instead of
   * starting another; null when there is none.
   */
  resumeSubmissionId: string | null;
}

/** What creating a ticket from a thread sends. */
export interface NewTicket {
  threadId: string;
  /**
   * Names this submission: a UUID v4 the Create dialog makes when it opens
   * and sends with each of its tries. The new ticket takes it as its ID where
   * the tracker allows, so a retry never creates a second ticket.
   */
  submissionId: string;
  tracker: TrackerId;
  destinationId: string;
  title: string;
  body: string;
  /** Whether the ticket says it came from Critiqs, with the thread's link. */
  createdFromCritiqs: boolean;
}

/** What linking a thread to an existing ticket sends. */
export interface TicketLinkInput {
  threadId: string;
  tracker: TrackerId;
  /** The tracker's permanent ID for the ticket, from a search result. */
  externalId: string;
  /** Also add a comment with the thread's summary to the ticket. */
  comment: boolean;
}

/** A linked ticket in short, on a thread's row in the list and its pin. */
export interface TicketBadge {
  tracker: TrackerId;
  key: string;
  status: TicketStatus | null;
}

/** A person's connected tracker account, as Your trackers shows it. Never carries tokens. */
export interface TrackerAccountView {
  tracker: TrackerId;
  /** Connected through the tracker's sign-in, or with a pasted personal token. */
  method: "oauth" | "token";
  accountName: string;
  /** The workspace, organization, or Jira site the account is in, where the tracker has one. */
  site: string | null;
  connectedAt: number;
  /** Whether the person's new tickets say they came from Critiqs, by default. */
  attribution: boolean;
}

/**
 * What disconnecting a tracker did there: `ended` Critiqs's access (a
 * sign-in's tokens no longer work); `kept` a pasted token, which only the
 * person can delete in the tracker; `failed` to end a sign-in, because the
 * tracker couldn't be reached or refused, so it still works until the person
 * removes Critiqs in the tracker (Critiqs tries again for a while); `none`
 * when nothing was connected.
 */
export type TrackerDisconnected = "ended" | "kept" | "failed" | "none";

/** The trackers a backend offers, and how each one connects; from `/critiqs/config`. */
export interface TicketsConfig {
  trackers: { id: TrackerId; signIn: "oauth" | "token" }[];
  /**
   * Whether threads can create and link tickets. A backend that offers only
   * Your trackers, from before creating and linking were built, leaves it out.
   */
  threadTickets?: boolean;
}

/**
 * A tracker sign-in the signed-in person just started, for the interface that
 * started it only. Its window posts `state` and `binding` to `url`; `binding`
 * never goes in an address, so a forwarded link can't open the sign-in.
 */
export interface TrackerSignInStart {
  url: string;
  state: string;
  binding: string;
}

export interface TicketTextOptions {
  /** Who is creating the ticket, for "Created from Critiqs by …"; null when they turned attribution off. */
  attribution: { name: string } | null;
  /** The thread's link, on the project's review address when it has one. */
  link: string;
  /** `uploaded` when the tracker gets the capture as an image; `link` when it can't (GitHub), so the capture is viewed by opening the thread. */
  captureNote: "uploaded" | "link";
}

/**
 * A ticket's title and Markdown text, filled from the thread without AI:
 * the first message as the summary, the thread's context and link, the
 * whole discussion, and, unless turned off, a line saying it came from Critiqs.
 */
export function ticketText(thread: ExportThread, options: TicketTextOptions): { title: string; body: string } {
  const [first] = thread.messages;
  const capture = !thread.hasCapture
    ? "none"
    : options.captureNote === "uploaded"
      ? "attached to this ticket"
      : "saved with the thread; open its link to view it";
  const lines = [
    // Every reviewer's text renders exactly as written (TICKET_STYLE), and quoted.
    ...(first === undefined ? [] : [...quoted(TICKET_STYLE.lines(first.body.trim())), ""]),
    "## Context",
    "",
    ...contextLines(thread, TICKET_STYLE, { link: options.link, linkText: "open the thread", status: false, capture }),
    "",
    "## Discussion",
    ...discussionLines(thread, TICKET_STYLE),
  ];
  if (options.attribution !== null) lines.push("", ...attributionLines(options.attribution.name, options.link));
  return {
    // The title is the reviewer's text too, which a tracker shows as text: it mentions no one and references no issue.
    title: first === undefined ? "(no messages)" : unresolvedText(summarize(first.body)),
    body: `${lines.join("\n")}\n`,
  };
}

function attributionLines(name: string, link: string): string[] {
  return ["---", "", `Created from Critiqs by ${markdownText(name)}: ${markdownLink("open the thread", link)}`];
}

export interface TicketBodyOptions {
  /**
   * The thread's capture: the address of the copy uploaded into the ticket,
   * `missing` when the tracker takes images but this one couldn't be
   * added, or null to add nothing.
   */
  capture: { url: string } | "missing" | null;
  /** Who is creating the ticket; null when they turned attribution off. */
  attribution: { name: string } | null;
  link: string;
}

/**
 * The text a ticket is created with: the person's draft, as they edited it
 * (`ticketText` without attribution), then the capture, then, unless turned
 * off, the line saying it came from Critiqs.
 */
export function ticketBody(draft: string, options: TicketBodyOptions): string {
  const lines = [draft.trimEnd()];
  if (options.capture !== null) {
    lines.push(
      "",
      "## Capture",
      "",
      options.capture === "missing" ? `Critiqs couldn't add the capture to this ticket; ${markdownLink("open the thread", options.link)} to view it.` : `!${markdownLink("Capture", options.capture.url)}`,
    );
  }
  if (options.attribution !== null) lines.push("", ...attributionLines(options.attribution.name, options.link));
  return `${lines.join("\n")}\n`;
}

/**
 * The comment a person may add when linking a ticket to a thread: the
 * thread's first message, quoted, and its link; unless they turned it off, it
 * says it came from Critiqs.
 */
export function ticketLinkComment(summary: string, options: { link: string; attribution: { name: string } | null }): string {
  const link = markdownLink("open the thread", options.link);
  return [
    ...quoted(TICKET_STYLE.lines(summary.trim())),
    "",
    options.attribution === null ? `Thread: ${link}` : `Linked from Critiqs by ${options.attribution.name}: ${link}`,
    "",
  ].join("\n");
}
