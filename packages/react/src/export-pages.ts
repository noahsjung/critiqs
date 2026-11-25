import type { ExportData, ExportedThread, ExportPage, PageRequest } from "@critiqs/core";

/** Requests one page of one selected thread's export. */
export type ExportPageLoader = (request: {
  projectId: string;
  threadIds: string[];
  threadIndex: number;
  paginationOpts: PageRequest;
}) => Promise<ExportPage>;

/** Never return/download a partial collection when one of its pages fails. */
export async function loadExport(
  loadPage: ExportPageLoader,
  projectId: string,
  threadIds: string[],
  cancelled: () => boolean,
): Promise<ExportData> {
  const data: ExportData = { projectName: "", threads: [] };
  const ids = [...new Set(threadIds)];
  for (let threadIndex = 0; threadIndex < ids.length; threadIndex++) {
    let cursor: string | null = null;
    let entry: ExportedThread | null = null;
    while (true) {
      if (cancelled()) throw new Error("Export cancelled");
      const result: ExportPage = await loadPage({
        projectId,
        threadIds: ids,
        threadIndex,
        paginationOpts: { numItems: 40, cursor },
      });
      data.projectName = result.projectName;
      // A deleted/inaccessible thread is omitted in full, including earlier pages.
      if (result.thread === null) {
        entry = null;
        break;
      }
      entry ??= { ...result.thread, messages: [] };
      entry.messages.push(...result.page);
      if (result.isDone) break;
      if (result.continueCursor === cursor) throw new Error("Export pagination did not advance.");
      cursor = result.continueCursor;
    }
    if (entry !== null) data.threads.push(entry);
  }
  return data;
}
