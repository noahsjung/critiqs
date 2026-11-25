import { MOCKUP_LIMITS, type MockupSnapshotInfo, type MockupSource, type MockupSummary } from "@critiqs/core";
import { Component, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { TurnStatus } from "../../mockup/ai-turn.ts";
import { groupThreads, type PendingVisit, type ThreadGroup, type ThreadRow } from "../../mockup/state.ts";
import type { LiveThread } from "../../model.ts";
import type { MockupTransport, PagedList } from "../../transport.ts";
import { Avatar, Dialog } from "../common.tsx";
import { describeViewState, fullTime, relativeTime } from "../format.ts";
import { BackIcon, CloseIcon, CommentIcon, TicketIcon } from "../icons.tsx";
import { SidebarResizer, useSidebarWidth } from "../sidebar-width.tsx";
import { ticketText } from "../Tickets.tsx";
import { AI_NAME } from "./MockupThread.tsx";

/** The Mockup panel's frame: in the right-hand place the comments sidebar takes. */
export function PanelFrame({
  hidden = false,
  header,
  tools,
  footer,
  children,
}: {
  hidden?: boolean;
  header: ReactNode;
  tools?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const width = useSidebarWidth();
  return (
    <aside className="sidebar mockup-panel" aria-label="Mockup" hidden={hidden} style={{ width }}>
      <SidebarResizer />
      <div className="sidebar-header">{header}</div>
      {tools}
      <div className="sidebar-body">{children}</div>
      {footer !== undefined && footer !== null && <div className="sidebar-footer">{footer}</div>}
    </aside>
  );
}

/** Closes the panel; Mockup mode stays on, as the other modes' panels close without leaving their mode. */
export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="icon-btn" aria-label="Close sidebar" title="Close (Esc)" onClick={onClose}>
      <CloseIcon />
    </button>
  );
}

export function BackToThreads({ onBack, disabled }: { onBack: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="icon-btn" aria-label="All mockup threads" title="All mockup threads" onClick={onBack} disabled={disabled}>
      <BackIcon />
    </button>
  );
}

/** Where a mockup was made: its screen, and the view state the app reported, if any. */
export function pageLabel(source: Pick<MockupSource, "screen" | "viewState">): string {
  const view = describeViewState(source.viewState);
  return view === "" ? source.screen : `${source.screen} · ${view}`;
}

/** Mockups that this page's part of the list, and the other pages' part, show at first and add with each Show more. */
const LIST_PAGE = 20;

type GroupProps = {
  mockups: MockupTransport;
  projectId: string;
  screen: string;
  turns: Record<string, TurnStatus>;
  onOpen: (row: ThreadRow) => void;
};

/**
 * Every page's mockup threads: this page's first, then each other page's,
 * labeled with the page. Each part is read a page at a time with its own Show
 * more, and has its own `ListBoundary`, so one part failing to load leaves the
 * other in place.
 */
export function ThreadList(props: GroupProps) {
  return (
    <>
      <ListBoundary key={`here ${props.projectId} ${props.screen}`} label="this page's mockup threads">
        <ThisPage {...props} />
      </ListBoundary>
      <ListBoundary key={`elsewhere ${props.projectId} ${props.screen}`} label="other pages' mockup threads">
        <OtherPages {...props} />
      </ListBoundary>
    </>
  );
}

function ThisPage({ mockups, projectId, screen, turns, onOpen }: GroupProps) {
  const here = mockups.useMockupPage(projectId, { screen }, LIST_PAGE);
  const rows = groupThreads(here.results, screen).find((group) => group.here)?.rows ?? [];
  return (
    <section aria-label="This page">
      <div className="group-title">This page</div>
      {here.status === "LoadingFirstPage" ? (
        <div className="note pad">Loading mockup threads…</div>
      ) : rows.length > 0 ? (
        rows.map((row) => <ThreadEntry key={row.thread._id} row={row} turn={turns[row.thread._id]} onOpen={() => onOpen(row)} />)
      ) : (
        here.status === "Exhausted" && <div className="note pad">No mockup threads on this page yet. Ask for a change below, or select an element on the page.</div>
      )}
      <ShowMore list={here} where="on this page" />
    </section>
  );
}

function OtherPages({ mockups, projectId, screen, turns, onOpen }: GroupProps) {
  const elsewhere = mockups.useMockupPage(projectId, { otherThan: screen }, LIST_PAGE);
  if (elsewhere.status === "LoadingFirstPage") return null;
  const groups = groupThreads(elsewhere.results, screen).filter((group) => !group.here);
  return (
    <>
      {groups.map((group) => (
        <section key={group.screen} aria-label={`Page ${group.screen}`}>
          <div className="group-title">{group.screen}</div>
          {group.rows.map((row) => (
            <ThreadEntry key={row.thread._id} row={row} turn={turns[row.thread._id]} onOpen={() => onOpen(row)} />
          ))}
        </section>
      ))}
      <ShowMore list={elsewhere} where="from other pages" />
    </>
  );
}

/**
 * The end of a paged part of the list: Show more while more may follow, and
 * Loading… while they load. A page filled exactly to the end can't tell, so
 * one last Show more may add nothing; then it goes away.
 */
function ShowMore({ list, where }: { list: PagedList<unknown>; where: string }) {
  if (list.status !== "CanLoadMore" && list.status !== "LoadingMore") return null;
  const loading = list.status === "LoadingMore";
  return (
    <div className="list-more">
      <button type="button" className="btn small ghost" aria-label={`Show more ${where}`} disabled={loading} onClick={() => list.loadMore(LIST_PAGE)}>
        {loading ? "Loading…" : "Show more"}
      </button>
    </div>
  );
}

/** A part of the thread list, or, when one of its pages can't load, a note with Try again, which reads that part afresh. */
export class ListBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty">
        <span>
          Couldn't load {this.props.label} ·{" "}
          <button type="button" className="link-btn" onClick={() => this.setState({ failed: false })}>
            Try again
          </button>
        </span>
      </div>
    );
  }
}

function ThreadEntry({ row, turn, onOpen }: { row: ThreadRow; turn: TurnStatus | undefined; onOpen: () => void }) {
  const { mockup, thread } = row;
  const author = thread.preview?.authorName ?? "Unknown";
  const replies = thread.messageCount - 1;
  return (
    <button type="button" className={`entry mockup-entry${thread.unread ? " unread" : ""}`} onClick={onOpen}>
      <Avatar name={author} imageUrl={thread.preview?.authorImageUrl} />
      <span className="grow">
        <span className="meta">
          <span className="author">{author}</span>
          <span className="time" title={fullTime(thread.lastMessageAt)}>
            {relativeTime(thread.lastMessageAt)}
          </span>
        </span>
        <span className="excerpt">{thread.preview?.body ?? mockup.title}</span>
        <span className="details">
          <span className="page-label">{pageLabel(mockup.source)}</span>
          <span>{mockup.versionCount === 0 ? "No changes yet" : `v${mockup.versionCount}`}</span>
          {replies > 0 && <span>{replies === 1 ? "1 reply" : `${replies} replies`}</span>}
          {thread.status === "resolved" && <span className="resolved-tag">Resolved</span>}
          {turn !== undefined && turn.status !== "failed" && <span className="ai-tag">{AI_NAME} is working…</span>}
          {turn?.status === "failed" && <span className="status-tag">{AI_NAME} couldn't answer</span>}
        </span>
      </span>
      {thread.unread && <span className="unread-dot" aria-label="Unread" />}
    </button>
  );
}

/** Asks before opening a thread made on another page, since the prototype goes there. */
export function VisitDialog({ visit, onGo, onCancel }: { visit: PendingVisit; onGo: () => void; onCancel: () => void }) {
  const going = visit.status === "going";
  return (
    <Dialog label={`Go to ${visit.screen}?`} onClose={onCancel}>
      <h3>Go to {visit.screen}?</h3>
      <p>This mockup thread is on {pageLabel(visit)}. The prototype opens that page, so you can compare the mockup with it.</p>
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={going} onClick={onGo}>
          {going ? `Opening ${visit.screen}…` : `Go to ${visit.screen}`}
        </button>
      </div>
    </Dialog>
  );
}

/** A model Critiqs AI may answer with, as the reviewer's connection offers it. */
export interface ModelOption {
  id: string;
  label: string;
  credits?: number;
  estimated?: true;
}

/** Which of the connection's models Critiqs AI answers with, by name, shown only when it offers more than one. */
export function ModelChoice({ models, value, onChange }: { models: readonly ModelOption[]; value: string; onChange: (model: string) => void }) {
  const chosen = models.find((model) => model.id === value);
  const cost = chosen?.credits === undefined ? "" : `: ${chosen.estimated ? "about " : ""}${chosen.credits === 1 ? "1 credit" : `${chosen.credits} credits`} per request`;
  return (
    <select className="model-choice" aria-label="Model" title={`The model Critiqs AI answers with${cost}`} value={value} onChange={(event) => onChange(event.target.value)}>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </select>
  );
}

/** Starts a mockup thread on the whole page: a new mockup, named after the message. */
export function AskComposer({
  draft,
  onDraft,
  sending,
  disabled,
  onSend,
  addComment,
  comments,
  hasComments = false,
  modelChoice,
}: {
  draft: string;
  onDraft: (text: string) => void;
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
  addComment: ReactNode;
  /** The comments added so far, shown beside the add button above the field. */
  comments?: ReactNode;
  /** Comments are added, so sending needs no text: Critiqs AI acts on them. */
  hasComments?: boolean;
  /** The model select, when the connection offers more than one. */
  modelChoice?: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ((draft.trim() !== "" || hasComments) && !sending && !disabled) onSend();
  };
  return (
    <form className="ask-composer" onSubmit={submit} aria-label="Start a mockup thread">
      <div className="composer-context" role="group" aria-label="Comments">
        {addComment}
        {comments}
      </div>
      <textarea
        className="field"
        aria-label="Ask for a change"
        placeholder="Ask Critiqs AI for a change to this page…"
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
        }}
      />
      <div className="row end">
        {modelChoice}
        <button type="submit" className="btn primary" disabled={(draft.trim() === "" && !hasComments) || sending || disabled}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

/** Answers the open thread: Critiqs AI changes the thread's copies again. */
export function ReplyBox({
  value,
  onChange,
  sending,
  disabled,
  onSend,
  addComment,
  comments,
  hasComments = false,
  modelChoice,
}: {
  value: string;
  onChange: (text: string) => void;
  sending: boolean;
  /** While Critiqs AI is still answering the previous request. */
  disabled: boolean;
  onSend: () => void;
  addComment: ReactNode;
  /** The thread's comments, shown beside the add button above the field. */
  comments?: ReactNode;
  /** Comments are added, so sending needs no text: Critiqs AI acts on them. */
  hasComments?: boolean;
  /** The model select, when the connection offers more than one. */
  modelChoice?: ReactNode;
}) {
  const send = () => {
    if ((value.trim() !== "" || hasComments) && !sending && !disabled) onSend();
  };
  return (
    <form
      className="ask-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="composer-context" role="group" aria-label="Comments">
        {addComment}
        {comments}
      </div>
      <textarea
        className="field"
        aria-label="Reply"
        placeholder="Reply, or ask for another change…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
        }}
      />
      <div className="row end">
        {modelChoice}
        <button type="submit" className="btn primary" disabled={(value.trim() === "" && !hasComments) || sending || disabled}>
          {sending ? "Sending…" : "Reply"}
        </button>
      </div>
    </form>
  );
}

/** Most comments the picker shows at once; searching finds the rest. */
const PICKER_LIMIT = 50;

/**
 * "+ Add existing comment": picks one of the project's comments for Critiqs AI to
 * read with the mockup, the given page's first, searchable by its text.
 */
export function AddComment({
  comments,
  screen,
  added,
  onAdd,
}: {
  comments: readonly LiveThread[];
  screen: string;
  added: ReadonlySet<string>;
  onAdd: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    setSearch("");
    trigger.current?.focus();
  };
  // The backend refuses links past this, so the picker stops there.
  const full = added.size >= MOCKUP_LIMITS.linkedThreads;
  const options = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const text = (thread: LiveThread) =>
      `${thread.summary.preview?.body ?? ""} ${thread.summary.preview?.authorName ?? ""} ${thread.location.screen}`.toLowerCase();
    return comments
      .filter((thread) => !added.has(thread.summary._id) && words.every((word) => text(thread).includes(word)))
      .sort((a, b) => Number(b.location.screen === screen) - Number(a.location.screen === screen) || b.summary.lastMessageAt - a.summary.lastMessageAt);
  }, [comments, added, search, screen]);
  return (
    <>
      <button ref={trigger} type="button" className="chip add-comment" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        + Add existing comment
      </button>
      {open && (
        <div
          className="comment-picker"
          role="dialog"
          aria-label="Add a comment"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="row">
            <input
              ref={field}
              type="search"
              className="field"
              aria-label="Search comments"
              placeholder="Search comments…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
              <CloseIcon />
            </button>
          </div>
          <div className="comment-options">
            {full && <div className="note pad">A mockup links up to {MOCKUP_LIMITS.linkedThreads} comments. Remove one to add another.</div>}
            {!full && options.length === 0 && <div className="note pad">{search.trim() === "" ? "No comments to add." : "No comments match."}</div>}
            {(full ? [] : options.slice(0, PICKER_LIMIT)).map((thread) => {
              const { summary, location } = thread;
              const author = summary.preview?.authorName ?? "Unknown";
              return (
                <button
                  key={summary._id}
                  type="button"
                  className="entry"
                  onClick={() => {
                    onAdd(summary._id);
                    close();
                  }}
                >
                  <Avatar name={author} imageUrl={summary.preview?.authorImageUrl} />
                  <span className="grow">
                    <span className="meta">
                      <span className="author">{author}</span>
                      <span className="time">{relativeTime(summary.lastMessageAt)}</span>
                    </span>
                    <span className="excerpt">{summary.preview?.body ?? ""}</span>
                    <span className="details">
                      {location.screen !== screen && <span>On {location.screen}</span>}
                      {summary.status === "resolved" && <span className="resolved-tag">Resolved</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/** The comments added for Critiqs AI to read, as short chips in the composer, each removable. */
export function CommentChips({
  ids,
  comments,
  onRemove,
}: {
  ids: readonly string[];
  comments: readonly LiveThread[];
  onRemove: (threadId: string) => void;
}) {
  if (ids.length === 0) return null;
  // Chips flow in the composer's row of comments, beside "+ Add existing comment".
  return (
    <>
      {ids.map((id) => {
        const summary = comments.find((thread) => thread.summary._id === id)?.summary;
        const text = summary?.preview?.body ?? "Comment";
        // The comment's linked tickets, from the summary the page already has.
        const tickets = (summary?.tickets ?? []).map(ticketText).join(", ");
        return (
          <span key={id} className="chip comment-chip" title={tickets === "" ? text : `${text}\n${tickets}`}>
            <CommentIcon />
            <span className="chip-text">{text}</span>
            {tickets !== "" && (
              <span className="chip-tickets">
                <TicketIcon size={12} />
                {tickets}
              </span>
            )}
            <button type="button" className="chip-remove" aria-label={`Remove comment: ${text}`} onClick={() => onRemove(id)}>
              ×
            </button>
          </span>
        );
      })}
    </>
  );
}

/** Shows the live page instead of the copy while held, as holding O does. */
export function HoldToCompare({ onHold, disabled }: { onHold: (held: boolean) => void; disabled: boolean }) {
  return (
    <button
      type="button"
      className="btn small hold"
      disabled={disabled}
      title={disabled ? "The live page is another page, so it can't be compared here" : "Hold to show the live page (or hold O)"}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onHold(true);
      }}
      onPointerUp={() => onHold(false)}
      onPointerCancel={() => onHold(false)}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) onHold(true);
      }}
      onKeyUp={() => onHold(false)}
      onBlur={() => onHold(false)}
    >
      Hold to compare
    </button>
  );
}

/** The thread's copies by width; shown only when it has more than one. */
export function CopyTabs({
  snapshots,
  snapshotId,
  onCopy,
}: {
  snapshots: MockupSnapshotInfo[];
  snapshotId: string | null;
  onCopy: (snapshotId: string) => void;
}) {
  if (snapshots.length < 2) return null;
  return (
    <div className="mockup-tools">
      <div className="segmented copy-tabs" role="group" aria-label="Page copies">
        {snapshots.map((snapshot) => (
          <button
            key={snapshot._id}
            type="button"
            aria-pressed={snapshot._id === snapshotId}
            title={`Taken at ${snapshot.width} px by ${snapshot.createdByName}, ${fullTime(snapshot.capturedAt)}`}
            onClick={() => onCopy(snapshot._id)}
          >
            {snapshot.width} px
          </button>
        ))}
      </div>
    </div>
  );
}

/** Shown while an earlier version is on the copy. */
export function OldVersionBanner({ version, onLatest }: { version: number; onLatest: () => void }) {
  return (
    <div className="mockup-banner" role="status">
      <span>{version === 0 ? "Viewing the original copy" : `Viewing version ${version}`}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="link-btn" onClick={onLatest}>
        Back to latest
      </button>
    </div>
  );
}

export function CopyHint({
  hint,
  shownWidth,
  busy,
  onTake,
  onSwitch,
}: {
  hint: { kind: "switch"; snapshot: MockupSnapshotInfo } | { kind: "take"; width: number };
  shownWidth: number;
  busy: boolean;
  onTake: () => void;
  onSwitch: (snapshotId: string) => void;
}) {
  return (
    <div className="mockup-banner hint" role="status">
      <span>This copy was taken at {shownWidth} px.</span>
      {hint.kind === "switch" ? (
        <button type="button" className="link-btn" onClick={() => onSwitch(hint.snapshot._id)}>
          Show the {hint.snapshot.width} px copy
        </button>
      ) : (
        <button type="button" className="link-btn" disabled={busy} onClick={onTake}>
          {busy ? "Taking a copy…" : `Take a copy at ${hint.width} px`}
        </button>
      )}
    </div>
  );
}
