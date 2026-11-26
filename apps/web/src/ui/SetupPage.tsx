import { PROJECT_ID_PATTERN } from "@critiqs/core";
import { type Backend, type SetupInfo, useAuth, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import type { QueryState } from "../shared.ts";
import { BackendStep, Commands, PageHeader, SignInButton } from "./parts.tsx";

/**
 * The developer's setup page at /setup/<id>: after sign-in, the project, its
 * address as text, and the install commands. `id` is a send's, from a setup
 * email, or a project's, from a copied message.
 */
export function SetupPage({ id }: { id: string }) {
  const auth = useAuth();
  if (auth.reviewer === null || !auth.ready) {
    return (
      <>
        <PageHeader title={copy.signIn.title} />
        <p className="lead">{copy.setup.signInLead}</p>
        <SignInButton />
      </>
    );
  }
  return <SetupDetails id={id} email={auth.reviewer.email} onSignOut={() => void auth.signOut()} />;
}

function SetupDetails({ id, email, onSignOut }: { id: string; email: string; onSignOut: () => void }) {
  return <SetupView state={useSetup(useBackend(), id)} email={email} onSignOut={onSignOut} />;
}

/**
 * The setup an ID opens: a send's, naming who asked, else, for a copied
 * message's project ID, the project's own setup (its saved stack only for
 * the people who manage it). A
 * project ID that names no project looks the same as a send that doesn't exist.
 */
export function useSetup(backend: Backend, id: string): QueryState<SetupInfo> {
  const send = backend.useDeveloperSetup(id);
  const tryProject = send.status === "error" && send.code === "not-found" && PROJECT_ID_PATTERN.test(id);
  const project = backend.useProjectSetup(tryProject ? id : null);
  if (!tryProject) return send;
  if (project.status === "error") return send;
  return project.status === "ready" ? { status: "ready", data: { ...project.data, inviterName: null } } : project;
}

/** What the setup page shows for each state of its query. A send that doesn't exist and one for someone else look the same. */
export function SetupView({ state, email, onSignOut }: { state: QueryState<SetupInfo>; email: string; onSignOut: () => void }) {
  const { componentBackend } = useBackend();
  if (state.status === "loading") return <p className="note">{copy.loading}</p>;
  if (state.status === "error") {
    return (
      <>
        <PageHeader title={copy.setup.notFoundTitle} />
        <p className="lead">{state.code === "not-found" || state.code === "forbidden" ? copy.setup.notFound : state.message}</p>
        <p className="note">{copy.signIn.signedInAs(email)}</p>
        <div>
          <button type="button" className="btn" onClick={onSignOut}>
            {copy.setup.signOut}
          </button>
        </div>
      </>
    );
  }
  const setup = state.data;
  const facts: [string, string][] = [
    [copy.setup.project, setup.projectName],
    [copy.setup.address, setup.address ?? copy.setup.notGiven],
    [copy.setup.builtWith, setup.stack?.label ?? copy.setup.notConfirmed],
  ];
  return (
    <>
      <PageHeader title={copy.setup.title(setup.projectName)} />
      <p className="lead">{setup.inviterName === null ? copy.setup.askedNoName : copy.setup.asked(setup.inviterName)}</p>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label} className="ds-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {setup.installCommands === null ? (
        <p className="caution">{copy.stack.notInstallable(setup.stack?.label ?? "")}</p>
      ) : (
        <div className="stacked">
          <p className="note">{setup.stack === null ? copy.install.unknownStack : copy.setup.commandsLabel}</p>
          <Commands commands={setup.installCommands} />
          {componentBackend !== null && <BackendStep backend={componentBackend} whose="your team's" />}
        </div>
      )}
      <p className="note">{copy.setup.noApproval}</p>
    </>
  );
}
