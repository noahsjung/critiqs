import { expect, test } from "bun:test";
import { decryptToken, trackerTokenBinding } from "../src/ai/secrets.ts";
import { CritiqsError } from "../src/errors.ts";
import * as ops from "../src/operations.ts";
import {
  claimTokenRefresh,
  claimTrackerSignIn,
  connectTrackerWithToken,
  disconnectTracker,
  endTrackerAccount,
  finishTokenRefresh,
  listTrackerAccounts,
  openTrackerSignIn,
  REFRESH_LEASE_MS,
  REFRESH_MARGIN_MS,
  REFRESH_SAVE_MS,
  type RefreshClaim,
  requireTrackerPerson,
  saveOwnTrackerAccount,
  saveSignedInAccount,
  saveTrackerAccount,
  sealSignIn,
  setTrackerAttribution,
  SIGN_IN_MINUTES,
  startTrackerSignIn,
  type TicketsDeployment,
  ticketsConfig,
  ticketsDeploymentFromEnv,
  trackerAccessToken,
} from "../src/tickets/accounts.ts";
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
    await backend.run((store) => tickets(store).links.insert(link(ids, "", { externalId: "", url: "", state: "pending", creationId: "p1" })));
    await backend.run((store) => tickets(store).links.insert(link({ ...ids, threadId: otherThreadId }, "ENG-9")));

    const linked = await backend.run((store) => tickets(store).links.listForThread(threadId, "linked", 10));
    expect(linked.map((row) => row.key)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    const pending = await backend.run((store) => tickets(store).links.listForThread(threadId, "pending", 10));
    expect(pending.map((row) => [row.creationId, row.state])).toEqual([["p1", "pending"]]);
    expect((await backend.run((store) => tickets(store).links.listForThread(threadId, "linked", 2))).map((row) => row.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(await backend.run((store) => tickets(store).links.get(linked[0]!._id))).toEqual({ _id: linked[0]!._id, ...link(ids, "ENG-1") });
  });

  test(`${name}: many tickets still being created don't hide a linked one`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    for (let i = 0; i < 25; i++) {
      await backend.run((store) => tickets(store).links.insert(link(ids, "", { externalId: "", url: "", state: "pending", creationId: `p${i}` })));
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

    const found = await backend.run((store) => tickets(store).links.findByExternal("linear", "id-ENG-1", 100));
    expect(found.map((row) => row.threadId).sort()).toEqual([threadId, otherThreadId].sort());
    expect(found.every((row) => row.tracker === "linear" && row.key === "ENG-1")).toBe(true);
    expect(await backend.run((store) => tickets(store).links.findByExternal("github", "id-ENG-1", 100))).toEqual([]);
  });

  test(`${name}: a creation's link is found by its creation ID in any thread, pending or linked`, async () => {
    const backend = fresh();
    const { projectId, threadId, otherThreadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    const pending = await backend.run((store) => tickets(store).links.insert(link({ ...ids, threadId: otherThreadId }, "", { externalId: "", url: "", state: "pending", creationId: "c1" })));
    const linked = await backend.run((store) => tickets(store).links.insert(link(ids, "ENG-1", { creationId: "c2", creatorAccountId: "u1", linkBack: { url: "https://review.example/?critiqs=t", title: "T", added: false } })));
    await backend.run((store) => tickets(store).links.insert(link(ids, "ENG-2")));
    expect((await backend.run((store) => tickets(store).links.findByCreation("c1")))?._id).toBe(pending);
    expect(await backend.run((store) => tickets(store).links.findByCreation("c2"))).toMatchObject({ _id: linked, creatorAccountId: "u1", linkBack: { added: false } });
    expect(await backend.run((store) => tickets(store).links.findByCreation("c3"))).toBeNull();
  });

  test(`${name}: a pending link is finalized by patching, null clears optional fields, and delete removes it`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await setup(backend);
    const ids = { projectId, threadId, linkedBy: danaId };
    const id = await backend.run((store) =>
      // Created as pending with the title being sent, before the tracker gives the ticket's ID, key, and address.
      tickets(store).links.insert(link(ids, "", { title: "Ticket ENG-7", externalId: "", url: "", site: undefined, state: "pending", creationId: "p1" })),
    );
    await backend.run((store) =>
      tickets(store).links.patch(id, {
        state: "linked",
        externalId: "id-ENG-7",
        key: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        site: "ws1",
        creationId: null,
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
    expect((await backend.run((store) => tickets(store).links.findByExternal("linear", "id-ENG-7", 100))).map((row) => row._id)).toEqual([id]);

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
    await backend.run((store) => tickets(store).links.insert(link(ids, "", { externalId: "", url: "", state: "pending", creationId: "p1" })));
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
        externalId: "id-ENG-1",
        key: "ENG-1",
        url: "https://linear.app/acme/issue/ENG-1",
        title: "Ticket ENG-1",
        status: { label: "In Progress", category: "started" },
        statusCheckedAt: 2_100,
        createdFromCritiqs: true,
        linkedByName: "Dana",
        linkedAt: 2_000,
        // Lee neither linked it nor owns the project.
        canUnlink: false,
        canAddLinkBack: false,
      },
      {
        _id: second,
        threadId,
        tracker: "jira",
        externalId: "id-ENG-2",
        key: "ENG-2",
        url: "https://linear.app/acme/issue/ENG-2",
        title: "Ticket ENG-2",
        status: null,
        statusCheckedAt: null,
        createdFromCritiqs: false,
        linkedByName: "Lee",
        linkedAt: 3_000,
        canUnlink: true,
        canAddLinkBack: false,
      },
    ]);
    // Dana owns the project, so she may unlink Lee's too.
    const asOwner = (await backend.run((store) => ops.getThread(store, dana, { threadId }, page))).tickets;
    expect(asOwner?.map((ticket) => [ticket.key, ticket.canUnlink])).toEqual([
      ["ENG-1", true],
      ["ENG-2", true],
    ]);
  });

  // -------------------------------------------------------------------------
  // Your trackers: the rules over this storage.

  const KEY = "operator-encryption-key-".padEnd(48, "x");
  const withKey: TicketsDeployment = { encryptionKey: KEY, linear: null, linearApiUrl: "https://linear.test", linearAppUrl: "https://linear.test" };
  const withSignIn: TicketsDeployment = { ...withKey, linear: { clientId: "client", clientSecret: "secret" } };

  /** A stand-in for Linear's API: its viewer, from the token sent; and its token endpoint, answering `refreshes` in turn. */
  function linearStub(refreshes: { access_token: string; refresh_token?: string; expires_in?: number }[] = []) {
    const sent: { url: string; authorization: string | null; body: string }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      sent.push({ url, authorization, body: String(init?.body ?? "") });
      if (url.endsWith("/oauth/token")) {
        const next = refreshes.shift();
        return next === undefined ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json(next);
      }
      if (authorization === "lin_api_bad") return Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 });
      const who = authorization === "lin_api_other" ? { id: "user-2", name: "Dana Other" } : { id: "user-1", name: "Dana Smith" };
      return Response.json({ data: { viewer: who, organization: { id: "org-1", name: "Acme" } } });
    }) as typeof fetch;
    return { fetchFn, sent };
  }

  /** A sign-in Dana started, whose window Linear has sent back: the state to save its account with. */
  async function claimedSignIn(backend: ContractBackend): Promise<string> {
    const state = `state-${crypto.randomUUID()}`;
    await backend.run((store) => startTrackerSignIn(store, dana, withSignIn, { tracker: "linear", state, verifier: "v", bindingHash: "h" }, 1_000));
    await backend.run((store) => openTrackerSignIn(store, { tracker: "linear", state, bindingHash: "h" }, 1_000));
    expect((await backend.run((store) => claimTrackerSignIn(store, { tracker: "linear", state, bindingHash: "h" }, 1_000))).status).toBe("claimed");
    return state;
  }

  /** Connects with a pasted token as `who`, each step its own transaction, as the Convex action runs it. */
  function connect(backend: ContractBackend, who: Identity, token: string, deployment = withKey, fetchFn = linearStub().fetchFn) {
    return connectTrackerWithToken(
      {
        requirePerson: () => backend.run((store) => requireTrackerPerson(store, who, deployment, { tracker: "linear" }, Date.now())),
        save: (userId, sealed) => backend.run((store) => saveOwnTrackerAccount(store, who, { userId, account: sealed }, 5_000)),
      },
      deployment,
      { tracker: "linear", token },
      fetchFn,
    );
  }

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CritiqsError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test(`${name}: connecting with a pasted token verifies it with Linear and stores it only encrypted, for that person`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const linear = linearStub();
    const view = await connect(backend, dana, "  lin_api_good ", withKey, linear.fetchFn);
    expect(view).toEqual({ tracker: "linear", method: "token", accountName: "Dana Smith", site: "Acme", connectedAt: 5_000, attribution: true });
    expect(linear.sent.map((request) => request.authorization)).toEqual(["lin_api_good"]);
    const stored = (await backend.run((store) => tickets(store).accounts.find(danaId, "linear")))!;
    expect(JSON.stringify(stored)).not.toContain("lin_api_good");
    expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), stored.access)).toBe("lin_api_good");
    expect(stored).toMatchObject({ accountId: "user-1", site: { id: "org-1", name: "Acme" } });
    expect(stored.refresh).toBeUndefined();
    // Only the person sees it, and never a token.
    expect(await backend.run((store) => listTrackerAccounts(store, dana))).toEqual([view]);
    expect(await backend.run((store) => listTrackerAccounts(store, lee))).toEqual([]);
    expect(JSON.stringify(await backend.run((store) => listTrackerAccounts(store, dana)))).not.toMatch(/ciphertext|lin_api/);
  });

  test(`${name}: connecting again replaces the account: one per person and tracker, keeping the attribution choice`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    await connect(backend, dana, "lin_api_good");
    await backend.run((store) => setTrackerAttribution(store, dana, { tracker: "linear", attribution: false }, 6_000));
    const view = await connect(backend, dana, "lin_api_other");
    expect(view).toMatchObject({ accountName: "Dana Other", attribution: false });
    const all = await backend.run((store) => tickets(store).accounts.list(danaId));
    expect(all).toHaveLength(1);
    expect(await decryptToken(KEY, trackerTokenBinding("linear", danaId), all[0]!.access)).toBe("lin_api_other");
  });

  test(`${name}: a token Linear refuses, an empty paste, or a deployment without an encryption key stores nothing`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    expect((await refusal(connect(backend, dana, "lin_api_bad"))).message).toBe("Linear didn't accept this API key. Check that you copied all of it, or create a new one.");
    expect((await refusal(connect(backend, dana, "   "))).message).toBe("Paste your API key.");
    const noKey = { ...withKey, encryptionKey: null };
    const linear = linearStub();
    const missing = await refusal(connect(backend, dana, "lin_api_good", noKey, linear.fetchFn));
    expect(missing.message).toBe("This deployment can't store tracker accounts yet. Its operator must set an encryption key (CRITIQS_AI_ENCRYPTION_KEY) first.");
    // Refused before the token is sent anywhere.
    expect(linear.sent).toEqual([]);
    expect(await backend.run((store) => tickets(store).accounts.list(danaId))).toEqual([]);
    expect((await refusal(backend.run((store) => requireTrackerPerson(store, dana, withKey, { tracker: "jira" }, Date.now())))).message).toBe("Critiqs can't connect Jira yet.");
    expect((await refusal(backend.run((store) => requireTrackerPerson(store, null, withKey, { tracker: "linear" }, Date.now())))).code).toBe("unauthenticated");
  });

  test(`${name}: a sign-in's account is saved only when its email is the Critiqs account's, in any letter case`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const save = async (email: string | null) => {
      const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email, site: null }, { access: "a", refresh: "r", expiresAt: 9_000_000 });
      const state = await claimedSignIn(backend);
      return await backend.run((store) => saveSignedInAccount(store, { userId: danaId, account: sealed, state }, 1_000));
    };
    // Another Linear account, or one that shares no email: nothing is stored.
    expect(await save("someone@example.com")).toEqual({ status: "other-email" });
    expect(await save(null)).toEqual({ status: "other-email" });
    expect(await backend.run((store) => tickets(store).accounts.list(danaId))).toEqual([]);
    // Dana's own address (dana@example.com), as sign-in compares addresses.
    expect(await save(" Dana@Example.COM ")).toEqual({ status: "saved" });
    expect(await backend.run((store) => listTrackerAccounts(store, dana))).toEqual([expect.objectContaining({ tracker: "linear", method: "oauth", accountName: "Dana" })]);
  });

  test(`${name}: an account sealed for one person can't be saved as another's`, async () => {
    const backend = fresh();
    const { danaId, leeId } = await setup(backend);
    const sealed = await sealSignIn(withKey, "linear", danaId, { accountId: "u", accountName: "Dana", email: null, site: null }, { access: "a", refresh: null, expiresAt: null });
    expect((await refusal(backend.run((store) => saveOwnTrackerAccount(store, lee, { userId: danaId, account: sealed }, 1)))).code).toBe("forbidden");
    expect(await backend.run((store) => tickets(store).accounts.list(leeId))).toEqual([]);
  });

  test(`${name}: disconnecting removes only that person's account; attribution needs an account`, async () => {
    const backend = fresh();
    const { danaId, leeId } = await setup(backend);
    await connect(backend, dana, "lin_api_good");
    await connect(backend, lee, "lin_api_good");
    expect(await backend.run((store) => setTrackerAttribution(store, dana, { tracker: "linear", attribution: false }, 7_000))).toMatchObject({ attribution: false });
    await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "linear"))).toBeNull();
    expect(await backend.run((store) => tickets(store).accounts.find(leeId, "linear"))).not.toBeNull();
    // Disconnecting twice changes nothing.
    await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    expect((await refusal(backend.run((store) => setTrackerAttribution(store, dana, { tracker: "linear", attribution: true }, 8_000)))).message).toBe("Connect Linear first.");
  });

  test(`${name}: disconnecting a sign-in ends it at Linear too; a pasted key can't be ended by Critiqs and stays the person's to remove`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: "dana@example.com", site: null }, { access: "oauth-access", refresh: "oauth-refresh", expiresAt: 9_000_000 });
    const state = await claimedSignIn(backend);
    await backend.run((store) => saveSignedInAccount(store, { userId: danaId, account: sealed, state }, 1_000));
    const ended = await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "linear"))).toBeNull();
    const linear = linearStub();
    expect(await endTrackerAccount(withSignIn, ended!, linear.fetchFn)).toBe("ended");
    // Linear's revocation endpoint, with the refresh token first (which ends the sign-in), then the access token.
    const revoked = linear.sent.filter((request) => request.url.endsWith("/oauth/revoke")).map((request) => Object.fromEntries(new URLSearchParams(request.body)));
    expect(revoked.map((form) => [form.token, form.token_type_hint])).toEqual([
      ["oauth-refresh", "refresh_token"],
      ["oauth-access", "access_token"],
    ]);
    expect(revoked.every((form) => form.client_id === "client" && form.client_secret === "secret")).toBe(true);
    // Disconnecting again finds nothing to end.
    expect(await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }))).toBeNull();
    // A pasted key: Linear offers no call that ends it, so Critiqs says it is kept.
    await connect(backend, dana, "lin_api_good");
    const pasted = await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    const quiet = linearStub();
    expect(await endTrackerAccount(withSignIn, pasted!, quiet.fetchFn)).toBe("kept");
    expect(quiet.sent).toEqual([]);
  });

  /**
   * Linear's sign-in tokens and its revocation endpoint, as documented
   * (https://linear.app/developers/oauth-2-0-authentication): `POST
   * /oauth/revoke` with `token` answers 200 when it revoked it and 400 when it
   * couldn't, as for a token already revoked; a token Linear no longer accepts
   * is refused by its API; a refresh token is spent when used. `refuse` makes
   * Linear turn every revocation down; `down` makes it unreachable;
   * `endsAuthorization` makes revoking the refresh token end the access
   * token too.
   */
  function linearTokens(live: string[], options: { refuse?: boolean; down?: boolean; endsAuthorization?: boolean } = {}) {
    const alive = new Set(live);
    const revocations: string[] = [];
    let issued = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (options.down === true) throw new TypeError("fetch failed");
      const url = String(input);
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (url.endsWith("/oauth/revoke")) {
        const value = form.get("token") ?? "";
        revocations.push(value);
        if (options.refuse === true || !alive.delete(value)) return new Response(null, { status: 400 });
        if (options.endsAuthorization === true && form.get("token_type_hint") === "refresh_token") alive.clear();
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/oauth/token")) {
        const used = form.get("refresh_token") ?? "";
        if (!alive.delete(used)) return Response.json({ error: "invalid_grant" }, { status: 400 });
        issued++;
        alive.add(`access-${issued}`);
        alive.add(`refresh-${issued}`);
        return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 86_399 });
      }
      const bearer = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("Authorization") ?? "")?.[1] ?? "";
      if (!alive.has(bearer)) return Response.json({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 });
      return Response.json({ data: { viewer: { id: "user-1", name: "Dana Smith", email: "dana@example.com" }, organization: { id: "org-1", name: "Acme" } } });
    }) as typeof fetch;
    return { fetchFn, alive, revocations };
  }

  test(`${name}: disconnecting says it ended a Linear sign-in only when Linear no longer accepts its tokens`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const disconnected = async () => {
      const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: "dana@example.com", site: null }, { access: "oauth-access", refresh: "oauth-refresh", expiresAt: 9_000_000 });
      await backend.run((store) => saveTrackerAccount(store, danaId, sealed, 1_000));
      return (await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" })))!;
    };
    // Linear turns the revocation down while both tokens still work: not ended, and the person is told.
    const refusing = linearTokens(["oauth-access", "oauth-refresh"], { refuse: true });
    expect(await endTrackerAccount(withSignIn, await disconnected(), refusing.fetchFn)).toBe("failed");
    expect(refusing.alive.has("oauth-refresh")).toBe(true);
    // Linear can't be reached.
    expect(await endTrackerAccount(withSignIn, await disconnected(), linearTokens(["oauth-access", "oauth-refresh"], { down: true }).fetchFn)).toBe("failed");
    // Both revoked.
    const normal = linearTokens(["oauth-access", "oauth-refresh"]);
    expect(await endTrackerAccount(withSignIn, await disconnected(), normal.fetchFn)).toBe("ended");
    expect(normal.alive.size).toBe(0);
    // Revoking the refresh token ended the access token too, so its own revocation answers 400: still ended, as Linear no longer accepts it.
    expect(await endTrackerAccount(withSignIn, await disconnected(), linearTokens(["oauth-access", "oauth-refresh"], { endsAuthorization: true }).fetchFn)).toBe("ended");
    // Already revoked in Linear by the person: both 400, and neither works.
    expect(await endTrackerAccount(withSignIn, await disconnected(), linearTokens([]).fetchFn)).toBe("ended");
    // The access token had expired and only the refresh token's revocation was turned down: the refresh token is tried, still works, and its new tokens are revoked.
    const halfway = linearTokens(["oauth-refresh"]);
    const stubborn = halfway.fetchFn;
    let refusedOnce = false;
    const refuseFirst = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!refusedOnce && String(input).endsWith("/oauth/revoke")) {
        refusedOnce = true;
        return new Response(null, { status: 400 });
      }
      return await stubborn(input, init);
    }) as typeof fetch;
    expect(await endTrackerAccount(withSignIn, await disconnected(), refuseFirst)).toBe("ended");
    expect(halfway.alive.size).toBe(0);
  });

  test(`${name}: a sign-in under way when the person disconnects connects nothing, whether or not the tracker had sent them back yet`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: "dana@example.com", site: null }, { access: "oauth-access", refresh: "oauth-refresh", expiresAt: 9_000_000 });
    const start = async (state: string) => {
      await backend.run((store) => startTrackerSignIn(store, dana, withSignIn, { tracker: "linear", state, verifier: "v", bindingHash: "h" }, 1_000));
      await backend.run((store) => openTrackerSignIn(store, { tracker: "linear", state, bindingHash: "h" }, 1_001));
    };
    // Linear had sent the window back, and Critiqs was trading the code for tokens, when Dana disconnected.
    await start("state-1");
    expect((await backend.run((store) => claimTrackerSignIn(store, { tracker: "linear", state: "state-1", bindingHash: "h" }, 1_002))).status).toBe("claimed");
    await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    expect(await backend.run((store) => saveSignedInAccount(store, { userId: danaId, account: sealed, state: "state-1" }, 1_003))).toEqual({ status: "cancelled" });
    expect(await backend.run((store) => tickets(store).accounts.find(danaId, "linear"))).toBeNull();
    // Linear hadn't sent it back yet: it can't finish at all.
    await start("state-2");
    await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    expect((await backend.run((store) => claimTrackerSignIn(store, { tracker: "linear", state: "state-2", bindingHash: "h" }, 1_002))).status).toBe("expired");
    // A sign-in started after disconnecting connects as usual, once.
    await start("state-3");
    expect((await backend.run((store) => claimTrackerSignIn(store, { tracker: "linear", state: "state-3", bindingHash: "h" }, 1_004))).status).toBe("claimed");
    expect(await backend.run((store) => saveSignedInAccount(store, { userId: danaId, account: sealed, state: "state-3" }, 1_005))).toEqual({ status: "saved" });
    expect(await backend.run((store) => saveSignedInAccount(store, { userId: danaId, account: sealed, state: "state-3" }, 1_006))).toEqual({ status: "cancelled" });
    expect((await backend.run((store) => claimTrackerSignIn(store, { tracker: "linear", state: "state-3", bindingHash: "h" }, 1_007))).status).toBe("expired");
  });

  test(`${name}: tickets are offered only with an encryption key, and Linear signs in only with the operator's app`, () => {
    expect(ticketsConfig({ ...withKey, encryptionKey: null })).toBeNull();
    expect(ticketsConfig(withKey)).toEqual({ trackers: [{ id: "linear", signIn: "token" }], threadTickets: true });
    expect(ticketsConfig(withSignIn)).toEqual({ trackers: [{ id: "linear", signIn: "oauth" }], threadTickets: true });
    expect(ticketsDeploymentFromEnv({ CRITIQS_AI_ENCRYPTION_KEY: KEY, CRITIQS_LINEAR_CLIENT_ID: "id" }).linear).toBeNull();
    expect(ticketsDeploymentFromEnv({ CRITIQS_AI_ENCRYPTION_KEY: KEY, CRITIQS_LINEAR_CLIENT_ID: "id", CRITIQS_LINEAR_CLIENT_SECRET: "s" })).toEqual({
      encryptionKey: KEY,
      linear: { clientId: "id", clientSecret: "s" },
      linearApiUrl: "https://api.linear.app",
      linearAppUrl: "https://linear.app",
    });
  });

  test(`${name}: a tracker sign-in opens once, only with the starting interface's secret, finishes only in that browser, and expires`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    // Each sign-in's binding secret, hashed, is `secret-<state>`; only the interface that started it has it.
    const start = (state: string, at = 1_000) =>
      backend.run((store) => startTrackerSignIn(store, dana, withSignIn, { tracker: "linear", state, verifier: `v-${state}`, bindingHash: `secret-${state}` }, at));
    expect(
      (await refusal(backend.run((store) => startTrackerSignIn(store, dana, withKey, { tracker: "linear", state: "s0", verifier: "v", bindingHash: "b" }, 1)))).message,
    ).toBe("Linear sign-in isn't set up on this deployment. Paste an API key instead.");
    await start("s1");
    const open = (state: string, bindingHash: string, at = 2_000) => backend.run((store) => openTrackerSignIn(store, { tracker: "linear", state, bindingHash }, at));
    const claim = (state: string, bindingHash: string, at = 3_000) => backend.run((store) => claimTrackerSignIn(store, { tracker: "linear", state, bindingHash }, at));
    // A window without the secret, as from a forwarded link, opens nothing, and can't finish it.
    expect(await open("s1", "")).toEqual({ status: "other-browser" });
    expect(await open("s1", "secret-other")).toEqual({ status: "other-browser" });
    expect(await claim("s1", "secret-s1")).toEqual({ status: "other-browser" });
    expect(await open("s1", "secret-s1")).toEqual({ status: "opened", verifier: "v-s1" });
    expect(await open("s1", "secret-s1")).toEqual({ status: "used" });
    expect(await open("unknown", "secret-s1")).toEqual({ status: "expired" });
    expect(await claim("s1", "secret-other")).toEqual({ status: "other-browser" });
    expect(await claim("s1", "secret-s1")).toEqual({ status: "claimed", userId: danaId, verifier: "v-s1" });
    // Used once.
    expect(await claim("s1", "secret-s1")).toEqual({ status: "expired" });
    // Expired before it was opened, or before the person came back.
    await start("s2");
    expect(await open("s2", "secret-s2", 1_000 + SIGN_IN_MINUTES * 60_000)).toEqual({ status: "expired" });
    await start("s3");
    await open("s3", "secret-s3");
    expect(await claim("s3", "secret-s3", 1_000 + SIGN_IN_MINUTES * 60_000 + 1)).toEqual({ status: "expired" });
    expect(await backend.run((store) => tickets(store).signIns.findByState("s3"))).toBeNull();
  });

  test(`${name}: an expired sign-in token is refreshed once at a time, and the rotated tokens are stored encrypted`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const binding = trackerTokenBinding("linear", danaId);
    const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: null, site: null }, { access: "old-access", refresh: "old-refresh", expiresAt: 10_000_000 });
    await backend.run((store) => saveTrackerAccount(store, danaId, sealed, 1_000));
    const accountId = "user-1";
    let clock = 1_000;
    const linear = linearStub([{ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3_600 }]);
    let leases = 0;
    const steps = (fetchFn = linear.fetchFn) => ({
      claim: (leaseId: string) => backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId, leaseId }, clock)),
      finish: (leaseId: string, tokens: Parameters<typeof finishTokenRefresh>[1]["tokens"]) =>
        backend.run((store) => finishTokenRefresh(store, { userId: danaId, tracker: "linear", leaseId, tokens }, clock)),
      sleep: async (ms: number) => void (clock += ms),
      now: () => clock,
      leaseId: () => `lease-${++leases}`,
      fetch: fetchFn,
    });
    const token = () => trackerAccessToken(steps(), withSignIn, { userId: danaId, tracker: "linear", accountId });

    // Well before it expires, the stored token is used as it is.
    expect(await token()).toEqual({ method: "oauth", value: "old-access" });
    expect(linear.sent).toEqual([]);
    // Within the margin, it is refreshed, and the rotated refresh token replaces the old one.
    clock = 10_000_000 - REFRESH_MARGIN_MS + 1;
    expect(await token()).toEqual({ method: "oauth", value: "new-access" });
    expect(Object.fromEntries(new URLSearchParams(linear.sent[0]!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
    const stored = (await backend.run((store) => tickets(store).accounts.find(danaId, "linear")))!;
    expect(await decryptToken(KEY, binding, stored.refresh!)).toBe("new-refresh");
    expect(stored.expiresAt).toBe(clock + 3_600_000);
    expect(stored.refreshLease).toBeUndefined();
    expect(await token()).toEqual({ method: "oauth", value: "new-access" });
    expect(linear.sent).toHaveLength(1);

    // While another refresh holds the lease, a second caller waits for it instead of spending the refresh token again.
    clock = stored.expiresAt!;
    expect(await backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId, leaseId: "other" }, clock))).toMatchObject({ status: "claimed" });
    expect(await backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId, leaseId: "mine" }, clock))).toEqual({ status: "busy" });
    // The other finishes; the waiting caller then gets its fresh token without refreshing.
    const fresher = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: null, site: null }, { access: "other-access", refresh: "other-refresh", expiresAt: clock + 3_600_000 });
    expect(await backend.run((store) => finishTokenRefresh(store, { userId: danaId, tracker: "linear", leaseId: "other", tokens: fresher }, clock))).toEqual({ status: "saved" });
    expect(await token()).toEqual({ method: "oauth", value: "other-access" });
    expect(linear.sent).toHaveLength(1);
    // A lease that was taken over can't store its tokens; it gets the account as it is now.
    expect(await backend.run((store) => finishTokenRefresh(store, { userId: danaId, tracker: "linear", leaseId: "other", tokens: fresher }, clock))).toMatchObject({
      status: "rejected",
      current: { connectedAt: 1_000, method: "oauth", expiresAt: clock + 3_600_000 },
    });
  });

  /**
   * An account whose sign-in token is due, and the steps of reading its token
   * at `clock`, as the Convex action runs them; `during` runs while Linear is
   * answering the refresh, and `claim` may change what the claim says.
   */
  async function dueAccount(backend: ContractBackend, options: { during?: () => Promise<unknown>; claim?: (claim: RefreshClaim) => RefreshClaim; fetch?: typeof fetch } = {}) {
    const { danaId } = await setup(backend);
    const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: null, site: null }, { access: "old-access", refresh: "old-refresh", expiresAt: 1_000 });
    await backend.run((store) => saveTrackerAccount(store, danaId, sealed, 1_000));
    const state = { clock: 2_000 };
    const accountId = "user-1";
    const fetchFn =
      options.fetch ??
      ((async () => {
        await options.during?.();
        return Response.json({ access_token: "my-access", refresh_token: "my-refresh", expires_in: 3_600 });
      }) as unknown as typeof fetch);
    const steps = {
      claim: async (leaseId: string) => {
        const claim = await backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId, leaseId }, state.clock));
        return options.claim ? options.claim(claim) : claim;
      },
      finish: (leaseId: string, tokens: Parameters<typeof finishTokenRefresh>[1]["tokens"]) =>
        backend.run((store) => finishTokenRefresh(store, { userId: danaId, tracker: "linear", leaseId, tokens }, state.clock)),
      sleep: async (ms: number) => void (state.clock += ms),
      now: () => state.clock,
      leaseId: () => "mine",
      fetch: fetchFn,
    };
    return { danaId, state, token: () => trackerAccessToken(steps, withSignIn, { userId: danaId, tracker: "linear", accountId }) };
  }

  test(`${name}: a refresh whose save is refused never returns its own tokens: disconnected, or connected again, meanwhile`, async () => {
    const disconnected = fresh();
    const gone = await dueAccount(disconnected, { during: () => disconnected.run((store) => disconnectTracker(store, dana, { tracker: "linear" })) });
    const refusedGone = await refusal(gone.token());
    expect([refusedGone.code, refusedGone.message]).toEqual(["not-found", "Connect Linear in Your trackers first."]);
    expect(await disconnected.run((store) => tickets(store).accounts.find(gone.danaId, "linear"))).toBeNull();

    const replaced = fresh();
    let replacedId = "";
    const again = await dueAccount(replaced, {
      during: async () => {
        const fresher = await sealSignIn(withSignIn, "linear", replacedId, { accountId: "user-2", accountName: "Dana Other", email: null, site: null }, { access: "reconnected", refresh: "r", expiresAt: 99_000_000 });
        await replaced.run((store) => saveTrackerAccount(store, replacedId, fresher, 3_000));
      },
    });
    replacedId = again.danaId;
    const refusedAgain = await refusal(again.token());
    expect([refusedAgain.code, refusedAgain.message]).toEqual(["not-found", "Your Linear connection changed while Critiqs was using it. Try again."]);
    // The new connection's tokens stand.
    const stored = (await replaced.run((store) => tickets(store).accounts.find(again.danaId, "linear")))!;
    expect(await decryptToken(KEY, trackerTokenBinding("linear", again.danaId), stored.access)).toBe("reconnected");
  });

  test(`${name}: a refresh whose lease another caller took over returns that caller's newer token, or none`, async () => {
    // The other caller refreshed and saved first: its token is the one to use.
    const refreshed = fresh();
    let refreshedId = "";
    const taken = await dueAccount(refreshed, {
      during: async () => {
        taken.state.clock += REFRESH_LEASE_MS;
        const at = taken.state.clock;
        expect(await refreshed.run((store) => claimTokenRefresh(store, { userId: refreshedId, tracker: "linear", accountId: "user-1", leaseId: "other" }, at))).toMatchObject({ status: "claimed" });
        const tokens = await sealSignIn(withSignIn, "linear", refreshedId, { accountId: "user-1", accountName: "Dana", email: null, site: null }, { access: "other-access", refresh: "other-refresh", expiresAt: at + 3_600_000 });
        await refreshed.run((store) => finishTokenRefresh(store, { userId: refreshedId, tracker: "linear", leaseId: "other", tokens }, at));
      },
    });
    refreshedId = taken.danaId;
    expect(await taken.token()).toEqual({ method: "oauth", value: "other-access" });

    // The other caller still holds the lease: nothing newer to return yet.
    const busy = fresh();
    let busyId = "";
    const holding = await dueAccount(busy, {
      during: async () => {
        holding.state.clock += REFRESH_LEASE_MS;
        await busy.run((store) => claimTokenRefresh(store, { userId: busyId, tracker: "linear", accountId: "user-1", leaseId: "other" }, holding.state.clock));
      },
    });
    busyId = holding.danaId;
    const refusedBusy = await refusal(holding.token());
    expect([refusedBusy.code, refusedBusy.message]).toEqual(["unavailable", "Critiqs couldn't refresh your Linear sign-in. Try again in a moment."]);
  });

  test(`${name}: a token request still running near the lease's end is abandoned, and the lease released`, async () => {
    const backend = fresh();
    let signal: AbortSignal | undefined;
    const due = await dueAccount(backend, {
      // The lease has only a moment left beyond the time saving takes.
      claim: (claim) => (claim.status === "claimed" ? { ...claim, until: due.state.clock + REFRESH_SAVE_MS + 30 } : claim),
      // Linear never answers, until the request is called off.
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal!.reason));
        })) as unknown as typeof fetch,
    });
    const started = performance.now();
    const refused = await refusal(due.token());
    expect([refused.code, refused.message]).toEqual(["unavailable", "Linear took too long to refresh your sign-in. Try again in a moment."]);
    expect(signal?.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect((await backend.run((store) => tickets(store).accounts.find(due.danaId, "linear")))!.refreshLease).toBeUndefined();
  });

  test(`${name}: a refresh never starts at or past its lease's cutoff: Linear isn't asked, and the lease is released`, async () => {
    for (const left of [REFRESH_SAVE_MS, REFRESH_SAVE_MS - 1]) {
      const backend = fresh();
      let sent = 0;
      const due = await dueAccount(backend, {
        // The lease ends `left` from now: at the cutoff, then just past it.
        claim: (claim) => (claim.status === "claimed" ? { ...claim, until: due.state.clock + left } : claim),
        fetch: (async () => {
          sent += 1;
          return Response.json({ access_token: "my-access", refresh_token: "my-refresh", expires_in: 3_600 });
        }) as unknown as typeof fetch,
      });
      const refused = await refusal(due.token());
      expect([refused.code, refused.message]).toEqual(["unavailable", "Critiqs couldn't refresh your Linear sign-in. Try again in a moment."]);
      expect(sent).toBe(0);
      const stored = (await backend.run((store) => tickets(store).accounts.find(due.danaId, "linear")))!;
      expect(stored.refreshLease).toBeUndefined();
      expect(await decryptToken(KEY, trackerTokenBinding("linear", due.danaId), stored.refresh!)).toBe("old-refresh");
    }
  });

  test(`${name}: a token is read only for the tracker account the caller checked; another account connected since is refused`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    await connect(backend, dana, "lin_api_first");
    const checked = (await backend.run((store) => tickets(store).accounts.find(danaId, "linear")))!.accountId;
    const steps = {
      claim: (leaseId: string) => backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId: checked, leaseId }, 10)),
      finish: (leaseId: string, tokens: null) => backend.run((store) => finishTokenRefresh(store, { userId: danaId, tracker: "linear", leaseId, tokens }, 10)),
      sleep: async () => {},
      now: () => 10,
      leaseId: () => "lease",
    };
    expect(await trackerAccessToken(steps, withKey, { userId: danaId, tracker: "linear", accountId: checked })).toEqual({ method: "token", value: "lin_api_first" });
    // Dana connects another Linear account with the same Critiqs account.
    const other = await sealSignIn(withSignIn, "linear", danaId, { accountId: "another-linear-account", accountName: "Dana Other", email: null, site: null }, { access: "other-access", refresh: null, expiresAt: null });
    await backend.run((store) => saveTrackerAccount(store, danaId, other, 2_000));
    expect(await backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId: checked, leaseId: "lease" }, 10))).toEqual({ status: "changed" });
    const refused = await refusal(trackerAccessToken(steps, withKey, { userId: danaId, tracker: "linear", accountId: checked }));
    expect([refused.code, refused.message]).toEqual(["unavailable", "Your Linear connection changed. Try again."]);
  });

  test(`${name}: a refused refresh releases the lease and says to connect again; a pasted token never expires`, async () => {
    const backend = fresh();
    const { danaId } = await setup(backend);
    const sealed = await sealSignIn(withSignIn, "linear", danaId, { accountId: "user-1", accountName: "Dana", email: null, site: null }, { access: "old", refresh: "spent", expiresAt: 1 });
    await backend.run((store) => saveTrackerAccount(store, danaId, sealed, 1));
    let accountId = "user-1";
    const steps = {
      claim: (leaseId: string) => backend.run((store) => claimTokenRefresh(store, { userId: danaId, tracker: "linear", accountId, leaseId }, 10)),
      finish: (leaseId: string, tokens: null) => backend.run((store) => finishTokenRefresh(store, { userId: danaId, tracker: "linear", leaseId, tokens }, 10)),
      sleep: async () => {},
      now: () => 10,
      leaseId: () => "lease",
      fetch: linearStub([]).fetchFn,
    };
    const refused = await refusal(trackerAccessToken(steps, withSignIn, { userId: danaId, tracker: "linear", accountId }));
    expect(refused.message).toBe("Your Linear sign-in has ended. Connect Linear again in Your trackers.");
    expect((await backend.run((store) => tickets(store).accounts.find(danaId, "linear")))!.refreshLease).toBeUndefined();

    await connect(backend, dana, "lin_api_good");
    accountId = (await backend.run((store) => tickets(store).accounts.find(danaId, "linear")))!.accountId;
    expect(await trackerAccessToken(steps, withKey, { userId: danaId, tracker: "linear", accountId })).toEqual({ method: "token", value: "lin_api_good" });
    await backend.run((store) => disconnectTracker(store, dana, { tracker: "linear" }));
    expect((await refusal(trackerAccessToken(steps, withKey, { userId: danaId, tracker: "linear", accountId }))).message).toBe("Connect Linear in Your trackers first.");
  });
}
