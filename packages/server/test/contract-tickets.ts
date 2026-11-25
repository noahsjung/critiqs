import { expect, test } from "bun:test";
import * as ops from "../src/operations.ts";
import type { Identity, Store, TicketLinkRecord, TrackerAccountRecord } from "../src/store.ts";
import { anchor, type ContractBackend, reviewer } from "./contract.ts";

const page = { numItems: 40, cursor: null };
const failed = { status: "failed" as const, failureReason: "Blocked" };
const token = (text: string) => ({ ciphertext: `${text}-ciphertext`, iv: `${text}-iv` });

/** The ticket storage of a backend that offers tickets. */
function tickets(store: Store) {
  if (store.tickets === undefined) throw new Error("This backend doesn't store tickets.");
  return store.tickets;
}

/**
 * Tickets' storage, and how threads show their linked tickets, the same on
 * every backend that offers tickets. Each test starts with a fresh, empty backend.
 */
export function defineTicketContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");

  async function userId(backend: ContractBackend, who: Identity) {
    const user = await backend.run((store) => store.users.byToken(who.tokenIdentifier));
    if (user === null) throw new Error(`${who.name} has no user record`);
    return user._id;
  }

  /** A project with two threads, Dana's, and Lee's user record. */
  async function setup(backend: ContractBackend) {
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const threadId = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "Department is wrong", tags: [], capture: failed }));
    const otherThreadId = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Label is unclear", tags: [], capture: failed }));
    return { projectId, threadId, otherThreadId, danaId: await userId(backend, dana), leeId: await userId(backend, lee) };
  }

  function account(userId: string, tracker: TrackerAccountRecord["tracker"]): Omit<TrackerAccountRecord, "_id"> {
    return {
      userId,
      tracker,
      method: "oauth",
      accountId: `${tracker}-${userId}`,
      accountName: "Dana Smith",
      site: { id: "ws1", name: "Acme" },
      access: token("access"),
      refresh: token("refresh"),
      expiresAt: 5_000,
      attribution: true,
      connectedAt: 1_000,
      updatedAt: 1_000,
    };
  }

  function link(ids: { projectId: string; threadId: string; linkedBy: string }, key: string, changes: Partial<TicketLinkRecord> = {}): Omit<TicketLinkRecord, "_id"> {
    return {
      ...ids,
      tracker: "linear",
      externalId: `id-${key}`,
      key,
      url: `https://linear.app/acme/issue/${key}`,
      title: `Ticket ${key}`,
      site: "ws1",
      state: "linked",
      linkedAt: 2_000,
      createdFromCritiqs: true,
      ...changes,
    };
  }

  test(`${name}: a person's tracker accounts are found by person and tracker, and only theirs are listed`, async () => {
    const backend = fresh();
    const { danaId, leeId } = await setup(backend);
    const linearId = await backend.run((store) => tickets(store).accounts.insert(account(danaId, "linear")));
    await backend.run((store) => tickets(store).accounts.insert(account(danaId, "jira")));
    await backend.run((store) => tickets(store).accounts.insert(account(leeId, "linear")));

    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "linear"))).toEqual({ _id: linearId, ...account(danaId, "linear") });
    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "github"))).toBeNull();
    const listed = await backend.run((store) => tickets(store).accounts.list(danaId));
    expect(listed.map((row) => row.tracker).sort()).toEqual(["jira", "linear"]);
    expect(listed.every((row) => row.userId === danaId)).toBe(true);
  });

  test(`${name}: patching a tracker account changes what is given, null clears optional fields, and delete removes it`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const id = await backend.run((store) => tickets(store).accounts.insert(account(danaId, "linear")));
    await backend.run((store) =>
      tickets(store).accounts.patch(id, { method: "token", access: token("pasted"), attribution: false, updatedAt: 3_000, refresh: null, expiresAt: null, site: null }),
    );
    const { refresh: _refresh, expiresAt: _expiresAt, site: _site, ...kept } = account(danaId, "linear");
    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "linear"))).toEqual({
      ...kept,
      _id: id,
      method: "token",
      access: token("pasted"),
      attribution: false,
      updatedAt: 3_000,
    });
    await backend.run((store) => tickets(store).accounts.delete(id));
    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "linear"))).toBeNull();
    expect(await backend.run((store) => tickets(store).accounts.list(danaId))).toEqual([]);
  });

  test(`${name}: a thread's ticket links list by state in the order they were added, up to the limit`, async () => {
    const backend = fresh();
    const { projectId, threadId, otherThreadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    for (const key of ["ENG-1", "ENG-2", "ENG-3"]) await backend.run((store) => tickets(store).links.insert(link(ids, key)));
    await backend.run((store) => tickets(store).links.insert(link(ids, "", { externalId: "", url: "", state: "pending", pendingToken: "p1" })));
    await backend.run((store) => tickets(store).links.insert(link({ ...ids, threadId: otherThreadId }, "ENG-9")));

    const linked = await backend.run((store) => tickets(store).links.listForThread(threadId, "linked", 10));
    expect(linked.map((row) => row.key)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    const pending = await backend.run((store) => tickets(store).links.listForThread(threadId, "pending", 10));
    expect(pending.map((row) => [row.pendingToken, row.state])).toEqual([["p1", "pending"]]);
    expect((await backend.run((store) => tickets(store).links.listForThread(threadId, "linked", 2))).map((row) => row.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(await backend.run((store) => tickets(store).links.get(linked[0]!._id))).toEqual({ _id: linked[0]!._id, ...link(ids, "ENG-1") });
  });

  test(`${name}: many tickets still being created don't hide a linked one`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    for (let i = 0; i < 25; i++) {
      await backend.run((store) => tickets(store).links.insert(link(ids, "", { externalId: "", url: "", state: "pending", pendingToken: `p${i}` })));
    }
    await backend.run((store) => tickets(store).links.insert(link(ids, "ENG-1")));
    const listed = await backend.run((store) => ops.listThreads(store, lee, { projectId }, page));
    expect(listed.page.find((thread) => thread._id === threadId)?.tickets?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
    const opened = await backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    expect(opened.tickets?.map((ticket) => ticket.key)).toEqual(["ENG-1"]);
  });

  test(`${name}: a ticket's links are found by tracker and ticket ID across threads`, async () => {
    const backend = fresh();
    const { projectId, threadId, otherThreadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    await backend.run((store) => tickets(store).links.insert(link(ids, "ENG-1")));
    await backend.run((store) => tickets(store).links.insert(link({ ...ids, threadId: otherThreadId }, "ENG-1")));
    await backend.run((store) => tickets(store).links.insert(link(ids, "ENG-2")));
    // The same ID in another tracker is another ticket.
    await backend.run((store) => tickets(store).links.insert(link(ids, "ENG-1", { tracker: "jira" })));

    const found = await backend.run((store) => tickets(store).links.findByExternal("linear", "id-ENG-1"));
    expect(found.map((row) => row.threadId).sort()).toEqual([threadId, otherThreadId].sort());
    expect(found.every((row) => row.tracker === "linear" && row.key === "ENG-1")).toBe(true);
    expect(await backend.run((store) => tickets(store).links.findByExternal("github", "id-ENG-1"))).toEqual([]);
  });

  test(`${name}: a pending link is finalized by patching, null clears optional fields, and delete removes it`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    const id = await backend.run((store) =>
      // Created as pending with the title being sent, before the tracker gives the ticket's ID, key, and address.
      tickets(store).links.insert(link(ids, "", { title: "Ticket ENG-7", externalId: "", url: "", site: undefined, state: "pending", pendingToken: "p1" })),
    );
    await backend.run((store) =>
      tickets(store).links.patch(id, {
        state: "linked",
        externalId: "id-ENG-7",
        key: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        site: "ws1",
        pendingToken: null,
        status: { label: "Todo", category: "open" },
        statusCheckedAt: 2_500,
        statusChangedAt: 2_400,
      }),
    );
    expect(await backend.run((store) => tickets(store).links.get(id))).toEqual({
      _id: id,
      ...link(ids, "ENG-7"),
      status: { label: "Todo", category: "open" },
      statusCheckedAt: 2_500,
      statusChangedAt: 2_400,
    });
    expect((await backend.run((store) => tickets(store).links.findByExternal("linear", "id-ENG-7"))).map((row) => row._id)).toEqual([id]);

    await backend.run((store) => tickets(store).links.patch(id, { status: null, statusCheckedAt: null, statusChangedAt: null, site: null }));
    const { site: _site, ...withoutSite } = link(ids, "ENG-7");
    expect(await backend.run((store) => tickets(store).links.get(id))).toEqual({ _id: id, ...withoutSite });

    await backend.run((store) => tickets(store).links.delete(id));
    expect(await backend.run((store) => tickets(store).links.get(id))).toBeNull();
    expect(await backend.run((store) => tickets(store).links.listForThread(threadId, "linked", 10))).toEqual([]);
  });

  test(`${name}: an ID that isn't a ticket link's finds nothing`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend);
    expect(await backend.run((store) => tickets(store).links.get("not-an-id"))).toBeNull();
    // Another table's ID is not a link's.
    expect(await backend.run((store) => tickets(store).links.get(threadId))).toBeNull();
  });

  test(`${name}: writes refuse another table's ID and leave that row alone`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await setup(backend);
    const writes: ((store: Store) => Promise<unknown>)[] = [
      (store) => tickets(store).links.delete(threadId),
      (store) => tickets(store).links.patch(threadId, { title: "x" }),
      (store) => tickets(store).accounts.delete(threadId),
      (store) => tickets(store).accounts.patch(threadId, { accountName: "x" }),
      (store) => tickets(store).settings.patch(projectId, { resolveWhenDone: true }),
      (store) => tickets(store).signIns.delete(danaId),
    ];
    for (const write of writes) await expect(backend.run(write)).rejects.toThrow();
    const opened = await backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    expect(opened._id).toBe(threadId);
    expect(await backend.run((store) => store.users.get(danaId))).not.toBeNull();
    expect(await backend.run((store) => store.projects.get(projectId))).not.toBeNull();
  });

  test(`${name}: a project has no ticket settings until saved, then they are found and patched`, async () => {
    const backend = fresh();
    const { projectId, danaId, leeId } = await setup(backend);
    expect(await backend.run((store) => tickets(store).settings.find(projectId))).toBeNull();
    const settings = {
      projectId,
      templates: [{ tracker: "linear" as const, destinationId: "team1", templateId: "tpl1", name: "Bug report" }],
      resolveWhenDone: false,
      defaults: [{ tracker: "linear" as const, destinationId: "team1", name: "Engineering" }],
      updatedBy: danaId,
      updatedAt: 1_000,
    };
    const id = await backend.run((store) => tickets(store).settings.insert(settings));
    expect(await backend.run((store) => tickets(store).settings.find(projectId))).toEqual({ _id: id, ...settings });
    await backend.run((store) => tickets(store).settings.patch(id, { resolveWhenDone: true, templates: [], updatedBy: leeId, updatedAt: 2_000 }));
    expect(await backend.run((store) => tickets(store).settings.find(projectId))).toEqual({
      ...settings,
      _id: id,
      resolveWhenDone: true,
      templates: [],
      updatedBy: leeId,
      updatedAt: 2_000,
    });
  });

  test(`${name}: a tracker sign-in is found by its state until deleted`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const signIn = { state: "state-abc", userId: danaId, tracker: "linear" as const, expiresAt: 9_000 };
    const id = await backend.run((store) => tickets(store).signIns.insert(signIn));
    expect(await backend.run((store) => tickets(store).signIns.findByState("state-abc"))).toEqual({ _id: id, ...signIn });
    expect(await backend.run((store) => tickets(store).signIns.findByState("state-other"))).toBeNull();
    await backend.run((store) => tickets(store).signIns.delete(id));
    expect(await backend.run((store) => tickets(store).signIns.findByState("state-abc"))).toBeNull();
  });

  test(`${name}: threads list and open with their linked tickets, oldest first, leaving out tickets still being created`, async () => {
    const backend = fresh();
    const { projectId, threadId, otherThreadId, danaId, leeId } = await setup(backend);
    const listed = async () => {
      const result = await backend.run((store) => ops.listThreads(store, lee, { projectId }, page));
      return Object.fromEntries(result.page.map((thread) => [thread._id, thread.tickets]));
    };
    const opened = async () => (await backend.run((store) => ops.getThread(store, lee, { threadId }, page))).tickets;
    expect(await listed()).toEqual({ [threadId]: [], [otherThreadId]: [] });
    expect(await opened()).toEqual([]);

    const ids = { projectId, threadId, linkedBy: danaId };
    const first = await backend.run((store) =>
      tickets(store).links.insert(link(ids, "ENG-1", { status: { label: "In Progress", category: "started" }, statusCheckedAt: 2_100 })),
    );
    await backend.run((store) => tickets(store).links.insert(link(ids, "", { externalId: "", url: "", state: "pending", pendingToken: "p1" })));
    const second = await backend.run((store) =>
      tickets(store).links.insert(link({ ...ids, linkedBy: leeId }, "ENG-2", { tracker: "jira", createdFromCritiqs: false, linkedAt: 3_000 })),
    );

    expect(await listed()).toEqual({
      [threadId]: [
        { tracker: "linear", key: "ENG-1", status: { label: "In Progress", category: "started" } },
        { tracker: "jira", key: "ENG-2", status: null },
      ],
      [otherThreadId]: [],
    });
    expect(await opened()).toEqual([
      {
        _id: first,
        threadId,
        tracker: "linear",
        key: "ENG-1",
        url: "https://linear.app/acme/issue/ENG-1",
        title: "Ticket ENG-1",
        status: { label: "In Progress", category: "started" },
        statusCheckedAt: 2_100,
        createdFromCritiqs: true,
        linkedByName: "Dana",
        linkedAt: 2_000,
      },
      {
        _id: second,
        threadId,
        tracker: "jira",
        key: "ENG-2",
        url: "https://linear.app/acme/issue/ENG-2",
        title: "Ticket ENG-2",
        status: null,
        statusCheckedAt: null,
        createdFromCritiqs: false,
        linkedByName: "Lee",
        linkedAt: 3_000,
      },
    ]);
  });
}
