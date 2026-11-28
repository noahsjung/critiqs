import type { ManageableProjects, PanelSignInErrorCode, ProjectInfo } from "@critiqs/core";

/**
 * Messages between Critiqs drawn on a page (a content script) and the
 * extension's worker, which alone holds the sign-in. The worker answers only
 * the top frame of a tab, from this extension, and takes the page's address
 * from Chrome's own record of the tab, never from a message. No answer
 * carries a refresh token or a sign-in attempt key; only `critiqs:token`
 * carries an access token, and only to a tab Critiqs is open in.
 */
export type OverlayRequest =
  | { type: "critiqs:session" }
  | { type: "critiqs:token"; force: boolean }
  | { type: "critiqs:sign-in/email"; email: string; again?: SignInHandle }
  | { type: "critiqs:sign-in/code"; handle: SignInHandle; code: string }
  | { type: "critiqs:sign-in/name"; handle: SignInHandle; name: string }
  | { type: "critiqs:sign-out" }
  | { type: "critiqs:set-name"; name: string }
  | { type: "critiqs:project" }
  | { type: "critiqs:project/choose"; projectId: string }
  | { type: "critiqs:project/start" }
  | { type: "critiqs:project/manageable" }
  | { type: "critiqs:project/add"; projectId: string }
  | { type: "critiqs:capture" }
  | { type: "critiqs:auto" }
  | { type: "critiqs:hidden"; hidden: boolean };

/** The worker's answer about the reviewer: no tokens. */
export type SessionView = { reviewer: { id: string; name: string; email: string } | null };

/** An opaque key the worker maps to the sign-in attempt it holds; the attempt key itself never leaves the worker. */
export type SignInHandle = string & { readonly __brand: "SignInHandle" };

export type SignInFailure = { status: "failed"; code: PanelSignInErrorCode; message: string; guessesLeft?: number; retryAfter?: number };

export type ProjectView =
  | { kind: "show"; project: ProjectInfo; choices: ProjectInfo[] | null; origin: string }
  | { kind: "choose"; projects: ProjectInfo[]; origin: string }
  | { kind: "none"; origin: string }
  | { kind: "signed-out" }
  /** An address no project can list, such as `file://`. */
  | { kind: "unsupported" };

/** The worker won't answer this sender: a frame, another extension, no tab, or a tab Critiqs isn't open in. */
export type OverlayRefusal = { refused: string };

/** The worker tried and the backend refused or couldn't be reached; `message` is Critiqs's own sentence. */
export type OverlayFailure = { failed: string };

/** What the worker answers to each request, besides a refusal or a failure. */
export interface OverlayAnswers {
  "critiqs:session": SessionView;
  "critiqs:token": { token: string | null };
  "critiqs:sign-in/email": { handle: SignInHandle; email: string; developmentCode?: string } | SignInFailure;
  "critiqs:sign-in/code": { status: "signed-in" } | { status: "needs-name" } | SignInFailure;
  "critiqs:sign-in/name": { status: "signed-in" } | SignInFailure;
  "critiqs:sign-out": { signedOut: true };
  "critiqs:set-name": { applied: boolean };
  "critiqs:project": ProjectView;
  "critiqs:project/choose": ProjectView;
  "critiqs:project/start": ProjectView;
  "critiqs:project/manageable": ManageableProjects;
  "critiqs:project/add": ProjectView;
  "critiqs:capture": { image: string | null };
  "critiqs:auto": { on: boolean };
  "critiqs:hidden": { hidden: boolean };
}

export type OverlayAnswer<T extends OverlayRequest["type"]> = OverlayAnswers[T] | OverlayRefusal | OverlayFailure;

/**
 * Worker to page (`chrome.tabs.sendMessage`). `session-changed`: the reviewer
 * signed in or out, changed their name, or this site's automatic comments
 * were turned on or off; ask again. `toggle`: the icon was clicked again.
 */
export type WorkerMessage = { type: "critiqs:session-changed" } | { type: "critiqs:toggle" };

export const SESSION_CHANGED = { type: "critiqs:session-changed" } as const satisfies WorkerMessage;

/** Longest strings the worker accepts; anything longer is not a request it answers. */
const LIMITS = { email: 320, code: 32, name: 200, id: 64, handle: 64 } as const;

const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;

/**
 * A request the worker answers, read field by field: only the fields its
 * type names are kept, so anything else a page put in the message (such as
 * another site's address) never reaches the worker's code. Null for anything
 * that isn't one.
 */
export function parseOverlayRequest(value: unknown): OverlayRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "critiqs:session":
    case "critiqs:sign-out":
    case "critiqs:project":
    case "critiqs:project/start":
    case "critiqs:project/manageable":
    case "critiqs:capture":
    case "critiqs:auto":
      return { type: message.type };
    case "critiqs:token":
      return { type: message.type, force: message.force === true };
    case "critiqs:hidden":
      return typeof message.hidden === "boolean" ? { type: message.type, hidden: message.hidden } : null;
    case "critiqs:sign-in/email":
      if (!text(message.email, LIMITS.email)) return null;
      if (message.again === undefined) return { type: message.type, email: message.email };
      return text(message.again, LIMITS.handle) ? { type: message.type, email: message.email, again: message.again as SignInHandle } : null;
    case "critiqs:sign-in/code":
      return text(message.handle, LIMITS.handle) && text(message.code, LIMITS.code) ? { type: message.type, handle: message.handle as SignInHandle, code: message.code } : null;
    case "critiqs:sign-in/name":
      return text(message.handle, LIMITS.handle) && text(message.name, LIMITS.name) ? { type: message.type, handle: message.handle as SignInHandle, name: message.name } : null;
    case "critiqs:set-name":
      return text(message.name, LIMITS.name) ? { type: message.type, name: message.name } : null;
    case "critiqs:project/choose":
    case "critiqs:project/add":
      return text(message.projectId, LIMITS.id) ? { type: message.type, projectId: message.projectId } : null;
    default:
      return null;
  }
}

/** Whether a message to the page is the worker's, from this extension. */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "critiqs:session-changed" || type === "critiqs:toggle";
}
