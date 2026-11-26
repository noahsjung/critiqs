import { type AddressCheck, availableWays, isLocalAddress, type OrganizationSummary, recommend, type StackId, type Way } from "@critiqs/core";
import { type Dispatch, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { type Backend, failureCode, failureMessage, type NewProject, useAcceptInvites, useAuth, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import {
  checkFor,
  choicesFor,
  CODE_ACCESS_OF,
  defaultProjectName,
  type FlowAction,
  flowReducer,
  type FlowReviewer,
  type FlowState,
  newCreateKey,
  otherWays,
  pendingCreate,
  restoreFlow,
  reviewUrlOf,
  saveFlow,
  savePendingCreate,
  sessionStore,
  shownHost,
  STEPS,
  type Who,
} from "../flow.ts";
import { Select } from "../shared.ts";
import { AboutYou, SuggestedPlan } from "./AboutYou.tsx";
import { InviteTeam } from "./Invite.tsx";
import { ConnectionStatus, Heading, Progress } from "./parts.tsx";
import { Preview } from "./Preview.tsx";
import { ExtensionPanel, InstallPanel, SendPanel, ShareBuildPanel } from "./Ways.tsx";

/**
 * Onboarding at /start, in three screens: the prototype's link, who adds
 * Critiqs, then the command or the email. Signing in happens when the person
 * leaves the first screen. The flow and its saved draft belong to the
 * signed-in reviewer: another reviewer starts fresh, and signing out removes
 * the draft.
 */
export function Onboarding() {
  const auth = useAuth();
  useAcceptInvites();
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
 * What the check found at an address, checked once per reviewer and address:
 * the check runs as the person signed in, so another reviewer's is never
 * reused. It names the stack saved with the project and orders the ways in,
 * so a failed check is null, and an address on this computer or a private
 * network is never sent to the server.
 */
export function useAddressCheck(backend: Backend): (reviewerId: string, url: string) => Promise<AddressCheck | null> {
  const checks = useRef(new Map<string, Promise<AddressCheck | null>>());
  return useCallback(
    (reviewerId: string, url: string) => {
      const key = `${reviewerId} ${url}`;
      let found = checks.current.get(key);
      if (found === undefined) {
        found = isLocalAddress(new URL(url))
          ? Promise.resolve({ kind: "local" } as const)
          : backend.checkAddress(url).then(
              (check) => check,
              () => null,
            );
        checks.current.set(key, found);
      }
      return found;
    },
    [backend],
  );
}

/** The stack a check found, or null. */
function stackIn(check: AddressCheck | null): StackId | null {
  return check !== null && "stack" in check ? check.stack : null;
}

/**
 * The keys of creates each flow sent that haven't answered yet, by the flow's
 * `dispatch`, which lasts as long as the page. A screen shown again while one
 * is out leaves it to its own answer, which still reaches the flow, rather
 * than sending it again.
 */
const sendingFor = new WeakMap<Dispatch<FlowAction>, Set<string>>();

/** The current screen beside the preview. Exported for tests, which drive it with a fake backend. */
export function OnboardingScreen({ state, dispatch }: { state: FlowState; dispatch: Dispatch<FlowAction> }) {
  const backend = useBackend();
  const checkOf = useAddressCheck(backend);
  const stackOf = useCallback(async (reviewerId: string, address: string) => stackIn(await checkOf(reviewerId, address)), [checkOf]);
  const url = state.address.url;
  // What the check found, for the address it was about: the choices' order follows it.
  const [found, setFound] = useState<{ url: string; check: AddressCheck | null } | null>(null);
  // The check starts as soon as someone signed in has given a link, so it's usually done before they choose.
  useEffect(() => {
    if (state.reviewer === null || typeof url !== "string" || state.project !== null) return;
    let current = true;
    void checkOf(state.reviewer.id, url).then((check) => {
      if (current) setFound({ url, check });
    });
    return () => void (current = false);
  }, [state.reviewer?.id, url, state.project === null]);
  const check = checkFor(url, found !== null && found.url === url ? found.check : null);

  const host = state.project?.reviewUrl != null ? shownHost(state.project.reviewUrl) : state.address.text.trim() === "" ? null : shownHost(state.address.text);
  return (
    <div className="flow">
      <section className="flow-main" aria-live="off">
        <Progress step={STEPS.indexOf(state.step) + 1} count={STEPS.length} />
        {state.step === "address" && <AddressScreen state={state} dispatch={dispatch} />}
        {state.step === "who" && <WhoScreen state={state} dispatch={dispatch} stackOf={stackOf} check={check} />}
        {state.step === "setup" && <SetupScreen state={state} dispatch={dispatch} check={check} checkOf={checkOf} />}
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
 * Who will add Critiqs to it? The recommended way comes first, marked, with
 * the others below it: the person, their developer, or no one for now, with
 * the browser extension when there's an address to open. Choosing creates
 * the project, named after the link, in the person's organization, with the stack the check found. The
 * choices wait for the organizations: a project never goes to one the person
 * didn't see. With several, the one it goes in is shown and can be changed;
 * if the chosen one leaves the list, nothing is chosen until the person
 * picks again. A plan's project limit offers the projects the person created
 * and, for an admin, the deployment's upgrade page.
 *
 * On a backend with create keys, the request goes out with the attempt's
 * key, kept in this tab first, so a reload sends the same request again and
 * gets the same project. A screen shown again (after a reload, or sign-in
 * being accepted again) with a create pending picks it up. One this page
 * still has out waits for its answer. One sent before a reload goes again
 * under its key when the backend takes keys and the key is under 23 hours
 * old. Any other, including one still waiting on the address check, is
 * called off, so the choices open at once and the old attempt never sends.
 */
function WhoScreen({
  state,
  dispatch,
  stackOf,
  check,
}: {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
  stackOf: (reviewerId: string, url: string) => Promise<StackId | null>;
  check: AddressCheck;
}) {
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
  const sending = sendingFor.get(dispatch) ?? new Set<string>();
  sendingFor.set(dispatch, sending);
  // A reviewer change, sign-out, or sign-in still being accepted replaces this screen.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => void (shown.current = false);
  }, []);

  /** Sends the attempt's create; on a backend with create keys, under its key, which the caller kept first. */
  const send = async (key: string, project: NewProject) => {
    dispatch({ type: "create-sent", key });
    sending.add(key);
    try {
      const id = await backend.createProject(backend.createKeys ? { ...project, idempotencyKey: key } : project);
      dispatch({ type: "created", key, project: { id, name: project.name, reviewUrl: project.reviewUrl, stack: project.stack } });
    } catch (failure) {
      dispatch({ type: "create-failed", key, message: failureMessage(failure, copy.who.failed), limit: failureCode(failure) === "limit" });
    } finally {
      sending.delete(key);
    }
  };

  // A create pending when this screen appears was started by an earlier one: see the comment above.
  const resumed = useRef(false);
  useEffect(() => {
    const pending = state.create;
    if (pending.status !== "creating" || resumed.current) return;
    resumed.current = true;
    if (pending.sent && sending.has(pending.key)) return;
    const saved = pending.sent && backend.createKeys && state.reviewer !== null ? pendingCreate(sessionStore(), state.reviewer.id, pending.key) : null;
    if (saved === null) return dispatch({ type: "create-cancelled", key: pending.key });
    void send(saved.key, saved.project);
  }, []);

  const choose = async (who: Who) => {
    if (creating || !ready) return;
    const key = newCreateKey();
    dispatch({ type: "choose", who, key });
    const name = defaultProjectName(state.address);
    const reviewUrl = reviewUrlOf(state.address);
    // The organization the person saw when they chose. If it's gone by the time the request is sent, the server refuses it, and that's shown.
    const organizationId = chosen?.id ?? null;
    const stack = typeof state.address.url === "string" && state.reviewer !== null ? await stackOf(state.reviewer.id, state.address.url) : null;
    // While the check ran, the screen may have gone: nothing is created. A screen shown again has already opened the choice.
    if (!shown.current) return dispatch({ type: "create-cancelled", key });
    const codeAccess = CODE_ACCESS_OF[who];
    const project: NewProject = { name, reviewUrl, organizationId, answers: codeAccess === undefined ? {} : { codeAccess }, stack };
    // Kept once, before the first send: a resend after a reload keeps the time it was first sent, which the 23 hours count from.
    if (backend.createKeys && state.reviewer !== null) savePendingCreate(sessionStore(), { reviewerId: state.reviewer.id, key, project });
    await send(key, project);
  };

  /** Uses a project the person created, with its own name, address, and saved stack, in place of a new one. */
  const chooseExisting = async (projectId: string) => {
    if (creating || state.who === null) return;
    const key = newCreateKey();
    dispatch({ type: "choose", who: state.who, key });
    dispatch({ type: "create-sent", key });
    sending.add(key);
    try {
      const setup = await backend.projectSetup(projectId);
      dispatch({ type: "created", key, project: { id: setup.projectId, name: setup.projectName, reviewUrl: setup.address, stack: setup.stack?.id ?? null } });
    } catch (failure) {
      dispatch({ type: "create-failed", key, message: failureMessage(failure, copy.who.useFailed), limit: true });
    } finally {
      sending.delete(key);
    }
  };

  const failure = state.create.status === "failed" ? state.create.message : null;
  // An address Critiqs can't save, such as HTTP on a private network, is said before choosing, not dropped quietly.
  const unsaved = typeof state.address.url === "string" && reviewUrlOf(state.address) === null ? shownHost(state.address.url) : null;
  const ways = choicesFor(check);
  const option = (who: Who, recommended: boolean) => {
    const { label, detail } = copy.who[who];
    const busy = creating && state.who === who;
    return (
      <button key={who} type="button" className={recommended ? "choice recommended" : "choice"} aria-busy={busy} disabled={creating || !ready} onClick={() => void choose(who)}>
        <span className="choice-icon" aria-hidden="true">
          {who === "me" ? <CodeGlyph /> : who === "developer" ? <MailGlyph /> : <ExtensionGlyph />}
        </span>
        <span className="choice-text">
          <span className="choice-label">
            {label}
            {recommended && <span className="badge">{copy.who.recommended}</span>}
          </span>
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
      <div className="choices" role="group" aria-labelledby={titleId} aria-describedby={`${titleId}-why`}>
        {ways.order.map((who, index) => option(who, index === 0))}
      </div>
      <p className="note" id={`${titleId}-why`}>
        {copy.who.reason[ways.reason]}
      </p>
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

/**
 * The chosen way: the command, the email, or the browser extension, with the
 * other ways below it, best first, then the ways to review without installing
 * this deployment offers, then the "while you're here" questions once the
 * person has done it.
 */
function SetupScreen({
  state,
  dispatch,
  check,
  checkOf,
}: {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
  check: AddressCheck;
  checkOf: (reviewerId: string, url: string) => Promise<AddressCheck | null>;
}) {
  // Once shown, the email panel stays mounted while another way shows, so a send in flight, its answer, an error, or a field being added
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
  const others = otherWays(state.who, check);
  const host = project.reviewUrl === null ? null : shownHost(project.reviewUrl);
  return (
    <>
      <div ref={panels} className="panels">
        {state.who === "me" && (
          <div className="panel">
            <InstallPanel project={project} onDone={done} />
            <ProjectConnection projectId={project.id} host={host} />
          </div>
        )}
        {sendOpened && (
          <div className="panel" hidden={state.who !== "developer"}>
            <SendPanel project={project} developers={state.developers} onDevelopers={(developers) => dispatch({ type: "developers", developers })} email={state.reviewer?.email ?? null} onDone={done} />
          </div>
        )}
        {state.who === "extension" && (
          <div className="panel">
            <ExtensionPanel project={project} prototype={typeof state.address.url === "string" ? state.address.url : null} email={state.reviewer?.email ?? null} onDone={done} />
          </div>
        )}
      </div>
      {others.length > 0 && (
        <div className="other-ways">
          {others.map((other) => (
            <button key={other} type="button" className="quiet" onClick={() => dispatch({ type: "switch-who", who: other })}>
              {copy.ways.switchTo[other]}
            </button>
          ))}
        </div>
      )}
      {state.reviewer !== null && <FreeWays projectId={project.id} who={state.who} url={typeof state.address.url === "string" ? state.address.url : null} reviewerId={state.reviewer.id} checkOf={checkOf} />}
      {/* The first question arrives while focus stays on what the person just used, so it's announced. */}
      <div aria-live="polite">
        {state.about.shown && (
          <AboutYou
            asking={state.about.asking}
            onAnswered={(answer) => dispatch({ type: "about-answered", ...("teamSize" in answer ? { teamSize: answer.teamSize } : {}) })}
            onSkip={() => dispatch({ type: "about-skip" })}
          />
        )}
        {state.about.teamSize !== undefined && <SuggestedPlan projectId={project.id} teamSize={state.about.teamSize} />}
        {/* Once the questions are done, unless it's just them: "Just me" leaves inviting for later. */}
        {state.about.shown && state.about.asking === null && state.about.teamSize !== "just-me" && (
          <InviteTeam project={project} email={state.reviewer?.email ?? null} />
        )}
      </div>
    </>
  );
}

/** Whether Critiqs has loaded with the new project yet, live. */
function ProjectConnection({ projectId, host }: { projectId: string; host: string | null }) {
  return <ConnectionStatus setup={useBackend().useProjectSetup(projectId)} host={host} />;
}

/** The ways in that need nothing installed. */
const FREE_WAYS: readonly Way[] = ["review-link", "share-build", "allow-critiqs"];

/**
 * Ways to review without installing, as `recommend()` orders them for the
 * person's answer and the address check, among those the deployment offers
 * (`availableWays` from `/critiqs/config`). None show where it offers none.
 */
export function FreeWays({ projectId, who, url, reviewerId, checkOf }: { projectId: string; who: NonNullable<FlowState["who"]>; url: string | null; reviewerId: string; checkOf: (reviewerId: string, url: string) => Promise<AddressCheck | null> }) {
  const backend = useBackend();
  const [check, setCheck] = useState<AddressCheck | null | undefined>(url === null ? { kind: "none" } : undefined);
  useEffect(() => {
    if (url === null) return setCheck({ kind: "none" });
    let current = true;
    void checkOf(reviewerId, url).then((found) => current && setCheck(found ?? { kind: "unreachable" }));
    return () => void (current = false);
  }, [url, reviewerId, checkOf]);
  if (check === undefined || check === null || backend.reviewLinks === null) return null;
  const { primary, others } = recommend({ codeAccess: CODE_ACCESS_OF[who] }, check, availableWays(backend.reviewLinks));
  const ways = [primary, ...others].filter((way) => FREE_WAYS.includes(way));
  if (ways.length === 0) return null;
  return (
    <section className="stacked ways-free" aria-labelledby="ways-free-title">
      <h2 id="ways-free-title">{copy.ways.title}</h2>
      <p className="note">{copy.ways.lead}</p>
      <ul className="way-cards">
        {ways.map((way) => (
          <li key={way} className="way-card" data-way={way}>
            {way === "review-link" && (
              <>
                <h3>{copy.ways.reviewLink.title}</h3>
                <p>{copy.ways.reviewLink.text}</p>
                <div>
                  <a className="btn" href={`/review-links/${encodeURIComponent(projectId)}`}>
                    {copy.ways.reviewLink.action}
                  </a>
                </div>
              </>
            )}
            {way === "share-build" && <ShareBuildPanel projectId={projectId} />}
            {way === "allow-critiqs" && url !== null && <AllowCritiqsWay projectId={projectId} url={url} onAllowed={() => setCheck({ kind: "public", stack: null })} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A prototype that refuses Critiqs's server: set up Allow Critiqs, then Check again from here. Allowed, the review link takes its place. */
function AllowCritiqsWay({ projectId, url, onAllowed }: { projectId: string; url: string; onAllowed: () => void }) {
  const backend = useBackend();
  const origin = new URL(url).origin;
  const [state, setState] = useState<{ status: "idle" | "checking" } | { status: "said"; text: string }>({ status: "idle" });
  const check = async () => {
    setState({ status: "checking" });
    try {
      await backend.issueAllowCritiqs(projectId, origin);
      const found = await backend.checkAllowCritiqs(projectId, origin);
      if (found.verified) onAllowed();
      else setState({ status: "said", text: copy.allowCritiqs.results[found.result] ?? copy.allowCritiqs.failed });
    } catch (failure) {
      setState({ status: "said", text: failureMessage(failure, copy.allowCritiqs.failed) });
    }
  };
  return (
    <>
      <h3>{copy.ways.allowCritiqs.title}</h3>
      <p>{copy.ways.allowCritiqs.text(shownHost(url))}</p>
      <div className="actions">
        <a className="btn" href={`/allow-critiqs?project=${encodeURIComponent(projectId)}&origin=${encodeURIComponent(origin)}`}>
          {copy.ways.allowCritiqs.action}
        </a>
        <button type="button" className="btn quiet" disabled={state.status === "checking"} onClick={() => void check()}>
          {state.status === "checking" ? copy.allowCritiqs.checking : copy.allowCritiqs.check}
        </button>
      </div>
      {state.status === "said" && (
        <p className="note" role="status">
          {state.text}
        </p>
      )}
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

function ExtensionGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path
        d="M9.5 4.5h3a1.5 1.5 0 0 1 3 0h3v4a1.5 1.5 0 0 1 0 3v4h-4a1.5 1.5 0 0 0-3 0h-4v-4a1.5 1.5 0 0 0 0-3v-4h2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
