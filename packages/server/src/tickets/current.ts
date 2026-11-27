import { canReview } from "../organizations.ts";
import type { Store, TicketLinkRecord } from "../store.ts";

// Whether a linked ticket's status is current. Critiqs checks a status only
// as the person who linked the ticket, with the tracker account they linked
// it with, so the one rule for "current" is whether that check can still
// happen. A status check (`prepareStatusCheck`) reads a token only when it
// can, and every place that shows a status (the thread window, the thread
// page, coding agents, emails, exports) marks it last known when it can't.

/**
 * The person and tracker account a link's status is checked as: its linker,
 * while they may review its project and are connected to its tracker as the
 * account they linked it with; null otherwise.
 */
export async function linkerAccount(store: Store, link: TicketLinkRecord): Promise<{ userId: string; accountId: string } | null> {
  // Tickets created before links recorded `accountId` have only the account their creator submitted them with.
  const accountId = link.accountId ?? link.creatorAccountId;
  if (accountId === undefined || store.tickets === undefined) return null;
  const project = await store.projects.get(link.projectId);
  // Someone who may no longer review the project, such as a member removed from its organization, isn't asked on its behalf.
  if (project === null || !(await canReview(store, project, link.linkedBy))) return null;
  const account = await store.tickets.accounts.find(link.linkedBy, link.tracker);
  return account !== null && account.accountId === accountId ? { userId: link.linkedBy, accountId } : null;
}

/**
 * Reads whether links' statuses are only last known: a check found the
 * ticket hidden from its linker (`statusStale`), or no check can run as them
 * now (`linkerAccount`). Remembers each linker's answer for the reads it
 * makes, so a page of many tickets asks once per linker.
 */
export function lastKnownStatus(store: Store): (link: TicketLinkRecord) => Promise<boolean> {
  const answers = new Map<string, Promise<boolean>>();
  return async (link) => {
    if (link.statusStale === true) return true;
    const key = JSON.stringify([link.linkedBy, link.tracker, link.projectId, link.accountId ?? link.creatorAccountId ?? null]);
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = linkerAccount(store, link).then((account) => account === null);
      answers.set(key, answer);
    }
    return await answer;
  };
}
