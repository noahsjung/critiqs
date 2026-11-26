import type { ExportedThread } from "./protocol.ts";
import { type ThreadTicket, TRACKERS } from "./tickets.ts";
import { contextLines, discussionLines, EXPORT_STYLE, formatTime, summarize } from "./thread-markdown.ts";
import type { Revision, Scope, ThreadStatus, ViewState } from "./types.ts";

/** Bumped when the JSON export shape changes incompatibly. */
export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportMessage {
  id: string;
  link: string;
  author: string;
  createdAt: number;
  editedAt: number | null;
  body: string;
  revision: Revision;
  /** Written by a coding agent for its author, or by Critiqs AI; absent when the author wrote it. */
  via?: "agent" | "ai";
}

/** One thread in a feedback collection. Its discussion is preserved, not merged. */
export interface ExportThread {
  id: string;
  link: string;
  status: Exclude<ThreadStatus, "deleted">;
  tags: string[];
  screen: string;
  viewState: ViewState;
  scope: Scope;
  target: { purposeId: string | null; recordKey: string | null; label: string | null };
  /** Prototype revision of the first message. */
  revision: Revision;
  /** Page the feedback was left on, its browser view size, and the demo persona shown. */
  pageUrl: string;
  viewport: { width: number; height: number };
  persona: string | null;
  /** True when the thread now points at a replacement target; `target` is the current one. */
  reattached: boolean;
  /** Whether a capture or screenshot is saved; it is viewed by opening the thread's link. */
  hasCapture: boolean;
  /**
   * The thread's linked tickets, oldest first: tracker, key, title, status
   * (null until known), and address in the tracker. Absent where the backend
   * has no tickets.
   */
  tickets?: ThreadTicket[];
  messages: ExportMessage[];
}

export interface FeedbackCollection {
  title: string;
  projectName: string;
  exportedAt: number;
  threads: ExportThread[];
}

/**
 * One exported thread as a collection holds it: where it is now (its
 * replacement target when reattached) and each message, with links from
 * `linkFor` (null for the thread as a whole).
 */
export function exportThread(thread: ExportedThread, linkFor: (messageId: string | null) => string): ExportThread {
  const { evidence } = thread.anchor;
  const { screen, viewState, scope, target } = thread.location ?? thread.anchor;
  return {
    id: thread._id,
    link: linkFor(null),
    status: thread.status === "resolved" ? "resolved" : "open",
    tags: thread.tags,
    screen,
    viewState,
    scope,
    target: { purposeId: target.purposeId, recordKey: target.recordKey, label: target.clues.label },
    revision: evidence.revision,
    pageUrl: evidence.url,
    viewport: evidence.viewport,
    persona: evidence.persona,
    reattached: thread.location !== null,
    hasCapture: thread.hasCapture,
    ...(thread.tickets === undefined ? {} : { tickets: thread.tickets.map(({ tracker, key, title, status, url }) => ({ tracker, key, title, status, url })) }),
    messages: thread.messages.map((message) => ({
      id: message._id,
      link: linkFor(message._id),
      author: message.author,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      body: message.body,
      revision: message.revision,
      ...(message.via === undefined ? {} : { via: message.via }),
    })),
  };
}

/** Structured JSON for coding agents and tools. Contains feedback only, never credentials. */
export function exportJson(collection: FeedbackCollection): string {
  return JSON.stringify({ schemaVersion: EXPORT_SCHEMA_VERSION, ...collection }, null, 2);
}

/** Readable Markdown handoff for implementers. */
export function exportMarkdown(collection: FeedbackCollection): string {
  const lines = [
    `# ${collection.title}`,
    "",
    `Project: ${collection.projectName}  `,
    `Exported: ${formatTime(collection.exportedAt)}  `,
    `Threads: ${collection.threads.length}`,
  ];
  for (const thread of collection.threads) {
    lines.push("", ...threadMarkdown(thread));
  }
  return `${lines.join("\n")}\n`;
}

function threadMarkdown(thread: ExportThread): string[] {
  const [first] = thread.messages;
  const heading = first === undefined ? "(no messages)" : summarize(first.body);
  return [
    `## ${heading}`,
    "",
    ...contextLines(thread, EXPORT_STYLE, { link: thread.link, status: true, capture: thread.hasCapture ? "saved; open the link to view it" : "none" }),
    ...ticketLines(thread),
    "",
    "### Discussion",
    ...discussionLines(thread, EXPORT_STYLE),
  ];
}

/** Each linked ticket on its own line: tracker, key and status, title, and address, as written; nothing where the backend has no tickets. */
function ticketLines(thread: ExportThread): string[] {
  if (thread.tickets === undefined) return [];
  if (thread.tickets.length === 0) return ["- Tickets: none"];
  const one = (value: string) => value.replace(/\s+/g, " ").trim();
  return thread.tickets.map((ticket) => {
    const tracker = TRACKERS.find((entry) => entry.id === ticket.tracker)?.label ?? ticket.tracker;
    const status = ticket.status === null ? "status unknown" : one(ticket.status.label);
    return `- Ticket: ${tracker} ${one(ticket.key)} · ${status}, "${one(ticket.title)}", ${one(ticket.url)}`;
  });
}
