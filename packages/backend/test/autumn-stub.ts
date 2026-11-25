// A stand-in for Autumn's API (version 2.6.0) with the request and response
// shapes Critiqs relies on, answering as Autumn's sandbox did on 2026-11-24
// (~/evidence/critiq/billing/sandbox/results.md).

const PERIOD_MS = 30 * 24 * 60 * 60_000;

interface Subscription {
  /** Each attach is its own subscription: two `storage_100gb` attaches are two rows, 200 GB. */
  id: string;
  plan_id: string;
  add_on: boolean;
  status: "active" | "scheduled";
  past_due: boolean;
  canceled_at: number | null;
  current_period_end: number | null;
}

interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  card: boolean;
  subscriptions: Subscription[];
  /** Critiqs AI credits deducted this period. */
  creditsUsed: number;
}

/** A plan in Autumn's catalog, in the shape `plans.list` returns (read back from the sandbox), trimmed to what Critiqs reads. */
export interface StubPlan {
  id: string;
  name: string;
  add_on: boolean;
  auto_enable: boolean;
  price: { amount: number; interval: "month" } | null;
  items: { feature_id: string; included: number; price: { amount: number; billing_units: number; billing_method: "usage_based"; interval: "month" } | null }[];
}

/** Critiqs Cloud's catalog as it is in Autumn. */
function catalog(): StubPlan[] {
  const credits = (included: number, extra: boolean) => ({
    feature_id: "ai_credits",
    included,
    price: extra ? { amount: 1, billing_units: 100, billing_method: "usage_based" as const, interval: "month" as const } : null,
  });
  return [
    { id: "free", name: "Free", add_on: false, auto_enable: true, price: null, items: [credits(200, false)] },
    { id: "plus", name: "Plus", add_on: false, auto_enable: false, price: { amount: 20, interval: "month" }, items: [credits(2_000, true)] },
    { id: "pro", name: "Pro", add_on: false, auto_enable: false, price: { amount: 100, interval: "month" }, items: [credits(10_000, true)] },
    {
      id: "storage_100gb",
      name: "Extra storage (100 GB)",
      add_on: true,
      auto_enable: false,
      price: { amount: 10, interval: "month" },
      items: [{ feature_id: "extra_storage_gb", included: 100, price: null }],
    },
  ];
}

export interface StubRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

export function autumnStub(secretKey = "am_sk_test_stub") {
  const customers = new Map<string, Customer>();
  const checkouts = new Map<string, { customerId: string; planId: string; successUrl: string }>();
  const idempotencyKeys = new Set<string>();
  /** Every subscription ever created, by ID, with its plan. */
  const subscriptionPlans = new Map<string, string>();
  const requests: StubRequest[] = [];
  /** Usage recorded once per key, in order: what was deducted, and when Autumn counts it as used. */
  const tracked: { customerId: string; featureId: string; value: number; timestamp: number; key: string | null }[] = [];
  const failures: { path: string; status: number; code: string }[] = [];
  const plans = catalog();
  const catalogPlan = (id: string) => plans.find((plan) => plan.id === id);
  const priceOf = (id: string) => catalogPlan(id)?.price?.amount ?? 0;

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const now = () => Date.now();
  const active = (customer: Customer) => customer.subscriptions.filter((s) => s.status === "active");
  const mainPlan = (customer: Customer) => active(customer).find((s) => !s.add_on) ?? null;
  const creditsGranted = (customer: Customer) => catalogPlan(mainPlan(customer)?.plan_id ?? "free")!.items.find((item) => item.feature_id === "ai_credits")!.included;

  function view(customer: Customer) {
    const storage = active(customer).filter((s) => s.plan_id === "storage_100gb").length * 100;
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      env: "sandbox",
      subscriptions: customer.subscriptions.map((s) => ({ ...s, quantity: 1, started_at: 0, current_period_start: 0 })),
      purchases: [],
      balances: {
        ai_credits: { feature_id: "ai_credits", granted: creditsGranted(customer), usage: customer.creditsUsed, remaining: Math.max(0, creditsGranted(customer) - customer.creditsUsed) },
        ...(storage === 0 ? {} : { extra_storage_gb: { feature_id: "extra_storage_gb", granted: storage, usage: 0, remaining: storage } }),
      },
      flags: {},
    };
  }

  function subscriptionOf(planId: string, status: Subscription["status"]): Subscription {
    const id = `cus_prod_stub_${subscriptionPlans.size + 1}`;
    subscriptionPlans.set(id, planId);
    return { id, plan_id: planId, add_on: planId === "storage_100gb", status, past_due: false, canceled_at: null, current_period_end: status === "active" ? now() + PERIOD_MS : null };
  }

  function activate(customer: Customer, planId: string) {
    const subscription = subscriptionOf(planId, "active");
    if (subscription.add_on) customer.subscriptions.push(subscription);
    else customer.subscriptions = [...customer.subscriptions.filter((s) => s.add_on), subscription];
  }

  async function handle(path: string, headers: Headers, body: Record<string, any>): Promise<Response> {
    requests.push({ path, headers: Object.fromEntries(headers.entries()), body });
    if (headers.get("authorization") !== `Bearer ${secretKey}`) return json({ code: "unauthorized", message: "Invalid secret key" }, 401);
    if (headers.get("x-api-version") !== "2.6.0") return json({ code: "invalid_version" }, 400);
    const failure = failures.findIndex((f) => f.path === path);
    if (failure !== -1) {
      const { status, code } = failures.splice(failure, 1)[0]!;
      return json({ code }, status);
    }
    const key = headers.get("idempotency-key");
    if (key !== null && idempotencyKeys.has(key)) {
      // Queued tracking (the default) accepts a key it already has again and counts it once; only async:false refuses it.
      if (path === "balances.track" && body.async !== false) return json({ customer_id: body.customer_id, value: body.value, balance: null }, 202);
      return json({ code: "duplicate_idempotency_key", message: `Another request with idempotency key ${key} has already been received` }, 409);
    }
    if (key !== null) idempotencyKeys.add(key);
    const customer = customers.get(body.customer_id);
    switch (path) {
      case "customers.get_or_create": {
        if (customer !== undefined) return json(view(customer));
        const created: Customer = { id: body.customer_id, name: body.name ?? null, email: body.email ?? null, card: false, subscriptions: [], creditsUsed: 0 };
        activate(created, "free");
        created.subscriptions[0]!.current_period_end = null;
        customers.set(created.id, created);
        return json(view(created));
      }
      case "customers.get":
        return customer === undefined ? json({ code: "customer_not_found", message: "Customer not found" }, 404) : json(view(customer));
      case "billing.attach": {
        if (customer === undefined) return json({ code: "customer_not_found" }, 404);
        const planId = body.plan_id as string;
        if (!customer.card || body.redirect_mode === "always") {
          const id = `cs_test_${checkouts.size + 1}`;
          checkouts.set(id, { customerId: customer.id, planId, successUrl: body.success_url });
          return json({ customer_id: customer.id, payment_url: `https://checkout.stripe.com/c/pay/${id}`, required_action: { code: "payment_method_required" } });
        }
        const current = mainPlan(customer);
        if (planId !== "storage_100gb" && current !== null && priceOf(planId) < priceOf(current.plan_id)) {
          // A downgrade ends the current plan with its period and starts the lower one then.
          current.canceled_at = now();
          customer.subscriptions = customer.subscriptions.filter((s) => s.status !== "scheduled");
          customer.subscriptions.push(subscriptionOf(planId, "scheduled"));
        } else {
          activate(customer, planId);
        }
        return json({ customer_id: customer.id, payment_url: null });
      }
      case "billing.update": {
        if (customer === undefined) return json({ code: "customer_not_found" }, 404);
        if (typeof body.plan_id !== "string" && typeof body.subscription_id !== "string") {
          return json({ code: "invalid_request", message: "plan_id or subscription_id is required: the customer has several plans" }, 400);
        }
        const action = body.cancel_action;
        if (action !== "cancel_end_of_cycle" && action !== "cancel_immediately" && action !== "uncancel") return json({ code: "invalid_cancel_action" }, 400);
        // By plan, the first of several add-ons with that plan, as the sandbox did; by subscription, exactly that one.
        const subscription = active(customer).find((s) => (typeof body.subscription_id === "string" ? s.id === body.subscription_id : s.plan_id === body.plan_id));
        if (subscription === undefined) return json({ code: "plan_not_found" }, 400);
        if (action === "cancel_end_of_cycle") subscription.canceled_at = now();
        if (action === "cancel_immediately") {
          // Ends now, with a prorated refund; it can't be undone.
          customer.subscriptions = customer.subscriptions.filter((s) => s !== subscription && (subscription.add_on || s.status !== "scheduled"));
          if (mainPlan(customer) === null) activate(customer, "free");
        }
        if (action === "uncancel") {
          // Only a pending cancel or scheduled change can be undone.
          if (subscription.canceled_at === null) return json({ code: "nothing_to_uncancel" }, 400);
          subscription.canceled_at = null;
          if (!subscription.add_on) customer.subscriptions = customer.subscriptions.filter((s) => s.status !== "scheduled");
        }
        return json({ customer_id: customer.id, payment_url: null });
      }
      case "billing.open_customer_portal":
        if (customer === undefined) return json({ code: "customer_not_found" }, 404);
        return json({ customer_id: customer.id, url: `https://billing.stripe.com/p/session/test_${customer.id}?return=${encodeURIComponent(body.return_url)}` });
      case "balances.track": {
        // Usage for a customer Autumn doesn't have is accepted, then dropped.
        if (customer === undefined) return json({ customer_id: body.customer_id, value: body.value, balance: null }, 202);
        const overage = body.overage_behavior ?? "cap";
        if (overage !== "cap" && overage !== "overflow") return json({ code: "invalid_overage_behavior" }, 400);
        if (body.timestamp !== undefined && typeof body.timestamp !== "number") return json({ code: "invalid_timestamp" }, 400);
        // By default Autumn deducts only what is left of the balance and drops the rest.
        const value = overage === "overflow" ? body.value : Math.min(body.value, Math.max(0, creditsGranted(customer) - customer.creditsUsed));
        customer.creditsUsed += value;
        tracked.push({ customerId: customer.id, featureId: body.feature_id, value, timestamp: body.timestamp ?? now(), key });
        return json({ customer_id: customer.id, value, balance: null }, body.async === false ? 200 : 202);
      }
      case "plans.list":
        return json({ list: structuredClone(plans) });
      default:
        return json({ code: "not_found" }, 404);
    }
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/v1\//, "");
    return await handle(path, request.headers, (await request.json().catch(() => ({}))) as Record<string, any>);
  };

  return {
    fetch,
    requests,
    tracked,
    customer: (id: string) => customers.get(id),
    /** Autumn's catalog; change a price here as the operator would in Autumn. */
    plans,
    /** The plan of a subscription, by its ID, even after it ended. */
    planOf: (subscriptionId: string) => subscriptionPlans.get(subscriptionId),
    /** A plan attached outside Critiqs, such as in Autumn's dashboard; add-ons stack. */
    attachOutside(customerId: string, planId: string) {
      activate(customers.get(customerId)!, planId);
    },
    /** The next `times` calls to `path` answer `status`, with `code`. */
    fail(path: string, status: number, times = 1, code = "injected") {
      for (let i = 0; i < times; i++) failures.push({ path, status, code });
    },
    /** The person pays on Stripe Checkout; returns where Stripe sends them back. */
    completeCheckout(paymentUrl: string): string {
      const id = paymentUrl.split("/").pop()!;
      const checkout = checkouts.get(id)!;
      const customer = customers.get(checkout.customerId)!;
      customer.card = true;
      activate(customer, checkout.planId);
      return checkout.successUrl;
    },
    /** The billing period ends: canceled plans end, scheduled ones start, Free comes back when nothing paid is left. */
    endPeriod(customerId: string) {
      const customer = customers.get(customerId)!;
      const scheduled = customer.subscriptions.find((s) => s.status === "scheduled");
      customer.subscriptions = customer.subscriptions.filter((s) => s.status === "active" && s.canceled_at === null);
      customer.creditsUsed = 0;
      if (scheduled !== undefined) activate(customer, scheduled.plan_id);
      if (mainPlan(customer) === null) activate(customer, "free");
    },
    setPastDue(customerId: string, pastDue: boolean) {
      const subscription = mainPlan(customers.get(customerId)!)!;
      subscription.past_due = pastDue;
    },
    /** Stripe gives up on a past-due subscription: it ends, and Free comes back. */
    expire(customerId: string) {
      const customer = customers.get(customerId)!;
      customer.subscriptions = customer.subscriptions.filter((s) => s.add_on);
      activate(customer, "free");
    },
  };
}

/** Signs a webhook as Svix does for Autumn. */
export async function signWebhook(secret: string, body: string, options: { id?: string; timestamp?: number } = {}) {
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor((options.timestamp ?? Date.now()) / 1000));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))));
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}`, "content-type": "application/json" };
}

/** A `billing.updated` event about a customer. */
export function billingUpdated(customerId: string) {
  return JSON.stringify({ type: "billing.updated", data: { object: "billing.updated", customer_id: customerId, plan_changes: [], tags: [] } });
}
