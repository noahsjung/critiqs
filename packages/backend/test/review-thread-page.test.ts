import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";

// "Open in prototype" on a thread page offers the project's review link for
// the address the comment was left on, to the project's owners and its
// organization's members who may open the page,
// and only while that link is still served to them.

const ENV: Record<string, string> = {
  CRITIQS_REVIEW_PROXY_URL: "http://review.localhost:5260",
  CRITIQS_PROXY_SECRET: "proxy-secret-for-tests-0123456789abcdefghij",
  CRITIQS_WEB_URL: "https://critiqs.example",
  CONVEX_SITE_URL: "https://test.convex.site",
  CRITIQS_AUTH_ISSUER: "https://test.convex.site",
};
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of [...Object.keys(ENV), "CRITIQS_WEB_RISK_API_KEY"]) saved.set(name, process.env[name]);
  Object.assign(process.env, ENV);
  delete process.env.CRITIQS_WEB_RISK_API_KEY;
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    return (error as { data?: { message?: string } }).data?.message ?? (error as Error).message;
  }
}

test("a thread page's review link is the project's link for the comment's address, at its path, while it is served", async () => {
  const t = setup();
  const [dana, sam] = ["Dana", "Sam"].map((name) => t.withIdentity(reviewer(name)));
  const projectId = await dana!.mutation(api.projects.create, { name: "Pilot" });
  await sam!.mutation(api.users.sync, {});
  // The comment was left on https://proto.example/users/alex?tab=permissions.
  const threadId = await dana!.mutation(api.threads.create, { projectId, anchor, body: "Spacing", tags: [], capture: { status: "failed" as const, failureReason: "x" } });
  const key = await dana!.mutation(api.threads.pageKey, { threadId });
  expect(await dana!.query(api.reviewLinks.forThreadPage, { key })).toBeNull();

  // A link for another origin isn't one for this comment.
  await dana!.mutation(api.reviewLinks.createLive, { projectId, address: "https://other.example/" });
  const link = await dana!.mutation(api.reviewLinks.createLive, { projectId, address: "https://proto.example/" });
  await t.finishAllScheduledFunctions(() => undefined);
  expect(await dana!.query(api.reviewLinks.forThreadPage, { key })).toBe(`${link.url}#/users/alex`);
  // A path the proxy would read as another site's address opens as the review page shows it, never as `#//…`.
  const odd = await dana!.mutation(api.threads.create, { projectId, anchor: { ...anchor, evidence: { ...anchor.evidence, url: "https://proto.example//evil.example/x" } }, body: "Odd path", tags: [], capture: { status: "failed" as const, failureReason: "x" } });
  expect(await dana!.query(api.reviewLinks.forThreadPage, { key: await dana!.mutation(api.threads.pageKey, { threadId: odd }) })).toBe(`${link.url}#/.//evil.example/x`);
  // Someone who may not open the thread page learns nothing from it.
  const pageRefusal: unknown = await outcome(sam!.query(api.threads.page, { key, paginationOpts: { numItems: 1, cursor: null } }));
  expect((await outcome(sam!.query(api.reviewLinks.forThreadPage, { key }))) as unknown).toBe(pageRefusal);
  expect(await outcome(t.query(api.reviewLinks.forThreadPage, { key }))).not.toContain("/r/");
  // Removed, it isn't offered.
  await dana!.mutation(api.reviewLinks.revoke, { linkId: link.linkId });
  expect(await dana!.query(api.reviewLinks.forThreadPage, { key })).toBeNull();
});
