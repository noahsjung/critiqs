import { describe, expect, test } from "bun:test";
import { cleanTagLabel, expandTagFilter, groupThreads, hashtagLabels, parseHashtags, tagKey, uniqueTags } from "../src/index.ts";

const labels = (text: string) => parseHashtags(text).map((tag) => tag.label);

describe("hashtags", () => {
  test("start at the start, after spaces, or after opening punctuation", () => {
    expect(labels("#wording at start, then #microcopy. (#copy) “#quote” [#list]")).toEqual(["wording", "microcopy", "copy", "quote", "list"]);
  });

  test("are not URL fragments, character references, numbers, or words like C#", () => {
    expect(labels("See https://proto.example/page#section and &#39; and C# and issue #123 and #1st and x#y")).toEqual([]);
  });

  test("begin with any letter and keep letters, numbers, marks, underscores, and hyphens", () => {
    expect(labels("#ux-copy #UX_copy2 #café #日本語 #ñandú #fff")).toEqual(["ux-copy", "UX_copy2", "café", "日本語", "ñandú", "fff"]);
  });

  test("drop trailing joiners and stop at other punctuation", () => {
    expect(labels("This is a #bug- and #copy_, also #done! #why? #a.b")).toEqual(["bug", "copy", "done", "why", "a"]);
  });

  test("longer than 50 characters are not tags", () => {
    expect(labels(`#${"a".repeat(50)}`)).toEqual(["a".repeat(50)]);
    expect(labels(`#${"a".repeat(51)}`)).toEqual([]);
  });

  test("report where each tag is, in string indexes", () => {
    const text = "😀 #emoji then #next";
    const [first, second] = parseHashtags(text);
    expect(text.slice(first!.start, first!.end)).toBe("#emoji");
    expect(text.slice(second!.start, second!.end)).toBe("#next");
  });

  test("match by key, keeping the first spelling", () => {
    expect(hashtagLabels("#Wording and #wording and #WORDING and #ux_copy then #UX-copy")).toEqual(["Wording", "ux_copy"]);
    expect(tagKey("UX copy change")).toBe(tagKey("#ux-copy-change"));
    expect(tagKey("ＣＯＰＹ")).toBe("copy");
    // Words are not split: camel case is a different tag.
    expect(tagKey("UXCopy")).not.toBe(tagKey("ux-copy"));
    expect(uniqueTags(["Bug", "bug", "UX copy change", "ux_copy_change"])).toEqual(["Bug", "UX copy change"]);
  });

  test("explicit tags allow presets with spaces and refuse empty, long, or control text", () => {
    expect(cleanTagLabel("  UX   copy change ")).toBe("UX copy change");
    expect(cleanTagLabel("#wording")).toBe("wording");
    expect(cleanTagLabel("")).toBeNull();
    expect(cleanTagLabel("a".repeat(51))).toBeNull();
    expect(cleanTagLabel("bad\u0000tag")).toBeNull();
    expect(cleanTagLabel("zero​width")).toBeNull();
  });
});

describe("tag filters", () => {
  const thread = (id: string, tags: string[]) => ({ id, status: "open" as const, screen: "s", tags, lastActivityAt: 1, unread: false });
  const view = { currentScreen: "s", isLive: () => true };
  const base = { status: "all" as const, unreadOnly: false, screens: "all" as const };

  test("match tags by key", () => {
    const groups = groupThreads([thread("a", ["Wording"]), thread("b", ["bug"])], view, { ...base, tags: ["wording"] });
    expect(groups.flatMap((group) => group.threads.map((entry) => entry.id))).toEqual(["a"]);
  });

  test("expand groups into their tags and list each thread once", () => {
    const members = (group: string) => (group === "copy" ? ["wording", "microcopy"] : []);
    const filters = expandTagFilter({ ...base, tags: [], groups: ["copy"] }, members);
    expect(filters.tags).toEqual(["wording", "microcopy"]);
    const groups = groupThreads(
      [thread("both", ["wording", "microcopy"]), thread("one", ["microcopy"]), thread("none", ["bug"])],
      view,
      filters,
    );
    expect(groups.flatMap((group) => group.threads.map((entry) => entry.id)).sort()).toEqual(["both", "one"]);
  });

  test("an empty group matches nothing", () => {
    const filters = expandTagFilter({ ...base, tags: [], groups: ["empty"] }, () => []);
    expect(groupThreads([thread("a", ["bug"])], view, filters)).toEqual([]);
  });
});
