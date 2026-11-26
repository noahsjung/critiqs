import {
  type Anchor,
  type CaptureState,
  DEFAULT_TAGS as CORE_DEFAULT_TAGS,
  type NotificationSettings,
  type ParticipantInfo,
  type ProjectUsage,
  type ExportPage,
  isUnread,
  type Page,
  type PageRequest,
  type ProjectInfo,
  type ProjectTags,
  type ReactionRow,
  REACTIONS,
  type Revision,
  type TargetLocation,
  type ThreadDetailPage,
  type ThreadMockup,
  type ThreadSummary,
  parseOnboardingAnswers,
  parseStack,
  startingTags,
  validReviewUrl,
} from "@critiqs/core";
import { fail } from "./errors.ts";
import { planFor, requireRoom, usageDay, usageSummary, useQuota } from "./limits.ts";
import { checkThreadMockup } from "./mockups.ts";
import { acceptInvites, homeOrganization, projectAccess, projectQuota, projectRole } from "./organizations.ts";
import {
  changePreferences,
  enqueueMentions,
  follow,
  queueReplyEmails,
  type MentionInput,
  listParticipants as participantsMatching,
  notificationSettings,
  participantsNamed,
  touchParticipant,
  validateMentions,
} from "./notify.ts";
import type { Identity, ProjectOnboarding, ProjectRecord, StoredCapture, StoredMention, Store, ThreadRecord, UserRecord } from "./store.ts";
import {
  explicitTags,
  messageHashtags,
  projectTags,
  registerTags,
  syncThreadTags,
  textTagLabels,
  threadTags,
  updateTextTags,
} from "./tags.ts";

export { createGroup, deleteGroup, mergeGroups, renameGroup, setTagGroups } from "./tags.ts";

// Critiqs's server rules (F2–F12), shared by every backend. Each function runs
// inside one transaction of the backend that calls it.

/**
 * Initial project tags (F11). Core keeps the list, read-only, with the starting
 * tags for each purpose; this copy stays a `string[]`, as callers have had it.
 */
export const DEFAULT_TAGS: string[] = [...CORE_DEFAULT_TAGS];

/** Operational request bound, independent of product storage/export limits. */
export const PAGE_SIZE = 40;
export const MAX_BODY_LENGTH = 10_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Image types captures and screenshots may have: raster formats that can't carry scripts, unlike SVG. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const UPLOAD_MINUTES = 60;
export const MAX_MESSAGES = 500;
export const MAX_EXPORT_THREADS = 200;

// ---------------------------------------------------------------------------
// Reviewers

/** The signed-in reviewer, without writing; `user` is null before their first change. */
export async function currentReviewer(store: Store, identity: Identity | null) {
  if (identity === null) fail("unauthenticated", "Sign in to view feedback.");
  if (!identity.emailVerified || !identity.email) fail("email-unverified", "Verify your email address first.");
  const user = await store.users.byToken(identity.tokenIdentifier);
  return { identity, user };
}

/** The signed-in reviewer's record, created or refreshed from their sign-in. */
export async function requireUser(store: Store, identity: Identity | null): Promise<UserRecord> {
  const { user } = await currentReviewer(store, identity);
  const signedIn = identity!;
  const version = signedIn.profileVersion ?? undefined;
  const profile = {
    tokenIdentifier: signedIn.tokenIdentifier,
    // Never the email address: names are shown to everyone in the project.
    name: signedIn.name ?? "Reviewer",
    email: signedIn.email,
    imageUrl: signedIn.pictureUrl,
    ...(version === undefined ? {} : { profileVersion: version }),
  };
  if (user === null) {
    const id = await store.users.insert(profile);
    return { _id: id, ...profile };
  }
  // A sign-in from before the reviewer's latest rename still authorizes them,
  // but must not put back their previous name. Sign-ins without a version
  // predate versioning, so they are older than any recorded version.
  const older = user.profileVersion !== undefined && (version === undefined || version < user.profileVersion);
  const next = {
    name: older ? user.name : profile.name,
    email: profile.email,
    imageUrl: profile.imageUrl,
    profileVersion: older ? user.profileVersion : profile.profileVersion,
  };
  if (
    user.name !== next.name ||
    user.email !== next.email ||
    user.imageUrl !== next.imageUrl ||
    user.profileVersion !== next.profileVersion
  ) {
    await store.users.patch(user._id, next);
  }
  return { ...user, ...next };
}

/**
 * Updates the reviewer's record from their sign-in, and joins the
 * organizations that invited their address; returns the name it now shows.
 */
export async function syncReviewer(store: Store, identity: Identity | null): Promise<string> {
  const user = await requireUser(store, identity);
  await acceptInvites(store, user, Date.now());
  return user.name;
}

// ---------------------------------------------------------------------------
// Projects

/**
 * Any signed-in reviewer who has the project's ID can access it (F12); the
 * company guards access to the prototype that carries the ID. Callers check
 * sign-in first. Restricting projects to a company email domain comes later.
 */
export async function requireProject(store: Store, projectId: string): Promise<ProjectRecord> {
  const id = store.normalizeId("projects", projectId);
  const project = id === null ? null : await store.projects.get(id);
  if (project === null) fail("not-found", "This project does not exist.");
  return project;
}

/** Deleted threads are reported unavailable rather than returned (F10). */
export async function requireThread(store: Store, threadId: string) {
  const id = store.normalizeId("threads", threadId);
  const thread = id === null ? null : await store.threads.get(id);
  if (thread === null) fail("not-found", "This thread does not exist.");
  const project = await requireProject(store, thread.projectId);
  if (thread.status === "deleted") fail("unavailable", "This thread was deleted.");
  return { thread, project };
}

/** Onboarding's answers about a project, as sent: values it doesn't know are dropped, as if skipped. */
export interface ProjectAnswersInput {
  codeAccess?: string;
  feedbackFrom?: string[];
  purpose?: string;
}

/**
 * Project setup: any signed-in reviewer can create a project, optionally with
 * its review address, in an organization they belong to: the one they choose,
 * or else their home organization. Setup checks the address first; an
 * address emails can't link to, which older setup could send, is left out
 * rather than refused. Onboarding also sends its answers about the project
 * and the stack: what it's for picks the starting tags, and without it the
 * project starts with the default tags.
 */
export async function createProject(
  store: Store,
  identity: Identity | null,
  args: { name: string; reviewUrl?: string | null; organizationId?: string; onboarding?: ProjectAnswersInput; stack?: string },
): Promise<string> {
  const user = await requireUser(store, identity);
  const name = args.name.trim();
  if (name === "") fail("invalid", "A project needs a name.");
  const reviewUrl = args.reviewUrl == null ? null : validReviewUrl(args.reviewUrl.trim());
  const onboarding = projectOnboarding(args.onboarding, args.stack);
  const now = Date.now();
  const organization = args.organizationId === undefined ? await homeOrganization(store, user, now) : await chosenOrganization(store, user, args.organizationId);
  await useQuota(store, { plan: await planFor(store, organization), metric: "projects", accountId: organization._id, projectId: null, now });
  return await store.projects.insert({
    name,
    tags: [...startingTags(onboarding?.purpose)],
    createdBy: user._id,
    createdAt: now,
    organizationId: organization._id,
    ...(reviewUrl === null ? {} : { reviewUrl }),
    ...(onboarding === null ? {} : { onboarding }),
  });
}

/** The answers worth keeping on a new project; null when every one was skipped or unknown. */
function projectOnboarding(answers: ProjectAnswersInput | undefined, stack: string | undefined): ProjectOnboarding | null {
  const { codeAccess, feedbackFrom, purpose } = parseOnboardingAnswers(answers);
  const picked = parseStack(stack);
  const kept: ProjectOnboarding = {
    ...(codeAccess === undefined ? {} : { codeAccess }),
    ...(feedbackFrom === undefined ? {} : { feedbackFrom: [...feedbackFrom] }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(picked === undefined ? {} : { stack: picked }),
  };
  return Object.keys(kept).length === 0 ? null : kept;
}

async function chosenOrganization(store: Store, user: UserRecord, organizationId: string) {
  const id = store.normalizeId("organizations", organizationId);
  const organization = id === null ? null : await store.organizations.get(id);
  if (organization === null || (await store.memberships.find(organization._id, user._id)) === null) {
    fail("forbidden", "You can create projects only in organizations you belong to.");
  }
  return organization;
}

/** The review address mention emails link to. Only those who manage the project may change it; nothing else does. */
export async function setReviewUrl(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; reviewUrl: string },
): Promise<void> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, args.projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", "Only the person who set up this project can change it.");
  const reviewUrl = validReviewUrl(args.reviewUrl.trim());
  if (reviewUrl === null) fail("invalid", "Use the prototype's address, starting with https:// (or http://localhost).");
  await store.projects.patch(project._id, { reviewUrl });
}

/** Projects the reviewer created, so setup can reconnect an existing project. */
export async function listMyProjects(
  store: Store,
  identity: Identity | null,
  request: PageRequest,
): Promise<Page<ProjectInfo>> {
  const { user } = await currentReviewer(store, identity);
  if (user === null) return { page: [], isDone: true, continueCursor: "" };
  const result = await store.projects.listByCreator(user._id, boundedPage(request));
  return {
    page: await Promise.all(result.page.map((project) => projectInfo(store, project, user._id))),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}

export async function getProject(store: Store, identity: Identity | null, args: { projectId: string }): Promise<ProjectInfo> {
  const { user } = await currentReviewer(store, identity);
  return await projectInfo(store, await requireProject(store, args.projectId), user?._id ?? null);
}

async function projectInfo(store: Store, project: ProjectRecord, userId: string | null): Promise<ProjectInfo> {
  const { access, organization } = await projectRole(store, project, userId);
  return {
    _id: project._id,
    name: project.name,
    tags: project.tags,
    createdAt: project.createdAt,
    reviewUrl: project.reviewUrl ?? null,
    isOwner: access === "manage",
    ...(organization === null ? {} : { organization }),
  };
}

/**
 * A project's usage against its Critiqs Cloud plan; null on a deployment
 * without plans. Only those who manage it see it. Components that read
 * `aiCredits` ask for it; components from before it get Critiqs AI credits
 * as `aiRequests`, which they show as credits.
 */
export async function getUsage(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; day?: string; aiCredits?: boolean },
): Promise<ProjectUsage | null> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, args.projectId);
  if ((await projectAccess(store, project, user?._id ?? null)) !== "manage") fail("forbidden", "Only the person who set up this project can see its usage.");
  const usage = await usageSummary(store, await projectQuota(store, project), usageDay(args.day, Date.now()));
  return usage === null || args.aiCredits === true ? usage : creditsAsAiRequests(usage);
}

function creditsAsAiRequests(usage: ProjectUsage): ProjectUsage {
  const rows = usage.rows.filter((row) => row.metric !== "aiRequests").map((row) => (row.metric === "aiCredits" ? { ...row, metric: "aiRequests" as const } : row));
  return { ...usage, rows };
}

/** Mention suggestions: people who have commented in the project, by name. */
export async function listParticipants(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; query: string },
): Promise<ParticipantInfo[]> {
  const { user } = await currentReviewer(store, identity);
  return await participantsMatching(store, user, await requireProject(store, args.projectId), args.query);
}

/** Everyone else in the project with exactly this name, and whether every participant was searched. Never yourself, as in suggestions. */
export async function listParticipantsNamed(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; name: string },
): Promise<{ people: ParticipantInfo[]; complete: boolean }> {
  const { user } = await currentReviewer(store, identity);
  if (args.name.trim() === "" || args.name.length > 200) fail("invalid", "Give a name of 1 to 200 characters.");
  const found = await participantsNamed(store, await requireProject(store, args.projectId), args.name);
  return { ...found, people: found.people.filter((person) => person._id !== user?._id) };
}

export async function getNotificationSettings(
  store: Store,
  identity: Identity | null,
  args: { projectId: string },
): Promise<NotificationSettings> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, args.projectId);
  return await notificationSettings(store, user?._id ?? null, project._id);
}

export async function setNotificationSettings(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; mentionEmails?: boolean; replyEmails?: boolean; projectMuted?: boolean },
): Promise<void> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, args.projectId);
  await changePreferences(store, user._id, {
    ...(args.mentionEmails === undefined ? {} : { mentionEmails: args.mentionEmails }),
    ...(args.replyEmails === undefined ? {} : { replyEmails: args.replyEmails }),
    ...(args.projectMuted === undefined ? {} : { mute: { projectId: project._id, muted: args.projectMuted } }),
  });
}

// ---------------------------------------------------------------------------
// Threads

/** A new thread's image by file ID, a screenshot supplied after capture failed, or the reason capture failed. */
export type CaptureInput =
  | { status: "captured"; fileId: string }
  | { status: "supplied"; fileId: string; failureReason: string }
  | { status: "failed"; failureReason: string };

/**
 * A message's hashtags. Mockup threads have none: their chat names colors and
 * selectors such as `#f5f5f5` or `#header`, which would otherwise become tags
 * in the normal sidebar's filters and grouping.
 */
function threadHashtags(body: string, inMockup: boolean): string[] {
  return inMockup ? [] : messageHashtags(body);
}

/**
 * Starts a thread with its first message. The author has read their own
 * thread. A mockup thread's backend checks first that its mockup and copy
 * are in the project.
 */
export async function createThread(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; anchor: Anchor; body: string; tags: string[]; capture: CaptureInput; mentions?: MentionInput[]; mockup?: ThreadMockup },
): Promise<string> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, args.projectId);
  const mentions = await validateMentions(store, project._id, args.mentions ?? []);
  validateLocation(args.anchor);
  if (args.mockup !== undefined) checkThreadMockup(args.mockup);
  let imageBytes = 0;
  let capture: StoredCapture;
  if (args.capture.status === "failed") {
    capture = args.capture;
  } else {
    const image = await validateImage(store, args.capture.fileId);
    imageBytes = image.size;
    capture = { ...args.capture, fileId: image.id };
  }
  const body = validateBody(args.body);
  const hashtags = threadHashtags(body, args.mockup !== undefined);
  const textTags = updateTextTags([], [], hashtags);
  // Tags chosen with the tag buttons stay explicit even when the text also writes them.
  const tags = explicitTags(args.tags);
  const now = Date.now();
  const quota = { ...(await projectQuota(store, project)), now };
  await useQuota(store, { ...quota, metric: "threads" });
  await useQuota(store, { ...quota, metric: "messages" });
  await useQuota(store, { ...quota, metric: "reviewers", member: user._id });
  if (imageBytes > 0) await useQuota(store, { ...quota, metric: "captureBytes", amount: imageBytes });
  const threadId = await store.threads.insert({
    projectId: project._id,
    status: "open",
    anchor: args.anchor,
    tags,
    capture,
    createdBy: user._id,
    createdAt: now,
    lastMessageAt: now,
    messageCount: 1,
    textTags,
    // Who is in the thread is recorded from its first message on.
    followersReady: true,
    ...(args.mockup === undefined ? {} : { mockup: args.mockup }),
  });
  const messageId = await store.messages.insert({
    threadId,
    authorId: user._id,
    body,
    createdAt: now,
    editedAt: null,
    revision: args.anchor.evidence.revision,
    ...(mentions.length === 0 ? {} : { mentions }),
    projectId: project._id,
    hashtags,
  });
  await registerTags(store, project._id, [...tags, ...hashtags], now);
  await syncThreadTags(store, { _id: threadId, projectId: project._id, tags, textTags });
  await markReadThrough(store, user._id, threadId, now);
  await touchParticipant(store, project._id, user._id, now);
  await enqueueMentions(store, { project, threadId, messageId, authorId: user._id, recipients: mentions.map((mention) => mention.userId), now });
  // Its author and the people it mentions are in the thread from its first message, for reply emails.
  await follow(store, threadId, [user._id, ...mentions.map((mention) => mention.userId)], 1);
  return threadId;
}

/** Threads the reviewer may see, with their personal unread state. Filtering and grouping happen in @critiqs/core. */
export async function listThreads(
  store: Store,
  identity: Identity | null,
  args: { projectId: string },
  request: PageRequest,
): Promise<Page<ThreadSummary>> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, args.projectId);
  const result = await store.threads.listVisible(project._id, boundedPage(request));
  const page = await Promise.all(result.page.map((thread) => threadSummary(store, user, thread)));
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

/** A thread as lists show it, with the reviewer's own unread state; `user` is null before their first change. */
export async function threadSummary(store: Store, user: UserRecord | null, thread: ThreadRecord): Promise<ThreadSummary> {
  const first = await store.messages.first(thread._id);
  const readState = user === null ? null : await store.readStates.find(user._id, thread._id);
  const author = first === null ? null : await store.users.get(first.authorId);
  return {
    _id: thread._id,
    status: visibleStatus(thread),
    anchor: thread.anchor,
    location: thread.reattachment?.location ?? null,
    tags: threadTags(thread),
    textTags: textTagLabels(thread),
    createdAt: thread.createdAt,
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    unread: isUnread(thread.lastMessageAt, readState),
    preview: first === null ? null : { body: first.body, authorName: author?.name ?? "Unknown", authorImageUrl: author?.imageUrl ?? null },
    ...(thread.mockup === undefined ? {} : { mockup: thread.mockup }),
  };
}

/** A bounded discussion page. Metadata and read state accompany every page. */
export async function getThread(
  store: Store,
  identity: Identity | null,
  args: { threadId: string },
  request: PageRequest,
): Promise<ThreadDetailPage> {
  const { user } = await currentReviewer(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  const result = await store.messages.list(thread._id, boundedPage(request));
  const nameOf = async (id: string | undefined) => (id === undefined ? null : ((await store.users.get(id))?.name ?? "Unknown"));
  const readState = user === null ? null : await store.readStates.find(user._id, thread._id);
  const { reattachment } = thread;
  return {
    _id: thread._id,
    projectId: thread.projectId,
    status: visibleStatus(thread),
    anchor: thread.anchor,
    tags: threadTags(thread),
    textTags: textTagLabels(thread),
    capture: captureState(thread.capture),
    createdAt: thread.createdAt,
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    statusChangedByName: await nameOf(thread.statusChangedBy),
    ...(thread.statusChangedAt === undefined ? {} : { statusChangedAt: thread.statusChangedAt }),
    ...(reattachment === undefined
      ? {}
      : { reattachment: { location: reattachment.location, reattachedAt: reattachment.reattachedAt } }),
    reattachedByName: await nameOf(reattachment?.reattachedBy),
    readState: readState === null ? null : { lastReadAt: readState.lastReadAt, manualUnread: readState.manualUnread },
    ...(thread.mockup === undefined ? {} : { mockup: thread.mockup }),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
    page: await Promise.all(
      result.page.map(async (message) => {
        const author = await store.users.get(message.authorId);
        return {
          _id: message._id,
          body: message.body,
          mentions: await mentionViews(store, message.mentions ?? []),
          createdAt: message.createdAt,
          editedAt: message.editedAt,
          revision: message.revision,
          author: { name: author?.name ?? "Unknown", imageUrl: author?.imageUrl ?? null },
          authorId: message.authorId,
          ...(message.via === undefined ? {} : { via: message.via }),
          ...(message.mockupVersion === undefined ? {} : { mockupVersion: message.mockupVersion }),
          isMine: user !== null && message.authorId === user._id,
        };
      }),
    ),
  };
}

/** Reactions page independently, so a busy discussion cannot overflow a request. */
export async function listReactions(
  store: Store,
  identity: Identity | null,
  args: { threadId: string },
  request: PageRequest,
): Promise<Page<ReactionRow>> {
  const { user } = await currentReviewer(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  const result = await store.reactions.list(thread._id, boundedPage(request));
  return {
    isDone: result.isDone,
    continueCursor: result.continueCursor,
    page: result.page.map((row) => ({ messageId: row.messageId, emoji: row.emoji, mine: row.userId === user?._id })),
  };
}

/** Anyone with project access can resolve or reopen a thread (F3). */
export async function setStatus(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; status: "open" | "resolved" },
): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  if (thread.status === args.status) return;
  await store.threads.patch(thread._id, { status: args.status, statusChangedBy: user._id, statusChangedAt: Date.now() });
}

/** Soft delete: hides the thread and records who deleted it, keeping its history. */
export async function removeThread(store: Store, identity: Identity | null, args: { threadId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  await store.threads.patch(thread._id, { status: "deleted", statusChangedBy: user._id, statusChangedAt: Date.now() });
}

/**
 * Sets a thread's explicit tags: presets or free tags. Hashtags its messages
 * use stay whether or not the list includes them, so older clients that send
 * the whole tag list back neither repeat nor drop them.
 */
export async function setTags(store: Store, identity: Identity | null, args: { threadId: string; tags: string[] }): Promise<void> {
  await requireUser(store, identity);
  const { thread, project } = await requireThread(store, args.threadId);
  const tags = explicitTags(args.tags, thread);
  await store.threads.patch(thread._id, { tags });
  await registerTags(store, project._id, tags.filter((tag) => !thread.tags.includes(tag)), Date.now());
  await syncThreadTags(store, { ...thread, tags });
}

/** The project's tags for suggestions and filters, and its shared tag groups. */
export async function listTags(store: Store, identity: Identity | null, args: { projectId: string }): Promise<ProjectTags> {
  const { user } = await currentReviewer(store, identity);
  return await projectTags(store, await requireProject(store, args.projectId), user?._id ?? null);
}

/**
 * Points a thread at a replacement target. The anchor keeps the original
 * target, capture, and context as evidence (F8).
 */
export async function reattach(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; location: TargetLocation },
): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  validateLocation(args.location);
  await store.threads.patch(thread._id, {
    reattachment: { location: args.location, reattachedBy: user._id, reattachedAt: Date.now() },
  });
}

/** One selected thread's export page; callers combine pages into full discussions. Mockup threads aren't exported. */
export async function exportThreads(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; threadIds: string[]; threadIndex: number },
  request: PageRequest,
): Promise<ExportPage> {
  await currentReviewer(store, identity);
  const project = await requireProject(store, args.projectId);
  if (args.threadIds.length > MAX_EXPORT_THREADS) fail("invalid", `Export up to ${MAX_EXPORT_THREADS} threads at a time.`);
  const ids = [...new Set(args.threadIds)];
  const { threadIndex } = args;
  if (!Number.isInteger(threadIndex) || threadIndex < 0 || threadIndex >= ids.length) fail("invalid", "Invalid export page.");
  const empty: ExportPage = { projectName: project.name, thread: null, page: [], isDone: true, continueCursor: "" };
  const id = store.normalizeId("threads", ids[threadIndex]!);
  const thread = id === null ? null : await store.threads.get(id);
  if (thread === null || thread.projectId !== project._id || thread.status === "deleted" || thread.mockup !== undefined) return empty;
  const result = await store.messages.list(thread._id, boundedPage(request));
  return {
    projectName: project.name,
    thread: {
      _id: thread._id,
      status: visibleStatus(thread),
      tags: threadTags(thread),
      anchor: thread.anchor,
      location: thread.reattachment?.location ?? null,
      hasCapture: thread.capture.status !== "failed",
    },
    isDone: result.isDone,
    continueCursor: result.continueCursor,
    page: await Promise.all(
      result.page.map(async (message) => ({
        _id: message._id,
        author: (await store.users.get(message.authorId))?.name ?? "Unknown",
        authorId: message.authorId,
        ...(message.via === undefined ? {} : { via: message.via }),
        body: message.body,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        revision: message.revision,
      })),
    ),
  };
}

/** Attaches a reviewer-supplied screenshot when automatic capture failed (F6). */
export async function attachScreenshot(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; fileId: string },
): Promise<void> {
  await requireUser(store, identity);
  const { thread, project } = await requireThread(store, args.threadId);
  // Once attached, an image stays with its thread, so it can never be attached elsewhere.
  if (thread.capture.status !== "failed") fail("invalid", "This thread already has an image.");
  const image = await validateImage(store, args.fileId);
  await useQuota(store, { ...(await projectQuota(store, project)), metric: "captureBytes", amount: image.size, now: Date.now() });
  await store.threads.patch(thread._id, {
    capture: { status: "supplied", fileId: image.id, failureReason: thread.capture.failureReason },
  });
}

/** Checks a reviewer may upload an image to a project; the backend then issues the upload. */
export async function authorizeUpload(store: Store, identity: Identity | null, args: { projectId: string }): Promise<void> {
  await requireUser(store, identity);
  const project = await requireProject(store, args.projectId);
  // An upload's size is known only once it is attached, where it is counted; a full project takes no more.
  await requireRoom(store, { ...(await projectQuota(store, project)), metric: "captureBytes", now: Date.now() });
}

/** File ID of a thread's image, after the same access checks as reading the thread. */
export async function authorizedCapture(store: Store, identity: Identity | null, args: { threadId: string }): Promise<string | null> {
  await currentReviewer(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  return thread.capture.status === "failed" ? null : thread.capture.fileId;
}

// ---------------------------------------------------------------------------
// Messages

/**
 * Adds a reply. Everyone else in the thread is emailed about it (unless they
 * turned that off), and people it mentions get a mention email instead. With
 * `via: "agent"`, a coding agent wrote it for the signed-in reviewer, and
 * Critiqs shows that beside their name.
 */
export async function reply(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; body: string; revision: Revision; mentions?: MentionInput[]; via?: "agent" },
): Promise<string> {
  if (args.via !== undefined && args.via !== "agent") fail("invalid", "Unknown author kind.");
  const user = await requireUser(store, identity);
  const { thread, project } = await requireThread(store, args.threadId);
  const mentions = await validateMentions(store, project._id, args.mentions ?? []);
  if (thread.messageCount >= MAX_MESSAGES) fail("invalid", "This thread has reached its reply limit; start a new thread.");
  const body = validateBody(args.body);
  const hashtags = threadHashtags(body, thread.mockup !== undefined);
  const textTags = updateTextTags(thread.textTags, [], hashtags);
  // Strictly later than the previous message, so read state can tell them apart (F5).
  const now = Math.max(Date.now(), thread.lastMessageAt + 1);
  // Usage periods follow the real clock, not the message order above.
  const quota = { ...(await projectQuota(store, project)), now: Date.now() };
  await useQuota(store, { ...quota, metric: "messages" });
  await useQuota(store, { ...quota, metric: "reviewers", member: user._id });
  const before = await store.readStates.find(user._id, thread._id);
  const messageId = await store.messages.insert({
    threadId: thread._id,
    authorId: user._id,
    body,
    createdAt: now,
    editedAt: null,
    revision: args.revision,
    ...(mentions.length === 0 ? {} : { mentions }),
    projectId: project._id,
    hashtags,
    ...(args.via === undefined ? {} : { via: args.via }),
  });
  await store.threads.patch(thread._id, { lastMessageAt: now, messageCount: thread.messageCount + 1, textTags });
  await registerTags(store, project._id, hashtags, now);
  await syncThreadTags(store, { ...thread, textTags });
  await touchParticipant(store, project._id, user._id, now);
  const mentioned = mentions.map((mention) => mention.userId);
  await enqueueMentions(store, { project, threadId: thread._id, messageId, authorId: user._id, recipients: mentioned, now });
  // Everyone else in the thread is emailed by the background worker; its author and mentions join it.
  const position = thread.messageCount + 1;
  await queueReplyEmails(store, { project, thread, messageId, authorId: user._id, position, now });
  await follow(store, thread._id, [user._id, ...mentioned], position);
  // The author has read their own reply, but replies they have not seen stay unread (F5).
  const caughtUp = before !== null && !before.manualUnread && before.lastReadAt >= thread.lastMessageAt;
  if (caughtUp) await markReadThrough(store, user._id, thread._id, now);
  return messageId;
}

/**
 * Saves Critiqs AI's answer in a mockup thread, written for the reviewer who
 * asked (`via: "ai"`), with the mockup version it saved, if any. It emails,
 * mentions, and adds nobody to the thread, and carries no tags.
 */
export async function aiReply(
  store: Store,
  context: { user: UserRecord; thread: ThreadRecord; project: ProjectRecord },
  args: { body: string; mockupVersion: number | null },
): Promise<string> {
  const { user, thread, project } = context;
  if (thread.mockup === undefined) fail("invalid", "Critiqs AI answers only in mockup threads.");
  if (thread.messageCount >= MAX_MESSAGES) fail("invalid", "This thread has reached its reply limit; start a new thread.");
  const body = validateBody(args.body);
  const now = Math.max(Date.now(), thread.lastMessageAt + 1);
  await useQuota(store, { ...(await projectQuota(store, project)), metric: "messages", now: Date.now() });
  const before = await store.readStates.find(user._id, thread._id);
  const messageId = await store.messages.insert({
    threadId: thread._id,
    authorId: user._id,
    body,
    createdAt: now,
    editedAt: null,
    revision: thread.anchor.evidence.revision,
    projectId: project._id,
    hashtags: [],
    via: "ai",
    ...(args.mockupVersion === null ? {} : { mockupVersion: args.mockupVersion }),
  });
  await store.threads.patch(thread._id, { lastMessageAt: now, messageCount: thread.messageCount + 1 });
  const caughtUp = before !== null && !before.manualUnread && before.lastReadAt >= thread.lastMessageAt;
  if (caughtUp) await markReadThrough(store, user._id, thread._id, now);
  return messageId;
}

/**
 * Authors can edit only their own messages (F2). Edits do not make the thread
 * unread. Without `mentions` an edit keeps the message's mentions; with them,
 * only people newly mentioned are emailed.
 */
export async function editMessage(
  store: Store,
  identity: Identity | null,
  args: { messageId: string; body: string; mentions?: MentionInput[] },
): Promise<void> {
  const user = await requireUser(store, identity);
  const message = await requireMessage(store, args.messageId);
  const { thread, project } = await requireThread(store, message.threadId);
  if (message.authorId !== user._id) fail("forbidden", "You can only edit your own messages.");
  if (message.via === "ai") fail("forbidden", "Critiqs AI's messages can't be edited.");
  const before = message.mentions ?? [];
  const mentions = args.mentions === undefined ? before : await validateMentions(store, project._id, args.mentions);
  const now = Date.now();
  const body = validateBody(args.body);
  const hashtags = threadHashtags(body, thread.mockup !== undefined);
  // A message from before tags were derived hasn't counted toward its thread's tags yet.
  const textTags = updateTextTags(thread.textTags, message.hashtags ?? [], hashtags);
  await store.messages.patch(message._id, { body, editedAt: now, mentions, projectId: project._id, hashtags });
  await store.threads.patch(thread._id, { editCount: (thread.editCount ?? 0) + 1, textTags });
  await registerTags(store, project._id, hashtags, now);
  await syncThreadTags(store, { ...thread, textTags });
  const added = mentions.map((mention) => mention.userId).filter((id) => !before.some((mention) => mention.userId === id));
  await enqueueMentions(store, { project, threadId: message.threadId, messageId: message._id, authorId: user._id, recipients: added, now });
  // Newly mentioned people are in the thread from now on: for replies after its current messages.
  await follow(store, thread._id, added, thread.messageCount);
}

export async function toggleReaction(
  store: Store,
  identity: Identity | null,
  args: { messageId: string; emoji: string },
): Promise<void> {
  const user = await requireUser(store, identity);
  const message = await requireMessage(store, args.messageId);
  await requireThread(store, message.threadId);
  if (!(REACTIONS as readonly string[]).includes(args.emoji)) fail("invalid", "Choose one of the offered reactions.");
  const existing = await store.reactions.find(message._id, user._id, args.emoji);
  if (existing === null) {
    await store.reactions.insert({ threadId: message.threadId, messageId: message._id, userId: user._id, emoji: args.emoji });
  } else {
    await store.reactions.delete(existing._id);
  }
}

/**
 * Marks the thread read through the newest message the reviewer has seen.
 * Clients pass that message's time so replies arriving unseen stay unread (F5).
 */
export async function markRead(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; seenThrough: number },
): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  await markReadThrough(store, user._id, thread._id, Math.min(args.seenThrough, thread.lastMessageAt));
}

export async function markUnread(store: Store, identity: Identity | null, args: { threadId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, args.threadId);
  const existing = await store.readStates.find(user._id, thread._id);
  if (existing === null) return; // Never opened, so already unread.
  await store.readStates.patch(existing._id, { manualUnread: true });
}

// ---------------------------------------------------------------------------
// Validation and helpers

/** Request page sizes are bounded so no request reads an unbounded list. */
export function boundedPage(request: PageRequest): PageRequest {
  if (!Number.isInteger(request.numItems) || request.numItems < 1 || request.numItems > PAGE_SIZE) {
    fail("invalid", `Request between 1 and ${PAGE_SIZE} items per page.`);
  }
  return request;
}

export function validateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") fail("invalid", "A comment cannot be empty.");
  if (trimmed.length > MAX_BODY_LENGTH) fail("invalid", `Comments are limited to ${MAX_BODY_LENGTH} characters.`);
  return trimmed;
}

/** Mentioned reviewers with their current names and the names as written. */
async function mentionViews(store: Store, mentions: StoredMention[]) {
  const views = [];
  for (const mention of mentions) {
    const person = await store.users.get(mention.userId);
    views.push({ _id: mention.userId, name: person?.name ?? mention.label, label: mention.label });
  }
  return views;
}

async function requireMessage(store: Store, messageId: string) {
  const id = store.normalizeId("messages", messageId);
  const message = id === null ? null : await store.messages.get(id);
  if (message === null) fail("not-found", "This message does not exist.");
  return message;
}

async function markReadThrough(store: Store, userId: string, threadId: string, time: number) {
  const existing = await store.readStates.find(userId, threadId);
  if (existing === null) {
    await store.readStates.insert({ userId, threadId, lastReadAt: time, manualUnread: false });
  } else {
    await store.readStates.patch(existing._id, { lastReadAt: Math.max(existing.lastReadAt, time), manualUnread: false });
  }
}

/** Status of a thread already checked not to be deleted. */
function visibleStatus(thread: ThreadRecord): "open" | "resolved" {
  return thread.status === "resolved" ? "resolved" : "open";
}

/** A thread's image state without its file ID; images are served through the protected capture route. */
function captureState(capture: StoredCapture): CaptureState {
  return capture.status === "captured" ? { status: "captured" } : { status: capture.status, failureReason: capture.failureReason };
}

/** Record-specific feedback must name its record, so it is never placed on another one (F7). */
function validateLocation(location: { scope: "shared" | "record"; target: { recordKey: string | null } }) {
  if (location.target.recordKey === "") fail("invalid", "A record key cannot be empty.");
  if (location.scope === "record" && location.target.recordKey === null) {
    fail("invalid", "Record-specific feedback needs a record.");
  }
}

/**
 * Accepts only a fresh image no thread uses yet. Uploads are not tied to a
 * project, so a known image from another project or a deleted thread cannot
 * be attached again. Returns the normalized file ID.
 */
async function validateImage(store: Store, fileId: string): Promise<{ id: string; size: number }> {
  const id = store.normalizeId("files", fileId);
  const file = id === null ? null : await store.files.info(id);
  if (id === null || file === null) fail("invalid", "The uploaded image was not found.");
  // Uploads without a declared type are served as downloads, never rendered.
  if (file.contentType !== undefined && !IMAGE_TYPES.includes(file.contentType.split(";")[0]!.trim().toLowerCase())) {
    fail("invalid", "Captures and screenshots must be PNG, JPEG, WebP, or GIF images.");
  }
  if (file.size > MAX_IMAGE_BYTES) fail("invalid", "Images are limited to 10 MB.");
  if (file.createdAt < Date.now() - UPLOAD_MINUTES * 60 * 1000) fail("invalid", "Upload the image again.");
  if ((await store.threads.byCaptureFile(id)) !== null) fail("invalid", "This image already belongs to a thread.");
  return { id, size: file.size };
}
