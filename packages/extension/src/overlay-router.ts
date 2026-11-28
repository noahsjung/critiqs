import { type PanelSignIn, PanelSignInError, type ProjectInfo } from "@critiqs/core";
import { backendMessage, convexProjects } from "./backend.ts";
import { captureTab } from "./capture.ts";
import type { ChromeApi, MessageSender, Tab } from "./chrome.ts";
import { Choices, findProject, pageOrigin, type ProjectChoice, StartKeys, addToProject, startReviewing } from "./lookup.ts";
import type { OverlayAnswers, OverlayFailure, OverlayRefusal, OverlayRequest, ProjectView, SignInFailure, SignInHandle } from "./overlay-protocol.ts";
import type { ExtensionSession, Locks } from "./session.ts";
import { showsAutomatically } from "./site-access.ts";

/**
 * The worker's answers to Critiqs drawn on a page. Every request passes the
 * same gate first: the top frame of a tab, from this extension, in a tab the
 * worker opened Critiqs in (for the site it was opened on) or on a site the
 * person allowed. The page's address always comes from Chrome's `sender.tab`.
 * Sign-in attempts stay here: the page holds an opaque handle, good for its
 * own tab only, for as long as the service keeps the attempt.
 */

/** What the router needs from the worker: the signed-in session, made once per worker start. */
export interface Connection {
  url: string;
  signInUrl: string;
  client: PanelSignIn;
  session: ExtensionSession;
}

type Api = Pick<ChromeApi, "runtime" | "storage" | "tabs" | "permissions" | "scripting">;

/** The service keeps a sign-in attempt this long (the backend's `ATTEMPT_MINUTES`). */
const ATTEMPT_MS = 30 * 60_000;

/** The worker's mark on a tab it opened Critiqs in: the origin of the page it was opened on. */
export const openKey = (tabId: number) => `overlay:${tabId}`;
const hiddenKey = (tabId: number) => `hidden:${tabId}`;
const handleKey = (handle: string) => `sign-in:${handle}`;

/** A sign-in attempt kept in the worker's session storage, which content scripts can't read. */
interface HeldAttempt {
  attempt: string;
  tabId: number;
  email: string;
  createdAt: number;
  step: "code" | "name";
}

/** The origin Chrome reports for a tab's page, opaque ones included, for comparing the page with the one Critiqs was opened on. */
export function tabOrigin(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type ProjectContext =
  | { ready: false; view: Extract<ProjectView, { kind: "signed-out" | "unsupported" }> }
  | { ready: true; origin: string; reviewerId: string; connection: Connection; projects: ReturnType<typeof convexProjects>; choices: Choices };

const refused = (reason: string): OverlayRefusal => ({ refused: reason });

export function overlayRouter(
  chrome: Api,
  connect: () => Promise<Connection>,
  options: { now?: () => number; locks?: Locks | null } = {},
) {
  const now = options.now ?? Date.now;
  const locks = options.locks === undefined ? ((globalThis.navigator as { locks?: Locks } | undefined)?.locks ?? null) : options.locks;

  /** Whether Critiqs is open in this tab: the worker opened it there for this page's site, or the person allowed the site. */
  const critiqsOpen = async (tab: Tab, tabId: number): Promise<boolean> => {
    const key = openKey(tabId);
    const mark = (await chrome.storage.session.get(key))[key] as { origin?: unknown } | undefined;
    const origin = tabOrigin(tab.url);
    if (origin !== null && mark?.origin === origin) return true;
    const site = pageOrigin(tab.url);
    return site !== null && (await showsAutomatically(chrome, site));
  };

  const readAttempt = async (handle: SignInHandle, tabId: number): Promise<HeldAttempt | null> => {
    const key = handleKey(handle);
    const held = (await chrome.storage.session.get(key))[key] as HeldAttempt | undefined;
    if (held === undefined) return null;
    if (now() - held.createdAt > ATTEMPT_MS) {
      await chrome.storage.session.remove(key);
      return null;
    }
    // A handle is its tab's own: another tab, even one Critiqs is open in, can't finish that sign-in.
    return held.tabId === tabId ? held : null;
  };

  const signInFailure = async (error: unknown, handle: SignInHandle | null): Promise<SignInFailure> => {
    if (!(error instanceof PanelSignInError)) throw error;
    // These need a new attempt from the email step.
    if (handle !== null && (error.code === "expired" || error.code === "locked" || error.code === "too-many-codes")) await chrome.storage.session.remove(handleKey(handle));
    return {
      status: "failed",
      code: error.code,
      message: error.message,
      ...(error.guessesLeft === undefined ? {} : { guessesLeft: error.guessesLeft }),
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    };
  };

  const projectView = (choice: ProjectChoice, origin: string): ProjectView =>
    choice.kind === "show" ? { kind: "show", project: choice.project, choices: choice.choices, origin } : choice.kind === "choose" ? { kind: "choose", projects: choice.projects, origin } : { kind: "none", origin };

  /** The tab's site and the reviewer, for the project requests; or the view that says why there's no project to show. */
  const projectContext = async (tab: Tab): Promise<ProjectContext> => {
    const origin = pageOrigin(tab.url);
    if (origin === null) return { ready: false, view: { kind: "unsupported" } };
    const connection = await connect();
    const reviewer = connection.session.reviewer;
    if (reviewer === null) return { ready: false, view: { kind: "signed-out" } };
    return { ready: true, origin, reviewerId: reviewer.id, connection, projects: convexProjects(connection.url, connection.session), choices: new Choices(chrome.storage.local, connection.signInUrl) };
  };

  async function answer(request: OverlayRequest, tab: Tab, tabId: number): Promise<OverlayAnswers[OverlayRequest["type"]] | OverlayRefusal | OverlayFailure> {
    switch (request.type) {
      case "critiqs:session": {
        const { session } = await connect();
        const reviewer = session.reviewer;
        return { reviewer: reviewer === null ? null : { id: reviewer.id, name: reviewer.name, email: reviewer.email } };
      }
      case "critiqs:token":
        return { token: await (await connect()).session.fetchAccessToken({ forceRefreshToken: request.force }) };
      case "critiqs:sign-in/email": {
        const { client } = await connect();
        const held = request.again === undefined ? null : await readAttempt(request.again, tabId);
        if (request.again !== undefined && held === null) return refused("That sign-in has ended. Start again.");
        try {
          const sent = await client.sendCode(request.email, held?.attempt);
          const handle = request.again ?? newHandle();
          const kept: HeldAttempt = { attempt: sent.attempt, tabId, email: sent.email, createdAt: held?.createdAt ?? now(), step: "code" };
          await chrome.storage.session.set({ [handleKey(handle)]: kept });
          return { handle, email: sent.email, ...(sent.developmentCode === undefined ? {} : { developmentCode: sent.developmentCode }) };
        } catch (error) {
          return await signInFailure(error, request.again ?? null);
        }
      }
      case "critiqs:sign-in/code": {
        const held = await readAttempt(request.handle, tabId);
        if (held === null || held.step !== "code") return refused("That sign-in has ended. Start again.");
        const { client, session } = await connect();
        try {
          const result = await client.checkCode(held.attempt, request.code);
          if (result.status === "needs-name") {
            await chrome.storage.session.set({ [handleKey(request.handle)]: { ...held, step: "name" } satisfies HeldAttempt });
            return { status: "needs-name" };
          }
          await chrome.storage.session.remove(handleKey(request.handle));
          await session.signedIn(result);
          return { status: "signed-in" };
        } catch (error) {
          return await signInFailure(error, request.handle);
        }
      }
      case "critiqs:sign-in/name": {
        const held = await readAttempt(request.handle, tabId);
        if (held === null || held.step !== "name") return refused("That sign-in has ended. Start again.");
        const { client, session } = await connect();
        try {
          const signedIn = await client.chooseName(held.attempt, request.name);
          await chrome.storage.session.remove(handleKey(request.handle));
          await session.signedIn(signedIn);
          return { status: "signed-in" };
        } catch (error) {
          return await signInFailure(error, request.handle);
        }
      }
      case "critiqs:sign-out":
        await (await connect()).session.signOut();
        return { signedOut: true };
      case "critiqs:set-name":
        return { applied: await (await connect()).session.setDisplayName(request.name) };
      case "critiqs:project": {
        const context = await projectContext(tab);
        if (!context.ready) return context.view;
        return projectView(await findProject(context.projects, context.choices, context.reviewerId, context.origin), context.origin);
      }
      case "critiqs:project/choose": {
        const context = await projectContext(tab);
        if (!context.ready) return context.view;
        const lookup = await context.projects.findForOrigin(context.origin);
        const offered: ProjectInfo[] = lookup.status === "choose" ? lookup.projects : lookup.status === "found" ? [lookup.project] : [];
        const chosen = offered.find((project) => project._id === request.projectId);
        // Only a project this site's address list offers the reviewer now.
        if (chosen === undefined) return { failed: "That project doesn't list this site. Choose again." };
        await context.choices.remember(context.reviewerId, context.origin, chosen._id);
        return { kind: "show", project: chosen, choices: lookup.status === "choose" ? lookup.projects : null, origin: context.origin };
      }
      case "critiqs:project/start": {
        const context = await projectContext(tab);
        if (!context.ready) return context.view;
        const keys = new StartKeys(chrome.storage.local, context.connection.signInUrl, context.reviewerId, context.origin);
        const started = await startReviewing(context.projects, context.origin, keys, locks);
        // The person's answer for this origin, so an origin such as localhost doesn't ask again.
        if (started.kind === "show" && started.choices === null) await context.choices.remember(context.reviewerId, context.origin, started.project._id);
        return projectView(started, context.origin);
      }
      case "critiqs:project/manageable": {
        const context = await projectContext(tab);
        if (!context.ready) return { failed: context.view.kind === "signed-out" ? "Sign in to Critiqs again." : "No project can list this page's address." };
        return await context.projects.manageable();
      }
      case "critiqs:project/add": {
        const context = await projectContext(tab);
        if (!context.ready) return context.view;
        // The backend allows it only for a project the reviewer manages.
        await addToProject(context.projects, request.projectId, context.origin);
        await context.choices.remember(context.reviewerId, context.origin, request.projectId);
        return { kind: "show", project: await context.projects.get(request.projectId), choices: null, origin: context.origin };
      }
      case "critiqs:capture":
        return { image: await captureTab(chrome, tabId).catch(() => null) };
      case "critiqs:auto": {
        const site = pageOrigin(tab.url);
        return { on: site !== null && (await showsAutomatically(chrome, site)) };
      }
      case "critiqs:hidden":
        await chrome.storage.session.set({ [hiddenKey(tabId)]: request.hidden });
        return { hidden: request.hidden };
    }
  }

  return {
    /** Answers one request, or refuses its sender. Never throws: a failure is answered as one. */
    async handle(request: OverlayRequest, sender: MessageSender): Promise<unknown> {
      const tab = sender.tab;
      const tabId = tab?.id;
      // Only the content script in a tab's top page, from this extension.
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tab === undefined || tabId === undefined) return refused("Critiqs answers only its own page in a tab.");
      if (!(await critiqsOpen(tab, tabId))) return refused("Critiqs isn't open in this tab. Click the Critiqs icon.");
      try {
        return await answer(request, tab, tabId);
      } catch (error) {
        return { failed: failureMessage(error) } satisfies OverlayFailure;
      }
    },
    /** Forgets what the worker knew about a tab's page: a new page, or the tab closed. */
    forgetKeys: (tabId: number) => [openKey(tabId), hiddenKey(tabId)],
  };
}

/** A sentence for the page about a failure: Critiqs's own explanation, never the error's details. */
function failureMessage(error: unknown): string {
  if (error instanceof PanelSignInError) return error.message;
  if (error instanceof Error && /^(Sign in to change your name\.|You signed out, so your name wasn't changed\.|Your name couldn't be changed\.)/.test(error.message)) return error.message;
  return backendMessage(error);
}

/** 32 random bytes, base64url: an opaque handle for a sign-in attempt. */
function newHandle(): SignInHandle {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") as SignInHandle;
}
