import { fail } from "./errors.ts";

// Shared builds (`critiqs share <folder>`): the rules the backend checks every
// upload against, and how the review proxy finds the file a frame asks for.
// A build is a folder of static files that someone who manages the project
// uploads to the deployment's own storage. It is served through the same
// per-viewer lease hosts as a live review link, with nothing fetched from
// anywhere else, so it is self-contained by construction. The command line
// checks the same rules first (`packages/critiqs/bin/share.mjs`; a test keeps
// the two in step), and the backend checks them again: nothing here trusts
// the uploader.

/** Pilot ceilings for shared builds, until plans set their own. */
export const BUILD_LIMITS = {
  files: 1_000,
  totalBytes: 50 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  cssBytes: 1024 * 1024,
  /** Characters in one file's path inside the build. */
  pathLength: 512,
  /** Builds a project may have ready at once. */
  readyPerProject: 5,
  /** Uploads one person may start in a day (UTC). */
  beginsPerPersonPerDay: 10,
  /** An upload must be published within this long of starting, or it is removed. */
  uploadMs: 30 * 60_000,
  /** Days a build is served unless its sharer says otherwise. */
  defaultDays: 7,
  minDays: 1,
  maxDays: 30,
} as const;

/**
 * The file types a build may hold, by extension, and the type each is served
 * with. The type is always the server's, never the uploader's. Source maps,
 * scripts for a server or a shell, and anything else not listed are refused.
 */
export const BUILD_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

/** A file in a build's manifest, as the command line sends it. */
export interface BuildFile {
  path: string;
  size: number;
  sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The extension of a path's last segment, lowercased, or null without one. */
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}

/** The type a build file is served with, or null for a type builds can't hold. */
export function buildContentType(path: string): string | null {
  const extension = extensionOf(path);
  return extension === null ? null : (BUILD_TYPES[extension] ?? null);
}

/**
 * Why a path can't be a file in a build, or null when it can: a plain
 * relative path of `/`-separated names, none of them empty, `.`, `..` or
 * hidden (a dotfile such as `.env` or `.git`), with no backslash, control
 * character or NUL, and a type builds may hold.
 */
export function buildPathProblem(path: string): string | null {
  if (typeof path !== "string" || path === "") return "has no name";
  if (path.length > BUILD_LIMITS.pathLength) return `has a path longer than ${BUILD_LIMITS.pathLength} characters`;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "has a backslash or a control character in its name";
  if (path.startsWith("/")) return "is an absolute path";
  if (path.normalize("NFC") !== path) return "has a name that isn't in Unicode normal form C";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "isn't a plain path inside the folder";
    if (segment.startsWith(".")) return "is hidden (its name or a folder's starts with a dot)";
  }
  if (path.split("/")[0] === "__critiqs") return "is in __critiqs/, a folder review links keep for themselves, so it could never be served";
  const extension = extensionOf(path);
  if (extension === "map") return "is a source map, which would publish the app's source";
  if (buildContentType(path) === null) return "isn't a file type a static build serves";
  return null;
}

/** The key two paths collide on: browsers and storage may treat names that differ only in case as one. */
const collisionKey = (path: string) => path.normalize("NFC").toLowerCase();

/** A build's manifest after every check: files sorted by path, with their sizes in total. */
export interface CheckedManifest {
  files: (BuildFile & { contentType: string })[];
  bytes: number;
}

/** Checks a manifest against every rule; throws an `invalid` failure naming the first file that breaks one. */
export function checkBuildManifest(files: readonly BuildFile[]): CheckedManifest {
  if (!Array.isArray(files) || files.length === 0) fail("invalid", "The folder has no files to share.");
  if (files.length > BUILD_LIMITS.files) fail("invalid", `A shared build can have at most ${BUILD_LIMITS.files} files; this one has ${files.length}.`);
  const seen = new Map<string, string>();
  const checked: CheckedManifest["files"] = [];
  let bytes = 0;
  for (const file of files) {
    const path = typeof file?.path === "string" ? file.path : "";
    const problem = buildPathProblem(path);
    if (problem !== null) fail("invalid", `${JSON.stringify(path.slice(0, 200))} ${problem}.`);
    const key = collisionKey(path);
    const earlier = seen.get(key);
    if (earlier !== undefined) fail("invalid", `${JSON.stringify(path)} and ${JSON.stringify(earlier)} name the same file.`);
    seen.set(key, path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) fail("invalid", `${JSON.stringify(path)} has no valid size.`);
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) fail("invalid", `${JSON.stringify(path)} has no valid SHA-256.`);
    const contentType = buildContentType(path)!;
    const limit = contentType.startsWith("text/html") ? BUILD_LIMITS.htmlBytes : contentType.startsWith("text/css") ? BUILD_LIMITS.cssBytes : BUILD_LIMITS.fileBytes;
    if (file.size > limit) fail("invalid", `${JSON.stringify(path)} is larger than ${limit / 1024 / 1024} MiB, the most a shared ${contentType.startsWith("text/html") ? "page" : contentType.startsWith("text/css") ? "stylesheet" : "file"} can be.`);
    bytes += file.size;
    checked.push({ path, size: file.size, sha256: file.sha256, contentType });
  }
  if (bytes > BUILD_LIMITS.totalBytes) fail("invalid", `A shared build can hold at most ${BUILD_LIMITS.totalBytes / 1024 / 1024} MiB; this one has ${(bytes / 1024 / 1024).toFixed(1)} MiB.`);
  if (!checked.some((file) => file.path === "index.html")) fail("invalid", "The folder needs an index.html at its top: share the built output, such as dist/ or build/.");
  checked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: checked, bytes };
}

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** The manifest's digest: the same files and SPA setting give the same digest, so a repeated upload resumes. */
export async function manifestDigest(manifest: CheckedManifest, spa: boolean): Promise<string> {
  const lines = manifest.files.map((file) => `${file.path}\n${file.size}\n${file.sha256}`);
  return await sha256Hex(encoder.encode(`critiqs-build-manifest\n${spa ? "spa" : "files"}\n${lines.join("\n")}`));
}

/** Days a build is served, from what its sharer asked for; throws for anything outside 1–30. */
export function buildDays(days: number | undefined): number {
  if (days === undefined) return BUILD_LIMITS.defaultDays;
  if (!Number.isSafeInteger(days) || days < BUILD_LIMITS.minDays || days > BUILD_LIMITS.maxDays) {
    fail("invalid", `A shared build can be served for ${BUILD_LIMITS.minDays} to ${BUILD_LIMITS.maxDays} days.`);
  }
  return days;
}

// ---------------------------------------------------------------------------
// The build's address in saved evidence

/**
 * Where a shared build's pages are said to be, in threads, exports and
 * anything else that keeps a page's address: `https://<publicId>.build.invalid`.
 * `.invalid` never resolves (RFC 2606), so the address names the build
 * without being one anybody can open, and it never carries the review link's
 * key or a frame host.
 */
export const BUILD_ORIGIN_SUFFIX = ".build.invalid";

/** A fresh public ID for a build: `b` and 20 base32 characters (100 random bits). */
export function newBuildPublicId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `b${[...crypto.getRandomValues(new Uint8Array(20))].map((byte) => alphabet[byte & 31]).join("")}`;
}

/** The origin a build's pages are said to be at. */
export function buildOrigin(publicId: string): string {
  return `https://${publicId}${BUILD_ORIGIN_SUFFIX}`;
}

/** Whether an origin is a shared build's (`https://<publicId>.build.invalid`). */
export function isBuildOrigin(origin: string): boolean {
  return /^https:\/\/b[a-z2-7]{20}\.build\.invalid$/.test(origin);
}

// ---------------------------------------------------------------------------
// Serving

/** Which of a build's files answers a request, and how: what the backend tells the proxy. */
export interface BuildFileAnswer {
  status: 200 | 404;
  sha256: string;
  size: number;
  /** The type the backend gave the file from its extension. */
  contentType: string;
}

/** The files a frame's path may stand for, in order, and what is served when none of them exists. */
export interface BuildLookup {
  /** Paths inside the build to try in order; the first that exists is served with 200. */
  candidates: string[];
  /** Tried after the candidates: `index.html` with 200 for a single-page app's route, then `404.html` with 404. */
  fallbacks: { path: string; status: 200 | 404 }[];
}

/**
 * Which file a request's path (as the browser sent it, percent-encoded) is.
 * `/` and paths ending in `/` are their folder's `index.html`; a path
 * without an extension may also be `<path>.html` or `<path>/index.html`, as
 * static hosts serve clean addresses. With `spa`, a path without an
 * extension that matches nothing is the app's `index.html`, so its router
 * can show the route; a missing file with an extension is never one, so a
 * missing asset is a 404 rather than a page. Null for a path no file can
 * have (`..`, a hidden name, bad percent-encoding): always a 404.
 */
export function buildLookup(pathname: string, spa: boolean): BuildLookup | null {
  if (!pathname.startsWith("/")) return null;
  const segments: string[] = [];
  const raw = pathname.slice(1).split("/");
  for (const [index, part] of raw.entries()) {
    let name: string;
    try {
      name = decodeURIComponent(part);
    } catch {
      return null;
    }
    // A trailing slash leaves one empty last segment: the folder itself.
    if (name === "" && index === raw.length - 1) continue;
    if (name === "" || name === "." || name === ".." || name.startsWith(".") || name.includes("/") || /[\u0000-\u001f\\]/.test(name)) return null;
    segments.push(name);
  }
  const path = segments.join("/");
  const folder = pathname.endsWith("/") || path === "";
  const candidates = folder ? [path === "" ? "index.html" : `${path}/index.html`] : extensionOf(path) === null ? [path, `${path}.html`, `${path}/index.html`] : [path];
  const fallbacks: BuildLookup["fallbacks"] = [];
  if (spa && (folder || extensionOf(path) === null)) fallbacks.push({ path: "index.html", status: 200 });
  fallbacks.push({ path: "404.html", status: 404 });
  return { candidates: candidates.filter((candidate) => candidate.length <= BUILD_LIMITS.pathLength), fallbacks };
}
