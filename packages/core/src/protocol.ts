import type { ThreadMockup } from "./mockup.ts";
import type { Anchor, Revision, TargetLocation } from "./types.ts";

// What a Critiqs backend returns to the interface, independent of how the
// backend stores it (Convex, or SQLite in the host app's server). IDs are
// opaque strings; only the backend that issued them interprets them.

/** One page of a list, with an opaque cursor for the next page. */
export interface Page<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

/** Request for one page of a list. */
export interface PageRequest {
  numItems: number;
  cursor: string | null;
}

export interface ProjectInfo {
  _id: string;
  name: string;
  tags: string[];
  createdAt: number;
  /** The prototype address mention emails link to, set during setup. */
  reviewUrl: string | null;
  /**
   * Whether the signed-in reviewer may manage the project: change its
   * settings and see its usage. An admin of its organization may, and so
   * may its creator while still a member.
   */
  isOwner: boolean;
  /** The project's organization, when the signed-in reviewer belongs to it; absent otherwise, and from backends without organizations. */
  organization?: { id: string; name: string; role: OrganizationRole };
  /** Who can review the project; absent from backends before the setting, where anyone who signs in can. */
  reviewAccess?: ReviewAccess;
}

/**
 * Who can review a project: read, add to, and download its feedback.
 * `anyone`: anyone who signs in, so the project ID alone grants access (the
 * default). `organization`: only members of the project's organization.
 */
export type ReviewAccess = "anyone" | "organization";

export const REVIEW_ACCESS: readonly ReviewAccess[] = ["anyone", "organization"];

/** What a member may do in an organization: admins manage all its projects; members manage the ones they created. */
export type OrganizationRole = "admin" | "member";

/** An organization the signed-in reviewer belongs to. */
export interface OrganizationSummary {
  id: string;
  name: string;
  role: OrganizationRole;
  /** Its Critiqs Cloud plan as shown to people, such as "Free"; null on a deployment without plans. */
  plan: string | null;
  /** Where the reviewer's new projects go unless they choose another; absent from backends before organization members. */
  home?: boolean;
}

/** One person in an organization, as its members see them. */
export interface OrganizationMember {
  userId: string;
  name: string;
  imageUrl: string | null;
  /** Shown to the organization's admins only; null for members. */
  email: string | null;
  role: OrganizationRole;
  /** The signed-in reviewer. */
  you: boolean;
}

/** An invitation waiting for someone to sign in with its address. */
export interface OrganizationInvite {
  _id: string;
  email: string;
  role: OrganizationRole;
  /** Who sent it, by name. */
  invitedBy: string;
  createdAt: number;
}

/** An organization as one of its members sees it. Only admins see its pending invites. */
export interface OrganizationDetails {
  id: string;
  name: string;
  /** The signed-in reviewer's role. */
  role: OrganizationRole;
  plan: string | null;
  members: OrganizationMember[];
  invites: OrganizationInvite[];
  /** Where to upgrade the plan, when the deployment names a page; absent from older backends. */
  upgradeUrl?: string;
}

/** A Critiqs Cloud plan an organization can buy or move to. */
export type BillingPlan = "free" | "plus" | "pro";

/** An organization's Critiqs Cloud subscription, on deployments that take payment. */
export interface BillingStatus {
  /** The plan whose limits apply, which an operator may have set without a subscription. */
  plan: BillingPlan;
  /** The paid subscription Autumn bills; null when nothing is billed, as on Free or a plan an operator set. */
  subscription: {
    /** The plan the subscription pays for, which `plan` follows once Autumn reports it. */
    plan: Exclude<BillingPlan, "free">;
    /** `past_due`: a renewal payment failed; the plan stays until it is paid or the subscription ends. */
    status: "active" | "past_due";
    /** When the current billing period ends, in milliseconds since 1970; null when not known yet. */
    currentPeriodEnd: number | null;
    /** The plan ends when the period does, and the organization moves to `scheduledPlan`. */
    cancelAtPeriodEnd: boolean;
    /** The plan that takes over when the period ends, such as after a downgrade; null when none is scheduled. */
    scheduledPlan: BillingPlan | null;
  } | null;
  /** Pro's 100 GB storage add-ons the organization pays for: those that renew. */
  storageAddOns: number;
  /**
   * Storage add-ons that no longer renew but still add storage until their
   * own period ends (`endsAt`, null when not known yet), as after Remove or
   * with a plan set to end. Absent from older backends.
   */
  endingStorageAddOns?: { endsAt: number | null }[];
  /** Whether the signed-in person may change the plan and payment details: an admin of the organization. */
  canManage: boolean;
  /** What the plans cost, from Autumn's catalog as last read; null until it has been read. */
  prices: BillingPrices | null;
  /** What each plan includes, from the deployment's plan configuration, which sets the limits. */
  plans: Record<BillingPlan, PlanIncludes>;
}

/** What a plan includes, as the deployment configures it. */
export interface PlanIncludes {
  /** The plan's name as shown, such as "Plus". */
  label: string;
  /**
   * What it allows of each thing people see counted, in this order: Critiqs
   * AI credits, projects, images stored (in bytes), reviewers, comments, and
   * mention emails. `max` is null when the plan doesn't limit it; `addOn` is
   * what each add-on the organization buys adds, as Pro's storage.
   */
  limits: { metric: ProjectUsage["rows"][number]["metric"]; period: "total" | "month" | "day"; max: number | null; addOn?: number }[];
}

/** Critiqs Cloud's prices in US dollars, as Autumn's catalog sets them. */
export interface BillingPrices {
  /** Each plan's price a month, and what its Critiqs AI credits past the included ones cost: `amount` per `credits`; null when it sells none. */
  plans: Record<BillingPlan, { monthly: number; extraCredits: { amount: number; credits: number } | null }>;
  /** Pro's storage add-on: the image storage one adds, in GB, and its price a month. */
  storageAddOn: { gb: number; monthly: number };
}

/** What a billing change asks of the person: nothing more, or a payment page to open. */
export interface BillingChange {
  /** A Stripe page to finish the change on, such as checkout; null when the change is already made or scheduled. */
  url: string | null;
}

/** A thread's image state (F6). Storage details stay on the backend. */
export type CaptureState =
  | { status: "captured" }
  | { status: "supplied"; failureReason: string }
  | { status: "failed"; failureReason: string };

/** A thread as listed in the sidebar, with the reviewer's own unread state. */
export interface ThreadSummary {
  _id: string;
  status: "open" | "resolved";
  anchor: Anchor;
  /** The replacement target after reattachment, if any. */
  location: TargetLocation | null;
  /** Every tag the thread has: its explicit tags, then hashtags its messages use. */
  tags: string[];
  /** The hashtags among `tags`, which change by editing the text; absent from backends before protocol 5. */
  textTags?: string[];
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  unread: boolean;
  preview: { body: string; authorName: string; authorImageUrl: string | null } | null;
  /** Set on a mockup thread; absent from backends without mockups. */
  mockup?: ThreadMockup;
}

export interface ReviewerInfo {
  name: string;
  imageUrl: string | null;
}

export interface ReactionCount {
  emoji: string;
  count: number;
  mine: boolean;
}

/** A reviewer mentioned in a message: their ID, current name, and the name the text shows after `@`. */
export interface MentionView {
  _id: string;
  name: string;
  /** As written when they were mentioned; it stays in the text if they rename. */
  label: string;
}

/** A mention as the interface sends it. */
export interface NewMention {
  userId: string;
  label: string;
}

export interface MessageView {
  _id: string;
  body: string;
  /** Reviewers this message mentions; the body shows each as `@Name`. */
  mentions: MentionView[];
  createdAt: number;
  editedAt: number | null;
  revision: Revision;
  author: ReviewerInfo;
  /** The author's permanent ID in this project's backend, as mentions and participants use; absent from older backends. */
  authorId?: string;
  /** Written by a coding agent for its author, or by Critiqs AI in a mockup thread; absent when the author wrote it. */
  via?: "agent" | "ai";
  /** The mockup version Critiqs AI made with this reply. */
  mockupVersion?: number;
  isMine: boolean;
  reactions: ReactionCount[];
}

/** A thread's whole discussion, as opened in its thread window. */
export interface ThreadDetail {
  _id: string;
  projectId: string;
  status: "open" | "resolved";
  anchor: Anchor;
  /** Every tag the thread has: its explicit tags, then hashtags its messages use. */
  tags: string[];
  /** The hashtags among `tags`, which change by editing the text; absent from backends before protocol 5. */
  textTags?: string[];
  capture: CaptureState;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  statusChangedByName: string | null;
  statusChangedAt?: number;
  reattachment?: { location: TargetLocation; reattachedAt: number };
  reattachedByName: string | null;
  readState: { lastReadAt: number; manualUnread: boolean } | null;
  /** Set on a mockup thread; absent from backends without mockups. */
  mockup?: ThreadMockup;
  /**
   * Whether the viewer may delete it: they started it, or they manage the
   * project. Absent from older backends, which let anyone who could review it.
   */
  canDelete?: boolean;
  messages: MessageView[];
}

/** One message in an export. */
export interface ExportedMessage {
  _id: string;
  author: string;
  /** The author's permanent ID, which names can't change or share; absent from older backends. */
  authorId?: string;
  /** Written by a coding agent for its author, or by Critiqs AI in a mockup thread; absent when the author wrote it. */
  via?: "agent" | "ai";
  body: string;
  createdAt: number;
  editedAt: number | null;
  revision: Revision;
}

/** One exported thread with its whole discussion. */
export interface ExportedThread {
  _id: string;
  status: "open" | "resolved";
  tags: string[];
  anchor: Anchor;
  location: TargetLocation | null;
  hasCapture: boolean;
  messages: ExportedMessage[];
}

export interface ExportData {
  projectName: string;
  threads: ExportedThread[];
}

/** An image for a new thread: uploaded, or the reason capture failed. */
export type NewCapture = { status: "captured"; fileId: string } | { status: "failed"; failureReason: string };

export interface NewThread {
  projectId: string;
  anchor: Anchor;
  body: string;
  tags: string[];
  capture: NewCapture;
  /** People chosen from mention suggestions. */
  mentions: NewMention[];
  /** Starts a mockup thread; only backends with mockups accept it. */
  mockup?: ThreadMockup;
}

/** Someone who has commented in a project, as mention suggestions show them. Never their email. */
export interface ParticipantInfo {
  _id: string;
  name: string;
  imageUrl: string | null;
}

/**
 * A project's usage against its Critiqs Cloud plan, for those who manage it.
 * Projects, images, and Critiqs AI credits (`aiCredits`) count for the whole
 * organization; the rest for the project.
 */
export interface ProjectUsage {
  plan: string;
  /** What the plan limits. */
  rows: {
    metric: "projects" | "threads" | "messages" | "reviewers" | "captureBytes" | "mentionEmails" | "aiRequests" | "aiCredits";
    period: "total" | "month" | "day";
    used: number;
    /** What the plan includes. */
    max: number;
    /** Usage may go past `max`, billed as extra, by up to `cap` more; a null cap allows any. Absent when the plan allows nothing past `max`. */
    overage?: { cap: number | null };
  }[];
  /** What the plan doesn't limit, with usage so far; absent from backends before it. */
  unlimited?: {
    metric: ProjectUsage["rows"][number]["metric"];
    period: "total" | "month" | "day";
    used: number;
  }[];
  /** Where to upgrade the plan, when the deployment names a page. */
  upgradeUrl?: string;
}

/** What an organization's plan limits for the whole organization, with usage so far, for its members. */
export interface OrganizationUsage {
  /** The plan's label, such as "Plus". */
  plan: string;
  /** Organization-wide limits only: projects, Critiqs AI credits, and images stored; as in `ProjectUsage`. */
  rows: ProjectUsage["rows"];
  unlimited?: ProjectUsage["unlimited"];
  /** The plan's own cap on extra Critiqs AI credits, and whether the organization uses it; absent when the plan allows no extra. */
  extraCredits?: { defaultCap: number; usesDefault: boolean };
}

/** The signed-in reviewer's email notification choices. */
export interface NotificationSettings {
  /** Email me when someone mentions me, in any project. */
  mentionEmails: boolean;
  /** Email me about new replies in threads I'm in, in any project; absent from backends without reply emails. */
  replyEmails?: boolean;
  /** This project's emails are muted. */
  projectMuted: boolean;
}

/** Error codes every backend reports, so the interface can explain them. */
export type ErrorCode =
  | "unauthenticated"
  | "email-unverified"
  | "forbidden"
  | "not-found"
  | "unavailable"
  | "invalid"
  | "limit"
  /** The project's AI usage rule needs the person's own AI connection, and they haven't set one up. */
  | "setup-ai";

// Pages as backends return them; clients combine pages into the types above.

/** One page of a thread's messages, with the thread's own fields on every page. */
export type ThreadDetailPage = Omit<ThreadDetail, "messages"> & Page<Omit<MessageView, "reactions">>;

export interface ReactionRow {
  messageId: string;
  emoji: string;
  mine: boolean;
}

/** One page of one selected thread's export. A deleted or inaccessible thread has no `thread`. */
export type ExportPage = { projectName: string; thread: Omit<ExportedThread, "messages"> | null } & Page<ExportedMessage>;

/**
 * One page of a thread page's discussion: the thread as `ThreadDetailPage`
 * has it, with what the page shows around it. Returned only to those who may
 * open the thread page.
 */
export type ThreadPageDetail = ThreadDetailPage & {
  /**
   * The thread's project: its name, its review address, where **Open in
   * prototype** goes when it is installed there, and when Critiqs last
   * loaded at the project's own address (null: not since it was recorded or
   * cleared; absent from older backends).
   */
  project: { name: string; reviewUrl: string | null; connectedAt?: number | null };
  /**
   * Where the thread was left: the saved page and its logical screen, for
   * **Open in prototype**, and whether it was left with Critiqs installed or
   * with the browser extension (absent on threads from before that was
   * recorded, which were left with an install, and from older backends).
   */
  prototype: { pageUrl: string; screen: string; madeWith?: "install" | "extension" };
};

/** A whole thread page, as the self-hosted server returns it: every page of its discussion, with reactions. */
export type ThreadPageView = ThreadDetail & Pick<ThreadPageDetail, "project" | "prototype">;
