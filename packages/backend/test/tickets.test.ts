import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { type LinearStandIn, linearStandIn } from "@critiqs/server/linear-standin";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup, upload } from "./harness";
import { list, thread as getThread } from "./pages";

// Tickets on Convex, end to end against a stand-in for Linear served over
// HTTP: connecting Linear, listing teams, drafting, creating with the
// capture, linking an existing issue, searching, unlinking, and thread
// answers showing the linked tickets to everyone in the project.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const ENV = ["CRITIQS_AI_ENCRYPTION_KEY", "CRITIQS_LINEAR_CLIENT_ID", "CRITIQS_LINEAR_CLIENT_SECRET", "CRITIQS_LINEAR_API_URL", "CONVEX_SITE_URL"];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const failedCapture = { status: "failed" as const, failureReason: "Blocked" };

let server: ReturnType<typeof Bun.serve>;
let linear: LinearStandIn;
beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => linear.handle(request) });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  const origin = `http://127.0.0.1:${server.port}`;
  linear = linearStandIn(origin, [{ id: "issue-9", identifier: "ENG-9", title: "Department label is unclear", teamId: "team-eng", state: { name: "In Progress", type: "started" } }]);
  process.env.CRITIQS_AI_ENCRYPTION_KEY = KEY;
  process.env.CRITIQS_LINEAR_API_URL = origin;
  process.env.CONVEX_SITE_URL = "https://backend.example";
  delete process.env.CRITIQS_LINEAR_CLIENT_ID;
  delete process.env.CRITIQS_LINEAR_CLIENT_SECRET;
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function project() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const sam = t.withIdentity(reviewer("Sam"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: ["Bug"], capture: failedCapture });
  await sam.query(api.trackers.mine, {});
  return { t, dana, lee, sam, projectId, threadId };
}

test("a reviewer connects Linear, picks a team, edits the draft, and creates the issue with the capture; everyone sees it on the thread", async () => {
  const { t, lee, sam, projectId, threadId } = await project();
  const storageId = await upload(lee, projectId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
  await lee.mutation(api.threads.attachScreenshot, { threadId, storageId });

  await expect(lee.action(api.tickets.destinations, { tracker: "linear" })).rejects.toThrow("Connect Linear in Your trackers first.");
  await lee.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_lee" });
  expect(await lee.action(api.tickets.destinations, { tracker: "linear" })).toEqual([
    { id: "team-des", name: "Design", key: "DES" },
    { id: "team-eng", name: "Engineering", key: "ENG" },
  ]);
  const draft = await lee.action(api.tickets.draft, { threadId, tracker: "linear" });
  expect(draft).toMatchObject({ title: "Department is wrong", createdFromCritiqs: true });
  expect(draft.body).toContain(`[open the thread](<https://review.example/app?critiqs=${threadId}>)`);
  expect(draft.body).toContain("- Capture: attached to this ticket");

  const submissionId = crypto.randomUUID();
  const create = { threadId, submissionId, tracker: "linear" as const, destinationId: "team-eng", title: draft.title, body: `${draft.body}\nPlease fix before launch.`, createdFromCritiqs: true };
  const view = await lee.action(api.tickets.create, create);
  expect(view).toMatchObject({ key: "ENG-10", status: { label: "Triage", category: "open" }, linkedByName: "Lee", canUnlink: true });
  const issue = linear.issues.find((entry) => entry.identifier === "ENG-10")!;
  expect(issue.description).toContain("Please fix before launch.\n\n## Capture\n\n![Capture](<https://uploads.linear.app/asset-1>)");
  expect(issue.description).toContain("Created from Critiqs by Lee");
  expect(linear.uploads).toEqual([{ path: "/uploads/1", contentType: "image/png", size: 10 }]);
  expect(linear.attachments.map((attachment) => attachment.url)).toEqual([`https://review.example/app?critiqs=${threadId}`]);
  // The dialog's retry, after an answer it never got, is the same ticket.
  expect((await lee.action(api.tickets.create, create))._id).toBe(view._id);
  expect(linear.issues.filter((entry) => entry.identifier !== "ENG-9")).toHaveLength(1);

  // Sam has no Linear, but sees the ticket's key and status on the list row and in the thread.
  expect((await list(sam, { projectId }))[0]!.tickets).toEqual([{ tracker: "linear", key: "ENG-10", status: { label: "Triage", category: "open" } }]);
  expect((await getThread(sam, { threadId })).tickets).toEqual([expect.objectContaining({ key: "ENG-10", url: "https://linear.app/acme/issue/eng-10", canUnlink: false })]);
  await expect(sam.mutation(api.tickets.unlink, { linkId: view._id })).rejects.toThrow("Only the person who linked this ticket or the project's owner can unlink it.");
  await expect(sam.action(api.tickets.search, { tracker: "linear", query: "ENG-10" })).rejects.toThrow("Connect Linear");
});

test("a reviewer searches Linear, links an existing issue with a summary comment, and unlinks it", async () => {
  const { dana, lee, threadId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_lee" });
  const [found] = await lee.action(api.tickets.search, { tracker: "linear", query: "department" });
  expect(found).toEqual({ tracker: "linear", externalId: "issue-9", key: "ENG-9", url: "https://linear.app/acme/issue/eng-9", title: "Department label is unclear", status: { label: "In Progress", category: "started" } });
  expect(await lee.action(api.tickets.search, { tracker: "linear", query: "eng-9" })).toEqual([found!]);

  const view = await lee.action(api.tickets.link, { threadId, tracker: "linear", externalId: "issue-9", comment: true });
  expect(view).toMatchObject({ key: "ENG-9", createdFromCritiqs: false });
  expect(linear.comments).toEqual([{ issueId: "issue-9", body: expect.stringContaining("> Department is wrong") }]);
  expect(linear.attachments).toEqual([{ issueId: "issue-9", url: `https://review.example/app?critiqs=${threadId}`, title: "Department is wrong" }]);
  // Linking it again leaves one link and asks Linear nothing.
  linear.operations.length = 0;
  expect((await lee.action(api.tickets.link, { threadId, tracker: "linear", externalId: "issue-9", comment: true }))._id).toBe(view._id);
  expect(linear.operations).toEqual([]);

  // Dana owns the project, so she may unlink Lee's link; the issue stays in Linear.
  expect((await getThread(dana, { threadId })).tickets?.[0]?.canUnlink).toBe(true);
  await dana.mutation(api.tickets.unlink, { linkId: view._id });
  expect((await getThread(lee, { threadId })).tickets).toEqual([]);
  expect(linear.issues.map((issue) => issue.identifier)).toEqual(["ENG-9"]);
});

test("a creation Linear never answered is found on retry instead of created again", async () => {
  const { lee, threadId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_lee" });
  const input = { threadId, submissionId: crypto.randomUUID(), tracker: "linear" as const, destinationId: "team-eng", title: "Department is wrong", body: "Text", createdFromCritiqs: false };
  linear.intercept = (operation) => (operation === "CritiqsCreate" ? "after" : undefined);
  await expect(lee.action(api.tickets.create, input)).rejects.toThrow("wasn't what Critiqs expected");
  expect((await getThread(lee, { threadId })).tickets).toEqual([]);
  linear.intercept = null;
  const view = await lee.action(api.tickets.create, input);
  expect(view.key).toBe("ENG-10");
  expect(linear.issues.filter((issue) => issue.teamId === "team-eng" && issue.identifier !== "ENG-9")).toHaveLength(1);
});

test("when Linear doesn't add the link back, the creator sees it missing and adds it again", async () => {
  const { lee, sam, threadId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_lee" });
  linear.intercept = (operation) => (operation === "CritiqsLinkBack" ? new Response("bad gateway", { status: 502 }) : undefined);
  const view = await lee.action(api.tickets.create, { threadId, submissionId: crypto.randomUUID(), tracker: "linear", destinationId: "team-eng", title: "T", body: "Text", createdFromCritiqs: false });
  expect(view).toMatchObject({ key: "ENG-10", canAddLinkBack: true });
  expect((await getThread(sam, { threadId })).tickets?.map((ticket) => ticket.canAddLinkBack)).toEqual([false]);
  await expect(sam.action(api.tickets.addLinkBack, { linkId: view._id })).rejects.toThrow("Only the person who created this ticket can add its link back to the thread.");
  linear.intercept = null;
  expect((await lee.action(api.tickets.addLinkBack, { linkId: view._id })).canAddLinkBack).toBe(false);
  expect(linear.attachments).toEqual([{ issueId: view.externalId, url: `https://review.example/app?critiqs=${threadId}`, title: "Department is wrong" }]);
  expect((await getThread(lee, { threadId })).tickets?.map((ticket) => ticket.canAddLinkBack)).toEqual([false]);
});

test("once a project is limited to its organization, someone outside it can't draft, create, link, or unlink its tickets", async () => {
  const { t, dana, lee, threadId, projectId } = await project();
  await lee.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_lee" });
  const linked = await lee.action(api.tickets.link, { threadId, tracker: "linear", externalId: "issue-9", comment: false });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  const riley = t.withIdentity(reviewer("Riley"));
  await riley.mutation(api.users.sync, {});
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });

  const refused = "This project is limited to members of its organization. Ask one of its admins to invite you.";
  linear.operations.length = 0;
  const create = { threadId, submissionId: crypto.randomUUID(), tracker: "linear" as const, destinationId: "team-eng", title: "T", body: "Text", createdFromCritiqs: false };
  await expect(lee.action(api.tickets.draft, { threadId, tracker: "linear" })).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.create, create)).rejects.toThrow(refused);
  await expect(lee.action(api.tickets.link, { threadId, tracker: "linear", externalId: "issue-9", comment: true })).rejects.toThrow(refused);
  await expect(lee.mutation(api.tickets.unlink, { linkId: linked._id })).rejects.toThrow(refused);
  // Refused before anything reached Linear, and the link Lee made earlier stays.
  expect(linear.operations).toEqual([]);
  expect((await getThread(dana, { threadId })).tickets?.map((ticket) => ticket.key)).toEqual(["ENG-9"]);

  // A member of the organization still can.
  await riley.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_riley" });
  expect((await riley.action(api.tickets.create, { ...create, submissionId: crypto.randomUUID() })).key).toBe("ENG-10");
});
