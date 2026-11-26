import { afterEach, expect, setSystemTime, test } from "bun:test";
import { type Anchor, type ProjectUsage, REACTIONS } from "@critiqs/core";
import { reserveCredits, settleCredits } from "../src/ai/credits.ts";
import { DEFAULT_PLANS, type Limit, type Plan, usageKey, utcDay } from "../src/limits.ts";
import type { CaptureInput } from "../src/operations.ts";
import { MAX_EMAIL_BYTES } from "../src/mention-email.ts";
import * as notify from "../src/notify.ts";
import * as ops from "../src/operations.ts";
import * as organizations from "../src/organizations.ts";
import { reportConnected } from "../src/onboarding.ts";
import { claimPlanAlerts, completePlanAlerts, planAlertEmails, sendPlanAlert } from "../src/plan-alerts.ts";
import { MailError, type Mailer, type MailMessage, preparedMessage, resendMailer } from "../src/signin.ts";
import type { Identity, Store } from "../src/store.ts";

/**
 * One backend under test: it runs an operation in its own transaction and can
 * store an uploaded file, as its real upload path would.
 */
export interface ContractBackend {
  run<T>(operation: (store: Store) => Promise<T>): Promise<T>;
  saveFile(contentType: string | null, bytes?: number): Promise<string>;
  /** Stores a file's content, as a worker stores a prepared email. */
  storeFile(data: Blob): Promise<string>;
  readFile(fileId: string): Promise<Blob | null>;
  /** False when the test harness drops uploads' content types, as convex-test does; real Convex keeps them. */
  recordsContentType?: boolean;
  /** The same kind of backend with Critiqs Cloud's plans turned on, using these plans. */
  withPlans(plans: Record<string, Plan>): ContractBackend;
  /** Replaces this backend's plans, as an operator edits them, keeping its data. */
  changePlans(plans: Record<string, Plan>): Promise<void>;
}

export function reviewer(name: string, profileVersion: number | null = null): Identity {
  const key = name.toLowerCase();
  return {
    tokenIdentifier: `https://auth.example|${key}`,
    name,
    email: `${key}@example.com`,
    emailVerified: true,
    pictureUrl: null,
    profileVersion,
  };
}

export const anchor: Anchor = {
  screen: "user-details",
  viewState: { tab: "profile" },
  target: {
    purposeId: "user-details.department",
    recordKey: "user:alex",
    clues: { tagName: "span", role: null, label: "Department", path: "main:1/span:2" },
  },
  scope: "record",
  evidence: {
    url: "https://proto.example/users/alex",
    viewport: { width: 1280, height: 800 },
    marker: null,
    capturedAt: 1,
    revision: "v1",
    persona: null,
    userAgent: null,
  },
};

const page = { numItems: 40, cursor: null };
const failed = { status: "failed" as const, failureReason: "Blocked" };

/** A copy of a project with a name longer than today's limit, as one created before it was set. */
async function insertNamed(backend: ContractBackend, like: string, name: string): Promise<string> {
  const project = (await backend.run((store) => store.projects.get(like)))!;
  const { tags, createdBy, createdAt, organizationId, reviewUrl } = project;
  return await backend.run((store) =>
    store.projects.insert({ name, tags, createdBy, createdAt, ...(organizationId === undefined ? {} : { organizationId }), ...(reviewUrl === undefined ? {} : { reviewUrl }) }),
  );
}

/**
 * The behavior every Critiqs backend must share. Each backend's tests call this
 * with a fresh, empty backend per test.
 */
export function defineContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");

  afterEach(() => setSystemTime());

  async function projectWithThread(backend: ContractBackend) {
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Department is wrong", tags: ["Bug"], capture: failed }),
    );
    return { projectId, threadId };
  }

  async function allMessages(backend: ContractBackend, who: Identity, threadId: string) {
    const messages = [];
    let cursor: string | null = null;
    for (;;) {
      const result = await backend.run((store) => ops.getThread(store, who, { threadId }, { numItems: 40, cursor }));
      messages.push(...result.page);
      if (result.isDone) return messages;
      expect(result.continueCursor).not.toBe(cursor);
      cursor = result.continueCursor;
    }
  }

  test(`${name}: a new thread starts read for its author and unread for others`, async () => {
    const backend = fresh();
    const { projectId } = await projectWithThread(backend);
    const forDana = await backend.run((store) => ops.listThreads(store, dana, { projectId }, page));
    const forLee = await backend.run((store) => ops.listThreads(store, lee, { projectId }, page));
    expect(forDana.page.map((thread) => thread.unread)).toEqual([false]);
    expect(forLee.page.map((thread) => thread.unread)).toEqual([true]);
    expect(forLee.page[0]!.preview).toEqual({ body: "Department is wrong", authorName: "Dana", authorImageUrl: null });
  });

  test(`${name}: a reply advances the thread, keeps a caught-up author read, and is strictly later`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    const before = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Also the label", revision: "v2" }));
    const after = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(after.messageCount).toBe(2);
    expect(after.page[1]!.createdAt).toBeGreaterThan(before.lastMessageAt);
    expect(after.lastMessageAt).toBe(after.page[1]!.createdAt);
    expect(after.page[1]).toMatchObject({ body: "Also the label", revision: "v2", isMine: true });
    const forDana = await backend.run((store) => ops.listThreads(store, dana, { projectId }, page));
    expect(forDana.page[0]!.unread).toBe(false);
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed", revision: null }));
    const again = await backend.run((store) => ops.listThreads(store, dana, { projectId }, page));
    expect(again.page[0]!.unread).toBe(true);
  });

  test(`${name}: an operation that fails part-way writes nothing`, async () => {
    const backend = fresh();
    await expect(
      backend.run(async (store) => {
        await ops.createProject(store, dana, { name: "Never kept" });
        throw new Error("Interrupted");
      }),
    ).rejects.toThrow("Interrupted");
    const mine = await backend.run((store) => ops.listMyProjects(store, dana, page));
    expect(mine.page).toEqual([]);
  });

  test(`${name}: pages cover a long discussion in order, without repeats`, async () => {
    const backend = fresh();
    const { threadId } = await projectWithThread(backend);
    for (let i = 0; i < 44; i++) {
      await backend.run((store) => ops.reply(store, i % 2 === 0 ? lee : dana, { threadId, body: `Reply ${i}`, revision: null }));
    }
    const messages = await allMessages(backend, dana, threadId);
    expect(messages.map((message) => message.body)).toEqual([
      "Department is wrong",
      ...Array.from({ length: 44 }, (_, i) => `Reply ${i}`),
    ]);
    expect(new Set(messages.map((message) => message._id)).size).toBe(45);
  });

  test(`${name}: page sizes are bounded`, async () => {
    const backend = fresh();
    const { projectId } = await projectWithThread(backend);
    await expect(
      backend.run((store) => ops.listThreads(store, dana, { projectId }, { numItems: 41, cursor: null })),
    ).rejects.toThrow("between 1 and 40");
  });

  test(`${name}: reactions toggle per reviewer`, async () => {
    const backend = fresh();
    const { threadId } = await projectWithThread(backend);
    const [first] = await allMessages(backend, dana, threadId);
    const messageId = first!._id;
    await backend.run((store) => ops.toggleReaction(store, dana, { messageId, emoji: "👍" }));
    await backend.run((store) => ops.toggleReaction(store, lee, { messageId, emoji: "👍" }));
    await backend.run((store) => ops.toggleReaction(store, lee, { messageId, emoji: "👍" }));
    const rows = await backend.run((store) => ops.listReactions(store, dana, { threadId }, page));
    expect(rows.page).toEqual([{ messageId, emoji: "👍", mine: true }]);
    await expect(backend.run((store) => ops.toggleReaction(store, dana, { messageId, emoji: "🦄" }))).rejects.toThrow("offered");
  });

  test(`${name}: only the author can edit a message, and edits keep the thread read`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    const [first] = await allMessages(backend, dana, threadId);
    await expect(
      backend.run((store) => ops.editMessage(store, lee, { messageId: first!._id, body: "Hijacked" })),
    ).rejects.toThrow("only edit your own");
    await backend.run((store) => ops.markRead(store, lee, { threadId, seenThrough: first!.createdAt }));
    await backend.run((store) => ops.editMessage(store, dana, { messageId: first!._id, body: "Department label is wrong" }));
    const [edited] = await allMessages(backend, lee, threadId);
    expect(edited).toMatchObject({ body: "Department label is wrong" });
    expect(edited!.editedAt).not.toBeNull();
    const forLee = await backend.run((store) => ops.listThreads(store, lee, { projectId }, page));
    expect(forLee.page[0]!.unread).toBe(false);
  });

  test(`${name}: read state is personal, and Mark unread holds until the thread is read again`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    const thread = await backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    await backend.run((store) => ops.markRead(store, lee, { threadId, seenThrough: thread.lastMessageAt }));
    await backend.run((store) => ops.markUnread(store, dana, { threadId }));
    const unread = async (who: Identity) =>
      (await backend.run((store) => ops.listThreads(store, who, { projectId }, page))).page[0]!.unread;
    expect(await unread(lee)).toBe(false);
    expect(await unread(dana)).toBe(true);
    await backend.run((store) => ops.markRead(store, dana, { threadId, seenThrough: thread.lastMessageAt }));
    expect(await unread(dana)).toBe(false);
  });

  test(`${name}: a deleted thread leaves the list and export, and reports unavailable`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.removeThread(store, dana, { threadId }));
    const listed = await backend.run((store) => ops.listThreads(store, dana, { projectId }, page));
    expect(listed.page).toEqual([]);
    await expect(backend.run((store) => ops.getThread(store, dana, { threadId }, page))).rejects.toThrow("deleted");
    const exported = await backend.run((store) =>
      ops.exportThreads(store, dana, { projectId, threadIds: [threadId], threadIndex: 0 }, page),
    );
    expect(exported.thread).toBeNull();
  });

  test(`${name}: status, tags, and reattachment are shared, and record who changed them`, async () => {
    const backend = fresh();
    const { threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.setStatus(store, lee, { threadId, status: "resolved" }));
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["UX copy change", "UX copy change"] }));
    const location = { ...anchor, target: { ...anchor.target, purposeId: "user-details.team" } };
    const { evidence: _evidence, ...replacement } = location;
    await backend.run((store) => ops.reattach(store, lee, { threadId, location: replacement }));
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread).toMatchObject({ status: "resolved", statusChangedByName: "Lee", tags: ["UX copy change"], reattachedByName: "Lee" });
    expect(thread.reattachment?.location.target.purposeId).toBe("user-details.team");
    expect(thread.anchor.target.purposeId).toBe("user-details.department");
    // Free tags are allowed alongside presets; only a tag's format is checked.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["UX copy change", "Onboarding"] }));
    expect((await backend.run((store) => ops.getThread(store, dana, { threadId }, page))).tags).toEqual(["UX copy change", "Onboarding"]);
    await expect(backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["x".repeat(51)] }))).rejects.toThrow("isn't a tag");
  });

  test(`${name}: images must be fresh image uploads that no thread uses yet`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const create = (fileId: string) =>
      backend.run((store) =>
        ops.createThread(store, dana, { projectId, anchor, body: "Look", tags: [], capture: { status: "captured", fileId } }),
      );
    if (backend.recordsContentType !== false) {
      const text = await backend.saveFile("text/plain");
      await expect(create(text)).rejects.toThrow("must be PNG, JPEG, WebP, or GIF images");
      // SVG can carry scripts, so it is never accepted as a capture.
      const svg = await backend.saveFile("image/svg+xml");
      await expect(create(svg)).rejects.toThrow("must be PNG, JPEG, WebP, or GIF images");
    }
    const image = await backend.saveFile("image/png");
    const threadId = await create(image);
    await expect(create(image)).rejects.toThrow("already belongs");
    expect(await backend.run((store) => ops.authorizedCapture(store, lee, { threadId }))).toBe(image);
    await expect(create("not-a-file")).rejects.toThrow("not found");
  });

  test(`${name}: a supplied screenshot replaces only a failed capture`, async () => {
    const backend = fresh();
    const { threadId } = await projectWithThread(backend);
    const screenshot = await backend.saveFile("image/png");
    await backend.run((store) => ops.attachScreenshot(store, lee, { threadId, fileId: screenshot }));
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread.capture).toEqual({ status: "supplied", failureReason: "Blocked" });
    const another = await backend.saveFile("image/png");
    await expect(backend.run((store) => ops.attachScreenshot(store, lee, { threadId, fileId: another }))).rejects.toThrow(
      "already has an image",
    );
  });

  test(`${name}: export pages carry every message of each selected thread`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed", revision: null }));
    const exported = await backend.run((store) =>
      ops.exportThreads(store, dana, { projectId, threadIds: [threadId, threadId], threadIndex: 0 }, page),
    );
    expect(exported.projectName).toBe("Admin prototype");
    expect(exported.page.map((message) => [message.author, message.body])).toEqual([
      ["Dana", "Department is wrong"],
      ["Lee", "Agreed"],
    ]);
    await expect(
      backend.run((store) => ops.exportThreads(store, dana, { projectId, threadIds: [threadId], threadIndex: 1 }, page)),
    ).rejects.toThrow("Invalid export page");
  });

  test(`${name}: messages name their author by a permanent ID that a rename or a shared name doesn't change`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    // Another reviewer who is also called Dana.
    const otherDana = { ...reviewer("Dana"), tokenIdentifier: "https://auth.example|dana-two", email: "dana.two@example.com" };
    await backend.run((store) => ops.reply(store, otherDana, { threadId, body: "Same name, different person", revision: null }));
    const danaId = await backend.run(async (store) => (await store.users.byToken(dana.tokenIdentifier))!._id);
    const otherId = await backend.run(async (store) => (await store.users.byToken(otherDana.tokenIdentifier))!._id);
    expect(danaId).not.toBe(otherId);
    const exported = await backend.run((store) =>
      ops.exportThreads(store, lee, { projectId, threadIds: [threadId], threadIndex: 0 }, page),
    );
    expect(exported.page.map((message) => [message.author, message.authorId])).toEqual([
      ["Dana", danaId],
      ["Dana", otherId],
    ]);
    const viewed = await allMessages(backend, lee, threadId);
    expect(viewed.map((message) => message.authorId)).toEqual([danaId, otherId]);
  });

  test(`${name}: signed-out, unverified, and unknown requests are refused`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    await expect(backend.run((store) => ops.listThreads(store, null, { projectId }, page))).rejects.toThrow("Sign in");
    const unverified = { ...lee, emailVerified: false };
    await expect(backend.run((store) => ops.listThreads(store, unverified, { projectId }, page))).rejects.toThrow("Verify");
    await expect(backend.run((store) => ops.getThread(store, dana, { threadId: "nonsense" }, page))).rejects.toThrow("does not exist");
    await expect(backend.run((store) => ops.getProject(store, dana, { projectId: threadId }))).rejects.toThrow("does not exist");
  });

  test(`${name}: discussions and previews follow message time, then the order messages were written`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    const [first] = await allMessages(backend, dana, threadId);
    const user = await backend.run(async (store) => (await store.users.byToken(dana.tokenIdentifier))!._id);
    // Written later but timed earlier, as an import or a clock correction could do.
    await backend.run(async (store) => {
      for (const [body, createdAt] of [["Earliest", first!.createdAt - 2], ["Tied A", first!.createdAt - 1], ["Tied B", first!.createdAt - 1]] as const) {
        await store.messages.insert({ threadId, authorId: user, body, createdAt, editedAt: null, revision: null });
      }
    });
    const pages = [];
    let cursor: string | null = null;
    for (;;) {
      const result = await backend.run((store) => ops.getThread(store, dana, { threadId }, { numItems: 1, cursor }));
      pages.push(...result.page.map((message) => message.body));
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(pages).toEqual(["Earliest", "Tied A", "Tied B", "Department is wrong"]);
    const listed = await backend.run((store) => ops.listThreads(store, dana, { projectId }, page));
    expect(listed.page[0]!.preview?.body).toBe("Earliest");
  });

  test(`${name}: project names are limited to 200 characters, counted after trimming`, async () => {
    const backend = fresh();
    const create = (projectName: string) => backend.run((store) => ops.createProject(store, dana, { name: projectName }));
    await expect(create("P".repeat(201))).rejects.toThrow("A project's name can have at most 200 characters.");
    // Characters outside the Basic Multilingual Plane count twice, as a browser's maxlength counts them.
    await expect(create("😀".repeat(101))).rejects.toThrow("at most 200 characters");
    await expect(create("P".repeat(900_000))).rejects.toThrow("at most 200 characters");
    const fits = await create(`  ${"P".repeat(200)}  `);
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId: fits }))).name).toBe("P".repeat(200));
    const listed = await backend.run((store) => ops.listMyProjects(store, dana, page));
    expect(listed.page.map((project) => project.name)).toEqual(["P".repeat(200)]);
  });

  test(`${name}: a new home organization's name fits an organization's 80 characters, however long the person's name`, async () => {
    const backend = fresh();
    const host = reviewer("H".repeat(300));
    await backend.run((store) => ops.createProject(store, host, { name: "Prototype" }));
    const [home] = await backend.run((store) => organizations.listMyOrganizations(store, host));
    expect(home!.name.length).toBeLessThanOrEqual(organizations.MAX_ORGANIZATION_NAME);
    expect(home!.name).toMatch(/^H+…'s organization$/);
    await backend.run((store) => ops.createProject(store, dana, { name: "Prototype" }));
    expect((await backend.run((store) => organizations.listMyOrganizations(store, dana)))[0]!.name).toBe("Dana's organization");
  });

  test(`${name}: a project named before the limit keeps working with its whole name`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const longName = "P".repeat(5_000);
    const olderId = await insertNamed(backend, projectId, longName);
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId: olderId }))).name).toBe(longName);
    await backend.run((store) => ops.createThread(store, lee, { projectId: olderId, anchor, body: "Still works", tags: [], capture: failed }));
  });

  test(`${name}: names, revisions, and failure reasons are kept as given`, async () => {
    const backend = fresh();
    const longName = "P".repeat(200);
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: longName }));
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).name).toBe(longName);
    const reason = "R".repeat(501);
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Look", tags: [], capture: { status: "failed", failureReason: reason } }),
    );
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Again", revision: "v".repeat(201) }));
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread.capture).toEqual({ status: "failed", failureReason: reason });
    expect(thread.page[1]!.revision).toBe("v".repeat(201));
  });

  test(`${name}: a thread can start with a screenshot supplied after capture failed`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const fileId = await backend.saveFile("image/png");
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, {
        projectId,
        anchor,
        body: "See attached",
        tags: [],
        capture: { status: "supplied", fileId, failureReason: "Canvas blocked" },
      }),
    );
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread.capture).toEqual({ status: "supplied", failureReason: "Canvas blocked" });
  });

  test(`${name}: an update leaves fields given as undefined unchanged`, async () => {
    const backend = fresh();
    await backend.run((store) => ops.syncReviewer(store, { ...dana, profileVersion: 2 }));
    const user = await backend.run(async (store) => {
      const record = (await store.users.byToken(dana.tokenIdentifier))!;
      await store.users.patch(record._id, { name: "Dana", profileVersion: undefined });
      return (await store.users.get(record._id))!;
    });
    expect(user.profileVersion).toBe(2);
  });

  // Mentions and notifications

  async function idOf(backend: ContractBackend, who: Identity) {
    return await backend.run(async (store) => (await store.users.byToken(who.tokenIdentifier))!._id);
  }

  const mention = (userId: string, label: string) => ({ userId, label });
  const far = () => Date.now() + 365 * 24 * 60 * 60_000;
  const links = { preferenceUrl: async (scope: { userId: string; projectId: string | null }) => `https://x/${scope.projectId === null ? "stop" : "mute"}` };

  /**
   * Dana's thread, with Lee and Riley having commented so they can be mentioned.
   * Their reply emails are off, so mention tests count only mention emails;
   * reply emails have their own tests, with the default settings.
   */
  async function discussion(backend: ContractBackend, { replyEmails = false }: { replyEmails?: boolean } = {}) {
    const riley = reviewer("Riley");
    const { projectId, threadId } = await projectWithThread(backend);
    if (!replyEmails) {
      for (const who of [dana, lee, riley]) await backend.run((store) => ops.setNotificationSettings(store, who, { projectId, replyEmails: false }));
    }
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Hi", revision: null }));
    await backend.run((store) => ops.reply(store, riley, { threadId, body: "Hello", revision: null }));
    // Reply emails are queued moments after each reply, as the worker does, before a test changes anyone's choices.
    await settle(backend);
    return { projectId, threadId, riley, leeId: await idOf(backend, lee), rileyId: await idOf(backend, riley), danaId: await idOf(backend, dana) };
  }

  /** Turns reply emails off for Dana, Lee, and Riley, so a test about mention emails counts only those. */
  async function quietReplies(backend: ContractBackend, projectId: string) {
    for (const who of [dana, lee, reviewer("Riley")]) await backend.run((store) => ops.setNotificationSettings(store, who, { projectId, replyEmails: false }));
  }

  /** Every delivery not yet finished, with the mentions it reports. */
  /** Runs the background job that queues reply emails until nothing is left, a step per transaction, as the worker does. */
  async function settle(backend: ContractBackend) {
    for (let step = 0; step < 10_000; step++) if (!(await backend.run((store) => notify.advanceReplyEmails(store, Date.now())))) return;
    throw new Error("Reply emails never finished queuing.");
  }

  async function owed(backend: ContractBackend) {
    await settle(backend);
    return await backend.run(async (store) => {
      const rows = [];
      for (const delivery of await store.deliveries.due(far(), 100)) {
        rows.push({ ...delivery, notifications: await store.notifications.forDelivery(delivery._id, 100) });
      }
      return rows;
    });
  }

  /** Ways a test can step into a worker's sending. */
  interface SendHooks {
    /** Runs before each check that the delivery may still go out. */
    beforeAllowed?: (check: number) => Promise<void>;
    /** Runs after each page of a discussion is read. */
    afterPage?: (page: number) => Promise<void>;
    beforeFreeze?: () => Promise<void>;
    readFile?: (fileId: string, read: () => Promise<Blob | null>) => Promise<Blob | null>;
    /** Sees each request before it counts as sent; throws to fail it. */
    send?: (body: Blob, idempotencyKey: string) => Promise<void>;
    /** The website that serves this deployment's thread pages, as a backend configured with one passes it. */
    website?: string;
  }

  /** Claims due deliveries and sends each through the shared steps, as a backend's worker does, without completing them. */
  async function sendDue(backend: ContractBackend, now: number, token = "worker", hooks: SendHooks = {}) {
    await settle(backend);
    const ids = await backend.run((store) => notify.claimDue(store, now, 25, token));
    const sends: { deliveryId: string; message: MailMessage; body: string }[] = [];
    const skipped: { deliveryId: string; reason: string }[] = [];
    const failed: { deliveryId: string; reason: string }[] = [];
    const deferred: { deliveryId: string; reason: string }[] = [];
    for (const id of ids) {
      let pages = 0;
      let checks = 0;
      const outcome = await notify.deliverOne({
        begin: () =>
          backend.run((store) => notify.beginDelivery(store, { id, claimToken: token, ...links, ...(hooks.website === undefined ? {} : { website: hooks.website }) })),
        allowed: async () => {
          await hooks.beforeAllowed?.(++checks);
          return await backend.run((store) => notify.deliveryAllowed(store, { id, claimToken: token }));
        },
        page: async ({ version, cursor }) => {
          const page = await backend.run((store) => notify.discussionPage(store, { id, claimToken: token, version, cursor }));
          await hooks.afterPage?.(++pages);
          return page;
        },
        stillMentions: (messageId) => backend.run((store) => notify.stillMentions(store, { id, claimToken: token, messageId })),
        pageKey: () => backend.run((store) => notify.makeDeliveryPageKey(store, { id, claimToken: token }, now)),
        freeze: async (args) => {
          await hooks.beforeFreeze?.();
          return await backend.run((store) => notify.freezeDelivery(store, { id, claimToken: token, ...args }));
        },
        readFile: (fileId) => (hooks.readFile ? hooks.readFile(fileId, () => backend.readFile(fileId)) : backend.readFile(fileId)),
        saveFile: (body) => backend.storeFile(body),
        deleteFile: (fileId) => backend.run((store) => store.files.delete(fileId)),
        sendPrepared: async (body, idempotencyKey) => {
          await hooks.send?.(body, idempotencyKey);
          const text = await body.text();
          sends.push({ deliveryId: id, message: preparedMessage(text, idempotencyKey), body: text });
        },
        sendMessage: async (message) => void sends.push({ deliveryId: id, message, body: "" }),
      });
      if (outcome?.result === "skipped") skipped.push({ deliveryId: id, reason: outcome.reason! });
      if (outcome?.result === "failed") failed.push({ deliveryId: id, reason: outcome.reason! });
      if (outcome?.result === "deferred") deferred.push({ deliveryId: id, reason: outcome.reason! });
    }
    return { ids, sends, skipped, failed, deferred };
  }

  /** A small valid PNG, or one of `size` bytes. */
  const png = (size = 16) => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Blob([bytes], { type: "image/png" });
  };

  test(`${name}: only people who have commented in the project can be mentioned`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    const stranger = reviewer("Stranger");
    await backend.run((store) => ops.syncReviewer(store, stranger));
    const strangerId = await idOf(backend, stranger);
    await expect(
      backend.run((store) => ops.reply(store, dana, { threadId, body: "@Stranger", revision: null, mentions: [mention(strangerId, "Stranger")] })),
    ).rejects.toThrow("only mention people who have commented");
    await expect(
      backend.run((store) => ops.reply(store, dana, { threadId, body: "@?", revision: null, mentions: [mention("not-an-id", "?")] })),
    ).rejects.toThrow("only mention people who have commented");
    await expect(
      backend.run((store) => ops.reply(store, dana, { threadId, body: "@", revision: null, mentions: [mention(leeId, " ")] })),
    ).rejects.toThrow("needs a name");
    await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee please check", revision: null, mentions: [mention(leeId, "Lee"), mention(leeId, "Lee")] }),
    );
    const thread = await backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    expect(thread.page.at(-1)!.mentions).toEqual([{ _id: leeId, name: "Lee", label: "Lee" }]);
  });

  test(`${name}: a mention keeps the name as written after the person renames`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee check", revision: null, mentions: [mention(leeId, "Lee")] }));
    await backend.run((store) => ops.syncReviewer(store, { ...lee, name: "Lee Renamed", profileVersion: 2 }));
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread.page.at(-1)!.mentions).toEqual([{ _id: leeId, name: "Lee Renamed", label: "Lee" }]);
  });

  test(`${name}: mention suggestions show participants by name, never email, and not yourself`, async () => {
    const backend = fresh();
    const { projectId } = await discussion(backend);
    const all = await backend.run((store) => ops.listParticipants(store, dana, { projectId, query: "" }));
    expect(all.map((person) => person.name).sort()).toEqual(["Lee", "Riley"]);
    expect(JSON.stringify(all)).not.toContain("@example.com");
    const matching = await backend.run((store) => ops.listParticipants(store, dana, { projectId, query: "ri" }));
    expect(matching.map((person) => person.name)).toEqual(["Riley"]);
  });

  test(`${name}: mentions owe one gathering email per person and thread, never to the author`, async () => {
    const backend = fresh();
    const { threadId, leeId, rileyId, danaId } = await discussion(backend);
    await backend.run((store) =>
      ops.reply(store, dana, {
        threadId,
        body: "@Lee @Riley @Dana",
        revision: null,
        mentions: [mention(leeId, "Lee"), mention(rileyId, "Riley"), mention(danaId, "Dana")],
      }),
    );
    await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: "@Lee too", revision: null, mentions: [mention(leeId, "Lee")] }));
    const rows = await owed(backend);
    expect(rows.map((row) => [row.recipientId, row.notifications.length]).sort()).toEqual(
      [
        [leeId, 2],
        [rileyId, 1],
      ].sort(),
    );
    expect(rows.every((row) => row.status === "pending" && row.attempts === 0 && row.dueAt > row.createdAt)).toBe(true);
  });

  test(`${name}: muted projects and stopped mention emails owe no email`, async () => {
    const backend = fresh();
    const { projectId, threadId, leeId, rileyId } = await discussion(backend);
    await backend.run((store) => ops.setNotificationSettings(store, lee, { projectId, projectMuted: true }));
    await backend.run((store) => ops.setNotificationSettings(store, reviewer("Riley"), { projectId, mentionEmails: false }));
    expect(await backend.run((store) => ops.getNotificationSettings(store, lee, { projectId }))).toEqual({
      mentionEmails: true,
      replyEmails: false,
      projectMuted: true,
    });
    await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee @Riley", revision: null, mentions: [mention(leeId, "Lee"), mention(rileyId, "Riley")] }),
    );
    expect(await owed(backend)).toEqual([]);
  });

  test(`${name}: editing a message emails only people it newly mentions`, async () => {
    const backend = fresh();
    const { threadId, leeId, rileyId } = await discussion(backend);
    const messageId = await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }),
    );
    await backend.run((store) =>
      ops.editMessage(store, dana, { messageId, body: "@Lee @Riley", mentions: [mention(leeId, "Lee"), mention(rileyId, "Riley")] }),
    );
    await backend.run((store) => ops.editMessage(store, dana, { messageId, body: "@Lee @Riley again" }));
    const rows = await owed(backend);
    expect(rows.map((row) => [row.recipientId, row.notifications.length]).sort()).toEqual(
      [
        [leeId, 1],
        [rileyId, 1],
      ].sort(),
    );
  });

  test(`${name}: an email is sent once after the gathering pause, with a short fixed key`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    for (let i = 0; i < 8; i++) {
      await backend.run((store) => ops.reply(store, dana, { threadId, body: `@Lee ${i}`, revision: null, mentions: [mention(leeId, "Lee")] }));
    }
    expect(await backend.run((store) => notify.claimDue(store, Date.now(), 25, "early"))).toEqual([]);
    const now = Date.now() + notify.GATHER_MS + 60_000;
    const { ids, sends, skipped } = await sendDue(backend, now);
    expect(skipped).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toMatchObject({ to: "lee@example.com", subject: "Dana mentioned you: “Department is wrong” · Admin prototype" });
    expect(sends[0]!.message.text).toContain("8 comments");
    expect(sends[0]!.message.idempotencyKey).toBe(`critiqs-mention:${ids[0]}`);
    expect(sends[0]!.message.idempotencyKey.length).toBeLessThanOrEqual(256);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: ids[0]!, claimToken: "worker", result: "sent" }], now));
    expect(await sendDue(backend, now + 10 * 60_000)).toMatchObject({ ids: [] });
  });

  test(`${name}: a retry sends exactly the first email, and later mentions start a new one`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee one", revision: null, mentions: [mention(leeId, "Lee")] }));
    let now = Date.now() + notify.GATHER_MS + 60_000;
    const first = await sendDue(backend, now);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: first.ids[0]!, claimToken: "worker", result: "failed", reason: "Down" }], now));
    // Another mention while the first email waits to retry: it goes in a new email, not the first.
    await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: "@Lee two", revision: null, mentions: [mention(leeId, "Lee")] }));
    // Before the retry pause ends, nothing old is pulled forward.
    const early = await sendDue(backend, now + 30_000);
    expect(early.ids).not.toContain(first.ids[0]);
    now += 2 * 60 * 60_000;
    const retry = await sendDue(backend, now);
    const again = retry.sends.find((send) => send.deliveryId === first.ids[0])!;
    expect(again.message).toEqual(first.sends[0]!.message);
    expect(again.body).toBe(first.sends[0]!.body);
    // The discussion is as it stood at the first attempt.
    expect(again.message.text).toContain("@Lee one");
    expect(again.message.text).not.toContain("@Lee two");
  });

  test(`${name}: a retry is skipped if the reviewer's address changed or the mention was removed`, async () => {
    const backend = fresh();
    const { threadId, leeId, rileyId } = await discussion(backend);
    const toLee = await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Riley", revision: null, mentions: [mention(rileyId, "Riley")] }));
    let now = Date.now() + notify.GATHER_MS + 60_000;
    const first = await sendDue(backend, now);
    expect(first.sends).toHaveLength(2);
    await backend.run((store) =>
      notify.completeDeliveries(
        store,
        first.ids.map((deliveryId) => ({ deliveryId, claimToken: "worker", result: "failed" as const, reason: "Down" })),
        now,
      ),
    );
    // Lee's address changes; Dana removes her mention of Riley.
    await backend.run((store) => ops.syncReviewer(store, { ...lee, email: "lee.new@example.com" }));
    const rileyMessage = (await backend.run((store) => ops.getThread(store, dana, { threadId }, page))).page.at(-1)!._id;
    await backend.run((store) => ops.editMessage(store, dana, { messageId: rileyMessage, body: "Never mind", mentions: [] }));
    void toLee;
    now += 2 * 60 * 60_000;
    const retry = await sendDue(backend, now);
    expect(retry.sends).toEqual([]);
    expect(retry.skipped.map((row) => row.reason).sort()).toEqual(["The mention was removed.", "The reviewer's email address changed."]);
  });

  test(`${name}: removing and adding a mention again in one message still counts one mention`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    const messageId = await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }),
    );
    for (let i = 0; i < 3; i++) {
      await backend.run((store) => ops.editMessage(store, dana, { messageId, body: "Nobody", mentions: [] }));
      await backend.run((store) => ops.editMessage(store, dana, { messageId, body: "@Lee", mentions: [mention(leeId, "Lee")] }));
    }
    const rows = await owed(backend);
    expect(rows.map((row) => row.notifications.length)).toEqual([1]);
  });

  test(`${name}: once an email is full, further mentions gather into one new email`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    for (let i = 0; i < notify.MAX_PER_DELIVERY + 3; i++) {
      await backend.run((store) => ops.reply(store, dana, { threadId, body: `@Lee ${i}`, revision: null, mentions: [mention(leeId, "Lee")] }));
    }
    const rows = await owed(backend);
    expect(rows.map((row) => row.notifications.length).sort((a, b) => b - a)).toEqual([notify.MAX_PER_DELIVERY, 3]);
  });

  test(`${name}: only the worker holding a delivery can finish it, and attempts never exceed the limit`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }));
    let now = Date.now() + notify.GATHER_MS + 60_000;
    const a = await sendDue(backend, now, "a");
    // Worker A stalls; its lease runs out and worker B takes over.
    now += notify.LEASE_MS + 1;
    const b = await sendDue(backend, now, "b");
    expect(b.ids).toEqual(a.ids);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: a.ids[0]!, claimToken: "a", result: "failed", reason: "Late" }], now));
    expect((await backend.run((store) => store.deliveries.get(a.ids[0]!)))!.status).toBe("sending");
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: b.ids[0]!, claimToken: "b", result: "sent" }], now));
    expect((await backend.run((store) => store.deliveries.get(a.ids[0]!)))!.status).toBe("sent");

    // Leases that keep running out count as attempts, and stop at the limit.
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee again", revision: null, mentions: [mention(leeId, "Lee")] }));
    now += notify.GATHER_MS + 60_000;
    let id = "";
    for (let attempt = 0; attempt < notify.MAX_ATTEMPTS + 2; attempt++) {
      const claimed = await backend.run((store) => notify.claimDue(store, now, 25, `w${attempt}`));
      if (claimed.length > 0) id = claimed[0]!;
      now += notify.LEASE_MS + 1;
    }
    const final = (await backend.run((store) => store.deliveries.get(id)))!;
    expect(final.attempts).toBe(notify.MAX_ATTEMPTS);
    expect(final.status).toBe("failed");
  });

  test(`${name}: a removed mention or deleted thread sends nothing, and failures retry then stop`, async () => {
    const backend = fresh();
    const { threadId, leeId, rileyId } = await discussion(backend);
    const messageId = await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee @Riley", revision: null, mentions: [mention(leeId, "Lee"), mention(rileyId, "Riley")] }),
    );
    await backend.run((store) => ops.editMessage(store, dana, { messageId, body: "@Riley", mentions: [mention(rileyId, "Riley")] }));
    let now = Date.now() + notify.GATHER_MS + 60_000;
    const first = await sendDue(backend, now);
    expect(first.skipped.map((row) => row.reason)).toEqual(["The mention was removed."]);
    expect(first.sends).toHaveLength(1);
    const rileyDelivery = first.sends[0]!.deliveryId;
    await backend.run((store) =>
      notify.completeDeliveries(store, first.skipped.map(({ deliveryId, reason }) => ({ deliveryId, claimToken: "worker", result: "skipped" as const, reason })), now),
    );
    for (let attempt = 1; attempt <= notify.MAX_ATTEMPTS; attempt++) {
      await backend.run((store) =>
        notify.completeDeliveries(store, [{ deliveryId: rileyDelivery, claimToken: `t${attempt}`, result: "failed", reason: "Down" }], now),
      );
      if (attempt === notify.MAX_ATTEMPTS) break;
      now += 5 * 60 * 60_000;
      const claimed = await backend.run((store) => notify.claimDue(store, now, 25, `t${attempt + 1}`));
      expect(claimed).toEqual([rileyDelivery]);
    }
    // The first completion above used the original claim token; later ones the new tokens.
    const final = (await backend.run((store) => store.deliveries.get(rileyDelivery)))!;
    expect(final).toMatchObject({ status: "failed", reason: "Down", attempts: notify.MAX_ATTEMPTS });

    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }));
    await backend.run((store) => ops.removeThread(store, dana, { threadId }));
    now += 60 * 60_000;
    const after = await sendDue(backend, now);
    expect(after.sends).toEqual([]);
    expect(after.skipped.map((row) => row.reason)).toEqual(["The thread was deleted."]);
  });

  test(`${name}: an email links to the project's review page exactly, whatever page or copy a comment was left on`, async () => {
    const backend = fresh();
    // A deployment under a path, with its own parameter (encoded as the app wrote it) and a hash route.
    const reviewPage = "https://team.github.io/admin-prototype/?env=a%20b#/start";
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: reviewPage }));
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).reviewUrl).toBe(reviewPage);
    await expect(backend.run((store) => ops.setReviewUrl(store, lee, { projectId, reviewUrl: "https://elsewhere.example" }))).rejects.toThrow(
      "Only the person who set up",
    );
    await expect(backend.run((store) => ops.setReviewUrl(store, dana, { projectId, reviewUrl: "javascript:alert(1)" }))).rejects.toThrow(
      "prototype's address",
    );
    // Comments left on a local copy, on a private (Tailscale) copy at another path, and on an unreadable page.
    const at = (url: string) => ({ ...anchor, evidence: { ...anchor.evidence, url } });
    const local = await backend.run((store) =>
      ops.createThread(store, lee, { projectId, anchor: at("http://localhost:5173/users/alex?tab=permissions#profile"), body: "Local", tags: [], capture: failed }),
    );
    const tailnet = await backend.run((store) =>
      ops.createThread(store, lee, { projectId, anchor: at("https://devbox.tail1234.ts.net/preview/users/alex"), body: "Tailnet", tags: [], capture: failed }),
    );
    const odd = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor: at("http://["), body: "Odd", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const replies = new Map<string, string>();
    for (const threadId of [local, tailnet, odd]) {
      replies.set(threadId, await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] })));
    }
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(sends).toHaveLength(3);
    const texts = sends.map((send) => `${send.message.text}\n${send.message.html}`).join("\n");
    for (const [threadId, reply] of replies) {
      expect(texts).toContain(`https://team.github.io/admin-prototype/?env=a%20b&critiqs=${threadId}.${reply}#/start`);
    }
    for (const elsewhere of ["localhost", "ts.net", "/users/alex", "tab=permissions", "https://team.github.io/?", "https://team.github.io/#"]) {
      expect(texts).not.toContain(elsewhere);
    }
    // The saved evidence is unchanged.
    const saved = await backend.run((store) => ops.getThread(store, lee, { threadId: local }, page));
    expect(saved.anchor.evidence.url).toBe("http://localhost:5173/users/alex?tab=permissions#profile");
    const message = sends[0]!.message;
    expect(message.html).toContain("https://x/stop");
    expect(message.html).toContain("https://x/mute");
  });

  test(`${name}: a review address keeps its hash route and drops a copied Critiqs parameter; changing it affects later emails only`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) =>
      ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: " https://proto.example/app/?critiqs=t1.m2&tab=a#/home " }),
    );
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).reviewUrl).toBe("https://proto.example/app/?tab=a#/home");
    // Setup from older versions could send an address emails can't link to; the project is created without one.
    const older = await backend.run((store) => ops.createProject(store, dana, { name: "Older", reviewUrl: "http://192.168.1.4:3000/" }));
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId: older }))).reviewUrl).toBeNull();
    // Commenting never changes the address.
    const threadId = await backend.run((store) =>
      ops.createThread(store, lee, { projectId, anchor: { ...anchor, evidence: { ...anchor.evidence, url: "http://localhost:5173/" } }, body: "Hi", tags: [], capture: failed }),
    );
    const leeId = await idOf(backend, lee);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee one", revision: null, mentions: [mention(leeId, "Lee")] }));
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).reviewUrl).toBe("https://proto.example/app/?tab=a#/home");
    const sentAt = Date.now() + notify.GATHER_MS + 60_000;
    const first = await sendDue(backend, sentAt);
    expect(first.sends[0]!.message.text).toContain(`https://proto.example/app/?tab=a&critiqs=${threadId}.`);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: first.ids[0]!, claimToken: "worker", result: "sent" }], sentAt));
    await backend.run((store) => ops.setReviewUrl(store, dana, { projectId, reviewUrl: "https://review.example/v2/" }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee two", revision: null, mentions: [mention(leeId, "Lee")] }));
    const second = await sendDue(backend, Date.now() + 2 * (notify.GATHER_MS + 60_000));
    expect(second.sends[0]!.message.text).toContain(`https://review.example/v2/?critiqs=${threadId}.`);
    expect(second.sends[0]!.message.text).not.toContain("proto.example");
  });

  test(`${name}: a long review address links in full; one too long to repeat keeps its path, never just the site`, async () => {
    const backend = fresh();
    const long = `https://proto.example/app/?filters=${"x".repeat(1_900)}#/home`;
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: long }));
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).reviewUrl).toBe(long);
    await expect(
      backend.run((store) => ops.setReviewUrl(store, dana, { projectId, reviewUrl: `https://proto.example/app/?filters=${"x".repeat(2_000)}` })),
    ).rejects.toThrow("prototype's address");
    const threadId = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Long", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }));
    const sentAt = Date.now() + notify.GATHER_MS + 60_000;
    const { ids, sends } = await sendDue(backend, sentAt);
    expect(sends[0]!.message.text).toMatch(new RegExp(`https://proto\\.example/app/\\?filters=x{1900}&critiqs=${threadId}\\.[^\\s#]+#/home`));
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: ids[0]!, claimToken: "worker", result: "sent" }], sentAt));

    // An address saved before today's limits, too long to repeat in every link.
    const legacy = await backend.run((store) => ops.createProject(store, dana, { name: "Legacy" }));
    await backend.run((store) => store.projects.patch(legacy, { reviewUrl: `https://proto.example/app/?q=${"x".repeat(5_000)}#/home` }));
    const legacyThread = await backend.run((store) => ops.createThread(store, lee, { projectId: legacy, anchor, body: "Legacy", tags: [], capture: failed }));
    await backend.run((store) => ops.reply(store, dana, { threadId: legacyThread, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }));
    const later = await sendDue(backend, Date.now() + 2 * (notify.GATHER_MS + 60_000));
    const text = later.sends[0]!.message.text;
    expect(text).toContain(`Open: https://proto.example/app/?critiqs=${legacyThread}.`);
    expect(text).not.toContain("xxxxxxxxxx");
    expect(text).not.toContain("https://proto.example/?critiqs");
  });

  /**
   * A project with a review address where Lee and Riley have commented, so
   * they can be mentioned; Dana is its owner.
   */
  async function reviewedProject(backend: ContractBackend) {
    const riley = reviewer("Riley");
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/app" }));
    const started: string[] = [];
    for (const who of [lee, riley]) {
      started.push(await backend.run((store) => ops.createThread(store, who, { projectId, anchor, body: `${who.name} was here`, tags: [], capture: failed })));
    }
    return { projectId, riley, leeThread: started[0]!, rileyThread: started[1]!, leeId: await idOf(backend, lee), rileyId: await idOf(backend, riley) };
  }

  const WEBSITE = "https://critiqs.example/app/";
  const pageKeyOf = async (backend: ContractBackend, threadId: string) => (await backend.run((store) => store.threads.get(threadId)))!.pageKey;
  const threadOf = async (backend: ContractBackend, deliveryId: string) => (await backend.run((store) => store.deliveries.get(deliveryId)))!.threadId;

  test(`${name}: with a website, mention, reply, and edit emails link to the thread's page instead of the prototype`, async () => {
    const backend = fresh();
    const { projectId, riley, leeId, rileyId, leeThread: replied, rileyThread: edited } = await reviewedProject(backend);
    // A new comment that mentions Lee.
    const started = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "@Lee look here", tags: [], capture: failed, mentions: [mention(leeId, "Lee")] }),
    );
    // A reply that mentions Riley, in a thread Lee started: Lee gets the reply email.
    await backend.run((store) => ops.reply(store, dana, { threadId: replied, body: "@Riley can you check?", revision: null, mentions: [mention(rileyId, "Riley")] }));
    // An edit that newly mentions Lee, in a thread Riley started.
    const messageId = await backend.run((store) => ops.reply(store, dana, { threadId: edited, body: "Looks fine", revision: null }));
    await backend.run((store) => ops.editMessage(store, dana, { messageId, body: "@Lee looks fine?", mentions: [mention(leeId, "Lee")] }));

    const { sends, failed: failures } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000, "worker", { website: WEBSITE });
    expect(failures).toEqual([]);
    const byThread = new Map<string, MailMessage[]>();
    for (const send of sends) {
      const threadId = await threadOf(backend, send.deliveryId);
      byThread.set(threadId, [...(byThread.get(threadId) ?? []), send.message]);
    }
    // Lee: the new comment's mention, the reply in Lee's thread, and the edit's mention. Riley: the mention in Lee's
    // thread, and the reply in Riley's own.
    expect(sends.map((send) => send.message.to).sort()).toEqual(["lee@example.com", "lee@example.com", "lee@example.com", "riley@example.com", "riley@example.com"]);
    expect(sends.map((send) => send.message.subject.split(":")[0]).sort()).toEqual(["Dana mentioned you", "Dana mentioned you", "Dana mentioned you", "Dana replied", "Dana replied"]);
    expect([...byThread.keys()].sort()).toEqual([started, replied, edited].sort());
    for (const [threadId, messages] of byThread) {
      const key = await pageKeyOf(backend, threadId);
      expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const link = `https://critiqs.example/app/t/${key}`;
      for (const message of messages) {
        expect(message.text).toContain(`Open the comment: ${link}\n`);
        expect(message.html).toContain(`<a href="${link}"`);
        // The page shows the whole thread, so no comment repeats a link of its own, and none goes to the prototype.
        expect(message.html).not.toContain("Open this comment");
        expect(message.text).not.toContain("Open: ");
        expect(`${message.text}${message.html}`).not.toContain("critiqs=");
        expect(`${message.text}${message.html}`).not.toContain("proto.example");
        expect(`${message.text}${message.html}`).not.toContain(threadId);
      }
    }
    void riley;
  });

  test(`${name}: an older thread gets its page key when it is emailed, the one Share gives, which opens the page for the person emailed`, async () => {
    const backend = fresh();
    const { projectId, leeId } = await reviewedProject(backend);
    const danaId = await idOf(backend, dana);
    const at = Date.now() - 60_000;
    // Saved before thread pages and reply emails: no page key, no record of who is in it.
    const older = async () =>
      await backend.run(async (store) => {
        const id = await store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: at, lastMessageAt: at, messageCount: 1 });
        await store.messages.insert({ threadId: id, authorId: danaId, body: "Old question", createdAt: at, editedAt: null, revision: null });
        return id;
      });
    // Without a website, emailing it makes no key and links to the prototype, as before.
    const before = await older();
    await backend.run((store) => ops.reply(store, dana, { threadId: before, body: "@Lee still?", revision: null, mentions: [mention(leeId, "Lee")] }));
    const plain = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000, "plain");
    expect(plain.sends).toHaveLength(1);
    expect(plain.sends[0]!.message.text).toContain(`https://proto.example/app?critiqs=${before}.`);
    expect(await pageKeyOf(backend, before)).toBeUndefined();

    const threadId = await older();
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee what do you think?", revision: null, mentions: [mention(leeId, "Lee")] }));
    expect(await pageKeyOf(backend, threadId)).toBeUndefined();
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 120_000, "worker", { website: WEBSITE });
    expect(sends).toHaveLength(1);
    const key = await pageKeyOf(backend, threadId);
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sends[0]!.message.text).toContain(`Open the comment: https://critiqs.example/app/t/${key}\n`);
    // Share gives the same key, and the page opens for Lee, who was mentioned.
    expect(await backend.run((store) => ops.threadPageKey(store, dana, { threadId }))).toBe(key!);
    const opened = await backend.run((store) => ops.getThreadPage(store, lee, { key: key! }, page));
    expect(opened.page.map((message) => message.body)).toEqual(["Old question", "@Lee what do you think?"]);
  });

  /**
   * A thread from before page keys and before people in threads were recorded, where Lee was mentioned then, and an
   * email to Lee about it still waiting, as one queued before the upgrade.
   */
  async function legacyMention(backend: ContractBackend, attempts = 0, at = Date.now() - 60_000) {
    const { projectId, leeId } = await reviewedProject(backend);
    const danaId = await idOf(backend, dana);
    return await backend.run(async (store) => {
      const threadId = await store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: at, lastMessageAt: at, messageCount: 1 });
      const messageId = await store.messages.insert({ threadId, authorId: danaId, body: "@Lee old question", createdAt: at, editedAt: null, revision: null, mentions: [{ userId: leeId, label: "Lee" }] });
      const deliveryId = await store.deliveries.insert({ recipientId: leeId, projectId, threadId, status: "pending", attempts, dueAt: at, createdAt: at });
      await store.notifications.insert({ deliveryId, recipientId: leeId, messageId, authorId: danaId, createdAt: at });
      return { threadId, deliveryId };
    });
  }

  test(`${name}: an email links to the page only once its recipient can open it, waiting for an older thread's people to be recorded`, async () => {
    const backend = fresh();
    // On its last attempt, so waiting must neither use it up nor give up on the page link.
    const { threadId, deliveryId } = await legacyMention(backend, notify.MAX_ATTEMPTS - 1);
    const now = Date.now() + 60_000;
    // The key is made as the email starts, but who is in the thread isn't recorded yet, so Lee couldn't open the page.
    const first = await sendDue(backend, now, "first", { website: WEBSITE });
    expect(first.sends).toEqual([]);
    expect(first.failed).toEqual([]);
    expect(first.deferred).toEqual([{ deliveryId, reason: "Waiting until the thread's page opens for its recipient." }]);
    const key = await pageKeyOf(backend, threadId);
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(backend.run((store) => ops.getThreadPage(store, lee, { key: key! }, page))).rejects.toThrow("This thread doesn't exist, or you can't open it.");
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId, claimToken: "first", result: "deferred", reason: first.deferred[0]!.reason }], now));
    // Waiting costs no attempt, and the email is tried again a minute later, not after the mail service's pauses.
    expect(await backend.run((store) => store.deliveries.get(deliveryId))).toMatchObject({ status: "pending", attempts: notify.MAX_ATTEMPTS - 1, dueAt: now + 60_000 });
    // The worker records who is in the thread before its next try, and Lee's link then opens.
    const second = await sendDue(backend, now + 60_000, "second", { website: WEBSITE });
    expect(second.sends).toHaveLength(1);
    expect(second.sends[0]!.message.text).toContain(`Open the comment: https://critiqs.example/app/t/${key}\n`);
    expect((await backend.run((store) => ops.getThreadPage(store, lee, { key: key! }, page))).page.map((message) => message.body)).toEqual(["@Lee old question"]);
  });

  test(`${name}: an email that has waited an hour for its thread's people stops waiting and links to the prototype`, async () => {
    const backend = fresh();
    // Owed for two hours: recording a thread's people takes minutes, so something has stopped it.
    const { threadId, deliveryId } = await legacyMention(backend, 0, Date.now() - 2 * 60 * 60_000);
    const { sends, deferred } = await sendDue(backend, Date.now() + 60_000, "worker", { website: WEBSITE });
    expect(deferred).toEqual([]);
    expect(sends.map((send) => send.deliveryId)).toEqual([deliveryId]);
    expect(sends[0]!.message.text).toContain(`Open the comment: https://proto.example/app?critiqs=${threadId}.`);
  });

  test(`${name}: someone the page wouldn't let in, once its people are recorded, gets the prototype's link rather than one that wouldn't open`, async () => {
    const backend = fresh();
    const { threadId, deliveryId } = await legacyMention(backend);
    // Recorded, but without Lee: as if Lee's mention had been lost from the record.
    await backend.run((store) => store.threads.patch(threadId, { followersReady: true }));
    const { sends, deferred } = await sendDue(backend, Date.now() + 60_000, "worker", { website: WEBSITE });
    expect(deferred).toEqual([]);
    expect(sends.map((send) => send.deliveryId)).toEqual([deliveryId]);
    expect(sends[0]!.message.text).toContain(`Open the comment: https://proto.example/app?critiqs=${threadId}.`);
    expect(sends[0]!.message.text).not.toContain("critiqs.example/app/t/");
  });

  test(`${name}: an email shows the whole discussion in order, beyond one page, with authors, times, and links`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/" }));
    await quietReplies(backend, projectId);
    setSystemTime(new Date("2026-10-24T09:05:00Z"));
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Department is wrong", tags: ["Bug"], capture: failed }),
    );
    setSystemTime(new Date("2026-10-24T09:30:00Z"));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Which one?", revision: null }));
    // More replies than one page holds, none mentioning Lee.
    const count = ops.PAGE_SIZE * 2 + 5;
    for (let i = 0; i < count; i++) {
      await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: `Note ${i}`, revision: null }));
    }
    const leeId = await idOf(backend, lee);
    const last = await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee the one\non the profile tab", revision: null, mentions: [mention(leeId, "Lee")] }),
    );
    setSystemTime();
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(sends).toHaveLength(1);
    const { text, html } = sends[0]!.message;
    const total = count + 3;
    expect(text).toContain(`Thread (${total} comments)`);
    expect(text).toContain(`Open · Bug · ${total} comments`);
    expect(text).toContain("No capture was saved: Blocked");
    expect(text).not.toContain("aren't shown");
    // Every message, in order, including those that don't mention Lee.
    const bodies = ["Department is wrong", "Which one?", ...Array.from({ length: count }, (_, i) => `Note ${i}\n`), "@Lee the one"];
    let at = 0;
    for (const body of bodies) {
      const found = text.indexOf(body, at);
      expect(found).toBeGreaterThan(at - 1);
      at = found + body.length;
    }
    expect(text).toContain("Dana · 24 Oct 2026, 09:05 UTC\nDepartment is wrong");
    expect(text).toContain("Lee · 24 Oct 2026, 09:30 UTC\nWhich one?");
    expect(text).toContain("· mentions you\n@Lee the one\non the profile tab");
    expect(text).toContain(`Open: https://proto.example/?critiqs=${threadId}.${last}`);
    expect(html).toContain("Department is wrong");
    expect(html).toContain(`Note ${count - 1}`);
    expect(html).toContain("@Lee</strong> the one<br>on the profile tab");
    expect(html).toContain("Mentions you");
    expect(html.match(/Open this comment/g)).toHaveLength(total);
  });

  test(`${name}: an email escapes what reviewers wrote`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    const evil = { ...reviewer("Eve"), name: "<img src=x onerror=alert(1)>" };
    await backend.run((store) => ops.reply(store, evil, { threadId, body: `<script>alert("x")</script> & 'more' &copy \u0007`, revision: null }));
    await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee <b>bold</b>", revision: null, mentions: [mention(leeId, "Lee")] }),
    );
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const { html, text, subject } = sends[0]!.message;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>bold");
    // `&copy` would show as ©; a control character is shown as a replacement.
    expect(html).toContain(`&lt;script>alert("x")&lt;/script> & 'more' &amp;copy �`);
    expect(html).toContain("&lt;img src=x onerror=alert(1)>");
    expect(text).toContain(`<script>alert("x")</script> & 'more' &copy �`);
    expect(subject).not.toMatch(/[\r\n]/);
  });

  test(`${name}: an email shows the thread's capture or supplied screenshot, or says why there is none`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    // Lee comments first, so they can be mentioned.
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const image = png(40);
    const capturedFile = await backend.storeFile(image);
    const suppliedFile = await backend.storeFile(png(24));
    const captured = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "@Lee captured", tags: [], capture: { status: "captured", fileId: capturedFile }, mentions: [mention(leeId, "Lee")] }),
    );
    const supplied = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "Plain", tags: [], capture: failed }));
    await backend.run((store) => ops.attachScreenshot(store, dana, { threadId: supplied, fileId: suppliedFile }));
    await backend.run((store) => ops.reply(store, dana, { threadId: supplied, body: "@Lee supplied", revision: null, mentions: [mention(leeId, "Lee")] }));
    const none = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "@Lee none", tags: [], capture: { status: "failed", failureReason: "Canvas blocked" }, mentions: [mention(leeId, "Lee")] }),
    );
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const threadOf = new Map(
      await backend.run(async (store) =>
        Promise.all(sends.map(async (send) => [send.deliveryId, (await store.deliveries.get(send.deliveryId))!.threadId] as const)),
      ),
    );
    const byThread = new Map(sends.map((send) => [threadOf.get(send.deliveryId)!, send.message]));
    const withCapture = byThread.get(captured)!;
    expect(withCapture.attachments).toEqual([
      { filename: "capture.png", contentType: "image/png", contentId: "critiqs-capture", content: new Uint8Array(await image.arrayBuffer()) },
    ]);
    expect(withCapture.html).toContain(`<img src="cid:critiqs-capture"`);
    expect(withCapture.html).toContain("with the element outlined");
    const withScreenshot = byThread.get(supplied)!;
    expect(withScreenshot.attachments).toHaveLength(1);
    expect(withScreenshot.html).toContain("Screenshot attached to the thread");
    const without = byThread.get(none)!;
    expect(without.attachments).toBeUndefined();
    expect(without.html).not.toContain("cid:");
    expect(without.html).toContain("No capture was saved: Canvas blocked");
    expect(without.text).toContain("No capture was saved: Canvas blocked");
  });

  test(`${name}: an email keeps every comment of a long discussion (34 comments of 9,000 characters)`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    const long = "<".repeat(9_000);
    for (let i = 0; i < 30; i++) {
      await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: `#${i}#${long}`, revision: null }));
    }
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee see above", revision: null, mentions: [mention(leeId, "Lee")] }));
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const { text, html } = sends[0]!.message;
    for (let i = 0; i < 30; i++) {
      expect(text).toContain(`#${i}#${long}\n`);
      expect(html).toContain(`#${i}#${"&lt;".repeat(9_000)}</p>`);
    }
    expect(text).toContain("Department is wrong");
    expect(text).toContain("@Lee see above");
    expect(text).toContain("Thread (34 comments)");
    expect((text.match(/ UTC/g) ?? []).length).toBe(34);
    expect(text).not.toContain("aren't shown");
  });

  test(`${name}: a saved page with a very long address keeps the stored delivery small and links to the review address`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/" }));
    const huge = { ...anchor, evidence: { ...anchor.evidence, url: `https://proto.example/users/alex?q=${"x".repeat(200_000)}` } };
    const threadId = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor: huge, body: "Long page", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const last = await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee look", revision: null, mentions: [mention(leeId, "Lee")] }));
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(sends).toHaveLength(1);
    const { text, html } = sends[0]!.message;
    expect(text).toContain(`Open: https://proto.example/?critiqs=${threadId}.${last}`);
    expect(text).not.toContain("xxxxxxxxxx");
    expect(new TextEncoder().encode(text).length + new TextEncoder().encode(html).length).toBeLessThan(20_000);
    // The delivery holds only a pointer to the stored email.
    const delivery = (await backend.run((store) => store.deliveries.get(sends[0]!.deliveryId)))!;
    expect(delivery.message).toBeUndefined();
    expect(delivery.payload).toEqual({ fileId: expect.any(String), to: "lee@example.com" });
    expect(JSON.stringify(delivery).length).toBeLessThan(1_000);
  });

  /** Dana's thread mentioning Lee at its end, with `count` comments of 10,000 characters that escape to four bytes each. */
  async function longThread(backend: ContractBackend, projectId: string, leeId: string, count: number, capture: CaptureInput) {
    const body = (i: number) => `#${i}#`.padEnd(10_000, "<");
    await quietReplies(backend, projectId);
    const threadId = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: body(0), tags: [], capture }));
    for (let i = 1; i < count - 1; i++) await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: body(i), revision: null }));
    await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: `@Lee ${body(count - 1)}`.slice(0, 10_000), revision: null, mentions: [mention(leeId, "Lee")] }),
    );
    return threadId;
  }

  /** Checks an email shows `count` long comments in order in its HTML part. */
  function expectEveryComment(html: string, count: number) {
    let at = 0;
    for (let i = 0; i < count; i++) {
      const found = html.indexOf(i === count - 1 ? `@Lee</strong> #${i}#&lt;` : `<p style="margin:4px 0 0">#${i}#&lt;&lt;`, at);
      if (found < 0) throw new Error(`Comment ${i} is missing from the email.`);
      at = found + 1;
    }
    expect((html.match(/Open this comment/g) ?? []).length).toBe(count);
  }

  /** The size of an email as the mail service counts it, every part Base64-encoded in 76-character lines. */
  function encodedSize(message: MailMessage) {
    const mime = (n: number) => Math.ceil(n / 3) * 4 + 2 * Math.ceil((Math.ceil(n / 3) * 4) / 76);
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    return mime(bytes(message.html)) + mime(bytes(message.text)) + (message.attachments ?? []).reduce((total, file) => total + mime(file.content.length), 0);
  }

  test(`${name}: 320 long comments and the largest capture all fit one email`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/" }));
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const image = png(10 * 1024 * 1024);
    const fileId = await backend.storeFile(image);
    await longThread(backend, projectId, leeId, 320, { status: "captured", fileId });
    const { sends, failed: failures } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(failures).toEqual([]);
    const { message, body } = sends[0]!;
    expectEveryComment(message.html, 320);
    expect(message.attachments?.[0]?.content.length).toBe(10 * 1024 * 1024);
    expect(message.text).toContain("#0#<<<");
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
    expect(encodedSize(message)).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
  }, 120_000);

  test(`${name}: 461 long comments and the largest capture, near the limit, still fit one email with the capture`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/" }));
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const fileId = await backend.storeFile(png(10 * 1024 * 1024));
    await longThread(backend, projectId, leeId, 461, { status: "captured", fileId });
    const { sends, failed: failures } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(failures).toEqual([]);
    const { message, body } = sends[0]!;
    expectEveryComment(message.html, 461);
    expect(message.attachments?.[0]?.content.length).toBe(10 * 1024 * 1024);
    expect(message.html).not.toContain("The capture isn't included");
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
    // Measured as the mail service would build it, with the same allowance for headers.
    expect(encodedSize(message) + 16 * 1024).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
  }, 120_000);

  test(`${name}: the longest discussion always fits whole; only past the mail service's limit do the plain text and then the capture make room`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/" }));
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const small = await longThread(backend, projectId, leeId, 500, { status: "captured", fileId: await backend.storeFile(png(64 * 1024)) });
    const large = await longThread(backend, projectId, leeId, 500, { status: "captured", fileId: await backend.storeFile(png(10 * 1024 * 1024)) });
    const { sends, failed: failures } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(failures).toEqual([]);
    const threadIds = await backend.run(async (store) =>
      Promise.all(sends.map(async (send) => (await store.deliveries.get(send.deliveryId))!.threadId)),
    );
    const threadOf = new Map(sends.map((send, index) => [threadIds[index]!, send]));
    for (const send of sends) {
      expectEveryComment(send.message.html, 500);
      expect(new TextEncoder().encode(send.body).length).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
      expect(encodedSize(send.message)).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
    }
    // With a small capture everything fits, plain text included.
    const withSmall = threadOf.get(small)!.message;
    expect(withSmall.attachments?.[0]?.content.length).toBe(64 * 1024);
    expect(withSmall.text).toContain("#250#<<<");
    // 500 such comments and a 10 MiB capture would be over 40 MB encoded: every comment stays, and the email says why the rest doesn't.
    const withLarge = threadOf.get(large)!.message;
    expect(withLarge.attachments).toBeUndefined();
    expect(withLarge.html).toContain("The capture isn't included: with this whole discussion, the email would be larger than the email service accepts.");
    expect(withLarge.text).toContain("are too long to repeat in the plain-text version of this email. The HTML version shows every comment.");
  }, 120_000);

  test(`${name}: very long names are shortened in the email, which still carries every comment`, async () => {
    const backend = fresh();
    const huge = "<".repeat(900_000);
    // Names longer than today's limit can remain from before it, until the backfill shortens them.
    const created = await backend.run((store) => ops.createProject(store, dana, { name: "Named later", reviewUrl: "https://proto.example/" }));
    const projectId = await insertNamed(backend, created, huge);
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    await longThread(backend, projectId, leeId, 400, failed);
    const { sends, failed: failures } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(failures).toEqual([]);
    const { message } = sends[0]!;
    expectEveryComment(message.html, 400);
    expect(message.html).toContain(`<strong>${"&lt;".repeat(199)}…</strong>`);
    // The email's opening and footer stay short; the name appears shortened each time.
    expect(message.html.indexOf("<table")).toBeLessThan(10_000);
    expect(message.html.length - message.html.lastIndexOf("</table>")).toBeLessThan(10_000);
    expect(message.text).toContain(`Mute ${"<".repeat(199)}…: `);
    expect(message.subject.length).toBeLessThanOrEqual(200);
    expect(encodedSize(message)).toBeLessThanOrEqual(MAX_EMAIL_BYTES);
  }, 120_000);

  test(`${name}: an edit or reply while an email is prepared starts it again, so it shows one moment of the discussion`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    for (let i = 0; i < 45; i++) await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: `Note ${i}`, revision: null }));
    const firstNote = (await allMessages(backend, dana, threadId)).find((message) => message.body === "Note 0")!._id;
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee look", revision: null, mentions: [mention(leeId, "Lee")] }));
    let edited = false;
    let replied = false;
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000, "worker", {
      // After the first page, Riley edits a message that page already read.
      afterPage: async () => {
        if (edited) return;
        edited = true;
        await backend.run((store) => ops.editMessage(store, reviewer("Riley"), { messageId: firstNote, body: "Note 0, corrected" }));
      },
      // After the whole discussion is read, Riley replies.
      beforeFreeze: async () => {
        if (replied) return;
        replied = true;
        await backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: "Late reply", revision: null }));
      },
    });
    expect(sends).toHaveLength(1);
    const { text } = sends[0]!.message;
    expect(text).toContain("Note 0, corrected");
    expect(text).toContain("Late reply");
    expect(text).toContain("Thread (50 comments)");
  });

  test(`${name}: a retry sends the identical request even when the capture is unreadable or gone, so the mail service accepts it`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    const leeId = await idOf(backend, lee);
    const fileId = await backend.storeFile(png(2048));
    await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "@Lee spacing", tags: [], capture: { status: "captured", fileId }, mentions: [mention(leeId, "Lee")] }),
    );
    // Resend's idempotency: a key's first request is kept; the same key with a different request is refused.
    const accepted = new Map<string, string>();
    const requests: string[] = [];
    let loseResponse = true;
    const provider = resendMailer({
      apiKey: "re_key",
      from: "Critiqs <mentions@example.com>",
      fetch: (async (_url: string, init: RequestInit) => {
        const key = new Headers(init.headers).get("Idempotency-Key")!;
        const body = await new Response(init.body).text();
        requests.push(body);
        if (accepted.has(key) && accepted.get(key) !== body) return new Response("invalid_idempotent_request", { status: 409 });
        accepted.set(key, body);
        if (loseResponse) throw new TypeError("connection reset");
        return Response.json({ id: "email" });
      }) as unknown as typeof fetch,
    });
    const send = (body: Blob, key: string) => provider.sendPrepared!(body, key);
    let now = Date.now() + notify.GATHER_MS + 60_000;
    let storageDown = true;
    const flaky = async (_fileId: string, read: () => Promise<Blob | null>) => {
      if (storageDown) throw new Error("storage unavailable");
      return await read();
    };

    // Storage is down when the email is first prepared: nothing is fixed or sent, and it is tried again.
    const first = await sendDue(backend, now, "w1", { readFile: flaky, send });
    expect(first.failed.map((row) => row.reason)).toEqual(["The capture couldn't be read."]);
    expect(requests).toHaveLength(0);
    expect((await backend.run((store) => store.deliveries.get(first.ids[0]!)))!.payload).toBeUndefined();
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: first.ids[0]!, claimToken: "w1", result: "failed", reason: "x" }], now));

    // Storage recovers; the email is prepared with its capture and reaches the provider, but the response is lost.
    storageDown = false;
    now += 2 * 60 * 60_000;
    const second = await sendDue(backend, now, "w2", { readFile: flaky, send });
    expect(second.failed.map((row) => row.reason)).toEqual(["The email service couldn't be reached."]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!).attachments).toHaveLength(1);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: second.ids[0]!, claimToken: "w2", result: "failed", reason: "x" }], now));

    // Storage fails again while retrying: the stored email can't be read, so nothing different is sent.
    storageDown = true;
    now += 2 * 60 * 60_000;
    const third = await sendDue(backend, now, "w3", { readFile: flaky, send });
    expect(third.failed.map((row) => row.reason)).toEqual(["The prepared email couldn't be read."]);
    expect(requests).toHaveLength(1);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: third.ids[0]!, claimToken: "w3", result: "failed", reason: "x" }], now));

    // The capture itself is gone now, but the retry sends the stored request, byte for byte, and the provider accepts it.
    storageDown = false;
    loseResponse = false;
    await backend.run((store) => store.files.delete(fileId));
    now += 5 * 60 * 60_000;
    const fourth = await sendDue(backend, now, "w4", { readFile: flaky, send });
    expect(fourth.failed).toEqual([]);
    expect(fourth.sends).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: fourth.ids[0]!, claimToken: "w4", result: "sent" }], now));
    // A finished delivery's stored email is removed.
    const payload = (await backend.run((store) => store.deliveries.get(fourth.ids[0]!)))!.payload!;
    expect(await backend.readFile(payload.fileId)).toBeNull();
  });

  test(`${name}: a mute or unsubscribe link changes only that choice for that reviewer`, async () => {
    const backend = fresh();
    const { projectId, leeId } = await discussion(backend, { replyEmails: true });
    const token = await notify.preferenceToken("secret", { userId: leeId, projectId });
    expect(await notify.readPreferenceToken("other secret", token)).toBeNull();
    expect(await notify.readPreferenceToken("secret", `${token}x`)).toBeNull();
    const scope = (await notify.readPreferenceToken("secret", token))!;
    await backend.run((store) => notify.applyPreferenceLink(store, scope));
    expect(await backend.run((store) => ops.getNotificationSettings(store, lee, { projectId }))).toEqual({
      mentionEmails: true,
      replyEmails: true,
      projectMuted: true,
    });
    const stop = (await notify.readPreferenceToken("secret", await notify.preferenceToken("secret", { userId: leeId, projectId: null })))!;
    await backend.run((store) => notify.applyPreferenceLink(store, stop));
    // Stopping all emails stops mentions and replies, for that reviewer only.
    expect(await backend.run((store) => ops.getNotificationSettings(store, lee, { projectId }))).toMatchObject({ mentionEmails: false, replyEmails: false });
    expect(await backend.run((store) => ops.getNotificationSettings(store, dana, { projectId }))).toMatchObject({ mentionEmails: true, replyEmails: true });
  });

  // Reply emails: everyone in a thread hears about new replies.

  /** What each unfinished delivery reports, as [recipient, kinds of its notifications]. */
  async function kinds(backend: ContractBackend): Promise<unknown> {
    return (await kindsByRecipient(backend)).sort();
  }

  async function kindsByRecipient(backend: ContractBackend): Promise<[string, string[]][]> {
    return (await owed(backend)).map((row): [string, string[]] => [row.recipientId, row.notifications.map((notification) => notification.kind ?? "mention")]);
  }

  test(`${name}: a reply emails everyone else in the thread: who started it, replied, or was mentioned`, async () => {
    const backend = fresh();
    const { projectId, threadId, leeId, rileyId, danaId } = await discussion(backend, { replyEmails: true });
    // Lee's and Riley's replies in the setup already told the others.
    expect(await kinds(backend)).toEqual([[danaId, ["reply", "reply"]], [leeId, ["reply"]]].sort());
    const sam = reviewer("Sam");
    await backend.run((store) => ops.createThread(store, sam, { projectId, anchor, body: "Elsewhere", tags: [], capture: failed }));
    const samId = await idOf(backend, sam);
    // Dana mentions Sam, who joins the thread; Lee gets a reply email, Riley too.
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Sam have a look", revision: null, mentions: [mention(samId, "Sam")] }));
    expect(await kinds(backend)).toEqual(
      [
        [danaId, ["reply", "reply"]],
        [leeId, ["reply", "reply"]],
        [rileyId, ["reply"]],
        [samId, ["mention"]],
      ].sort(),
    );
    // Sam, now in the thread, hears about the next reply; its author never does.
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Done", revision: null }));
    const after = Object.fromEntries(await kindsByRecipient(backend));
    expect(after[samId]).toEqual(["mention", "reply"]);
    expect(after[leeId]).toEqual(["reply", "reply"]);
  });

  test(`${name}: reply emails can be turned off, or muted per project, without turning off mention emails`, async () => {
    const backend = fresh();
    const { projectId, threadId, leeId, rileyId } = await discussion(backend);
    await backend.run((store) => ops.setNotificationSettings(store, lee, { projectId, replyEmails: true }));
    await backend.run((store) => ops.setNotificationSettings(store, reviewer("Riley"), { projectId, replyEmails: true, projectMuted: true }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Fixed", revision: null }));
    // Lee wants reply emails; Riley muted the project; Dana, the author, is never told.
    expect(await kinds(backend)).toEqual([[leeId, ["reply"]]]);
    await backend.run((store) => ops.setNotificationSettings(store, lee, { projectId, replyEmails: false }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee still there?", revision: null, mentions: [mention(leeId, "Lee")] }));
    // Turning replies off leaves mentions on; and the reply already owed is no longer sent.
    expect(await kinds(backend)).toEqual([[leeId, ["reply", "mention"]]]);
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message.subject).toStartWith("Dana mentioned you");
    void rileyId;
  });

  test(`${name}: a thread from before reply emails learns who is in it from its discussion at its first reply`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const riley = reviewer("Riley");
    for (const who of [lee, riley]) await backend.run((store) => ops.requireUser(store, who));
    const [danaId, leeId, rileyId] = [await idOf(backend, dana), await idOf(backend, lee), await idOf(backend, riley)];
    const at = Date.now() - 60_000;
    // Saved before reply emails: no record of who is in it.
    const threadId = await backend.run(async (store) => {
      const id = await store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: at, lastMessageAt: at + 1, messageCount: 2 });
      await store.messages.insert({ threadId: id, authorId: danaId, body: "Old question", createdAt: at, editedAt: null, revision: null });
      await store.messages.insert({ threadId: id, authorId: leeId, body: "@Riley old answer", createdAt: at + 1, editedAt: null, revision: null, mentions: [{ userId: rileyId, label: "Riley" }] });
      return id;
    });
    expect((await backend.run((store) => store.threads.get(threadId)))!.followersReady).toBeUndefined();
    await backend.run((store) => ops.reply(store, riley, { threadId, body: "New answer", revision: null }));
    // Nothing is owed until the background job has read the discussion.
    expect(await backend.run((store) => store.deliveries.due(far(), 10))).toEqual([]);
    expect(await kinds(backend)).toEqual([[danaId, ["reply"]], [leeId, ["reply"]]].sort());
    expect((await backend.run((store) => store.threads.get(threadId)))!.followersReady).toBe(true);
    for (const id of [danaId, leeId, rileyId]) expect(await backend.run((store) => store.followers.find(threadId, id))).not.toBeNull();
  });

  test(`${name}: everyone in a thread gets reply emails, however many people are in it`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await discussion(backend, { replyEmails: true });
    const many = Array.from({ length: 260 }, (_, i) => reviewer(`Person ${i}`));
    const ids: string[] = [];
    for (const who of many) ids.push(await backend.run(async (store) => (await ops.requireUser(store, who))._id));
    // In the thread since its first messages.
    await backend.run((store) => notify.follow(store, threadId, ids, 1));
    void projectId;
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "For everyone", revision: null }));
    await settle(backend);
    const told = new Set(
      await backend.run(async (store) => {
        const recipients: string[] = [];
        for (const delivery of await store.deliveries.due(far(), 1_000)) {
          for (const notification of await store.notifications.forDelivery(delivery._id, 100)) {
            if (notification.kind === "reply") recipients.push(notification.recipientId);
          }
        }
        return recipients;
      }),
    );
    // All 260, past the first page of people, and the 201st among them.
    for (const id of ids) expect(told.has(id)).toBe(true);
    expect(told.has(await idOf(backend, lee))).toBe(true);
  });

  test(`${name}: editing a message to mention someone puts them in the thread`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend, { replyEmails: true });
    const sam = reviewer("Sam");
    const projectId = (await backend.run((store) => store.threads.get(threadId)))!.projectId;
    await backend.run((store) => ops.createThread(store, sam, { projectId, anchor, body: "Elsewhere", tags: [], capture: failed }));
    const samId = await idOf(backend, sam);
    const first = (await allMessages(backend, dana, threadId))[0]!;
    await backend.run((store) => ops.editMessage(store, dana, { messageId: first._id, body: "Department is wrong @Sam", mentions: [mention(samId, "Sam")] }));
    expect(await backend.run((store) => store.followers.find(threadId, samId))).not.toBeNull();
    void leeId;
  });

  test(`${name}: a reply written by a coding agent says so, in the thread, the export, and emails`, async () => {
    const backend = fresh();
    const { projectId, threadId, leeId } = await discussion(backend);
    await backend.run((store) => ops.setNotificationSettings(store, reviewer("Riley"), { projectId, replyEmails: true }));
    await expect(
      backend.run((store) => ops.reply(store, dana, { threadId, body: "x", revision: null, via: "robot" as "agent" })),
    ).rejects.toThrow("Unknown author kind");
    const messageId = await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee fixed in abc123; please check", revision: "abc123", mentions: [mention(leeId, "Lee")], via: "agent" }),
    );
    const viewed = await allMessages(backend, lee, threadId);
    expect(viewed.find((message) => message._id === messageId)).toMatchObject({ via: "agent", authorId: await idOf(backend, dana), revision: "abc123" });
    expect(viewed[0]!.via).toBeUndefined();
    const exported = await backend.run((store) => ops.exportThreads(store, lee, { projectId, threadIds: [threadId], threadIndex: 0 }, page));
    expect(exported.page.at(-1)).toMatchObject({ via: "agent" });
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const byRecipient = Object.fromEntries(sends.map((send) => [send.message.to, send.message]));
    // Lee was mentioned; Riley hears about the reply.
    expect(byRecipient["lee@example.com"]!.subject).toStartWith("Dana mentioned you");
    expect(byRecipient["riley@example.com"]!.subject).toBe("Dana replied: “Department is wrong” · Admin prototype");
    expect(byRecipient["riley@example.com"]!.text).toContain("Dana replied in a thread you're in on Admin prototype.");
    expect(byRecipient["riley@example.com"]!.text).toContain("Dana · via coding agent ·");
    expect(byRecipient["riley@example.com"]!.html).toContain("via coding agent");
    expect(byRecipient["riley@example.com"]!.text).toContain("Stop all Critiqs emails");
  });

  test(`${name}: several replies gather into one email that names who replied`, async () => {
    const backend = fresh();
    await discussion(backend, { replyEmails: true });
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const toDana = sends.find((send) => send.message.to === "dana@example.com")!.message;
    expect(toDana.subject).toBe("Lee and Riley replied: “Department is wrong” · Admin prototype");
    expect(toDana.html).toContain("<strong>Lee and Riley</strong> replied in a thread you're in on");
    expect(sends.find((send) => send.message.to === "lee@example.com")!.message.subject).toBe("Riley replied: “Department is wrong” · Admin prototype");
  });

  test(`${name}: an email isn't sent for kinds turned off after it was owed, even with its mention removed`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await discussion(backend, { replyEmails: true });
    // Dana is owed Lee's and Riley's replies; Lee's next reply also mentions her.
    const mentioned = await backend.run((store) =>
      ops.reply(store, lee, { threadId, body: "@Dana look", revision: null, mentions: [mention(danaId, "Dana")] }),
    );
    await backend.run((store) => ops.setNotificationSettings(store, dana, { projectId, replyEmails: false }));
    // The mention goes away before sending: only replies, which she turned off, remain.
    await backend.run((store) => ops.editMessage(store, lee, { messageId: mentioned, body: "look", mentions: [] }));
    const { sends, skipped } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(sends.filter((send) => send.message.to === "dana@example.com")).toEqual([]);
    expect(skipped.map((row) => row.reason)).toContain("The mention was removed.");
  });

  test(`${name}: an edit that mentions someone already owed that reply adds a mention, and keeps the reply`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await discussion(backend, { replyEmails: true });
    // Dana is owed Lee's reply, then turns reply emails off but keeps mentions.
    const owedReply = await backend.run((store) => ops.reply(store, lee, { threadId, body: "And this", revision: null }));
    await settle(backend);
    await backend.run((store) => ops.setNotificationSettings(store, dana, { projectId, replyEmails: false }));
    await backend.run((store) => ops.editMessage(store, lee, { messageId: owedReply, body: "@Dana and this", mentions: [mention(danaId, "Dana")] }));
    const kindsFor = async () =>
      (await owed(backend))
        .filter((row) => row.recipientId === danaId)
        .flatMap((row) => row.notifications.filter((notification) => notification.messageId === owedReply).map((notification) => notification.kind ?? "mention"))
        .sort();
    expect(await kindsFor()).toEqual(["mention", "reply"]);
    // Mentioning her again in another edit adds nothing.
    await backend.run((store) => ops.editMessage(store, lee, { messageId: owedReply, body: "@Dana and this, again", mentions: [mention(danaId, "Dana")] }));
    expect(await kindsFor()).toEqual(["mention", "reply"]);
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    expect(sends.find((send) => send.message.to === "dana@example.com")?.message.subject).toStartWith("Lee mentioned you");
  });

  test(`${name}: a mention added and removed again before sending still leaves the reply email it was owed`, async () => {
    const backend = fresh();
    const { threadId, danaId } = await discussion(backend, { replyEmails: true });
    const reply = await backend.run((store) => ops.reply(store, lee, { threadId, body: "Changed it", revision: null }));
    await backend.run((store) => ops.editMessage(store, lee, { messageId: reply, body: "@Dana changed it", mentions: [mention(danaId, "Dana")] }));
    await backend.run((store) => ops.editMessage(store, lee, { messageId: reply, body: "Changed it", mentions: [] }));
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const toDana = sends.find((send) => send.message.to === "dana@example.com");
    expect(toDana?.message.subject).toBe("Lee and Riley replied: “Department is wrong” · Admin prototype");
    expect(toDana?.message.text).toContain("Changed it");
  });

  test(`${name}: people are found by their exact name, so a name two people share is never guessed`, async () => {
    const backend = fresh();
    const { projectId } = await discussion(backend);
    const otherLee = { ...reviewer("Lee"), tokenIdentifier: "https://auth.example|lee-two", email: "lee.two@example.com" };
    await backend.run((store) => ops.createThread(store, otherLee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    // Newer participants whose names contain "Lee" don't hide either Lee.
    for (const name of ["Leela", "Lee Ann", "Kalee", "Leeroy", "Ashlee", "Leeds", "Haylee", "Lee Two"]) {
      await backend.run((store) => ops.createThread(store, reviewer(name), { projectId, anchor, body: "Hi", tags: [], capture: failed }));
    }
    const named = await backend.run((store) => ops.listParticipantsNamed(store, dana, { projectId, name: " lee " }));
    expect(named.complete).toBe(true);
    expect(named.people.map((person) => person.name)).toEqual(["Lee", "Lee"]);
    expect((await backend.run((store) => ops.listParticipantsNamed(store, dana, { projectId, name: "Riley" }))).people).toHaveLength(1);
    expect((await backend.run((store) => ops.listParticipantsNamed(store, dana, { projectId, name: "Zed" }))).people).toEqual([]);
    // Names and pictures only, never email addresses.
    expect(JSON.stringify(named)).not.toContain("@example.com");
  });

  test(`${name}: a mention past a full email starts a new one, so it isn't lost when replies are turned off`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await discussion(backend, { replyEmails: true });
    // Dana's email gathers Lee's and Riley's replies; 48 more fill it to 50.
    const replies: string[] = [];
    for (let i = 0; i < 48; i++) replies.push(await backend.run((store) => ops.reply(store, lee, { threadId, body: `Note ${i}`, revision: null })));
    await settle(backend);
    await backend.run((store) => ops.editMessage(store, lee, { messageId: replies[10]!, body: "@Dana note 10", mentions: [mention(danaId, "Dana")] }));
    const forDana = (await owed(backend)).filter((row) => row.recipientId === danaId);
    expect(forDana.map((row) => row.notifications.length).sort()).toEqual([1, 50]);
    await backend.run((store) => ops.setNotificationSettings(store, dana, { projectId, replyEmails: false }));
    const { sends } = await sendDue(backend, Date.now() + notify.GATHER_MS + 60_000);
    const toDana = sends.filter((send) => send.message.to === "dana@example.com");
    expect(toDana.map((send) => send.message.subject)).toEqual(["Lee mentioned you: “Department is wrong” · Admin prototype"]);
  });

  test(`${name}: a retry is sent only for kinds still wanted and still true`, async () => {
    const backend = fresh();
    const { projectId, threadId, danaId } = await discussion(backend, { replyEmails: true });
    await settle(backend);
    // Dana is owed Lee's reply both as a reply and as a mention, in one email.
    const both = await backend.run((store) => ops.reply(store, lee, { threadId, body: "@Dana look", revision: null, mentions: [mention(danaId, "Dana")] }));
    let now = Date.now() + notify.GATHER_MS + 60_000;
    const first = await sendDue(backend, now);
    const toDana = first.sends.find((send) => send.message.to === "dana@example.com")!;
    // Its first send fails; then she turns reply emails off and the mention is removed.
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: toDana.deliveryId, claimToken: "worker", result: "failed", reason: "Down" }], now));
    await backend.run((store) => ops.setNotificationSettings(store, dana, { projectId, replyEmails: false }));
    await backend.run((store) => ops.editMessage(store, lee, { messageId: both, body: "look", mentions: [] }));
    now += 2 * 60 * 60_000;
    const retry = await sendDue(backend, now);
    // The reply notice no longer counts (replies are off) and the mention is gone: nothing is sent.
    expect(retry.sends.filter((send) => send.message.to === "dana@example.com")).toEqual([]);
    expect(retry.skipped.map((row) => row.reason)).toContain("The mention was removed.");
  });

  test(`${name}: reading an older thread doesn't move back when someone mentioned later by an edit joined`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const riley = reviewer("Riley");
    const sam = reviewer("Sam");
    for (const who of [lee, riley, sam]) await backend.run((store) => ops.requireUser(store, who));
    await backend.run((store) => ops.createThread(store, sam, { projectId, anchor, body: "Elsewhere", tags: [], capture: failed }));
    const [danaId, leeId, samId] = [await idOf(backend, dana), await idOf(backend, lee), await idOf(backend, sam)];
    const at = Date.now() - 60_000;
    const { threadId, first } = await backend.run(async (store) => {
      const id = await store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: at, lastMessageAt: at, messageCount: 1 });
      const message = await store.messages.insert({ threadId: id, authorId: danaId, body: "Old question", createdAt: at, editedAt: null, revision: null });
      return { threadId: id, first: message };
    });
    // Lee's reply is queued; before the job reads the thread, Dana's first comment is edited to mention Sam.
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Answer", revision: null }));
    await backend.run((store) => ops.editMessage(store, dana, { messageId: first, body: "Old question @Sam", mentions: [mention(samId, "Sam")] }));
    const told = new Map(await kindsByRecipient(backend));
    // Sam joined after Lee's reply, so is told only of the edit's mention; Dana, there from the start, hears the reply.
    expect(told.get(danaId)).toEqual(["reply"]);
    expect(told.get(samId)).toEqual(["mention"]);
    expect((await backend.run((store) => store.followers.find(threadId, samId)))!.since).toBe(2);
    void leeId;
  });

  test(`${name}: someone mentioned by an edit hears about the very next reply, even within the same millisecond`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await discussion(backend, { replyEmails: true });
    const sam = reviewer("Sam");
    await backend.run((store) => ops.createThread(store, sam, { projectId, anchor, body: "Elsewhere", tags: [], capture: failed }));
    const samId = await idOf(backend, sam);
    const first = (await allMessages(backend, dana, threadId))[0]!;
    setSystemTime(new Date("2026-11-09T12:00:00Z"));
    await backend.run((store) => ops.editMessage(store, dana, { messageId: first._id, body: "Department is wrong @Sam", mentions: [mention(samId, "Sam")] }));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Same moment", revision: null }));
    setSystemTime();
    expect((await kindsByRecipient(backend)).find(([id]) => id === samId)?.[1]).toEqual(expect.arrayContaining(["reply"]));
  });

  test(`${name}: finished emails are removed after a month`, async () => {
    const backend = fresh();
    const { threadId, leeId } = await discussion(backend);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee", revision: null, mentions: [mention(leeId, "Lee")] }));
    const now = Date.now() + notify.GATHER_MS + 60_000;
    const { ids } = await sendDue(backend, now);
    await backend.run((store) => notify.completeDeliveries(store, [{ deliveryId: ids[0]!, claimToken: "worker", result: "sent" }], now));
    expect(await backend.run((store) => notify.cleanUpDeliveries(store, now + 29 * 24 * 60 * 60_000, 100))).toBe(0);
    expect(await backend.run((store) => notify.cleanUpDeliveries(store, now + 31 * 24 * 60 * 60_000, 100))).toBe(1);
    expect(await backend.run((store) => store.deliveries.get(ids[0]!))).toBeNull();
  });

  // Plans and limits

  const planWith = (...limits: Limit[]): Record<string, Plan> => ({ free: { name: "free", label: "Free", limits } });

  // Organizations

  async function access(backend: ContractBackend, who: Identity, projectId: string) {
    const info = await backend.run((store) => ops.getProject(store, who, { projectId }));
    const tags = await backend.run((store) => ops.listTags(store, who, { projectId }));
    return { isOwner: info.isOwner, organization: info.organization, canOrganize: tags.canOrganize };
  }

  async function join(backend: ContractBackend, who: Identity, organizationId: string, role: "admin" | "member") {
    return await backend.run(async (store) => {
      const user = await ops.requireUser(store, who);
      return await store.memberships.insert({ organizationId, userId: user._id, role, createdAt: Date.now() });
    });
  }

  async function storedBeforeOrganizations(backend: ContractBackend, who: Identity, plan?: string) {
    return await backend.run(async (store) => {
      const userId = await store.users.insert({ tokenIdentifier: who.tokenIdentifier, name: who.name!, email: who.email, imageUrl: null });
      if (plan !== undefined) await store.users.patch(userId, { plan });
      const projectId = await store.projects.insert({ name: "From before", tags: [], createdBy: userId, createdAt: Date.now() });
      return { userId, projectId };
    });
  }

  test(`${name}: an organization's admins, and a project's creator while still a member, manage the project; no one else does`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const own = await access(backend, dana, projectId);
    expect(own).toEqual({ isOwner: true, organization: { id: expect.any(String), name: "Dana's organization", role: "admin" }, canOrganize: true });
    const organizationId = own.organization!.id;
    expect(await access(backend, lee, projectId)).toEqual({ isOwner: false, organization: undefined, canOrganize: false });
    const setReviewUrl = (who: Identity) => backend.run((store) => ops.setReviewUrl(store, who, { projectId, reviewUrl: "https://proto.example" }));
    await expect(setReviewUrl(lee)).rejects.toThrow("Only the person who set up this project can change it.");

    const leeMembership = await join(backend, lee, organizationId, "member");
    expect(await access(backend, lee, projectId)).toEqual({ isOwner: false, organization: { id: organizationId, name: "Dana's organization", role: "member" }, canOrganize: false });
    await expect(backend.run((store) => ops.getUsage(store, lee, { projectId }))).rejects.toThrow("Only the person who set up");
    await backend.run((store) => store.memberships.patch(leeMembership, { role: "admin" }));
    expect(await access(backend, lee, projectId)).toMatchObject({ isOwner: true, canOrganize: true });
    await setReviewUrl(lee);

    const danaMembership = (await backend.run(async (store) => store.memberships.find(organizationId, (await ops.requireUser(store, dana))._id)))!;
    await backend.run((store) => store.memberships.patch(danaMembership._id, { role: "member" }));
    expect(await access(backend, dana, projectId)).toMatchObject({ isOwner: true, organization: { role: "member" } });
    await backend.run((store) => store.memberships.delete(danaMembership._id));
    expect(await access(backend, dana, projectId)).toEqual({ isOwner: false, organization: undefined, canOrganize: false });
    await expect(setReviewUrl(dana)).rejects.toThrow("Only the person who set up");
  });

  test(`${name}: projects count against their organization's plan, and each person lists their organizations`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "projects", period: "total", max: 2 }));
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "One" }));
    const { organization } = await access(backend, dana, projectId);
    await join(backend, lee, organization!.id, "admin");
    await backend.run((store) => ops.createProject(store, lee, { name: "Lee's" }));
    expect(await backend.run((store) => ops.getUsage(store, lee, { projectId }))).toMatchObject({
      plan: "Free",
      rows: [{ metric: "projects", period: "total", used: 1, max: 2 }],
    });
    await backend.run((store) => ops.createProject(store, dana, { name: "Two" }));
    await expect(backend.run((store) => ops.createProject(store, dana, { name: "Three" }))).rejects.toThrow("Free plan's limit of 2 projects");
    await backend.run((store) => ops.createProject(store, lee, { name: "Lee's two" }));
    expect(await backend.run((store) => organizations.listMyOrganizations(store, lee))).toEqual([
      { id: organization!.id, name: "Dana's organization", role: "admin", plan: "Free", home: false },
      { id: expect.any(String), name: "Lee's organization", role: "admin", plan: "Free", home: true },
    ]);
    expect(await backend.run((store) => organizations.listMyOrganizations(store, reviewer("Riley")))).toEqual([]);
    await expect(backend.run((store) => organizations.listMyOrganizations(store, null))).rejects.toThrow("Sign in");
  });

  test(`${name}: operators move an organization to another plan, named or found by one of its projects`, async () => {
    const backend = fresh().withPlans({
      ...planWith({ metric: "threads", period: "total", max: 1 }),
      team: { name: "team", label: "Team", limits: [] },
    });
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "One" }));
    const leeProject = await backend.run((store) => ops.createProject(store, lee, { name: "Lee's" }));
    const organizationId = (await access(backend, dana, projectId)).organization!.id;
    const assign = (args: { organizationId?: string; projectId?: string; plan: string }) =>
      backend.run((store) => organizations.assignPlan(store, args, Date.now()));
    await expect(assign({ projectId, plan: "gold" })).rejects.toThrow('There is no plan named "gold"');
    await expect(assign({ plan: "team" })).rejects.toThrow("Name the organization");
    await expect(assign({ organizationId, projectId: leeProject, plan: "team" })).rejects.toThrow("belongs to another organization");
    await assign({ organizationId, plan: "team" });
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId })))!.plan).toBe("Team");
    expect((await backend.run((store) => organizations.listMyOrganizations(store, lee))).map((one) => one.plan)).toEqual(["Free"]);
    await assign({ projectId, plan: "free" });
    expect((await backend.run((store) => organizations.listMyOrganizations(store, dana))).map((one) => one.plan)).toEqual(["Free"]);
  });

  test(`${name}: until it is moved, a project from before organizations keeps its creator's access, plan, and usage`, async () => {
    const backend = fresh().withPlans({
      ...planWith({ metric: "projects", period: "total", max: 1 }),
      team: {
        name: "team",
        label: "Team",
        limits: [
          { metric: "projects", period: "total", max: 3 },
          { metric: "threads", period: "total", max: 5 },
          { metric: "captureBytes", period: "total", max: 1_000 },
        ],
      },
    });
    const { userId, projectId } = await storedBeforeOrganizations(backend, dana, "team");
    await backend.run((store) => store.usage.insert({ key: usageKey("projects", "total", userId, utcDay(Date.now())), count: 2 }));
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Before", tags: [], capture: failed }));
    const fileId = await backend.saveFile("image/png", 64);
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Image", tags: [], capture: { status: "captured", fileId } }));
    const usage: ProjectUsage = {
      plan: "Team",
      rows: [
        { metric: "projects", period: "total", used: 2, max: 3 },
        { metric: "threads", period: "total", used: 2, max: 5 },
        { metric: "captureBytes", period: "total", used: 64, max: 1_000 },
      ],
    };

    expect(await access(backend, dana, projectId)).toEqual({ isOwner: true, organization: undefined, canOrganize: true });
    expect(await access(backend, lee, projectId)).toMatchObject({ isOwner: false, organization: undefined });
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId }))).toMatchObject(usage);
    expect(await backend.run((store) => organizations.listMyOrganizations(store, dana))).toEqual([]);

    expect(await backend.run((store) => organizations.adoptProject(store, projectId, Date.now()))).toBe(true);
    expect(await backend.run((store) => organizations.adoptProject(store, projectId, Date.now()))).toBe(false);
    const movedTo = (await backend.run((store) => store.projects.get(projectId)))!.organizationId!;
    expect(await access(backend, dana, projectId)).toEqual({ isOwner: true, organization: { id: movedTo, name: "Dana's organization", role: "admin" }, canOrganize: true });
    expect(await access(backend, lee, projectId)).toMatchObject({ isOwner: false, organization: undefined });
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId }))).toMatchObject(usage);
    expect(await backend.run((store) => organizations.listMyOrganizations(store, dana))).toEqual([
      { id: movedTo, name: "Dana's organization", role: "admin", plan: "Team", home: true },
    ]);
    await backend.run((store) => ops.createProject(store, dana, { name: "Third" }));
    await expect(backend.run((store) => ops.createProject(store, dana, { name: "Fourth" }))).rejects.toThrow("Team plan's limit of 3 projects");
  });

  test(`${name}: someone from before organizations who sets up a project gets a home organization with their plan and project count`, async () => {
    const backend = fresh().withPlans({
      ...planWith({ metric: "projects", period: "total", max: 1 }),
      team: { name: "team", label: "Team", limits: [{ metric: "projects", period: "total", max: 3 }] },
    });
    const { userId, projectId: before } = await storedBeforeOrganizations(backend, dana, "team");
    await backend.run((store) => store.usage.insert({ key: usageKey("projects", "total", userId, utcDay(Date.now())), count: 2 }));
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "New" }));
    await expect(backend.run((store) => ops.createProject(store, dana, { name: "Newer" }))).rejects.toThrow("Team plan's limit of 3 projects");
    const { organization } = await access(backend, dana, projectId);
    expect(await access(backend, dana, before)).toEqual({ isOwner: true, organization, canOrganize: true });
    await backend.run((store) => organizations.assignPlan(store, { projectId: before, plan: "free" }, Date.now()));
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId })))!.plan).toBe("Free");
  });

  test(`${name}: someone whose plan was set before organizations keeps it in a home organization`, async () => {
    const backend = fresh().withPlans({ ...planWith(), team: { name: "team", label: "Team", limits: [] } });
    const userId = await backend.run(async (store) => {
      const id = await store.users.insert({ tokenIdentifier: dana.tokenIdentifier, name: "Dana", email: dana.email, imageUrl: null });
      await store.users.patch(id, { plan: "team" });
      return id;
    });
    const user = async () => (await backend.run((store) => store.users.get(userId)))!;
    const adopt = () => backend.run((store) => organizations.adoptPlan(store, userId, Date.now()));
    expect((await backend.run((store) => organizations.personalQuota(store, userId))).plan!.label).toBe("Team");
    expect(await adopt()).toBe(true);
    expect(await adopt()).toBe(false);
    expect((await backend.run((store) => organizations.personalQuota(store, userId))).plan!.label).toBe("Team");
    expect(await backend.run((store) => organizations.listMyOrganizations(store, dana))).toEqual([
      { id: (await user()).homeOrganizationId!, name: "Dana's organization", role: "admin", plan: "Team", home: true },
    ]);
  });

  test(`${name}: someone removed from their home organization sets up projects and uses Critiqs AI under a new one on the default plan`, async () => {
    const backend = fresh().withPlans({
      ...planWith({ metric: "projects", period: "total", max: 2 }),
      team: { name: "team", label: "Team", limits: [{ metric: "projects", period: "total", max: 3 }] },
    });
    const { userId } = await storedBeforeOrganizations(backend, dana, "team");
    await backend.run((store) => store.usage.insert({ key: usageKey("projects", "total", userId, utcDay(Date.now())), count: 2 }));
    const first = await backend.run((store) => ops.createProject(store, dana, { name: "First" }));
    const home = (await access(backend, dana, first)).organization!;
    await join(backend, lee, home.id, "admin");
    const danaMembership = (await backend.run((store) => store.memberships.find(home.id, userId)))!;
    await backend.run((store) => store.memberships.delete(danaMembership._id));
    expect((await backend.run((store) => organizations.personalQuota(store, userId))).plan!.label).toBe("Free");

    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "After" }));
    const moved = await access(backend, dana, projectId);
    expect(moved).toEqual({ isOwner: true, organization: { id: expect.any(String), name: "Dana's organization", role: "admin" }, canOrganize: true });
    expect(moved.organization!.id).not.toBe(home.id);
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId }))).toMatchObject({
      plan: "Free",
      rows: [{ metric: "projects", period: "total", used: 1, max: 2 }],
    });
    expect((await backend.run((store) => ops.getUsage(store, lee, { projectId: first })))!.rows[0]!.used).toBe(3);
    expect((await backend.run((store) => organizations.personalQuota(store, userId))).plan!.label).toBe("Free");
    expect(await backend.run((store) => organizations.listMyOrganizations(store, dana))).toEqual([
      { id: moved.organization!.id, name: "Dana's organization", role: "admin", plan: "Free", home: true },
    ]);
  });

  test(`${name}: a stored person keeps their plan and home organization`, async () => {
    const backend = fresh();
    const stored = await backend.run(async (store) => {
      const leeId = await store.users.insert({ tokenIdentifier: lee.tokenIdentifier, name: "Lee", email: lee.email, imageUrl: null });
      const organizationId = await store.organizations.insert({ name: "Lee's organization", createdBy: leeId, createdAt: 1 });
      const userId = await store.users.insert({ tokenIdentifier: dana.tokenIdentifier, name: "Dana", email: dana.email, imageUrl: null, plan: "team", homeOrganizationId: organizationId });
      return { organizationId, user: await store.users.get(userId) };
    });
    expect(stored.user).toMatchObject({ plan: "team", homeOrganizationId: stored.organizationId });
  });


  // Organization members and invites

  /** Dana's home organization, made by her first project, and that project. */
  async function danasOrganization(backend: ContractBackend) {
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/admin" }));
    const organizationId = (await access(backend, dana, projectId)).organization!.id;
    return { projectId, organizationId };
  }

  const details = (backend: ContractBackend, who: Identity, organizationId: string) =>
    backend.run((store) => organizations.getOrganization(store, who, { organizationId }));
  const invite = (backend: ContractBackend, who: Identity, organizationId: string, email: string, role: "admin" | "member" = "member") =>
    backend.run((store) => organizations.inviteMember(store, who, { organizationId, email, role }, Date.now()));
  const signIn = (backend: ContractBackend, who: Identity) => backend.run((store) => ops.syncReviewer(store, who));
  const claimEmail = (backend: ContractBackend, inviteId: string, now = Date.now(), projectId?: string) =>
    backend.run((store) => organizations.claimInviteEmail(store, { inviteId, ...(projectId === undefined ? {} : { projectId }) }, now));
  const invited = (result: organizations.InviteResult) => {
    if (result.status !== "invited") throw new Error(`Expected a new invite, got ${result.status}`);
    return result.inviteId;
  };
  const roles = async (backend: ContractBackend, organizationId: string) =>
    (await details(backend, dana, organizationId).catch(() => details(backend, lee, organizationId))).members.map((member) => [member.name, member.role]);

  test(`${name}: an admin invites by email; inviting a member or someone already invited changes nothing`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    expect(await invite(backend, dana, organizationId, "  LEE@Example.com ")).toEqual({ status: "invited", inviteId: expect.any(String) });
    expect(await invite(backend, dana, organizationId, "lee@example.com", "admin")).toEqual({ status: "pending" });
    expect((await details(backend, dana, organizationId)).invites).toEqual([
      { _id: expect.any(String), email: "lee@example.com", role: "member", invitedBy: "Dana", createdAt: expect.any(Number) },
    ]);
    await signIn(backend, lee);
    expect(await invite(backend, dana, organizationId, "Lee@example.com")).toEqual({ status: "member" });
    expect(await invite(backend, dana, organizationId, "dana@example.com")).toEqual({ status: "member" });
    expect((await details(backend, dana, organizationId)).invites).toEqual([]);
    await expect(invite(backend, dana, organizationId, "not an address")).rejects.toThrow("Enter a valid email address");
  });

  test(`${name}: only admins invite, rename, withdraw invites, and change members`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    await invite(backend, dana, organizationId, "lee@example.com");
    await signIn(backend, lee);
    const leeId = await idOf(backend, lee);
    const danaId = await idOf(backend, dana);
    const pending = await invite(backend, dana, organizationId, "riley@example.com");
    const inviteId = pending.status === "invited" ? pending.inviteId : "";
    const onlyAdmins = "Only an organization's admins";
    await expect(invite(backend, lee, organizationId, "sam@example.com")).rejects.toThrow(onlyAdmins);
    await expect(backend.run((store) => organizations.renameOrganization(store, lee, { organizationId, name: "Lee's now" }))).rejects.toThrow(onlyAdmins);
    await expect(backend.run((store) => organizations.revokeInvite(store, lee, { inviteId }))).rejects.toThrow("already accepted or withdrawn");
    await expect(backend.run((store) => organizations.setMemberRole(store, lee, { organizationId, userId: leeId, role: "admin" }))).rejects.toThrow(onlyAdmins);
    await expect(backend.run((store) => organizations.removeMember(store, lee, { organizationId, userId: danaId }))).rejects.toThrow(onlyAdmins);
    // Someone outside the organization can't even see it.
    const riley = reviewer("Riley");
    await expect(details(backend, riley, organizationId)).rejects.toThrow("aren't in it");
    await expect(invite(backend, riley, organizationId, "sam@example.com")).rejects.toThrow("aren't in it");
    const withdraw = (who: Identity, id: string) => backend.run((store) => organizations.revokeInvite(store, who, { inviteId: id })).catch((error: Error) => error.message);
    expect(await withdraw(riley, inviteId)).toBe(await withdraw(riley, "not-an-id"));
    expect(await withdraw(lee, inviteId)).toBe(await withdraw(riley, "not-an-id"));
    expect((await details(backend, dana, organizationId)).invites.map((pending) => pending.email)).toEqual(["riley@example.com"]);
    expect(await roles(backend, organizationId)).toEqual([
      ["Dana", "admin"],
      ["Lee", "member"],
    ]);
  });

  test(`${name}: members see who is in the organization; only admins see addresses and pending invites`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    await invite(backend, dana, organizationId, "lee@example.com");
    await signIn(backend, lee);
    await invite(backend, dana, organizationId, "riley@example.com", "admin");
    const asMember = await details(backend, lee, organizationId);
    expect(asMember).toEqual({
      id: organizationId,
      name: "Dana's organization",
      role: "member",
      plan: null,
      members: [
        { userId: expect.any(String), name: "Dana", imageUrl: null, email: null, role: "admin", you: false },
        { userId: expect.any(String), name: "Lee", imageUrl: null, email: null, role: "member", you: true },
      ],
      invites: [],
    });
    const asAdmin = await details(backend, dana, organizationId);
    expect(asAdmin.members.map((member) => [member.email, member.you])).toEqual([
      ["dana@example.com", true],
      ["lee@example.com", false],
    ]);
    expect(asAdmin.invites.map((pending) => [pending.email, pending.role])).toEqual([["riley@example.com", "admin"]]);
  });

  test(`${name}: an invited person joins with the invited role when they sign in with that address, once`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    // Lee already uses Critiqs; Riley has never signed in.
    await signIn(backend, lee);
    await invite(backend, dana, organizationId, "lee@example.com");
    await invite(backend, dana, organizationId, "RILEY@example.com", "admin");
    await expect(details(backend, lee, organizationId)).rejects.toThrow("aren't in it");
    await signIn(backend, lee);
    await signIn(backend, lee);
    const riley = reviewer("Riley");
    await signIn(backend, riley);
    expect(await roles(backend, organizationId)).toEqual([
      ["Dana", "admin"],
      ["Lee", "member"],
      ["Riley", "admin"],
    ]);
    expect(await backend.run((store) => organizations.listMyOrganizations(store, riley))).toEqual([
      { id: organizationId, name: "Dana's organization", role: "admin", plan: null, home: false },
    ]);
    expect((await details(backend, dana, organizationId)).invites).toEqual([]);
    // Someone signing in with another address joins nothing.
    expect(await backend.run((store) => organizations.listMyOrganizations(store, reviewer("Sam")))).toEqual([]);
  });

  test(`${name}: a withdrawn invite lets no one join`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    const sent = await invite(backend, dana, organizationId, "lee@example.com");
    const inviteId = sent.status === "invited" ? sent.inviteId : "";
    await backend.run((store) => organizations.revokeInvite(store, dana, { inviteId }));
    await expect(backend.run((store) => organizations.revokeInvite(store, dana, { inviteId }))).rejects.toThrow("already accepted or withdrawn");
    expect(await claimEmail(backend, inviteId)).toBeNull();
    await signIn(backend, lee);
    expect(await backend.run((store) => organizations.listMyOrganizations(store, lee))).toEqual([]);
    expect((await details(backend, dana, organizationId)).invites).toEqual([]);
  });

  test(`${name}: an organization always keeps an admin; anyone else may be demoted, removed, or leave`, async () => {
    const backend = fresh();
    const { projectId, organizationId } = await danasOrganization(backend);
    await invite(backend, dana, organizationId, "lee@example.com");
    await signIn(backend, lee);
    const danaId = await idOf(backend, dana);
    const leeId = await idOf(backend, lee);
    const setRole = (who: Identity, userId: string, role: "admin" | "member") =>
      backend.run((store) => organizations.setMemberRole(store, who, { organizationId, userId, role }));
    const remove = (who: Identity, userId: string) => backend.run((store) => organizations.removeMember(store, who, { organizationId, userId }));
    const lastAdmin = "needs at least one admin";
    await expect(setRole(dana, danaId, "member")).rejects.toThrow(lastAdmin);
    await expect(remove(dana, danaId)).rejects.toThrow(lastAdmin);

    await setRole(dana, leeId, "admin");
    await setRole(dana, leeId, "admin");
    expect(await access(backend, lee, projectId)).toMatchObject({ isOwner: true, organization: { role: "admin" } });
    await setRole(lee, danaId, "member");
    await expect(setRole(lee, leeId, "member")).rejects.toThrow(lastAdmin);
    await expect(remove(lee, leeId)).rejects.toThrow(lastAdmin);
    expect(await roles(backend, organizationId)).toEqual([
      ["Dana", "member"],
      ["Lee", "admin"],
    ]);

    // Dana leaves; the project she created stays, and her next project makes her a new home organization.
    await remove(dana, danaId);
    expect(await roles(backend, organizationId)).toEqual([["Lee", "admin"]]);
    expect(await access(backend, dana, projectId)).toEqual({ isOwner: false, organization: undefined, canOrganize: false });
    expect(await access(backend, lee, projectId)).toMatchObject({ isOwner: true });
    expect(await backend.run((store) => organizations.listMyOrganizations(store, dana))).toEqual([]);
    const next = await backend.run((store) => ops.createProject(store, dana, { name: "Next" }));
    const home = (await access(backend, dana, next)).organization!;
    expect(home).toEqual({ id: expect.any(String), name: "Dana's organization", role: "admin" });
    expect(home.id).not.toBe(organizationId);
    // An admin removes a member, who loses access to the organization.
    await invite(backend, lee, organizationId, "riley@example.com");
    const riley = reviewer("Riley");
    await signIn(backend, riley);
    await remove(lee, await idOf(backend, riley));
    await expect(details(backend, riley, organizationId)).rejects.toThrow("aren't in it");
    await expect(remove(lee, danaId)).rejects.toThrow("isn't in this organization");
  });

  test(`${name}: admins rename the organization`, async () => {
    const backend = fresh();
    const { projectId, organizationId } = await danasOrganization(backend);
    const rename = (name: string) => backend.run((store) => organizations.renameOrganization(store, dana, { organizationId, name }));
    await rename("  Acme design  ");
    expect((await access(backend, dana, projectId)).organization!.name).toBe("Acme design");
    await expect(rename("   ")).rejects.toThrow("needs a name");
    await expect(rename("x".repeat(81))).rejects.toThrow("at most 80 characters");
    await expect(rename("Acme\u0000design")).rejects.toThrow("can't contain");
    await expect(rename("Acme\u001b[2Jdesign")).rejects.toThrow("can't contain");
    await rename(" Acme \n\t design ");
    expect((await details(backend, dana, organizationId)).name).toBe("Acme design");
  });

  test(`${name}: a new project goes in the organization chosen, only one the person belongs to, and otherwise their home`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    await invite(backend, dana, organizationId, "lee@example.com");
    await signIn(backend, lee);
    const create = (who: Identity, chosen?: string) =>
      backend.run((store) => ops.createProject(store, who, { name: "Lee's prototype", ...(chosen === undefined ? {} : { organizationId: chosen }) }));
    const inDanas = await create(lee, organizationId);
    expect((await access(backend, lee, inDanas)).organization).toEqual({ id: organizationId, name: "Dana's organization", role: "member" });
    // The creator manages it, and so do the organization's admins.
    expect(await access(backend, lee, inDanas)).toMatchObject({ isOwner: true });
    expect(await access(backend, dana, inDanas)).toMatchObject({ isOwner: true });
    const inHome = await create(lee);
    const leeHome = (await access(backend, lee, inHome)).organization!;
    expect(leeHome).toEqual({ id: expect.any(String), name: "Lee's organization", role: "admin" });
    expect((await backend.run((store) => organizations.listMyOrganizations(store, lee))).map((one) => [one.name, one.home])).toEqual([
      ["Dana's organization", false],
      ["Lee's organization", true],
    ]);
    const refused = "only in organizations you belong to";
    await expect(create(reviewer("Riley"), organizationId)).rejects.toThrow(refused);
    await expect(create(dana, leeHome.id)).rejects.toThrow(refused);
    await expect(create(dana, "not-an-id")).rejects.toThrow(refused);
  });

  test(`${name}: an organization sends a limited number of invites a day`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    for (let index = 0; index < organizations.MAX_INVITES_PER_DAY; index++) await invite(backend, dana, organizationId, `person${index}@example.com`);
    await expect(invite(backend, dana, organizationId, "one-more@example.com")).rejects.toThrow(`sent ${organizations.MAX_INVITES_PER_DAY} invites today`);
    // Inviting someone already invited doesn't count.
    expect(await invite(backend, dana, organizationId, "person0@example.com")).toEqual({ status: "pending" });
  });

  async function ownOrganization(backend: ContractBackend, admin: Identity) {
    const projectId = await backend.run((store) => ops.createProject(store, admin, { name: "Prototype" }));
    return (await access(backend, admin, projectId)).organization!.id;
  }

  test(`${name}: an address gets a limited number of invite emails a day, but can always be invited`, async () => {
    const backend = fresh();
    const { organizationId } = await danasOrganization(backend);
    const mallory = reviewer("Mallory");
    const theirs = await ownOrganization(backend, mallory);
    for (let index = 0; index < organizations.MAX_INVITE_EMAILS_PER_INBOX; index++) {
      const inviteId = invited(await invite(backend, mallory, theirs, "lee@example.com"));
      expect(await claimEmail(backend, inviteId)).not.toBeNull();
      await backend.run((store) => organizations.revokeInvite(store, mallory, { inviteId }));
    }
    const inviteId = invited(await invite(backend, dana, organizationId, "lee@example.com"));
    expect(await claimEmail(backend, inviteId)).toBeNull();
    await signIn(backend, lee);
    expect(await roles(backend, organizationId)).toEqual([
      ["Dana", "admin"],
      ["Lee", "member"],
    ]);
  });

  test(`${name}: other spellings of an address share its invite emails, and an invite keeps the spelling given`, async () => {
    const backend = fresh();
    const spellings = ["sam+one@gmail.com", "S.A.M@gmail.com", "sam@googlemail.com", "s.am+two@googlemail.com", "SAM+x@gmail.com"];
    expect(spellings).toHaveLength(organizations.MAX_INVITE_EMAILS_PER_INBOX);
    for (const [index, spelling] of [...spellings, "sam@gmail.com"].entries()) {
      const admin = reviewer(`Admin${index}`);
      const organizationId = await ownOrganization(backend, admin);
      const inviteId = invited(await invite(backend, admin, organizationId, spelling));
      expect((await details(backend, admin, organizationId)).invites.map((pending) => pending.email)).toEqual([spelling.toLowerCase()]);
      const email = await claimEmail(backend, inviteId);
      if (index < spellings.length) expect(email?.to).toBe(spelling.toLowerCase());
      else expect(email).toBeNull();
    }
    const admin = reviewer("Other");
    const organizationId = await ownOrganization(backend, admin);
    expect(await claimEmail(backend, invited(await invite(backend, admin, organizationId, "s.am@example.com")))).not.toBeNull();
    for (const odd of ["sam@example.com.", "s..am@example.com", "sam@example..com", "lee.@example.com"]) {
      await expect(invite(backend, admin, organizationId, odd)).rejects.toThrow("Enter a valid email address");
    }
  });

  test(`${name}: a deployment sends a limited number of invite emails an hour`, async () => {
    const backend = fresh();
    const now = Date.UTC(2026, 10, 23, 12, 30);
    const sent: (MailMessage | null)[] = [];
    for (let index = 0; sent.length <= organizations.MAX_INVITE_EMAILS_PER_HOUR; index++) {
      const admin = reviewer(`Admin${index}`);
      const organizationId = await ownOrganization(backend, admin);
      for (let each = 0; each < organizations.MAX_INVITES_PER_DAY && sent.length <= organizations.MAX_INVITE_EMAILS_PER_HOUR; each++) {
        const result = await backend.run((store) => organizations.inviteMember(store, admin, { organizationId, email: `person${sent.length}@example.com`, role: "member" }, now));
        sent.push(await claimEmail(backend, invited(result), now));
      }
    }
    expect(sent.filter((email) => email !== null)).toHaveLength(organizations.MAX_INVITE_EMAILS_PER_HOUR);
    expect(sent.at(-1)).toBeNull();
    const admin = reviewer("Later");
    const organizationId = await ownOrganization(backend, admin);
    const later = now + 60 * 60 * 1000;
    const result = await backend.run((store) => organizations.inviteMember(store, admin, { organizationId, email: "sam@example.com", role: "member" }, later));
    expect(await claimEmail(backend, invited(result), later)).not.toBeNull();
  });

  test(`${name}: an invite's email names the organization, who invited, the role, and the prototype when it can be opened elsewhere`, async () => {
    const backend = fresh();
    const { projectId, organizationId } = await danasOrganization(backend);
    const sent = await invite(backend, dana, organizationId, "lee@example.com", "admin");
    const inviteId = sent.status === "invited" ? sent.inviteId : "";
    const email = (await claimEmail(backend, inviteId, Date.now(), projectId))!;
    expect(email).toMatchObject({ to: "lee@example.com", subject: "Dana invited you to Dana's organization on Critiqs", idempotencyKey: `critiqs-invite:${inviteId}` });
    expect(email.text).toBe(
      [
        "Dana invited you to join Dana's organization on Critiqs as an admin.",
        "Sign in to Critiqs with this address (lee@example.com) and you'll join Dana's organization automatically.",
        "Open the prototype: https://proto.example/admin",
        "If you didn't expect this, you can ignore this email.",
      ].join("\n\n"),
    );
    expect(email.html).toContain('<a href="https://proto.example/admin">Open the prototype</a>');
    // A project elsewhere, or one only reachable on one computer, adds no link.
    const local = await backend.run((store) => ops.createProject(store, lee, { name: "Local", reviewUrl: "http://localhost:5173" }));
    expect((await claimEmail(backend, inviteId, Date.now(), local))!.text).not.toContain("Open the prototype");
    await signIn(backend, lee);
    expect(await claimEmail(backend, inviteId, Date.now(), projectId)).toBeNull();
  });

  test(`${name}: an invite's email shows names without control characters`, async () => {
    const backend = fresh();
    const odd = { ...reviewer("Mallory"), name: "Mal\u0000lory\u001b[2J" };
    const organizationId = await ownOrganization(backend, odd);
    const email = (await claimEmail(backend, invited(await invite(backend, odd, organizationId, "lee@example.com"))))!;
    expect(email.subject).toBe("Mallory[2J invited you to Mallory[2J's organization on Critiqs");
    expect(`${email.text}${email.html}`).not.toMatch(/[\u0000\u001b]/);
  });

  // Free, Plus, and Pro

  const GB = 1024 ** 3;

  async function organizationProject(backend: ContractBackend, who: Identity = dana, name = "One") {
    const projectId = await backend.run((store) => ops.createProject(store, who, { name }));
    return { projectId, organizationId: (await access(backend, who, projectId)).organization!.id };
  }

  const assignTo = (backend: ContractBackend, organizationId: string, plan: string) =>
    backend.run((store) => organizations.assignPlan(store, { organizationId, plan }, Date.now()));

  test(`${name}: Free, Plus, and Pro limit what they say, projects, images, and AI credits per organization and the rest per project`, async () => {
    const backend = fresh().withPlans(DEFAULT_PLANS);
    const { projectId, organizationId } = await organizationProject(backend);
    const create = (name: string) => backend.run((store) => ops.createProject(store, dana, { name }));
    await expect(create("Two")).rejects.toThrow("Your organization has reached the Free plan's limit of 1 project. An admin of the organization can upgrade the plan.");
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId, aiCredits: true }))).toEqual({
      plan: "Free",
      rows: [
        { metric: "aiCredits", period: "month", used: 0, max: 200 },
        { metric: "projects", period: "total", used: 1, max: 1 },
        { metric: "reviewers", period: "month", used: 0, max: 5 },
        { metric: "messages", period: "month", used: 0, max: 500 },
        { metric: "captureBytes", period: "total", used: 0, max: 500 * 1024 ** 2 },
        { metric: "mentionEmails", period: "day", used: 0, max: 100 },
      ],
    });

    await assignTo(backend, organizationId, "plus");
    const others: string[] = [];
    for (let i = 2; i <= 10; i++) others.push(await create(`Project ${i}`));
    await expect(create("Eleven")).rejects.toThrow("Plus plan's limit of 10 projects");
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Only here", tags: [], capture: failed }));
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId: others[0]!, aiCredits: true }))).toEqual({
      plan: "Plus",
      rows: [
        { metric: "aiCredits", period: "month", used: 0, max: 2_000, overage: { cap: 2_000 } },
        { metric: "projects", period: "total", used: 10, max: 10 },
        { metric: "reviewers", period: "month", used: 0, max: 25 },
        { metric: "messages", period: "month", used: 0, max: 5_000 },
        { metric: "captureBytes", period: "total", used: 0, max: 10 * GB },
      ],
      unlimited: [{ metric: "mentionEmails", period: "day", used: 0 }],
    });
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId })))!.rows.find((row) => row.metric === "messages")!.used).toBe(1);

    await assignTo(backend, organizationId, "pro");
    await create("Eleven");
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId, aiCredits: true }))).toEqual({
      plan: "Pro",
      rows: [
        { metric: "aiCredits", period: "month", used: 0, max: 10_000, overage: { cap: 10_000 } },
        { metric: "captureBytes", period: "total", used: 0, max: 100 * GB },
      ],
      unlimited: [
        { metric: "projects", period: "total", used: 11 },
        { metric: "reviewers", period: "month", used: 1 },
        { metric: "messages", period: "month", used: 1 },
        { metric: "mentionEmails", period: "day", used: 0 },
      ],
    });
  });

  test(`${name}: organizations on the former Team plan have Plus, unless the deployment configures Team`, async () => {
    const backend = fresh().withPlans(DEFAULT_PLANS);
    const { projectId, organizationId } = await organizationProject(backend);
    await backend.run((store) => store.organizations.patch(organizationId, { plan: "team" }));
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId })))!.plan).toBe("Plus");
    expect((await backend.run((store) => organizations.listMyOrganizations(store, dana))).map((one) => one.plan)).toEqual(["Plus"]);
    await backend.run((store) => ops.createProject(store, dana, { name: "Two" }));
    await assignTo(backend, organizationId, "team");

    const configured = fresh().withPlans({ ...DEFAULT_PLANS, team: { name: "team", label: "Team", limits: [] } });
    const kept = await organizationProject(configured);
    await assignTo(configured, kept.organizationId, "team");
    expect((await configured.run((store) => ops.getUsage(store, dana, { projectId: kept.projectId })))!.plan).toBe("Team");
  });

  const creditPlans: Record<string, Plan> = {
    free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 10 }] },
    plus: { name: "plus", label: "Plus", limits: [{ metric: "aiCredits", period: "month", max: 10, overage: { defaultCap: 5 } }] },
  };

  /** A Critiqs AI request the project pays for, whose worst case and real cost are both `credits`. */
  const charge = async (backend: ContractBackend, projectId: string, credits: number) => {
    const payer = { payer: "project" as const, ownerId: projectId };
    const reserved = await backend.run((store) => reserveCredits(store, payer, credits, Date.now()));
    if (!reserved.ok) throw new Error(reserved.reason);
    await backend.run((store) => settleCredits(store, reserved.hold, { ...payer, credits }, Date.now()));
  };

  const creditsRow = async (backend: ContractBackend, projectId: string) =>
    (await backend.run((store) => ops.getUsage(store, dana, { projectId, aiCredits: true })))!.rows.find((row) => row.metric === "aiCredits");

  test(`${name}: paid plans use extra AI credits up to the organization's cap, which only its admins change`, async () => {
    const backend = fresh().withPlans(creditPlans);
    const { projectId, organizationId } = await organizationProject(backend);
    await join(backend, lee, organizationId, "member");
    // Free has no extra credits.
    await charge(backend, projectId, 10);
    await expect(charge(backend, projectId, 1)).rejects.toThrow("no Critiqs AI credits left");

    await assignTo(backend, organizationId, "plus");
    await charge(backend, projectId, 3);
    await expect(charge(backend, projectId, 3)).rejects.toThrow("enough Critiqs AI credits left for this request");
    await charge(backend, projectId, 2);
    expect(await creditsRow(backend, projectId)).toEqual({ metric: "aiCredits", period: "month", used: 15, max: 10, overage: { cap: 5 } });
    await expect(charge(backend, projectId, 1)).rejects.toThrow("no Critiqs AI credits left");

    const setCap = (who: Identity, cap: number | null) => backend.run((store) => organizations.setOverageCap(store, who, { organizationId, cap }));
    await expect(setCap(lee, 100)).rejects.toThrow("Only an organization's admins can change its name, members, or billing.");
    // Someone outside the organization gets the same refusal, and code, as a member.
    await expect(setCap(reviewer("Riley"), 100)).rejects.toMatchObject({ code: "forbidden", message: "Only an organization's admins can change its name, members, or billing." });
    await expect(setCap(dana, -1)).rejects.toThrow("whole number of credits");
    await expect(setCap(dana, 2.5)).rejects.toThrow("whole number of credits");
    await setCap(dana, 10);
    await charge(backend, projectId, 5);
    expect(await creditsRow(backend, projectId)).toMatchObject({ used: 20, overage: { cap: 10 } });
    await setCap(dana, null);
    await charge(backend, projectId, 1_000);
    expect(await creditsRow(backend, projectId)).toMatchObject({ used: 1_020, overage: { cap: null } });
    await setCap(dana, 0);
    await expect(charge(backend, projectId, 1)).rejects.toThrow("no Critiqs AI credits left");
  });

  test(`${name}: admins put the cap back to the plan's default, and a change of plan puts it at the new plan's`, async () => {
    const backend = fresh().withPlans({
      ...creditPlans,
      pro: { name: "pro", label: "Pro", limits: [{ metric: "aiCredits", period: "month", max: 20, overage: { defaultCap: 50 } }] },
    });
    const { projectId, organizationId } = await organizationProject(backend);
    await assignTo(backend, organizationId, "plus");
    const setCap = (cap: number | null | "default") => backend.run((store) => organizations.setOverageCap(store, dana, { organizationId, cap }));
    const stored = async () => (await backend.run((store) => store.organizations.get(organizationId)))!;
    await setCap(100);
    expect(await creditsRow(backend, projectId)).toMatchObject({ overage: { cap: 100 } });
    await setCap("default");
    expect(await stored()).not.toHaveProperty("overageCap");
    expect(await creditsRow(backend, projectId)).toMatchObject({ overage: { cap: 5 } });

    await setCap(null);
    await assignTo(backend, organizationId, "pro");
    expect(await stored()).not.toHaveProperty("overageCap");
    expect(await creditsRow(backend, projectId)).toMatchObject({ max: 20, overage: { cap: 50 } });
    // Assigning the plan it already has keeps the admin's cap.
    await setCap(7);
    await assignTo(backend, organizationId, "pro");
    expect(await creditsRow(backend, projectId)).toMatchObject({ overage: { cap: 7 } });
  });

  test(`${name}: members see what the organization's plan limits for the whole organization, and whether the cap is the plan's`, async () => {
    const backend = fresh().withPlans({
      free: { name: "free", label: "Free", limits: [{ metric: "messages", period: "month", max: 3 }, { metric: "aiCredits", period: "month", max: 10 }] },
      plus: {
        name: "plus",
        label: "Plus",
        limits: [
          { metric: "messages", period: "month", max: 30 },
          { metric: "aiCredits", period: "month", max: 10, overage: { defaultCap: 5 } },
          { metric: "projects", period: "total", max: 4 },
        ],
      },
    });
    const { projectId, organizationId } = await organizationProject(backend);
    await join(backend, lee, organizationId, "member");
    const usage = (who: Identity) => backend.run((store) => organizations.getOrganizationUsage(store, who, { organizationId }));
    await charge(backend, projectId, 4);
    expect(await usage(lee)).toEqual({ plan: "Free", rows: [{ metric: "aiCredits", period: "month", used: 4, max: 10 }], unlimited: [{ metric: "projects", period: "total", used: 1 }, { metric: "captureBytes", period: "total", used: 0 }] });

    await assignTo(backend, organizationId, "plus");
    await charge(backend, projectId, 11);
    expect(await usage(lee)).toEqual({
      plan: "Plus",
      rows: [
        { metric: "aiCredits", period: "month", used: 15, max: 10, overage: { cap: 5 } },
        { metric: "projects", period: "total", used: 1, max: 4 },
      ],
      unlimited: [{ metric: "captureBytes", period: "total", used: 0 }],
      extraCredits: { defaultCap: 5, usesDefault: true },
    });
    await backend.run((store) => organizations.setOverageCap(store, dana, { organizationId, cap: 5 }));
    expect((await usage(dana))?.extraCredits).toEqual({ defaultCap: 5, usesDefault: false });
    await backend.run((store) => organizations.setOverageCap(store, dana, { organizationId, cap: null }));
    expect(await usage(dana)).toMatchObject({ rows: [{ overage: { cap: null } }, {}], extraCredits: { defaultCap: 5, usesDefault: false } });

    await expect(usage(reviewer("Riley"))).rejects.toThrow("Only members of the organization");
    await expect(backend.run((store) => organizations.getOrganizationUsage(store, dana, { organizationId: projectId }))).rejects.toThrow("Only members of the organization");
  });

  test(`${name}: Pro's storage add-ons raise its image storage, which the organization's projects share`, async () => {
    const backend = fresh().withPlans({
      free: { name: "free", label: "Free", limits: [{ metric: "captureBytes", period: "total", max: 100 }] },
      pro: { name: "pro", label: "Pro", limits: [{ metric: "captureBytes", period: "total", max: 100, addOn: { size: 50 } }] },
    });
    const { projectId, organizationId } = await organizationProject(backend);
    const other = await backend.run((store) => ops.createProject(store, dana, { name: "Two" }));
    const create = async (project: string) => {
      const fileId = await backend.saveFile("image/png", 64);
      return await backend.run((store) => ops.createThread(store, dana, { projectId: project, anchor, body: "Look", tags: [], capture: { status: "captured", fileId } }));
    };
    await create(projectId);
    await expect(create(other)).rejects.toThrow("This project's organization has reached the Free plan's limit");
    const setUnits = (units: number) => backend.run((store) => organizations.setExtraStorage(store, { organizationId, units }));
    await expect(setUnits(-1)).rejects.toThrow("whole number");
    // A plan without add-ons ignores them.
    await setUnits(1);
    await expect(create(other)).rejects.toThrow("Free plan's limit");
    await assignTo(backend, organizationId, "pro");
    await create(other);
    await expect(create(other)).rejects.toThrow("Pro plan's limit");
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId: other })))!.rows).toEqual([{ metric: "captureBytes", period: "total", used: 128, max: 150 }]);
  });

  /** Sends due plan alerts as the worker does, through `mailer`. */
  async function sendAlerts(backend: ContractBackend, mailer: Mailer | null, claimToken: string) {
    const ids = await backend.run((store) => claimPlanAlerts(store, Date.now(), 10, claimToken));
    const outcomes: Parameters<typeof completePlanAlerts>[1] = [];
    for (const id of ids) {
      const messages = await backend.run((store) => planAlertEmails(store, { id, claimToken }));
      if (messages !== null) outcomes.push({ id, claimToken, ...(await sendPlanAlert(mailer, messages)) });
    }
    await backend.run((store) => completePlanAlerts(store, outcomes, Date.now()));
    return ids.length;
  }

  test(`${name}: admins get one email when included AI credits run out and one when none are left, each month`, async () => {
    setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const backend = fresh().withPlans(creditPlans);
    const { projectId, organizationId } = await organizationProject(backend);
    await backend.run((store) => ops.setReviewUrl(store, dana, { projectId, reviewUrl: "https://proto.example/app" }));
    await join(backend, lee, organizationId, "admin");
    await join(backend, reviewer("Riley"), organizationId, "member");
    await assignTo(backend, organizationId, "plus");
    const sent: MailMessage[] = [];
    const mailer: Mailer = { send: async (message) => void sent.push(message) };

    await charge(backend, projectId, 9);
    expect(await sendAlerts(backend, mailer, "one")).toBe(0);
    // Two requests at once cross the line; one email is owed.
    await Promise.all([charge(backend, projectId, 1), charge(backend, projectId, 1)]);
    await charge(backend, projectId, 2);
    expect(await sendAlerts(backend, mailer, "two")).toBe(1);
    expect(sent.map((message) => [message.to, message.subject])).toEqual([
      ["dana@example.com", "Dana's organization has used its included Critiqs AI credits"],
      ["lee@example.com", "Dana's organization has used its included Critiqs AI credits"],
    ]);
    expect(sent[0]!.text).toBe(
      [
        "Dana's organization has used the 10 Critiqs AI credits its Plus plan includes this month.",
        "Critiqs AI keeps working. Extra credits are billed at your plan's rate, up to 5 extra credits this month. An admin can change that cap.",
        "See usage in the project's Critiqs setup: https://proto.example/app",
        "You get this email as an admin of Dana's organization.",
      ].join("\n\n"),
    );
    expect(sent[0]!.html).toContain('<a href="https://proto.example/app">');

    await charge(backend, projectId, 2);
    await expect(charge(backend, projectId, 1)).rejects.toThrow("no Critiqs AI credits left");
    sent.length = 0;
    expect(await sendAlerts(backend, mailer, "three")).toBe(1);
    expect(sent.map((message) => message.subject)).toEqual(["Critiqs AI is paused for Dana's organization", "Critiqs AI is paused for Dana's organization"]);
    expect(sent[0]!.text.split("\n\n").slice(0, 2)).toEqual([
      "Dana's organization doesn't have enough Critiqs AI credits left this month. Its Plus plan includes 10 a month, and its cap allows 5 extra.",
      "Critiqs AI is paused until December 1 (UTC), or until an admin raises the cap on extra credits.",
    ]);
    await backend.run((store) => organizations.setOverageCap(store, dana, { organizationId, cap: 10 }));
    await charge(backend, projectId, 5);
    sent.length = 0;
    expect(await sendAlerts(backend, mailer, "four")).toBe(0);

    // Next month starts again; on Free, the paused email says to upgrade.
    setSystemTime(new Date("2026-12-02T12:00:00Z"));
    await assignTo(backend, organizationId, "free");
    await charge(backend, projectId, 10);
    expect(await sendAlerts(backend, mailer, "five")).toBe(1);
    expect(sent.map((message) => message.subject)).toEqual(["Critiqs AI is paused for Dana's organization", "Critiqs AI is paused for Dana's organization"]);
    expect(sent[0]!.text.split("\n\n").slice(0, 2)).toEqual([
      "Dana's organization doesn't have enough Critiqs AI credits left this month. Its Free plan includes 10 a month.",
      "Critiqs AI is paused until January 1 (UTC), or until an admin upgrades the plan.",
    ]);
  });

  test(`${name}: an organization that changes plan mid-month gets the new plan's alerts, and one charge past both lines sends only that none are left`, async () => {
    setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const backend = fresh().withPlans(creditPlans);
    const { projectId, organizationId } = await organizationProject(backend);
    const sent: MailMessage[] = [];
    const mailer: Mailer = { send: async (message) => void sent.push(message) };
    await charge(backend, projectId, 10);
    expect(await sendAlerts(backend, mailer, "one")).toBe(1);
    expect(sent.map((message) => message.text.split("\n\n")[1])).toEqual(["Critiqs AI is paused until December 1 (UTC), or until an admin upgrades the plan."]);

    await assignTo(backend, organizationId, "plus");
    await charge(backend, projectId, 5);
    sent.length = 0;
    expect(await sendAlerts(backend, mailer, "two")).toBe(1);
    expect(sent.map((message) => message.text.split("\n\n")[0])).toEqual(["Dana's organization doesn't have enough Critiqs AI credits left this month. Its Plus plan includes 10 a month, and its cap allows 5 extra."]);

    const another = fresh().withPlans(creditPlans);
    const other = await organizationProject(another);
    await assignTo(another, other.organizationId, "plus");
    await charge(another, other.projectId, 15);
    sent.length = 0;
    expect(await sendAlerts(another, mailer, "three")).toBe(1);
    expect(sent.map((message) => message.subject)).toEqual(["Critiqs AI is paused for Dana's organization"]);
  });

  test(`${name}: a request refused because it costs more than what's left says credits ran short, not that they were all used`, async () => {
    setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const backend = fresh().withPlans(creditPlans);
    const { projectId } = await organizationProject(backend);
    const sent: MailMessage[] = [];
    const mailer: Mailer = { send: async (message) => void sent.push(message) };
    await charge(backend, projectId, 4);
    await expect(charge(backend, projectId, 8)).rejects.toThrow("enough Critiqs AI credits left for this request");
    expect((await creditsRow(backend, projectId))!.used).toBe(4);
    expect(await sendAlerts(backend, mailer, "one")).toBe(1);
    expect(sent[0]!.text.split("\n\n").slice(0, 2)).toEqual([
      "Dana's organization doesn't have enough Critiqs AI credits left this month. Its Free plan includes 10 a month.",
      "Critiqs AI is paused until December 1 (UTC), or until an admin upgrades the plan.",
    ]);
  });

  test(`${name}: alerts follow the plan, not its label, and an organization on Team counts as Plus`, async () => {
    setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const backend = fresh().withPlans(creditPlans);
    const { projectId, organizationId } = await organizationProject(backend);
    await backend.run((store) => store.organizations.patch(organizationId, { plan: "team" }));
    const sent: MailMessage[] = [];
    const mailer: Mailer = { send: async (message) => void sent.push(message) };
    await charge(backend, projectId, 10);
    await charge(backend, projectId, 5);
    expect(await sendAlerts(backend, mailer, "one")).toBe(2);
    expect(sent[0]!.text.split("\n\n")[0]).toBe("Dana's organization has used the 10 Critiqs AI credits its Plus plan includes this month.");

    await backend.changePlans({ ...creditPlans, plus: { ...creditPlans.plus!, label: "Plus 2026" } });
    await assignTo(backend, organizationId, "plus");
    await backend.run((store) => organizations.setOverageCap(store, dana, { organizationId, cap: 10 }));
    await charge(backend, projectId, 5);
    expect(await sendAlerts(backend, mailer, "two")).toBe(0);
  });

  test(`${name}: an alert email that fails is sent again with the same key, and is skipped without email`, async () => {
    const backend = fresh().withPlans(creditPlans);
    const { projectId, organizationId } = await organizationProject(backend);
    await assignTo(backend, organizationId, "plus");
    await charge(backend, projectId, 10);
    const keys: string[] = [];
    const failing: Mailer = {
      send: async (message) => {
        keys.push(message.idempotencyKey);
        throw new MailError("The email service refused the message (500).");
      },
    };
    expect(await sendAlerts(backend, failing, "one")).toBe(1);
    expect(await sendAlerts(backend, failing, "two")).toBe(0);
    setSystemTime(new Date(Date.now() + 2 * 60_000));
    expect(await sendAlerts(backend, { send: async (message) => void keys.push(message.idempotencyKey) }, "three")).toBe(1);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]!);
    expect(await sendAlerts(backend, null, "four")).toBe(0);

    await charge(backend, projectId, 5);
    expect(await sendAlerts(backend, null, "five")).toBe(1);
    const month = utcDay(Date.now()).slice(0, 7);
    expect(await backend.run((store) => store.planAlerts.find(organizationId, "paused", month, "plus"))).toMatchObject({
      status: "skipped",
      reason: "Email isn't set up for this deployment.",
    });
  });

  test(`${name}: components that don't ask for aiCredits see Critiqs AI credits under aiRequests, the name they show credits by`, async () => {
    const backend = fresh().withPlans(creditPlans);
    const { projectId } = await organizationProject(backend);
    await charge(backend, projectId, 4);
    const row = { period: "month" as const, used: 4, max: 10 };
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId })))!.rows).toEqual([{ metric: "aiRequests", ...row }]);
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId, aiCredits: true })))!.rows).toEqual([{ metric: "aiCredits", ...row }]);
  });

  test(`${name}: limits on the AI metrics from before AI credits no longer apply, and their usage still reads`, async () => {
    const backend = fresh().withPlans({
      free: { name: "free", label: "Free", limits: [{ metric: "aiRequests", period: "day", max: 1 }] },
    });
    const { projectId } = await organizationProject(backend);
    await backend.run((store) => store.usage.insert({ key: usageKey("aiRequests", "day", projectId, utcDay(Date.now())), count: 1 }));
    await charge(backend, projectId, 5);
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId, aiCredits: true }))).toMatchObject({
      rows: [{ metric: "aiRequests", period: "day", used: 1, max: 1 }],
      unlimited: expect.arrayContaining([{ metric: "aiCredits", period: "month", used: 5 }]),
    });
  });

  test(`${name}: without plans, nothing is limited and there is no usage to show`, async () => {
    const backend = fresh();
    const { projectId } = await projectWithThread(backend);
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId }))).toBeNull();
  });

  test(`${name}: a plan limits comments per month, and a failed change counts nothing`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "messages", period: "month", max: 3 }));
    const { projectId, threadId } = await projectWithThread(backend);
    await expect(backend.run((store) => ops.reply(store, lee, { threadId, body: "   ", revision: null }))).rejects.toThrow("cannot be empty");
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Two", revision: null }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Three", revision: null }));
    await expect(backend.run((store) => ops.reply(store, lee, { threadId, body: "Four", revision: null }))).rejects.toThrow(
      "Free plan's limit of 3 comments this month",
    );
    const usage = await backend.run((store) => ops.getUsage(store, dana, { projectId }));
    expect(usage).toMatchObject({ plan: "Free", rows: [{ metric: "messages", period: "month", used: 3, max: 3 }] });
    await expect(backend.run((store) => ops.getUsage(store, lee, { projectId }))).rejects.toThrow("Only the person who set up");
  });

  test(`${name}: a plan counts each reviewer once a month`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "reviewers", period: "month", max: 2 }));
    const { threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Lee", revision: null }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Dana again", revision: null }));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Lee again", revision: null }));
    await expect(backend.run((store) => ops.reply(store, reviewer("Riley"), { threadId, body: "Riley", revision: null }))).rejects.toThrow(
      "limit of 2 reviewers this month",
    );
  });

  test(`${name}: a plan limits projects per account and threads per project`, async () => {
    const backend = fresh().withPlans(
      planWith({ metric: "projects", period: "total", max: 1 }, { metric: "threads", period: "total", max: 1 }),
    );
    const { projectId } = await projectWithThread(backend);
    await expect(backend.run((store) => ops.createProject(store, dana, { name: "Another" }))).rejects.toThrow("Your organization has reached");
    await backend.run((store) => ops.createProject(store, lee, { name: "Lee's" }));
    await expect(
      backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Second", tags: [], capture: failed })),
    ).rejects.toThrow("limit of 1 thread");
  });

  test(`${name}: a plan limits stored image bytes`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "captureBytes", period: "total", max: 100 }));
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin" }));
    const create = (fileId: string) =>
      backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "Look", tags: [], capture: { status: "captured", fileId } }));
    await create(await backend.saveFile("image/png", 64));
    await expect(create(await backend.saveFile("image/png", 64))).rejects.toThrow("MB of images");
    await backend.run((store) => ops.authorizeUpload(store, dana, { projectId }));
    await create(await backend.saveFile("image/png", 36));
    await expect(backend.run((store) => ops.authorizeUpload(store, dana, { projectId }))).rejects.toThrow("MB of images");
  });

  test(`${name}: an organization's plan covers every project it owns, and moving plans is immediate`, async () => {
    const backend = fresh().withPlans({
      ...planWith({ metric: "projects", period: "total", max: 1 }),
      team: { name: "team", label: "Team", limits: [{ metric: "projects", period: "total", max: 3 }] },
    });
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "One" }));
    await expect(backend.run((store) => ops.createProject(store, dana, { name: "Two" }))).rejects.toThrow("Free plan's limit of 1 project");
    await backend.run((store) => organizations.assignPlan(store, { projectId, plan: "team" }, Date.now()));
    await backend.run((store) => ops.createProject(store, dana, { name: "Two" }));
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId }))).toMatchObject({
      plan: "Team",
      rows: [{ metric: "projects", period: "total", used: 2, max: 3 }],
    });
  });

  test(`${name}: usage is counted even without a limit, so a new plan's limit applies to it`, async () => {
    const backend = fresh().withPlans({
      ...planWith({ metric: "threads", period: "total", max: 2 }),
      team: { name: "team", label: "Team", limits: [] },
    });
    const { projectId } = await projectWithThread(backend);
    await backend.run((store) => organizations.assignPlan(store, { projectId, plan: "team" }, Date.now()));
    const start = () => backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "More", tags: [], capture: failed }));
    await start();
    await start();
    await backend.run((store) => organizations.assignPlan(store, { projectId, plan: "free" }, Date.now()));
    await expect(start()).rejects.toThrow("limit of 2 threads");
    expect(await backend.run((store) => ops.getUsage(store, dana, { projectId }))).toMatchObject({
      plan: "Free",
      rows: [{ metric: "threads", period: "total", used: 3, max: 2 }],
    });
  });

  test(`${name}: every limit on a metric applies, and a refusal counts nothing`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "messages", period: "total", max: 10 }, { metric: "messages", period: "day", max: 2 }));
    const { projectId, threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Two", revision: null }));
    await expect(backend.run((store) => ops.reply(store, lee, { threadId, body: "Three", revision: null }))).rejects.toThrow("2 comments today");
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId })))!.rows.map((row) => row.used)).toEqual([2, 2]);
  });

  test(`${name}: usage periods follow the clock, whatever the message order`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "messages", period: "month", max: 1 }));
    setSystemTime(new Date("2026-10-31T23:59:59.999Z"));
    const { projectId, threadId } = await projectWithThread(backend);
    // The reply is ordered just after the first message, in November, but it is still October.
    await expect(backend.run((store) => ops.reply(store, lee, { threadId, body: "Two", revision: null }))).rejects.toThrow("this month");
    setSystemTime(new Date("2026-11-01T00:00:01Z"));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Two", revision: null }));
    // Usage for a chosen day, as the setup panel asks for it.
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId, day: "2026-10-31" })))!.rows[0]!.used).toBe(1);
    expect((await backend.run((store) => ops.getUsage(store, dana, { projectId, day: "2026-11-01" })))!.rows[0]!.used).toBe(1);
    await expect(backend.run((store) => ops.getUsage(store, dana, { projectId, day: "tomorrow" }))).rejects.toThrow("YYYY-MM-DD");
  });

  test(`${name}: over the email allowance, mentions still post but send no email`, async () => {
    const backend = fresh().withPlans(planWith({ metric: "mentionEmails", period: "day", max: 1 }));
    const { threadId, leeId, rileyId } = await discussion(backend);
    await backend.run((store) =>
      ops.reply(store, dana, { threadId, body: "@Lee @Riley", revision: null, mentions: [mention(leeId, "Lee"), mention(rileyId, "Riley")] }),
    );
    const rows = await owed(backend);
    expect(rows).toHaveLength(1);
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread.page.at(-1)!.mentions.map((m) => m.label)).toEqual(["Lee", "Riley"]);
  });

  test(`${name}: a sign-in from before a rename cannot put back the old name`, async () => {
    const backend = fresh();
    const { threadId } = await projectWithThread(backend);
    expect(await backend.run((store) => ops.syncReviewer(store, { ...dana, name: "Dana Kim", profileVersion: 2 }))).toBe("Dana Kim");
    await backend.run((store) => ops.reply(store, { ...dana, profileVersion: 1 }, { threadId, body: "Old tab", revision: null }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Older tab", revision: null }));
    const authors = (await allMessages(backend, lee, threadId)).map((message) => message.author.name);
    expect(authors).toEqual(["Dana Kim", "Dana Kim", "Dana Kim"]);
  });

  // -------------------------------------------------------------------------
  // Who can review

  /** What an attempt came to: "allowed", or the refusal's code and message. */
  async function outcome(work: Promise<unknown>): Promise<string> {
    try {
      await work;
      return "allowed";
    } catch (error) {
      return `${(error as { code?: string }).code}: ${(error as Error).message}`;
    }
  }

  const refusedOutsideOrganization = `forbidden: ${organizations.ORGANIZATION_ONLY}`;

  /**
   * Dana's project, limited to her organization: Riley joined it through an
   * invite when she signed in, and Lee, who commented while anyone could, is
   * outside it.
   */
  async function limitedProject(backend: ContractBackend) {
    const riley = reviewer("Riley");
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    const image = await backend.saveFile("image/png");
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Department is wrong", tags: ["Bug"], capture: { status: "captured", fileId: image } }),
    );
    const leeMessageId = await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed", revision: null }));
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: "riley@example.com", role: "member" }, Date.now()));
    await backend.run((store) => ops.syncReviewer(store, riley));
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    return { projectId, organizationId, threadId, leeMessageId, image, riley };
  }

  /** Every operation on a project or on something in it, as `who`; `own` names the thread, message, and failed capture `who` may change. */
  function projectOperations(projectId: string, own: { threadId: string; messageId: string; failedThreadId: string; screenshot: string }) {
    const { evidence: _evidence, ...location } = anchor;
    const { threadId, messageId } = own;
    const each: Record<string, (who: Identity) => (store: Store) => Promise<unknown>> = {
      getProject: (who) => (store) => ops.getProject(store, who, { projectId }),
      listThreads: (who) => (store) => ops.listThreads(store, who, { projectId }, page),
      getThread: (who) => (store) => ops.getThread(store, who, { threadId }, page),
      listReactions: (who) => (store) => ops.listReactions(store, who, { threadId }, page),
      exportThreads: (who) => (store) => ops.exportThreads(store, who, { projectId, threadIds: [threadId], threadIndex: 0 }, page),
      listParticipants: (who) => (store) => ops.listParticipants(store, who, { projectId, query: "" }),
      listParticipantsNamed: (who) => (store) => ops.listParticipantsNamed(store, who, { projectId, name: "Dana" }),
      getNotificationSettings: (who) => (store) => ops.getNotificationSettings(store, who, { projectId }),
      setNotificationSettings: (who) => (store) => ops.setNotificationSettings(store, who, { projectId, projectMuted: false }),
      listTags: (who) => (store) => ops.listTags(store, who, { projectId }),
      createThread: (who) => (store) => ops.createThread(store, who, { projectId, anchor, body: "Another", tags: [], capture: failed }),
      reply: (who) => (store) => ops.reply(store, who, { threadId, body: "Still here", revision: null }),
      editMessage: (who) => (store) => ops.editMessage(store, who, { messageId, body: "Edited" }),
      toggleReaction: (who) => (store) => ops.toggleReaction(store, who, { messageId, emoji: REACTIONS[0] }),
      setStatus: (who) => (store) => ops.setStatus(store, who, { threadId, status: "resolved" }),
      setTags: (who) => (store) => ops.setTags(store, who, { threadId, tags: ["Bug"] }),
      reattach: (who) => (store) => ops.reattach(store, who, { threadId, location }),
      attachScreenshot: (who) => (store) => ops.attachScreenshot(store, who, { threadId: own.failedThreadId, fileId: own.screenshot }),
      authorizeUpload: (who) => (store) => ops.authorizeUpload(store, who, { projectId }),
      authorizedCapture: (who) => (store) => ops.authorizedCapture(store, who, { threadId }),
      markRead: (who) => (store) => ops.markRead(store, who, { threadId, seenThrough: Date.now() }),
      markUnread: (who) => (store) => ops.markUnread(store, who, { threadId }),
      removeThread: (who) => (store) => ops.removeThread(store, who, { threadId }),
    };
    return each;
  }

  async function outcomes(backend: ContractBackend, who: Identity, each: ReturnType<typeof projectOperations>) {
    const results: Record<string, string> = {};
    // In order: removing the thread comes last.
    for (const [name, operation] of Object.entries(each)) results[name] = await outcome(backend.run(operation(who)));
    return results;
  }

  test(`${name}: projects let anyone who signs in review them until their owners limit them, and report which`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    expect((await backend.run((store) => ops.getProject(store, lee, { projectId }))).reviewAccess).toBe("anyone");
    expect(await outcome(backend.run((store) => ops.listThreads(store, reviewer("Sam"), { projectId }, page)))).toBe("allowed");
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    expect((await backend.run((store) => ops.getProject(store, dana, { projectId }))).reviewAccess).toBe("organization");
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "anyone" }));
    expect((await backend.run((store) => ops.getProject(store, lee, { projectId }))).reviewAccess).toBe("anyone");
  });

  test(`${name}: limited to its organization, a project refuses everyone outside it on every operation, and lets its members in`, async () => {
    const backend = fresh();
    const { projectId, threadId, leeMessageId, image, riley } = await limitedProject(backend);
    const failedThreadId = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "No capture", tags: [], capture: failed }));
    const outside = projectOperations(projectId, { threadId, messageId: leeMessageId, failedThreadId, screenshot: await backend.saveFile("image/png") });
    const everyRefused = Object.fromEntries(Object.keys(outside).map((name) => [name, refusedOutsideOrganization]));
    // Lee commented before; Sam has never signed in here, so has no record yet.
    expect(await outcomes(backend, lee, outside)).toEqual(everyRefused);
    expect(await outcomes(backend, reviewer("Sam"), outside)).toEqual(everyRefused);
    // Nothing Lee or Sam tried changed anything.
    const thread = await backend.run((store) => ops.getThread(store, dana, { threadId }, page));
    expect(thread).toMatchObject({ status: "open", messageCount: 2 });
    expect(thread.page.map((message) => message.body)).toEqual(["Department is wrong", "Agreed"]);

    // Riley, a member, may do each, on her own thread and message where it matters.
    const rileyThreadId = await backend.run((store) => ops.createThread(store, riley, { projectId, anchor, body: "Mine", tags: [], capture: failed }));
    const rileyMessageId = (await backend.run((store) => ops.getThread(store, riley, { threadId: rileyThreadId }, page))).page[0]!._id;
    const inside = projectOperations(projectId, { threadId: rileyThreadId, messageId: rileyMessageId, failedThreadId, screenshot: await backend.saveFile("image/png") });
    expect(await outcomes(backend, riley, inside)).toEqual(Object.fromEntries(Object.keys(inside).map((name) => [name, "allowed"])));
    expect(await backend.run((store) => ops.authorizedCapture(store, riley, { threadId }))).toBe(image);
    expect((await backend.run((store) => ops.listThreads(store, riley, { projectId }, page))).page.map((each) => each._id)).toContain(threadId);
  });

  test(`${name}: a thread, message, or capture named by its own ID is refused like its project, deleted or not`, async () => {
    const backend = fresh();
    const { projectId, organizationId, threadId, leeMessageId } = await limitedProject(backend);
    // Lee's own project, open to anyone, can't reach Dana's thread through its export either.
    const leeProjectId = await backend.run((store) => ops.createProject(store, lee, { name: "Lee's prototype" }));
    const exported = await backend.run((store) => ops.exportThreads(store, lee, { projectId: leeProjectId, threadIds: [threadId], threadIndex: 0 }, page));
    expect(exported.thread).toBeNull();
    expect(await outcome(backend.run((store) => ops.getThread(store, lee, { threadId }, page)))).toBe(refusedOutsideOrganization);
    expect(await outcome(backend.run((store) => ops.authorizedCapture(store, lee, { threadId })))).toBe(refusedOutsideOrganization);
    expect(await outcome(backend.run((store) => ops.toggleReaction(store, lee, { messageId: leeMessageId, emoji: REACTIONS[0] })))).toBe(refusedOutsideOrganization);
    // A deleted thread is reported deleted only to those who may review the project.
    await backend.run((store) => ops.removeThread(store, dana, { threadId }));
    expect(await outcome(backend.run((store) => ops.getThread(store, lee, { threadId }, page)))).toBe(refusedOutsideOrganization);
    expect(await outcome(backend.run((store) => ops.getThread(store, dana, { threadId }, page)))).toBe("unavailable: This thread was deleted.");
    // A creator who leaves the organization no longer reaches the project, nor lists it to reconnect to.
    expect((await backend.run((store) => ops.listMyProjects(store, dana, page))).page.map((project) => project._id)).toEqual([projectId]);
    const danaId = await idOf(backend, dana);
    const membership = (await backend.run((store) => store.memberships.find(organizationId, danaId)))!;
    await backend.run((store) => store.memberships.delete(membership._id));
    expect((await backend.run((store) => ops.listMyProjects(store, dana, page))).page).toEqual([]);
    expect(await outcome(backend.run((store) => ops.getProject(store, dana, { projectId })))).toBe(refusedOutsideOrganization);
  });

  test(`${name}: only a thread's author or the project's owners delete it`, async () => {
    const backend = fresh();
    const { projectId, organizationId } = await danasOrganization(backend);
    const riley = reviewer("Riley");
    const morgan = reviewer("Morgan");
    await invite(backend, dana, organizationId, "riley@example.com");
    await invite(backend, dana, organizationId, "morgan@example.com", "admin");
    await signIn(backend, riley);
    await signIn(backend, morgan);
    const start = (who: Identity) => backend.run((store) => ops.createThread(store, who, { projectId, anchor, body: `${who.name}'s`, tags: [], capture: failed }));
    const remove = (who: Identity, threadId: string) => outcome(backend.run((store) => ops.removeThread(store, who, { threadId })));
    const notYours = "forbidden: Only the person who started this thread or the project's owners can delete it.";
    const danas = await start(dana);
    const lees = await start(lee);
    const rileys = await start(riley);
    // Each thread says whether the person reading it may delete it, so the Delete menu matches.
    const canDelete = async (who: Identity, threadId: string) => (await backend.run((store) => ops.getThread(store, who, { threadId }, page))).canDelete;
    expect([await canDelete(lee, danas), await canDelete(lee, lees), await canDelete(riley, lees), await canDelete(morgan, lees), await canDelete(dana, rileys)]).toEqual([false, true, false, true, true]);
    // Anyone may review this project, but not delete others' threads: neither a reviewer outside the organization nor a member.
    expect(await remove(lee, danas)).toBe(notYours);
    expect(await remove(riley, danas)).toBe(notYours);
    expect(await remove(riley, lees)).toBe(notYours);
    // Authors delete their own; an admin and the project's creator delete anyone's.
    expect(await remove(lee, lees)).toBe("allowed");
    expect(await remove(morgan, rileys)).toBe("allowed");
    expect(await remove(dana, await start(riley))).toBe("allowed");
    // The creator while only a member still manages the project; once removed, not even their own project's threads.
    const danaId = await idOf(backend, dana);
    const membership = (await backend.run((store) => store.memberships.find(organizationId, danaId)))!;
    await backend.run((store) => store.memberships.patch(membership._id, { role: "member" }));
    expect(await remove(dana, await start(lee))).toBe("allowed");
    await backend.run((store) => store.memberships.delete(membership._id));
    expect(await remove(dana, await start(lee))).toBe(notYours);
    // Others' messages stay theirs to edit, whoever manages the project.
    const leeThread = await start(lee);
    const leeMessage = (await backend.run((store) => ops.getThread(store, lee, { threadId: leeThread }, page))).page[0]!._id;
    expect(await outcome(backend.run((store) => ops.editMessage(store, morgan, { messageId: leeMessage, body: "Changed" })))).toBe(
      "forbidden: You can only edit your own messages.",
    );
    expect(await outcome(backend.run((store) => ops.removeThread(store, morgan, { threadId: danas })))).toBe("allowed");
  });

  test(`${name}: only the project's owners change who can review it`, async () => {
    const backend = fresh();
    const { projectId, organizationId } = await danasOrganization(backend);
    const riley = reviewer("Riley");
    const morgan = reviewer("Morgan");
    await invite(backend, dana, organizationId, "riley@example.com");
    await invite(backend, dana, organizationId, "morgan@example.com", "admin");
    await signIn(backend, riley);
    await signIn(backend, morgan);
    const set = (who: Identity | null, reviewAccess: "anyone" | "organization") =>
      outcome(backend.run((store) => ops.setReviewAccess(store, who, { projectId, reviewAccess })));
    const onlyOwners = "forbidden: Only the project's owners can change who can review it.";
    expect(await set(lee, "organization")).toBe(onlyOwners);
    expect(await set(riley, "organization")).toBe(onlyOwners);
    expect(await set(null, "organization")).toBe("unauthenticated: Sign in to view feedback.");
    expect(await outcome(backend.run((store) => ops.setReviewAccess(store, morgan, { projectId, reviewAccess: "everyone" as "anyone" })))).toBe(
      "invalid: Choose anyone who signs in, or members of the organization.",
    );
    expect((await backend.run((store) => ops.getProject(store, riley, { projectId }))).reviewAccess).toBe("anyone");
    expect(await set(morgan, "organization")).toBe("allowed");
    expect((await backend.run((store) => ops.getProject(store, riley, { projectId }))).reviewAccess).toBe("organization");
    // Once limited, someone outside can't even try to open it again.
    expect(await set(lee, "anyone")).toBe(refusedOutsideOrganization);
    expect(await set(dana, "anyone")).toBe("allowed");
    expect(await outcome(backend.run((store) => ops.listThreads(store, lee, { projectId }, page)))).toBe("allowed");
  });

  test(`${name}: once a project is limited to its organization, people outside it are neither suggested nor emailed`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Hi", revision: null }));
    // Dana's reply owes Lee an email before the project is limited.
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Thanks", revision: null }));
    await settle(backend);
    expect((await backend.run((store) => ops.listParticipants(store, dana, { projectId, query: "" }))).map((person) => person.name)).toEqual(["Lee"]);
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    expect(await backend.run((store) => ops.listParticipants(store, dana, { projectId, query: "" }))).toEqual([]);
    expect(await backend.run((store) => ops.listParticipantsNamed(store, dana, { projectId, name: "Lee" }))).toEqual({ people: [], complete: true });
    const now = Date.now() + notify.GATHER_MS + 60_000;
    const sent = await sendDue(backend, now);
    expect(sent.sends.map((send) => send.message.to)).toEqual(["dana@example.com"]);
    expect(sent.skipped.map((row) => row.reason)).toEqual(["The reviewer can no longer review this project."]);
    await backend.run((store) =>
      notify.completeDeliveries(store, [...sent.skipped.map(({ deliveryId, reason }) => ({ deliveryId, claimToken: "worker", result: "skipped" as const, reason })), ...sent.sends.map(({ deliveryId }) => ({ deliveryId, claimToken: "worker", result: "sent" as const }))], now),
    );
    // Later replies and mentions owe Lee nothing.
    const leeId = await idOf(backend, lee);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Lee more", revision: null, mentions: [mention(leeId, "Lee")] }));
    expect((await owed(backend)).filter((delivery) => delivery.recipientId === leeId)).toEqual([]);
  });

  /** Finishes what `sendDue` sent and skipped, as the worker does, returning the prepared email each delivery had. */
  async function finish(backend: ContractBackend, sent: Awaited<ReturnType<typeof sendDue>>, now: number) {
    const prepared = new Map<string, string | undefined>();
    for (const id of sent.ids) prepared.set(id, (await backend.run((store) => store.deliveries.get(id)))?.payload?.fileId);
    await backend.run((store) =>
      notify.completeDeliveries(
        store,
        [
          ...sent.skipped.map(({ deliveryId, reason }) => ({ deliveryId, claimToken: "worker", result: "skipped" as const, reason })),
          ...sent.failed.map(({ deliveryId, reason }) => ({ deliveryId, claimToken: "worker", result: "failed" as const, reason })),
          ...sent.sends.map(({ deliveryId }) => ({ deliveryId, claimToken: "worker", result: "sent" as const })),
        ],
        now,
      ),
    );
    return prepared;
  }

  test(`${name}: an email being prepared when its project is limited to the organization reads no capture and isn't sent`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const image = await backend.saveFile("image/png");
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Department is wrong", tags: [], capture: { status: "captured", fileId: image } }),
    );
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed", revision: null }));
    await backend.run((store) => ops.setNotificationSettings(store, dana, { projectId, replyEmails: false }));
    // Dana's reply owes Lee, outside her organization, an email with the capture.
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Thanks", revision: null }));
    const now = Date.now() + notify.GATHER_MS + 60_000;
    const read: string[] = [];
    const sent = await sendDue(backend, now, "worker", {
      // The delivery was approved and its discussion read; then the owners limit the project.
      afterPage: () => backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" })),
      readFile: async (fileId, readIt) => {
        read.push(fileId);
        return await readIt();
      },
    });
    expect(sent.ids).toHaveLength(1);
    expect(sent.sends).toEqual([]);
    expect(read).toEqual([]);
    expect(sent.skipped.map((row) => row.reason)).toEqual(["The reviewer can no longer review this project."]);
  });

  test(`${name}: an email prepared before its project is limited to the organization is discarded, not sent`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await projectWithThread(backend);
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Hi", revision: null }));
    await backend.run((store) => ops.setNotificationSettings(store, dana, { projectId, replyEmails: false }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Thanks", revision: null }));
    const now = Date.now() + notify.GATHER_MS + 60_000;
    // The email is stored, then the owners limit the project before it goes to the mail service.
    const sent = await sendDue(backend, now, "worker", {
      beforeFreeze: () => backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" })),
    });
    expect(sent.sends).toEqual([]);
    expect(sent.skipped.map((row) => row.reason)).toEqual(["The reviewer can no longer review this project."]);
    const prepared = await finish(backend, sent, now);
    const fileId = prepared.get(sent.ids[0]!);
    expect(fileId).toBeDefined();
    expect(await backend.readFile(fileId!)).toBeNull();
  });

  test(`${name}: a retried email isn't sent to a member removed from the organization after it was approved`, async () => {
    const backend = fresh();
    const { projectId, organizationId } = await danasOrganization(backend);
    const riley = reviewer("Riley");
    await invite(backend, dana, organizationId, "riley@example.com");
    await signIn(backend, riley);
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    const threadId = await backend.run((store) => ops.createThread(store, riley, { projectId, anchor, body: "Department is wrong", tags: [], capture: failed }));
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "Thanks", revision: null }));
    // The first attempt is prepared and stored, but the mail service fails it.
    let now = Date.now() + notify.GATHER_MS + 60_000;
    const first = await sendDue(backend, now, "worker", {
      send: async () => {
        throw new MailError("The mail service is down.");
      },
    });
    expect(first.failed.map((row) => row.reason)).toEqual(["The mail service is down."]);
    const prepared = await finish(backend, first, now);
    const fileId = prepared.get(first.ids[0]!)!;
    expect(await backend.readFile(fileId)).not.toBeNull();
    // The retry is approved; then Riley leaves the organization before it is sent.
    now += 24 * 60 * 60_000;
    const rileyId = await idOf(backend, riley);
    const retry = await sendDue(backend, now, "worker", {
      beforeAllowed: async () => {
        const membership = await backend.run((store) => store.memberships.find(organizationId, rileyId));
        if (membership !== null) await backend.run((store) => store.memberships.delete(membership._id));
      },
    });
    expect(retry.ids).toEqual(first.ids);
    expect(retry.sends).toEqual([]);
    expect(retry.skipped.map((row) => row.reason)).toEqual(["The reviewer can no longer review this project."]);
    await finish(backend, retry, now);
    expect(await backend.readFile(fileId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Thread pages

  const noThreadPage = "not-found: This thread doesn't exist, or you can't open it.";

  /**
   * Dana's thread in her project, open to anyone who signs in: Riley belongs
   * to Dana's organization, Lee replied, Mo was mentioned (after commenting
   * on another thread), and Sam has signed in but is none of these.
   */
  async function pagedThread(backend: ContractBackend) {
    const riley = reviewer("Riley");
    const mo = reviewer("Mo");
    const sam = reviewer("Sam");
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype", reviewUrl: "https://proto.example/app" }));
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    const image = await backend.saveFile("image/png");
    const threadId = await backend.run((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Department is wrong", tags: [], capture: { status: "captured", fileId: image } }),
    );
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed", revision: null }));
    await backend.run((store) => ops.createThread(store, mo, { projectId, anchor, body: "Elsewhere", tags: [], capture: failed }));
    const moId = await idOf(backend, mo);
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "@Mo can you check?", revision: null, mentions: [mention(moId, "Mo")] }));
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: "riley@example.com", role: "member" }, Date.now()));
    await backend.run((store) => ops.syncReviewer(store, riley));
    await backend.run((store) => ops.syncReviewer(store, sam));
    const key = await backend.run((store) => ops.threadPageKey(store, dana, { threadId }));
    return { projectId, organizationId, threadId, image, key, riley, mo, sam };
  }

  async function openPage(backend: ContractBackend, who: Identity | null, key: string) {
    return await backend.run((store) => ops.getThreadPage(store, who, { key }, page));
  }

  test(`${name}: a thread page opens for the project's organization and the people in the thread, with what the page shows`, async () => {
    const backend = fresh();
    const { projectId, threadId, key, riley, mo } = await pagedThread(backend);
    for (const who of [dana, lee, mo, riley]) expect(await outcome(openPage(backend, who, key))).toBe("allowed");
    const shown = await openPage(backend, riley, key);
    expect(shown).toMatchObject({
      _id: threadId,
      projectId,
      status: "open",
      messageCount: 3,
      project: { name: "Admin prototype", reviewUrl: "https://proto.example/app" },
      prototype: { pageUrl: "https://proto.example/users/alex", screen: "user-details" },
      capture: { status: "captured" },
      isDone: true,
    });
    expect(shown.page.map((message) => [message.author.name, message.body])).toEqual([
      ["Dana", "Department is wrong"],
      ["Lee", "Agreed"],
      ["Dana", "@Mo can you check?"],
    ]);
    // The page shows the discussion as the thread window does.
    const { project: _project, prototype: _prototype, ...thread } = shown;
    expect(thread).toEqual(await backend.run((store) => ops.getThread(store, riley, { threadId }, page)));
  });

  test(`${name}: anyone else, signed in or not, gets the same answer as for a thread page that doesn't exist`, async () => {
    const backend = fresh();
    const { threadId, key, riley, sam } = await pagedThread(backend);
    // Riley belongs to the organization, but this sign-in hasn't verified her address.
    const unverified = { ...riley, emailVerified: false };
    // Sam has the link and could review the project, but is neither in its organization nor in the thread.
    expect(await outcome(openPage(backend, sam, key))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, null, key))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, unverified, key))).toBe(noThreadPage);
    // Someone who has never signed in here, and keys that open nothing.
    expect(await outcome(openPage(backend, reviewer("Newcomer"), key))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, dana, "AAAAAAAAAAAAAAAAAAAAAA"))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, null, "AAAAAAAAAAAAAAAAAAAAAA"))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, dana, "not a key"))).toBe(noThreadPage);
    // A thread ID is not a page key, even to the thread's author.
    expect(await outcome(openPage(backend, dana, threadId))).toBe(noThreadPage);
    // The page's image follows the same rule.
    expect(await outcome(backend.run((store) => ops.authorizedPageCapture(store, sam, { key })))).toBe(noThreadPage);
    expect(await outcome(backend.run((store) => ops.authorizedPageCapture(store, null, { key })))).toBe(noThreadPage);
  });

  test(`${name}: a thread page's image downloads for those who may open the page, through the page key`, async () => {
    const backend = fresh();
    const { image, key, riley, mo } = await pagedThread(backend);
    for (const who of [dana, lee, mo, riley]) expect(await backend.run((store) => ops.authorizedPageCapture(store, who, { key }))).toBe(image);
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Second" }));
    const failedThread = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "No image", tags: [], capture: failed }));
    const failedKey = await backend.run((store) => ops.threadPageKey(store, dana, { threadId: failedThread }));
    expect(await backend.run((store) => ops.authorizedPageCapture(store, dana, { key: failedKey }))).toBeNull();
  });

  test(`${name}: in a project limited to its organization, a thread page opens only for members; someone in the thread who left is refused`, async () => {
    const backend = fresh();
    const { projectId, organizationId, threadId, key, riley } = await pagedThread(backend);
    await backend.run((store) => ops.reply(store, riley, { threadId, body: "On it", revision: null }));
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    // Lee and Mo are in the thread but outside the organization.
    for (const who of [lee, reviewer("Mo")]) expect(await outcome(openPage(backend, who, key))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, riley, key))).toBe("allowed");
    // Riley replied in the thread, then left the organization.
    const rileyId = await idOf(backend, riley);
    await backend.run((store) => organizations.removeMember(store, dana, { organizationId, userId: rileyId }));
    expect(await outcome(openPage(backend, riley, key))).toBe(noThreadPage);
    expect(await outcome(backend.run((store) => ops.authorizedPageCapture(store, riley, { key })))).toBe(noThreadPage);
    expect(await outcome(backend.run((store) => ops.reply(store, riley, { threadId, body: "Still here?", revision: null, threadPage: true })))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, dana, key))).toBe("allowed");
  });

  test(`${name}: a deleted thread's page is refused: reported deleted only to those who could open it`, async () => {
    const backend = fresh();
    const { threadId, key, riley, sam } = await pagedThread(backend);
    await backend.run((store) => ops.removeThread(store, dana, { threadId }));
    for (const who of [dana, lee, riley]) expect(await outcome(openPage(backend, who, key))).toBe("unavailable: This thread was deleted.");
    expect(await outcome(openPage(backend, sam, key))).toBe(noThreadPage);
    expect(await outcome(openPage(backend, null, key))).toBe(noThreadPage);
    expect(await outcome(backend.run((store) => ops.authorizedPageCapture(store, dana, { key })))).toBe("unavailable: This thread was deleted.");
    expect(await outcome(backend.run((store) => ops.reply(store, lee, { threadId, body: "Gone?", revision: null, threadPage: true })))).toBe(
      "unavailable: This thread was deleted.",
    );
  });

  test(`${name}: replies from a thread page follow the page's rule; the installed component's replies keep the project's`, async () => {
    const backend = fresh();
    const { threadId, riley, mo, sam } = await pagedThread(backend);
    const fromPage = (who: Identity | null, body: string) => backend.run((store) => ops.reply(store, who, { threadId, body, revision: null, threadPage: true }));
    for (const [who, body] of [[dana, "From Dana"], [lee, "From Lee"], [mo, "From Mo"], [riley, "From Riley"]] as const) {
      expect(await outcome(fromPage(who, body))).toBe("allowed");
    }
    expect(await outcome(fromPage(sam, "From Sam"))).toBe(noThreadPage);
    expect(await outcome(fromPage(null, "Signed out"))).toBe(noThreadPage);
    expect(await outcome(fromPage({ ...riley, emailVerified: false }, "Unverified"))).toBe(noThreadPage);
    expect(await outcome(backend.run((store) => ops.reply(store, sam, { threadId: "not-an-id", body: "?", revision: null, threadPage: true })))).toBe(noThreadPage);
    const bodies = (await allMessages(backend, dana, threadId)).map((message) => message.body);
    expect(bodies.slice(3)).toEqual(["From Dana", "From Lee", "From Mo", "From Riley"]);
    // Anyone may review this project, so without the page, Sam's reply is accepted as before.
    expect(await outcome(backend.run((store) => ops.reply(store, sam, { threadId, body: "From the prototype", revision: null })))).toBe("allowed");
    // Once Sam replied, Sam is in the thread, and the page opens.
    expect(await outcome(fromPage(sam, "Now from the page"))).toBe("allowed");
  });

  test(`${name}: whom someone may mention follows their standing in the project, not where they reply from`, async () => {
    const backend = fresh();
    const { projectId, threadId, key, riley, mo, sam } = await pagedThread(backend);
    // Sam, outside the organization, commented elsewhere in the project, so the installed panel used to offer Sam to anyone.
    await backend.run((store) => ops.createThread(store, sam, { projectId, anchor, body: "Another page", tags: [], capture: failed }));
    await backend.run((store) => ops.reply(store, riley, { threadId, body: "On it", revision: null }));
    const [leeId, moId, samId, rileyId] = [await idOf(backend, lee), await idOf(backend, mo), await idOf(backend, sam), await idOf(backend, riley)];
    const reply = (who: Identity, mentions: { userId: string; label: string }[], threadPage: boolean) =>
      backend.run((store) =>
        ops.reply(store, who, { threadId, body: mentions.map((each) => `@${each.label}`).join(" "), revision: null, mentions, ...(threadPage ? { threadPage: true } : {}) }),
      );
    // Lee replied in the thread but isn't in the organization: leaving the thread page's flag off changes nothing.
    for (const threadPage of [true, false]) {
      expect(await outcome(reply(lee, [mention(samId, "Sam")], threadPage))).toBe("invalid: You can only mention people in this thread, or in the project's team.");
      expect(await outcome(reply(lee, [mention(moId, "Mo")], threadPage))).toBe("allowed");
      expect(await outcome(reply(lee, [mention(rileyId, "Riley")], threadPage))).toBe("allowed");
    }
    // Nor does editing a reply to add the mention.
    const lees = (await allMessages(backend, dana, threadId)).filter((message) => message.body === "@Mo");
    const leeReply = lees.at(-1)!._id;
    expect(await outcome(backend.run((store) => ops.editMessage(store, lee, { messageId: leeReply, body: "@Mo @Sam", mentions: [mention(moId, "Mo"), mention(samId, "Sam")] })))).toBe(
      "invalid: You can only mention people in this thread, or in the project's team.",
    );
    // In a new thread nobody else is in it yet: someone outside the team mentions the team only.
    const newThread = (mentions: { userId: string; label: string }[]) =>
      backend.run((store) => ops.createThread(store, sam, { projectId, anchor, body: "New", tags: [], capture: failed, mentions }));
    expect(await outcome(newThread([mention(leeId, "Lee")]))).toBe("invalid: You can only mention people in the project's team.");
    expect(await outcome(newThread([mention(rileyId, "Riley")]))).toBe("allowed");
    // The project's team mentions anyone in the project, from either place.
    for (const threadPage of [true, false]) expect(await outcome(reply(dana, [mention(samId, "Sam")], threadPage))).toBe("allowed");
    // Suggestions agree: someone outside the team is offered the team, the team everyone.
    const suggested = async (who: Identity) => (await backend.run((store) => ops.listParticipants(store, who, { projectId, query: "" }))).map((person) => person.name).sort();
    expect(await suggested(lee)).toEqual(["Dana", "Riley"]);
    expect(await suggested(riley)).toEqual(["Dana", "Lee", "Mo", "Sam"]);
    // The page says whether the project is installed: not until Critiqs loads at its address.
    expect((await openPage(backend, dana, key)).project.connectedAt).toBeNull();
    await backend.run((store) => reportConnected(store, { projectId, origin: "https://proto.example" }, 5_000));
    expect((await openPage(backend, dana, key)).project.connectedAt).toBe(5_000);
  });

  test(`${name}: a thread records whether it was left with the extension, and its page says so; older threads say nothing`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Installed", reviewUrl: "https://proto.example" }));
    const made = (madeWith?: "extension") =>
      backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "Here", tags: [], capture: failed, ...(madeWith === undefined ? {} : { madeWith }) }));
    const pageOf = async (threadId: string) => (await openPage(backend, dana, await backend.run((store) => ops.threadPageKey(store, dana, { threadId })))).prototype;
    expect(await pageOf(await made("extension"))).toMatchObject({ madeWith: "extension" });
    // Anything else, including every older component, is an install.
    expect(await pageOf(await made())).toMatchObject({ madeWith: "install" });
    // A thread from before it was recorded says nothing, so the page treats it as left with an install.
    const danaId = await idOf(backend, dana);
    const old = await backend.run((store) =>
      store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: 1, lastMessageAt: 1, messageCount: 0, followersReady: true }),
    );
    expect("madeWith" in (await pageOf(old))).toBe(false);
  });

  test(`${name}: a thread from before people in threads were recorded opens for those its discussion names`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Old prototype" }));
    const mo = reviewer("Mo");
    const sam = reviewer("Sam");
    for (const who of [lee, mo, sam]) await backend.run((store) => ops.syncReviewer(store, who));
    const [danaId, leeId, moId] = [await idOf(backend, dana), await idOf(backend, lee), await idOf(backend, mo)];
    // Written as an older Critiqs stored it: no followers, no page key, and 45 messages, more than one page.
    const threadId = await backend.run(async (store) => {
      const id = await store.threads.insert({
        projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: 1, lastMessageAt: 46, messageCount: 46,
      });
      const write = (authorId: string, at: number, mentions?: { userId: string; label: string }[]) =>
        store.messages.insert({ threadId: id, authorId, body: `Message ${at}`, createdAt: at, editedAt: null, revision: null, ...(mentions === undefined ? {} : { mentions }) });
      await write(danaId, 1);
      for (let at = 2; at <= 45; at++) await write(danaId, at);
      await write(leeId, 46, [{ userId: moId, label: "Mo" }]);
      return id;
    });
    const key = await backend.run((store) => ops.threadPageKey(store, sam, { threadId }));
    // Until the email worker records who is in it, only whoever started it gets in: the check never reads the discussion.
    expect(await outcome(openPage(backend, dana, key))).toBe("allowed");
    for (const who of [lee, mo, sam]) expect(await outcome(openPage(backend, who, key))).toBe(noThreadPage);
    // Sharing it queued that record; it emails no one.
    expect(await owed(backend)).toEqual([]);
    for (const who of [dana, lee, mo]) expect(await outcome(openPage(backend, who, key))).toBe("allowed");
    expect(await outcome(openPage(backend, sam, key))).toBe(noThreadPage);
    // Sharing again queues nothing more.
    await backend.run((store) => ops.threadPageKey(store, lee, { threadId }));
    expect(await backend.run((store) => store.replyEmailJobs.next())).toBeNull();
  });

  test(`${name}: editing an older thread's message, keeping its mentions, before its people are recorded still emails them a waiting reply`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Old prototype" }));
    const mo = reviewer("Mo");
    for (const who of [lee, mo]) await backend.run((store) => ops.syncReviewer(store, who));
    const [danaId, moId] = [await idOf(backend, dana), await idOf(backend, mo)];
    const { threadId, messageId } = await backend.run(async (store) => {
      const id = await store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: 1, lastMessageAt: 1, messageCount: 1 });
      const first = await store.messages.insert({ threadId: id, authorId: danaId, body: "@Mo look", createdAt: 1, editedAt: null, revision: null, mentions: [{ userId: moId, label: "Mo" }] });
      return { threadId: id, messageId: first };
    });
    // Lee's reply waits for the email worker to record who is in the thread; Dana fixes a typo meanwhile.
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed", revision: null }));
    await backend.run((store) => ops.editMessage(store, dana, { messageId, body: "@Mo, look" }));
    const recipients = (await owed(backend)).filter((delivery) => delivery.notifications.some((notice) => notice.kind === "reply")).map((delivery) => delivery.recipientId);
    expect(recipients.sort()).toEqual([danaId, moId].sort());
  });

  test(`${name}: someone whose mention is edited out of an older thread before its people are recorded can still open its page`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Old prototype" }));
    const mo = reviewer("Mo");
    for (const who of [lee, mo]) await backend.run((store) => ops.syncReviewer(store, who));
    const [danaId, leeId, moId] = [await idOf(backend, dana), await idOf(backend, lee), await idOf(backend, mo)];
    const { threadId, messageId } = await backend.run(async (store) => {
      const id = await store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: 1, lastMessageAt: 2, messageCount: 2 });
      await store.messages.insert({ threadId: id, authorId: danaId, body: "Old", createdAt: 1, editedAt: null, revision: null });
      const reply = await store.messages.insert({ threadId: id, authorId: leeId, body: "@Mo look", createdAt: 2, editedAt: null, revision: null, mentions: [{ userId: moId, label: "Mo" }] });
      return { threadId: id, messageId: reply };
    });
    const key = await backend.run((store) => ops.threadPageKey(store, dana, { threadId }));
    // Lee takes the mention out before the email worker has recorded who is in the thread.
    await backend.run((store) => ops.editMessage(store, lee, { messageId, body: "Never mind", mentions: [] }));
    await settle(backend);
    for (const who of [dana, lee, mo]) expect(await outcome(openPage(backend, who, key))).toBe("allowed");
  });

  test(`${name}: new threads have a page key; older ones get one the first time anyone who may review them shares them`, async () => {
    const backend = fresh();
    const { projectId, threadId, key, sam } = await pagedThread(backend);
    // Every request returns the same key, whoever asks.
    expect(await backend.run((store) => ops.threadPageKey(store, sam, { threadId }))).toBe(key);
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const danaId = await idOf(backend, dana);
    const older = await backend.run((store) =>
      store.threads.insert({ projectId, status: "open", anchor, tags: [], capture: failed, createdBy: danaId, createdAt: 1, lastMessageAt: 1, messageCount: 0, followersReady: true }),
    );
    const first = await backend.run((store) => ops.threadPageKey(store, lee, { threadId: older }));
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first).not.toBe(key);
    expect(await backend.run((store) => ops.threadPageKey(store, dana, { threadId: older }))).toBe(first);
    expect(await outcome(openPage(backend, dana, first))).toBe("allowed");
    // Sharing is refused like the thread itself: signed out, limited to the organization, or deleted.
    expect(await outcome(backend.run((store) => ops.threadPageKey(store, null, { threadId })))).toBe("unauthenticated: Sign in to view feedback.");
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    expect(await outcome(backend.run((store) => ops.threadPageKey(store, sam, { threadId })))).toBe(refusedOutsideOrganization);
    await backend.run((store) => ops.removeThread(store, dana, { threadId }));
    expect(await outcome(backend.run((store) => ops.threadPageKey(store, dana, { threadId })))).toBe("unavailable: This thread was deleted.");
  });

  test(`${name}: opening a thread page records nothing: not read state, and not the person as in the thread or the project`, async () => {
    const backend = fresh();
    const { projectId, key, riley } = await pagedThread(backend);
    const rileyId = await idOf(backend, riley);
    await openPage(backend, riley, key);
    expect((await backend.run((store) => ops.listThreads(store, riley, { projectId }, page))).page.map((thread) => thread.unread)).toEqual([true, true]);
    expect(await backend.run((store) => store.participants.find(projectId, rileyId))).toBeNull();
    expect((await backend.run((store) => ops.listParticipants(store, dana, { projectId, query: "Riley" }))).map((person) => person.name)).toEqual([]);
  });
}
