import { api } from "@critiqs/backend/api";
import type {
  AddressCheck,
  BillingStatus,
  DeveloperSendResult,
  DeveloperSendSummary,
  DeveloperSetup,
  MessageView,
  NewMention,
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
import type { FunctionReturnType } from "convex/server";
import type { GenericId as Id } from "convex/values";
import { createContext, useContext, useEffect } from "react";
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

/** What opening a review link gives (`reviewLinks:open`): a lease for its frame, or why not. */
export type ReviewOpen = FunctionReturnType<typeof api.reviewLinks.open>;
export type ReviewReady = Extract<ReviewOpen, { kind: "ready" }>;
export type ReviewRenewal = FunctionReturnType<typeof api.reviewLinks.renew>;
export type ReviewLeaseState = FunctionReturnType<typeof api.reviewLinks.leaseState>;
export type ReviewAdoption = FunctionReturnType<typeof api.reviewLinks.adopt>;
export type ReviewLinkSummary = FunctionReturnType<typeof api.reviewLinks.list>[number];
export type CreatedReviewLink = FunctionReturnType<typeof api.reviewLinks.createLive>;

/** Review links as `/critiqs/config` reports them. */
export interface ReviewLinksCapability {
  version: number;
  live: boolean;
  builds: boolean;
  allowCritiqs: boolean;
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
  /** The backend sends a developer the setup steps again, 24 hours after their email (`resend` on `sendDeveloperSetup`). */
  developerResends: boolean;
  /** The backend adds one address to a project's address list (`projects:addAddress`), which the browser extension finds projects by. */
  addressEdits: boolean;
  checkAddress(address: string): Promise<AddressCheck>;
  saveAboutYou(answers: { role?: Role; teamSize?: TeamSize }): Promise<void>;
  createProject(project: NewProject): Promise<string>;
  /** Emails the steps to each address; `resend` sends them again to addresses whose email went out (only with `developerResends`). */
  sendDeveloperSetup(projectId: string, emails: string[], resend?: boolean): Promise<DeveloperSendResult[]>;
  /**
   * Invites someone to the organization as a member, for its admins; an
   * invite email links to the project's review address. `email` says whether
   * that email is on its way, or this deployment can't send it.
   */
  inviteMember(organizationId: string, email: string, projectId: string): Promise<InviteAnswer>;
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
  /** An organization's plan, what each plan includes, and their prices; null where the deployment takes no payment. Null skips it. */
  useBillingStatus(organizationId: string | null): QueryState<BillingStatus | null>;
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
  replyOnThreadPage(threadId: string, body: string, mentions?: NewMention[]): Promise<void>;
  /**
   * A thread page's image, through the same check as the page: null when the
   * backend has none to give (404); throws when the download fails, so the
   * page can offer to try again.
   */
  loadThreadPageCapture(key: string): Promise<Blob | null>;
  /** The deployment's review links, from `/critiqs/config`; null when it has none. */
  reviewLinks: ReviewLinksCapability | null;
  /**
   * Opens a review link by its key, as the signed-in person or signed out.
   * Anything that isn't ready says nothing about whether the key exists.
   */
  openReviewLink(key: string): Promise<ReviewOpen>;
  /** Keeps a lease for another ten minutes while every check still passes; `ended` otherwise. */
  renewReviewLease(leaseId: string, renewalSecret: string): Promise<ReviewRenewal>;
  /** Whether a lease still serves, live: `ended` as soon as its link is removed or closed to the viewer. */
  useReviewLease(leaseId: string, renewalSecret: string): QueryState<ReviewLeaseState>;
  /** Binds a signed-out lease to the person who just signed in, keeping the frame as it is, and names the project. */
  adoptReviewLease(leaseId: string, renewalSecret: string): Promise<ReviewAdoption>;
  /** Records that the signed-in viewer opened the project, as an install does. */
  recordReviewOpened(leaseId: string, renewalSecret: string): Promise<void>;
  /** A project's review links, for its owners, live. */
  useReviewLinks(projectId: string | null): QueryState<ReviewLinkSummary[]>;
  createReviewLink(projectId: string, address: string, requestKey: string): Promise<CreatedReviewLink>;
  /** A link's address again, for its owners. */
  copyReviewLink(linkId: string): Promise<string>;
  revokeReviewLink(linkId: string): Promise<void>;
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

/** The reviewers each backend already accepted pending invitations for on this page. */
const invitesAccepted = new WeakMap<Backend, Set<string>>();

/**
 * Accepts the signed-in person's pending invitations to organizations
 * (`syncReviewer`), once per page load and reviewer, as signing in through an
 * install does: someone invited who signs in on the website joins too. A
 * failure is tried again on the next page load.
 */
export function useAcceptInvites(): void {
  const auth = useAuth();
  const backend = useBackend();
  const reviewerId = auth.ready ? (auth.reviewer?.id ?? null) : null;
  useEffect(() => {
    if (reviewerId === null) return;
    const accepted = invitesAccepted.get(backend) ?? new Set<string>();
    invitesAccepted.set(backend, accepted);
    if (accepted.has(reviewerId)) return;
    accepted.add(reviewerId);
    backend.syncReviewer().catch(() => accepted.delete(reviewerId));
  }, [backend, reviewerId]);
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

/** What inviting someone did: invited (with whether the invite email is on its way), or nothing, as they're already a member or invited. */
export type InviteAnswer = { status: "invited"; email?: "pending" | "not-sent" } | { status: "member" } | { status: "pending" };

/** What a backend reports it can do, beyond what every backend the website works with does. */
export type BackendFeatures = Pick<Backend, "createKeys" | "addressEdits" | "developerResends" | "reviewLinks">;

/**
 * The deployment at `given`, as critiqs-react's `resolveDeployment` finds
 * it, and what it can do: `createKeys`, `addressEdits`, `developerResends`, and `reviewLinks` in the same
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
  return {
    deployment,
    createKeys: config?.createKeys === true,
    addressEdits: config?.addressEdits === true,
    developerResends: config?.developerResends === true,
    reviewLinks: reviewLinksOf(config?.reviewLinks),
  };
}

/** The review links a config reports, read field by field; null for anything else. */
export function reviewLinksOf(raw: unknown): ReviewLinksCapability | null {
  if (raw === null || typeof raw !== "object") return null;
  const { version, live, builds, allowCritiqs } = raw as Record<string, unknown>;
  if (version !== 1 || typeof live !== "boolean") return null;
  return { version, live, builds: builds === true, allowCritiqs: allowCritiqs === true };
}

export function convexBackend(client: ConvexReactClient, componentBackend: string | null, captures: CaptureAccess, features: BackendFeatures): Backend {
  return {
    componentBackend,
    ...features,
    openReviewLink: (key) => client.mutation(api.reviewLinks.open, { key }),
    renewReviewLease: (leaseId, renewalSecret) => client.mutation(api.reviewLinks.renew, { leaseId, renewalSecret }),
    useReviewLease: (leaseId, renewalSecret) => useQueryState(api.reviewLinks.leaseState, { leaseId, renewalSecret }),
    adoptReviewLease: (leaseId, renewalSecret) => client.mutation(api.reviewLinks.adopt, { leaseId, renewalSecret }),
    recordReviewOpened: async (leaseId, renewalSecret) => {
      await client.mutation(api.reviewLinks.recordOpened, { leaseId, renewalSecret });
    },
    useReviewLinks: (projectId) => useQueryState(api.reviewLinks.list, projectId === null ? "skip" : { projectId }),
    createReviewLink: (projectId, address, requestKey) => client.mutation(api.reviewLinks.createLive, { projectId, address, requestKey }),
    copyReviewLink: async (linkId) => (await client.query(api.reviewLinks.copy, { linkId })).url,
    revokeReviewLink: async (linkId) => {
      await client.mutation(api.reviewLinks.revoke, { linkId });
    },
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
    sendDeveloperSetup: (projectId, emails, resend) => client.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails, ...(resend === true ? { resend } : {}) }),
    inviteMember: (organizationId, email, projectId) => client.mutation(api.organizations.invite, { organizationId, email, role: "member", projectId }) as Promise<InviteAnswer>,
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
    useBillingStatus: (organizationId) => useQueryState(api.billing.status, organizationId === null ? "skip" : { organizationId }),
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
    replyOnThreadPage: async (threadId, body, mentions = []) => {
      await client.mutation(api.threads.reply, { threadId: threadId as Id<"threads">, body, revision: null, threadPage: true, ...(mentions.length === 0 ? {} : { mentions: mentions.map(({ userId, label }) => ({ userId: userId as Id<"users">, label })) }) });
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
