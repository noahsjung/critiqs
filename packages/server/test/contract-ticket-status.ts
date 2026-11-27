import { expect, test } from "bun:test";
import type { TicketStatus } from "@critiqs/core";
import { encryptToken, trackerTokenBinding } from "../src/ai/secrets.ts";
import { CritiqsError } from "../src/errors.ts";
import * as ops from "../src/operations.ts";
import { claimTokenRefresh, disconnectTracker, finishTokenRefresh, saveTrackerAccount, type TicketsDeployment, type TokenRead, trackerAccessToken } from "../src/tickets/accounts.ts";
import { getTicketTemplateSettings, saveTicketTemplateSettings } from "../src/tickets/drafts.ts";
import { claimTicketLink, finishTicketLink, linkTicket, releaseTicketHold } from "../src/tickets/links.ts";
import {
  applyCheckedStatus,
  applyTicketStatus,
  checkTicketStatus,
  claimStatusChecks,
  markStatusStale,
  prepareStatusCheck,
  STATUS_CHECK_MS,
  setResolveWhenDone,
  WEBHOOK_UPDATES_PER_MINUTE,
  ticketSettings,
} from "../src/tickets/status.ts";
import type { Identity, Store } from "../src/store.ts";
import { anchor, type ContractBackend, reviewer } from "./contract.ts";
import { NO_GITHUB } from "./github-standin.ts";
import { NO_JIRA } from "./jira-standin.ts";
import { type LinearStandIn, linearStandIn } from "./linear-standin.ts";

const page = { numItems: 40, cursor: null };
const failed = { status: "failed" as const, failureReason: "Blocked" };
const KEY = "operator-encryption-key-".padEnd(48, "x");
const deployment: TicketsDeployment = { encryptionKey: KEY, linear: null, linearWebhookSecret: null, linearApiUrl: "https://linear.test", linearAppUrl: "https://linear.test", ...NO_GITHUB, ...NO_JIRA };
const DONE: TicketStatus = { label: "Done", category: "done" };
const STARTED: TicketStatus = { label: "In Progress", category: "started" };
const CANCELED: TicketStatus = { label: "Canceled", category: "canceled" };
const DELETED: TicketStatus = { label: "Deleted", category: "canceled" };
/** When the stand-in's issues last changed, before any update these tests send: 1,000 ms on Linear's clock. */
const AT_1000 = new Date(1_000).toISOString();

function tickets(store: Store) {
  if (store.tickets === undefined) throw new Error("This backend doesn't store tickets.");
  return store.tickets;
}

async function refusal(promise: Promise<unknown>): Promise<CritiqsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CritiqsError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/**
 * Tickets' status coming back from the tracker, the same on every backend
 * that offers tickets: webhook updates, the check when a thread opens with the
 * linker's own token, stale status, and Resolve when done.
 */
export function defineTicketStatusContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");
  const sam = reviewer("Sam");

  async function userId(backend: ContractBackend, who: Identity) {
    const user = await backend.run((store) => store.users.byToken(who.tokenIdentifier));
    if (user === null) throw new Error(`${who.name} has no user record`);
    return user._id;
  }

  /** Connects `who`'s Linear with a pasted key `lin_api_<name>`, as the Linear account `accountId`. */
  async function connect(backend: ContractBackend, who: Identity, accountId?: string) {
    await backend.run((store) => ops.requireUser(store, who));
    const id = await userId(backend, who);
    const access = await encryptToken(KEY, trackerTokenBinding("linear", id), `lin_api_${who.name!.toLowerCase()}`);
    await backend.run((store) =>
      saveTrackerAccount(
        store,
        id,
        { tracker: "linear", method: "token", identity: { accountId: accountId ?? `u-${id}`, accountName: who.name!, emails: [], site: { id: "org-1", name: "Acme" } }, access, refresh: null, expiresAt: null },
        1_000,
      ),
    );
  }

  /** Dana's project, a thread of Lee's, and a stand-in Linear with issues ENG-1 and ENG-2 in progress, last changed at 1,000. */
  async function setup(backend: ContractBackend) {
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const threadId = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Department is wrong", tags: [], capture: failed }));
    const linear = linearStandIn("https://linear.test", [
      { id: "issue-1", identifier: "ENG-1", title: "One", teamId: "team-eng", state: { name: "In Progress", type: "started" }, updatedAt: AT_1000 },
      { id: "issue-2", identifier: "ENG-2", title: "Two", teamId: "team-eng", state: { name: "In Progress", type: "started" }, updatedAt: AT_1000 },
    ]);
    return { projectId, threadId, linear };
  }

  /** A person's Linear token, read as Convex reads it: as `who` in their own request, or for a job acting in `use`'s projects. */
  const tokens =
    (backend: ContractBackend, who: Identity | null = null) =>
    ({ userId: id, accountId }: { userId: string; accountId: string }, use: TokenRead = { by: "person" }) =>
      trackerAccessToken(
        {
          claim: (leaseId, asked) => backend.run((store) => claimTokenRefresh(store, { userId: id, tracker: "linear", accountId, leaseId, use: asked }, 1_000, who)),
          finish: (leaseId, refreshed) => backend.run((store) => finishTokenRefresh(store, { userId: id, tracker: "linear", leaseId, tokens: refreshed }, 1_000)),
          sleep: async () => undefined,
          now: () => 1_000,
          leaseId: () => "lease",
        },
        deployment,
        { userId: id, tracker: "linear", accountId, use },
      );

  let ids = 0;
  const newId = () => `6f1c2b9a-3d4e-4f50-8a1b-${String(++ids).padStart(12, "0")}`;

  /** Links `threadId` to a stand-in issue as `who`, through the store steps around Linear calls; `paused` runs after Linear was read, before the link is saved. */
  async function link(backend: ContractBackend, who: Identity, linear: LinearStandIn, threadId: string, externalId: string, paused: () => Promise<void> = async () => undefined) {
    const args = { threadId, tracker: "linear" as const, externalId, comment: false };
    return await linkTicket(
      {
        claim: (holder) => backend.run((store) => claimTicketLink(store, who, { ...args, holder }, 6_000)),
        token: (person) => tokens(backend, who)(person),
        finish: async ({ linkId, holder }, ticket) => {
          await paused();
          return await backend.run((store) => finishTicketLink(store, who, { linkId, holder, threadId, ticket }, 6_000));
        },
        release: ({ linkId, holder }, end) => backend.run((store) => releaseTicketHold(store, who, { linkId, holder, end }, 6_000)),
        now: () => 6_000,
        newId,
      },
      deployment,
      args,
      linear.fetchFn,
    );
  }

  /** A status update for a stand-in issue, as a webhook delivers it. */
  const update = (externalId: string, status: TicketStatus, asOf: number, site: string | null = "org-1", deleted = false) => ({ tracker: "linear" as const, externalId, site, status, asOf, deleted });
  const apply = (backend: ContractBackend, externalId: string, status: TicketStatus, asOf: number, now = 100_000, site: string | null = "org-1") =>
    backend.run((store) => applyTicketStatus(store, update(externalId, status, asOf, site), now));
  /** Linear's remove event for a stand-in issue, as of `asOf`. */
  const remove = (backend: ContractBackend, externalId: string, asOf: number, now = 100_000) =>
    backend.run((store) => applyTicketStatus(store, update(externalId, DELETED, asOf, "org-1", true), now));

  /** Checks one link's status as Convex's scheduled action does; `waiting` runs while it waits on Linear. */
  const check = (backend: ContractBackend, linear: LinearStandIn, linkId: string, now = 100_000, waiting: () => Promise<unknown> = async () => undefined) =>
    checkTicketStatus(
      {
        prepare: () => backend.run((store) => prepareStatusCheck(store, { linkId }, now)),
        token: async (person, _tracker, use) => {
          await waiting();
          return await tokens(backend)(person, use);
        },
        save: (reading) => backend.run((store) => applyCheckedStatus(store, { linkId, reading }, now)),
        stale: (startedAt) => backend.run((store) => markStatusStale(store, { linkId, startedAt })),
      },
      deployment,
      linear.fetchFn,
    );

  const shown = async (backend: ContractBackend, who: Identity, threadId: string) => (await backend.run((store) => ops.getThread(store, who, { threadId }, page))).tickets ?? [];
  const thread = (backend: ContractBackend, who: Identity, threadId: string) => backend.run((store) => ops.getThread(store, who, { threadId }, page));

  test(`${name}: a webhook's status reaches every thread linking the issue, once per change, and older or repeated deliveries change nothing`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    const other = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "Also this", tags: [], capture: failed }));
    await connect(backend, lee);
    await connect(backend, dana);
    await link(backend, lee, linear, threadId, "issue-1");
    await link(backend, dana, linear, other, "issue-1");
    await link(backend, lee, linear, threadId, "issue-2");

    expect(await apply(backend, "issue-1", DONE, 50_000)).toEqual({ updated: 2, resolved: [] });
    for (const id of [threadId, other]) {
      expect((await shown(backend, sam, id)).find((ticket) => ticket.key === "ENG-1")).toMatchObject({ status: DONE, statusCheckedAt: 100_000, statusStale: false });
    }
    expect((await backend.run((store) => tickets(store).links.findByExternal("linear", "issue-1", 100)))[0]).toMatchObject({ statusChangedAt: 50_000, statusAsOf: 50_000 });
    // The other issue on the thread is untouched.
    expect((await shown(backend, sam, threadId)).find((ticket) => ticket.key === "ENG-2")?.status).toEqual(STARTED);

    // A late delivery of an older change is ignored; the same delivery again, a replay, writes nothing at all, not even when it was read.
    const before = await backend.run((store) => tickets(store).links.findByExternal("linear", "issue-1", 100));
    expect(await apply(backend, "issue-1", STARTED, 40_000, 110_000)).toEqual({ updated: 0, resolved: [] });
    expect(await apply(backend, "issue-1", DONE, 50_000, 120_000)).toEqual({ updated: 0, resolved: [] });
    expect(await backend.run((store) => tickets(store).links.findByExternal("linear", "issue-1", 100))).toEqual(before);
    expect(before[0]).toMatchObject({ status: DONE, statusChangedAt: 50_000, statusCheckedAt: 100_000 });
    // Another workspace's issue with the same ID isn't this one.
    expect(await apply(backend, "issue-1", CANCELED, 60_000, 130_000, "org-2")).toEqual({ updated: 0, resolved: [] });
    // An issue no thread links changes nothing.
    expect(await apply(backend, "issue-404", DONE, 60_000)).toEqual({ updated: 0, resolved: [] });
  });

  test(`${name}: each site's webhook may update linked tickets a limited number of times a minute; past it, the tracker is told to send it again later`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await link(backend, lee, linear, threadId, "issue-1");
    const results = [];
    for (let index = 1; index <= WEBHOOK_UPDATES_PER_MINUTE + 1; index++) results.push(await apply(backend, "issue-1", index % 2 === 0 ? DONE : STARTED, 50_000 + index, 100_000 + index));
    expect(results.slice(0, WEBHOOK_UPDATES_PER_MINUTE).every((result) => result.updated === 1 && result.limited !== true)).toBe(true);
    expect(results.at(-1)).toEqual({ updated: 0, resolved: [], limited: true });
    // Another site has its own room, and an update for no linked ticket takes none.
    expect(await apply(backend, "issue-404", DONE, 60_000, 100_500)).toEqual({ updated: 0, resolved: [] });
    expect(await apply(backend, "issue-1", DONE, 60_000, 100_500, "org-2")).toEqual({ updated: 0, resolved: [] });
    // A minute later there is room again.
    expect((await apply(backend, "issue-1", DONE, 90_000, 100_000 + 60_000 + WEBHOOK_UPDATES_PER_MINUTE + 1)).limited).toBeUndefined();
  });

  test(`${name}: an update naming a site Critiqs can't keep reaches no link, not even one without a site`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    const leeId = await backend.run(async (store) => (await ops.requireUser(store, lee))._id);
    // A link with no site, as a tracker without sites would save one.
    const linkId = await backend.run((store) =>
      tickets(store).links.insert({ projectId, threadId, tracker: "linear", externalId: "issue-7", key: "ENG-7", url: "https://linear.app/acme/issue/eng-7", title: "t", state: "linked", accountId: "u-lee", linkedBy: leeId, linkedAt: 1, createdFromCritiqs: false, status: STARTED, statusAsOf: 1 }),
    );
    // Too long, or with a control character: not "no site", so it can't match one.
    expect(await apply(backend, "issue-7", DONE, 50_000, 100_000, "x".repeat(300))).toEqual({ updated: 0, resolved: [] });
    expect(await apply(backend, "issue-7", DONE, 50_000, 100_000, "org\u0000")).toEqual({ updated: 0, resolved: [] });
    expect((await backend.run((store) => tickets(store).links.get(linkId)))?.status).toEqual(STARTED);
    // An update that names no site does reach it.
    expect(await apply(backend, "issue-7", DONE, 50_000, 100_000, null)).toEqual({ updated: 1, resolved: [] });
  });

  test(`${name}: an issue updated and deleted at the same moment stays Deleted, in either order and when the update is delivered again`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await link(backend, lee, linear, threadId, "issue-1");
    await link(backend, lee, linear, threadId, "issue-2");

    // Updated, then deleted, both at 50,000: the deletion wins the tie.
    expect(await apply(backend, "issue-1", DONE, 50_000)).toEqual({ updated: 1, resolved: [] });
    expect(await remove(backend, "issue-1", 50_000, 110_000)).toEqual({ updated: 1, resolved: [] });
    // The update delivered again changes nothing.
    const replayed = await apply(backend, "issue-1", DONE, 50_000, 120_000);
    expect((await shown(backend, sam, threadId)).find((ticket) => ticket.key === "ENG-1")).toMatchObject({ status: DELETED, statusCheckedAt: 110_000 });
    expect(replayed).toEqual({ updated: 0, resolved: [] });

    // Deleted first, then an update at the same time delivered late: still Deleted.
    expect(await remove(backend, "issue-2", 50_000)).toEqual({ updated: 1, resolved: [] });
    const late = await apply(backend, "issue-2", STARTED, 50_000, 120_000);
    expect((await shown(backend, sam, threadId)).find((ticket) => ticket.key === "ENG-2")?.status).toEqual(DELETED);
    expect(late).toEqual({ updated: 0, resolved: [] });
    // The deletion delivered again writes nothing either.
    expect(await remove(backend, "issue-2", 50_000, 130_000)).toEqual({ updated: 0, resolved: [] });
  });

  test(`${name}: linking saves the status as of the issue's last change, so a webhook sent before the link and delivered after it changes nothing`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    linear.issues[0]!.updatedAt = new Date(60_000).toISOString();
    const view = await link(backend, lee, linear, threadId, "issue-1");
    expect((await backend.run((store) => tickets(store).links.get(view._id)))?.statusAsOf).toBe(60_000);
    // Done at 50,000 in Linear, reopened at 60,000, linked after; the Done delivery arrives late.
    expect(await apply(backend, "issue-1", DONE, 50_000)).toEqual({ updated: 0, resolved: [] });
    expect((await shown(backend, sam, threadId))[0]?.status).toEqual(STARTED);
    expect(await apply(backend, "issue-1", DONE, 70_000)).toEqual({ updated: 1, resolved: [] });
  });

  test(`${name}: an issue deleted while it is being linked shows Deleted once linked, and Resolve when done resolves its thread`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 1));
    await connect(backend, lee);
    // Linking reads ENG-1 In Progress, as of 1,000; Linear's remove, at 5,000, arrives before the link is saved.
    let delivered: unknown;
    const view = await link(backend, lee, linear, threadId, "issue-1", async () => {
      delivered = await remove(backend, "issue-1", 5_000);
    });
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: DELETED, statusCheckedAt: 6_000, statusStale: false });
    expect(await thread(backend, sam, threadId)).toMatchObject({ status: "resolved", resolvedByTickets: true });
    expect(view.status).toEqual(DELETED);
    // Saved on the pending link; nothing resolves until it is linked.
    expect(delivered).toEqual({ updated: 1, resolved: [] });
    // The update the link read, delivered after it: still Deleted.
    expect(await apply(backend, "issue-1", STARTED, 1_000)).toEqual({ updated: 0, resolved: [] });
    expect((await shown(backend, sam, threadId))[0]?.status).toEqual(DELETED);
  });

  test(`${name}: a webhook delivered while a ticket is being linked counts only when newer than what linking read`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 1));
    await connect(backend, lee);
    // An older Done, delivered late while linking: the In Progress linking read, as of 1,000, stays.
    const older = await link(backend, lee, linear, threadId, "issue-1", async () => {
      await apply(backend, "issue-1", DONE, 500);
    });
    expect(older.status).toEqual(STARTED);
    expect((await backend.run((store) => tickets(store).links.get(older._id)))?.statusAsOf).toBe(1_000);
    expect((await thread(backend, sam, threadId)).status).toBe("open");
    // A newer Done, delivered while ENG-2 is being linked, is saved; ENG-1 is still in progress, so the thread stays open.
    const newer = await link(backend, lee, linear, threadId, "issue-2", async () => {
      await apply(backend, "issue-2", DONE, 3_000);
    });
    expect(newer.status).toEqual(DONE);
    expect(await backend.run((store) => tickets(store).links.get(newer._id))).toMatchObject({ statusAsOf: 3_000, statusChangedAt: 3_000 });
    expect((await thread(backend, sam, threadId)).status).toBe("open");
  });

  test(`${name}: opening a thread claims a check of tickets whose status is over 5 minutes old, at most once every 5 minutes per link`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    const view = await link(backend, lee, linear, threadId, "issue-1");
    // Linked at 6,000 with the status Linear gave then: fresh until 5 minutes later.
    const claim = (now: number, who = sam) => backend.run((store) => claimStatusChecks(store, who, { threadId }, now));
    await backend.run((store) => ops.requireUser(store, sam));
    expect(await claim(6_000 + STATUS_CHECK_MS - 1)).toEqual([]);
    expect(await claim(6_000 + STATUS_CHECK_MS)).toEqual([view._id]);
    // Everyone else opening it meanwhile starts no other check, even if the first never finished.
    expect(await claim(6_000 + STATUS_CHECK_MS + 1_000, dana)).toEqual([]);
    expect(await claim(6_000 + 2 * STATUS_CHECK_MS - 1)).toEqual([]);
    expect(await claim(6_000 + 2 * STATUS_CHECK_MS)).toEqual([view._id]);
    // A status a webhook just saved needs no check.
    await apply(backend, "issue-1", STARTED, 60_000, 6_000 + 3 * STATUS_CHECK_MS);
    expect(await claim(6_000 + 3 * STATUS_CHECK_MS + 1_000)).toEqual([]);
    // Signing in is needed; a deleted thread can't be checked.
    expect((await refusal(backend.run((store) => claimStatusChecks(store, null, { threadId }, 0)))).code).toBe("unauthenticated");
    await backend.run((store) => ops.removeThread(store, lee, { threadId }));
    expect((await refusal(claim(10 * STATUS_CHECK_MS))).code).toBe("unavailable");
  });

  test(`${name}: a check reads Linear with only the linker's own token, whoever opened the thread`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await connect(backend, sam);
    const view = await link(backend, lee, linear, threadId, "issue-1");
    linear.issues[0]!.state = { name: "Done", type: "completed" };
    linear.issues[0]!.updatedAt = "2026-11-25T10:00:00.000Z";
    linear.tokens.length = 0;
    expect(await check(backend, linear, view._id)).toBe("updated");
    expect(linear.tokens).toEqual(["lin_api_lee"]);
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: DONE, statusCheckedAt: 100_000, statusStale: false });
    expect((await backend.run((store) => tickets(store).links.get(view._id)))?.statusAsOf).toBe(Date.parse("2026-11-25T10:00:00.000Z"));
  });

  test(`${name}: a job reads a person's token only while they may review every project it acts for, checked in the step that reads it`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await connect(backend, lee);
    const leeId = await userId(backend, lee);
    const person = { userId: leeId, accountId: `u-${leeId}` };
    expect((await tokens(backend)(person, { by: "job", projects: [projectId] })).value).toBe("lin_api_lee");
    // The project now takes reviews only from its organization, which Lee isn't in: no job uses his token for it.
    await backend.run((store) => store.projects.patch(projectId, { reviewAccess: "organization" }));
    expect((await refusal(tokens(backend)(person, { by: "job", projects: [projectId] }))).code).toBe("forbidden");
    // A job names what it acts for: none, or a project that doesn't exist, isn't enough.
    expect((await refusal(tokens(backend)(person, { by: "job", projects: [] }))).code).toBe("forbidden");
    // In a person's own request, only that person's token.
    expect((await tokens(backend, lee)(person)).value).toBe("lin_api_lee");
    expect((await refusal(tokens(backend, sam)(person))).code).toBe("forbidden");
    expect((await refusal(tokens(backend, null)(person))).code).toBe("forbidden");
    // Removing what Critiqs registered at the tracker reads nothing there, so it needs no project; the token is held only as a removal (trackerRemovalAccess).
    expect(await backend.run((store) => claimTokenRefresh(store, { userId: leeId, tracker: "linear", accountId: person.accountId, leaseId: "lease", use: { by: "cleanup" } }, 1_000))).toMatchObject({ status: "ready" });
  });

  test(`${name}: a check of an issue moved to another team keeps it linked under its new key and address, and keeps the old ones out`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    const view = await link(backend, lee, linear, threadId, "issue-1");
    // Moved to Ops in Linear: same issue, new key and page.
    linear.issues[0]!.identifier = "OPS-4";
    linear.issues[0]!.title = "One, moved";
    linear.issues[0]!.state = { name: "Done", type: "completed" };
    linear.issues[0]!.updatedAt = "2026-11-25T10:00:00.000Z";
    expect(await check(backend, linear, view._id)).toBe("updated");
    expect(await backend.run((store) => tickets(store).links.get(view._id))).toMatchObject({ key: "OPS-4", url: "https://linear.app/acme/issue/ops-4", title: "One, moved", status: DONE });
    // An answer whose page isn't Linear's for its key changes only the status, never where the link points.
    linear.issues[0]!.state = { name: "In Progress", type: "started" };
    linear.issues[0]!.updatedAt = "2026-11-25T11:00:00.000Z";
    linear.pageOf = () => "https://evil.example/acme/issue/ops-4";
    expect(await check(backend, linear, view._id)).toBe("updated");
    expect(await backend.run((store) => tickets(store).links.get(view._id))).toMatchObject({ key: "OPS-4", url: "https://linear.app/acme/issue/ops-4", status: STARTED });
  });

  test(`${name}: a ticket created before links recorded their account is checked with the account its creator submitted it with`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    const view = await link(backend, lee, linear, threadId, "issue-1");
    const leeId = await userId(backend, lee);
    // As saved before `accountId`: only the creator's account.
    await backend.run((store) => tickets(store).links.patch(view._id, { accountId: null, creatorAccountId: `u-${leeId}` }));
    linear.issues[0]!.state = { name: "Done", type: "completed" };
    linear.tokens.length = 0;
    expect(await check(backend, linear, view._id)).toBe("updated");
    expect(linear.tokens).toEqual(["lin_api_lee"]);
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: DONE, statusStale: false });
    // Connected as another account since: last known, as for any link.
    await connect(backend, lee, "u-other-account");
    expect(await check(backend, linear, view._id)).toBe("stale");
  });

  test(`${name}: when the linker disconnects, connects another account, or can't see the ticket, the last status stays, marked stale, and no one else's token is used`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await connect(backend, sam);
    const view = await link(backend, lee, linear, threadId, "issue-1");
    const leeId = await userId(backend, lee);
    linear.tokens.length = 0;

    await backend.run((store) => disconnectTracker(store, lee, { tracker: "linear" }));
    expect(await check(backend, linear, view._id)).toBe("stale");
    expect(linear.tokens).toEqual([]);
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: STARTED, statusStale: true });

    // Reconnected as another Linear account: still stale, and Linear isn't asked.
    await connect(backend, lee, "u-other-account");
    expect(await check(backend, linear, view._id)).toBe("stale");
    expect(linear.tokens).toEqual([]);

    // Back on the account they linked it with, a check clears it.
    await connect(backend, lee, `u-${leeId}`);
    expect(await check(backend, linear, view._id)).toBe("updated");
    expect((await shown(backend, sam, threadId))[0]?.statusStale).toBe(false);

    // Linear no longer shows them the issue, or refuses their key.
    linear.issues.splice(0, 1);
    expect(await check(backend, linear, view._id)).toBe("stale");
    await apply(backend, "issue-1", STARTED, Date.parse("2026-11-25T11:00:00.000Z"));
    expect((await shown(backend, sam, threadId))[0]?.statusStale).toBe(false);
    linear.intercept = () => Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 });
    expect(await check(backend, linear, view._id)).toBe("stale");
    // Linear unreachable is passing: nothing is marked.
    await apply(backend, "issue-1", STARTED, Date.parse("2026-11-25T12:00:00.000Z"));
    linear.intercept = () => new Response("bad gateway", { status: 502 });
    expect(await check(backend, linear, view._id)).toBe("failed");
    expect((await shown(backend, sam, threadId))[0]?.statusStale).toBe(false);
    expect(linear.tokens.every((token) => token === "lin_api_lee")).toBe(true);
  });

  test(`${name}: the moment the linker disconnects, connects another account, or may no longer review the project, the status reads as last known, before anything checks it`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await link(backend, lee, linear, threadId, "issue-1");
    const leeId = await userId(backend, lee);
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: STARTED, statusStale: false });

    await backend.run((store) => disconnectTracker(store, lee, { tracker: "linear" }));
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: STARTED, statusStale: true });
    // The thread list's row says so too.
    const listed = await backend.run((store) => ops.listThreads(store, sam, { projectId }, page));
    expect(listed.page.find((thread) => thread._id === threadId)?.tickets).toEqual([{ tracker: "linear", key: "ENG-1", status: STARTED, lastKnown: true }]);
    await connect(backend, lee, "u-other-account");
    expect((await shown(backend, sam, threadId))[0]?.statusStale).toBe(true);
    // Back on the account they linked it with, and nothing found it hidden: current again.
    await connect(backend, lee, `u-${leeId}`);
    expect((await shown(backend, sam, threadId))[0]?.statusStale).toBe(false);
    // The project now takes reviews only from its organization, which Lee isn't in.
    await backend.run((store) => store.projects.patch(projectId, { reviewAccess: "organization" }));
    expect((await shown(backend, dana, threadId))[0]?.statusStale).toBe(true);
    expect(linear.tokens.every((token) => token === "lin_api_lee")).toBe(true);
  });

  test(`${name}: a check refused after a newer webhook was saved leaves that status current, not last known`, async () => {
    const backend = fresh();
    const { threadId, linear } = await setup(backend);
    await connect(backend, lee);
    const view = await link(backend, lee, linear, threadId, "issue-1");
    linear.intercept = () => Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 });
    // The check begins at 100,000; while it waits on Linear, a webhook saves Done at 100,500; then Linear refuses Lee's key.
    expect(await check(backend, linear, view._id, 100_000, () => apply(backend, "issue-1", DONE, 50_000, 100_500))).toBe("stale");
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: DONE, statusCheckedAt: 100_500, statusStale: false });
    // The next refused check, with nothing saved since it began, marks it last known.
    expect(await check(backend, linear, view._id, 200_000)).toBe("stale");
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: DONE, statusStale: true });
  });

  test(`${name}: a check saves only the link it checked: another thread's link to the same issue keeps its own last-known status and stays open`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    const other = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "Same issue", tags: [], capture: failed }));
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 1));
    await connect(backend, lee);
    await connect(backend, dana);
    const lees = await link(backend, lee, linear, threadId, "issue-1");
    const danas = await link(backend, dana, linear, other, "issue-1");
    // Lee disconnects: his link's status is last known.
    await backend.run((store) => disconnectTracker(store, lee, { tracker: "linear" }));
    expect(await check(backend, linear, lees._id)).toBe("stale");

    // Dana's link is checked with her token and reads Done.
    linear.issues[0]!.state = { name: "Done", type: "completed" };
    linear.issues[0]!.updatedAt = "2026-11-25T10:00:00.000Z";
    expect(await check(backend, linear, danas._id)).toBe("updated");
    expect((await shown(backend, sam, other))[0]).toMatchObject({ status: DONE, statusStale: false });
    expect(await thread(backend, sam, other)).toMatchObject({ status: "resolved", resolvedByTickets: true });
    // Lee's thread still shows what he last could read, marked so, and isn't resolved by Dana's check.
    expect((await shown(backend, sam, threadId))[0]).toMatchObject({ status: STARTED, statusStale: true, statusCheckedAt: 6_000 });
    expect((await thread(backend, sam, threadId)).status).toBe("open");
    // A check of a link that is gone saves nothing.
    expect(await backend.run((store) => applyCheckedStatus(store, { linkId: "missing", reading: { status: DONE, asOf: 1 } }, 1))).toEqual({ updated: 0, resolved: [] });
  });

  test(`${name}: Resolve when done is off by default and only the project's owner sees or changes it`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    expect(await backend.run((store) => ticketSettings(store, dana, { projectId }))).toEqual({ resolveWhenDone: false });
    expect((await refusal(backend.run((store) => setResolveWhenDone(store, lee, { projectId, on: true }, 1))))).toMatchObject({
      code: "forbidden",
      message: "Only the person who set up this project can change its ticket settings.",
    });
    expect((await refusal(backend.run((store) => ticketSettings(store, lee, { projectId })))).code).toBe("forbidden");
    expect(await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 1))).toEqual({ resolveWhenDone: true });
    expect(await backend.run((store) => ticketSettings(store, dana, { projectId }))).toEqual({ resolveWhenDone: true });
    expect(await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: false }, 2))).toEqual({ resolveWhenDone: false });
    expect(await backend.run((store) => ticketSettings(store, dana, { projectId }))).toEqual({ resolveWhenDone: false });
  });

  test(`${name}: saving the project's templates keeps Resolve when done, and changing Resolve when done keeps its templates, whichever is saved first`, async () => {
    const backend = fresh();
    const bug = { tracker: "linear" as const, destinationId: "team-eng", templateId: "tpl-bug", name: "Bug report" };
    const copy = { tracker: "linear" as const, destinationId: "team-des", templateId: "tpl-copy", name: "Copy change" };
    const both = async (projectId: string) => ({
      templates: await backend.run((store) => getTicketTemplateSettings(store, dana, { projectId })),
      resolve: await backend.run((store) => ticketSettings(store, dana, { projectId })),
    });

    // Templates saved first, then Resolve when done turned on and off.
    const { projectId } = await setup(backend);
    await backend.run((store) => saveTicketTemplateSettings(store, dana, { projectId, on: true, templates: [bug] }, 1));
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 2));
    expect(await both(projectId)).toEqual({ templates: { on: true, templates: [bug] }, resolve: { resolveWhenDone: true } });
    await backend.run((store) => saveTicketTemplateSettings(store, dana, { projectId, on: false, templates: [bug, copy] }, 3));
    expect(await both(projectId)).toEqual({ templates: { on: false, templates: [bug, copy] }, resolve: { resolveWhenDone: true } });
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: false }, 4));
    expect(await both(projectId)).toEqual({ templates: { on: false, templates: [bug, copy] }, resolve: { resolveWhenDone: false } });

    // Resolve when done saved first, on a project with no ticket settings yet, then templates.
    const other = await backend.run((store) => ops.createProject(store, dana, { name: "Checkout prototype" }));
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId: other, on: true }, 5));
    expect(await both(other)).toEqual({ templates: { on: false, templates: [] }, resolve: { resolveWhenDone: true } });
    await backend.run((store) => saveTicketTemplateSettings(store, dana, { projectId: other, on: true, templates: [copy] }, 6));
    expect(await both(other)).toEqual({ templates: { on: true, templates: [copy] }, resolve: { resolveWhenDone: true } });
    // Each project keeps its own.
    expect(await both(projectId)).toEqual({ templates: { on: false, templates: [bug, copy] }, resolve: { resolveWhenDone: false } });
  });

  test(`${name}: with Resolve when done on, a thread resolves when its last open ticket is done or canceled, recorded as resolved by its tickets`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await link(backend, lee, linear, threadId, "issue-1");
    await link(backend, lee, linear, threadId, "issue-2");

    // Off: nothing resolves.
    expect(await apply(backend, "issue-1", DONE, 50_000)).toMatchObject({ resolved: [] });
    expect(await apply(backend, "issue-2", DONE, 50_000)).toMatchObject({ resolved: [] });
    expect((await thread(backend, sam, threadId)).status).toBe("open");

    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 1));
    await apply(backend, "issue-1", STARTED, 60_000);
    await apply(backend, "issue-2", STARTED, 60_000);
    // One of two done: still open.
    expect(await apply(backend, "issue-1", DONE, 70_000)).toMatchObject({ resolved: [] });
    expect((await thread(backend, sam, threadId)).status).toBe("open");
    // The last one canceled: the work is closed, so it resolves.
    expect(await apply(backend, "issue-2", CANCELED, 70_000, 200_000)).toMatchObject({ resolved: [threadId] });
    const resolved = await thread(backend, sam, threadId);
    expect(resolved).toMatchObject({ status: "resolved", resolvedByTickets: true, statusChangedByName: null, statusChangedAt: 200_000 });

    // Reopening a ticket never reopens the thread.
    await apply(backend, "issue-2", STARTED, 80_000);
    expect((await thread(backend, sam, threadId)).status).toBe("resolved");

    // A person reopens it; an update that finishes nothing new leaves it open.
    await backend.run((store) => ops.setStatus(store, lee, { threadId, status: "open" }));
    const reopened = await thread(backend, sam, threadId);
    expect(reopened).toMatchObject({ status: "open", statusChangedByName: "Lee" });
    expect(reopened.resolvedByTickets).toBeUndefined();
    await apply(backend, "issue-1", DONE, 90_000);
    expect((await thread(backend, sam, threadId)).status).toBe("open");
    // Finishing the reopened ticket again resolves it again.
    expect(await apply(backend, "issue-2", DONE, 90_000)).toMatchObject({ resolved: [threadId] });
    // Reopened by a person while every ticket is done: a later update that leaves them done, such as a title change, keeps it open.
    await backend.run((store) => ops.setStatus(store, lee, { threadId, status: "open" }));
    expect(await apply(backend, "issue-2", DONE, 95_000)).toEqual({ updated: 1, resolved: [] });
    expect((await thread(backend, sam, threadId)).status).toBe("open");
  });

  test(`${name}: Resolve when done counts only linked tickets, needs one, and leaves resolved and other projects' threads alone`, async () => {
    const backend = fresh();
    const { projectId, threadId, linear } = await setup(backend);
    await connect(backend, lee);
    await backend.run((store) => setResolveWhenDone(store, dana, { projectId, on: true }, 1));
    // Another project, with the setting off, links the same issue.
    const elsewhere = await backend.run((store) => ops.createProject(store, sam, { name: "Elsewhere" }));
    const otherThread = await backend.run((store) => ops.createThread(store, sam, { projectId: elsewhere, anchor, body: "Same issue", tags: [], capture: failed }));
    await connect(backend, sam);
    await link(backend, lee, linear, threadId, "issue-1");
    await link(backend, sam, linear, otherThread, "issue-1");
    // A creation still pending on the thread doesn't hold it open, nor count.
    const leeId = await userId(backend, lee);
    await backend.run((store) =>
      tickets(store).links.insert({ projectId, threadId, tracker: "linear", externalId: "", key: "", url: "", title: "", state: "pending", linkedBy: leeId, linkedAt: 1, createdFromCritiqs: true }),
    );
    expect(await apply(backend, "issue-1", DONE, 50_000)).toEqual({ updated: 2, resolved: [threadId] });
    expect((await thread(backend, sam, otherThread)).status).toBe("open");

    // Already resolved by a person: stays recorded as theirs.
    const third = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Third", tags: [], capture: failed }));
    await link(backend, lee, linear, third, "issue-2");
    await backend.run((store) => ops.setStatus(store, lee, { threadId: third, status: "resolved" }));
    await apply(backend, "issue-2", DONE, 50_000);
    expect(await thread(backend, sam, third)).toMatchObject({ status: "resolved", statusChangedByName: "Lee" });
    expect((await thread(backend, sam, third)).resolvedByTickets).toBeUndefined();
  });
}
