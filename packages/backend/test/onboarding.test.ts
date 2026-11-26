import { DEFAULT_TAGS } from "@critiqs/core";
import { expect, test } from "bun:test";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

// Onboarding's answers on Convex: the public functions and what the schema
// stores. The rules themselves are in the shared contract (contract-onboarding).

test("onboarding saves the person's answers and creates a project with its answers, stack, and starting tags", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  await dana.mutation(api.onboarding.saveAboutYou, { role: "engineer", teamSize: "2-5" });
  await dana.mutation(api.onboarding.saveAboutYou, { role: "chief", teamSize: undefined });
  const projectId = await dana.mutation(api.projects.create, {
    name: "acme-proto.vercel.app",
    reviewUrl: "https://acme-proto.vercel.app",
    onboarding: { codeAccess: "self", feedbackFrom: ["team", "nobody"], purpose: "user-testing" },
    stack: "react",
  });
  const stored = await t.run(async (ctx) => ({
    user: await ctx.db.query("users").first(),
    project: await ctx.db.get(projectId as Id<"projects">),
  }));
  expect(stored.user).toMatchObject({ role: "engineer", teamSize: "2-5" });
  expect(stored.project).toMatchObject({
    tags: ["User feedback", "Bug", "UX copy change", "Design change request"],
    onboarding: { codeAccess: "self", feedbackFrom: ["team"], purpose: "user-testing", stack: "react" },
  });
  // Setup's call, with none of onboarding's arguments, still works as before.
  const plain = await dana.mutation(api.projects.create, { name: "Setup panel" });
  expect(await dana.query(api.projects.get, { projectId: plain })).toMatchObject({ tags: [...DEFAULT_TAGS] });
  await expect(t.mutation(api.onboarding.saveAboutYou, { role: "engineer" })).rejects.toThrow();
});
