import { expect, test } from "bun:test";
import { resolveBackend } from "../src/backend.ts";

// Which backend the website talks to, and whether it takes create keys, from one read of its configuration.

const BACKEND = "http://127.0.0.1:3214";
const SITE = "http://127.0.0.1:3215";

function configServer(config: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    // Only the first read answers: a second one would fail.
    if (asked.length > 1) throw new Error("offline");
    return new Response(JSON.stringify({ signInUrl: SITE, protocol: 5, ...config }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { asked, fetchFn };
}

test("create keys come from the same configuration read that finds the deployment", async () => {
  const keys = configServer({ createKeys: true });
  const found = await resolveBackend(BACKEND, keys.fetchFn);
  expect([found.deployment.siteUrl, found.createKeys, keys.asked]).toEqual([SITE, true, [`${SITE}/critiqs/config`]]);
});

test("a backend that doesn't report create keys gets none", async () => {
  for (const config of [{}, { createKeys: "yes" }, { createKeys: false }]) {
    expect((await resolveBackend(BACKEND, configServer(config).fetchFn)).createKeys).toBe(false);
  }
});

test("address edits come from the same read, and only a backend that reports them gets them", async () => {
  expect((await resolveBackend(BACKEND, configServer({ addressEdits: true }).fetchFn)).addressEdits).toBe(true);
  for (const config of [{}, { addressEdits: "yes" }, { addressLists: true }]) {
    expect((await resolveBackend(BACKEND, configServer(config).fetchFn)).addressEdits).toBe(false);
  }
});
