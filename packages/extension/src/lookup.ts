import { type ManageableProjects, originLookupKeys, type ProjectInfo, type ProjectLookup } from "@critiqs/core";
import type { StorageArea } from "./chrome.ts";
import type { Locks } from "./session.ts";

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
  /** Projects whose address lists the person may change: those in organizations they're an admin of, and those they created. */
  manageable(): Promise<ManageableProjects>;
  /** Creates a project; a retry with the same key by the same person returns the same project. */
  create(name: string, idempotencyKey: string): Promise<string>;
  /** Adds one address to a project's list in one step, so people adding at once keep both; returns the list. */
  addAddress(projectId: string, address: string): Promise<string[]>;
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
 * The idempotency key a "Start reviewing this site" under way sends, kept in
 * the extension per sign-in service, person, and origin until the start
 * finishes. Trying again after a lost response or a closed panel sends the
 * same key, so the backend returns the project it already made.
 */
export class StartKeys {
  readonly #key: string;
  constructor(
    private readonly storage: StorageArea,
    signInUrl: string,
    reviewerId: string,
    origin: string,
  ) {
    this.#key = `start:${signInUrl}:${reviewerId}:${origin}`;
  }

  /** The Web Lock that lets one panel at a time start this site for this person. */
  get lockName(): string {
    return `critiqs-${this.#key}`;
  }

  async get(): Promise<string | null> {
    const value = (await this.storage.get(this.#key))[this.#key];
    return typeof value === "string" ? value : null;
  }

  set(key: string): Promise<void> {
    return this.storage.set({ [this.#key]: key });
  }

  clear(): Promise<void> {
    return this.storage.remove(this.#key);
  }
}

/**
 * "Start reviewing this site": a project named for the site whose address
 * list has this origin, or the project another panel started meanwhile. One
 * panel at a time starts a site. A new start looks the site up again first,
 * since a panel may show "No project" from before another one finished;
 * then it sends a new key, so starting again after the site was removed from
 * a project makes a new project.
 */
export async function startReviewing(api: ProjectsApi, origin: string, keys: StartKeys, locks: Locks | null): Promise<ProjectChoice> {
  const work = async (): Promise<ProjectChoice> => {
    let key = await keys.get();
    if (key === null) {
      const lookup = await api.findForOrigin(origin);
      if (lookup.status !== "none") return choose(lookup, null);
      key = `start-${crypto.randomUUID()}`;
      await keys.set(key);
    }
    const projectId = await api.create(siteName(origin), key);
    // Added rather than set: someone may have added addresses to the project since it was started.
    await api.addAddress(projectId, origin);
    await keys.clear();
    return { kind: "show", project: await api.get(projectId), choices: null };
  };
  return locks === null ? await work() : await locks.request(keys.lockName, work);
}

/** "Add to a project": adds this origin to the address list of a project the person manages. */
export async function addToProject(api: ProjectsApi, projectId: string, origin: string): Promise<void> {
  await api.addAddress(projectId, origin);
}

/** Whether projects come from more than one organization, so each row names its own. */
export function inSeveralOrganizations(projects: ProjectInfo[]): boolean {
  return new Set(projects.map((project) => project.organization?.id)).size > 1;
}

/** Whether the panel still shows the picker that made `request`, so its answer applies. */
export function waitingFor<S extends { name: string }>(current: S, request: number): current is Extract<S, { name: "add"; request: number }> {
  return current.name === "add" && (current as { request?: number }).request === request;
}
