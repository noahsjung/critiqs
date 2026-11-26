import type {
  Anchor,
  CodeAccess,
  FeedbackFrom,
  OrganizationRole,
  PageRequest,
  Purpose,
  ReviewAccess,
  Revision,
  Role,
  StackId,
  TargetLocation,
  TeamSize,
  ThreadMockup,
  TicketStatus,
  TrackerId,
} from "@critiqs/core";
import type { Plan } from "./limits.ts";

// The storage a backend gives Critiqs's rules. Each operation runs in one
// transaction the backend owns: Convex mutations, or a SQLite transaction.
// Methods are domain operations with matching indexes in every backend, not a
// general query language. IDs are opaque strings each backend issues.

export interface Identity {
  /** Issuer and subject together; stable for one reviewer. */
  tokenIdentifier: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  pictureUrl: string | null;
  /** Increases with each display name change; absent on tokens from before versions. */
  profileVersion: number | null;
}

export interface UserRecord {
  _id: string;
  tokenIdentifier: string;
  name: string;
  email: string | null;
  imageUrl: string | null;
  profileVersion?: number;
  /** Critiqs Cloud plan from before organizations; it applies until their home organization, which copies it, exists. */
  plan?: string;
  /** Where the person's new projects go, and whose plan covers their own Critiqs AI while they belong to it. Absent until they first need one. */
  homeOrganizationId?: string;
  /** Onboarding's "About you" answers; absent when skipped. */
  role?: Role;
  teamSize?: TeamSize;
}

/** Onboarding's answers that belong to a project, and the stack picked or confirmed; a skipped one has no field. */
export interface ProjectOnboarding {
  codeAccess?: CodeAccess;
  feedbackFrom?: FeedbackFrom[];
  purpose?: Purpose;
  stack?: StackId;
}

export interface ProjectRecord {
  _id: string;
  name: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  /** The prototype address mention emails link to. */
  reviewUrl?: string;
  /** The organization that owns it; absent on projects from before organizations until the backfill gives them one. */
  organizationId?: string;
  /** Present when the project was created in onboarding with at least one answer. */
  onboarding?: ProjectOnboarding;
  /** Who can review it; absent means `anyone`. */
  reviewAccess?: ReviewAccess;
  /** When Critiqs last loaded on a page at the project's own address (`reportConnected`); absent until then, or once its owners clear it. */
  connectedAt?: number;
  /** That page's origin, as its browser sent it; absent when a thread from before Connected stands for the load and its page can't be read. */
  connectedOrigin?: string;
}

/**
 * One address in a project's address list, which the browser extension's
 * project lookup searches. Rows carry the project's organization, so the
 * lookup reads only the organizations a person belongs to.
 */
export interface ProjectAddressRecord {
  _id: string;
  projectId: string;
  /** The project's organization when the list was saved; moving a project to another organization must rewrite its rows. */
  organizationId: string;
  /** Normalized, as `parseProjectAddress` in @critiqs/core returns it. */
  address: string;
  /** What the lookup searches by: the origin, or for a pattern, its key such as `https://*.vercel.app`. */
  key: string;
  /** Its place in the list, from 0. */
  position: number;
}

/**
 * That a person opened a project through an install (the component connecting
 * with its project ID), or later a review link. The lookup also searches these
 * projects. Opening a thread page never records one.
 */
export interface OpenedProjectRecord {
  _id: string;
  userId: string;
  projectId: string;
  /** Updated at most once a day, so recording again usually writes nothing. */
  openedAt: number;
}

/**
 * A project created with an idempotency key, so a retry of the same request
 * by the same person returns that project instead of creating another.
 * Kept for `CREATE_KEY_MS` after the create.
 */
export interface ProjectCreationRecord {
  userId: string;
  /** Chosen by the client, unique to one person's create request. */
  key: string;
  projectId: string;
  createdAt: number;
}

/** A group of people that owns projects and the Critiqs Cloud plan covering them. */
export interface OrganizationRecord {
  _id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  /** Critiqs Cloud plan; absent means the default plan. */
  plan?: string;
  /** Critiqs AI credits allowed past the plan's: absent means the plan's default, null means no cap. */
  overageCap?: number | null;
  /** Extra image storage bought, 100 GB each. */
  extraStorageUnits?: number;
}

/** That a person belongs to an organization, and as what. */
export interface MembershipRecord {
  _id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: number;
}

/** An emailed invitation to join an organization. */
export interface InviteRecord {
  _id: string;
  organizationId: string;
  /** Normalized, as sign-in normalizes addresses. */
  email: string;
  role: OrganizationRole;
  invitedBy: string;
  createdAt: number;
  acceptedAt?: number;
}

/** A developer setup email exactly as first prepared, so a retry under its key sends the same request. */
export interface StoredMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  fromName: string;
  replyTo: string;
}

/**
 * One time a setup email was handed to the mail service under its key, and
 * its answer: `accepted`, `refused` (certainly not delivered), or null while
 * none came, because it is still out, its answer was lost, or the worker
 * stopped after claiming it.
 */
export interface DeveloperAttempt {
  at: number;
  /**
   * The mail service's answer: `unknown` when the attempt ended without one,
   * so it may have gone out; null while the attempt is still waiting for it,
   * which holds the email (`DEVELOPER_ATTEMPT_CLAIM_MS`).
   */
  answer: "accepted" | "refused" | "unknown" | null;
}

/** The setup email a project sent to one developer's address. */
export interface DeveloperSendRecord {
  _id: string;
  projectId: string;
  /** The exact address it goes to, normalized, fixed when the record is created; one record per project and address. */
  email: string;
  /** Who asked for the current email. */
  sentBy: string;
  createdAt: number;
  /** When the current email was reserved: counted, but not yet handed to the mail service. */
  reservedAt: number;
  /** The current email's number, from 0, in its idempotency key; an email that replaces a failed one, or a resend, gets the next. */
  emailNumber: number;
  /** How many times the address was sent the steps again after an email went out (`MAX_DEVELOPER_RESENDS`); absent means none. */
  resends?: number;
  /** The current email's attempts, oldest first; its status follows from them (`sendStatus`). */
  attempts: DeveloperAttempt[];
  /** The current email, once prepared. */
  message?: StoredMail;
}

/** A usage counter for one metric, organization, person, or project, and period. */
export interface UsageRecord {
  _id: string;
  key: string;
  count: number;
}

export type StoredCapture =
  | { status: "captured"; fileId: string }
  | { status: "supplied"; fileId: string; failureReason: string }
  | { status: "failed"; failureReason: string };

export type ThreadStatus = "open" | "resolved" | "deleted";

export interface ThreadRecord {
  _id: string;
  projectId: string;
  status: ThreadStatus;
  anchor: Anchor;
  tags: string[];
  capture: StoredCapture;
  createdBy: string;
  createdAt: number;
  /** Newest message time. Edits, reactions, and status changes leave it unchanged. */
  lastMessageAt: number;
  messageCount: number;
  /**
   * Whether `followers` lists everyone in the thread (whoever started it,
   * replied, or was mentioned in it), for reply emails. Absent on threads from
   * before reply emails until the background job has read their discussion.
   */
  followersReady?: boolean;
  /** Message edits so far, so work that reads a whole discussion can tell it changed meanwhile. */
  editCount?: number;
  statusChangedBy?: string;
  statusChangedAt?: number;
  /** True when the thread was last resolved because every ticket linked to it was done (Resolve when done), not by a person; `statusChangedBy` then doesn't apply. */
  statusChangedByTickets?: boolean;
  /** Replacement target. The anchor keeps the original target and evidence. */
  reattachment?: { location: TargetLocation; reattachedBy: string; reattachedAt: number };
  /**
   * Hashtags the thread's messages use, by key, with the first spelling and
   * how many messages use each. Explicit tags stay in `tags`.
   */
  textTags?: TextTag[];
  /** Set on a mockup thread: a discussion of a mockup, kept out of the thread list, search, and export. */
  mockup?: ThreadMockup;
  /**
   * The key in the thread page's link (`/t/<key>`), which never carries the
   * thread's ID. New threads get one; older threads get one the first time
   * someone shares them.
   */
  pageKey?: string;
  /**
   * How it was left: with Critiqs installed on the prototype, or with the
   * browser extension. Absent on threads from before it was recorded, which
   * were left with an install: the extension was never published before.
   */
  madeWith?: ThreadMadeWith;
}

/** How a thread was left: with Critiqs installed on the prototype, or with the browser extension. */
export type ThreadMadeWith = "install" | "extension";

/** A hashtag some of a thread's messages use. */
export interface TextTag {
  key: string;
  label: string;
  /** Messages using it; the thread has the tag while this is above zero. */
  count: number;
}

export interface MessageRecord {
  _id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: number;
  editedAt: number | null;
  revision: Revision;
  /** Reviewers the message mentions, with the name as written in the text. */
  mentions?: StoredMention[];
  /** The thread's project, so search can find messages by project. Absent before tags were derived. */
  projectId?: string;
  /** Unique hashtags the text uses, each as first written. Absent before tags were derived. */
  hashtags?: string[];
  /**
   * Written for its author by a coding agent (`critiqs_reply`), or by Critiqs
   * AI in a mockup thread. Absent for messages the author wrote.
   */
  via?: "agent" | "ai";
  /** The mockup version Critiqs AI saved with this message. */
  mockupVersion?: number;
}

/** A mention: the reviewer's ID, and the name the text shows after `@`, kept even if they rename. */
export interface StoredMention {
  userId: string;
  label: string;
}

export interface ReactionRecord {
  _id: string;
  threadId: string;
  messageId: string;
  userId: string;
  emoji: string;
}

export interface ReadStateRecord {
  _id: string;
  userId: string;
  threadId: string;
  lastReadAt: number;
  manualUnread: boolean;
}

/** Someone who has commented in a project; the people who can be mentioned there. */
export interface ParticipantRecord {
  _id: string;
  projectId: string;
  userId: string;
  lastActiveAt: number;
}

export type DeliveryStatus = "pending" | "sending" | "sent" | "skipped" | "failed";

/**
 * One email owed to one reviewer about one thread. Mentions gather into it for
 * a short pause; once a send is attempted its content and key are fixed, and
 * later mentions start a new delivery.
 */
export interface DeliveryRecord {
  _id: string;
  recipientId: string;
  projectId: string;
  threadId: string;
  status: DeliveryStatus;
  /** Send attempts so far. */
  attempts: number;
  /** When it may next be sent. */
  dueAt: number;
  /** The worker holding it while sending, and until when. */
  claimToken?: string;
  leaseUntil?: number;
  /** An email prepared before prepared emails were stored as files; sent unchanged on every retry. */
  message?: { to: string; subject: string; text: string; html: string };
  /**
   * The email as first prepared: a private file holding the exact request for
   * the mail service, sent unchanged on every retry, and the address it goes to.
   */
  payload?: { fileId: string; to: string };
  createdAt: number;
  finishedAt?: number;
  /** Why it was skipped or failed. */
  reason?: string;
}

/**
 * The line an organization's Critiqs AI credits crossed this month:
 * `included`, the credits its plan includes are used and extra credits are
 * billed; `paused`, no credits are left.
 */
export type PlanAlertKind = "included" | "paused";

/** An email owed to an organization's admins about its Critiqs AI credits, at most one of each kind per month and plan. */
export interface PlanAlertRecord {
  _id: string;
  organizationId: string;
  kind: PlanAlertKind;
  /** The month it is about, `YYYY-MM` (UTC). */
  month: string;
  /** The plan as the line was crossed: its name, its label for the email, the credits it includes, and the extra allowed. */
  plan: string;
  planLabel: string;
  included: number;
  /** Absent when the plan allows no extra credits; a null cap allows any. */
  overage?: { cap: number | null };
  /** The project whose request crossed the line, for the email's link. */
  projectId?: string;
  status: DeliveryStatus;
  attempts: number;
  dueAt: number;
  claimToken?: string;
  leaseUntil?: number;
  createdAt: number;
  finishedAt?: number;
  reason?: string;
}

/** One message a delivery reports: one that mentions the recipient, or a reply in a thread they are in. */
export interface NotificationRecord {
  _id: string;
  deliveryId: string;
  recipientId: string;
  messageId: string;
  authorId: string;
  createdAt: number;
  /** Why the recipient is told: absent (from before reply emails) means a mention. */
  kind?: "mention" | "reply";
}

/** Someone in a thread: they started it, replied, or were mentioned in it. They get its later replies' emails. */
export interface FollowerRecord {
  _id: string;
  threadId: string;
  userId: string;
  /**
   * How many messages the thread had once they joined it (their first message
   * or mention). Replies numbered above this are emailed to them; counts, not
   * clock times, so edits and replies in the same millisecond still order.
   */
  since: number;
}

/**
 * A reply whose emails to everyone in its thread are still being queued by
 * the background worker, a page at a time: first, for a thread from before
 * reply emails, its messages (`scan`), to find who is in it; then the people
 * in it (`notify`).
 */
export interface ReplyEmailJobRecord {
  _id: string;
  projectId: string;
  threadId: string;
  messageId: string;
  authorId: string;
  createdAt: number;
  /**
   * The reply's number in its thread (its message count once written): people
   * who joined before it are told. 0 for a job that only records who is in an
   * older thread (`queueFollowerScan`) and emails no one.
   */
  position: number;
  stage: "scan" | "notify";
  cursor: string | null;
}

/** A reviewer's email notification choices. */
export interface PreferenceRecord {
  _id: string;
  userId: string;
  mentionEmails: boolean;
  /** Emails about new replies in threads the reviewer is in. Absent (from before reply emails) means on. */
  replyEmails?: boolean;
  mutedProjects: string[];
}

/** How a tag came to be in its groups; see TagGrouping in @critiqs/core. */
export type TagGroupingState = "pending" | "ai" | "starter" | "human" | "none";

/** A tag used or offered in a project. Its label is the first spelling seen. */
export interface TagRecord {
  _id: string;
  projectId: string;
  key: string;
  label: string;
  firstUsedAt: number;
  lastUsedAt: number;
  groupIds: string[];
  grouping: TagGroupingState;
  /**
   * Increases with every change a person makes, so automatic grouping that
   * started earlier can't apply over it.
   */
  epoch: number;
  /** Automatic grouping attempts so far. */
  attempts: number;
  /** When automatic grouping may next try this tag, while pending. */
  nextAttemptAt: number;
  /** The grouping run holding it, and until when. */
  claimToken?: string;
  leaseUntil?: number;
  /** Why the last automatic attempt failed, without provider details. */
  lastError?: string;
}

/** A shared group of tags in a project. */
export interface TagGroupRecord {
  _id: string;
  projectId: string;
  name: string;
  /** The name's key, so names differing only in case or spacing are one group. */
  nameKey: string;
  origin: "ai" | "human" | "starter";
  createdAt: number;
  updatedAt: number;
}

/** That a thread has a tag, explicit or written, so search can find threads by tag. */
export interface ThreadTagRecord {
  _id: string;
  projectId: string;
  threadId: string;
  key: string;
}

export type StoredAiProvider = "openai" | "anthropic" | "google" | "openrouter" | "gateway" | "compatible";

/** An AI provider key as stored: AES-GCM ciphertext and IV, base64, and the key's last four characters. */
export interface StoredSecret {
  ciphertext: string;
  iv: string;
  hint: string;
}

/** The fields every AI connection has, a project's or a person's. Keys are stored only encrypted, never returned. */
export interface StoredConnection {
  enabled: boolean;
  mode: "managed" | "own";
  /** The Critiqs AI model's id; absent means the deployment's first model. */
  managedModel?: string;
  provider?: StoredAiProvider;
  /** The own key's default model, always one of `models` when they are set. */
  model?: string;
  /** The own key's models a request may name; absent means only `model`. */
  models?: string[];
  baseUrl?: string;
  secret?: StoredSecret;
  /** Increases with every change, so work started under older settings can't apply. */
  epoch: number;
  updatedAt: number;
  lastTest?: { ok: boolean; at: number; message: string };
}

/** A project's AI connection, and whose connection people's requests use. */
export interface AiSettingsRecord extends StoredConnection {
  _id: string;
  projectId: string;
  updatedBy: string;
  /** Absent means `either`. */
  rule?: "project" | "personal" | "either";
  /** Critiqs AI model ids the project's connection may use; absent means all. */
  allowedModels?: string[];
}

/** A person's own AI connection, one per person. Its key is bound to the person, not a project. */
export interface PersonalAiSettingsRecord extends StoredConnection {
  _id: string;
  userId: string;
}

/** A tracker token as stored: AES-GCM ciphertext and IV, base64, bound to its person and tracker (`trackerTokenBinding`). */
export interface StoredToken {
  ciphertext: string;
  iv: string;
}

/** A person's connected tracker account, one per person and tracker. Tokens are stored only encrypted, never returned. */
export interface TrackerAccountRecord {
  _id: string;
  userId: string;
  tracker: TrackerId;
  /** Connected through the tracker's sign-in, or with a pasted personal token. */
  method: "oauth" | "token";
  /** The tracker's ID for the person, and the name it shows. */
  accountId: string;
  accountName: string;
  /** The workspace, organization, or Jira site the account is in, where the tracker has one. */
  site?: { id: string; name: string };
  access: StoredToken;
  /** Sign-in's refresh token, when the tracker issues one. */
  refresh?: StoredToken;
  /** When the access token expires, when the tracker says. */
  expiresAt?: number;
  /** Whether the person's new tickets say they came from Critiqs, by default. */
  attribution: boolean;
  connectedAt: number;
  updatedAt: number;
  /** A token refresh in progress, so only one runs at a time: trackers that rotate refresh tokens accept each only once. */
  refreshLease?: { id: string; until: number };
}

/**
 * A ticket linked to a thread. A ticket Critiqs is creating is saved as
 * `pending` before the tracker is called, so a retry knows a creation was
 * started; until it is `linked`, its `externalId`, `key`, and `url` are empty.
 */
export interface TicketLinkRecord {
  _id: string;
  projectId: string;
  threadId: string;
  tracker: TrackerId;
  externalId: string;
  key: string;
  url: string;
  title: string;
  /** The tracker's workspace, organization, or site ID, to match webhooks. */
  site?: string;
  state: "pending" | "linked";
  /**
   * For a ticket Critiqs creates: the creation's ID, which the ticket takes in
   * the tracker (Linear accepts it as the issue's ID). It is the Create
   * dialog's submission ID, the same across the creation's attempts and kept
   * once it is linked, so a retry never makes a second ticket.
   */
  creationId?: string;
  /** For a ticket Critiqs creates: the tracker account (the tracker's ID for it) its creator submitted it with. Only that account recovers it. */
  creatorAccountId?: string;
  /**
   * For a ticket Critiqs creates: where it was first submitted, such as a
   * GitHub repository, where a retry looks for the ticket an earlier attempt
   * may have made. Absent on creations from before it was recorded.
   */
  destinationId?: string;
  /** For a ticket Critiqs creates: the link back to the thread, as recorded when it was submitted, and whether the tracker has it. */
  linkBack?: { url: string; title: string; added: boolean };
  /** The attempt working on a pending link, and until when it may: only it calls the tracker for this creation, and only it may finish or release it. */
  claimToken?: string;
  /** When the attempt's lease ends; after an attempt ends without a ticket, when it ended. */
  leaseUntil?: number;
  /** A pending link set aside at once, without waiting to sit idle, because the tracker refused its creator's token while checking it. */
  parked?: boolean;
  /** The last status Critiqs knew, when it last read it, and when the tracker says it last changed. */
  status?: TicketStatus;
  statusCheckedAt?: number;
  statusChangedAt?: number;
  /**
   * The tracker's own time `status` was current as of (the ticket's last
   * update there), so an update older than the one already saved, such as a
   * webhook delivered late or replayed, changes nothing.
   */
  statusAsOf?: number;
  /** True when `status` says the tracker deleted the ticket: an update at the same `statusAsOf` never replaces it. */
  statusDeleted?: boolean;
  /** When opening the thread last started a check of the status, so it is checked at most once every few minutes. */
  statusCheckStartedAt?: number;
  /** Set when Critiqs can't check the status with the linker's account (disconnected, another account, or no longer allowed to see the ticket): `status` is the last one it knew. */
  statusStale?: boolean;
  /**
   * A check a status webhook asked for, not yet started: when, and whether
   * the delivery said the ticket was deleted. Where a delivery only says a
   * ticket changed (Jira), its status is read with the linker's token; while
   * one check waits, more deliveries ask for none.
   */
  statusCheckQueued?: { at: number };
  /** What the tracker's status webhooks filter the ticket by (a Jira project's ID), so a person's webhook follows only their linked tickets' scopes. */
  webhookScope?: string;
  /** The tracker account (the tracker's ID for it) the person linked or created the ticket with: status checks use only this account's token. */
  accountId?: string;
  /** Who linked or created it. */
  linkedBy: string;
  linkedAt: number;
  createdFromCritiqs: boolean;
}

/** A project's ticket settings. No record means templates off and Resolve when done off. */
export interface TicketSettingsRecord {
  _id: string;
  projectId: string;
  /** Whether the Create dialog offers the chosen tracker templates; absent means off. */
  templatesOn?: boolean;
  /** Tracker templates the project offers while templates are on, by destination. */
  templates: { tracker: TrackerId; destinationId: string; templateId: string; name: string; body?: string }[];
  /** Resolve a thread when every ticket linked to it is done. */
  resolveWhenDone: boolean;
  /** Where the project's new tickets go by default, per tracker. */
  defaults: { tracker: TrackerId; destinationId: string; name: string }[];
  updatedBy: string;
  updatedAt: number;
}

/** A tracker sign-in in progress: the OAuth state the tracker returns, whose it is, and until when it is accepted. */
export interface TrackerSignInRecord {
  _id: string;
  state: string;
  userId: string;
  tracker: TrackerId;
  expiresAt: number;
  /** The PKCE code verifier sent with the code, so a stolen code alone is useless. */
  verifier?: string;
  /**
   * Hash of a secret given only to the interface that started the sign-in. Its
   * window brings the secret to open the sign-in, and keeps it in a cookie to
   * finish it; a forwarded link has neither.
   */
  bindingHash?: string;
  /** When the starting interface's window opened the sign-in; it opens once. */
  openedAt?: number;
  /**
   * When the tracker sent the window back and Critiqs began trading its code
   * for tokens; the sign-in is kept until they are saved, so disconnecting
   * meanwhile, which removes it, cancels it.
   */
  claimedAt?: number;
  /** The site the person chose to connect, where the tracker has several (a Jira site's host). */
  site?: string;
}

/**
 * A status webhook a person's sign-in registered with a tracker that sends
 * webhooks only to those its users register, and expires them (Jira): one per
 * person, tracker, and site, following the tickets of `scopes` (Jira
 * projects) that the person linked or created there.
 */
export interface TrackerWebhookRecord {
  _id: string;
  userId: string;
  tracker: TrackerId;
  /** The tracker account it was registered as (the tracker's ID for it); renewed only with that account's token. */
  accountId: string;
  site: { id: string; name: string };
  /** The tracker's ID for the webhook; unique within its site only. */
  hookId: string;
  scopes: string[];
  expiresAt: number;
  updatedAt: number;
  /** A registration or renewal in progress, so only one runs at a time. */
  lease?: { id: string; until: number };
}

export interface FileInfo {
  /** Absent when the upload declared no type. */
  contentType?: string;
  size: number;
  createdAt: number;
}

export interface PageResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

type New<T extends { _id: string }> = Omit<T, "_id">;

/** What may change after a record is created; everything else is fixed. */
export type UserChanges = Partial<Pick<UserRecord, "name" | "email" | "imageUrl" | "profileVersion" | "plan" | "homeOrganizationId" | "role" | "teamSize">>;
export type OrganizationChanges = Partial<Pick<OrganizationRecord, "name" | "plan" | "extraStorageUnits">> & {
  /** `default` removes the organization's own cap, so the plan's default applies. */
  overageCap?: OverageCapChoice;
};
/** An organization's cap on extra Critiqs AI credits: a number of credits, null for no cap, or `default` for the plan's. */
export type OverageCapChoice = number | null | "default";
export type PlanAlertChanges = Partial<Pick<PlanAlertRecord, "status" | "attempts" | "dueAt" | "claimToken" | "leaseUntil" | "finishedAt" | "reason">>;
export type ThreadChanges = Partial<
  Pick<
    ThreadRecord,
    | "status"
    | "tags"
    | "capture"
    | "lastMessageAt"
    | "messageCount"
    | "editCount"
    | "statusChangedBy"
    | "statusChangedAt"
    | "statusChangedByTickets"
    | "reattachment"
    | "textTags"
    | "followersReady"
    | "pageKey"
  >
>;
export type MessageChanges = Partial<Pick<MessageRecord, "body" | "editedAt" | "mentions" | "projectId" | "hashtags">>;
export type TagChanges = Partial<
  Pick<TagRecord, "label" | "lastUsedAt" | "groupIds" | "grouping" | "epoch" | "attempts" | "nextAttemptAt" | "claimToken" | "leaseUntil" | "lastError">
>;
export type TagGroupChanges = Partial<Pick<TagGroupRecord, "name" | "nameKey" | "updatedAt">>;
type ConnectionField = "managedModel" | "provider" | "model" | "models" | "baseUrl" | "secret" | "lastTest";
/** Changes to a project's AI settings; `null` clears an optional field. */
export type AiSettingsChanges = Partial<Pick<AiSettingsRecord, "enabled" | "mode" | "epoch" | "updatedAt" | "updatedBy">> & {
  [K in ConnectionField | "rule" | "allowedModels"]?: AiSettingsRecord[K] | null;
};
/** Changes to a person's AI settings; `null` clears an optional field. */
export type PersonalAiSettingsChanges = Partial<Pick<PersonalAiSettingsRecord, "enabled" | "mode" | "epoch" | "updatedAt">> & {
  [K in ConnectionField]?: PersonalAiSettingsRecord[K] | null;
};
export type ProjectChanges = Partial<Pick<ProjectRecord, "reviewUrl" | "organizationId" | "reviewAccess" | "tags">> & {
  /** Sets `connectedAt` and `connectedOrigin` together; null clears both. */
  connection?: { at: number; origin: string | null } | null;
};
export type DeliveryChanges = Partial<
  Pick<DeliveryRecord, "status" | "attempts" | "dueAt" | "claimToken" | "leaseUntil" | "message" | "payload" | "finishedAt" | "reason">
>;
/** Changes to a send record; a null message clears it, for a new email. */
export type DeveloperSendChanges = Partial<Pick<DeveloperSendRecord, "sentBy" | "reservedAt" | "emailNumber" | "attempts" | "resends">> & { message?: StoredMail | null };
export type PreferenceChanges = Partial<Pick<PreferenceRecord, "mentionEmails" | "replyEmails" | "mutedProjects">>;
export type ReadStateChanges = Partial<Pick<ReadStateRecord, "lastReadAt" | "manualUnread">>;
/** Changes to a tracker account; `null` clears an optional field. */
export type TrackerAccountChanges = Partial<Pick<TrackerAccountRecord, "method" | "accountId" | "accountName" | "access" | "attribution" | "connectedAt" | "updatedAt">> & {
  [K in "site" | "refresh" | "expiresAt" | "refreshLease"]?: TrackerAccountRecord[K] | null;
};
/** Changes to a ticket link; `null` clears an optional field. */
export type TicketLinkChanges = Partial<Pick<TicketLinkRecord, "externalId" | "key" | "url" | "title" | "state" | "linkedAt">> & {
  [K in "site" | "creationId" | "creatorAccountId" | "linkBack" | "claimToken" | "leaseUntil" | "parked" | "status" | "statusCheckedAt" | "statusChangedAt" | "statusAsOf" | "statusDeleted" | "statusCheckStartedAt" | "statusStale" | "statusCheckQueued" | "webhookScope" | "accountId"]?: TicketLinkRecord[K] | null;
};
export type TicketSettingsChanges = Partial<Pick<TicketSettingsRecord, "templatesOn" | "templates" | "resolveWhenDone" | "defaults" | "updatedBy" | "updatedAt">>;

export interface Store {
  /** The ID if `raw` is a well-formed ID for that table in this backend, else null. */
  normalizeId(
    table: "projects" | "threads" | "messages" | "files" | "users" | "deliveries" | "tagGroups" | "organizations" | "invites" | "developerSends",
    raw: string,
  ): string | null;

  users: {
    byToken(tokenIdentifier: string): Promise<UserRecord | null>;
    get(id: string): Promise<UserRecord | null>;
    insert(user: New<UserRecord>): Promise<string>;
    patch(id: string, changes: UserChanges): Promise<void>;
  };
  organizations: {
    get(id: string): Promise<OrganizationRecord | null>;
    insert(organization: New<OrganizationRecord>): Promise<string>;
    patch(id: string, changes: OrganizationChanges): Promise<void>;
  };
  memberships: {
    find(organizationId: string, userId: string): Promise<MembershipRecord | null>;
    insert(membership: New<MembershipRecord>): Promise<string>;
    patch(id: string, changes: Pick<MembershipRecord, "role">): Promise<void>;
    delete(id: string): Promise<void>;
    /** A person's memberships, oldest first; at most `limit`. */
    forUser(userId: string, limit: number): Promise<MembershipRecord[]>;
    /** An organization's admins, oldest first; at most `limit`. */
    admins(organizationId: string, limit: number): Promise<MembershipRecord[]>;
    /** An organization's memberships, oldest first; at most `limit`. */
    forOrganization(organizationId: string, limit: number): Promise<MembershipRecord[]>;
  };
  invites: {
    get(id: string): Promise<InviteRecord | null>;
    /** The organization's invite for this normalized address that no one has accepted yet. */
    findPending(organizationId: string, email: string): Promise<InviteRecord | null>;
    insert(invite: New<InviteRecord>): Promise<string>;
    patch(id: string, changes: Pick<InviteRecord, "acceptedAt">): Promise<void>;
    delete(id: string): Promise<void>;
    /** Invites no one has accepted yet, oldest first; at most `limit`. */
    pendingForOrganization(organizationId: string, limit: number): Promise<InviteRecord[]>;
    /** Invites to this normalized address no one has accepted yet, in any organization, oldest first; at most `limit`. */
    pendingForEmail(email: string, limit: number): Promise<InviteRecord[]>;
  };
  developerSends: {
    get(id: string): Promise<DeveloperSendRecord | null>;
    find(projectId: string, email: string): Promise<DeveloperSendRecord | null>;
    /** A project's send records, oldest first; at most `limit`. */
    forProject(projectId: string, limit: number): Promise<DeveloperSendRecord[]>;
    insert(send: New<DeveloperSendRecord>): Promise<string>;
    patch(id: string, changes: DeveloperSendChanges): Promise<void>;
  };
  /** Inboxes whose people reported Critiqs's email as unwanted; they get no more developer or invite emails. */
  emailSuppressions: {
    has(inbox: string): Promise<boolean>;
    /** Adds the inbox; nothing changes when it is already listed. */
    add(inbox: string, now: number): Promise<void>;
  };
  projects: {
    get(id: string): Promise<ProjectRecord | null>;
    insert(project: New<ProjectRecord>): Promise<string>;
    patch(id: string, changes: ProjectChanges): Promise<void>;
    /** Projects a reviewer created, oldest first. */
    listByCreator(userId: string, request: PageRequest): Promise<PageResult<ProjectRecord>>;
    /** Projects a reviewer created in an organization (null: from before organizations), oldest first; at most `limit`. */
    createdIn(userId: string, organizationId: string | null, limit: number): Promise<ProjectRecord[]>;
    /** An organization's projects, oldest first; at most `limit`. */
    inOrganization(organizationId: string, limit: number): Promise<ProjectRecord[]>;
  };
  /** Projects created with an idempotency key, by person and key. */
  projectCreations: {
    find(userId: string, key: string): Promise<ProjectCreationRecord | null>;
    /** Records the project a person's key created, replacing an expired record of the same key. */
    put(record: ProjectCreationRecord): Promise<void>;
    /** Removes up to `limit` of a person's records created before `before`, oldest first. */
    removeBefore(userId: string, before: number, limit: number): Promise<void>;
  };
  /** Projects' address lists. */
  projectAddresses: {
    /** A project's addresses in list order; at most `limit`. */
    forProject(projectId: string, limit: number): Promise<ProjectAddressRecord[]>;
    insert(address: New<ProjectAddressRecord>): Promise<string>;
    delete(id: string): Promise<void>;
    /** Addresses with this key in an organization's projects; at most `limit`. */
    inOrganization(organizationId: string, key: string, limit: number): Promise<ProjectAddressRecord[]>;
    /** One project's addresses with this key. */
    inProject(projectId: string, key: string): Promise<ProjectAddressRecord[]>;
  };
  openedProjects: {
    find(userId: string, projectId: string): Promise<OpenedProjectRecord | null>;
    insert(opened: New<OpenedProjectRecord>): Promise<string>;
    patch(id: string, changes: Pick<OpenedProjectRecord, "openedAt">): Promise<void>;
    /** Projects a person opened, most recently first; at most `limit`. */
    recent(userId: string, limit: number): Promise<OpenedProjectRecord[]>;
  };
  threads: {
    get(id: string): Promise<ThreadRecord | null>;
    insert(thread: New<ThreadRecord>): Promise<string>;
    patch(id: string, changes: ThreadChanges): Promise<void>;
    /** A project's threads that are not deleted and not about a mockup, oldest first. */
    listVisible(projectId: string, request: PageRequest): Promise<PageResult<ThreadRecord>>;
    /** The thread whose image is this file, if any. */
    byCaptureFile(fileId: string): Promise<ThreadRecord | null>;
    /** The thread whose page key this is, if any. */
    byPageKey(key: string): Promise<ThreadRecord | null>;
    /** A project's threads that are not deleted and not about a mockup, newest activity first; at most `limit`. */
    recent(projectId: string, limit: number): Promise<ThreadRecord[]>;
  };
  messages: {
    get(id: string): Promise<MessageRecord | null>;
    insert(message: New<MessageRecord>): Promise<string>;
    patch(id: string, changes: MessageChanges): Promise<void>;
    /** A thread's messages by time, then by the order they were written. */
    list(threadId: string, request: PageRequest): Promise<PageResult<MessageRecord>>;
    first(threadId: string): Promise<MessageRecord | null>;
    /** A thread's newest messages, newest first; at most `limit`. */
    latest(threadId: string, limit: number): Promise<MessageRecord[]>;
    /**
     * A project's messages containing any of `terms` (whole words or their
     * beginnings), best matches first; at most `limit`. Messages from before
     * tags were derived are found once backfilled.
     */
    search(projectId: string, terms: string[], limit: number): Promise<MessageRecord[]>;
  };
  reactions: {
    find(messageId: string, userId: string, emoji: string): Promise<ReactionRecord | null>;
    insert(reaction: New<ReactionRecord>): Promise<string>;
    delete(id: string): Promise<void>;
    list(threadId: string, request: PageRequest): Promise<PageResult<ReactionRecord>>;
  };
  readStates: {
    find(userId: string, threadId: string): Promise<ReadStateRecord | null>;
    insert(state: New<ReadStateRecord>): Promise<string>;
    patch(id: string, changes: ReadStateChanges): Promise<void>;
  };
  participants: {
    find(projectId: string, userId: string): Promise<ParticipantRecord | null>;
    insert(participant: New<ParticipantRecord>): Promise<string>;
    patch(id: string, changes: Partial<Pick<ParticipantRecord, "lastActiveAt">>): Promise<void>;
    /** A project's most recently active participants first. */
    recent(projectId: string, limit: number): Promise<ParticipantRecord[]>;
  };
  deliveries: {
    get(id: string): Promise<DeliveryRecord | null>;
    insert(delivery: New<DeliveryRecord>): Promise<string>;
    patch(id: string, changes: DeliveryChanges): Promise<void>;
    /** The newest delivery still gathering mentions for one reviewer and thread: pending and never attempted. */
    gathering(recipientId: string, threadId: string): Promise<DeliveryRecord | null>;
    /** Deliveries ready to send: pending and due, or sending with an expired lease. Oldest first. */
    due(now: number, limit: number): Promise<DeliveryRecord[]>;
    /** Sent, skipped, or failed deliveries that finished before `before`, for cleanup. */
    finishedBefore(before: number, limit: number): Promise<DeliveryRecord[]>;
    delete(id: string): Promise<void>;
  };
  planAlerts: {
    get(id: string): Promise<PlanAlertRecord | null>;
    /** The alert of this kind owed in `month` under the plan named `plan`. */
    find(organizationId: string, kind: PlanAlertKind, month: string, plan: string): Promise<PlanAlertRecord | null>;
    insert(alert: New<PlanAlertRecord>): Promise<string>;
    patch(id: string, changes: PlanAlertChanges): Promise<void>;
    /** Alerts ready to send: pending and due, or sending with an expired lease. Earliest due first. */
    due(now: number, limit: number): Promise<PlanAlertRecord[]>;
  };
  notifications: {
    insert(notification: New<NotificationRecord>): Promise<string>;
    /** A delivery's mentions, oldest first; at most `limit`. */
    forDelivery(deliveryId: string, limit: number): Promise<NotificationRecord[]>;
    delete(id: string): Promise<void>;
  };
  followers: {
    find(threadId: string, userId: string): Promise<FollowerRecord | null>;
    insert(follower: New<FollowerRecord>): Promise<string>;
    /** A thread's people, a page at a time. */
    list(threadId: string, request: PageRequest): Promise<PageResult<FollowerRecord>>;
  };
  replyEmailJobs: {
    insert(job: New<ReplyEmailJobRecord>): Promise<string>;
    /** The oldest job still waiting, or null. */
    next(): Promise<ReplyEmailJobRecord | null>;
    patch(id: string, changes: Partial<Pick<ReplyEmailJobRecord, "stage" | "cursor">>): Promise<void>;
    delete(id: string): Promise<void>;
  };
  preferences: {
    find(userId: string): Promise<PreferenceRecord | null>;
    insert(preference: New<PreferenceRecord>): Promise<string>;
    patch(id: string, changes: PreferenceChanges): Promise<void>;
  };
  tags: {
    find(projectId: string, key: string): Promise<TagRecord | null>;
    get(id: string): Promise<TagRecord | null>;
    insert(tag: New<TagRecord>): Promise<string>;
    patch(id: string, changes: TagChanges): Promise<void>;
    /** A project's tags, most recently used first; at most `limit`. */
    list(projectId: string, limit: number): Promise<TagRecord[]>;
    /** Pending tags due for automatic grouping, in any project, oldest due first. */
    due(now: number, limit: number): Promise<TagRecord[]>;
    /** One project's pending tags due for automatic grouping. */
    dueInProject(projectId: string, now: number, limit: number): Promise<TagRecord[]>;
    /** A project's tags in a state, for requeueing; at most `limit`. */
    inState(projectId: string, grouping: TagGroupingState, limit: number): Promise<TagRecord[]>;
  };
  tagGroups: {
    get(id: string): Promise<TagGroupRecord | null>;
    byName(projectId: string, nameKey: string): Promise<TagGroupRecord | null>;
    /** A project's groups by name; at most `limit`. */
    list(projectId: string, limit: number): Promise<TagGroupRecord[]>;
    insert(group: New<TagGroupRecord>): Promise<string>;
    patch(id: string, changes: TagGroupChanges): Promise<void>;
    delete(id: string): Promise<void>;
  };
  threadTags: {
    /** The tags recorded for a thread. */
    forThread(threadId: string): Promise<ThreadTagRecord[]>;
    insert(row: New<ThreadTagRecord>): Promise<string>;
    delete(id: string): Promise<void>;
    /** Threads with a tag, most recently tagged first; at most `limit`. */
    byKey(projectId: string, key: string, limit: number): Promise<ThreadTagRecord[]>;
  };
  aiSettings: {
    find(projectId: string): Promise<AiSettingsRecord | null>;
    insert(settings: New<AiSettingsRecord>): Promise<string>;
    patch(id: string, changes: AiSettingsChanges): Promise<void>;
  };
  personalAiSettings: {
    find(userId: string): Promise<PersonalAiSettingsRecord | null>;
    insert(settings: New<PersonalAiSettingsRecord>): Promise<string>;
    patch(id: string, changes: PersonalAiSettingsChanges): Promise<void>;
    delete(id: string): Promise<void>;
  };
  /** Short-window counters for operational limits, such as searches per minute. */
  rateLimits: {
    /** Counts one use of `key` in the current window; false, counting nothing, when `limit` is reached. */
    hit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>;
  };
  files: {
    info(fileId: string): Promise<FileInfo | null>;
    /** Removes a stored file, such as a prepared email no longer needed; nothing happens if it is gone. */
    delete(fileId: string): Promise<void>;
  };
  /** Critiqs Cloud's plans. Self-hosted stores report limits as off. */
  limits: {
    enabled(): boolean;
    /** A plan configured on this deployment, overriding the built-in one of that name. */
    plan(name: string): Promise<Plan | null>;
    /** Where people upgrade their plan, an https address; null when the deployment names none. */
    upgradeUrl?(): string | null;
  };
  usage: {
    find(key: string): Promise<UsageRecord | null>;
    insert(usage: New<UsageRecord>): Promise<string>;
    patch(id: string, changes: Pick<UsageRecord, "count">): Promise<void>;
    /** Whether `member`, such as a reviewer, already counted toward this counter. */
    isMember(key: string, member: string): Promise<boolean>;
    addMember(key: string, member: string): Promise<void>;
  };
  /** Critiqs AI credits the deployment bills organizations for; absent where nothing is billed, as on self-hosted deployments. */
  billedCredits?: {
    /** Records credits an organization used, in the same transaction as their charge; the deployment decides whether it bills them. */
    add(charge: { organizationId: string; credits: number; now: number }): Promise<void>;
  };
  /** Critiqs AI credits held for requests whose model is still answering, per payer's counter scope. */
  creditHolds: {
    /** The credits held for `scope` that haven't expired by `now`. */
    held(scope: string, now: number): Promise<number>;
    /** Holds credits for `scope` until `expiresAt`. */
    insert(hold: { scope: string; credits: number; expiresAt: number }, now: number): Promise<string>;
    /** Releases a hold; nothing happens if it is gone. */
    delete(id: string): Promise<void>;
  };
  /**
   * Tickets in trackers: people's tracker accounts, threads' ticket links,
   * projects' ticket settings, and tracker sign-ins in progress. Optional:
   * a backend without it offers no tickets (the SQLite store).
   */
  tickets?: {
    accounts: {
      find(userId: string, tracker: TrackerId): Promise<TrackerAccountRecord | null>;
      /** A person's tracker accounts, by tracker. */
      list(userId: string): Promise<TrackerAccountRecord[]>;
      /** Critiqs accounts connected to one tracker account (the tracker's ID for it) by `method`, whoever's; at most `limit`. */
      withAccountId(tracker: TrackerId, accountId: string, method: TrackerAccountRecord["method"], limit: number): Promise<TrackerAccountRecord[]>;
      insert(account: New<TrackerAccountRecord>): Promise<string>;
      patch(id: string, changes: TrackerAccountChanges): Promise<void>;
      delete(id: string): Promise<void>;
    };
    links: {
      /** The link, or null when `id` isn't one of this backend's link IDs. */
      get(id: string): Promise<TicketLinkRecord | null>;
      /** A thread's links in one state only (linked, or still being created), in the order they were added; at most `limit`. */
      listForThread(threadId: string, state: TicketLinkRecord["state"], limit: number): Promise<TicketLinkRecord[]>;
      /** Links to one ticket, in any thread, as status updates find them: at most `limit`. */
      findByExternal(tracker: TrackerId, externalId: string, limit: number): Promise<TicketLinkRecord[]>;
      /** The link a creation made or is making, in any thread, by its creation ID; null when there is none. */
      findByCreation(creationId: string): Promise<TicketLinkRecord | null>;
      /** Links one person made in a tracker's site, linked or pending: at most `limit`. */
      listForLinker(userId: string, tracker: TrackerId, site: string, limit: number): Promise<TicketLinkRecord[]>;
      insert(link: New<TicketLinkRecord>): Promise<string>;
      patch(id: string, changes: TicketLinkChanges): Promise<void>;
      delete(id: string): Promise<void>;
    };
    settings: {
      find(projectId: string): Promise<TicketSettingsRecord | null>;
      insert(settings: New<TicketSettingsRecord>): Promise<string>;
      patch(id: string, changes: TicketSettingsChanges): Promise<void>;
    };
    signIns: {
      findByState(state: string): Promise<TrackerSignInRecord | null>;
      insert(signIn: New<TrackerSignInRecord>): Promise<string>;
      patch(id: string, changes: Partial<Pick<TrackerSignInRecord, "openedAt" | "claimedAt">>): Promise<void>;
      delete(id: string): Promise<void>;
      /** A person's sign-ins under way for a tracker. */
      listForUser(userId: string, tracker: TrackerId): Promise<TrackerSignInRecord[]>;
    };
    /** Status webhooks registered with people's sign-ins (Jira). */
    webhooks: {
      /** The webhook record, or null when `id` isn't one of this backend's. */
      get(id: string): Promise<TrackerWebhookRecord | null>;
      /** A person's webhook for a tracker and site. */
      find(userId: string, tracker: TrackerId, siteId: string): Promise<TrackerWebhookRecord | null>;
      /** A person's webhooks for a tracker, on every site. */
      listForUser(userId: string, tracker: TrackerId): Promise<TrackerWebhookRecord[]>;
      /** Webhooks with this tracker ID on one site, named by its ID or by its host: IDs are unique only within a site. At most a few. */
      findByHook(tracker: TrackerId, site: { id: string } | { name: string }, hookId: string): Promise<TrackerWebhookRecord[]>;
      /** Webhooks that expire before `before`, soonest first; at most `limit`. */
      listExpiring(before: number, limit: number): Promise<TrackerWebhookRecord[]>;
      insert(webhook: New<TrackerWebhookRecord>): Promise<string>;
      patch(id: string, changes: Partial<Pick<TrackerWebhookRecord, "hookId" | "scopes" | "expiresAt" | "updatedAt" | "accountId">> & { lease?: TrackerWebhookRecord["lease"] | null }): Promise<void>;
      delete(id: string): Promise<void>;
    };
  };
}
