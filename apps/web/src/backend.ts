import { api } from "@critiqs/backend/api";
import type {
  AddressCheck,
  DeveloperSendResult,
  DeveloperSendSummary,
  DeveloperSetup,
  MessageView,
  OnboardingAnswers,
  OrganizationSummary,
  ProjectInfo,
  ProjectSetup,
  Role,
  StackId,
  TeamSize,
  ThreadPageDetail,
} from "@critiqs/core";
import type { ConvexReactClient } from "convex/react";
import type { GenericId as Id } from "convex/values";
import { createContext, useContext } from "react";
import { type Deployment, describeError, type QueryState, resolveDeployment, type Reviewer, useAllPages, useQueryState, useUtcDay } from "./shared.ts";

// What the pages need from Critiqs's backend, so they can be tested with a
// fake one. `convexBackend` is the real one: Critiqs Cloud's Convex functions.

/** What the setup page shows: a send's setup, naming who asked, or a project's, from a copied message, naming no one. */
export type SetupInfo = ProjectSetup & { inviterName: string | null };

export interface NewProject {
  name: string;
  reviewUrl: string | null;
  organizationId: string | null;
  answers: Pick<OnboardingAnswers, "codeAccess" | "feedbackFrom" | "purpose">;
  stack: StackId | null;
  /** Sent only to backends with `createKeys`: a retry with the same key returns the project the first request created. */
  idempotencyKey?: string;
}

/**
 * A thread page as it shows: the thread, its project's name and review
 * address, where it was left, and every message so far.
 */
export type ThreadPageData = Omit<ThreadPageDetail, "page" | "isDone" | "continueCursor"> & { messages: Omit<MessageView, "reactions">[] };

export interface Backend {
  /**
   * The `backend` property the prototype's <Critiqs /> needs to reach this
   * backend: null for Critiqs Cloud, the component's default. `init
   * <projectId>` doesn't write it, so the install steps say to add it.
   */
  componentBackend: string | null;
  /** The backend takes `idempotencyKey` on creates; older ones refuse arguments they don't know. */
  createKeys: boolean;
  /** The backend adds one address to a project's address list (`projects:addAddress`), which the browser extension finds projects by. */
  addressEdits: boolean;
  checkAddress(address: string): Promise<AddressCheck>;
  saveAboutYou(answers: { role?: Role; teamSize?: TeamSize }): Promise<void>;
  createProject(project: NewProject): Promise<string>;
  sendDeveloperSetup(projectId: string, emails: string[]): Promise<DeveloperSendResult[]>;
  /** Adds an address to the project's address list, for its owners; returns the list. Only with `addressEdits`. */
  addProjectAddress(projectId: string, address: string): Promise<string[]>;
  /** A project's setup, read once: its name, address, saved stack, and commands. */
  projectSetup(projectId: string): Promise<ProjectSetup>;
  useOrganizations(enabled: boolean): QueryState<OrganizationSummary[]>;
  /** A project as the signed-in reviewer sees it, with their role in its organization. */
  useProject(projectId: string | null): QueryState<ProjectInfo>;
  /** Projects the reviewer created, to use one in place of a new project. */
  useMyProjects(enabled: boolean): QueryState<ProjectInfo[]>;
  /** The deployment's upgrade page, as the plan rows' Upgrade opens it; null when it names none. */
  useUpgradeUrl(enabled: boolean): QueryState<string | null>;
  useDeveloperSends(projectId: string | null): QueryState<DeveloperSendSummary[]>;
  /** A send's setup, from a setup email's link; null skips it. */
  useDeveloperSetup(sendId: string | null): QueryState<DeveloperSetup>;
  /** A project's setup, from a copied message's link; null skips it. */
  useProjectSetup(projectId: string | null): QueryState<ProjectSetup>;
  /** Clears a project's Connected record, for the people who manage it. */
  clearConnected(projectId: string): Promise<void>;
  /**
   * A thread page by its key, live: new replies arrive as they are posted.
   * Anyone who may not open it, and a key that opens nothing, get the same
   * `not-found`; null skips it.
   */
  useThreadPage(key: string | null): QueryState<ThreadPageData>;
  /**
   * Updates the signed-in person's record from their sign-in and accepts the
   * invitations sent to their address, as the installed panel does when it
   * opens; a thread page waits for it, so someone just invited to the
   * project's organization gets in.
   */
  syncReviewer(): Promise<void>;
  /** Replies from a thread page, which the backend allows only to those who may open it. */
  replyOnThreadPage(threadId: string, body: string): Promise<void>;
  /**
   * A thread page's image, through the same check as the page: null when the
   * backend has none to give (404); throws when the download fails, so the
   * page can offer to try again.
   */
  loadThreadPageCapture(key: string): Promise<Blob | null>;
}

/** What reading a thread page's image needs: the deployment's HTTP address and the signed-in person's token. */
export interface CaptureAccess {
  siteUrl: string;
  getToken: () => Promise<string | null>;
}

/** The signed-in person, as the pages see them. `ready`: the backend accepted their sign-in, so calls can start. */
export interface Auth {
  reviewer: Reviewer | null;
  ready: boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export const BackendContext = createContext<Backend | null>(null);
export const AuthContext = createContext<Auth | null>(null);

export function useBackend(): Backend {
  const backend = useContext(BackendContext);
  if (backend === null) throw new Error("The page needs a backend.");
  return backend;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("The page needs sign-in.");
  return auth;
}

/** A failed call's message for people: Critiqs's own explanation when the backend gave one. */
export function failureMessage(error: unknown, fallback: string): string {
  const described = describeError(error);
  return described.code === "error" ? fallback : described.message;
}

/** A failed call's code, such as `limit` for a plan's limit. */
export function failureCode(error: unknown): string {
  return describeError(error).code;
}

/** What a backend reports it can do, beyond what every backend the website works with does. */
export type BackendFeatures = Pick<Backend, "createKeys" | "addressEdits">;

/**
 * The deployment at `given`, as critiqs-react's `resolveDeployment` finds
 * it, and what it can do: `createKeys` and `addressEdits` in the same
 * reading of its `/critiqs/config`, so a backend that reports one is never
 * treated as one that doesn't. Backends that don't say get neither, so an
 * older one is never sent a call or an argument it refuses.
 */
export async function resolveBackend(given: string, fetchFn: typeof fetch = fetch): Promise<{ deployment: Deployment } & BackendFeatures> {
  const configs = new Map<string, unknown>();
  const reading = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchFn(input, init);
    const url = String(input);
    if (url.endsWith("/critiqs/config") && response.ok) configs.set(url, await response.clone().json().catch(() => null));
    return response;
  }) as typeof fetch;
  const deployment = await resolveDeployment(given, reading);
  const config = configs.get(`${deployment.siteUrl}/critiqs/config`) as Record<string, unknown> | null | undefined;
  return { deployment, createKeys: config?.createKeys === true, addressEdits: config?.addressEdits === true };
}

export function convexBackend(client: ConvexReactClient, componentBackend: string | null, captures: CaptureAccess, features: BackendFeatures): Backend {
  return {
    componentBackend,
    ...features,
    checkAddress: (address) => client.action(api.addressCheck.check, { address }),
    saveAboutYou: async (answers) => {
      await client.mutation(api.onboarding.saveAboutYou, answers);
    },
    createProject: async ({ name, reviewUrl, organizationId, answers, stack, idempotencyKey }) =>
      await client.mutation(api.projects.create, {
        name,
        reviewUrl,
        ...(organizationId === null ? {} : { organizationId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        onboarding: { codeAccess: answers.codeAccess, purpose: answers.purpose, feedbackFrom: answers.feedbackFrom === undefined ? undefined : [...answers.feedbackFrom] },
        ...(stack === null ? {} : { stack }),
      }),
    sendDeveloperSetup: (projectId, emails) => client.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails }),
    addProjectAddress: (projectId, address) => client.mutation(api.projects.addAddress, { projectId: projectId as Id<"projects">, address }),
    projectSetup: (projectId) => client.query(api.onboarding.projectSetup, { projectId }),
    useOrganizations: (enabled) => useQueryState(api.organizations.mine, enabled ? {} : "skip"),
    useProject: (projectId) => useQueryState(api.projects.get, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    useMyProjects: (enabled) => {
      const pages = useAllPages(api.projects.listMine, enabled ? {} : "skip");
      return pages.status === "ready" ? { status: "ready", data: pages.data.flatMap((page) => page.page) } : pages;
    },
    useUpgradeUrl: (enabled) => {
      // The deployment's upgrade page comes with plan usage, as on the plan rows in Critiqs; a person's own usage needs no project.
      const day = useUtcDay();
      const usage = useQueryState(api.aiSettings.myUsage, enabled ? { day } : "skip");
      return usage.status === "ready" ? { status: "ready", data: usage.data?.upgradeUrl ?? null } : usage;
    },
    useDeveloperSends: (projectId) => useQueryState(api.onboarding.developerSends, projectId === null ? "skip" : { projectId }),
    useDeveloperSetup: (sendId) => useQueryState(api.onboarding.developerSetup, sendId === null ? "skip" : { sendId }),
    useProjectSetup: (projectId) => useQueryState(api.onboarding.projectSetup, projectId === null ? "skip" : { projectId }),
    clearConnected: async (projectId) => {
      await client.mutation(api.onboarding.clearConnected, { projectId });
    },
    useThreadPage: (key) => {
      const pages = useAllPages(api.threads.page, key === null ? "skip" : { key });
      if (pages.status !== "ready") return pages;
      const first = pages.data[0];
      if (first === undefined) return { status: "loading" };
      const { page: _page, isDone: _isDone, continueCursor: _cursor, ...thread } = first;
      return { status: "ready", data: { ...(thread as Omit<ThreadPageDetail, "page" | "isDone" | "continueCursor">), messages: pages.data.flatMap((page) => page.page) } };
    },
    syncReviewer: async () => {
      await client.mutation(api.users.sync, {});
    },
    replyOnThreadPage: async (threadId, body) => {
      await client.mutation(api.threads.reply, { threadId: threadId as Id<"threads">, body, revision: null, threadPage: true });
    },
    // Convex file URLs alone would bypass the page's check, so the image comes through Critiqs's route, as in the panel.
    loadThreadPageCapture: async (key) => {
      const token = await captures.getToken();
      // Signed in but the token didn't refresh, such as offline: worth trying again.
      if (token === null) throw new Error("Couldn't confirm your sign-in to load the image.");
      // The key goes in a header: request logs record addresses, and a key opens the page for anyone the page lets in.
      const response = await fetch(`${captures.siteUrl}/capture`, { headers: { Authorization: `Bearer ${token}`, "X-Critiqs-Thread-Page": key } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`The image couldn't be loaded (${response.status}).`);
      return await response.blob();
    },
  };
}
