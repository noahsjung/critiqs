import { expect, test } from "bun:test";
import type { ProjectInfo, ProjectLookup } from "@critiqs/core";
import { addToProject, Choices, StartedProjects, choose, findProject, ownedProjects, type ProjectsApi, pageOrigin, siteName, startReviewing } from "../src/lookup.ts";
import { fakeChrome } from "./fake-chrome.ts";

const project = (id: string, isOwner = true): ProjectInfo => ({ _id: id, name: `Project ${id}`, tags: [], createdAt: 1, reviewUrl: null, isOwner });

function api(lookup: ProjectLookup, lists: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const projects: ProjectsApi = {
    findForOrigin: async (origin) => (calls.push(`find ${origin}`), lookup),
    listMine: async () => [project("mine"), project("shared", false)],
    create: async (name) => (calls.push(`create ${name}`), "new"),
    addresses: async (projectId) => lists[projectId] ?? [],
    setAddresses: async (projectId, addresses) => (calls.push(`set ${projectId} ${addresses.join(" ")}`), (lists[projectId] = addresses)),
    get: async (projectId) => project(projectId),
  };
  return { projects, calls };
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

test("Start reviewing this site creates a project named for the site, listing its origin", async () => {
  const { projects, calls } = api({ status: "none" });
  expect(await startReviewing(projects, "http://localhost:5173", new StartedProjects(fakeChrome().storage.local, "s", "dana", "http://localhost:5173"))).toBe("new");
  expect(calls).toEqual(["create localhost:5173", "set new http://localhost:5173"]);
  expect(siteName("https://acme-proto.vercel.app")).toBe("acme-proto.vercel.app");
});

test("Add to a project adds the origin to the project's list once, keeping its other addresses", async () => {
  const { projects, calls } = api({ status: "none" }, { mine: ["https://acme.dev"] });
  await addToProject(projects, "mine", "https://staging.acme.dev");
  await addToProject(projects, "mine", "https://staging.acme.dev");
  expect(calls).toEqual(["set mine https://acme.dev https://staging.acme.dev"]);
});

test("only projects the person owns are offered for adding the site", async () => {
  const { projects } = api({ status: "none" });
  expect((await ownedProjects(projects)).map((item) => item._id)).toEqual(["mine"]);
});

test("pages a project could list have an origin; others, such as chrome:// pages and files, have none", () => {
  expect(pageOrigin("https://Acme-Proto.vercel.app:443/users/42?tab=1#x")).toBe("https://acme-proto.vercel.app");
  expect(pageOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
  expect(pageOrigin("chrome://extensions/")).toBeNull();
  expect(pageOrigin("file:///Users/dana/page.html")).toBeNull();
  expect(pageOrigin("https://chromewebstore.google.com/detail/x")).toBe("https://chromewebstore.google.com");
  expect(pageOrigin(undefined)).toBeNull();
});

test("trying Start reviewing again after its address failed to save finishes the same project instead of making another", async () => {
  const { projects, calls } = api({ status: "none" });
  const setAddresses = projects.setAddresses;
  let failures = 1;
  projects.setAddresses = async (projectId, addresses) => {
    if (failures-- > 0) throw new Error("offline");
    return setAddresses(projectId, addresses);
  };
  const chrome = fakeChrome();
  const started = () => new StartedProjects(chrome.storage.local, "https://signin.example", "dana", "https://acme.dev");
  await expect(startReviewing(projects, "https://acme.dev", started())).rejects.toThrow("offline");
  // The panel was closed and opened again: what it started is still known.
  expect(await startReviewing(projects, "https://acme.dev", started())).toBe("new");
  expect(chrome.storage.local.items.size).toBe(0);
  expect(calls.filter((call) => call.startsWith("create"))).toEqual(["create acme.dev"]);
  expect(calls).toContain("set new https://acme.dev");
});

test("finishing a started project adds its address, keeping any added to it meanwhile", async () => {
  const { projects } = api({ status: "none" }, { new: ["https://staging.acme.dev"] });
  const chrome = fakeChrome();
  const started = new StartedProjects(chrome.storage.local, "s", "dana", "https://acme.dev");
  await started.set("new");
  await startReviewing(projects, "https://acme.dev", started);
  expect(await projects.addresses("new")).toEqual(["https://staging.acme.dev", "https://acme.dev"]);
});
