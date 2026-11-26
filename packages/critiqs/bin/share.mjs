/**
 * `critiqs share <folder>`: uploads a static build to the project's Critiqs
 * backend and prints a review link, so people can review it with nothing
 * installed. `critiqs share list` shows the project's shared builds and
 * `critiqs share delete <id or link>` stops one at once. Uses this
 * computer's sign-in (`critiqs sign-in`), and only someone who manages the
 * project may share. Dependency-free, like the rest of the command line.
 *
 * The folder rules here are the backend's (`@critiqs/server/review-builds`),
 * checked first so a refused file is named before anything is sent; the
 * backend checks every one of them again. A test keeps the two in step.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { connect, NotSignedInError } from "./agent.mjs";
import { CLOUD_BACKEND_URL, listMyProjects, projectInCode, SetupError } from "./setup.mjs";

export const BUILD_LIMITS = {
  files: 1_000,
  totalBytes: 50 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  cssBytes: 1024 * 1024,
  pathLength: 512,
  minDays: 1,
  maxDays: 30,
  defaultDays: 7,
};

/** Extensions a build may hold; everything else (source maps, scripts for a server or shell, keys) is refused. */
export const BUILD_EXTENSIONS = ["html", "htm", "css", "js", "mjs", "json", "webmanifest", "txt", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf", "wasm", "mp4", "webm", "mp3"];

/** Files only an app's source folder has; a build's output never does. */
const SOURCE_MARKS = ["package.json", "node_modules", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** Files operating systems leave in folders, skipped rather than refused: nothing would ever ask for them. */
const SYSTEM_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}

/** Why `path` can't be shared, or null when it can. The backend's `buildPathProblem`, word for word. */
export function buildPathProblem(path) {
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
  if (extension === null || !BUILD_EXTENSIONS.includes(extension)) return "isn't a file type a static build serves";
  return null;
}

function limitFor(path) {
  const extension = extensionOf(path);
  if (extension === "html" || extension === "htm") return { bytes: BUILD_LIMITS.htmlBytes, what: "page" };
  if (extension === "css") return { bytes: BUILD_LIMITS.cssBytes, what: "stylesheet" };
  return { bytes: BUILD_LIMITS.fileBytes, what: "file" };
}

/** Checks a manifest as the backend does; returns the first problem as a sentence, or null. */
export function manifestProblem(files) {
  if (files.length === 0) return "The folder has no files to share.";
  if (files.length > BUILD_LIMITS.files) return `A shared build can have at most ${BUILD_LIMITS.files} files; this one has ${files.length}.`;
  const seen = new Map();
  let bytes = 0;
  for (const file of files) {
    const problem = buildPathProblem(file.path);
    if (problem !== null) return `${JSON.stringify(file.path.slice(0, 200))} ${problem}.`;
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) return `${JSON.stringify(file.path)} and ${JSON.stringify(seen.get(key))} name the same file.`;
    seen.set(key, file.path);
    const limit = limitFor(file.path);
    if (file.size > limit.bytes) return `${JSON.stringify(file.path)} is larger than ${limit.bytes / 1024 / 1024} MiB, the most a shared ${limit.what} can be.`;
    bytes += file.size;
  }
  if (bytes > BUILD_LIMITS.totalBytes) return `A shared build can hold at most ${BUILD_LIMITS.totalBytes / 1024 / 1024} MiB; this one has ${(bytes / 1024 / 1024).toFixed(1)} MiB.`;
  if (!files.some((file) => file.path === "index.html")) return "The folder needs an index.html at its top: share the built output, such as dist/ or build/.";
  return null;
}

/**
 * Reads a build folder: every regular file, with its path inside the folder,
 * size and SHA-256. Symbolic links and anything that isn't a file or folder
 * are refused, never followed, so nothing outside the folder is read.
 */
export function readBuild(folder) {
  const root = resolve(folder);
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    throw new SetupError(`There is no folder at ${folder}. Build the prototype first, then share its output folder, such as dist/.`);
  }
  if (!stat.isDirectory()) throw new SetupError(`${folder} isn't a folder. Share the build's output folder, such as dist/.`);
  // An app's own folder, not what its build writes: say so before naming its first odd file.
  const source = SOURCE_MARKS.find((name) => existsSync(join(root, name)));
  if (source !== undefined) throw new SetupError(`${folder} looks like the app's source (it has ${source}), not its build output. Build the prototype first, then share the folder the build writes, such as dist/.`);
  const files = [];
  const skipped = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join("/");
      if (SYSTEM_JUNK.has(entry.name)) {
        skipped.push(path);
        continue;
      }
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new SetupError(`${JSON.stringify(path)} is a symbolic link. Shared builds hold only plain files: copy the file into the folder instead.`);
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (!info.isFile()) throw new SetupError(`${JSON.stringify(path)} isn't a plain file, so it can't be shared.`);
      const problem = buildPathProblem(path);
      if (problem !== null) throw new SetupError(`${JSON.stringify(path)} ${problem}. Remove it from the folder, or share only the build's output.`);
      if (info.size > BUILD_LIMITS.fileBytes) throw new SetupError(`${JSON.stringify(path)} is larger than ${BUILD_LIMITS.fileBytes / 1024 / 1024} MiB, the most a shared file can be.`);
      if (files.length >= BUILD_LIMITS.files) throw new SetupError(`A shared build can have at most ${BUILD_LIMITS.files} files.`);
      const bytes = readFileSync(full);
      files.push({ path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const problem = manifestProblem(files);
  if (problem !== null) throw new SetupError(problem);
  return { files, skipped, bytes: files.reduce((total, file) => total + file.size, 0) };
}

/** Whether a build is a single-page app by default: index.html is its only page besides 404.html. */
export function looksLikeSpa(files) {
  return files.filter((file) => /\.html?$/i.test(file.path) && file.path !== "404.html").length === 1;
}

function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A date as the review page shows it: in this computer's time zone and words, such as "Dec 2, 2026". */
export const day = (time) => new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Runs `work` over `items`, at most `limit` at a time. */
async function eachLimited(items, limit, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/**
 * Which project to share into: `--project`, else the one the app's code
 * names (in `--dir`, or the folder the command runs in), else the person's
 * only project. With several and none named, the choices are listed.
 */
async function chooseProject(options, { cwd, env, fetchFn }) {
  if (options.project !== null) return { projectId: options.project, backendUrl: options.backendUrl ?? null };
  const inCode = projectInCode(resolve(cwd, options.dir ?? "."), { env });
  if (inCode !== null) return { projectId: inCode.projectId, backendUrl: options.backendUrl ?? inCode.backendUrl };
  const session = await connect({ backendUrl: options.backendUrl ?? undefined, env, fetchFn, now: Date.now });
  const projects = await listMyProjects({ backendUrl: session.backend.backendUrl, accessToken: session.accessToken, fetchFn });
  if (projects.length === 1) return { projectId: projects[0]._id, backendUrl: options.backendUrl ?? null };
  if (projects.length === 0) throw new SetupError("You have no Critiqs project to share into. Start one at the Critiqs website, or run npx critiqs init in the app, then share again.");
  const choices = projects.slice(0, 20).map((project) => `  ${project._id}  ${project.name}`).join("\n");
  throw new SetupError(`Choose the project to share into with --project <id>:\n${choices}`);
}

const NOT_OFFERED = (backend) => `The Critiqs backend at ${backend} doesn't offer shared builds. Its operator needs to set up review links.`;

/** Shares a folder; resolves to the link, or throws a `SetupError` with what to do. */
export async function shareFolder(options, { cwd = process.cwd(), env = process.env, fetchFn = fetch, log = () => {} } = {}) {
  const days = options.expires ?? BUILD_LIMITS.defaultDays;
  if (!Number.isSafeInteger(days) || days < BUILD_LIMITS.minDays || days > BUILD_LIMITS.maxDays) throw new SetupError(`--expires takes ${BUILD_LIMITS.minDays} to ${BUILD_LIMITS.maxDays} days.`);
  const build = readBuild(resolve(cwd, options.folder));
  const spa = options.spa ?? looksLikeSpa(build.files);
  const { projectId, backendUrl } = await chooseProject(options, { cwd, env, fetchFn });
  const session = await connect({ backendUrl: backendUrl ?? undefined, env, fetchFn, now: Date.now });
  const backend = session.backend.backendUrl;
  const config = await fetchFn(`${session.backend.siteUrl}/critiqs/config`)
    .then((response) => response.json())
    .catch(() => null);
  if (config?.reviewLinks?.builds !== true) throw new SetupError(NOT_OFFERED(backend === CLOUD_BACKEND_URL ? "Critiqs Cloud" : backend));
  log(`Sharing ${build.files.length} files (${size(build.bytes)}) from ${options.folder}${spa ? " as a single-page app" : ""}…`);
  if (build.skipped.length > 0) log(`Skipped ${build.skipped.join(", ")}.`);

  const manifest = build.files.map(({ path, size: bytes, sha256 }) => ({ path, size: bytes, sha256 }));
  const begun = await session.mutate("reviewBuilds:begin", { projectId, files: manifest, spa, expiresInDays: days });
  const bySha = new Map(build.files.map((file) => [file.sha256, file]));
  const site = new URL(session.backend.siteUrl).origin;
  let sent = 0;
  await eachLimited(begun.uploads, 6, async (upload) => {
    const file = bySha.get(upload.sha256);
    // Only to this backend's own upload route, and only the file the backend asked for.
    if (file === undefined || new URL(upload.url).origin !== site || new URL(upload.url).pathname !== "/review-build/upload") throw new SetupError("The backend asked for an upload this build doesn't have.");
    let response;
    try {
      response = await fetchFn(upload.url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file.bytes, redirect: "error" });
    } catch {
      throw new SetupError(`Uploading ${file.path} failed: can't reach ${site}. Run the same command again to resume.`);
    }
    // 409: a copy of this file is already stored.
    if (!response.ok && response.status !== 409) throw new SetupError(`Uploading ${file.path} failed: ${(await response.text().catch(() => "")) || response.status}. Run the same command again to resume.`);
    sent++;
  });
  if (begun.uploads.length > 0) log(`Uploaded ${sent} ${sent === 1 ? "file" : "files"}.`);
  const published = await session.mutate("reviewBuilds:publish", { buildId: begun.buildId });
  // The same files, already shared: the link and its end date stay as they were.
  if (begun.ready) {
    log(`These files are already shared, so this is the same link${options.expires === null ? "" : `, still until ${day(published.expiresAt)}: --expires applies only to a new share. To change it, delete this one (npx critiqs share delete ${published.buildId}) and share again`}.`);
  }
  return { buildId: published.buildId, url: published.url, expiresAt: published.expiresAt, files: build.files.length, bytes: build.bytes, spa, projectId };
}

export async function listShares(options, { cwd = process.cwd(), env = process.env, fetchFn = fetch } = {}) {
  const { projectId, backendUrl } = await chooseProject(options, { cwd, env, fetchFn });
  const session = await connect({ backendUrl: backendUrl ?? undefined, env, fetchFn, now: Date.now });
  return { projectId, builds: await session.query("reviewBuilds:list", { projectId }) };
}

/** A build ID, or a review link's key from its address or the key alone. */
export function shareTarget(value) {
  const text = String(value ?? "").trim();
  const key = /(?:^|\/r\/)([a-z2-7]{26})(?:[/#?].*)?$/.exec(text)?.[1];
  if (key !== undefined) return { key };
  if (/^[a-z0-9]{8,64}$/i.test(text)) return { buildId: text };
  throw new SetupError("Give the shared build's ID (from critiqs share list) or its review link.");
}

export async function deleteShare(options, { env = process.env, fetchFn = fetch } = {}) {
  const target = shareTarget(options.target);
  const session = await connect({ backendUrl: options.backendUrl ?? undefined, env, fetchFn, now: Date.now });
  await session.mutate("reviewBuilds:remove", target);
  return target;
}

export const SHARE_USAGE = `Usage:
  critiqs share <folder>         Upload a static build and print a review link for it
  critiqs share list             The project's shared builds and their links
  critiqs share delete <id|link> Stop sharing a build at once and remove its files

Options:
  --project <id>     The project (default: the one the app's code names, or your only project)
  --dir <path>       The app whose code names the project (default: current folder)
  --backend <url>    A Critiqs backend other than Critiqs Cloud
  --spa, --no-spa    Serve index.html for unknown addresses without an extension
                     (default: on when index.html is the build's only page)
  --expires <days>   1 to 30 (default 7)
  --json             Print the result as JSON

Share the built output (dist/, build/, out/), never the source: whoever opens the
link can read every file in the folder. Source maps, hidden files and anything that
isn't a static web file are refused. Uses this computer's sign-in (critiqs sign-in);
only the project's owners can share.`;

/** Parses `share` arguments (after `share`); returns options or `{ error }`. */
export function parseShare(argv) {
  const options = { action: "share", folder: null, target: null, project: null, dir: null, backendUrl: null, spa: null, expires: null, json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = (flag) => {
      const next = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (next === undefined || next === "") throw new Error(`${flag} needs a value.`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") options.help = true;
      else if (arg === "--json") options.json = true;
      else if (arg === "--spa") options.spa = true;
      else if (arg === "--no-spa") options.spa = false;
      else if (arg === "--project" || arg.startsWith("--project=")) options.project = value("--project");
      else if (arg === "--dir" || arg.startsWith("--dir=")) options.dir = value("--dir");
      else if (arg === "--backend" || arg.startsWith("--backend=")) options.backendUrl = value("--backend");
      else if (arg === "--expires" || arg.startsWith("--expires=")) {
        const days = Number(value("--expires"));
        if (!Number.isSafeInteger(days) || days < BUILD_LIMITS.minDays || days > BUILD_LIMITS.maxDays) throw new Error(`--expires takes ${BUILD_LIMITS.minDays} to ${BUILD_LIMITS.maxDays} days.`);
        options.expires = days;
      } else if (arg.startsWith("-")) return { error: `Unknown option ${arg}.` };
      else positional.push(arg);
    } catch (error) {
      return { error: error.message };
    }
  }
  if (options.help) return options;
  if (options.backendUrl !== null) {
    try {
      new URL(options.backendUrl);
    } catch {
      return { error: "--backend needs a URL such as https://<deployment>.convex.cloud." };
    }
  }
  if (positional[0] === "list" && positional.length === 1) options.action = "list";
  else if (positional[0] === "delete") {
    if (positional.length !== 2) return { error: "Give the shared build's ID or link: critiqs share delete <id|link>." };
    options.action = "delete";
    options.target = positional[1];
  } else if (positional.length === 1) options.folder = positional[0];
  else return { error: positional.length === 0 ? "Name the folder to share, such as dist/." : `Unexpected argument ${positional.at(-1)}.` };
  return options;
}

/** Runs `critiqs share …`; resolves to the exit code: 0 done, 1 not done, 2 usage error. */
/** A sign-in message written for agents and people, for a person at a terminal: only the command. */
export function terminalSignIn(message) {
  return message
    .replace(/call the critiqs_sign_in tool with backend "[^"]*", or run/g, "run")
    .replace(/ with the critiqs_sign_in tool, or run `npx critiqs sign-in`\./g, ": run `npx critiqs sign-in`.");
}

export async function runShare(argv, { cwd = process.cwd(), print = console.log, env = process.env, fetchFn = fetch } = {}) {
  const options = parseShare(argv);
  if ("error" in options) {
    print(`${options.error}\n\n${SHARE_USAGE}`);
    return 2;
  }
  if (options.help) {
    print(SHARE_USAGE);
    return 0;
  }
  const say = options.json ? (message) => console.error(message) : print;
  try {
    if (options.action === "list") {
      const { projectId, builds } = await listShares(options, { cwd, env, fetchFn });
      if (options.json) print(JSON.stringify({ ok: true, projectId, builds }, null, 2));
      else if (builds.length === 0) print("This project has no shared builds.");
      else for (const build of builds) print(`${build.buildId}  ${build.url}  ${build.fileCount} files, ${size(build.bytes)}, until ${day(build.expiresAt)}, by ${build.createdByName}`);
      return 0;
    }
    if (options.action === "delete") {
      await deleteShare(options, { env, fetchFn });
      if (options.json) print(JSON.stringify({ ok: true }, null, 2));
      else print("Stopped sharing it: the link no longer opens, and its files are being removed. Comments left on it stay in the project.");
      return 0;
    }
    const shared = await shareFolder(options, { cwd, env, fetchFn, log: say });
    if (options.json) print(JSON.stringify({ ok: true, ...shared }, null, 2));
    else {
      print(`\nReview link: ${shared.url}`);
      print(`Anyone the project's review access allows can open it until ${day(shared.expiresAt)}, with nothing to install.`);
      print(`Stop sharing it: npx critiqs share delete ${shared.buildId}`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    // Said to a person at a terminal: the sign-in command, not an agent's tool.
    if (error instanceof NotSignedInError) error.message = terminalSignIn(error.message);
    if (options.json) print(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else print(error.message);
    return 1;
  }
}
