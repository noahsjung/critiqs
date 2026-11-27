import { isRecord } from "./page-layer/check.ts";

// What a review link's frame tells the review page around it, apart from the
// page layer's own protocol: that the prototype couldn't be shown, that it
// went to another site, or that it tried something review links don't do.
// The frame is untrusted (the prototype's scripts run there), so these
// messages only choose what the review page says; they never change where
// the frame points or grant anything.

export const REVIEW_FRAME_TAG = "critiqs:review-frame";

/**
 * Set on a review frame's window by the proxy's runtime, before any of the
 * prototype's own scripts run. A copy of Critiqs the prototype installed
 * (`mountCritiqs`) sees it and stays out: in a review frame the proxy's page
 * layer is the one that runs, and an installed copy could only fail to reach
 * its backend. A global symbol, so separately built copies agree on it.
 */
export const REVIEW_FRAME_MARK: unique symbol = Symbol.for("critiqs.review-frame");

/** Whether this window is a review link's frame (`REVIEW_FRAME_MARK`). */
export function inReviewFrame(scope: object = globalThis): boolean {
  return (scope as Record<symbol, unknown>)[REVIEW_FRAME_MARK] === true;
}

/**
 * The Server-Timing entry the proxy puts on a file it refused (too busy,
 * unsafe, the wrong type, unreachable), so the frame's runtime can tell it
 * from the prototype's own errors.
 */
export const REVIEW_REFUSED_TIMING = "critiqs-refused";

/**
 * The prototype path a review link's address names after `#`, such as
 * `/r/<key>#/products/42`: a path on the prototype's own origin, without a
 * query, kept out of the address the server sees. Null for anything else.
 */
export function reviewPathOf(hash: string): string | null {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/__critiqs/")) return null;
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path)) return null;
  return path;
}

/**
 * The path a review link's address shows for a path on the prototype (the
 * review page's bar and Share, a thread page's link): a path starting with
 * `//` gets `/.` in front, as the proxy writes it, so it never reads as
 * another site's address; null for the proxy's own paths and anything else
 * a review address can't hold (`reviewPathOf`).
 */
export function shownPathOf(pathname: string): string | null {
  return reviewPathOf(pathname.startsWith("//") ? `/.${pathname}` : pathname);
}

/**
 * Put beside `REVIEW_REFUSED_TIMING` when a file was refused only because
 * the viewer's request budget ran out for now: waiting and reloading loads
 * it, so the review page says that instead of pointing elsewhere.
 */
export const REVIEW_LIMITED_TIMING = "critiqs-limit";

/**
 * The Server-Timing entry on a file the proxy passes through with a success
 * status: if the browser then can't use it, the body was cut on the way (a
 * file over the size cap, a site that stopped sending), not an error of the
 * prototype's own.
 */
export const REVIEW_FILE_TIMING = "critiqs-file";

/**
 * Why the proxy couldn't show a page. `busy`: the page waited its turn
 * behind other reads of its site or link and got none in time; `limited`:
 * this viewer's request budget is used up for now and refills as time
 * passes; `offline`: Critiqs couldn't reach its own backend to check the
 * link.
 */
export type ReviewFailure = "unreachable" | "blocked" | "needs-sign-in" | "too-large" | "timeout" | "unsafe" | "unsupported" | "busy" | "limited" | "offline" | "not-found";

/**
 * Something the prototype tried that review links don't support: a form, a
 * password field, or `load`: part of the page couldn't load through the
 * review link (a web socket, another site the frame's policy refuses, a file
 * the proxy refused or the browser couldn't read). `limit`: files were held
 * back only because the viewer's request budget ran out for now.
 */
export type ReviewUnsupported = "form" | "password" | "load" | "limit";

export type ReviewFrameMessage =
  | { tag: typeof REVIEW_FRAME_TAG; v: 1; kind: "failed"; reason: ReviewFailure }
  /** The prototype went to another origin, shown here without path or query; `signIn` when it is an identity provider. */
  | { tag: typeof REVIEW_FRAME_TAG; v: 1; kind: "left"; url: string; signIn: boolean }
  | { tag: typeof REVIEW_FRAME_TAG; v: 1; kind: "unsupported"; feature: ReviewUnsupported };

const FAILURES: readonly ReviewFailure[] = ["unreachable", "blocked", "needs-sign-in", "too-large", "timeout", "unsafe", "unsupported", "busy", "limited", "offline", "not-found"];
const UNSUPPORTED: readonly ReviewUnsupported[] = ["form", "password", "load", "limit"];

/** An `http:` or `https:` origin, at most 512 characters, or null. */
function webOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** A frame message, checked field by field, or null for anything else (another program's message included). */
export function parseReviewFrameMessage(raw: unknown): ReviewFrameMessage | null {
  if (!isRecord(raw) || raw.tag !== REVIEW_FRAME_TAG || raw.v !== 1) return null;
  const keys = Object.keys(raw).sort().join(",");
  switch (raw.kind) {
    case "failed":
      return keys === "kind,reason,tag,v" && FAILURES.includes(raw.reason as ReviewFailure) ? { tag: REVIEW_FRAME_TAG, v: 1, kind: "failed", reason: raw.reason as ReviewFailure } : null;
    case "left": {
      const url = webOrigin(raw.url);
      return keys === "kind,signIn,tag,url,v" && url !== null && typeof raw.signIn === "boolean" ? { tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url, signIn: raw.signIn } : null;
    }
    case "unsupported":
      return keys === "feature,kind,tag,v" && UNSUPPORTED.includes(raw.feature as ReviewUnsupported) ? { tag: REVIEW_FRAME_TAG, v: 1, kind: "unsupported", feature: raw.feature as ReviewUnsupported } : null;
    default:
      return null;
  }
}
