import { expect, test } from "bun:test";
import { pricesOf, retryAt } from "../convex/lib/billing";

const HOUR = 60 * 60_000;

test("usage reports back off up to an hour apart, and stop while Autumn still remembers their key", () => {
  const created = 0;
  expect(retryAt(1, created, 0)).toBe(60_000);
  expect(retryAt(3, created, 0)).toBe(4 * 60_000);
  expect(retryAt(12, created, 5 * HOUR)).toBe(6 * HOUR);
  expect(retryAt(30, created, 19 * HOUR)).toBe(20 * HOUR);
  expect(retryAt(30, created, 19.5 * HOUR)).toBeNull();
});

/** Autumn's sandbox `plans.list` for Critiqs Cloud, as read back on 2026-11-24, trimmed of IDs. */
const SANDBOX_CATALOG = [
  { id: "free", name: "Free", group: null, add_on: false, auto_enable: true, price: null, items: [{ feature_id: "ai_credits", included: 200, unlimited: false, reset: { interval: "month" }, price: null, display: { primary_text: "200 Critiqs AI credits" } }], archived: false },
  {
    id: "plus", name: "Plus", group: null, add_on: false, auto_enable: false,
    price: { amount: 20, interval: "month", display: { primary_text: "$20", secondary_text: "per month" } },
    items: [{ feature_id: "ai_credits", included: 2000, unlimited: false, reset: { interval: "month" }, price: { amount: 1, interval: "month", billing_units: 100, billing_method: "usage_based", max_purchase: null } }],
    config: { ignore_past_due: false, anchor_to_month_start: true },
  },
  {
    id: "pro", name: "Pro", group: null, add_on: false, auto_enable: false,
    price: { amount: 100, interval: "month" },
    items: [{ feature_id: "ai_credits", included: 10000, unlimited: false, reset: { interval: "month" }, price: { amount: 1, interval: "month", billing_units: 100, billing_method: "usage_based", max_purchase: null } }],
  },
  {
    id: "storage_100gb", name: "Extra storage (100 GB)", group: null, add_on: true, auto_enable: false,
    price: { amount: 10, interval: "month" },
    items: [{ feature_id: "extra_storage_gb", included: 100, unlimited: false, reset: null, price: null }],
  },
];

test("prices are read from Autumn's catalog as the sandbox returns it, or not at all when one is missing", () => {
  expect(pricesOf(SANDBOX_CATALOG)).toEqual({
    plans: {
      free: { monthly: 0, extraCredits: null },
      plus: { monthly: 20, extraCredits: { amount: 1, credits: 100 } },
      pro: { monthly: 100, extraCredits: { amount: 1, credits: 100 } },
    },
    storageAddOn: { gb: 100, monthly: 10 },
  });
  const without = (id: string, change: Record<string, unknown>) => SANDBOX_CATALOG.map((plan) => (plan.id === id ? { ...plan, ...change } : plan));
  expect(pricesOf(without("pro", { price: null }))).toBeNull();
  expect(pricesOf(without("plus", { price: { amount: 200, interval: "year" } }))).toBeNull();
  expect(pricesOf(without("storage_100gb", { items: [] }))).toBeNull();
  expect(pricesOf(SANDBOX_CATALOG.filter((plan) => plan.id !== "free"))).toBeNull();
  expect(pricesOf([])).toBeNull();
});
