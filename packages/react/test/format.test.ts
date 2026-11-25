import { expect, test } from "bun:test";
import { describeViewState } from "../src/ui/format.ts";

test("describes a view state by its chosen values, shortening long ones such as a recorded draft", () => {
  const draft = JSON.stringify({ title: "Welcome", body: { type: "text", pages: ["one", "two", "three", "four"] } });

  expect(describeViewState({ tab: "course-library", contentPage: 2, aiEdit: true, coursePanel: null, compact: false, search: "" })).toBe(
    "tab: course-library, contentPage: 2, aiEdit",
  );
  expect(describeViewState({ contentDraft: draft })).toBe(`contentDraft: ${draft.slice(0, 59)}…`);
});
