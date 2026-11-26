import { describe, expect, test } from "bun:test";
import { buildLink, isThreadPageKey, parseLink, parseThreadPageLink, removeLink, threadPageLink } from "../src/links.ts";

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

describe("thread page links", () => {
  const key = "AbCdEfGhIjKlMnOpQrSt_-";

  test("a thread page is /t/<key> on the website, keeping a base path", () => {
    expect(threadPageLink("https://critiqs.app", key)).toBe(`https://critiqs.app/t/${key}`);
    expect(threadPageLink("https://critiqs.app/", key)).toBe(`https://critiqs.app/t/${key}`);
    expect(threadPageLink("https://example.com/feedback/?x=1#top", key)).toBe(`https://example.com/feedback/t/${key}`);
    expect(threadPageLink("http://localhost:5291", key)).toBe(`http://localhost:5291/t/${key}`);
  });

  test("only a page key goes in the link, never a thread ID or a path", () => {
    expect(() => threadPageLink("https://critiqs.app", "t_0123456789abcdef0123456789abcdef")).toThrow("Not a thread page key.");
    expect(() => threadPageLink("https://critiqs.app", "../admin/AbCdEfGhIjKlMn")).toThrow("Not a thread page key.");
    expect(() => threadPageLink("javascript:alert(1)", key)).toThrow("https://");
  });

  test("a link reads back to its key only on the same website", () => {
    expect(parseThreadPageLink(`https://critiqs.app/t/${key}`, "https://critiqs.app")).toBe(key);
    expect(parseThreadPageLink(`https://critiqs.app/t/${key}/`, "https://critiqs.app")).toBe(key);
    expect(parseThreadPageLink(`https://example.com/feedback/t/${key}`, "https://example.com/feedback")).toBe(key);
    expect(parseThreadPageLink(`https://other.example/t/${key}`, "https://critiqs.app")).toBeNull();
    expect(parseThreadPageLink(`https://critiqs.app/t/${key}x`, "https://critiqs.app")).toBeNull();
    expect(parseThreadPageLink("https://critiqs.app/docs", "https://critiqs.app")).toBeNull();
    expect(parseThreadPageLink("not a url", "https://critiqs.app")).toBeNull();
    expect(isThreadPageKey(key)).toBe(true);
  });
});
