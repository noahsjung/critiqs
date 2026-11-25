import { expect, test } from "bun:test";
import { alertEmail } from "../src/plan-alerts.ts";

test("the included-credits email names no price: extra credits are billed at the plan's rate", () => {
  const alert = { kind: "included" as const, month: "2026-11", planLabel: "Plus", included: 2_000 };
  const capped = alertEmail({ ...alert, overage: { cap: 2_000 } }, "Acme", null);
  const uncapped = alertEmail({ ...alert, overage: { cap: null } }, "Acme", null);
  expect(capped.text.split("\n\n")[1]).toBe(
    "Critiqs AI keeps working. Extra credits are billed at your plan's rate, up to 2,000 extra credits this month. An admin can change that cap.",
  );
  expect(uncapped.text.split("\n\n")[1]).toBe("Critiqs AI keeps working. Extra credits are billed at your plan's rate, with no cap. An admin can set a cap.");
  for (const email of [capped, uncapped]) expect(`${email.text}${email.html}`).not.toContain("$");
});
