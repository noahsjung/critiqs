import { shortenProjectName } from "@critiqs/core";
import { expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

const dana = reviewer("Dana");

test("creating a project refuses a name longer than 200 characters", async () => {
  const t = setup({ limits: true });
  await expect(t.withIdentity(dana).mutation(api.projects.create, { name: "P".repeat(201) })).rejects.toThrow("at most 200 characters");
  const projectId = await t.withIdentity(dana).mutation(api.projects.create, { name: "P".repeat(200) });
  expect((await t.withIdentity(dana).query(api.projects.get, { projectId })).name).toBe("P".repeat(200));
});

test("the backfill shortens names from before the limit, so listing many such projects fits Convex's read limit", async () => {
  const t = setup({ limits: true });
  const first = await t.withIdentity(dana).mutation(api.projects.create, { name: "Admin prototype" });
  const template = await t.run(async (ctx) => (await ctx.db.get(first))!);
  const { _id, _creationTime, ...fields } = template;
  // 20 projects of about 900 KB each hold more than the 16 MiB one transaction may read.
  const ids: Id<"projects">[] = [];
  for (let i = 0; i < 20; i++) ids.push(await t.run((ctx) => ctx.db.insert("projects", { ...fields, name: `${i}`.padEnd(900_000, "x") })));
  const list = () => t.withIdentity(dana).query(api.projects.listMine, { paginationOpts: { numItems: 25, cursor: null } });
  const recount = () => t.mutation(internal.organizations.recountStorage, {});
  // Before: reading every project of the organization fails, and a page of projects stops after two.
  await expect(recount()).rejects.toThrow("Read too much data");
  expect((await list()).page).toHaveLength(2);

  await t.mutation(internal.projects.shortenLongNames, {});
  await t.finishAllScheduledFunctions(() => undefined);
  await recount();
  const listed = await list();
  expect(listed.page).toHaveLength(21);
  expect(listed.page[0]!.name).toBe("Admin prototype");
  expect(listed.page.slice(1).map((project) => project.name)).toEqual(ids.map((_, i) => shortenProjectName(`${i}`.padEnd(900_000, "x"))));

  // Running it again changes nothing.
  const before = await t.run(async (ctx) => (await ctx.db.query("projects").collect()).map((project) => [project._id, project.name]));
  await t.mutation(internal.projects.shortenLongNames, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await t.run(async (ctx) => (await ctx.db.query("projects").collect()).map((project) => [project._id, project.name]))).toEqual(before);
}, 120_000);
