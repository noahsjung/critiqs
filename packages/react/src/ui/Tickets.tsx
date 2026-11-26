import {
  TRACKERS,
  type TicketBadge,
  type TicketDestination,
  type TicketDraft,
  type TicketDraftOptions,
  type TicketField,
  type TicketFieldValue,
  type TicketLabel,
  type TicketLinkView,
  type TicketSearchResult,
  type TicketStatus,
  type TicketsConfig,
  type TrackerAccountView,
  type TrackerId,
  webAddress,
} from "@critiqs/core";
import { useEffect, useId, useRef, useState } from "react";
import { useStoredState } from "../hooks.ts";
import { errorMessage, useTransport } from "../transport.ts";
import { Dialog } from "./common.tsx";
import { DialogHeader, Select, SettingRow } from "./ds.tsx";
import { fullTime } from "./format.ts";
import { CloseIcon, TicketIcon } from "./icons.tsx";
import { ModelChoice } from "./mockup/MockupPanel.tsx";

// Tickets linked to threads: the chips under the thread window's header, the
// key and status on list rows and pins, and the dialogs that create a ticket
// from a thread or link it to an existing one, in the person's own tracker.

export const trackerLabel = (tracker: TrackerId) => TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;

/** What a tracker calls the place a ticket goes. */
const DESTINATION_LABEL: Record<TrackerId, string> = { linear: "Team", github: "Repository", jira: "Project and type" };

/** A ticket's key and status as people read it, such as `ENG-123 · In Progress`. */
export function ticketText(ticket: { key: string; status: TicketStatus | null; lastKnown?: boolean }): string {
  return ticket.status === null ? ticket.key : `${ticket.key} · ${ticket.status.label}${ticket.lastKnown === true ? " · last known" : ""}`;
}

/** Where tickets can be created: the backend offers tickets and the transport has them. */
export interface TicketsOffer {
  offered: TicketsConfig;
  /** Opens Your trackers, to connect a tracker first. */
  onYourTrackers: () => void;
  /** The signed-in person, so what the dialogs remember in this browser is theirs alone. */
  personId: string;
  /** The backend says which models the person's AI connection offers, and what each costs. */
  modelLists?: boolean;
  /** Opens Your AI, for a draft that needs the person's own AI first; null where they have none to set up. */
  onSetUpAi?: (() => void) | null;
}

/** The trackers the person has connected, in the order the backend offers them. */
export function connectedTrackers(offered: TicketsConfig, accounts: TrackerAccountView[]): TrackerAccountView[] {
  return offered.trackers.flatMap(({ id }) => accounts.filter((account) => account.tracker === id));
}

function StatusDot({ status }: { status: TicketStatus | null }) {
  return <span className={`ticket-dot ${status?.category ?? "unknown"}`} aria-hidden="true" />;
}

/**
 * What a chip says on hover: the ticket's title, tracker, and who linked it;
 * for a status Critiqs can no longer check, that it is the last one known and
 * why, with when it was last read.
 */
function chipTitle(ticket: TicketLinkView): string {
  const tracker = trackerLabel(ticket.tracker);
  const about = `${ticket.title} (${tracker}, linked by ${ticket.linkedByName})`;
  if (ticket.statusStale !== true || ticket.status === null) return about;
  const when = ticket.statusCheckedAt === null ? "" : ` from ${fullTime(ticket.statusCheckedAt)}`;
  return `${about}. Last known status${when}: Critiqs can't check it with ${ticket.linkedByName}'s ${tracker} account.`;
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
      {tickets.map((ticket) => {
        const title = chipTitle(ticket);
        const chip = (
          <>
            <TicketIcon size={14} />
            <span className="key">{ticket.key}</span>
            {ticket.status !== null && (
              <span className={ticket.statusStale === true ? "status stale" : "status"}>
                <StatusDot status={ticket.status} />
                {ticket.status.label}
                {ticket.statusStale === true && <span className="stale-note">· last known</span>}
              </span>
            )}
          </>
        );
        // Only a web address is a link: React doesn't refuse a `javascript:` one, whatever a backend sends.
        const href = webAddress(ticket.url);
        return (
          <li key={ticket._id} className="ticket-chip">
            {href === null ? (
              <span title={title}>{chip}</span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener" title={title}>
                {chip}
              </a>
            )}
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
        );
      })}
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

/** Critiqs's standard format, in the Template menu. */
const STANDARD = "";

/** What one request with the model costs, as the model menu says it: "about 6 credits"; null for an own key, which costs none. */
function draftCost(model: { credits?: number; estimated?: true } | undefined): string | null {
  if (model?.credits === undefined) return null;
  return `${model.estimated ? "About " : ""}${model.credits === 1 ? "1 credit" : `${model.credits} credits`}`;
}

/**
 * Creates a ticket from the thread: the tracker (among those connected), where
 * it goes (remembered per person, project, and tracker), and the title and
 * text filled from the thread, both editable, with **Created from Critiqs**
 * defaulting to the person's choice in Your trackers. When the person started
 * a ticket on the thread that didn't finish, the dialog finishes that one,
 * under its submission ID, rather than starting another.
 *
 * Where the backend drafts (`drafting`), it also offers the templates the
 * project turned on for the destination, which fill the draft without AI
 * when chosen; **Draft with Critiqs AI**, with its cost shown first, which
 * fills it from the thread and the chosen template, or says why it couldn't
 * and fills it without AI; and the destination's labels that match the
 * thread's tags, each removable.
 */
export function CreateTicketDialog({
  threadId,
  projectId,
  personId,
  accounts,
  drafting = false,
  modelLists = false,
  onSetUpAi = null,
  installUrls = {},
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
  /** The backend drafts with AI and from templates, and suggests labels. */
  drafting?: boolean;
  /** The backend says which models the person's AI connection offers, and what each costs. */
  modelLists?: boolean;
  /** Opens Your AI, which closes this dialog first; null where the person has none to set up. */
  onSetUpAi?: (() => void) | null;
  /** Where an organization installs a tracker's app to reach its repositories, by tracker (GitHub). */
  installUrls?: Partial<Record<TrackerId, string>>;
  onClose: () => void;
  onCreated: (ticket: TicketLinkView) => void;
  returnFocus?: HTMLElement | null;
}) {
  const transport = useTransport();
  const tickets = transport.tickets!;
  const [tracker, setTracker] = useState<TrackerId>(accounts[0]!.tracker);
  // Each tracker's destinations are its own: another tracker's are never used, even in the render after switching.
  const [loadedDestinations, setDestinations] = useState<{ tracker: TrackerId; loaded: Loaded<TicketDestination[]> }>({ tracker, loaded: { status: "loading" } });
  const destinations: Loaded<TicketDestination[]> = loadedDestinations.tracker === tracker ? loadedDestinations.loaded : { status: "loading" };
  const [remembered, remember] = useStoredState<string | null>(`critiqs:ticket-destination:${projectId}:${personId}:${tracker}`, null);
  /** Where the project's owners send this tracker's tickets by default, as the draft said; undefined until it loads for the tracker. */
  const [projectDefault, setProjectDefault] = useState<{ tracker: TrackerId; id: string | null } | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [attribution, setAttribution] = useState(accounts[0]!.attribution);
  // One submission per tracker while the dialog is open: every try sends its ID, so a retry never creates a second ticket.
  // The server names the person's unfinished one, which the dialog finishes instead of starting another.
  const submissions = useRef(new Map<TrackerId, string>());
  const [resuming, setResuming] = useState(false);
  /** What is filling the title and text: the thread without AI, Critiqs AI, or nothing. */
  const [filling, setFilling] = useState<"plain" | "ai" | null>("plain");
  /**
   * Whether the title and text are for a tracker or team no longer chosen,
   * or not loaded yet: their replacement is loading or couldn't load. Create
   * waits until a draft loads for the choice now.
   */
  const [stale, setStale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<TicketDraftOptions>({ templates: [], labels: [] });
  const [templateId, setTemplateId] = useState(STANDARD);
  /** A template whose draft is loading: it is chosen once its draft loads; if it can't load, the template and draft before it stay. */
  const [choosing, setChoosing] = useState<string | null>(null);
  const [labels, setLabels] = useState<TicketLabel[]>([]);
  /** Values for the destination's required fields, such as a Jira issue type's, by field ID. */
  const [fieldValues, setFieldValues] = useState<Record<string, TicketFieldValue>>({});
  /** What the last draft by Critiqs AI said: that it drafted, or why it couldn't, and whether setting up Your AI would let it. */
  const [aiNote, setAiNote] = useState<{ text: string; setUpAi: boolean } | null>(null);
  /** Answers to an earlier draft request are ignored once another starts. */
  const latestDraft = useRef(0);
  const titleId = useId();
  const bodyId = useId();

  // The models the person's AI connection offers here, for the cost and the model menu, as in Mockup mode.
  const choiceQuery = transport.useAiChoice(drafting && modelLists ? projectId : null);
  const choice = choiceQuery.status === "ready" ? choiceQuery.data : null;
  const [rememberedModel, rememberModel] = useStoredState<string | null>(`critiqs:ticket-model:${projectId}`, null);
  const models = choice?.models ?? [];
  const model = models.find((entry) => entry.id === rememberedModel) ?? models.find((entry) => entry.id === choice?.defaultModel) ?? models[0];
  // Where the backend lists models, a draft waits for the model and its cost, so a paid one never starts before its cost shows.
  const choiceLoaded = !modelLists || choice !== null;

  useEffect(() => {
    let cancelled = false;
    setDestinations({ tracker, loaded: { status: "loading" } });
    tickets.listTicketDestinations(tracker).then(
      (data) => !cancelled && setDestinations({ tracker, loaded: { status: "ready", data } }),
      (failure) => !cancelled && setDestinations({ tracker, loaded: { status: "error", message: errorMessage(failure) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [tickets, tracker]);

  /** Fills the title and text: without AI, or by Critiqs AI, which may say why it filled them without AI instead. A failed request keeps them, and says why. */
  function fill<T extends { title: string; body: string }>(by: "plain" | "ai", load: () => Promise<T>, after?: (draft: T) => void, failed?: () => void) {
    const request = ++latestDraft.current;
    setFilling(by);
    setError(null);
    load().then(
      (draft) => {
        if (latestDraft.current !== request) return;
        setTitle(draft.title);
        setBody(draft.body);
        setStale(false);
        after?.(draft);
        setFilling(null);
      },
      (failure) => {
        if (latestDraft.current !== request) return;
        setError(errorMessage(failure));
        failed?.();
        setFilling(null);
      },
    );
  }

  /**
   * Fills the standard format's draft for the tracker, in place of text for
   * another tracker or team: until it loads, Create waits, and if it can't
   * load, the dialog says why and offers Try again.
   */
  function replaceDraft(after?: (draft: TicketDraft) => void, failed?: () => void) {
    setStale(true);
    fill(
      "plain",
      () => tickets.ticketDraft(threadId, tracker),
      (draft) => {
        if (draft.resumeSubmissionId !== null) submissions.current.set(tracker, draft.resumeSubmissionId);
        setResuming(draft.resumeSubmissionId !== null);
        after?.(draft);
      },
      failed,
    );
  }

  useEffect(() => {
    setResuming(false);
    setTemplateId(STANDARD);
    setChoosing(null);
    setAiNote(null);
    replaceDraft(
      (draft) => {
        setAttribution(draft.createdFromCritiqs);
        setProjectDefault({ tracker, id: draft.projectDestinationId ?? null });
      },
      // Without the draft, the list starts at its first destination.
      () => setProjectDefault({ tracker, id: null }),
    );
    return () => {
      latestDraft.current++;
    };
    // `replaceDraft` only sets this dialog's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, threadId, tracker]);

  const options = destinations.status === "ready" ? destinations.data : [];
  // The person's own last choice here, else the project's default (known once the draft loads), else the first.
  const known = projectDefault?.tracker === tracker ? projectDefault.id : undefined;
  const mine = options.find((option) => option.id === remembered);
  const destination = mine ?? (known === undefined ? null : (options.find((option) => option.id === known) ?? options[0] ?? null));
  const destinationId = destination?.id ?? null;

  // The destination's templates and suggested labels; a template from another destination no longer applies.
  useEffect(() => {
    setOffer({ templates: [], labels: [] });
    setLabels([]);
    setFieldValues({});
    if (!drafting || destinationId === null) return;
    let cancelled = false;
    tickets.ticketDraftOptions(threadId, tracker, destinationId).then(
      (data) => {
        if (cancelled) return;
        setOffer(data);
        setLabels(data.labels);
      },
      // Templates and labels are extras: the draft works without them.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [tickets, drafting, threadId, tracker, destinationId]);

  const chooseDestination = (id: string) => {
    remember(id);
    // A template chosen, or any format still loading (whose failure would keep the template before it), belongs to the team before.
    if (choosing !== null || templateId !== STANDARD) {
      setChoosing(null);
      setTemplateId(STANDARD);
      setAiNote(null);
      replaceDraft();
    }
  };

  const chooseTemplate = (id: string) => {
    if (destinationId === null) return;
    setChoosing(id);
    fill(
      "plain",
      () => tickets.ticketDraft(threadId, tracker, id === STANDARD ? undefined : { destinationId, templateId: id }),
      () => {
        setTemplateId(id);
        setAiNote(null);
        setChoosing(null);
      },
      () => setChoosing(null),
    );
  };

  const draftWithAi = () => {
    if (destinationId === null || !choiceLoaded) return;
    setAiNote(null);
    fill(
      "ai",
      () => tickets.draftTicketWithAi({ threadId, tracker, destinationId, templateId: templateId === STANDARD ? null : templateId, ...(model === undefined ? {} : { model: model.id }) }),
      (draft) => setAiNote({ text: draft.notice ?? "Drafted by Critiqs AI from the thread. Check it before creating.", setUpAi: draft.noticeCode === "setup-ai" }),
    );
  };

  const fields = offer.fields ?? [];
  const unsupported = offer.unsupportedFields ?? [];
  const fieldsFilled = fields.every((field) => {
    const value = fieldValues[field.id];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value.trim() !== "";
  });
  const ready = destination !== null && filling === null && !stale && !busy && title.trim() !== "" && unsupported.length === 0 && fieldsFilled;
  const cost = draftCost(model);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const submissionId = submissions.current.get(tracker) ?? crypto.randomUUID();
    submissions.current.set(tracker, submissionId);
    try {
      const created = await tickets.createTicket({
        threadId,
        submissionId,
        tracker,
        destinationId: destination.id,
        title,
        body,
        createdFromCritiqs: attribution,
        // Older backends take neither.
        ...(templateId === STANDARD ? {} : { templateId }),
        ...(labels.length === 0 ? {} : { labelIds: labels.map((label) => label.id) }),
        ...(fields.length === 0 ? {} : { fields: Object.fromEntries(fields.map((field) => [field.id, fieldValues[field.id]!])) }),
      });
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
                  onChange={chooseDestination}
                />
              )
            }
          </SettingRow>
          {destinations.status === "ready" && options.length === 0 && (
            <p className="note">
              You have no {DESTINATION_LABEL[tracker].toLowerCase()} here that takes new tickets.
              {installUrls[tracker] !== undefined && (
                <>
                  {" "}
                  <a className="link-btn" href={installUrls[tracker]} target="_blank" rel="noreferrer noopener">
                    Install Critiqs on your repositories in GitHub
                  </a>
                </>
              )}
            </p>
          )}
          {offer.templates.length > 0 && (
            <SettingRow label="Template">
              {(labelId) => (
                <Select
                  value={choosing ?? templateId}
                  labelledBy={labelId}
                  disabled={busy || filling !== null}
                  options={[{ value: STANDARD, label: "Critiqs's standard format" }, ...offer.templates.map((template) => ({ value: template.id, label: template.name }))]}
                  onChange={chooseTemplate}
                />
              )}
            </SettingRow>
          )}
        </div>
        <label className="stacked" htmlFor={titleId}>
          <span className="field-label">Title</span>
          <input id={titleId} className="field" value={title} disabled={filling !== null || busy} placeholder={filling !== null ? "Filling from the thread…" : ""} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="stacked" htmlFor={bodyId}>
          <span className="field-label">Text</span>
          <textarea id={bodyId} className="field ticket-body" rows={9} value={body} disabled={filling !== null || busy} onChange={(event) => setBody(event.target.value)} />
        </label>
        {drafting && (
          <div className="ticket-ai">
            <button type="button" className="btn small" disabled={busy || filling !== null || destination === null || !choiceLoaded} onClick={draftWithAi}>
              {filling === "ai" ? "Drafting…" : "Draft with Critiqs AI"}
            </button>
            {models.length > 1 && model !== undefined && <ModelChoice models={models} value={model.id} onChange={rememberModel} />}
            {cost !== null && <span className="note">{cost}</span>}
            {choiceQuery.status === "error" && <span className="note">Couldn't load the AI's models.</span>}
          </div>
        )}
        {aiNote !== null &&
          (aiNote.setUpAi && onSetUpAi !== null ? (
            <div className="note row between">
              <span role="status">{aiNote.text}</span>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  onClose();
                  onSetUpAi();
                }}
              >
                Set up your AI
              </button>
            </div>
          ) : (
            <p className="note" role="status">
              {aiNote.text}
            </p>
          ))}
        {labels.length > 0 && (
          <div className="ticket-labels">
            <span className="field-label" id={`${titleId}-labels`}>
              Labels
            </span>
            <ul aria-labelledby={`${titleId}-labels`}>
              {labels.map((label) => (
                <li key={label.id} className="ticket-label">
                  {label.name}
                  <button type="button" className="icon-btn" aria-label={`Remove label ${label.name}`} disabled={busy} onClick={() => setLabels(labels.filter((each) => each.id !== label.id))}>
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {fields.length > 0 && (
          <RequiredFields fields={fields} values={fieldValues} disabled={busy} onChange={(id, value) => setFieldValues((values) => ({ ...values, [id]: value }))} />
        )}
        {unsupported.length > 0 && (
          <p className="error" role="alert">
            This {DESTINATION_LABEL[tracker].toLowerCase()} needs {unsupported.join(", ")}, which Critiqs can't fill yet. Choose another, or create this ticket in {trackerLabel(tracker)}.
          </p>
        )}
        <label className="ticket-check">
          <input type="checkbox" checked={attribution} disabled={busy} onChange={(event) => setAttribution(event.target.checked)} />
          Created from Critiqs
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {stale && filling === null && (
          <div className="note row between">
            <span>Create waits until the draft for this {DESTINATION_LABEL[tracker].toLowerCase()} loads.</span>
            <button type="button" className="btn small" disabled={busy} onClick={() => replaceDraft()}>
              Try again
            </button>
          </div>
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

/**
 * The fields the destination requires, such as a Jira issue type's: a line
 * or paragraph of text, a number, a date, or one or more of its options.
 * Create waits until each has a value.
 */
function RequiredFields({
  fields,
  values,
  disabled,
  onChange,
}: {
  fields: TicketField[];
  values: Record<string, TicketFieldValue>;
  disabled: boolean;
  onChange: (id: string, value: TicketFieldValue) => void;
}) {
  const baseId = useId();
  return (
    <div className="ticket-fields" role="group" aria-label="Required fields">
      {fields.map((field, index) => {
        const id = `${baseId}-${index}`;
        const value = values[field.id];
        const text = typeof value === "string" ? value : "";
        switch (field.kind) {
          case "choice":
            return (
              <SettingRow key={field.id} label={field.name}>
                {(labelId) => (
                  <Select
                    value={text}
                    labelledBy={labelId}
                    disabled={disabled}
                    options={[{ value: "", label: "Choose…" }, ...field.options.map((option) => ({ value: option.id, label: option.name }))]}
                    onChange={(next) => onChange(field.id, next)}
                  />
                )}
              </SettingRow>
            );
          case "choices": {
            const chosen = Array.isArray(value) ? value : [];
            return (
              <fieldset key={field.id} className="stacked">
                <legend className="field-label">{field.name}</legend>
                {field.options.map((option) => (
                  <label key={option.id} className="ticket-check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(option.id)}
                      disabled={disabled}
                      onChange={(event) => onChange(field.id, event.target.checked ? [...chosen, option.id] : chosen.filter((each) => each !== option.id))}
                    />
                    {option.name}
                  </label>
                ))}
              </fieldset>
            );
          }
          case "paragraph":
            return (
              <label key={field.id} className="stacked" htmlFor={id}>
                <span className="field-label">{field.name}</span>
                <textarea id={id} className="field" rows={3} value={text} disabled={disabled} onChange={(event) => onChange(field.id, event.target.value)} />
              </label>
            );
          default:
            return (
              <label key={field.id} className="stacked" htmlFor={id}>
                <span className="field-label">{field.name}</span>
                <input
                  id={id}
                  className="field"
                  type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"}
                  value={text}
                  disabled={disabled}
                  onChange={(event) => onChange(field.id, event.target.value)}
                />
              </label>
            );
        }
      })}
    </div>
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
