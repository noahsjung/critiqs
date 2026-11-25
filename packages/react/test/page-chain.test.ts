import { expect, test } from "bun:test";
import { pageChain } from "../src/page-chain.ts";

const page = (cursor: string, rows: string[] = [], isDone = false) => ({ continueCursor: cursor, isDone, page: rows });

test("loads empty scan-limited pages through cursor exhaustion without discarding later rows", () => {
  const pending = pageChain([null], { "0": page("a") });
  expect(pending.next).toEqual([null, "a"]);
  expect(pending.complete).toBe(false);
  const result = pageChain([null, "a"], { "0": page("a"), "1": page("", ["last"], true) });
  expect(result.complete).toBe(true);
  expect(result.pages.flatMap(row => row.page)).toEqual(["last"]);
});

test("a live insert/delete changing a boundary invalidates old downstream pages", () => {
  const changed = pageChain([null, "old", "end"], { "0": page("new", ["inserted"]), "1": page("end", ["stale"]), "2": page("", ["last"], true) });
  expect(changed.complete).toBe(false);
  expect(changed.next).toEqual([null, "new"]);
  expect(changed.pages.flatMap(row => row.page)).toEqual(["inserted"]);
  const corrected = pageChain([null, "new"], { "0": page("new", ["inserted"]), "1": page("", ["corrected"], true) });
  expect(corrected.pages.flatMap(row => row.page)).toEqual(["inserted", "corrected"]);
  expect(corrected.complete).toBe(true);
});

test("later page failures never become a partial success and exhausted collections drop obsolete cursors", () => {
  const error = new Error("Page inaccessible");
  const failed = pageChain([null, "a"], { "0": page("a", ["first"]), "1": error });
  expect(failed.failure).toBe(error);
  expect(failed.complete).toBe(false);
  const shorter = pageChain([null, "a"], { "0": page("", ["only"], true), "1": page("", ["stale"], true) });
  expect(shorter.next).toEqual([null]);
  expect(shorter.pages.flatMap(row => row.page)).toEqual(["only"]);
});

test("repeated or missing nonterminal cursors fail instead of looping", () => {
  expect(pageChain([null, "a"], { "0": page("a"), "1": page("a") }).failure).toBeInstanceOf(Error);
  expect(pageChain([null], { "0": page("") }).failure).toBeInstanceOf(Error);
});
