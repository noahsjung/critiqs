import type { PersonalAiSettingsView } from "@critiqs/core";
import { useEffect, useRef, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { type ConnectionDraft, connectionDraftOf, connectionInput, managedOptions, keyName, OwnKeySetup, PlanCredits } from "./AiConnectionForm.tsx";
import { Dialog } from "./common.tsx";
import { DialogHeader, NavRow, Select, SettingRow, usePageFocus } from "./ds.tsx";

/**
 * The signed-in person's own AI: Critiqs AI on their own plan, which everyone
 * has until they choose otherwise, or their own API key, set up in steps.
 * Projects whose AI usage rule allows it use it for AI the person starts.
 * Each change saves at once. `modelLists`: the backend lists providers'
 * models, so an own key's models are picked from its list.
 */
export function YourAiDialog({ onClose, notify, modelLists = false }: { onClose: () => void; notify: (message: string) => void; modelLists?: boolean }) {
  const transport = useTransport();
  const state = transport.usePersonalAiSettings(true);
  const usage = transport.usePersonalAiUsage(true);
  // What a save or Remove returned, shown until the settings are read again.
  const [returned, setReturned] = useState<{ view: PersonalAiSettingsView; over: PersonalAiSettingsView } | null>(null);
  const [page, setPage] = useState<"main" | "key">("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // The confirmation takes focus; Keep key gives it back to the row that asked.
  const asked = useRef(false);
  useEffect(() => {
    if (confirmRemove) keepButton.current?.focus();
    else if (asked.current) card.current?.querySelector<HTMLElement>(".ds-nav-row")?.focus();
    asked.current = confirmRemove;
  }, [confirmRemove]);
  // Back from setting up a key, the first setting takes focus.
  const mainRef = useRef<HTMLDivElement>(null);
  usePageFocus(mainRef, page);

  const body = (() => {
    if (state.status === "error") return <p className="error">{state.message}</p>;
    if (state.status === "loading") return <p className="note">Loading…</p>;
    const view = returned !== null && returned.over === state.data ? returned.view : state.data;
    const draft = personalDraftOf(view);
    const managed = view.deployment.managed;
    const models = view.deployment.managedModels ?? [];
    const own = view.mode === "own" && view.provider !== null;
    const plans = usage.status === "ready" ? usage.data : null;
    const show = (next: PersonalAiSettingsView) => setReturned({ view: next, over: state.data });
    /** Saves a change at once; false when the server refused it, with its reason shown. */
    const commit = async (next: ConnectionDraft): Promise<boolean> => {
      // One save at a time; controls stay enabled, so focus stays on them while it saves.
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        const saved = await transport.savePersonalAiSettings(connectionInput(next, view, { withModels: modelLists }));
        show(saved);
        notify(saved.status.ready ? "Your AI saved" : `Your AI saved. ${saved.status.reason}`);
        return true;
      } catch (failure) {
        // Such as a plan without personal Critiqs AI: the server says why.
        setError(errorMessage(failure));
        return false;
      } finally {
        setBusy(false);
      }
    };
    /** Another page starts without the last page's error. */
    const go = (next: "main" | "key") => {
      setError(null);
      setConfirmRemove(false);
      setPage(next);
    };
    const remove = async () => {
      setBusy(true);
      setError(null);
      try {
        show(await transport.removePersonalAiSettings());
        // Removed, the row that asked is gone; the dialog keeps focus instead.
        asked.current = false;
        setConfirmRemove(false);
        notify(managed ? "Your key was removed. Critiqs AI is back on." : "Your key was removed.");
        // The rows that held focus are gone; the dialog keeps it.
        card.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    };

    if (page === "key") {
      return (
        <OwnKeySetup
          view={view}
          draft={draft}
          busy={busy}
          error={error}
          clearError={() => setError(null)}
          loadModels={modelLists ? (request) => transport.listPersonalAiModels(request) : undefined}
          onExit={() => go("main")}
          onSave={(next) => void commit(next).then((ok) => ok && setPage("main"))}
        />
      );
    }

    const chosen = models.find((entry) => entry.id === draft.managedModel);
    // Saved settings that don't work, which saving the shown choice fixes.
    const fixable = view.saved && view.enabled && !view.status.ready && view.mode === "managed" && managed && chosen !== undefined;
    return (
      <div ref={mainRef} className="ds-page">
        <DialogHeader title="Your AI" onClose={onClose} />
        {view.saved && !view.enabled && (
          <div className="warning row between" role="status">
            <span>Your AI is off.</span>
            <button type="button" className="btn small" disabled={busy} onClick={() => void commit(draft)}>
              Turn on
            </button>
          </div>
        )}
        {view.saved && view.enabled && !view.status.ready && (
          <div className="warning row between" role="status">
            <span>{view.status.reason}</span>
            {fixable && (
              <button type="button" className="btn small" disabled={busy} onClick={() => void commit(draft)}>
                Use {chosen.label}
              </button>
            )}
          </div>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {own ? (
          <div className="ds-group">
            <SettingRow label="Model">
              {(labelId) => (
                <Select
                  value={draft.model}
                  options={draft.models.map((model) => ({ value: model, label: model }))}
                  labelledBy={labelId}
                  onChange={(model) => void commit({ ...draft, model })}
                />
              )}
            </SettingRow>
            <NavRow label={keyName(view.provider!)} value={view.keyHint === null ? undefined : `····${view.keyHint}`} onClick={() => go("key")} />
          </div>
        ) : (
          managed && (
            <div className="ds-group">
              <SettingRow label="Model">
                {(labelId) =>
                  models.length > 1 ? (
                    <Select
                      value={draft.managedModel}
                      options={managedOptions(models)}
                      labelledBy={labelId}
                      onChange={(managedModel) => void commit({ ...draft, mode: "managed", managedModel })}
                    />
                  ) : (
                    <span aria-labelledby={labelId}>{models[0]?.label ?? "Critiqs AI"}</span>
                  )
                }
              </SettingRow>
              {plans !== null && <PlanCredits plan={plans.plan} rows={plans.rows} upgradeUrl={plans.upgradeUrl} organizationId={plans.organizationId} whose="person" />}
            </div>
          )
        )}
        <div ref={card} className="ds-group">
          {/* A divider only where two groups meet. */}
          {(own || managed) && <hr className="ds-divider" />}
          {!own ? (
            <NavRow label="Use your own API key" onClick={() => go("key")} />
          ) : confirmRemove ? (
            <div className="warning stacked" role="alert">
              <span>{managed ? "Remove your key and use Critiqs AI?" : "Remove your key?"}</span>
              <div className="row end">
                <button ref={keepButton} type="button" className="btn small" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Keep key
                </button>
                <button type="button" className="btn small danger solid" disabled={busy} onClick={() => void remove()}>
                  {busy ? "Removing…" : "Remove key"}
                </button>
              </div>
            </div>
          ) : (
            <NavRow label={managed ? "Use Critiqs AI instead" : "Remove key"} onClick={() => setConfirmRemove(true)} />
          )}
        </div>
      </div>
    );
  })();

  return (
    <Dialog label="Your AI" onClose={onClose}>
      {state.status === "ready" ? body : (
        <div className="ds-page">
          <DialogHeader title="Your AI" onClose={onClose} />
          {body}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The person's settings as a draft: always on, since turning their own AI off
 * is done by removing it. A connection saved off is turned on by saving this.
 */
function personalDraftOf(view: PersonalAiSettingsView): ConnectionDraft {
  return { ...connectionDraftOf(view), enabled: true };
}
