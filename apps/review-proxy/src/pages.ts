import { REVIEW_FRAME_TAG, type ReviewFailure, type ReviewFrameMessage } from "@critiqs/core";

// The proxy's own small pages, shown in the frame instead of a prototype's:
// why a page can't be shown, that a link leads to another site, and that a
// frame host doesn't open on its own. Each states it in plain words and tells
// the review page around the frame with one message, so the frame is never
// blank. Status codes, addresses and upstream errors are never shown. The
// pages carry no proxied content and never redirect.

const WORDS: Record<ReviewFailure, { title: string; body: string }> = {
  unreachable: { title: "This page can't be reached", body: "Critiqs couldn't load this page from the prototype's address. It may be down, or only reachable on a private network." },
  blocked: { title: "This page blocked Critiqs", body: "The prototype's site turned Critiqs away, often with a bot check. Its owner can allow Critiqs, or you can review it with the Critiqs extension." },
  "needs-sign-in": { title: "This page needs a sign-in", body: "Review links show pages without signing in. Use the Critiqs extension to review it in your own browser, signed in." },
  "too-large": { title: "This page is too large", body: "This page is larger than a review link shows. Try the Critiqs extension, or share a smaller build." },
  timeout: { title: "This page took too long", body: "The prototype's site didn't answer in time. Try again in a moment." },
  unsafe: { title: "This page can't be shown", body: "This address is reported as unsafe, so review links don't show it." },
  unsupported: { title: "This page can't be shown here", body: "This page uses something review links don't support, such as a text encoding other than UTF-8. Try the Critiqs extension." },
  busy: { title: "Critiqs is busy", body: "Too many pages are loading through this review link at once. Try again in a moment." },
  "not-found": { title: "This review link isn't available", body: "It may have ended or been turned off. Ask for a new link." },
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A page that tells the review page `message`, addressed only to the website origins. */
function page(title: string, body: string, message: ReviewFrameMessage | null, panelOrigins: readonly string[]): string {
  // The message and origins are JSON from fixed values the proxy chose; `<` is escaped so no text can close the script.
  const post =
    message === null
      ? ""
      : `<script>(function(){var m=${JSON.stringify(message).replace(/</g, "\\u003c")};var o=${JSON.stringify(panelOrigins).replace(/</g, "\\u003c")};if(window.parent!==window)for(var i=0;i<o.length;i++)window.parent.postMessage(m,o[i]);})();</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;color:#18181b;background:#fafafa}main{max-width:420px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#52525b}@media (prefers-color-scheme:dark){body{color:#f4f4f5;background:#18181b}p{color:#a1a1aa}}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(body)}</p></main>${post}</body></html>`;
}

export function failurePage(reason: ReviewFailure, panelOrigins: readonly string[]): string {
  const words = WORDS[reason];
  return page(words.title, words.body, { tag: REVIEW_FRAME_TAG, v: 1, kind: "failed", reason }, panelOrigins);
}

/** A link or redirect to another site: names its host, offers no link to it. */
export function leavePage(origin: string, signIn: boolean, panelOrigins: readonly string[]): string {
  const host = new URL(origin).host;
  return signIn
    ? page("This prototype signs in elsewhere", `It sends you to ${host} to sign in, which doesn't work in a review link. Use the Critiqs extension to review it signed in.`, { tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: origin, signIn: true }, panelOrigins)
    : page("This link opens another site", `This prototype linked to ${host}, which opens outside Critiqs.`, { tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: origin, signIn: false }, panelOrigins);
}

/** A frame host opened on its own, outside a review page: nothing of the prototype. */
export function topLevelPage(): string {
  return page("Open this from its review link", "This address only works inside a Critiqs review page.", null, []);
}

/** The Content-Security-Policy for documents on a frame host. */
export function frameCsp(webOrigins: readonly string[]): string {
  return [
    `frame-ancestors ${webOrigins.join(" ")}`,
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "worker-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** For anything else a frame host serves: inert if a browser ever opens it as a page. */
export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox";
