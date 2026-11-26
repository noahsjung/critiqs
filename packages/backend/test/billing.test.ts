import { afterEach, expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { usageKey } from "../convex/billing";
import { autumnStub, billingUpdated, signWebhook } from "./autumn-stub";
import { reviewer, setup } from "./harness";

const realFetch = globalThis.fetch;
const ENV = ["CRITIQS_PLANS", "CRITIQS_BILLING", "AUTUMN_SECRET_KEY", "AUTUMN_WEBHOOK_SECRET", "AUTUMN_API_URL", "CRITIQS_AUTH_ISSUER"];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of ENV) delete process.env[name];
});

const WEBHOOK_SECRET = `whsec_${btoa("critiqs-billing-test-secret-0123")}`;
const SITE = "https://app.example";
const RETURN = `${SITE}/billing`;
const dana = { ...reviewer("Dana"), origin: SITE };
const lee = { ...reviewer("Lee"), origin: SITE };

/** A Critiqs Cloud deployment that takes payment through a stub Autumn; every Autumn request lands in `stub`. */
function billingOn() {
  process.env.CRITIQS_PLANS = "enabled";
  process.env.CRITIQS_BILLING = "autumn";
  process.env.AUTUMN_SECRET_KEY = "am_sk_test_stub";
  process.env.AUTUMN_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.AUTUMN_API_URL = "https://autumn.test";
  const stub = autumnStub();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith("https://autumn.test/") ? stub.fetch(input, init) : realFetch(input as Request, init)) as typeof fetch;
  return stub;
}

/** Dana's organization, with her as admin and Lee as a member, and a project it pays for. */
async function organization(t: ReturnType<typeof setup>) {
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "Pilot", reviewUrl: "https://proto.example/" });
  const [summary] = await t.withIdentity(dana).query(api.organizations.mine, {});
  const organizationId = summary!.id as Id<"organizations">;
  await t.withIdentity(lee).mutation(api.users.sync, {});
  await t.run(async (ctx) => {
    const leeId = (await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", lee.tokenIdentifier)).unique())!._id;
    await ctx.db.insert("memberships", { organizationId, userId: leeId, role: "member", createdAt: 1 });
  });
  return { projectId, organizationId };
}

async function webhook(t: ReturnType<typeof setup>, customerId: string, options: { id?: string; timestamp?: number; secret?: string } = {}) {
  const body = billingUpdated(customerId);
  const response = await t.fetch("/critiqs/billing/autumn", { method: "POST", headers: await signWebhook(options.secret ?? WEBHOOK_SECRET, body, options), body });
  await t.finishAllScheduledFunctions(() => undefined);
  return response.status;
}

/** Moves the organization to `plan` as its page does: from the plan its billing status shows. */
async function changePlan(t: ReturnType<typeof setup>, organizationId: Id<"organizations">, plan: "free" | "plus" | "pro") {
  const from = (await t.withIdentity(dana).query(api.billing.status, { organizationId }))?.subscription?.plan ?? "free";
  return await t.withIdentity(dana).action(api.billing.changePlan, { organizationId, from, plan, returnUrl: RETURN });
}

/** Prices read from the stub's catalog, as Plan and billing shows them before any change that charges the card on file. */
const pricesRead = (t: ReturnType<typeof setup>) => t.action(internal.billing.refreshPrices, {});

const organizationOf = (t: ReturnType<typeof setup>, id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));

async function charge(t: ReturnType<typeof setup>, projectId: Id<"projects">, credits: number) {
  const reserved = await t.mutation(internal.aiSettings.reserve, { payer: "project", ownerId: projectId, credits });
  if (!reserved.ok) throw new Error(reserved.reason);
  await t.mutation(internal.aiSettings.settle, { hold: reserved.hold, charge: { payer: "project", ownerId: projectId, credits } });
}

test("a deployment without billing advertises none, has no webhook, and never reaches Autumn", async () => {
  process.env.CRITIQS_PLANS = "enabled";
  process.env.CRITIQS_AUTH_ISSUER = "https://cloud.convex.site";
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  // An Autumn key alone doesn't turn billing on.
  process.env.AUTUMN_SECRET_KEY = "am_sk_test_stub";
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  await t.mutation(internal.plans.assign, { organizationId, plan: "plus" });

  const config = await (await t.fetch("/critiqs/config")).json();
  expect(config.billing).toBeUndefined();
  expect((await (await t.fetch("/critiqs/health")).json()).billing).toBe(false);
  expect(await webhook(t, organizationId)).toBe(404);
  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toBeNull();
  await expect(t.withIdentity(dana).action(api.billing.changePlan, { organizationId, from: "free", plan: "pro", returnUrl: RETURN })).rejects.toThrow("doesn't take payment");

  await charge(t, projectId, 50);
  await t.action(internal.billing.reportUsage, {});
  await t.mutation(internal.billing.reconcile, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await t.run((ctx) => ctx.db.query("billingUsage").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("billingAccounts").collect())).toEqual([]);
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");
  expect(calls).toEqual([]);
});

test("config and health report billing without any key", async () => {
  billingOn();
  process.env.CRITIQS_AUTH_ISSUER = "https://cloud.convex.site";
  const t = setup();
  expect((await (await t.fetch("/critiqs/config")).json()).billing).toBe(true);
  const health = await (await t.fetch("/critiqs/health")).text();
  expect(JSON.parse(health).billing).toEqual({ provider: "autumn", environment: "sandbox", webhook: true });
  expect(health).not.toContain("am_sk_");
  expect(health).not.toContain("whsec_");
});

test("an admin upgrades from Free through Stripe Checkout, and the signed webhook moves the organization to Plus", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);

  const { url } = await changePlan(t, organizationId, "plus");
  expect(url).toStartWith("https://checkout.stripe.com/c/pay/");
  expect(stub.customer(organizationId)).toMatchObject({ name: "Dana's organization", email: "dana@example.com" });
  expect(stub.requests.find((request) => request.path === "billing.attach")!.body).toEqual({ customer_id: organizationId, plan_id: "plus", success_url: RETURN, redirect_mode: "always" });
  expect(stub.requests.every((request) => request.headers["x-api-version"] === "2.6.0")).toBe(true);
  // Nothing changes until the person pays.
  expect((await organizationOf(t, organizationId))!.plan).toBeUndefined();

  expect(stub.completeCheckout(url!)).toBe(RETURN);
  expect(await webhook(t, organizationId)).toBe(204);
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");
  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toEqual({
    plan: "plus",
    subscription: { plan: "plus", status: "active", currentPeriodEnd: expect.any(Number), cancelAtPeriodEnd: false, scheduledPlan: null },
    storageAddOns: 0,
    endingStorageAddOns: [],
    canManage: true,
    prices: null,
    plans: expect.any(Object),
  });
  expect(await t.withIdentity(lee).query(api.billing.status, { organizationId })).toMatchObject({ plan: "plus", canManage: false });
});

test("only an organization's admins change billing, only back to the site they signed in from, one change at a time", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  const outsider = reviewer("Sam");

  await expect(t.withIdentity(lee).action(api.billing.changePlan, { organizationId, from: "free", plan: "plus", returnUrl: RETURN })).rejects.toThrow("Only an admin");
  await expect(t.withIdentity(lee).action(api.billing.portal, { organizationId, returnUrl: RETURN })).rejects.toThrow("Only an admin");
  await expect(t.withIdentity(outsider).query(api.billing.status, { organizationId })).rejects.toThrow("Only members");
  const refused = [
    "http://app.example/billing",
    "javascript:alert(1)",
    "/billing",
    "https://user:pw@app.example/",
    "ftp://app.example/",
    "https://attacker.example/billing",
    "https://app.example.attacker.example/",
    "http://localhost:5173/settings",
  ];
  for (const returnUrl of refused) {
    await expect(t.withIdentity(dana).action(api.billing.changePlan, { organizationId, from: "free", plan: "plus", returnUrl })).rejects.toThrow("the site you signed in from");
  }
  await expect(t.withIdentity(reviewer("Dana")).action(api.billing.portal, { organizationId, returnUrl: RETURN })).rejects.toThrow("the site you signed in from");
  expect(stub.requests).toEqual([]);
  expect((await t.withIdentity(dana).action(api.billing.portal, { organizationId, returnUrl: RETURN })).url).toContain(encodeURIComponent(RETURN));
  for (const returnUrl of ["http://localhost:5173/settings", "http://127.0.0.1:3000/"]) {
    const local = { ...dana, origin: new URL(returnUrl).origin };
    expect((await t.withIdentity(local).action(api.billing.portal, { organizationId, returnUrl })).url).toContain(encodeURIComponent(returnUrl));
  }

  // A second click while the first change is still with Autumn is refused.
  await t.run(async (ctx) => {
    const account = (await ctx.db.query("billingAccounts").unique())!;
    await ctx.db.patch(account._id, { busyUntil: Date.now() + 10_000 });
  });
  const before = stub.requests.length;
  await expect(changePlan(t, organizationId, "plus")).rejects.toThrow("in progress");
  expect(stub.requests.length).toBe(before);
  await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("billingAccounts").unique())!._id, { busyUntil: undefined }));

  // Autumn's limit of billing calls per customer, and its lock while another change for the customer runs
  // (423, as the sandbox answered two at once), are explained, and the organization is free for the next try.
  stub.fail("billing.attach", 429);
  stub.fail("billing.attach", 423, 1, "lock_already_exists");
  for (let i = 0; i < 2; i++) {
    await expect(changePlan(t, organizationId, "plus")).rejects.toThrow("Too many billing changes at once. Wait a minute, then try again.");
  }
  expect((await changePlan(t, organizationId, "plus")).url).toStartWith("https://checkout.stripe.com/");
});

test("with a card on file, Plus to Pro is immediate, Pro to Plus waits for the period's end, and Free cancels at the end", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  await pricesRead(t);
  const change = (plan: "free" | "plus" | "pro") => changePlan(t, organizationId, plan);
  const status = () => t.withIdentity(dana).query(api.billing.status, { organizationId });
  stub.completeCheckout((await change("plus")).url!);
  await webhook(t, organizationId);

  // An upgrade charges the card at once; the organization changes before any webhook.
  expect(await change("pro")).toEqual({ url: null });
  expect((await organizationOf(t, organizationId))!.plan).toBe("pro");

  expect(await change("plus")).toEqual({ url: null });
  expect(await status()).toMatchObject({ plan: "pro", subscription: { cancelAtPeriodEnd: false, scheduledPlan: "plus" } });
  // Choosing Pro again keeps it.
  await change("pro");
  expect(await status()).toMatchObject({ plan: "pro", subscription: { scheduledPlan: null } });
  await change("plus");
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(await status()).toMatchObject({ plan: "plus", subscription: { scheduledPlan: null } });

  expect(await change("free")).toEqual({ url: null });
  expect(await status()).toMatchObject({ plan: "plus", subscription: { cancelAtPeriodEnd: true, scheduledPlan: "free" } });
  expect(stub.requests.filter((request) => request.path === "billing.update").at(-1)!.body).toEqual({ customer_id: organizationId, plan_id: "plus", cancel_action: "cancel_end_of_cycle" });
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect((await organizationOf(t, organizationId))!.plan).toBe("free");
  expect(await status()).toMatchObject({ plan: "free", subscription: null });
});

test("a change from a plan other than Autumn's charges nothing and says the plan changed", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  await pricesRead(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);
  const attaches = () => stub.requests.filter((request) => request.path === "billing.attach").length;
  const before = attaches();

  await expect(t.withIdentity(dana).action(api.billing.changePlan, { organizationId, from: "free", plan: "pro", returnUrl: RETURN })).rejects.toThrow(
    "Dana's organization is on Plus now, not Free. Check the plan, then choose again.",
  );
  expect(attaches()).toBe(before);
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");
  expect(await changePlan(t, organizationId, "pro")).toEqual({ url: null });
});

test("from Free, a paid plan always goes through Stripe Checkout, even with a card on file", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);
  await changePlan(t, organizationId, "free");
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(stub.customer(organizationId)!.card).toBe(true);

  const { url } = await changePlan(t, organizationId, "pro");
  expect(url).toStartWith("https://checkout.stripe.com/c/pay/");
  expect(stub.requests.filter((request) => request.path === "billing.attach").at(-1)!.body).toMatchObject({ plan_id: "pro", redirect_mode: "always" });
  expect((await organizationOf(t, organizationId))!.plan).toBe("free");
  stub.completeCheckout(url!);
  await webhook(t, organizationId);
  expect((await organizationOf(t, organizationId))!.plan).toBe("pro");
});

test("without prices, a change that would charge the card on file is refused before Autumn; Checkout, cancel, keep and remove still work", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  const addOn = (enabled: boolean) => t.withIdentity(dana).action(api.billing.setStorageAddOn, { organizationId, enabled, returnUrl: RETURN });
  const status = () => t.withIdentity(dana).query(api.billing.status, { organizationId });
  const attaches = () => stub.requests.filter((request) => request.path === "billing.attach").length;
  const PAUSED = "Prices can't be shown right now, so plan changes are paused. Try again shortly.";
  expect(await status()).toMatchObject({ prices: null });

  // From Free, Stripe Checkout shows the price, so buying stays open.
  const { url } = await changePlan(t, organizationId, "plus");
  expect(url).toStartWith("https://checkout.stripe.com/c/pay/");
  stub.completeCheckout(url!);
  await webhook(t, organizationId);
  expect(stub.customer(organizationId)!.card).toBe(true);

  // Plus to Pro would charge the saved card an amount nobody saw.
  let before = attaches();
  await expect(changePlan(t, organizationId, "pro")).rejects.toThrow(PAUSED);
  expect(attaches()).toBe(before);
  expect(await status()).toMatchObject({ plan: "plus", subscription: { scheduledPlan: null } });

  // Cancelling and keeping the plan charge nothing.
  expect(await changePlan(t, organizationId, "free")).toEqual({ url: null });
  expect(await status()).toMatchObject({ plan: "plus", subscription: { cancelAtPeriodEnd: true } });
  expect(await changePlan(t, organizationId, "plus")).toEqual({ url: null });
  expect(await status()).toMatchObject({ plan: "plus", subscription: { cancelAtPeriodEnd: false } });

  // On Pro with storage, once prices go: removing storage works, buying it and Pro to Plus don't.
  await pricesRead(t);
  await changePlan(t, organizationId, "pro");
  await addOn(true);
  await t.run(async (ctx) => ctx.db.delete((await ctx.db.query("billingPrices").unique())!._id));
  expect(await status()).toMatchObject({ plan: "pro", storageAddOns: 1, prices: null });
  await addOn(false);
  expect(await status()).toMatchObject({ storageAddOns: 0 });
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  before = attaches();
  await expect(addOn(true)).rejects.toThrow(PAUSED);
  await expect(changePlan(t, organizationId, "plus")).rejects.toThrow(PAUSED);
  expect(attaches()).toBe(before);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 0 });
  expect(await changePlan(t, organizationId, "free")).toEqual({ url: null });
});

test("billing status says what each plan includes, from the deployment's plan configuration", async () => {
  billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  const plans = async () => (await t.withIdentity(lee).query(api.billing.status, { organizationId }))!.plans;
  const GB = 1024 ** 3;
  expect(await plans()).toEqual({
    free: {
      label: "Free",
      limits: [
        { metric: "aiCredits", period: "month", max: 200 },
        { metric: "projects", period: "total", max: 1 },
        { metric: "captureBytes", period: "total", max: 500 * 1024 ** 2 },
        { metric: "reviewers", period: "month", max: 5 },
        { metric: "messages", period: "month", max: 500 },
        { metric: "mentionEmails", period: "day", max: 100 },
      ],
    },
    plus: {
      label: "Plus",
      limits: [
        { metric: "aiCredits", period: "month", max: 2_000 },
        { metric: "projects", period: "total", max: 10 },
        { metric: "captureBytes", period: "total", max: 10 * GB },
        { metric: "reviewers", period: "month", max: 25 },
        { metric: "messages", period: "month", max: 5_000 },
        { metric: "mentionEmails", period: "day", max: null },
      ],
    },
    pro: {
      label: "Pro",
      limits: [
        { metric: "aiCredits", period: "month", max: 10_000 },
        { metric: "projects", period: "total", max: null },
        { metric: "captureBytes", period: "total", max: 100 * GB, addOn: 100 * GB },
        { metric: "reviewers", period: "month", max: null },
        { metric: "messages", period: "month", max: null },
        { metric: "mentionEmails", period: "day", max: null },
      ],
    },
  });

  // An operator changes Plus: the status says so at once, with no change to Critiqs's code.
  await t.mutation(internal.plans.set, {
    name: "plus",
    label: "Plus",
    limits: [
      { metric: "aiCredits", period: "month", max: 3_000, overage: { defaultCap: 3_000 } },
      { metric: "projects", period: "total", max: 20 },
      { metric: "messages", period: "day", max: 300 },
    ],
  });
  expect((await plans()).plus.limits).toEqual([
    { metric: "aiCredits", period: "month", max: 3_000 },
    { metric: "projects", period: "total", max: 20 },
    { metric: "captureBytes", period: "total", max: null },
    { metric: "reviewers", period: "month", max: null },
    { metric: "messages", period: "day", max: 300 },
    { metric: "mentionEmails", period: "day", max: null },
  ]);
});

test("a plan an operator set shows as the organization's plan, with no subscription, and paying for one goes through Checkout", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  await t.mutation(internal.plans.assign, { organizationId, plan: "plus" });

  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toEqual({ plan: "plus", subscription: null, storageAddOns: 0, endingStorageAddOns: [], canManage: true, prices: null, plans: expect.any(Object) });
  const { url } = await changePlan(t, organizationId, "pro");
  expect(url).toStartWith("https://checkout.stripe.com/c/pay/");
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");
  stub.completeCheckout(url!);
  await webhook(t, organizationId);
  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toMatchObject({ plan: "pro", subscription: { plan: "pro" } });
});

test("Free after a scheduled downgrade to Plus ends the paid plan at the period's end, on Free", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  await pricesRead(t);
  const change = (plan: "free" | "plus" | "pro") => changePlan(t, organizationId, plan);
  const status = () => t.withIdentity(dana).query(api.billing.status, { organizationId });
  stub.completeCheckout((await change("pro")).url!);
  await webhook(t, organizationId);

  await change("plus");
  expect(await status()).toMatchObject({ plan: "pro", subscription: { cancelAtPeriodEnd: false, scheduledPlan: "plus" } });
  expect(await change("free")).toEqual({ url: null });
  expect(await status()).toMatchObject({ plan: "pro", subscription: { cancelAtPeriodEnd: true, scheduledPlan: "free" } });
  // Free again changes nothing more.
  const updates = stub.requests.filter((request) => request.path === "billing.update").length;
  await change("free");
  expect(stub.requests.filter((request) => request.path === "billing.update")).toHaveLength(updates);

  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect((await organizationOf(t, organizationId))!.plan).toBe("free");
  expect(await status()).toMatchObject({ plan: "free", subscription: null });
});

test("a moved plan starts from its own default cap on extra credits", async () => {
  const stub = billingOn();
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  await pricesRead(t);
  const credits = async () =>
    (await t.withIdentity(dana).query(api.projects.usage, { projectId, day: new Date().toISOString().slice(0, 10), aiCredits: true }))!.rows.find((row) => row.metric === "aiCredits");
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);
  await t.withIdentity(dana).mutation(api.organizations.setOverageCap, { organizationId, cap: 500 });
  expect(await credits()).toMatchObject({ max: 2_000, overage: { cap: 500 } });
  await changePlan(t, organizationId, "pro");
  expect(await credits()).toMatchObject({ max: 10_000, overage: { cap: 10_000 } });
});

test("a failed renewal keeps the paid plan until Stripe gives up, then the organization is on Free", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);

  stub.setPastDue(organizationId, true);
  await webhook(t, organizationId);
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");
  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toMatchObject({ plan: "plus", subscription: { status: "past_due" } });

  stub.expire(organizationId);
  await webhook(t, organizationId);
  expect((await organizationOf(t, organizationId))!.plan).toBe("free");
});

test("webhooks count only when signed with the secret and recent", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  const reads = () => stub.requests.filter((request) => request.path === "customers.get").length;
  const before = reads();

  expect(await webhook(t, organizationId, { secret: `whsec_${btoa("someone-else-entirely-0123456789")}` })).toBe(401);
  expect(await webhook(t, organizationId, { timestamp: Date.now() - 6 * 60_000 })).toBe(401);
  expect(await webhook(t, organizationId, { timestamp: Date.now() + 6 * 60_000 })).toBe(401);
  const unsigned = await t.fetch("/critiqs/billing/autumn", { method: "POST", body: billingUpdated(organizationId) });
  expect(unsigned.status).toBe(401);
  expect(reads()).toBe(before);
  expect((await organizationOf(t, organizationId))!.plan).toBeUndefined();

  // A redelivered message reads the customer again, which changes nothing.
  expect(await webhook(t, organizationId, { id: "msg_1" })).toBe(204);
  expect(await webhook(t, organizationId, { id: "msg_1" })).toBe(204);
  expect(reads()).toBe(before + 2);
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");

  // Svix's other header names, and an event about no organization of this deployment.
  const body = billingUpdated("someone-else");
  const headers = await signWebhook(WEBHOOK_SECRET, body);
  const renamed = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.replace("svix-", "webhook-"), value]));
  expect((await t.fetch("/critiqs/billing/autumn", { method: "POST", headers: renamed, body })).status).toBe(204);
});

test("a webhook whose customer can't be read is refused, so Svix sends it again, and the resend moves the organization", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);

  stub.fail("customers.get", 500);
  expect(await webhook(t, organizationId, { id: "msg_resent" })).toBe(503);
  expect((await organizationOf(t, organizationId))!.plan).toBeUndefined();
  expect(await webhook(t, organizationId, { id: "msg_resent" })).toBe(204);
  expect((await organizationOf(t, organizationId))!.plan).toBe("plus");
});

test("the daily check catches a change whose webhook never came, and leaves an operator's plan alone", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "pro")).url!);
  const sam = reviewer("Sam");
  await t.withIdentity(sam).mutation(api.projects.create, { name: "Comped" });
  const [comped] = await t.withIdentity(sam).query(api.organizations.mine, {});
  await t.mutation(internal.plans.assign, { organizationId: comped!.id as Id<"organizations">, plan: "plus" });

  await t.mutation(internal.billing.reconcile, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect((await organizationOf(t, organizationId))!.plan).toBe("pro");
  expect((await organizationOf(t, comped!.id as Id<"organizations">))!.plan).toBe("plus");
  expect(stub.customer(comped!.id)).toBeUndefined();
});

test("Pro's storage add-on raises the organization's image storage by 100 GB until it is canceled", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  await pricesRead(t);
  const addOn = (enabled: boolean) => t.withIdentity(dana).action(api.billing.setStorageAddOn, { organizationId, enabled, returnUrl: RETURN });
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await expect(addOn(true)).rejects.toThrow("Extra storage comes with Pro");
  await changePlan(t, organizationId, "pro");

  expect(await addOn(true)).toEqual({ url: null });
  expect(await addOn(true)).toEqual({ url: null });
  expect(stub.requests.filter((request) => request.path === "billing.attach" && request.body.plan_id === "storage_100gb")).toHaveLength(1);
  expect((await organizationOf(t, organizationId))!.extraStorageUnits).toBe(1);
  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toMatchObject({ storageAddOns: 1 });

  await addOn(false);
  expect((await organizationOf(t, organizationId))!.extraStorageUnits).toBe(1);
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect((await organizationOf(t, organizationId))!.extraStorageUnits).toBe(0);
});

/** Dana's organization on Pro with the storage add-on, paid by card. */
async function proWithStorage(t: ReturnType<typeof setup>, stub: ReturnType<typeof autumnStub>) {
  const { organizationId } = await organization(t);
  await pricesRead(t);
  const change = (plan: "free" | "plus" | "pro") => changePlan(t, organizationId, plan);
  const addOn = (enabled: boolean) => t.withIdentity(dana).action(api.billing.setStorageAddOn, { organizationId, enabled, returnUrl: RETURN });
  stub.completeCheckout((await change("pro")).url!);
  await webhook(t, organizationId);
  await addOn(true);
  expect((await organizationOf(t, organizationId))!.extraStorageUnits).toBe(1);
  // A copy: a matcher must never write into the stub.
  const storages = () => structuredClone(stub.customer(organizationId)!.subscriptions.filter((s) => s.plan_id === "storage_100gb"));
  const storage = () => storages()[0];
  const updatesOf = (planId: string) =>
    stub.requests.filter((request) => request.path === "billing.update" && (request.body.plan_id ?? stub.planOf(request.body.subscription_id)) === planId).map((request) => request.body);
  const updates = (planId: string) => updatesOf(planId).map((body) => body.cancel_action);
  const status = () => t.withIdentity(dana).query(api.billing.status, { organizationId });
  /** A second storage add-on, attached in Autumn's dashboard: Autumn stacks it as its own subscription. */
  const secondAddOn = async () => {
    stub.attachOutside(organizationId, "storage_100gb");
    await webhook(t, organizationId);
    expect(await organizationOf(t, organizationId)).toMatchObject({ extraStorageUnits: 2 });
    expect(await status()).toMatchObject({ storageAddOns: 2 });
  };
  return { organizationId, change, addOn, storage, storages, updates, updatesOf, status, secondAddOn };
}

test("two storage add-ons stack to 200 GB, and removing storage cancels one at a time, each by its own subscription", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId, addOn, storages, updatesOf, status, secondAddOn } = await proWithStorage(t, stub);
  await secondAddOn();
  // Each add-on bills on its own period: the second was bought nine days later.
  const [first, second] = stub.customer(organizationId)!.subscriptions.filter((s) => s.plan_id === "storage_100gb");
  second!.current_period_end = first!.current_period_end! + 9 * 86_400_000;
  await webhook(t, organizationId);
  const ending = () => storages().filter((s) => s.canceled_at !== null).map((s) => ({ endsAt: s.current_period_end }));
  expect(await status()).toMatchObject({ storageAddOns: 2, endingStorageAddOns: [] });
  // Storage is added one add-on at a time: one renews already.
  expect(await addOn(true)).toEqual({ url: null });
  expect(storages()).toHaveLength(2);

  await addOn(false);
  expect(storages().map((s) => s.canceled_at === null).sort()).toEqual([false, true]);
  // The count shows what renews; the storage lasts until that add-on's period ends, which the status says.
  expect(ending()).toHaveLength(1);
  expect(await status()).toMatchObject({ storageAddOns: 1, endingStorageAddOns: ending() });
  expect(await organizationOf(t, organizationId)).toMatchObject({ extraStorageUnits: 2 });

  await addOn(false);
  expect(storages().map((s) => s.canceled_at === null)).toEqual([false, false]);
  expect(await status()).toMatchObject({ storageAddOns: 0 });
  expect(new Set((await status())!.endingStorageAddOns!.map((one) => one.endsAt))).toEqual(new Set([first!.current_period_end, second!.current_period_end]));
  const canceled = updatesOf("storage_100gb").map((body) => body.subscription_id);
  expect(new Set(canceled)).toEqual(new Set(storages().map((s) => s.id)));
  // Nothing more to remove.
  await addOn(false);
  expect(updatesOf("storage_100gb")).toHaveLength(2);

  // Adding storage back undoes one cancel before buying anything.
  await addOn(true);
  expect(await status()).toMatchObject({ storageAddOns: 1 });
  expect(storages()).toHaveLength(2);
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 1 });
  expect(await status()).toMatchObject({ storageAddOns: 1 });
});

test("leaving Pro ends every storage add-on with it, and keeping Pro restores those, not one the admin removed", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId, change, addOn, storages, updates, status, secondAddOn } = await proWithStorage(t, stub);
  await secondAddOn();
  const renewing = () => storages().filter((s) => s.canceled_at === null).length;

  await change("plus");
  expect(updates("storage_100gb")).toEqual(["cancel_end_of_cycle", "cancel_end_of_cycle"]);
  expect(renewing()).toBe(0);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 2 });
  await change("pro");
  expect(updates("storage_100gb")).toEqual(["cancel_end_of_cycle", "cancel_end_of_cycle", "uncancel", "uncancel"]);
  expect(renewing()).toBe(2);
  expect(await status()).toMatchObject({ storageAddOns: 2 });

  // The admin removes one; leaving and keeping Pro brings back only the other.
  await addOn(false);
  await change("free");
  expect(renewing()).toBe(0);
  await change("pro");
  expect(renewing()).toBe(1);
  expect(await status()).toMatchObject({ plan: "pro", storageAddOns: 1 });
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 1 });

  // Leaving for good ends what is left with Pro.
  await secondAddOn();
  await change("plus");
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(storages()).toEqual([]);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "plus", extraStorageUnits: 0 });
});

for (const lower of ["plus", "free"] as const) {
  test(`Pro with extra storage to ${lower} ends the storage add-on with Pro, at the period's end`, async () => {
    const stub = billingOn();
    const t = setup();
    const { organizationId, change, storage, updates } = await proWithStorage(t, stub);

    expect(await change(lower)).toEqual({ url: null });
    expect(updates("storage_100gb")).toEqual(["cancel_end_of_cycle"]);
    // Until then the organization keeps Pro and its storage.
    expect(storage()).toMatchObject({ status: "active", canceled_at: expect.any(Number) });
    expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 1 });
    // Choosing the lower plan again changes nothing more.
    await change(lower);
    expect(updates("storage_100gb")).toEqual(["cancel_end_of_cycle"]);

    stub.endPeriod(organizationId);
    await webhook(t, organizationId);
    expect(storage()).toBeUndefined();
    expect(await organizationOf(t, organizationId)).toMatchObject({ plan: lower, extraStorageUnits: 0 });
  });
}

test("keeping Pro after choosing a lower plan keeps the storage add-on, unless the admin removed it themselves", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId, change, addOn, storage, updates } = await proWithStorage(t, stub);

  await change("plus");
  // Storage can't be added back to a plan that is ending.
  await expect(addOn(true)).rejects.toThrow("Keep Pro");
  expect(await change("pro")).toEqual({ url: null });
  expect(updates("pro")).toEqual(["uncancel"]);
  expect(updates("storage_100gb")).toEqual(["cancel_end_of_cycle", "uncancel"]);
  expect(storage()).toMatchObject({ status: "active", canceled_at: null });
  expect(await t.withIdentity(dana).query(api.billing.status, { organizationId })).toMatchObject({ plan: "pro", subscription: { scheduledPlan: null }, storageAddOns: 1 });
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 1 });

  // Free then Pro again restores it too.
  await change("free");
  await change("pro");
  expect(storage()).toMatchObject({ canceled_at: null });

  // Storage the admin removed stays removed when they keep Pro.
  await change("plus");
  await addOn(false);
  await change("pro");
  expect(storage()).toMatchObject({ canceled_at: expect.any(Number) });
  await addOn(false);
  await change("free");
  await change("pro");
  expect(storage()).toMatchObject({ canceled_at: expect.any(Number) });
  stub.endPeriod(organizationId);
  await webhook(t, organizationId);
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "pro", extraStorageUnits: 0 });
});

test("an organization that leaves Pro through Autumn has its storage add-on canceled at once, and the webhook retried until it is", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId, storage, updates } = await proWithStorage(t, stub);
  const errors: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    // Stripe gives up on Pro; the add-on would keep billing for storage Free doesn't use.
    stub.expire(organizationId);
    stub.fail("billing.update", 500);
    expect(await webhook(t, organizationId)).toBe(503);
    expect((await organizationOf(t, organizationId))!.plan).toBe("free");
    expect(storage()).toMatchObject({ status: "active", canceled_at: null });

    expect(await webhook(t, organizationId)).toBe(204);
    expect(updates("storage_100gb")).toEqual(["cancel_immediately", "cancel_immediately"]);
    expect(storage()).toBeUndefined();
    expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "free", extraStorageUnits: 0 });
    expect(errors.filter((line) => line.includes(organizationId) && line.includes("storage add-on"))).toHaveLength(2);

    // Nothing more to cancel afterwards, from a webhook or the daily check.
    await webhook(t, organizationId);
    await t.mutation(internal.billing.reconcile, {});
    await t.finishAllScheduledFunctions(() => undefined);
    expect(updates("storage_100gb")).toHaveLength(2);
  } finally {
    console.warn = warn;
  }
});

test("the daily check cancels storage add-ons left behind on Plus", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId, storage, updates, secondAddOn } = await proWithStorage(t, stub);
  await secondAddOn();
  // Moved to Plus outside Critiqs, at once, with no webhook.
  const customer = stub.customer(organizationId)!;
  customer.subscriptions = customer.subscriptions.map((s) => (s.plan_id === "pro" ? { ...s, plan_id: "plus" } : s));

  await t.mutation(internal.billing.reconcile, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect(updates("storage_100gb")).toEqual(["cancel_immediately", "cancel_immediately"]);
  expect(storage()).toBeUndefined();
  expect(await organizationOf(t, organizationId)).toMatchObject({ plan: "plus", extraStorageUnits: 0 });
});

test("the stub answers usage and unknown customers as Autumn's sandbox did", async () => {
  // ~/evidence/critiq/billing/sandbox/results.md, 2026-11-24.
  const stub = autumnStub();
  const post = async (path: string, body: Record<string, unknown>, key?: string) => {
    const headers: Record<string, string> = { Authorization: "Bearer am_sk_test_stub", "x-api-version": "2.6.0" };
    if (key !== undefined) headers["Idempotency-Key"] = key;
    const response = await stub.fetch(`https://autumn.test/v1/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, code: ((await response.json()) as { code?: string }).code };
  };
  await post("customers.get_or_create", { customer_id: "org" });
  const usage = { customer_id: "org", feature_id: "ai_credits", value: 1, overage_behavior: "overflow" };

  // Queued (the default): a repeated key is accepted again and counted once.
  for (let i = 0; i < 3; i++) expect(await post("balances.track", usage, "key-1")).toEqual({ status: 202, code: undefined });
  expect(stub.tracked.map((one) => one.key)).toEqual(["key-1"]);
  // Only async:false refuses a repeated key.
  expect((await post("balances.track", { ...usage, async: false }, "key-2")).status).toBe(200);
  expect(await post("balances.track", { ...usage, async: false }, "key-2")).toEqual({ status: 409, code: "duplicate_idempotency_key" });
  expect(stub.customer("org")!.creditsUsed).toBe(2);

  // An unknown customer's usage is accepted and dropped; reading the customer says it doesn't exist.
  expect(await post("balances.track", { ...usage, customer_id: "nobody" }, "key-3")).toEqual({ status: 202, code: undefined });
  expect(stub.tracked).toHaveLength(2);
  expect(await post("customers.get", { customer_id: "nobody" })).toEqual({ status: 404, code: "customer_not_found" });
});

test("a paying organization's Critiqs AI credits reach Autumn once each, through failures, retries, and lost runs", async () => {
  const stub = billingOn();
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  const rows = () => t.run((ctx) => ctx.db.query("billingUsage").collect());
  const report = () => t.action(internal.billing.reportUsage, {});
  const makeDue = () => t.run(async (ctx) => {
    for (const row of await ctx.db.query("billingUsage").collect()) if (row.status === "pending") await ctx.db.patch(row._id, { dueAt: 0 });
  });

  // Free organizations' credits are included, not billed, and nor are an operator's comped plan's: Autumn has no subscription to bill.
  await charge(t, projectId, 30);
  await t.mutation(internal.plans.assign, { organizationId, plan: "plus" });
  await charge(t, projectId, 30);
  expect(await rows()).toEqual([]);

  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);
  await charge(t, projectId, 7);
  await charge(t, projectId, 11);
  await report();
  await report();
  expect(stub.tracked.map(({ customerId, featureId, value }) => ({ customerId, featureId, value }))).toEqual([
    { customerId: organizationId, featureId: "ai_credits", value: 7 },
    { customerId: organizationId, featureId: "ai_credits", value: 11 },
  ]);
  const [first, second] = await rows();
  expect(stub.tracked.map((one) => one.key)).toEqual([usageKey(first!._id), usageKey(second!._id)]);
  expect(stub.tracked.map((one) => one.timestamp)).toEqual([first!.createdAt, second!.createdAt]);
  expect((await rows()).map((row) => row.status)).toEqual(["sent", "sent"]);

  // Autumn fails, then the report goes through later, once.
  await charge(t, projectId, 5);
  stub.fail("balances.track", 503);
  await report();
  const [, , retried] = await rows();
  expect(retried).toMatchObject({ status: "pending", attempts: 1, reason: "Autumn balances.track answered 503." });
  expect(retried!.dueAt).toBeGreaterThan(Date.now());
  await report();
  expect(stub.tracked).toHaveLength(2);
  await makeDue();
  await report();
  expect(stub.tracked.map((one) => one.value)).toEqual([7, 11, 5]);

  // A run that sent but never recorded it: the next one sends the same key, which Autumn already has.
  await charge(t, projectId, 3);
  await report();
  await t.run(async (ctx) => {
    const lost = (await ctx.db.query("billingUsage").collect()).at(-1)!;
    await ctx.db.patch(lost._id, { status: "sending", leaseUntil: 0, claimToken: "lost-run" });
  });
  await report();
  expect(stub.tracked.map((one) => one.value)).toEqual([7, 11, 5, 3]);
  expect((await rows()).map((row) => row.status)).toEqual(["sent", "sent", "sent", "sent"]);
  expect(stub.requests.filter((request) => request.path === "balances.track")).toHaveLength(6);
  // Autumn answers a key it already has with 409 only for async:false tracking; that counts as sent too.
  await charge(t, projectId, 4);
  stub.fail("balances.track", 409, 1, "duplicate_idempotency_key");
  await report();
  expect((await rows()).at(-1)).toMatchObject({ status: "sent" });

  // A report Autumn refuses for good is kept as failed, not sent again.
  await charge(t, projectId, 2);
  stub.fail("balances.track", 400);
  await report();
  await makeDue();
  await report();
  expect((await rows()).at(-1)).toMatchObject({ status: "failed", reason: "Autumn balances.track answered 400." });
  expect(stub.tracked).toHaveLength(4);
});

test("usage is sent as soon as it is recorded, not only by the minute's run", async () => {
  // Autumn counts usage in the period current when it arrives, so waiting moves usage near the monthly reset into the next month.
  const stub = billingOn();
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  stub.completeCheckout((await t.withIdentity(dana).action(api.billing.changePlan, { organizationId, from: "free", plan: "plus", returnUrl: RETURN })).url!);
  await webhook(t, organizationId);

  await charge(t, projectId, 6);
  await t.finishAllScheduledFunctions(() => undefined);
  expect(stub.tracked.map(({ value }) => value)).toEqual([6]);
  expect((await t.run((ctx) => ctx.db.query("billingUsage").collect())).map((row) => row.status)).toEqual(["sent"]);
});

test("usage reaches Autumn at the time it was used, and in full past the plan's included credits", async () => {
  const stub = billingOn();
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);

  // Reported an hour late, it still counts when it was used.
  await charge(t, projectId, 1_500);
  const usedAt = Date.now() - 60 * 60_000;
  await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("billingUsage").unique())!._id, { createdAt: usedAt }));
  await t.action(internal.billing.reportUsage, {});
  // Plus includes 2,000 credits; what goes past them is billed, not dropped.
  await charge(t, projectId, 700);
  await t.action(internal.billing.reportUsage, {});
  expect(stub.tracked.map(({ value, timestamp }) => ({ value, timestamp }))).toEqual([
    { value: 1_500, timestamp: usedAt },
    { value: 700, timestamp: expect.any(Number) },
  ]);
  expect(stub.requests.filter((request) => request.path === "balances.track").every((request) => request.body.overage_behavior === "overflow")).toBe(true);
});

test("a report tried but not sent within 20 hours is never sent again, and stays failed where an operator sees what it was worth", async () => {
  const stub = billingOn();
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);
  const late = Date.now() - 21 * 60 * 60_000;

  // One waited too long to be sent, and one was claimed by a run that never finished.
  await charge(t, projectId, 4);
  await charge(t, projectId, 6);
  await t.run(async (ctx) => {
    const [waiting, stuck] = await ctx.db.query("billingUsage").collect();
    await ctx.db.patch(waiting!._id, { createdAt: late, attempts: 3 });
    await ctx.db.patch(stuck!._id, { createdAt: late, attempts: 1, status: "sending", leaseUntil: 0, claimToken: "lost-run" });
  });
  await charge(t, projectId, 9);
  await t.action(internal.billing.reportUsage, {});

  expect(stub.tracked.map((one) => one.value)).toEqual([9]);
  expect((await t.run((ctx) => ctx.db.query("billingUsage").collect())).map((row) => row.status)).toEqual(["failed", "failed", "sent"]);
  expect(await t.query(internal.billing.failedUsage, {})).toEqual({
    reports: 2,
    credits: 10,
    organizations: [{ organizationId, reports: 2, credits: 10 }],
    rows: [
      expect.objectContaining({ organizationId, credits: 4, createdAt: late, reason: expect.stringContaining("20 hours") }),
      expect.objectContaining({ organizationId, credits: 6, createdAt: late, reason: expect.stringContaining("20 hours") }),
    ],
  });
});

test("a report never tried is sent however old, at its time, once; an old one already tried stays failed", async () => {
  const stub = billingOn();
  const t = setup();
  const { projectId, organizationId } = await organization(t);
  stub.completeCheckout((await changePlan(t, organizationId, "plus")).url!);
  await webhook(t, organizationId);
  const old = Date.now() - 25 * 60 * 60_000;

  await charge(t, projectId, 8);
  await charge(t, projectId, 12);
  await t.run(async (ctx) => {
    const [untried, tried] = await ctx.db.query("billingUsage").collect();
    await ctx.db.patch(untried!._id, { createdAt: old, attempts: 0 });
    await ctx.db.patch(tried!._id, { createdAt: old, attempts: 1, dueAt: 0 });
  });
  await t.action(internal.billing.reportUsage, {});
  await t.action(internal.billing.reportUsage, {});

  const [untried, tried] = await t.run((ctx) => ctx.db.query("billingUsage").collect());
  expect(stub.tracked.map(({ value, timestamp, key }) => ({ value, timestamp, key }))).toEqual([{ value: 8, timestamp: old, key: usageKey(untried!._id) }]);
  expect([untried!.status, tried!.status]).toEqual(["sent", "failed"]);
  expect(await t.query(internal.billing.failedUsage, {})).toEqual({
    reports: 1,
    credits: 12,
    organizations: [{ organizationId, reports: 1, credits: 12 }],
    rows: [expect.objectContaining({ id: tried!._id, credits: 12, createdAt: old, attempts: 1, reason: expect.stringContaining("20 hours") })],
  });
});

const statusPrices = async (t: ReturnType<typeof setup>, organizationId: Id<"organizations">) =>
  (await t.withIdentity(lee).query(api.billing.status, { organizationId }))!.prices;
const catalogReads = (stub: ReturnType<typeof autumnStub>) => stub.requests.filter((request) => request.path === "plans.list").length;

test("prices come from Autumn's catalog: read when the page first needs them, and again by the daily check", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  expect(await statusPrices(t, organizationId)).toBeNull();

  await t.withIdentity(lee).action(api.billing.loadPrices, {});
  expect(await statusPrices(t, organizationId)).toEqual({
    plans: {
      free: { monthly: 0, extraCredits: null },
      plus: { monthly: 20, extraCredits: { amount: 1, credits: 100 } },
      pro: { monthly: 100, extraCredits: { amount: 1, credits: 100 } },
    },
    storageAddOn: { gb: 100, monthly: 10 },
  });

  // The operator changes prices in Autumn. The page keeps the prices it has until the daily check reads them again.
  stub.plans.find((plan) => plan.id === "plus")!.price!.amount = 25;
  stub.plans.find((plan) => plan.id === "pro")!.items[0]!.price!.amount = 2;
  stub.plans.find((plan) => plan.id === "storage_100gb")!.price!.amount = 15;
  await t.withIdentity(lee).action(api.billing.loadPrices, {});
  expect((await statusPrices(t, organizationId))!.plans.plus.monthly).toBe(20);
  await t.mutation(internal.billing.reconcile, {});
  await t.finishAllScheduledFunctions(() => undefined);
  const prices = await statusPrices(t, organizationId);
  expect(prices!.plans.plus.monthly).toBe(25);
  expect(prices!.plans.pro.extraCredits).toEqual({ amount: 2, credits: 100 });
  expect(prices!.storageAddOn).toEqual({ gb: 100, monthly: 15 });

  // A catalog that can't be read, or that lacks a plan, keeps the prices last read.
  stub.fail("plans.list", 500);
  await t.mutation(internal.billing.reconcile, {});
  await t.finishAllScheduledFunctions(() => undefined);
  stub.plans.splice(stub.plans.findIndex((plan) => plan.id === "pro"), 1);
  await t.mutation(internal.billing.reconcile, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect((await statusPrices(t, organizationId))!.plans.plus.monthly).toBe(25);
});

test("while Autumn's catalog can't be read, the page shows no prices, and opening it reaches Autumn at most once a minute", async () => {
  const stub = billingOn();
  const t = setup();
  const { organizationId } = await organization(t);
  stub.fail("plans.list", 503, 2);
  await t.withIdentity(lee).action(api.billing.loadPrices, {});
  await t.withIdentity(dana).action(api.billing.loadPrices, {});
  expect(catalogReads(stub)).toBe(1);
  expect(await statusPrices(t, organizationId)).toBeNull();
  await expect(t.action(api.billing.loadPrices, {})).rejects.toThrow("Sign in");

  const later = Date.now() + 61_000;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    await t.withIdentity(lee).action(api.billing.loadPrices, {});
    expect(await statusPrices(t, organizationId)).toBeNull();
    Date.now = () => later + 61_000;
    await t.withIdentity(lee).action(api.billing.loadPrices, {});
  } finally {
    Date.now = realNow;
  }
  expect(catalogReads(stub)).toBe(3);
  expect((await statusPrices(t, organizationId))!.plans.pro.monthly).toBe(100);
});
