// Addresses Critiqs writes into ticket text, sends to a tracker, or shows as a
// link: checked first, since reviewers and trackers can send anything.

declare const web: unique symbol;
/** An `https:` or `http:` address without a username or password, as the browser writes it: made only by `webAddress`. */
export type WebAddress = string & { readonly [web]: true };

/** The longest address Critiqs keeps. */
export const MAX_WEB_ADDRESS_LENGTH = 2048;

/**
 * The address as a web address, or null when it isn't one: not `https:` or
 * `http:` (such as `javascript:` or `data:`), with a username or password,
 * unreadable, or longer than `MAX_WEB_ADDRESS_LENGTH`.
 */
export function webAddress(value: string): WebAddress | null {
  if (value.length > MAX_WEB_ADDRESS_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href.length > MAX_WEB_ADDRESS_LENGTH ? null : (url.href as WebAddress);
}
