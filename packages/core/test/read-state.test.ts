import { expect, test } from "bun:test";
import { isUnread } from "../src/read-state.ts";

test("a thread never opened is unread", () => {
  expect(isUnread(100, null)).toBe(true);
});

test("viewing the newest message marks the thread read", () => {
  expect(isUnread(100, { lastReadAt: 100, manualUnread: false })).toBe(false);
});

test("a newer reply makes the thread unread again", () => {
  expect(isUnread(200, { lastReadAt: 100, manualUnread: false })).toBe(true);
});

test("Mark unread keeps a viewed thread unread", () => {
  expect(isUnread(100, { lastReadAt: 100, manualUnread: true })).toBe(true);
});
