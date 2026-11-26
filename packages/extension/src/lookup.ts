import { originLookupKeys, type ProjectInfo, type ProjectLookup } from "@critiqs/core";
import type { StorageArea } from "./chrome.ts";

/**
 * Which project the side panel shows for a page: the backend's lookup by the
 * page's origin (only among projects the person can already reach), plus the
 * person's own answer when it asked, remembered in the extension for that
 * person and origin. The same `localhost` address is a different app on each
 * computer, so the answer is never saved on the server.
 */

/** What the side panel needs from the backend, signed in as the reviewer. */
export interface ProjectsApi {
  findForOrigin(origin: string): Promise<ProjectLookup>;
  /** Projects the person created; owners may change their address lists. */
  listMine(): Promise<ProjectInfo[]>;
  create(name: string): Promise<string>;
  addresses(projectId: string): Promise<string[]>;
  setAddresses(projectId: string, addresses: string[]): Promise<string[]>;
  get(projectId: string): Promise<ProjectInfo>;
}

export type ProjectChoice =
  /** `choices`: the projects the person chose among, so they can choose again; null when one project matched. */
  | { kind: "show"; project: ProjectInfo; choices: ProjectInfo[] | null }
  | { kind: "choose"; projects: ProjectInfo[] }
  | { kind: "none" };

/** The page's origin as the lookup reads it, or null for pages a project can't list, such as `chrome://` or `file://`. */
export function pageOrigin(url: string | undefined): string | null {
  if (url === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return originLookupKeys(parsed.origin)?.origin ?? null;
}

const choiceKey = (signInUrl: string, reviewerId: string, origin: string) => `choice:${signInUrl}:${reviewerId}:${origin}`;

/** The person's remembered answers to "Which project is this?", one per sign-in service, person, and origin. */
export class Choices {
  constructor(
    private readonly storage: StorageArea,
    private readonly signInUrl: string,
  ) {}

  async get(reviewerId: string, origin: string): Promise<string | null> {
    const key = choiceKey(this.signInUrl, reviewerId, origin);
    const value = (await this.storage.get(key))[key];
    return typeof value === "string" ? value : null;
  }

  async remember(reviewerId: string, origin: string, projectId: string): Promise<void> {
    await this.storage.set({ [choiceKey(this.signInUrl, reviewerId, origin)]: projectId });
  }

  async forget(reviewerId: string, origin: string): Promise<void> {
    await this.storage.remove(choiceKey(this.signInUrl, reviewerId, origin));
  }
}

/**
 * What to show for the lookup's answer. One match on an origin that isn't
 * ambiguous is shown. Several, or an ambiguous origin, ask, unless the person
 * already chose one of the projects offered now. A remembered project that
 * isn't offered any more (its list changed, or the person lost access) is
 * never shown; the panel asks again.
 */
export function choose(lookup: ProjectLookup, remembered: string | null): ProjectChoice {
  if (lookup.status === "none") return { kind: "none" };
  if (lookup.status === "found") return { kind: "show", project: lookup.project, choices: null };
  const known = lookup.projects.find((project) => project._id === remembered);
  return known === undefined ? { kind: "choose", projects: lookup.projects } : { kind: "show", project: known, choices: lookup.projects };
}

/** Finds the project for a page's origin and applies the person's remembered answer. */
export async function findProject(api: ProjectsApi, choices: Choices, reviewerId: string, origin: string): Promise<ProjectChoice> {
  const [lookup, remembered] = await Promise.all([api.findForOrigin(origin), choices.get(reviewerId, origin)]);
  const choice = choose(lookup, remembered);
  if (remembered !== null && choice.kind !== "show") await choices.forget(reviewerId, origin);
  return choice;
}

/** A new project's name for a site: its host, with the port when it has one, such as `localhost:5173`. */
export function siteName(origin: string): string {
  return new URL(origin).host;
}

/**
 * A project "Start reviewing this site" created whose address didn't save
 * yet, kept in the extension per person and origin, so trying again, even
 * after closing the panel, finishes it rather than creating another.
 */
export class StartedProjects {
  readonly #key: string;
  constructor(
    private readonly storage: StorageArea,
    signInUrl: string,
    reviewerId: string,
    origin: string,
  ) {
    this.#key = `started:${signInUrl}:${reviewerId}:${origin}`;
  }

  async get(): Promise<string | null> {
    const value = (await this.storage.get(this.#key))[this.#key];
    return typeof value === "string" ? value : null;
  }

  set(projectId: string): Promise<void> {
    return this.storage.set({ [this.#key]: projectId });
  }

  clear(): Promise<void> {
    return this.storage.remove(this.#key);
  }
}

/** "Start reviewing this site": a new project whose address list is this origin, or the one started before. Returns its ID. */
export async function startReviewing(api: ProjectsApi, origin: string, started: StartedProjects): Promise<string> {
  let projectId = await started.get();
  if (projectId === null) {
    projectId = await api.create(siteName(origin));
    await started.set(projectId);
  }
  // Added rather than set: someone may have added addresses to a project started earlier.
  await addToProject(api, projectId, origin);
  await started.clear();
  return projectId;
}

/** "Add to a project": adds this origin to the address list of a project the person owns. */
export async function addToProject(api: ProjectsApi, projectId: string, origin: string): Promise<void> {
  const current = await api.addresses(projectId);
  if (current.includes(origin)) return;
  await api.setAddresses(projectId, [...current, origin]);
}

/** Projects the person created and may still manage, for "Add to a project". Projects they manage only as an organization admin aren't listed: the backend has no query for them yet. */
export async function ownedProjects(api: ProjectsApi): Promise<ProjectInfo[]> {
  return (await api.listMine()).filter((project) => project.isOwner);
}
