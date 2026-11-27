import { expandTagFilter, groupThreads, type ProjectTags, type SidebarFilters, type SidebarThread, tagKey, type ThreadPlacement } from "@critiqs/core";
import { useMemo } from "react";
import { describeTargetState, type LiveThread, targetState } from "../model.ts";
import { Avatar, Menu, MenuItem, useMenu } from "./common.tsx";
import { TicketBadges } from "./Tickets.tsx";
import { relativeTime } from "./format.ts";
import { tagDisplay } from "./MentionInput.tsx";
import { FilterIcon } from "./icons.tsx";

const GROUP_TITLES: Record<ThreadPlacement, string> = {
  "current-view": "In this view",
  "other-view": "Other views on this screen",
  "other-screen": "Other screens",
};

export const NO_FILTERS: SidebarFilters = { status: "all", unreadOnly: false, tags: [], groups: [], screens: "all" };

/** Labels of the tags in a group, from the project's tags. */
export function groupMembers(tags: ProjectTags | null, groupId: string): string[] {
  return (tags?.tags ?? []).filter((tag) => tag.groupIds.includes(groupId)).map((tag) => tag.label);
}

export function ThreadList({
  threads,
  currentScreen,
  filters,
  defaultFilters,
  onFilters,
  selectedId,
  onSelect,
  selecting,
  checked,
  onCheck,
  onStartCommenting,
  commenting,
  tags,
  onTag,
}: {
  threads: LiveThread[];
  currentScreen: string;
  filters: SidebarFilters;
  defaultFilters: SidebarFilters;
  onFilters: (filters: SidebarFilters) => void;
  selectedId: string | null;
  onSelect: (threadId: string) => void;
  selecting: boolean;
  checked: Set<string>;
  onCheck: (threadId: string, checked: boolean) => void;
  onStartCommenting: () => void;
  /** Comment mode is already on. */
  commenting: boolean;
  /** The project's tags and groups, which group filters expand into. */
  tags: ProjectTags | null;
  /** Filters by one tag. */
  onTag: (tag: string) => void;
}) {
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.summary._id as string, thread])), [threads]);
  const sidebarThreads: SidebarThread[] = useMemo(
    () =>
      threads.map((thread) => ({
        id: thread.summary._id,
        status: thread.summary.status,
        screen: thread.location.screen,
        tags: thread.summary.tags,
        lastActivityAt: thread.summary.lastMessageAt,
        unread: thread.summary.unread,
      })),
    [threads],
  );
  const view = useMemo(
    () => ({ currentScreen, isLive: (id: string) => byId.get(id)?.located?.status === "found" }),
    [byId, currentScreen],
  );
  // A group filter shows threads with any of its tags, each thread once.
  const groups = groupThreads(sidebarThreads, view, expandTagFilter(filters, (groupId) => groupMembers(tags, groupId)));
  const shown = groups.reduce((count, group) => count + group.threads.length, 0);
  const hidden = threads.length - shown;

  return (
    <>
      <FilterSummary filters={filters} defaultFilters={defaultFilters} hidden={hidden} onFilters={onFilters} tags={tags} />
      {shown === 0 ? (
        <EmptyState
          total={threads.length}
          filters={filters}
          onClear={() => onFilters(NO_FILTERS)}
          onShowAll={() => onFilters({ ...filters, unreadOnly: false })}
          onStartCommenting={onStartCommenting}
          commenting={commenting}
        />
      ) : (
        groups.map((group) => (
          <section key={group.placement} aria-label={GROUP_TITLES[group.placement]}>
            <div className="group-title">{GROUP_TITLES[group.placement]}</div>
            {group.threads.map((entry) => (
              <Entry
                key={entry.id}
                thread={byId.get(entry.id)!}
                selected={entry.id === selectedId}
                selecting={selecting}
                checked={checked.has(entry.id)}
                onCheck={(value) => onCheck(entry.id, value)}
                onSelect={() => onSelect(entry.id)}
                onTag={onTag}
              />
            ))}
          </section>
        ))
      )}
    </>
  );
}

function Entry({
  thread,
  selected,
  selecting,
  checked,
  onCheck,
  onSelect,
  onTag,
}: {
  thread: LiveThread;
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onSelect: () => void;
  onTag: (tag: string) => void;
}) {
  const { summary } = thread;
  const author = summary.preview?.authorName ?? "Unknown";
  const replies = summary.messageCount - 1;
  const state = targetState(thread);
  const classes = ["entry", summary.unread && "unread", selected && "selected"].filter(Boolean).join(" ");
  const content = (
    <>
      <Avatar name={author} imageUrl={summary.preview?.authorImageUrl} />
      <span className="grow">
        <span className="meta">
          <span className="author">{author}</span>
          <span className="time" title={new Date(summary.lastMessageAt).toLocaleString()}>
            {relativeTime(summary.lastMessageAt)}
          </span>
        </span>
        <span className="excerpt">{summary.preview?.body ?? ""}</span>
        <span className="details">
          {replies > 0 && <span>{replies === 1 ? "1 reply" : `${replies} replies`}</span>}
          {summary.status === "resolved" && <span className="resolved-tag">Resolved</span>}
          {state !== "live" && <span className="status-tag">{describeTargetState(thread)}</span>}
          <TicketBadges tickets={summary.tickets} />
          {summary.tags.map((tag) => (
            // The entry itself is the button; the keyboard filters by tag from the filter menu.
            <span
              key={tag}
              className="tag-chip clickable"
              title={`Show threads tagged ${tag}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTag(tag);
              }}
            >
              {tagDisplay(tag)}
            </span>
          ))}
        </span>
      </span>
      {summary.unread && <span className="unread-dot" aria-label="Unread" />}
    </>
  );
  if (selecting) {
    return (
      <label className={classes}>
        <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} />
        {content}
      </label>
    );
  }
  return (
    <button type="button" className={classes} onClick={onSelect} aria-current={selected || undefined}>
      {content}
    </button>
  );
}

function FilterSummary({
  filters,
  defaultFilters,
  hidden,
  onFilters,
  tags,
}: {
  filters: SidebarFilters;
  defaultFilters: SidebarFilters;
  hidden: number;
  onFilters: (filters: SidebarFilters) => void;
  tags: ProjectTags | null;
}) {
  // A group shows which tags it includes, so the filter is never a mystery.
  const groupParts = (filters.groups ?? []).map((id) => {
    const name = tags?.groups.find((group) => group._id === id)?.name ?? "Group";
    const members = groupMembers(tags, id);
    return `${name} (${members.length === 0 ? "no tags yet" : members.join(", ")})`;
  });
  const parts = [
    { open: "Open", resolved: "Resolved", all: "Open and resolved" }[filters.status],
    filters.screens === "current" ? "this screen" : "all screens",
    filters.unreadOnly && "unread",
    filters.tags.length > 0 && filters.tags.join(", "),
    ...groupParts,
  ].filter(Boolean);
  const isDefault =
    filters.status === defaultFilters.status &&
    filters.screens === defaultFilters.screens &&
    filters.unreadOnly === defaultFilters.unreadOnly &&
    filters.tags.length === 0 &&
    (filters.groups ?? []).length === 0;
  return (
    <div className="filter-summary">
      <span>{parts.join(" · ")}</span>
      {hidden > 0 && <span>· {hidden} hidden by filters</span>}
      {!isDefault && (
        <button type="button" className="link-btn" onClick={() => onFilters(defaultFilters)}>
          Reset
        </button>
      )}
    </div>
  );
}

/** The sidebar's filter menu: status, unread, screens, and tags in separate groups. */
export function FilterButton({
  filters,
  tags,
  groups,
  onFilters,
}: {
  filters: SidebarFilters;
  /** Every tag to offer, presets and free tags. */
  tags: string[];
  groups: { _id: string; name: string; members: string[] }[];
  onFilters: (filters: SidebarFilters) => void;
}) {
  const menu = useMenu();
  const set = (patch: Partial<SidebarFilters>) => onFilters({ ...filters, ...patch });
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        title="Filter and sort"
        aria-label="Filter"
        aria-haspopup="menu"
        aria-pressed={menu.open}
        onClick={menu.toggle}
      >
        <FilterIcon />
      </button>
      {menu.open && (
        <Menu anchor={menu.anchor!} onClose={menu.close}>
          <div className="menu-label">Status</div>
          <MenuItem checked={filters.status === "open"} onSelect={() => set({ status: "open" })}>
            Open
          </MenuItem>
          <MenuItem checked={filters.status === "resolved"} onSelect={() => set({ status: "resolved" })}>
            Resolved
          </MenuItem>
          <MenuItem checked={filters.status === "all"} onSelect={() => set({ status: "all" })}>
            Open and resolved
          </MenuItem>
          <hr />
          <div className="menu-label">Show</div>
          <MenuItem checked={filters.unreadOnly} onSelect={() => set({ unreadOnly: !filters.unreadOnly })}>
            Unread only
          </MenuItem>
          <MenuItem checked={filters.screens === "current"} onSelect={() => set({ screens: "current" })}>
            This screen
          </MenuItem>
          <MenuItem checked={filters.screens === "all"} onSelect={() => set({ screens: "all" })}>
            All screens
          </MenuItem>
          {groups.length > 0 && (
            <>
              <hr />
              <div className="menu-label">Tag groups</div>
              {groups.map((group) => {
                const chosen = (filters.groups ?? []).includes(group._id);
                return (
                  <MenuItem
                    key={group._id}
                    checked={chosen}
                    onSelect={() =>
                      set({ groups: chosen ? (filters.groups ?? []).filter((id) => id !== group._id) : [...(filters.groups ?? []), group._id] })
                    }
                  >
                    <span className="grow">
                      {group.name}
                      <span className="note"> {group.members.length === 0 ? "no tags yet" : group.members.join(", ")}</span>
                    </span>
                  </MenuItem>
                );
              })}
            </>
          )}
          {tags.length > 0 && (
            <>
              <hr />
              <div className="menu-label">Tags</div>
              <div className="menu-scroll">
                {tags.map((tag) => {
                  const chosen = filters.tags.some((chosenTag) => tagKey(chosenTag) === tagKey(tag));
                  return (
                    <MenuItem
                      key={tag}
                      checked={chosen}
                      onSelect={() => set({ tags: chosen ? filters.tags.filter((t) => tagKey(t) !== tagKey(tag)) : [...filters.tags, tag] })}
                    >
                      {tag}
                    </MenuItem>
                  );
                })}
              </div>
            </>
          )}
          <hr />
          <div className="menu-label">Sort</div>
          <div className="note" style={{ padding: "2px 8px 6px" }}>
            Newest activity first in each group
          </div>
        </Menu>
      )}
    </>
  );
}

function EmptyState({
  total,
  filters,
  onClear,
  onShowAll,
  onStartCommenting,
  commenting,
}: {
  total: number;
  filters: SidebarFilters;
  onClear: () => void;
  onShowAll: () => void;
  onStartCommenting: () => void;
  commenting: boolean;
}) {
  if (total === 0) {
    return (
      <div className="empty">
        <strong>No comments yet</strong>
        {commenting ? (
          <span>Select an element in the prototype to leave feedback.</span>
        ) : (
          <>
            <span>Switch to Comment mode and select an element to leave feedback.</span>
            <button type="button" className="btn primary" onClick={onStartCommenting}>
              Start commenting
            </button>
          </>
        )}
      </div>
    );
  }
  if (filters.unreadOnly) {
    return (
      <div className="empty">
        <strong>No unread threads</strong>
        <span>You're all caught up.</span>
        <button type="button" className="btn" onClick={onShowAll}>
          Show read threads
        </button>
      </div>
    );
  }
  return (
    <div className="empty">
      <strong>No threads match these filters</strong>
      <span>{total === 1 ? "1 thread is" : `${total} threads are`} hidden.</span>
      <button type="button" className="btn" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}
