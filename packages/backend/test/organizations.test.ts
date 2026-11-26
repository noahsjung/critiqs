import { afterEach, expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { anchor, reviewer, setup } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  delete process.env.CRITIQS_PLANS;
  delete process.env.RESEND_API_KEY;
  delete process.env.CRITIQS_EMAIL_FROM;
  delete process.env.CRITIQS_UPGRADE_URL;
  globalThis.fetch = realFetch;
});

const dana = reviewer("Dana");
const lee = reviewer("Lee");
const today = () => new Date().toISOString().slice(0, 10);

test("the backfill moves projects and plans from before organizations into home organizations, once", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  const t = setup();
  const { danaId, projectIds } = await t.run(async (ctx) => {
    const danaId = await ctx.db.insert("users", { tokenIdentifier: dana.tokenIdentifier, name: "Dana", email: dana.email, imageUrl: null, plan: "team" });
    const projectIds = [];
    for (const name of ["One", "Two"]) projectIds.push(await ctx.db.insert("projects", { name, tags: [], createdBy: danaId, createdAt: 1 }));
    await ctx.db.insert("usage", { key: `projects:${danaId}:total`, count: 2 });
    await ctx.db.insert("usage", { key: `captureBytes:${projectIds[1]}:total`, count: 1000 });
    await ctx.db.insert("users", { tokenIdentifier: "https://auth.example|sam", name: "Sam", email: "sam@example.com", imageUrl: null, plan: "team" });
    await ctx.db.insert("users", { tokenIdentifier: "https://auth.example|lee", name: "Lee", email: lee.email, imageUrl: null });
    return { danaId, projectIds };
  });
  expect(await t.withIdentity(dana).query(api.projects.get, { projectId: projectIds[0]! })).toMatchObject({ isOwner: true });
  expect(await t.withIdentity(lee).query(api.projects.get, { projectId: projectIds[0]! })).toMatchObject({ isOwner: false });
  const before = await t.withIdentity(dana).query(api.projects.usage, { projectId: projectIds[0]!, day: today() });
  // Images count per organization now; a moved project brings what it stores.
  const moved = { ...before!, rows: before!.rows.map((row) => (row.metric === "captureBytes" ? { ...row, used: 1000 } : row)) };
  // The former Team plan is Plus.
  expect(before).toMatchObject({ plan: "Plus", rows: expect.arrayContaining([{ metric: "projects", period: "total", used: 2, max: 10 }]) });

  await t.mutation(internal.organizations.backfill, {});
  await t.finishAllScheduledFunctions(() => undefined);
  const snapshot = () =>
    t.run(async (ctx) => ({
      organizations: (await ctx.db.query("organizations").collect()).map(({ name, plan, createdBy }) => ({ name, plan, createdBy })),
      memberships: (await ctx.db.query("memberships").collect()).map(({ organizationId, userId, role }) => ({ organizationId, userId, role })),
      projects: (await ctx.db.query("projects").collect()).map((project) => project.organizationId),
      users: (await ctx.db.query("users").collect()).map((user) => user.homeOrganizationId ?? null),
      usage: (await ctx.db.query("usage").collect()).map(({ key, count }) => ({ key, count })),
    }));
  const after = await snapshot();
  expect(after.organizations.map(({ name, plan }) => [name, plan])).toEqual([
    ["Dana's organization", "team"],
    ["Sam's organization", "team"],
  ]);
  const [danaOrganization] = await t.run((ctx) => ctx.db.query("organizations").collect());
  expect(after.projects).toEqual([danaOrganization!._id, danaOrganization!._id]);
  expect(after.users).toEqual([danaOrganization!._id, expect.any(String), null]);
  expect(after.memberships.map(({ role }) => role)).toEqual(["admin", "admin"]);
  expect(after.usage).toContainEqual({ key: `projects:${danaOrganization!._id}:total`, count: 2 });
  expect(after.usage).toContainEqual({ key: `captureBytes:${danaOrganization!._id}:total`, count: 1000 });
  expect(await t.withIdentity(dana).query(api.projects.usage, { projectId: projectIds[0]!, day: today() })).toEqual(moved);
  expect(await t.withIdentity(dana).query(api.projects.get, { projectId: projectIds[1]! })).toMatchObject({
    isOwner: true,
    organization: { id: danaOrganization!._id, name: "Dana's organization", role: "admin" },
  });
  expect(await t.withIdentity(dana).query(api.organizations.mine, {})).toEqual([
    { id: danaOrganization!._id, name: "Dana's organization", role: "admin", plan: "Plus", home: true },
  ]);
  expect(await t.withIdentity(lee).query(api.organizations.mine, {})).toEqual([]);
  expect(danaId).toBe(danaOrganization!.createdBy);

  await t.mutation(internal.organizations.backfill, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await snapshot()).toEqual(after);
});

test("the backfill counts images stored before they counted per organization, and running it again after more changes nothing", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  const t = setup();
  const projectIds = [await t.withIdentity(dana).mutation(api.projects.create, { name: "One" })];
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  await t.mutation(internal.plans.assign, { organizationId: organization!.id as Id<"organizations">, plan: "plus" });
  projectIds.push(await t.withIdentity(dana).mutation(api.projects.create, { name: "Two" }));
  // Moved into the organization before images counted per organization: only the projects counted them.
  await t.run(async (ctx) => {
    await ctx.db.insert("usage", { key: `captureBytes:${projectIds[0]}:total`, count: 1000 });
    await ctx.db.insert("usage", { key: `captureBytes:${projectIds[1]}:total`, count: 500 });
  });
  const stored = async () => (await t.withIdentity(dana).query(api.projects.usage, { projectId: projectIds[0]!, day: today() }))!.rows.find((row) => row.metric === "captureBytes")!.used;
  expect(await stored()).toBe(0);
  const backfill = async () => {
    await t.mutation(internal.organizations.backfill, {});
    await t.finishAllScheduledFunctions(() => undefined);
  };
  await backfill();
  expect(await stored()).toBe(1500);
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["png-bytes"], { type: "image/png" })));
  await t.withIdentity(dana).mutation(api.threads.create, { projectId: projectIds[1]!, anchor, body: "Look", tags: [], capture: { status: "captured", storageId } });
  expect(await stored()).toBe(1509);
  await backfill();
  expect(await stored()).toBe(1509);
});

test("a new project goes to its creator's home organization, which plans:assign moves by organization", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  const t = setup();
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  expect(organization).toEqual({ id: expect.any(String), name: "Dana's organization", role: "admin", plan: "Free", home: true });
  await t.mutation(internal.plans.assign, { organizationId: organization!.id as Id<"organizations">, plan: "pro" });
  expect((await t.withIdentity(dana).query(api.projects.usage, { projectId, day: today() }))?.plan).toBe("Pro");
  expect(await t.withIdentity(dana).query(api.organizations.mine, {})).toEqual([{ ...organization!, plan: "Pro" }]);
});

test("an invite is emailed once through the deployment's mail service, and the invited person joins when they sign in", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <sign-in@example.com>";
  const sent: { to: string[]; subject: string; text: string; key: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.resend.com/")) return realFetch(input as Request, init);
    const body = JSON.parse(await new Response(init?.body).text());
    sent.push({ to: body.to, subject: body.subject, text: body.text, key: new Headers(init?.headers).get("Idempotency-Key") });
    return Response.json({ id: "email" });
  }) as typeof fetch;
  const t = setup();
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot", reviewUrl: "https://proto.example/pilot" });
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  const invite = (email: string) => t.withIdentity(dana).mutation(api.organizations.invite, { organizationId: organization!.id, email, role: "member", projectId });
  expect(await invite("Lee@Example.com")).toEqual({ status: "invited", email: "pending" });
  expect(await invite("lee@example.com")).toEqual({ status: "pending" });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(sent).toEqual([
    { to: ["lee@example.com"], subject: "Dana invited you to Dana's organization on Critiqs", text: expect.stringContaining("Open the prototype: https://proto.example/pilot"), key: expect.stringMatching(/^critiqs-invite:/) },
  ]);
  await t.withIdentity(lee).mutation(api.users.sync, {});
  expect(await t.withIdentity(lee).query(api.organizations.mine, {})).toEqual([{ ...organization!, role: "member", home: false }]);
  const details = await t.withIdentity(lee).query(api.organizations.get, { organizationId: organization!.id });
  expect(details.members.map((member) => [member.name, member.role, member.email])).toEqual([
    ["Dana", "admin", null],
    ["Lee", "member", null],
  ]);
  await expect(t.withIdentity(lee).mutation(api.organizations.invite, { organizationId: organization!.id, email: "sam@example.com", role: "member" })).rejects.toThrow(
    "Only an organization's admins",
  );
});

test("without email set up, an invite says none went out, and the invited person still joins when they sign in", async () => {
  const t = setup();
  await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  expect(await t.withIdentity(dana).mutation(api.organizations.invite, { organizationId: organization!.id, email: "lee@example.com", role: "member" })).toEqual({
    status: "invited",
    email: "not-sent",
  });
  await t.finishAllScheduledFunctions(() => undefined);
  await t.withIdentity(lee).mutation(api.users.sync, {});
  expect(await t.withIdentity(lee).query(api.organizations.mine, {})).toEqual([{ ...organization!, role: "member", home: false }]);
});

test("an invite doesn't claim its email went out before it is sent: an email limit can skip it, or the send fail, and the person still joins", async () => {
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <sign-in@example.com>";
  const sent: string[] = [];
  let failing = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.resend.com/")) return realFetch(input as Request, init);
    if (failing) return Response.json({ message: "Resend is down" }, { status: 500 });
    sent.push(JSON.parse(await new Response(init?.body).text()).to[0]);
    return Response.json({ id: "email" });
  }) as typeof fetch;
  const t = setup();
  await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  const organizationId = organization!.id;
  const invite = (email: string) => t.withIdentity(dana).mutation(api.organizations.invite, { organizationId, email, role: "member" });
  const withdraw = async () => {
    const [pending] = (await t.withIdentity(dana).query(api.organizations.get, { organizationId })).invites;
    await t.withIdentity(dana).mutation(api.organizations.revokeInvite, { inviteId: pending!._id });
  };

  // Lee's inbox takes 5 invite emails a day; the sixth invite is skipped, yet answers the same.
  for (let round = 0; round < 5; round++) {
    expect(await invite("lee@example.com")).toEqual({ status: "invited", email: "pending" });
    await t.finishAllScheduledFunctions(() => undefined);
    await withdraw();
  }
  expect(sent).toHaveLength(5);
  expect(await invite("lee@example.com")).toEqual({ status: "invited", email: "pending" });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(sent).toHaveLength(5);

  // Resend refuses Sam's: the answer still didn't say it was sent.
  failing = true;
  expect(await invite("sam@example.com")).toEqual({ status: "invited", email: "pending" });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(sent).toHaveLength(5);

  // Both still join by signing in.
  await t.withIdentity(lee).mutation(api.users.sync, {});
  expect(await t.withIdentity(lee).query(api.organizations.mine, {})).toEqual([{ ...organization!, role: "member", home: false }]);
  const sam = reviewer("Sam");
  await t.withIdentity(sam).mutation(api.users.sync, {});
  expect(await t.withIdentity(sam).query(api.organizations.mine, {})).toEqual([{ ...organization!, role: "member", home: false }]);
});

test("an organization carries the deployment's https upgrade page while it has a plan, and leaves out any other address", async () => {
  const t = setup();
  await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  const get = () => t.withIdentity(dana).query(api.organizations.get, { organizationId: organization!.id });
  process.env.CRITIQS_UPGRADE_URL = "https://critiqs.example/plans";
  // Without plans there is nothing to upgrade.
  expect(await get()).toMatchObject({ plan: null });
  expect(await get()).not.toHaveProperty("upgradeUrl");
  process.env.CRITIQS_PLANS = "enabled";
  expect(await get()).toMatchObject({ plan: "Free", upgradeUrl: "https://critiqs.example/plans" });
  for (const address of ["javascript:alert(1)", "http://critiqs.example/plans", "not a url"]) {
    process.env.CRITIQS_UPGRADE_URL = address;
    expect(await get()).toMatchObject({ plan: "Free" });
    expect(await get()).not.toHaveProperty("upgradeUrl");
  }
});

test("organizations:usage shows members the organization's plan usage, and refuses an ID that isn't an organization's", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  const t = setup();
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await t.withIdentity(dana).query(api.organizations.mine, {});
  const organizationId = organization!.id as Id<"organizations">;
  await t.mutation(internal.plans.assign, { organizationId, plan: "plus" });
  expect(await t.withIdentity(dana).query(api.organizations.usage, { organizationId, day: today() })).toEqual({
    plan: "Plus",
    rows: [
      { metric: "aiCredits", period: "month", used: 0, max: 2_000, overage: { cap: 2_000 } },
      { metric: "projects", period: "total", used: 1, max: 10 },
      { metric: "captureBytes", period: "total", used: 0, max: 10 * 1024 ** 3 },
    ],
    extraCredits: { defaultCap: 2_000, usesDefault: true },
  });
  await expect(t.withIdentity(reviewer("Lee")).query(api.organizations.usage, { organizationId, day: today() })).rejects.toThrow("Only members of the organization");
  await expect(t.withIdentity(dana).query(api.organizations.usage, { organizationId: projectId as unknown as Id<"organizations">, day: today() })).rejects.toThrow();
});
