import { CritiqsError, fail } from "@critiqs/server";
import { type AutumnCustomer, type AutumnSubscription, type BillingConfig, CREDITS_FEATURE } from "./billing";

const API_VERSION = "2.6.0";

/** An answer from Autumn other than success. */
export class AutumnError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AutumnError";
  }
}

/** The outcome of reporting usage: recorded (or already recorded), worth trying again, or refused for good. */
export type TrackResult = { result: "done" } | { result: "retry"; reason: string } | { result: "failed"; reason: string };

export function autumn(config: BillingConfig) {
  async function send(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return await fetch(`${config.apiUrl}/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.secretKey}`, "Content-Type": "application/json", "x-api-version": API_VERSION, ...headers },
      body: JSON.stringify(body),
    });
  }

  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await send(path, body);
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const code = typeof json?.code === "string" ? json.code : null;
      throw new AutumnError(response.status, code, `Autumn ${path} answered ${response.status}${code === null ? "" : ` (${code})`}.`);
    }
    return json ?? {};
  }

  return {
    /** The organization's customer, created with its name and an admin's email the first time. */
    getOrCreateCustomer: async (customer: { id: string; name: string; email: string | null }): Promise<AutumnCustomer> =>
      customerOf(await call("customers.get_or_create", { customer_id: customer.id, name: customer.name, ...(customer.email === null ? {} : { email: customer.email }) })),

    /** The customer as it is now, or null when Autumn has none with this ID. */
    getCustomer: async (id: string): Promise<AutumnCustomer | null> => {
      try {
        return customerOf(await call("customers.get", { customer_id: id }));
      } catch (error) {
        if (error instanceof AutumnError && (error.status === 404 || error.code === "customer_not_found")) return null;
        throw error;
      }
    },

    /**
     * Buys or switches to a plan; a payment page when the person must pay or
     * confirm there, and always with `alwaysCheckout`, even with a card on file.
     */
    attach: async (args: { customerId: string; planId: string; successUrl: string; alwaysCheckout?: boolean }): Promise<{ url: string | null }> => {
      const result = await call("billing.attach", {
        customer_id: args.customerId,
        plan_id: args.planId,
        success_url: args.successUrl,
        ...(args.alwaysCheckout === true ? { redirect_mode: "always" } : {}),
      });
      return { url: typeof result.payment_url === "string" ? result.payment_url : null };
    },

    /**
     * Cancels a plan at the end of its period or at once (refunding the rest of
     * the period), or undoes a pending cancel or scheduled change. Names one
     * subscription by its ID where the customer may have several of a plan,
     * as with storage add-ons.
     */
    update: async (
      args: { customerId: string; action: "cancel_end_of_cycle" | "cancel_immediately" | "uncancel" } & ({ planId: string } | { subscriptionId: string }),
    ): Promise<{ url: string | null }> => {
      const target = "subscriptionId" in args ? { subscription_id: args.subscriptionId } : { plan_id: args.planId };
      const result = await call("billing.update", { customer_id: args.customerId, ...target, cancel_action: args.action });
      return { url: typeof result.payment_url === "string" ? result.payment_url : null };
    },

    /** The plans in Autumn's catalog, with their prices, as `plans.list` returns them. */
    listPlans: async (): Promise<unknown[]> => {
      const result = await call("plans.list", {});
      return Array.isArray(result.list) ? result.list : [];
    },

    /** Stripe's customer portal, for payment details and invoices. */
    portal: async (args: { customerId: string; returnUrl: string }): Promise<string> => {
      const result = await call("billing.open_customer_portal", { customer_id: args.customerId, return_url: args.returnUrl });
      if (typeof result.url !== "string") throw new Error("Autumn returned no customer portal address.");
      return result.url;
    },

    /**
     * Reports Critiqs AI credits a customer used at `usedAt`, all of them even
     * past the plan's included credits: Critiqs enforces the cap itself, and
     * Autumn would otherwise drop what its balance can't cover. Tracking is
     * queued: Autumn answers 202 and counts each `key` once within its 24
     * hours, however often it is sent. Only `async: false` tracking answers a
     * repeated key with 409, which also means it was recorded. Autumn deducts
     * usage from the period current when the report arrives, whatever
     * `timestamp` says.
     */
    track: async (args: { customerId: string; credits: number; usedAt: number; key: string }): Promise<TrackResult> => {
      let response: Response;
      try {
        response = await send(
          "balances.track",
          { customer_id: args.customerId, feature_id: CREDITS_FEATURE, value: args.credits, timestamp: args.usedAt, overage_behavior: "overflow" },
          { "Idempotency-Key": args.key },
        );
      } catch (error) {
        return { result: "retry", reason: `Autumn couldn't be reached: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (response.ok || response.status === 409) return { result: "done" };
      const reason = `Autumn balances.track answered ${response.status}.`;
      return response.status === 429 || response.status >= 500 ? { result: "retry", reason } : { result: "failed", reason };
    },
  };
}

export type Autumn = ReturnType<typeof autumn>;

/** Explains an Autumn failure to the person who asked for a billing change. */
export function billingFailure(error: unknown): never {
  if (error instanceof CritiqsError) throw error;
  if (error instanceof AutumnError) {
    console.error(error.message);
    // 429: Autumn's limit of billing calls per customer. 423 (`lock_already_exists`): another change for the customer is still running.
    if (error.status === 429 || error.status === 423) fail("unavailable", "Too many billing changes at once. Wait a minute, then try again.");
  } else {
    console.error("Autumn couldn't be reached:", error instanceof Error ? error.message : String(error));
  }
  fail("unavailable", "Billing isn't available right now. Try again in a few minutes.");
}

function customerOf(json: Record<string, unknown>): AutumnCustomer {
  const subscriptions = Array.isArray(json.subscriptions) ? json.subscriptions : [];
  return {
    id: String(json.id ?? ""),
    subscriptions: subscriptions.flatMap((raw): AutumnSubscription[] => {
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.plan_id !== "string" || (row.status !== "active" && row.status !== "scheduled")) return [];
      return [
        {
          id: row.id,
          planId: row.plan_id,
          addOn: row.add_on === true,
          status: row.status,
          pastDue: row.past_due === true,
          canceledAt: typeof row.canceled_at === "number" ? row.canceled_at : null,
          currentPeriodEnd: typeof row.current_period_end === "number" ? row.current_period_end : null,
        },
      ];
    }),
  };
}
