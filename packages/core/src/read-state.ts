/**
 * One reviewer's read state for one thread (F5). Personal: it never affects
 * other reviewers or the thread's shared status.
 */
export interface ReadState {
  /** Creation time of the newest message the reviewer has viewed. */
  lastReadAt: number;
  /** Set by Mark unread; cleared when the reviewer next opens the thread. */
  manualUnread: boolean;
}

/**
 * A thread is unread when it has a message newer than the reviewer last
 * viewed, or when the reviewer marked it unread. Edits, reactions, and status
 * changes do not change `lastMessageAt`, so they do not make a thread unread.
 */
export function isUnread(lastMessageAt: number, state: ReadState | null): boolean {
  if (state === null) return true;
  return state.manualUnread || lastMessageAt > state.lastReadAt;
}
