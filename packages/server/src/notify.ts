import { isPrivateReviewAddress, MAX_REVIEW_URL_LENGTH, reviewLink, type NotificationSettings, type ParticipantInfo } from "@critiqs/core";
import { fail } from "./errors.ts";
import { useQuota } from "./limits.ts";
import { canReview, projectQuota } from "./organizations.ts";
import { type EmailEntry, type EmailHeader, type EmailImage, emailImage, MentionEmail } from "./mention-email.ts";
import { MailError, type MailMessage } from "./signin.ts";
import type { NotificationRecord, ProjectRecord, Store, StoredMention, ThreadRecord } from "./store.ts";

// Mentions, replies, and the emails they cause. A mention names a reviewer by
// ID, chosen from the people who have commented in the project. A reply is
// emailed to everyone in its thread: whoever started it, replied, or was
// mentioned in it. The message and the emails it owes save together; a
// background job sends them later, retries failures, and sends one email for
// several mentions and replies in one thread. Each email shows the thread's
// capture and its whole discussion, so the reviewer can tell what it is about
// before opening it.

/** Most people one message may mention. */
export const MAX_MENTIONS = 20;
/** Suggestions offered for one query. */
export const MAX_SUGGESTIONS = 8;
/** Participants searched for suggestions: the most recently active ones. */
export const SUGGESTION_POOL = 200;
/** Pause before sending, so several mentions in quick succession arrive as one email. */
export const GATHER_MS = 60_000;
/** How long a worker may hold notifications while sending before another may take over. */
export const LEASE_MS = 2 * 60_000;
/** Attempts before a notification is given up as failed. */
export const MAX_ATTEMPTS = 6;
export const RETRY_MINUTES = [1, 5, 15, 60, 240];

/** Records that a reviewer has commented in a project, so others can mention them. */
export async function touchParticipant(store: Store, projectId: string, userId: string, at: number): Promise<void> {
  const existing = await store.participants.find(projectId, userId);
  if (existing === null) await store.participants.insert({ projectId, userId, lastActiveAt: at });
  else if (existing.lastActiveAt < at) await store.participants.patch(existing._id, { lastActiveAt: at });
}

/** Longest name a mention may show after `@`. */
export const MAX_MENTION_LABEL = 80;
/** Most mentions and replies one email reports; further ones start another email. */
export const MAX_PER_DELIVERY = 50;
/** People told about a reply per step of the background job; each may need a few reads and writes. */
export const REPLY_EMAIL_PAGE = 100;
/** How long finished deliveries are kept before cleanup. */
export const KEEP_FINISHED_DAYS = 30;

/** A mention as a client sends it: who, and the name the text shows after `@`. */
export interface MentionInput {
  userId: string;
  label: string;
}

/**
 * The reviewers a message may mention: each must have commented in the
 * project. The author mentioning themselves is allowed but never notified.
 */
export async function validateMentions(store: Store, projectId: string, mentions: MentionInput[]): Promise<StoredMention[]> {
  const valid: StoredMention[] = [];
  for (const mention of mentions) {
    const id = store.normalizeId("users", mention.userId);
    if (id === null || (await store.participants.find(projectId, id)) === null) {
      fail("invalid", "You can only mention people who have commented in this project.");
    }
    const label = mention.label.trim();
    if (label === "" || label.length > MAX_MENTION_LABEL || /[\n\r]/.test(label)) fail("invalid", "A mention needs a name.");
    if (!valid.some((existing) => existing.userId === id)) valid.push({ userId: id, label });
    if (valid.length > MAX_MENTIONS) fail("invalid", `Mention up to ${MAX_MENTIONS} people in one comment.`);
  }
  return valid;
}

/** What a notification reports: a message that mentions the recipient, or a reply in a thread they are in. */
export type NoticeKind = "mention" | "reply";

/**
 * Saves the emails a message owes to the reviewers it newly mentions, unless
 * they turned them off. A mention joins the reviewer's email for that thread
 * while it is still gathering; otherwise it starts a new one.
 */
export async function enqueueMentions(
  store: Store,
  args: { project: ProjectRecord; threadId: string; messageId: string; authorId: string; recipients: string[]; now: number },
): Promise<void> {
  await enqueue(store, args, "mention");
}

/**
 * Records people as having joined a thread once it had `since` messages, so
 * replies numbered above that email them. Someone already in it keeps their
 * first record: messages are only ever added, so a later event never means an
 * earlier join, and the scan of an older thread can't move one back.
 */
export async function follow(store: Store, threadId: string, people: string[], since: number): Promise<void> {
  for (const userId of new Set(people)) {
    if ((await store.followers.find(threadId, userId)) === null) await store.followers.insert({ threadId, userId, since });
  }
}

/** The position of a job that only records who is in an older thread: before every message, so no one is owed its email. */
const FOLLOWERS_ONLY = 0;

/**
 * Has the email worker record who is in a thread from before that was
 * recorded, a page of its discussion at a time, emailing no one. A thread
 * page's access check reads that record, never the whole discussion, which
 * one Convex transaction can't always read.
 */
export async function queueFollowerScan(store: Store, thread: ThreadRecord, now: number): Promise<void> {
  if (thread.followersReady === true) return;
  const first = await store.messages.first(thread._id);
  if (first === null) return;
  await store.replyEmailJobs.insert({
    projectId: thread.projectId,
    threadId: thread._id,
    messageId: first._id,
    authorId: thread.createdBy,
    createdAt: now,
    position: FOLLOWERS_ONLY,
    stage: "scan",
    cursor: null,
  });
}

/**
 * Queues a reply's emails to everyone else in its thread, which the email
 * worker owes before sending (`advanceReplyEmails`): a thread may have any
 * number of people, more than one transaction can email. People in the thread it
 * also mentions keep this reply notice beside their mention, so the email
 * still goes out (as a reply) if the mention is later removed.
 */
export async function queueReplyEmails(
  store: Store,
  args: { project: ProjectRecord; thread: ThreadRecord; messageId: string; authorId: string; position: number; now: number },
): Promise<void> {
  await store.replyEmailJobs.insert({
    projectId: args.project._id,
    threadId: args.thread._id,
    messageId: args.messageId,
    authorId: args.authorId,
    createdAt: args.now,
    position: args.position,
    stage: args.thread.followersReady === true ? "notify" : "scan",
    cursor: null,
  });
}

/**
 * One step of the background job that emails replies to everyone in their
 * thread, on the oldest waiting reply: a page of its older thread's messages,
 * to find who is in it, or a page of the people in it, to owe each of them
 * the email. Each step makes one paginated read, as a Convex transaction
 * allows. Returns whether more steps are waiting.
 */
export async function advanceReplyEmails(store: Store, now: number): Promise<boolean> {
  const job = await store.replyEmailJobs.next();
  if (job === null) return false;
  const thread = await store.threads.get(job.threadId);
  const project = await store.projects.get(job.projectId);
  if (thread === null || project === null || thread.status === "deleted") {
    await store.replyEmailJobs.delete(job._id);
    return true;
  }
  if (job.stage === "scan") {
    if (thread.followersReady === true) {
      if (job.position === FOLLOWERS_ONLY) await store.replyEmailJobs.delete(job._id);
      else await store.replyEmailJobs.patch(job._id, { stage: "notify", cursor: null });
      return true;
    }
    const result = await store.messages.list(thread._id, { numItems: DISCUSSION_PAGE, cursor: job.cursor === null ? null : job.cursor.slice(job.cursor.indexOf("|") + 1) });
    // People without a record joined at the position of their first message or mention; people recorded since (by
    // replies and edits) keep that record, so a mention added later by an edit isn't moved back.
    if (job.cursor === null) await follow(store, thread._id, [thread.createdBy], 1);
    const position = (job.cursor === null ? 0 : Number(job.cursor.split("|")[0])) || 0;
    let at = position;
    for (const message of result.page) {
      at++;
      await follow(store, thread._id, [message.authorId, ...(message.mentions ?? []).map((mention) => mention.userId)], at);
    }
    if (result.isDone) {
      await store.threads.patch(thread._id, { followersReady: true });
      // A job that only records who is in the thread owes no email.
      if (job.position === FOLLOWERS_ONLY) await store.replyEmailJobs.delete(job._id);
      else await store.replyEmailJobs.patch(job._id, { stage: "notify", cursor: null });
    } else {
      // The scan's cursor carries how many messages it has passed, then the store's own cursor.
      await store.replyEmailJobs.patch(job._id, { cursor: `${at}|${result.continueCursor}` });
    }
    return true;
  }
  const result = await store.followers.list(thread._id, { numItems: REPLY_EMAIL_PAGE, cursor: job.cursor });
  // Only people already in the thread before the reply; those who joined with it or later aren't told.
  const recipients = result.page.filter((follower) => follower.since < job.position).map((follower) => follower.userId);
  // Due a minute after the reply itself, like a mention, however long queuing took.
  await enqueue(store, { project, threadId: thread._id, messageId: job.messageId, authorId: job.authorId, recipients, now: job.createdAt }, "reply");
  if (result.isDone) await store.replyEmailJobs.delete(job._id);
  else await store.replyEmailJobs.patch(job._id, { cursor: result.continueCursor });
  return true;
}

async function enqueue(
  store: Store,
  args: { project: ProjectRecord; threadId: string; messageId: string; authorId: string; recipients: string[]; now: number },
  kind: NoticeKind,
): Promise<void> {
  const quota = await projectQuota(store, args.project);
  for (const recipientId of new Set(args.recipients)) {
    if (recipientId === args.authorId) continue;
    if (!(await wantsEmail(store, recipientId, args.project._id, kind))) continue;
    // Someone who can no longer review the project, such as after it was limited to its organization, isn't emailed its feedback.
    if (!(await canReview(store, args.project, recipientId))) continue;
    let delivery = await store.deliveries.gathering(recipientId, args.threadId);
    if (delivery !== null) {
      const gathered = await store.notifications.forDelivery(delivery._id, MAX_PER_DELIVERY);
      const same = gathered.filter((notification) => notification.messageId === args.messageId);
      // A mention removed and added again in the same message is still one mention; a reply is told once.
      if (same.some((notification) => (notification.kind ?? "mention") === kind)) continue;
      // A message may be owed as both a reply and a mention: each kind is checked on its own when sending.
      // Every notice counts toward the email's limit, which sending and cleanup read up to.
      if (gathered.length >= MAX_PER_DELIVERY) delivery = null;
    }
    // A new email counts against the plan's email allowance; over it, the mention
    // still shows in Critiqs and only the email is left out.
    if (delivery === null) {
      const allowed = await useQuota(store, { ...quota, metric: "mentionEmails", now: Date.now(), soft: true });
      if (!allowed) continue;
    }
    const deliveryId =
      delivery?._id ??
      (await store.deliveries.insert({
        recipientId,
        projectId: args.project._id,
        threadId: args.threadId,
        status: "pending",
        attempts: 0,
        dueAt: args.now + GATHER_MS,
        createdAt: args.now,
      }));
    await store.notifications.insert({
      deliveryId,
      recipientId,
      messageId: args.messageId,
      authorId: args.authorId,
      createdAt: args.now,
      ...(kind === "reply" ? { kind } : {}),
    });
  }
}

/** Whether a reviewer wants this kind of email from a project. Both kinds are on until turned off. */
async function wantsEmail(store: Store, userId: string, projectId: string, kind: NoticeKind): Promise<boolean> {
  const preferences = await store.preferences.find(userId);
  if (preferences === null) return true;
  if (preferences.mutedProjects.includes(projectId)) return false;
  return kind === "mention" ? preferences.mentionEmails : preferences.replyEmails !== false;
}

// ---------------------------------------------------------------------------
// What reviewers see and choose

/**
 * Mention suggestions: participants whose name contains the query, who can
 * still review the project. Names and pictures only, never email addresses.
 */
export async function listParticipants(
  store: Store,
  user: { _id: string } | null,
  project: ProjectRecord,
  query: string,
): Promise<ParticipantInfo[]> {
  const needle = query.trim().toLowerCase().slice(0, 60);
  const found: ParticipantInfo[] = [];
  for (const participant of await store.participants.recent(project._id, SUGGESTION_POOL)) {
    if (participant.userId === user?._id) continue;
    const person = await store.users.get(participant.userId);
    if (person === null || !person.name.toLowerCase().includes(needle)) continue;
    if (!(await canReview(store, project, person._id))) continue;
    found.push({ _id: person._id, name: person.name, imageUrl: person.imageUrl });
    if (found.length === MAX_SUGGESTIONS) break;
  }
  return found;
}

/** Participants searched for an exact name; past this, a name can't be shown to be unique. */
export const NAMED_POOL = 1_000;

/**
 * Everyone in a project with exactly this display name (any case), who can
 * still review it, for mentioning by name (`critiqs_reply`). `complete` is false when the project
 * has more participants than are searched, so uniqueness can't be shown.
 */
export async function participantsNamed(
  store: Store,
  project: ProjectRecord,
  name: string,
): Promise<{ people: ParticipantInfo[]; complete: boolean }> {
  const wanted = name.trim().toLowerCase();
  const pool = await store.participants.recent(project._id, NAMED_POOL + 1);
  const people: ParticipantInfo[] = [];
  for (const participant of pool.slice(0, NAMED_POOL)) {
    const person = await store.users.get(participant.userId);
    if (person !== null && person.name.trim().toLowerCase() === wanted && (await canReview(store, project, person._id))) people.push({ _id: person._id, name: person.name, imageUrl: person.imageUrl });
  }
  return { people, complete: pool.length <= NAMED_POOL };
}

export async function notificationSettings(store: Store, userId: string | null, projectId: string): Promise<NotificationSettings> {
  const preferences = userId === null ? null : await store.preferences.find(userId);
  return {
    mentionEmails: preferences?.mentionEmails ?? true,
    replyEmails: preferences?.replyEmails ?? true,
    projectMuted: preferences?.mutedProjects.includes(projectId) ?? false,
  };
}

/** Changes a reviewer's choices; unchanged fields stay as they were. */
export async function changePreferences(
  store: Store,
  userId: string,
  change: { mentionEmails?: boolean; replyEmails?: boolean; mute?: { projectId: string; muted: boolean } },
): Promise<void> {
  const existing = await store.preferences.find(userId);
  const current = existing ?? { mentionEmails: true, replyEmails: true, mutedProjects: [] as string[] };
  const mutedProjects =
    change.mute === undefined
      ? current.mutedProjects
      : change.mute.muted
        ? [...new Set([...current.mutedProjects, change.mute.projectId])]
        : current.mutedProjects.filter((id) => id !== change.mute!.projectId);
  const next = {
    mentionEmails: change.mentionEmails ?? current.mentionEmails,
    replyEmails: change.replyEmails ?? current.replyEmails ?? true,
    mutedProjects,
  };
  if (existing === null) await store.preferences.insert({ userId, ...next });
  else await store.preferences.patch(existing._id, next);
}

/**
 * Whether a project's review address only opens on one computer or private
 * network, such as `http://localhost:5173` or a Tailscale address, so reviewers
 * elsewhere can't follow mention emails to it. Health reports this; it reveals
 * no address.
 */
export function isLocalReviewAddress(address: string | undefined | null): boolean {
  return address !== undefined && address !== null && isPrivateReviewAddress(address);
}

// ---------------------------------------------------------------------------
// Delivery
//
// A worker sends each claimed delivery in steps, each its own transaction, so
// no step reads more than a page of a discussion:
//
// 1. `beginDelivery` checks the delivery is still wanted.
// 2. A new email reads the discussion with `discussionPage`, a page at a time,
//    and builds the email (`MentionEmail`) in the worker. The thread's version
//    (messages, newest message, edits) must not change between pages.
// 3. The worker stores the finished request as a private file, and
//    `freezeDelivery` records it only if the thread is still at that version;
//    otherwise it starts again.
// 4. The worker sends the stored request. Every retry sends the same file
//    under the same idempotency key, so the mail service sees identical requests.

/** Messages read per page of a discussion. */
const DISCUSSION_PAGE = 40;
/** Longest message link an email repeats: any saved review address, with the message parameter. */
export const MAX_LINK_LENGTH = MAX_REVIEW_URL_LENGTH + 100;
/** Times one run starts an email again because its thread changed while being read. */
const MAX_RESTARTS = 3;

/**
 * Takes up to `limit` deliveries that are ready, marking them as held by this
 * worker's `claimToken` for a while. A delivery that has used all its
 * attempts is given up instead. Returns the claimed IDs.
 */
export async function claimDue(store: Store, now: number, limit: number, claimToken: string): Promise<string[]> {
  const claimed: string[] = [];
  for (const delivery of await store.deliveries.due(now, limit)) {
    if (delivery.attempts >= MAX_ATTEMPTS) {
      await store.deliveries.patch(delivery._id, {
        status: "failed",
        finishedAt: now,
        reason: delivery.reason ?? `Gave up after ${MAX_ATTEMPTS} attempts.`,
      });
      if (delivery.payload !== undefined) await store.files.delete(delivery.payload.fileId);
      continue;
    }
    await store.deliveries.patch(delivery._id, {
      status: "sending",
      claimToken,
      leaseUntil: now + LEASE_MS,
      attempts: delivery.attempts + 1,
    });
    claimed.push(delivery._id);
  }
  return claimed;
}

/** What a worker should do with a claimed delivery. */
export type DeliveryStart =
  /** Another worker holds it now. */
  | { kind: "lost" }
  | { kind: "skip"; reason: string }
  /** Already prepared: send the stored request if one of `mentionIds` still mentions the reviewer. */
  | { kind: "prepared"; fileId: string; idempotencyKey: string; mentionIds: string[] }
  /** Prepared before emails were stored as files. */
  | { kind: "legacy"; message: MailMessage; mentionIds: string[] }
  | { kind: "new"; idempotencyKey: string; version: string; attempts: number; header: EmailHeader; captureFileId: string | null };

/**
 * Checks a claimed delivery is still wanted: the thread exists, the reviewer
 * has an address and wants these emails, and a retry still goes to the same
 * address. Reads no messages, so it stays small however long the thread is.
 */
export async function beginDelivery(
  store: Store,
  args: {
    id: string;
    claimToken: string;
    /** A signed mute (one project) or unsubscribe (all) link for a reviewer. */
    preferenceUrl: (scope: LinkScope) => Promise<string>;
  },
): Promise<DeliveryStart> {
  const delivery = await store.deliveries.get(args.id);
  if (delivery === null || delivery.status !== "sending" || delivery.claimToken !== args.claimToken) return { kind: "lost" };
  const recipient = await store.users.get(delivery.recipientId);
  const project = await store.projects.get(delivery.projectId);
  const thread = await store.threads.get(delivery.threadId);
  if (recipient === null || recipient.email === null) return { kind: "skip", reason: "The reviewer has no email address." };
  if (project === null || thread === null || thread.status === "deleted") return { kind: "skip", reason: "The thread was deleted." };
  if (!(await canReview(store, project, recipient._id))) return { kind: "skip", reason: NO_LONGER_ALLOWED };
  const notices = await store.notifications.forDelivery(delivery._id, MAX_PER_DELIVERY);
  // Only the kinds the reviewer still wants count; a delivery of only unwanted kinds isn't sent.
  const wanted: NotificationRecord[] = [];
  for (const notice of notices) if (await wantsEmail(store, recipient._id, project._id, notice.kind ?? "mention")) wanted.push(notice);
  if (wanted.length === 0) return { kind: "skip", reason: "The reviewer turned these emails off." };
  const mentionIds = wanted.map((notification) => notification.messageId);
  const idempotencyKey = `critiqs-mention:${delivery._id}`;
  // A retry sends exactly the first email, but never to an address the reviewer no longer uses.
  const sentTo = delivery.payload?.to ?? delivery.message?.to;
  if (sentTo !== undefined && sentTo !== recipient.email) return { kind: "skip", reason: "The reviewer's email address changed." };
  if (delivery.payload !== undefined) return { kind: "prepared", fileId: delivery.payload.fileId, idempotencyKey, mentionIds };
  if (delivery.message !== undefined) return { kind: "legacy", message: { ...delivery.message, idempotencyKey }, mentionIds };
  const capture = thread.capture;
  const info = capture.status === "failed" ? null : await store.files.info(capture.fileId);
  return {
    kind: "new",
    idempotencyKey,
    version: threadVersion(thread),
    attempts: delivery.attempts,
    captureFileId: capture.status !== "failed" && info !== null ? capture.fileId : null,
    header: {
      to: recipient.email,
      recipientName: recipient.name,
      projectName: project.name,
      status: thread.status,
      tags: thread.tags,
      messageCount: thread.messageCount,
      capture:
        capture.status === "failed"
          ? { note: `No capture was saved: ${capture.failureReason}` }
          : info === null
            ? { note: "The capture for this thread is no longer available." }
            : {
                size: info.size,
                caption:
                  capture.status === "captured"
                    ? "Captured when the comment was left, with the element outlined."
                    : "Screenshot attached to the thread (automatic capture failed).",
              },
      mute: await args.preferenceUrl({ userId: recipient._id, projectId: project._id }),
      unsubscribe: await args.preferenceUrl({ userId: recipient._id, projectId: null }),
    },
  };
}

/** Changes whenever a message is added or edited. */
function threadVersion(thread: ThreadRecord): string {
  return `${thread.messageCount}:${thread.lastMessageAt}:${thread.editCount ?? 0}`;
}

/** One page of a discussion for an email, or `changed` if the thread changed since the email started. */
export type DiscussionPage = { kind: "page"; entries: EmailEntry[]; isDone: boolean; cursor: string } | { kind: "changed" };

/** Reads one page of the discussion for a delivery's email, in order. */
export async function discussionPage(
  store: Store,
  args: { id: string; claimToken: string; version: string; cursor: string | null },
): Promise<DiscussionPage> {
  const delivery = await store.deliveries.get(args.id);
  if (delivery === null || delivery.status !== "sending" || delivery.claimToken !== args.claimToken) return { kind: "changed" };
  const thread = await store.threads.get(delivery.threadId);
  const project = await store.projects.get(delivery.projectId);
  if (thread === null || project === null || thread.status === "deleted" || threadVersion(thread) !== args.version) return { kind: "changed" };
  // Access can end while a long discussion is read; starting again finds the delivery is no longer wanted.
  if (!(await canReview(store, project, delivery.recipientId))) return { kind: "changed" };
  // Only the kinds the reviewer still wants count, as when the delivery began.
  const wants = {
    mention: await wantsEmail(store, delivery.recipientId, project._id, "mention"),
    reply: await wantsEmail(store, delivery.recipientId, project._id, "reply"),
  };
  // Each message's wanted kinds: it may be owed as a reply, a mention, or both.
  const reported = new Map<string, Set<NoticeKind>>();
  for (const notification of await store.notifications.forDelivery(delivery._id, MAX_PER_DELIVERY)) {
    const kind = notification.kind ?? "mention";
    if (!wants[kind]) continue;
    reported.set(notification.messageId, (reported.get(notification.messageId) ?? new Set()).add(kind));
  }
  const result = await store.messages.list(thread._id, { numItems: DISCUSSION_PAGE, cursor: args.cursor });
  const names = new Map<string, string>();
  const entries: EmailEntry[] = [];
  for (const message of result.page) {
    if (!names.has(message.authorId)) names.set(message.authorId, (await store.users.get(message.authorId))?.name ?? "Someone");
    const mentions = message.mentions ?? [];
    const mentionsYou = mentions.some((mention) => mention.userId === delivery.recipientId);
    entries.push({
      messageId: message._id,
      authorName: names.get(message.authorId)!,
      createdAt: message.createdAt,
      edited: message.editedAt !== null,
      body: message.body,
      mentions: mentions.map((mention) => ({ label: mention.label, you: mention.userId === delivery.recipientId })),
      mentionsYou,
      // A reply is reported while it exists; a mention while the message still mentions the reviewer.
      reported: (reported.get(message._id)?.has("reply") ?? false) || (mentionsYou && (reported.get(message._id)?.has("mention") ?? false)),
      ...(message.via === undefined ? {} : { via: message.via }),
      link: messageLink(project, message._id, thread._id),
    });
  }
  return { kind: "page", entries, isDone: result.isDone, cursor: result.continueCursor };
}

/**
 * Whether a message a delivery reports is still worth the email: a reply while
 * it exists, a mention while it still mentions the reviewer. One message per
 * call, so a retry reads little.
 */
export async function stillMentions(store: Store, args: { id: string; claimToken: string; messageId: string }): Promise<boolean> {
  const delivery = await store.deliveries.get(args.id);
  if (delivery === null || delivery.claimToken !== args.claimToken) return false;
  const message = await store.messages.get(args.messageId);
  if (message === null) return false;
  const kinds = new Set(
    (await store.notifications.forDelivery(delivery._id, MAX_PER_DELIVERY))
      .filter((notification) => notification.messageId === args.messageId)
      .map((notification) => notification.kind ?? "mention"),
  );
  // Each kind counts only while the reviewer still wants it.
  if (kinds.has("reply") && (await wantsEmail(store, delivery.recipientId, delivery.projectId, "reply"))) return true;
  return (
    kinds.has("mention") &&
    (await wantsEmail(store, delivery.recipientId, delivery.projectId, "mention")) &&
    (message.mentions ?? []).some((mention) => mention.userId === delivery.recipientId)
  );
}

/**
 * Records a delivery's prepared email, if this worker still holds the delivery
 * and the thread hasn't changed since the email was started.
 */
export async function freezeDelivery(
  store: Store,
  args: { id: string; claimToken: string; version: string; fileId: string; to: string },
): Promise<"frozen" | "changed" | "lost"> {
  const delivery = await store.deliveries.get(args.id);
  if (delivery === null || delivery.status !== "sending" || delivery.claimToken !== args.claimToken || delivery.payload !== undefined) return "lost";
  const thread = await store.threads.get(delivery.threadId);
  if (thread === null || thread.status === "deleted" || threadVersion(thread) !== args.version) return "changed";
  await store.deliveries.patch(delivery._id, { payload: { fileId: args.fileId, to: args.to } });
  return "frozen";
}

/**
 * Whether a held delivery may still go out: this worker holds it, its thread
 * isn't deleted, and the reviewer may still review the project. Checked again
 * right before the capture is read and right before the email goes to the
 * mail service, since access can end while an email is prepared or retried.
 */
export async function deliveryAllowed(store: Store, args: { id: string; claimToken: string }): Promise<boolean> {
  const delivery = await store.deliveries.get(args.id);
  if (delivery === null || delivery.status !== "sending" || delivery.claimToken !== args.claimToken) return false;
  const project = await store.projects.get(delivery.projectId);
  const thread = await store.threads.get(delivery.threadId);
  if (project === null || thread === null || thread.status === "deleted") return false;
  return await canReview(store, project, delivery.recipientId);
}

/** How a worker reaches its backend while sending one delivery. Each step runs in its own transaction. */
export interface DeliverySteps {
  begin(): Promise<DeliveryStart>;
  /** See `deliveryAllowed`. */
  allowed(): Promise<boolean>;
  page(args: { version: string; cursor: string | null }): Promise<DiscussionPage>;
  stillMentions(messageId: string): Promise<boolean>;
  freeze(args: { version: string; fileId: string; to: string }): Promise<"frozen" | "changed" | "lost">;
  /** A stored file, or null if there is none. Throws when storage can't be reached. */
  readFile(fileId: string): Promise<Blob | null>;
  saveFile(body: Blob): Promise<string>;
  deleteFile(fileId: string): Promise<void>;
  /** Sends a stored request (Resend's JSON without the sender); throws `MailError` when the mail service fails. */
  sendPrepared(body: Blob, idempotencyKey: string): Promise<void>;
  sendMessage(message: MailMessage): Promise<void>;
}

/** How sending went; null when another worker took the delivery over. */
export type DeliveryOutcome = { result: "sent" | "skipped" | "failed"; reason?: string } | null;

/** Sends one claimed delivery: prepares and stores its email the first time, then sends that stored email. */
export async function deliverOne(steps: DeliverySteps): Promise<DeliveryOutcome> {
  for (let restarts = 0; ; restarts++) {
    const start = await steps.begin();
    if (start.kind === "lost") return null;
    if (start.kind === "skip") return { result: "skipped", reason: start.reason };
    if (start.kind === "prepared" || start.kind === "legacy") {
      if (!(await anyStillMentions(steps, start.mentionIds))) return { result: "skipped", reason: "The mention was removed." };
      // Each send checks access right before it; finishing as skipped discards the prepared email.
      if (start.kind === "legacy") {
        if (!(await steps.allowed())) return { result: "skipped", reason: NO_LONGER_ALLOWED };
        return await send(() => steps.sendMessage(start.message));
      }
      let body: Blob | null;
      try {
        body = await steps.readFile(start.fileId);
      } catch {
        body = null;
      }
      // Never send anything else under this key; try the same email again later.
      if (body === null) return { result: "failed", reason: "The prepared email couldn't be read." };
      if (!(await steps.allowed())) return { result: "skipped", reason: NO_LONGER_ALLOWED };
      return await send(() => steps.sendPrepared(body, start.idempotencyKey));
    }
    if (restarts >= MAX_RESTARTS) return { result: "failed", reason: "The thread kept changing while its email was prepared." };

    const email = new MentionEmail(start.header);
    let changed = false;
    for (let cursor: string | null = null; ; ) {
      const page: DiscussionPage = await steps.page({ version: start.version, cursor });
      if (page.kind === "changed") {
        changed = true;
        break;
      }
      email.add(page.entries);
      if (page.isDone) break;
      cursor = page.cursor;
    }
    if (changed) continue;
    if (!email.mentionsRecipient) return { result: "skipped", reason: "The mention was removed." };
    let image: EmailImage | null = null;
    if (email.wantsImage && start.captureFileId !== null) {
      if (!(await steps.allowed())) return { result: "skipped", reason: NO_LONGER_ALLOWED };
      let blob: Blob | null;
      try {
        blob = await steps.readFile(start.captureFileId);
      } catch {
        // Storage may be briefly unavailable: try again later rather than fix an email without its capture.
        if (start.attempts < MAX_ATTEMPTS) return { result: "failed", reason: "The capture couldn't be read." };
        blob = null;
      }
      image = emailImage(blob === null ? null : new Uint8Array(await blob.arrayBuffer()));
    }
    const body = email.finish(image);
    if (body === null) return { result: "failed", reason: "This discussion is too large to send in an email." };
    const fileId = await steps.saveFile(body);
    const frozen = await steps.freeze({ version: start.version, fileId, to: start.header.to });
    if (frozen !== "frozen") {
      await steps.deleteFile(fileId);
      if (frozen === "lost") return null;
      continue;
    }
    // Finishing as skipped discards the email just stored.
    if (!(await steps.allowed())) return { result: "skipped", reason: NO_LONGER_ALLOWED };
    return await send(() => steps.sendPrepared(body, start.idempotencyKey));
  }
}

const NO_LONGER_ALLOWED = "The reviewer can no longer review this project.";

async function anyStillMentions(steps: DeliverySteps, messageIds: string[]): Promise<boolean> {
  for (const messageId of messageIds) if (await steps.stillMentions(messageId)) return true;
  return false;
}

async function send(attempt: () => Promise<void>): Promise<DeliveryOutcome> {
  try {
    await attempt();
    return { result: "sent" };
  } catch (error) {
    if (!(error instanceof MailError)) throw error;
    return { result: "failed", reason: error.message };
  }
}

/**
 * A message's link: the project's review address, exactly as its owner saved
 * it, with the message parameter. The thread's saved page is never used, so a
 * comment left on a local or private copy still links to the review page. An
 * address too long to repeat drops only its parameters and hash, staying under
 * its path. Null without a usable review address.
 */
function messageLink(project: ProjectRecord, messageId: string, threadId: string): string | null {
  if (project.reviewUrl === undefined) return null;
  const target = { threadId, messageId };
  try {
    const link = reviewLink(project.reviewUrl, target);
    if (link.length <= MAX_LINK_LENGTH) return link;
    const page = new URL(project.reviewUrl);
    page.search = "";
    page.hash = "";
    const shorter = reviewLink(page.toString(), target);
    return shorter.length <= MAX_LINK_LENGTH ? shorter : null;
  } catch {
    return null;
  }
}

/**
 * Records how sending went, only for deliveries this worker still holds.
 * Failures are retried after growing pauses; the last attempt's failure is
 * final. A finished delivery's prepared email is removed.
 */
export async function completeDeliveries(
  store: Store,
  outcomes: { deliveryId: string; claimToken: string; result: "sent" | "skipped" | "failed"; reason?: string }[],
  now: number,
): Promise<void> {
  for (const outcome of outcomes) {
    const delivery = await store.deliveries.get(outcome.deliveryId);
    if (delivery === null || delivery.status !== "sending" || delivery.claimToken !== outcome.claimToken) continue;
    const final = outcome.result !== "failed" || delivery.attempts >= MAX_ATTEMPTS;
    if (outcome.result === "sent") {
      await store.deliveries.patch(delivery._id, { status: "sent", finishedAt: now });
    } else if (outcome.result === "skipped") {
      await store.deliveries.patch(delivery._id, { status: "skipped", finishedAt: now, reason: outcome.reason });
    } else if (final) {
      await store.deliveries.patch(delivery._id, { status: "failed", finishedAt: now, reason: outcome.reason });
    } else {
      const pause = RETRY_MINUTES[Math.min(delivery.attempts - 1, RETRY_MINUTES.length - 1)]! * 60_000;
      await store.deliveries.patch(delivery._id, { status: "pending", dueAt: now + pause, reason: outcome.reason });
    }
    if (final && delivery.payload !== undefined) await store.files.delete(delivery.payload.fileId);
  }
}

/** Removes finished deliveries older than the retention period, with their mentions. Returns how many. */
export async function cleanUpDeliveries(store: Store, now: number, limit: number): Promise<number> {
  const old = await store.deliveries.finishedBefore(now - KEEP_FINISHED_DAYS * 24 * 60 * 60_000, limit);
  for (const delivery of old) {
    for (const notification of await store.notifications.forDelivery(delivery._id, MAX_PER_DELIVERY)) {
      await store.notifications.delete(notification._id);
    }
    if (delivery.payload !== undefined) await store.files.delete(delivery.payload.fileId);
    await store.deliveries.delete(delivery._id);
  }
  return old.length;
}

// ---------------------------------------------------------------------------
// Mute and unsubscribe links

/** What a mute or unsubscribe link changes: one project's emails, or all of Critiqs's emails (mentions and replies). */
export type LinkScope = { userId: string; projectId: string | null };

/** A link token that authorizes only that one change, for that one reviewer. */
export async function preferenceToken(secret: string, scope: LinkScope): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify([scope.userId, scope.projectId])));
  return `${payload}.${await sign(secret, payload)}`;
}

export async function readPreferenceToken(secret: string, token: string): Promise<LinkScope | null> {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined || token.length > 500) return null;
  const expected = await sign(secret, payload);
  if (expected.length !== signature.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (difference !== 0) return null;
  try {
    const [userId, projectId] = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as [string, string | null];
    return typeof userId === "string" && (projectId === null || typeof projectId === "string") ? { userId, projectId } : null;
  } catch {
    return null;
  }
}

/** Applies a mute or unsubscribe link's change. */
export async function applyPreferenceLink(store: Store, scope: LinkScope): Promise<void> {
  const userId = store.normalizeId("users", scope.userId);
  if (userId === null || (await store.users.get(userId)) === null) return;
  if (scope.projectId === null) await changePreferences(store, userId, { mentionEmails: false, replyEmails: false });
  else await changePreferences(store, userId, { mute: { projectId: scope.projectId, muted: true } });
}

async function sign(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(`critiqs-preferences:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
