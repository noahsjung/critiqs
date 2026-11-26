import { expect, test } from "bun:test";
import { DEFAULT_TAGS } from "@critiqs/server";

// `bun run typecheck` checks this file too: callers have always been able to
// assign the list to a `string[]`, so it must stay one.
const tags: string[] = DEFAULT_TAGS;

test("DEFAULT_TAGS is still a string[] of the default tags", () => {
  expect(tags).toEqual(["Bug", "UX copy change", "Design change request", "User feedback"]);
});
