import { expect, test } from "bun:test";
import type { ProjectInfo, ProjectLookup } from "@critiqs/core";
import { addToProject, Choices, choose, findProject, inSeveralOrganizations, type ProjectsApi, pageOrigin, siteName, StartKeys, startReviewing, waitingFor } from "../src/lookup.ts";
import { fakeChrome } from "./fake-chrome.ts";

const project = (id: string, isOwner = true): ProjectInfo => ({ _id: id, name: `Project ${id}`, tags: [], createdAt: 1, reviewUrl: null, isOwner });

/**
 * A backend as the extension sees it: creates with the same key return the
 * same project, and adding an address is one step that keeps the others.
 * `lose` makes the next create's response go missing after the backend made it.
 */
function api(lookup: ProjectLookup | "live", lists: Record<string, string[]> = {}) {
  const calls: string[] = [];
  // "live": the lookup finds whichever projects list the origin now.
  const find = (origin: string): ProjectLookup => {
    if (lookup !== "live") return lookup;
    const found = Object.keys(lists).filter((projectId) => lists[projectId]!.includes(origin));
    return found.length === 0 ? { status: "none" } : found.length === 1 ? { status: "found", project: project(found[0]!) } : { status: "choose", projects: found.map((id) => project(id)) };
  };
  const keys = new Map<string, string>();
  const state = { lose: 0, failAdds: 0 };
  const projects: ProjectsApi = {
    findForOrigin: async (origin) => (calls.push(`find ${origin}`), find(origin)),
    manageable: async () => ({ projects: [project("mine"), project("admin-of")], complete: true }),
    create: async (name, idempotencyKey) => {
      calls.push(`create ${name}`);
      await Promise.resolve();
      let projectId = keys.get(idempotencyKey);
      if (projectId === undefined) {
        projectId = keys.size === 0 ? "new" : `new-${keys.size}`;
        keys.set(idempotencyKey, projectId);
      }
      if (state.lose-- > 0) throw new Error("offline");
      return projectId;
    },
    addAddress: async (projectId, address) => {
      if (state.failAdds-- > 0) throw new Error("offline");
      calls.push(`add ${projectId} ${address}`);
      const list = (lists[projectId] ??= []);
      if (!list.includes(address)) list.push(address);
      return [...list];
    },
    get: async (projectId) => project(projectId),
  };
  return { projects, calls, keys, state, lists };
}

test("one match is shown; several ask; none offers to start", () => {
  expect(choose({ status: "found", project: project("a") }, null)).toEqual({ kind: "show", project: project("a"), choices: null });
  expect(choose({ status: "choose", projects: [project("a"), project("b")] }, null)).toEqual({ kind: "choose", projects: [project("a"), project("b")] });
  expect(choose({ status: "none" }, "a")).toEqual({ kind: "none" });
});

test("the answer the person gave before is shown, but only while the lookup still offers it", () => {
  const offered: ProjectLookup = { status: "choose", projects: [project("a"), project("b")] };
  // The projects it was chosen among stay with it, so the person can choose again.
  expect(choose(offered, "b")).toEqual({ kind: "show", project: project("b"), choices: [project("a"), project("b")] });
  expect(choose(offered, "gone")).toEqual({ kind: "choose", projects: [project("a"), project("b")] });
  // An ambiguous origin with one match still asks, and still uses the person's answer.
  expect(choose({ status: "choose", projects: [project("a")] }, null).kind).toBe("choose");
  expect(choose({ status: "choose", projects: [project("a")] }, "a").kind).toBe("show");
});

test("answers are remembered per person and origin, and a stale one is forgotten", async () => {
  const chrome = fakeChrome();
  const choices = new Choices(chrome.storage.local, "https://signin.example");
  await choices.remember("dana", "http://localhost:5173", "b");
  expect(await choices.get("dana", "http://localhost:5173")).toBe("b");
  expect(await choices.get("lee", "http://localhost:5173")).toBeNull();
  expect(await choices.get("dana", "http://localhost:3000")).toBeNull();
  expect(await new Choices(chrome.storage.local, "https://other-signin.example").get("dana", "http://localhost:5173")).toBeNull();

  const { projects } = api({ status: "choose", projects: [project("a"), project("c")] });
  expect((await findProject(projects, choices, "dana", "http://localhost:5173")).kind).toBe("choose");
  expect(await choices.get("dana", "http://localhost:5173")).toBeNull();
});

/** Web Locks as Chrome gives them: one holder at a time per name. */
function sharedLocks() {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_: string, work: () => Promise<T>): Promise<T> {
      const run = queue.then(work, work);
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
const startKeys = (storage = fakeChrome().storage.local, origin = "https://acme.dev") => new StartKeys(storage, "https://signin.example", "dana", origin);

test("Start reviewing this site creates a project named for the site, listing its origin", async () => {
  const { projects, calls, keys } = api("live");
  const storage = fakeChrome().storage.local;
  const started = await startReviewing(projects, "http://localhost:5173", startKeys(storage, "http://localhost:5173"), null);
  expect(started).toEqual({ kind: "show", project: project("new"), choices: null });
  expect(calls).toEqual(["find http://localhost:5173", "create localhost:5173", "add new http://localhost:5173"]);
  expect([...keys.keys()][0]).toMatch(/^start-[0-9a-f-]{36}$/);
  // Nothing is kept once the start finished.
  expect(storage.items.size).toBe(0);
  expect(siteName("https://acme-proto.vercel.app")).toBe("acme-proto.vercel.app");
});

test("Add to a project adds the origin in one step, keeping the project's other addresses", async () => {
  const { projects, calls, lists } = api({ status: "none" }, { mine: ["https://acme.dev"] });
  await addToProject(projects, "mine", "https://staging.acme.dev");
  await addToProject(projects, "mine", "https://staging.acme.dev");
  expect(calls).toEqual(["add mine https://staging.acme.dev", "add mine https://staging.acme.dev"]);
  expect(lists.mine).toEqual(["https://acme.dev", "https://staging.acme.dev"]);
});

test("two panels adding different sites to one project at once keep both", async () => {
  const { projects, lists } = api({ status: "none" }, { mine: ["https://acme.dev"] });
  await Promise.all([addToProject(projects, "mine", "https://one.acme.dev"), addToProject(projects, "mine", "https://two.acme.dev")]);
  expect([...lists.mine!].sort()).toEqual(["https://acme.dev", "https://one.acme.dev", "https://two.acme.dev"]);
})

test("pages a project could list have an origin; others, such as chrome:// pages and files, have none", () => {
  expect(pageOrigin("https://Acme-Proto.vercel.app:443/users/42?tab=1#x")).toBe("https://acme-proto.vercel.app");
  expect(pageOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
  expect(pageOrigin("chrome://extensions/")).toBeNull();
  expect(pageOrigin("file:///Users/dana/page.html")).toBeNull();
  expect(pageOrigin("https://chromewebstore.google.com/detail/x")).toBe("https://chromewebstore.google.com");
  expect(pageOrigin(undefined)).toBeNull();
});

test("trying Start reviewing again after a lost response or a failed address finishes the same project", async () => {
  const { projects, calls, state, lists } = api("live");
  const storage = fakeChrome().storage.local;
  state.lose = 1;
  await expect(startReviewing(projects, "https://acme.dev", startKeys(storage), null)).rejects.toThrow("offline");
  state.failAdds = 1;
  // The panel was closed and opened again: the key it kept is sent again.
  await expect(startReviewing(projects, "https://acme.dev", startKeys(storage), null)).rejects.toThrow("offline");
  expect(await startReviewing(projects, "https://acme.dev", startKeys(storage), null)).toMatchObject({ kind: "show", project: { _id: "new" } });
  expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(3);
  expect(lists).toEqual({ new: ["https://acme.dev"] });
  expect(storage.items.size).toBe(0);
});

test("two panels starting the same site at once get one project, the second finding the first's", async () => {
  const { projects, keys, lists } = api("live");
  const storage = fakeChrome().storage.local;
  const locks = sharedLocks();
  const [first, second] = await Promise.all([
    startReviewing(projects, "https://acme.dev", startKeys(storage), locks),
    startReviewing(projects, "https://acme.dev", startKeys(storage), locks),
  ]);
  expect(first).toMatchObject({ kind: "show", project: { _id: "new" } });
  expect(second).toMatchObject({ kind: "show", project: { _id: "new" } });
  expect(keys.size).toBe(1);
  expect(lists).toEqual({ new: ["https://acme.dev"] });
});

test("starting a site again after its address was removed from the project makes a new project", async () => {
  const { projects, lists } = api("live");
  const storage = fakeChrome().storage.local;
  await startReviewing(projects, "https://acme.dev", startKeys(storage), null);
  lists.new = [];
  expect(await startReviewing(projects, "https://acme.dev", startKeys(storage), null)).toMatchObject({ kind: "show", project: { _id: "new-1" } });
  expect(lists).toEqual({ new: [], "new-1": ["https://acme.dev"] });
});

test("an answer for a picker the person already left is dropped", () => {
  expect(waitingFor({ name: "add", request: 2 }, 2)).toBe(true);
  expect(waitingFor({ name: "add", request: 3 }, 2)).toBe(false);
  expect(waitingFor({ name: "none" }, 2)).toBe(false);
});

test("the list names each project's organization only when it spans several", () => {
  const inOrganization = (id: string, organization: string): ProjectInfo => ({ ...project(id), organization: { id: organization, name: organization, role: "admin" } });
  expect(inSeveralOrganizations([inOrganization("a", "acme"), inOrganization("b", "acme")])).toBe(false);
  expect(inSeveralOrganizations([inOrganization("a", "acme"), inOrganization("b", "globex")])).toBe(true);
  expect(inSeveralOrganizations([])).toBe(false);
});
