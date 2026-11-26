import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { convexDirectory } from "@critiqs/server/review-directory";
import { REVIEW_LINK_LIMITS, RESOLUTION_CACHE_MS } from "@critiqs/server/review-links";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

// The review proxy's side of review links: `convexDirectory`, the directory
// the proxy reads frame hosts through, against this backend's real
// `/internal/review/v1/*` routes. It stands in for the proxy: the requests
// below are the ones the proxy makes.

const SECRET = "proxy-secret-for-tests-0123456789abcdefghij";
const ENV: Record<string, string> = {
  CRITIQS_REVIEW_PROXY_URL: "http://review.localhost:5260",
  CRITIQS_PROXY_SECRET: SECRET,
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
  setSystemTime();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A live link opened by someone signed out, and a directory that reaches this backend and counts its requests. */
async function opened(options: { secret?: string } = {}) {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const link = await dana.mutation(api.reviewLinks.createLive, { projectId, address: "https://app.acme.com/" });
  await t.finishAllScheduledFunctions(() => undefined);
  const lease = await t.mutation(api.reviewLinks.open, { key: link.key });
  if (lease.kind !== "ready") throw new Error(lease.kind);
  const requests: { path: string; authorization: string | null; body: unknown }[] = [];
  let backend: (path: string, init: RequestInit) => Promise<Response> = (path, init) => t.fetch(path, init);
  const directory = convexDirectory({
    backend: "https://test.convex.site",
    secret: options.secret ?? SECRET,
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      requests.push({ path: pathname, authorization: new Headers(init.headers).get("Authorization"), body: JSON.parse(String(init.body)) });
      return await backend(pathname, init);
    },
  });
  return {
    t,
    dana,
    link,
    lease,
    label: new URL(lease.entry.origin).hostname.split(".")[0]!,
    directory,
    requests,
    /** Replaces the backend, as an outage or a broken deployment would. */
    failWith: (replacement: typeof backend) => (backend = replacement),
    restore: () => (backend = (path, init) => t.fetch(path, init)),
  };
}

test("the directory resolves a frame host with the proxy's own request, and reuses the answer for at most five seconds", async () => {
  const f = await opened();
  const resolution = await f.directory.resolve(f.label);
  expect(resolution).toMatchObject({ v: 1, kind: "site", linkId: f.link.linkId, leaseId: f.lease.entry.leaseId, origin: "https://app.acme.com", assetOrigins: [] });
  // The request carries the secret and the label's hash, never the label.
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.path).toBe("/internal/review/v1/resolve");
  expect(f.requests[0]!.authorization).toBe(`Bearer ${SECRET}`);
  expect(JSON.stringify(f.requests[0]!.body)).not.toContain(f.label);
  expect(f.requests[0]!.body).toEqual({ hostHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

  // Many requests at once share one question.
  await Promise.all([f.directory.resolve(f.label), f.directory.resolve(f.label), f.directory.resolve(f.label)]);
  expect(f.requests).toHaveLength(1);
});

test("a revoked link stops serving through the directory within five seconds", async () => {
  const f = await opened();
  // The clock stands still, so the five seconds are counted from exactly when the directory asked.
  const start = Date.now();
  setSystemTime(start);
  expect(await f.directory.resolve(f.label)).not.toBeNull();
  await f.dana.mutation(api.reviewLinks.revoke, { linkId: f.link.linkId });
  // Until the cached answer runs out, the proxy may still serve: never longer than five seconds.
  setSystemTime(start + RESOLUTION_CACHE_MS - 1);
  expect(await f.directory.resolve(f.label)).not.toBeNull();
  setSystemTime(start + RESOLUTION_CACHE_MS);
  expect(await f.directory.resolve(f.label)).toBeNull();
  expect(f.requests).toHaveLength(2);
});

test("an answer is never reused past the lease's end", async () => {
  const f = await opened();
  const start = Date.now();
  setSystemTime(start);
  await f.t.run(async (ctx) => await ctx.db.patch(f.lease.entry.leaseId as Id<"reviewLeases">, { expiresAt: start + 2_000 }));
  expect(await f.directory.resolve(f.label)).toMatchObject({ expiresAt: start + 2_000, cacheUntil: start + 2_000 });
  setSystemTime(start + 2_000);
  expect(await f.directory.resolve(f.label)).toBeNull();
});

test("the directory fails closed: an unreachable or broken backend, or a wrong secret, serves nothing", async () => {
  const f = await opened();
  const failures: [string, (path: string, init: RequestInit) => Promise<Response>][] = [
    ["unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
    ["server error", async () => new Response("oops", { status: 500 })],
    ["not JSON", async () => new Response("<html>", { status: 200 })],
    ["the wrong shape", async () => Response.json({ v: 1, kind: "site", linkId: "x", leaseId: "y", origin: "https://app.acme.com/path", assetOrigins: [], expiresAt: 1, cacheUntil: 1 })],
    ["a cache longer than the lease", async () => Response.json({ v: 1, kind: "site", linkId: "x", leaseId: "y", origin: "https://app.acme.com", assetOrigins: [], expiresAt: 1, cacheUntil: 2 })],
  ];
  for (const [name, backend] of failures) {
    f.failWith(backend);
    expect([name, await f.directory.resolve(f.label)]).toEqual([name, null]);
  }
  // Failures aren't remembered: once the backend answers, the host serves again.
  f.restore();
  expect(await f.directory.resolve(f.label)).not.toBeNull();

  const wrong = await opened({ secret: "not-the-secret-0123456789abcdefghijkl" });
  expect(await wrong.directory.resolve(wrong.label)).toBeNull();
});

test("labels that can't be a frame host are refused without asking the backend", async () => {
  const f = await opened();
  for (const label of ["", "v-", "v-short", f.label.toUpperCase(), `${f.label}.evil`, "app", `x${f.label.slice(1)}`]) {
    expect([label, await f.directory.resolve(label)]).toEqual([label, null]);
  }
  expect(f.requests).toHaveLength(0);
});

test("usage past the day's ceiling pauses a link, and the directory forgets its hosts at once", async () => {
  const f = await opened();
  expect(await f.directory.resolve(f.label)).not.toBeNull();
  expect(await f.directory.report([{ linkId: f.link.linkId, requests: 10, bytes: 2048 }])).toEqual({ paused: [] });
  expect(await f.directory.resolve(f.label)).not.toBeNull();
  expect(await f.directory.report([{ linkId: f.link.linkId, requests: REVIEW_LINK_LIMITS.requestsPerLinkPerDay, bytes: 0 }])).toEqual({ paused: [f.link.linkId] });
  expect(await f.directory.resolve(f.label)).toBeNull();
  const [summary] = await f.dana.query(api.reviewLinks.list, { projectId: (await f.t.run(async (ctx) => (await ctx.db.get(f.link.linkId))!.projectId)) });
  expect(summary).toMatchObject({ paused: true, usageToday: { requests: REVIEW_LINK_LIMITS.requestsPerLinkPerDay + 10, bytes: 2048 } });

  f.failWith(async () => new Response("Not found", { status: 404 }));
  await expect(f.directory.report([{ linkId: f.link.linkId, requests: 1, bytes: 1 }])).rejects.toThrow("The backend didn't take the usage report.");
});

test("the directory refuses a backend address that isn't https, except on this computer", () => {
  expect(() => convexDirectory({ backend: "http://backend.example", secret: SECRET })).toThrow("The backend address must use https://");
  expect(() => convexDirectory({ backend: "https://backend.example/path", secret: SECRET })).toThrow("The backend address must be a bare origin.");
  expect(() => convexDirectory({ backend: "http://127.0.0.1:5211", secret: SECRET })).not.toThrow();
});
