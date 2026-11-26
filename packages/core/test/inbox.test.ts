import { expect, test } from "bun:test";
import { inboxOf } from "../src/index.ts";

test("an address's inbox drops a +tag, and for Gmail the dots, ignoring case and surrounding spaces", () => {
  const cases: [string, string][] = [
    ["sam@acme.com", "sam@acme.com"],
    ["sam+work@acme.com", "sam@acme.com"],
    ["s.am@acme.com", "s.am@acme.com"],
    ["s.a.m+work@gmail.com", "sam@gmail.com"],
    ["sam@googlemail.com", "sam@gmail.com"],
    [" Sam+X@GMail.com ", "sam@gmail.com"],
    ["Dev+B@Corp.com", "dev@corp.com"],
  ];
  for (const [email, inbox] of cases) expect([email, inboxOf(email)]).toEqual([email, inbox]);
});
