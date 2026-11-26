import { TRACKERS, type TicketDestination, type TicketTemplateChoice, type TicketTemplateSettings, type TrackerId, type TrackerTemplateGroup } from "@critiqs/core";
import { useEffect, useId, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { ResolveWhenDoneSection } from "./ResolveWhenDone.tsx";
import { Select, SettingRow, Switch } from "./ds.tsx";

// The project's ticket settings, for its owners, in the Tags and AI dialog's
// Tickets tab. Each setting is its own section, so others can sit beside it.

/**
 * The Tickets tab: the project's ticket settings, each its own section and
 * each only where the backend has it: templates first, then Resolve when done.
 */
export function TicketsTab({ projectId, notify, templates, resolveWhenDone }: { projectId: string; notify: (message: string) => void; templates: boolean; resolveWhenDone: boolean }) {
  return (
    <div className="ds-page">
      {templates && <TicketTemplatesSection projectId={projectId} notify={notify} />}
      {resolveWhenDone && <ResolveWhenDoneSection projectId={projectId} notify={notify} />}
    </div>
  );
}

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/** Trackers whose templates Critiqs reads from the tracker, in the order Your trackers offers them. */
const TEMPLATE_TRACKERS: readonly TrackerId[] = ["linear", "github"];

/** What each tracker calls where its templates live, for this tab's notes. */
const TEMPLATE_PLACES: Partial<Record<TrackerId, { none: string; offer: string }>> = {
  linear: { none: "Your Linear teams have no issue templates yet.", offer: "for their team" },
  github: { none: "Your GitHub repositories have no issue templates or issue forms yet.", offer: "in their repository" },
};

const same = (a: TicketTemplateChoice, b: { tracker: TrackerId; destinationId: string; templateId: string }) =>
  a.tracker === b.tracker && a.destinationId === b.destinationId && a.templateId === b.templateId;

/**
 * Whether the Create dialog offers the team's own tracker templates, and
 * which: off by default, when tickets use Critiqs's standard format. The
 * templates listed are those the owner can see with their own connected
 * accounts: their Linear teams' templates, and their GitHub repositories'
 * issue templates and forms. Each change saves at once.
 */
export function TicketTemplatesSection({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  const tickets = useTransport().tickets!;
  const state = tickets.useTicketTemplateSettings(projectId);
  const accounts = tickets.useTrackerAccounts(true);
  // What a save returned, shown until the settings are read again.
  const [saved, setSaved] = useState<TicketTemplateSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Partial<Record<TrackerId, Loaded<TrackerTemplateGroup[]>>>>({});
  const settings = saved ?? (state.status === "ready" ? state.data : null);
  const connected = accounts.status === "ready" ? TEMPLATE_TRACKERS.filter((tracker) => accounts.data.some((account) => account.tracker === tracker)) : [];
  const jira = accounts.status === "ready" ? accounts.data.some((account) => account.tracker === "jira") : false;
  const on = settings?.on === true;
  const connectedKey = connected.join(",");

  const read = state.status === "ready" ? state.data : null;
  useEffect(() => setSaved(null), [read]);
  useEffect(() => {
    if (!on || connected.length === 0) return;
    let cancelled = false;
    for (const tracker of connected) {
      setGroups((before) => ({ ...before, [tracker]: { status: "loading" } }));
      tickets.listTrackerTemplates(projectId, tracker).then(
        (data) => !cancelled && setGroups((before) => ({ ...before, [tracker]: { status: "ready", data } })),
        (failure) => !cancelled && setGroups((before) => ({ ...before, [tracker]: { status: "error", message: errorMessage(failure) } })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [tickets, projectId, on, connectedKey]);

  if (state.status === "error") return <p className="error">{state.message}</p>;
  if (settings === null) return <p className="note">Loading…</p>;

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

  const toggle = (tracker: TrackerId, group: TrackerTemplateGroup, template: { id: string; name: string }, offer: boolean) => {
    const choice = { tracker, destinationId: group.destination.id, templateId: template.id, name: template.name };
    const templates = offer ? [...settings.templates.filter((each) => !same(each, choice)), choice] : settings.templates.filter((each) => !same(each, choice));
    void save({ on: true, templates }, offer ? `Offering ${template.name}` : `No longer offering ${template.name}`);
  };

  return (
    <div className="ds-page">
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ds-group">
        <SettingRow label="Use the team's ticket templates">
          {(labelId) => (
            <Switch
              checked={on}
              labelledBy={labelId}
              disabled={busy}
              onChange={(next) => void save({ on: next, templates: settings.templates }, next ? "Ticket templates turned on" : "Ticket templates turned off")}
            />
          )}
        </SettingRow>
      </div>
      {on && connected.length === 0 && !jira && accounts.status === "ready" && (
        <p className="note">Connect Linear, GitHub Issues, or Jira in Your trackers to choose your teams' templates.</p>
      )}
      {on &&
        connected.map((tracker) => {
          const loaded = groups[tracker];
          const place = TEMPLATE_PLACES[tracker]!;
          return (
            <div key={tracker} className="ds-page" role="group" aria-label={`${trackerName(tracker)} templates`}>
              {connected.length > 1 && <h4 className="ds-group-label">{trackerName(tracker)}</h4>}
              {loaded?.status === "loading" && <p className="note">Loading templates…</p>}
              {loaded?.status === "error" && <p className="error">{loaded.message}</p>}
              {loaded?.status === "ready" && loaded.data.length === 0 && <p className="note">{place.none}</p>}
              {loaded?.status === "ready" && loaded.data.length > 0 && (
                <>
                  <p className="note">Create ticket offers the templates turned on here, {place.offer}.</p>
                  {loaded.data.map((group) => (
                    <div key={group.destination.id} className="ds-group" role="group" aria-label={group.destination.name}>
                      <div className="ds-group-label">{group.destination.name}</div>
                      {group.templates.map((template) => (
                        <SettingRow key={template.id} label={template.name}>
                          {(labelId) => (
                            <Switch
                              checked={settings.templates.some((each) => same(each, { tracker, destinationId: group.destination.id, templateId: template.id }))}
                              labelledBy={labelId}
                              disabled={busy}
                              onChange={(offer) => toggle(tracker, group, template, offer)}
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
        })}
      {on && jira && <JiraTemplates settings={settings} busy={busy} onSave={save} />}
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
      <div className="ds-group-label">Jira</div>
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
