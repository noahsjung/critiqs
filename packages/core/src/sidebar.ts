import { tagKey } from "./tags.ts";
import type { ThreadPlacement, ThreadStatus } from "./types.ts";

export interface SidebarThread {
  id: string;
  status: ThreadStatus;
  screen: string;
  tags: string[];
  /** Newest message time. Reading does not change it. */
  lastActivityAt: number;
  unread: boolean;
  /** Whether the thread links to a ticket; absent where the backend has no tickets. */
  hasTicket?: boolean;
}

export interface SidebarFilters {
  status: "open" | "resolved" | "all";
  unreadOnly: boolean;
  /** Threads with any of these tags, matched by tag key. Empty means no tag filter. */
  tags: string[];
  /** Tag groups chosen in the filter; `expandTagFilter` turns them into their tags. */
  groups?: string[];
  screens: "current" | "all";
  /** Only threads linked to a ticket (**Has ticket**). */
  hasTicket?: boolean;
}

export interface SidebarGroup {
  placement: ThreadPlacement;
  threads: SidebarThread[];
}

/** Default: open threads across all screens, including read and unread ones. */
export const DEFAULT_FILTERS: SidebarFilters = {
  status: "open",
  unreadOnly: false,
  tags: [],
  screens: "all",
};

const GROUP_ORDER: ThreadPlacement[] = ["current-view", "other-view", "other-screen"];

/**
 * Groups visible threads by where they sit relative to the reviewer's current
 * view, newest activity first. Groups follow the app's view; they are not
 * statuses. `isLive` reports whether a thread's target is located in the active view.
 * Deleted threads never appear.
 */
export function groupThreads(
  threads: SidebarThread[],
  view: { currentScreen: string; isLive: (threadId: string) => boolean },
  filters: SidebarFilters = DEFAULT_FILTERS,
): SidebarGroup[] {
  const groups = new Map<ThreadPlacement, SidebarThread[]>();
  for (const thread of threads) {
    if (!matchesFilters(thread, filters, view.currentScreen)) continue;
    const placement = placementOf(thread, view);
    groups.set(placement, [...(groups.get(placement) ?? []), thread]);
  }
  return GROUP_ORDER.flatMap((placement) => {
    const grouped = groups.get(placement);
    if (grouped === undefined) return [];
    return [{ placement, threads: grouped.sort((a, b) => b.lastActivityAt - a.lastActivityAt) }];
  });
}

function placementOf(
  thread: SidebarThread,
  view: { currentScreen: string; isLive: (threadId: string) => boolean },
): ThreadPlacement {
  if (thread.screen !== view.currentScreen) return "other-screen";
  return view.isLive(thread.id) ? "current-view" : "other-view";
}

function matchesFilters(thread: SidebarThread, filters: SidebarFilters, currentScreen: string): boolean {
  if (thread.status === "deleted") return false;
  if (filters.status !== "all" && thread.status !== filters.status) return false;
  if (filters.unreadOnly && !thread.unread) return false;
  if (filters.hasTicket === true && thread.hasTicket !== true) return false;
  if (filters.tags.length > 0) {
    const wanted = new Set(filters.tags.map(tagKey));
    if (!thread.tags.some((tag) => wanted.has(tagKey(tag)))) return false;
  }
  if (filters.screens === "current" && thread.screen !== currentScreen) return false;
  return true;
}

/**
 * The filters with each chosen group replaced by its member tags, so a thread
 * with several of them still appears once. `members` lists each group's tag labels.
 */
export function expandTagFilter(filters: SidebarFilters, members: (groupId: string) => string[]): SidebarFilters {
  const groups = filters.groups ?? [];
  if (groups.length === 0) return filters;
  const tags = new Map(filters.tags.map((tag) => [tagKey(tag), tag]));
  for (const group of groups) for (const tag of members(group)) if (!tags.has(tagKey(tag))) tags.set(tagKey(tag), tag);
  // A chosen group with no tags yet matches nothing, rather than everything.
  const expanded = [...tags.values()];
  return { ...filters, tags: expanded.length === 0 ? ["\u0000no-tags"] : expanded, groups: [] };
}
