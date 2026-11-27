import { expect, test } from "bun:test";
import { ID_PATTERN, MIGRATIONS, PREFIX, SCHEMA_VERSION } from "../src/sqlite/store.ts";

// Guards against two branches that each add a migration or an ID prefix
// merging cleanly into a schema that no longer works.

test("there is exactly one migration per schema version", () => {
  expect(MIGRATIONS.length).toBe(SCHEMA_VERSION);
});

test("every table has its own ID prefix", () => {
  const tablesByPrefix = new Map<string, string[]>();
  for (const [table, prefix] of Object.entries(PREFIX)) {
    tablesByPrefix.set(prefix, [...(tablesByPrefix.get(prefix) ?? []), table]);
  }
  const shared = [...tablesByPrefix].filter(([, tables]) => tables.length > 1);
  expect(shared).toEqual([]);
});

test("IDs with every table's prefix are accepted", () => {
  const rejected = Object.entries(PREFIX)
    .filter(([, prefix]) => !ID_PATTERN.test(`${prefix}_${"0".repeat(32)}`))
    .map(([table]) => table);
  expect(rejected).toEqual([]);
});
