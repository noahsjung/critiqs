import { api } from "@critiqs/backend/api";
import { loadExport, type Page, type ReactionRow, type ThreadDetail, type ThreadDetailPage } from "@critiqs/core";
import { ConvexProviderWithAuth, type ConvexReactClient, useConvexAuth, usePaginatedQuery } from "convex/react";
import { ConvexError, type GenericId as Id } from "convex/values";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { creditsArg, type Deployment, madeWithArg, mentionThreadArg } from "../deployment.ts";
import { uploadCapture, uploadFile } from "../capture-upload.ts";
import { useUtcDay } from "../hooks.ts";
import type { TokenSession } from "../session.ts";
import type { NewCapture } from "@critiqs/core";
import type { CritiqsTransport, MockupTransport, NewSnapshot, QueryState } from "../transport.ts";
import { useAllPages, useQueryState } from "./queries.ts";

/**
 * Critiqs on Convex: Critiqs Cloud or a team's own deployment. Queries are live
 * subscriptions; changes are Convex mutations; captures are served through the
 * deployment's protected HTTP route.
 */
export function convexTransport(client: ConvexReactClient, deployment: Deployment, session: TokenSession): CritiqsTransport {
  // Whether Convex's latest request for a token got one. Convex reports both a
  // refused token and a missing one as unauthenticated; only the first is a rejection.
  let lastTokenFetched = false;
  const fetchToken = async (args: { forceRefreshToken: boolean }) => {
    const token = await session.fetchAccessToken(args);
    lastTokenFetched = token !== null;
    return token;
  };
  function useSessionAuth() {
    const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    // A new function when the reviewer's name changes makes Convex authenticate
    // again, so the deployment sees the token that carries the new name.
    const name = reviewer?.name;
    const fetchAccessToken = useCallback(
      (args: { forceRefreshToken: boolean }) => fetchToken(args),
      [name],
    );
    return { isLoading: false, isAuthenticated: reviewer !== null, fetchAccessToken };
  }
  const mutation = client.mutation.bind(client);
  /** Runs a change whose result the interface doesn't use. */
  const change = (result: Promise<unknown>) => result.then(() => undefined);
  /** Images just uploaded, by file ID, so a thread refused for its file can upload it again (`retryUpload`). */
  const images = recentUploads<{ projectId: string; image: Blob }>();
  const uploadImage = async (projectId: string, image: Blob) => {
    const uploadUrl = await mutation(api.captures.generateUploadUrl, { projectId: projectId as Id<"projects"> });
    const storageId = await uploadCapture(uploadUrl, deployment.siteUrl, image, () => session.fetchAccessToken({ forceRefreshToken: false }));
    images.set(storageId, { projectId, image });
    return storageId;
  };
  const startThread = (args: Parameters<CritiqsTransport["createThread"]>[0], capture: NewCapture) =>
    mutation(api.threads.create, {
      projectId: args.projectId as Id<"projects">,
      anchor: args.anchor,
      body: args.body,
      tags: args.tags,
      mentions: args.mentions.map(({ userId, label }) => ({ userId: userId as Id<"users">, label })),
      capture: capture.status === "captured" ? { status: "captured", storageId: capture.fileId as Id<"_storage"> | Id<"captureFiles"> } : capture,
      ...madeWithArg(deployment),
      ...(args.mockup === undefined
        ? {}
        : {
            mockup: {
              mockupId: args.mockup.mockupId as Id<"mockups">,
              snapshotId: args.mockup.snapshotId as Id<"mockupSnapshots"> | null,
              node: args.mockup.node,
            },
          }),
    });

  return {
    wrap: (children: ReactNode) => (
      <ConvexProviderWithAuth client={client} useAuth={useSessionAuth}>
        {children}
      </ConvexProviderWithAuth>
    ),
    useAuth: () => {
      const { isLoading, isAuthenticated } = useConvexAuth();
      return { isLoading, isAuthenticated, rejected: !isLoading && !isAuthenticated && lastTokenFetched };
    },
    useProject: (projectId) =>
      useQueryState(api.projects.get, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    useMyProjects: (enabled) => flatten(useAllPages(api.projects.listMine, enabled ? {} : "skip")),
    useMyOrganizations: (enabled) => useQueryState(api.organizations.mine, enabled ? {} : "skip"),
    useOrganization: (organizationId) => useQueryState(api.organizations.get, organizationId === null ? "skip" : { organizationId }),
    renameOrganization: (organizationId, name) => change(mutation(api.organizations.rename, { organizationId, name })),
    inviteMember: (args) => mutation(api.organizations.invite, args),
    revokeInvite: (inviteId) => change(mutation(api.organizations.revokeInvite, { inviteId })),
    setMemberRole: (args) => change(mutation(api.organizations.setRole, args)),
    removeMember: (args) => change(mutation(api.organizations.removeMember, args)),
    useThreads: (projectId) =>
      flatten(useAllPages(api.threads.list, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> })),
    useParticipants: (projectId, query, threadId = null) => {
      const thread = mentionThreadArg(deployment, threadId);
      return useQueryState(
        api.projects.participants,
        projectId === null ? "skip" : { projectId: projectId as Id<"projects">, query, ...(thread.threadId === undefined ? {} : { threadId: thread.threadId as Id<"threads"> }) },
      );
    },
    useNotificationSettings: (projectId) =>
      useQueryState(api.notifications.settings, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    useUsage: (projectId) => {
      const day = useUtcDay();
      return useQueryState(api.projects.usage, projectId === null ? "skip" : { projectId: projectId as Id<"projects">, day, ...creditsArg(deployment) });
    },
    setNotificationSettings: ({ projectId, ...settings }) =>
      change(mutation(api.notifications.setSettings, { projectId: projectId as Id<"projects">, ...settings })),
    useThread: (threadId) => {
      const args = { threadId: threadId as Id<"threads"> };
      return combineThread(useAllPages(api.threads.get, args), useAllPages(api.threads.listReactions, args));
    },

    syncReviewer: () => mutation(api.users.sync, {}),
    createProject: (name, reviewUrl, organizationId) =>
      mutation(api.projects.create, { name, reviewUrl, ...(organizationId === undefined ? {} : { organizationId }) }),
    setReviewUrl: ({ projectId, reviewUrl }) =>
      change(mutation(api.projects.setReviewUrl, { projectId: projectId as Id<"projects">, reviewUrl })),
    setReviewAccess: ({ projectId, reviewAccess }) =>
      change(mutation(api.projects.setReviewAccess, { projectId: projectId as Id<"projects">, reviewAccess })),
    recordProjectOpened: (projectId) => change(mutation(api.projects.recordOpened, { projectId: projectId as Id<"projects"> })),
    useProjectAddresses: (projectId) => useQueryState(api.projects.addresses, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    useProjectAddressNotes: (projectId) => useQueryState(api.projects.addressNotes, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    addProjectAddress: ({ projectId, address }) => mutation(api.projects.addAddress, { projectId: projectId as Id<"projects">, address }),
    removeProjectAddress: ({ projectId, address }) => mutation(api.projects.removeAddress, { projectId: projectId as Id<"projects">, address }),
    setOverageCap: ({ organizationId, cap }) =>
      change(mutation(api.organizations.setOverageCap, { organizationId: organizationId as Id<"organizations">, cap })),
    uploadImage,
    createThread: async (args) => {
      const { capture } = args;
      if (capture.status === "failed") return await startThread(args, capture);
      try {
        return await retryUpload(
          capture.fileId,
          images,
          (fileId) => startThread(args, { status: "captured", fileId }),
          (file) => uploadImage(file.projectId, file.image),
        );
      } finally {
        images.delete(capture.fileId);
      }
    },
    reply: ({ threadId, body, revision, mentions }) =>
      mutation(api.threads.reply, {
        threadId: threadId as Id<"threads">,
        body,
        revision,
        mentions: mentions.map(({ userId, label }) => ({ userId: userId as Id<"users">, label })),
      }),
    editMessage: ({ messageId, body, mentions }) =>
      change(
        mutation(api.threads.editMessage, {
          messageId: messageId as Id<"messages">,
          body,
          mentions: mentions.map(({ userId, label }) => ({ userId: userId as Id<"users">, label })),
        }),
      ),
    toggleReaction: ({ messageId, emoji }) =>
      change(mutation(api.threads.toggleReaction, { messageId: messageId as Id<"messages">, emoji })),
    setStatus: ({ threadId, status }) => change(mutation(api.threads.setStatus, { threadId: threadId as Id<"threads">, status })),
    remove: (threadId) => change(mutation(api.threads.remove, { threadId: threadId as Id<"threads"> })),
    setTags: ({ threadId, tags }) => change(mutation(api.threads.setTags, { threadId: threadId as Id<"threads">, tags })),
    reattach: ({ threadId, location }) => change(mutation(api.threads.reattach, { threadId: threadId as Id<"threads">, location })),
    attachScreenshot: async ({ threadId, fileId }) => {
      const attach = (storageId: string) =>
        change(mutation(api.threads.attachScreenshot, { threadId: threadId as Id<"threads">, storageId: storageId as Id<"_storage"> | Id<"captureFiles"> }));
      try {
        return await retryUpload(fileId, images, attach, (file) => uploadImage(file.projectId, file.image));
      } finally {
        images.delete(fileId);
      }
    },
    markRead: ({ threadId, seenThrough }) => change(mutation(api.threads.markRead, { threadId: threadId as Id<"threads">, seenThrough })),
    markUnread: (threadId) => change(mutation(api.threads.markUnread, { threadId: threadId as Id<"threads"> })),
    threadPageKey: (threadId) => mutation(api.threads.pageKey, { threadId: threadId as Id<"threads"> }),

    exportThreads: (projectId, threadIds, cancelled) =>
      loadExport(
        ({ projectId, threadIds, threadIndex, paginationOpts }) =>
          client.query(api.threads.exportThreads, {
            projectId: projectId as Id<"projects">,
            threadIds: threadIds as Id<"threads">[],
            threadIndex,
            paginationOpts,
          }),
        projectId,
        threadIds,
        cancelled,
      ),
    useTags: (projectId) => useQueryState(api.tags.list, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    createTagGroup: ({ projectId, name }) => mutation(api.tags.createGroup, { projectId: projectId as Id<"projects">, name }),
    renameTagGroup: ({ projectId, ...args }) => change(mutation(api.tags.renameGroup, { projectId: projectId as Id<"projects">, ...args })),
    deleteTagGroup: ({ projectId, ...args }) => change(mutation(api.tags.deleteGroup, { projectId: projectId as Id<"projects">, ...args })),
    mergeTagGroups: ({ projectId, ...args }) => change(mutation(api.tags.mergeGroups, { projectId: projectId as Id<"projects">, ...args })),
    setTagGroups: ({ projectId, ...args }) => change(mutation(api.tags.setTagGroups, { projectId: projectId as Id<"projects">, ...args })),
    setPresetTags: ({ projectId, ...args }) => change(mutation(api.tags.setPresets, { projectId: projectId as Id<"projects">, ...args })),
    search: ({ projectId, ...args }) => client.action(api.ai.search, { projectId: projectId as Id<"projects">, ...args }),
    useAiSettings: (projectId) =>
      useQueryState(api.aiSettings.get, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    saveAiSettings: ({ projectId, ...input }) => client.action(api.ai.saveSettings, { projectId: projectId as Id<"projects">, ...input }),
    testAiConnection: (projectId, draft) =>
      client.action(api.ai.testSettings, {
        projectId: projectId as Id<"projects">,
        ...(draft === undefined ? {} : { draft: { ...draft, projectId: projectId as Id<"projects"> } }),
      }),
    usePersonalAiSettings: (enabled) => useQueryState(api.aiSettings.getPersonal, enabled ? {} : "skip"),
    savePersonalAiSettings: (input) => client.action(api.ai.savePersonalSettings, input),
    testPersonalAiConnection: (draft) => client.action(api.ai.testPersonalSettings, draft === undefined ? {} : { draft }),
    removePersonalAiSettings: () => mutation(api.aiSettings.removePersonal, {}),
    usePersonalAiUsage: (enabled) => {
      const day = useUtcDay();
      return useQueryState(api.aiSettings.myUsage, enabled ? { day } : "skip");
    },
    listAiModels: (projectId, draft) =>
      client.action(api.ai.listModels, { projectId: projectId as Id<"projects">, ...(draft === undefined ? {} : { draft }) }),
    listPersonalAiModels: (draft) => client.action(api.ai.listPersonalModels, draft === undefined ? {} : { draft }),
    useAiChoice: (projectId) => useQueryState(api.aiSettings.myChoice, projectId === null ? "skip" : { projectId: projectId as Id<"projects"> }),
    // Convex file URLs alone would bypass access checks, so captures come through Critiqs's route.
    loadCapture: async (threadId) => {
      const token = await session.fetchAccessToken({ forceRefreshToken: false });
      if (token === null) return null;
      const response = await fetch(`${deployment.siteUrl}/capture?threadId=${encodeURIComponent(threadId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.ok ? await response.blob() : null;
    },
    mockups: convexMockups(client, deployment, session),
    billing: {
      useStatus: (organizationId) => useQueryState(api.billing.status, organizationId === null ? "skip" : { organizationId }),
      useUsage: (organizationId) => {
        const day = useUtcDay();
        return useQueryState(api.organizations.usage, organizationId === null ? "skip" : { organizationId: organizationId as Id<"organizations">, day });
      },
      changePlan: (args) => client.action(api.billing.changePlan, args),
      setStorageAddOn: (args) => client.action(api.billing.setStorageAddOn, args),
      openPortal: (args) => client.action(api.billing.portal, args),
      loadPrices: async () => {
        await client.action(api.billing.loadPrices, {});
      },
    },
    tickets: {
      useTrackerAccounts: (enabled) => useQueryState(api.trackers.mine, enabled ? {} : "skip"),
      connectTrackerWithToken: (tracker, token) => client.action(api.trackers.connectWithToken, { tracker, token }),
      startTrackerSignIn: (tracker) => client.action(api.trackers.startSignIn, { tracker }),
      disconnectTracker: (tracker) => client.action(api.trackers.disconnect, { tracker }),
      setTrackerAttribution: (tracker, attribution) => change(mutation(api.trackers.setAttribution, { tracker, attribution })),
      listTicketDestinations: (tracker) => client.action(api.tickets.destinations, { tracker }),
      searchTickets: (tracker, query) => client.action(api.tickets.search, { tracker, query }),
      ticketDraft: (threadId, tracker) => client.action(api.tickets.draft, { threadId: threadId as Id<"threads">, tracker }),
      createTicket: ({ threadId, ...input }) => client.action(api.tickets.create, { threadId: threadId as Id<"threads">, ...input }),
      linkTicket: ({ threadId, ...input }) => client.action(api.tickets.link, { threadId: threadId as Id<"threads">, ...input }),
      addTicketLinkBack: (linkId) => client.action(api.tickets.addLinkBack, { linkId }),
      unlinkTicket: (linkId) => change(mutation(api.tickets.unlink, { linkId })),
    },
  };
}

/**
 * Mockups on Convex. Page copies are uploaded to the deployment's storage and
 * read back through its `/mockup/snapshot` route, which checks access as
 * reading the mockup does; copies never change, so each is kept once loaded.
 */
function convexMockups(client: ConvexReactClient, deployment: Deployment, session: TokenSession): MockupTransport {
  const mutation = client.mutation.bind(client);
  const change = (result: Promise<unknown>) => result.then(() => undefined);
  const copies = new Map<string, Promise<string>>();
  /** HTML just uploaded, by file ID, so the copy made from it needn't be downloaded again. */
  const uploaded = new Map<string, string>();
  const remember = (snapshotId: string, storageId: string) => {
    const html = uploaded.get(storageId);
    uploaded.delete(storageId);
    if (html !== undefined) copies.set(snapshotId, Promise.resolve(html));
  };
  const snapshotArgs = (snapshot: NewSnapshot) => ({ ...snapshot, storageId: snapshot.storageId as Id<"_storage"> });
  const uploadSnapshot = async (projectId: string, html: string) => {
    const uploadUrl = await mutation(api.mockups.generateUploadUrl, { projectId: projectId as Id<"projects"> });
    // Current backends route the upload through the deployment, which takes the reviewer's token; older ones gave a storage address.
    const file = new Blob([html], { type: "text/html" });
    const storageId = await uploadFile(uploadUrl, deployment.siteUrl, file, () => session.fetchAccessToken({ forceRefreshToken: false }), fetch, "page copy");
    uploaded.set(storageId, html);
    return storageId;
  };
  const getMockup = (mockupId: string) => client.query(api.mockups.get, { mockupId: mockupId as Id<"mockups"> });

  return {
    useMockupPage: (projectId, scope, initialNumItems) =>
      usePaginatedQuery(api.mockups.listPage, projectId === null ? "skip" : { projectId: projectId as Id<"projects">, scope }, { initialNumItems }),
    useMockup: (mockupId) => useQueryState(api.mockups.get, mockupId === null ? "skip" : { mockupId: mockupId as Id<"mockups"> }),
    useMockupsForThread: (threadId) => useQueryState(api.mockups.forThread, { threadId: threadId as Id<"threads"> }),
    getMockup,
    uploadSnapshot,
    create: async ({ projectId, title, source, snapshot, linkedThreadIds = [] }) => {
      let storageId = snapshot.storageId;
      const mockupId = await retryUpload(
        snapshot.storageId,
        uploaded,
        (fileId) => {
          storageId = fileId;
          return client.action(api.mockups.create, {
            projectId: projectId as Id<"projects">,
            title,
            source,
            snapshot: snapshotArgs({ ...snapshot, storageId: fileId }),
            ...(linkedThreadIds.length === 0 ? {} : { linkedThreadIds: linkedThreadIds as Id<"threads">[] }),
          });
        },
        (html) => uploadSnapshot(projectId, html),
      );
      const snapshotId = (await getMockup(mockupId)).snapshots[0]!._id;
      remember(snapshotId, storageId);
      return { mockupId, snapshotId };
    },
    addSnapshot: async ({ mockupId, snapshot }) => {
      let storageId = snapshot.storageId;
      const snapshotId = await retryUpload(
        snapshot.storageId,
        uploaded,
        (fileId) => {
          storageId = fileId;
          return client.action(api.mockups.addSnapshot, { mockupId: mockupId as Id<"mockups">, snapshot: snapshotArgs({ ...snapshot, storageId: fileId }) });
        },
        async (html) => uploadSnapshot((await getMockup(mockupId)).projectId, html),
      );
      remember(snapshotId, storageId);
      return snapshotId;
    },
    loadSnapshot: (snapshotId) => {
      const known = copies.get(snapshotId);
      if (known !== undefined) return known;
      const loading = (async () => {
        const token = await session.fetchAccessToken({ forceRefreshToken: false });
        if (token === null) throw new Error("Sign in again to open this mockup.");
        const response = await fetch(`${deployment.siteUrl}/mockup/snapshot?snapshotId=${encodeURIComponent(snapshotId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("This page copy couldn't be loaded.");
        return await response.text();
      })();
      copies.set(snapshotId, loading);
      // A failed load is tried again next time.
      loading.catch(() => copies.delete(snapshotId));
      return loading;
    },
    link: ({ mockupId, threadId }) =>
      change(mutation(api.mockups.link, { mockupId: mockupId as Id<"mockups">, threadId: threadId as Id<"threads"> })),
    unlink: ({ mockupId, threadId }) =>
      change(mutation(api.mockups.unlink, { mockupId: mockupId as Id<"mockups">, threadId: threadId as Id<"threads"> })),
    remove: (mockupId) => change(mutation(api.mockups.remove, { mockupId: mockupId as Id<"mockups"> })),
    restore: ({ mockupId, ...args }) => mutation(api.mockups.restore, { mockupId: mockupId as Id<"mockups">, ...args }),
    mockupReply: ({ threadId, snapshots, continuation, model }) =>
      client.action(api.ai.mockupReply, {
        threadId: threadId as Id<"threads">,
        snapshots: snapshots.map((entry) => ({ ...entry, snapshotId: entry.snapshotId as Id<"mockupSnapshots"> })),
        continuation,
        // Left out unless chosen, so a backend from before model choices accepts it.
        ...(model === undefined ? {} : { model }),
      }),
  };
}

/** Whether a change was refused for a file that can only be uploaded again (`reupload` in the backend's `uploads.ts`). */
function needsReupload(error: unknown): boolean {
  return error instanceof ConvexError && (error.data as { reupload?: unknown } | null)?.reupload === true;
}

/**
 * Runs a change that attaches an uploaded file. If the backend refuses the
 * file itself, such as one stored through an address an older backend gave
 * just before a newer one was deployed, uploads it again and retries once.
 */
async function retryUpload<F, T>(
  fileId: string,
  files: Map<string, F>,
  attach: (fileId: string) => Promise<T>,
  upload: (file: F) => Promise<string>,
): Promise<T> {
  try {
    return await attach(fileId);
  } catch (error) {
    const file = files.get(fileId);
    if (!needsReupload(error) || file === undefined) throw error;
    files.delete(fileId);
    return await attach(await upload(file));
  }
}

/** The last few uploads by file ID; older ones are forgotten, so files never attached don't pile up. */
function recentUploads<F>(keep = 4): Map<string, F> {
  const files = new Map<string, F>();
  const set = files.set.bind(files);
  files.set = (key, value) => {
    set(key, value);
    for (const oldest of files.keys()) {
      if (files.size <= keep) break;
      files.delete(oldest);
    }
    return files;
  };
  return files;
}

function flatten<T>(state: QueryState<{ page: T[] }[]>): QueryState<T[]> {
  return state.status === "ready" ? { status: "ready", data: state.data.flatMap((page) => page.page) } : state;
}

/** One discussion from its message pages and reaction pages. */
function combineThread(
  pages: QueryState<ThreadDetailPage[]>,
  reactions: QueryState<Page<ReactionRow>[]>,
): QueryState<ThreadDetail> {
  if (pages.status !== "ready") return pages;
  if (reactions.status !== "ready") return reactions;
  const rows = reactions.data.flatMap((page) => page.page);
  const { page: _page, isDone: _isDone, continueCursor: _cursor, ...thread } = pages.data[0]!;
  return {
    status: "ready",
    data: {
      ...thread,
      messages: pages.data
        .flatMap((page) => page.page)
        .map((message) => {
          const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
          for (const reaction of rows) {
            if (reaction.messageId !== message._id) continue;
            const entry = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
            entry.count++;
            entry.mine ||= reaction.mine;
            byEmoji.set(reaction.emoji, entry);
          }
          return { ...message, reactions: [...byEmoji.values()] };
        }),
    },
  };
}
