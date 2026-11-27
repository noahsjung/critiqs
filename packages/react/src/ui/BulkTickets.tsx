import type { TicketDestination, TicketLinkView, TrackerAccountView, TrackerId } from "@critiqs/core";
import { useEffect, useRef, useState } from "react";
import { useStoredState } from "../hooks.ts";
import { describeError, useTransport } from "../transport.ts";
import { Dialog } from "./common.tsx";
import { DialogHeader, Select, SettingRow } from "./ds.tsx";
import { DESTINATION_LABEL, TrackerRow, ticketText, trackerLabel, useCreatedFromCritiqs } from "./Tickets.tsx";

// **Create tickets** for a selected feedback collection: one ticket per
// thread, each filled from its thread without AI as Create ticket fills it,
// created one after another with the person's own tracker account. Each
// creation is an ordinary Create ticket on the backend, with its checks and
// its per-person limit (20 creates or links a minute), so a run holds at most
// that many threads. A thread that already has a ticket is skipped. When some
// aren't created, the dialog says which and why, and **Try again** retries
// only those, each under the submission it started with, so no retry makes a
// second ticket.

/** The most threads one run creates tickets for: the backend's creates and links a minute. */
export const MAX_BULK_TICKETS = 20;

/** A selected thread, as the list shows it. */
export interface BulkThread {
  id: string;
  /** The first message's first line, to name the thread. */
  title: string;
  /** The tickets it links already; any means it is skipped. */
  tickets: { key: string }[];
}

type Row =
  | { state: "waiting" }
  | { state: "creating" }
  | { state: "created"; ticket: TicketLinkView }
  | { state: "skipped"; reason: string }
  | { state: "failed"; reason: string }
  /** Stopped by the minute's limit on tickets; continues on its own while the dialog is open. */
  | { state: "paused" };

/**
 * How long a run stopped by the limit waits before it continues: the
 * server counts a person's tickets in windows of a minute, so a minute after
 * the refusal there is room again, with a second to spare.
 */
const LIMIT_WAIT_MS = 61_000;
/** How many times a run continues on its own; past that, the person presses Try again. */
const MAX_LIMIT_WAITS = 3;

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/** One line for a thread: its first line, short. */
const short = (title: string) => (title.length > 60 ? `${title.slice(0, 59)}…` : title || "(empty comment)");

export function BulkCreateTicketsDialog({
  projectId,
  personId,
  threads: selected,
  accounts,
  drafting = false,
  onClose,
  onDone,
}: {
  projectId: string;
  personId: string;
  threads: BulkThread[];
  /** The person's connected trackers; at least one. */
  accounts: TrackerAccountView[];
  /** The backend drafts and reports a destination's required fields (`tickets.drafting`). */
  drafting?: boolean;
  onClose: () => void;
  /** After a run: how many were created and how many have none. */
  onDone: (created: number, missing: number) => void;
}) {
  const tickets = useTransport().tickets!;
  // The selection as it was when the dialog opened: tickets this run creates mustn't make their threads read as skipped.
  const [threads] = useState(selected);
  const [tracker, setTracker] = useState<TrackerId>(accounts[0]!.tracker);
  const account = accounts.find((entry) => entry.tracker === tracker) ?? accounts[0]!;
  const [attribution, setAttribution] = useCreatedFromCritiqs(tracker, account.attribution);
  const [destinations, setDestinations] = useState<{ tracker: TrackerId; loaded: Loaded<TicketDestination[]> }>({ tracker, loaded: { status: "loading" } });
  const [remembered, remember] = useStoredState<string | null>(`critiqs:ticket-destination:${projectId}:${personId}:${tracker}`, null);
  /** The project's default for the tracker, from the first thread's draft; undefined until read. */
  const [projectDefault, setProjectDefault] = useState<{ tracker: TrackerId; id: string | null } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  /** Fields the destination requires beyond title and text, which a run can't fill; null until checked. */
  const [blocked, setBlocked] = useState<{ destinationId: string; fields: string[] } | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [running, setRunning] = useState(false);
  // Each thread's submission, kept for the dialog's life: a retry sends the same one.
  const submissions = useRef(new Map<string, string>());
  /** When a run stopped by the limit continues on its own; null when none waits. */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  /** Whether the limit stopped the run after it had continued on its own as often as it may. */
  const [limitAgain, setLimitAgain] = useState(false);
  const wait = useRef<{ timer: ReturnType<typeof setTimeout> | null; count: number }>({ timer: null, count: 0 });
  const stopWaiting = () => {
    if (wait.current.timer !== null) clearTimeout(wait.current.timer);
    wait.current.timer = null;
    setResumeAt(null);
  };
  // Closing the dialog ends the wait.
  useEffect(
    () => () => {
      if (wait.current.timer !== null) clearTimeout(wait.current.timer);
    },
    [],
  );

  const eligible = threads.filter((thread) => thread.tickets.length === 0);
  const tooMany = eligible.length > MAX_BULK_TICKETS;

  useEffect(() => {
    let cancelled = false;
    setDestinations({ tracker, loaded: { status: "loading" } });
    tickets.listTicketDestinations(tracker).then(
      (data) => !cancelled && setDestinations({ tracker, loaded: { status: "ready", data } }),
      (failure) => !cancelled && setDestinations({ tracker, loaded: { status: "error", message: describeError(failure).message } }),
    );
    // Where the project sends this tracker's tickets, read from a draft as Create ticket reads it.
    const first = eligible[0];
    if (first === undefined) setProjectDefault({ tracker, id: null });
    else
      tickets.ticketDraft(first.id, tracker).then(
        (draft) => !cancelled && setProjectDefault({ tracker, id: draft.projectDestinationId ?? null }),
        () => !cancelled && setProjectDefault({ tracker, id: null }),
      );
    return () => {
      cancelled = true;
    };
    // The selection is fixed while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, tracker]);

  const loaded = destinations.tracker === tracker ? destinations.loaded : ({ status: "loading" } as const);
  const options = loaded.status === "ready" ? loaded.data : [];
  const known = projectDefault?.tracker === tracker ? projectDefault.id : undefined;
  const destination =
    options.find((option) => option.id === chosen) ??
    options.find((option) => option.id === remembered) ??
    (known === undefined ? null : (options.find((option) => option.id === known) ?? options[0] ?? null));

  // A destination whose tickets need more than a title and text (a Jira issue type's required fields) can't be filled here.
  const destinationId = destination?.id ?? null;
  useEffect(() => {
    setBlocked(null);
    if (!drafting || destinationId === null || eligible[0] === undefined) return;
    let cancelled = false;
    tickets.ticketDraftOptions(eligible[0].id, tracker, destinationId).then(
      (offer) => !cancelled && setBlocked({ destinationId, fields: [...(offer.fields ?? []).map((field) => field.name), ...(offer.unsupportedFields ?? [])] }),
      () => !cancelled && setBlocked({ destinationId, fields: [] }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, drafting, tracker, destinationId]);
  const required = blocked?.destinationId === destinationId ? blocked.fields : null;
  const checked = !drafting || required !== null;

  const set = (threadId: string, row: Row) => setRows((before) => ({ ...before, [threadId]: row }));

  /**
   * Creates the tickets for `targets`, one after another. A limit refusal
   * pauses the run: that thread and the rest wait, and continue on their own
   * a minute later while the dialog is open, up to `MAX_LIMIT_WAITS` times;
   * after that they fail and the person presses Try again.
   */
  const run = async (targets: BulkThread[], automatic = false) => {
    if (destination === null || running) return;
    stopWaiting();
    if (!automatic) wait.current.count = 0;
    setLimitAgain(false);
    setRunning(true);
    for (const thread of targets) set(thread.id, { state: "waiting" });
    let created = 0;
    let limit: string | null = null;
    const paused: BulkThread[] = [];
    for (const thread of targets) {
      if (limit !== null) {
        paused.push(thread);
        continue;
      }
      set(thread.id, { state: "creating" });
      try {
        const draft = await tickets.ticketDraft(thread.id, tracker);
        const submissionId = draft.resumeSubmissionId ?? submissions.current.get(thread.id) ?? crypto.randomUUID();
        submissions.current.set(thread.id, submissionId);
        const ticket = await tickets.createTicket({ threadId: thread.id, submissionId, tracker, destinationId: destination.id, title: draft.title, body: draft.body, createdFromCritiqs: attribution });
        set(thread.id, { state: "created", ticket });
        created++;
      } catch (failure) {
        const { code, message: reason } = describeError(failure);
        // Past the minute's limit, the rest would be refused too: this one and the rest wait.
        if (code === "limit") {
          limit = reason;
          paused.push(thread);
        } else set(thread.id, { state: "failed", reason });
      }
    }
    remember(destination.id);
    const pausing = limit !== null && wait.current.count < MAX_LIMIT_WAITS;
    if (pausing) {
      for (const thread of paused) set(thread.id, { state: "paused" });
      wait.current.count++;
      setResumeAt(Date.now() + LIMIT_WAIT_MS);
      wait.current.timer = setTimeout(() => {
        wait.current.timer = null;
        void run(paused, true);
      }, LIMIT_WAIT_MS);
    } else if (limit !== null) {
      setLimitAgain(true);
      for (const thread of paused) set(thread.id, { state: "failed", reason: limit });
    }
    setRunning(false);
    // A paused run reports when it finishes.
    if (!pausing) onDone(created, targets.length - created);
  };

  const started = Object.keys(rows).length > 0;
  const failed = eligible.filter((thread) => rows[thread.id]?.state === "failed");
  const paused = eligible.filter((thread) => rows[thread.id]?.state === "paused");
  const createdCount = eligible.filter((thread) => rows[thread.id]?.state === "created").length;
  const doneCount = eligible.filter((thread) => rows[thread.id]?.state === "created" || rows[thread.id]?.state === "failed").length;
  const ready = !running && !started && destination !== null && !tooMany && eligible.length > 0 && checked && (required ?? []).length === 0;
  const label = DESTINATION_LABEL[tracker];

  return (
    <Dialog label="Create tickets" onClose={running ? () => undefined : onClose}>
      <div className="ds-page ticket-dialog">
        <DialogHeader title="Create tickets" onClose={running ? () => undefined : onClose} />
        <p className="note">
          One ticket per thread in {trackerLabel(tracker)}, each filled from its thread as Create ticket fills it. Threads that already have a ticket are skipped.
        </p>
        <div className="ds-group">
          <TrackerRow accounts={accounts} value={tracker} disabled={running || started} onChange={(next) => { setTracker(next); setChosen(null); }} />
          <SettingRow label={label}>
            {(labelId) =>
              loaded.status === "error" ? (
                <span className="error">{loaded.message}</span>
              ) : (
                <Select
                  value={destination?.id ?? ""}
                  labelledBy={labelId}
                  disabled={running || started || loaded.status === "loading" || options.length === 0}
                  options={options.map((option) => ({ value: option.id, label: option.name, ...(option.key === null ? {} : { detail: option.key }) }))}
                  onChange={setChosen}
                />
              )
            }
          </SettingRow>
        </div>
        <label className="ticket-check">
          <input type="checkbox" checked={attribution} disabled={running || started} onChange={(event) => setAttribution(event.target.checked)} />
          Created from Critiqs
        </label>
        {tooMany && (
          <p className="warning" role="alert">
            Create tickets works on up to {MAX_BULK_TICKETS} threads at a time; {eligible.length} are selected without a ticket. Select fewer.
          </p>
        )}
        {required !== null && required.length > 0 && (
          <p className="warning" role="alert">
            This {label.toLowerCase()} needs {required.join(", ")} on each ticket. Choose another, or create these tickets one at a time.
          </p>
        )}
        <ol className="bulk-tickets" aria-label="Threads">
          {threads.map((thread) => {
            const row: Row = thread.tickets.length > 0 ? { state: "skipped", reason: `Has ${thread.tickets.map((ticket) => ticket.key).join(", ")}` } : (rows[thread.id] ?? { state: "waiting" });
            return (
              <li key={thread.id} className={`bulk-ticket ${row.state}`}>
                <span className="grow ellipsis">{short(thread.title)}</span>
                <span className="bulk-state">
                  {row.state === "waiting"
                    ? started
                      ? "Waiting"
                      : ""
                    : row.state === "creating"
                      ? "Creating…"
                      : row.state === "paused"
                        ? "Waiting for the limit of tickets a minute"
                        : row.state === "created"
                        ? `Created ${ticketText(row.ticket)}`
                        : row.state === "skipped"
                          ? `Skipped: ${row.reason}`
                          : `Not created: ${row.reason}`}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="note" role="status" aria-live="polite">
          {running
            ? `Creating ${Math.min(doneCount + 1, eligible.length)} of ${eligible.length}…`
            : started
              ? failed.length === 0 && paused.length === 0
                ? `Created ${createdCount} ${createdCount === 1 ? "ticket" : "tickets"}.`
                : [
                    `Created ${createdCount} of ${eligible.length}.`,
                    ...(paused.length > 0 && resumeAt !== null
                      ? [`Paused at the limit of tickets a minute: ${paused.length} more continue on their own at ${new Date(resumeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} while this stays open.`]
                      : []),
                    ...(limitAgain ? ["The limit of tickets a minute was reached again: press Try again in a minute."] : []),
                    ...(failed.length > 0 ? [`${failed.length === 1 ? "1 thread has" : `${failed.length} threads have`} no ticket: ${failed.map((thread) => `“${short(thread.title)}”`).join(", ")}.`] : []),
                  ].join(" ")
              : eligible.length === 0
                ? "Every selected thread already has a ticket."
                : `Creates ${eligible.length} ${eligible.length === 1 ? "ticket" : "tickets"}${destination === null ? "" : ` in ${destination.name}`}.`}
        </p>
        <div className="ds-actions">
          {started && !running && failed.length > 0 && (
            <button type="button" className="btn" onClick={() => void run([...failed, ...paused])}>
              Try again
            </button>
          )}
          {started ? (
            <button type="button" className="btn primary" disabled={running} onClick={onClose}>
              Done
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!ready} onClick={() => void run(eligible)}>
              Create {eligible.length === 1 ? "ticket" : "tickets"}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
