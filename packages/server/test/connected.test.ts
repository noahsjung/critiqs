import { expect, test } from "bun:test";
import * as onboarding from "../src/onboarding.ts";

// What the Connected route decides before it calls anything that reads or
// writes: a report that can't count is dropped there, at no further cost.

test("a report that can't count is dropped before any lookup; one that may count names its canonical origin", () => {
  const shape = (body: string, origin: string | null) => onboarding.connectionReport(body, origin);
  for (const [body, origin] of [
    ["", "https://acme.example"],
    ["p_123", null],
    ["p_123", "null"],
    ["p_123", "chrome-extension://pfdpnmmiemejphfghkalofichdcoandg"],
    ["p_123", "file://"],
    ["p_123", "https://acme.example/path"],
    ["p_123", "HTTPS://ACME.EXAMPLE"],
    ["p 123", "https://acme.example"],
    ["x".repeat(65), "https://acme.example"],
  ] as const) {
    expect([body.slice(0, 10), origin, shape(body, origin)]).toEqual([body.slice(0, 10), origin, null]);
  }
  expect(shape(" p_123\n", "https://acme.example")).toEqual({ projectId: "p_123", origin: "https://acme.example" });
  expect(shape("jd7abc123", "https://acme-proto.vercel.app.")).toEqual({ projectId: "jd7abc123", origin: "https://acme-proto.vercel.app" });
});
