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
  const lines = [
    `## ${heading}`,
    "",
    `- Link: ${thread.link}`,
    `- Status: ${thread.status}`,
    `- Tags: ${thread.tags.length > 0 ? thread.tags.join(", ") : "none"}`,
    `- Screen: ${thread.screen}`,
    `- Target: ${describeTarget(thread)}${thread.reattached ? " (reattached)" : ""}`,
    `- Scope: ${thread.scope === "shared" ? "shared across records" : "this record only"}`,
    `- Revision: ${thread.revision ?? "unknown"}`,
    `- Page: ${thread.pageUrl} at ${thread.viewport.width}×${thread.viewport.height}`,
  ];
  if (thread.persona !== null) lines.push(`- Demo persona: ${thread.persona}`);
  const viewState = Object.entries(thread.viewState);
  if (viewState.length > 0) {
    lines.push(`- View state: ${viewState.map(([key, value]) => `${key}=${String(value)}`).join(", ")}`);
  }
  lines.push(`- Capture: ${thread.hasCapture ? "saved; open the link to view it" : "none"}`);
  lines.push("", "### Discussion");
  for (const message of thread.messages) {
    const edited = message.editedAt === null ? "" : " (edited)";
    const via = message.via === "agent" ? " via coding agent" : "";
    lines.push(
      "",
      `**${message.author}**${via}, ${formatTime(message.createdAt)}${edited}, revision ${message.revision ?? "unknown"}:`,
      "",
      ...message.body.split("\n").map((line) => `> ${line}`),
    );
  }
  return lines;
}

function describeTarget(thread: ExportThread): string {
  const parts = [
    thread.target.purposeId === null ? null : `\`${thread.target.purposeId}\``,
    thread.target.label === null ? null : `"${thread.target.label}"`,
    thread.target.recordKey === null ? null : `record ${thread.target.recordKey}`,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "unknown";
}

function summarize(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine || "(empty comment)";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
