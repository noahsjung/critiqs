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

// ---------------------------------------------------------------------------
// Thread pages

/**
 * The path segment of a thread page on Critiqs's website: `/t/<key>`. The
 * link carries the thread's page key, never its ID. A thread ID is enough
 * for components from 0.3.x and earlier to read the thread and its project
 * in a project anyone may review, and a thread page's link can be forwarded
 * to anyone; the page key opens only the thread page, which checks who may
 * read it.
 */
export const THREAD_PAGE_PATH = "t";

const PAGE_KEY = /^[A-Za-z0-9_-]{22}$/;

/** Whether `value` has the form of a thread page key: 22 base64url characters (128 random bits). */
export function isThreadPageKey(value: string): boolean {
  return PAGE_KEY.test(value);
}

/** The website's origin and its base path without a trailing slash, from its configured address. */
function websiteBase(websiteUrl: string): { origin: string; path: string } {
  const url = new URL(websiteUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("A website address starts with https:// or http://.");
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
}

/**
 * A thread page's link on the website at `websiteUrl` (such as
 * `https://critiqs.app`, or an address with a base path), for **Share**,
 * emails, and the extension: `<website>/t/<key>`. The link names no
 * deployment, so `websiteUrl` must be a site that reaches the backend holding
 * the thread: Critiqs's website for Critiqs Cloud, or a self-hosted server's
 * own address, since its API answers only its own site.
 */
export function threadPageLink(websiteUrl: string, key: string): string {
  if (!isThreadPageKey(key)) throw new Error("Not a thread page key.");
  const { origin, path } = websiteBase(websiteUrl);
  return `${origin}${path}/${THREAD_PAGE_PATH}/${key}`;
}

/** The page key a thread page link on the website at `websiteUrl` names, or null when `href` isn't one. */
export function parseThreadPageLink(href: string, websiteUrl: string): string | null {
  const base = websiteBase(websiteUrl);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  const prefix = `${base.path}/${THREAD_PAGE_PATH}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const key = url.pathname.slice(prefix.length).replace(/\/$/, "");
  return isThreadPageKey(key) ? key : null;
}
