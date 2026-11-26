import type { ExportPage, PageRequest } from "@critiqs/core";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { creditsArg, type Deployment } from "../deployment.ts";
import { loadExport } from "../export-pages.ts";
import { useUtcDay } from "../hooks.ts";
import { CritiqsRequestError, type CritiqsTransport, describeError, type QueryState } from "../transport.ts";
import { type CookieSession, REQUEST_HEADER } from "./session.ts";

/** How often to ask a server in the host app whether anything changed. */
export const POLL_MS = 3000;

/**
 * Critiqs on a server inside the host app, storing feedback in SQLite. There
 * are no live updates: the transport asks every few seconds whether anything
 * changed, and right after the reviewer's own changes, then reloads what the
 * interface shows.
 */
export function httpTransport(deployment: Deployment, session: CookieSession, fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): CritiqsTransport {
  const base = deployment.backendUrl;

  // The server's change counter, and the components waiting on it.
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };
  let seen: number | null = null;
  /** Queries that failed, retried once the server answers again, even if nothing changed. */
  const retries = new Set<() => void>();
  let polling: ReturnType<typeof setInterval> | null = null;
  const poll = async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const response = await fetchFn(`${base}/changes`, { credentials: "same-origin", headers: REQUEST_HEADER });
      if (!response.ok) return;
      const { version: current } = (await response.json()) as { version: number };
      // The first answer reloads too: what loaded before it may predate this version.
      if (seen === null || current !== seen) changed();
      seen = current;
      const waiting = [...retries];
      retries.clear();
      for (const retry of waiting) retry();
      await session.refresh();
    } catch {}
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (polling === null) {
      void poll();
      polling = setInterval(poll, POLL_MS);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && polling !== null) {
        clearInterval(polling);
        polling = null;
      }
    };
  };
  // Reviewers change who is signed in through the sign-in window; reload then too.
  session.subscribe(changed);

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetchFn(`${base}/api/${name}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...REQUEST_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = (await response.json().catch(() => null)) as { value?: T; error?: { code: string; message: string } } | null;
    if (!response.ok || body === null || body.error !== undefined) {
      throw new CritiqsRequestError((body?.error?.code ?? "error") as never, body?.error?.message ?? "Something went wrong. Try again.");
    }
    return body.value as T;
  }
  /** A change: afterwards, everything shown reloads. */
  async function change<T>(name: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await call<T>(name, args);
    } finally {
      changed();
    }
  }

  /** Loads a query, and loads it again whenever something changed. Keeps showing the last result while reloading. */
  function useQuery<T>(name: string, args: Record<string, unknown> | "skip"): QueryState<T> {
    const current = useSyncExternalStore(subscribe, () => version);
    const key = args === "skip" ? "skip" : `${name}:${JSON.stringify(args)}`;
    const [state, setState] = useState<{ key: string; value: QueryState<T> }>({ key, value: { status: "loading" } });
    const latest = useRef(0);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (args === "skip") return;
      const request = ++latest.current;
      let retry: (() => void) | null = null;
      call<T>(name, args).then(
        (data) => request === latest.current && setState({ key, value: { status: "ready", data } }),
        (error: unknown) => {
          if (request !== latest.current) return;
          setState({ key, value: describeError(error) });
          retry = () => setAttempt((count) => count + 1);
          retries.add(retry);
        },
      );
      return () => {
        if (retry !== null) retries.delete(retry);
      };
    }, [key, current, attempt]);
    if (args === "skip" || state.key !== key) return { status: "loading" };
    return state.value;
  }

  return {
    wrap: (children: ReactNode) => children,
    useAuth: () => {
      const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
      useSyncExternalStore(subscribe, () => version);
      return { isLoading: !session.loaded, isAuthenticated: reviewer !== null, rejected: false };
    },
    useProject: (projectId) => useQuery("project", projectId === null ? "skip" : { projectId }),
    useMyProjects: (enabled) => useQuery("myProjects", enabled ? {} : "skip"),
    useMyOrganizations: (enabled) => useQuery("myOrganizations", enabled ? {} : "skip"),
    useOrganization: (organizationId) => useQuery("organization", organizationId === null ? "skip" : { organizationId }),
    renameOrganization: (organizationId, name) => change("renameOrganization", { organizationId, name }),
    inviteMember: (args) => change("inviteMember", args),
    revokeInvite: (inviteId) => change("revokeInvite", { inviteId }),
    setMemberRole: (args) => change("setMemberRole", args),
    removeMember: (args) => change("removeMember", args),
    useThreads: (projectId) => useQuery("threads", projectId === null ? "skip" : { projectId }),
    useThread: (threadId) => useQuery("thread", { threadId }),
    useParticipants: (projectId, query) => useQuery("participants", projectId === null ? "skip" : { projectId, query }),
    useNotificationSettings: (projectId) => useQuery("notificationSettings", projectId === null ? "skip" : { projectId }),
    useUsage: (projectId) => {
      const day = useUtcDay();
      return useQuery("usage", projectId === null ? "skip" : { projectId, day, ...creditsArg(deployment) });
    },
    setNotificationSettings: (args) => change("setNotificationSettings", args),

    syncReviewer: () => call("sync", {}),
    createProject: (name, reviewUrl, organizationId) =>
      change("createProject", { name, reviewUrl, ...(organizationId === undefined ? {} : { organizationId }) }),
    setReviewUrl: (args) => change("setReviewUrl", args),
    setReviewAccess: (args) => change("setReviewAccess", args),
    // Changes nothing the interface shows, so other queries aren't reloaded.
    recordProjectOpened: async (projectId) => void (await call("recordProjectOpened", { projectId })),
    useProjectAddresses: (projectId) => useQuery("projectAddresses", projectId === null ? "skip" : { projectId }),
    addProjectAddress: (args) => change("addProjectAddress", args),
    removeProjectAddress: (args) => change("removeProjectAddress", args),
    setOverageCap: (args) => change("setOverageCap", args),
    uploadImage: async (projectId, image) => {
      const response = await fetchFn(`${base}/upload?projectId=${encodeURIComponent(projectId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { ...REQUEST_HEADER, "Content-Type": image.type },
        body: image,
      });
      const body = (await response.json().catch(() => null)) as { fileId?: string; error?: { code: string; message: string } } | null;
      if (!response.ok || typeof body?.fileId !== "string") {
        throw new CritiqsRequestError((body?.error?.code ?? "error") as never, body?.error?.message ?? "The image could not be uploaded.");
      }
      return body.fileId;
    },
    createThread: (thread) => change("createThread", { ...thread }),
    reply: (args) => change("reply", args),
    editMessage: (args) => change("editMessage", args),
    toggleReaction: (args) => change("toggleReaction", args),
    setStatus: (args) => change("setStatus", args),
    remove: (threadId) => change("remove", { threadId }),
    setTags: (args) => change("setTags", args),
    reattach: (args) => change("reattach", args),
    attachScreenshot: (args) => change("attachScreenshot", args),
    markRead: (args) => change("markRead", args),
    markUnread: (threadId) => change("markUnread", { threadId }),
    threadPageKey: (threadId) => call<string>("threadPageKey", { threadId }),

    exportThreads: (projectId, threadIds, cancelled) =>
      loadExport(
        (args: { projectId: string; threadIds: string[]; threadIndex: number; paginationOpts: PageRequest }) => call<ExportPage>("exportPage", args),
        projectId,
        threadIds,
        cancelled,
      ),
    loadCapture: async (threadId) => {
      const response = await fetchFn(`${base}/capture?threadId=${encodeURIComponent(threadId)}`, { credentials: "same-origin" });
      return response.ok ? await response.blob() : null;
    },

    useTags: (projectId) => useQuery("tags", projectId === null ? "skip" : { projectId }),
    createTagGroup: (args) => change("createTagGroup", args),
    renameTagGroup: (args) => change("renameTagGroup", args),
    deleteTagGroup: (args) => change("deleteTagGroup", args),
    mergeTagGroups: (args) => change("mergeTagGroups", args),
    setTagGroups: (args) => change("setTagGroups", args),
    setPresetTags: (args) => change("setPresetTags", args),
    search: (args) => call("search", args),
    useAiSettings: (projectId) => useQuery("aiSettings", projectId === null ? "skip" : { projectId }),
    saveAiSettings: (input) => change("saveAiSettings", { ...input }),
    testAiConnection: (projectId, draft) => call("testAiConnection", draft === undefined ? { projectId } : { projectId, draft }),
    usePersonalAiSettings: (enabled) => useQuery("personalAiSettings", enabled ? {} : "skip"),
    savePersonalAiSettings: (input) => change("savePersonalAiSettings", { ...input }),
    testPersonalAiConnection: (draft) => call("testPersonalAiConnection", draft === undefined ? {} : { draft }),
    removePersonalAiSettings: () => change("removePersonalAiSettings", {}),
    usePersonalAiUsage: (enabled) => {
      const day = useUtcDay();
      return useQuery("personalAiUsage", enabled ? { day } : "skip");
    },
    listAiModels: (projectId, draft) => call("listAiModels", draft === undefined ? { projectId } : { projectId, draft }),
    listPersonalAiModels: (draft) => call("listPersonalAiModels", draft === undefined ? {} : { draft }),
    useAiChoice: (projectId) => useQuery("aiChoice", projectId === null ? "skip" : { projectId }),
  };
}
