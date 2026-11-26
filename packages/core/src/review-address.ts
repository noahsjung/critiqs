/**
 * A project's review address (F13): the page mention emails open, set by the
 * project's owner. Every copy of the prototype (local, preview, deployed)
 * shares one project, so emails link to this one page rather than to the copy
 * a comment was left on.
 */
import { LINK_PARAMETER } from "./links.ts";
import { isPrivateHost } from "./local-host.ts";

/** Longest review address a project can save. */
export const MAX_REVIEW_URL_LENGTH = 2000;

/**
 * The address as it is saved, or null if mention emails can't link to it:
 * HTTPS, or plain HTTP on this computer, without a username or password.
 * The page's path, parameters, and hash route are kept; a Critiqs link
 * parameter copied with it is removed.
 */
export function validReviewUrl(value: string): string | null {
  if (value.length > MAX_REVIEW_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.searchParams.has(LINK_PARAMETER)) url.searchParams.delete(LINK_PARAMETER);
    const saved = url.toString();
    return saved.length > MAX_REVIEW_URL_LENGTH ? null : saved;
  } catch {
    return null;
  }
}

/**
 * Whether an address names this computer or a private network, such as
 * `http://localhost:5173`, `http://192.168.1.4:3000`, or a Tailscale address
 * (`*.ts.net`, `100.64.0.0/10`), so only people on that computer or network can
 * open it: `isPrivateHost`, which onboarding shares. Private review addresses
 * are allowed; this only informs. An address that isn't recognized as private
 * isn't thereby known to be public.
 */
export function isPrivateReviewAddress(address: string): boolean {
  try {
    return isPrivateHost(new URL(address).hostname);
  } catch {
    return false;
  }
}
