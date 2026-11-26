import { isLocalAddress, type OrganizationSummary, type StackId } from "@critiqs/core";
import { type Dispatch, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { type Backend, failureCode, failureMessage, useAuth, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import {
  CODE_ACCESS_OF,
  defaultProjectName,
  type FlowAction,
  flowReducer,
  type FlowReviewer,
  type FlowState,
  restoreFlow,
  reviewUrlOf,
  saveFlow,
  sessionStore,
  shownHost,
  STEPS,
  type Who,
} from "../flow.ts";
import { Select } from "../shared.ts";
import { AboutYou } from "./AboutYou.tsx";
import { Heading, Progress } from "./parts.tsx";
import { Preview } from "./Preview.tsx";
import { InstallPanel, SendPanel } from "./Ways.tsx";

/**
 * Onboarding at /start, in three screens: the prototype's link, who adds
 * Critiqs, then the command or the email. Signing in happens when the person
 * leaves the first screen. The flow and its saved draft belong to the
 * signed-in reviewer: another reviewer starts fresh, and signing out removes
 * the draft.
 */
export function Onboarding() {
  const auth = useAuth();
  const reviewer: FlowReviewer | null = auth.reviewer === null ? null : { id: auth.reviewer.id, email: auth.reviewer.email };
  const [state, dispatch] = useReducer(flowReducer, reviewer, (signedIn) => restoreFlow(sessionStore(), signedIn));
  useEffect(() => saveFlow(sessionStore(), state), [state]);

  // Finishing sign-in moves on from the first screen, and another reviewer gets a fresh flow; signing out starts over.
  useEffect(() => {
    if (reviewer === null) {
      if (state.reviewer !== null) dispatch({ type: "signed-out" });
    } else if (auth.ready && (state.reviewer?.id !== reviewer.id || state.reviewer.email !== reviewer.email)) {
      dispatch({ type: "signed-in", reviewer });
    }
  }, [reviewer?.id, reviewer?.email, auth.ready]);

  // A stored sign-in is still being accepted by the backend, or the flow is still another reviewer's for a moment.
  if (state.step !== "address" && (!auth.ready || state.reviewer?.id !== reviewer?.id)) return <p className="note">{copy.loading}</p>;
  return <OnboardingScreen state={state} dispatch={dispatch} />;
}

/**
 * The stack found at an address, checked once per reviewer and address: the
 * check runs as the person signed in, so another reviewer's is never reused.
 * The check only names the stack saved with the project, so a failed one is
 * no stack, and an address on this computer or a private network is never
 * sent to the server.
 */
export function useStackCheck(backend: Backend): (reviewerId: string, url: string) => Promise<StackId | null> {
  const checks = useRef(new Map<string, Promise<StackId | null>>());
  return useCallback(
    (reviewerId: string, url: string) => {
      const key = `${reviewerId} ${url}`;
      let found = checks.current.get(key);
      if (found === undefined) {
        found = isLocalAddress(new URL(url))
          ? Promise.resolve(null)
          : backend.checkAddress(url).then(
              (check) => ("stack" in check ? check.stack : null),
              () => null,
            );
        checks.current.set(key, found);
      }
      return found;
    },
    [backend],
  );
}

/** The current screen beside the preview. Exported for tests, which drive it with a fake backend. */
export function OnboardingScreen({ state, dispatch }: { state: FlowState; dispatch: Dispatch<FlowAction> }) {
  const backend = useBackend();
  const stackOf = useStackCheck(backend);
  const url = state.address.url;
  // The check starts as soon as someone signed in has given a link, so it's usually done before they choose.
  useEffect(() => {
    if (state.reviewer !== null && typeof url === "string" && state.project === null) void stackOf(state.reviewer.id, url);
  }, [state.reviewer?.id, url, state.project === null]);

  const host = state.project?.reviewUrl != null ? shownHost(state.project.reviewUrl) : state.address.text.trim() === "" ? null : shownHost(state.address.text);
  return (
    <div className="flow">
      <section className="flow-main" aria-live="off">
        <Progress step={STEPS.indexOf(state.step) + 1} count={STEPS.length} />
        {state.step === "address" && <AddressScreen state={state} dispatch={dispatch} />}
        {state.step === "who" && <WhoScreen state={state} dispatch={dispatch} stackOf={stackOf} />}
        {state.step === "setup" && <SetupScreen state={state} dispatch={dispatch} />}
      </section>
      <Preview host={host} live={state.step === "setup"} />
    </div>
  );
}

/** What should your team review? A link, or "It's not online yet". Leaving it signs the person in when they aren't. */
function AddressScreen({ state, dispatch }: { state: FlowState; dispatch: Dispatch<FlowAction> }) {
  const auth = useAuth();
  const fieldId = useId();
  const [signIn, setSignIn] = useState<{ status: "idle" | "waiting" } | { status: "failed"; message: string }>({ status: "idle" });
  const { address } = state;
  const signedIn = state.reviewer !== null;
  const field = useRef<HTMLInputElement>(null);

  // The sign-in window opens from the click itself, or browsers block it.
  const signInIfNeeded = async () => {
    if (signedIn) return;
    setSignIn({ status: "waiting" });
    try {
      await auth.signIn();
      setSignIn({ status: "idle" });
    } catch (error) {
      setSignIn({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const go = (action: FlowAction, valid: boolean) => {
    dispatch(action);
    if (valid) void signInIfNeeded();
  };
  const waiting = signIn.status === "waiting" || (auth.reviewer !== null && !auth.ready);

  return (
    <>
      <Heading title={copy.address.title} lead={copy.address.lead} />
      <form
        className="stacked"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const valid = flowReducer(state, { type: "address-continue" }).address.error === null;
          go({ type: "address-continue" }, valid);
          // A refused link keeps focus on the field, whose description is the error.
          if (!valid) field.current?.focus();
        }}
      >
        <label className="visually-hidden" htmlFor={fieldId}>
          {copy.address.field}
        </label>
        <input
          ref={field}
          id={fieldId}
          className="field large"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="off"
          autoFocus
          spellCheck={false}
          placeholder={copy.address.placeholder}
          value={address.text}
          aria-invalid={address.error !== null}
          aria-describedby={address.error === null ? undefined : `${fieldId}-error`}
          onChange={(event) => dispatch({ type: "address-text", text: event.target.value })}
        />
        {address.error !== null && (
          <p className="error" id={`${fieldId}-error`} role="alert">
            {address.error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn primary large" disabled={waiting}>
            {copy.continue}
          </button>
          <button type="button" className="quiet" disabled={waiting} onClick={() => go({ type: "address-none" }, true)}>
            {copy.address.notOnline}
          </button>
        </div>
      </form>
      {!signedIn && signIn.status === "idle" && <p className="note">{copy.signIn.next}</p>}
      {waiting && (
        <p className="note" role="status">
          {copy.signIn.waiting}
        </p>
      )}
      {signIn.status === "failed" && (
        <p className="error" role="alert">
          {signIn.message}
        </p>
      )}
    </>
  );
}

/** As the sidebar's project setup chooses: the person's home organization, else the first. */
export function defaultOrganization(choices: readonly OrganizationSummary[]): OrganizationSummary | undefined {
  return choices.find((organization) => organization.home) ?? choices[0];
}

/**
 * Who will add Critiqs to it? Choosing creates the project, named after the
 * link, in the person's organization, with the stack the check found. The
 * choices wait for the organizations: a project never goes to one the person
 * didn't see. With several, the one it goes in is shown and can be changed;
 * if the chosen one leaves the list, nothing is chosen until the person
 * picks again. A plan's project limit offers the projects the person created
 * and, for an admin, the deployment's upgrade page.
 */
function WhoScreen({ state, dispatch, stackOf }: { state: FlowState; dispatch: Dispatch<FlowAction>; stackOf: (reviewerId: string, url: string) => Promise<StackId | null> }) {
  const backend = useBackend();
  const titleId = useId();
  const organizationLabel = useId();
  const existingLabel = useId();
  const organizations = backend.useOrganizations(true);
  const creating = state.create.status === "creating";
  const limited = state.create.status === "failed" && state.create.limit;
  const choices = organizations.status === "ready" ? organizations.data : [];
  const fallback = defaultOrganization(choices) ?? null;
  const chosen = state.organizationId === null ? fallback : (choices.find((organization) => organization.id === state.organizationId) ?? null);
  const lost = organizations.status === "ready" && state.organizationId !== null && chosen === null && choices.length > 0;
  const names = useRef(new Map<string, string>());
  for (const organization of choices) names.current.set(organization.id, organization.name);
  useEffect(() => {
    if (organizations.status === "ready" && state.organizationId === null && fallback !== null) dispatch({ type: "organization", organizationId: fallback.id });
  }, [organizations.status, state.organizationId, fallback?.id]);
  const mine = backend.useMyProjects(limited);
  const upgradeUrl = backend.useUpgradeUrl(limited && chosen?.role === "admin");
  const ready = organizations.status === "ready" && !lost;
  // The flow on screen now, for a create that waited on the address check.
  const now = useRef(state.flow);
  now.current = state.flow;
  // A reviewer change, sign-out, or sign-in still being accepted replaces this screen.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => void (shown.current = false);
  }, []);

  const choose = async (who: Who) => {
    if (creating || !ready) return;
    const flow = state.flow;
    dispatch({ type: "choose", who });
    const name = defaultProjectName(state.address);
    const reviewUrl = reviewUrlOf(state.address);
    // The organization the person saw when they chose. If it's gone by the time the request is sent, the server refuses it, and that's shown.
    const organizationId = chosen?.id ?? null;
    try {
      const stack = typeof state.address.url === "string" && state.reviewer !== null ? await stackOf(state.reviewer.id, state.address.url) : null;
      // While the check ran, the screen may have gone, or the flow changed: nothing is created, and the choice is open again if this flow comes back.
      if (!shown.current || now.current !== flow) return dispatch({ type: "create-cancelled", flow });
      const id = await backend.createProject({ name, reviewUrl, organizationId, answers: { codeAccess: CODE_ACCESS_OF[who] }, stack });
      dispatch({ type: "created", flow, project: { id, name, reviewUrl, stack } });
    } catch (failure) {
      dispatch({ type: "create-failed", flow, message: failureMessage(failure, copy.who.failed), limit: failureCode(failure) === "limit" });
    }
  };

  /** Uses a project the person created, with its own name, address, and saved stack, in place of a new one. */
  const chooseExisting = async (projectId: string) => {
    if (creating || state.who === null) return;
    const flow = state.flow;
    dispatch({ type: "choose", who: state.who });
    try {
      const setup = await backend.projectSetup(projectId);
      dispatch({ type: "created", flow, project: { id: setup.projectId, name: setup.projectName, reviewUrl: setup.address, stack: setup.stack?.id ?? null } });
    } catch (failure) {
      dispatch({ type: "create-failed", flow, message: failureMessage(failure, copy.who.useFailed), limit: true });
    }
  };

  const failure = state.create.status === "failed" ? state.create.message : null;
  // An address Critiqs can't save, such as HTTP on a private network, is said before choosing, not dropped quietly.
  const unsaved = typeof state.address.url === "string" && reviewUrlOf(state.address) === null ? shownHost(state.address.url) : null;
  const option = (who: Who) => {
    const { label, detail } = copy.who[who];
    const busy = creating && state.who === who;
    return (
      <button type="button" className="choice" aria-busy={busy} disabled={creating || !ready} onClick={() => void choose(who)}>
        <span className="choice-icon" aria-hidden="true">
          {who === "me" ? <CodeGlyph /> : <MailGlyph />}
        </span>
        <span className="choice-text">
          <span className="choice-label">{label}</span>
          <span className="choice-detail">{busy ? copy.who.creating : detail}</span>
        </span>
        {busy && <span className="spinner" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <>
      <button type="button" className="quiet back" disabled={creating} onClick={() => dispatch({ type: "back" })}>
        <BackGlyph />
        {copy.back}
      </button>
      <Heading id={titleId} title={copy.who.title} lead={copy.who.lead} />
      <div className="choices" role="group" aria-labelledby={titleId}>
        {option("me")}
        {option("developer")}
      </div>
      {creating && (
        <p className="visually-hidden" role="status">
          {copy.who.creating}
        </p>
      )}
      {(choices.length > 1 || lost) && (
        <div className="row organization">
          <span className="note" id={organizationLabel}>
            {copy.who.organization}
          </span>
          <Select
            value={chosen?.id ?? ""}
            options={choices.map((organization) => ({ value: organization.id, label: organization.name }))}
            labelledBy={organizationLabel}
            disabled={creating}
            onChange={(value) => dispatch({ type: "organization", organizationId: value })}
          />
        </div>
      )}
      {unsaved !== null && <p className="note">{copy.who.addressNotSaved(unsaved)}</p>}
      {lost && (
        <p className="error" role="alert">
          {copy.who.organizationLost(names.current.get(state.organizationId!) ?? null)}
        </p>
      )}
      {organizations.status === "error" && (
        <p className="error" role="alert">
          {copy.who.organizationsFailed(organizations.message)}
        </p>
      )}
      {failure !== null && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {limited && (
        <div className="stacked limit-recovery">
          {upgradeUrl.status === "ready" && upgradeUrl.data !== null && (
            <div>
              <a className="btn" href={upgradeUrl.data} target="_blank" rel="noreferrer noopener">
                {copy.who.upgrade}
              </a>
            </div>
          )}
          {mine.status === "ready" && mine.data.length > 0 && (
            <div className="stacked">
              <p className="note" id={existingLabel}>
                {copy.who.useExisting}
              </p>
              <div className="project-list" role="group" aria-labelledby={existingLabel}>
                {mine.data.map((project) => (
                  <button key={project._id} type="button" disabled={creating} onClick={() => void chooseExisting(project._id)}>
                    <span className="project-name">{project.name}</span>
                    <span className="note">{copy.who.projectDetail(project.organization?.name ?? null, project.reviewUrl, project.createdAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** The command or the email, then the "while you're here" questions once the person has done it. */
function SetupScreen({ state, dispatch }: { state: FlowState; dispatch: Dispatch<FlowAction> }) {
  // Once shown, the email panel stays mounted while the command shows, so a send in flight, its answer, an error, or a field being added
  // are all still there when the person switches back.
  const [sendOpened, setSendOpened] = useState(state.who === "developer");
  if (state.who === "developer" && !sendOpened) setSendOpened(true);
  // Switching panels moves focus to the shown panel's heading, as a new screen does.
  const panels = useRef<HTMLDivElement>(null);
  const shownWho = useRef(state.who);
  useEffect(() => {
    if (shownWho.current === state.who) return;
    shownWho.current = state.who;
    panels.current?.querySelector<HTMLElement>(".panel:not([hidden]) h1")?.focus();
  }, [state.who]);
  const project = state.project;
  // The flow reaches this screen only by creating the project.
  if (project === null || state.who === null) return null;
  const flow = state.flow;
  const done = () => dispatch({ type: "setup-done", flow });
  return (
    <>
      <div ref={panels} className="panels">
        {state.who === "me" && (
          <div className="panel">
            <InstallPanel project={project} onDone={done} />
          </div>
        )}
        {sendOpened && (
          <div className="panel" hidden={state.who !== "developer"}>
            <SendPanel project={project} developers={state.developers} onDevelopers={(developers) => dispatch({ type: "developers", developers })} email={state.reviewer?.email ?? null} onDone={done} />
          </div>
        )}
      </div>
      <div>
        <button type="button" className="quiet" onClick={() => dispatch({ type: "switch-who" })}>
          {state.who === "me" ? copy.install.switch : copy.send.switch}
        </button>
      </div>
      {/* The first question arrives while focus stays on what the person just used, so it's announced. */}
      <div aria-live="polite">
        {state.about.shown && <AboutYou asking={state.about.asking} onAnswered={() => dispatch({ type: "about-answered" })} onSkip={() => dispatch({ type: "about-skip" })} />}
      </div>
    </>
  );
}

function BackGlyph() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CodeGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m4.5 7 7.5 6 7.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
