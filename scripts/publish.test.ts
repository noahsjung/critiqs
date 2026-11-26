// Runs the publish checks against scratch workspaces shaped like this one,
// with two npm packages, a gem, and a PyPI project. Builds and `npm pack` run
// for real; registries are stand-ins, and nothing is uploaded. Then the
// Publish workflow's own guard steps run against scratch Git repositories,
// packed files, and stand-ins for gh, npm, curl, and gem.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageTarball, packedFile } from "./package-tarball.ts";
import { artifactProblems, checksums, main, packageProblems, parseArtifact, type Effects } from "./publish.ts";
import { releasePackages, workingTree, type Registry, type ReleasePackage } from "./release.ts";

setDefaultTimeout(60_000);
const root = new URL("../", import.meta.url).pathname;
const scratch = await mkdtemp(join(tmpdir(), "critiqs-publish-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const npmManifest = (name: string, version: string, extra: object = {}) =>
  ({ name, version, license: "MIT", files: ["index.js", "LICENSE"], publishConfig: { access: "public" }, ...extra });
// Stand-in release:build scripts that write what `gem build` and
// `python -m build` name their files, versioned from package.json.
const gemBuild = `const { version } = await Bun.file("package.json").json();\nawait Bun.write(\`release/critiqs-rails-\${version}.gem\`, "gem");\n`;
const pythonBuild = `const { version } = await Bun.file("package.json").json();\nawait Bun.write(\`release/django_critiqs-\${version}-py3-none-any.whl\`, "wheel");\nawait Bun.write(\`release/django_critiqs-\${version}.tar.gz\`, "sdist");\n`;

let fixtures = 0;
/** A workspace at `version`; `files` adds or replaces files (null removes one). */
async function workspace(version = "0.4.0", files: Record<string, string | null> = {}) {
  const dir = join(scratch, `workspace-${fixtures++}`);
  const all: Record<string, string | null> = {
    "package.json": json({ name: "fixture", private: true, workspaces: ["packages/*"] }),
    ".changeset/config.json": await Bun.file(join(root, ".changeset/config.json")).text(),
    ".changeset/README.md": "# Release notes\n",
    "packages/critiqs/package.json": json(npmManifest("critiqs", version, { devDependencies: { "@critiqs/core": "workspace:*" } })),
    "packages/react/package.json": json(npmManifest("critiqs-react", version, { dependencies: { critiqs: version } })),
    "packages/rails/package.json": json({ name: "critiqs-rails", version, private: true, critiqsRelease: { registry: "rubygems" }, scripts: { "release:build": "bun build.ts" } }),
    "packages/rails/build.ts": gemBuild,
    "packages/django/package.json": json({ name: "critiqs-django", version, private: true, critiqsRelease: { registry: "pypi" }, scripts: { "release:build": "bun build.ts" } }),
    "packages/django/build.ts": pythonBuild,
    "packages/core/package.json": json({ name: "@critiqs/core", version: "0.0.0", private: true }),
    ...Object.fromEntries(["critiqs", "react"].flatMap((pkg) => [[`packages/${pkg}/index.js`, "export {};\n"], [`packages/${pkg}/LICENSE`, "MIT\n"]])),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) if (text !== null) await Bun.write(join(dir, path), text);
  return dir;
}

/** Stand-in registries holding `existing` ("registry name@version"), and a runner that records every command and refuses a publish. */
function effects(existing: string[] = []) {
  const commands: string[] = [];
  const asked: string[] = [];
  const value: Effects = {
    async published(registry: Registry, name: string, version: string) {
      asked.push(`${registry} ${name}@${version}`);
      return existing.includes(`${registry} ${name}@${version}`);
    },
    async exec(command: string[], cwd: string) {
      commands.push(`${cwd.slice(cwd.indexOf("/packages/") + 1)}: ${command.slice(0, 3).join(" ")}`);
      if (command.includes("publish")) throw new Error("tests never publish");
      const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
    },
  };
  return { effects: value, commands, asked };
}

async function run(dir: string, args: string[], existing: string[] = []) {
  const stub = effects(existing);
  const out: string[] = [];
  const err: string[] = [];
  const status = await main(args, dir, stub.effects, (line) => out.push(line), (line) => err.push(line));
  return { status, out: out.join("\n"), err: err.join("\n"), commands: stub.commands, asked: stub.asked };
}

/** Runs a command, returning its exit status and output. */
async function sh(cwd: string, ...command: string[]) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { status, output: stdout + stderr };
}

describe("verify", () => {
  test("checks every package of every registry, building the gem and the PyPI project", async () => {
    const dir = await workspace();
    const result = await run(dir, ["verify", "--version", "0.4.0"]);
    expect(result).toMatchObject({ status: 0, err: "" });
    expect(result.out).toBe([
      "critiqs@0.4.0 (npm): to publish",
      "django-critiqs@0.4.0 (PyPI): to publish",
      "critiqs-rails@0.4.0 (RubyGems): to publish",
      "critiqs-react@0.4.0 (npm): to publish",
      "Critiqs 0.4.0 can be published from this checkout.",
    ].join("\n"));
    expect(result.commands).toEqual(["packages/django: bun run release:build", "packages/rails: bun run release:build"]);
    expect(result.asked).toEqual(["npm critiqs@0.4.0", "pypi django-critiqs@0.4.0", "rubygems critiqs-rails@0.4.0", "npm critiqs-react@0.4.0"]);
  });

  test("reports what a registry already has as skipped, and succeeds when everything is published", async () => {
    const dir = await workspace();
    const some = await run(dir, ["verify", "--version", "0.4.0"], ["npm critiqs@0.4.0", "rubygems critiqs-rails@0.4.0"]);
    expect(some.status).toBe(0);
    expect(some.out).toContain("critiqs@0.4.0 (npm): already published, skipped");
    expect(some.out).toContain("critiqs-rails@0.4.0 (RubyGems): already published, skipped");
    expect(some.out).toContain("critiqs-react@0.4.0 (npm): to publish");
    const all = await run(dir, ["verify", "--version", "0.4.0"], ["npm critiqs@0.4.0", "npm critiqs-react@0.4.0", "rubygems critiqs-rails@0.4.0", "pypi django-critiqs@0.4.0"]);
    expect(all).toMatchObject({ status: 0 });
    expect(all.out).toEndWith("Every package is already published at 0.4.0; nothing to do.");
  });

  test("checks one registry without building the others", async () => {
    const dir = await workspace();
    const result = await run(dir, ["verify", "--version", "0.4.0", "--registry", "npm"]);
    expect(result.status).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.asked).toEqual(["npm critiqs@0.4.0", "npm critiqs-react@0.4.0"]);
  });

  test("refuses another version, unversioned release notes, and a misconfigured package", async () => {
    const dir = await workspace("0.4.0", {
      ".changeset/waiting.md": '---\n"critiqs": patch\n---\n\nFix.\n',
      "packages/flask/package.json": json({ name: "critiqs-flask", version: "0.4.0", private: true }),
    });
    const result = await run(dir, ["verify", "--version", "0.5.0"]);
    expect(result.status).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("1 release note(s) wait to be versioned");
    expect(result.err).toContain("packages/critiqs/package.json is version 0.4.0, not 0.5.0.");
    expect(result.err).toContain("packages/rails/package.json is version 0.4.0, not 0.5.0.");
    expect(result.err).toContain("critiqs-flask is in the release group but names no registry");
    expect(result.asked).toEqual([]);
  });

  test("refuses a gem built with a version of its own", async () => {
    const dir = await workspace("0.4.0", { "packages/rails/build.ts": 'await Bun.write("release/critiqs-rails-0.3.0.gem", "gem");\n' });
    const result = await run(dir, ["verify", "--version", "0.4.0"]);
    expect(result.status).toBe(1);
    expect(result.err).toContain("critiqs-rails: packages/rails/release/critiqs-rails-0.3.0.gem is version 0.3.0, not 0.4.0; release:build must take the version from package.json.");
  });

  test("builds from an empty release folder, so stale files never ship", async () => {
    const dir = await workspace("0.4.0", { "packages/rails/release/critiqs-rails-0.3.0.gem": "old" });
    expect((await run(dir, ["verify", "--version", "0.4.0"])).status).toBe(0);
    expect(await readdir(join(dir, "packages/rails/release"))).toEqual(["critiqs-rails-0.4.0.gem"]);
  });

  test("rejects bad arguments", async () => {
    const dir = await workspace();
    for (const args of [
      ["verify"],
      ["verify", "--version", "0.4.0", "--registry", "maven"],
      ["pack", "--version", "0.4.0"],
      ["pack", "--registry", "npm", "--version", "0.4.0", "--out", "x"],
      ["publish", "--registry", "npm", "--version", "0.4.0"],
      ["stage", "--registry", "pypi", "--version", "0.4.0", "--out", "x"],
      ["ship", "--version", "0.4.0"],
    ]) {
      expect((await run(dir, args)).status).toBe(2);
    }
  });
});

describe("pack", () => {
  const packed = ["SHA256SUMS", "npm/critiqs-0.4.0.tgz", "npm/critiqs-react-0.4.0.tgz", "npm/order", "pypi/django_critiqs-0.4.0-py3-none-any.whl", "pypi/django_critiqs-0.4.0.tar.gz", "rubygems/critiqs-rails-0.4.0.gem"];

  test("packs every package once into one folder, npm in dependency order, with every file's sha256", async () => {
    const dir = await workspace();
    await Bun.write(join(dir, "out/npm/leftover-0.3.0.tgz"), "old");
    const result = await run(dir, ["pack", "--version", "0.4.0", "--out", "out"]);
    expect(result).toMatchObject({ status: 0, err: "" });
    // The gem and PyPI files are built (and checked) first, then the npm packages packed in order.
    expect(result.commands).toEqual([
      "packages/django: bun run release:build",
      "packages/rails: bun run release:build",
      "packages/critiqs: npm pack --pack-destination",
      "packages/react: npm pack --pack-destination",
    ]);
    const out = join(dir, "out");
    expect((await readdir(out, { recursive: true })).filter((path) => path.includes(".") || path.endsWith("order") || path === "SHA256SUMS").sort()).toEqual(packed);
    expect(await Bun.file(join(out, "npm/order")).text()).toBe("critiqs-0.4.0.tgz\ncritiqs-react-0.4.0.tgz\n");
    const sums = await Bun.file(join(out, "SHA256SUMS")).text();
    expect(sums.split("\n").filter(Boolean).map((line) => line.slice(66))).toEqual(packed.filter((path) => path !== "SHA256SUMS"));
    expect(await sh(out, "sha256sum", "--check", "--strict", "SHA256SUMS")).toMatchObject({ status: 0 });
    // The packed tarball is the package npm would publish.
    const manifest = await sh(out, "tar", "-xzOf", "npm/critiqs-react-0.4.0.tgz", "package/package.json");
    expect(JSON.parse(manifest.output)).toMatchObject({ name: "critiqs-react", version: "0.4.0", dependencies: { critiqs: "0.4.0" } });
    expect(result.out).toEndWith("Packed 4 packages into out, with SHA256SUMS.");
  });

  test("packs what a registry already has too, since the other packages are checked against it", async () => {
    const dir = await workspace();
    const result = await run(dir, ["pack", "--version", "0.4.0", "--out", "out"], ["npm critiqs@0.4.0", "rubygems critiqs-rails@0.4.0"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("critiqs@0.4.0 (npm): already published, skipped");
    expect(await Bun.file(join(dir, "out/npm/order")).text()).toBe("critiqs-0.4.0.tgz\ncritiqs-react-0.4.0.tgz\n");
    expect(await Bun.file(join(dir, "out/rubygems/critiqs-rails-0.4.0.gem")).exists()).toBe(true);
  });

  test("refuses a dependency npm would publish unresolved, or one off the shared version, packing nothing", async () => {
    const dir = await workspace("0.4.0", { "packages/react/package.json": json(npmManifest("critiqs-react", "0.4.0", { dependencies: { critiqs: "workspace:*" } })) });
    const result = await run(dir, ["pack", "--version", "0.4.0", "--out", "out"]);
    expect(result.status).toBe(1);
    expect(result.err).toContain('critiqs-react: dependencies.critiqs is "workspace:*", which npm would publish as written.');
    expect(result.commands.filter((command) => command.includes("npm"))).toEqual([]);
    expect(await Bun.file(join(dir, "out/SHA256SUMS")).exists()).toBe(false);
  });

  test("checksums lists every file under a folder as sha256sum reads it", async () => {
    const dir = join(scratch, "sums");
    await Bun.write(join(dir, "b/one.txt"), "one\n");
    await Bun.write(join(dir, "a.txt"), "a\n");
    const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(await checksums(dir)).toBe(`${sha("a\n")}  a.txt\n${sha("one\n")}  b/one.txt\n`);
  });
});

const pkg = (registry: ReleasePackage["registry"], manifest: object = {}): ReleasePackage =>
  ({ name: "critiqs-x", dir: "packages/x", version: "0.4.0", registry, manifest: { name: "critiqs-x", version: "0.4.0", ...manifest } });

describe("manifest and file rules", () => {
  test("npm packages need a public, MIT-licensed manifest that ships its license", () => {
    expect(packageProblems(pkg("npm", npmManifest("critiqs-x", "0.4.0")), "0.4.0", [])).toEqual([]);
    expect(packageProblems(pkg("npm", { files: ["dist"] }), "0.4.0", [])).toEqual([
      "critiqs-x must name its MIT license.",
      'critiqs-x: publishConfig.access must be "public".',
      "critiqs-x: files must include LICENSE.",
    ]);
    expect(packageProblems(pkg("npm", npmManifest("critiqs-x", "0.4.0", { dependencies: { critiqs: "^0.4.0" } })), "0.4.0", ["critiqs"]))
      .toEqual(['critiqs-x: dependencies.critiqs is "^0.4.0", not the shared version 0.4.0.']);
  });

  test("RubyGems and PyPI packages are checked by their built files, not npm's manifest rules", () => {
    expect(packageProblems(pkg("rubygems", { private: true }), "0.4.0", [])).toEqual([]);
    expect(packageProblems(pkg(null, { private: true }), "0.4.0", [])[0]).toContain("names no registry");
  });

  test("file names give the registry name and version", () => {
    expect(parseArtifact("rubygems", "critiqs-rails-0.4.0.gem")).toEqual({ name: "critiqs-rails", version: "0.4.0" });
    expect(parseArtifact("pypi", "django_critiqs-0.4.0-py3-none-any.whl")).toEqual({ name: "django-critiqs", version: "0.4.0" });
    expect(parseArtifact("pypi", "flask_critiqs-0.4.0-1-py3-none-any.whl")).toEqual({ name: "flask-critiqs", version: "0.4.0" });
    expect(parseArtifact("pypi", "Flask.Critiqs-0.4.0.tar.gz")).toEqual({ name: "flask-critiqs", version: "0.4.0" });
    expect(parseArtifact("rubygems", "notes.txt")).toBeNull();
    expect(parseArtifact("pypi", "critiqs-rails-0.4.0.gem")).toBeNull();
  });

  test("a build must write one project's files at the shared version", () => {
    const gem = pkg("rubygems");
    expect(artifactProblems(gem, [], "0.4.0")).toEqual(["critiqs-x: release:build wrote nothing to packages/x/release/."]);
    expect(artifactProblems(gem, ["critiqs-x-0.4.0.gem", "critiqs-x-0.3.0.gem"], "0.4.0")).toEqual([
      "critiqs-x: packages/x/release/critiqs-x-0.3.0.gem is version 0.3.0, not 0.4.0; release:build must take the version from package.json.",
      "critiqs-x: release:build must write exactly one gem to packages/x/release/, not 2 files.",
    ]);
    expect(artifactProblems(pkg("pypi"), ["a-0.4.0.tar.gz", "b-0.4.0.tar.gz", "README"], "0.4.0")).toEqual([
      "critiqs-x: packages/x/release/README is not a wheel (.whl) or source distribution (.tar.gz).",
      "critiqs-x: packages/x/release/ holds more than one PyPI project (a, b).",
    ]);
  });
});

describe("package checks' packed files", () => {
  const refuse = async (): Promise<string> => { throw new Error("packed instead of using CRITIQS_PACKED"); };

  test("with CRITIQS_PACKED, the checks use the packed files, unchanged, and never pack their own", async () => {
    const dir = await mkdtemp(join(scratch, "packed-"));
    const files = ["npm/critiqs-0.4.0.tgz", "npm/critiqs-react-0.4.0.tgz", "rubygems/critiqs-rails-0.4.0.gem", "pypi/django_critiqs-0.4.0-py3-none-any.whl", "pypi/django_critiqs-0.4.0.tar.gz"];
    for (const file of files) await Bun.write(join(dir, file), "packed once\n");
    const env = { CRITIQS_PACKED: dir };
    expect(packedFile("npm", "critiqs-react", "0.4.0", env)).toBe(join(dir, "npm/critiqs-react-0.4.0.tgz"));
    expect(packedFile("rubygems", "critiqs-rails", "0.4.0", env)).toBe(join(dir, "rubygems/critiqs-rails-0.4.0.gem"));
    expect(packedFile("pypi", "django-critiqs", "0.4.0", env)).toBe(join(dir, "pypi/django_critiqs-0.4.0-py3-none-any.whl"));
    // A missing file fails the check instead of quietly building another.
    expect(() => packedFile("npm", "critiqs-react", "0.5.0", env)).toThrow("holds no single npm file for critiqs-react 0.5.0");
    expect(() => packedFile("pypi", "flask-critiqs", "0.4.0", env)).toThrow("holds no single pypi file");
    expect(() => packedFile("npm", "critiqs", "0.4.0", { CRITIQS_PACKED: join(dir, "missing") })).toThrow("holds no single npm file");
    expect(packedFile("npm", "critiqs", "0.4.0", {})).toBeNull();
    expect(packedFile("npm", "critiqs", "0.4.0", { CRITIQS_PACKED: "" })).toBeNull();

    const version = (await Bun.file(join(root, "packages/react/package.json")).json()).version;
    await Bun.write(join(dir, `npm/critiqs-react-${version}.tgz`), "packed once\n");
    expect(await packageTarball("packages/react", scratch, refuse, env)).toBe(join(dir, `npm/critiqs-react-${version}.tgz`));
  });

  test("without CRITIQS_PACKED, packs the package into scratch", async () => {
    const calls: [string[], string][] = [];
    const run = async (command: string[], cwd: string) => {
      calls.push([command, cwd]);
      return JSON.stringify([{ filename: "critiqs-react-0.3.0.tgz" }]);
    };
    expect(await packageTarball("packages/react", scratch, run, {})).toBe(join(scratch, "critiqs-react-0.3.0.tgz"));
    expect(calls).toEqual([[["npm", "pack", "--json", "--pack-destination", scratch], join(root, "packages/react")]]);
  });
});

// The Publish workflow's own steps.
const workflow = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/publish.yml")).text()) as any;
const { build } = workflow.jobs;
const PUBLISHERS = ["npm", "rubygems", "pypi"] as const;
const named = (job: any, name: string) => job.steps.find((step: any) => step.name === name);
const step = (job: any, name: string) => named(job, name).run as string;
const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed (${status}):\n${stderr}`);
  return stdout.trim();
}

/** A clone of a repository whose main records Critiqs `version`, as the build job checks it out. */
async function checkout(version = "0.4.0") {
  const dir = await mkdtemp(join(scratch, "repo-"));
  const origin = join(dir, "origin");
  for (const pkg of ["critiqs", "react"]) await Bun.write(join(origin, `packages/${pkg}/package.json`), JSON.stringify({ name: pkg === "critiqs" ? "critiqs" : "critiqs-react", version }));
  await git(origin, "init", "-q", "-b", "main");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-qm", "Release");
  const work = join(dir, "work");
  await git(dir, "clone", "-q", origin, work);
  return { dir, origin, work, sha: await git(work, "rev-parse", "HEAD") };
}

/** A directory holding an executable stand-in for `command`. */
async function standIn(command: string, script: string) {
  const bin = await mkdtemp(join(scratch, "bin-"));
  await Bun.write(join(bin, command), `#!/usr/bin/env bash\n${script}`);
  await chmod(join(bin, command), 0o755);
  return bin;
}

/** Runs a workflow step's script as Actions does, with the runner's files under `<cwd>/../runner`. */
async function runStep(job: any, name: string, cwd: string, env: Record<string, string>, { bin }: { bin?: string } = {}) {
  const runner = join(cwd, "..", "runner");
  await mkdir(runner, { recursive: true });
  const files = { GITHUB_STEP_SUMMARY: join(runner, "summary.md"), GITHUB_ENV: join(runner, "env"), GITHUB_OUTPUT: join(runner, "output") };
  for (const file of Object.values(files)) await Bun.write(file, "");
  const child = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step(job, name)], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...files, RUNNER_TEMP: runner, GITHUB_REPOSITORY: "noahsjung/critiqs", ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}), ...env },
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const read = (file: string) => Bun.file(file).text();
  return { status, output: stdout + stderr, env: await read(files.GITHUB_ENV), outputs: await read(files.GITHUB_OUTPUT), summary: await read(files.GITHUB_STEP_SUMMARY) };
}

/** A gzipped npm tarball at `path` whose package.json is `manifest`. */
async function tarball(path: string, manifest: object) {
  const work = await mkdtemp(join(scratch, "tarball-"));
  await Bun.write(join(work, "package/package.json"), JSON.stringify(manifest));
  await mkdir(join(path, ".."), { recursive: true });
  expect((await sh(work, "tar", "-czf", path, "package")).status).toBe(0);
}

/**
 * A release folder at `<dir>/<folder>` as `publish.ts pack` writes it, with
 * SHA256SUMS; returns the folder and the sha256 of SHA256SUMS.
 */
async function release(dir: string, folder: string, { version = "0.4.0", manifests = {} as Record<string, object> } = {}) {
  const out = join(dir, folder);
  for (const name of ["critiqs", "critiqs-react"]) await tarball(join(out, `npm/${name}-${version}.tgz`), manifests[name] ?? { name, version });
  await Bun.write(join(out, "npm/order"), `critiqs-${version}.tgz\ncritiqs-react-${version}.tgz\n`);
  await Bun.write(join(out, `rubygems/critiqs-rails-${version}.gem`), "gem");
  await Bun.write(join(out, `pypi/django_critiqs-${version}-py3-none-any.whl`), "wheel");
  await Bun.write(join(out, `pypi/django_critiqs-${version}.tar.gz`), "sdist");
  await Bun.write(join(out, "SHA256SUMS"), await checksums(out));
  return { out, sha: sha256(join(out, "SHA256SUMS")) };
}

/** A publishing job's workspace with the downloaded artifact in `release/`. */
async function downloaded(options?: Parameters<typeof release>[2]) {
  const dir = await mkdtemp(join(scratch, "download-"));
  const work = join(dir, "work");
  return { work, ...(await release(work, "release", options)) };
}

describe("Publish workflow", () => {
  test("checks with read-only access, and publishes the checked files, from the dispatch commit only", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(["build", ...PUBLISHERS]);
    expect(build.if).toBe("github.ref == 'refs/heads/main'");
    expect(build.permissions).toEqual({ contents: "read" });
    expect(build.environment).toBeUndefined();
    expect(build.env.DISPATCH_SHA).toBe("${{ github.sha }}");
    const checkoutStep = build.steps.find((step: any) => String(step.uses).startsWith("actions/checkout@"));
    expect(checkoutStep.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(workflow.on.workflow_dispatch.inputs.commit.required).toBe(true);
    // Actions prints a step's env block before its script runs, so raw inputs
    // appear in no expression: the first step reads them from the event file.
    expect(JSON.stringify(workflow.jobs)).not.toMatch(/\$\{\{[^}]*((?<![\w.])inputs\.|github\.event\b)/);
    expect("${{ inputs.version }} ${{ github.event.inputs.commit }}".match(/\$\{\{[^}]*((?<![\w.])inputs\.|github\.event\b)/g)).toHaveLength(2);
    expect(build.steps[0].env).toBeUndefined();
    expect(build.steps[0].run).toContain('"$GITHUB_EVENT_PATH"');

    const buildSteps = build.steps.map((step: any) => step.name ?? step.uses ?? step.run);
    expect(buildSteps[0]).toBe("Check the requested version and commit");
    // Gem and Python builds vendor the shared bundle, so it is built before verify runs them.
    expect(buildSteps.indexOf("bun run build")).toBeLessThan(buildSteps.indexOf("Check this version may be published"));
    expect(step(build, "Check this version may be published")).toBe('bun scripts/publish.ts verify --version "$VERSION"');
    expect(buildSteps).toEqual(expect.arrayContaining(["bun run typecheck", "bun run test:unit"]));
    // Packed once; every package and consumer check installs those files, and those files are uploaded.
    const buildScripts = build.steps.map((step: any) => step.run ?? "").join("\n");
    expect(buildScripts).not.toMatch(/\bnpm pack\b|\bgem build\b|release:build/);
    expect(buildScripts.match(/\bscripts\/publish\.ts pack\b/g)).toHaveLength(1);
    expect(buildScripts).not.toMatch(/bun run (test|check:package|check:consumers)\b(?!:)/);
    expect(buildSteps.slice(buildSteps.indexOf("Pack every package"))).toEqual([
      "Pack every package",
      "Check the packed npm packages",
      "Check apps built with the packed packages",
      "Check each framework's app built with the packed packages",
      "Check nothing moved before uploading",
      build.steps.at(-1).uses,
    ]);
    expect(step(build, "Pack every package")).toContain('echo "CRITIQS_PACKED=$release" >> "$GITHUB_ENV"');
    expect(step(build, "Check the packed npm packages")).toBe("bun scripts/check-package.ts");
    expect(step(build, "Check apps built with the packed packages")).toBe("bun scripts/check-consumers.ts");
    expect(step(build, "Check each framework's app built with the packed packages")).toBe("bun run --filter './packages/*' check:consumer");
    expect(String(build.steps.at(-1).uses)).toStartWith("actions/upload-artifact@");
    expect(build.steps.at(-1).with).toMatchObject({ name: "critiqs-release", path: "${{ steps.pack.outputs.release }}" });
    expect(build.outputs).toEqual({ version: "${{ steps.inputs.outputs.version }}", sha256: "${{ steps.pack.outputs.sha256 }}" });
    expect(named(build, "Check nothing moved before uploading").env).toEqual({ SHA256: "${{ steps.pack.outputs.sha256 }}" });

    const verifyFiles = step(workflow.jobs.npm, "Check the files are the ones that were built and checked");
    for (const name of PUBLISHERS) {
      const job = workflow.jobs[name];
      expect(job).toMatchObject({ if: "github.ref == 'refs/heads/main'", environment: name, permissions: { contents: "read", "id-token": "write" } });
      expect(job.needs).toEqual(name === "npm" ? "build" : ["build", "npm"]);
      expect(job.env).toEqual({ VERSION: "${{ needs.build.outputs.version }}", SHA256: "${{ needs.build.outputs.sha256 }}", DISPATCH_SHA: "${{ github.sha }}" });
      const names = job.steps.map((step: any) => step.name ?? step.uses);
      expect(names.slice(0, 3)).toEqual(["Check the commit is still on main", expect.stringMatching(/^actions\/download-artifact@/), "Check the files are the ones that were built and checked"]);
      expect(job.steps[1].with).toEqual({ name: "critiqs-release", path: "release" });
      // Every publishing job runs the same guards.
      expect(step(job, "Check the commit is still on main")).toBe(step(workflow.jobs.npm, "Check the commit is still on main"));
      expect(step(job, "Check the files are the ones that were built and checked")).toBe(verifyFiles);
      // A job holding a publishing identity checks out and installs nothing, and uses no stored secret.
      const scripts = job.steps.map((step: any) => step.run ?? "").join("\n");
      expect(scripts).not.toMatch(/\bbun\b|npm (install|ci|run|exec)\b|\bnpx\b|\bpip\b|\bbundle\b|gem install/);
      expect(JSON.stringify(job)).not.toMatch(/secrets\./);
      const uses = job.steps.map((step: any) => String(step.uses ?? "").split("@")[0]).filter(Boolean);
      expect(uses).toEqual({
        npm: ["actions/download-artifact", "actions/setup-node"],
        rubygems: ["actions/download-artifact", "rubygems/configure-rubygems-credentials"],
        pypi: ["actions/download-artifact", "pypa/gh-action-pypi-publish"],
      }[name]);
    }
    expect(named(workflow.jobs.npm, "Publish to npm").run).toContain('npm publish "./$tarball" --access public --ignore-scripts');
    const credentials = workflow.jobs.rubygems.steps.find((step: any) => String(step.uses).startsWith("rubygems/configure-rubygems-credentials@"));
    expect(credentials.if).toBe("steps.gems.outputs.push == 'true'");
    expect(named(workflow.jobs.rubygems, "Push to RubyGems").if).toBe("steps.gems.outputs.push == 'true'");
    const upload = workflow.jobs.pypi.steps.at(-1);
    expect(String(upload.uses)).toStartWith("pypa/gh-action-pypi-publish@");
    expect(upload.with).toMatchObject({ "packages-dir": "release/pypi/", "skip-existing": true });
  });

  test("reads the version and commit from the event file, refusing a malformed one without echoing it", async () => {
    const { dir, work, sha } = await checkout();
    const name = "Check the requested version and commit";
    let events = 0;
    const dispatch = async (inputs: unknown, dispatchSha = sha) => {
      const event = join(dir, `event-${events++}.json`);
      await Bun.write(event, JSON.stringify({ ref: "refs/heads/main", inputs }));
      return runStep(build, name, work, { GITHUB_EVENT_PATH: event, DISPATCH_SHA: dispatchSha });
    };
    const ok = await dispatch({ version: "0.4.0", commit: sha });
    expect(ok.status).toBe(0);
    expect(ok.env).toBe("VERSION=0.4.0\n");
    expect(ok.outputs).toBe("version=0.4.0\n");
    expect(ok.summary).toContain(`Publishing Critiqs 0.4.0 from ${sha}`);
    expect((await dispatch({ version: "1.0.0-beta.1", commit: sha })).status).toBe(0);

    for (const version of ["0.4.0\n::warning::injected", "0.4.0\n", "0.4.0\u0000", "v0.4.0", "0.4", "0.4.0+build", "", "0.4.0 ", "01.0.0", '0.4.0","injected', 3, null, undefined]) {
      const bad = await dispatch({ version, commit: sha });
      expect({ version, status: bad.status, env: bad.env, outputs: bad.outputs, summary: bad.summary }).toEqual({ version, status: 1, env: "", outputs: "", summary: "" });
      expect(bad.output).toContain("version must be a version number");
      expect(bad.output).not.toContain("injected");
    }

    const moved = await dispatch({ version: "0.4.0", commit: sha }, "f".repeat(40));
    expect(moved.status).toBe(1);
    expect(moved.output).toContain(`not the requested ${sha}`);
    for (const commit of [sha.slice(0, 7), `${sha}\n::warning::injected`, `${sha}\n`, sha.toUpperCase(), null]) {
      const bad = await dispatch({ version: "0.4.0", commit });
      expect(bad.status).toBe(1);
      expect(bad.output).toContain("full 40-character");
      expect(bad.output).not.toContain("injected");
      expect(bad.env).toBe("");
    }

    // No readable event file stops the job.
    const missing = await runStep(build, name, work, { GITHUB_EVENT_PATH: join(dir, "missing.json"), DISPATCH_SHA: sha });
    expect(missing.status).not.toBe(0);
    expect(missing.env).toBe("");
  });

  test("refuses a checkout of another commit, or a commit no longer on main", async () => {
    const { origin, work, sha } = await checkout();
    const name = "Check the checkout is that commit and is on main";
    expect((await runStep(build, name, work, { DISPATCH_SHA: sha })).status).toBe(0);
    expect((await runStep(build, name, work, { DISPATCH_SHA: "f".repeat(40) })).output).toContain("not ffff");

    // main is rewritten after the run started, dropping the commit.
    await git(origin, "commit", "-q", "--amend", "-m", "Rewritten");
    await git(work, "fetch", "-q", "--force", "origin");
    const dropped = await runStep(build, name, work, { DISPATCH_SHA: sha });
    expect(dropped.status).toBe(1);
    expect(dropped.output).toContain("no longer on main");
  });

  test("packs once, pointing the checks at the packed folder and recording the sha256 of its SHA256SUMS", async () => {
    const { dir, work } = await checkout();
    const runner = join(dir, "runner");
    const calls = join(scratch, "bun-calls");
    // A stand-in for `bun scripts/publish.ts pack`: records its arguments and writes a release folder.
    const bun = await standIn("bun", `echo "$*" > "${calls}"\nout="\${@: -1}"\nmkdir -p "$out/npm"\necho packed > "$out/npm/critiqs-0.4.0.tgz"\n(cd "$out" && sha256sum npm/critiqs-0.4.0.tgz > SHA256SUMS)\n`);
    const packed = await runStep(build, "Pack every package", work, { VERSION: "0.4.0" }, { bin: bun });
    expect(packed.status).toBe(0);
    const out = join(runner, "release");
    expect(await Bun.file(calls).text()).toBe(`scripts/publish.ts pack --version 0.4.0 --out ${out}\n`);
    expect(packed.env).toBe(`CRITIQS_PACKED=${out}\n`);
    expect(packed.outputs).toBe(`release=${out}\nsha256=${sha256(join(out, "SHA256SUMS"))}\n`);
    expect(packed.summary).toContain("npm/critiqs-0.4.0.tgz");

    const failing = await runStep(build, "Pack every package", work, { VERSION: "0.4.0" }, { bin: await standIn("bun", "exit 1\n") });
    expect(failing.status).not.toBe(0);
    expect(failing.outputs).toBe("");
    expect(failing.env).toBe("");
  });

  test("refuses to upload when a file, the version, or tracked files changed during the checks, or git fails", async () => {
    const { dir, work, sha } = await checkout();
    const runner = join(dir, "runner");
    const { out, sha: recorded } = await release(runner, "release");
    const name = "Check nothing moved before uploading";
    const env = { VERSION: "0.4.0", DISPATCH_SHA: sha, CRITIQS_PACKED: out, SHA256: recorded };
    expect((await runStep(build, name, work, env)).status).toBe(0);
    expect((await runStep(build, name, work, { ...env, VERSION: "0.5.0" })).output).toContain("requested 0.5.0");
    await Bun.write(join(work, "untracked.txt"), "build output\n");
    expect((await runStep(build, name, work, env)).status).toBe(0);

    for (const missing of [{ SHA256: "" }, { CRITIQS_PACKED: "" }, { CRITIQS_PACKED: join(dir, "other") }]) {
      const result = await runStep(build, name, work, { ...env, ...missing });
      expect(result.status).toBe(1);
      expect(result.output).toContain("recorded no release folder or sha256");
    }
    // Every file must be the one packed, unchanged since packing, and nothing may be added.
    const gem = join(out, "rubygems/critiqs-rails-0.4.0.gem");
    await Bun.write(gem, "rebuilt by a check");
    const replaced = await runStep(build, name, work, env);
    expect(replaced.status).not.toBe(0);
    expect(replaced.output).toContain("FAILED");
    await Bun.write(gem, "gem");
    expect((await runStep(build, name, work, env)).status).toBe(0);
    await Bun.write(join(out, "pypi/extra-0.4.0.tar.gz"), "added by a check");
    const added = await runStep(build, name, work, env);
    expect(added.status).toBe(1);
    expect(added.output).toContain("holds files SHA256SUMS doesn't list");
    await rm(join(out, "pypi/extra-0.4.0.tar.gz"));
    expect((await runStep(build, name, work, { ...env, SHA256: "0".repeat(64) })).output).toContain("FAILED");

    // A git status that fails must stop the job, not read as "nothing changed".
    const realGit = (await git(work, "--exec-path")) + "/git";
    const failingStatus = await standIn("git", `if [ "$1" = status ]; then echo "fatal: injected status failure" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`);
    const broken = await runStep(build, name, work, env, { bin: failingStatus });
    expect(broken.status).not.toBe(0);
    expect(broken.output).toContain("injected status failure");

    await Bun.write(join(work, "packages/react/package.json"), JSON.stringify({ name: "critiqs-react", version: "0.4.0", extra: true }));
    const edited = await runStep(build, name, work, env);
    expect(edited.status).toBe(1);
    expect(edited.output).toContain("changed tracked files");
  });

  test("refuses to publish once the commit has left main, or when GitHub can't say", async () => {
    const { work } = await downloaded();
    const name = "Check the commit is still on main";
    const run = async (gh: string) => runStep(workflow.jobs.npm, name, work, { DISPATCH_SHA: "a".repeat(40), GH_TOKEN: "unused" }, { bin: await standIn("gh", gh) });
    const calls = join(scratch, "gh-calls");
    expect((await run(`echo "$*" > "${calls}"; echo identical`)).status).toBe(0);
    expect(await Bun.file(calls).text()).toBe(`api repos/noahsjung/critiqs/compare/${"a".repeat(40)}...main --jq .status\n`);
    expect((await run("echo ahead")).status).toBe(0);
    for (const status of ["diverged", "behind"]) {
      const left = await run(`echo ${status}`);
      expect(left.status).toBe(1);
      expect(left.output).toContain(`no longer on main (main is ${status})`);
    }
    const failing = await run(`echo "HTTP 404: No common ancestor" >&2; exit 1`);
    expect(failing.status).not.toBe(0);
  });

  test("publishes only the files the build job recorded, each unchanged", async () => {
    const name = "Check the files are the ones that were built and checked";
    const job = workflow.jobs.npm;
    const good = await downloaded();
    expect((await runStep(job, name, good.work, { SHA256: good.sha })).status).toBe(0);

    const tampered = await runStep(job, name, good.work, { SHA256: "0".repeat(64) });
    expect(tampered.status).not.toBe(0);
    expect(tampered.output).toContain("FAILED");
    const missing = await runStep(job, name, good.work, { SHA256: "" });
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("recorded no sha256");

    // A file changed after its sha256 was recorded.
    const wheel = join(good.out, "pypi/django_critiqs-0.4.0-py3-none-any.whl");
    await Bun.write(wheel, "swapped");
    const swapped = await runStep(job, name, good.work, { SHA256: good.sha });
    expect(swapped.status).not.toBe(0);
    expect(swapped.output).toContain("FAILED");
    await Bun.write(wheel, "wheel");

    // A file SHA256SUMS doesn't list, or a listed file that's gone.
    await Bun.write(join(good.out, "pypi/extra-0.4.0.tar.gz"), "extra");
    expect((await runStep(job, name, good.work, { SHA256: good.sha })).output).toContain("doesn't hold exactly the files SHA256SUMS lists");
    await rm(join(good.out, "pypi/extra-0.4.0.tar.gz"));
    // A link is a file to the upload too, so one SHA256SUMS doesn't list is refused.
    await symlink("django_critiqs-0.4.0.tar.gz", join(good.out, "pypi/linked-0.4.0.tar.gz"));
    expect((await runStep(job, name, good.work, { SHA256: good.sha })).output).toContain("doesn't hold exactly the files SHA256SUMS lists");
    await rm(join(good.out, "pypi/linked-0.4.0.tar.gz"));
    await rm(join(good.out, "rubygems/critiqs-rails-0.4.0.gem"));
    expect((await runStep(job, name, good.work, { SHA256: good.sha })).output).toContain("doesn't hold exactly the files SHA256SUMS lists");
  });

  describe("npm", () => {
    const name = "Publish to npm";
    /** A stand-in npm: `view` answers from `published` ("name@version" lines), `publish` records its call. */
    async function npm(published: string[], { viewFails = false } = {}) {
      const calls = join(await mkdtemp(join(scratch, "npm-calls-")), "calls");
      const bin = await standIn("npm", `
if [ "$1" = view ]; then
  ${viewFails ? 'echo "npm error code ECONNRESET" >&2; exit 1' : ""}
  case "${published.join(" ")}" in *"$2"*) echo "\${2##*@}"; exit 0;; esac
  if [ "\${2%@*}" = critiqs ]; then echo "npm error code E404" >&2; exit 1; fi
  exit 0
fi
echo "$PWD $*" >> "${calls}"
`);
      return { bin, calls };
    }

    test("publishes each tarball in order without running its scripts, skipping what npm has", async () => {
      const { work, out } = await downloaded();
      const fresh = await npm([]);
      expect((await runStep(workflow.jobs.npm, name, work, { VERSION: "0.4.0" }, { bin: fresh.bin })).status).toBe(0);
      expect(await Bun.file(fresh.calls).text()).toBe([
        `${join(out, "npm")} publish ./critiqs-0.4.0.tgz --access public --ignore-scripts`,
        `${join(out, "npm")} publish ./critiqs-react-0.4.0.tgz --access public --ignore-scripts`,
        "",
      ].join("\n"));

      // A rerun after critiqs was published publishes only critiqs-react.
      const partial = await npm(["critiqs@0.4.0"]);
      const rerun = await runStep(workflow.jobs.npm, name, work, { VERSION: "0.4.0" }, { bin: partial.bin });
      expect(rerun.status).toBe(0);
      expect(rerun.output).toContain("critiqs@0.4.0 is already on npm; skipped.");
      expect(await Bun.file(partial.calls).text()).toBe(`${join(out, "npm")} publish ./critiqs-react-0.4.0.tgz --access public --ignore-scripts\n`);
    });

    test("stops when npm can't say whether it has a version", async () => {
      const { work } = await downloaded();
      const failing = await npm([], { viewFails: true });
      const result = await runStep(workflow.jobs.npm, name, work, { VERSION: "0.4.0" }, { bin: failing.bin });
      expect(result.status).toBe(1);
      expect(result.output).toContain("Couldn't ask npm whether it has critiqs@0.4.0");
      expect(await Bun.file(failing.calls).exists()).toBe(false);
    });

    test("refuses a tarball of another package or version, or an order that doesn't list the tarballs", async () => {
      for (const manifest of [{ name: "critiqs-react", version: "0.5.0" }, { name: "critiqs-reakt", version: "0.4.0" }]) {
        const { work } = await downloaded({ manifests: { "critiqs-react": manifest } });
        const fresh = await npm([]);
        const result = await runStep(workflow.jobs.npm, name, work, { VERSION: "0.4.0" }, { bin: fresh.bin });
        expect(result.status).toBe(1);
        expect(result.output).toContain(`critiqs-react-0.4.0.tgz is ${manifest.name}@${manifest.version}, not a package at 0.4.0.`);
      }
      const { work, out } = await downloaded();
      await Bun.write(join(out, "npm/order"), "critiqs-0.4.0.tgz\n");
      const fresh = await npm([]);
      const result = await runStep(workflow.jobs.npm, name, work, { VERSION: "0.4.0" }, { bin: fresh.bin });
      expect(result.status).toBe(1);
      expect(result.output).toContain("npm/order doesn't list exactly the packed tarballs");
      expect(await Bun.file(fresh.calls).exists()).toBe(false);
    });

    test("refuses a tarball of a package outside the release group, before publishing anything", async () => {
      const { work, out } = await downloaded();
      await tarball(join(out, "npm/left-pad-0.4.0.tgz"), { name: "left-pad", version: "0.4.0" });
      await Bun.write(join(out, "npm/order"), "left-pad-0.4.0.tgz\ncritiqs-0.4.0.tgz\ncritiqs-react-0.4.0.tgz\n");
      const fresh = await npm([]);
      const result = await runStep(workflow.jobs.npm, name, work, { VERSION: "0.4.0" }, { bin: fresh.bin });
      expect(result.status).toBe(1);
      expect(result.output).toContain("left-pad-0.4.0.tgz holds left-pad, which isn't a Critiqs package.");
      expect(await Bun.file(fresh.calls).exists()).toBe(false);
    });
  });

  describe("PyPI", () => {
    const name = "Check the Python packages";

    test("uploads only a wheel and a source archive of each Critiqs project at the version", async () => {
      const { work, out } = await downloaded();
      await Bun.write(join(out, "pypi/flask_critiqs-0.4.0-py3-none-any.whl"), "wheel");
      await Bun.write(join(out, "pypi/flask_critiqs-0.4.0.tar.gz"), "sdist");
      expect((await runStep(workflow.jobs.pypi, name, work, { VERSION: "0.4.0" })).status).toBe(0);
      expect((await runStep(workflow.jobs.pypi, name, work, { VERSION: "0.5.0" })).output).toContain("django_critiqs-0.4.0-py3-none-any.whl is not a Critiqs Python package at 0.5.0.");
      // The version's dots are literal.
      await Bun.write(join(out, "pypi/flask_critiqs-0x4x0.tar.gz"), "sdist");
      expect((await runStep(workflow.jobs.pypi, name, work, { VERSION: "0.4.0" })).output).toContain("flask_critiqs-0x4x0.tar.gz is not a Critiqs Python package at 0.4.0.");
      await rm(join(out, "pypi/flask_critiqs-0x4x0.tar.gz"));
    });

    test("refuses anything else, a missing half, an empty file, a link, or no package at all", async () => {
      const refuses = async (change: (pypi: string) => Promise<unknown>, message: string) => {
        const { work, out } = await downloaded();
        await change(join(out, "pypi"));
        const result = await runStep(workflow.jobs.pypi, name, work, { VERSION: "0.4.0" });
        expect([result.status, result.output]).toEqual([1, expect.stringContaining(message)]);
      };
      await refuses((pypi) => Bun.write(join(pypi, "requests-0.4.0-py3-none-any.whl"), "x"), "requests-0.4.0-py3-none-any.whl is not a Critiqs Python package");
      await refuses((pypi) => Bun.write(join(pypi, "django_critiqs-0.4.0-cp312-abi3-linux_x86_64.whl"), "x"), "is not a Critiqs Python package");
      await refuses((pypi) => rm(join(pypi, "django_critiqs-0.4.0.tar.gz")), "needs both its wheel and its source archive");
      await refuses((pypi) => Bun.write(join(pypi, "django_critiqs-0.4.0.tar.gz"), ""), "django_critiqs-0.4.0.tar.gz is not a Critiqs Python package");
      await refuses(async (pypi) => {
        await rm(join(pypi, "django_critiqs-0.4.0.tar.gz"));
        await symlink("django_critiqs-0.4.0-py3-none-any.whl", join(pypi, "django_critiqs-0.4.0.tar.gz"));
      }, "django_critiqs-0.4.0.tar.gz is not a Critiqs Python package");
      await refuses((pypi) => mkdir(join(pypi, "flask_critiqs-0.4.0.tar.gz")), "flask_critiqs-0.4.0.tar.gz is not a Critiqs Python package");
      await refuses(async (pypi) => {
        for (const file of await readdir(pypi)) await rm(join(pypi, file));
      }, "The artifact holds no Python package.");
    });
  });

  describe("RubyGems", () => {
    const find = "Find the gems RubyGems doesn't have yet";
    const curl = (status: string) => standIn("curl", `echo "$*" >> "${join(scratch, "curl-calls")}"\nprintf '${status}'\n`);

    test("pushes the gem RubyGems doesn't have, and nothing once it has it", async () => {
      const { work } = await downloaded();
      const runner = join(work, "..", "runner");
      const missing = await runStep(workflow.jobs.rubygems, find, work, { VERSION: "0.4.0" }, { bin: await curl("404") });
      expect(missing.status).toBe(0);
      expect(missing.outputs).toBe("push=true\n");
      expect(await readdir(join(runner, "gems"))).toEqual(["critiqs-rails-0.4.0.gem"]);
      expect(await Bun.file(join(scratch, "curl-calls")).text()).toContain("https://rubygems.org/api/v2/rubygems/critiqs-rails/versions/0.4.0.json");

      const calls = join(scratch, "gem-calls");
      const gem = await standIn("gem", `echo "$*" >> "${calls}"\n`);
      expect((await runStep(workflow.jobs.rubygems, "Push to RubyGems", work, {}, { bin: gem })).status).toBe(0);
      expect(await Bun.file(calls).text()).toBe(`push ${join(runner, "gems/critiqs-rails-0.4.0.gem")}\n`);

      await rm(join(runner, "gems"), { recursive: true });
      const present = await runStep(workflow.jobs.rubygems, find, work, { VERSION: "0.4.0" }, { bin: await curl("200") });
      expect(present.status).toBe(0);
      expect(present.outputs).toBe("push=false\n");
      expect(present.output).toContain("critiqs-rails 0.4.0 is already on RubyGems; skipped.");
    });

    test("stops when RubyGems can't say, or the gem isn't at the requested version", async () => {
      const { work } = await downloaded();
      const outage = await runStep(workflow.jobs.rubygems, find, work, { VERSION: "0.4.0" }, { bin: await curl("503") });
      expect(outage.status).toBe(1);
      expect(outage.output).toContain("RubyGems answered 503 for critiqs-rails 0.4.0");
      const other = await runStep(workflow.jobs.rubygems, find, work, { VERSION: "0.5.0" }, { bin: await curl("404") });
      expect(other.status).toBe(1);
      expect(other.output).toContain("critiqs-rails-0.4.0.gem is not a gem at 0.5.0");
    });
  });
});

test("every workflow pins third-party actions to a full commit SHA with its version", async () => {
  const dir = join(root, ".github/workflows");
  const files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    for (const line of (await Bun.file(join(dir, file)).text()).split("\n")) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/);
      if (!uses || uses[1].startsWith("./")) continue;
      expect({ file, line: line.trim(), pinned: /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(uses[1]) && /^\s+# v\d+(\.\d+)*$/.test(uses[2]) })
        .toEqual({ file, line: line.trim(), pinned: true });
    }
  }
});

test("Dependabot watches every released package's own dependencies: npm through bun, the gem through bundler, Python through pip", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(root, ".github/dependabot.yml")).text()) as { updates: { "package-ecosystem": string; directory?: string; directories?: string[] }[] };
  const watched = new Set(config.updates.flatMap((update) => (update.directories ?? [update.directory!]).map((dir) => `${update["package-ecosystem"]} ${dir}`)));
  const ecosystem: Record<Registry, string> = { npm: "bun", rubygems: "bundler", pypi: "pip" };
  const missing = (await releasePackages(workingTree(root)))
    .filter((pkg) => pkg.registry !== null)
    // bun's entry at / covers every workspace's package.json.
    .map((pkg) => (pkg.registry === "npm" ? "bun /" : `${ecosystem[pkg.registry!]} /${pkg.dir}`))
    .filter((entry) => !watched.has(entry));
  expect(missing).toEqual([]);
});
