import { expect, test } from "bun:test";
import { DEFAULT_FILTERS, groupThreads, type SidebarThread } from "../src/sidebar.ts";

function thread(overrides: Partial<SidebarThread> & { id: string }): SidebarThread {
  return { status: "open", screen: "user-details", tags: [], lastActivityAt: 0, unread: false, ...overrides };
}

const threads = [
  thread({ id: "live-old", lastActivityAt: 1 }),
  thread({ id: "live-new", lastActivityAt: 3 }),
  thread({ id: "hidden-tab", lastActivityAt: 2 }),
  thread({ id: "resolved", status: "resolved" }),
  thread({ id: "deleted", status: "deleted" }),
  thread({ id: "elsewhere", screen: "settings", unread: true, tags: ["Bug"] }),
];
const view = { currentScreen: "user-details", isLive: (id: string) => id.startsWith("live") };

function ids(groups: ReturnType<typeof groupThreads>) {
  return groups.map((group) => [group.placement, group.threads.map((t) => t.id)]);
}

test("default shows open threads on all screens, grouped by view, newest first", () => {
  expect(ids(groupThreads(threads, view))).toEqual([
    ["current-view", ["live-new", "live-old"]],
    ["other-view", ["hidden-tab"]],
    ["other-screen", ["elsewhere"]],
  ]);
});

test("current-screen filter leaves out other screens", () => {
  const groups = groupThreads(threads, view, { ...DEFAULT_FILTERS, screens: "current" });
  expect(groups.map((group) => group.placement)).toEqual(["current-view", "other-view"]);
});

test("resolved filter reveals resolved threads; deleted threads never appear", () => {
  expect(ids(groupThreads(threads, view, { ...DEFAULT_FILTERS, status: "resolved" }))).toEqual([
    ["other-view", ["resolved"]],
  ]);
  const all = groupThreads(threads, view, { ...DEFAULT_FILTERS, status: "all", screens: "all" });
  expect(all.flatMap((group) => group.threads.map((t) => t.id))).not.toContain("deleted");
});

test("unread and tag filters combine", () => {
  const filters = { ...DEFAULT_FILTERS, screens: "all" as const, unreadOnly: true, tags: ["Bug"] };
  expect(ids(groupThreads(threads, view, filters))).toEqual([["other-screen", ["elsewhere"]]]);
});

test("Has ticket shows only threads linked to a ticket, with the other filters", () => {
  const linked = [
    thread({ id: "live-ticket", lastActivityAt: 5, hasTicket: true }),
    thread({ id: "live-plain", lastActivityAt: 4, hasTicket: false }),
    thread({ id: "old-backend", lastActivityAt: 3 }),
    thread({ id: "resolved-ticket", status: "resolved", hasTicket: true }),
  ];
  expect(ids(groupThreads(linked, view, { ...DEFAULT_FILTERS, hasTicket: true }))).toEqual([["current-view", ["live-ticket"]]]);
  expect(ids(groupThreads(linked, view, { ...DEFAULT_FILTERS, status: "all", hasTicket: true }))).toEqual([
    ["current-view", ["live-ticket"]],
    ["other-view", ["resolved-ticket"]],
  ]);
  // Off, every thread shows, with or without tickets.
  expect(ids(groupThreads(linked, view, { ...DEFAULT_FILTERS, hasTicket: false }))[0]![1]).toEqual(["live-ticket", "live-plain"]);
});
