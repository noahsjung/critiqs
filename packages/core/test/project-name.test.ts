import { expect, test } from "bun:test";
import { MAX_PROJECT_NAME_LENGTH, shortenProjectName } from "../src/project-name.ts";

test("a project name is limited to 200 characters, as the onboarding name field is", () => {
  expect(MAX_PROJECT_NAME_LENGTH).toBe(200);
});

test("names that fit are unchanged", () => {
  expect(shortenProjectName("Admin prototype")).toBe("Admin prototype");
  expect(shortenProjectName("x".repeat(200))).toBe("x".repeat(200));
  expect(shortenProjectName("😀".repeat(100))).toBe("😀".repeat(100));
});

test("a longer name keeps its start and gains a mark computed from the whole name, within the limit", () => {
  const shortened = shortenProjectName("x".repeat(900_000));
  expect(shortened).toMatch(/^x{187}… [0-9a-z]{11}$/);
  expect(shortened.length).toBeLessThanOrEqual(MAX_PROJECT_NAME_LENGTH);
  // The same name always shortens the same way.
  expect(shortenProjectName("x".repeat(900_000))).toBe(shortened);
});

test("two long names that share their first 200 characters stay different, and neither equals that start", () => {
  const start = "acme-platform/".padEnd(200, "a");
  const one = shortenProjectName(`${start}-web`);
  const two = shortenProjectName(`${start}-admin`);
  expect(one).not.toBe(two);
  expect([one, two]).not.toContain(start);
  expect([one, two]).not.toContain(shortenProjectName(start));
});

test("shortening never splits a character made of two code units, nor keeps spaces before the mark", () => {
  expect(shortenProjectName(`${"x".repeat(186)}😀${"y".repeat(20)}`)).toMatch(/^x{186}… [0-9a-z]{11}$/);
  expect(shortenProjectName(`${"x".repeat(180)}       ${"y".repeat(20)}`)).toMatch(/^x{180}… [0-9a-z]{11}$/);
  expect(shortenProjectName("😀".repeat(150))).toMatch(new RegExp(`^(?:😀){93}… [0-9a-z]{11}$`));
});
