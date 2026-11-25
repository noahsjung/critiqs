import { Critiqs } from "critiqs-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useCritiqsIntegration } from "./critiqs.ts";
import { personas, type User, users } from "./data.ts";
import {
  type Dialog,
  detailsOf,
  type PilotView,
  type PrototypeVersion,
  ROW_HEIGHT,
  type Tab,
  VISIBLE_ROWS,
} from "./view.ts";

// Pilot host app. Elements carry `data-critiqs-id` (stable purpose) and
// `data-critiqs-record` (which record they belong to). The App holds the view
// state so Critiqs can record and restore it.

export function App() {
  const [view, setView] = useState<PilotView>({
    screen: { name: "user-list" },
    tab: "profile",
    dialog: null,
    persona: personas[0]!,
    listScrollTop: 0,
  });
  const [version, setVersion] = useState(initialVersion);
  const integration = useCritiqsIntegration(view, setView);
  const update = (changes: Partial<PilotView>) => setView((current) => ({ ...current, ...changes }));
  const { screen } = view;

  return (
    <div className="app">
      <header className="app-header" data-critiqs-id="app.header">
        <strong className="app-title" data-critiqs-id="app.title">
          Acme Admin
        </strong>
        <label>
          Viewing as{" "}
          <select
            data-critiqs-id="app.persona"
            value={view.persona}
            onChange={(event) => update({ persona: event.target.value })}
          >
            {personas.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Prototype version{" "}
          <select
            data-critiqs-id="app.version"
            value={version}
            onChange={(event) => setVersion(saveVersion(event.target.value as PrototypeVersion))}
          >
            <option value="v1">v1</option>
            <option value="v2">v2 (changed)</option>
          </select>
        </label>
      </header>
      {screen.name === "user-list" ? (
        <UserList
          version={version}
          scrollTop={view.listScrollTop}
          onScroll={(listScrollTop) => update({ listScrollTop })}
          onOpen={(userId) => setView((current) => detailsOf(current, userId))}
        />
      ) : (
        <UserDetails
          version={version}
          user={users.find((user) => user.id === screen.userId)!}
          tab={view.tab}
          dialog={view.dialog}
          onBack={() => update({ screen: { name: "user-list" }, dialog: null })}
          onTab={(tab) => update({ tab })}
          onDialog={(dialog) => update({ dialog })}
        />
      )}
      <Critiqs
        {...integration}
        version={`pilot-${version}`}
        backend={import.meta.env.VITE_CRITIQS_BACKEND}
        projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID}
      />
    </div>
  );
}

/** The simulated prototype version lives in the URL, so a reload keeps it like a deploy would. */
function initialVersion(): PrototypeVersion {
  return new URLSearchParams(window.location.search).get("version") === "v2" ? "v2" : "v1";
}

/** Updates only the `version` parameter, preserving any others (such as Critiqs's links). */
function saveVersion(version: PrototypeVersion): PrototypeVersion {
  const url = new URL(window.location.href);
  url.searchParams.set("version", version);
  window.history.replaceState(window.history.state, "", url);
  return version;
}

/** Renders only rows scrolled into view, to exercise restoring hidden rows. */
function UserList({
  version,
  scrollTop,
  onScroll,
  onOpen,
}: {
  version: PrototypeVersion;
  scrollTop: number;
  onScroll: (scrollTop: number) => void;
  onOpen: (userId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const visible = users.slice(first, first + VISIBLE_ROWS + 1);
  // v2 drops the Department column, removing `user-list.department` targets.
  const columns = version === "v1" ? "columns-3" : "columns-2";

  // The scroll position is App state, so restoring a thread can reveal its row.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list !== null && Math.abs(list.scrollTop - scrollTop) >= 1) list.scrollTop = scrollTop;
  }, [scrollTop]);

  return (
    <main className="page">
      <h1 data-critiqs-id="user-list.title">Users</h1>
      <p className="subtitle" data-critiqs-id="user-list.count">
        {users.length} people
      </p>
      <div className={`list-columns ${columns}`} data-critiqs-id="user-list.columns">
        <span>Name</span>
        {version === "v1" && <span>Department</span>}
        <span>Role</span>
      </div>
      <div
        ref={listRef}
        className="list"
        data-critiqs-id="user-list.rows"
        style={{ height: ROW_HEIGHT * VISIBLE_ROWS }}
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      >
        <div style={{ height: users.length * ROW_HEIGHT, position: "relative" }}>
          {visible.map((user, index) => (
            <button
              type="button"
              key={user.id}
              className={`row ${columns}`}
              data-critiqs-id="user-list.row"
              data-critiqs-record={`user:${user.id}`}
              style={{ top: (first + index) * ROW_HEIGHT, height: ROW_HEIGHT }}
              onClick={() => onOpen(user.id)}
            >
              <span data-critiqs-id="user-list.name">{user.name}</span>
              {version === "v1" && <span data-critiqs-id="user-list.department">{user.department}</span>}
              <span data-critiqs-id="user-list.role">{user.role}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

function UserDetails({
  version,
  user,
  tab,
  dialog,
  onBack,
  onTab,
  onDialog,
}: {
  version: PrototypeVersion;
  user: User;
  tab: Tab;
  dialog: Dialog;
  onBack: () => void;
  onTab: (tab: Tab) => void;
  onDialog: (dialog: Dialog) => void;
}) {
  return (
    <main className="page" data-critiqs-record={`user:${user.id}`}>
      <button type="button" className="back" data-critiqs-id="user-details.back" onClick={onBack}>
        ← Users
      </button>
      <h1 data-critiqs-id="user-details.name">{user.name}</h1>
      <nav role="tablist" className="tabs" data-critiqs-id="user-details.tabs">
        {(["profile", "permissions"] as const).map((name) => (
          <button
            type="button"
            role="tab"
            key={name}
            aria-selected={tab === name}
            data-critiqs-id={`user-details.tab.${name}`}
            onClick={() => onTab(name)}
          >
            {name === "profile" ? "Profile" : "Permissions"}
          </button>
        ))}
      </nav>
      {tab === "profile" ? (
        <dl role="tabpanel" className="panel fields" data-critiqs-id="user-details.profile">
          {/* v2 renames this label; the purpose ID stays the same. */}
          <dt data-critiqs-id="user-details.department-label">{version === "v1" ? "Department" : "Team"}</dt>
          <dd data-critiqs-id="user-details.department">{user.department}</dd>
          <dt>User ID</dt>
          <dd data-critiqs-id="user-details.user-id">{user.id}</dd>
        </dl>
      ) : (
        <section role="tabpanel" className="panel" data-critiqs-id="user-details.permissions">
          <p>
            Role: <span data-critiqs-id="user-details.role">{user.role}</span>
          </p>
          {/* v2 turns the button into a link; changing the tag need not change its purpose. */}
          {version === "v1" ? (
            <button type="button" className="danger" data-critiqs-id="user-details.revoke" onClick={() => onDialog("revoke")}>
              Revoke access
            </button>
          ) : (
            <a
              href="#revoke"
              className="danger-link"
              data-critiqs-id="user-details.revoke"
              onClick={(event) => {
                event.preventDefault();
                onDialog("revoke");
              }}
            >
              Remove access…
            </a>
          )}
        </section>
      )}
      {dialog === "revoke" && (
        <div className="backdrop">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-dialog-title"
            className="dialog"
            data-critiqs-id="user-details.revoke-dialog"
          >
            <h2 id="revoke-dialog-title" data-critiqs-id="user-details.revoke-dialog.title">
              Revoke access
            </h2>
            <p data-critiqs-id="user-details.revoke-dialog.message">Revoke {user.name}'s access?</p>
            <div className="dialog-actions">
              <button type="button" data-critiqs-id="user-details.revoke-dialog.cancel" onClick={() => onDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                data-critiqs-id="user-details.revoke-dialog.confirm"
                onClick={() => onDialog(null)}
              >
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
