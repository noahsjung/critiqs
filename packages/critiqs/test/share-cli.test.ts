import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_LIMITS as SERVER_LIMITS, BUILD_TYPES, buildPathProblem as serverPathProblem, checkBuildManifest } from "@critiqs/server/review-builds";
import { runCli } from "../bin/cli.mjs";
import { BUILD_EXTENSIONS, BUILD_LIMITS, buildPathProblem, day, looksLikeSpa, manifestProblem, parseShare, readBuild, shareTarget } from "../bin/share.mjs";

// `critiqs share`: the folder rules (AT-27, the command line's half; the
// backend's half is packages/backend/test/review-builds.test.ts), that they
// are the backend's own, and the upload against a stand-in backend: what is
// sent, where, and what is printed.

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const scratch = () => {
  const made = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "critiqs-share-"));
  folders.push(made);
  return made;
};

/** A folder holding `files` (path → text or size in bytes). */
function folderWith(files: Record<string, string | number>): string {
  const root = scratch();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof content === "number" ? Buffer.alloc(content, 97) : content);
  }
  return root;
}

const SITE = { "index.html": "<!doctype html><h1>Home</h1>", "assets/app.js": "console.log(1)", "assets/app.css": "h1{color:red}" };

test("the command line's folder rules are the backend's, path for path and limit for limit", () => {
  expect([...BUILD_EXTENSIONS].sort()).toEqual(Object.keys(BUILD_TYPES).sort());
  for (const key of ["files", "totalBytes", "fileBytes", "htmlBytes", "cssBytes", "pathLength", "minDays", "maxDays", "defaultDays"] as const) expect([key, BUILD_LIMITS[key]]).toEqual([key, SERVER_LIMITS[key]]);
  const paths = [
    "index.html", "assets/app.js", "a/b/c/d.woff2", "IMG.PNG", "café.svg", "café.svg", "../x.js", "a/../b.js", "./a.js", "/abs.js", "a//b.js", "a\\b.js", "a\u0000.js", "a\u007f.js",
    ".env", ".well-known/x.json", "a/.git/config.txt", "app.js.map", "app.map", "deploy.sh", "x.php", "server.pem", "key.key", "noext", "x.", ".htaccess", "a".repeat(510) + ".js", "a".repeat(600) + ".js", "",
  ];
  for (const path of paths) expect([path, buildPathProblem(path)]).toEqual([path, serverPathProblem(path)]);
  const manifests = [
    [{ path: "index.html", size: 1, sha256: "a".repeat(64) }],
    [{ path: "app.js", size: 1, sha256: "a".repeat(64) }],
    [{ path: "index.html", size: SERVER_LIMITS.htmlBytes + 1, sha256: "a".repeat(64) }],
    [{ path: "index.html", size: 1, sha256: "a".repeat(64) }, { path: "A.js", size: 1, sha256: "a".repeat(64) }, { path: "a.js", size: 1, sha256: "a".repeat(64) }],
    [{ path: "index.html", size: 1, sha256: "a".repeat(64) }, { path: "s.css", size: SERVER_LIMITS.cssBytes + 1, sha256: "a".repeat(64) }],
  ];
  for (const files of manifests) {
    let server: string | null = null;
    try {
      checkBuildManifest(files);
    } catch (error) {
      server = (error as Error).message;
    }
    expect(manifestProblem(files)).toBe(server);
  }
});

test("AT-27: a folder is read without following links, and any file the backend would refuse stops the share before anything is sent", () => {
  const good = folderWith({ ...SITE, ".DS_Store": "junk" });
  const build = readBuild(good);
  expect(build.files.map((file) => file.path)).toEqual(["assets/app.css", "assets/app.js", "index.html"]);
  expect(build.skipped).toEqual([".DS_Store"]);
  expect(build.files[2]!.sha256).toBe(new Bun.CryptoHasher("sha256").update(SITE["index.html"]).digest("hex"));

  const refusals: [string, () => string, RegExp][] = [
    ["a link that leaves the folder", () => {
      const root = folderWith(SITE);
      symlinkSync("/etc/hostname", join(root, "host.txt"));
      return root;
    }, /"host\.txt" is a symbolic link/],
    ["a link inside the folder", () => {
      const root = folderWith(SITE);
      symlinkSync(join(root, "index.html"), join(root, "copy.html"));
      return root;
    }, /"copy\.html" is a symbolic link/],
    ["a dotfile", () => folderWith({ ...SITE, ".env": "SECRET=1" }), /"\.env" is hidden/],
    ["a hidden folder", () => folderWith({ ...SITE, ".git/HEAD.txt": "ref" }), /is hidden/],
    ["a source map", () => folderWith({ ...SITE, "assets/app.js.map": "{}" }), /source map/],
    ["a shell script", () => folderWith({ ...SITE, "deploy.sh": "rm -rf /" }), /isn't a file type/],
    ["an env file", () => folderWith({ ...SITE, "prod.env": "X=1" }), /isn't a file type/],
    ["a backslash", () => folderWith({ ...SITE, "a\\b.js": "1" }), /backslash/],
    ["names differing in case", () => folderWith({ ...SITE, "assets/App.js": "2" }), /name the same file/],
    ["no index.html", () => folderWith({ "about.html": "<h1>About</h1>" }), /needs an index\.html/],
    ["a file over 16 MiB", () => folderWith({ ...SITE, "video.mp4": BUILD_LIMITS.fileBytes + 1 }), /larger than 16 MiB/],
    ["a page over 2 MiB", () => folderWith({ "index.html": BUILD_LIMITS.htmlBytes + 1 }), /larger than 2 MiB/],
    ["over 50 MiB in all", () => folderWith({ ...SITE, "a.mp4": 15 * 1024 * 1024, "b.mp4": 15 * 1024 * 1024, "c.mp4": 15 * 1024 * 1024, "d.mp4": 6 * 1024 * 1024 }), /at most 50 MiB/],
    ["over 1,000 files", () => folderWith({ ...SITE, ...Object.fromEntries(Array.from({ length: BUILD_LIMITS.files }, (_, n) => [`f/${n}.txt`, "x"])) }), /at most 1000 files/],
    ["not a folder", () => join(folderWith(SITE), "index.html"), /isn't a folder/],
    ["no such folder", () => join(scratch(), "dist"), /no folder/],
  ];
  for (const [name, make, reason] of refusals) {
    let message: string | null = null;
    try {
      readBuild(make());
    } catch (error) {
      message = (error as Error).message;
    }
    expect([name, message !== null && reason.test(message) ? "refused" : message]).toEqual([name, "refused"]);
  }
});

test("a build is a single-page app by default when index.html is its only page", () => {
  expect(looksLikeSpa([{ path: "index.html" }, { path: "404.html" }, { path: "a.js" }])).toBe(true);
  expect(looksLikeSpa([{ path: "index.html" }, { path: "about/index.html" }])).toBe(false);
});

test("share's options, and what delete accepts", () => {
  expect(parseShare(["dist", "--project", "p1", "--expires", "3", "--no-spa", "--json"])).toMatchObject({ action: "share", folder: "dist", project: "p1", expires: 3, spa: false, json: true });
  expect(parseShare(["list"])).toMatchObject({ action: "list" });
  expect(parseShare(["delete", "https://critiqs.app/r/abcdefghijklmnopqrstuvwxyz#/x"])).toMatchObject({ action: "delete", target: "https://critiqs.app/r/abcdefghijklmnopqrstuvwxyz#/x" });
  expect(parseShare(["dist", "--expires", "31"])).toEqual({ error: "--expires takes 1 to 30 days." });
  expect(parseShare([])).toEqual({ error: "Name the folder to share, such as dist/." });
  expect(parseShare(["dist", "extra"])).toEqual({ error: "Unexpected argument extra." });
  expect(shareTarget("https://critiqs.app/r/abcdefghijklmnopqrstuvwxyz")).toEqual({ key: "abcdefghijklmnopqrstuvwxyz" });
  expect(shareTarget("abcdefghijklmnopqrstuvwxyz")).toEqual({ key: "abcdefghijklmnopqrstuvwxyz" });
  expect(shareTarget("jd7abc123def456")).toEqual({ buildId: "jd7abc123def456" });
  expect(() => shareTarget("../etc")).toThrow("Give the shared build's ID");
});

// ---------------------------------------------------------------------------
// Against a stand-in backend at https://team.example

const BACKEND = "https://team.example";

/** This computer signed in to the stand-in backend. */
function signedIn(): Record<string, string> {
  const config = scratch();
  writeFileSync(
    join(config, "sign-in.v2.json"),
    JSON.stringify({ version: 2, services: { [BACKEND]: { origin: BACKEND, bindings: [{ backend: BACKEND, site: BACKEND }], refreshToken: "r1", accessToken: "token-1", accessExpiresAt: Date.now() + 3_600_000 } } }),
  );
  return { CRITIQS_CONFIG_DIR: config };
}

interface Stand {
  calls: { path: string; args: Record<string, unknown> }[];
  uploads: { url: string; bytes: number; auth: string | null }[];
  fetchFn: typeof fetch;
}

/** A backend that offers shared builds and asks for `wanted(sha256s)` of the files; the projects are `projects`. */
function standIn(options: { builds?: boolean; projects?: { _id: string; name: string }[]; wanted?: (shas: string[]) => string[]; uploadTo?: string; ready?: boolean } = {}): Stand {
  const calls: Stand["calls"] = [];
  const uploads: Stand["uploads"] = [];
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.pathname === "/critiqs/config") return Response.json({ protocol: 5, signInUrl: BACKEND, reviewLinks: { version: 1, live: true, builds: options.builds ?? true, allowCritiqs: false } });
    if (url.pathname === "/review-build/upload") {
      uploads.push({ url: input, bytes: (init.body as Uint8Array).byteLength, auth: new Headers(init.headers).get("authorization") });
      return new Response("Stored", { status: 201 });
    }
    const { path, args } = JSON.parse(String(init.body)) as { path: string; args: Record<string, unknown> };
    calls.push({ path, args });
    const value = (() => {
      switch (path) {
        case "projects:listMine":
          return { page: options.projects ?? [{ _id: "p1", name: "Pilot" }], isDone: true, continueCursor: "" };
        case "reviewBuilds:begin": {
          const shas = (args.files as { sha256: string }[]).map((file) => file.sha256);
          const wanted = options.wanted?.(shas) ?? [...new Set(shas)];
          if (options.ready === true) return { buildId: "b1", ready: true, fileCount: shas.length, bytes: 1, uploads: [] };
          return { buildId: "b1", ready: false, fileCount: shas.length, bytes: 1, uploads: wanted.map((sha256) => ({ sha256, size: 1, url: `${options.uploadTo ?? BACKEND}/review-build/upload?buildId=b1&sha256=${sha256}&grant=g` })) };
        }
        case "reviewBuilds:publish":
          return { buildId: "b1", linkId: "l1", url: "https://critiqs.example/r/abcdefghijklmnopqrstuvwxyz", expiresAt: Date.UTC(2026, 11, 2) };
        case "reviewBuilds:list":
          return [{ buildId: "b1", url: "https://critiqs.example/r/abcdefghijklmnopqrstuvwxyz", createdAt: 1, expiresAt: Date.UTC(2026, 11, 2), fileCount: 3, bytes: 2048, createdByName: "Dana" }];
        case "reviewBuilds:remove":
          return null;
        default:
          throw new Error(`Unexpected call ${path}`);
      }
    })();
    return Response.json({ status: "success", value });
  }) as unknown as typeof fetch;
  return { calls, uploads, fetchFn };
}

async function cli(argv: string[], stand: Stand, env = signedIn(), cwd = scratch()) {
  const printed: string[] = [];
  const code = await runCli(argv, { cwd, env, fetchFn: stand.fetchFn, print: (message: string) => printed.push(message) });
  return { code, out: printed.join("\n") };
}

test("critiqs share uploads each file the backend asks for once, to its upload route only, and prints the link", async () => {
  const dist = folderWith(SITE);
  const stand = standIn();
  const { code, out } = await cli(["share", dist, "--backend", BACKEND], stand);
  expect(code).toBe(0);
  expect(out).toContain("Review link: https://critiqs.example/r/abcdefghijklmnopqrstuvwxyz");
  expect(out).toContain(`until ${day(Date.UTC(2026, 11, 2))}`);
  expect(out).toContain("npx critiqs share delete b1");
  const begin = stand.calls.find((call) => call.path === "reviewBuilds:begin")!;
  expect(begin.args).toMatchObject({ projectId: "p1", spa: true, expiresInDays: 7 });
  expect((begin.args.files as { path: string }[]).map((file) => file.path)).toEqual(["assets/app.css", "assets/app.js", "index.html"]);
  expect(stand.uploads).toHaveLength(3);
  // The grant is the upload's only credential: the computer's sign-in never goes with a file.
  expect(stand.uploads.every((upload) => upload.auth === null)).toBe(true);
  expect(stand.calls.map((call) => call.path)).toEqual(["projects:listMine", "reviewBuilds:begin", "reviewBuilds:publish"]);
});

test("an interrupted share run again sends only what the backend still needs", async () => {
  const dist = folderWith(SITE);
  const stand = standIn({ wanted: (shas) => shas.slice(0, 1) });
  expect((await cli(["share", dist, "--backend", BACKEND, "--project", "p9", "--expires", "2", "--json"], stand)).code).toBe(0);
  expect(stand.uploads).toHaveLength(1);
  expect(stand.calls.find((call) => call.path === "reviewBuilds:begin")!.args).toMatchObject({ projectId: "p9", expiresInDays: 2 });
});

test("an upload address anywhere but the backend's own route gets nothing", async () => {
  const dist = folderWith(SITE);
  const stand = standIn({ uploadTo: "https://evil.example" });
  const { code, out } = await cli(["share", dist, "--backend", BACKEND], stand);
  expect(code).toBe(1);
  expect(out).toEndWith("The backend asked for an upload this build doesn't have.");
  expect(stand.uploads).toEqual([]);
  expect(stand.calls.map((call) => call.path)).not.toContain("reviewBuilds:publish");
});

test("share says what to do when it can't: no builds on the backend, several projects, not signed in, a refused file", async () => {
  const dist = folderWith(SITE);
  expect((await cli(["share", dist, "--backend", BACKEND], standIn({ builds: false }))).out).toEndWith("The Critiqs backend at https://team.example doesn't offer shared builds. Its operator needs to set up review links.");
  const several = await cli(["share", dist, "--backend", BACKEND], standIn({ projects: [{ _id: "p1", name: "One" }, { _id: "p2", name: "Two" }] }));
  expect(several.out).toEndWith("Choose the project to share into with --project <id>:\n  p1  One\n  p2  Two");
  const none = await cli(["share", dist, "--backend", BACKEND], standIn({ projects: [] }));
  expect(none.code).toBe(1);
  const signedOut = await cli(["share", dist, "--backend", BACKEND, "--project", "p1"], standIn(), { CRITIQS_CONFIG_DIR: scratch() });
  expect(signedOut.out).toContain("npx critiqs sign-in --backend 'https://team.example'");
  // A person at a terminal is told the command, not an agent's tool.
  expect(signedOut.out).not.toContain("critiqs_sign_in");
  const leaky = folderWith({ ...SITE, "assets/app.js.map": "{}" });
  const stand = standIn();
  const refused = await cli(["share", leaky, "--backend", BACKEND, "--project", "p1"], stand);
  expect([refused.code, refused.out]).toEqual([1, '"assets/app.js.map" is a source map, which would publish the app\'s source. Remove it from the folder, or share only the build\'s output.']);
  expect([stand.calls, stand.uploads]).toEqual([[], []]);
});

test("share list and share delete", async () => {
  const stand = standIn();
  const listed = await cli(["share", "list", "--backend", BACKEND, "--project", "p1"], stand);
  expect(listed.out).toBe(`b1  https://critiqs.example/r/abcdefghijklmnopqrstuvwxyz  3 files, 2.0 KB, until ${day(Date.UTC(2026, 11, 2))}, by Dana`);
  const removed = await cli(["share", "delete", "https://critiqs.example/r/abcdefghijklmnopqrstuvwxyz", "--backend", BACKEND], stand);
  expect(removed.code).toBe(0);
  expect(stand.calls.at(-1)).toEqual({ path: "reviewBuilds:remove", args: { key: "abcdefghijklmnopqrstuvwxyz" } });
  expect((await cli(["share", "--help"], stand)).out).toContain("critiqs share <folder>");
});

test("a folder that is the app's source, not its build, is named as such before any of its files", async () => {
  for (const mark of ["package.json", "bun.lock", "node_modules"]) {
    const app = folderWith({ ...SITE, [mark === "node_modules" ? "node_modules/x/index.js" : mark]: "{}" });
    const stand = standIn();
    const { code, out } = await cli(["share", app, "--backend", BACKEND, "--project", "p1"], stand);
    expect([mark, code, out]).toEqual([mark, 1, `${app} looks like the app's source (it has ${mark}), not its build output. Build the prototype first, then share the folder the build writes, such as dist/.`]);
    expect(stand.calls).toEqual([]);
  }
});

test("sharing the same files again says it is the same link, and that --expires didn't change its end date", async () => {
  const dist = folderWith(SITE);
  const again = await cli(["share", dist, "--backend", BACKEND, "--project", "p1", "--expires", "3"], standIn({ ready: true }));
  expect(again.code).toBe(0);
  expect(again.out).toContain(`These files are already shared, so this is the same link, still until ${day(Date.UTC(2026, 11, 2))}: --expires applies only to a new share.`);
  const plain = await cli(["share", dist, "--backend", BACKEND, "--project", "p1"], standIn({ ready: true }));
  expect(plain.out).toContain("These files are already shared, so this is the same link.");
  expect(plain.out).not.toContain("--expires");
});

test("a file in __critiqs/, the folder review links keep for themselves, is refused before anything is sent", async () => {
  const stand = standIn();
  const { code, out } = await cli(["share", folderWith({ ...SITE, "__critiqs/app.js": "x" }), "--backend", BACKEND, "--project", "p1"], stand);
  expect([code, out]).toEqual([1, '"__critiqs/app.js" is in __critiqs/, a folder review links keep for themselves, so it could never be served. Remove it from the folder, or share only the build\'s output.']);
  expect(stand.calls).toEqual([]);
});
