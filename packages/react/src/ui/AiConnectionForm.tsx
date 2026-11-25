import {
  AI_PROVIDERS,
  type AiConnectionInput,
  type AiMode,
  type AiModelListDraft,
  type AiModelListResult,
  type AiProvider,
  type AiSettingsView,
  BASE_AI_PROVIDERS,
  type ManagedModelInfo,
} from "@critiqs/core";
import { type KeyboardEvent, useRef, useState } from "react";
import { errorMessage } from "../transport.ts";
import { DialogHeader, Meter, NavRow, type SelectOption, SettingRow, usePageFocus } from "./ds.tsx";
import { UpgradeButton } from "./BillingDialog.tsx";

/** What the connection form needs from a project's settings or a person's own; older backends leave out the model lists. */
export type ConnectionView = Pick<AiSettingsView, "enabled" | "mode" | "managedModel" | "provider" | "model" | "models" | "baseUrl" | "keyHint" | "deployment">;

/** Lists a provider's models for the form: the project's or the person's own call. */
export type LoadModels = (draft: AiModelListDraft) => Promise<AiModelListResult>;

/** Most models one connection may offer, as the backend allows. */
export const MAX_PICKED_MODELS = 50;
/** Most model rows shown at once; searching finds the rest. */
const SHOWN_MODELS = 200;

/** One connection's settings as being edited. */
export interface ConnectionDraft {
  enabled: boolean;
  mode: AiMode;
  /** The chosen Critiqs AI model's id; empty where the backend lists none. */
  managedModel: string;
  provider: AiProvider | "";
  /** The own key's default model, always one of `models` where the backend lists models. */
  model: string;
  /** The own key's models a request may choose among. */
  models: string[];
  baseUrl: string;
  apiKey: string;
}

export function connectionDraftOf(view: ConnectionView): ConnectionDraft {
  const models = view.deployment.managedModels ?? [];
  const managedModel = models.some((entry) => entry.id === view.managedModel) ? view.managedModel! : (models[0]?.id ?? "");
  return {
    enabled: view.enabled,
    mode: view.mode,
    managedModel,
    provider: view.provider ?? "",
    model: view.model ?? "",
    models: view.models !== undefined && view.models.length > 0 ? view.models : view.model ? [view.model] : [],
    baseUrl: view.baseUrl ?? "",
    apiKey: "",
  };
}

/** Whether Critiqs sets a provider's address, so owners don't enter one. */
const fixedAddress = (provider: AiProvider | "") => AI_PROVIDERS.find((entry) => entry.id === provider)?.address === "fixed";

/** The address a draft would save, as the server compares it: none for a fixed address, and no trailing slash. */
function draftAddress(draft: Pick<ConnectionDraft, "provider" | "baseUrl">): string | null {
  if (fixedAddress(draft.provider)) return null;
  return draft.baseUrl.trim().replace(/\/+$/, "") || null;
}

/** Whether the saved connection's key and models belong to this provider and address; the server uses them only then. */
function savedConnectionFits(view: ConnectionView, draft: Pick<ConnectionDraft, "provider" | "baseUrl">): boolean {
  return view.provider !== null && draft.provider === view.provider && draftAddress(draft) === (view.baseUrl?.replace(/\/+$/, "") || null);
}

/**
 * The model fields for a newly chosen provider: the saved ones when it is the
 * saved provider at the saved address, otherwise none, so one provider's
 * models are never offered as another's.
 */
export function modelsForProvider(view: ConnectionView, draft: Pick<ConnectionDraft, "provider" | "baseUrl">): Pick<ConnectionDraft, "model" | "models"> {
  if (!savedConnectionFits(view, draft) || view.model === null) return { model: "", models: [] };
  return { model: view.model, models: view.models !== undefined && view.models.length > 0 ? view.models : [view.model] };
}

/**
 * The draft as a save or test sends it. A key is sent only when one was
 * typed. The Critiqs AI model is sent only when there was one to choose, so
 * a deployment's only model isn't saved as a choice that would outlast it;
 * with one model, a saved model it no longer offers is reset to it. The
 * picked models are sent only with `withModels`, where the backend lists
 * providers' models. Turned off, it sends the saved connection unchanged, so
 * nothing typed is sent or checked, and turning it on again needs nothing
 * re-entered.
 */
export function connectionInput(draft: ConnectionDraft, saved: ConnectionView, { withModels = false }: { withModels?: boolean } = {}): AiConnectionInput {
  if (!draft.enabled) {
    // A save for an own key without its provider would remove the saved key.
    const own = saved.mode === "own" && saved.provider !== null;
    return { enabled: false, mode: saved.mode, ...(own ? { provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl } : {}) };
  }
  return {
    enabled: draft.enabled,
    mode: draft.mode,
    ...(draft.mode === "managed" ? managedModelInput(draft, saved) : {}),
    ...(draft.mode === "own"
      ? {
          provider: draft.provider === "" ? null : draft.provider,
          model: draft.model.trim() === "" ? null : draft.model.trim(),
          ...(withModels && draft.provider !== "" ? { models: draft.models } : {}),
          baseUrl: draft.baseUrl.trim() === "" || fixedAddress(draft.provider) ? null : draft.baseUrl.trim(),
          ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey.trim() }),
        }
      : {}),
  };
}

function managedModelInput(draft: ConnectionDraft, saved: ConnectionView): Pick<AiConnectionInput, "managedModel"> {
  const offered = (saved.deployment.managedModels ?? []).map((entry) => entry.id);
  if (offered.length > 1) return draft.managedModel === "" ? {} : { managedModel: draft.managedModel };
  const replaced = offered.length === 1 && saved.managedModel != null && !offered.includes(saved.managedModel);
  return replaced ? { managedModel: null } : {};
}

/** What one request with a Critiqs AI model costs, such as "5 credits", or "about 5 credits" for a model charged by its token use. */
export function credits(model: Pick<ManagedModelInfo, "credits" | "estimated">): string {
  const amount = model.credits === 1 ? "1 credit" : `${model.credits} credits`;
  return model.estimated ? `about ${amount}` : amount;
}

/** Critiqs AI's models as a `Select` offers them: by name, with the cost in the open menu. */
export function managedOptions(models: readonly ManagedModelInfo[]): SelectOption[] {
  return models.map((model) => ({ value: model.id, label: model.label, detail: credits(model) }));
}

export const providerLabel = (provider: AiProvider) => AI_PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;

/** What a saved own connection is called in a row: "OpenAI key", or "Your endpoint". */
export const keyName = (provider: AiProvider) => (provider === "compatible" ? "Your endpoint" : `${providerLabel(provider)} key`);

/** Where each provider hands out keys, for "Get a key". */
const KEY_PAGES: Partial<Record<AiProvider, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
};

/** Critiqs AI credits a plan counts in one period. */
export interface CreditsRow {
  period: "total" | "month" | "day";
  used: number;
  /** What the plan includes. */
  max: number;
  /** Extra credits allowed past `max`; a null cap allows any. */
  overage?: { cap: number | null };
}

const PERIOD_WORDS: Record<CreditsRow["period"], string> = { day: "today", month: "this month", total: "in total" };
const PERIOD_ORDER: CreditsRow["period"][] = ["day", "month", "total"];

/** The most credits a row allows, or null when there is no cap. */
const ceiling = (row: CreditsRow) => (row.overage === undefined ? row.max : row.overage.cap === null ? null : row.max + row.overage.cap);

function creditsText(row: CreditsRow): string {
  const used = `${row.used.toLocaleString("en-US")} of ${row.max.toLocaleString("en-US")} ${row.max === 1 ? "credit" : "credits"} used ${PERIOD_WORDS[row.period]}`;
  if (row.overage === undefined) return used;
  const extra = Math.max(0, row.used - row.max).toLocaleString("en-US");
  return `${used} · ${extra} extra, ${row.overage.cap === null ? "no cap" : `up to ${row.overage.cap.toLocaleString("en-US")}`}`;
}

/**
 * The plan Critiqs AI is counted against: its name with Upgrade, where the
 * deployment names an upgrade page, and the credits used in the period
 * nearest its limit, with extra credits past what the plan includes. `whose`
 * words a plan without the credits.
 */
export function PlanCredits({
  plan,
  rows,
  upgradeUrl,
  organizationId,
  whose,
}: {
  plan: string;
  rows: readonly CreditsRow[];
  upgradeUrl?: string;
  organizationId?: string;
  whose: "person" | "project";
}) {
  const none = rows.some((row) => ceiling(row) === 0);
  const sorted = [...rows].sort((a, b) => PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period));
  // A capped row is measured against everything it allows; an uncapped one against what the plan includes.
  const measured = sorted.map((row) => ({ row, of: ceiling(row) ?? row.max }));
  const fullest = measured.length === 0 ? null : measured.reduce((most, next) => (next.row.used / next.of > most.row.used / most.of ? next : most));
  const full = !none && rows.some((row) => row.used >= (ceiling(row) ?? Number.POSITIVE_INFINITY));
  return (
    <div className="ds-group">
      <SettingRow label={`${plan} plan`}>{() => <UpgradeButton upgradeUrl={upgradeUrl} organizationId={organizationId} className="btn small" />}</SettingRow>
      {none ? (
        <p className="warning" role="status">
          {whose === "person" ? `The ${plan} plan doesn't include your own Critiqs AI.` : `The ${plan} plan doesn't include Critiqs AI.`}
        </p>
      ) : (
        fullest !== null && (
          <div className="stacked">
            <Meter value={fullest.row.used} max={fullest.of} label={`Credits used ${PERIOD_WORDS[fullest.row.period]}`} />
            <span className={full ? "error" : "note"} role={full ? "status" : undefined}>
              {sorted.map(creditsText).join(" · ")}
            </span>
          </div>
        )
      )}
    </div>
  );
}

/** The own key being set up, step by step. */
interface KeyDraft {
  provider: AiProvider | "";
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
}

/**
 * Setting up an own API key in steps, inside the dialog: the provider, then
 * its key (and address, where one is needed), then the models to offer. With
 * `loadModels`, the key step loads the provider's models, which checks the
 * key; without it, the key step takes the model's name and saves. `onSave`
 * gets the whole draft; `onExit` leaves without saving.
 */
export function OwnKeySetup({
  view,
  draft,
  onSave,
  onExit,
  loadModels,
  busy,
  error,
  clearError,
}: {
  view: ConnectionView;
  draft: ConnectionDraft;
  onSave: (draft: ConnectionDraft) => void;
  onExit: () => void;
  loadModels?: LoadModels;
  busy: boolean;
  /** A failed save's reason, shown on the step it failed on. */
  error: string | null;
  clearError: () => void;
}) {
  const accepted = view.deployment.providers ?? BASE_AI_PROVIDERS;
  const providers = AI_PROVIDERS.filter((entry) => accepted.includes(entry.id) || entry.id === draft.provider);
  const [step, setStep] = useState<1 | 2 | 3>(draft.mode === "own" && draft.provider !== "" ? 2 : 1);
  const [key, setKey] = useState<KeyDraft>({ provider: draft.provider, baseUrl: draft.baseUrl, apiKey: "", model: draft.model, models: draft.models });
  const [listed, setListed] = useState<AiModelListResult | null>(null);
  const [loading, setLoading] = useState(false);
  /** The latest model list asked for; one that finishes after the key or address changed is ignored. */
  const latest = useRef(0);
  const count = loadModels === undefined ? 2 : 3;
  // Each step takes focus, since the control that opened it is gone.
  const pageRef = useRef<HTMLDivElement>(null);
  usePageFocus(pageRef, step, { initial: true });
  const info = AI_PROVIDERS.find((entry) => entry.id === key.provider);
  const keyKept = view.keyHint !== null && savedConnectionFits(view, key);
  const addressShown = key.provider === "compatible" || (info?.address === "optional" && (view.deployment.allowedEndpoints.length > 0 || key.baseUrl !== ""));
  const needsAddress = info?.address === "required" && draftAddress(key) === null;
  const needsKey = info?.needsKey === true && key.apiKey.trim() === "" && !keyKept;
  const save = (picked: Pick<KeyDraft, "model" | "models">) => onSave({ ...draft, enabled: true, mode: "own", ...key, ...picked });
  /** Another step starts without the last one's error. */
  const goStep = (next: 1 | 2 | 3) => {
    clearError();
    setStep(next);
  };
  /** Forgets a model list still loading, whose key, address, or provider no longer applies. */
  const forgetList = () => {
    latest.current++;
    setLoading(false);
    setListed(null);
  };

  if (step === 1) {
    return (
      <div ref={pageRef} className="ds-page">
        <DialogHeader title="Choose a provider" onBack={onExit} step={{ current: 1, count }} />
        <div className="ds-group">
          {providers.map((entry) => (
            <NavRow
              key={entry.id}
              label={entry.id === "compatible" ? "Other (OpenAI-compatible)" : entry.label}
              onClick={() => {
                // Another provider starts over: its address, key, and models are its own, or the saved ones when it is the saved provider.
                if (entry.id !== key.provider) {
                  const baseUrl = entry.address !== "fixed" && entry.id === view.provider ? (view.baseUrl ?? "") : "";
                  setKey({ provider: entry.id, baseUrl, apiKey: "", ...modelsForProvider(view, { provider: entry.id, baseUrl }) });
                }
                forgetList();
                goStep(2);
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (step === 2) {
    const next = async () => {
      // Enter submits as the button would, so the same conditions hold.
      if (needsAddress || needsKey || loading || busy || (loadModels === undefined && key.model.trim() === "")) return;
      if (loadModels === undefined) return save({ model: key.model.trim(), models: key.model.trim() === "" ? [] : [key.model.trim()] });
      const run = ++latest.current;
      setLoading(true);
      let result: AiModelListResult;
      try {
        result = await loadModels({ provider: key.provider as AiProvider, baseUrl: draftAddress(key), ...(key.apiKey.trim() === "" ? {} : { apiKey: key.apiKey.trim() }) });
      } catch (failure) {
        result = { ok: false, code: "unknown", message: errorMessage(failure) };
      }
      if (run !== latest.current) return;
      setLoading(false);
      setListed(result);
      // A list that loads checked the key; a provider that has no list goes on to naming models by hand.
      if (result.ok || result.code === "capability") goStep(3);
    };
    return (
      <div ref={pageRef}>
      <form
        className="ds-page"
        onSubmit={(event) => {
          event.preventDefault();
          void next();
        }}
      >
        <DialogHeader title={key.provider === "compatible" ? "Connect your endpoint" : `Add your ${providerLabel(key.provider as AiProvider)} key`} onBack={() => {
            forgetList();
            goStep(1);
          }} step={{ current: 2, count }} />
        {/* An endpoint's address comes first; another provider's optional address after its key. */}
        {addressShown && key.provider === "compatible" && (
          <label className="stacked">
            <span className="field-label">Endpoint address</span>
            <input
              className="field"
              value={key.baseUrl}
              placeholder="https://llm.example.com/v1"
              onChange={(event) => {
                // At another address it is another connection: the saved key and its models don't apply. A key typed here is for this address, so it stays.
                setKey({ ...key, baseUrl: event.target.value, ...modelsForProvider(view, { provider: key.provider, baseUrl: event.target.value }) });
                forgetList();
              }}
            />
          </label>
        )}
        <label className="stacked">
          <span className="field-label">API key{info?.needsKey ? "" : " (if it needs one)"}</span>
          <input
            className="field"
            type="password"
            autoComplete="off"
            value={key.apiKey}
            disabled={!view.deployment.keysStorable}
            placeholder={keyKept ? `Saved key ending in ${view.keyHint}` : "Paste the key"}
            onChange={(event) => {
              setKey({ ...key, apiKey: event.target.value });
              forgetList();
            }}
          />
        </label>
        {addressShown && key.provider !== "compatible" && (
          <label className="stacked">
            <span className="field-label">Endpoint address (optional)</span>
            <input
              className="field"
              value={key.baseUrl}
              placeholder="https://llm.example.com/v1"
              onChange={(event) => {
                // At another address it is another connection: the saved key and its models don't apply. A key typed here is for this address, so it stays.
                setKey({ ...key, baseUrl: event.target.value, ...modelsForProvider(view, { provider: key.provider, baseUrl: event.target.value }) });
                forgetList();
              }}
            />
          </label>
        )}
        {!view.deployment.keysStorable && <p className="warning">This deployment can't store keys until its operator sets CRITIQS_AI_ENCRYPTION_KEY.</p>}
        {loadModels === undefined && (
          <label className="stacked">
            <span className="field-label">Model</span>
            <input className="field" value={key.model} maxLength={200} placeholder="gpt-6.2-sol" onChange={(event) => setKey({ ...key, model: event.target.value })} />
          </label>
        )}
        {listed?.ok === false && (
          <p className="error" role="status">
            {listed.message}
          </p>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="ds-actions between">
          {KEY_PAGES[key.provider as AiProvider] !== undefined ? (
            <a className="link-btn" href={KEY_PAGES[key.provider as AiProvider]} target="_blank" rel="noreferrer noopener">
              Get a key
            </a>
          ) : (
            <span />
          )}
          <div className="row">
            {listed?.ok === false && (
              <button type="button" className="btn" onClick={() => goStep(3)}>
                Name models instead
              </button>
            )}
            <button type="submit" className="btn primary" disabled={needsAddress || needsKey || loading || busy || (loadModels === undefined && key.model.trim() === "")}>
              {loading ? "Checking…" : loadModels === undefined ? (busy ? "Saving…" : "Save key") : "Continue"}
            </button>
          </div>
        </div>
      </form>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="ds-page">
      <DialogHeader title="Choose models" onBack={() => goStep(2)} step={{ current: 3, count }} />
      {listed?.ok !== true && <p className="note">Add the names of the models to offer.</p>}
      <ModelPicker
        picked={key.models}
        listed={listed?.ok === true ? listed : null}
        onChange={(models) => setKey({ ...key, models, model: models.includes(key.model) ? key.model : (models[0] ?? "") })}
      />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ds-actions">
        <button type="button" className="btn primary" disabled={key.models.length === 0 || busy} onClick={() => save({ model: key.model, models: key.models })}>
          {busy ? "Saving…" : "Save key"}
        </button>
      </div>
    </div>
  );
}

/**
 * An own key's models to offer: the provider's list to search and tick, and
 * names typed by hand where it has none. The picked ones come first.
 */
function ModelPicker({ picked, listed, onChange }: { picked: string[]; listed: Extract<AiModelListResult, { ok: true }> | null; onChange: (models: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const full = picked.length >= MAX_PICKED_MODELS;
  const loaded = listed?.models ?? [];
  const labels = new Map(loaded.map((entry) => [entry.id, entry.label]));
  const rows = [...picked, ...loaded.map((entry) => entry.id).filter((id) => !picked.includes(id))];
  const needle = query.trim().toLowerCase();
  const matching = needle === "" ? rows : rows.filter((id) => id.toLowerCase().includes(needle) || (labels.get(id) ?? "").toLowerCase().includes(needle));
  const shown = matching.slice(0, SHOWN_MODELS);
  const toggle = (id: string) => onChange(picked.includes(id) ? picked.filter((entry) => entry !== id) : full ? picked : [...picked, id]);
  const addTyped = () => {
    const id = typed.trim();
    // At the limit the name stays typed, so nothing is lost.
    if (id === "" || full) return;
    if (!picked.includes(id)) onChange([...picked, id]);
    setTyped("");
  };
  return (
    <>
      {loaded.length > 8 && (
        <input className="field" type="search" aria-label="Search models" placeholder={`Search ${loaded.length} models`} value={query} onChange={(event) => setQuery(event.target.value)} />
      )}
      {rows.length > 0 && (
        <div className="model-list" role="group" aria-label="Models to offer">
          {shown.map((id) => (
            <label key={id} className="row">
              <input type="checkbox" checked={picked.includes(id)} disabled={!picked.includes(id) && full} onChange={() => toggle(id)} />
              <span className="grow">{labels.get(id) ?? id}</span>
            </label>
          ))}
          {matching.length === 0 && <span className="note">No models match.</span>}
          {matching.length > shown.length && <span className="note">Search to see the other {matching.length - shown.length}.</span>}
        </div>
      )}
      {listed?.truncated && <span className="note">The provider listed more; search finds the first {loaded.length} by name.</span>}
      {full && <span className="note">At most {MAX_PICKED_MODELS} models.</span>}
      <div className="row">
        <input
          className="field"
          aria-label="Model name"
          value={typed}
          maxLength={200}
          placeholder="Add a model by name"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event: KeyboardEvent) => {
            // Enter adds the name rather than submitting anything.
            if (event.key === "Enter") {
              event.preventDefault();
              addTyped();
            }
          }}
        />
        <button type="button" className="btn" disabled={typed.trim() === "" || full} onClick={addTyped}>
          Add
        </button>
      </div>
    </>
  );
}
