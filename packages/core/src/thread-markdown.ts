import type { ExportThread } from "./export.ts";
import { markdownCode, markdownLines, markdownLink, markdownText } from "./markdown-text.ts";

// Markdown pieces of one exported thread, shared by the Markdown export and
// ticket text. Internal: not exported from the package.

/** The first line of a message, short enough for a heading or a ticket title. */
export function summarize(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine || "(empty comment)";
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/** Quotes Markdown lines, so they can't run past the quote (an unclosed code fence ends with it). */
export function quoted(lines: string[]): string[] {
  return lines.map((line) => `> ${line}`);
}

/**
 * How a thread's own text (its messages, names, and the page's details,
 * which reviewers and apps write) goes into the Markdown.
 *
 * - `export`: as written, for the Markdown export, a handoff the team
 *   downloads and reads as text: messages keep their own Markdown, and each
 *   detail is kept on one line, so it can't start a block (a code fence, say)
 *   inside a list item.
 * - `ticket`: rendering exactly as written, for ticket text, which a
 *   tracker renders for the whole team: escaped, so nothing in it forms a
 *   link, image, HTML, or any other structure (`markdownText`). The page's
 *   address leaves out its query and fragment, which can carry a prototype's
 *   sign-in token.
 */
export interface ThreadTextStyle {
  text(value: unknown): string;
  code(value: unknown): string;
  lines(text: string): string[];
  page(url: string): string;
}

/** Text from the app or a person, on one line, so it can't start a Markdown block (a code fence, say) inside a list item. */
function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}

export const EXPORT_STYLE: ThreadTextStyle = {
  text: oneLine,
  code: (value) => `\`${oneLine(value)}\``,
  lines: (text) => text.split(/\r\n|\r|\n/),
  page: oneLine,
};

export const TICKET_STYLE: ThreadTextStyle = {
  text: markdownText,
  code: markdownCode,
  lines: markdownLines,
  page: (url) => markdownCode(pageWithoutQuery(url)),
};

/** A page's address without its query or fragment; as given when it isn't an address. */
function pageWithoutQuery(url: string): string {
  try {
    const page = new URL(url);
    return `${page.origin === "null" ? `${page.protocol}` : page.origin}${page.pathname}`;
  } catch {
    return url.replace(/[?#].*$/s, "");
  }
}

/**
 * The thread's context as a list: its link, then where and what it is about.
 * `linkText` writes the link as a Markdown link with that text, for trackers,
 * which render it; the export keeps the bare address.
 */
export function contextLines(thread: ExportThread, style: ThreadTextStyle, options: { link: string; linkText?: string; status: boolean; capture: string }): string[] {
  const lines = [
    `- Link: ${options.linkText === undefined ? options.link : markdownLink(options.linkText, options.link)}`,
    ...(options.status ? [`- Status: ${thread.status}`] : []),
    `- Tags: ${thread.tags.length > 0 ? thread.tags.map(style.text).join(", ") : "none"}`,
    `- Screen: ${style.text(thread.screen)}`,
    `- Target: ${describeTarget(thread, style)}${thread.reattached ? " (reattached)" : ""}`,
    `- Scope: ${thread.scope === "shared" ? "shared across records" : "this record only"}`,
    `- Revision: ${thread.revision === null ? "unknown" : style.text(thread.revision)}`,
    `- Page: ${style.page(thread.pageUrl)} at ${thread.viewport.width}×${thread.viewport.height}`,
  ];
  if (thread.persona !== null) lines.push(`- Demo persona: ${style.text(thread.persona)}`);
  const viewState = Object.entries(thread.viewState);
  if (viewState.length > 0) {
    lines.push(`- View state: ${viewState.map(([key, value]) => `${style.text(key)}=${style.text(value)}`).join(", ")}`);
  }
  lines.push(`- Capture: ${options.capture}`);
  return lines;
}

/** Every message, oldest first, each quoted under its author and time. */
export function discussionLines(thread: ExportThread, style: ThreadTextStyle): string[] {
  const lines: string[] = [];
  for (const message of thread.messages) {
    const edited = message.editedAt === null ? "" : " (edited)";
    const via = message.via === "agent" ? " via coding agent" : "";
    lines.push(
      "",
      `**${style.text(message.author)}**${via}, ${formatTime(message.createdAt)}${edited}, revision ${message.revision === null ? "unknown" : style.text(message.revision)}:`,
      "",
      ...quoted(style.lines(message.body)),
    );
  }
  return lines;
}

function describeTarget(thread: ExportThread, style: ThreadTextStyle): string {
  const parts = [
    thread.target.purposeId === null ? null : style.code(thread.target.purposeId),
    thread.target.label === null ? null : `"${style.text(thread.target.label)}"`,
    thread.target.recordKey === null ? null : `record ${style.text(thread.target.recordKey)}`,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "unknown";
}
