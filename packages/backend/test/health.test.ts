import { afterEach, expect, test } from "bun:test";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";

const saved = { ...process.env };
afterEach(() => {
  for (const name of ["CRITIQS_AUTH_ISSUER", "CONVEX_SITE_URL", "RESEND_API_KEY", "CRITIQS_EMAIL_FROM", "CRITIQS_PLANS", "CRITIQS_AUTH_PRIVATE_KEY"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("health reports how a deployment that trusts Critiqs Cloud's sign-in is set up", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "https://cloud.convex.site";
  process.env.CONVEX_SITE_URL = "https://team.convex.site";
  const t = setup();
  const projectId = await t.withIdentity(reviewer("Dana")).mutation(api.projects.create, { name: "Pilot" });
  const health = await (await t.fetch(`/critiqs/health?projectId=${projectId}`)).json();
  expect(health).toEqual({
    protocol: 5,
    signIn: "external",
    email: false,
    plans: false,
    billing: false,
    captures: { provider: "convex", configured: true },
    ai: { managed: false, defaultProvider: null, keysStorable: false },
    mentionEmails: { overdue: false, waitingSince: null, last: null },
    project: "found",
    reviewAddress: false,
    reviewAddressLocal: false,
  });
  expect((await (await t.fetch("/critiqs/health?projectId=not-an-id")).json()).project).toBe("missing");
});

test("health describes a project limited to its organization only to its members", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot", reviewUrl: "https://proto.example/admin" });
  await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess: "organization" });
  await lee.mutation(api.users.sync, {});
  const project = (health: Record<string, unknown>) => ({ project: health.project, reviewAddress: health.reviewAddress, reviewAddressLocal: health.reviewAddressLocal });
  const nothing = { project: undefined, reviewAddress: undefined, reviewAddressLocal: undefined };
  const anonymous = await (await t.fetch(`/critiqs/health?projectId=${projectId}`)).json();
  expect(project(anonymous)).toEqual(nothing);
  // The deployment's own diagnostics stay public.
  expect(anonymous.mentionEmails).toEqual({ overdue: false, waitingSince: null, last: null });
  expect(project(await (await lee.fetch(`/critiqs/health?projectId=${projectId}`)).json())).toEqual(nothing);
  expect(project(await (await dana.fetch(`/critiqs/health?projectId=${projectId}`)).json())).toEqual({ project: "found", reviewAddress: true, reviewAddressLocal: false });
});

test("health notices mention emails that scheduled sending left waiting", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "https://team.convex.site";
  process.env.CONVEX_SITE_URL = "https://team.convex.site";
  process.env.RESEND_API_KEY = "re_test";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <c@example.com>";
  delete process.env.CRITIQS_AUTH_PRIVATE_KEY;
  const t = setup();
  // Without its signing key, a deployment with email still can't sign anyone in.
  expect((await (await t.fetch("/critiqs/health")).json()).signIn).toBe("unavailable");
  process.env.CRITIQS_AUTH_PRIVATE_KEY = "{}";
  const projectId = await t.withIdentity(reviewer("Dana")).mutation(api.projects.create, { name: "Pilot" });
  const threadId = await t.withIdentity(reviewer("Dana")).mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Look",
    tags: [],
    capture: { status: "failed", failureReason: "Blocked" },
  });
  await t.run(async (ctx) => {
    const project = (await ctx.db.get(projectId))!;
    await ctx.db.insert("deliveries", {
      recipientId: project.createdBy,
      projectId,
      threadId,
      status: "pending",
      attempts: 0,
      dueAt: Date.now() - 60 * 60_000,
      createdAt: 0,
    });
  });
  const health = await (await t.fetch("/critiqs/health")).json();
  expect(health.signIn).toBe("email");
  expect(health.email).toBe(true);
  expect(health.mentionEmails.overdue).toBe(true);
  expect(health.project).toBeUndefined();
});

test("health notices a send that stopped midway and was never picked up again", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "https://cloud.convex.site";
  const t = setup();
  const projectId = await t.withIdentity(reviewer("Dana")).mutation(api.projects.create, { name: "Pilot", reviewUrl: "https://proto.example/" });
  const threadId = await t.withIdentity(reviewer("Dana")).mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Look",
    tags: [],
    capture: { status: "failed", failureReason: "Blocked" },
  });
  await t.run(async (ctx) => {
    const project = (await ctx.db.get(projectId))!;
    await ctx.db.insert("deliveries", {
      recipientId: project.createdBy,
      projectId,
      threadId,
      status: "sending",
      attempts: 1,
      dueAt: 0,
      claimToken: "gone",
      leaseUntil: Date.now() - 30 * 60_000,
      createdAt: 0,
    });
  });
  const health = await (await t.fetch(`/critiqs/health?projectId=${projectId}`)).json();
  expect(health.mentionEmails.overdue).toBe(true);
  expect(health.reviewAddress).toBe(true);
});

test("health says when a project's review address only opens on one computer or private network, without revealing it", async () => {
  process.env.CRITIQS_AUTH_ISSUER = "https://team.convex.site";
  process.env.CONVEX_SITE_URL = "https://team.convex.site";
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const local = await dana.mutation(api.projects.create, { name: "Local", reviewUrl: "http://localhost:5173/" });
  const tailnet = await dana.mutation(api.projects.create, { name: "Tailnet", reviewUrl: "https://DevBox.tail1234.TS.NET./app/" });
  const deployed = await dana.mutation(api.projects.create, { name: "Deployed", reviewUrl: "https://proto.example/" });
  const read = async (id: string) => await (await t.fetch(`/critiqs/health?projectId=${id}`)).json();
  expect(await read(local)).toMatchObject({ reviewAddress: true, reviewAddressLocal: true });
  expect(JSON.stringify(await read(local))).not.toContain("localhost");
  expect(await read(tailnet)).toMatchObject({ reviewAddress: true, reviewAddressLocal: true });
  expect(JSON.stringify(await read(tailnet)).toLowerCase()).not.toContain("ts.net");
  expect(await read(deployed)).toMatchObject({ reviewAddress: true, reviewAddressLocal: false });
});
