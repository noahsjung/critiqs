import { useEffect, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { SettingRow, Switch } from "./ds.tsx";

/** Resolve when done, as its own section of the Tickets tab, with what counts as done. */
export function ResolveWhenDoneSection({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  return (
    <div className="ds-page">
      <div className="ds-group">
        <ResolveWhenDoneRow projectId={projectId} notify={notify} />
      </div>
      <p className="note">Canceled tickets count as done. Reopening a ticket doesn't reopen its thread.</p>
    </div>
  );
}

/**
 * Resolve when done, in the project owner's ticket settings: resolves a
 * thread once every ticket linked to it is done or canceled. Off by default.
 * Saves at once with a toast, showing the new choice while it saves and until
 * the settings read it back; a failed save shows its error and puts the
 * switch back.
 */
export function ResolveWhenDoneRow({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  const tickets = useTransport().tickets;
  const settings = tickets?.useTicketSettings(projectId, true);
  const saved = settings?.status === "ready" ? settings.data.resolveWhenDone : undefined;
  // The choice being saved, or saved but not yet read back.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the settings read the choice back, they show it, and any later change.
  useEffect(() => {
    if (!busy && chosen !== null && saved === chosen) setChosen(null);
  }, [busy, chosen, saved]);
  if (tickets === undefined || settings === undefined) return null;
  if (settings.status === "error") return <p className="error">{settings.message}</p>;
  if (settings.status !== "ready") return <p className="note">Loading…</p>;
  const change = async (next: boolean) => {
    // One save at a time; the switch stays enabled, so focus stays on it while it saves.
    if (busy) return;
    setBusy(true);
    setChosen(next);
    setError(null);
    try {
      await tickets.setResolveWhenDone(projectId, next);
      notify(next ? "Threads now resolve when their tickets are done" : "Threads no longer resolve when their tickets are done");
    } catch (failure) {
      setChosen(null);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <SettingRow label="Resolve threads when their tickets are done">
        {(labelId) => <Switch checked={chosen ?? settings.data.resolveWhenDone} labelledBy={labelId} onChange={(next) => void change(next)} />}
      </SettingRow>
    </>
  );
}
