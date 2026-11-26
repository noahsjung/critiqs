import { type ThreadTicket, TRACKERS, webAddress } from "@critiqs/core";
import type { ThreadStatus } from "./store.ts";

// The mention and reply email itself: who mentioned the reviewer or replied
// in a thread they are in, the thread's capture, and its whole discussion. It is built a page of messages at a time into the
// exact request the mail service receives (Resend's JSON, without the sender),
// which is stored once and sent unchanged on every retry.

/**
 * Resend's limit for one email, in bytes: 40 MB, counting attachments after
 * Base64 encoding. A prepared email is measured both as the request Critiqs
 * sends and as the message the mail service builds from it, assuming every
 * part is Base64-encoded in 76-character lines. Every comment always stays in
 * the HTML part; only when the whole email wouldn't fit does the plain-text
 * part, then the capture, make room, and the email says so.
 */
export const MAX_EMAIL_BYTES = 40_000_000;
/** Room for the message's headers and part boundaries when the mail service builds it. */
const MIME_OVERHEAD_BYTES = 16 * 1024;
/** Room kept for the email's opening and closing while reading pages; the finished email is measured exactly. */
const RESERVE_BYTES = 64 * 1024;
/** Longest name or label the email repeats: project, reviewer, and author names are shortened past this. */
const MAX_NAME_SHOWN = 200;
/** Where the HTML refers to its capture; the inline attachment's content ID. */
export const CAPTURE_CONTENT_ID = "critiqs-capture";

/** One message of the discussion as the email shows it. */
export interface EmailEntry {
  messageId: string;
  authorName: string;
  createdAt: number;
  edited: boolean;
  body: string;
  /** The names the text shows after `@`, and whether each is the recipient. */
  mentions: { label: string; you: boolean }[];
  mentionsYou: boolean;
  /** One of the mentions or replies this email reports; a mention when `mentionsYou`, otherwise a reply. */
  reported: boolean;
  /** Written for its author by a coding agent, or by Critiqs AI in a mockup thread. */
  via?: "agent" | "ai";
  link: string | null;
}

/** How a message's author line names who wrote it for them. */
const VIA_LABELS = { agent: "via coding agent", ai: "via Critiqs AI" } as const;

/** What the email knows before reading the discussion. */
export interface EmailHeader {
  to: string;
  recipientName: string;
  projectName: string;
  status: ThreadStatus;
  tags: string[];
  messageCount: number;
  /** The capture to attach, by size, or why there is none. */
  capture: { size: number; caption: string } | { note: string };
  mute: string;
  unsubscribe: string;
  /**
   * The thread's page on the Critiqs website, where the deployment has one.
   * It shows the whole thread, so it is the email's one link, and comments
   * carry no links of their own.
   */
  threadPage?: string;
  /** The thread's linked tickets, oldest first, each with its key, status, and address; absent where the backend has none. */
  tickets?: ThreadTicket[];
}

/** A capture read for attaching, or why it can't be shown. */
export type EmailImage = { bytes: Uint8Array; type: string; extension: string } | { note: string };

const encoder = new TextEncoder();
/** A string's bytes inside a JSON string literal, without the quotes. */
const json = (text: string) => encoder.encode(JSON.stringify(text).slice(1, -1));

/** Bytes of a part the mail service Base64-encodes in 76-character lines. */
const mimeBytes = (bytes: number) => {
  const encoded = Math.ceil(bytes / 3) * 4;
  return encoded + 2 * Math.ceil(encoded / 76);
};

/** One part of the email as it is built: its request bytes, and its own bytes for measuring the built message. */
class Part {
  readonly chunks: Uint8Array[] = [];
  /** Bytes inside the request's JSON string. */
  json = 0;
  /** UTF-8 bytes of the text itself. */
  raw = 0;
  add(text: string): void {
    const chunk = json(text);
    this.chunks.push(chunk);
    this.json += chunk.length;
    this.raw += encoder.encode(text).length;
  }
}

/** Builds one mention email from the discussion, page by page. */
export class MentionEmail {
  private readonly html = new Part();
  /** Null once the plain-text discussion can't fit. */
  private text: Part | null = new Part();
  /** The capture's size, or 0 without one. Whether it fits is decided only once the finished email is measured. */
  private readonly imageSize: number;
  private first: EmailEntry | null = null;
  private count = 0;
  private readonly reported: EmailEntry[] = [];

  constructor(private readonly header: EmailHeader) {
    this.imageSize = "size" in header.capture ? header.capture.size : 0;
  }

  add(entries: EmailEntry[]): void {
    for (const entry of entries) {
      if (entry.reported) this.reported.push(entry);
      this.first ??= entry;
      const shown = this.header.threadPage === undefined ? entry : { ...entry, link: null };
      this.html.add(entryHtml(shown));
      this.text?.add(`${this.count === 0 ? "" : "\n\n"}${entryText(shown)}`);
      this.count++;
      this.fit();
    }
  }

  /** Whether any message still mentions the recipient as this email reports. */
  get mentionsRecipient(): boolean {
    return this.reported.length > 0;
  }

  /** Whether there is a capture to read; `finish` decides whether it fits. */
  get wantsImage(): boolean {
    return this.imageSize > 0;
  }

  /**
   * While reading pages, stops keeping the plain-text copy of the discussion
   * once it clearly can't fit beside the HTML part and the capture. The
   * capture is never given up here: only `finish`, measuring the whole email,
   * decides that.
   */
  private fit(): void {
    const fits = (text: Part | null, image: number) =>
      fitsEmail(
        { json: RESERVE_BYTES + this.html.json, raw: RESERVE_BYTES + this.html.raw },
        text === null ? null : { json: RESERVE_BYTES + text.json, raw: RESERVE_BYTES + text.raw },
        image,
      );
    if (this.text !== null && !fits(this.text, this.imageSize)) this.text = null;
  }

  /**
   * The finished request body, or null if even the HTML discussion alone is
   * larger than an email may be. `image` is the capture read for attaching,
   * when `wantsImage`. The finished email is measured exactly; if it is too
   * large, the plain-text discussion and then the capture make room.
   */
  finish(image: EmailImage | null): Blob | null {
    const attach = image !== null && "bytes" in image ? image : null;
    const imageNote = image !== null && "note" in image ? image.note : null;
    const options = [
      { text: true, attach },
      { text: false, attach },
      ...(attach === null ? [] : [{ text: false, attach: null }]),
    ];
    for (const option of options) {
      if (option.text && this.text === null) continue;
      const parts = this.render(option.text, option.attach, imageNote);
      if (parts !== null) return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: "application/json" });
    }
    return null;
  }

  /** The request's pieces with or without the plain-text discussion and capture, or null if that email is too large. */
  private render(withText: boolean, attach: { bytes: Uint8Array; type: string; extension: string } | null, imageNote: string | null): Uint8Array[] | null {
    const header = this.header;
    const projectName = shorten(header.projectName);
    // A mention is the stronger reason: when there is one, the email is about the mentions.
    const mentions = this.reported.filter((entry) => entry.mentionsYou);
    const told = mentions.length > 0 ? mentions : this.reported;
    const authors: string[] = [];
    for (const entry of told) if (!authors.includes(shorten(entry.authorName))) authors.push(shorten(entry.authorName));
    const who = authors.length === 1 ? authors[0]! : `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}`;
    const what = told.length === 1 ? "a comment" : `${told.length} comments`;
    const link = header.threadPage ?? this.reported.at(-1)?.link ?? null;
    const topic = clean(this.first?.body ?? "").replace(/\s+/g, " ").trim();
    const snippet = topic.length > 60 ? `${topic.slice(0, 59).trimEnd()}…` : topic;
    const action = mentions.length > 0 ? "mentioned you" : "replied";
    const sentence = mentions.length > 0 ? `mentioned you in ${what} on` : `replied in a thread you're in on`;
    // Names and comments come from reviewers; keep the subject a single line.
    const subject = (snippet === "" ? `${who} ${action} in ${projectName}` : `${who} ${action}: “${snippet}” · ${projectName}`)
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 200);
    const count = Math.max(header.messageCount, this.count);
    const comments = count === 1 ? "1 comment" : `${count} comments`;
    const context = [header.status === "resolved" ? "Resolved" : "Open", ...header.tags.map((tag) => shorten(tag)), comments].join(" · ");
    // Without an attachment, say why: no capture, an unreadable one, or no room beside the whole discussion.
    const note =
      attach !== null
        ? null
        : "note" in header.capture
          ? shorten(header.capture.note, 1_000)
          : (imageNote ??
            "The capture isn't included: with this whole discussion, the email would be larger than the email service accepts. Open the comment to see it.");

    const tickets = emailTickets(header.tickets);
    const textStart = clean([
      `Hi ${shorten(header.recipientName)},`,
      "",
      `${who} ${sentence} ${projectName}.`,
      context,
      ...tickets.map((ticket) => `Ticket: ${ticket.text}${ticket.url === null ? "" : ` ${ticket.url}`}`),
      ...(note === null ? [] : [note]),
      link === null ? "Open the prototype to see it." : `Open the comment: ${link}`,
      "",
      withText ? `Thread (${comments})` : "Thread",
      "",
      withText ? "" : `This discussion's ${comments} are too long to repeat in the plain-text version of this email. The HTML version shows every comment.`,
    ].join("\n"));
    const textEnd = clean(["", "", "--", `Mute ${projectName}: ${header.mute}`, `Stop all Critiqs emails: ${header.unsubscribe}`].join("\n"));

    const capture =
      attach === null
        ? captureNoteHtml(note!)
        : `<p style="margin:16px 0 4px"><img src="cid:${CAPTURE_CONTENT_ID}" width="560" alt="Capture of the commented screen" style="display:block;width:100%;max-width:560px;height:auto;border:1px solid #e5e7eb;border-radius:6px"></p>
<p style="margin:0 0 16px;color:#6b7280;font-size:13px">${htmlText("caption" in header.capture ? header.capture.caption : "")}</p>`;
    const htmlStart = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1a1a">
<p style="margin:0 0 12px">Hi ${htmlText(shorten(header.recipientName))},</p>
<p style="margin:0 0 4px"><strong>${htmlText(who)}</strong> ${htmlText(sentence)} <strong>${htmlText(projectName)}</strong>.</p>
<p style="margin:0;color:#6b7280;font-size:13px">${htmlText(context)}</p>
${tickets
  .map(
    (ticket) =>
      `<p style="margin:4px 0 0;color:#6b7280;font-size:13px">Ticket: ${ticket.url === null ? htmlText(ticket.text) : `<a href="${escapeAttribute(ticket.url)}" style="color:#0d63f3">${htmlText(ticket.text)}</a>`}</p>`,
  )
  .join("\n")}
${capture}
${link === null ? `<p style="margin:16px 0">Open the prototype to see it.</p>` : `<p style="margin:16px 0"><a href="${escapeAttribute(link)}" style="display:inline-block;padding:8px 14px;background:#0d63f3;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">Open the comment</a></p>`}
<h2 style="margin:24px 0 0;font-size:15px">Thread · ${htmlText(comments)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
`;
    const htmlEnd = `
</table>
<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px"><a href="${escapeAttribute(header.mute)}" style="color:#6b7280">Mute ${htmlText(projectName)}</a> · <a href="${escapeAttribute(header.unsubscribe)}" style="color:#6b7280">Stop all Critiqs emails</a></p>
</div>
</body></html>`;

    const html = { json: json(htmlStart).length + this.html.json + json(htmlEnd).length, raw: 0 };
    html.raw = encoder.encode(htmlStart).length + this.html.raw + encoder.encode(htmlEnd).length;
    const textParts = withText ? this.text! : null;
    const text = {
      json: json(textStart).length + (textParts?.json ?? 0) + json(textEnd).length,
      raw: encoder.encode(textStart).length + (textParts?.raw ?? 0) + encoder.encode(textEnd).length,
    };
    const parts: Uint8Array[] = [
      encoder.encode(`{"to":${JSON.stringify([header.to])},"subject":${JSON.stringify(subject)},"text":"`),
      json(textStart),
      ...(textParts?.chunks ?? []),
      json(textEnd),
      encoder.encode(`","html":"`),
      json(htmlStart),
      ...this.html.chunks,
      json(htmlEnd),
      encoder.encode(`"`),
    ];
    if (attach !== null) {
      parts.push(encoder.encode(`,"attachments":[{"filename":${JSON.stringify(`capture.${attach.extension}`)},"content":"`));
      parts.push(...base64Chunks(attach.bytes));
      parts.push(encoder.encode(`","content_type":${JSON.stringify(attach.type)},"content_id":${JSON.stringify(CAPTURE_CONTENT_ID)}}]`));
    }
    parts.push(encoder.encode("}"));
    const request = parts.reduce((total, part) => total + part.length, 0);
    if (request > MAX_EMAIL_BYTES || !fitsEmail(html, text, attach?.bytes.length ?? 0)) return null;
    return parts;
  }
}

/** The most tickets an email names; a thread holds at most 40. */
export const MAX_EMAIL_TICKETS = 40;

/**
 * A thread's tickets as an email names them: "Linear ENG-1 · In Progress",
 * each on one line and shortened, with its address only when it is a web
 * address, so nothing a tracker sent can become another kind of link.
 */
function emailTickets(tickets: ThreadTicket[] | undefined): { text: string; url: string | null }[] {
  return (tickets ?? []).slice(0, MAX_EMAIL_TICKETS).map((ticket) => {
    const tracker = TRACKERS.find((entry) => entry.id === ticket.tracker)?.label ?? ticket.tracker;
    const status = ticket.status === null ? "" : ` · ${shorten(ticket.status.label)}${ticket.lastKnown === true ? " · last known" : ""}`;
    return { text: clean(`${tracker} ${shorten(ticket.key)}${status}`).replace(/\s+/g, " "), url: webAddress(ticket.url) };
  });
}

/**
 * Whether an email with these parts fits the mail service's limit, both as
 * the request and as the message built from it. A null text part means only
 * its short note is kept, which the reserves cover.
 */
function fitsEmail(html: { json: number; raw: number }, text: { json: number; raw: number } | null, imageSize: number): boolean {
  const attachment = imageSize === 0 ? 0 : Math.ceil(imageSize / 3) * 4 + 200;
  const request = html.json + (text?.json ?? RESERVE_BYTES) + attachment + 1_000;
  const message = mimeBytes(html.raw) + mimeBytes(text?.raw ?? RESERVE_BYTES) + (imageSize === 0 ? 0 : mimeBytes(imageSize)) + MIME_OVERHEAD_BYTES;
  return request <= MAX_EMAIL_BYTES && message <= MAX_EMAIL_BYTES;
}

/** A name or label as the email repeats it: cleaned, and shortened with an ellipsis past `max` characters. */
function shorten(text: string, max = MAX_NAME_SHOWN): string {
  const cleaned = clean(text);
  return cleaned.length > max ? clean(`${cleaned.slice(0, max - 1)}…`) : cleaned;
}

/** Base64 in pieces whose length is a multiple of three, so the pieces join into the same text as encoding at once. */
export function base64Chunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 3 * 0x8000) {
    chunks.push(encoder.encode(btoa(String.fromCharCode(...bytes.subarray(i, i + 3 * 0x8000)))));
  }
  return chunks;
}

const IMAGE_SIGNATURES: { type: string; extension: string; matches: (bytes: Uint8Array) => boolean }[] = [
  { type: "image/png", extension: "png", matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/jpeg", extension: "jpg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", extension: "gif", matches: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    type: "image/webp",
    extension: "webp",
    matches: (b) => String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
  },
];

/** A capture's bytes as an image to attach, or why it can't be shown: missing, or not an image Critiqs accepts. */
export function emailImage(bytes: Uint8Array | null): EmailImage {
  const kind = bytes === null ? undefined : IMAGE_SIGNATURES.find((signature) => signature.matches(bytes));
  if (bytes === null || kind === undefined) return { note: "The capture couldn't be included in this email. Open the comment to see it." };
  return { bytes, type: kind.type, extension: kind.extension };
}

function entryText(entry: EmailEntry): string {
  const meta = [
    shorten(entry.authorName),
    ...(entry.via === undefined ? [] : [VIA_LABELS[entry.via]]),
    readableTime(entry.createdAt),
    ...(entry.edited ? ["edited"] : []),
    ...(entry.mentionsYou ? ["mentions you"] : []),
  ];
  return clean([meta.join(" · "), entry.body, ...(entry.link === null ? [] : [`Open: ${entry.link}`])].join("\n"));
}

function entryHtml(entry: EmailEntry): string {
  const cell = entry.mentionsYou
    ? "padding:12px;border-top:1px solid #e5e7eb;border-left:3px solid #0d63f3;background:#f5f8ff"
    : "padding:12px 0;border-top:1px solid #e5e7eb";
  const meta = [...(entry.via === undefined ? [] : [VIA_LABELS[entry.via]]), readableTime(entry.createdAt), ...(entry.edited ? ["edited"] : [])].join(" · ");
  return `<tr><td style="${cell}"><p style="margin:0;font-size:14px"><strong>${htmlText(shorten(entry.authorName))}</strong> <span style="color:#6b7280">· ${meta}</span>${entry.mentionsYou ? ` <span style="color:#0d63f3;font-size:12px;font-weight:600">· Mentions you</span>` : ""}</p><p style="margin:4px 0 0">${bodyHtml(entry.body, entry.mentions)}</p>${entry.link === null ? "" : `<p style="margin:4px 0 0;font-size:13px"><a href="${escapeAttribute(entry.link)}" style="color:#0d63f3">Open this comment</a></p>`}</td></tr>
`;
}

/** A message's text as HTML: escaped, line breaks kept, and the first `@Name` of each person it mentions highlighted. */
function bodyHtml(body: string, mentions: { label: string; you: boolean }[]): string {
  const text = clean(body);
  const picks: { start: number; end: number; you: boolean }[] = [];
  for (const mention of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    const token = `@${clean(mention.label)}`;
    for (let from = 0; ; ) {
      const start = text.indexOf(token, from);
      if (start < 0) break;
      const end = start + token.length;
      if (!picks.some((pick) => start < pick.end && end > pick.start)) {
        picks.push({ start, end, you: mention.you });
        break;
      }
      from = start + 1;
    }
  }
  picks.sort((a, b) => a.start - b.start);
  let html = "";
  let at = 0;
  for (const pick of picks) {
    html += multiline(text.slice(at, pick.start));
    const token = htmlText(text.slice(pick.start, pick.end));
    html += pick.you
      ? `<strong style="color:#0d63f3;background:#e8f0fe;border-radius:3px;padding:0 2px">${token}</strong>`
      : `<span style="color:#0d63f3;font-weight:600">${token}</span>`;
    at = pick.end;
  }
  return html + multiline(text.slice(at));
}

const multiline = (text: string) => htmlText(text).replace(/\n/g, "<br>");

function captureNoteHtml(note: string): string {
  return `<p style="margin:16px 0;padding:12px;background:#f3f4f6;border-radius:6px;color:#4b5563;font-size:13px">${htmlText(note)}</p>`;
}

/**
 * Text that reviewers wrote, made safe to show: line breaks normalized, and
 * control characters and broken surrogate halves, which neither email part
 * can show, replaced with U+FFFD.
 */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

/**
 * Text for an HTML element's content. Only `<` and an `&` that could start a
 * character reference need escaping there; leaving the rest as written keeps
 * long comments within the email's size.
 */
function htmlText(text: string): string {
  return clean(text).replace(/&(?=[A-Za-z0-9#])/g, "&amp;").replace(/</g, "&lt;");
}

/** Text for a quoted attribute, such as a link. */
function escapeAttribute(text: string): string {
  return clean(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time every reader can place: the server can't know the reader's time zone, so it's in UTC. */
export function readableTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
