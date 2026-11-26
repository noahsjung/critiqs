import type {
  AddressNote,
  ReviewAccess,
  AiChoiceView,
  BillingChange,
  BillingPlan,
  BillingStatus,
  AiModelListDraft,
  AiModelListResult,
  AiSettingsInput,
  AiSettingsView,
  AiTestResult,
  ErrorCode,
  ExportData,
  MockupDetail,
  MockupListScope,
  MockupSource,
  MockupSummary,
  NewMention,
  NewThread,
  NotificationSettings,
  OrganizationDetails,
  OrganizationRole,
  OrganizationSummary,
  OrganizationUsage,
  ParticipantInfo,
  PersonalAiSettingsInput,
  PersonalAiSettingsView,
  PersonalAiUsage,
  ProjectInfo,
  ProjectTags,
  ProjectUsage,
  Revision,
  SearchResponse,
  SearchScope,
  TargetLocation,
  ThreadDetail,
  ThreadSummary,
  TrackerAccountView,
  TrackerDisconnected,
  TrackerId,
  TrackerSignInStart,
} from "@critiqs/core";
import { PageLayerError } from "@critiqs/core";
import { createContext, type ReactNode, useContext } from "react";

/** A live query's state. Errors are values the interface can explain. */
export type QueryState<T> =
  | { status: "loading" }
  | { status: "error"; code: string; message: string }
  | { status: "ready"; data: T };

/**
 * A live list read a page at a time, with the statuses of Convex's
 * `usePaginatedQuery`: `loadMore` asks for more while `CanLoadMore`. Items
 * added or changed later join the pages they fall in, so a new item shows at
 * the top. A page that can't load throws, so render the list inside an error
 * boundary.
 */
export interface PagedList<T> {
  results: T[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
}

/**
 * What an invite did. `email`, for a new invite: `sent` once the mail service
 * accepted it, `not-sent` when none went out (no email on the deployment, an
 * email limit, or a failed send), so the person joins by signing in, and
 * `pending` when it is sent afterwards, as on Convex. Absent from older
 * backends, which say nothing about it.
 */
export interface InviteAnswer {
  status: "invited" | "member" | "pending";
  email?: "sent" | "not-sent" | "pending";
}

/**
 * How the interface reaches a Critiqs backend. The interface uses only these
 * operations and Critiqs's own types, so it works the same whether the backend
 * is Convex (live updates) or a server in the host app (checked periodically).
 * Methods named `use…` are React hooks.
 */
export interface CritiqsTransport {
  /** Wraps the interface in anything the backend client needs, such as its React provider. */
  wrap(children: ReactNode): ReactNode;
  /**
   * Whether the backend accepted the reviewer's sign-in. `rejected` means it
   * checked a token and refused it, unlike a token that couldn't be fetched,
   * such as while offline.
   */
  useAuth(): { isLoading: boolean; isAuthenticated: boolean; rejected: boolean };
  useProject(projectId: string | null): QueryState<ProjectInfo>;
  /** Projects the reviewer created, for reconnecting in setup. */
  useMyProjects(enabled: boolean): QueryState<ProjectInfo[]>;
  /** The organizations the reviewer belongs to, on backends whose configuration reports `organizations`. */
  useMyOrganizations(enabled: boolean): QueryState<OrganizationSummary[]>;
  /** An organization's members, and for its admins pending invites; on backends whose configuration reports `organizationMembers`. */
  useOrganization(organizationId: string | null): QueryState<OrganizationDetails>;
  renameOrganization(organizationId: string, name: string): Promise<void>;
  /** Invites someone by email; `projectId`, the project the admin is in, links the email to its prototype. */
  inviteMember(args: { organizationId: string; email: string; role: OrganizationRole; projectId?: string }): Promise<InviteAnswer>;
  revokeInvite(inviteId: string): Promise<void>;
  setMemberRole(args: { organizationId: string; userId: string; role: OrganizationRole }): Promise<void>;
  /** Removes someone from an organization, or, given the reviewer's own ID, leaves it. */
  removeMember(args: { organizationId: string; userId: string }): Promise<void>;
  /** Every thread the reviewer may see, with personal unread state. */
  useThreads(projectId: string | null): QueryState<ThreadSummary[]>;
  /** A thread's whole discussion, with reactions combined per message. */
  useThread(threadId: string): QueryState<ThreadDetail>;
  /**
   * Mention suggestions whose name contains the query: whom the reviewer may
   * mention in the thread they reply in, or with `threadId` null in a new thread.
   */
  useParticipants(projectId: string | null, query: string, threadId?: string | null): QueryState<ParticipantInfo[]>;
  /** The signed-in reviewer's email notification choices for a project. */
  useNotificationSettings(projectId: string | null): QueryState<NotificationSettings>;
  /** The project's usage against its Critiqs Cloud plan, for its owner; null when the backend has no plans. */
  useUsage(projectId: string | null): QueryState<ProjectUsage | null>;
  setNotificationSettings(args: { projectId: string; mentionEmails?: boolean; replyEmails?: boolean; projectMuted?: boolean }): Promise<void>;

  /** Updates the backend's record of the signed-in reviewer from their sign-in; returns the name it now shows. */
  syncReviewer(): Promise<string>;
  /**
   * Creates a project; `reviewUrl` is where mention emails link, usually the
   * page setup ran on. `organizationId` puts it in one of the reviewer's
   * organizations instead of their home one (backends reporting `organizationMembers`).
   */
  createProject(name: string, reviewUrl: string | null, organizationId?: string): Promise<string>;
  setReviewUrl(args: { projectId: string; reviewUrl: string }): Promise<void>;
  /** Sets who can review the project, for its owners; on backends whose projects report `reviewAccess`. */
  setReviewAccess(args: { projectId: string; reviewAccess: ReviewAccess }): Promise<void>;
  /**
   * Records that the signed-in reviewer opened the project through this
   * install, so the browser extension's project lookup finds it for them; on
   * backends whose configuration reports `addressLists`.
   */
  recordProjectOpened(projectId: string): Promise<void>;
  /**
   * The project's address list, which the browser extension finds it by, for
   * its owners; on backends whose configuration reports `addressLists`.
   */
  useProjectAddresses(projectId: string | null): QueryState<string[]>;
  /** The addresses in the project's list that match no site now, with what to do, for its owners; on backends that report `addressNotes`. */
  useProjectAddressNotes(projectId: string | null): QueryState<AddressNote[]>;
  /** Adds one address or pattern to the project's list, for its owners; returns the list. On backends that report `addressEdits`. */
  addProjectAddress(args: { projectId: string; address: string }): Promise<string[]>;
  /** Removes one address from the project's list, for its owners; returns the list. On backends that report `addressEdits`. */
  removeProjectAddress(args: { projectId: string; address: string }): Promise<string[]>;
  /** Sets how many Critiqs AI credits past the plan's an organization may use each month, null for no cap, or `default` for the plan's; for its admins, on backends whose configuration reports `overageCap`. */
  setOverageCap(args: { organizationId: string; cap: number | null | "default" }): Promise<void>;
  /** Uploads an image for a new thread or a supplied screenshot; returns its file ID. */
  uploadImage(projectId: string, image: Blob): Promise<string>;
  createThread(thread: NewThread): Promise<string>;
  reply(args: { threadId: string; body: string; revision: Revision; mentions: NewMention[] }): Promise<string>;
  editMessage(args: { messageId: string; body: string; mentions: NewMention[] }): Promise<void>;
  toggleReaction(args: { messageId: string; emoji: string }): Promise<void>;
  setStatus(args: { threadId: string; status: "open" | "resolved" }): Promise<void>;
  remove(threadId: string): Promise<void>;
  setTags(args: { threadId: string; tags: string[] }): Promise<void>;
  reattach(args: { threadId: string; location: TargetLocation }): Promise<void>;
  attachScreenshot(args: { threadId: string; fileId: string }): Promise<void>;
  markRead(args: { threadId: string; seenThrough: number }): Promise<void>;
  markUnread(threadId: string): Promise<void>;
  /**
   * The key of the thread's page on the Critiqs website, for **Copy link**;
   * a thread older than thread pages gets one the first time. Only on
   * backends that report `threadPages`.
   */
  threadPageKey(threadId: string): Promise<string>;
  /** Selected threads with their whole discussions; never a partial collection. */
  exportThreads(projectId: string, threadIds: string[], cancelled: () => boolean): Promise<ExportData>;
  /** A thread's protected image, after the same access checks as reading the thread. */
  loadCapture(threadId: string): Promise<Blob | null>;

  /** The project's tags, presets and free, most recently used first, and its shared tag groups. */
  useTags(projectId: string | null): QueryState<ProjectTags>;
  createTagGroup(args: { projectId: string; name: string }): Promise<string>;
  renameTagGroup(args: { projectId: string; groupId: string; name: string }): Promise<void>;
  deleteTagGroup(args: { projectId: string; groupId: string }): Promise<void>;
  mergeTagGroups(args: { projectId: string; groupId: string; intoGroupId: string }): Promise<void>;
  /** Sets a tag's groups (final, never changed automatically), or hands it back to automatic grouping. */
  setTagGroups(args: { projectId: string; tag: string; groupIds: string[]; automatic?: boolean }): Promise<void>;
  /**
   * Sets the project's preset tags, in order. `previous` is the list being
   * edited; the backend refuses the change when the presets changed since.
   */
  setPresetTags(args: { projectId: string; tags: string[]; previous: string[] }): Promise<void>;
  /** Searches the project's feedback in plain language; basic word and tag search when AI isn't available. */
  search(args: { projectId: string; question: string; scope: SearchScope }): Promise<SearchResponse>;
  /** The project's AI settings, for its owner. */
  useAiSettings(projectId: string | null): QueryState<AiSettingsView>;
  saveAiSettings(input: AiSettingsInput): Promise<AiSettingsView>;
  /** Tests the saved connection, or a draft before saving it. */
  testAiConnection(projectId: string, draft?: AiSettingsInput): Promise<AiTestResult>;
  /**
   * The signed-in person's own AI settings ("Your AI"), on backends whose
   * configuration reports `personalAi`; the interface asks for them only there.
   */
  usePersonalAiSettings(enabled: boolean): QueryState<PersonalAiSettingsView>;
  savePersonalAiSettings(input: PersonalAiSettingsInput): Promise<PersonalAiSettingsView>;
  /** Tests the person's saved connection, or a draft before saving it. */
  testPersonalAiConnection(draft?: PersonalAiSettingsInput): Promise<AiTestResult>;
  /** Removes the person's own settings and key. */
  removePersonalAiSettings(): Promise<PersonalAiSettingsView>;
  /**
   * The person's own Critiqs AI credits used against their plan, today and
   * this month as the plan limits them; null on a deployment without plans.
   * Asked for only on backends that report `personalAi`; an error, as from a
   * backend from before this call, shows no usage.
   */
  usePersonalAiUsage(enabled: boolean): QueryState<PersonalAiUsage | null>;
  /**
   * The models the project's provider offers, for its owner: the saved
   * provider's, or a draft's, whose typed key is used only for this request.
   * Only on backends whose configuration reports `modelLists`.
   */
  listAiModels(projectId: string, draft?: AiModelListDraft): Promise<AiModelListResult>;
  /** The models the person's own provider offers, saved or drafted, on backends that report `modelLists`. */
  listPersonalAiModels(draft?: AiModelListDraft): Promise<AiModelListResult>;
  /**
   * Which connection the signed-in person's requests in the project use and
   * the models they may choose among; null skips it, as on backends that
   * don't report `modelLists`.
   */
  useAiChoice(projectId: string | null): QueryState<AiChoiceView>;
  /**
   * Mockup mode's backend, on backends that store mockups (Convex). The
   * interface offers Mockup mode only when this is present and the backend's
   * configuration reports `mockups`.
   */
  mockups?: MockupTransport;
  /**
   * Paying for Critiqs Cloud plans, on backends that take payment (Convex).
   * Offer it only when this is present and the backend's configuration
   * reports `billing`. Changes return a Stripe page to open, or null when
   * nothing more is needed; while one is in progress, another is refused.
   */
  billing?: BillingTransport;
  /**
   * Tickets' backend, on backends that store tickets (Convex). The interface
   * offers Your trackers only when this is present and the backend's
   * configuration reports `tickets`.
   */
  tickets?: TicketTransport;
}

/** An organization's plan and payment: members see it, admins change it; see `CritiqsTransport.billing`. */
export interface BillingTransport {
  /** The organization's plan and subscription, for its members; null skips it. */
  useStatus(organizationId: string | null): QueryState<BillingStatus | null>;
  /** What the organization's plan limits for the whole organization, with usage so far, for its members; null skips it. */
  useUsage(organizationId: string | null): QueryState<OrganizationUsage | null>;
  /**
   * Moves the organization to a plan from `from`, the plan its status
   * showed as billed; refused when another is billed now. With nothing
   * billed, returns Stripe Checkout, which sends the person back to
   * `returnUrl` (https, or http on localhost).
   * With a card on file, moving up is charged at once and moving down waits
   * for the end of the period; Free cancels at the end of the period.
   */
  changePlan(args: { organizationId: string; from: BillingPlan; plan: BillingPlan; returnUrl: string }): Promise<BillingChange>;
  /** Buys one of Pro's storage add-ons when none renews, or cancels one that renews at the end of the period. */
  setStorageAddOn(args: { organizationId: string; enabled: boolean; returnUrl: string }): Promise<BillingChange>;
  /** Stripe's page for the organization's payment method and invoices. */
  openPortal(args: { organizationId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Asks the backend to read plan prices when status has none yet; status updates when they arrive. */
  loadPrices(): Promise<void>;
}

/** Each person's own tracker accounts (Your trackers). Tokens go to the backend once and never come back. */
export interface TicketTransport {
  /** The signed-in person's tracker accounts; skipped while `enabled` is false. */
  useTrackerAccounts(enabled: boolean): QueryState<TrackerAccountView[]>;
  /** Connects a tracker with a personal token the person pasted, after the tracker confirms whose it is. */
  connectTrackerWithToken(tracker: TrackerId, token: string): Promise<TrackerAccountView>;
  /**
   * Starts the tracker's sign-in; returns where the sign-in window posts the
   * state and binding secret, which only this caller gets. The account appears
   * in `useTrackerAccounts` once it finishes.
   */
  startTrackerSignIn(tracker: TrackerId): Promise<TrackerSignInStart>;
  /** Removes the person's account for the tracker, ends Critiqs's access there where it can, and says what it did there. */
  disconnectTracker(tracker: TrackerId): Promise<TrackerDisconnected>;
  /** Whether the person's new tickets in the tracker say they came from Critiqs, by default. */
  setTrackerAttribution(tracker: TrackerId, on: boolean): Promise<void>;
}

/** A page copy's layout as frozen, with its uploaded file. */
export interface NewSnapshot {
  storageId: string;
  width: number;
  height: number;
  scrollY: number;
  viewportHeight: number;
  capturedAt: number;
}

/** What Critiqs AI's turn in a mockup thread returned. */
export interface MockupReply {
  messageId: string;
  /** The version its changes made, or null when it only answered. */
  version: number | null;
  /** Its request reaches past what it was shown, so the rest of the page should be described next. */
  remaining: boolean;
}

/**
 * Mockups: page copies, their versions, and their threads. Mockup threads are
 * created and answered with `createThread` (with `mockup`) and `reply`, then
 * `mockupReply` asks Critiqs AI to answer.
 */
export interface MockupTransport {
  /** One screen's mockups with threads, or every other screen's, most recently active first, `initialNumItems` at first. */
  useMockupPage(projectId: string | null, scope: MockupListScope, initialNumItems: number): PagedList<MockupSummary>;
  /** A mockup with its copies, linked threads, and versions, oldest first. */
  useMockup(mockupId: string | null): QueryState<MockupDetail>;
  /** Mockups an existing thread is linked to. */
  useMockupsForThread(threadId: string): QueryState<{ _id: string; title: string }[]>;
  /** A mockup as it is now, read once. */
  getMockup(mockupId: string): Promise<MockupDetail>;
  /** Uploads a page copy's HTML; returns its file ID for `create` or `addSnapshot`. */
  uploadSnapshot(projectId: string, html: string): Promise<string>;
  /** Starts a mockup from an uploaded copy, linking existing threads in the same step; returns it and its first copy. */
  create(args: {
    projectId: string;
    title: string;
    source: MockupSource;
    snapshot: NewSnapshot;
    linkedThreadIds?: string[];
  }): Promise<{ mockupId: string; snapshotId: string }>;
  /** Adds a copy at another width; returns its ID. */
  addSnapshot(args: { mockupId: string; snapshot: NewSnapshot }): Promise<string>;
  /** A copy's HTML, after the same access checks as reading its mockup. Kept in memory once loaded. */
  loadSnapshot(snapshotId: string): Promise<string>;
  /** Adds an existing thread to the mockup as instructions. */
  link(args: { mockupId: string; threadId: string }): Promise<void>;
  unlink(args: { mockupId: string; threadId: string }): Promise<void>;
  remove(mockupId: string): Promise<void>;
  /** Saves version `number` (0: the original copies) as a new version, unless the latest is no longer `expectedHead`. */
  restore(args: { mockupId: string; number: number; expectedHead: number }): Promise<number>;
  /** Critiqs AI's answer to the thread's latest message, from descriptions of the copies it should change. */
  mockupReply(args: {
    threadId: string;
    snapshots: { snapshotId: string; description: string; complete: boolean }[];
    continuation: boolean;
    /** One of the models `useAiChoice` offers; without it, the connection's default. */
    model?: string;
  }): Promise<MockupReply>;
}

export const TransportContext = createContext<CritiqsTransport | null>(null);

export function useTransport(): CritiqsTransport {
  const transport = useContext(TransportContext);
  if (transport === null) throw new Error("Critiqs's interface needs a backend transport.");
  return transport;
}

/** An error a backend reported with one of Critiqs's error codes. */
export class CritiqsRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Describes any backend error with Critiqs's code and explanation when there is one. */
export function describeError(error: unknown): { status: "error"; code: string; message: string } {
  if (error instanceof CritiqsRequestError) return { status: "error", code: error.code, message: error.message };
  // The prototype's page, when Critiqs runs beside it rather than in it.
  if (error instanceof PageLayerError) {
    const message =
      error.code === "failed"
        ? error.message
        : error.code === "cancelled"
          ? "The prototype changed pages before this finished. Try again."
          : "The prototype's page didn't answer. Check that it is still open with Critiqs on it, then try again.";
    return { status: "error", code: `page-${error.code}`, message };
  }
  // Convex reports Critiqs's errors as structured data on the error.
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const { code, message } = data as { code?: string; message?: string };
    return { status: "error", code: code ?? "error", message: message ?? "Something went wrong." };
  }
  if (error instanceof Error && /ArgumentValidationError|Invalid argument|not a valid ID/i.test(error.message)) {
    return { status: "error", code: "not-found", message: "This item does not exist." };
  }
  return { status: "error", code: "error", message: "Something went wrong. Try again." };
}

/** Message for a failed change, using Critiqs's own explanation when there is one. */
export function errorMessage(error: unknown): string {
  return describeError(error).message;
}
