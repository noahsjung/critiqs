import {
  type ManageableProjects,
  MAX_MANAGEABLE_PROJECTS,
  MAX_PROJECT_ADDRESSES,
  originLookupKeys,
  parseProjectAddress,
  patternMatches,
  type ProjectLookup,
} from "@critiqs/core";
import { fail } from "./errors.ts";
import { currentReviewer, projectInfo, requireProject, requireUser } from "./operations.ts";
import { adoptProject, canReview, projectAccess } from "./organizations.ts";
import type { Identity, ProjectAddressRecord, ProjectRecord, Store } from "./store.ts";

// Address lists, and the browser extension's project lookup. The extension
// has no project ID in the page, so it finds the project by the page's origin,
// searching only projects the person can already reach: those in
// organizations they belong to, and those they opened through an install.
// Lists aren't unique across Critiqs, and nothing tells anyone whether
// another project lists an origin.

/** Organizations, and opened projects, the lookup searches for one person. */
const MAX_ORGANIZATIONS_SEARCHED = 100;
const MAX_OPENED_SEARCHED = 100;
/**
 * Addresses read for one key in one organization: few for an exact origin,
 * where the first matches are enough; more for a pattern key, which many
 * projects' patterns may share. With the limits above, one lookup reads at
 * most about 20,000 addresses, under Convex's 32,000 documents a transaction.
 */
const MAX_EXACT_ROWS = 50;
const MAX_PATTERN_ROWS = 100;
/** Projects the lookup offers to choose from. */
export const MAX_LOOKUP_CHOICES = 20;
/** Matches checked in full, so one lookup stays within a transaction's reads however many projects list an origin. */
const MAX_CANDIDATES = 50;
/**
 * Organizations the manageable list reads. A membership where the person
 * manages nothing costs one indexed read that returns nothing, so this can be
 * far above what the lookup searches.
 */
const MAX_MEMBERSHIPS_LISTED = 500;
/** How often recording an opened project again updates when it was opened. */
const OPENED_REFRESH_MS = 24 * 60 * 60 * 1000;

const OWNERS_ONLY = "Only the project's owners can change or see its address list.";

/**
 * Replaces a project's address list with `addresses`, normalized, and returns
 * it. Only the project's owners may. Two projects may list the same origin.
 */
export async function setProjectAddresses(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; addresses: string[] },
): Promise<string[]> {
  const project = await managedProject(store, identity, args.projectId);
  if (args.addresses.length > MAX_PROJECT_ADDRESSES) fail("invalid", TOO_MANY);
  const next: ListedAddress[] = [];
  for (const value of args.addresses) {
    const parsed = listedAddress(value);
    if (!next.some((known) => known.address === parsed.address)) next.push(parsed);
  }
  return await saveList(store, project, next);
}

/**
 * Adds one address to a project's list, normalized, and returns the list. One
 * transaction reads and writes the list, so people adding at the same time
 * keep every address. An address already listed changes nothing. Only the
 * project's owners may.
 */
export async function addProjectAddress(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; address: string },
): Promise<string[]> {
  const project = await managedProject(store, identity, args.projectId);
  const added = listedAddress(args.address);
  const current = await listed(store, project._id);
  if (current.some((row) => row.address === added.address)) return current.map((row) => row.address);
  if (current.length >= MAX_PROJECT_ADDRESSES) fail("invalid", TOO_MANY);
  return await saveList(store, project, [...current, added]);
}

/**
 * Removes one address from a project's list, matched once normalized, and
 * returns the list. An address not listed changes nothing. Only the project's
 * owners may.
 */
export async function removeProjectAddress(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; address: string },
): Promise<string[]> {
  const project = await managedProject(store, identity, args.projectId);
  const removed = listedAddress(args.address);
  const current = await listed(store, project._id);
  if (!current.some((row) => row.address === removed.address)) return current.map((row) => row.address);
  return await saveList(store, project, current.filter((row) => row.address !== removed.address));
}

/** An address as a list holds it: normalized, with the key the lookup searches by. */
interface ListedAddress {
  address: string;
  key: string;
}

const TOO_MANY = `A project can list up to ${MAX_PROJECT_ADDRESSES} addresses.`;

function listedAddress(value: string): ListedAddress {
  const parsed = parseProjectAddress(value);
  if ("error" in parsed) fail("invalid", parsed.error);
  return { address: parsed.address, key: parsed.key };
}

async function listed(store: Store, projectId: string): Promise<ListedAddress[]> {
  return (await store.projectAddresses.forProject(projectId, MAX_PROJECT_ADDRESSES)).map(({ address, key }) => ({ address, key }));
}

/** The project, for someone who may change its address list: its owners, as `projectAccess` decides. */
async function managedProject(store: Store, identity: Identity | null, projectId: string): Promise<ProjectRecord> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", OWNERS_ONLY);
  return project;
}

/**
 * Saves a project's list as `next`, in order, and returns it. Rows already in
 * their place are kept, so adding an address writes one row.
 */
async function saveList(store: Store, saved: ProjectRecord, next: ListedAddress[]): Promise<string[]> {
  let project = saved;
  // The lookup searches by organization, so a project from before organizations moves into its creator's first.
  if (project.organizationId === undefined) {
    await adoptProject(store, project._id, Date.now());
    project = (await store.projects.get(project._id)) ?? project;
  }
  const organizationId = project.organizationId;
  if (organizationId === undefined) fail("unavailable", "This project can't list addresses yet. Try again later.");
  const current = await store.projectAddresses.forProject(project._id, MAX_PROJECT_ADDRESSES);
  const inPlace = (index: number) => {
    const row = current[index];
    return row !== undefined && row.address === next[index]?.address && row.organizationId === organizationId && row.position === index;
  };
  for (const [index, row] of current.entries()) if (!inPlace(index)) await store.projectAddresses.delete(row._id);
  for (const [position, { address, key }] of next.entries()) {
    if (!inPlace(position)) await store.projectAddresses.insert({ projectId: project._id, organizationId, address, key, position });
  }
  return next.map((row) => row.address);
}

/**
 * The projects whose address lists the signed-in person may change, by name:
 * every project in an organization they're an admin of, and the projects they
 * created while still a member, as `projectAccess` decides for
 * `setProjectAddresses`. The extension's "Add to a project" offers these.
 */
export async function listManageableProjects(store: Store, identity: Identity | null): Promise<ManageableProjects> {
  const { user } = await currentReviewer(store, identity);
  if (user === null) return { projects: [], complete: true };
  const found = new Map<string, ProjectRecord>();
  // Reading one more than is returned tells whether there may be more.
  const full = () => found.size > MAX_MANAGEABLE_PROJECTS;
  let complete = true;
  const memberships = await store.memberships.forUser(user._id, MAX_MEMBERSHIPS_LISTED + 1);
  if (memberships.length > MAX_MEMBERSHIPS_LISTED) complete = false;
  // Each read returns only projects the person manages: all of an organization's for its admins, and a member's own.
  for (const membership of memberships.slice(0, MAX_MEMBERSHIPS_LISTED)) {
    if (full()) break;
    const projects =
      membership.role === "admin"
        ? await store.projects.inOrganization(membership.organizationId, MAX_MANAGEABLE_PROJECTS + 1)
        : await store.projects.createdIn(user._id, membership.organizationId, MAX_MANAGEABLE_PROJECTS + 1);
    for (const project of projects) found.set(project._id, project);
  }
  // Projects they created before organizations, until the backfill moves them into one.
  if (!full()) {
    for (const project of await store.projects.createdIn(user._id, null, MAX_MANAGEABLE_PROJECTS + 1)) {
      if ((await projectAccess(store, project, user._id)) === "manage") found.set(project._id, project);
    }
  }
  if (full()) complete = false;
  const projects = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || (a._id < b._id ? -1 : 1)).slice(0, MAX_MANAGEABLE_PROJECTS);
  return { projects: await Promise.all(projects.map((project) => projectInfo(store, project, user._id))), complete };
}

/** A project's address list, for its owners. */
export async function getProjectAddresses(store: Store, identity: Identity | null, args: { projectId: string }): Promise<string[]> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user?._id ?? null)) !== "manage") fail("forbidden", OWNERS_ONLY);
  return (await store.projectAddresses.forProject(project._id, MAX_PROJECT_ADDRESSES)).map((row) => row.address);
}

/**
 * Records that the signed-in person opened a project through an install, so
 * the lookup searches it too. The installed component calls it once per
 * session and project; review links will too. Thread pages never do. Running
 * it again usually writes nothing.
 */
export async function recordProjectOpened(store: Store, identity: Identity | null, args: { projectId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const now = Date.now();
  const opened = await store.openedProjects.find(user._id, project._id);
  if (opened === null) await store.openedProjects.insert({ userId: user._id, projectId: project._id, openedAt: now });
  else if (now - opened.openedAt >= OPENED_REFRESH_MS) await store.openedProjects.patch(opened._id, { openedAt: now });
}

/**
 * The browser extension's project lookup: the projects whose address lists
 * match a page's origin, among those the signed-in person can reach. An exact
 * origin wins over a pattern. An origin many unrelated projects may use, such
 * as `http://localhost:5173`, always asks which project, even for one match.
 * A match the person can't reach answers exactly as an origin no project
 * lists does. Remembering the person's choice for an origin is the
 * extension's: the same `localhost` address is a different app on each
 * computer.
 */
export async function findProjectsForOrigin(store: Store, identity: Identity | null, args: { origin: string }): Promise<ProjectLookup> {
  const { user } = await currentReviewer(store, identity);
  const keys = originLookupKeys(args.origin);
  // Someone with no record yet belongs to no organization and opened nothing.
  if (user === null || keys === null) return { status: "none" };

  const exact = new Map<string, ProjectAddressRecord>();
  const patterns = new Map<string, ProjectAddressRecord>();
  const collect = (rows: ProjectAddressRecord[]) => {
    for (const row of rows) {
      const match = listedMatch(row, keys);
      if (match === "exact") exact.set(row.projectId, row);
      else if (match === "pattern") patterns.set(row.projectId, row);
    }
  };
  const searchKeys: [string, number][] = [[keys.origin, MAX_EXACT_ROWS]];
  if (keys.patternKey !== null) searchKeys.push([keys.patternKey, MAX_PATTERN_ROWS]);
  // Whether a read stopped at its limit, so a match may be missing and one match can't be trusted to be the only one.
  let partial = false;
  for (const membership of await store.memberships.forUser(user._id, MAX_ORGANIZATIONS_SEARCHED)) {
    for (const [key, limit] of searchKeys) {
      const rows = await store.projectAddresses.inOrganization(membership.organizationId, key, limit);
      if (rows.length >= limit) partial = true;
      collect(rows);
    }
  }
  for (const opened of await store.openedProjects.recent(user._id, MAX_OPENED_SEARCHED)) {
    for (const [key] of searchKeys) collect(await store.projectAddresses.inProject(opened.projectId, key));
  }

  // Each candidate is checked again here, the one place that decides who may find a project.
  // An exact origin wins over a pattern, except on an ambiguous origin, where every match is a choice.
  const tiers = keys.ambiguous ? [new Map([...patterns, ...exact])] : [exact, patterns];
  const found: ProjectRecord[] = [];
  for (const rows of tiers) {
    if (rows.size > MAX_CANDIDATES) partial = true;
    for (const row of [...rows.values()].slice(0, MAX_CANDIDATES)) {
      const project = await store.projects.get(row.projectId);
      if (project !== null && (await mayFind(store, project, row, user._id))) found.push(project);
    }
    if (found.length > 0) break;
  }
  if (found.length === 0) return { status: "none" };
  found.sort((a, b) => a.name.localeCompare(b.name) || (a._id < b._id ? -1 : 1));
  const projects = await Promise.all(found.slice(0, MAX_LOOKUP_CHOICES).map((project) => projectInfo(store, project, user._id)));
  return projects.length === 1 && !keys.ambiguous && !partial ? { status: "found", project: projects[0]! } : { status: "choose", projects };
}

/** What the lookup searches for a page's origin (`originLookupKeys`). */
type OriginKeys = NonNullable<ReturnType<typeof originLookupKeys>>;

/**
 * How a listed address matches a page's origin: as the origin itself, by its
 * pattern, or not at all. The one place that decides it, for the extension's
 * lookup and for Connected.
 */
export function listedMatch(row: Pick<ProjectAddressRecord, "address" | "key">, keys: OriginKeys): "exact" | "pattern" | null {
  if (row.key === keys.origin) return "exact";
  return patternMatches(row.address, keys.origin) ? "pattern" : null;
}

/**
 * Whether a page's origin is the project's own address: its review address's
 * origin, or an address its list matches (`listedMatch`).
 */
export async function isProjectAddress(store: Store, project: ProjectRecord, origin: string): Promise<boolean> {
  const keys = originLookupKeys(origin);
  if (keys === null) return false;
  if (project.reviewUrl !== undefined && reviewOrigin(project.reviewUrl) === keys.origin) return true;
  for (const key of [keys.origin, keys.patternKey]) {
    if (key === null) continue;
    for (const row of await store.projectAddresses.inProject(project._id, key)) if (listedMatch(row, keys) !== null) return true;
  }
  return false;
}

function reviewOrigin(reviewUrl: string): string | null {
  try {
    return originLookupKeys(new URL(reviewUrl).origin)?.origin ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the lookup may return a project whose address matched: the person
 * belongs to the organization that owns it, or opened it through an install.
 * A project limited to its organization is found only by someone who may
 * still review it, so one the person may no longer review isn't found.
 */
async function mayFind(store: Store, project: ProjectRecord, row: ProjectAddressRecord, userId: string): Promise<boolean> {
  // A row from before its project's organization changed is stale; the list is saved again before it counts.
  if (project.organizationId !== row.organizationId) return false;
  // A project limited to its organization isn't found by someone who opened it before the limit.
  if (!(await canReview(store, project, userId))) return false;
  if ((await store.memberships.find(row.organizationId, userId)) !== null) return true;
  return (await store.openedProjects.find(userId, project._id)) !== null;
}
