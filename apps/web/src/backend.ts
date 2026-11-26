import { api } from "@critiqs/backend/api";
import type {
  AddressCheck,
  DeveloperSendResult,
  DeveloperSendSummary,
  DeveloperSetup,
  OnboardingAnswers,
  OrganizationSummary,
  ProjectInfo,
  ProjectSetup,
  Role,
  StackId,
  TeamSize,
} from "@critiqs/core";
import type { ConvexReactClient } from "convex/react";
import type { GenericId as Id } from "convex/values";
import { createContext, useContext } from "react";
import { describeError, type QueryState, type Reviewer, useAllPages, useQueryState, useUtcDay } from "./shared.ts";

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
}

export interface Backend {
  /**
   * The `backend` property the prototype's <Critiqs /> needs to reach this
   * backend: null for Critiqs Cloud, the component's default. `init
   * <projectId>` doesn't write it, so the install steps say to add it.
   */
  componentBackend: string | null;
  checkAddress(address: string): Promise<AddressCheck>;
  saveAboutYou(answers: { role?: Role; teamSize?: TeamSize }): Promise<void>;
  createProject(project: NewProject): Promise<string>;
  sendDeveloperSetup(projectId: string, emails: string[]): Promise<DeveloperSendResult[]>;
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

export function convexBackend(client: ConvexReactClient, componentBackend: string | null): Backend {
  return {
    componentBackend,
    checkAddress: (address) => client.action(api.addressCheck.check, { address }),
    saveAboutYou: async (answers) => {
      await client.mutation(api.onboarding.saveAboutYou, answers);
    },
    createProject: async ({ name, reviewUrl, organizationId, answers, stack }) =>
      await client.mutation(api.projects.create, {
        name,
        reviewUrl,
        ...(organizationId === null ? {} : { organizationId }),
        onboarding: { codeAccess: answers.codeAccess, purpose: answers.purpose, feedbackFrom: answers.feedbackFrom === undefined ? undefined : [...answers.feedbackFrom] },
        ...(stack === null ? {} : { stack }),
      }),
    sendDeveloperSetup: (projectId, emails) => client.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails }),
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
  };
}
