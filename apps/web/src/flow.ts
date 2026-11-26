import {
  type AddressCheck,
  type CodeAccess,
  inboxOf,
  isPrivateHost,
  MAX_DEVELOPER_INVITES_PER_PROJECT,
  type OnboardingAnswers,
  type StackId,
  validReviewUrl,
} from "@critiqs/core";
import { copy } from "./copy.ts";

// Onboarding as data: a typed list of steps and one reducer over them. Each
// step after sign-in asks one question; Skip removes that one answer, Back
// keeps every answer until the project exists, and nothing here talks to the
// backend: the page runs the address check and project creation and reports
// their results as actions. A flow belongs to one signed-in reviewer, and
// each flow has its own number, so a result that arrives after the reviewer
// changed or started over is dropped.

export const STEPS = ["sign-in", "address", "role", "team-size", "code-access", "feedback-from", "purpose", "create", "recommendation"] as const;
export type StepId = (typeof STEPS)[number];

/** Steps that ask a question, so they offer Skip. Sign-in, creating the project, and the recommendation ask none. */
export const SKIPPABLE: ReadonlySet<StepId> = new Set<StepId>(["address", "role", "team-size", "code-access", "feedback-from", "purpose"]);

/** A framework someone picked, or "I'm not sure". */
export type StackChoice = StackId | "unsure";

/**
 * The address step. `checked` holds what Critiqs found, or what the person
 * said ("It's only on my computer", "I don't have one yet"), with the
 * address to save as the review address when it is one.
 */
export type AddressState =
  | { status: "editing"; text: string; error: string | null }
  | { status: "checking"; text: string; url: string }
  | { status: "checked"; text: string; url: string | null; check: AddressCheck };

export interface StackState {
  /** What the address check found, which the person confirms with "Use …". */
  detected: StackId | null;
  chosen: StackChoice | null;
  /** The framework picker is open: nothing was detected, or the person chose Change. */
  picking: boolean;
}

/** The project as created, with the answers it was created with: the recommendation and the copied message match what the server keeps. */
export interface CreatedProject {
  id: string;
  name: string;
  reviewUrl: string | null;
  answers: OnboardingAnswers;
  stack: StackId | null;
  check: AddressCheck;
}

/** The signed-in reviewer a flow belongs to: their ID, and their address for the developer emails' own-address check. */
export interface FlowReviewer {
  id: string;
  email: string;
}

/** Creating the project: the request is pending, or failed with the server's message; `limit` is a plan's project limit. */
export type CreateState = { status: "idle" } | { status: "creating" } | { status: "failed"; message: string; limit: boolean };

export interface FlowState {
  step: StepId;
  reviewer: FlowReviewer | null;
  /** This flow's number. Sign-in changes, sign-out, and Start over begin a new one; results for an earlier one are dropped. */
  flow: number;
  address: AddressState;
  stack: StackState;
  answers: OnboardingAnswers;
  /** The developer email fields as typed; empty fields are ignored. */
  developers: string[];
  /** Errors show once Continue was refused, then update as the person types. */
  showDeveloperErrors: boolean;
  /** How many times Continue was refused for the developer emails; each time, focus moves to the first invalid field. */
  developerCheck: number;
  /** Null until the person edits it; then the name field shows `defaultProjectName`. */
  projectName: string | null;
  /** The organization to create in: the one shown first, or one the person chose; null until the create step sets it. */
  organizationId: string | null;
  create: CreateState;
  project: CreatedProject | null;
}

export type FlowAction =
  | { type: "signed-in"; reviewer: FlowReviewer }
  | { type: "signed-out" }
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "address-text"; text: string }
  | { type: "address-invalid" }
  | { type: "address-check-started"; url: string }
  | { type: "address-checked"; flow: number; url: string; check: AddressCheck }
  | { type: "address-check-failed"; flow: number; url: string; error: string }
  | { type: "address-only-local" }
  | { type: "address-none" }
  | { type: "stack-use" }
  | { type: "stack-change" }
  | { type: "stack-pick"; stack: StackChoice | null }
  | { type: "answer"; answer: Partial<OnboardingAnswers> }
  | { type: "developers"; developers: string[] }
  | { type: "project-name"; name: string }
  | { type: "organization"; organizationId: string }
  | { type: "create-started" }
  | { type: "created"; flow: number; project: CreatedProject }
  | { type: "create-failed"; flow: number; message: string; limit: boolean }
  | { type: "start-over" };

const EMPTY_ADDRESS: AddressState = { status: "editing", text: "", error: null };
const NO_STACK: StackState = { detected: null, chosen: null, picking: false };

export function initialFlow(reviewer: FlowReviewer | null = null, flow = 0): FlowState {
  return {
    step: reviewer === null ? "sign-in" : "address",
    reviewer,
    flow,
    address: EMPTY_ADDRESS,
    stack: NO_STACK,
    answers: {},
    developers: [""],
    showDeveloperErrors: false,
    developerCheck: 0,
    projectName: null,
    organizationId: null,
    create: { status: "idle" },
    project: null,
  };
}

/** Whether Back is offered: not on the first step, not while the project is being created, and not once it exists, since answers can't change it then. */
export function canGoBack(state: FlowState): boolean {
  return state.step !== STEPS[0] && state.create.status !== "creating" && state.project === null;
}

function stepAfter(step: StepId): StepId {
  return STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]!;
}

function stepBefore(step: StepId): StepId {
  return STEPS[Math.max(STEPS.indexOf(step) - 1, 0)]!;
}

/** "Can you change the prototype's code?" as shown: the answer, or Yes already chosen for an engineer. */
export function shownCodeAccess(answers: OnboardingAnswers): CodeAccess | undefined {
  return answers.codeAccess ?? (answers.role === "engineer" ? "self" : undefined);
}

/** Whether the code-access step shows the developer email fields. */
export function asksForDevelopers(access: CodeAccess | undefined): boolean {
  return access === "teammate" || access === "nobody";
}

/** Whether the current step has an answer to continue with. Without one, Skip is the way on. */
export function canContinue(state: FlowState): boolean {
  switch (state.step) {
    case "sign-in":
      return state.reviewer !== null;
    case "address":
      return state.address.status === "checked";
    case "role":
      return state.answers.role !== undefined;
    case "team-size":
      return state.answers.teamSize !== undefined;
    case "code-access":
      return shownCodeAccess(state.answers) !== undefined;
    case "feedback-from":
      return (state.answers.feedbackFrom?.length ?? 0) > 0;
    case "purpose":
      return state.answers.purpose !== undefined;
    case "create":
      return state.project !== null;
    case "recommendation":
      return false;
    default: {
      const exhaustive: never = state.step;
      return exhaustive;
    }
  }
}

/** The answer each question step asks for. The address step's answer is its own state. */
const ANSWER_OF: Partial<Record<StepId, keyof OnboardingAnswers>> = {
  role: "role",
  "team-size": "teamSize",
  "code-access": "codeAccess",
  "feedback-from": "feedbackFrom",
  purpose: "purpose",
};

/** The current step's answer, removed: Skip leaves it absent. */
function withoutAnswer(state: FlowState): FlowState {
  if (state.step === "address") return { ...state, address: EMPTY_ADDRESS, stack: NO_STACK };
  const key = ANSWER_OF[state.step];
  return key === undefined ? state : { ...state, answers: clean({ ...state.answers, [key]: undefined }), showDeveloperErrors: false };
}

/** Answers without fields that hold `undefined` or an empty list, so a skipped answer is absent, not present and empty. */
function clean(answers: OnboardingAnswers): OnboardingAnswers {
  return Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))) as OnboardingAnswers;
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  // A result for an earlier flow, such as another reviewer's or one started over, changes nothing.
  if ("flow" in action && action.flow !== state.flow) return state;
  switch (action.type) {
    case "signed-in":
      // Another reviewer's flow is theirs: the new one starts fresh.
      if (state.reviewer !== null && state.reviewer.id !== action.reviewer.id) return initialFlow(action.reviewer, state.flow + 1);
      return { ...state, reviewer: action.reviewer, step: state.step === "sign-in" ? "address" : state.step };
    case "signed-out":
      return initialFlow(null, state.flow + 1);
    case "next": {
      if (!canContinue(state)) return state;
      if (state.step === "code-access") {
        const access = shownCodeAccess(state.answers)!;
        if (asksForDevelopers(access) && developerErrors(state.developers, state.reviewer?.email ?? null).some((error) => error !== null)) {
          return { ...state, showDeveloperErrors: true, developerCheck: state.developerCheck + 1 };
        }
        return { ...state, answers: { ...state.answers, codeAccess: access }, showDeveloperErrors: false, step: stepAfter(state.step) };
      }
      return { ...state, step: stepAfter(state.step) };
    }
    case "back":
      return canGoBack(state) ? { ...state, step: stepBefore(state.step) } : state;
    case "skip":
      return SKIPPABLE.has(state.step) ? { ...withoutAnswer(state), step: stepAfter(state.step) } : state;
    case "address-text":
      // Changing the address drops what was found at the old one.
      return { ...state, address: { status: "editing", text: action.text, error: null }, stack: NO_STACK };
    case "address-invalid":
      return state.address.status === "editing" ? { ...state, address: { ...state.address, error: copy.address.invalid } } : state;
    case "address-check-started":
      return { ...state, address: { status: "checking", text: state.address.text, url: action.url }, stack: NO_STACK };
    case "address-checked": {
      // A result for an address the person has since changed is ignored.
      if (state.address.status !== "checking" || state.address.url !== action.url) return state;
      const detected = "stack" in action.check ? action.check.stack : null;
      return {
        ...state,
        address: { status: "checked", text: state.address.text, url: action.url, check: action.check },
        stack: { detected, chosen: null, picking: detected === null },
      };
    }
    case "address-check-failed":
      if (state.address.status !== "checking" || state.address.url !== action.url) return state;
      return { ...state, address: { status: "editing", text: state.address.text, error: action.error } };
    case "address-only-local":
      return { ...state, address: { status: "checked", text: "", url: null, check: { kind: "local" } }, stack: { ...NO_STACK, picking: true } };
    case "address-none":
      return { ...state, address: { status: "checked", text: "", url: null, check: { kind: "none" } }, stack: { ...NO_STACK, picking: true } };
    case "stack-use":
      if (state.stack.detected === null || state.address.status !== "checked") return state;
      return { ...state, stack: { ...state.stack, chosen: state.stack.detected, picking: false }, step: stepAfter(state.step) };
    case "stack-change":
      // The picker starts on what was found, so Continue without a new choice keeps it.
      return { ...state, stack: { ...state.stack, picking: true, chosen: state.stack.chosen ?? state.stack.detected } };
    case "stack-pick":
      return { ...state, stack: { ...state.stack, chosen: action.stack } };
    case "answer":
      return { ...state, answers: clean({ ...state.answers, ...action.answer }) };
    case "developers":
      return { ...state, developers: action.developers.slice(0, MAX_DEVELOPER_INVITES_PER_PROJECT) };
    case "project-name":
      return state.create.status === "creating" ? state : { ...state, projectName: action.name };
    case "organization":
      return state.create.status === "creating" ? state : { ...state, organizationId: action.organizationId };
    case "create-started":
      // One request at a time: the step stays, and Back and Create wait for its answer.
      return state.step !== "create" || state.project !== null || state.create.status === "creating" ? state : { ...state, create: { status: "creating" } };
    case "created":
      return state.create.status === "creating" ? { ...state, create: { status: "idle" }, project: action.project, step: "recommendation" } : state;
    case "create-failed":
      return state.create.status === "creating" ? { ...state, create: { status: "failed", message: action.message, limit: action.limit } } : state;
    case "start-over":
      return initialFlow(state.reviewer, state.flow + 1);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

// What the steps hand to the backend.

/** The stack to save with the project: a framework picked or confirmed; "I'm not sure" or none is no stack. */
export function savedStack(stack: StackState): StackId | null {
  return stack.chosen === null || stack.chosen === "unsure" ? null : stack.chosen;
}

/** What the recommendation reads: the check, or no address when the step was skipped. */
export function addressCheckOf(address: AddressState): AddressCheck {
  return address.status === "checked" ? address.check : { kind: "none" };
}

/** The review address to save: the checked address when it is a valid one (HTTPS, or HTTP on this computer). */
export function reviewUrlOf(address: AddressState): string | null {
  return address.status === "checked" && address.url !== null ? validReviewUrl(address.url) : null;
}

/**
 * The name field's starting value: the first part of the address's host,
 * such as "acme-proto" for acme-proto.vercel.app, or "My prototype". Not the
 * whole host: Critiqs won't email setup steps for a project whose name
 * contains a web address.
 */
export function defaultProjectName(address: AddressState): string {
  if (address.status !== "checked" || address.url === null) return copy.create.defaultName;
  const host = new URL(address.url).hostname;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return copy.create.defaultName;
  return host.split(".").find((label) => label !== "" && label !== "www") ?? copy.create.defaultName;
}

export function projectNameOf(state: FlowState): string {
  return state.projectName ?? defaultProjectName(state.address);
}

// Addresses.

/**
 * The address to check from what the person typed, with `https://` added to
 * a bare host (`http://` for one on this computer or a private network,
 * except Tailscale's `*.ts.net`), or null when it isn't an
 * http or https address without a username or password.
 */
export function addressToCheck(text: string): URL | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const host = trimmed.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, "");
    // Tailscale serves *.ts.net names over HTTPS, so they get https:// as public hosts do.
    candidate = `${isPrivateHost(host) && !/\.ts\.net\.?$/i.test(host) ? "http" : "https"}://${trimmed}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
    return url;
  } catch {
    return null;
  }
}

// Developer emails.

/** An address as the server reads it: trimmed, lowercase, with the shape `inviteAddress` accepts; null otherwise. */
export function emailAddress(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(email)) return null;
  return email.endsWith(".") || email.includes("..") || email.includes(".@") ? null : email;
}

/**
 * One error per field, or null: empty fields are fine and ignored. Addresses
 * are compared by inbox, as the server counts them (`inboxOf`): another
 * spelling of an address already entered, or of the person's own, is the same.
 */
export function developerErrors(fields: readonly string[], ownEmail: string | null): (string | null)[] {
  const own = ownEmail === null ? null : inboxOf(ownEmail);
  const seen = new Set<string>();
  return fields.map((field) => {
    if (field.trim() === "") return null;
    const email = emailAddress(field);
    if (email === null) return copy.developers.invalid;
    const inbox = inboxOf(email);
    if (inbox === own) return copy.developers.own;
    if (seen.has(inbox)) return copy.developers.duplicate(field.trim());
    seen.add(inbox);
    return null;
  });
}

/** The addresses to send to: the filled-in fields, trimmed. */
export function filledDevelopers(fields: readonly string[]): string[] {
  return fields.map((field) => field.trim()).filter((field) => field !== "");
}

// Keeping the flow across a reload of the page, in this tab only, for the
// reviewer it belongs to.

const STORAGE_KEY = "critiqs:onboarding:v2";

/** Saves a signed-in reviewer's flow; with no one signed in, removes any saved one. */
export function saveFlow(storage: Storage | null, state: FlowState): void {
  if (state.reviewer === null) return clearFlow(storage);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be full or blocked; the flow still works without it.
  }
}

/**
 * The saved flow for the signed-in reviewer, or a new one. Another
 * reviewer's saved flow, or one saved with nobody signed in, is removed. A
 * check that was running when the page closed starts over. So does a create:
 * its request may have finished, and nothing ties a new request to it, so
 * creating again after a reload during a create can make a second project.
 */
export function restoreFlow(storage: Storage | null, reviewer: FlowReviewer | null): FlowState {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw == null) return initialFlow(reviewer);
    const saved = JSON.parse(raw) as FlowState;
    if (reviewer === null || saved.reviewer?.id !== reviewer.id || !STEPS.includes(saved.step)) {
      clearFlow(storage);
      return initialFlow(reviewer);
    }
    const address: AddressState = saved.address.status === "checking" ? { status: "editing", text: saved.address.text, error: null } : saved.address;
    const create: CreateState = saved.create?.status === "creating" ? { status: "idle" } : (saved.create ?? { status: "idle" });
    return { ...initialFlow(reviewer), ...saved, reviewer, address, create, step: saved.step === "sign-in" ? "address" : saved.step };
  } catch {
    return initialFlow(reviewer);
  }
}

/** This tab's storage for the draft, or null when the browser blocks it. */
export function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Removes the draft whenever the session has nobody signed in, on any page
 * and after any tab's sign-out, so a signed-out browser keeps no answers.
 * Returns the function that stops it.
 */
export function clearFlowOnSignOut(session: { subscribe(listener: () => void): () => void; getSnapshot(): { reviewer: unknown } }, storage: Storage | null): () => void {
  const check = () => {
    if (session.getSnapshot().reviewer === null) clearFlow(storage);
  };
  check();
  return session.subscribe(check);
}

export function clearFlow(storage: Storage | null): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
