import { TRACKERS, type TicketDestination, type TicketTemplateChoice, type TicketTemplateSettings, type TrackerId, type TrackerTemplateGroup } from "@critiqs/core";
import { useEffect, useId, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { ResolveWhenDoneSection } from "./ResolveWhenDone.tsx";
import { Select, SettingRow, Switch } from "./ds.tsx";

// The project's ticket settings, for its owners, in the Tags and AI dialog's
// Tickets tab. Each setting is its own section, so others can sit beside it.

/**
 * The Tickets tab: the project's ticket settings, each only where the backend
 * has it. Settings for every tracker come first (whether templates are on,
 * Resolve when done); then one section per tracker the owner has connected,
 * titled with the tracker's name, holding where its tickets go by default and
 * which of its templates the project offers, so a tracker's teams or
 * repositories read as part of it.
 */
export function TicketsTab({
  projectId,
  notify,
  templates,
  resolveWhenDone,
  defaults = false,
}: {
  projectId: string;
  notify: (message: string) => void;
  templates: boolean;
  resolveWhenDone: boolean;
  /** The backend keeps where each tracker's tickets go by default (`tickets.defaultDestinations`). */
  defaults?: boolean;
}) {
  const tickets = useTransport().tickets!;
  const accounts = tickets.useTrackerAccounts(templates || defaults);
  const connected = accounts.status === "ready" ? TRACKERS.map((entry) => entry.id).filter((id) => accounts.data.some((account) => account.tracker === id)) : [];
  const templateSettings = useTemplateSettings(projectId, notify, templates);
  const on = templateSettings.settings?.on === true;
  return (
    <div className="ds-page">
      {templates && <TemplatesSwitch state={templateSettings} />}
      {resolveWhenDone && <ResolveWhenDoneSection projectId={projectId} notify={notify} />}
      {(defaults || (templates && on)) && accounts.status === "ready" && connected.length === 0 && (
        <p className="note">
          {defaults
            ? "Connect Linear, GitHub Issues, or Jira in Your trackers to choose where tickets go and your teams' templates."
            : "Connect Linear, GitHub Issues, or Jira in Your trackers to choose your teams' templates."}
        </p>
      )}
      {connected.map((tracker) =>
        !defaults && !(on && templates) ? null : (
          <section key={tracker} className="ds-section" aria-label={trackerName(tracker)}>
            <h4 className="ds-section-title">{trackerName(tracker)}</h4>
            {defaults && <DefaultDestinationRow projectId={projectId} tracker={tracker} notify={notify} />}
            {templates && on && templateSettings.settings !== null && (
              tracker === "jira" ? (
                <JiraTemplates settings={templateSettings.settings} busy={templateSettings.busy} onSave={templateSettings.save} />
              ) : (
                <TrackerTemplates projectId={projectId} tracker={tracker} state={templateSettings} />
              )
            )}
          </section>
        ),
      )}
    </div>
  );
}

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/** What each tracker calls where its tickets go, for the default's label. */
const DESTINATION_NOUNS: Record<TrackerId, string> = { linear: "team", github: "repository", jira: "project and issue type" };

/**
 * Where the project's new tickets go by default in one tracker: one of the
 * destinations the owner's own account there offers, or none, when each person
 * starts with their own last choice or the first in their list. Saves at once.
 * A default another owner chose that this owner can't see stays listed by the
 * name it was saved with.
 */
function DefaultDestinationRow({ projectId, tracker, notify }: { projectId: string; tracker: TrackerId; notify: (message: string) => void }) {
  const tickets = useTransport().tickets!;
  const settings = tickets.useTicketSettings(projectId, true);
  const [destinations, setDestinations] = useState<Loaded<TicketDestination[]>>({ status: "loading" });
  // The choice being saved, or saved but not yet read back; "" is none.
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const saved = settings.status === "ready" ? (settings.data.defaults ?? []).find((entry) => entry.tracker === tracker) : undefined;
  const savedId = saved?.destinationId ?? "";
  useEffect(() => {
    if (!busy && chosen !== null && savedId === chosen) setChosen(null);
  }, [busy, chosen, savedId]);
  const noun = DESTINATION_NOUNS[tracker];
  const label = `Default ${noun}`;
  if (settings.status === "error") return <p className="error">{settings.message}</p>;
  const options = destinations.status === "ready" ? destinations.data : [];
  const listed = [
    { value: "", label: "None", detail: "Each person's last choice" },
    ...(saved !== undefined && !options.some((option) => option.id === saved.destinationId) ? [{ value: saved.destinationId, label: saved.name }] : []),
    ...options.map((option) => ({ value: option.id, label: option.name })),
  ];
  const change = async (value: string) => {
    if (busy || value === (chosen ?? savedId)) return;
    setBusy(true);
    setChosen(value);
    setError(null);
    try {
      await tickets.setTicketDefaultDestination!(projectId, tracker, value === "" ? null : value);
      const name = listed.find((option) => option.value === value)?.label;
      notify(value === "" ? `New ${trackerName(tracker)} tickets have no default ${noun}` : `New ${trackerName(tracker)} tickets go to ${name} by default`);
    } catch (failure) {
      setChosen(null);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ds-group">
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <SettingRow label={label}>
        {(labelId) => (
          <Select
            value={chosen ?? savedId}
            labelledBy={labelId}
            disabled={busy || settings.status !== "ready" || destinations.status !== "ready"}
            options={listed}
            onChange={(value) => void change(value)}
          />
        )}
      </SettingRow>
      {destinations.status === "error" && <p className="error">{destinations.message}</p>}
      <p className="note">Create ticket starts here, unless the person chose another {noun} for this project before.</p>
    </div>
  );
}

/** Trackers whose templates Critiqs reads from the tracker. */
const TEMPLATE_PLACES: Partial<Record<TrackerId, { none: string; offer: string }>> = {
  linear: { none: "Your Linear teams have no issue templates yet.", offer: "for their team" },
  github: { none: "Your GitHub repositories have no issue templates or issue forms yet.", offer: "in their repository" },
};

const same = (a: TicketTemplateChoice, b: { tracker: TrackerId; destinationId: string; templateId: string }) =>
  a.tracker === b.tracker && a.destinationId === b.destinationId && a.templateId === b.templateId;

interface TemplateSettingsState {
  /** The settings as read, or as a save returned until read again; null while loading. */
  settings: TicketTemplateSettings | null;
  error: string | null;
  loadError: string | null;
  busy: boolean;
  save: (next: TicketTemplateSettings, done: string) => Promise<void>;
}

/** The project's template settings, and saving them with a toast; each change saves at once. */
function useTemplateSettings(projectId: string, notify: (message: string) => void, enabled: boolean): TemplateSettingsState {
  const tickets = useTransport().tickets!;
  const state = tickets.useTicketTemplateSettings(enabled ? projectId : null);
  // What a save returned, shown until the settings are read again.
  const [saved, setSaved] = useState<TicketTemplateSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = state.status === "ready" ? state.data : null;
  useEffect(() => setSaved(null), [read]);
  const save = async (next: TicketTemplateSettings, done: string) => {
    setBusy(true);
    setError(null);
    try {
      setSaved(await tickets.saveTicketTemplateSettings(projectId, next));
      notify(done);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return { settings: saved ?? read, error, loadError: state.status === "error" ? state.message : null, busy, save };
}

/**
 * Whether the Create dialog offers the team's own tracker templates: off by
 * default, when tickets use Critiqs's standard format. Which ones are chosen
 * in each tracker's section.
 */
function TemplatesSwitch({ state }: { state: TemplateSettingsState }) {
  const { settings, busy, save } = state;
  if (state.loadError !== null) return <p className="error">{state.loadError}</p>;
  if (settings === null) return <p className="note">Loading…</p>;
  return (
    <div className="ds-group">
      {state.error !== null && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <SettingRow label="Use the team's ticket templates">
        {(labelId) => (
          <Switch
            checked={settings.on}
            labelledBy={labelId}
            disabled={busy}
            onChange={(next) => void save({ on: next, templates: settings.templates }, next ? "Ticket templates turned on" : "Ticket templates turned off")}
          />
        )}
      </SettingRow>
    </div>
  );
}

/**
 * The templates the owner can see in one tracker that reads its own (their
 * Linear teams' templates, their GitHub repositories' issue templates and
 * forms), by team or repository, each turned on or off for Create ticket.
 */
function TrackerTemplates({ projectId, tracker, state }: { projectId: string; tracker: TrackerId; state: TemplateSettingsState }) {
  const tickets = useTransport().tickets!;
  const [loaded, setLoaded] = useState<Loaded<TrackerTemplateGroup[]>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: "loading" });
    tickets.listTrackerTemplates(projectId, tracker).then(
      (data) => !cancelled && setLoaded({ status: "ready", data }),
      (failure) => !cancelled && setLoaded({ status: "error", message: errorMessage(failure) }),
    );
    return () => {
      cancelled = true;
    };
  }, [tickets, projectId, tracker]);
  const settings = state.settings!;
  const place = TEMPLATE_PLACES[tracker]!;
  const toggle = (group: TrackerTemplateGroup, template: { id: string; name: string }, offer: boolean) => {
    const choice = { tracker, destinationId: group.destination.id, templateId: template.id, name: template.name };
    const templates = offer ? [...settings.templates.filter((each) => !same(each, choice)), choice] : settings.templates.filter((each) => !same(each, choice));
    void state.save({ on: true, templates }, offer ? `Offering ${template.name}` : `No longer offering ${template.name}`);
  };
  return (
    <div className="ds-page" role="group" aria-label={`${trackerName(tracker)} templates`}>
      {loaded.status === "loading" && <p className="note">Loading templates…</p>}
      {loaded.status === "error" && <p className="error">{loaded.message}</p>}
      {loaded.status === "ready" && loaded.data.length === 0 && <p className="note">{place.none}</p>}
      {loaded.status === "ready" && loaded.data.length > 0 && (
        <>
          <p className="note">Create ticket offers the templates turned on here, {place.offer}.</p>
          {loaded.data.map((group) => (
            <div key={group.destination.id} className="ds-group" role="group" aria-label={group.destination.name}>
              <div className="ds-group-label">{group.destination.name}</div>
              {group.from !== undefined && <p className="note">From {group.from}: this repository has no templates of its own, so GitHub uses these.</p>}
              {group.templates.map((template) => (
                <SettingRow key={template.id} label={template.name}>
                  {(labelId) => (
                    <Switch
                      checked={settings.templates.some((each) => same(each, { tracker, destinationId: group.destination.id, templateId: template.id }))}
                      labelledBy={labelId}
                      disabled={state.busy}
                      onChange={(offer) => toggle(group, template, offer)}
                    />
                  )}
                </SettingRow>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const trackerName = (tracker: TrackerId) => TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;

/**
 * Jira keeps no ticket templates of its own: owners paste a template's text
 * for a project and issue type, and Create ticket offers it there.
 */
function JiraTemplates({ settings, busy, onSave }: { settings: TicketTemplateSettings; busy: boolean; onSave: (next: TicketTemplateSettings, done: string) => Promise<void> }) {
  const tickets = useTransport().tickets!;
  const [destinations, setDestinations] = useState<Loaded<TicketDestination[]>>({ status: "loading" });
  const [destinationId, setDestinationId] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const nameId = useId();
  const bodyId = useId();
  useEffect(() => {
    let cancelled = false;
    tickets.listTicketDestinations("jira").then(
      (data) => !cancelled && setDestinations({ status: "ready", data }),
      (failure) => !cancelled && setDestinations({ status: "error", message: errorMessage(failure) }),
    );
    return () => {
      cancelled = true;
    };
  }, [tickets]);
  const pasted = settings.templates.filter((choice) => choice.tracker === "jira");
  const options = destinations.status === "ready" ? destinations.data : [];
  const chosen = options.find((option) => option.id === destinationId) ?? options[0] ?? null;
  const destinationName = (id: string) => options.find((option) => option.id === id)?.name ?? "A Jira project";
  const add = async () => {
    if (chosen === null || name.trim() === "" || body.trim() === "") return;
    const choice: TicketTemplateChoice = { tracker: "jira", destinationId: chosen.id, templateId: `pasted-${crypto.randomUUID()}`, name: name.trim(), body };
    await onSave({ on: true, templates: [...settings.templates, choice] }, `Offering ${choice.name}`);
    setName("");
    setBody("");
  };
  return (
    <div className="ds-group" role="group" aria-label="Jira templates">
      <div className="ds-group-label">Templates</div>
      <p className="note">Jira has no ticket templates of its own. Paste your team's description template for a project and issue type; Create ticket offers it there.</p>
      {pasted.map((choice) => (
        <div key={choice.templateId} className="ds-row">
          <span className="ds-row-label stacked">
            <span className="ellipsis">{choice.name}</span>
            <span className="note ellipsis">{destinationName(choice.destinationId)}</span>
          </span>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => void onSave({ on: true, templates: settings.templates.filter((each) => !same(each, choice)) }, `No longer offering ${choice.name}`)}
          >
            Remove
          </button>
        </div>
      ))}
      {destinations.status === "error" && <p className="error">{destinations.message}</p>}
      {destinations.status === "ready" && (
        <form
          className="stacked"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <SettingRow label="Project and type">
            {(labelId) => (
              <Select
                value={chosen?.id ?? ""}
                labelledBy={labelId}
                disabled={busy || options.length === 0}
                options={options.map((option) => ({ value: option.id, label: option.name }))}
                onChange={setDestinationId}
              />
            )}
          </SettingRow>
          <label className="stacked" htmlFor={nameId}>
            <span className="field-label">Template name</span>
            <input id={nameId} className="field" value={name} disabled={busy} placeholder="Bug report" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="stacked" htmlFor={bodyId}>
            <span className="field-label">Template text</span>
            <textarea id={bodyId} className="field" rows={5} value={body} disabled={busy} placeholder={"## What happened\n\n## Expected"} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="ds-actions">
            <button type="submit" className="btn small" disabled={busy || chosen === null || name.trim() === "" || body.trim() === ""}>
              Add template
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
