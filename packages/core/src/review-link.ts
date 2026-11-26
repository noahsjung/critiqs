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

/** Why the proxy couldn't show a page. */
export type ReviewFailure = "unreachable" | "blocked" | "needs-sign-in" | "too-large" | "timeout" | "unsafe" | "unsupported" | "busy" | "not-found";

/**
 * Something the prototype tried that review links don't support: a form, a
 * password field, or `load`: part of the page couldn't load through the
 * review link (a web socket, another site the frame's policy refuses, a file
 * the proxy refused or the browser couldn't read).
 */
export type ReviewUnsupported = "form" | "password" | "load";

export type ReviewFrameMessage =
  | { tag: typeof REVIEW_FRAME_TAG; v: 1; kind: "failed"; reason: ReviewFailure }
  /** The prototype went to another origin, shown here without path or query; `signIn` when it is an identity provider. */
  | { tag: typeof REVIEW_FRAME_TAG; v: 1; kind: "left"; url: string; signIn: boolean }
  | { tag: typeof REVIEW_FRAME_TAG; v: 1; kind: "unsupported"; feature: ReviewUnsupported };

const FAILURES: readonly ReviewFailure[] = ["unreachable", "blocked", "needs-sign-in", "too-large", "timeout", "unsafe", "unsupported", "busy", "not-found"];
const UNSUPPORTED: readonly ReviewUnsupported[] = ["form", "password", "load"];

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
