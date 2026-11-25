import { type Client, exportAll, list, mine, thread as getThread } from "./pages";
import type { Id } from "../convex/_generated/dataModel";
import { expect, test } from "bun:test";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";

const failedCapture = { status: "failed" as const, failureReason: "Canvas was tainted by a cross-origin image" };

async function projectWithThread() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype" });
  const threadId = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Department is wrong",
    tags: ["Bug"],
    capture: failedCapture,
  });
  return { t, dana, lee, projectId, threadId };
}

async function unreadFor(client: Client, projectId: Parameters<typeof list>[1]["projectId"]) {
  const threads = await list(client, { projectId });
  return threads[0]!.unread as boolean;
}

test("signed-out reviewers cannot read feedback", async () => {
  const { t, projectId } = await projectWithThread();
  await expect(list(t, { projectId })).rejects.toThrow("Sign in");
});

test("any signed-in reviewer with the project ID can take part", async () => {
  const { t, projectId, threadId } = await projectWithThread();
  const newcomer = t.withIdentity(reviewer("Riley"));
  expect(await list(newcomer, { projectId })).toHaveLength(1);
  await newcomer.mutation(api.threads.reply, { threadId, body: "Agreed", revision: null });
  expect((await getThread(newcomer, { threadId })).messages).toHaveLength(2);
});

test("project setup lists only the projects a reviewer created", async () => {
  const { t, dana } = await projectWithThread();
  expect((await mine(dana)).map((project) => project.name)).toEqual(["Admin prototype"]);
  expect(await mine(t.withIdentity(reviewer("Riley")))).toEqual([]);
});

test("unverified email addresses are rejected", async () => {
  const t = setup();
  const unverified = t.withIdentity({ ...reviewer("Una"), email_verified: false });
  await expect(unverified.mutation(api.projects.create, { name: "X" })).rejects.toThrow("Verify");
});

test("a failed capture still saves the comment, and a screenshot can be supplied", async () => {
  const { t, dana, threadId } = await projectWithThread();
  const thread = await getThread(dana, { threadId });
  expect(thread.capture).toEqual(failedCapture);
  expect(thread.messages[0]?.body).toBe("Department is wrong");
  expect(thread.messages[0]?.revision).toBe("abc123");

  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
  await dana.mutation(api.threads.attachScreenshot, { threadId, storageId });
  const updated = await getThread(dana, { threadId });
  expect(updated.capture).toEqual({ status: "supplied", failureReason: failedCapture.failureReason });
});

test("read state is personal and replies make a thread unread until viewed", async () => {
  const { dana, lee, projectId, threadId } = await projectWithThread();
  expect(await unreadFor(dana, projectId)).toBe(false);
  expect(await unreadFor(lee, projectId)).toBe(true);

  const thread = await getThread(lee, { threadId });
  await lee.mutation(api.threads.markRead, { threadId, seenThrough: thread.lastMessageAt });
  expect(await unreadFor(lee, projectId)).toBe(false);

  await dana.mutation(api.threads.reply, { threadId, body: "Also the label", revision: "abc124" });
  expect(await unreadFor(lee, projectId)).toBe(true);
  expect(await unreadFor(dana, projectId)).toBe(false);

  // Marking read through an older message leaves the unseen reply unread.
  await lee.mutation(api.threads.markRead, { threadId, seenThrough: thread.lastMessageAt });
  expect(await unreadFor(lee, projectId)).toBe(true);
});

test("Mark unread is personal and cleared by viewing", async () => {
  const { dana, lee, projectId, threadId } = await projectWithThread();
  await dana.mutation(api.threads.markUnread, { threadId });
  expect(await unreadFor(dana, projectId)).toBe(true);
  expect(await unreadFor(lee, projectId)).toBe(true);
  const thread = await getThread(dana, { threadId });
  await dana.mutation(api.threads.markRead, { threadId, seenThrough: thread.lastMessageAt });
  expect(await unreadFor(dana, projectId)).toBe(false);
});

test("edits and reactions do not make a thread unread", async () => {
  const { dana, lee, projectId, threadId } = await projectWithThread();
  const thread = await getThread(lee, { threadId });
  await lee.mutation(api.threads.markRead, { threadId, seenThrough: thread.lastMessageAt });
  const messageId = thread.messages[0]!._id as Id<"messages">;
  await dana.mutation(api.threads.editMessage, { messageId, body: "Department label is wrong" });
  await dana.mutation(api.threads.toggleReaction, { messageId, emoji: "👍" });
  expect(await unreadFor(lee, projectId)).toBe(false);
});

test("only the author can edit a message", async () => {
  const { dana, lee, threadId } = await projectWithThread();
  const thread = await getThread(dana, { threadId });
  const messageId = thread.messages[0]!._id as Id<"messages">;
  await expect(lee.mutation(api.threads.editMessage, { messageId, body: "Hijacked" })).rejects.toThrow(
    "only edit your own",
  );
  await dana.mutation(api.threads.editMessage, { messageId, body: "Department label is wrong" });
  const edited = await getThread(lee, { threadId });
  expect(edited.messages[0]?.body).toBe("Department label is wrong");
  expect(edited.messages[0]?.editedAt).not.toBeNull();
  expect(edited.messages[0]?.isMine).toBe(false);
});

test("anyone with access can resolve, reopen, and delete; deleted threads are unavailable", async () => {
  const { dana, lee, projectId, threadId } = await projectWithThread();
  await lee.mutation(api.threads.setStatus, { threadId, status: "resolved" });
  expect((await getThread(dana, { threadId })).status).toBe("resolved");
  await dana.mutation(api.threads.setStatus, { threadId, status: "open" });

  await lee.mutation(api.threads.remove, { threadId });
  await expect(getThread(dana, { threadId })).rejects.toThrow("deleted");
  expect(await list(dana, { projectId })).toEqual([]);
  await expect(dana.mutation(api.threads.setStatus, { threadId, status: "open" })).rejects.toThrow("deleted");
});

test("reactions toggle per reviewer", async () => {
  const { dana, lee, threadId } = await projectWithThread();
  const messageId = (await getThread(dana, { threadId })).messages[0]!._id as Id<"messages">;
  await dana.mutation(api.threads.toggleReaction, { messageId, emoji: "👍" });
  await lee.mutation(api.threads.toggleReaction, { messageId, emoji: "👍" });
  await lee.mutation(api.threads.toggleReaction, { messageId, emoji: "👍" });
  const [message] = (await getThread(dana, { threadId })).messages;
  expect(message?.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
});

test("tags may be presets or free tags, in a tag's format", async () => {
  const { dana, threadId } = await projectWithThread();
  await expect(dana.mutation(api.threads.setTags, { threadId, tags: [""] })).rejects.toThrow("isn't a tag");
  await dana.mutation(api.threads.setTags, { threadId, tags: ["Bug", "User feedback", "Onboarding"] });
  expect((await getThread(dana, { threadId })).tags).toEqual(["Bug", "User feedback", "Onboarding"]);
});

test("record-specific feedback must name its record", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype" });
  const noRecord = { ...anchor, target: { ...anchor.target, recordKey: null } };
  await expect(
    dana.mutation(api.threads.create, { projectId, anchor: noRecord, body: "x", tags: [], capture: failedCapture }),
  ).rejects.toThrow("needs a record");
});

test("reattaching keeps the original anchor and evidence", async () => {
  const { dana, lee, threadId } = await projectWithThread();
  const replacement = {
    screen: "user-details",
    viewState: { tab: "profile" },
    target: { ...anchor.target, purposeId: "user.team" },
    scope: "record" as const,
  };
  await lee.mutation(api.threads.reattach, { threadId, location: replacement });
  const thread = await getThread(dana, { threadId });
  expect(thread.anchor).toEqual(anchor);
  expect(thread.reattachment?.location).toEqual(replacement);
  expect(thread.reattachedByName).toBe("Lee");
  expect(thread.status).toBe("open");
});

test("the thread view reports who resolved it and the reviewer's own read state", async () => {
  const { dana, lee, threadId } = await projectWithThread();
  await lee.mutation(api.threads.setStatus, { threadId, status: "resolved" });
  const forDana = await getThread(dana, { threadId });
  expect(forDana.statusChangedByName).toBe("Lee");
  expect(forDana.readState?.lastReadAt).toBe(forDana.lastMessageAt);
  expect((await getThread(lee, { threadId })).readState).toBeNull();
});

test("export includes selected threads with whole discussions, skipping deleted ones", async () => {
  const { dana, lee, projectId, threadId } = await projectWithThread();
  await lee.mutation(api.threads.reply, { threadId, body: "On it", revision: "abc124" });
  const second = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Remove me",
    tags: [],
    capture: failedCapture,
  });
  await dana.mutation(api.threads.remove, { threadId: second });
  const exported = await exportAll(dana, { projectId, threadIds: [threadId, second] });
  expect(exported.projectName).toBe("Admin prototype");
  expect(exported.threads).toHaveLength(1);
  expect(exported.threads[0]?.messages.map((message) => [message.author, message.body])).toEqual([
    ["Dana", "Department is wrong"],
    ["Lee", "On it"],
  ]);
});

test("replying does not mark someone else's unseen reply read", async () => {
  const { dana, lee, projectId, threadId } = await projectWithThread();
  const thread = await getThread(lee, { threadId });
  await lee.mutation(api.threads.markRead, { threadId, seenThrough: thread.lastMessageAt });
  await dana.mutation(api.threads.reply, { threadId, body: "Also the label", revision: null });
  // Lee replies without having seen Dana's reply.
  await lee.mutation(api.threads.reply, { threadId, body: "Agreed", revision: null });
  expect(await unreadFor(lee, projectId)).toBe(true);
  // Dana had seen everything, so her own next reply keeps her caught up.
  const latest = await getThread(dana, { threadId });
  await dana.mutation(api.threads.markRead, { threadId, seenThrough: latest.lastMessageAt });
  await dana.mutation(api.threads.reply, { threadId, body: "Thanks", revision: null });
  expect(await unreadFor(dana, projectId)).toBe(false);
});

test("only the offered reactions are accepted", async () => {
  const { dana, threadId } = await projectWithThread();
  const messageId = (await getThread(dana, { threadId })).messages[0]!._id as Id<"messages">;
  await expect(dana.mutation(api.threads.toggleReaction, { messageId, emoji: "abcdefgh" })).rejects.toThrow("offered");
});

test("duplicate tags are stored once", async () => {
  const { dana, threadId } = await projectWithThread();
  await dana.mutation(api.threads.setTags, { threadId, tags: ["Bug", "Bug"] });
  expect((await getThread(dana, { threadId })).tags).toEqual(["Bug"]);
});

test("a reviewer without a name is never shown by their email address", async () => {
  const { t, threadId } = await projectWithThread();
  const { name: _name, ...unnamed } = reviewer("Quinn");
  const quinn = t.withIdentity(unnamed);
  await quinn.mutation(api.threads.reply, { threadId, body: "Looks good", revision: null });
  const authors = (await getThread(quinn, { threadId })).messages.map((message) => message.author.name);
  expect(authors).toEqual(["Dana", "Reviewer"]);
  expect(JSON.stringify(await getThread(quinn, { threadId }))).not.toContain("quinn@example.com");
});

test("a token from before a rename authorizes the reviewer but cannot put back their old name", async () => {
  const { t, threadId } = await projectWithThread();
  const renamed = t.withIdentity({ ...reviewer("Dana"), name: "Dana Kim", profile_version: 2 });
  await renamed.mutation(api.users.sync, {});
  const stale = t.withIdentity({ ...reviewer("Dana"), name: "Dana", profile_version: 1 });
  await stale.mutation(api.threads.reply, { threadId, body: "Still me", revision: null });
  const authors = (await getThread(stale, { threadId })).messages.map((message) => message.author.name);
  expect(authors).toEqual(["Dana Kim", "Dana Kim"]);
  expect(await stale.mutation(api.users.sync, {})).toBe("Dana Kim");
});

test("backend pages carry only the declared fields", async () => {
  const { dana, projectId } = await projectWithThread();
  const page = await dana.query(api.threads.list, { projectId, paginationOpts: { numItems: 40, cursor: null } });
  expect(Object.keys(page).sort()).toEqual(["continueCursor", "isDone", "page"]);
  const mine = await dana.query(api.projects.listMine, { paginationOpts: { numItems: 40, cursor: null } });
  expect(Object.keys(mine).sort()).toEqual(["continueCursor", "isDone", "page"]);
});

test("a token from before profile versions cannot put back an older name", async () => {
  const { t, threadId } = await projectWithThread();
  await t.withIdentity({ ...reviewer("Dana"), name: "Dana Kim", profile_version: 2 }).mutation(api.users.sync, {});
  const legacy = t.withIdentity({ ...reviewer("Dana"), name: "Dana" });
  await legacy.mutation(api.threads.reply, { threadId, body: "From an old tab", revision: null });
  const authors = (await getThread(legacy, { threadId })).messages.map((message) => message.author.name);
  expect(authors).toEqual(["Dana Kim", "Dana Kim"]);
});
