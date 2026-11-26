import { afterEach, expect, test } from "bun:test";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup, upload as uploadFile } from "./harness";

// Who can review a project, on Convex: the functions and routes only Convex
// has (mockups, page copies, captures served over HTTP, uploads, AI calls),
// on top of the shared contract every backend passes.

const PAGE = '<html><head></head><body data-critiqs-node="1"><button data-critiqs-node="2">Save</button></body></html>';
const source = { url: "https://proto.example/users/alex", screen: "user-details", viewState: {}, revision: null, persona: null };
const failed = { status: "failed" as const, failureReason: "x" };
const page = { numItems: 40, cursor: null };
const site = process.env.CONVEX_SITE_URL;
afterEach(() => {
  if (site === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = site;
});

const REFUSED = "This project is limited to members of its organization. Ask one of its admins to invite you.";

/**
 * Dana's project with a captured thread and a mockup with its thread, limited
 * to her organization; Riley joined it by invite, and Lee, who took part
 * while anyone could, is outside it.
 */
async function limitedProject() {
  // Uploads are reserved at the deployment's own address.
  process.env.CONVEX_SITE_URL ??= "https://test.convex.site";
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const riley = t.withIdentity(reviewer("Riley"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  /**
   * A file `who` uploads, or Dana when `who` may not upload here: then the
   * operation using it is refused for who is asking, not for the file.
   */
  const upload = async (body: string, type: string, who: typeof dana = dana) => {
    const purpose = type === "text/html" ? "pageCopy" : "capture";
    try {
      return await uploadFile(who, projectId, body, { type, purpose });
    } catch {
      return await uploadFile(dana, projectId, body, { type, purpose });
    }
  };
  const copy = async (width = 1440, who: typeof dana = dana) => ({ storageId: await upload(PAGE, "text/html", who), width, height: 2000, scrollY: 0, viewportHeight: 900, capturedAt: 1 });
  const threadId = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Spacing",
    tags: [],
    capture: { status: "captured", storageId: await upload("png-bytes", "image/png") },
  });
  const failedThreadId = await dana.mutation(api.threads.create, { projectId, anchor, body: "No capture", tags: [], capture: failed });
  const mockupId = await dana.action(api.mockups.create, { projectId, title: "Bigger save", source, snapshot: await copy() });
  const snapshotId = (await dana.query(api.mockups.get, { mockupId })).snapshots[0]!._id as Id<"mockupSnapshots">;
  const mockupThreadId = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Make it bigger",
    tags: [],
    capture: failed,
    mockup: { mockupId, snapshotId, node: 2 },
  });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley.mutation(api.users.sync, {});
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });
  return { t, dana, lee, riley, projectId, threadId, failedThreadId, mockupId, snapshotId, mockupThreadId, upload, copy };
}

type Fixture = Awaited<ReturnType<typeof limitedProject>>;
type Client = Fixture["lee"];

/** What an attempt came to: "allowed", or its refusal's message. */
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "allowed";
  } catch (error) {
    const data = (error as { data?: { message?: string } }).data;
    return data?.message ?? (error as Error).message;
  }
}

/** Every Convex-only function on a project or on something in it. Deleting comes last. */
function convexOperations(f: Fixture, own: { threadId: Id<"threads">; mockupId: Id<"mockups">; mockupThreadId: Id<"threads"> }) {
  const each: Record<string, (who: Client) => Promise<unknown>> = {
    "mockups.list": (who) => who.query(api.mockups.list, { projectId: f.projectId }),
    "mockups.listPage": (who) => who.query(api.mockups.listPage, { projectId: f.projectId, scope: { screen: "user-details" }, paginationOpts: page }),
    "mockups.get": (who) => who.query(api.mockups.get, { mockupId: own.mockupId }),
    "mockups.threads": (who) => who.query(api.mockups.threads, { mockupId: own.mockupId }),
    "mockups.forThread": (who) => who.query(api.mockups.forThread, { threadId: f.threadId }),
    "mockups.generateUploadUrl": (who) => who.mutation(api.mockups.generateUploadUrl, { projectId: f.projectId }),
    "mockups.create": async (who) => who.action(api.mockups.create, { projectId: f.projectId, title: "Another", source, snapshot: await f.copy(1440, who) }),
    "mockups.addSnapshot": async (who) => who.action(api.mockups.addSnapshot, { mockupId: own.mockupId, snapshot: await f.copy(390, who) }),
    "mockups.rename": (who) => who.mutation(api.mockups.rename, { mockupId: own.mockupId, title: "Renamed" }),
    "mockups.restore": (who) => who.mutation(api.mockups.restore, { mockupId: own.mockupId, number: 0, expectedHead: 0 }),
    "mockups.link": (who) => who.mutation(api.mockups.link, { mockupId: own.mockupId, threadId: f.threadId }),
    "mockups.unlink": (who) => who.mutation(api.mockups.unlink, { mockupId: own.mockupId, threadId: f.threadId }),
    "ai.search": (who) => who.action(api.ai.search, { projectId: f.projectId, question: "spacing", scope: { status: "all", screen: null } }),
    "ai.mockupReply": (who) => who.action(api.ai.mockupReply, { threadId: own.mockupThreadId, snapshots: [], continuation: false }),
    "aiSettings.myChoice": (who) => who.query(api.aiSettings.myChoice, { projectId: f.projectId }),
    "captures.generateUploadUrl": (who) => who.mutation(api.captures.generateUploadUrl, { projectId: f.projectId }),
    "threads.attachScreenshot": async (who) => who.mutation(api.threads.attachScreenshot, { threadId: f.failedThreadId, storageId: await f.upload("png", "image/png", who) }),
    "threads.remove": (who) => who.mutation(api.threads.remove, { threadId: own.threadId }),
    "mockups.remove": (who) => who.mutation(api.mockups.remove, { mockupId: own.mockupId }),
  };
  return each;
}

async function outcomes(each: ReturnType<typeof convexOperations>, who: Client) {
  const results: Record<string, string> = {};
  for (const [name, run] of Object.entries(each)) results[name] = await outcome(run(who));
  return results;
}

test("limited to its organization, a project's mockups, page copies, captures, uploads, and AI are refused to everyone outside it", async () => {
  const f = await limitedProject();
  const outside = convexOperations(f, { threadId: f.mockupThreadId, mockupId: f.mockupId, mockupThreadId: f.mockupThreadId });
  const everyRefused = Object.fromEntries(Object.keys(outside).map((name) => [name, REFUSED]));
  expect(await outcomes(outside, f.lee)).toEqual(everyRefused);
  // Sam has never signed in here.
  expect(await outcomes(outside, f.t.withIdentity(reviewer("Sam")))).toEqual(everyRefused);

  // Files are served only after the same check, by their own IDs.
  for (const path of [`/capture?threadId=${f.threadId}`, `/mockup/snapshot?snapshotId=${f.snapshotId}`]) {
    const response = await f.lee.fetch(path);
    expect([path, response.status, await response.text()]).toEqual([path, 403, REFUSED]);
  }
  expect(await (await f.riley.fetch(`/capture?threadId=${f.threadId}`)).text()).toBe("png-bytes");
  expect(await (await f.riley.fetch(`/mockup/snapshot?snapshotId=${f.snapshotId}`)).text()).toBe(PAGE);

  // Nothing Lee or Sam tried changed anything.
  const mockup = await f.dana.query(api.mockups.get, { mockupId: f.mockupId });
  expect(mockup).toMatchObject({ title: "Bigger save", versionCount: 0, linkedThreadIds: [] });
  expect(mockup.snapshots).toHaveLength(1);
});

test("a member of the project's organization may use its mockups, captures, uploads, and AI", async () => {
  const f = await limitedProject();
  const rileysMockup = await f.riley.action(api.mockups.create, { projectId: f.projectId, title: "Riley's", source, snapshot: await f.copy(1440, f.riley) });
  const snapshotId = (await f.riley.query(api.mockups.get, { mockupId: rileysMockup })).snapshots[0]!._id as Id<"mockupSnapshots">;
  const rileysThread = await f.riley.mutation(api.threads.create, {
    projectId: f.projectId,
    anchor,
    body: "Smaller",
    tags: [],
    capture: failed,
    mockup: { mockupId: rileysMockup, snapshotId, node: null },
  });
  const inside = convexOperations(f, { threadId: rileysThread, mockupId: rileysMockup, mockupThreadId: rileysThread });
  const results = await outcomes(inside, f.riley);
  // Without AI on this deployment, a mockup turn gets past access and says there's no AI.
  expect(results["ai.mockupReply"]).not.toBe(REFUSED);
  delete results["ai.mockupReply"];
  expect(results).toEqual(Object.fromEntries(Object.keys(inside).filter((name) => name !== "ai.mockupReply").map((name) => [name, "allowed"])));
});

test("projects report who can review them, and only their owners change it", async () => {
  const f = await limitedProject();
  expect((await f.riley.query(api.projects.get, { projectId: f.projectId })).reviewAccess).toBe("organization");
  expect(await outcome(f.riley.mutation(api.projects.setReviewAccess, { projectId: f.projectId, reviewAccess: "anyone" }))).toBe(
    "Only the project's owners can change who can review it.",
  );
  expect(await outcome(f.lee.query(api.projects.get, { projectId: f.projectId }))).toBe(REFUSED);
  await f.dana.mutation(api.projects.setReviewAccess, { projectId: f.projectId, reviewAccess: "anyone" });
  expect((await f.lee.query(api.projects.get, { projectId: f.projectId })).reviewAccess).toBe("anyone");
  // A project from before the setting has none stored, and anyone may review it.
  const stored = await f.t.run((ctx) => ctx.db.get(f.projectId));
  expect(stored!.reviewAccess).toBe("anyone");
  await f.t.run((ctx) => ctx.db.patch(f.projectId, { reviewAccess: undefined }));
  expect((await f.lee.query(api.projects.get, { projectId: f.projectId })).reviewAccess).toBe("anyone");
});
