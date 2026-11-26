import { type AiRule, type AiSettingsInput, type AiSettingsView, cleanPresetTag, MAX_PRESET_TAGS, type TagGrouping, type TagInfo, tagKey } from "@critiqs/core";
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
 * The project owner's settings for tags and AI: the preset tags `#` suggests
 * first, shared tag groups, which everyone's filters use, and the project's
 * AI connection.
 */
export function TagsAiDialog({
  projectId,
  initialTab,
  onClose,
  notify,
  modelLists = false,
  presetTags = false,
}: {
  projectId: string;
  initialTab: "groups" | "ai";
  onClose: () => void;
  notify: (message: string) => void;
  /** The backend lists providers' models, so an own key's models are picked from its list. */
  modelLists?: boolean;
  /** The backend lets the owner change the project's preset tags; older backends don't, so they aren't offered. */
  presetTags?: boolean;
}) {
  const [tab, setTab] = useState(initialTab);
  return (
    <Dialog label="Tags and AI" onClose={onClose}>
      <div className="row between">
        <h3>Tags and AI</h3>
        <div className="segmented" role="tablist" aria-label="Settings">
          <button type="button" role="tab" aria-selected={tab === "groups"} aria-pressed={tab === "groups"} onClick={() => setTab("groups")}>
            Tags
          </button>
          <button type="button" role="tab" aria-selected={tab === "ai"} aria-pressed={tab === "ai"} onClick={() => setTab("ai")}>
            AI
          </button>
        </div>
      </div>
      <div className="dialog-scroll" role="tabpanel" aria-label={tab === "groups" ? "Tags" : "AI"}>
        {tab === "groups" ? <GroupsTab projectId={projectId} notify={notify} presetTags={presetTags} /> : <AiTab projectId={projectId} notify={notify} modelLists={modelLists} />}
      </div>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

function GroupsTab({ projectId, notify, presetTags }: { projectId: string; notify: (message: string) => void; presetTags: boolean }) {
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
      {presetTags && <PresetTags projectId={projectId} notify={notify} />}
      <div className="menu-label">Groups</div>
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

/**
 * The project's preset tags, in order: after the tags reviewers used most
 * recently, `#` suggests the unused ones in this order. Rename, move, and
 * remove act on a preset by its key, so a list changed elsewhere meanwhile
 * never moves the change onto another preset. Every
 * change sends the whole list with the list it changed, so a change someone
 * else made meanwhile is refused rather than undone.
 */
function PresetTags({ projectId, notify }: { projectId: string; notify: (message: string) => void }) {
  const transport = useTransport();
  const project = transport.useProject(projectId);
  const [adding, setAdding] = useState("");
  /** The preset being renamed, by its key, so the form stays on it while the list changes elsewhere. */
  const [renaming, setRenaming] = useState<{ key: string; label: string } | null>(null);
  const [saving, setSaving] = useState(false);
  if (project.status === "loading") return <p className="note">Loading preset tags…</p>;
  if (project.status === "error") return <p className="error">{project.message}</p>;
  const presets = project.data.tags;
  /** A preset's place in the list now, by its key; -1 once it was renamed or removed elsewhere. */
  const placeOf = (key: string) => presets.findIndex((label) => tagKey(label) === key);
  /** Checks a new or renamed preset here first, with the backend's rules, so the owner can fix it before sending. */
  const problem = (label: string, except: number | null): string | null => {
    const cleaned = cleanPresetTag(label);
    if (cleaned === null) return "Use 1 to 50 letters, numbers, spaces, - or _, starting with a letter.";
    const same = presets.findIndex((other, index) => index !== except && tagKey(other) === tagKey(cleaned));
    return same === -1 ? null : `“${presets[same]}” is already a preset.`;
  };
  const save = (tags: string[], done: string) => {
    setSaving(true);
    return transport
      .setPresetTags({ projectId, tags, previous: presets })
      .then(() => {
        notify(done);
        return true;
      })
      .catch((error) => {
        notify(errorMessage(error));
        return false;
      })
      .finally(() => setSaving(false));
  };
  const move = (key: string, by: -1 | 1) => {
    const index = placeOf(key);
    if (index === -1 || index + by < 0 || index + by >= presets.length) return;
    const next = [...presets];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    void save(next, `Moved “${presets[index]}” ${by < 0 ? "up" : "down"}`);
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (problem(adding, null) !== null) return;
    void save([...presets, adding], `Preset “${cleanPresetTag(adding)}” added`).then((ok) => ok && setAdding(""));
  };
  const addProblem = adding.trim() === "" ? null : problem(adding, null);
  const full = presets.length >= MAX_PRESET_TAGS;
  return (
    <section className="settings" aria-label="Preset tags">
      <div className="menu-label">Preset tags</div>
      <p className="note">
        Typing # suggests the tags reviewers used most recently, then these presets that no one has used yet, in this order.
        Renaming or removing one leaves the threads that already have it as they are; their tag stays in filters, and a group
        can gather it with the new one.
      </p>
      {presets.length === 0 ? (
        <p className="note">No preset tags. Typing # suggests only tags reviewers have used.</p>
      ) : (
        <ol className="tag-list preset-list">
          {presets.map((label, index) =>
            renaming?.key === tagKey(label) ? (
              <li key={label}>
                <form
                  className="row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const place = placeOf(renaming.key);
                    if (place === -1 || problem(renaming.label, place) !== null) return;
                    const next = presets.map((other, i) => (i === place ? renaming.label : other));
                    void save(next, `Renamed “${label}” to “${cleanPresetTag(renaming.label)}”`).then((ok) => ok && setRenaming(null));
                  }}
                >
                  <input
                    className="field"
                    aria-label={`New name for ${label}`}
                    value={renaming.label}
                    autoFocus
                    aria-invalid={problem(renaming.label, index) !== null}
                    onChange={(event) => setRenaming({ key: renaming.key, label: event.target.value })}
                  />
                  <button type="submit" className="btn small" disabled={saving || problem(renaming.label, index) !== null}>
                    Save
                  </button>
                  <button type="button" className="btn small" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
                {problem(renaming.label, index) !== null && renaming.label.trim() !== "" && <p className="error">{problem(renaming.label, index)}</p>}
              </li>
            ) : (
              <li key={label} className="row between">
                <span className="tag-chip">{tagDisplay(label)}</span>
                <PresetActions
                  label={label}
                  disabled={saving}
                  first={index === 0}
                  last={index === presets.length - 1}
                  onMove={(by) => move(tagKey(label), by)}
                  onRename={() => setRenaming({ key: tagKey(label), label })}
                  onRemove={() => void save(presets.filter((other) => tagKey(other) !== tagKey(label)), `Preset “${label}” removed; threads keep it`)}
                />
              </li>
            ),
          )}
        </ol>
      )}
      <form className="row" onSubmit={add}>
        <input
          className="field"
          aria-label="New preset tag"
          placeholder={full ? `Up to ${MAX_PRESET_TAGS} preset tags` : "New preset, such as Accessibility"}
          value={adding}
          disabled={full}
          aria-invalid={addProblem !== null}
          onChange={(event) => setAdding(event.target.value)}
        />
        <button type="submit" className="btn" disabled={saving || full || adding.trim() === "" || addProblem !== null}>
          Add preset
        </button>
      </form>
      {addProblem !== null && <p className="error">{addProblem}</p>}
    </section>
  );
}

function PresetActions({
  label,
  disabled,
  first,
  last,
  onMove,
  onRename,
  onRemove,
}: {
  label: string;
  disabled: boolean;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const menu = useMenu();
  const choose = (action: () => void) => () => {
    menu.close();
    action();
  };
  return (
    <>
      <button type="button" className="btn small" aria-haspopup="menu" aria-label={`Change preset ${label}`} disabled={disabled} onClick={menu.toggle}>
        Change…
      </button>
      {menu.open && (
        <Menu anchor={menu.anchor!} onClose={menu.close}>
          {!first && <MenuItem onSelect={choose(() => onMove(-1))}>Move up</MenuItem>}
          {!last && <MenuItem onSelect={choose(() => onMove(1))}>Move down</MenuItem>}
          <MenuItem onSelect={choose(onRename)}>Rename</MenuItem>
          <hr />
          <MenuItem danger onSelect={choose(onRemove)}>
            Remove preset
          </MenuItem>
        </Menu>
      )}
    </>
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
  const project = transport.useProject(projectId);
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
          {onCritiqs && plans !== null && <PlanCredits plan={plans.plan} rows={credited} upgradeUrl={plans.upgradeUrl} organizationId={project.status === "ready" ? project.data.organization?.id : undefined} whose="project" />}
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
