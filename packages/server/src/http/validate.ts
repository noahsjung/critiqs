import { MAX_TAG_LIST, MAX_THREAD_TAGS } from "@critiqs/core";
import { fail } from "../errors.ts";

// Argument shapes for the self-hosted API, matching what Convex's validators
// accept for the same functions, so a request can't store data the
// interface can't read.

export type Check = (value: unknown, path: string) => void;

const invalid = (path: string, expected: string): never => fail("invalid", `${path} must be ${expected}.`);

export const string: Check = (value, path) => {
  if (typeof value !== "string") invalid(path, "text");
};
export const number: Check = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "a number");
};
export const boolean: Check = (value, path) => {
  if (typeof value !== "boolean") invalid(path, "true or false");
};
export const literal =
  (...options: string[]): Check =>
  (value, path) => {
    if (typeof value !== "string" || !options.includes(value)) invalid(path, options.map((option) => `"${option}"`).join(" or "));
  };
export const nullable =
  (check: Check): Check =>
  (value, path) => {
    if (value !== null) check(value, path);
  };
export const array =
  (check: Check, max = 1000): Check =>
  (value, path) => {
    if (!Array.isArray(value)) return invalid(path, "a list");
    if (value.length > max) invalid(path, `a list of at most ${max}`);
    value.forEach((item, index) => check(item, `${path}[${index}]`));
  };
/** An object with exactly these properties; names ending in `?` are optional. */
export const object =
  (shape: Record<string, Check>): Check =>
  (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "an object");
    const known = new Map(Object.entries(shape).map(([name, check]) => [name.replace(/\?$/, ""), { check, optional: name.endsWith("?") }]));
    for (const name of Object.keys(value)) if (!known.has(name)) fail("invalid", `${path}.${name} is not expected.`);
    for (const [name, { check, optional }] of known) {
      const item = (value as Record<string, unknown>)[name];
      if (item === undefined) {
        if (!optional) fail("invalid", `${path}.${name} is required.`);
      } else check(item, `${path}.${name}`);
    }
  };
export const union =
  (...checks: Check[]): Check =>
  (value, path) => {
    for (const check of checks) {
      try {
        check(value, path);
        return;
      } catch {}
    }
    fail("invalid", `${path} is not valid.`);
  };
export const record =
  (check: Check): Check =>
  (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "an object");
    for (const [name, item] of Object.entries(value)) check(item, `${path}.${name}`);
  };

const viewState = record(union(string, number, boolean, (value, path) => value !== null && invalid(path, "null")));
const rect = object({ x: number, y: number, width: number, height: number });
const target = object({
  purposeId: nullable(string),
  recordKey: nullable(string),
  clues: object({ tagName: string, role: nullable(string), label: nullable(string), path: string }),
});
const scope = literal("shared", "record");
const location = object({ screen: string, viewState, target, scope });
const anchor = object({
  screen: string,
  viewState,
  target,
  scope,
  evidence: object({
    url: string,
    viewport: object({ width: number, height: number }),
    marker: nullable(rect),
    capturedAt: number,
    revision: nullable(string),
    persona: nullable(string),
    userAgent: nullable(string),
  }),
});
const capture = union(
  object({ status: literal("captured"), fileId: string }),
  object({ status: literal("supplied"), fileId: string, failureReason: string }),
  object({ status: literal("failed"), failureReason: string }),
);
const mentions = array(object({ userId: string, label: string }), 100);
const page = object({ numItems: number, cursor: nullable(string) });

/** One connection's settings, a project's or a person's own. */
const connectionFields = {
  enabled: boolean,
  mode: literal("managed", "own"),
  "managedModel?": nullable(string),
  "provider?": nullable(literal("openai", "anthropic", "google", "openrouter", "gateway", "compatible")),
  "model?": nullable(string),
  "models?": array(string, 100),
  "baseUrl?": nullable(string),
  "apiKey?": string,
};
const aiSettingsInput = object({
  projectId: string,
  ...connectionFields,
  "rule?": literal("project", "personal", "either"),
  "allowedModels?": array(string, 100),
});
const personalAiSettingsInput = object(connectionFields);
const modelListDraft = object({ provider: literal("openai", "anthropic", "google", "openrouter", "gateway", "compatible"), "baseUrl?": nullable(string), "apiKey?": string });

/** Each API call's arguments. */
export const ARGUMENTS: Record<string, Check> = {
  project: object({ projectId: string }),
  myProjects: object({}),
  myOrganizations: object({}),
  organization: object({ organizationId: string }),
  renameOrganization: object({ organizationId: string, name: string }),
  inviteMember: object({ organizationId: string, email: string, role: literal("admin", "member"), "projectId?": string }),
  revokeInvite: object({ inviteId: string }),
  setMemberRole: object({ organizationId: string, userId: string, role: literal("admin", "member") }),
  removeMember: object({ organizationId: string, userId: string }),
  threads: object({ projectId: string }),
  thread: object({ threadId: string }),
  participants: object({ projectId: string, query: string }),
  participantsNamed: object({ projectId: string, name: string }),
  notificationSettings: object({ projectId: string }),
  usage: object({ projectId: string, "day?": string, "aiCredits?": boolean }),
  exportPage: object({ projectId: string, threadIds: array(string), threadIndex: number, paginationOpts: page }),
  sync: object({}),
  createProject: object({
    name: string,
    "reviewUrl?": nullable(string),
    "organizationId?": string,
    "onboarding?": object({ "codeAccess?": string, "feedbackFrom?": array(string, 10), "purpose?": string }),
    "stack?": string,
  }),
  saveAboutYou: object({ "role?": string, "teamSize?": string }),
  setReviewUrl: object({ projectId: string, reviewUrl: string }),
  setOverageCap: object({ organizationId: string, cap: union(nullable(number), literal("default")) }),
  createThread: object({
    projectId: string,
    anchor,
    body: string,
    tags: array(string, MAX_THREAD_TAGS),
    capture,
    "mentions?": mentions,
    // Accepted so the handler can say mockups aren't available here, rather than that the field is unexpected.
    "mockup?": object({ mockupId: string, snapshotId: nullable(string), node: nullable(number) }),
  }),
  reply: object({ threadId: string, body: string, revision: nullable(string), "mentions?": mentions, "via?": literal("agent") }),
  editMessage: object({ messageId: string, body: string, "mentions?": mentions }),
  toggleReaction: object({ messageId: string, emoji: string }),
  setStatus: object({ threadId: string, status: literal("open", "resolved") }),
  remove: object({ threadId: string }),
  setTags: object({ threadId: string, tags: array(string, MAX_TAG_LIST) }),
  reattach: object({ threadId: string, location }),
  attachScreenshot: object({ threadId: string, fileId: string }),
  markRead: object({ threadId: string, seenThrough: number }),
  markUnread: object({ threadId: string }),
  setNotificationSettings: object({ projectId: string, "mentionEmails?": boolean, "replyEmails?": boolean, "projectMuted?": boolean }),
  tags: object({ projectId: string }),
  createTagGroup: object({ projectId: string, name: string }),
  renameTagGroup: object({ projectId: string, groupId: string, name: string }),
  deleteTagGroup: object({ projectId: string, groupId: string }),
  mergeTagGroups: object({ projectId: string, groupId: string, intoGroupId: string }),
  setTagGroups: object({ projectId: string, tag: string, groupIds: array(string, 20), "automatic?": boolean }),
  search: object({ projectId: string, question: string, scope: object({ status: literal("open", "resolved", "all"), screen: nullable(string) }) }),
  aiSettings: object({ projectId: string }),
  saveAiSettings: aiSettingsInput,
  testAiConnection: object({ projectId: string, "draft?": aiSettingsInput }),
  personalAiSettings: object({}),
  personalAiUsage: object({ "day?": string }),
  savePersonalAiSettings: personalAiSettingsInput,
  testPersonalAiConnection: object({ "draft?": personalAiSettingsInput }),
  removePersonalAiSettings: object({}),
  listAiModels: object({ projectId: string, "draft?": modelListDraft }),
  listPersonalAiModels: object({ "draft?": modelListDraft }),
  aiChoice: object({ projectId: string }),
  checkPrototypeAddress: object({ address: string }),
};
