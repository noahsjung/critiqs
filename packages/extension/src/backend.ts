import { api } from "@critiqs/backend/api";
import type { Page, ProjectInfo, ProjectLookup, ThreadSummary } from "@critiqs/core";
import { ConvexHttpClient } from "convex/browser";
import type { GenericId as Id } from "convex/values";
import type { TokenSession } from "../../react/src/session.ts";
import type { ProjectsApi } from "./lookup.ts";

/**
 * Critiqs's Convex functions the extension calls outside the panel itself:
 * the project lookup and setup, and the threads behind pins shown with no
 * side panel open. Every call carries the signed-in reviewer's current token.
 */
export function convexProjects(backendUrl: string, session: TokenSession): ProjectsApi & { threads(projectId: string): Promise<ThreadSummary[]> } {
  const client = new ConvexHttpClient(backendUrl);
  const signedIn = async () => {
    const token = await session.fetchAccessToken({ forceRefreshToken: false });
    if (token === null) throw new Error("Sign in to Critiqs again.");
    client.setAuth(token);
    return client;
  };
  const project = (projectId: string) => projectId as Id<"projects">;
  /** The most items the backend returns a page. */
  const PAGE = 40;
  const allPages = async <T,>(read: (cursor: string | null) => Promise<Page<T>>, limit: number): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < limit; page++) {
      const result: Page<T> = await read(cursor);
      items.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return items;
  };
  return {
    async findForOrigin(origin) {
      return (await (await signedIn()).query(api.projects.findForOrigin, { origin })) as ProjectLookup;
    },
    async listMine() {
      const convex = await signedIn();
      return await allPages<ProjectInfo>((cursor) => convex.query(api.projects.listMine, { paginationOpts: { numItems: PAGE, cursor } }) as Promise<Page<ProjectInfo>>, 10);
    },
    async create(name) {
      return (await (await signedIn()).mutation(api.projects.create, { name, reviewUrl: null })) as string;
    },
    async addresses(projectId) {
      return await (await signedIn()).query(api.projects.addresses, { projectId: project(projectId) });
    },
    async setAddresses(projectId, addresses) {
      return await (await signedIn()).mutation(api.projects.setAddresses, { projectId: project(projectId), addresses });
    },
    async get(projectId) {
      return (await (await signedIn()).query(api.projects.get, { projectId: project(projectId) })) as ProjectInfo;
    },
    async threads(projectId) {
      const convex = await signedIn();
      return await allPages<ThreadSummary>((cursor) => convex.query(api.threads.list, { projectId: project(projectId), paginationOpts: { numItems: PAGE, cursor } }) as Promise<Page<ThreadSummary>>, 25);
    },
  };
}

/** Critiqs's own explanation of a refused call, such as an address that can't be listed; a plain sentence otherwise. */
export function backendMessage(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string") return (data as { message: string }).message;
  if (error instanceof Error && /Sign in to Critiqs again/.test(error.message)) return error.message;
  return "Critiqs couldn't reach its backend. Try again.";
}
