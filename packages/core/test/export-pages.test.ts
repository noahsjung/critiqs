import { expect, test } from "bun:test";
import { type ExportPageLoader, loadExport } from "../src/export-pages.ts";

function client(query: (args: Record<string, any>) => Promise<any>): ExportPageLoader {
  return async (args) => query(args);
}

test("export assembles every message page, deduplicates selected threads and omits deleted ones", async () => {
  const requests: Record<string, any>[] = [];
  const service = client(async args => {
    requests.push(args);
    if (args.threadIndex === 1) return { projectName: "Pilot", thread: null, page: [], isDone: true, continueCursor: "" };
    return { projectName: "Pilot", thread: { _id: "a" },
      page: [{ _id: args.paginationOpts.cursor === null ? "first" : "last", body: "Text" }],
      isDone: args.paginationOpts.cursor !== null, continueCursor: "next" };
  });
  const data = await loadExport(service, "project", ["a", "a", "deleted"], () => false);
  expect(data.threads).toHaveLength(1);
  expect(data.threads[0]?.messages.map(message => String(message._id))).toEqual(["first", "last"]);
  expect(requests.map(args => [args.threadIndex, args.paginationOpts.cursor])).toEqual([[0, null], [0, "next"], [1, null]]);
  expect(requests.every(args => args.paginationOpts.numItems === 40)).toBe(true);
});

test("a failure on a later export page rejects the collection instead of returning partial history", async () => {
  const service = client(async args => {
    if (args.paginationOpts.cursor !== null) throw new Error("network failed");
    return { projectName: "Pilot", thread: { _id: "a" }, page: [{ body: "First" }], isDone: false, continueCursor: "next" };
  });
  await expect(loadExport(service, "project", ["a"], () => false)).rejects.toThrow("network failed");
});

test("a thread deleted between export pages is omitted entirely", async () => {
  const service = client(async args => ({ projectName: "Pilot", thread: args.paginationOpts.cursor === null ? { _id: "a" } : null,
    page: [{ body: "First" }], isDone: args.paginationOpts.cursor !== null, continueCursor: "next" }));
  expect((await loadExport(service, "project", ["a"], () => false)).threads).toEqual([]);
});

test("a repeated export cursor fails and closing the dialog cancels further requests", async () => {
  const service = client(async () => ({ projectName: "Pilot", thread: { _id: "a" }, page: [], isDone: false, continueCursor: "same" }));
  await expect(loadExport(service, "project", ["a"], () => false)).rejects.toThrow("did not advance");
  await expect(loadExport(service, "project", ["a"], () => true)).rejects.toThrow("cancelled");
});
