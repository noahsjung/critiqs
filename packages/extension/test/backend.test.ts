import { afterEach, expect, test } from "bun:test";
import { convexProjects } from "../src/backend.ts";
import type { TokenSession } from "../../react/src/session.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const session = { fetchAccessToken: async () => "token" } as unknown as TokenSession;

test("threads are read a page at a time, within the backend's 40 a page, until the last page", async () => {
  const asked: { path: string; numItems: number; cursor: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const { paginationOpts } = body.args[0];
    asked.push({ path: body.path, numItems: paginationOpts.numItems, cursor: paginationOpts.cursor });
    if (paginationOpts.numItems > 40) return Response.json({ status: "error", errorMessage: "Request between 1 and 40 items per page.", errorData: { code: "invalid" } }, { status: 200 });
    const last = paginationOpts.cursor === "page-2";
    const page = Array.from({ length: last ? 3 : 40 }, (_, index) => ({ _id: `${paginationOpts.cursor ?? "page-1"}-${index}` }));
    return Response.json({ status: "success", value: { page, isDone: last, continueCursor: last ? "" : "page-2" }, logLines: [] });
  }) as typeof fetch;
  const threads = await convexProjects("http://127.0.0.1:3210", session).threads("project");
  expect(threads).toHaveLength(43);
  expect(asked.map(({ path, numItems, cursor }) => [path, numItems, cursor])).toEqual([
    ["threads:list", 40, null],
    ["threads:list", 40, "page-2"],
  ]);
});
