// Email-code sign-in rules shared by Critiqs Cloud's sign-in service and a
// self-hosted server. Reviewers prove they control an email address by typing
// a one-time code sent to it; there are no passwords.

/** How long a code works. */
export const CODE_MINUTES = 10;
/** Wrong guesses allowed per sign-in attempt, across all codes it sends. */
export const MAX_GUESSES = 5;
/** Codes one sign-in attempt may send, counting the first. */
export const MAX_CODE_SENDS = 3;
/** Codes sent to one address within the window below, across all attempts. */
export const EMAIL_SEND_LIMIT = 5;
export const EMAIL_SEND_WINDOW_MS = 15 * 60 * 1000;
/** Codes sent by one deployment within the window below, to cap abuse of its mail account. */
export const GLOBAL_SEND_LIMIT = 300;
export const GLOBAL_SEND_WINDOW_MS = 60 * 60 * 1000;
/** Longest display name, so names fit on comments and in menus. */
export const MAX_NAME_LENGTH = 60;

/** A lowercased email address, or null when it isn't a plausible one. */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(email)) return null;
  return email;
}

/** A display name after trimming, or null when it is empty, too long, or contains control characters. */
export function displayName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  if (name === "" || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** A six-digit code from a cryptographic source, without modulo bias. */
export function generateCode(): string {
  const limit = 4_294_000_000; // largest multiple of 1,000,000 below 2^32
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value! < limit) return String(value! % 1_000_000).padStart(6, "0");
  }
}

/** Only the digits a reviewer typed, so spaces or dashes in a pasted code don't matter. */
export function cleanCode(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/**
 * A keyed digest of a code, bound to its attempt, address, and send. A stolen
 * database alone cannot test the million possible codes, and a code from one
 * attempt, address, or earlier send never matches another.
 */
export async function codeDigest(
  secret: string,
  parts: { attempt: string; email: string; generation: number; code: string },
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = JSON.stringify([parts.attempt, parts.email, parts.generation, parts.code]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compares two digests in time independent of where they differ. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** A fixed-window counter, such as codes sent to one address. */
export interface Counter {
  count: number;
  expiresAt: number;
}

/** Counts one use if the limit allows it; returns the updated counter, or when to retry. */
export function countUse(
  counter: Counter | null,
  limit: number,
  windowMs: number,
  now: number,
): { allowed: true; next: Counter } | { allowed: false; retryAfterMs: number } {
  const live = counter !== null && counter.expiresAt > now ? counter : null;
  if (live !== null && live.count >= limit) return { allowed: false, retryAfterMs: live.expiresAt - now };
  return { allowed: true, next: { count: (live?.count ?? 0) + 1, expiresAt: live?.expiresAt ?? now + windowMs } };
}

// ---------------------------------------------------------------------------
// Email

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Lets the mail service drop a retried duplicate. */
  idempotencyKey: string;
  /** Files sent with the message; one with a `contentId` shows where the HTML refers to `cid:<contentId>`. */
  attachments?: MailAttachment[];
  /**
   * A display name in place of the sender's own, such as "Sam Lee via
   * Critiqs", always on the sender's address: Critiqs never sends as someone
   * else's address, which would fail email checks.
   */
  fromName?: string;
  /** Where replies go, such as the person who asked Critiqs to send it. */
  replyTo?: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /**
   * Sends a request prepared earlier: Resend's JSON without the sender. Mail
   * services without it receive the same email through `send`.
   */
  sendPrepared?(body: Blob, idempotencyKey: string): Promise<void>;
}

/** A prepared request (Resend's JSON without the sender) as a message, for mail services that take messages. */
export function preparedMessage(body: string, idempotencyKey: string): MailMessage {
  const request = JSON.parse(body) as {
    to: [string];
    subject: string;
    text: string;
    html: string;
    attachments?: { filename: string; content: string; content_type: string; content_id?: string }[];
  };
  return {
    to: request.to[0],
    subject: request.subject,
    text: request.text,
    html: request.html,
    idempotencyKey,
    ...(request.attachments === undefined
      ? {}
      : {
          attachments: request.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.content_type,
            content: Uint8Array.from(atob(attachment.content), (char) => char.charCodeAt(0)),
            ...(attachment.content_id === undefined ? {} : { contentId: attachment.content_id }),
          })),
        }),
  };
}

export class MailError extends Error {
  /**
   * True when the mail service answered that it didn't take the message, so
   * it certainly wasn't sent; false when its answer never arrived or it
   * failed on its side, so the message may still go out.
   */
  readonly confirmed: boolean;
  constructor(message: string, options: { confirmed?: boolean } = {}) {
    super(message);
    this.confirmed = options.confirmed ?? false;
  }
}

/**
 * Whether a mail service status means it refused the message, so it wasn't
 * sent: a client error, except 409, which Resend answers while a request
 * with the same idempotency key is still in progress.
 */
function refused(status: number): boolean {
  return status >= 400 && status < 500 && status !== 409;
}

/** The sender with another display name, on the same address; quotes and line breaks in the name can't change the header. */
export function senderAs(from: string, name: string): string {
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  const shown = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/["\\]/g, (char) => `\\${char}`);
  return `"${shown}" <${address}>`;
}

/**
 * Sends mail through Resend's API with a team's or Critiqs's own key. A
 * message and the same message prepared earlier produce identical requests.
 */
export function resendMailer(options: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const fetcher = options.fetch ?? fetch;
  const post = async (body: BodyInit, idempotencyKey: string) => {
    let response: Response;
    try {
      response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body,
      });
    } catch {
      throw new MailError("The email service couldn't be reached.");
    }
    if (!response.ok) throw new MailError(`The email service refused the message (${response.status}).`, { confirmed: refused(response.status) });
  };
  return {
    async send(message) {
      const body = JSON.stringify({
        from: message.fromName === undefined ? options.from : senderAs(options.from, message.fromName),
        to: [message.to],
        ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.attachments === undefined || message.attachments.length === 0
          ? {}
          : {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: base64(attachment.content),
                content_type: attachment.contentType,
                ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
              })),
            }),
      });
      await post(body, message.idempotencyKey);
    },
    async sendPrepared(body, idempotencyKey) {
      // The prepared request starts with `{`; the sender goes first, as `send` puts it.
      await post(new Blob([`{"from":${JSON.stringify(options.from)},`, body.slice(1)], { type: "application/json" }), idempotencyKey);
    },
  };
}

/** The sign-in code email. It names the site asking, so a reviewer notices a site they didn't use. */
export function signInCodeMessage(options: {
  to: string;
  code: string;
  site: string;
  idempotencyKey: string;
  /** Where the code is typed: Critiqs's sign-in window (the default), or one of Critiqs's own panels. */
  where?: "window" | "panel";
}): MailMessage {
  const { to, code, site } = options;
  const only = options.where === "panel"
    ? "Only type it into the Critiqs panel where you asked for it."
    : "Only type it into the Critiqs sign-in window you opened.";
  const text = [
    `Your Critiqs sign-in code is ${code}.`,
    "",
    `It signs you in to review ${site} and works for ${CODE_MINUTES} minutes.`,
    `${only} Critiqs never asks for it anywhere else.`,
    "",
    "If you didn't try to sign in, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;color:#1a1a1a">
<p>Your Critiqs sign-in code is</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
<p>It signs you in to review <strong>${escapeHtml(site)}</strong> and works for ${CODE_MINUTES} minutes.
${only} Critiqs never asks for it anywhere else.</p>
<p style="color:#666">If you didn't try to sign in, you can ignore this email.</p>
</body></html>`;
  return { to, subject: `${code} is your Critiqs sign-in code`, text, html, idempotencyKey: options.idempotencyKey };
}

/** Base64 in pieces whose length is a multiple of three, so a large capture doesn't overflow the call stack. */
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3 * 0x8000) text += btoa(String.fromCharCode(...bytes.subarray(i, i + 3 * 0x8000)));
  return text;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
