import { TRACKERS, type TicketTemplateChoice, type TicketTemplateSettings, type TrackerId, type TrackerTemplateGroup } from "@critiqs/core";
import { useEffect, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { ResolveWhenDoneSection } from "./ResolveWhenDone.tsx";
import { SettingRow, Switch } from "./ds.tsx";

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
      {on && connected.length === 0 && accounts.status === "ready" && (
        <p className="note">Connect {TEMPLATE_TRACKERS.map(trackerName).join(" or ")} in Your trackers to choose your teams' templates.</p>
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
    </div>
  );
}

const trackerName = (tracker: TrackerId) => TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;
