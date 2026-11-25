import { afterEach, expect, test } from "bun:test";
import { DEFAULT_PLANS } from "@critiqs/server";
import { api, internal } from "../convex/_generated/api";
import { reviewer, setup } from "./harness";

afterEach(() => {
  delete process.env.CRITIQS_PLANS;
  delete process.env.CRITIQS_UPGRADE_URL;
});

const dana = reviewer("Dana");
const today = () => new Date().toISOString().slice(0, 10);

test("without plans turned on, usage is null and nothing is counted", async () => {
  const t = setup();
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  expect(await t.withIdentity(dana).query(api.projects.usage, { projectId, day: today() })).toBeNull();
  expect(await t.run((ctx) => ctx.db.query("usage").collect())).toEqual([]);
});

test("Critiqs Cloud counts usage against the default plan and shows it to the owner only", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  const t = setup();
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const usage = await t.withIdentity(dana).query(api.projects.usage, { projectId, day: today() });
  expect(usage?.plan).toBe("Free");
  expect(usage?.rows.find((row) => row.metric === "projects")).toEqual({ metric: "projects", period: "total", used: 1, max: 1 });
  await expect(t.withIdentity(dana).mutation(api.projects.create, { name: "Second" })).rejects.toThrow("Free plan's limit of 1 project");
  await expect(t.withIdentity(reviewer("Lee")).query(api.projects.usage, { projectId, day: today() })).rejects.toThrow("Only the person who set up");
});

test("operators configure plans and move accounts between them without a deploy", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  const t = setup();
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  await t.mutation(internal.plans.set, {
    name: "pilot",
    label: "Pilot",
    limits: [{ metric: "threads", period: "total", max: 7 }],
  });
  await expect(t.mutation(internal.plans.assign, { projectId, plan: "pilto" })).rejects.toThrow('There is no plan named "pilto"');
  await expect(t.mutation(internal.plans.assign, { plan: "pilot" })).rejects.toThrow("Name the organization");
  await t.mutation(internal.plans.assign, { projectId, plan: "pilot" });
  expect(await t.withIdentity(dana).query(api.projects.usage, { projectId, day: today() })).toMatchObject({
    plan: "Pilot",
    rows: [{ metric: "threads", period: "total", used: 0, max: 7 }],
  });
  const plans = await t.query(internal.plans.list, {});
  expect(plans.map((plan) => [plan.name, plan.source])).toEqual([
    ["pilot", "configured"],
    ...Object.keys(DEFAULT_PLANS).map((name) => [name, "built-in"]),
  ]);
});

test("each person sees their own Critiqs AI credits against their own plan, and no one else's", async () => {
  const t = setup();
  expect(await t.withIdentity(dana).query(api.aiSettings.myUsage, { day: today() })).toBeNull();
  await expect(t.query(api.aiSettings.myUsage, { day: today() })).rejects.toThrow("Sign in");

  process.env.CRITIQS_PLANS = "enabled";
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot" });
  const organizationId = (await t.run((ctx) => ctx.db.get(projectId)))!.organizationId!;
  // The built-in Free plan's credits cover the organization's projects and its members' own.
  expect(await t.withIdentity(dana).query(api.aiSettings.myUsage, { day: today() })).toEqual({ plan: "Free", organizationId, rows: [{ period: "month", used: 0, max: 200 }] });
  // An https upgrade page is offered with usage; anything else is ignored.
  process.env.CRITIQS_UPGRADE_URL = "https://critiqs.example/plans";
  expect(await t.withIdentity(dana).query(api.aiSettings.myUsage, { day: today() })).toMatchObject({ upgradeUrl: "https://critiqs.example/plans" });
  expect(await t.withIdentity(dana).query(api.projects.usage, { projectId, day: today() })).toMatchObject({ plan: "Free", upgradeUrl: "https://critiqs.example/plans" });
  process.env.CRITIQS_UPGRADE_URL = "javascript:alert(1)";
  expect(await t.withIdentity(dana).query(api.aiSettings.myUsage, { day: today() })).not.toHaveProperty("upgradeUrl");
  delete process.env.CRITIQS_UPGRADE_URL;
  await t.mutation(internal.plans.set, { name: "pilot", label: "Pilot", limits: [{ metric: "aiCredits", period: "month", max: 40, overage: { defaultCap: 10 } }] });
  await t.mutation(internal.plans.assign, { projectId, plan: "pilot" });
  const month = today().slice(0, 7);
  await t.run((ctx) => ctx.db.insert("usage", { key: `aiCredits:${organizationId}:${month}`, count: 7 }));
  expect(await t.withIdentity(dana).query(api.aiSettings.myUsage, { day: today() })).toEqual({ plan: "Pilot", organizationId, rows: [{ period: "month", used: 7, max: 40, overage: { cap: 10 } }] });
  // Lee, on the default plan, sees his own usage, not Dana's.
  expect(await t.withIdentity(reviewer("Lee")).query(api.aiSettings.myUsage, { day: today() })).toEqual({ plan: "Free", rows: [{ period: "month", used: 0, max: 200 }] });
});
