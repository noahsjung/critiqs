import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { BUILD_LIMITS, sha256Hex } from "@critiqs/server/review-builds";
import { frameHostHash } from "@critiqs/server/review-links";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

// Shared builds on Convex: who may upload one, what an upload must be, and
// that a shared build is served only through a lease the project's review
// access allows, only while it is published and unexpired. The proxy's side
// is `/internal/review/v1/build-file` and `build-blob`, called here as the
// proxy calls them.

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

const encoder = new TextEncoder();
const SITE: Record<string, string> = {
  "index.html": "<!doctype html><title>Acme</title><h1>Home</h1><script src=/assets/app.js></script>",
  "assets/app.js": "console.log('acme')",
  "about/index.html": "<!doctype html><h1>About</h1>",
  "404.html": "<!doctype html><h1>Lost</h1>",
};

async function manifestOf(files: Record<string, string>) {
  return await Promise.all(Object.entries(files).map(async ([path, text]) => ({ path, size: encoder.encode(text).byteLength, sha256: await sha256Hex(encoder.encode(text)) })));
}

/** What an attempt came to: its value, or its refusal's message. */
async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    const data = (error as { data?: { message?: string } }).data;
    return data?.message ?? (error as Error).message;
  }
}

/** Dana owns "Pilot"; Riley is a member of her organization but not an owner; Lee is outside it. */
async function fixture(reviewAccess: "anyone" | "organization" = "anyone") {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const riley = t.withIdentity(reviewer("Riley"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const [organization] = await dana.query(api.organizations.mine, {});
  await dana.mutation(api.organizations.invite, { organizationId: organization!.id, email: "riley@example.com", role: "member" });
  await riley.mutation(api.users.sync, {});
  await lee.mutation(api.users.sync, {});
  if (reviewAccess === "organization") await dana.mutation(api.projects.setReviewAccess, { projectId, reviewAccess });
  return { t, dana, riley, lee, projectId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Posts a file to an upload address as `critiqs share` does. */
async function put(t: Fixture["t"], url: string, body: string | Uint8Array<ArrayBuffer>) {
  const address = new URL(url);
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const response = await t.fetch(`${address.pathname}${address.search}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
  return { status: response.status, text: await response.text() };
}

/** Shares `files` as Dana: begins, uploads every file, publishes. */
async function share(f: Fixture, files: Record<string, string> = SITE, options: { spa?: boolean; expiresInDays?: number } = {}) {
  const begun = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf(files), spa: options.spa ?? false, ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }) });
  const bySha = new Map(await Promise.all(Object.values(files).map(async (text) => [await sha256Hex(encoder.encode(text)), text] as const)));
  for (const upload of begun.uploads) expect((await put(f.t, upload.url, bySha.get(upload.sha256)!)).status).toBe(201);
  const published = await f.dana.mutation(api.reviewBuilds.publish, { buildId: begun.buildId });
  return { ...published, key: published.url.split("/r/")[1]! };
}

const labelOf = (origin: string) => new URL(origin).hostname.split(".")[0]!;

async function internalPost(t: Fixture["t"], path: string, body: unknown, secret: string | null = SECRET) {
  return await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }) }, body: JSON.stringify(body) });
}

/** What the proxy is told for a frame path: the file's status and type, and its bytes; null for a 404. */
async function served(t: Fixture["t"], label: string, path: string) {
  const hostHash = await frameHostHash(label);
  const file = await internalPost(t, "/internal/review/v1/build-file", { hostHash, path });
  if (file.status !== 200) return null;
  const answer = (await file.json()) as { status: number; sha256: string; contentType: string };
  const blob = await internalPost(t, "/internal/review/v1/build-blob", { hostHash, sha256: answer.sha256 });
  return { status: answer.status, type: answer.contentType, body: blob.status === 200 ? await blob.text() : null };
}

async function openLease(who: Fixture["t"] | Fixture["dana"], key: string) {
  const opened = await who.mutation(api.reviewLinks.open, { key });
  if (opened.kind !== "ready") throw new Error(`Expected a ready link, got ${opened.kind}`);
  return { ...opened, label: labelOf(opened.entry.origin) };
}

test("/critiqs/config reports shared builds wherever the review proxy is set up, with or without a reputation provider", async () => {
  const f = await fixture();
  const config = async () => ((await (await f.t.fetch("/critiqs/config")).json()) as { reviewLinks?: unknown }).reviewLinks;
  expect(await config()).toEqual({ version: 1, live: true, builds: true, allowCritiqs: false });
  delete process.env.CRITIQS_PROXY_SECRET;
  expect(await config()).toBeUndefined();
  expect(await outcome(f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf(SITE), spa: false }))).toBe("Review links aren't set up on this deployment.");
});

test("an owner shares a build: anyone with the link gets a lease, and the proxy is given its files and nothing else", async () => {
  const f = await fixture();
  const shared = await share(f, SITE, { spa: true });
  expect(shared.url).toMatch(/^https:\/\/critiqs\.example\/r\/[a-z2-7]{26}$/);
  expect(Math.abs(shared.expiresAt - (Date.now() + 7 * 24 * 60 * 60_000))).toBeLessThan(5_000);

  const lease = await openLease(f.t, shared.key);
  // Signed out: no project named; the source is the build's own unresolvable name.
  expect(lease.projectId).toBeNull();
  expect(lease.source).toMatchObject({ kind: "share" });
  expect(lease.source.origin).toMatch(/^https:\/\/b[a-z2-7]{20}\.build\.invalid$/);

  const resolution = await internalPost(f.t, "/internal/review/v1/resolve", { hostHash: await frameHostHash(lease.label) });
  expect(await resolution.json()).toMatchObject({ kind: "share", origin: lease.source.origin, assetOrigins: [], allow: [] });

  expect(await served(f.t, lease.label, "/")).toEqual({ status: 200, type: "text/html; charset=utf-8", body: SITE["index.html"]! });
  expect(await served(f.t, lease.label, "/about")).toEqual({ status: 200, type: "text/html; charset=utf-8", body: SITE["about/index.html"]! });
  expect(await served(f.t, lease.label, "/assets/app.js")).toEqual({ status: 200, type: "text/javascript; charset=utf-8", body: SITE["assets/app.js"]! });
  // A route of the single-page app is its index.html; a missing file with an extension never is.
  expect(await served(f.t, lease.label, "/products/42")).toEqual({ status: 200, type: "text/html; charset=utf-8", body: SITE["index.html"]! });
  expect(await served(f.t, lease.label, "/assets/missing.js")).toEqual({ status: 404, type: "text/html; charset=utf-8", body: SITE["404.html"]! });
  for (const path of ["/../index.html", "/%2e%2e/index.html", "/.env", "/assets/%2fapp.js", "/a\\b"]) expect([path, await served(f.t, lease.label, path)]).toEqual([path, null]);

  // Without the proxy's secret, or for a sha the build doesn't hold, nothing.
  expect((await internalPost(f.t, "/internal/review/v1/build-file", { hostHash: await frameHostHash(lease.label), path: "/" }, "wrong-secret-wrong-secret-wrong-secret")).status).toBe(404);
  expect((await internalPost(f.t, "/internal/review/v1/build-blob", { hostHash: await frameHostHash(lease.label), sha256: "0".repeat(64) })).status).toBe(404);
});

test("only the project's owners may share or remove a build; members, outsiders and people signed out are refused", async () => {
  const f = await fixture();
  const files = await manifestOf(SITE);
  expect(await outcome(f.riley.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false }))).toBe("Only the project's owners can create or change its review links.");
  expect(typeof (await outcome(f.lee.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false })))).toBe("string");
  expect(typeof (await outcome(f.t.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false })))).toBe("string");
  const shared = await share(f);
  expect(await outcome(f.riley.mutation(api.reviewBuilds.remove, { buildId: shared.buildId }))).toBe("Only the project's owners can create or change its review links.");
  expect(typeof (await outcome(f.lee.mutation(api.reviewBuilds.remove, { key: shared.key })))).toBe("string");
  expect(typeof (await outcome(f.t.mutation(api.reviewBuilds.remove, { key: shared.key })))).toBe("string");
  // Only the uploader publishes their upload.
  const other = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf({ "index.html": "two" }), spa: false });
  expect(await outcome(f.riley.mutation(api.reviewBuilds.publish, { buildId: other.buildId }))).toBe("This upload does not exist.");
  expect((await openLease(f.t, shared.key)).kind).toBe("ready");
});

test("AT-27: the server refuses every file the command line refuses, whatever it is sent", async () => {
  const f = await fixture();
  const sha = "a".repeat(64);
  const begin = (files: { path: string; size: number; sha256: string }[]) => outcome(f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false }));
  const index = { path: "index.html", size: 10, sha256: sha };
  const refused: [string, { path: string; size: number; sha256: string }[], RegExp][] = [
    ["traversal", [index, { path: "../secret.js", size: 1, sha256: sha }], /isn't a plain path|hidden/],
    ["inner traversal", [index, { path: "assets/../../x.js", size: 1, sha256: sha }], /isn't a plain path|hidden/],
    ["absolute", [index, { path: "/etc/passwd.txt", size: 1, sha256: sha }], /absolute path/],
    ["backslash", [index, { path: "assets\\app.js", size: 1, sha256: sha }], /backslash/],
    ["NUL", [index, { path: "app\u0000.js", size: 1, sha256: sha }], /control character/],
    ["dotfile", [index, { path: ".env", size: 1, sha256: sha }], /hidden/],
    ["hidden folder", [index, { path: ".git/config.txt", size: 1, sha256: sha }], /hidden/],
    ["source map", [index, { path: "assets/app.js.map", size: 1, sha256: sha }], /source map/],
    ["shell script", [index, { path: "deploy.sh", size: 1, sha256: sha }], /isn't a file type/],
    ["env file", [index, { path: "config.env", size: 1, sha256: sha }], /isn't a file type/],
    ["key", [index, { path: "server.pem", size: 1, sha256: sha }], /isn't a file type/],
    ["case duplicate", [index, { path: "App.js", size: 1, sha256: sha }, { path: "app.js", size: 1, sha256: sha }], /name the same file/],
    ["exact duplicate", [index, { path: "app.js", size: 1, sha256: sha }, { path: "app.js", size: 1, sha256: sha }], /name the same file/],
    ["no index.html", [{ path: "app.js", size: 1, sha256: sha }], /needs an index\.html/],
    ["too many files", [index, ...Array.from({ length: BUILD_LIMITS.files }, (_, n) => ({ path: `f${n}.js`, size: 1, sha256: sha }))], /at most 1000 files/],
    ["too large in all", [index, ...Array.from({ length: 4 }, (_, n) => ({ path: `v${n}.mp4`, size: 15 * 1024 * 1024, sha256: sha }))], /at most 50 MiB/],
    ["file too large", [index, { path: "big.mp4", size: BUILD_LIMITS.fileBytes + 1, sha256: sha }], /larger than 16 MiB/],
    ["page too large", [{ ...index, size: BUILD_LIMITS.htmlBytes + 1 }], /larger than 2 MiB/],
    ["bad hash", [{ ...index, sha256: "not-a-hash" }], /SHA-256/],
    ["negative size", [{ ...index, size: -1 }], /valid size/],
  ];
  for (const [name, files, reason] of refused) {
    const result = await begin(files);
    expect([name, typeof result === "string" && reason.test(result) ? "refused" : result]).toEqual([name, "refused"]);
  }
  expect(await f.t.run(async (ctx) => (await ctx.db.query("reviewBuilds").collect()).length)).toBe(0);
});

test("AT-28: an upload keeps only the exact file the manifest names, once, with its grant, before the upload expires", async () => {
  const f = await fixture();
  const begun = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf(SITE), spa: false });
  const shaOf = new Map(await Promise.all(Object.values(SITE).map(async (text) => [text, await sha256Hex(encoder.encode(text))] as const)));
  const urlFor = async (text: string) => begun.uploads.find((upload) => upload.sha256 === shaOf.get(text))!.url;
  const index = await urlFor(SITE["index.html"]!);

  // Different bytes of the same size, a different size, and too many bytes.
  const same = SITE["index.html"]!.replace("Acme", "Evil");
  expect(await put(f.t, index, same)).toMatchObject({ status: 400, text: expect.stringContaining("SHA-256") });
  expect(await put(f.t, index, SITE["index.html"]!.slice(1))).toMatchObject({ status: 400, text: expect.stringContaining("size") });
  expect(await put(f.t, index, `${SITE["index.html"]!}x`)).toMatchObject({ status: 400 });
  // Another grant, or none.
  const forged = new URL(index);
  forged.searchParams.set("grant", "forged-grant");
  expect((await put(f.t, forged.toString(), SITE["index.html"]!)).status).toBe(400);
  forged.searchParams.delete("grant");
  expect((await put(f.t, forged.toString(), SITE["index.html"]!)).status).toBe(400);
  // A file not in the manifest.
  const other = new URL(index);
  other.searchParams.set("sha256", "b".repeat(64));
  expect((await put(f.t, other.toString(), "b")).status).toBe(400);
  // Publishing before every file is stored.
  expect(await outcome(f.dana.mutation(api.reviewBuilds.publish, { buildId: begun.buildId }))).toBe("4 of the build's files haven't finished uploading.");

  expect((await put(f.t, index, SITE["index.html"]!)).status).toBe(201);
  // The grant can't replace a file once taken.
  expect(await put(f.t, index, SITE["index.html"]!)).toEqual({ status: 409, text: "This file was already uploaded." });
  // An expired upload takes nothing more and can't be published.
  setSystemTime(new Date(Date.now() + BUILD_LIMITS.uploadMs + 1_000));
  expect((await put(f.t, await urlFor(SITE["assets/app.js"]!), SITE["assets/app.js"]!)).status).toBe(400);
  expect(await outcome(f.dana.mutation(api.reviewBuilds.publish, { buildId: begun.buildId }))).toBe("This upload expired or was removed. Run critiqs share again.");
  // Nothing was kept but the one exact file.
  expect(await f.t.run(async (ctx) => (await ctx.db.query("reviewBuildFiles").collect()).filter((file) => file.storageId !== undefined).map((file) => file.path))).toEqual(["index.html"]);
});

test("an interrupted share resumes: the same files again upload only what is missing, under a new grant", async () => {
  const f = await fixture();
  const files = await manifestOf(SITE);
  const first = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false });
  const sha = await sha256Hex(encoder.encode(SITE["index.html"]!));
  expect((await put(f.t, first.uploads.find((upload) => upload.sha256 === sha)!.url, SITE["index.html"]!)).status).toBe(201);
  const again = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: [...files].reverse(), spa: false });
  expect(again.buildId).toBe(first.buildId);
  expect(again.uploads.map((upload) => upload.sha256).sort()).toEqual(first.uploads.map((upload) => upload.sha256).filter((each) => each !== sha).sort());
  // The first grant is gone.
  expect((await put(f.t, first.uploads.find((upload) => upload.sha256 !== sha)!.url, "x")).status).toBe(400);
  // A different SPA setting is a different build.
  expect((await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: true })).buildId).not.toBe(first.buildId);
});

test("a shared build is served only as the project's review access allows: organization-only refuses outsiders and people signed out", async () => {
  const f = await fixture("organization");
  const shared = await share(f);
  expect(await f.t.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "sign-in" });
  expect(await f.lee.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "unavailable" });
  const member = await openLease(f.riley, shared.key);
  expect((await served(f.t, member.label, "/"))?.status).toBe(200);
  // The member leaves the organization: their lease serves nothing from the next question on.
  const rileyId = await f.t.run(async (ctx) => (await ctx.db.query("users").collect()).find((user) => user.email === "riley@example.com")!._id);
  const [organization] = await f.dana.query(api.organizations.mine, {});
  await f.dana.mutation(api.organizations.removeMember, { organizationId: organization!.id, userId: rileyId });
  expect(await served(f.t, member.label, "/")).toBeNull();
});

test("deleting a build stops its link and its files at once; cleanup removes the stored files, and threads stay", async () => {
  const f = await fixture();
  const shared = await share(f);
  const lease = await openLease(f.t, shared.key);
  expect((await served(f.t, lease.label, "/"))?.status).toBe(200);
  const listed = await f.dana.query(api.reviewBuilds.list, { projectId: f.projectId });
  expect(listed.map((build) => [build.buildId, build.url, build.fileCount])).toEqual([[shared.buildId, shared.url, 4]]);
  const links = await f.dana.query(api.reviewLinks.list, { projectId: f.projectId });
  expect(links.map((link) => [link.kind, link.build?.buildId])).toEqual([["share", shared.buildId]]);

  await f.dana.mutation(api.reviewBuilds.remove, { key: shared.key });
  expect(await served(f.t, lease.label, "/")).toBeNull();
  expect((await internalPost(f.t, "/internal/review/v1/resolve", { hostHash: await frameHostHash(lease.label) })).status).toBe(404);
  expect(await f.t.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "sign-in" });
  expect(await f.dana.query(api.reviewBuilds.list, { projectId: f.projectId })).toEqual([]);
  await f.t.finishAllScheduledFunctions(() => undefined);
  const left = await f.t.run(async (ctx) => ({ files: (await ctx.db.query("reviewBuildFiles").collect()).length, stored: (await ctx.db.system.query("_storage").collect()).length, build: (await ctx.db.get(shared.buildId as Id<"reviewBuilds">))! }));
  expect([left.files, left.stored, left.build.status, typeof left.build.purgedAt]).toEqual([0, 0, "deleted", "number"]);
  // Removing it again changes nothing; revoking its link from the links page is the same as deleting it.
  expect(await f.dana.mutation(api.reviewBuilds.remove, { buildId: shared.buildId })).toBeNull();
  const second = await share(f, { "index.html": "<h1>Two</h1>" });
  await f.dana.mutation(api.reviewLinks.revoke, { linkId: second.linkId });
  expect(await f.t.run(async (ctx) => (await ctx.db.get(second.buildId as Id<"reviewBuilds">))!.status)).toBe("deleted");
});

test("a build expires after its days: it stops serving at once, then cleanup ends it and removes its files", async () => {
  const f = await fixture();
  expect(await outcome(f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf(SITE), spa: false, expiresInDays: 31 }))).toBe("A shared build can be served for 1 to 30 days.");
  const shared = await share(f, SITE, { expiresInDays: 1 });
  const lease = await openLease(f.t, shared.key);
  setSystemTime(new Date(shared.expiresAt + 1));
  expect(await served(f.t, lease.label, "/")).toBeNull();
  expect(await f.t.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "sign-in" });
  await f.t.mutation(internal.reviewBuilds.expire, {});
  await f.t.finishAllScheduledFunctions(() => undefined);
  expect(await f.t.run(async (ctx) => [(await ctx.db.get(shared.buildId as Id<"reviewBuilds">))!.status, (await ctx.db.system.query("_storage").collect()).length])).toEqual(["expired", 0]);
});

test("a project has at most five shared builds at once, and a person starts at most ten a day", async () => {
  const f = await fixture();
  for (let n = 0; n < BUILD_LIMITS.readyPerProject; n++) await share(f, { "index.html": `<h1>${n}</h1>` });
  expect(await outcome(f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf({ "index.html": "six" }), spa: false }))).toContain("5 shared builds at once");
  const second = await f.dana.mutation(api.projects.create, { name: "Second" });
  for (let n = BUILD_LIMITS.readyPerProject; n < BUILD_LIMITS.beginsPerPersonPerDay; n++) await f.dana.mutation(api.reviewBuilds.begin, { projectId: second, files: await manifestOf({ "index.html": `${n}` }), spa: false });
  expect(await outcome(f.dana.mutation(api.reviewBuilds.begin, { projectId: second, files: await manifestOf({ "index.html": "eleventh" }), spa: false }))).toBe("You can share 10 builds a day. Try again tomorrow.");
});

// ---------------------------------------------------------------------------
// Round 3: the protections the review found untested, and the open-tab and expiry gaps

const userIdOf = async (f: Fixture, email: string) => await f.t.run(async (ctx) => (await ctx.db.query("users").collect()).find((user) => user.email === email)!._id);

test("M13: the same files shared into a second project start that project's own upload, never resume the first project's", async () => {
  const f = await fixture();
  const files = await manifestOf(SITE);
  const inPilot = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false });
  const second = await f.dana.mutation(api.projects.create, { name: "Second" });
  const inSecond = await f.dana.mutation(api.reviewBuilds.begin, { projectId: second, files, spa: false });
  expect(inSecond.buildId).not.toBe(inPilot.buildId);
  expect(await f.t.run(async (ctx) => (await ctx.db.get(inSecond.buildId))!.projectId)).toBe(second);
  // Back to the first project: its own upload resumes, though the second project's is newer.
  const resumed = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files, spa: false });
  expect(resumed.buildId).toBe(inPilot.buildId);
});

test("M5: someone who stops managing the project mid-upload can't upload another file, or publish", async () => {
  const f = await fixture();
  const [organization] = await f.dana.query(api.organizations.mine, {});
  const rileyId = await userIdOf(f, "riley@example.com");
  await f.dana.mutation(api.organizations.setRole, { organizationId: organization!.id, userId: rileyId, role: "admin" });
  const begun = await f.riley.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf(SITE), spa: false });
  await f.dana.mutation(api.organizations.setRole, { organizationId: organization!.id, userId: rileyId, role: "member" });
  const sha = await sha256Hex(encoder.encode(SITE["index.html"]!));
  expect(await put(f.t, begun.uploads.find((upload) => upload.sha256 === sha)!.url, SITE["index.html"]!)).toEqual({ status: 400, text: "This upload is unavailable." });
  expect(await outcome(f.riley.mutation(api.reviewBuilds.publish, { buildId: begun.buildId }))).toBe("Only the project's owners can create or change its review links.");
});

test("M6: a stored file is bound to the build only with the build's current grant, before the upload expires", async () => {
  const f = await fixture();
  const begun = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf(SITE), spa: false });
  const grant = new URL(begun.uploads[0]!.url).searchParams.get("grant")!;
  const sha256 = begun.uploads[0]!.sha256;
  const storageId = await f.t.run(async (ctx) => await ctx.storage.store(new Blob(["x"])));
  expect(await f.t.mutation(internal.reviewBuilds.finishUpload, { buildId: begun.buildId, sha256, grant: "not-the-grant", storageId })).toBe(false);
  setSystemTime(new Date(Date.now() + BUILD_LIMITS.uploadMs + 1));
  expect(await f.t.mutation(internal.reviewBuilds.finishUpload, { buildId: begun.buildId, sha256, grant, storageId })).toBe(false);
  setSystemTime();
  expect(await f.t.mutation(internal.reviewBuilds.finishUpload, { buildId: begun.buildId, sha256, grant, storageId })).toBe(true);
});

test("M3: a share link serves only the build that names it", async () => {
  const f = await fixture();
  const first = await share(f);
  const second = await share(f, { "index.html": "<h1>Two</h1>" });
  // The second link pointed at the first build, whose own link is another: refused.
  await f.t.run(async (ctx) => await ctx.db.patch(second.linkId as Id<"reviewLinks">, { buildId: first.buildId as Id<"reviewBuilds"> }));
  expect(await f.dana.mutation(api.reviewLinks.open, { key: second.key })).toEqual({ kind: "unavailable" });
});

test("a build's files are judged at the time the proxy asks, which the HTTP action passes in, so no cached answer outlives the build", async () => {
  const f = await fixture();
  const shared = await share(f, SITE, { expiresInDays: 1 });
  const lease = await openLease(f.t, shared.key);
  const hostHash = await frameHostHash(lease.label);
  expect(await f.t.query(internal.reviewBuilds.fileForHost, { hostHash, path: "/", now: Date.now() })).not.toBeNull();
  expect(await f.t.query(internal.reviewBuilds.fileForHost, { hostHash, path: "/", now: shared.expiresAt })).toBeNull();
  const sha256 = await sha256Hex(encoder.encode(SITE["index.html"]!));
  expect(await f.t.query(internal.reviewBuilds.blobForHost, { hostHash, sha256, now: Date.now() })).not.toBeNull();
  expect(await f.t.query(internal.reviewBuilds.blobForHost, { hostHash, sha256, now: shared.expiresAt })).toBeNull();
});

test("an open tab's watch on its lease says ended as soon as the build is deleted", async () => {
  const f = await fixture();
  const shared = await share(f);
  const lease = await openLease(f.t, shared.key);
  const watch = () => f.t.query(api.reviewLinks.leaseState, { leaseId: lease.entry.leaseId, renewalSecret: lease.entry.renewalSecret });
  expect(await watch()).toEqual({ kind: "live" });
  await f.dana.mutation(api.reviewBuilds.remove, { buildId: shared.buildId });
  expect(await watch()).toEqual({ kind: "ended" });
});

test("a build that ran out says so to someone it was open to; a deleted one, and anyone it wasn't open to, get the usual answer", async () => {
  const f = await fixture("organization");
  const shared = await share(f, SITE, { expiresInDays: 1 });
  setSystemTime(new Date(shared.expiresAt + 1));
  expect(await f.riley.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "expired", expiredAt: shared.expiresAt });
  expect(await f.lee.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "unavailable" });
  expect(await f.t.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "sign-in" });
  // Still so once cleanup has ended it.
  await f.t.mutation(internal.reviewBuilds.expire, {});
  expect(await f.riley.mutation(api.reviewLinks.open, { key: shared.key })).toEqual({ kind: "expired", expiredAt: shared.expiresAt });
  setSystemTime();
  const deleted = await share(f, { "index.html": "<h1>Gone</h1>" });
  await f.dana.mutation(api.reviewBuilds.remove, { buildId: deleted.buildId });
  expect(await f.riley.mutation(api.reviewLinks.open, { key: deleted.key })).toEqual({ kind: "unavailable" });
});

test("someone signed in whom the deployment has never seen gets the owners-only sentence from the builds list", async () => {
  const f = await fixture();
  const olive = f.t.withIdentity(reviewer("Olive"));
  expect(await outcome(olive.query(api.reviewBuilds.list, { projectId: f.projectId }))).toBe("Only the project's owners can create or change its review links.");
});

test("a build ending isn't counted among the project's five once it has run out, before cleanup gets to it", async () => {
  const f = await fixture();
  for (let n = 0; n < BUILD_LIMITS.readyPerProject; n++) await share(f, { "index.html": `<h1>${n}</h1>` }, { expiresInDays: 1 });
  setSystemTime(new Date(Date.now() + 24 * 60 * 60_000 + 60_000));
  const begun = await f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf({ "index.html": "sixth" }), spa: false });
  expect(begun.ready).toBe(false);
});

test("a file under the proxy's own folder, __critiqs/, is refused at upload: it could never be served", async () => {
  const f = await fixture();
  expect(await outcome(f.dana.mutation(api.reviewBuilds.begin, { projectId: f.projectId, files: await manifestOf({ ...SITE, "__critiqs/app.js": "x" }), spa: false }))).toContain("__critiqs/");
});
