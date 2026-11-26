import type { ExportThread } from "./export.ts";
import { markdownBlocks } from "./markdown-blocks.ts";
import { markdownLink, markdownText, unresolvedText } from "./markdown-text.ts";
import { contextLines, discussionLines, quoted, summarize, TICKET_STYLE } from "./thread-markdown.ts";
import type { WebAddress } from "./web-address.ts";

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
  /** A ticket template's text, as long as a ticket's. */
  templateText: 50_000,
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
  /**
   * Whether `status` is only the last one Critiqs knew: the person who linked
   * the ticket disconnected their tracker or connected another account, or
   * can no longer see the ticket, so Critiqs can't check it. Webhooks still
   * update it. Absent from backends before ticket status updates.
   */
  statusStale?: boolean;
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
  /**
   * Where the project's owners send its new tickets in this tracker by
   * default (`TicketDefaultDestination`), as a destination ID; null when they
   * chose none. The Create dialog starts there unless the person chose another
   * destination for this project before. Absent on backends from before it.
   */
  projectDestinationId?: string | null;
}

/** Where a project's new tickets go in one tracker by default, which its owners choose. */
export interface TicketDefaultDestination {
  tracker: TrackerId;
  destinationId: string;
  /** The destination's name when it was chosen, for the owners' settings. */
  name: string;
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
  /**
   * The tracker template the ticket was drafted from, one the project offers
   * for the destination; the tracker applies its other defaults, such as
   * labels, with the person's title and text taking precedence. Absent or
   * null for Critiqs's standard format.
   */
  templateId?: string | null;
  /** Labels to add, by the tracker's IDs, such as those suggested from the thread's tags. */
  labelIds?: string[];
  /** Values for the fields the destination requires (`TicketDraftOptions.fields`), by field ID. */
  fields?: Record<string, TicketFieldValue>;
}

/**
 * A field a destination requires that the Create dialog asks for, such as a
 * Jira issue type's required custom field: a line or paragraph of text, a
 * number, a date (`YYYY-MM-DD`), or one or more of its options.
 */
export interface TicketField {
  id: string;
  name: string;
  kind: "text" | "paragraph" | "number" | "date" | "choice" | "choices";
  /** The values a choice field allows; empty for the others. */
  options: { id: string; name: string }[];
}

/** A required field's value: text (numbers and dates as written), or option IDs for a `choices` field. */
export type TicketFieldValue = string | string[];

/** A tracker template the Create dialog offers, such as a Linear team's issue template. */
export interface TicketTemplate {
  id: string;
  name: string;
}

/** A label in the tracker, such as a Linear team's. */
export interface TicketLabel {
  id: string;
  name: string;
}

/**
 * What the Create dialog offers for one destination: the templates the
 * project turned on there (none while templates are off), and the
 * destination's labels whose names match the thread's tags.
 */
export interface TicketDraftOptions {
  templates: TicketTemplate[];
  labels: TicketLabel[];
  /** The fields the destination requires that Critiqs asks for; absent where the tracker has none. */
  fields?: TicketField[];
  /** Required fields Critiqs can't fill, such as a person picker, by name: the destination can't take a ticket from Critiqs. */
  unsupportedFields?: string[];
}

/** What a draft is filled into: Critiqs's standard format, or a template the project offers for the destination. */
export interface TicketDraftFormat {
  destinationId: string;
  /** Null for Critiqs's standard format. */
  templateId: string | null;
}

/** What asking Critiqs AI to draft a ticket sends. */
export interface AiTicketDraftInput extends TicketDraftFormat {
  threadId: string;
  tracker: TrackerId;
  /** One of the models the person's connection offers (`AiChoiceView`); without it, its default. */
  model?: string;
}

/**
 * A ticket's title and text drafted by Critiqs AI, or, when it couldn't
 * draft (AI off, out of credits, the provider failed), filled from the
 * thread without AI, with `notice` saying why. Creating a ticket never
 * depends on AI.
 */
export interface AiTicketDraft {
  title: string;
  body: string;
  drafted: "ai" | "plain";
  /** Why Critiqs AI didn't draft it; null when it did. */
  notice: string | null;
  /** `setup-ai` when the person must set up Your AI first. */
  noticeCode?: "setup-ai";
}

/** One tracker template a project offers in the Create dialog. */
export interface TicketTemplateChoice {
  tracker: TrackerId;
  destinationId: string;
  templateId: string;
  /** The template's name when it was chosen; the dialog shows its current name from the tracker. */
  name: string;
  /**
   * The template's text, for a template the project's owners pasted into
   * Critiqs because the tracker keeps none of its own (Jira); absent for
   * templates read from the tracker.
   */
  body?: string;
}

/**
 * A project's ticket templates, for its owners. Off until turned on; while
 * off, tickets use Critiqs's standard format and no template is offered.
 */
export interface TicketTemplateSettings {
  on: boolean;
  templates: TicketTemplateChoice[];
}

/** A destination's templates in the tracker, for an owner choosing which to offer. */
export interface TrackerTemplateGroup {
  /** Where the templates apply: one destination, or `EVERY_DESTINATION` for templates that belong to none (a Linear workspace's). */
  destination: TicketDestination;
  templates: TicketTemplate[];
  /**
   * Where the templates come from when not the destination itself: a GitHub
   * organization's `.github` repository, whose templates a repository without
   * its own uses. Absent for the destination's own.
   */
  from?: string;
}

/**
 * The destination ID of templates that apply wherever the tracker's tickets go,
 * such as a Linear workspace's templates, which belong to no team. A project
 * that offers one offers it in every destination of that tracker.
 */
export const EVERY_DESTINATION = "*";

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
  /**
   * Whether `status` is only the last one Critiqs knew (as
   * `TicketLinkView.statusStale`). Absent from backends before it, and never
   * sent to the page layer, whose pins take only the fields above.
   */
  lastKnown?: boolean;
}

/**
 * A ticket linked to a thread, as handoffs carry it (exports, notification
 * emails, coding agents' tools): its tracker, key, title, status, and
 * address in the tracker. Only tickets that finished linking.
 */
export interface ThreadTicket extends TicketBadge {
  title: string;
  url: string;
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
 * removes Critiqs in the tracker (Critiqs tries again for a while); `shared`
 * when the sign-in's access at the tracker is shared with another Critiqs
 * account connected to the same tracker account (GitHub's grant is per GitHub
 * account), so it stays until that one disconnects too; `none` when nothing
 * was connected.
 */
export type TrackerDisconnected = "ended" | "kept" | "failed" | "shared" | "none";

/** The trackers a backend offers, and how each one connects; from `/critiqs/config`. */
export interface TicketsConfig {
  /**
   * Each tracker offered, how it connects, and, for GitHub with sign-in, where
   * an organization installs the deployment's GitHub App to reach its repositories.
   */
  trackers: { id: TrackerId; signIn: "oauth" | "token"; installUrl?: string }[];
  /**
   * Whether threads can create and link tickets. A backend that offers only
   * Your trackers, from before creating and linking were built, leaves it out.
   */
  threadTickets?: boolean;
  /**
   * Whether the Create dialog can draft with Critiqs AI and from the
   * tracker's templates, suggest labels from tags, and owners can turn
   * templates on. Absent on backends from before these.
   */
  drafting?: boolean;
  /**
   * Whether tickets' status comes back to Critiqs: opening a thread checks
   * its tickets (`ticketStatus:checkStatus`), and projects have **Resolve when
   * done**. Older backends leave it out.
   */
  ticketStatus?: boolean;
  /**
   * Whether a project's owners can choose where its new tickets go by
   * default in each tracker (`tickets:setDefaultDestination`), which the
   * Create dialog starts with. Older backends leave it out.
   */
  defaultDestinations?: boolean;
}

/** Whether a ticket's status counts as finished for **Resolve when done**: done, or canceled, since the work is closed either way. */
export function ticketFinished(status: TicketStatus | null | undefined): boolean {
  return status?.category === "done" || status?.category === "canceled";
}

/** A project's ticket settings, as its owners see them. */
export interface TicketSettingsView {
  /** Resolve a thread when every ticket linked to it is done or canceled. Off by default. */
  resolveWhenDone: boolean;
  /** Where new tickets go by default, per tracker; at most one per tracker. Absent on backends from before it. */
  defaults?: TicketDefaultDestination[];
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
  /** The thread's link: its website page, else on the project's review address; null with neither, and the ticket doesn't link to the thread. */
  link: WebAddress | null;
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
  const capture = captureText(thread, options.captureNote);
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

/** A tracker template's text, as a draft is filled from it. */
export interface TicketTemplateText {
  name: string;
  /** Markdown, with headings marking its sections. */
  body: string;
}

/** The line its first top-level heading ends on, the template's first section starting after it; -1 without one. */
function firstHeadingEnd(text: string): number {
  return markdownBlocks(text).headings[0]?.end ?? -1;
}

/**
 * A ticket's title and text filled into a tracker template without AI: the
 * thread's summary (its first message, quoted) and context, with its link,
 * go at the start of the template's first section, under its first heading
 * (or before the template's text when it has no heading), and every section
 * keeps its own text for the person to fill. The title is the thread's
 * summary, as in the standard format.
 */
export function templateTicketText(thread: ExportThread, template: TicketTemplateText, options: Omit<TicketTextOptions, "attribution">): { title: string; body: string } {
  const [first] = thread.messages;
  const filled = [
    ...(first === undefined ? [] : [...quoted(TICKET_STYLE.lines(first.body.trim())), ""]),
    ...contextLines(thread, TICKET_STYLE, { link: options.link, linkText: "open the thread", status: false, capture: captureText(thread, options.captureNote) }),
  ];
  const text = template.body.replace(/\r\n?/g, "\n").trimEnd();
  const lines = text.trim() === "" ? [] : text.split("\n");
  const heading = firstHeadingEnd(text);
  let body: string[];
  if (lines.length === 0) body = filled;
  else if (heading === -1) body = [...filled, "", ...lines];
  else {
    const rest = lines.slice(heading + 1);
    const start = rest.findIndex((line) => line.trim() !== "");
    body = [...lines.slice(0, heading + 1), "", ...filled, ...(start === -1 ? [] : ["", ...rest.slice(start)])];
  }
  return { title: first === undefined ? "(no messages)" : unresolvedText(summarize(first.body)), body: `${body.join("\n")}\n` };
}

// ---------------------------------------------------------------------------
// Drafts by Critiqs AI. The model writes plain text, never Markdown; Critiqs
// writes the Markdown: the headings, from the template or its standard
// format, and the model's text with every character that could form Markdown
// escaped, so nothing it writes renders as a link, image, HTML, code, heading,
// or any other structure. Then the thread's one real link.

/** A section of a drafted ticket. */
export interface TicketSection {
  /** What the model calls it: the heading's text, as the template writes it. */
  name: string;
  /** The heading line Critiqs writes, such as `## Expected`. */
  heading: string;
  /**
   * Choices the template offers under the heading, as a task list and
   * nothing else (a GitHub issue form's checkboxes or dropdown): the person
   * ticks them, so the model never writes there, and a draft keeps them.
   */
  choices?: PlainText[];
}

/** The sections a draft by Critiqs AI fills, in order. */
export interface TicketOutline {
  sections: TicketSection[];
  /** A template's sections stay when the model leaves them empty; the standard format's don't. */
  keepEmpty: boolean;
}

/** Critiqs's standard format's sections, for a draft without a template, or with one that has no headings. */
export const STANDARD_OUTLINE: TicketOutline = {
  sections: ["Summary", "Steps to reproduce", "Expected", "Actual", "Context"].map((name) => ({ name, heading: `## ${name}` })),
  keepEmpty: false,
};

/**
 * The sections a draft fills: the template's top-level headings, in its
 * order, each written as an ATX heading of its level; or Critiqs's standard
 * format's, when there is no template or it has no headings.
 */
export function ticketOutline(template: string | null): TicketOutline {
  const headings = template === null ? [] : markdownBlocks(template).headings;
  const lines = template === null ? [] : template.split(/\r\n|\r|\n/);
  const sections = headings.flatMap(({ level, text, end }, index) => {
    const name = text.replace(/\s+/g, " ").trim();
    if (name === "") return [];
    // The heading is the tracker's text, so it renders as written, as everything Critiqs AI writes does.
    const section: TicketSection = { name, heading: `${"#".repeat(level)} ${markdownText(name)}` };
    const choices = taskList(lines.slice(end + 1, headings[index + 1]?.start ?? lines.length));
    return [choices === null ? section : { ...section, choices }];
  });
  return sections.length === 0 ? STANDARD_OUTLINE : { sections, keepEmpty: true };
}

/** A section's lines when they are an unticked task list and nothing else: each item's text, as plain text; null otherwise. */
function taskList(lines: string[]): PlainText[] | null {
  const filled = lines.filter((line) => line.trim() !== "");
  const items = filled.map((line) => /^ {0,3}[-*+] \[ \] (.*)$/.exec(line)?.[1]).map((item) => (item === undefined ? null : plainText(item)));
  return items.length > 0 && items.every((item) => item !== null) ? (items as PlainText[]) : null;
}

/** The sections the model may write: all but those that offer choices for the person to tick. */
export function fillableSections(outline: TicketOutline): TicketSection[] {
  return outline.sections.filter((section) => section.choices === undefined);
}

declare const plain: unique symbol;
/** Text on one line, as written by the model, never read as Markdown: made only by `plainText`. */
export type PlainText = string & { readonly [plain]: true };

/** Text as plain text: every run of whitespace, line breaks included, one space. Null when nothing is left. */
export function plainText(value: string): PlainText | null {
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : (text as PlainText);
}

/** A section's text by the model: paragraphs, then a list, each piece plain text. */
export interface DraftedSection {
  section: TicketSection;
  paragraphs: PlainText[];
  items: PlainText[];
  /** Whether the list is numbered, as steps are. */
  numbered: boolean;
}

/** A section as the model answers it, before Critiqs checks it. */
export interface SectionAnswer {
  heading: string;
  text: string;
  items: string[];
  numbered: boolean;
}

/** Text's paragraphs, split at blank lines, each as plain text. */
const paragraphsOf = (text: string) => text.split(/(?:\r\n|\r|\n)\s*(?:\r\n|\r|\n)/).flatMap((paragraph) => plainText(paragraph) ?? []);

/**
 * The outline's sections, each with what the model wrote for it: an answer
 * is matched to a section by the section's exact name, the first section of
 * that name still unfilled, or the last of that name when all are filled,
 * whose text it adds to. An answer naming no section is dropped.
 */
export function draftedSections(outline: TicketOutline, answers: SectionAnswer[]): DraftedSection[] {
  const drafted = outline.sections.map((section) => ({ section, paragraphs: [] as PlainText[], items: [] as PlainText[], numbered: false, filled: false }));
  for (const answer of answers) {
    // Choices are the person's to tick: the model never writes there.
    const named = drafted.filter((entry) => entry.section.choices === undefined && entry.section.name === answer.heading.replace(/\s+/g, " ").trim());
    const entry = named.find((each) => !each.filled) ?? named.at(-1);
    if (entry === undefined) continue;
    const items = answer.items.flatMap((item) => plainText(item) ?? []);
    if (!entry.filled) entry.numbered = answer.numbered;
    entry.filled = true;
    entry.paragraphs.push(...paragraphsOf(answer.text));
    entry.items.push(...items);
  }
  return drafted.map(({ filled: _, ...entry }) => entry);
}

/** Plain text as Markdown that renders it exactly, as one line of a paragraph or list item (`markdownText`). */
const escaped = (text: PlainText) => markdownText(text);

/** The drafted sections as Markdown: each heading, then its paragraphs and list, escaped; a section left empty keeps its heading only when the outline says so. */
export function draftedMarkdown(sections: DraftedSection[], outline: Pick<TicketOutline, "keepEmpty">): string {
  const blocks: string[] = [];
  for (const { section, paragraphs, items, numbered } of sections) {
    if (section.choices !== undefined) {
      blocks.push(section.heading, section.choices.map((choice) => `- [ ] ${escaped(choice)}`).join("\n"));
      continue;
    }
    if (paragraphs.length === 0 && items.length === 0 && !outline.keepEmpty) continue;
    blocks.push(section.heading, ...paragraphs.map(escaped));
    if (items.length > 0) blocks.push(items.map((item, index) => `${numbered ? `${index + 1}.` : "-"} ${escaped(item)}`).join("\n"));
  }
  return blocks.join("\n\n");
}

/** A draft by Critiqs AI as the person edits it: its sections' Markdown, then the thread's link. */
export function aiTicketText(sections: DraftedSection[], outline: Pick<TicketOutline, "keepEmpty">, link: WebAddress | null): string {
  const markdown = draftedMarkdown(sections, outline);
  if (link === null) return markdown === "" ? "" : `${markdown}\n`;
  return `${markdown === "" ? "" : `${markdown}\n\n`}Thread: ${markdownLink("open the thread", link)}\n`;
}

function captureText(thread: ExportThread, note: TicketTextOptions["captureNote"]): string {
  if (!thread.hasCapture) return "none";
  return note === "uploaded" ? "attached to this ticket" : "saved with the thread; open its link to view it";
}

function attributionLines(name: string, link: WebAddress | null): string[] {
  return ["---", "", `Created from Critiqs by ${markdownText(name)}${link === null ? "." : `: ${markdownLink("open the thread", link)}`}`];
}

declare const ticketMarkdown: unique symbol;
/**
 * Ticket text as Critiqs sends it to a tracker: made only by `ticketBody`,
 * `ticketLinkComment`, and `ticketCaptureMissing`, so everything in it that others wrote renders as
 * written and nothing Critiqs adds is swallowed. Trackers' adapters take only
 * this, never a plain string.
 */
export type TicketMarkdown = string & { readonly [ticketMarkdown]: true };

export interface TicketBodyOptions {
  /**
   * The thread's capture: the checked address of the copy uploaded into the
   * ticket, `missing` when the tracker takes images but this one couldn't be
   * added, or null to add nothing.
   */
  capture: { url: WebAddress } | "missing" | null;
  /** Who is creating the ticket; null when they turned attribution off. */
  attribution: { name: string } | null;
  /** The thread's link; null with no website and no review address. */
  link: WebAddress | null;
}

/**
 * The text a ticket is created with: the person's draft exactly as they
 * edited it, then the capture, then, unless turned off, the line saying it
 * came from Critiqs. When the draft ends inside a block at the top level
 * that a blank line doesn't end (a code fence, an HTML comment, a `<pre>`
 * block, and the like), the line that ends it is added after it, so what
 * Critiqs adds stays outside it; nothing else in the draft changes.
 */
export function ticketBody(draft: string, options: TicketBodyOptions): TicketMarkdown {
  const added: string[] = [];
  if (options.capture !== null) {
    added.push(
      "## Capture",
      options.capture !== "missing"
        ? `!${markdownLink("Capture", options.capture.url)}`
        : options.link === null
          ? "Critiqs couldn't add the capture to this ticket."
          : `Critiqs couldn't add the capture to this ticket; ${markdownLink("open the thread", options.link)} to view it.`,
    );
  }
  if (options.attribution !== null) added.push(attributionLines(options.attribution.name, options.link).join("\n"));
  if (added.length === 0) return draft as TicketMarkdown;
  if (draft.trim() === "") return `${added.join("\n\n")}\n` as TicketMarkdown;
  const end = markdownBlocks(draft).openBlockEnd;
  const ended = /[\r\n]$/.test(draft) ? draft : `${draft}\n`;
  return `${ended}${end === null ? "" : `${end}\n`}\n${added.join("\n\n")}\n` as TicketMarkdown;
}

/**
 * The comment on a ticket whose tracker keeps captures as attachments (Jira)
 * when Critiqs couldn't attach the thread's: where to view it, when the
 * thread has a link.
 */
export function ticketCaptureMissing(link: WebAddress | null): TicketMarkdown {
  return (link === null
    ? "Critiqs couldn't attach the thread's capture to this ticket.\n"
    : `Critiqs couldn't attach the thread's capture to this ticket; ${markdownLink("open the thread", link)} to view it.\n`) as TicketMarkdown;
}

/**
 * The comment a person may add when linking a ticket to a thread: the
 * thread's first message, quoted, and its link; unless they turned it off, it
 * says it came from Critiqs.
 */
export function ticketLinkComment(summary: string, options: { link: WebAddress | null; attribution: { name: string } | null }): TicketMarkdown {
  const link = options.link === null ? null : markdownLink("open the thread", options.link);
  const line =
    options.attribution === null
      ? link === null
        ? []
        : [`Thread: ${link}`]
      : [`Linked from Critiqs by ${markdownText(options.attribution.name)}${link === null ? "." : `: ${link}`}`];
  return `${[...quoted(TICKET_STYLE.lines(summary.trim())), ...(line.length === 0 ? [] : ["", ...line])].join("\n")}\n` as TicketMarkdown;
}
