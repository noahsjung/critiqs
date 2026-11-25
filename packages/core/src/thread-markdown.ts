import type { ExportThread } from "./export.ts";

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

/**
 * A Markdown link whose destination renders exactly as given: in angle
 * brackets, so ")" can't end it, with "&" written as "&amp;" so no part of
 * the address is read as a character reference, and the characters that
 * angle brackets can't hold percent-encoded.
 */
export function markdownLink(text: string, url: string): string {
  const destination = url
    .replaceAll("&", "&amp;")
    .replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
  return `[${text}](<${destination}>)`;
}

/** Quotes text line by line, so its Markdown can't run past the quote (an unclosed code fence ends with it). */
export function quoted(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((line) => `> ${line}`);
}

/** Text from the app or a person, on one line, so it can't start a Markdown block (a code fence, say) inside a list item. */
function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * The thread's context as a list: its link, then where and what it is about.
 * `linkText` writes the link as a Markdown link with that text, for trackers,
 * which render it; the export keeps the bare address.
 */
export function contextLines(thread: ExportThread, options: { link: string; linkText?: string; status: boolean; capture: string }): string[] {
  const lines = [
    `- Link: ${options.linkText === undefined ? options.link : markdownLink(options.linkText, options.link)}`,
    ...(options.status ? [`- Status: ${thread.status}`] : []),
    `- Tags: ${thread.tags.length > 0 ? thread.tags.map(oneLine).join(", ") : "none"}`,
    `- Screen: ${oneLine(thread.screen)}`,
    `- Target: ${describeTarget(thread)}${thread.reattached ? " (reattached)" : ""}`,
    `- Scope: ${thread.scope === "shared" ? "shared across records" : "this record only"}`,
    `- Revision: ${thread.revision === null ? "unknown" : oneLine(thread.revision)}`,
    `- Page: ${oneLine(thread.pageUrl)} at ${thread.viewport.width}×${thread.viewport.height}`,
  ];
  if (thread.persona !== null) lines.push(`- Demo persona: ${oneLine(thread.persona)}`);
  const viewState = Object.entries(thread.viewState);
  if (viewState.length > 0) {
    lines.push(`- View state: ${viewState.map(([key, value]) => `${oneLine(key)}=${oneLine(value)}`).join(", ")}`);
  }
  lines.push(`- Capture: ${options.capture}`);
  return lines;
}

/** Every message, oldest first, each quoted under its author and time. */
export function discussionLines(thread: ExportThread): string[] {
  const lines: string[] = [];
  for (const message of thread.messages) {
    const edited = message.editedAt === null ? "" : " (edited)";
    const via = message.via === "agent" ? " via coding agent" : "";
    lines.push(
      "",
      `**${oneLine(message.author)}**${via}, ${formatTime(message.createdAt)}${edited}, revision ${message.revision ?? "unknown"}:`,
      "",
      ...quoted(message.body),
    );
  }
  return lines;
}

function describeTarget(thread: ExportThread): string {
  const parts = [
    thread.target.purposeId === null ? null : `\`${oneLine(thread.target.purposeId)}\``,
    thread.target.label === null ? null : `"${oneLine(thread.target.label)}"`,
    thread.target.recordKey === null ? null : `record ${oneLine(thread.target.recordKey)}`,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "unknown";
}
