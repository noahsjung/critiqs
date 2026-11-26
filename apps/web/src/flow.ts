import { type CodeAccess, inboxOf, isPrivateHost, MAX_DEVELOPER_INVITES_PER_PROJECT, type Role, type StackId, type TeamSize, validReviewUrl } from "@critiqs/core";
import type { NewProject } from "./backend.ts";
import { copy } from "./copy.ts";

// Onboarding as data: three screens and one reducer over them.
//
//   address  What should your team review? (a link, or "It's not online yet")
//   who      Who will add Critiqs to it? Choosing creates the project.
//   setup    The command to run, or the email to a developer.
//
// Sign-in happens between the first two, when the person continues. The
// address check runs quietly after sign-in; its only use is the stack saved
// with the project, so it never blocks or shows a result. Nothing here talks
// to the backend: the page does, and reports results as actions. Each flow
// has its own number, so a result that arrives after the reviewer changed or
// the flow restarted is dropped.

export const STEPS = ["address", "who", "setup"] as const;
export type StepId = (typeof STEPS)[number];

/** Who adds Critiqs to the prototype: the person, or a developer they send the steps to. */
export type Who = "me" | "developer";

/** The code-access answer saved with the project for each choice. */
export const CODE_ACCESS_OF: Record<Who, CodeAccess> = { me: "self", developer: "teammate" };

/**
 * The prototype's address as the person gives it. `url` is set once they
 * continue: the address with https:// added where needed, or null for "It's
 * not online yet".
 */
export interface AddressState {
  text: string;
  error: string | null;
  url: string | null | undefined;
}

/** The project as created: what the setup screen and the developer message need. */
export interface CreatedProject {
  id: string;
  name: string;
  reviewUrl: string | null;
  stack: StackId | null;
}

/** The signed-in reviewer a flow belongs to: their ID, and their address for the developer emails' own-address check. */
export interface FlowReviewer {
  id: string;
  email: string;
}

/**
 * Creating the project: pending, or failed with the server's message
 * (`limit` is a plan's project limit). A pending create is one attempt,
 * named by `key` when the person chose; it is `sent` once its request went
 * out, and until then waits on the address check. Results and call-offs
 * name their attempt, so one for an earlier attempt changes nothing.
 */
export type CreateState = { status: "idle" } | { status: "creating"; key: string; sent: boolean } | { status: "failed"; message: string; limit: boolean };

/** The two "while you're here" questions, asked one at a time after setup. */
export const ABOUT_QUESTIONS = ["team-size", "role"] as const;
export type AboutQuestion = (typeof ABOUT_QUESTIONS)[number];

export interface AboutState {
  /** The question showing, or null once both were answered or skipped. */
  asking: AboutQuestion | null;
  /** Shown once the person has done the setup step's action: copied the command, or sent or copied the message. */
  shown: boolean;
}

export interface FlowState {
  step: StepId;
  reviewer: FlowReviewer | null;
  /** This flow's number. Sign-in changes and sign-out begin a new one; results for an earlier one are dropped. */
  flow: number;
  address: AddressState;
  who: Who | null;
  /** The developer email fields as typed; empty fields are ignored. */
  developers: string[];
  /** The organization to create in: the one shown first, or one the person chose; null until the organizations load. */
  organizationId: string | null;
  create: CreateState;
  project: CreatedProject | null;
  about: AboutState;
}

export type FlowAction =
  | { type: "signed-in"; reviewer: FlowReviewer }
  | { type: "signed-out" }
  | { type: "address-text"; text: string }
  | { type: "address-continue" }
  | { type: "address-none" }
  | { type: "back" }
  | { type: "choose"; who: Who; key: string }
  | { type: "switch-who" }
  | { type: "developers"; developers: string[] }
  | { type: "organization"; organizationId: string }
  /** The attempt's request went out. */
  | { type: "create-sent"; key: string }
  | { type: "created"; key: string; project: CreatedProject }
  | { type: "create-failed"; key: string; message: string; limit: boolean }
  /** The attempt was called off before its request went out, such as when the screen went away while it waited on the address check. */
  | { type: "create-cancelled"; key: string }
  | { type: "setup-done"; flow: number }
  | { type: "about-answered" }
  | { type: "about-skip" };

const EMPTY_ADDRESS: AddressState = { text: "", error: null, url: undefined };

export function initialFlow(reviewer: FlowReviewer | null = null, flow = 0): FlowState {
  return {
    step: "address",
    reviewer,
    flow,
    address: EMPTY_ADDRESS,
    who: null,
    developers: [""],
    organizationId: null,
    create: { status: "idle" },
    project: null,
    about: { asking: ABOUT_QUESTIONS[0], shown: false },
  };
}

/** Whether the address is given (a link, or "not online yet") and someone is signed in, so the flow can leave the first screen. */
function addressDone(state: FlowState): boolean {
  return state.address.url !== undefined && state.reviewer !== null;
}

/** Back is offered only on the second screen, and not while the project is being created. */
export function canGoBack(state: FlowState): boolean {
  return state.step === "who" && state.create.status !== "creating";
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  // A result for an earlier flow, such as another reviewer's, changes nothing.
  if ("flow" in action && action.flow !== state.flow) return state;
  switch (action.type) {
    case "signed-in": {
      // Another reviewer's flow is theirs: the new one starts fresh. Someone signing in for the first time keeps what they typed.
      const base: FlowState = state.reviewer !== null && state.reviewer.id !== action.reviewer.id ? initialFlow(action.reviewer, state.flow + 1) : { ...state, reviewer: action.reviewer };
      return base.step === "address" && base.address.url !== undefined ? { ...base, step: "who" } : base;
    }
    case "signed-out":
      return initialFlow(null, state.flow + 1);
    case "address-text":
      return state.step === "address" ? { ...state, address: { text: action.text, error: null, url: undefined } } : state;
    case "address-continue": {
      if (state.step !== "address") return state;
      const url = addressToCheck(state.address.text);
      if (url === null) return { ...state, address: { ...state.address, error: state.address.text.trim() === "" ? copy.address.empty : copy.address.invalid, url: undefined } };
      const next = { ...state, address: { ...state.address, error: null, url: url.href } };
      return addressDone(next) ? { ...next, step: "who" } : next;
    }
    case "address-none": {
      if (state.step !== "address") return state;
      const next = { ...state, address: { text: "", error: null, url: null } };
      return addressDone(next) ? { ...next, step: "who" } : next;
    }
    case "back":
      // Going back keeps the address, but it must be confirmed again with Continue.
      return canGoBack(state) ? { ...state, step: "address", address: { ...state.address, url: undefined }, create: { status: "idle" } } : state;
    case "choose":
      // One request at a time; the page creates the project when it sees `creating`.
      if (state.step !== "who" || state.create.status === "creating") return state;
      return { ...state, who: action.who, create: { status: "creating", key: action.key, sent: false } };
    case "switch-who":
      return state.step === "setup" && state.who !== null ? { ...state, who: state.who === "me" ? "developer" : "me" } : state;
    case "developers":
      return { ...state, developers: action.developers.slice(0, MAX_DEVELOPER_INVITES_PER_PROJECT) };
    case "organization":
      return state.create.status === "creating" ? state : { ...state, organizationId: action.organizationId };
    // Each names its attempt: one for an attempt that isn't pending now changes nothing.
    case "create-sent":
      return isPending(state, action.key) ? { ...state, create: { status: "creating", key: action.key, sent: true } } : state;
    case "created":
      return isPending(state, action.key) ? { ...state, create: { status: "idle" }, project: action.project, step: "setup" } : state;
    case "create-failed":
      return isPending(state, action.key) ? { ...state, create: { status: "failed", message: action.message, limit: action.limit } } : state;
    case "create-cancelled":
      return isPending(state, action.key) ? { ...state, create: { status: "idle" } } : state;
    case "setup-done":
      return state.step === "setup" && !state.about.shown ? { ...state, about: { ...state.about, shown: true } } : state;
    case "about-answered":
    case "about-skip": {
      if (state.about.asking === null) return state;
      const next = ABOUT_QUESTIONS[ABOUT_QUESTIONS.indexOf(state.about.asking) + 1] ?? null;
      return { ...state, about: { ...state.about, asking: next } };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Whether the create pending now is the attempt named `key`. */
function isPending(state: FlowState, key: string): boolean {
  return state.create.status === "creating" && state.create.key === key;
}

/** The answer each "while you're here" question saves. */
export type AboutAnswer = { role: Role } | { teamSize: TeamSize };

// What the screens hand to the backend.

/** The review address to save: the given address when it is a valid one (HTTPS, or HTTP on this computer). */
export function reviewUrlOf(address: AddressState): string | null {
  return typeof address.url === "string" ? validReviewUrl(address.url) : null;
}

/**
 * The project's name: the first part of the address's host, such as
 * "acme-proto" for acme-proto.vercel.app, or "My prototype". Not the whole
 * host: Critiqs won't email setup steps for a project whose name contains a
 * web address. It can be renamed later in Critiqs.
 */
export function defaultProjectName(address: AddressState): string {
  if (typeof address.url !== "string") return copy.defaultProjectName;
  const host = new URL(address.url).hostname;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return copy.defaultProjectName;
  return host.split(".").find((label) => label !== "" && label !== "www") ?? copy.defaultProjectName;
}

/** The host to show for the prototype: what's typed, without https:// or a trailing slash. */
export function shownHost(text: string): string {
  return text.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

// Addresses.

/**
 * The address to check from what the person typed, with `https://` added to
 * a bare host (`http://` for one on this computer or a private network,
 * except Tailscale's `*.ts.net`), or null when it isn't an http or https
 * address without a username or password.
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
    // Browsers differ on what a host may hold: Chrome keeps a space as %20. A host is letters, digits, dots, and hyphens (IDNs arrive as xn--), or an IP literal.
    if (!/^([a-z0-9-]+\.)*[a-z0-9-]+\.?$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)) return null;
    // A host needs a dot, or must be one on this computer or a private network: "hello" is a typo, not a prototype.
    if (!url.hostname.includes(".") && !url.hostname.includes(":") && !isPrivateHost(url.hostname)) return null;
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

const STORAGE_KEY = "critiqs:onboarding:v3";
/** The create whose request went out with an idempotency key, until the flow saves how it ended. */
const PENDING_CREATE_KEY = "critiqs:onboarding:create:v1";
/** Drafts saved by earlier versions of this page, removed with the current one. */
const OLD_STORAGE_KEYS = ["critiqs:onboarding:v2"];

/**
 * Saves a signed-in reviewer's flow; with no one signed in, removes any saved
 * one. Once the saved flow has no create pending, the pending create's key
 * goes too: the project, or the failure, is now saved with the flow.
 */
export function saveFlow(storage: Storage | null, state: FlowState): void {
  if (state.reviewer === null) return clearFlow(storage);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    if (state.create.status !== "creating") storage?.removeItem(PENDING_CREATE_KEY);
  } catch {
    // Storage can be full or blocked; the flow still works without it.
  }
}

/** A create sent with an idempotency key: whose it is, its key, the request, to send again exactly after a reload, and when it was kept. */
export interface PendingCreate {
  reviewerId: string;
  key: string;
  project: NewProject;
  savedAt: number;
}

/**
 * How long a kept create is sent again after a reload: the backend returns
 * the first request's project for 24 hours, so an hour sooner, a resend never
 * reaches a backend that has forgotten the key and makes a second project.
 */
export const PENDING_CREATE_MS = 23 * 60 * 60 * 1000;

/** A new idempotency key: 32 random hex digits. `crypto.randomUUID` needs a secure page; this doesn't. */
export function newCreateKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Keeps a create's key and request in this tab before it is sent. */
export function savePendingCreate(storage: Storage | null, pending: Omit<PendingCreate, "savedAt">, now = Date.now()): void {
  try {
    storage?.setItem(PENDING_CREATE_KEY, JSON.stringify({ ...pending, savedAt: now }));
  } catch {
    // Without storage, a reload can't send it again: the choice opens again, as on backends without keys.
  }
}

/** The reviewer's pending create with `key`, or null, as when it was kept `PENDING_CREATE_MS` or longer ago. */
export function pendingCreate(storage: Storage | null, reviewerId: string, key: string, now = Date.now()): PendingCreate | null {
  try {
    const raw = storage?.getItem(PENDING_CREATE_KEY);
    const pending = raw == null ? null : (JSON.parse(raw) as PendingCreate);
    if (pending === null || pending.reviewerId !== reviewerId || pending.key !== key || typeof pending.project?.name !== "string") return null;
    return typeof pending.savedAt === "number" && now - pending.savedAt >= 0 && now - pending.savedAt < PENDING_CREATE_MS ? pending : null;
  } catch {
    return null;
  }
}

/**
 * The saved flow for the signed-in reviewer, or a new one. Another
 * reviewer's saved flow, or one saved with nobody signed in, is removed. A
 * create that was pending when the page closed stays pending when its
 * request went out with an idempotency key (`PendingCreate`), so the page
 * sends it again and gets the same project. Otherwise it goes back to the
 * choice: nothing was sent yet, or, on a backend without create keys,
 * nothing ties a new request to the old one, so choosing again after a
 * reload during a create can make a second project there.
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
    const create: CreateState =
      saved.create?.status !== "creating"
        ? (saved.create ?? { status: "idle" })
        : pendingCreate(storage, reviewer.id, saved.create.key) !== null
          ? { status: "creating", key: saved.create.key, sent: true }
          : { status: "idle" };
    return { ...initialFlow(reviewer), ...saved, reviewer, create };
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
    for (const key of [STORAGE_KEY, PENDING_CREATE_KEY, ...OLD_STORAGE_KEYS]) storage?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}
