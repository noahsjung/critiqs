import { isLocalAddress, type OrganizationSummary, STACKS } from "@critiqs/core";
import { type Dispatch, type ReactNode, useEffect, useId, useReducer, useRef, useState } from "react";
import { failureCode, failureMessage, type NewProject, useAuth, useBackend } from "../backend.ts";
import { checkResult, copy } from "../copy.ts";
import {
  addressCheckOf,
  addressToCheck,
  asksForDevelopers,
  canContinue,
  developerErrors,
  type FlowAction,
  flowReducer,
  type FlowReviewer,
  type FlowState,
  projectNameOf,
  restoreFlow,
  reviewUrlOf,
  saveFlow,
  savedStack,
  sessionStore,
  shownCodeAccess,
  SKIPPABLE,
  type StackChoice,
  STEPS,
} from "../flow.ts";
import { Select } from "../shared.ts";
import { DeveloperEmails } from "./DeveloperEmails.tsx";
import { Actions, CheckList, PageHeader, RadioList, SignInButton } from "./parts.tsx";
import { Recommendation } from "./Recommendation.tsx";

/**
 * Onboarding at /start: sign in, the prototype's address, a question per
 * step, the project, then one recommendation. The flow and its saved draft
 * belong to the signed-in reviewer: another reviewer starts fresh, and
 * signing out removes the draft.
 */
export function Onboarding() {
  const auth = useAuth();
  const backend = useBackend();
  const reviewer: FlowReviewer | null = auth.reviewer === null ? null : { id: auth.reviewer.id, email: auth.reviewer.email };
  const [state, dispatch] = useReducer(flowReducer, reviewer, (signedIn) => restoreFlow(sessionStore(), signedIn));
  useEffect(() => saveFlow(sessionStore(), state), [state]);

  // Finishing sign-in moves past the sign-in step, and another reviewer gets a fresh flow; signing out starts over.
  useEffect(() => {
    if (reviewer === null) {
      if (state.reviewer !== null) dispatch({ type: "signed-out" });
    } else if (auth.ready && (state.reviewer?.id !== reviewer.id || state.reviewer.email !== reviewer.email)) {
      dispatch({ type: "signed-in", reviewer });
    }
  }, [reviewer?.id, reviewer?.email, auth.ready]);

  // "About you" is saved as the person leaves the team-size step, whether they answered or skipped.
  const act: Dispatch<FlowAction> = (action) => {
    if (state.step === "team-size" && (action.type === "next" || action.type === "skip")) {
      const { role, teamSize } = flowReducer(state, action).answers;
      if (role !== undefined || teamSize !== undefined) {
        backend.saveAboutYou({ ...(role === undefined ? {} : { role }), ...(teamSize === undefined ? {} : { teamSize }) }).catch((error) => console.warn("Critiqs couldn't save the About you answers.", error));
      }
    }
    dispatch(action);
  };

  // A stored sign-in is still being accepted by the backend, or the flow is still another reviewer's for a moment.
  if (state.step !== "sign-in" && (!auth.ready || state.reviewer?.id !== reviewer?.id)) return <p className="note">{copy.loading}</p>;
  return <OnboardingStep state={state} dispatch={act} />;
}

/** The current step's page. Exported for tests, which drive it with a fake backend. */
export function OnboardingStep({ state, dispatch }: { state: FlowState; dispatch: Dispatch<FlowAction> }) {
  const titleId = useId();
  const index = STEPS.indexOf(state.step);
  const frame = (title: string, body: ReactNode, primary?: ReactNode) => (
    <>
      <PageHeader
        id={titleId}
        title={title}
        // No Back once the project exists: the answers before it can't change it. It waits while the project is created.
        onBack={index > 0 && state.project === null ? () => dispatch({ type: "back" }) : undefined}
        backDisabled={state.create.status === "creating"}
        step={{ current: index + 1, count: STEPS.length }}
      />
      {body}
      {primary !== undefined && <Actions onSkip={SKIPPABLE.has(state.step) ? () => dispatch({ type: "skip" }) : undefined}>{primary}</Actions>}
    </>
  );
  const next = (
    <button type="button" className="btn primary" disabled={!canContinue(state)} onClick={() => dispatch({ type: "next" })}>
      {copy.continue}
    </button>
  );

  switch (state.step) {
    case "sign-in":
      return frame(copy.signIn.title, <SignInBody state={state} dispatch={dispatch} />);
    case "address":
      return <AddressStep state={state} dispatch={dispatch} frame={frame} />;
    case "role":
      return frame(
        copy.role.title,
        <>
          <p className="lead">{copy.role.lead}</p>
          <RadioList labelledBy={titleId} options={copy.role.options} value={state.answers.role} onChange={(role) => dispatch({ type: "answer", answer: { role } })} />
        </>,
        next,
      );
    case "team-size":
      return frame(
        copy.teamSize.title,
        <RadioList labelledBy={titleId} options={copy.teamSize.options} value={state.answers.teamSize} onChange={(teamSize) => dispatch({ type: "answer", answer: { teamSize } })} />,
        next,
      );
    case "code-access": {
      const access = shownCodeAccess(state.answers);
      return frame(
        copy.codeAccess.title,
        <>
          <p className="lead">{copy.codeAccess.lead}</p>
          <RadioList labelledBy={titleId} options={copy.codeAccess.options} value={access} onChange={(codeAccess) => dispatch({ type: "answer", answer: { codeAccess } })} />
          {asksForDevelopers(access) && (
            <DeveloperEmails
              fields={state.developers}
              onChange={(developers) => dispatch({ type: "developers", developers })}
              errors={state.showDeveloperErrors ? developerErrors(state.developers, state.reviewer?.email ?? null) : null}
              refused={state.developerCheck}
              note={copy.developers.note}
            />
          )}
        </>,
        next,
      );
    }
    case "feedback-from":
      return frame(
        copy.feedbackFrom.title,
        <>
          <p className="lead">{copy.feedbackFrom.lead}</p>
          <CheckList
            labelledBy={titleId}
            options={copy.feedbackFrom.options}
            value={state.answers.feedbackFrom ?? []}
            onChange={(feedbackFrom) => dispatch({ type: "answer", answer: { feedbackFrom } })}
          />
        </>,
        next,
      );
    case "purpose":
      return frame(
        copy.purpose.title,
        <>
          <p className="lead">{copy.purpose.lead}</p>
          <RadioList labelledBy={titleId} options={copy.purpose.options} value={state.answers.purpose} onChange={(purpose) => dispatch({ type: "answer", answer: { purpose } })} />
        </>,
        next,
      );
    case "create":
      return <CreateStep state={state} dispatch={dispatch} frame={frame} />;
    case "recommendation": {
      const project = state.project;
      // The flow reaches the recommendation only by creating the project.
      if (project === null) return frame(copy.create.title, null, next);
      return frame(
        copy.recommendation.title(project.name),
        <>
          <Recommendation project={project} developers={state.developers} onDevelopers={(developers) => dispatch({ type: "developers", developers })} email={state.reviewer?.email ?? null} />
          <div className="ds-actions start-over">
            <button type="button" className="btn ghost" onClick={() => dispatch({ type: "start-over" })}>
              {copy.startOver}
            </button>
          </div>
        </>,
      );
    }
    default: {
      const exhaustive: never = state.step;
      return exhaustive;
    }
  }
}

type Frame = (title: string, body: ReactNode, primary?: ReactNode) => ReactNode;

function SignInBody({ state, dispatch }: { state: FlowState; dispatch: Dispatch<FlowAction> }) {
  const auth = useAuth();
  if (state.reviewer !== null && auth.ready) {
    return (
      <>
        <p className="lead">{copy.signIn.signedInAs(state.reviewer.email)}</p>
        <div>
          <button type="button" className="link-btn" onClick={() => void auth.signOut()}>
            {copy.signIn.useAnother}
          </button>
        </div>
        <Actions>
          <button type="button" className="btn primary" onClick={() => dispatch({ type: "next" })}>
            {copy.continue}
          </button>
        </Actions>
      </>
    );
  }
  return (
    <>
      <p className="lead">{copy.signIn.lead}</p>
      <SignInButton />
    </>
  );
}

const STACK_OPTIONS = [...STACKS.map((stack) => ({ value: stack.id as string, label: stack.label })), { value: "unsure", label: copy.stack.unsure }];

function AddressStep({ state, dispatch, frame }: { state: FlowState; dispatch: Dispatch<FlowAction>; frame: Frame }) {
  const backend = useBackend();
  const fieldId = useId();
  const pickerId = useId();
  const { address, stack } = state;

  const check = async () => {
    const url = addressToCheck(address.text);
    if (url === null) return dispatch({ type: "address-invalid" });
    const flow = state.flow;
    dispatch({ type: "address-check-started", url: url.href });
    // An address on this computer or a private network is never fetched; the server would answer the same.
    if (isLocalAddress(url)) return dispatch({ type: "address-checked", flow, url: url.href, check: { kind: "local" } });
    try {
      dispatch({ type: "address-checked", flow, url: url.href, check: await backend.checkAddress(url.href) });
    } catch (error) {
      dispatch({ type: "address-check-failed", flow, url: url.href, error: failureMessage(error, copy.address.checkFailed) });
    }
  };

  const error = address.status === "editing" ? address.error : null;
  const chosen = stack.chosen === null ? null : STACKS.find((candidate) => candidate.id === stack.chosen) ?? null;
  const detected = stack.detected === null ? null : STACKS.find((candidate) => candidate.id === stack.detected)!;

  let primary: ReactNode;
  if (address.status !== "checked") {
    primary = (
      <button type="submit" form={fieldId + "-form"} className="btn primary" disabled={address.text.trim() === "" || address.status === "checking"}>
        {copy.address.check}
      </button>
    );
  } else if (detected !== null && !stack.picking) {
    primary = (
      <button type="button" className="btn primary" onClick={() => dispatch({ type: "stack-use" })}>
        {copy.stack.use(detected.label)}
      </button>
    );
  } else {
    primary = (
      <button type="button" className="btn primary" onClick={() => dispatch({ type: "next" })}>
        {copy.continue}
      </button>
    );
  }

  return frame(
    copy.address.title,
    <>
      <p className="lead">{copy.address.lead}</p>
      <form
        id={fieldId + "-form"}
        className="stacked address-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (address.status === "editing") void check();
        }}
      >
        <label className="field-label" htmlFor={fieldId}>
          {copy.address.field}
        </label>
        <input
          id={fieldId}
          className="field"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={copy.address.placeholder}
          value={address.text}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${fieldId}-error`}
          onChange={(event) => dispatch({ type: "address-text", text: event.target.value })}
        />
        {error !== null && (
          <p className="error" id={`${fieldId}-error`}>
            {error}
          </p>
        )}
      </form>
      <div className="row wrap quiet-choices">
        <button type="button" className="link-btn" onClick={() => dispatch({ type: "address-only-local" })}>
          {copy.address.onlyOnMyComputer}
        </button>
        <button type="button" className="link-btn" onClick={() => dispatch({ type: "address-none" })}>
          {copy.address.noAddressYet}
        </button>
      </div>
      <div role="status" className="check-status">
        {address.status === "checking" && <p className="note">{copy.address.checking(new URL(address.url).host)}</p>}
        {address.status === "checked" && <CheckResult {...checkResult(address.check, address.url === null ? null : new URL(address.url))} />}
      </div>
      {address.status === "checked" &&
        (detected !== null && !stack.picking ? (
          <div className="row wrap stack-found">
            <span>{copy.stack.detected(detected.label)}</span>
            <button type="button" className="link-btn" onClick={() => dispatch({ type: "stack-change" })}>
              {copy.stack.change}
            </button>
          </div>
        ) : (
          <div className="stacked stack-picker">
            <p className="field-label" id={pickerId}>
              {copy.stack.pickerTitle}
            </p>
            <p className="note">{copy.stack.pickerLead}</p>
            <div>
              <Select
                value={stack.chosen ?? ""}
                options={STACK_OPTIONS}
                labelledBy={pickerId}
                onChange={(value) => dispatch({ type: "stack-pick", stack: value as StackChoice })}
              />
            </div>
            {chosen !== null && !chosen.installable && <p className="caution">{copy.stack.notInstallable(chosen.label)}</p>}
          </div>
        ))}
    </>,
    primary,
  );
}

function CheckResult({ heading, detail }: { heading: string; detail: string }) {
  return (
    <p className="check-result">
      <strong>{heading}</strong>
      <span className="note">{detail}</span>
    </p>
  );
}

/** As the sidebar's project setup chooses: the person's home organization, else the first. */
export function defaultOrganization(choices: readonly OrganizationSummary[]): OrganizationSummary | undefined {
  return choices.find((organization) => organization.home) ?? choices[0];
}

/**
 * Creating the project. Create waits for the organizations, and stays
 * disabled with their error when they can't be loaded: the project never
 * goes to an organization the person didn't see. The one shown first (the
 * home one, else the first) becomes the choice; if the chosen one leaves the
 * person's list while the form is open, the choice is cleared and Create
 * waits until they choose again, even with one left. While the request is
 * pending, Create and Back wait. A plan's project limit offers the projects
 * the person created and, for an admin of the organization, the deployment's
 * upgrade page.
 */
function CreateStep({ state, dispatch, frame }: { state: FlowState; dispatch: Dispatch<FlowAction>; frame: Frame }) {
  const backend = useBackend();
  const organizations = backend.useOrganizations(true);
  const nameId = useId();
  const organizationLabel = useId();
  const existingLabel = useId();
  const [nameMissing, setNameMissing] = useState(false);
  const creating = state.create.status === "creating";
  const limited = state.create.status === "failed" && state.create.limit;
  const choices = organizations.status === "ready" ? organizations.data : [];
  const fallback = defaultOrganization(choices) ?? null;
  const chosen = state.organizationId === null ? fallback : (choices.find((organization) => organization.id === state.organizationId) ?? null);
  // The chosen organization left the list: nothing is chosen until the person picks again. With none left, the server picks.
  const lost = organizations.status === "ready" && state.organizationId !== null && chosen === null && choices.length > 0;
  // Names of the organizations shown, to say which one left.
  const names = useRef(new Map<string, string>());
  for (const organization of choices) names.current.set(organization.id, organization.name);
  // The organization shown first is the one chosen, so its leaving is noticed too.
  useEffect(() => {
    if (organizations.status === "ready" && state.organizationId === null && fallback !== null) dispatch({ type: "organization", organizationId: fallback.id });
  }, [organizations.status, state.organizationId, fallback?.id]);
  const mine = backend.useMyProjects(limited);
  const upgradeUrl = backend.useUpgradeUrl(limited && chosen?.role === "admin");
  const name = projectNameOf(state);

  const create = async () => {
    if (creating || organizations.status !== "ready" || lost) return;
    const trimmed = name.trim();
    setNameMissing(trimmed === "");
    if (trimmed === "") return;
    const flow = state.flow;
    dispatch({ type: "create-started" });
    const { codeAccess, feedbackFrom, purpose } = state.answers;
    const project: NewProject = {
      name: trimmed,
      reviewUrl: reviewUrlOf(state.address),
      organizationId: chosen?.id ?? null,
      answers: { ...(codeAccess === undefined ? {} : { codeAccess }), ...(feedbackFrom === undefined ? {} : { feedbackFrom }), ...(purpose === undefined ? {} : { purpose }) },
      stack: savedStack(state.stack),
    };
    try {
      const id = await backend.createProject(project);
      dispatch({ type: "created", flow, project: { id, name: trimmed, reviewUrl: project.reviewUrl, answers: state.answers, stack: project.stack, check: addressCheckOf(state.address) } });
    } catch (failure) {
      // A plan's project limit, among others: the server's message says which, and the person stays here.
      dispatch({ type: "create-failed", flow, message: failureMessage(failure, copy.create.failed), limit: failureCode(failure) === "limit" });
    }
  };

  /** Uses a project the person created, with its own name, address, and saved stack, in place of a new one. */
  const chooseExisting = async (projectId: string) => {
    if (creating) return;
    const flow = state.flow;
    dispatch({ type: "create-started" });
    try {
      const setup = await backend.projectSetup(projectId);
      dispatch({
        type: "created",
        flow,
        project: { id: setup.projectId, name: setup.projectName, reviewUrl: setup.address, answers: state.answers, stack: setup.stack?.id ?? null, check: addressCheckOf(state.address) },
      });
    } catch (failure) {
      dispatch({ type: "create-failed", flow, message: failureMessage(failure, copy.create.useFailed), limit: true });
    }
  };

  const failure = state.create.status === "failed" ? state.create.message : null;
  // A checked address Critiqs can't save, such as HTTP on a private network, is said before Create, not dropped quietly.
  const unsaved = state.address.status === "checked" && state.address.url !== null && reviewUrlOf(state.address) === null ? state.address.url : null;
  return frame(
    copy.create.title,
    <>
      <form
        id={nameId + "-form"}
        className="stacked create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <p className="lead">{copy.create.lead}</p>
        <label className="field-label" htmlFor={nameId}>
          {copy.create.name}
        </label>
        <input
          id={nameId}
          className="field"
          value={name}
          maxLength={200}
          disabled={creating}
          aria-invalid={nameMissing}
          aria-describedby={nameMissing ? `${nameId}-error` : undefined}
          onChange={(event) => dispatch({ type: "project-name", name: event.target.value })}
        />
        {nameMissing && (
          <p className="error" id={`${nameId}-error`}>
            {copy.create.nameRequired}
          </p>
        )}
        {unsaved !== null && <p className="note">{copy.create.addressNotSaved(unsaved)}</p>}
        {(choices.length > 1 || lost) && (
          <div className="ds-row">
            <span className="field-label" id={organizationLabel}>
              {copy.create.organization}
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
        {lost && (
          <p className="error" role="alert">
            {copy.create.organizationLost(names.current.get(state.organizationId!) ?? null)}
          </p>
        )}
        {organizations.status === "error" && (
          <p className="error" role="alert">
            {copy.create.organizationsFailed(organizations.message)}
          </p>
        )}
        {failure !== null && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
      </form>
      {limited && (
        <div className="stacked limit-recovery">
          {upgradeUrl.status === "ready" && upgradeUrl.data !== null && (
            <div>
              <a className="btn" href={upgradeUrl.data} target="_blank" rel="noreferrer noopener">
                {copy.create.upgrade}
              </a>
            </div>
          )}
          {mine.status === "ready" && mine.data.length > 0 && (
            <div className="stacked">
              <p className="field-label" id={existingLabel}>
                {copy.create.useExisting}
              </p>
              <div className="project-list" role="group" aria-labelledby={existingLabel}>
                {mine.data.map((project) => (
                  <button key={project._id} type="button" disabled={creating} onClick={() => void chooseExisting(project._id)}>
                    <span className="project-name">{project.name}</span>
                    <span className="note">{copy.create.projectDetail(project.organization?.name ?? null, project.reviewUrl, project.createdAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>,
    <button type="submit" form={nameId + "-form"} className="btn primary" disabled={creating || organizations.status !== "ready" || lost}>
      {creating ? copy.create.creating : copy.create.button}
    </button>,
  );
}
