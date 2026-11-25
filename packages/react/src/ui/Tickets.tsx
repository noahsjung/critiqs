import {
  TRACKERS,
  type TicketBadge,
  type TicketDestination,
  type TicketLinkView,
  type TicketSearchResult,
  type TicketStatus,
  type TicketsConfig,
  type TrackerAccountView,
  type TrackerId,
} from "@critiqs/core";
import { useEffect, useId, useRef, useState } from "react";
import { useStoredState } from "../hooks.ts";
import { errorMessage, useTransport } from "../transport.ts";
import { Dialog } from "./common.tsx";
import { DialogHeader, Select, SettingRow } from "./ds.tsx";
import { CloseIcon, TicketIcon } from "./icons.tsx";

// Tickets linked to threads: the chips under the thread window's header, the
// key and status on list rows and pins, and the dialogs that create a ticket
// from a thread or link it to an existing one, in the person's own tracker.

export const trackerLabel = (tracker: TrackerId) => TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;

/** What a tracker calls the place a ticket goes. */
const DESTINATION_LABEL: Record<TrackerId, string> = { linear: "Team", github: "Repository", jira: "Project" };

/** A ticket's key and status as people read it, such as `ENG-123 · In Progress`. */
export function ticketText(ticket: { key: string; status: TicketStatus | null }): string {
  return ticket.status === null ? ticket.key : `${ticket.key} · ${ticket.status.label}`;
}

/** Where tickets can be created: the backend offers tickets and the transport has them. */
export interface TicketsOffer {
  offered: TicketsConfig;
  /** Opens Your trackers, to connect a tracker first. */
  onYourTrackers: () => void;
  /** The signed-in person, so what the dialogs remember in this browser is theirs alone. */
  personId: string;
}

/** The trackers the person has connected, in the order the backend offers them. */
export function connectedTrackers(offered: TicketsConfig, accounts: TrackerAccountView[]): TrackerAccountView[] {
  return offered.trackers.flatMap(({ id }) => accounts.filter((account) => account.tracker === id));
}

function StatusDot({ status }: { status: TicketStatus | null }) {
  return <span className={`ticket-dot ${status?.category ?? "unknown"}`} aria-hidden="true" />;
}

/**
 * The thread's linked tickets, under the thread window's header: each opens
 * the ticket in a new tab. A ticket the person created whose tracker didn't
 * add the link back to the thread offers **Add link back**.
 */
export function TicketChips({
  tickets,
  onUnlink,
  onAddLinkBack,
}: {
  tickets: TicketLinkView[];
  onUnlink: (ticket: TicketLinkView) => void;
  onAddLinkBack: (ticket: TicketLinkView) => Promise<void>;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  if (tickets.length === 0) return null;
  const addLinkBack = (ticket: TicketLinkView) => {
    setAdding(ticket._id);
    void onAddLinkBack(ticket).finally(() => setAdding(null));
  };
  return (
    <ul className="ticket-chips" aria-label="Linked tickets">
      {tickets.map((ticket) => (
        <li key={ticket._id} className="ticket-chip">
          <a href={ticket.url} target="_blank" rel="noreferrer noopener" title={`${ticket.title} (${trackerLabel(ticket.tracker)}, linked by ${ticket.linkedByName})`}>
            <TicketIcon size={14} />
            <span className="key">{ticket.key}</span>
            {ticket.status !== null && (
              <span className="status">
                <StatusDot status={ticket.status} />
                {ticket.status.label}
              </span>
            )}
          </a>
          {ticket.canAddLinkBack && (
            <button
              type="button"
              className="link-btn"
              disabled={adding === ticket._id}
              title={`${trackerLabel(ticket.tracker)} didn't add the link back to this thread`}
              onClick={() => addLinkBack(ticket)}
            >
              {adding === ticket._id ? "Adding link back…" : "Add link back"}
            </button>
          )}
          {ticket.canUnlink && (
            <button type="button" className="icon-btn" aria-label={`Unlink ${ticket.key}`} title="Unlink" onClick={() => onUnlink(ticket)}>
              <CloseIcon />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A thread's tickets in short, on its row in the thread list. */
export function TicketBadges({ tickets }: { tickets: TicketBadge[] | undefined }) {
  if (tickets === undefined || tickets.length === 0) return null;
  return (
    <>
      {tickets.map((ticket) => (
        <span key={`${ticket.tracker}:${ticket.key}`} className="ticket-badge" title={`${trackerLabel(ticket.tracker)} ticket`}>
          <TicketIcon size={12} />
          {ticketText(ticket)}
        </span>
      ))}
    </>
  );
}

/** Picks the tracker among the person's connected ones; shown only when there is more than one. */
function TrackerRow({ accounts, value, onChange, disabled }: { accounts: TrackerAccountView[]; value: TrackerId; onChange: (tracker: TrackerId) => void; disabled: boolean }) {
  if (accounts.length < 2) return null;
  return (
    <SettingRow label="Tracker">
      {(labelId) => (
        <Select
          value={value}
          labelledBy={labelId}
          disabled={disabled}
          options={accounts.map((account) => ({ value: account.tracker, label: trackerLabel(account.tracker), detail: account.accountName }))}
          onChange={(next) => onChange(next as TrackerId)}
        />
      )}
    </SettingRow>
  );
}

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/**
 * Creates a ticket from the thread: the tracker (among those connected), where
 * it goes (remembered per person, project, and tracker), and the title and text filled from the
 * thread, both editable, with **Created from Critiqs** defaulting to the
 * person's choice in Your trackers. When the person started a ticket on the
 * thread that didn't finish, the dialog finishes that one, under its
 * submission ID, rather than starting another.
 */
export function CreateTicketDialog({
  threadId,
  projectId,
  personId,
  accounts,
  onClose,
  onCreated,
  returnFocus,
}: {
  threadId: string;
  projectId: string;
  /** The signed-in person: the team is remembered for them, not for everyone who uses this browser. */
  personId: string;
  /** The person's connected trackers; at least one. */
  accounts: TrackerAccountView[];
  onClose: () => void;
  onCreated: (ticket: TicketLinkView) => void;
  returnFocus?: HTMLElement | null;
}) {
  const tickets = useTransport().tickets!;
  const [tracker, setTracker] = useState<TrackerId>(accounts[0]!.tracker);
  const [destinations, setDestinations] = useState<Loaded<TicketDestination[]>>({ status: "loading" });
  const [remembered, remember] = useStoredState<string | null>(`critiqs:ticket-destination:${projectId}:${personId}:${tracker}`, null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [attribution, setAttribution] = useState(accounts[0]!.attribution);
  // One submission per tracker while the dialog is open: every try sends its ID, so a retry never creates a second ticket.
  // The server names the person's unfinished one, which the dialog finishes instead of starting another.
  const submissions = useRef(new Map<TrackerId, string>());
  const [resuming, setResuming] = useState(false);
  const [drafting, setDrafting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    let cancelled = false;
    setDestinations({ status: "loading" });
    tickets.listTicketDestinations(tracker).then(
      (data) => !cancelled && setDestinations({ status: "ready", data }),
      (failure) => !cancelled && setDestinations({ status: "error", message: errorMessage(failure) }),
    );
    return () => {
      cancelled = true;
    };
  }, [tickets, tracker]);

  useEffect(() => {
    let cancelled = false;
    setDrafting(true);
    setResuming(false);
    tickets.ticketDraft(threadId, tracker).then(
      (draft) => {
        if (cancelled) return;
        setTitle(draft.title);
        setBody(draft.body);
        setAttribution(draft.createdFromCritiqs);
        if (draft.resumeSubmissionId !== null) submissions.current.set(tracker, draft.resumeSubmissionId);
        setResuming(draft.resumeSubmissionId !== null);
        setDrafting(false);
      },
      (failure) => {
        if (cancelled) return;
        setError(errorMessage(failure));
        setDrafting(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tickets, threadId, tracker]);

  const options = destinations.status === "ready" ? destinations.data : [];
  const destination = options.find((option) => option.id === remembered) ?? options[0] ?? null;
  const ready = destination !== null && !drafting && !busy && title.trim() !== "";

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const submissionId = submissions.current.get(tracker) ?? crypto.randomUUID();
    submissions.current.set(tracker, submissionId);
    try {
      const created = await tickets.createTicket({ threadId, submissionId, tracker, destinationId: destination.id, title, body, createdFromCritiqs: attribution });
      remember(destination.id);
      onCreated(created);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog label="Create ticket" onClose={onClose} returnFocus={returnFocus}>
      <form
        className="ds-page ticket-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader title="Create ticket" onClose={onClose} />
        {resuming && (
          <p className="note">
            Finishing the ticket you started earlier. If {trackerLabel(tracker)} already created it, Critiqs links it instead of creating another.
          </p>
        )}
        <div className="ds-group">
          <TrackerRow accounts={accounts} value={tracker} disabled={busy} onChange={setTracker} />
          <SettingRow label={DESTINATION_LABEL[tracker]}>
            {(labelId) =>
              destinations.status === "error" ? (
                <span className="error">{destinations.message}</span>
              ) : (
                <Select
                  value={destination?.id ?? ""}
                  labelledBy={labelId}
                  disabled={busy || destinations.status === "loading" || options.length === 0}
                  options={options.map((option) => ({ value: option.id, label: option.name, ...(option.key === null ? {} : { detail: option.key }) }))}
                  onChange={remember}
                />
              )
            }
          </SettingRow>
        </div>
        <label className="stacked" htmlFor={titleId}>
          <span className="field-label">Title</span>
          <input id={titleId} className="field" value={title} disabled={drafting || busy} placeholder={drafting ? "Filling from the thread…" : ""} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="stacked" htmlFor={bodyId}>
          <span className="field-label">Text</span>
          <textarea id={bodyId} className="field ticket-body" rows={9} value={body} disabled={drafting || busy} onChange={(event) => setBody(event.target.value)} />
        </label>
        <label className="ticket-check">
          <input type="checkbox" checked={attribution} disabled={busy} onChange={(event) => setAttribution(event.target.checked)} />
          Created from Critiqs
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="ds-actions">
          <button type="submit" className="btn primary" disabled={!ready}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const SEARCH_DELAY_MS = 300;

/**
 * Links the thread to an existing ticket: searches the person's tracker by key
 * or words, and can add a comment with the thread's summary to the ticket.
 */
export function LinkTicketDialog({
  threadId,
  accounts,
  linked,
  onClose,
  onLinked,
  returnFocus,
}: {
  threadId: string;
  accounts: TrackerAccountView[];
  /** Tickets the thread already links to, marked in the results. */
  linked: TicketLinkView[];
  onClose: () => void;
  onLinked: (ticket: TicketLinkView) => void;
  returnFocus?: HTMLElement | null;
}) {
  const tickets = useTransport().tickets!;
  const [tracker, setTracker] = useState<TrackerId>(accounts[0]!.tracker);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Loaded<TicketSearchResult[]> | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [comment, setComment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchId = useId();
  const latest = useRef(0);

  useEffect(() => {
    const words = query.trim();
    // Answers to any earlier search, including one for a query since cleared, are ignored.
    const request = ++latest.current;
    setChosen(null);
    // The last search's results don't match what's typed now, so they go at once, before the next search.
    setResults(words === "" ? null : { status: "loading" });
    if (words === "") return;
    const timer = setTimeout(() => {
      tickets.searchTickets(tracker, words).then(
        (data) => latest.current === request && setResults({ status: "ready", data }),
        (failure) => latest.current === request && setResults({ status: "error", message: errorMessage(failure) }),
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tickets, tracker, query]);

  const found = results?.status === "ready" ? results.data : [];
  const ticket = found.find((entry) => entry.externalId === chosen) ?? null;

  const submit = async () => {
    if (ticket === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      onLinked(await tickets.linkTicket({ threadId, tracker, externalId: ticket.externalId, comment }));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog label="Link ticket" onClose={onClose} returnFocus={returnFocus}>
      <form
        className="ds-page ticket-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader title="Link ticket" onClose={onClose} />
        <TrackerRow accounts={accounts} value={tracker} disabled={busy} onChange={setTracker} />
        <label className="stacked" htmlFor={searchId}>
          <span className="field-label">Search {trackerLabel(tracker)}</span>
          <input id={searchId} className="field" type="search" value={query} placeholder="Key, such as ENG-123, or words" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        </label>
        {results?.status === "loading" && <p className="note">Searching…</p>}
        {results?.status === "error" && <p className="error">{results.message}</p>}
        {results?.status === "ready" && found.length === 0 && <p className="note">No tickets match.</p>}
        {found.length > 0 && (
          <div className="ticket-results" role="radiogroup" aria-label="Tickets found">
            {found.map((entry) => {
              const already = linked.some((link) => link.tracker === entry.tracker && link.externalId === entry.externalId);
              return (
                <label key={entry.externalId} className={`ticket-result${entry.externalId === chosen ? " chosen" : ""}`}>
                  <input type="radio" name={`${searchId}-ticket`} checked={entry.externalId === chosen} disabled={busy || already} onChange={() => setChosen(entry.externalId)} />
                  <span className="key">{entry.key}</span>
                  <span className="title">{entry.title}</span>
                  <span className="status">
                    <StatusDot status={entry.status} />
                    {already ? "Linked" : entry.status.label}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <label className="ticket-check">
          <input type="checkbox" checked={comment} disabled={busy} onChange={(event) => setComment(event.target.checked)} />
          Add a comment with the thread's summary
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="ds-actions">
          <button type="submit" className="btn primary" disabled={ticket === null || busy}>
            {busy ? "Linking…" : "Link"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
