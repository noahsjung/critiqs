import { expect, test } from "bun:test";
import { compactRules } from "../../../scripts/update-public-suffixes.ts";
import { isPublicSuffix } from "../src/public-suffix.ts";
import { PUBLIC_SUFFIX_LIST_VERSION } from "../src/public-suffixes.ts";

test("shared hosting domains and registries' second levels are public suffixes; a site's own name isn't", () => {
  for (const host of ["vercel.app", "co.uk", "github.io", "netlify.app", "s3.amazonaws.com", "pages.dev", "com", "xn--55qx5d.cn"]) expect([host, isPublicSuffix(host)]).toEqual([host, true]);
  for (const host of ["acme.com", "acme.co.uk", "acme.vercel.app", "acme.github.io", "example.com"]) expect([host, isPublicSuffix(host)]).toEqual([host, false]);
});

test("wildcard and exception rules are read as the list means them", () => {
  // `*.ck` makes every name under ck a suffix, except `www.ck`.
  expect([isPublicSuffix("anything.ck"), isPublicSuffix("www.ck")]).toEqual([true, false]);
});

test("the compact form keeps multi-label rules of both sections, in xn-- form, and names the list's version", () => {
  const list = "// VERSION: 2026-01-01_00-00-00_UTC\n// ===BEGIN ICANN DOMAINS===\ncom\nco.uk\n*.ck\n!www.ck\n公司.cn\n// ===BEGIN PRIVATE DOMAINS===\nvercel.app\n";
  expect(compactRules(list)).toEqual({ version: "2026-01-01_00-00-00_UTC", rules: "app:vercel;ck:!www,*.;cn:xn--55qx5d;uk:co", count: 5 });
  expect(PUBLIC_SUFFIX_LIST_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}_/);
});
