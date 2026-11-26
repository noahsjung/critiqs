import {
  type Anchor,
  type CaptureState,
  DEFAULT_TAGS as CORE_DEFAULT_TAGS,
  type NotificationSettings,
  type ParticipantInfo,
  type ProjectUsage,
  type ExportPage,
  isThreadPageKey,
  isUnread,
  MAX_PROJECT_NAME_LENGTH,
  type Page,
  type PageRequest,
  type ProjectInfo,
  type ProjectTags,
  type ReactionRow,
  REVIEW_ACCESS,
  type ReviewAccess,
  REACTIONS,
  type Revision,
  type TargetLocation,
  type ThreadDetailPage,
  type ThreadMockup,
  type ThreadPageDetail,
  type ThreadSummary,
  parseOnboardingAnswers,
  parseStack,
  startingTags,
  type ThreadTicket,
  type TicketLinkView,
  validReviewUrl,
} from "@critiqs/core";
import { fail } from "./errors.ts";
import { planFor, requireRoom, usageDay, usageSummary, useQuota } from "./limits.ts";
import { checkThreadMockup } from "./mockups.ts";
import { acceptInvites, canOpenThreadPage, canReview, homeOrganization, ORGANIZATION_ONLY, projectAccess, projectQuota, projectRole } from "./organizations.ts";
import {
  changePreferences,
  enqueueMentions,
  follow,
  ensureThreadPageKey,
  newThreadPageKey,
  queueReplyEmails,
  type MentionInput,
  listParticipants as participantsMatching,
  notificationSettings,
  participantsNamed,
  touchParticipant,
  validateMentions,
  checkMentionReach,
} from "./notify.ts";
import { lastKnownStatus } from "./tickets/current.ts";
import type { Identity, ProjectOnboarding, ProjectRecord, StoredCapture, StoredMention, Store, ThreadRecord, TicketLinkRecord, UserRecord } from "./store.ts";
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

export { createGroup, deleteGroup, mergeGroups, renameGroup, setPresetTags, setTagGroups } from "./tags.ts";

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
/**
 * The most tickets one thread can link to, counting creations still under
 * way; a new creation or link past it is refused. A creation set aside
 * (parked) doesn't count, and may still finish past it.
 */
export const MAX_THREAD_TICKETS = 20;
/**
 * The most ticket links one thread holds, linked or pending of any kind. A new
 * creation or link past it is refused, so a thread's linked tickets, read up to
 * this many, are always all of them.
 */
export const MAX_THREAD_TICKET_ROWS = 40;

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

/** Who is asking: the signed-in reviewer's record, or null before their first change. */
export type Viewer = { _id: string } | null;

/**
 * A project the viewer may review (`canReview`): with the default
 * `reviewAccess`, any signed-in reviewer who has the project's ID (F12), and
 * the company guards access to the prototype that carries the ID; limited to
 * its organization, only that organization's members. Every operation on a
 * project, or on anything in one, comes through here. Callers check sign-in
 * first.
 */
export async function requireProject(store: Store, viewer: Viewer, projectId: string): Promise<ProjectRecord> {
  const id = store.normalizeId("projects", projectId);
  const project = id === null ? null : await store.projects.get(id);
  if (project === null) fail("not-found", "This project does not exist.");
  if (!(await canReview(store, project, viewer?._id ?? null))) fail("forbidden", ORGANIZATION_ONLY);
  return project;
}

/** A thread by its own ID, unchecked; null when there is none. */
async function threadById(store: Store, threadId: string): Promise<ThreadRecord | null> {
  const id = store.normalizeId("threads", threadId);
  return id === null ? null : await store.threads.get(id);
}

/**
 * A thread by its own ID, after the same check as its project. Deleted
 * threads are reported unavailable rather than returned (F10), and only to
 * those who may review the project.
 */
export async function requireThread(store: Store, viewer: Viewer, threadId: string) {
  const thread = await threadById(store, threadId);
  if (thread === null) fail("not-found", "This thread does not exist.");
  const project = await requireProject(store, viewer, thread.projectId);
  if (thread.status === "deleted") fail("unavailable", "This thread was deleted.");
  return { thread, project };
}

/** Onboarding's answers about a project, as sent: values it doesn't know are dropped, as if skipped. */
export interface ProjectAnswersInput {
  codeAccess?: string;
  feedbackFrom?: string[];
  purpose?: string;
}

/** A message by its own ID, after the same checks as its thread. */
export async function requireMessage(store: Store, viewer: Viewer, messageId: string) {
  const id = store.normalizeId("messages", messageId);
  const message = id === null ? null : await store.messages.get(id);
  if (message === null) fail("not-found", "This message does not exist.");
  return { message, ...(await requireThread(store, viewer, message.threadId)) };
}

/** Refuses, with `message`, anyone who doesn't manage the project: only its organization's admins, and its creator while a member, do. */
async function requireManager(store: Store, project: ProjectRecord, userId: string | null, message: string): Promise<void> {
  if ((await projectAccess(store, project, userId)) !== "manage") fail("forbidden", message);
}

/**
 * How long a create's idempotency key returns its project. It covers a client
 * retrying after a lost response, a panel reopened, or a page reloaded while
 * the create was pending, including a laptop that slept through it; a later
 * create with the same key makes a new project.
 */
export const CREATE_KEY_MS = 24 * 60 * 60 * 1000;
const CREATE_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Project setup: any signed-in reviewer can create a project, optionally with
 * its review address, in an organization they belong to: the one they choose,
 * or else their home organization. Setup checks the address first; an
 * address emails can't link to, which older setup could send, is left out
 * rather than refused. Onboarding also sends its answers about the project
 * and the stack: what it's for picks the starting tags, and without it the
 * project starts with the default tags.
 * With an idempotency key, a retry of the same request
 * by the same person within `CREATE_KEY_MS` returns the project the first one
 * created, whatever its other arguments; clients make a new key for each new
 * project. Another person's identical key is a different request.
 */
export async function createProject(
  store: Store,
  identity: Identity | null,
  args: { name: string; reviewUrl?: string | null; organizationId?: string; onboarding?: ProjectAnswersInput; stack?: string; idempotencyKey?: string },
): Promise<string> {
  const user = await requireUser(store, identity);
  const key = args.idempotencyKey;
  if (key !== undefined && !CREATE_KEY.test(key)) fail("invalid", "An idempotency key is 8 to 100 letters, digits, - or _.");
  const now = Date.now();
  if (key !== undefined) {
    const earlier = await store.projectCreations.find(user._id, key);
    if (earlier !== null && now - earlier.createdAt < CREATE_KEY_MS && (await store.projects.get(earlier.projectId)) !== null) return earlier.projectId;
  }
  const name = args.name.trim();
  if (name === "") fail("invalid", "A project needs a name.");
  if (name.length > MAX_PROJECT_NAME_LENGTH) fail("invalid", `A project's name can have at most ${MAX_PROJECT_NAME_LENGTH} characters.`);
  const reviewUrl = args.reviewUrl == null ? null : validReviewUrl(args.reviewUrl.trim());
  const onboarding = projectOnboarding(args.onboarding, args.stack);
  const organization = args.organizationId === undefined ? await homeOrganization(store, user, now) : await chosenOrganization(store, user, args.organizationId);
  await useQuota(store, { plan: await planFor(store, organization), metric: "projects", accountId: organization._id, projectId: null, now });
  const projectId = await store.projects.insert({
    name,
    tags: [...startingTags(onboarding?.purpose)],
    createdBy: user._id,
    createdAt: now,
    organizationId: organization._id,
    ...(reviewUrl === null ? {} : { reviewUrl }),
    ...(onboarding === null ? {} : { onboarding }),
  });
  // Expired keys go as the person creates projects, so what's kept stays bounded by how many they create in a day.
  await store.projectCreations.removeBefore(user._id, now - CREATE_KEY_MS, 20);
  if (key !== undefined) await store.projectCreations.put({ userId: user._id, key, projectId, createdAt: now });
  return projectId;
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
  const project = await requireProject(store, user, args.projectId);
  await requireManager(store, project, user._id, "Only the person who set up this project can change it.");
  const reviewUrl = validReviewUrl(args.reviewUrl.trim());
  if (reviewUrl === null) fail("invalid", "Use the prototype's address, starting with https:// (or http://localhost).");
  await store.projects.patch(project._id, { reviewUrl });
}

/**
 * Who can review the project: anyone who signs in, or only members of its
 * organization. Only those who manage the project may change it. Someone
 * invited to the organization joins when they next sign in.
 */
export async function setReviewAccess(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; reviewAccess: ReviewAccess },
): Promise<void> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  await requireManager(store, project, user._id, "Only the project's owners can change who can review it.");
  if (!REVIEW_ACCESS.includes(args.reviewAccess)) fail("invalid", "Choose anyone who signs in, or members of the organization.");
  if ((project.reviewAccess ?? "anyone") !== args.reviewAccess) await store.projects.patch(project._id, { reviewAccess: args.reviewAccess });
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
  // A creator who left a project's organization can't reconnect to it once it is limited to members.
  const reviewable = [];
  for (const project of result.page) if (await canReview(store, project, user._id)) reviewable.push(project);
  return {
    page: await Promise.all(reviewable.map((project) => projectInfo(store, project, user._id))),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}

export async function getProject(store: Store, identity: Identity | null, args: { projectId: string }): Promise<ProjectInfo> {
  const { user } = await currentReviewer(store, identity);
  return await projectInfo(store, await requireProject(store, user, args.projectId), user?._id ?? null);
}

export async function projectInfo(store: Store, project: ProjectRecord, userId: string | null): Promise<ProjectInfo> {
  const { access, organization } = await projectRole(store, project, userId);
  return {
    _id: project._id,
    name: project.name,
    tags: project.tags,
    createdAt: project.createdAt,
    reviewUrl: project.reviewUrl ?? null,
    isOwner: access === "manage",
    ...(organization === null ? {} : { organization }),
    reviewAccess: project.reviewAccess ?? "anyone",
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
  const project = await requireProject(store, user, args.projectId);
  await requireManager(store, project, user?._id ?? null, "Only the person who set up this project can see its usage.");
  const usage = await usageSummary(store, await projectQuota(store, project), usageDay(args.day, Date.now()));
  return usage === null || args.aiCredits === true ? usage : creditsAsAiRequests(usage);
}

function creditsAsAiRequests(usage: ProjectUsage): ProjectUsage {
  const rows = usage.rows.filter((row) => row.metric !== "aiRequests").map((row) => (row.metric === "aiCredits" ? { ...row, metric: "aiRequests" as const } : row));
  return { ...usage, rows };
}

/**
 * Mention suggestions, by name: whom the person may mention in the thread
 * they reply in (`threadId`), or, without one, in a new thread of the project.
 */
export async function listParticipants(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; query: string; threadId?: string },
): Promise<ParticipantInfo[]> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  if (args.threadId === undefined) return await participantsMatching(store, user, project, null, args.query);
  const { thread } = await requireThread(store, user, args.threadId);
  if (thread.projectId !== project._id) fail("not-found", "This thread does not exist.");
  return await participantsMatching(store, user, project, thread, args.query);
}

/** Everyone else in the project with exactly this name, and whether every participant was searched. Never yourself, as in suggestions. */
export async function listParticipantsNamed(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; name: string },
): Promise<{ people: ParticipantInfo[]; complete: boolean }> {
  const { user } = await currentReviewer(store, identity);
  if (args.name.trim() === "" || args.name.length > 200) fail("invalid", "Give a name of 1 to 200 characters.");
  const found = await participantsNamed(store, await requireProject(store, user, args.projectId), args.name);
  return { ...found, people: found.people.filter((person) => person._id !== user?._id) };
}

export async function getNotificationSettings(
  store: Store,
  identity: Identity | null,
  args: { projectId: string },
): Promise<NotificationSettings> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  return await notificationSettings(store, user?._id ?? null, project._id);
}

export async function setNotificationSettings(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; mentionEmails?: boolean; replyEmails?: boolean; projectMuted?: boolean },
): Promise<void> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
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
  args: { projectId: string; anchor: Anchor; body: string; tags: string[]; capture: CaptureInput; mentions?: MentionInput[]; mockup?: ThreadMockup; madeWith?: "extension" },
): Promise<string> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const mentions = await validateMentions(store, project._id, args.mentions ?? []);
  await checkMentionReach(store, project, null, user._id, mentions);
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
    pageKey: newThreadPageKey(),
    // The panel says when it runs in the browser extension; anything else is an install, including older components.
    madeWith: args.madeWith === "extension" ? "extension" : "install",
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
  const project = await requireProject(store, user, args.projectId);
  const result = await store.threads.listVisible(project._id, boundedPage(request));
  const lastKnown = lastKnownStatus(store);
  const page = await Promise.all(result.page.map((thread) => threadSummary(store, user, thread, lastKnown)));
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

/** A thread as lists show it, with the reviewer's own unread state; `user` is null before their first change. */
export async function threadSummary(
  store: Store,
  user: UserRecord | null,
  thread: ThreadRecord,
  lastKnown: (link: TicketLinkRecord) => Promise<boolean> = lastKnownStatus(store),
): Promise<ThreadSummary> {
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
    ...(store.tickets === undefined
      ? {}
      : {
          tickets: await Promise.all(
            (await linkedTickets(store.tickets, thread._id)).map(async (link) => ({ tracker: link.tracker, key: link.key, status: link.status ?? null, lastKnown: await lastKnown(link) })),
          ),
        }),
  };
}

/** A thread's linked tickets as handoffs carry them: key, title, status, and address. */
export async function threadTickets(tickets: NonNullable<Store["tickets"]>, threadId: string): Promise<ThreadTicket[]> {
  return (await linkedTickets(tickets, threadId)).map((link) => ({ tracker: link.tracker, key: link.key, title: link.title, status: link.status ?? null, url: link.url }));
}

/** A thread's linked tickets, oldest first, leaving out tickets still being created. */
async function linkedTickets(tickets: NonNullable<Store["tickets"]>, threadId: string) {
  return await tickets.links.listForThread(threadId, "linked", MAX_THREAD_TICKET_ROWS);
}

async function ticketViews(store: Store, tickets: NonNullable<Store["tickets"]>, project: ProjectRecord, threadId: string, user: UserRecord | null): Promise<TicketLinkView[]> {
  const links = await linkedTickets(tickets, threadId);
  // Project owners may unlink anyone's; read only when someone else linked one.
  const owner = user !== null && links.some((link) => link.linkedBy !== user._id) && (await projectAccess(store, project, user._id)) === "manage";
  const lastKnown = lastKnownStatus(store);
  return await Promise.all(links.map((link) => ticketView(store, link, { userId: user?._id ?? null, owner }, lastKnown)));
}

/** A linked ticket as the thread window shows it, to `viewer`: the person asking, and whether they own the project. */
export async function ticketView(
  store: Store,
  link: TicketLinkRecord,
  viewer: { userId: string | null; owner: boolean },
  lastKnown: (link: TicketLinkRecord) => Promise<boolean> = lastKnownStatus(store),
): Promise<TicketLinkView> {
  const mine = viewer.userId !== null && link.linkedBy === viewer.userId;
  return {
    _id: link._id,
    threadId: link.threadId,
    tracker: link.tracker,
    externalId: link.externalId,
    key: link.key,
    url: link.url,
    title: link.title,
    status: link.status ?? null,
    statusCheckedAt: link.statusCheckedAt ?? null,
    statusStale: await lastKnown(link),
    createdFromCritiqs: link.createdFromCritiqs,
    linkedByName: (await store.users.get(link.linkedBy))?.name ?? "Unknown",
    linkedAt: link.linkedAt,
    canUnlink: mine || (viewer.userId !== null && viewer.owner),
    canAddLinkBack: mine && link.linkBack?.added === false,
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
  const { thread, project } = await requireThread(store, user, args.threadId);
  return await threadDetail(store, user, project, thread, request);
}

/** A page of a thread already checked readable by `user`, with its fields and their read state. */
async function threadDetail(
  store: Store,
  user: UserRecord | null,
  project: ProjectRecord,
  thread: ThreadRecord,
  request: PageRequest,
): Promise<ThreadDetailPage> {
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
    statusChangedByName: thread.statusChangedByTickets ? null : await nameOf(thread.statusChangedBy),
    ...(thread.statusChangedAt === undefined ? {} : { statusChangedAt: thread.statusChangedAt }),
    ...(thread.statusChangedByTickets && thread.status === "resolved" ? { resolvedByTickets: true as const } : {}),
    ...(reattachment === undefined
      ? {}
      : { reattachment: { location: reattachment.location, reattachedAt: reattachment.reattachedAt } }),
    reattachedByName: await nameOf(reattachment?.reattachedBy),
    readState: readState === null ? null : { lastReadAt: readState.lastReadAt, manualUnread: readState.manualUnread },
    ...(thread.mockup === undefined ? {} : { mockup: thread.mockup }),
    canDelete: await canDeleteThread(store, project, thread, user?._id ?? null),
    ...(store.tickets === undefined ? {} : { tickets: await ticketViews(store, store.tickets, project, thread._id, user) }),
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
  const { thread } = await requireThread(store, user, args.threadId);
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
  const { thread } = await requireThread(store, user, args.threadId);
  if (thread.status === args.status) return;
  await store.threads.patch(thread._id, { status: args.status, statusChangedBy: user._id, statusChangedAt: Date.now(), ...(thread.statusChangedByTickets ? { statusChangedByTickets: false } : {}) });
}

/**
 * Soft delete: hides the thread and records who deleted it, keeping its
 * history. Only the person who started it, or someone who manages the
 * project, may.
 */
export async function removeThread(store: Store, identity: Identity | null, args: { threadId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread, project } = await requireThread(store, user, args.threadId);
  if (!(await canDeleteThread(store, project, thread, user._id))) fail("forbidden", "Only the person who started this thread or the project's owners can delete it.");
  await store.threads.patch(thread._id, { status: "deleted", statusChangedBy: user._id, statusChangedAt: Date.now() });
}

/**
 * Whether someone may delete a thread: the person who started it, or someone
 * who manages its project. Deleting a mockup deletes its threads, so it
 * checks each of them with this too.
 */
export async function canDeleteThread(store: Store, project: ProjectRecord, thread: Pick<ThreadRecord, "createdBy">, userId: string | null): Promise<boolean> {
  if (userId === null) return false;
  return thread.createdBy === userId || (await projectAccess(store, project, userId)) === "manage";
}

/**
 * Sets a thread's explicit tags: presets or free tags. Hashtags its messages
 * use stay whether or not the list includes them, so older clients that send
 * the whole tag list back neither repeat nor drop them.
 */
export async function setTags(store: Store, identity: Identity | null, args: { threadId: string; tags: string[] }): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread, project } = await requireThread(store, user, args.threadId);
  const tags = explicitTags(args.tags, thread);
  await store.threads.patch(thread._id, { tags });
  await registerTags(store, project._id, tags.filter((tag) => !thread.tags.includes(tag)), Date.now());
  await syncThreadTags(store, { ...thread, tags });
}

/** The project's tags for suggestions and filters, and its shared tag groups. */
export async function listTags(store: Store, identity: Identity | null, args: { projectId: string }): Promise<ProjectTags> {
  const { user } = await currentReviewer(store, identity);
  return await projectTags(store, await requireProject(store, user, args.projectId), user?._id ?? null);
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
  const { thread } = await requireThread(store, user, args.threadId);
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
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
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
      ...(store.tickets === undefined ? {} : { tickets: await threadTickets(store.tickets, thread._id) }),
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
  const user = await requireUser(store, identity);
  const { thread, project } = await requireThread(store, user, args.threadId);
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
  await authorizeUploadBy(store, await requireUser(store, identity), args);
}

/**
 * The same check for a known reviewer, without their sign-in: for an upload
 * reserved by them earlier, whose request carries only its upload grant.
 */
export async function authorizeUploadBy(store: Store, viewer: { _id: string }, args: { projectId: string }): Promise<void> {
  const project = await requireProject(store, viewer, args.projectId);
  // An upload's size is known only once it is attached, where it is counted; a full project takes no more.
  await requireRoom(store, { ...(await projectQuota(store, project)), metric: "captureBytes", now: Date.now() });
}

/** File ID of a thread's image, after the same access checks as reading the thread. */
export async function authorizedCapture(store: Store, identity: Identity | null, args: { threadId: string }): Promise<string | null> {
  const { user } = await currentReviewer(store, identity);
  const { thread } = await requireThread(store, user, args.threadId);
  return thread.capture.status === "failed" ? null : thread.capture.fileId;
}

// ---------------------------------------------------------------------------
// Thread pages
//
// A thread page shows one thread on Critiqs's website, outside the
// prototype that guards access to it, and its link can be forwarded to
// anyone. It is found by its page key (`/t/<key>`), never by the thread's ID:
// in a project anyone may review, a thread ID alone lets components from
// 0.3.x and earlier read the thread and its project.
//
// Opening a thread page never counts as opening the project. When address
// lists record the projects each person opened, nothing here may record one:
// whoever combines the two keeps every thread page operation free of that
// record.

/** The one answer for a thread page that doesn't exist, or that this person may not open, signed in or not. */
const NO_THREAD_PAGE = "This thread doesn't exist, or you can't open it.";

/**
 * A thread someone may open as a thread page, with its project. Anyone who
 * may not, including someone signed out, gets the same `not-found` as for a
 * thread that doesn't exist. A deleted thread is reported deleted only to
 * those who may open its page.
 */
async function openThreadPage(store: Store, user: UserRecord | null, thread: ThreadRecord | null): Promise<{ thread: ThreadRecord; project: ProjectRecord }> {
  const project = thread === null ? null : await store.projects.get(thread.projectId);
  if (thread === null || project === null || !(await canOpenThreadPage(store, project, thread, user?._id ?? null))) fail("not-found", NO_THREAD_PAGE);
  if (thread.status === "deleted") fail("unavailable", "This thread was deleted.");
  return { thread, project };
}

/** The thread page a key opens, for the signed-in person; signed out, they get the same answer as for a key that opens nothing. */
/** A thread page's thread, project and viewer, for someone who may open it; refused with the page's own answer otherwise. */
export async function threadPageSubject(store: Store, identity: Identity | null, key: string) {
  return await requireThreadPage(store, identity, key);
}

async function requireThreadPage(store: Store, identity: Identity | null, key: string) {
  const user = identity === null || !identity.emailVerified || !identity.email ? null : await store.users.byToken(identity.tokenIdentifier);
  const thread = user === null || !isThreadPageKey(key) ? null : await store.threads.byPageKey(key);
  return { user, ...(await openThreadPage(store, user, thread)) };
}

/**
 * A page of a thread page's discussion, with the project's name, its review
 * address, and where the thread was left, for **Open in prototype**. Replies
 * from the page go through `reply` with `threadPage: true`, and its capture
 * through the capture download with the page key, each checked the same way.
 * Records nothing: never an opened project (see above), and not read state.
 */
export async function getThreadPage(
  store: Store,
  identity: Identity | null,
  args: { key: string },
  request: PageRequest,
): Promise<ThreadPageDetail> {
  const { user, thread, project } = await requireThreadPage(store, identity, args.key);
  return {
    ...(await threadDetail(store, user, project, thread, request)),
    project: { name: project.name, reviewUrl: project.reviewUrl ?? null, connectedAt: project.connectedAt ?? null },
    prototype: { pageUrl: thread.anchor.evidence.url, screen: thread.anchor.screen, ...(thread.madeWith === undefined ? {} : { madeWith: thread.madeWith }) },
  };
}

/** File ID of a thread page's image, after the same checks as opening the page. */
export async function authorizedPageCapture(store: Store, identity: Identity | null, args: { key: string }): Promise<string | null> {
  const { thread } = await requireThreadPage(store, identity, args.key);
  return thread.capture.status === "failed" ? null : thread.capture.fileId;
}

/**
 * The key for a thread page's link, for **Share**: anyone who may review the
 * thread may share it, and the link opens only for those who may open the
 * page. A thread from before thread pages gets its key here, once, and if it
 * is also from before followers were recorded, the email worker records them.
 */
export async function threadPageKey(store: Store, identity: Identity | null, args: { threadId: string }): Promise<string> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, user, args.threadId);
  return await ensureThreadPageKey(store, thread, Date.now());
}

// ---------------------------------------------------------------------------
// Messages

/**
 * Adds a reply. Everyone else in the thread is emailed about it (unless they
 * turned that off), and people it mentions get a mention email instead. With
 * `via: "agent"`, a coding agent wrote it for the signed-in reviewer, and
 * Critiqs shows that beside their name. With `threadPage: true`, it comes
 * from the thread page, and only those who may open that page may send it.
 */
export async function reply(
  store: Store,
  identity: Identity | null,
  args: { threadId: string; body: string; revision: Revision; mentions?: MentionInput[]; via?: "agent"; threadPage?: boolean },
): Promise<string> {
  if (args.via !== undefined && args.via !== "agent") fail("invalid", "Unknown author kind.");
  // From a thread page, someone signed out gets the page's one answer too.
  if (args.threadPage === true && (identity === null || !identity.emailVerified || !identity.email)) fail("not-found", NO_THREAD_PAGE);
  const user = await requireUser(store, identity);
  const { thread, project } = args.threadPage === true ? await openThreadPage(store, user, await threadById(store, args.threadId)) : await requireThread(store, user, args.threadId);
  const mentions = await validateMentions(store, project._id, args.mentions ?? []);
  // Whom the person may mention depends on their standing in the project, wherever they reply from.
  await checkMentionReach(store, project, thread, user._id, mentions);
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
  const { message, thread, project } = await requireMessage(store, user, args.messageId);
  if (message.authorId !== user._id) fail("forbidden", "You can only edit your own messages.");
  if (message.via === "ai") fail("forbidden", "Critiqs AI's messages can't be edited.");
  const before = message.mentions ?? [];
  const mentions = args.mentions === undefined ? before : await validateMentions(store, project._id, args.mentions);
  await checkMentionReach(store, project, thread, user._id, mentions.filter((mention) => !before.some((earlier) => earlier.userId === mention.userId)));
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
  // In a thread whose people aren't recorded yet, someone whose mention this edit removes was still in it, and the
  // scan that records them reads messages as they are now, so it would miss them. Mentions kept are left to the scan,
  // which records them from their message's place, so replies already waiting still email them.
  if (thread.followersReady !== true) {
    const removed = before.map((mention) => mention.userId).filter((id) => !mentions.some((mention) => mention.userId === id));
    await follow(store, thread._id, removed, thread.messageCount);
  }
}

export async function toggleReaction(
  store: Store,
  identity: Identity | null,
  args: { messageId: string; emoji: string },
): Promise<void> {
  const user = await requireUser(store, identity);
  const { message } = await requireMessage(store, user, args.messageId);
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
  const { thread } = await requireThread(store, user, args.threadId);
  await markReadThrough(store, user._id, thread._id, Math.min(args.seenThrough, thread.lastMessageAt));
}

export async function markUnread(store: Store, identity: Identity | null, args: { threadId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const { thread } = await requireThread(store, user, args.threadId);
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
