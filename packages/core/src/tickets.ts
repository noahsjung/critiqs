import type { ExportThread } from "./export.ts";
import { markdownLink, markdownText } from "./markdown-text.ts";
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

/** The trackers a backend offers, and how each one connects; from `/critiqs/config`. */
export interface TicketsConfig {
  trackers: { id: TrackerId; signIn: "oauth" | "token" }[];
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
  if (options.attribution !== null) {
    lines.push("", "---", "", `Created from Critiqs by ${markdownText(options.attribution.name)}: ${markdownLink("open the thread", options.link)}`);
  }
  return {
    title: first === undefined ? "(no messages)" : summarize(first.body),
    body: `${lines.join("\n")}\n`,
  };
}
