import {
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
  const user = await requireUser(store, identity);
  let project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", OWNERS_ONLY);
  if (args.addresses.length > MAX_PROJECT_ADDRESSES) fail("invalid", `A project can list up to ${MAX_PROJECT_ADDRESSES} addresses.`);
  const next: { address: string; key: string }[] = [];
  for (const value of args.addresses) {
    const parsed = parseProjectAddress(value);
    if ("error" in parsed) fail("invalid", parsed.error);
    if (!next.some((known) => known.address === parsed.address)) next.push({ address: parsed.address, key: parsed.key });
  }
  // The lookup searches by organization, so a project from before organizations moves into its creator's first.
  if (project.organizationId === undefined) {
    await adoptProject(store, project._id, Date.now());
    project = (await store.projects.get(project._id)) ?? project;
  }
  const organizationId = project.organizationId;
  if (organizationId === undefined) fail("unavailable", "This project can't list addresses yet. Try again later.");
  const current = await store.projectAddresses.forProject(project._id, MAX_PROJECT_ADDRESSES);
  const unchanged =
    current.length === next.length &&
    current.every((row, index) => row.address === next[index]!.address && row.organizationId === organizationId);
  if (!unchanged) {
    for (const row of current) await store.projectAddresses.delete(row._id);
    for (const [position, { address, key }] of next.entries()) {
      await store.projectAddresses.insert({ projectId: project._id, organizationId, address, key, position });
    }
  }
  return next.map((row) => row.address);
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
      if (row.key === keys.origin) exact.set(row.projectId, row);
      else if (patternMatches(row.address, keys.origin)) patterns.set(row.projectId, row);
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

/**
 * Whether the lookup may return a project whose address matched: the person
 * belongs to the organization that owns it, or opened it through an install.
 * When projects can limit who may review them, that check joins this one, so
 * a project the person may no longer review isn't found either.
 */
async function mayFind(store: Store, project: ProjectRecord, row: ProjectAddressRecord, userId: string): Promise<boolean> {
  // A row from before its project's organization changed is stale; the list is saved again before it counts.
  if (project.organizationId !== row.organizationId) return false;
  // A project limited to its organization isn't found by someone who opened it before the limit.
  if (!(await canReview(store, project, userId))) return false;
  if ((await store.memberships.find(row.organizationId, userId)) !== null) return true;
  return (await store.openedProjects.find(userId, project._id)) !== null;
}
