import { users } from "./data.ts";

// The pilot's view state, held by the App so Critiqs can record and restore it.

export type Screen = { name: "user-list" } | { name: "user-details"; userId: string };
export type Tab = "profile" | "permissions";
export type Dialog = "revoke" | null;

export interface PilotView {
  screen: Screen;
  /** Selected tab on user details. */
  tab: Tab;
  dialog: Dialog;
  /** Demo persona shown in the prototype. Context only, never the reviewer. */
  persona: string;
  /** Scroll position of the user list. Not context: it only decides which rows render. */
  listScrollTop: number;
}

/**
 * Simulated prototype builds. v2 renames the Department label, turns the revoke
 * button into a link, and drops the list's Department column, so threads can
 * meet changed and removed targets.
 */
export type PrototypeVersion = "v1" | "v2";

export const ROW_HEIGHT = 40;
export const VISIBLE_ROWS = 12;
const LIST_HEIGHT = ROW_HEIGHT * VISIBLE_ROWS;

/** Opens a user's details with the default tab and no dialog. */
export function detailsOf(view: PilotView, userId: string): PilotView {
  return { ...view, screen: { name: "user-details", userId }, tab: "profile", dialog: null };
}

/** Index of the user a record key such as `user:u1` names, or -1. */
export function userIndexOf(recordKey: string | null): number {
  if (recordKey === null || !recordKey.startsWith("user:")) return -1;
  const id = recordKey.slice("user:".length);
  return users.findIndex((user) => user.id === id);
}

/** Keeps the scroll position if the row is fully visible; otherwise centers the row. */
export function scrollTopRevealing(index: number, scrollTop: number): number {
  const top = index * ROW_HEIGHT;
  if (top >= scrollTop && top + ROW_HEIGHT <= scrollTop + LIST_HEIGHT) return scrollTop;
  const max = users.length * ROW_HEIGHT - LIST_HEIGHT;
  return Math.min(max, Math.max(0, top - (LIST_HEIGHT - ROW_HEIGHT) / 2));
}
