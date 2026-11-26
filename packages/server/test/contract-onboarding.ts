import { expect, test } from "bun:test";
import { DEFAULT_TAGS, startingTags } from "@critiqs/core";
import { DEFAULT_PLANS, type Plan } from "../src/limits.ts";
import { saveAboutYou } from "../src/onboarding.ts";
import * as ops from "../src/operations.ts";
import type { Identity } from "../src/store.ts";
import { type ContractBackend, reviewer } from "./contract.ts";

/**
 * Onboarding on the Critiqs website, as every backend must store it. Each
 * backend's tests call this with a fresh, empty backend per test.
 */
export function defineOnboardingContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");

  const person = (backend: ContractBackend, who: Identity) => backend.run(async (store) => await store.users.byToken(who.tokenIdentifier));
  const project = (backend: ContractBackend, projectId: string) => backend.run(async (store) => await store.projects.get(projectId));
  const tags = async (backend: ContractBackend, projectId: string) => (await backend.run((store) => ops.getProject(store, dana, { projectId }))).tags;

  test(`${name}: "About you" saves known answers on the person; unknown ones and skipped ones change nothing`, async () => {
    const backend = fresh();
    await backend.run((store) => saveAboutYou(store, dana, { role: "designer", teamSize: "6-20" }));
    expect(await person(backend, dana)).toMatchObject({ role: "designer", teamSize: "6-20" });
    // Skipping one answer, or both, keeps what was saved.
    await backend.run((store) => saveAboutYou(store, dana, { teamSize: "just-me" }));
    await backend.run((store) => saveAboutYou(store, dana, {}));
    // Values core doesn't know are dropped, as if skipped.
    await backend.run((store) => saveAboutYou(store, dana, { role: "ceo", teamSize: "huge" }));
    expect(await person(backend, dana)).toMatchObject({ role: "designer", teamSize: "just-me" });
    // A sign-in afterwards keeps the answers.
    await backend.run((store) => ops.syncReviewer(store, { ...dana, name: "Dana Kim" }));
    expect(await person(backend, dana)).toMatchObject({ name: "Dana Kim", role: "designer", teamSize: "just-me" });
  });

  test(`${name}: skipping "About you" stores no answers, and signing in is required`, async () => {
    const backend = fresh();
    await backend.run((store) => saveAboutYou(store, dana, { role: "nope" }));
    const saved = (await person(backend, dana))!;
    expect("role" in saved || "teamSize" in saved).toBe(false);
    await expect(backend.run((store) => saveAboutYou(store, null, { role: "designer" }))).rejects.toThrow("Sign in");
    await expect(backend.run((store) => saveAboutYou(store, { ...dana, emailVerified: false }, { role: "designer" }))).rejects.toThrow("Verify");
  });

  test(`${name}: a project from onboarding keeps its answers and stack, and starts with its purpose's tags`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) =>
      ops.createProject(store, dana, {
        name: "acme-proto.vercel.app",
        reviewUrl: "https://acme-proto.vercel.app",
        onboarding: { codeAccess: "nobody", feedbackFrom: ["test-users", "team", "bogus", "team"], purpose: "qa" },
        stack: "next",
      }),
    );
    expect(await project(backend, projectId)).toMatchObject({
      name: "acme-proto.vercel.app",
      reviewUrl: "https://acme-proto.vercel.app/",
      onboarding: { codeAccess: "nobody", feedbackFrom: ["team", "test-users"], purpose: "qa", stack: "next" },
    });
    expect(await tags(backend, projectId)).toEqual([...startingTags("qa")]);
    expect(await tags(backend, projectId)).toEqual(["Bug", "Regression", "UX copy change", "User feedback"]);
  });

  test(`${name}: each purpose picks its starting tags; without one a project starts with the default tags`, async () => {
    const backend = fresh();
    for (const purpose of ["design-review", "user-testing"] as const) {
      const projectId = await backend.run((store) => ops.createProject(store, dana, { name: purpose, onboarding: { purpose } }));
      expect(await tags(backend, projectId)).toEqual([...startingTags(purpose)]);
    }
    const skipped = await backend.run((store) => ops.createProject(store, dana, { name: "Skipped", onboarding: { codeAccess: "self" } }));
    const before = await backend.run((store) => ops.createProject(store, dana, { name: "Setup panel" }));
    for (const projectId of [skipped, before]) expect(await tags(backend, projectId)).toEqual([...DEFAULT_TAGS]);
  });

  test(`${name}: unknown answers and stacks are dropped, and a project with none keeps no onboarding record`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) =>
      ops.createProject(store, dana, { name: "Odd", onboarding: { codeAccess: "maybe", feedbackFrom: ["everyone"], purpose: "fun" }, stack: "cobol" }),
    );
    expect(await tags(backend, projectId)).toEqual([...DEFAULT_TAGS]);
    expect(await project(backend, projectId)).not.toHaveProperty("onboarding");
    const stackOnly = await backend.run((store) => ops.createProject(store, dana, { name: "Stack only", onboarding: {}, stack: "vue" }));
    expect((await project(backend, stackOnly))!.onboarding).toEqual({ stack: "vue" });
  });

  test(`${name}: creating from onboarding keeps setup's rules: a name, the organization chosen, and the plan's project limit`, async () => {
    const free = DEFAULT_PLANS.free!;
    const projectLimit = free.limits.find((limit) => limit.metric === "projects")!.max;
    const backend = fresh().withPlans({ free } satisfies Record<string, Plan>);
    const create = (name: string, extra: Partial<Parameters<typeof ops.createProject>[2]> = {}) =>
      backend.run((store) => ops.createProject(store, dana, { name, onboarding: { purpose: "qa" }, stack: "react", ...extra }));
    await expect(create("   ")).rejects.toThrow("A project needs a name.");
    await expect(create("Elsewhere", { organizationId: "not-an-id" })).rejects.toThrow("only in organizations you belong to");
    // A review address emails can't link to is left out, not refused.
    const first = await create("First", { reviewUrl: "ftp://proto.example" });
    expect(await project(backend, first)).not.toHaveProperty("reviewUrl");
    for (let count = 1; count < projectLimit; count++) await create(`Project ${count}`);
    await expect(create("One too many")).rejects.toThrow("An admin of the organization can upgrade the plan.");
  });
}
