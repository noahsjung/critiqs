import { expect, test } from "bun:test";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup, upload } from "./harness";

async function threadWithCapture() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Admin prototype" });
  const storageId = await upload(dana, projectId, "png-bytes");
  const threadId = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "Spacing",
    tags: [],
    capture: { status: "captured", storageId },
  });
  return { t, threadId };
}

test("captures are served only to signed-in reviewers", async () => {
  const { t, threadId } = await threadWithCapture();
  const path = `/capture?threadId=${threadId}`;

  const member = await t.withIdentity(reviewer("Lee")).fetch(path);
  expect(member.status).toBe(200);
  expect(await member.text()).toBe("png-bytes");

  expect((await t.fetch(path)).status).toBe(401);
});

test("malformed thread IDs are reported as not found", async () => {
  const { t } = await threadWithCapture();
  const response = await t.withIdentity(reviewer("Lee")).fetch("/capture?threadId=not-an-id");
  expect(response.status).toBe(404);
});

test("an image already used by a thread cannot be attached to another", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectA = await dana.mutation(api.projects.create, { name: "A" });
  const projectB = await dana.mutation(api.projects.create, { name: "B" });
  const storageId = await upload(dana, projectA, "png");
  const create = (projectId: typeof projectA) =>
    dana.mutation(api.threads.create, { projectId, anchor, body: "x", tags: [], capture: { status: "captured", storageId } });
  await create(projectA);
  await expect(create(projectB)).rejects.toThrow("already belongs");
});

test("a supplied screenshot cannot be replaced, so it is never freed for reuse", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "A" });
  const threadId = await dana.mutation(api.threads.create, {
    projectId,
    anchor,
    body: "x",
    tags: [],
    capture: { status: "failed", failureReason: "Tainted canvas" },
  });
  const store = () => upload(dana, projectId, "png");
  await dana.mutation(api.threads.attachScreenshot, { threadId, storageId: await store() });
  await expect(dana.mutation(api.threads.attachScreenshot, { threadId, storageId: await store() })).rejects.toThrow(
    "already has an image",
  );
});
