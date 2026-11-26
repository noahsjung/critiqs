import { DEFAULT_TAGS } from "@critiqs/core";
import { afterEach, expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup } from "./harness";

const failed = { status: "failed" as const, failureReason: "Blocked" };

// Onboarding on Convex: the public functions, what the schema stores, and
// how developer setup emails go out. The rules themselves are in the shared
// contract (contract-onboarding).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of ["RESEND_API_KEY", "CRITIQS_EMAIL_FROM", "CONVEX_SITE_URL", "CRITIQS_WEB_URL"]) delete process.env[name];
});

/** Turns email on and captures Resend requests, answering each with the next status (200 once they run out). */
function resend(statuses: number[] = []) {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <hello@critiqs.example>";
  process.env.CONVEX_SITE_URL = "https://backend.example.site";
  const sent: { key: string | null; body: any }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.resend.com/")) return realFetch(input as Request, init);
    sent.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(await new Response(init?.body).text()) });
    const status = statuses.shift() ?? 200;
    return status === 200 ? Response.json({ id: "email" }) : new Response("no", { status });
  }) as typeof fetch;
  return sent;
}

test("onboarding saves the person's answers and creates a project with its answers, stack, and starting tags", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  await dana.mutation(api.onboarding.saveAboutYou, { role: "engineer", teamSize: "2-5" });
  await dana.mutation(api.onboarding.saveAboutYou, { role: "chief", teamSize: undefined });
  const projectId = await dana.mutation(api.projects.create, {
    name: "acme-proto.vercel.app",
    reviewUrl: "https://acme-proto.vercel.app",
    onboarding: { codeAccess: "self", feedbackFrom: ["team", "nobody"], purpose: "user-testing" },
    stack: "react",
  });
  const stored = await t.run(async (ctx) => ({
    user: await ctx.db.query("users").first(),
    project: await ctx.db.get(projectId as Id<"projects">),
  }));
  expect(stored.user).toMatchObject({ role: "engineer", teamSize: "2-5" });
  expect(stored.project).toMatchObject({
    tags: ["User feedback", "Bug", "UX copy change", "Design change request"],
    onboarding: { codeAccess: "self", feedbackFrom: ["team"], purpose: "user-testing", stack: "react" },
  });
  // Setup's call, with none of onboarding's arguments, still works as before.
  const plain = await dana.mutation(api.projects.create, { name: "Setup panel" });
  expect(await dana.query(api.projects.get, { projectId: plain })).toMatchObject({ tags: [...DEFAULT_TAGS] });
  await expect(t.mutation(api.onboarding.saveAboutYou, { role: "engineer" })).rejects.toThrow();
});

test("a setup email goes out from a scheduled action as the inviter via Critiqs, and its report link stops further emails", async () => {
  const sent = resend();
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Acme", reviewUrl: "https://acme.example", stack: "next" });
  const [result] = await dana.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails: ["sam@example.com"] });
  expect(result).toEqual({ email: "sam@example.com", status: "sent", sendId: expect.any(String), invite: "created" });
  const sendId = result!.status === "sent" ? result!.sendId : "";
  expect(await dana.query(api.onboarding.developerSends, { projectId })).toMatchObject([{ status: "uncertain" }]);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(sent.map(({ key, body }) => [key, body.from, body.reply_to, body.to])).toEqual([
    [`critiqs-developer:${sendId}:0`, '"Dana via Critiqs" <hello@critiqs.example>', "dana@example.com", ["sam@example.com"]],
  ]);
  expect(sent[0]!.body.text).toContain(`Setup steps: https://critiqs.app/setup/${sendId}`);
  expect(await dana.query(api.onboarding.developerSends, { projectId })).toMatchObject([{ sendId, email: "sam@example.com", status: "sent" }]);
  const sam = t.withIdentity(reviewer("Sam"));
  expect(await sam.query(api.onboarding.developerSetup, { sendId })).toMatchObject({ projectId, projectName: "Acme", inviterName: "Dana" });
  // A copied message's setup page reads the project, not a send: anyone signed in sees it, and only its managers see the saved stack.
  expect(await t.withIdentity(reviewer("Kim")).query(api.onboarding.projectSetup, { projectId })).toEqual({
    projectId,
    projectName: "Acme",
    address: "https://acme.example/",
    stack: null,
    installCommands: [`npx critiqs init ${projectId}`],
    connected: null,
  });
  expect(await dana.query(api.onboarding.projectSetup, { projectId })).toMatchObject({ stack: { id: "next", label: "Next.js", installable: true } });
  await expect(t.query(api.onboarding.projectSetup, { projectId })).rejects.toThrow("Sign in");
  // The report link asks first; confirming stops emails to that inbox.
  const reportUrl = new URL(/Report it: (\S+)/.exec(sent[0]!.body.text)![1]!);
  expect(reportUrl.origin + reportUrl.pathname).toBe("https://backend.example.site/developer-emails/report");
  expect(await (await t.fetch(`${reportUrl.pathname}${reportUrl.search}`)).text()).toContain("Stop emails from Critiqs to this address?");
  const token = reportUrl.searchParams.get("token")!;
  const forged = await t.fetch("/developer-emails/report", { method: "POST", body: new URLSearchParams({ token: `${token}x` }).toString() });
  expect(await forged.text()).toContain("Link not recognized");
  await t.fetch("/developer-emails/report", { method: "POST", body: new URLSearchParams({ token }).toString() });
  const lee = t.withIdentity(reviewer("Lee"));
  const leesProject = await lee.mutation(api.projects.create, { name: "Lee's" });
  expect(await lee.mutation(api.onboarding.sendDeveloperSetup, { projectId: leesProject, emails: ["sam+x@example.com"] })).toEqual([
    { email: "sam+x@example.com", status: "suppressed" },
  ]);
});

test("an unknown result is retried later under the same key; a refusal is recorded as failed", async () => {
  const sent = resend([503, 200, 422]);
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Acme" });
  const [result] = await dana.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails: ["sam@acme.example"] });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await dana.query(api.onboarding.developerSends, { projectId })).toMatchObject([{ status: "uncertain" }]);
  // The retry waits a minute, with the same email and key.
  const retries = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "pending"));
  expect(retries.map((job) => [job.name, job.args[0]])).toEqual([
    ["onboarding:deliverDeveloperEmail", { sendId: result!.status === "sent" ? result!.sendId : "", idempotencyKey: sent[0]!.key, attempt: 1 }],
  ]);
  await t.action(internal.onboarding.deliverDeveloperEmail, retries[0]!.args[0]);
  expect(sent.map((each) => each.key)).toEqual([sent[0]!.key, sent[0]!.key]);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(await dana.query(api.onboarding.developerSends, { projectId })).toMatchObject([{ status: "sent" }]);
  const [other] = await dana.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails: ["kim@acme.example"] });
  expect(other!.status).toBe("sent");
  await t.finishAllScheduledFunctions(() => undefined);
  expect((await dana.query(api.onboarding.developerSends, { projectId })).map((each) => each.status)).toEqual(["sent", "failed"]);
});

test("without email set up, or with an invalid website address, nothing is reserved and setup emails say they're unavailable", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Acme" });
  const refusal = async () =>
    ((await dana.mutation(api.onboarding.sendDeveloperSetup, { projectId, emails: ["sam@acme.example"] }).catch((error: unknown) => error)) as { data?: unknown }).data;
  expect(await refusal()).toEqual({ code: "unavailable", message: "This deployment can't send setup emails. Copy the message instead." });
  resend();
  process.env.CRITIQS_WEB_URL = "http://critiqs.example";
  expect(await refusal()).toMatchObject({ code: "unavailable" });
  expect(await dana.query(api.onboarding.developerSends, { projectId })).toEqual([]);
  process.env.CRITIQS_WEB_URL = "https://staging.critiqs.example/";
  expect(await refusal()).toBeUndefined();
});

test("the component's report that it loaded marks the project connected, from the page's origin, and answers the same for anything", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Acme", reviewUrl: "https://acme.example" });
  const report = (body: string, origin?: string) => t.fetch("/critiqs/connected", { method: "POST", body, headers: origin === undefined ? {} : { Origin: origin } });
  // From the extension's panel, with no origin, or for no project: nothing changes, and every answer is the same.
  for (const response of [await report(projectId, "chrome-extension://pfdpnmmiemejphfghkalofichdcoandg"), await report(projectId), await report("nothing", "https://acme.example"), await report("")]) {
    expect([response.status, response.headers.get("Access-Control-Allow-Origin")]).toEqual([204, "*"]);
  }
  expect((await dana.query(api.onboarding.projectSetup, { projectId })).connected).toBeNull();
  expect((await report(projectId, "https://acme.example")).status).toBe(204);
  expect((await dana.query(api.onboarding.projectSetup, { projectId })).connected).toEqual({ at: expect.any(Number), origin: "https://acme.example", clearable: true });
});

test("a report from an origin the project doesn't list changes nothing; its review address does", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Acme", reviewUrl: "https://acme.example" });
  const report = (body: string, origin: string) => t.fetch("/critiqs/connected", { method: "POST", body, headers: { Origin: origin } });
  expect((await report(projectId, "https://evil.example")).status).toBe(204);
  expect((await dana.query(api.onboarding.projectSetup, { projectId })).connected).toBeNull();
  expect((await report(projectId, "https://acme.example")).status).toBe(204);
  expect((await dana.query(api.onboarding.projectSetup, { projectId })).connected).toEqual({ at: expect.any(Number), origin: "https://acme.example", clearable: true });
  // Its owner clears it.
  await dana.mutation(api.onboarding.clearConnected, { projectId });
  expect((await dana.query(api.onboarding.projectSetup, { projectId })).connected).toBeNull();
});

test("the backfill marks projects that already have threads connected, at their first thread, and is safe to run again", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const used = await dana.mutation(api.projects.create, { name: "Installed before", reviewUrl: "https://acme.example" });
  const unused = await dana.mutation(api.projects.create, { name: "Never installed" });
  await dana.mutation(api.threads.create, { projectId: used, anchor, body: "Left with the installed component", tags: [], capture: failed });
  // As on a deployment from before Connected: the thread is there, the project never reported.
  const threadAt = await t.run(async (ctx) => {
    await ctx.db.patch(used as Id<"projects">, { connectedAt: undefined, connectedOrigin: undefined });
    return (await ctx.db.query("threads").first())!.createdAt;
  });
  for (let run = 0; run < 2; run++) {
    await t.mutation(internal.onboarding.backfillConnected, {});
    await t.finishAllScheduledFunctions(() => undefined);
  }
  expect((await dana.query(api.onboarding.projectSetup, { projectId: used })).connected).toEqual({ at: threadAt, origin: new URL(anchor.evidence.url).origin, clearable: true });
  expect((await dana.query(api.onboarding.projectSetup, { projectId: unused })).connected).toBeNull();
});
