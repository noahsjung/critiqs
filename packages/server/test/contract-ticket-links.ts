import { expect, test } from "bun:test";
import type { NewTicket, TicketLinkInput, TrackerId } from "@critiqs/core";
import { encryptToken, trackerTokenBinding } from "../src/ai/secrets.ts";
import { CritiqsError } from "../src/errors.ts";
import * as ops from "../src/operations.ts";
import { claimTokenRefresh, finishTokenRefresh, saveTrackerAccount, type TicketsDeployment, trackerAccessToken } from "../src/tickets/accounts.ts";
import {
  addTicketLinkBack,
  claimTicketCreation,
  claimTicketLink,
  CREATION_FINISH_MS,
  CREATION_LEASE_MS,
  createTicket,
  finishTicketCreation,
  finishTicketLink,
  IDLE_CREATION_MS,
  linkTicket,
  listTicketDestinations,
  prepareTicketDraft,
  prepareTicketLinkBack,
  releaseTicketHold,
  requireTicketCreator,
  requireTrackerAccount,
  saveTicketLinkBack,
  searchTickets,
  ticketDraft,
  unlinkTicket,
} from "../src/tickets/links.ts";
import type { Identity, Store } from "../src/store.ts";
import { anchor, type ContractBackend, reviewer } from "./contract.ts";
import { type LinearStandIn, linearStandIn } from "./linear-standin.ts";

const page = { numItems: 40, cursor: null };
const failed = { status: "failed" as const, failureReason: "Blocked" };
const KEY = "operator-encryption-key-".padEnd(48, "x");
const deployment: TicketsDeployment = { encryptionKey: KEY, linear: null, linearApiUrl: "https://linear.test", linearAppUrl: "https://linear.test" };
const REVIEW = "https://review.example/app?tab=users";

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
 * Creating, linking, and unlinking tickets, the same on every backend that
 * offers tickets, against a stand-in for Linear. Each tracker call runs between
 * store steps, as Convex's actions run them.
 */
export function defineTicketLinkContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");
  const sam = reviewer("Sam");

  async function userId(backend: ContractBackend, who: Identity) {
    const user = await backend.run((store) => store.users.byToken(who.tokenIdentifier));
    if (user === null) throw new Error(`${who.name} has no user record`);
    return user._id;
  }

  /**
   * Connects `who`'s Linear with a pasted key, stored encrypted as connecting
   * does: `accountId` is the Linear account's ID, and `key` the key, by default
   * `lin_api_<name>`.
   */
  async function connect(backend: ContractBackend, who: Identity, attribution = true, accountId?: string, key = `lin_api_${who.name!.toLowerCase()}`) {
    await backend.run((store) => ops.requireUser(store, who));
    const id = await userId(backend, who);
    const access = await encryptToken(KEY, trackerTokenBinding("linear", id), key);
    await backend.run((store) =>
      saveTrackerAccount(
        store,
        id,
        { tracker: "linear", method: "token", identity: { accountId: accountId ?? `u-${id}`, accountName: who.name!, email: null, site: { id: "org-1", name: "Acme" } }, access, refresh: null, expiresAt: null },
        1_000,
      ),
    );
    if (!attribution) {
      const account = await backend.run((store) => tickets(store).accounts.find(id, "linear"));
      await backend.run((store) => tickets(store).accounts.patch(account!._id, { attribution: false }));
    }
  }

  /** A project (Dana's) with a review address, and a thread Lee started; `capture` gives it an image. */
  async function setup(backend: ContractBackend, options: { review?: boolean; capture?: boolean } = {}) {
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", ...(options.review === false ? {} : { reviewUrl: REVIEW }) }));
    const fileId = options.capture ? await backend.storeFile(new Blob([new Uint8Array([137, 80, 78, 71, 1, 2])], { type: "image/png" })) : null;
    const threadId = await backend.run((store) =>
      ops.createThread(store, lee, { projectId, anchor, body: "Department is wrong\nShould be Support", tags: ["Bug"], capture: fileId === null ? failed : { status: "captured", fileId } }),
    );
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Agreed", revision: "abc123" }));
    return { projectId, threadId };
  }

  /** A person's token for the Linear account a request checked, read and decrypted from their stored account as the backend reads it for a tracker call. */
  const tokens =
    (backend: ContractBackend) =>
    ({ userId: id, accountId }: { userId: string; accountId: string }) =>
      trackerAccessToken(
        {
          claim: (leaseId) => backend.run((store) => claimTokenRefresh(store, { userId: id, tracker: "linear", accountId, leaseId }, 1_000)),
          finish: (leaseId, refreshed) => backend.run((store) => finishTokenRefresh(store, { userId: id, tracker: "linear", leaseId, tokens: refreshed }, 1_000)),
          sleep: async () => undefined,
          now: () => 1_000,
          leaseId: () => "lease",
        },
        deployment,
        { userId: id, tracker: "linear", accountId },
      );
  const token = (who: Identity) => async () => ({ method: "token" as const, value: `lin_api_${who.name!.toLowerCase()}` });

  let ids = 0;
  /** A fresh UUID v4, as the Create dialog makes one for each submission and an action for each lease. */
  const newId = () => `6f1c2b9a-3d4e-4f50-8a1b-${String(++ids).padStart(12, "0")}`;

  interface Clock {
    now: number;
    action?: () => number;
  }

  /**
   * Creates a ticket as `who`, through the store steps around tracker calls,
   * as Convex's actions run them, at the store's time `clock.now` and the
   * action's `clock.action` (the same unless a test moves it). A retry of the
   * same dialog passes its `submissionId` again; without one, it is a new dialog.
   */
  function create(backend: ContractBackend, who: Identity, linear: LinearStandIn, input: Partial<NewTicket> & { threadId: string }, clock: Clock = { now: 5_000 }) {
    const { threadId } = input;
    return createTicket(
      {
        requireCreator: () => backend.run((store) => requireTicketCreator(store, who, { threadId, tracker: "linear" })),
        token: tokens(backend),
        claim: (claim) => backend.run((store) => claimTicketCreation(store, who, { threadId, tracker: "linear", ...claim }, clock.now)),
        finish: ({ linkId, holder }, ticket, linkBackAdded) => backend.run((store) => finishTicketCreation(store, who, { linkId, threadId, holder, ticket, linkBackAdded }, clock.now)),
        release: ({ linkId, holder }, end) => backend.run((store) => releaseTicketHold(store, who, { linkId, holder, end }, clock.now)),
        capture: async (fileId) => {
          const data = await backend.readFile(fileId);
          return data === null ? null : { data, contentType: "image/png" };
        },
        now: () => clock.action?.() ?? clock.now,
        newId,
      },
      deployment,
      { tracker: "linear", submissionId: newId(), destinationId: "team-eng", title: "Department is wrong", body: "> Department is wrong\n", createdFromCritiqs: true, ...input },
      linear.fetchFn,
    );
  }

  /** The steps of linking a ticket as `who`, through the store steps around tracker calls, as Convex's actions run them. */
  function linkSteps(backend: ContractBackend, who: Identity, args: { threadId: string; tracker: TrackerId; externalId: string }, clock: Clock) {
    return {
      claim: (holder: string) => backend.run((store) => claimTicketLink(store, who, { ...args, holder }, clock.now)),
      token: tokens(backend),
      finish: ({ linkId, holder }: { linkId: string; holder: string }, ticket: Parameters<typeof finishTicketLink>[2]["ticket"]) =>
        backend.run((store) => finishTicketLink(store, who, { linkId, holder, threadId: args.threadId, ticket }, clock.now)),
      release: ({ linkId, holder }: { linkId: string; holder: string }, end: "nothing" | "unknown" | "parked") => backend.run((store) => releaseTicketHold(store, who, { linkId, holder, end }, clock.now)),
      now: () => clock.action?.() ?? clock.now,
      newId,
    };
  }

  function link(backend: ContractBackend, who: Identity, linear: LinearStandIn, input: Partial<TicketLinkInput> & { threadId: string; externalId: string }, clock: Clock = { now: 6_000 }) {
    const args = { tracker: "linear" as TrackerId, comment: false, ...input };
    return linkTicket(
      linkSteps(backend, who, args, clock),
      deployment,
      args,
      linear.fetchFn,
    );
  }

  /** Adds the missing link back to a ticket `who` created. */
  function addLinkBack(backend: ContractBackend, who: Identity, linear: LinearStandIn, linkId: string) {
    return addTicketLinkBack(
      {
        prepare: () => backend.run((store) => prepareTicketLinkBack(store, who, { linkId })),
        token: tokens(backend),
        save: () => backend.run((store) => saveTicketLinkBack(store, who, { linkId })),
      },
      deployment,
      linear.fetchFn,
    );
  }

  /** The Create dialog's draft for `who`, as it opens. */
  function draft(backend: ContractBackend, who: Identity, threadId: string) {
    return ticketDraft(
      {
        prepare: () => backend.run((store) => prepareTicketDraft(store, who, { threadId, tracker: "linear" })),
        loadPage: ({ paginationOpts, ...args }) => backend.run((store) => ops.exportThreads(store, who, args, paginationOpts)),
      },
      { tracker: "linear" },
    );
  }

  /** A promise and the function that settles it, to hold a request at Linear's stand-in. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  }

  const pendingLinks = (backend: ContractBackend, threadId: string) => backend.run((store) => tickets(store).links.listForThread(threadId, "pending", 50));
  const shown = async (backend: ContractBackend, who: Identity, threadId: string) => (await backend.run((store) => ops.getThread(store, who, { threadId }, page))).tickets;

  test(`${name}: the draft is the thread's export without AI, linked on the review address, with the person's attribution default`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    expect((await refusal(draft(backend, dana, threadId))).message).toBe("Connect Linear in Your trackers first.");
    await connect(backend, dana, false);
    const filled = await draft(backend, dana, threadId);
    expect(filled.title).toBe("Department is wrong");
    expect(filled.createdFromCritiqs).toBe(false);
    expect(filled.resumeSubmissionId).toBeNull();
    expect(filled.body.startsWith("> Department is wrong\n> Should be Support\n")).toBe(true);
    expect(filled.body).toContain(`- Link: [open the thread](<https://review.example/app?tab=users&amp;critiqs=${threadId}>)`);
    expect(filled.body).toContain("**Dana**");
    expect(filled.body).toContain("> Agreed");
    // Attribution is added when the ticket is created, never in the text the person edits.
    expect(filled.body).not.toContain("Created from Critiqs");
  });

  test(`${name}: without a review address, the thread links on the page it was left on`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend, { review: false });
    await connect(backend, dana);
    const linear = linearStandIn();
    await create(backend, dana, linear, { threadId });
    expect(linear.attachments).toEqual([{ issueId: expect.any(String), url: `${anchor.evidence.url}?critiqs=${threadId}`, title: "Department is wrong" }]);
  });

  test(`${name}: creating saves a pending link before calling Linear, then links the issue with its key, status, and the thread's link`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    let pendingWhileCreating: unknown[] = [];
    linear.intercept = async (operation) => {
      if (operation === "CritiqsCreate") pendingWhileCreating = await pendingLinks(backend, threadId);
      return undefined;
    };
    const view = await create(backend, dana, linear, { threadId, title: "  Department   is wrong " });
    expect(pendingWhileCreating).toHaveLength(1);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    expect(view).toMatchObject({ threadId, tracker: "linear", key: "ENG-1", url: "https://linear.app/acme/issue/eng-1", status: { label: "Triage", category: "open" }, createdFromCritiqs: true, linkedByName: "Dana", canUnlink: true });
    const [issue] = linear.issues;
    expect(issue).toMatchObject({ title: "Department is wrong", teamId: "team-eng" });
    expect(issue!.description).toContain("Created from Critiqs by Dana: [open the thread](<https://review.example/app?tab=users&amp;critiqs=");
    expect(linear.attachments).toEqual([{ issueId: issue!.id, url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" }]);
    const stored = (await backend.run((store) => tickets(store).links.listForThread(threadId, "linked", 50)))[0]!;
    expect(stored).toMatchObject({ externalId: issue!.id, site: "org-1", state: "linked", statusCheckedAt: 5_000, creationId: issue!.id, creatorAccountId: `u-${await userId(backend, dana)}` });
    expect(stored.linkBack).toEqual({ url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong", added: true });
    expect(view.canAddLinkBack).toBe(false);
    // Everyone in the project sees it on the thread, list row included.
    expect((await shown(backend, sam, threadId))?.map((ticket) => [ticket.key, ticket.canUnlink])).toEqual([["ENG-1", false]]);
    const listed = await backend.run(async (store) => (await ops.listThreads(store, sam, { projectId: stored.projectId }, page)).page[0]!.tickets);
    expect(listed).toEqual([{ tracker: "linear", key: "ENG-1", status: { label: "Triage", category: "open" } }]);
  });

  test(`${name}: with attribution off the ticket has no Critiqs text, and the capture is uploaded into it`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend, { capture: true });
    await connect(backend, dana);
    const linear = linearStandIn();
    await create(backend, dana, linear, { threadId, createdFromCritiqs: false, body: "My own text" });
    const { description } = linear.issues[0]!;
    expect(description).toBe("My own text\n\n## Capture\n\n![Capture](<https://uploads.linear.app/asset-1>)\n");
    expect(linear.uploads).toEqual([{ path: "/uploads/1", contentType: "image/png", size: 6 }]);
  });

  test(`${name}: a creation whose outcome is unknown is checked with Linear on retry, so the issue isn't created twice`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    // Linear creates the issue, but the answer never arrives.
    linear.intercept = (operation) => (operation === "CritiqsCreate" ? "after" : undefined);
    const submissionId = newId();
    expect((await refusal(create(backend, dana, linear, { threadId, submissionId }))).code).toBe("unavailable");
    expect(linear.issues).toHaveLength(1);
    expect(await pendingLinks(backend, threadId)).toHaveLength(1);
    expect(await shown(backend, dana, threadId)).toEqual([]);

    linear.intercept = null;
    linear.operations.length = 0;
    const view = await create(backend, dana, linear, { threadId, submissionId, title: "Second try" });
    // Found by the creation's ID, then the link back to the thread, which the lost attempt never added.
    expect(linear.operations).toEqual(["CritiqsIssue", "CritiqsLinkBack"]);
    expect(linear.attachments).toEqual([{ issueId: linear.issues[0]!.id, url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" }]);
    expect(linear.issues).toHaveLength(1);
    expect(view.key).toBe("ENG-1");
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
  });

  test(`${name}: a creation whose issue was archived before the retry is found and linked, not lost`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    linear.intercept = (operation) => (operation === "CritiqsCreate" ? "after" : undefined);
    const submissionId = newId();
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    linear.intercept = null;
    // Someone archived the new issue in Linear before Dana tried again.
    linear.issues[0]!.archivedAt = "2026-11-25T10:00:00.000Z";
    // Linear's lists leave it out now: search doesn't find it.
    const asDana = { requirePerson: () => backend.run((store) => requireTrackerAccount(store, dana, { tracker: "linear" })), token: token(dana) };
    expect(await searchTickets(asDana, deployment, { tracker: "linear", query: "ENG-1" }, linear.fetchFn)).toEqual([]);
    const view = await create(backend, dana, linear, { threadId, submissionId });
    expect(view.key).toBe("ENG-1");
    expect(linear.issues.map((issue) => issue.id)).toEqual([submissionId]);
    expect(linear.operations.slice(-2)).toEqual(["CritiqsIssue", "CritiqsLinkBack"]);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
  });

  test(`${name}: a retry whose earlier attempt made nothing creates the issue under the same ID; a refusal leaves nothing pending`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    linear.intercept = (operation) => (operation === "CritiqsCreate" ? new Response("bad gateway", { status: 502 }) : undefined);
    const submissionId = newId();
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    const [pending] = await pendingLinks(backend, threadId);
    expect(pending!.creationId).toBe(submissionId);
    linear.intercept = null;
    const view = await create(backend, dana, linear, { threadId, submissionId });
    expect(linear.issues.map((issue) => issue.id)).toEqual([submissionId]);
    expect(view.key).toBe("ENG-1");

    // Linear's rate limit refuses before creating anything: the pending link goes.
    linear.intercept = (operation) => (operation === "CritiqsCreate" ? Response.json({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] }, { status: 429 }) : undefined);
    expect((await refusal(create(backend, dana, linear, { threadId }))).code).toBe("limit");
    expect(await pendingLinks(backend, threadId)).toEqual([]);
  });

  test(`${name}: a thread's 21st ticket is refused, created or linked, counting tickets still being created`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    const danaId = await userId(backend, dana);
    for (let index = 0; index < ops.MAX_THREAD_TICKETS - 1; index++) {
      await backend.run((store) =>
        tickets(store).links.insert({ projectId, threadId, tracker: "linear", externalId: `x${index}`, key: `ENG-${100 + index}`, url: "https://linear.app/x", title: "t", state: "linked", linkedBy: danaId, linkedAt: 1, createdFromCritiqs: false }),
      );
    }
    const leeId = await userId(backend, lee);
    await backend.run((store) =>
      tickets(store).links.insert({ projectId, threadId, tracker: "linear", externalId: "", key: "", url: "", title: "", state: "pending", creationId: "someone-else", linkedBy: leeId, linkedAt: 1, createdFromCritiqs: true }),
    );
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Existing", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } }]);
    const refused = await refusal(create(backend, dana, linear, { threadId }));
    expect(refused.code).toBe("limit");
    expect(refused.message).toBe("A thread can link to at most 20 tickets. Unlink one first.");
    expect((await refusal(link(backend, dana, linear, { threadId, externalId: "i1" }))).code).toBe("limit");
    expect(linear.issues).toHaveLength(1);
    expect(linear.attachments).toEqual([]);
  });

  test(`${name}: linking an existing issue adds the thread's link and an optional summary comment; linking it again changes nothing`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Existing", teamId: "team-eng", state: { name: "In Progress", type: "started" } }]);
    const view = await link(backend, dana, linear, { threadId, externalId: "i1", comment: true });
    expect(view).toMatchObject({ key: "ENG-1", title: "Existing", status: { label: "In Progress", category: "started" }, createdFromCritiqs: false, canUnlink: true });
    expect(linear.attachments).toEqual([{ issueId: "i1", url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" }]);
    expect(linear.comments).toEqual([
      { issueId: "i1", body: `> Department is wrong\n> Should be Support\n\nLinked from Critiqs by Dana: [open the thread](<https://review.example/app?tab=users&amp;critiqs=${threadId}>)\n` },
    ]);
    linear.operations.length = 0;
    const again = await link(backend, dana, linear, { threadId, externalId: "i1", comment: true });
    expect(again._id).toBe(view._id);
    expect(linear.operations).toEqual([]);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    // An issue Linear doesn't show the person is refused before anything is saved.
    expect((await refusal(link(backend, dana, linear, { threadId, externalId: "nope" }))).code).toBe("not-found");
  });

  test(`${name}: searching and listing teams need the person's own Linear`, async () => {
    const backend = fresh();
    await setup(backend);
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Department label", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } }]);
    const steps = (who: Identity) => ({ requirePerson: () => backend.run((store) => requireTrackerAccount(store, who, { tracker: "linear" })), token: token(who) });
    expect((await refusal(listTicketDestinations(steps(lee), deployment, { tracker: "linear" }, linear.fetchFn))).message).toBe("Connect Linear in Your trackers first.");
    await connect(backend, lee);
    expect((await listTicketDestinations(steps(lee), deployment, { tracker: "linear" }, linear.fetchFn)).map((team) => team.name)).toEqual(["Engineering", "Design"].sort());
    expect((await searchTickets(steps(lee), deployment, { tracker: "linear", query: "ENG-1" }, linear.fetchFn)).map((found) => found.key)).toEqual(["ENG-1"]);
    expect((await searchTickets(steps(lee), deployment, { tracker: "linear", query: "label" }, linear.fetchFn)).map((found) => found.key)).toEqual(["ENG-1"]);
    expect(await searchTickets(steps(lee), deployment, { tracker: "linear", query: "   " }, linear.fetchFn)).toEqual([]);
  });

  test(`${name}: unlinking is for the person who linked it or a project owner, and leaves the ticket in Linear`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, lee);
    await connect(backend, sam);
    const linear = linearStandIn("https://linear.test", [
      { id: "i1", identifier: "ENG-1", title: "One", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } },
      { id: "i2", identifier: "ENG-2", title: "Two", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } },
    ]);
    const lees = await link(backend, lee, linear, { threadId, externalId: "i1" });
    const sams = await link(backend, sam, linear, { threadId, externalId: "i2" });
    const refused = await refusal(backend.run((store) => unlinkTicket(store, sam, { linkId: lees._id })));
    expect(refused.code).toBe("forbidden");
    await backend.run((store) => unlinkTicket(store, lee, { linkId: lees._id }));
    // Dana owns the project.
    await backend.run((store) => unlinkTicket(store, dana, { linkId: sams._id }));
    expect(await shown(backend, dana, threadId)).toEqual([]);
    expect(linear.issues).toHaveLength(2);
    expect((await refusal(backend.run((store) => unlinkTicket(store, dana, { linkId: sams._id })))).code).toBe("not-found");
  });

  test(`${name}: while one attempt creates the ticket, another is told it's still being created and Linear isn't called; only the attempt holding it may finish or release it`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    const arrived = gate();
    const held = gate();
    linear.intercept = async (operation) => {
      if (operation === "CritiqsCreate") {
        arrived.open();
        await held.opened;
      }
      return undefined;
    };
    const submissionId = newId();
    const first = create(backend, dana, linear, { threadId, submissionId });
    await arrived.opened;
    const second = await refusal(create(backend, dana, linear, { threadId, submissionId }));
    expect(second.message).toBe("Critiqs is still creating this ticket in Linear. Try again in a moment.");
    expect(linear.operations).toEqual(["CritiqsCreate"]);
    const [pending] = await pendingLinks(backend, threadId);
    const stranger = { linkId: pending!._id, holder: "not-the-holder" };
    await backend.run((store) => releaseTicketHold(store, dana, { ...stranger, end: "nothing" }, 5_000));
    const ticket = { tracker: "linear" as const, externalId: "x", key: "ENG-9", url: "https://linear.app/x", title: "t", status: { label: "Todo", category: "open" as const }, site: null };
    expect((await refusal(backend.run((store) => finishTicketCreation(store, dana, { ...stranger, threadId, ticket, linkBackAdded: true }, 5_000)))).code).toBe("unavailable");
    expect(await pendingLinks(backend, threadId)).toHaveLength(1);
    held.open();
    expect((await first).key).toBe("ENG-1");
    expect(linear.issues).toHaveLength(1);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
  });

  test(`${name}: an attempt starts no request to Linear after its cutoff and aborts one still running then; the next attempt finds the issue under the same ID`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    const cutoff = 5_000 + CREATION_LEASE_MS - CREATION_FINISH_MS;
    // The action's clock is at the cutoff already: nothing is sent, and the creation stays for the next attempt.
    const submissionId = newId();
    expect((await refusal(create(backend, dana, linear, { threadId, submissionId }, { now: 5_000, action: () => cutoff }))).code).toBe("unavailable");
    expect(linear.operations).toEqual([]);
    const [kept] = await pendingLinks(backend, threadId);
    expect(kept).toMatchObject({ leaseUntil: 5_000 });
    expect(kept!.claimToken).toBeUndefined();
    // 50 ms before the cutoff: Linear takes longer, so the request is aborted, though Linear goes on to create the issue.
    linear.intercept = async (operation) => {
      if (operation === "CritiqsCreate") await new Promise((done) => setTimeout(done, 300));
      return undefined;
    };
    const began = Date.now();
    expect((await refusal(create(backend, dana, linear, { threadId, submissionId }, { now: 5_000, action: () => cutoff - 50 }))).code).toBe("unavailable");
    expect(Date.now() - began).toBeLessThan(300);
    await new Promise((done) => setTimeout(done, 400));
    expect(linear.issues.map((issue) => issue.id)).toEqual([submissionId]);
    linear.intercept = null;
    const view = await create(backend, dana, linear, { threadId, submissionId });
    expect(view.key).toBe("ENG-1");
    expect(linear.issues).toHaveLength(1);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
  });

  test(`${name}: a recovered creation the thread links already keeps one link, and gets its link back to the thread`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    linear.intercept = (operation) => (operation === "CritiqsCreate" ? "after" : undefined);
    const submissionId = newId();
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    const [issue] = linear.issues;
    linear.intercept = null;
    // Meanwhile Dana found the issue in Linear and linked it.
    const linked = await link(backend, dana, linear, { threadId, externalId: issue!.id });
    const recovered = await create(backend, dana, linear, { threadId, submissionId });
    expect(recovered._id).toBe(linked._id);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    // Added again on recovery, which Linear keeps as one attachment.
    expect(linear.operations.filter((operation) => operation === "CritiqsLinkBack")).toHaveLength(2);
    expect(linear.attachments).toEqual([{ issueId: issue!.id, url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" }]);
  });

  test(`${name}: Linear's refusal removes the creation and says why; a retry whose ID Linear already has links that issue`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    const refused = await refusal(create(backend, dana, linear, { threadId, destinationId: "team-gone" }));
    expect(refused.message).toBe("Linear turned this down: Entity not found: Team.");
    expect(await pendingLinks(backend, threadId)).toEqual([]);

    // The first attempt's answer is lost; on the retry the issue lands only after Critiqs looked for it, so Linear refuses its ID.
    linear.intercept = (operation) => (operation === "CritiqsCreate" ? "after" : undefined);
    const submissionId = newId();
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    let looked = 0;
    linear.intercept = (operation) => (operation === "CritiqsIssue" && ++looked === 1 ? Response.json({ data: { issues: { nodes: [] } } }) : undefined);
    const view = await create(backend, dana, linear, { threadId, submissionId });
    expect(view.key).toBe("ENG-1");
    expect(linear.operations.slice(-4)).toEqual(["CritiqsIssue", "CritiqsCreate", "CritiqsIssue", "CritiqsLinkBack"]);
    expect(linear.issues).toHaveLength(1);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
  });

  test(`${name}: while one attempt links a ticket, linking it again is refused before Linear is called; one link and one summary comment`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Existing", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } }]);
    const arrived = gate();
    const held = gate();
    linear.intercept = async (operation) => {
      if (operation === "CritiqsIssue") {
        arrived.open();
        await held.opened;
      }
      return undefined;
    };
    const first = link(backend, dana, linear, { threadId, externalId: "i1", comment: true });
    await arrived.opened;
    expect((await refusal(link(backend, dana, linear, { threadId, externalId: "i1", comment: true }))).message).toBe("Critiqs is still linking this ticket in Linear. Try again in a moment.");
    expect(linear.operations).toEqual(["CritiqsIssue"]);
    held.open();
    expect((await first).key).toBe("ENG-1");
    expect(linear.comments).toHaveLength(1);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    // Linked now: linking it again returns that link, and Linear isn't called.
    linear.operations.length = 0;
    await link(backend, dana, linear, { threadId, externalId: "i1", comment: true });
    expect(linear.operations).toEqual([]);
  });

  test(`${name}: two links competing for a thread's last place: one is written to Linear and saved, the other refused before Linear is called`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    await connect(backend, lee);
    await fill(backend, { projectId, threadId }, await userId(backend, dana), ops.MAX_THREAD_TICKETS - 1);
    const linear = linearStandIn("https://linear.test", [
      { id: "i1", identifier: "ENG-1", title: "One", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } },
      { id: "i2", identifier: "ENG-2", title: "Two", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } },
    ]);
    // Dana's link is at Linear when Lee links another issue.
    const arrived = gate();
    const held = gate();
    let reads = 0;
    linear.intercept = async (operation) => {
      if (operation === "CritiqsIssue" && ++reads === 1) {
        arrived.open();
        await held.opened;
      }
      return undefined;
    };
    const danas = link(backend, dana, linear, { threadId, externalId: "i1" });
    await arrived.opened;
    const lees = await refusal(link(backend, lee, linear, { threadId, externalId: "i2" }));
    expect([lees.code, lees.message]).toEqual(["limit", "A thread can link to at most 20 tickets. Unlink one first."]);
    held.open();
    expect((await danas).key).toBe("ENG-1");
    expect(linear.tokens.filter((token) => token === "lin_api_lee")).toEqual([]);
    expect(linear.attachments).toEqual([{ issueId: "i1", url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" }]);
    expect(await shown(backend, sam, threadId)).toHaveLength(ops.MAX_THREAD_TICKETS);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
  });

  test(`${name}: a link Linear refuses frees its place; one whose link back's answer is lost keeps it until linked again or parked`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    await connect(backend, lee);
    await fill(backend, { projectId, threadId }, await userId(backend, dana), ops.MAX_THREAD_TICKETS - 1);
    const linear = linearStandIn("https://linear.test", [
      { id: "i1", identifier: "ENG-1", title: "One", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } },
      { id: "i2", identifier: "ENG-2", title: "Two", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } },
    ]);
    // Linear refuses the link back: nothing was added, so the place is free again.
    linear.intercept = (operation) => (operation === "CritiqsLinkBack" ? Response.json({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] }, { status: 400 }) : undefined);
    expect((await refusal(link(backend, dana, linear, { threadId, externalId: "i1" }))).code).toBe("forbidden");
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    // The link back's answer is lost: it may be there, so the place stays held.
    linear.intercept = (operation) => (operation === "CritiqsLinkBack" ? "after" : undefined);
    expect((await refusal(link(backend, dana, linear, { threadId, externalId: "i1" }))).code).toBe("unavailable");
    expect(await pendingLinks(backend, threadId)).toEqual([expect.objectContaining({ externalId: "i1", state: "pending" })]);
    linear.intercept = null;
    expect((await refusal(link(backend, lee, linear, { threadId, externalId: "i2" }, { now: 6_000 + IDLE_CREATION_MS - 1 }))).code).toBe("limit");
    // Linking it again, by anyone on the thread, finishes it; Linear keeps one attachment.
    expect((await link(backend, lee, linear, { threadId, externalId: "i1" }, { now: 6_100 })).linkedByName).toBe("Lee");
    expect(linear.attachments.filter((attachment) => attachment.issueId === "i1")).toHaveLength(1);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    expect(await shown(backend, sam, threadId)).toHaveLength(ops.MAX_THREAD_TICKETS);
  });

  test(`${name}: when the comment's answer is lost, the link stays and a retry doesn't comment again`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Existing", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } }]);
    linear.intercept = (operation) => (operation === "CritiqsComment" ? "after" : undefined);
    const lost = await refusal(link(backend, dana, linear, { threadId, externalId: "i1", comment: true }));
    expect(lost.message).toBe("Linked ENG-1, but Critiqs couldn't tell whether Linear added the comment. Check the ticket before adding it yourself.");
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    linear.intercept = null;
    await link(backend, dana, linear, { threadId, externalId: "i1", comment: true });
    expect(linear.comments).toHaveLength(1);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
  });

  /** `count` linked tickets on the thread, linked by `linkedBy`, as if linked long ago. */
  async function fill(backend: ContractBackend, ids: { projectId: string; threadId: string }, linkedBy: string, count: number) {
    for (let index = 0; index < count; index++) {
      await backend.run((store) =>
        tickets(store).links.insert({ ...ids, tracker: "linear", externalId: `x${index}`, key: `OLD-${index}`, url: "https://linear.app/x", title: "t", state: "linked", linkedBy, linkedAt: 1, createdFromCritiqs: false }),
      );
    }
  }

  /** Linear makes the issue but its answer never arrives. */
  const answerLost = (operation: string) => (operation === "CritiqsCreate" ? ("after" as const) : undefined);

  test(`${name}: a retry of a submission saved before its answer was lost returns the same link and makes no second issue`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    const submissionId = newId();
    // The first try finished and saved the link; the dialog never got the answer, and the person tries again.
    const first = await create(backend, dana, linear, { threadId, submissionId });
    linear.operations.length = 0;
    const retried = await create(backend, dana, linear, { threadId, submissionId });
    expect(retried._id).toBe(first._id);
    expect(retried.key).toBe("ENG-1");
    expect(linear.operations).toEqual([]);
    expect(linear.issues).toHaveLength(1);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    // A new dialog is a new submission, and a new ticket.
    expect((await create(backend, dana, linear, { threadId })).key).toBe("ENG-2");
  });

  test(`${name}: a submission belongs to the person and thread it was made on, and its ID must be a UUID v4`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    const otherThreadId = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Another", tags: [], capture: failed }));
    await connect(backend, dana);
    await connect(backend, lee);
    const linear = linearStandIn();
    const submissionId = newId();
    linear.intercept = answerLost;
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    linear.intercept = null;
    linear.operations.length = 0;
    const elsewhere = "This ticket was started somewhere else. Close the dialog and create the ticket again.";
    expect((await refusal(create(backend, lee, linear, { threadId, submissionId }))).message).toBe(elsewhere);
    expect((await refusal(create(backend, dana, linear, { threadId: otherThreadId, submissionId }))).message).toBe(elsewhere);
    expect(linear.operations).toEqual([]);
    await create(backend, dana, linear, { threadId, submissionId });
    expect((await refusal(create(backend, lee, linear, { threadId, submissionId }))).message).toBe(elsewhere);
    for (const malformed of ["", "not-a-uuid", "6f1c2b9a-3d4e-1f50-8a1b-000000000001"]) {
      expect((await refusal(create(backend, dana, linear, { threadId, submissionId: malformed }))).code).toBe("invalid");
    }
    expect(linear.issues).toHaveLength(1);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.linkedByName)).toEqual(["Dana"]);
  });

  test(`${name}: only its creator's own requests recover a creation, with their token and the link back recorded when they submitted it`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, lee);
    await connect(backend, sam);
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Existing", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } }]);
    const submissionId = newId();
    linear.intercept = answerLost;
    await refusal(create(backend, lee, linear, { threadId, submissionId }));
    linear.intercept = null;
    // The project's review address changes after Lee submitted.
    await backend.run((store) => ops.setReviewUrl(store, dana, { projectId, reviewUrl: "https://review.example/moved" }));
    // Long after, Sam creates and links on the thread: nothing is asked of Linear as Lee.
    const later = { now: 5_000 + 3 * IDLE_CREATION_MS };
    linear.tokens.length = 0;
    await create(backend, sam, linear, { threadId }, later);
    await link(backend, sam, linear, { threadId, externalId: "i1" }, later);
    expect(new Set(linear.tokens)).toEqual(new Set(["lin_api_sam"]));
    expect((await pendingLinks(backend, threadId)).map((pending) => pending.creationId)).toEqual([submissionId]);
    // Dana has no Linear: refused before anything is asked of Linear.
    linear.tokens.length = 0;
    expect((await refusal(create(backend, dana, linear, { threadId }, later))).message).toBe("Connect Linear in Your trackers first.");
    expect(linear.tokens).toEqual([]);
    // Even connected to the same Linear account as Lee (a shared key), Dana's create leaves Lee's creation alone.
    await connect(backend, dana, true, `u-${await userId(backend, lee)}`);
    await create(backend, dana, linear, { threadId }, later);
    expect((await pendingLinks(backend, threadId)).map((pending) => pending.creationId)).toEqual([submissionId]);
    linear.tokens.length = 0;
    // Lee's retry finds the issue as Lee and adds the link back recorded at submission, not the moved address.
    const view = await create(backend, lee, linear, { threadId, submissionId }, later);
    expect(new Set(linear.tokens)).toEqual(new Set(["lin_api_lee"]));
    expect(view).toMatchObject({ linkedByName: "Lee", canAddLinkBack: false });
    expect(linear.attachments.filter((attachment) => attachment.issueId === submissionId)).toEqual([
      { issueId: submissionId, url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" },
    ]);
    expect(linear.issues.filter((issue) => issue.id === submissionId)).toHaveLength(1);
  });

  test(`${name}: a creation isn't recovered with another Linear account than it was started with, nor from a deleted thread`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, lee);
    const linear = linearStandIn();
    const submissionId = newId();
    linear.intercept = answerLost;
    await refusal(create(backend, lee, linear, { threadId, submissionId }));
    linear.intercept = null;
    linear.operations.length = 0;
    // Lee connects another Linear account.
    await connect(backend, lee, true, "another-linear-account");
    expect((await refusal(create(backend, lee, linear, { threadId, submissionId }))).message).toBe("You started this ticket with another Linear account. Connect that account in Your trackers again to finish it.");
    // Nor do Lee's later creations check it.
    await create(backend, lee, linear, { threadId }, { now: 5_000 + 3 * IDLE_CREATION_MS });
    expect(linear.operations).toEqual(["CritiqsCreate", "CritiqsLinkBack"]);
    // Back on the first account, but the thread was deleted: refused before Linear is asked.
    await connect(backend, lee);
    await backend.run((store) => ops.removeThread(store, lee, { threadId }));
    linear.operations.length = 0;
    expect((await refusal(create(backend, lee, linear, { threadId, submissionId }))).message).toBe("This thread was deleted.");
    expect(linear.operations).toEqual([]);
    expect((await pendingLinks(backend, threadId)).map((pending) => pending.creationId)).toEqual([submissionId]);
  });

  test(`${name}: a creation idle for 10 minutes stops counting toward the thread's 20 tickets, and its creator's retry still links its issue past 20`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    await connect(backend, lee);
    await fill(backend, { projectId, threadId }, await userId(backend, dana), ops.MAX_THREAD_TICKETS - 1);
    const linear = linearStandIn();
    const submissionId = newId();
    linear.intercept = answerLost;
    await refusal(create(backend, lee, linear, { threadId, submissionId }));
    linear.intercept = null;
    // Under way, it holds the 20th place.
    expect((await refusal(create(backend, dana, linear, { threadId }, { now: 5_000 + IDLE_CREATION_MS - 1 }))).code).toBe("limit");
    // Parked: Dana's ticket takes the place, and Lee's creation waits for Lee, untouched.
    const parked = { now: 5_000 + IDLE_CREATION_MS };
    linear.tokens.length = 0;
    expect((await create(backend, dana, linear, { threadId }, parked)).key).toBe("ENG-2");
    expect(new Set(linear.tokens)).toEqual(new Set(["lin_api_dana"]));
    expect(await pendingLinks(backend, threadId)).toHaveLength(1);
    expect((await refusal(create(backend, dana, linear, { threadId }, parked))).message).toBe("A thread can link to at most 20 tickets. Unlink one first.");
    // The issue Lee's creation made exists, so Lee's retry links it, as the thread's 21st, and every one shows.
    expect((await create(backend, lee, linear, { threadId, submissionId }, parked)).key).toBe("ENG-1");
    expect(await shown(backend, sam, threadId)).toHaveLength(ops.MAX_THREAD_TICKETS + 1);
    expect(linear.issues).toHaveLength(2);
    expect(await pendingLinks(backend, threadId)).toEqual([]);
  });

  test(`${name}: after Linear refuses a key while checking a creation, reconnecting and reopening the dialog finishes that ticket instead of creating another`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    // Dana creates; Linear makes ENG-1, but its answer is lost.
    const submissionId = newId();
    linear.intercept = answerLost;
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    // Her key is revoked in Linear, so her retry can't check, and the creation is parked.
    linear.intercept = (_operation, _variables, token) =>
      token === "lin_api_dana" ? Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 }) : undefined;
    expect((await refusal(create(backend, dana, linear, { threadId, submissionId }))).message).toBe(
      "Linear didn't accept your connection, so Critiqs couldn't check whether it created this ticket. Connect Linear again in Your trackers, then try again.",
    );
    // She connects the same Linear account with a new key.
    await connect(backend, dana, true, undefined, "lin_api_dana_new");
    // A submission that doesn't resume hers is refused before Linear is asked anything.
    linear.operations.length = 0;
    linear.tokens.length = 0;
    expect((await refusal(create(backend, dana, linear, { threadId }))).message).toBe(
      "You started a ticket on this thread that isn't finished yet. Close this dialog and choose Create ticket again to finish it.",
    );
    expect(linear.operations).toEqual([]);
    // The reopened dialog's draft names her unfinished submission, and submitting it links ENG-1.
    const reopened = await draft(backend, dana, threadId);
    expect(reopened.resumeSubmissionId).toBe(submissionId);
    const view = await create(backend, dana, linear, { threadId, submissionId: reopened.resumeSubmissionId! });
    expect(view.key).toBe("ENG-1");
    expect(linear.issues.map((issue) => issue.id)).toEqual([submissionId]);
    expect(new Set(linear.tokens)).toEqual(new Set(["lin_api_dana_new"]));
    expect(await pendingLinks(backend, threadId)).toEqual([]);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    // With nothing unfinished, the next dialog starts a new ticket.
    expect((await draft(backend, dana, threadId)).resumeSubmissionId).toBeNull();
  });

  test(`${name}: a thread holds at most 40 ticket links, parked creations included, and shows every linked one`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    const leeId = await userId(backend, lee);
    await fill(backend, { projectId, threadId }, await userId(backend, dana), ops.MAX_THREAD_TICKETS - 1);
    const parkedCount = ops.MAX_THREAD_TICKET_ROWS - ops.MAX_THREAD_TICKETS + 1;
    const parked: string[] = [];
    for (let index = 0; index < parkedCount; index++) {
      parked.push(
        await backend.run((store) =>
          tickets(store).links.insert({ projectId, threadId, tracker: "linear", externalId: "", key: "", url: "", title: "", state: "pending", creationId: newId(), creatorAccountId: "u-lee", linkBack: { url: "u", title: "t", added: false }, leaseUntil: 1, linkedBy: leeId, linkedAt: 1, createdFromCritiqs: true }),
        ),
      );
    }
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "ENG-1", title: "Existing", teamId: "team-eng", state: { name: "Todo", type: "unstarted" } }]);
    const full = "Too many tickets on this thread didn't finish being created or linked. Whoever started one finishes it by creating or linking it here again.";
    expect((await refusal(create(backend, dana, linear, { threadId }, { now: 1 + IDLE_CREATION_MS }))).message).toBe(full);
    expect((await refusal(link(backend, dana, linear, { threadId, externalId: "i1" }, { now: 1 + IDLE_CREATION_MS }))).message).toBe(full);
    expect(linear.issues).toHaveLength(1);
    // Should every parked creation turn out to have made its issue, the thread shows all 40.
    for (const [index, id] of parked.entries()) {
      await backend.run((store) => tickets(store).links.patch(id, { state: "linked", externalId: `p${index}`, key: `NEW-${index}`, url: "https://linear.app/p" }));
    }
    expect(await shown(backend, dana, threadId)).toHaveLength(ops.MAX_THREAD_TICKET_ROWS);
  });

  test(`${name}: when Linear refuses the creator's key while checking their creation, it is parked, and they're told to connect Linear again`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    await connect(backend, lee);
    await fill(backend, { projectId, threadId }, await userId(backend, dana), ops.MAX_THREAD_TICKETS - 1);
    const linear = linearStandIn();
    const submissionId = newId();
    linear.intercept = answerLost;
    await refusal(create(backend, dana, linear, { threadId, submissionId }));
    // Dana's key has been revoked in Linear.
    linear.intercept = (_operation, _variables, token) =>
      token === "lin_api_dana" ? Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 }) : undefined;
    const refused = await refusal(create(backend, dana, linear, { threadId, submissionId }));
    expect(refused.message).toBe("Linear didn't accept your connection, so Critiqs couldn't check whether it created this ticket. Connect Linear again in Your trackers, then try again.");
    expect(await pendingLinks(backend, threadId)).toEqual([expect.objectContaining({ creationId: submissionId, parked: true })]);
    // Parked at once, it holds no place: Lee's ticket takes the 20th.
    expect((await create(backend, lee, linear, { threadId })).key).toBe("ENG-2");
    // Once Dana's key works again, her retry links the issue her creation made.
    linear.intercept = null;
    expect((await create(backend, dana, linear, { threadId, submissionId })).key).toBe("ENG-1");
    expect(linear.issues).toHaveLength(2);
  });

  test(`${name}: Add link back and Link call Linear only as the account they checked: connecting another one meanwhile stops them before Linear is called`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn("https://linear.test", [{ id: "i1", identifier: "DES-9", title: "Existing", teamId: "team-des", state: { name: "Todo", type: "unstarted" } }]);
    linear.intercept = (operation) => (operation === "CritiqsLinkBack" ? new Response("bad gateway", { status: 502 }) : undefined);
    const created = await create(backend, dana, linear, { threadId });
    expect(created.canAddLinkBack).toBe(true);
    linear.intercept = null;
    linear.tokens.length = 0;
    const changed = "Your Linear connection changed. Try again.";
    // Add link back is checked as the account Dana created ENG-1 with; she connects another before her token is read.
    const addBack = addTicketLinkBack(
      {
        prepare: async () => {
          const prepared = await backend.run((store) => prepareTicketLinkBack(store, dana, { linkId: created._id }));
          await connect(backend, dana, true, "linear-account-b", "lin_api_dana_b");
          return prepared;
        },
        token: tokens(backend),
        save: () => backend.run((store) => saveTicketLinkBack(store, dana, { linkId: created._id })),
      },
      deployment,
      linear.fetchFn,
    );
    expect((await refusal(addBack)).message).toBe(changed);
    // Link is checked as account B; she connects her first account again before her token is read.
    const steps = linkSteps(backend, dana, { threadId, tracker: "linear", externalId: "i1" }, { now: 6_000 });
    const linking = linkTicket(
      {
        ...steps,
        claim: async (holder) => {
          const claimed = await steps.claim(holder);
          await connect(backend, dana);
          return claimed;
        },
      },
      deployment,
      { threadId, tracker: "linear", externalId: "i1", comment: false },
      linear.fetchFn,
    );
    expect((await refusal(linking)).message).toBe(changed);
    expect(linear.tokens).toEqual([]);
    expect(linear.attachments).toEqual([]);
    expect((await shown(backend, dana, threadId))?.map((ticket) => [ticket.key, ticket.canAddLinkBack])).toEqual([["ENG-1", true]]);
  });

  test(`${name}: an issue Linear made but answered with a field error stays pending for the retry, which links it without creating it again`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    await connect(backend, dana);
    const linear = linearStandIn();
    linear.intercept = (operation, variables) => {
      if (operation !== "CritiqsCreate") return undefined;
      const input = variables.input as { id: string; teamId: string; title: string; description: string };
      linear.issues.push({ id: input.id, identifier: "ENG-1", title: input.title, description: input.description, teamId: input.teamId, state: { name: "Triage", type: "triage" } });
      return Response.json({
        data: { issueCreate: { success: true, issue: null } },
        errors: [{ message: "Cannot return null for non-nullable field Issue.state", path: ["issueCreate", "issue", "state"], extensions: { code: "INPUT_ERROR", userError: true } }],
      });
    };
    const submissionId = newId();
    expect((await refusal(create(backend, dana, linear, { threadId, submissionId }))).code).toBe("unavailable");
    expect(await pendingLinks(backend, threadId)).toHaveLength(1);
    linear.intercept = null;
    expect((await create(backend, dana, linear, { threadId, submissionId })).key).toBe("ENG-1");
    expect(linear.issues).toHaveLength(1);
  });

  test(`${name}: when Linear doesn't add the link back, the created ticket is linked and says so to its creator, who can add it again with the recorded link`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    await connect(backend, dana);
    await connect(backend, sam);
    const linear = linearStandIn();
    linear.intercept = (operation) => (operation === "CritiqsLinkBack" ? new Response("bad gateway", { status: 502 }) : undefined);
    const submissionId = newId();
    const view = await create(backend, dana, linear, { threadId, submissionId });
    expect(view).toMatchObject({ key: "ENG-1", canAddLinkBack: true });
    expect(linear.attachments).toEqual([]);
    // Only Dana is offered to add it; everyone sees the ticket.
    expect((await shown(backend, sam, threadId))?.map((ticket) => [ticket.key, ticket.canAddLinkBack])).toEqual([["ENG-1", false]]);
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.canAddLinkBack)).toEqual([true]);
    // Retrying the submission creates nothing again.
    expect((await create(backend, dana, linear, { threadId, submissionId }))._id).toBe(view._id);
    expect(linear.issues).toHaveLength(1);
    expect((await refusal(addLinkBack(backend, sam, linear, view._id))).code).toBe("forbidden");
    // Still failing: it says so, and stays missing.
    expect((await refusal(addLinkBack(backend, dana, linear, view._id))).code).toBe("unavailable");
    expect((await shown(backend, dana, threadId))?.map((ticket) => ticket.canAddLinkBack)).toEqual([true]);
    // The review address moved since; the link back is the one recorded when Dana submitted.
    await backend.run((store) => ops.setReviewUrl(store, dana, { projectId, reviewUrl: "https://review.example/moved" }));
    linear.intercept = null;
    expect((await addLinkBack(backend, dana, linear, view._id)).canAddLinkBack).toBe(false);
    expect(linear.attachments).toEqual([{ issueId: submissionId, url: `https://review.example/app?tab=users&critiqs=${threadId}`, title: "Department is wrong" }]);
    linear.operations.length = 0;
    expect((await addLinkBack(backend, dana, linear, view._id)).canAddLinkBack).toBe(false);
    expect(linear.operations).toEqual([]);
  });
}
