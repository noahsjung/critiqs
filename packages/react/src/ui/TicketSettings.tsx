import type { TicketTemplateChoice, TicketTemplateSettings, TrackerTemplateGroup } from "@critiqs/core";
import { useEffect, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { SettingRow, Switch } from "./ds.tsx";

// The project's ticket settings, for its owners, in the Tags and AI dialog's
// Tickets tab. Each setting is its own section, so others can sit beside it.

/** The Tickets tab: the project's ticket settings, each its own section. */
export function TicketsTab({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  return <TicketTemplatesSection projectId={projectId} notify={notify} />;
}

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

const same = (a: TicketTemplateChoice, b: { destinationId: string; templateId: string }) => a.destinationId === b.destinationId && a.templateId === b.templateId;

/**
 * Whether the Create dialog offers the team's own Linear templates, and
 * which: off by default, when tickets use Critiqs's standard format. The
 * templates listed are those of the owner's own Linear teams; each change
 * saves at once.
 */
export function TicketTemplatesSection({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  const tickets = useTransport().tickets!;
  const state = tickets.useTicketTemplateSettings(projectId);
  const accounts = tickets.useTrackerAccounts(true);
  // What a save returned, shown until the settings are read again.
  const [saved, setSaved] = useState<TicketTemplateSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Loaded<TrackerTemplateGroup[]> | null>(null);
  const settings = saved ?? (state.status === "ready" ? state.data : null);
  const linear = accounts.status === "ready" ? accounts.data.some((account) => account.tracker === "linear") : false;
  const on = settings?.on === true;

  const read = state.status === "ready" ? state.data : null;
  useEffect(() => setSaved(null), [read]);
  useEffect(() => {
    if (!on || !linear) return;
    let cancelled = false;
    setGroups({ status: "loading" });
    tickets.listTrackerTemplates(projectId, "linear").then(
      (data) => !cancelled && setGroups({ status: "ready", data }),
      (failure) => !cancelled && setGroups({ status: "error", message: errorMessage(failure) }),
    );
    return () => {
      cancelled = true;
    };
  }, [tickets, projectId, on, linear]);

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

  const toggle = (group: TrackerTemplateGroup, template: { id: string; name: string }, offer: boolean) => {
    const choice = { tracker: "linear" as const, destinationId: group.destination.id, templateId: template.id, name: template.name };
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
      {on && !linear && accounts.status === "ready" && <p className="note">Connect Linear in Your trackers to choose your teams' templates.</p>}
      {on && linear && groups?.status === "loading" && <p className="note">Loading templates…</p>}
      {on && linear && groups?.status === "error" && <p className="error">{groups.message}</p>}
      {on && linear && groups?.status === "ready" && groups.data.length === 0 && <p className="note">Your Linear teams have no issue templates yet.</p>}
      {on && linear && groups?.status === "ready" && groups.data.length > 0 && (
        <>
          <p className="note">Create ticket offers the templates turned on here, for their team.</p>
          {groups.data.map((group) => (
            <div key={group.destination.id} className="ds-group" role="group" aria-label={group.destination.name}>
              <div className="ds-group-label">{group.destination.name}</div>
              {group.templates.map((template) => (
                <SettingRow key={template.id} label={template.name}>
                  {(labelId) => (
                    <Switch
                      checked={settings.templates.some((each) => same(each, { destinationId: group.destination.id, templateId: template.id }))}
                      labelledBy={labelId}
                      disabled={busy}
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
