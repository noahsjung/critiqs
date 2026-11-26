import {
  BUILD_LIMITS,
  type BuildFileAnswer,
  buildDays,
  buildLookup,
  buildOrigin,
  checkBuildManifest,
  countWithinAll,
  deriveLinkKey,
  fail,
  linkKeyHash,
  manifestDigest,
  newBuildPublicId,
  operations,
  projectAccess,
  sha256Hex,
  utcDay,
} from "@critiqs/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { convexStore, identityOf, run } from "./lib/store";
import { hashSecret, randomSecret } from "./lib/tokens";
import { endBuild, hostResolution, KEY_VERSION, linkKey, managed, OFF, reviewSetup, ringSecret } from "./reviewLinks";

// Shared builds (`critiqs share <folder>`) on Convex. Someone who manages a
// project — the same people who may create its review links — starts an
// upload with the build's manifest (`begin`): every rule in
// `@critiqs/server/review-builds` is checked here again, and each distinct
// file is uploaded once to `/review-build/upload` with a one-use grant only
// that person holds; the route checks its size and SHA-256 against the
// manifest before anything is kept. `publish` makes the build a review link
// of kind `share`, served through the review proxy like a live link, under
// the same project review access, until the build expires or is deleted.
// Then cleanup removes its stored files; threads left on it keep the build's
// `.build.invalid` address.

const DAY_MS = 24 * 60 * 60_000;

function invalid(message: string): never {
  throw new ConvexError({ code: "invalid", message });
}

/** Addresses the command line uploads each distinct file to, once. */
function uploadUrls(buildId: Id<"reviewBuilds">, grant: string, files: Doc<"reviewBuildFiles">[]) {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is not configured.");
  const seen = new Set<string>();
  const uploads: { sha256: string; size: number; url: string }[] = [];
  for (const file of files) {
    if (file.storageId !== undefined || seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    uploads.push({ sha256: file.sha256, size: file.size, url: `${site.replace(/\/$/, "")}/review-build/upload?buildId=${buildId}&sha256=${file.sha256}&grant=${encodeURIComponent(grant)}` });
  }
  return uploads;
}

async function filesOf(ctx: QueryCtx, buildId: Id<"reviewBuilds">): Promise<Doc<"reviewBuildFiles">[]> {
  return await ctx.db
    .query("reviewBuildFiles")
    .withIndex("by_build_path", (q) => q.eq("buildId", buildId))
    .take(BUILD_LIMITS.files + 1);
}

/** The project's builds being served now: one that has run out doesn't count, though cleanup hasn't ended it yet. */
async function readyCount(ctx: QueryCtx, projectId: Id<"projects">, now: number): Promise<number> {
  return (
    await ctx.db
      .query("reviewBuilds")
      .withIndex("by_project_status", (q) => q.eq("projectId", projectId).eq("status", "ready"))
      .take(BUILD_LIMITS.readyPerProject * 4)
  ).filter((build) => (build.expiresAt ?? 0) > now).length;
}

const fresh = (build: Doc<"reviewBuilds">, now: number) => build.status === "uploading" && now - build.createdAt < BUILD_LIMITS.uploadMs;

export interface BuildBegun {
  buildId: Id<"reviewBuilds">;
  /** Already published: `publish` returns its link. */
  ready: boolean;
  /** The files still to upload, each distinct file once. */
  uploads: { sha256: string; size: number; url: string }[];
  fileCount: number;
  bytes: number;
}

/**
 * Starts sharing a build in a project, or resumes the same person's upload
 * of the same files with a new grant. Only the project's owners may. Refuses
 * anything outside the rules for shared builds, and past the project's ready
 * builds or the person's uploads for the day.
 */
export const begin = mutation({
  args: {
    projectId: v.string(),
    files: v.array(v.object({ path: v.string(), size: v.number(), sha256: v.string() })),
    spa: v.boolean(),
    expiresInDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BuildBegun> =>
    run(async () => {
      if (reviewSetup() === null) fail("unavailable", OFF);
      const store = convexStore(ctx);
      const { user, project } = await managed(ctx, store, args.projectId);
      if (args.files.length > BUILD_LIMITS.files) fail("invalid", `A shared build can have at most ${BUILD_LIMITS.files} files; this one has ${args.files.length}.`);
      const manifest = checkBuildManifest(args.files);
      const days = buildDays(args.expiresInDays);
      const digest = await manifestDigest(manifest, args.spa);
      const now = Date.now();
      const userId = user._id as Id<"users">;

      // This person's latest build of these files in this project: the same files shared into another project are that project's own.
      const earlier =
        (
          await ctx.db
            .query("reviewBuilds")
            .withIndex("by_creator_digest", (q) => q.eq("createdBy", userId).eq("manifestDigest", digest))
            .order("desc")
            .take(BUILD_LIMITS.beginsPerPersonPerDay * 3)
        ).find((build) => build.projectId === project._id) ?? null;
      if (earlier !== null && earlier.projectId === project._id) {
        if (earlier.status === "ready" && (earlier.expiresAt ?? 0) > now) return { buildId: earlier._id, ready: true, uploads: [], fileCount: earlier.fileCount, bytes: earlier.bytes };
        if (fresh(earlier, now)) {
          // The same upload again, as after an interruption: a new grant, and only the files not yet stored.
          const grant = randomSecret();
          await ctx.db.patch(earlier._id, { grantHash: await hashSecret(grant), days });
          return { buildId: earlier._id, ready: false, uploads: uploadUrls(earlier._id, grant, await filesOf(ctx, earlier._id)), fileCount: earlier.fileCount, bytes: earlier.bytes };
        }
      }

      if ((await readyCount(ctx, project._id, now)) >= BUILD_LIMITS.readyPerProject) {
        fail("limit", `A project can have ${BUILD_LIMITS.readyPerProject} shared builds at once. Delete one first (critiqs share list, then critiqs share delete <id>).`);
      }
      if (!(await countWithinAll(store, [[`reviewBuildBegins:${userId}:${utcDay(now)}`, BUILD_LIMITS.beginsPerPersonPerDay]]))) {
        fail("limit", `You can share ${BUILD_LIMITS.beginsPerPersonPerDay} builds a day. Try again tomorrow.`);
      }
      const grant = randomSecret();
      const buildId = await ctx.db.insert("reviewBuilds", {
        projectId: project._id,
        createdBy: userId,
        createdAt: now,
        status: "uploading",
        spa: args.spa,
        fileCount: manifest.files.length,
        bytes: manifest.bytes,
        manifestDigest: digest,
        publicId: newBuildPublicId(),
        grantHash: await hashSecret(grant),
        days,
      });
      for (const file of manifest.files) {
        await ctx.db.insert("reviewBuildFiles", { buildId, path: file.path, sha256: file.sha256, size: file.size, contentType: file.contentType });
      }
      return { buildId, ready: false, uploads: uploadUrls(buildId, grant, await filesOf(ctx, buildId)), fileCount: manifest.files.length, bytes: manifest.bytes };
    }),
});

/** What publishing a build gives: its review link. */
export interface PublishedBuild {
  buildId: Id<"reviewBuilds">;
  linkId: Id<"reviewLinks">;
  url: string;
  expiresAt: number;
}

async function publishedAnswer(ctx: QueryCtx, build: Doc<"reviewBuilds">, website: string): Promise<PublishedBuild> {
  const link = build.linkId === undefined ? null : await ctx.db.get(build.linkId);
  const key = link === null ? null : await linkKey(ctx, link);
  if (link === null || key === null || build.expiresAt === undefined) fail("unavailable", "This build is no longer shared.");
  return { buildId: build._id, linkId: link._id, url: `${website}/r/${key}`, expiresAt: build.expiresAt };
}

/**
 * Publishes an uploaded build once every file is stored: it becomes a review
 * link of kind `share` and is served until it expires. Only the person who
 * uploaded it, while they still manage the project. Publishing again returns
 * the same link.
 */
export const publish = mutation({
  args: { buildId: v.string() },
  handler: async (ctx, args): Promise<PublishedBuild> =>
    run(async () => {
      const setup = reviewSetup();
      if (setup === null) fail("unavailable", OFF);
      const user = await operations.requireUser(convexStore(ctx), await identityOf(ctx));
      const id = ctx.db.normalizeId("reviewBuilds", args.buildId);
      const build = id === null ? null : await ctx.db.get(id);
      if (build === null || build.createdBy !== user._id) fail("not-found", "This upload does not exist.");
      await managed(ctx, convexStore(ctx), build.projectId);
      const now = Date.now();
      if (build.status === "ready" && (build.expiresAt ?? 0) > now) return await publishedAnswer(ctx, build, setup.website);
      if (!fresh(build, now)) fail("invalid", "This upload expired or was removed. Run critiqs share again.");
      const files = await filesOf(ctx, build._id);
      const missing = files.filter((file) => file.storageId === undefined).length;
      if (missing > 0 || files.length !== build.fileCount) fail("invalid", `${missing} of the build's files haven't finished uploading.`);
      if ((await readyCount(ctx, build.projectId, now)) >= BUILD_LIMITS.readyPerProject) {
        fail("limit", `A project can have ${BUILD_LIMITS.readyPerProject} shared builds at once. Delete one first (critiqs share list, then critiqs share delete <id>).`);
      }
      const linkId = await ctx.db.insert("reviewLinks", {
        projectId: build.projectId,
        kind: "share",
        origin: buildOrigin(build.publicId),
        startPath: "/",
        assetOrigins: [],
        buildId: build._id,
        keyHash: "",
        keyVersion: KEY_VERSION,
        // No address to check: it is served once published.
        status: "active",
        createdBy: build.createdBy,
        createdAt: now,
      });
      const key = await deriveLinkKey((await ringSecret(ctx, KEY_VERSION))!, linkId, KEY_VERSION);
      await ctx.db.patch(linkId, { keyHash: await linkKeyHash(key) });
      const expiresAt = now + build.days * DAY_MS;
      await ctx.db.patch(build._id, { status: "ready", expiresAt, linkId });
      return { buildId: build._id, linkId, url: `${setup.website}/r/${key}`, expiresAt };
    }),
});

export interface SharedBuildSummary {
  buildId: Id<"reviewBuilds">;
  url: string;
  createdAt: number;
  expiresAt: number;
  fileCount: number;
  bytes: number;
  createdByName: string;
}

/** A project's shared builds being served, newest first, with their links, for its owners. */
export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<SharedBuildSummary[]> =>
    run(async () => {
      const setup = reviewSetup();
      if (setup === null) fail("unavailable", OFF);
      const { project } = await managed(ctx, convexStore(ctx), args.projectId);
      const builds = await ctx.db
        .query("reviewBuilds")
        .withIndex("by_project_status", (q) => q.eq("projectId", project._id).eq("status", "ready"))
        .take(BUILD_LIMITS.readyPerProject * 2);
      const summaries: SharedBuildSummary[] = [];
      for (const build of builds.sort((a, b) => b.createdAt - a.createdAt)) {
        const { url, expiresAt } = await publishedAnswer(ctx, build, setup.website);
        summaries.push({ buildId: build._id, url, createdAt: build.createdAt, expiresAt, fileCount: build.fileCount, bytes: build.bytes, createdByName: (await ctx.db.get(build.createdBy))?.name ?? "Reviewer" });
      }
      return summaries;
    }),
});

/**
 * Stops sharing a build at once, by its ID or its review link's key: its
 * link stops opening and serving, and its files are removed. Only the
 * project's owners may. Removing it again changes nothing.
 */
export const remove = mutation({
  args: { buildId: v.optional(v.string()), key: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> =>
    run(async () => {
      const store = convexStore(ctx);
      // Signed in first, so someone signed out learns nothing about which builds exist.
      await operations.requireUser(store, await identityOf(ctx));
      let build: Doc<"reviewBuilds"> | null = null;
      if (args.buildId !== undefined) {
        const id = ctx.db.normalizeId("reviewBuilds", args.buildId);
        build = id === null ? null : await ctx.db.get(id);
      } else if (args.key !== undefined && /^[a-z2-7]{26}$/.test(args.key)) {
        const keyHash = await linkKeyHash(args.key);
        const link = await ctx.db
          .query("reviewLinks")
          .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
          .unique();
        build = link?.buildId === undefined ? null : await ctx.db.get(link.buildId);
      }
      if (build === null) fail("not-found", "This shared build does not exist.");
      await managed(ctx, store, build.projectId);
      await endBuild(ctx, build._id, "deleted");
      return null;
    }),
});

// ---------------------------------------------------------------------------
// The upload route: `POST /review-build/upload?buildId=&sha256=&grant=`

/** The file an upload is for: an unexpired upload's grant, a SHA-256 in its manifest not yet stored, and its uploader still an owner. */
export const uploadTarget = internalQuery({
  args: { buildId: v.string(), sha256: v.string(), grant: v.string() },
  handler: async (ctx, args): Promise<{ size: number; contentType: string }> => {
    const id = ctx.db.normalizeId("reviewBuilds", args.buildId);
    const build = id === null ? null : await ctx.db.get(id);
    if (build === null || (await hashSecret(args.grant)) !== build.grantHash) invalid("This upload is unavailable.");
    if (!fresh(build, Date.now())) invalid("This upload expired. Run critiqs share again.");
    if ((await projectAccess(convexStore(ctx), (await ctx.db.get(build.projectId))!, build.createdBy)) !== "manage") invalid("This upload is unavailable.");
    const files = await ctx.db
      .query("reviewBuildFiles")
      .withIndex("by_build_hash", (q) => q.eq("buildId", build._id).eq("sha256", args.sha256))
      .take(BUILD_LIMITS.files);
    if (files.length === 0) invalid("This file isn't in the build's list of files.");
    // Each file is taken once: a grant can't be used to replace what was checked.
    if (files.every((file) => file.storageId !== undefined)) throw new ConvexError({ code: "conflict", message: "This file was already uploaded." });
    return { size: files[0]!.size, contentType: files[0]!.contentType };
  },
});

/** Records a stored, checked file on every manifest entry with its SHA-256; false when the upload ended meanwhile, or another copy won. */
export const finishUpload = internalMutation({
  args: { buildId: v.id("reviewBuilds"), sha256: v.string(), grant: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<boolean> => {
    const build = await ctx.db.get(args.buildId);
    if (build === null || (await hashSecret(args.grant)) !== build.grantHash || !fresh(build, Date.now())) return false;
    const files = await ctx.db
      .query("reviewBuildFiles")
      .withIndex("by_build_hash", (q) => q.eq("buildId", build._id).eq("sha256", args.sha256))
      .take(BUILD_LIMITS.files);
    const open = files.filter((file) => file.storageId === undefined);
    if (open.length === 0) return false;
    for (const file of open) await ctx.db.patch(file._id, { storageId: args.storageId });
    return true;
  },
});

const UPLOAD_HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };

function uploadFailure(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string; message?: string };
    const status = ({ invalid: 400, conflict: 409, "too-large": 413 } as Record<string, number>)[data.code ?? ""] ?? 400;
    return new Response(data.message ?? "The upload was refused.", { status, headers: UPLOAD_HEADERS });
  }
  return new Response("Storage is unavailable. Try again shortly.", { status: 503, headers: UPLOAD_HEADERS });
}

/**
 * One file of a build. The body is read up to the size the manifest gave
 * and no further, hashed, and kept only when its size and SHA-256 both match;
 * it is stored with the type the server gave its extension.
 */
export const upload = httpAction(async (ctx, request): Promise<Response> => {
  try {
    const params = new URL(request.url).searchParams;
    const buildId = params.get("buildId") ?? "";
    const sha256 = params.get("sha256") ?? "";
    const grant = params.get("grant") ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha256) || grant === "") invalid("This upload is unavailable.");
    const target = await ctx.runQuery(internal.reviewBuilds.uploadTarget, { buildId, sha256, grant });
    const length = request.headers.get("Content-Length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== target.size)) invalid("The file's size doesn't match the build's list of files.");
    const reader = request.body?.getReader();
    const body = new Uint8Array(target.size);
    let size = 0;
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > target.size) {
          await reader.cancel();
          invalid("The file is larger than the build's list of files says.");
        }
        body.set(value, size);
        size += value.byteLength;
      }
    }
    if (size !== target.size) invalid("The file's size doesn't match the build's list of files.");
    if ((await sha256Hex(body)) !== sha256) invalid("The file's contents don't match its SHA-256 in the build's list of files.");
    const storageId = await ctx.storage.store(new Blob([body], { type: target.contentType }));
    const kept = await ctx.runMutation(internal.reviewBuilds.finishUpload, { buildId: buildId as Id<"reviewBuilds">, sha256, grant, storageId }).catch(() => false);
    if (!kept) {
      // Never left behind unbound: nothing would ever serve or remove it.
      await ctx.storage.delete(storageId);
      throw new ConvexError({ code: "conflict", message: "This file was already uploaded, or the upload ended." });
    }
    return new Response("Stored", { status: 201, headers: UPLOAD_HEADERS });
  } catch (error) {
    return uploadFailure(error);
  }
});

// ---------------------------------------------------------------------------
// The proxy: a shared build's files (`/internal/review/v1/build-file`, `build-blob`)

/** The build a frame host serves at `now`, the time the proxy asked (passed in by the HTTP action, so a cached answer can't outlive the build). */
async function buildOfHost(ctx: QueryCtx, hostHash: string, now: number): Promise<Doc<"reviewBuilds"> | null> {
  const resolved = await hostResolution(ctx, hostHash, now);
  if (resolved === null || resolved.resolution.kind !== "share" || resolved.link.buildId === undefined) return null;
  return await ctx.db.get(resolved.link.buildId);
}

/** The file a shared build's frame host serves for `path` now (`buildLookup`), or null when the host serves nothing or no file matches. */
export const fileForHost = internalQuery({
  args: { hostHash: v.string(), path: v.string(), now: v.number() },
  handler: async (ctx, { hostHash, path, now }): Promise<BuildFileAnswer | null> => {
    const build = await buildOfHost(ctx, hostHash, now);
    const lookup = build === null ? null : buildLookup(path, build.spa);
    if (build === null || lookup === null) return null;
    const tries: [string, 200 | 404][] = [...lookup.candidates.map((candidate) => [candidate, 200] as [string, 200]), ...lookup.fallbacks.map((entry) => [entry.path, entry.status] as [string, 200 | 404])];
    for (const [candidate, status] of tries) {
      const file = await ctx.db
        .query("reviewBuildFiles")
        .withIndex("by_build_path", (q) => q.eq("buildId", build._id).eq("path", candidate))
        .unique();
      if (file?.storageId !== undefined) return { status, sha256: file.sha256, size: file.size, contentType: file.contentType };
    }
    return null;
  },
});

/** The stored file with `sha256` in the build a frame host serves now, or null. */
export const blobForHost = internalQuery({
  args: { hostHash: v.string(), sha256: v.string(), now: v.number() },
  handler: async (ctx, { hostHash, sha256, now }): Promise<Id<"_storage"> | null> => {
    const build = await buildOfHost(ctx, hostHash, now);
    if (build === null) return null;
    const file = await ctx.db
      .query("reviewBuildFiles")
      .withIndex("by_build_hash", (q) => q.eq("buildId", build._id).eq("sha256", sha256))
      .first();
    return file?.storageId ?? null;
  },
});

// ---------------------------------------------------------------------------
// Expiry and cleanup

/** Builds and files cleanup handles in one run; a full batch runs it again at once. */
const BATCH = 100;

/** Ends builds past their expiry and uploads never published in time. Runs every 10 minutes. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("reviewBuilds")
      .withIndex("by_status_expiry", (q) => q.eq("status", "ready").lte("expiresAt", now))
      .take(BATCH);
    for (const build of expired) await endBuild(ctx, build._id, "expired");
    const abandoned = await ctx.db
      .query("reviewBuilds")
      .withIndex("by_status_created", (q) => q.eq("status", "uploading").lte("createdAt", now - BUILD_LIMITS.uploadMs))
      .take(BATCH);
    for (const build of abandoned) await endBuild(ctx, build._id, "deleted");
    if (expired.length === BATCH || abandoned.length === BATCH) await ctx.scheduler.runAfter(0, internal.reviewBuilds.expire, {});
    return { expired: expired.length, abandoned: abandoned.length };
  },
});

async function purgeOne(ctx: MutationCtx, build: Doc<"reviewBuilds">): Promise<boolean> {
  const files = await ctx.db
    .query("reviewBuildFiles")
    .withIndex("by_build_path", (q) => q.eq("buildId", build._id))
    .take(BATCH);
  const deleted = new Set<string>();
  for (const file of files) {
    if (file.storageId !== undefined && !deleted.has(file.storageId)) {
      deleted.add(file.storageId);
      if ((await ctx.db.system.get(file.storageId)) !== null) await ctx.storage.delete(file.storageId);
    }
    await ctx.db.delete(file._id);
  }
  if (files.length < BATCH) await ctx.db.patch(build._id, { purgedAt: Date.now() });
  return files.length === BATCH;
}

/** Removes the stored files of ended builds, a batch per run. Builds' rows stay, so their links still say what they were. */
export const purge = internalMutation({
  args: {},
  handler: async (ctx) => {
    let more = false;
    for (const status of ["expired", "deleted"] as const) {
      const ended = await ctx.db
        .query("reviewBuilds")
        .withIndex("by_status_purged", (q) => q.eq("status", status).eq("purgedAt", undefined))
        .take(11);
      for (const build of ended.slice(0, 10)) more = (await purgeOne(ctx, build)) || more;
      more ||= ended.length > 10;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.reviewBuilds.purge, {});
    return more;
  },
});
