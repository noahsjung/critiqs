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
  messages: ExportMessage[];
}

export interface FeedbackCollection {
  title: string;
  projectName: string;
  exportedAt: number;
  threads: ExportThread[];
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
    "",
    "### Discussion",
    ...discussionLines(thread, EXPORT_STYLE),
  ];
}
