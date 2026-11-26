import { connectionOrigin, parseOnboardingAnswers } from "@critiqs/core";
import { fail } from "./errors.ts";
import { countWithinAll } from "./limits.ts";
import { requireProject, requireUser } from "./operations.ts";
import { projectAccess } from "./organizations.ts";
import { isProjectAddress } from "./project-addresses.ts";
import type { Identity, Store, UserChanges } from "./store.ts";

// Onboarding on the Critiqs website. The address check itself fetches from
// the network (`checkPrototypeAddress` in address-check.ts, Node only); this
// part runs in a transaction, before the fetch.

/** Address checks one person may run per hour. */
export const ADDRESS_CHECKS_PER_PERSON_PER_HOUR = 20;
/** Address checks one deployment runs per hour, for everyone together. */
export const ADDRESS_CHECKS_PER_HOUR = 500;

// Fixed UTC hours, like every other limit in Critiqs: checks on either side
// of an hour's edge count against different hours. The cap on checks running
// at once (`MAX_CONCURRENT_ADDRESS_CHECKS`) bounds peak load instead.
const HOUR_MS = 3_600_000;

/**
 * Counts one address check for the signed-in person, refusing with a `limit`
 * error past their hourly limit or the deployment's. A refusal counts
 * nothing: the error rolls the transaction back.
 */
export async function claimAddressCheck(store: Store, identity: Identity | null, now: number): Promise<void> {
  const user = await requireUser(store, identity);
  const hour = Math.floor(now / HOUR_MS);
  if (!(await countWithinAll(store, [[`addressChecks:user:${user._id}:${hour}`, ADDRESS_CHECKS_PER_PERSON_PER_HOUR]]))) {
    fail("limit", `You've checked ${ADDRESS_CHECKS_PER_PERSON_PER_HOUR} addresses this hour. Try again later, or skip this step.`);
  }
  if (!(await countWithinAll(store, [[`addressChecks:all:${hour}`, ADDRESS_CHECKS_PER_HOUR]]))) {
    fail("limit", "Critiqs is checking a lot of addresses right now. Try again in a few minutes, or skip this step.");
  }
}

/**
 * Saves onboarding's "About you" answers on the signed-in person. Values it
 * doesn't know are dropped, as if skipped, and a skipped answer leaves any
 * saved one as it is, so skipping saves nothing.
 */
export async function saveAboutYou(store: Store, identity: Identity | null, args: { role?: string; teamSize?: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const { role, teamSize } = parseOnboardingAnswers(args);
  const changes: UserChanges = {
    ...(role === undefined || role === user.role ? {} : { role }),
    ...(teamSize === undefined || teamSize === user.teamSize ? {} : { teamSize }),
  };
  if (Object.keys(changes).length > 0) await store.users.patch(user._id, changes);
}

/**
 * How often one project's Connected record may be written: a report within
 * this long of the recorded load changes nothing, so however many reports
 * arrive, a project is written at most six times an hour.
 */
export const CONNECTION_WRITE_MS = 10 * 60_000;

/** The largest report body read: a project ID is far shorter. */
export const MAX_CONNECTION_REPORT_BYTES = 200;

/**
 * Records that Critiqs loaded on a page with this project's ID, for
 * onboarding's Connected: the latest load from the project's own address,
 * with that page's origin as its browser sent it. The installed component
 * reports it on its own, before anyone signs in, so it takes no identity and
 * answers the same whether or not the project exists. A report counts only
 * when its origin is the project's review address or matches its address
 * list (`isProjectAddress`, the matching the extension's lookup uses), so a
 * stranger who knows the ID can claim nothing but an address the owners
 * listed, and the next real load replaces a wrong record. The extension's
 * panel, a page that names no origin, and a developer's own computer don't
 * count. At most one write per `CONNECTION_WRITE_MS`, and nothing is ever
 * inserted, so reports can't grow any table.
 */
export async function reportConnected(store: Store, args: { projectId: string; origin: string | null }, now: number): Promise<void> {
  const origin = connectionOrigin(args.origin);
  const id = store.normalizeId("projects", args.projectId);
  if (origin === null || id === null) return;
  const project = await store.projects.get(id);
  if (project === null) return;
  if (project.connectedAt !== undefined && now < project.connectedAt + CONNECTION_WRITE_MS) return;
  if (!(await isProjectAddress(store, project, origin))) return;
  await store.projects.patch(project._id, { connection: { at: now, origin } });
}

/** Clears a project's Connected record, for the people who manage it; the next load from its own address records it again. */
export async function clearConnected(store: Store, identity: Identity | null, args: { projectId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", "Only the people who manage this project can clear Connected.");
  if (project.connectedAt !== undefined) await store.projects.patch(project._id, { connection: null });
}

/**
 * The Connected record a thread from before Connected stands for: it was
 * left with Critiqs installed, so the project was connected when it was
 * made, on the origin of the page it was left on. For backends' one-off
 * upgrade of projects that already have threads.
 */
export function connectionFromThread(thread: { createdAt: number; pageUrl: string }): { at: number; origin: string | null } {
  let origin: string | null = null;
  try {
    origin = connectionOrigin(new URL(thread.pageUrl).origin);
  } catch {
    // A page address that can't be read still shows the project was installed, just not where.
  }
  return { at: thread.createdAt, origin };
}
