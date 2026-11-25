import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { STATUS_CHECK_MS } from "@critiqs/server";
import { type LinearStandIn, linearIssueWebhook, linearSignature, linearStandIn } from "@critiqs/server/linear-standin";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";
import { list, thread as getThread } from "./pages";

// Tickets' status on Convex, end to end: Linear's webhooks through the HTTP
// route, the check scheduled when someone opens a thread (against a stand-in
// Linear served over HTTP), and Resolve when done.

const KEY = "operator-encryption-key-".padEnd(48, "x");
const SECRET = "lin_wh_test_secret";
const ENV = ["CRITIQS_AI_ENCRYPTION_KEY", "CRITIQS_LINEAR_WEBHOOK_SECRET", "CRITIQS_LINEAR_API_URL", "CONVEX_SITE_URL", "CRITIQS_LINEAR_CLIENT_ID", "CRITIQS_LINEAR_CLIENT_SECRET", "CRITIQS_AUTH_ISSUER"];
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
  process.env.CRITIQS_LINEAR_WEBHOOK_SECRET = SECRET;
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

/** Dana's project; two of Lee's threads, both linked to ENG-9 by Lee. */
async function project() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const sam = t.withIdentity(reviewer("Sam"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype", reviewUrl: "https://review.example/app" });
  const threadId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Department is wrong", tags: [], capture: failedCapture });
  const otherId = await lee.mutation(api.threads.create, { projectId, anchor, body: "Same label elsewhere", tags: [], capture: failedCapture });
  await sam.query(api.trackers.mine, {});
  await lee.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_lee" });
  const link = await lee.action(api.tickets.link, { threadId, tracker: "linear", externalId: "issue-9", comment: false });
  await lee.action(api.tickets.link, { threadId: otherId, tracker: "linear", externalId: "issue-9", comment: false });
  return { t, dana, lee, sam, projectId, threadId, otherId, link };
}

const deliver = async (t: ReturnType<typeof setup>, delivery: { body: string; headers: Record<string, string> }) =>
  await t.fetch("/trackers/linear/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });

const done = (sentAt = Date.now(), updatedAt = sentAt - 1_000) => linearIssueWebhook(SECRET, { action: "update", issueId: "issue-9", state: { name: "Done", type: "completed" }, updatedAt, sentAt });

test("a signed webhook from Linear updates the ticket on every thread that links it; a wrong, stale, or replayed one changes nothing", async () => {
  const { t, sam, projectId, threadId, otherId } = await project();
  const statuses = async () => (await list(sam, { projectId })).map((row) => row.tickets?.[0]?.status?.label);

  // Signed with another secret, or changed after signing: refused, nothing read.
  const forged = await linearIssueWebhook("not-the-secret", { action: "update", issueId: "issue-9", state: { name: "Done", type: "completed" }, updatedAt: Date.now(), sentAt: Date.now() });
  expect((await deliver(t, forged)).status).toBe(401);
  const genuine = await done();
  expect((await deliver(t, { ...genuine, body: genuine.body.replace("Done", "Shipped") })).status).toBe(401);
  // Sent two minutes ago: a recorded delivery sent again.
  expect((await deliver(t, await done(Date.now() - 120_000))).status).toBe(401);
  expect(await statuses()).toEqual(["In Progress", "In Progress"]);

  expect((await deliver(t, genuine)).status).toBe(200);
  expect(await statuses()).toEqual(["Done", "Done"]);
  for (const id of [threadId, otherId]) expect((await getThread(sam, { threadId: id })).tickets?.[0]).toMatchObject({ status: { label: "Done", category: "done" }, statusStale: false });

  // Delivered again, or an older change delivered late: still Done.
  expect((await deliver(t, genuine)).status).toBe(200);
  const older = await linearIssueWebhook(SECRET, { action: "update", issueId: "issue-9", state: { name: "In Progress", type: "started" }, updatedAt: Date.now() - 60_000, sentAt: Date.now() });
  expect((await deliver(t, older)).status).toBe(200);
  expect(await statuses()).toEqual(["Done", "Done"]);

  // Other events are answered and ignored, so Linear doesn't retry them.
  expect((await deliver(t, await linearIssueWebhook(SECRET, { action: "update", issueId: "issue-9", type: "Comment", updatedAt: Date.now(), sentAt: Date.now() }))).status).toBe(200);
  expect(await statuses()).toEqual(["Done", "Done"]);
});

test("the webhook route reads at most 256 KB of bytes, refusing a larger delivery as soon as it is known, and checks the signature over the exact bytes", async () => {
  const { t, sam, projectId } = await project();
  const statuses = async () => (await list(sam, { projectId })).map((row) => row.tickets?.[0]?.status?.label);
  const post = (body: BodyInit, headers: Record<string, string> = {}) => t.fetch("/trackers/linear/webhook", { method: "POST", headers, body });
  const genuine = await done();

  // A Content-Length over the limit, or one that isn't a number, is answered before the body is read.
  expect((await post(genuine.body, { ...genuine.headers, "Content-Length": String(256 * 1024 + 1) })).status).toBe(413);
  expect((await post(genuine.body, { ...genuine.headers, "Content-Length": "lots" })).status).toBe(400);

  // Streamed without a Content-Length: reading stops at the first chunk past the limit (of up to 50 offered).
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulled > 50) return controller.close();
      controller.enqueue(new Uint8Array(100 * 1024).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect((await post(endless, genuine.headers)).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(10);

  // Signed, and under 256 K characters, but over 256 KB as UTF-8: too large.
  const wide = JSON.parse(genuine.body) as { data: { title: string } };
  wide.data.title = "€".repeat(90_000);
  const wideBody = JSON.stringify(wide);
  expect(wideBody.length).toBeLessThan(256 * 1024);
  expect((await post(wideBody, { ...genuine.headers, "Linear-Signature": await linearSignature(SECRET, wideBody) })).status).toBe(413);

  // Signed over what a lenient text read makes of the bytes, not over the bytes sent: refused.
  const raw = new TextEncoder().encode(genuine.body.replace("Department", "Department\u0000"));
  raw[raw.indexOf(0)] = 0xff;
  expect((await post(raw, { ...genuine.headers, "Linear-Signature": await linearSignature(SECRET, new TextDecoder().decode(raw)) })).status).toBe(401);
  expect(await statuses()).toEqual(["In Progress", "In Progress"]);

  // The genuine delivery still lands.
  expect((await post(genuine.body, genuine.headers)).status).toBe(200);
  expect(await statuses()).toEqual(["Done", "Done"]);
});

test("a deleted issue stays Deleted when an older update arrives late or again, as of when it was deleted", async () => {
  const { t, sam, projectId, link } = await project();
  const statuses = async () => (await list(sam, { projectId })).map((row) => row.tickets?.[0]?.status?.label);
  const updatedAt = Date.now() - 5_000;
  const update = await done(Date.now(), updatedAt);
  expect((await deliver(t, update)).status).toBe(200);
  // Deleted after its last update: Linear's remove carries that update's time, and the deletion's own.
  const deletedAt = Date.now() - 1_000;
  expect((await deliver(t, await linearIssueWebhook(SECRET, { action: "remove", issueId: "issue-9", updatedAt, happenedAt: deletedAt, sentAt: Date.now() }))).status).toBe(200);
  expect(await statuses()).toEqual(["Deleted", "Deleted"]);
  expect(await t.run(async (ctx) => (await ctx.db.get(link._id as never)) as { statusChangedAt?: number } | null)).toMatchObject({ statusChangedAt: deletedAt });
  // The update delivered again, within the minute.
  expect((await deliver(t, update)).status).toBe(200);
  expect(await statuses()).toEqual(["Deleted", "Deleted"]);
});

test("an issue deleted after a check read it is still marked Deleted, and Resolve when done resolves its thread", async () => {
  const { t, dana, sam, projectId, threadId, link } = await project();
  await dana.mutation(api.ticketStatus.setResolveWhenDone, { projectId, on: true });
  // A check reads the issue as updated a second ago.
  linear.issues[0]!.updatedAt = new Date(Date.now() - 1_000).toISOString();
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  // Its deletion now carries an older updatedAt than the check read.
  const remove = await linearIssueWebhook(SECRET, { action: "remove", issueId: "issue-9", updatedAt: Date.now() - 60_000, happenedAt: Date.now(), sentAt: Date.now() });
  expect((await deliver(t, remove)).status).toBe(200);
  expect((await getThread(sam, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "Deleted", category: "canceled" } });
  expect(await getThread(sam, { threadId })).toMatchObject({ status: "resolved", resolvedByTickets: true });
});

test("without CRITIQS_LINEAR_WEBHOOK_SECRET, the webhook route refuses every call", async () => {
  const { t, sam, projectId } = await project();
  delete process.env.CRITIQS_LINEAR_WEBHOOK_SECRET;
  expect((await deliver(t, await done())).status).toBe(404);
  expect((await list(sam, { projectId }))[0]?.tickets?.[0]?.status?.label).toBe("In Progress");
});

test("opening a thread schedules a check with the linker's token once its status is over 5 minutes old, at most once per 5 minutes", async () => {
  const { t, sam, threadId, link } = await project();
  linear.issues[0]!.state = { name: "Done", type: "completed" };
  linear.tokens.length = 0;
  // Just linked: fresh, nothing checked.
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(0);

  // Five minutes later, as the stored status ages.
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  // Opening it again before the check ran starts no second one.
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(0);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(linear.tokens).toEqual(["lin_api_lee"]);
  expect((await getThread(sam, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "Done", category: "done" }, statusStale: false });
  await expect(t.mutation(api.ticketStatus.checkStatus, { threadId })).rejects.toThrow("Sign in");
});

test("after the linker disconnects Linear, the chip keeps the last status, marked stale, until a webhook updates it", async () => {
  const { t, lee, sam, threadId, link } = await project();
  await lee.mutation(api.trackers.disconnect, { tracker: "linear" });
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  linear.tokens.length = 0;
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(linear.tokens).toEqual([]);
  expect((await getThread(sam, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "In Progress" }, statusStale: true });
  expect((await deliver(t, await done())).status).toBe(200);
  expect((await getThread(sam, { threadId })).tickets?.[0]).toMatchObject({ status: { label: "Done" }, statusStale: false });
});

test("opening a thread checks only its own links: another thread's link to the same issue, whose linker disconnected, keeps its last-known status and stays open", async () => {
  const { t, dana, lee, sam, projectId, threadId, otherId, link } = await project();
  await dana.mutation(api.ticketStatus.setResolveWhenDone, { projectId, on: true });
  // Lee disconnects; opening his thread marks its status last known.
  await lee.mutation(api.trackers.disconnect, { tracker: "linear" });
  await t.run(async (ctx) => ctx.db.patch(link._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  await sam.mutation(api.ticketStatus.checkStatus, { threadId });
  await t.finishAllScheduledFunctions(() => undefined);
  // Dana links the same issue on her own thread with her own Linear.
  const danaThread = await dana.mutation(api.threads.create, { projectId, anchor, body: "Her thread", tags: [], capture: failedCapture });
  await dana.action(api.trackers.connectWithToken, { tracker: "linear", token: "lin_api_dana" });
  const danas = await dana.action(api.tickets.link, { threadId: danaThread, tracker: "linear", externalId: "issue-9", comment: false });

  linear.issues[0]!.state = { name: "Done", type: "completed" };
  linear.issues[0]!.updatedAt = new Date().toISOString();
  linear.tokens.length = 0;
  await t.run(async (ctx) => ctx.db.patch(danas._id as never, { statusCheckedAt: Date.now() - STATUS_CHECK_MS - 1 }));
  expect(await sam.mutation(api.ticketStatus.checkStatus, { threadId: danaThread })).toBe(1);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(linear.tokens).toEqual(["lin_api_dana"]);
  expect(await getThread(sam, { threadId: danaThread })).toMatchObject({ status: "resolved", resolvedByTickets: true, tickets: [{ status: { label: "Done" }, statusStale: false }] });
  // Lee's threads are untouched by Dana's check.
  expect(await getThread(sam, { threadId })).toMatchObject({ status: "open", tickets: [{ status: { label: "In Progress" }, statusStale: true }] });
  expect(await getThread(sam, { threadId: otherId })).toMatchObject({ status: "open", tickets: [{ status: { label: "In Progress" } }] });
});

test("Resolve when done: only the owner turns it on; then a webhook that finishes every ticket resolves the thread, and reopening the ticket doesn't reopen it", async () => {
  const { t, dana, lee, sam, projectId, threadId } = await project();
  expect(await dana.query(api.ticketStatus.settings, { projectId })).toEqual({ resolveWhenDone: false });
  await expect(lee.mutation(api.ticketStatus.setResolveWhenDone, { projectId, on: true })).rejects.toThrow("Only the person who set up this project can change its ticket settings.");
  await expect(lee.query(api.ticketStatus.settings, { projectId })).rejects.toThrow("Only the person who set up this project");
  expect(await dana.mutation(api.ticketStatus.setResolveWhenDone, { projectId, on: true })).toEqual({ resolveWhenDone: true });

  const sentAt = Date.now();
  expect((await deliver(t, await done(sentAt, sentAt - 1_000))).status).toBe(200);
  expect(await getThread(sam, { threadId })).toMatchObject({ status: "resolved", resolvedByTickets: true, statusChangedByName: null });
  const reopened = await linearIssueWebhook(SECRET, { action: "update", issueId: "issue-9", state: { name: "Todo", type: "unstarted" }, updatedAt: sentAt, sentAt });
  expect((await deliver(t, reopened)).status).toBe(200);
  expect((await getThread(sam, { threadId })).status).toBe("resolved");
  // A person reopens it, and it's theirs again.
  await lee.mutation(api.threads.setStatus, { threadId, status: "open" });
  const open = await getThread(sam, { threadId });
  expect(open).toMatchObject({ status: "open", statusChangedByName: "Lee" });
  expect(open.resolvedByTickets).toBeUndefined();
});

test("/critiqs/config reports ticketStatus with tickets", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "https://auth.example";
  const t = setup();
  const config = (await (await t.fetch("/critiqs/config")).json()) as { tickets?: { ticketStatus?: boolean } };
  expect(config.tickets?.ticketStatus).toBe(true);
});
