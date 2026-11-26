import type {
  AiChoiceView,
  TrackerDisconnected,
  BillingChange,
  BillingPlan,
  BillingStatus,
  AiModelListDraft,
  AiModelListResult,
  AiSettingsInput,
  AiSettingsView,
  AiTestResult,
  ExportPage,
  MockupDetail,
  MockupSummary,
  NotificationSettings,
  OrganizationDetails,
  OrganizationSummary,
  OrganizationUsage,
  ParticipantInfo,
  PersonalAiSettingsInput,
  PersonalAiSettingsView,
  PersonalAiUsage,
  ProjectInfo,
  ProjectTags,
  ProjectUsage,
  SearchResponse,
  SearchScope,
  ThreadDetail,
  ThreadSummary,
  NewTicket,
  TicketDestination,
  TicketDraft,
  TicketDraftFormat,
  TicketDraftOptions,
  TicketTemplateSettings,
  TrackerTemplateGroup,
  AiTicketDraft,
  AiTicketDraftInput,
  TicketLinkInput,
  TicketLinkView,
  TicketSearchResult,
  TicketSettingsView,
  TrackerAccountView,
  TrackerId,
  TrackerSignInStart,
} from "@critiqs/core";
import { type ReactNode, useState } from "react";
import type { BillingTransport, CritiqsTransport, InviteAnswer, MockupReply, MockupTransport, PagedList, QueryState, TicketTransport } from "../src/transport.ts";
import { loadExport, type MockupListScope } from "@critiqs/core";

/** Data a fake backend serves; `undefined` means still loading. Tests may change it between renders. */
export interface FakeBackend {
  /** Whether the backend currently accepts the reviewer's sign-in; defaults to true. */
  authenticated?: boolean;
  /** Whether the backend is still checking the sign-in, as while re-authenticating. */
  authLoading?: boolean;
  /** Whether the backend checked the token and refused it; otherwise an unaccepted sign-in is temporary. */
  rejected?: boolean;
  project: ProjectInfo | undefined;
  /** The message the backend refuses a preset tag change with. */
  presetError?: string;
  /** The backend's refusal of the project, such as to someone outside an organization it's limited to. */
  projectError?: { code: string; message: string };
  /** Saves who can review the project; resolves by default. */
  setReviewAccess?: (args: { projectId: string; reviewAccess: "anyone" | "organization" }) => Promise<void>;
  threads: ThreadSummary[] | undefined;
  thread?: ThreadDetail;
  /** Discussions by thread ID, where tests open more than one; others get `thread`. */
  threadDetails?: Record<string, ThreadDetail>;
  /** A backend that stores mockups; none by default, as on the embedded server. */
  mockups?: FakeMockups;
  exportPage?: () => Promise<ExportPage>;
  reply?: (args: { threadId: string; body: string; mentions: { userId: string; label: string }[] }) => Promise<string>;
  /** Deleting a thread; without it, deleting succeeds. */
  removeThread?: (threadId: string) => Promise<void>;
  /** A thread's page key, for Share on a backend with thread pages; without it, the call is refused as on an older backend. */
  threadPageKey?: (threadId: string) => Promise<string>;
  /** Mention suggestions; as a function, by the thread they are asked for (null: a new thread). */
  participants?: ParticipantInfo[] | ((threadId: string | null) => ParticipantInfo[]);
  /** The project's address list, for its owners. */
  addresses?: string[];
  /** The list's addresses that match no site now, with what to do. */
  addressNotes?: { address: string; note: string }[];
  /** The backend's refusal to show the list. */
  addressesError?: { code: string; message: string };
  /** Answers adding or removing an address in place of the default, which changes `addresses`. */
  changeAddresses?: (change: "add" | "remove", address: string) => Promise<string[]>;
  /** Plan usage shown to the project's owner; none by default, as on a backend without plans. */
  usage?: ProjectUsage | null;
  /** The project's tags and groups; none by default. */
  tags?: ProjectTags;
  search?: (args: { projectId: string; question: string; scope: SearchScope }) => Promise<SearchResponse>;
  aiSettings?: AiSettingsView;
  saveAiSettings?: (input: AiSettingsInput) => Promise<AiSettingsView>;
  testAiConnection?: (projectId: string, draft?: AiSettingsInput) => Promise<AiTestResult>;
  /** The signed-in person's own AI settings (Your AI); `undefined` means still loading. */
  personalAiSettings?: PersonalAiSettingsView;
  savePersonalAiSettings?: (input: PersonalAiSettingsInput) => Promise<PersonalAiSettingsView>;
  testPersonalAiConnection?: (draft?: PersonalAiSettingsInput) => Promise<AiTestResult>;
  removePersonalAiSettings?: () => Promise<PersonalAiSettingsView>;
  /** The reviewer's own Critiqs AI usage; null without plans, `"missing"` as from a backend without the call. */
  personalAiUsage?: PersonalAiUsage | null | "missing";
  /** A provider's model list, for a project's settings or Your AI. */
  listAiModels?: (draft?: AiModelListDraft) => Promise<AiModelListResult>;
  /** Which connection the reviewer's requests use, and its models; `undefined` means still loading. */
  aiChoice?: AiChoiceView;
  /** Why the connection's models couldn't load; set, `aiChoice` is ignored. */
  aiChoiceError?: string;
  /** The reviewer's email choices; mention emails on and nothing muted by default, as from a backend without reply emails. */
  notificationSettings?: NotificationSettings;
  /** The reviewer's organizations; none by default. */
  organizations?: OrganizationSummary[];
  /** Organizations' details by ID; a missing one is still loading, and one the reviewer isn't in is refused. */
  organizationDetails?: Record<string, OrganizationDetails>;
  /** Answers an organization change by name, such as `inviteMember`; each succeeds by default, and an invite is sent. */
  organizationChange?: (name: string, args: unknown) => Promise<unknown>;
  /** A backend that takes payment; none by default, as on every backend but Critiqs Cloud. */
  billing?: FakeBilling;
  /** A backend that stores tickets, with the reviewer's tracker accounts; none by default, as on the embedded server. */
  trackers?: FakeTrackers;
  /** Changes the interface asked for, by name, for assertions. */
  calls?: { name: string; args: unknown }[];
}

/** The reviewer's tracker accounts a fake backend keeps; `undefined` means still loading. */
export interface FakeTrackers {
  accounts: TrackerAccountView[] | undefined;
  /** Answers a pasted token; by default it connects as Dana Smith in Acme. */
  connect?: (tracker: TrackerId, token: string) => Promise<TrackerAccountView>;
  /** The started sign-in; by default one on the backend. */
  signIn?: () => Promise<TrackerSignInStart>;
  /** What disconnecting did at the tracker; by default it ended a sign-in there and kept a pasted token. */
  disconnected?: TrackerDisconnected;
  /** Where tickets go; by default two Linear teams. */
  destinations?: (tracker: TrackerId) => Promise<TicketDestination[]>;
  /** Search results; by default none. */
  search?: (tracker: TrackerId, query: string) => Promise<TicketSearchResult[]>;
  /** A thread's draft, in the format asked for; by default a short one, attribution on, or a template's when one is named. */
  draft?: (threadId: string, tracker: TrackerId, format?: TicketDraftFormat) => Promise<TicketDraft>;
  /** What the Create dialog offers for a destination; by default nothing. */
  options?: (destinationId: string) => Promise<TicketDraftOptions>;
  /** Answers drafting with Critiqs AI; by default a short drafted one. */
  aiDraft?: (input: AiTicketDraftInput) => Promise<AiTicketDraft>;
  /** The project's ticket templates; by default off. */
  templateSettings?: TicketTemplateSettings;
  /** The owner's teams' templates, by tracker; by default two teams' worth. */
  trackerTemplates?: (tracker: TrackerId) => Promise<TrackerTemplateGroup[]>;
  /** Answers creating a ticket; by default ENG-1 in Triage. */
  create?: (input: NewTicket) => Promise<TicketLinkView>;
  /** Answers linking a ticket; by default the chosen ticket, linked. */
  link?: (input: TicketLinkInput) => Promise<TicketLinkView>;
  /** Answers adding a ticket's link back; by default the ticket, with its link back. */
  addLinkBack?: (linkId: string) => Promise<TicketLinkView>;
  /** Projects' ticket settings, by project ID; by default Resolve when done off. */
  settings?: Record<string, TicketSettingsView>;
  /** Answers turning Resolve when done on or off; by default it saves. */
  setResolveWhenDone?: (projectId: string, on: boolean) => Promise<void>;
}

/** A linked ticket as a fake backend answers it. */
export function fakeTicketView(changes: Partial<TicketLinkView> = {}): TicketLinkView {
  return {
    _id: "link-1",
    threadId: "thread",
    tracker: "linear",
    externalId: "issue-1",
    key: "ENG-1",
    url: "https://linear.app/acme/issue/eng-1",
    title: "Department is wrong",
    status: { label: "Triage", category: "open" },
    statusCheckedAt: 1,
    createdFromCritiqs: true,
    linkedByName: "Dana",
    linkedAt: 1,
    canUnlink: true,
    canAddLinkBack: false,
    ...changes,
  };
}

/** An in-memory transport, so interface tests need no backend client. */
export function fakeTransport(backend: FakeBackend): CritiqsTransport {
  const ready = <T,>(data: T | undefined) =>
    data === undefined ? ({ status: "loading" } as const) : ({ status: "ready", data } as const);
  const none = async () => undefined;
  const organizationChange = async (name: string, args: unknown) => {
    backend.calls?.push({ name, args });
    return await backend.organizationChange?.(name, args);
  };
  return {
    wrap: (children: ReactNode) => children,
    useAuth: () => ({
      isLoading: backend.authLoading ?? false,
      isAuthenticated: backend.authenticated ?? true,
      rejected: backend.rejected ?? false,
    }),
    useProject: (projectId) =>
      projectId === null ? { status: "loading" } : backend.projectError !== undefined ? { status: "error", ...backend.projectError } : ready(backend.project),
    useMyProjects: () => ready(backend.project === undefined ? undefined : [backend.project]),
    useMyOrganizations: (enabled) => (enabled ? ready(backend.organizations ?? []) : { status: "loading" }),
    useOrganization: (organizationId) =>
      organizationId === null
        ? { status: "loading" }
        : (backend.organizations ?? []).some((organization) => organization.id === organizationId)
          ? ready(backend.organizationDetails?.[organizationId])
          : { status: "error", code: "not-found", message: "This organization doesn't exist, or you aren't in it." },
    renameOrganization: (organizationId, name) => organizationChange("renameOrganization", { organizationId, name }).then(() => undefined),
    inviteMember: async (args) => ((await organizationChange("inviteMember", args)) ?? { status: "invited", email: "sent" }) as InviteAnswer,
    revokeInvite: (inviteId) => organizationChange("revokeInvite", { inviteId }).then(() => undefined),
    setMemberRole: (args) => organizationChange("setMemberRole", args).then(() => undefined),
    removeMember: (args) => organizationChange("removeMember", args).then(() => undefined),
    useThreads: (projectId) => (projectId === null ? { status: "loading" } : ready(backend.threads)),
    useThread: (threadId) => ready(backend.threadDetails?.[threadId] ?? backend.thread),
    useParticipants: (projectId, query, threadId = null) =>
      projectId === null
        ? { status: "loading" }
        : ready(
            (typeof backend.participants === "function" ? backend.participants(threadId) : (backend.participants ?? [])).filter((person) =>
              person.name.toLowerCase().includes(query.toLowerCase()),
            ),
          ),
    useNotificationSettings: () => ready(backend.notificationSettings ?? { mentionEmails: true, projectMuted: false }),
    useUsage: (projectId) => (projectId === null ? { status: "loading" } : ready(backend.usage ?? null)),
    setNotificationSettings: async (args) => void backend.calls?.push({ name: "setNotificationSettings", args }),
    setReviewUrl: async (args) => void backend.calls?.push({ name: "setReviewUrl", args }),
    setReviewAccess: async (args) => {
      backend.calls?.push({ name: "setReviewAccess", args });
      if (backend.setReviewAccess !== undefined) await backend.setReviewAccess(args);
    },
    recordProjectOpened: async (projectId) => void backend.calls?.push({ name: "recordProjectOpened", args: { projectId } }),
    useProjectAddresses: (projectId) => (projectId === null ? { status: "loading" } : backend.addressesError !== undefined ? { status: "error", ...backend.addressesError } : ready(backend.addresses ?? [])),
    useProjectAddressNotes: (projectId) => (projectId === null ? { status: "loading" } : ready(backend.addressNotes ?? [])),
    addProjectAddress: async (args) => {
      backend.calls?.push({ name: "addProjectAddress", args });
      if (backend.changeAddresses !== undefined) return await backend.changeAddresses("add", args.address);
      backend.addresses = [...(backend.addresses ?? []), args.address];
      return backend.addresses;
    },
    removeProjectAddress: async (args) => {
      backend.calls?.push({ name: "removeProjectAddress", args });
      if (backend.changeAddresses !== undefined) return await backend.changeAddresses("remove", args.address);
      backend.addresses = (backend.addresses ?? []).filter((address) => address !== args.address);
      return backend.addresses;
    },
    setOverageCap: async (args) => void backend.calls?.push({ name: "setOverageCap", args }),
    syncReviewer: async () => "Dana",
    createProject: async (name, reviewUrl, organizationId) => {
      backend.calls?.push({ name: "createProject", args: organizationId === undefined ? { name, reviewUrl } : { name, reviewUrl, organizationId } });
      return "project";
    },
    uploadImage: async () => "file",
    createThread: async (args) => {
      backend.calls?.push({ name: "createThread", args });
      return "thread";
    },
    reply: (args) => backend.reply?.(args) ?? Promise.resolve("message"),
    editMessage: none,
    toggleReaction: none,
    setStatus: none,
    remove: async (threadId) => await backend.removeThread?.(threadId),
    setTags: none,
    reattach: none,
    attachScreenshot: none,
    markRead: async (args) => void backend.calls?.push({ name: "markRead", args }),
    markUnread: none,
    threadPageKey: async (threadId) => {
      backend.calls?.push({ name: "threadPageKey", args: { threadId } });
      if (backend.threadPageKey === undefined) throw new Error("Could not find public function for 'threads:pageKey'.");
      return await backend.threadPageKey(threadId);
    },
    exportThreads: (projectId, threadIds, cancelled) =>
      loadExport(() => backend.exportPage?.() ?? Promise.reject(new Error("No export")), projectId, threadIds, cancelled),
    loadCapture: async () => null,
    useTags: (projectId) => (projectId === null ? { status: "loading" } : ready(backend.tags ?? { tags: [], groups: [], canOrganize: false })),
    createTagGroup: async (args) => {
      backend.calls?.push({ name: "createTagGroup", args });
      return "group";
    },
    renameTagGroup: async (args) => void backend.calls?.push({ name: "renameTagGroup", args }),
    deleteTagGroup: async (args) => void backend.calls?.push({ name: "deleteTagGroup", args }),
    mergeTagGroups: async (args) => void backend.calls?.push({ name: "mergeTagGroups", args }),
    setTagGroups: async (args) => void backend.calls?.push({ name: "setTagGroups", args }),
    // Saved presets are what the project reads next, as from a live backend; `presetError` refuses the change.
    setPresetTags: async (args) => {
      backend.calls?.push({ name: "setPresetTags", args });
      if (backend.presetError !== undefined) {
        const { ConvexError } = await import("convex/values");
        throw new ConvexError({ code: "invalid", message: backend.presetError });
      }
      if (backend.project !== undefined) backend.project = { ...backend.project, tags: args.tags };
    },
    search: (args) => backend.search?.(args) ?? Promise.reject(new Error("No search")),
    useAiSettings: (projectId) => (projectId === null ? { status: "loading" } : ready(backend.aiSettings)),
    saveAiSettings: (input) => {
      backend.calls?.push({ name: "saveAiSettings", args: input });
      return backend.saveAiSettings?.(input) ?? Promise.reject(new Error("No settings"));
    },
    testAiConnection: (projectId, draft) => backend.testAiConnection?.(projectId, draft) ?? Promise.resolve({ ok: true, message: "Connected" }),
    usePersonalAiSettings: (enabled) => (enabled ? ready(backend.personalAiSettings) : { status: "loading" }),
    // Saved settings are what the settings read next, as from a live backend.
    savePersonalAiSettings: async (input) => {
      backend.calls?.push({ name: "savePersonalAiSettings", args: input });
      if (backend.savePersonalAiSettings === undefined) throw new Error("No settings");
      return (backend.personalAiSettings = await backend.savePersonalAiSettings(input));
    },
    usePersonalAiUsage: (enabled) => {
      if (!enabled) return { status: "loading" };
      if (backend.personalAiUsage === "missing") return { status: "error", code: "error", message: "Could not find public function for 'aiSettings:myUsage'." };
      return ready(backend.personalAiUsage ?? null);
    },
    testPersonalAiConnection: (draft) => {
      backend.calls?.push({ name: "testPersonalAiConnection", args: draft });
      return backend.testPersonalAiConnection?.(draft) ?? Promise.resolve({ ok: true, message: "Connected" });
    },
    removePersonalAiSettings: async () => {
      backend.calls?.push({ name: "removePersonalAiSettings", args: {} });
      if (backend.removePersonalAiSettings === undefined) throw new Error("No settings");
      return (backend.personalAiSettings = await backend.removePersonalAiSettings());
    },
    listAiModels: (projectId, draft) => {
      backend.calls?.push({ name: "listAiModels", args: { projectId, draft } });
      return backend.listAiModels?.(draft) ?? Promise.reject(new Error("No model list"));
    },
    listPersonalAiModels: (draft) => {
      backend.calls?.push({ name: "listPersonalAiModels", args: { draft } });
      return backend.listAiModels?.(draft) ?? Promise.reject(new Error("No model list"));
    },
    useAiChoice: (projectId) =>
      projectId === null ? { status: "loading" } : backend.aiChoiceError !== undefined ? { status: "error", code: "unavailable", message: backend.aiChoiceError } : ready(backend.aiChoice),
    ...(backend.billing === undefined ? {} : { billing: fakeBilling(backend.billing, (name, args) => backend.calls?.push({ name, args })) }),
    ...(backend.mockups === undefined ? {} : { mockups: fakeMockups(backend.mockups, (name, args) => backend.calls?.push({ name, args })) }),
    ...(backend.trackers === undefined ? {} : { tickets: fakeTickets(backend.trackers, (name, args) => backend.calls?.push({ name, args })) }),
  };
}

/** Your trackers' backend over a fake's accounts; changes apply to `trackers.accounts`, shown after the next render. */
function fakeTickets(trackers: FakeTrackers, record: (name: string, args: unknown) => void): TicketTransport {
  const replace = (account: TrackerAccountView) => (trackers.accounts = [...(trackers.accounts ?? []).filter((each) => each.tracker !== account.tracker), account]);
  return {
    useTrackerAccounts: (enabled) => (enabled && trackers.accounts !== undefined ? { status: "ready", data: trackers.accounts } : { status: "loading" }),
    connectTrackerWithToken: async (tracker, token, site) => {
      record("connectTrackerWithToken", { tracker, token, ...site });
      const account = trackers.connect
        ? await trackers.connect(tracker, token)
        : { tracker, method: "token" as const, accountName: "Dana Smith", site: "Acme", connectedAt: 1, attribution: true };
      replace(account);
      return account;
    },
    startTrackerSignIn: async (tracker, site) => {
      record("startTrackerSignIn", { tracker, ...(site === undefined ? {} : { site }) });
      return (await trackers.signIn?.()) ?? { url: `https://backend.convex.site/trackers/${tracker}/start`, state: "s1", binding: "secret-1" };
    },
    disconnectTracker: async (tracker) => {
      record("disconnectTracker", { tracker });
      const account = (trackers.accounts ?? []).find((each) => each.tracker === tracker);
      trackers.accounts = (trackers.accounts ?? []).filter((each) => each.tracker !== tracker);
      return trackers.disconnected ?? (account === undefined ? "none" : account.method === "oauth" ? "ended" : "kept");
    },
    setTrackerAttribution: async (tracker, on) => {
      record("setTrackerAttribution", { tracker, on });
      trackers.accounts = (trackers.accounts ?? []).map((each) => (each.tracker === tracker ? { ...each, attribution: on } : each));
    },
    listTicketDestinations: async (tracker) =>
      (await trackers.destinations?.(tracker)) ?? [
        { id: "team-des", name: "Design", key: "DES" },
        { id: "team-eng", name: "Engineering", key: "ENG" },
      ],
    searchTickets: async (tracker, query) => {
      record("searchTickets", { tracker, query });
      return (await trackers.search?.(tracker, query)) ?? [];
    },
    ticketDraft: async (threadId, tracker, format) => {
      record("ticketDraft", { threadId, tracker, ...format });
      return (
        (await trackers.draft?.(threadId, tracker, format)) ?? {
          title: "Department is wrong",
          body: format?.templateId == null ? "> Department is wrong\n" : `## Summary\n\n> Department is wrong\n\n## Steps (${format.templateId})\n`,
          createdFromCritiqs: true,
          resumeSubmissionId: null,
        }
      );
    },
    ticketDraftOptions: async (threadId, tracker, destinationId) => {
      record("ticketDraftOptions", { threadId, tracker, destinationId });
      return (await trackers.options?.(destinationId)) ?? { templates: [], labels: [] };
    },
    draftTicketWithAi: async (input) => {
      record("draftTicketWithAi", input);
      return (await trackers.aiDraft?.(input)) ?? { title: "Department shows the wrong team", body: "Drafted by AI\n", drafted: "ai", notice: null };
    },
    useTicketTemplateSettings: (projectId) => (projectId === null ? { status: "loading" } : { status: "ready", data: trackers.templateSettings ?? { on: false, templates: [] } }),
    saveTicketTemplateSettings: async (projectId, settings) => {
      record("saveTicketTemplateSettings", { projectId, ...settings });
      trackers.templateSettings = settings;
      return settings;
    },
    listTrackerTemplates: async (projectId, tracker) => {
      record("listTrackerTemplates", { projectId, tracker });
      return (
        (await trackers.trackerTemplates?.(tracker)) ?? [
          { destination: { id: "team-des", name: "Design", key: "DES" }, templates: [{ id: "tpl-copy", name: "Copy change" }] },
          {
            destination: { id: "team-eng", name: "Engineering", key: "ENG" },
            templates: [
              { id: "tpl-bug", name: "Bug report" },
              { id: "tpl-feature", name: "Feature request" },
            ],
          },
        ]
      );
    },
    createTicket: async (input) => {
      record("createTicket", input);
      return (await trackers.create?.(input)) ?? fakeTicketView({ threadId: input.threadId });
    },
    linkTicket: async (input) => {
      record("linkTicket", input);
      return (await trackers.link?.(input)) ?? fakeTicketView({ threadId: input.threadId, createdFromCritiqs: false });
    },
    addTicketLinkBack: async (linkId) => {
      record("addTicketLinkBack", { linkId });
      return (await trackers.addLinkBack?.(linkId)) ?? fakeTicketView({ _id: linkId });
    },
    unlinkTicket: async (linkId) => {
      record("unlinkTicket", { linkId });
    },
    checkTicketStatus: async (threadId) => {
      record("checkTicketStatus", { threadId });
    },
    useTicketSettings: (projectId, enabled) => (enabled ? { status: "ready", data: trackers.settings?.[projectId] ?? { resolveWhenDone: false } } : { status: "loading" }),
    setResolveWhenDone: async (projectId, on) => {
      record("setResolveWhenDone", { projectId, on });
      await trackers.setResolveWhenDone?.(projectId, on);
      trackers.settings = { ...trackers.settings, [projectId]: { resolveWhenDone: on } };
    },
  };
}

/** Billing a fake backend serves, by organization ID: a missing entry is still loading, and a string status is the query's error. */
export interface FakeBilling {
  status: Record<string, BillingStatus | string>;
  usage: Record<string, OrganizationUsage | null>;
  /** Each change's answer; nothing more to do by default. */
  changePlan?: (args: { organizationId: string; from: BillingPlan; plan: BillingPlan; returnUrl: string }) => Promise<BillingChange>;
  setStorageAddOn?: (args: { organizationId: string; enabled: boolean; returnUrl: string }) => Promise<BillingChange>;
}

function fakeBilling(data: FakeBilling, record: (name: string, args: unknown) => void): BillingTransport {
  const state = <T,>(value: T | string | undefined): QueryState<T> =>
    value === undefined ? { status: "loading" } : typeof value === "string" ? { status: "error", code: "error", message: value } : { status: "ready", data: value };
  return {
    useStatus: (organizationId) => (organizationId === null ? { status: "loading" } : state(data.status[organizationId])),
    useUsage: (organizationId) => (organizationId === null ? { status: "loading" } : state(data.usage[organizationId])),
    changePlan: async (args) => {
      record("changePlan", args);
      return (await data.changePlan?.(args)) ?? { url: null };
    },
    setStorageAddOn: async (args) => {
      record("setStorageAddOn", args);
      return (await data.setStorageAddOn?.(args)) ?? { url: null };
    },
    openPortal: async (args) => {
      record("openPortal", args);
      return { url: "https://billing.stripe.example/portal" };
    },
    loadPrices: async () => {
      record("loadPrices", {});
    },
  };
}

/** Mockups a fake backend serves. */
export interface FakeMockups {
  /** Every mockup; the list reads one screen's, or every other screen's, a page at a time, most recently active first. */
  list: MockupSummary[];
  detail?: MockupDetail;
  /** Other mockups by ID, for opening more than `detail`. */
  details?: Record<string, MockupDetail>;
  /** Mockups any thread is linked to. */
  forThread?: { _id: string; title: string }[];
  /** The screen whose mockups the list last asked for as this page's. */
  listedFor?: string;
  /** Pages Show more asks for arrive only once this resolves. */
  hold?: Promise<void>;
  /** While true, the list's pages fail, and the list throws as `usePaginatedQuery` does. */
  /** Every part of the list fails, or only the other pages' part. */
  failing?: boolean | "elsewhere";
  /** Every copy's HTML. */
  html?: string;
  mockupReply?: (args: { threadId: string; continuation: boolean; model?: string }) => Promise<MockupReply>;
}

function fakeMockups(data: FakeMockups, record: (name: string, args: unknown) => void): MockupTransport {
  const ready = <T,>(value: T | undefined) =>
    value === undefined ? ({ status: "loading" } as const) : ({ status: "ready", data: value } as const);
  const change = (name: string) => async (args: unknown) => void record(name, args);
  return {
    useMockupPage: (projectId, scope, initialNumItems) => {
      if ("screen" in scope) data.listedFor = scope.screen;
      return useFakeList(data, projectId, scope, initialNumItems);
    },
    useMockup: (mockupId) => (mockupId === null ? { status: "loading" } : ready(data.details?.[mockupId] ?? data.detail)),
    useMockupsForThread: () => ready(data.forThread ?? []),
    getMockup: async (mockupId) => data.details?.[mockupId] ?? data.detail!,
    uploadSnapshot: async (projectId, html) => {
      record("uploadSnapshot", { projectId, html });
      return "storage";
    },
    create: async (args) => {
      record("createMockup", args);
      return { mockupId: "mockup", snapshotId: "copy" };
    },
    addSnapshot: async (args) => {
      record("addSnapshot", args);
      return "copy-2";
    },
    loadSnapshot: async () => data.html ?? "<!DOCTYPE html><html><head></head><body data-critiqs-node=\"1\"></body></html>",
    link: change("link"),
    unlink: change("unlink"),
    remove: change("removeMockup"),
    restore: async (args) => {
      record("restore", args);
      return (data.detail?.versions.length ?? 0) + 1;
    },
    mockupReply: (args) => {
      record("mockupReply", args);
      return data.mockupReply?.(args) ?? Promise.resolve({ messageId: "ai", version: null, remaining: false });
    },
  };
}

/**
 * One part of the mockup list as `usePaginatedQuery` reads it: newest first,
 * a page at a time. A page filled exactly to the end isn't known to be the
 * last, so the list says it's exhausted only once a page comes back short.
 */
function useFakeList(data: FakeMockups, projectId: string | null, scope: MockupListScope, initialNumItems: number): PagedList<MockupSummary> {
  const [asked, setAsked] = useState(initialNumItems);
  const [loading, setLoading] = useState(false);
  if (data.failing === true || (data.failing === "elsewhere" && "otherThan" in scope)) throw new Error("The mockup list couldn't be loaded.");
  if (projectId === null) return { results: [], status: "LoadingFirstPage", loadMore: () => {} };
  const matches = (mockup: MockupSummary) => ("screen" in scope ? mockup.source.screen === scope.screen : mockup.source.screen !== scope.otherThan);
  const listed = data.list.filter((mockup) => mockup.listedAt !== null && matches(mockup)).sort((a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0));
  const results = listed.slice(0, asked);
  if (loading) return { results, status: "LoadingMore", loadMore: () => {} };
  const loadMore = (numItems: number) => {
    const hold = data.hold ?? Promise.resolve();
    setLoading(true);
    void hold.then(() => {
      setAsked((count) => count + numItems);
      setLoading(false);
    });
  };
  return { results, status: listed.length < asked ? "Exhausted" : "CanLoadMore", loadMore };
}
