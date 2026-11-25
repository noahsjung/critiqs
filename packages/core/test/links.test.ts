import { expect, test } from "bun:test";
import { buildLink, parseLink, removeLink } from "../src/links.ts";

test("links keep the app's path and parameters on the current origin", () => {
  const link = buildLink("https://proto.example", "http://localhost:5173/users/alex?tab=permissions#top", {
    threadId: "t1",
    messageId: null,
  });
  expect(link).toBe("https://proto.example/users/alex?tab=permissions&critiqs=t1#top");
});

test("reply links identify both the thread and the message", () => {
  const link = buildLink("https://proto.example", "https://proto.example/", { threadId: "t1", messageId: "m2" });
  expect(parseLink(link)).toEqual({ threadId: "t1", messageId: "m2" });
  expect(parseLink("https://proto.example/?critiqs=t1")).toEqual({ threadId: "t1", messageId: null });
  expect(parseLink("https://proto.example/?tab=a")).toBeNull();
});

test("removing a link leaves other parameters", () => {
  expect(removeLink("https://proto.example/users?tab=a&critiqs=t1.m2")).toBe("https://proto.example/users?tab=a");
});

test("links never leave the current origin", () => {
  const link = buildLink("https://proto.example", "https://old.example//evil.example/phish", { threadId: "t1", messageId: null });
  expect(new URL(link).origin).toBe("https://proto.example");
});
