import type { AiRule, AiSettingsInput, AiSettingsView, TagGrouping, TagInfo } from "@critiqs/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { type ConnectionDraft, connectionDraftOf, connectionInput, credits, managedOptions, keyName, OwnKeySetup, PlanCredits } from "./AiConnectionForm.tsx";
import { Dialog, Menu, MenuItem, useMenu } from "./common.tsx";
import { DialogHeader, NavRow, Select, SettingRow, Switch, usePageFocus } from "./ds.tsx";
import { tagDisplay } from "./MentionInput.tsx";

const GROUPING: Record<TagGrouping, string> = {
  pending: "Waiting for automatic grouping",
  ai: "Grouped automatically",
  starter: "Starter group",
  human: "Set by you",
  none: "Not grouped",
};

/**
 * The project owner's settings for tags and AI: shared tag groups, which
 * everyone's filters use, and the project's AI connection.
 */
export function TagsAiDialog({
  projectId,
  initialTab,
  onClose,
  notify,
  modelLists = false,
}: {
  projectId: string;
  initialTab: "groups" | "ai";
  onClose: () => void;
  notify: (message: string) => void;
  /** The backend lists providers' models, so an own key's models are picked from its list. */
  modelLists?: boolean;
}) {
  const [tab, setTab] = useState(initialTab);
  return (
    <Dialog label="Tags and AI" onClose={onClose}>
      <div className="row between">
        <h3>Tags and AI</h3>
        <div className="segmented" role="tablist" aria-label="Settings">
          <button type="button" role="tab" aria-selected={tab === "groups"} aria-pressed={tab === "groups"} onClick={() => setTab("groups")}>
            Tag groups
          </button>
          <button type="button" role="tab" aria-selected={tab === "ai"} aria-pressed={tab === "ai"} onClick={() => setTab("ai")}>
            AI
          </button>
        </div>
      </div>
      <div className="dialog-scroll" role="tabpanel" aria-label={tab === "groups" ? "Tag groups" : "AI"}>
        {tab === "groups" ? <GroupsTab projectId={projectId} notify={notify} /> : <AiTab projectId={projectId} notify={notify} modelLists={modelLists} />}
      </div>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

function GroupsTab({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  const transport = useTransport();
  const state = transport.useTags(projectId);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const run = (work: Promise<unknown>, done?: string) => work.then(() => done && notify(done)).catch((error) => notify(errorMessage(error)));
  if (state.status === "loading") return <p className="note">Loading tags…</p>;
  if (state.status === "error") return <p className="error">{state.message}</p>;
  const { tags, groups } = state.data;
  const members = (groupId: string) => tags.filter((tag) => tag.groupIds.includes(groupId));
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    void run(transport.createTagGroup({ projectId, name }), `Group “${name.trim()}” created`).then(() => setName(""));
  };
  return (
    <div className="settings">
      <p className="note">
        Groups gather related tags, so filtering by a group shows threads with any of its tags. Everyone in the project uses
        them. Automatic grouping places new tags; your choices are never changed automatically.
      </p>
      <form className="row" onSubmit={create}>
        <input className="field" aria-label="New group name" placeholder="New group, such as Visual design" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="btn" disabled={name.trim() === ""}>
          Create group
        </button>
      </form>
      {groups.length === 0 ? (
        <p className="note">No groups yet.</p>
      ) : (
        <ul className="group-list">
          {groups.map((group) => (
            <li key={group._id}>
              {renaming?.id === group._id ? (
                <form
                  className="row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(transport.renameTagGroup({ projectId, groupId: group._id, name: renaming.name })).then(() => setRenaming(null));
                  }}
                >
                  <input className="field" aria-label="Group name" value={renaming.name} maxLength={60} autoFocus onChange={(event) => setRenaming({ id: group._id, name: event.target.value })} />
                  <button type="submit" className="btn small">
                    Save
                  </button>
                  <button type="button" className="btn small" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="row between">
                  <strong>
                    {group.name}
                    {group.origin !== "human" && <span className="note"> · {group.origin === "ai" ? "created automatically" : "starter"}</span>}
                  </strong>
                  <GroupActions
                    groupName={group.name}
                    others={groups.filter((other) => other._id !== group._id)}
                    onRename={() => setRenaming({ id: group._id, name: group.name })}
                    onMerge={(intoGroupId) => void run(transport.mergeTagGroups({ projectId, groupId: group._id, intoGroupId }), "Groups merged")}
                    onDelete={() => void run(transport.deleteTagGroup({ projectId, groupId: group._id }), `Group “${group.name}” deleted; its tags remain`)}
                  />
                </div>
              )}
              <div className="row wrap">
                {members(group._id).length === 0 ? (
                  <span className="note">No tags yet</span>
                ) : (
                  members(group._id).map((tag) => (
                    <span key={tag.key} className="tag-chip">
                      {tagDisplay(tag.label)}
                    </span>
                  ))
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="menu-label">Tags</div>
      {tags.length === 0 ? (
        <p className="note">No tags yet. Tags appear as reviewers use them, such as by writing #wording in a comment.</p>
      ) : (
        <ul className="tag-list">
          {tags.map((tag) => (
            <TagRow key={tag.key} tag={tag} groups={groups} onChange={(groupIds, automatic) => void run(transport.setTagGroups({ projectId, tag: tag.key, groupIds, automatic }))} />
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupActions({
  groupName,
  others,
  onRename,
  onMerge,
  onDelete,
}: {
  groupName: string;
  others: { _id: string; name: string }[];
  onRename: () => void;
  onMerge: (intoGroupId: string) => void;
  onDelete: () => void;
}) {
  const menu = useMenu();
  return (
    <>
      <button type="button" className="btn small" aria-haspopup="menu" aria-label={`Change group ${groupName}`} onClick={menu.toggle}>
        Change…
      </button>
      {menu.open && (
        <Menu anchor={menu.anchor!} onClose={menu.close}>
          <MenuItem
            onSelect={() => {
              menu.close();
              onRename();
            }}
          >
            Rename
          </MenuItem>
          {others.length > 0 && <div className="menu-label">Merge into</div>}
          {others.map((other) => (
            <MenuItem
              key={other._id}
              onSelect={() => {
                menu.close();
                onMerge(other._id);
              }}
            >
              {other.name}
            </MenuItem>
          ))}
          <hr />
          <MenuItem
            danger
            onSelect={() => {
              menu.close();
              onDelete();
            }}
          >
            Delete group
          </MenuItem>
        </Menu>
      )}
    </>
  );
}

function TagRow({
  tag,
  groups,
  onChange,
}: {
  tag: TagInfo;
  groups: { _id: string; name: string }[];
  onChange: (groupIds: string[], automatic?: boolean) => void;
}) {
  const menu = useMenu();
  const names = tag.groupIds.map((id) => groups.find((group) => group._id === id)?.name).filter(Boolean);
  return (
    <li className="row between">
      <span className="grow">
        <span className="tag-chip">{tagDisplay(tag.label)}</span>{" "}
        <span className="note">
          {names.length > 0 ? names.join(", ") : "No group"} · {GROUPING[tag.grouping]}
        </span>
      </span>
      <button type="button" className="btn small" aria-haspopup="menu" aria-label={`Groups for ${tag.label}`} onClick={menu.toggle}>
        Groups…
      </button>
      {menu.open && (
        <Menu anchor={menu.anchor!} onClose={menu.close}>
          <div className="menu-label">Groups for {tag.label}</div>
          {groups.length === 0 && <div className="note" style={{ padding: "2px 8px 6px" }}>Create a group first.</div>}
          {groups.map((group) => (
            <MenuItem
              key={group._id}
              checked={tag.groupIds.includes(group._id)}
              onSelect={() =>
                onChange(tag.groupIds.includes(group._id) ? tag.groupIds.filter((id) => id !== group._id) : [...tag.groupIds, group._id])
              }
            >
              {group.name}
            </MenuItem>
          ))}
          <hr />
          <MenuItem
            onSelect={() => {
              menu.close();
              onChange([]);
            }}
          >
            No group
          </MenuItem>
          <MenuItem
            onSelect={() => {
              menu.close();
              onChange([], true);
            }}
          >
            Let automatic grouping decide
          </MenuItem>
        </Menu>
      )}
    </li>
  );
}

/** The AI usage rules, in the order offered; the default first. */
const RULES: { value: AiRule; label: string }[] = [
  { value: "either", label: "Project pays, personal allowed" },
  { value: "project", label: "Project pays" },
  { value: "personal", label: "Each person pays" },
];

interface ProjectDraft {
  connection: ConnectionDraft;
  rule: AiRule;
  /** Critiqs AI models the project's AI may use, in the deployment's order: every one when the owner limits none. Always includes the project's model. */
  allowed: string[];
}

function draftOf(view: AiSettingsView): ProjectDraft {
  const offered = (view.deployment.managedModels ?? []).map((entry) => entry.id);
  const limit = view.allowedModels ?? [];
  const stillAllowed = offered.filter((id) => limit.includes(id));
  // A limit none of whose models is offered any more shows only the first offered one, rather than every model.
  const allowed = limit.length === 0 ? offered : stillAllowed.length > 0 ? stillAllowed : offered.slice(0, 1);
  // The model requests use, as the server picks it: the saved one while offered and allowed, else the first allowed.
  const saved = view.managedModel ?? offered[0];
  const managedModel = saved !== undefined && allowed.includes(saved) ? saved : (allowed[0] ?? "");
  return { connection: { ...connectionDraftOf(view), managedModel }, rule: view.rule ?? "either", allowed };
}

/** `allowed` with the project's model, in the deployment's order. */
function withModel(allowed: string[], model: string, offered: string[]): string[] {
  return offered.filter((id) => allowed.includes(id) || id === model);
}

/**
 * The project's AI, for its owner: on or off, the model, who pays, the plan's
 * credits, and, a step deeper, the models people may choose and an own API
 * key. Each change saves at once.
 */
function AiTab({ projectId, notify, modelLists }: { projectId: string; notify: (message: string) => void; modelLists: boolean }) {
  const transport = useTransport();
  const state = transport.useAiSettings(projectId);
  const usage = transport.useUsage(projectId);
  // What a save returned, shown until the settings are read again.
  const [returned, setReturned] = useState<{ view: AiSettingsView; over: AiSettingsView } | null>(null);
  const [page, setPage] = useState<"main" | "key" | "models">("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  // The confirmation takes focus; Keep key gives it back to the row that asked.
  const keepButton = useRef<HTMLButtonElement>(null);
  const switchRow = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (confirmSwitch) keepButton.current?.focus();
    else if (asked.current) switchRow.current?.querySelector<HTMLElement>(".ds-nav-row")?.focus();
    asked.current = confirmSwitch;
  }, [confirmSwitch]);
  // A page of the tab takes focus when it opens, since the row that opened it is gone.
  const pageRef = useRef<HTMLDivElement>(null);
  usePageFocus(pageRef, page);
  if (state.status === "error") return <p className="error">{state.message}</p>;
  if (state.status === "loading") return <p className="note">Loading…</p>;
  const view = returned !== null && returned.over === state.data ? returned.view : state.data;
  const draft = draftOf(view);
  // Backends from before AI usage rules and Critiqs AI's model list report neither.
  const models = view.deployment.managedModels ?? null;
  const offered = (models ?? []).map((entry) => entry.id);
  // The model and allowed models are offered only with a choice to make; otherwise a save leaves the saved ones as they are.
  const choosing = offered.length > 1;
  const managed = view.deployment.managed;
  const enabled = view.enabled;
  const own = draft.connection.mode === "own" && view.provider !== null;
  // On Critiqs AI only when saved so: a project on the deployment's own provider isn't, even where Critiqs AI is offered.
  const onCritiqs = managed && draft.connection.mode === "managed";
  const plans = usage.status === "ready" ? usage.data : null;
  // Backends from before `aiCredits` report Critiqs AI credits as `aiRequests`.
  const creditMetric = plans?.rows.some((row) => row.metric === "aiCredits") ? "aiCredits" : "aiRequests";
  const credited = plans?.rows.filter((row) => row.metric === creditMetric) ?? [];

  const inputOf = (next: ProjectDraft): AiSettingsInput => {
    const allowed = withModel(next.allowed, next.connection.managedModel, offered);
    const onManaged = next.connection.enabled && next.connection.mode === "managed";
    // With the deployment's one model, a saved limit that leaves it out allows nothing: it narrows to that model, never to every one.
    const saved = view.allowedModels ?? [];
    const stranded = offered.length === 1 && saved.length > 0 && !saved.includes(offered[0]!);
    return {
      projectId,
      ...connectionInput(next.connection, view, { withModels: modelLists }),
      ...(view.rule === undefined ? {} : { rule: next.rule }),
      // Every model ticked is no limit, which also allows models the deployment adds later.
      ...(onManaged && choosing ? { allowedModels: allowed.length === offered.length ? [] : allowed } : {}),
      ...(onManaged && stranded ? { allowedModels: [offered[0]!] } : {}),
    };
  };
  /** Saves a change at once; false when the server refused it, with its reason shown. */
  const commit = async (next: ProjectDraft): Promise<boolean> => {
    // One save at a time; controls stay enabled, so focus stays on them while it saves.
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const saved = await transport.saveAiSettings(inputOf(next));
      setReturned({ view: saved, over: state.data });
      notify(saved.status.ready || !saved.enabled ? "AI settings saved" : `AI settings saved. ${saved.status.reason}`);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setConnection = (patch: Partial<ConnectionDraft>) => {
    const connection = { ...draft.connection, ...patch };
    // The project's own model is always one it allows.
    return commit({ ...draft, connection, allowed: withModel(draft.allowed, connection.managedModel, offered) });
  };
  /** Another page starts without the last page's error. */
  const go = (next: "main" | "key" | "models") => {
    setError(null);
    setConfirmSwitch(false);
    setPage(next);
  };
  const errorLine = error !== null && (
    <p className="error" role="alert">
      {error}
    </p>
  );

  if (page === "key") {
    return (
      <OwnKeySetup
        view={view}
        draft={draft.connection}
        busy={busy}
        error={error}
        clearError={() => setError(null)}
        loadModels={modelLists ? (request) => transport.listAiModels(projectId, request) : undefined}
        onExit={() => go("main")}
        onSave={(connection) => void commit({ ...draft, connection }).then((ok) => ok && setPage("main"))}
      />
    );
  }

  if (page === "models" && models !== null) {
    return (
      <div ref={pageRef} className="ds-page">
        <DialogHeader title="Allowed models" onBack={() => go("main")} />
        {errorLine}
        <div className="ds-group" role="group" aria-label="Allowed models">
          {models.map((entry) => {
            const own = entry.id === draft.connection.managedModel;
            const ticked = draft.allowed.includes(entry.id);
            return (
              <label key={entry.id} className="ds-row">
                <span className="row">
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={own}
                    onChange={() => void commit({ ...draft, allowed: withModel(ticked ? draft.allowed.filter((id) => id !== entry.id) : [...draft.allowed, entry.id], draft.connection.managedModel, offered) })}
                  />
                  {entry.label}
                </span>
                <span className="note">{own ? "This project's model" : credits(entry)}</span>
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  // Leaving the project's own key, which removes it: for Critiqs AI, or for the deployment's own provider.
  const leave: { label: string; confirm: string; change: Partial<ConnectionDraft> } | null = managed
    ? { label: "Use Critiqs AI instead", confirm: "Remove the project's key and use Critiqs AI?", change: { mode: "managed", apiKey: "" } }
    : view.deployment.defaultProvider !== null
      ? { label: "Use this deployment's provider", confirm: "Remove the project's key and use this deployment's provider?", change: { mode: "own", provider: "", baseUrl: "", apiKey: "", model: "", models: [] } }
      : null;
  const chosen = (models ?? []).find((entry) => entry.id === draft.connection.managedModel);
  // Saved Critiqs AI settings that don't work, which saving the shown choice fixes (such as a retired model).
  const fixable = enabled && !view.status.ready && draft.connection.mode === "managed" && managed && chosen !== undefined;
  return (
    <div ref={pageRef} className="ds-page">
      <div className="ds-group">
        <SettingRow label="AI for this project">
          {(labelId) => <Switch checked={enabled} labelledBy={labelId} onChange={(on) => void setConnection({ enabled: on, apiKey: "" })} />}
        </SettingRow>
      </div>
      {enabled && !view.status.ready && (
        <div className="warning row between" role="status">
          <span>{view.status.reason}</span>
          {fixable && (
            <button type="button" className="btn small" disabled={busy} onClick={() => void commit(draft)}>
              Use {chosen.label}
            </button>
          )}
        </div>
      )}
      {errorLine}
      {enabled && (
        <>
          {(own || onCritiqs || view.rule !== undefined) && (
          <div className="ds-group">
            {own ? (
              <>
                <SettingRow label="Model">
                  {(labelId) => (
                    <Select
                      value={draft.connection.model}
                      options={draft.connection.models.map((model) => ({ value: model, label: model }))}
                      labelledBy={labelId}
                      onChange={(model) => void setConnection({ model })}
                    />
                  )}
                </SettingRow>
                <NavRow label={keyName(view.provider!)} value={view.keyHint === null ? undefined : `····${view.keyHint}`} onClick={() => go("key")} />
              </>
            ) : (
              onCritiqs &&
              models !== null &&
              models.length > 0 && (
                <SettingRow label="Model">
                  {(labelId) =>
                    choosing ? (
                      <Select
                        value={draft.connection.managedModel}
                        options={managedOptions(models)}
                        labelledBy={labelId}
                        onChange={(managedModel) => void setConnection({ mode: "managed", managedModel })}
                      />
                    ) : (
                      <span aria-labelledby={labelId}>{models[0]!.label}</span>
                    )
                  }
                </SettingRow>
              )
            )}
            {view.rule !== undefined && (
              <SettingRow label="Who pays">
                {(labelId) => <Select value={draft.rule} options={RULES} labelledBy={labelId} onChange={(rule) => void commit({ ...draft, rule: rule as AiRule })} />}
              </SettingRow>
            )}
          </div>
          )}
          {onCritiqs && plans !== null && <PlanCredits plan={plans.plan} rows={credited} upgradeUrl={plans.upgradeUrl} whose="project" />}
          {(!own || leave !== null) && (
            <div ref={switchRow} className="ds-group">
              <hr className="ds-divider" />
              {onCritiqs && choosing && models !== null && (
                <NavRow
                  label="Allowed models"
                  value={draft.allowed.length === offered.length ? "All" : `${draft.allowed.length} of ${offered.length}`}
                  onClick={() => go("models")}
                />
              )}
              {!own ? (
                <>
                  <NavRow label="Use your own API key" onClick={() => go("key")} />
                  {/* On the deployment's own provider there is no key to remove. */}
                  {managed && !onCritiqs && <NavRow label="Use Critiqs AI instead" onClick={() => void setConnection({ mode: "managed", apiKey: "" })} />}
                </>
              ) : (
                leave !== null &&
                (confirmSwitch ? (
                  <div className="warning stacked" role="alert">
                    <span>{leave.confirm}</span>
                    <div className="row end">
                      <button ref={keepButton} type="button" className="btn small" disabled={busy} onClick={() => setConfirmSwitch(false)}>
                        Keep key
                      </button>
                      <button
                        type="button"
                        className="btn small danger solid"
                        disabled={busy}
                        onClick={() => void setConnection(leave.change).then((ok) => ok && setConfirmSwitch(false))}
                      >
                        {busy ? "Removing…" : "Remove key"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <NavRow label={leave.label} onClick={() => setConfirmSwitch(true)} />
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
