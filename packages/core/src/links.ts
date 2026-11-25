/**
 * Shareable links (F10). A link identifies a thread or reply; it never packs
 * app state or credentials. It reuses the app's own URL, keeping its routing
 * and parameters, and adds one Critiqs parameter.
 */
export const LINK_PARAMETER = "critiqs";

export interface LinkTarget {
  threadId: string;
  /** A reply or the first message; null links the thread as a whole. */
  messageId: string | null;
}

/**
 * Builds a link on the current prototype's origin for the page a thread was
 * left on. `pageUrl` is the thread's saved URL; its origin may be another copy
 * of the prototype (local, preview, or deployed), so only its path is kept.
 */
export function buildLink(currentOrigin: string, pageUrl: string, target: LinkTarget): string {
  const saved = new URL(pageUrl, currentOrigin);
  // Copy the parts separately: a path such as `//other.example/` must not change the origin.
  const url = new URL(currentOrigin);
  url.pathname = saved.pathname;
  url.search = saved.search;
  url.hash = saved.hash;
  const value = target.messageId === null ? target.threadId : `${target.threadId}.${target.messageId}`;
  url.searchParams.set(LINK_PARAMETER, value);
  return url.toString();
}

/**
 * A link for an email, which has no current prototype: the project's review
 * address exactly as saved, keeping its path, the app's own parameters, and its
 * hash route, with the Critiqs parameter added. The thread's saved page isn't
 * used, since it may be a copy reviewers can't open; once the message opens,
 * Critiqs restores the thread's screen and view from its saved context.
 */
export function reviewLink(reviewUrl: string, target: LinkTarget): string {
  const url = new URL(reviewUrl);
  const value = target.messageId === null ? target.threadId : `${target.threadId}.${target.messageId}`;
  if (url.searchParams.has(LINK_PARAMETER)) url.searchParams.set(LINK_PARAMETER, value);
  // Appended as text, so the app's own parameters keep their exact encoding.
  else url.search = `${url.search === "" ? "?" : `${url.search}&`}${LINK_PARAMETER}=${encodeURIComponent(value)}`;
  return url.toString();
}

/** Reads a Critiqs link from a URL, or null when it has none. */
export function parseLink(href: string): LinkTarget | null {
  const value = new URL(href).searchParams.get(LINK_PARAMETER);
  if (value === null || value === "") return null;
  const [threadId, messageId] = value.split(".");
  if (threadId === undefined || threadId === "") return null;
  return { threadId, messageId: messageId === undefined || messageId === "" ? null : messageId };
}

/** The same URL without the Critiqs parameter, leaving the app's own parameters intact. */
export function removeLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(LINK_PARAMETER);
  return url.toString();
}
