import { afterEach, expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CRITIQS_PLANS;
  delete process.env.RESEND_API_KEY;
  delete process.env.CRITIQS_EMAIL_FROM;
});

/** Captures Resend requests. */
function resend() {
  const sent: { headers: Record<string, string>; body: any }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.resend.com/")) return realFetch(input as Request, init);
    sent.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(await new Response(init?.body).text()) });
    return Response.json({ id: "email" });
  }) as typeof fetch;
  return sent;
}

test("a Plus organization's admins get one email through Resend when its included credits run out, and one when none are left", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  process.env.RESEND_API_KEY = "re_key";
  process.env.CRITIQS_EMAIL_FROM = "Critiqs <hello@critiqs.example>";
  const sent = resend();
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot", reviewUrl: "https://proto.example/" });
  const [organization] = await dana.query(api.organizations.mine, {});
  const organizationId = organization!.id as Id<"organizations">;
  await t.mutation(internal.plans.assign, { organizationId, plan: "plus" });
  /** A Critiqs AI request the project pays for, whose worst case and real cost are both `credits`. */
  const charge = async (credits: number) => {
    const reserved = await t.mutation(internal.aiSettings.reserve, { payer: "project", ownerId: projectId, credits });
    if (!reserved.ok) throw new Error(reserved.reason);
    await t.mutation(internal.aiSettings.settle, { hold: reserved.hold, charge: { payer: "project", ownerId: projectId, credits } });
  };
  const deliver = () => t.action(internal.notificationEmails.deliverPlanAlerts, {});

  await charge(1_999);
  await deliver();
  expect(sent).toEqual([]);
  await charge(2);
  await deliver();
  await deliver();
  expect(sent).toHaveLength(1);
  const [alert] = await t.run((ctx) => ctx.db.query("planAlerts").collect());
  expect(alert).toMatchObject({ kind: "included", status: "sent", included: 2_000, overage: { cap: 2_000 } });
  expect(sent[0]!.headers["idempotency-key"]).toBe(`plan-alert-${alert!._id}-${(await t.run((ctx) => ctx.db.get(projectId)))!.createdBy}`);
  expect(sent[0]!.body).toMatchObject({
    from: "Critiqs <hello@critiqs.example>",
    to: ["dana@example.com"],
    subject: "Dana's organization has used its included Critiqs AI credits",
  });
  expect(sent[0]!.body.text).toContain("up to 2,000 extra credits this month");

  await charge(1_999);
  await expect(charge(1)).rejects.toThrow("allowance is used up");
  await deliver();
  expect(sent.map((one) => one.body.subject)).toEqual(["Dana's organization has used its included Critiqs AI credits", "Critiqs AI is paused for Dana's organization"]);

  // An admin raises the cap, and Critiqs AI works again.
  await dana.mutation(api.organizations.setOverageCap, { organizationId, cap: 3_000 });
  await charge(1);
  expect((await dana.query(api.projects.usage, { projectId, day: new Date().toISOString().slice(0, 10), aiCredits: true }))!.rows[0]).toEqual({
    metric: "aiCredits",
    period: "month",
    used: 4_001,
    max: 2_000,
    overage: { cap: 3_000 },
  });
  await expect(t.withIdentity(reviewer("Lee")).mutation(api.organizations.setOverageCap, { organizationId, cap: null })).rejects.toThrow("Only an admin");
});
