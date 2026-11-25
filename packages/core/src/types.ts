// Shared Critiqs domain types. Names follow docs/glossary.md.

/** Thread statuses (F4). Resolved also serves as archive. */
export type ThreadStatus = "open" | "resolved" | "deleted";

/** Shared across compatible records, or specific to one record (F7). */
export type Scope = "shared" | "record";

/** Prototype build a message refers to. `null` means unknown. */
export type Revision = string | null;

/** Settings that affect visible content, recorded by the host app. */
export type ViewState = Record<string, string | number | boolean | null>;

export interface Target {
  /** Stable purpose ID from `data-critiqs-id`, such as `user-details.department`. */
  purposeId: string | null;
  /** Record key from the nearest `data-critiqs-record`, when the target belongs to one. */
  recordKey: string | null;
  /** Backup clues used to confirm a match; never used to guess a nearby element. */
  clues: TargetClues;
}

export interface TargetClues {
  tagName: string;
  role: string | null;
  label: string | null;
  /** Structural path of tag names and sibling positions from the anchor root. */
  path: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The information stored to locate a target in the right context. */
export interface Anchor {
  /** Logical page, such as `user-details`. */
  screen: string;
  viewState: ViewState;
  target: Target;
  scope: Scope;
  evidence: Evidence;
}

/** Original evidence saved with the first message (F6). */
export interface Evidence {
  url: string;
  viewport: { width: number; height: number };
  /** Marked location in page coordinates at capture time. */
  marker: Rect | null;
  capturedAt: number;
  revision: Revision;
  /** Browser that left the feedback, shown with the context. */
  userAgent: string | null;
  /** Demo persona shown in the prototype. Context only, never the author. */
  persona: string | null;
}

/** Where a thread's target is now: the original anchor, or its reattachment (F8). */
export type TargetLocation = Pick<Anchor, "screen" | "viewState" | "target" | "scope">;

/** Where a thread sits relative to the reviewer's current view (sidebar groups). */
export type ThreadPlacement = "current-view" | "other-view" | "other-screen";

/** Result of trying to locate a target in the live page. */
export type LocateResult =
  | { status: "found"; elements: Element[] }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: number }
  | { status: "wrong-record" };

/** Reactions offered on messages. The server accepts only these. */
export const REACTIONS = ["👍", "❤️", "🎉", "👀", "✅", "😄"] as const;
