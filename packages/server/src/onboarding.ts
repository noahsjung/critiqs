import { parseOnboardingAnswers } from "@critiqs/core";
import { fail } from "./errors.ts";
import { countWithinAll } from "./limits.ts";
import { requireUser } from "./operations.ts";
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
