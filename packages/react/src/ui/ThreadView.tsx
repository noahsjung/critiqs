import { REACTIONS } from "@critiqs/core";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { describeTargetState, type LiveThread, locationOf, type ThreadDetail, targetState } from "../model.ts";
import { type CritiqsTransport, errorMessage, useTransport } from "../transport.ts";
import { Avatar, copyText, Dialog, Menu, MenuItem, useMenu } from "./common.tsx";
import { MentionInput, MessageBody, type MentionText, mentionsInText } from "./MentionInput.tsx";
import { describeBrowser, describeViewState, fullTime, relativeTime } from "./format.ts";
import { useHidden } from "./hidden.ts";
import { CloseIcon, EmojiIcon, MoreIcon, ResolveIcon } from "./icons.tsx";
import { connectedTrackers, CreateTicketDialog, LinkTicketDialog, TicketChips, type TicketsOffer, trackerLabel } from "./Tickets.tsx";

/** How revealing a thread's target in the prototype went. */
export type RevealState =
  | { status: "idle" }
  | { status: "restoring" }
  | { status: "shown" }
  | { status: "failed"; reason: string };

/** A thread's reply box, kept by the caller so closing or reopening the thread doesn't lose or repeat it. */
export interface ReplyState {
  draft: MentionText;
  sending: boolean;
  error: string | null;
}

export interface ThreadViewProps {
  threadId: string;
  focusMessageId: string | null;
  /** Changes each time the thread is opened, so opening the same message again shows it again. */
  selectionId: number;
  projectId: string;
  live: LiveThread | undefined;
  version: string | null;
  reveal: RevealState;
  linkFor: (pageUrl: string, messageId: string | null) => string;
  /** The thread's link for **Copy link**: its page on the Critiqs website where the backend has one, otherwise `linkFor`'s. */
  shareLink: (pageUrl: string) => Promise<string>;
  /** False when the target can't be shown beside the thread, so its saved context is shown open. */
  targetShown: boolean;
  reply: ReplyState;
  onDraft: (draft: MentionText) => void;
  onSend: () => void;
  onClose: () => void;
  onShow: () => void;
  onReattach: () => void;
  notify: (message: string, action?: { label: string; run: () => void }) => void;
  /** Filters the sidebar by a tag. */
  onTag: (tag: string) => void;
  /**
   * Opens a mockup in Mockup mode, with one of its threads open; absent where
   * Mockup mode isn't available. A mockup thread, such as one a link opens,
   * opens there instead of here.
   */
  onOpenMockup?: (mockupId: string, threadId: string | null) => void;
  /** Creating and linking tickets, where the backend offers them; absent elsewhere. */
  tickets?: TicketsOffer;
  /** The backend checks tickets' status when a thread opens (`tickets.ticketStatus`). */
  ticketStatus?: boolean;
}

export function ThreadView(props: ThreadViewProps) {
  const result = useTransport().useThread(props.threadId);

  if (result.status === "loading") {
    return (
      <>
        <Header onClose={props.onClose} title="Comment" />
        <div className="empty">Loading…</div>
      </>
    );
  }
  if (result.status === "error" || result.data.projectId !== props.projectId) {
    const message =
      result.status === "ready"
        ? "This comment belongs to another Critiqs project."
        : result.code === "unavailable"
          ? "This thread was deleted."
          : result.code === "not-found"
            ? "This comment does not exist. It may belong to another project or backend."
            : result.message;
    return (
      <>
        <Header onClose={props.onClose} title="Comment unavailable" />
        <div className="empty">
          <strong>Can't open this comment</strong>
          <span>{message}</span>
          <button type="button" className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </>
    );
  }
  const mockup = result.data.mockup;
  if (mockup !== undefined && props.onOpenMockup !== undefined) {
    return <OpenInMockup mockupId={mockup.mockupId} threadId={result.data._id} onOpen={props.onOpenMockup} onClose={props.onClose} />;
  }
  return <Thread {...props} thread={result.data} />;
}

/** A mockup thread opened outside Mockup mode, such as from a link: it opens in its mockup. */
function OpenInMockup({
  mockupId,
  threadId,
  onOpen,
  onClose,
}: {
  mockupId: string;
  threadId: string;
  onOpen: (mockupId: string, threadId: string | null) => void;
  onClose: () => void;
}) {
  useEffect(() => onOpen(mockupId, threadId), [mockupId, threadId]);
  return (
    <>
      <Header onClose={onClose} title="Mockup thread" />
      <div className="empty">Opening its mockup…</div>
    </>
  );
}

/** The mockups an existing thread was added to, to open them in Mockup mode. */
function LinkedMockups({ threadId, onOpen }: { threadId: string; onOpen: (mockupId: string, threadId: string | null) => void }) {
  const linked = useTransport().mockups?.useMockupsForThread(threadId);
  if (linked?.status !== "ready" || linked.data.length === 0) return null;
  return (
    <div className="linked-mockups row wrap">
      {linked.data.map((mockup) => (
        <button key={mockup._id} type="button" className="btn small" onClick={() => onOpen(mockup._id, null)}>
          Open mockup: {mockup.title}
        </button>
      ))}
    </div>
  );
}

function Header({ onClose, title, children }: { onClose: () => void; title: string; children?: ReactNode }) {
  return (
    <div className="window-header">
      <h2>{title}</h2>
      {children}
      <button type="button" className="icon-btn" aria-label="Close comment" title="Close" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}

function Thread(props: ThreadViewProps & { thread: ThreadDetail }) {
  const { thread } = props;
  const threadId = thread._id;
  const transport = useTransport();
  const { setStatus, remove, markRead, markUnread } = transport;
  const overflow = useMenu();
  const moreButton = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Tickets are offered from threads that aren't mockup threads, with the person's connected trackers.
  const ticketsOffer = thread.mockup === undefined ? props.tickets : undefined;
  const accounts = transport.tickets?.useTrackerAccounts(ticketsOffer !== undefined);
  const connected = ticketsOffer !== undefined && accounts?.status === "ready" ? connectedTrackers(ticketsOffer.offered, accounts.data) : [];
  const [ticketDialog, setTicketDialog] = useState<"create" | "link" | null>(null);
  const openTicketDialog = (kind: "create" | "link") => {
    overflow.close();
    if (connected.length === 0) ticketsOffer?.onYourTrackers();
    else setTicketDialog(kind);
  };
  const addLinkBack = async (ticket: { _id: string; key: string }) => {
    try {
      await transport.tickets?.addTicketLinkBack(ticket._id);
      props.notify(`Added the link back to ${ticket.key}`);
    } catch (failure) {
      props.notify(errorMessage(failure));
    }
  };
  const unlink = (ticket: { _id: string; key: string }) => {
    transport.tickets?.unlinkTicket(ticket._id).then(
      () => props.notify(`Unlinked ${ticket.key}`),
      (failure) => props.notify(errorMessage(failure)),
    );
  };
  // Opening a thread with tickets asks the backend to check their status; it checks only status a few minutes old.
  const checkTickets = props.ticketStatus === true && (thread.tickets?.length ?? 0) > 0;
  useEffect(() => {
    if (checkTickets) transport.tickets?.checkTicketStatus(threadId).catch(() => undefined);
  }, [checkTickets, threadId, transport]);
  const { draft, sending, error } = props.reply;

  // Where "New" starts is fixed when the thread opens, so it stays put while the reviewer reads.
  const divider = useRef<{ threadId: string; after: number | null } | null>(null);
  if (divider.current?.threadId !== threadId) {
    const state = thread.readState;
    const after = state !== null && state.lastReadAt < thread.lastMessageAt ? state.lastReadAt : null;
    divider.current = { threadId, after };
  }

  // Reading marks the thread read through the newest message actually seen:
  // on screen in the thread window while the page is visible (F5).
  const body = useRef<HTMLDivElement>(null);
  const seenThrough = useSeenThrough(body, thread.messages.length);
  // Hidden, nothing is read, even when the read state changes elsewhere meanwhile.
  const hidden = useHidden();
  useEffect(() => {
    if (seenThrough === null || hidden) return;
    const state = thread.readState;
    if (state !== null && !state.manualUnread && state.lastReadAt >= seenThrough) return;
    markRead({ threadId, seenThrough }).catch(() => undefined);
  }, [threadId, seenThrough, thread.readState, markRead, hidden]);

  // Open an unread thread where its new messages start.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (props.focusMessageId === null) scrollWithin(body.current?.querySelector(".new-divider") ?? null, "start");
  }, [props.focusMessageId]);

  const resolve = async (status: "open" | "resolved") => {
    try {
      await setStatus({ threadId, status });
      if (status === "resolved") {
        props.notify("Thread resolved", { label: "Undo", run: () => void setStatus({ threadId, status: "open" }) });
      }
    } catch (failure) {
      props.notify(errorMessage(failure));
    }
  };

  const send = () => {
    if (draft.text.trim() !== "" && !sending) props.onSend();
  };

  const copyLink = async (messageId: string | null) => {
    // A message's link opens it in the prototype: a thread page shows the whole thread, not one message.
    const link = messageId === null ? props.shareLink(thread.anchor.evidence.url) : props.linkFor(thread.anchor.evidence.url, messageId);
    let copied: boolean;
    try {
      copied = await copyText(link);
    } catch (failure) {
      props.notify(errorMessage(failure));
      return;
    }
    if (!copied) props.notify(`Couldn't copy the link. Here it is: ${await link}`);
    else props.notify(messageId === null ? "Link to thread copied" : "Link to reply copied");
  };

  const firstRevision = thread.messages[0]?.revision ?? null;
  const newAfter = divider.current.after;
  const firstNewId = newAfter === null ? null : thread.messages.find((message) => message.createdAt > newAfter)?._id;

  return (
    <>
      <Header onClose={props.onClose} title={thread.status === "resolved" ? "Resolved comment" : "Comment"}>
        {thread.status === "open" ? (
          <button type="button" className="btn small" title="Resolve thread" onClick={() => resolve("resolved")}>
            <ResolveIcon /> Resolve
          </button>
        ) : (
          <button type="button" className="btn small" onClick={() => resolve("open")}>
            Reopen
          </button>
        )}
        <button
          ref={moreButton}
          type="button"
          className="icon-btn"
          aria-label="More actions"
          aria-haspopup="menu"
          onClick={overflow.toggle}
        >
          <MoreIcon />
        </button>
        {overflow.open && (
          <Menu anchor={overflow.anchor!} onClose={overflow.close}>
            <MenuItem
              onSelect={() => {
                overflow.close();
                void copyLink(null);
              }}
            >
              Copy link
            </MenuItem>
            <MenuItem
              onSelect={() => {
                overflow.close();
                // Leave the thread first so viewing it does not mark it read again.
                props.onClose();
                markUnread(threadId).catch((failure) => props.notify(errorMessage(failure)));
              }}
            >
              Mark unread
            </MenuItem>
            {ticketsOffer !== undefined && (
              <>
                <hr />
                <MenuItem onSelect={() => openTicketDialog("create")}>Create ticket…</MenuItem>
                <MenuItem onSelect={() => openTicketDialog("link")}>Link ticket…</MenuItem>
              </>
            )}
            {/* Only its author or the project's owners may delete it; older backends don't say, and let anyone. */}
            {thread.canDelete !== false && (
              <>
                <hr />
                <MenuItem
                  danger
                  onSelect={() => {
                    overflow.close();
                    setConfirmDelete(true);
                  }}
                >
                  Delete thread…
                </MenuItem>
              </>
            )}
          </Menu>
        )}
      </Header>
      <div className="window-body" ref={body}>
        {thread.status === "resolved" && (
          <div className="status-banner">
            Resolved{thread.resolvedByTickets === true ? " when its tickets were done" : thread.statusChangedByName ? ` by ${thread.statusChangedByName}` : ""}
            {thread.statusChangedAt ? `, ${fullTime(thread.statusChangedAt)}` : ""}. Resolved threads stay as an archive.
          </div>
        )}
        {thread.tickets !== undefined && <TicketChips tickets={thread.tickets} onUnlink={unlink} onAddLinkBack={addLinkBack} />}
        {props.onOpenMockup !== undefined && <LinkedMockups threadId={threadId} onOpen={props.onOpenMockup} />}
        {props.targetShown ? (
          <details className="saved-context">
            <summary>Saved context</summary>
            <Context {...props} thread={thread} />
          </details>
        ) : (
          <Context {...props} thread={thread} />
        )}
        <div className="messages">
          {thread.messages.map((message) => (
            <div key={message._id}>
              {message._id === firstNewId && <div className="new-divider">New messages</div>}
              <Message
                message={message}
                onTag={props.onTag}
                projectId={props.projectId}
                threadId={threadId}
                focused={message._id === props.focusMessageId}
                selectionId={props.selectionId}
                showRevision={message.revision !== firstRevision}
                onCopyLink={() => copyLink(message._id)}
                notify={props.notify}
              />
            </div>
          ))}
        </div>
      </div>
      <form
        className="window-footer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <MentionInput
          projectId={props.projectId}
          threadId={threadId}
          className="field"
          placeholder="Reply. Type @ to mention someone, # to tag."
          aria-label="Reply"
          value={draft}
          onChange={props.onDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
          }}
        />
        {error !== null && <div className="error">{error}</div>}
        <div className="row end" style={{ marginTop: 8 }}>
          <button type="submit" className="btn primary" disabled={draft.text.trim() === "" || sending}>
            {sending ? "Sending…" : "Reply"}
          </button>
        </div>
      </form>
      {ticketDialog === "create" && ticketsOffer !== undefined && connected.length > 0 && (
        <CreateTicketDialog
          threadId={threadId}
          projectId={props.projectId}
          personId={ticketsOffer.personId}
          accounts={connected}
          drafting={ticketsOffer.offered.drafting === true}
          modelLists={ticketsOffer.modelLists === true}
          onSetUpAi={ticketsOffer.onSetUpAi ?? null}
          installUrls={Object.fromEntries(ticketsOffer.offered.trackers.flatMap((entry) => (entry.installUrl === undefined ? [] : [[entry.id, entry.installUrl]])))}
          returnFocus={moreButton.current}
          onClose={() => setTicketDialog(null)}
          onCreated={(ticket) => {
            setTicketDialog(null);
            if (ticket.canAddLinkBack) {
              props.notify(`Created ${ticket.key}, but ${trackerLabel(ticket.tracker)} didn't add the link back to this thread.`, { label: "Add link back", run: () => void addLinkBack(ticket) });
            } else {
              props.notify(`Created ${ticket.key}`, { label: "Open", run: () => window.open(ticket.url, "_blank", "noopener,noreferrer") });
            }
          }}
        />
      )}
      {ticketDialog === "link" && connected.length > 0 && (
        <LinkTicketDialog
          threadId={threadId}
          accounts={connected}
          linked={thread.tickets ?? []}
          returnFocus={moreButton.current}
          onClose={() => setTicketDialog(null)}
          onLinked={(ticket) => {
            setTicketDialog(null);
            props.notify(`Linked ${ticket.key}`);
          }}
        />
      )}
      {confirmDelete && (
        <Dialog label="Delete thread" onClose={() => setConfirmDelete(false)} returnFocus={moreButton.current}>
          <h3>Delete this thread?</h3>
          <p>
            The whole discussion is removed for everyone, and links to it will report it unavailable. To keep it as an
            archive, resolve it instead.
          </p>
          <div className="row end">
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            {thread.status === "open" && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setConfirmDelete(false);
                  void resolve("resolved");
                }}
              >
                Resolve instead
              </button>
            )}
            <button
              type="button"
              className="btn danger solid"
              onClick={() => {
                setConfirmDelete(false);
                // The thread stays open until it is deleted, so a refusal is shown beside it.
                remove(threadId)
                  .then(() => {
                    props.onClose();
                    props.notify("Thread deleted");
                  })
                  .catch((failure) => props.notify(errorMessage(failure)));
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The thread's saved evidence and where its target is now. */
function Context(props: ThreadViewProps & { thread: ThreadDetail }) {
  const { thread, live, reveal } = props;
  const { evidence } = thread.anchor;
  const location = locationOf(thread);
  const image = useCapture(useTransport(), thread._id, thread.capture.status);
  const [zoomed, setZoomed] = useState(false);
  const state = live === undefined ? null : targetState(live);
  const viewState = describeViewState(location.viewState);
  const browser = describeBrowser(evidence.userAgent);
  const page = (() => {
    try {
      const url = new URL(evidence.url);
      return `${url.pathname}${url.search}`;
    } catch {
      return evidence.url;
    }
  })();

  return (
    <div className="thread-context">
      {thread.capture.status !== "failed" && image !== null && (
        <img className="capture" src={image} alt="Capture from when the comment was left" onClick={() => setZoomed(true)} />
      )}
      {thread.capture.status === "failed" && <CaptureFailed {...props} reason={thread.capture.failureReason} />}
      {thread.capture.status === "supplied" && (
        <div className="capture-missing note">Screenshot supplied after automatic capture failed.</div>
      )}
      <details className="context-details">
        <summary>Details</summary>
        <dl>
          <dt>Screen</dt>
          <dd>{location.screen}</dd>
          {viewState !== "" && (
            <>
              <dt>View</dt>
              <dd>{viewState}</dd>
            </>
          )}
          {location.target.recordKey !== null && (
            <>
              <dt>Record</dt>
              <dd>{location.target.recordKey}</dd>
            </>
          )}
          <dt>Applies to</dt>
          <dd>{location.scope === "record" ? "This record only" : "Every record showing this element"}</dd>
          <dt>Element</dt>
          <dd>{location.target.purposeId ?? location.target.clues.label ?? location.target.clues.tagName}</dd>
          {evidence.persona !== null && (
            <>
              <dt>Viewing as</dt>
              <dd>{evidence.persona} (demo persona)</dd>
            </>
          )}
          <dt>Version</dt>
          <dd>{evidence.revision ?? "Unknown"}</dd>
          <dt>Page</dt>
          <dd>{page}</dd>
          <dt>Browser</dt>
          <dd>
            {evidence.viewport.width}×{evidence.viewport.height}
            {browser !== null ? `, ${browser}` : ""}
          </dd>
          <dt>Left</dt>
          <dd>{fullTime(evidence.capturedAt)}</dd>
          {thread.reattachment !== undefined && (
            <>
              <dt>Reattached</dt>
              <dd>
                by {thread.reattachedByName ?? "Unknown"}, {fullTime(thread.reattachment.reattachedAt)}. Originally{" "}
                {thread.anchor.target.purposeId ?? thread.anchor.target.clues.label ?? thread.anchor.target.clues.tagName} on{" "}
                {thread.anchor.screen}.
              </dd>
            </>
          )}
        </dl>
      </details>
      <div className="target-status">
        <span className={`dot${state === "live" ? " live" : state === null ? "" : " warn"}`} />
        <div className="grow">
          <div>{live === undefined ? "Finding the element…" : describeTargetState(live)}</div>
          {reveal.status === "restoring" && <div className="note">Restoring the view…</div>}
          {reveal.status === "failed" && (
            <div className="note">
              {reveal.reason} The saved {thread.capture.status === "failed" ? "context is" : "capture and context are"} shown
              above.
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 6 }}>
            <button type="button" className="btn small" onClick={props.onShow} disabled={reveal.status === "restoring"}>
              Show in prototype
            </button>
            {state !== "live" && (
              <button type="button" className="btn small" onClick={props.onReattach} title="Point this thread at a replacement element">
                Reattach…
              </button>
            )}
          </div>
        </div>
      </div>
      {zoomed && image !== null && (
        <Dialog label="Capture" onClose={() => setZoomed(false)} bare>
          <img src={image} alt="Capture from when the comment was left" onClick={() => setZoomed(false)} />
        </Dialog>
      )}
    </div>
  );
}

function CaptureFailed(props: ThreadViewProps & { thread: ThreadDetail; reason: string }) {
  const { uploadImage, attachScreenshot } = useTransport();
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fileId = await uploadImage(props.thread.projectId, file);
      await attachScreenshot({ threadId: props.thread._id, fileId });
      props.notify("Screenshot attached");
    } catch (failure) {
      props.notify(failure instanceof Error && !("data" in failure) ? failure.message : errorMessage(failure));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="capture-missing">
      <div className="warning">
        Automatic capture failed: {props.reason} The comment was saved without an image.
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn small" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? "Uploading…" : "Attach a screenshot"}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void upload(file);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

/** Loads a thread's protected capture as an object URL. */
function useCapture(transport: CritiqsTransport, threadId: string, status: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (status === "failed") return setUrl(null);
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      const image = await transport.loadCapture(threadId);
      if (image === null || cancelled) return;
      objectUrl = URL.createObjectURL(image);
      if (cancelled) URL.revokeObjectURL(objectUrl);
      else setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [transport, threadId, status]);
  return url;
}

/**
 * The creation time of the newest message seen: at least half on screen in
 * the thread window, or filling much of it, while the page is visible. Rechecked as
 * the thread or its content scrolls or resizes. Null until a message has been seen.
 */
function useSeenThrough(body: RefObject<HTMLDivElement | null>, messageCount: number): number | null {
  const [seen, setSeen] = useState<number | null>(null);
  // Hidden, nothing is on screen, so nothing is read.
  const hidden = useHidden();
  useEffect(() => {
    const root = body.current;
    if (root === null || hidden) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (document.visibilityState !== "visible") return;
      // Only the part of the thread inside the browser window counts as seen.
      const box = root.getBoundingClientRect();
      const view = { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) };
      let newest: number | null = null;
      for (const element of root.querySelectorAll<HTMLElement>(".message[data-created]")) {
        const rect = element.getBoundingClientRect();
        const shown = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
        if (shown <= 0 || (shown < rect.height / 2 && shown < 120)) continue;
        const created = Number(element.dataset.created);
        if (newest === null || created > newest) newest = created;
      }
      if (newest !== null) setSeen((current) => (current === null || newest! > current ? newest : current));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    schedule();
    // The viewport, and its content: an edit or a loaded capture can move messages into view.
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    for (const child of root.children) resize.observe(child);
    for (const element of root.querySelectorAll(".message")) resize.observe(element);
    root.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      root.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [body, messageCount, hidden]);
  return seen;
}

function Message({
  message,
  onTag,
  projectId,
  threadId,
  focused,
  selectionId,
  showRevision,
  onCopyLink,
  notify,
}: {
  message: ThreadDetail["messages"][number];
  onTag: (tag: string) => void;
  projectId: string;
  threadId: string;
  focused: boolean;
  selectionId: number;
  showRevision: boolean;
  onCopyLink: () => void;
  notify: ThreadViewProps["notify"];
}) {
  const { editMessage, toggleReaction } = useTransport();
  const [editing, setEditing] = useState<MentionText | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useMenu();
  const more = useMenu();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Within the thread's own scroll area, so the prototype behind it stays put.
    if (focused) scrollWithin(ref.current, "center");
  }, [focused, selectionId]);

  const save = async () => {
    if (editing === null || editing.text.trim() === "") return;
    setSaving(true);
    try {
      await editMessage({ messageId: message._id, body: editing.text, mentions: mentionsInText(editing) });
      setEditing(null);
    } catch (failure) {
      notify(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const react = (emoji: string) =>
    toggleReaction({ messageId: message._id, emoji }).catch((failure) => notify(errorMessage(failure)));

  return (
    <div
      ref={ref}
      className={`message${focused ? " focused" : ""}`}
      id={`critiqs-message-${message._id}`}
      data-created={message.createdAt}
    >
      <Avatar name={message.author.name} imageUrl={message.author.imageUrl} large />
      <div className="grow">
        <div className="meta">
          <span className="author">{message.author.name}</span>
          {message.via === "agent" && (
            <span className="via" title={`A coding agent wrote this for ${message.author.name}`}>
              via coding agent
            </span>
          )}
          <span className="time" title={fullTime(message.createdAt)}>
            {relativeTime(message.createdAt)}
          </span>
          {message.editedAt !== null && (
            <span className="edited" title={`Edited ${fullTime(message.editedAt)}`}>
              (edited)
            </span>
          )}
          {showRevision && <span className="time">· version {message.revision ?? "unknown"}</span>}
          <span className="actions row">
            <button type="button" className="icon-btn" aria-label="Add reaction" title="Add reaction" onClick={picker.toggle}>
              <EmojiIcon />
            </button>
            <button type="button" className="icon-btn" aria-label="Message actions" aria-haspopup="menu" onClick={more.toggle}>
              <MoreIcon />
            </button>
          </span>
        </div>
        {editing === null ? (
          <div className="body">
            <MessageBody body={message.body} mentions={message.mentions} onTag={onTag} />
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <MentionInput
              projectId={projectId}
              threadId={threadId}
              className="field"
              aria-label="Edit message"
              value={editing}
              autoFocus
              onChange={setEditing}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setEditing(null);
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
              }}
            />
            <div className="row end" style={{ marginTop: 6 }}>
              <button type="button" className="btn small" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn small primary" disabled={saving || editing.text.trim() === ""}>
                Save
              </button>
            </div>
          </form>
        )}
        {message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                className="reaction"
                aria-pressed={reaction.mine}
                aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ", including you" : ""}`}
                onClick={() => react(reaction.emoji)}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
          </div>
        )}
      </div>
      {picker.open && (
        <Menu anchor={picker.anchor!} onClose={picker.close}>
          <div className="emoji-picker">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React ${emoji}`}
                onClick={() => {
                  picker.close();
                  void react(emoji);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </Menu>
      )}
      {more.open && (
        <Menu anchor={more.anchor!} onClose={more.close}>
          <MenuItem
            onSelect={() => {
              more.close();
              onCopyLink();
            }}
          >
            Copy link to message
          </MenuItem>
          {message.isMine && (
            <MenuItem
              onSelect={() => {
                more.close();
                setEditing({ text: message.body, mentions: message.mentions });
              }}
            >
              Edit
            </MenuItem>
          )}
        </Menu>
      )}
    </div>
  );
}

/** Scrolls an element into view within the thread's scroll area only, leaving the page itself where it is. */
function scrollWithin(element: Element | null, block: "start" | "center") {
  const container = element?.closest(".window-body");
  if (!(element instanceof HTMLElement) || !(container instanceof HTMLElement)) return;
  const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += block === "start" ? offset : offset - (container.clientHeight - element.offsetHeight) / 2;
}
