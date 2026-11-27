import {
  cleanPresetTag,
  cleanTagLabel,
  hashtagLabels,
  MAX_MESSAGE_HASHTAGS,
  MAX_PRESET_TAGS,
  MAX_TAG_LIST,
  MAX_THREAD_TAGS,
  MAX_THREAD_TEXT_TAGS,
  type ProjectTags,
  type TagInfo,
  tagKey,
  uniqueTags,
} from "@critiqs/core";
import { fail } from "./errors.ts";
// Called only inside operations, after both modules have loaded.
import { requireProject, requireUser } from "./operations.ts";
import { projectAccess } from "./organizations.ts";
import type { Identity, MessageRecord, ProjectRecord, Store, TagGroupRecord, TagRecord, TextTag, ThreadRecord } from "./store.ts";

// Tags (F11) and tag groups. A thread's tags are its explicit tags, set with
// the tag buttons, and the hashtags its messages use, which the server reads
// from the text on every new message, reply, and edit, so every client sees
// the same tags. Each project keeps a registry of its tags and their shared
// groups; automatic grouping (see ai/grouping.ts) only fills in tags still
// pending, and a person's choice is final.

export { MAX_MESSAGE_HASHTAGS, MAX_THREAD_TEXT_TAGS };
/** Tags a project's registry lists; older tags still work as filters on threads. */
export const MAX_LISTED_TAGS = 500;
export const MAX_GROUPS = 100;
export const MAX_GROUP_NAME = 60;

/**
 * Groups every project starts with, so related tags filter together before,
 * or without, any AI. A tag joins one when it is first used.
 */
export const STARTER_GROUPS: { name: string; keys: string[] }[] = [
  { name: "Copy & wording", keys: ["copy", "wording", "text", "microcopy", "ux-copy", "ux-copy-change"] },
];

/**
 * The hashtags a new or edited message's text uses, as stored with the
 * message. Text with more than a message can keep is refused, so no tag the
 * text shows is silently left out.
 */
export function messageHashtags(body: string): string[] {
  const labels = hashtagLabels(body);
  if (labels.length > MAX_MESSAGE_HASHTAGS) {
    fail("invalid", `A message can use up to ${MAX_MESSAGE_HASHTAGS} different hashtags; this one uses ${labels.length}.`);
  }
  return labels;
}

/** The hashtags read from a message written before tags were derived: its first ones, up to the limit. */
export function backfillHashtags(body: string): string[] {
  return hashtagLabels(body).slice(0, MAX_MESSAGE_HASHTAGS);
}

/**
 * A thread's hashtags after one message's hashtags change from `before` to
 * `after`. The whole result is checked before anything changes: hashtags the
 * thread keeps hold their places, and a hashtag the change stops using frees
 * its place, so at the limit an edit can swap one hashtag for another. New
 * hashtags beyond the limit refuse the change, whatever their order, except
 * in a `backfill` of older messages, which keeps the first ones.
 */
export function updateTextTags(current: TextTag[] | undefined, before: string[], after: string[], backfill = false): TextTag[] {
  const indexed = new Set((current ?? []).filter((tag) => tag.count > 0).map((tag) => tag.key));
  const tags = new Map((current ?? []).map((tag) => [tag.key, { ...tag }]));
  for (const label of before) {
    const tag = tags.get(tagKey(label));
    if (tag !== undefined) tag.count = Math.max(0, tag.count - 1);
  }
  // A hashtag the thread already lists keeps its place: the message still uses it.
  const added: { key: string; label: string }[] = [];
  for (const label of after) {
    const key = tagKey(label);
    const tag = tags.get(key);
    if (tag !== undefined && (tag.count > 0 || indexed.has(key))) tag.count++;
    else if (!added.some((tag) => tag.key === key)) added.push({ key, label });
  }
  const room = Math.max(0, MAX_THREAD_TEXT_TAGS - [...tags.values()].filter((tag) => tag.count > 0).length);
  // A message's own hashtags that a thread over the limit never listed stay
  // unlisted, as before; only hashtags new to the message must fit.
  const had = new Set(before.map(tagKey));
  const fresh = added.filter((tag) => !had.has(tag.key));
  if (!backfill && fresh.length > room) {
    fail("invalid", `A thread's messages can use up to ${MAX_THREAD_TEXT_TAGS} different hashtags, and this thread's already do, so #${fresh[room]!.label} can't be added.`);
  }
  let spare = backfill ? room : room - fresh.length;
  for (const { key, label } of added) {
    if (backfill || had.has(key)) {
      if (spare === 0) continue;
      spare--;
    }
    const tag = tags.get(key);
    if (tag !== undefined) tag.count = 1;
    else tags.set(key, { key, label, count: 1 });
  }
  // Unused hashtags are forgotten, so a later use takes its new spelling.
  return [...tags.values()].filter((tag) => tag.count > 0);
}

/** Hashtags a thread's messages use now. */
export function textTagLabels(thread: Pick<ThreadRecord, "textTags">): string[] {
  return (thread.textTags ?? []).filter((tag) => tag.count > 0).map((tag) => tag.label);
}

/** Every tag a thread has: explicit tags first, then hashtags, without repeats by key. */
export function threadTags(thread: Pick<ThreadRecord, "tags" | "textTags">): string[] {
  return uniqueTags([...thread.tags, ...textTagLabels(thread)]);
}

/**
 * Explicit tags as a client set them. Any tag is allowed, preset or free, in
 * a tag's format. Tags its messages already write are left out unless the
 * thread already has them explicitly, so a client sending back the thread's
 * whole tag list neither repeats nor removes written tags, nor turns an
 * explicit tag into one that disappears with the text: removing a written
 * tag means editing the text.
 */
export function explicitTags(tags: string[], thread?: Pick<ThreadRecord, "tags" | "textTags">): string[] {
  // Setting a thread's tags, the list may also hold every tag its text writes.
  const max = thread === undefined ? MAX_THREAD_TAGS : MAX_TAG_LIST;
  if (tags.length > max) fail("invalid", `A thread can have up to ${MAX_THREAD_TAGS} tags besides the hashtags its messages use.`);
  const cleaned = tags.map((tag) => {
    const label = cleanTagLabel(tag);
    if (label === null) fail("invalid", `"${tag.slice(0, 60)}" isn't a tag. Tags have 1 to 50 characters.`);
    return label;
  });
  const explicit = new Set((thread?.tags ?? []).map(tagKey));
  const written = new Set(textTagLabels(thread ?? {}).map(tagKey));
  const result = uniqueTags(cleaned).filter((tag) => explicit.has(tagKey(tag)) || !written.has(tagKey(tag)));
  if (result.length > MAX_THREAD_TAGS) fail("invalid", `A thread can have up to ${MAX_THREAD_TAGS} tags besides the hashtags its messages use.`);
  return result;
}

/**
 * Records that a project used these tags now: new tags join the registry,
 * waiting for automatic grouping unless a starter group takes them.
 */
export async function registerTags(store: Store, projectId: string, labels: string[], now: number): Promise<void> {
  for (const label of uniqueTags(labels)) {
    const key = tagKey(label);
    const existing = await store.tags.find(projectId, key);
    if (existing !== null) {
      if (existing.lastUsedAt < now) await store.tags.patch(existing._id, { lastUsedAt: now });
      continue;
    }
    const starter = STARTER_GROUPS.find((group) => group.keys.includes(key));
    const groupId = starter === undefined ? null : await ensureGroup(store, projectId, starter.name, "starter", now);
    await store.tags.insert({
      projectId,
      key,
      label,
      firstUsedAt: now,
      lastUsedAt: now,
      groupIds: groupId === null ? [] : [groupId],
      grouping: groupId === null ? "pending" : "starter",
      epoch: 0,
      attempts: 0,
      nextAttemptAt: now,
    });
  }
}

/** Keeps the thread-to-tag records search uses in step with the thread's tags. */
export async function syncThreadTags(store: Store, thread: Pick<ThreadRecord, "_id" | "projectId" | "tags" | "textTags">): Promise<void> {
  const wanted = new Set(threadTags(thread).map(tagKey));
  const rows = await store.threadTags.forThread(thread._id);
  const have = new Set<string>();
  for (const row of rows) {
    if (wanted.has(row.key) && !have.has(row.key)) have.add(row.key);
    else await store.threadTags.delete(row._id);
  }
  for (const key of wanted) if (!have.has(key)) await store.threadTags.insert({ projectId: thread.projectId, threadId: thread._id, key });
}

/** Finds a group by name, or creates it. */
export async function ensureGroup(
  store: Store,
  projectId: string,
  name: string,
  origin: TagGroupRecord["origin"],
  now: number,
): Promise<string | null> {
  const nameKey = groupNameKey(name);
  const existing = await store.tagGroups.byName(projectId, nameKey);
  if (existing !== null) return existing._id;
  if ((await store.tagGroups.list(projectId, MAX_GROUPS)).length >= MAX_GROUPS) return null;
  return await store.tagGroups.insert({ projectId, name, nameKey, origin, createdAt: now, updatedAt: now });
}

export function groupNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanGroupName(name: string): string {
  const cleaned = name.normalize("NFC").replace(/\s+/g, " ").trim();
  if (cleaned === "" || Array.from(cleaned).length > MAX_GROUP_NAME || /[\p{Cc}\p{Cf}]/u.test(cleaned)) {
    fail("invalid", `Group names have 1 to ${MAX_GROUP_NAME} characters.`);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// What clients read

/**
 * A project's tags and groups, most recently used first. Among tags used at
 * the same time, or not yet used, presets come first in the owner's order.
 */
export async function projectTags(store: Store, project: ProjectRecord, userId: string | null): Promise<ProjectTags> {
  const groups = await store.tagGroups.list(project._id, MAX_GROUPS);
  const groupIds = new Set(groups.map((group) => group._id));
  const records = await store.tags.list(project._id, MAX_LISTED_TAGS);
  const presets = new Set(project.tags.map(tagKey));
  const byKey = new Map<string, TagInfo>();
  for (const record of records) {
    byKey.set(record.key, {
      key: record.key,
      label: record.label,
      preset: presets.has(record.key),
      lastUsedAt: record.lastUsedAt,
      // A deleted group may linger on tags beyond the listed ones; it is never shown.
      groupIds: record.groupIds.filter((id) => groupIds.has(id)),
      grouping: record.grouping,
    });
  }
  for (const label of project.tags) {
    const key = tagKey(label);
    if (!byKey.has(key)) byKey.set(key, { key, label, preset: true, lastUsedAt: null, groupIds: [], grouping: "none" });
    // A preset keeps the project's spelling.
    else byKey.get(key)!.label = label;
  }
  const presetOrder = new Map(project.tags.map((label, index) => [tagKey(label), index]));
  const rank = (tag: TagInfo) => presetOrder.get(tag.key) ?? project.tags.length;
  return {
    tags: [...byKey.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || rank(a) - rank(b) || a.label.localeCompare(b.label)),
    groups: groups.map((group) => ({ _id: group._id, name: group.name, origin: group.origin })),
    canOrganize: (await projectAccess(store, project, userId)) === "manage",
  };
}

// ---------------------------------------------------------------------------
// Organizing groups: those who manage the project only

async function requireOrganizer(store: Store, identity: Identity | null, projectId: string) {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, projectId);
  if ((await projectAccess(store, project, user._id)) !== "manage") fail("forbidden", "Only the person who set up this project can organize its tags.");
  return { user, project };
}

async function requireGroup(store: Store, projectId: string, groupId: string): Promise<TagGroupRecord> {
  const id = store.normalizeId("tagGroups", groupId);
  const group = id === null ? null : await store.tagGroups.get(id);
  if (group === null || group.projectId !== projectId) fail("not-found", "This tag group does not exist.");
  return group;
}

/** Tags in a group, among the listed tags. */
async function members(store: Store, projectId: string, groupId: string): Promise<TagRecord[]> {
  return (await store.tags.list(projectId, MAX_LISTED_TAGS)).filter((tag) => tag.groupIds.includes(groupId));
}

export async function createGroup(store: Store, identity: Identity | null, args: { projectId: string; name: string }) {
  const { project } = await requireOrganizer(store, identity, args.projectId);
  const name = cleanGroupName(args.name);
  if ((await store.tagGroups.byName(project._id, groupNameKey(name))) !== null) fail("invalid", "A group with this name already exists.");
  const id = await ensureGroup(store, project._id, name, "human", Date.now());
  if (id === null) fail("invalid", `A project can have up to ${MAX_GROUPS} tag groups.`);
  return id;
}

export async function renameGroup(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; groupId: string; name: string },
) {
  const { project } = await requireOrganizer(store, identity, args.projectId);
  const group = await requireGroup(store, project._id, args.groupId);
  const name = cleanGroupName(args.name);
  const other = await store.tagGroups.byName(project._id, groupNameKey(name));
  if (other !== null && other._id !== group._id) fail("invalid", "A group with this name already exists.");
  await store.tagGroups.patch(group._id, { name, nameKey: groupNameKey(name), updatedAt: Date.now() });
}

/** Removes a group. Its tags stay, and keep their other groups; this is a person's choice, so automatic grouping leaves them. */
export async function deleteGroup(store: Store, identity: Identity | null, args: { projectId: string; groupId: string }) {
  const { project } = await requireOrganizer(store, identity, args.projectId);
  const group = await requireGroup(store, project._id, args.groupId);
  for (const tag of await members(store, project._id, group._id)) {
    await store.tags.patch(tag._id, humanChange(tag, tag.groupIds.filter((id) => id !== group._id)));
  }
  await store.tagGroups.delete(group._id);
}

/** Moves every tag of one group into another and removes the first. */
export async function mergeGroups(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; groupId: string; intoGroupId: string },
) {
  const { project } = await requireOrganizer(store, identity, args.projectId);
  const from = await requireGroup(store, project._id, args.groupId);
  const into = await requireGroup(store, project._id, args.intoGroupId);
  if (from._id === into._id) fail("invalid", "Choose a different group to merge into.");
  for (const tag of await members(store, project._id, from._id)) {
    const groupIds = [...new Set(tag.groupIds.map((id) => (id === from._id ? into._id : id)))];
    await store.tags.patch(tag._id, humanChange(tag, groupIds));
  }
  await store.tagGroups.delete(from._id);
  await store.tagGroups.patch(into._id, { updatedAt: Date.now() });
}

/**
 * Sets the groups a tag belongs to, or none. A person's choice locks the tag
 * against automatic grouping; `automatic` instead hands it back to automatic
 * grouping, without groups until it runs.
 */
export async function setTagGroups(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; tag: string; groupIds: string[]; automatic?: boolean },
) {
  const { project } = await requireOrganizer(store, identity, args.projectId);
  const key = tagKey(args.tag);
  let tag = await store.tags.find(project._id, key);
  if (tag === null) {
    // A preset nobody used yet can be grouped too.
    const preset = project.tags.find((label) => tagKey(label) === key);
    if (preset === undefined) fail("not-found", "This tag isn't used in this project.");
    await registerTags(store, project._id, [preset], Date.now());
    tag = (await store.tags.find(project._id, key))!;
  }
  if (args.groupIds.length > 20) fail("invalid", "A tag can belong to up to 20 groups.");
  const groupIds: string[] = [];
  for (const id of args.groupIds) groupIds.push((await requireGroup(store, project._id, id))._id);
  if (args.automatic) {
    await store.tags.patch(tag._id, {
      groupIds: [],
      grouping: "pending",
      epoch: tag.epoch + 1,
      attempts: 0,
      nextAttemptAt: Date.now(),
      claimToken: "",
      leaseUntil: 0,
      lastError: "",
    });
    return;
  }
  await store.tags.patch(tag._id, humanChange(tag, [...new Set(groupIds)]));
}

/**
 * Sets a project's preset tags, in order: adding, renaming, reordering, and
 * removing are all a new list. Presets are the tags `#` suggests first and the
 * ones a project starts with; threads keep the tags they already carry. A
 * reviewer's message says `#Bug` in its own words, and an explicit tag must
 * stay in step with the text (see `explicitTags`), so renaming or removing a
 * preset never rewrites a thread: its old tag stays on those threads, still
 * listed and filterable as an ordinary tag, and a group can gather it with
 * the new one. `previous` is the list the owner edited; when the presets have
 * changed since, the change is refused rather than undoing someone else's.
 */
export async function setPresetTags(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; tags: string[]; previous: string[] },
): Promise<string[]> {
  const { project } = await requireOrganizer(store, identity, args.projectId);
  // Required, so no caller overwrites a change made meanwhile by leaving it out.
  if (!Array.isArray(args.previous)) fail("invalid", "Send the preset tags you changed as `previous`.");
  if (args.previous.length !== project.tags.length || args.previous.some((tag, i) => tag !== project.tags[i])) {
    fail("invalid", "The preset tags changed while you were editing them. Look at them again and redo your change.");
  }
  if (args.tags.length > MAX_PRESET_TAGS) fail("invalid", `A project can have up to ${MAX_PRESET_TAGS} preset tags.`);
  const seen = new Map<string, string>();
  const tags = args.tags.map((tag) => {
    const label = cleanPresetTag(tag);
    if (label === null) {
      fail("invalid", `“${tag.slice(0, 60)}” can't be a preset tag. Presets have 1 to 50 characters, start with a letter, and use only letters, numbers, spaces, - and _, so reviewers can write them as hashtags.`);
    }
    const same = seen.get(tagKey(label));
    if (same !== undefined) fail("invalid", `“${same}” and “${label}” are the same tag. Keep one of them.`);
    seen.set(tagKey(label), label);
    return label;
  });
  await store.projects.patch(project._id, { tags });
  return tags;
}

/** A person's change to a tag's groups: final, and newer than any grouping run already started. */
function humanChange(tag: TagRecord, groupIds: string[]) {
  return { groupIds, grouping: "human" as const, epoch: tag.epoch + 1, claimToken: "", leaseUntil: 0 };
}

/**
 * Derives tags for feedback from before tags were derived, a record at a
 * time, for backends that backfill in pages (Convex). SQLite does the same in
 * its migration.
 */
export const registerTagsForBackfill = {
  /** Reads an older message's hashtags into it and its thread. Skip messages that already have `hashtags`. */
  async message(store: Store, message: MessageRecord): Promise<void> {
    const thread = await store.threads.get(message.threadId);
    if (thread === null) return;
    const hashtags = backfillHashtags(message.body);
    await store.messages.patch(message._id, { projectId: thread.projectId, hashtags });
    if (hashtags.length === 0) return;
    await store.threads.patch(thread._id, { textTags: updateTextTags(thread.textTags, [], hashtags, true) });
    await registerTags(store, thread.projectId, hashtags, message.createdAt);
  },
  /** Records a thread's tags, explicit and written, in the registry and thread-tag records. */
  async thread(store: Store, threadId: string): Promise<void> {
    const thread = await store.threads.get(threadId);
    if (thread === null) return;
    if (thread.textTags === undefined) await store.threads.patch(thread._id, { textTags: [] });
    await registerTags(store, thread.projectId, thread.tags, thread.lastMessageAt);
    await syncThreadTags(store, thread);
  },
};
