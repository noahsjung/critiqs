import { afterEach, expect, test } from "bun:test";
import { backendProblem, convexProjects } from "../src/backend.ts";
import type { Deployment } from "../../react/src/deployment.ts";
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

test("starting, adding, and listing call the backend's keyed create, one-address add, and manageable projects", async () => {
  const asked: { path: string; args: unknown }[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push({ path: body.path, args: body.args[0] });
    const value = body.path === "projects:manageable" ? { projects: [], complete: true } : body.path === "projects:create" ? "project" : ["https://acme.dev"];
    return Response.json({ status: "success", value, logLines: [] });
  }) as typeof fetch;
  const projects = convexProjects("http://127.0.0.1:3210", session);
  expect(await projects.create("acme.dev", "start-key-0001")).toBe("project");
  expect(await projects.addAddress("project", "https://acme.dev")).toEqual(["https://acme.dev"]);
  expect(await projects.manageable()).toEqual({ projects: [], complete: true });
  expect(asked).toEqual([
    { path: "projects:create", args: { name: "acme.dev", reviewUrl: null, idempotencyKey: "start-key-0001" } },
    { path: "projects:addAddress", args: { projectId: "project", address: "https://acme.dev" } },
    { path: "projects:manageable", args: {} },
  ]);
});

test("the extension needs a Convex backend that reports the lookup, single-address edits, and keyed creates", () => {
  const current: Deployment = {
    backendUrl: "https://team.convex.cloud",
    siteUrl: "https://team.convex.site",
    signInUrl: "https://team.convex.site",
    transport: "convex",
    signIn: null,
    addressLists: true,
    addressEdits: true,
    createKeys: true,
  };
  expect(backendProblem(current)).toBeNull();
  for (const missing of ["addressLists", "addressEdits", "createKeys"] as const) {
    expect(backendProblem({ ...current, [missing]: false })).toBe("The Critiqs backend at https://team.convex.cloud runs an older version. Deploy the current Critiqs functions to it.");
  }
  expect(backendProblem({ ...current, transport: "http" })).toContain("runs inside its app");
});
