// Release notes gate and version step for the Critiqs packages, which all
// release at one shared version. The procedure and its rules are in
// docs/releasing.md.
//
//   bun scripts/release.ts check --base <ref> [--head <ref>]
//   bun scripts/release.ts version
//   bun scripts/release.ts shared-version
//   bun scripts/release.ts pr-body
import { parseChangesetFile } from "@changesets/parse";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedChanges } from "./shipped-changes.ts";

const BUMPS = ["patch", "minor", "major"];

/** Where a released package is published. */
export type Registry = "npm" | "rubygems" | "pypi";

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  publishConfig?: { access?: string };
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** For a private package published outside npm: its registry. */
  critiqsRelease?: { registry?: string };
}

/**
 * A workspace package in the Changesets fixed group (`critiqs`, `critiqs-*`).
 * Every one is versioned together. `registry` is null when the manifest names
 * no registry it can be published to: public packages go to npm; private ones
 * need `critiqsRelease.registry` (rubygems or pypi) and a `release:build`
 * script.
 */
export interface ReleasePackage {
  name: string;
  /** Workspace folder, relative to the repository root. */
  dir: string;
  version: string;
  registry: Registry | null;
  manifest: Manifest;
}

/** Files of the repository, read from the working tree or from one commit. */
interface Tree {
  read(path: string): Promise<string | null>;
  /** Paths of files matching any of the glob patterns. */
  match(patterns: string[]): Promise<string[]>;
}

export const workingTree = (cwd: string): Tree => ({
  read: (path) => Bun.file(join(cwd, path)).text().catch(() => null),
  async match(patterns) {
    const found = new Set<string>();
    for (const pattern of patterns) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) found.add(path);
    }
    return [...found];
  },
});

const commitTree = (cwd: string, commit: string): Tree => ({
  read: (path) => git(cwd, "show", `${commit}:${path}`).catch(() => null),
  async match(patterns) {
    const globs = patterns.map((pattern) => new Bun.Glob(pattern));
    const paths = (await run(["git", "ls-tree", "-r", "-z", "--name-only", commit], cwd)).split("\0").filter(Boolean);
    return paths.filter((path) => globs.some((glob) => glob.match(path)));
  },
});

function registryOf(manifest: Manifest): Registry | null {
  if (manifest.private !== true) return "npm";
  const registry = manifest.critiqsRelease?.registry;
  return (registry === "rubygems" || registry === "pypi") && manifest.scripts?.["release:build"] ? registry : null;
}

/**
 * The released packages: every workspace package whose name matches the
 * Changesets fixed group that contains `critiqs`, each after the packages
 * it depends on (so `critiqs` comes first), otherwise by name.
 */
export async function releasePackages(tree: Tree): Promise<ReleasePackage[]> {
  const root = JSON.parse(await tree.read("package.json") ?? "{}");
  const workspaces: string[] = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages ?? [];
  const config = JSON.parse(await tree.read(".changeset/config.json") ?? "{}");
  const group = ((config.fixed ?? []) as string[][]).find((patterns) => patterns.includes("critiqs")) ?? [];
  const globs = group.map((pattern) => new Bun.Glob(pattern));
  const found: ReleasePackage[] = [];
  for (const path of await tree.match(workspaces.map((workspace) => `${workspace.replace(/\/$/, "")}/package.json`))) {
    const manifest = JSON.parse(await tree.read(path) ?? "{}") as Manifest;
    if (!manifest.name || !globs.some((glob) => glob.match(manifest.name!))) continue;
    found.push({ name: manifest.name, dir: path.slice(0, -"/package.json".length), version: manifest.version ?? "0.0.0", registry: registryOf(manifest), manifest });
  }
  return dependencyOrder(found.sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * Packages after the group packages they depend on (`critiqs` first, then
 * such as `critiqs-vue` before `critiqs-nuxt`), so a registry never holds a
 * package whose dependency isn't published yet; otherwise in the given order.
 */
function dependencyOrder(packages: ReleasePackage[]): ReleasePackage[] {
  const names = new Set(packages.map((pkg) => pkg.name));
  const ordered: ReleasePackage[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const place = (pkg: ReleasePackage) => {
    if (placed.has(pkg.name)) return;
    if (visiting.has(pkg.name)) throw new Error(`The Critiqs packages depend on each other in a cycle through ${pkg.name}.`);
    visiting.add(pkg.name);
    const needs = { ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies, ...pkg.manifest.peerDependencies };
    for (const name of Object.keys(needs).sort()) if (names.has(name) && name !== pkg.name) place(byName.get(name)!);
    visiting.delete(pkg.name);
    placed.add(pkg.name);
    ordered.push(pkg);
  };
  for (const pkg of packages) place(pkg);
  return ordered;
}

/** The one version every released package has; throws when they differ. */
export function sharedVersion(packages: ReleasePackage[]): string {
  const versions = [...new Set(packages.map((pkg) => pkg.version))];
  if (versions.length !== 1) {
    throw new Error(`The Critiqs packages must share one version, but have ${packages.map((pkg) => `${pkg.name} ${pkg.version}`).join(", ") || "none"}.`);
  }
  return versions[0]!;
}

const highestVersion = (packages: ReleasePackage[]) =>
  packages.map((pkg) => pkg.version).sort((a, b) => Bun.semver.order(b, a))[0] ?? "0.0.0";

const changesetsDir = fileURLToPath(new URL("../node_modules/@changesets/", import.meta.url));

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout;
}

const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd).then((out) => out.trim());

// File names in `.changeset/` that the pinned Changesets CLI skips
// (@changesets/read): hidden files, any-case README.md, and agent files.
const SKIPPED_NOTE_NAMES = [/^\./, /^README\.md$/i, /^(AGENTS|CLAUDE|GEMINI)\.md$/];

/** Whether the Changesets CLI reads this file name in `.changeset/` as a release note. */
export const isNoteName = (name: string) => name.endsWith(".md") && !SKIPPED_NOTE_NAMES.some((pattern) => pattern.test(name));

/** Releases named by notes waiting in `.changeset/`, read as the Changesets CLI reads them. */
export async function pendingReleases(cwd: string): Promise<number> {
  const names = await readdir(join(cwd, ".changeset")).catch(() => []);
  let releases = 0;
  for (const name of names.filter(isNoteName)) {
    releases += parseChangesetFile(await Bun.file(join(cwd, ".changeset", name)).text()).releases.length;
  }
  return releases;
}

/**
 * Consumes pending changesets with the Changesets CLI, which versions every
 * released package to one version and writes each one's changelog, and
 * refreshes bun.lock. Returns the new shared version, or null when no pending
 * note releases anything; no-release notes wait to be consumed with the next
 * release.
 */
export async function version(cwd: string): Promise<string | null> {
  if (await pendingReleases(cwd) === 0) return null;
  // The configured changelog generator resolves from the project's own
  // node_modules; a scratch checkout borrows this installation.
  const linked = join(cwd, "node_modules/@changesets");
  if (!(await lstat(linked).catch(() => null))) {
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await symlink(changesetsDir, linked);
  }
  await run(["node", join(changesetsDir, "cli/bin.js"), "version"], cwd);
  await run(["bun", "install", "--lockfile-only"], cwd);
  return sharedVersion(await releasePackages(workingTree(cwd)));
}

type Change = { status: string; path: string };

/** Changed paths, exactly as stored: NUL-separated, so no name is quoted or escaped. */
async function changes(cwd: string, from: string, to: string): Promise<Change[]> {
  const fields = (await run(["git", "diff", "--name-status", "--no-renames", "-z", from, to], cwd)).split("\0");
  const found: Change[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) found.push({ status: fields[index]!, path: fields[index + 1]! });
  return found;
}

const noteDirectoryName = (path: string) => /^\.changeset\/[^/]+$/.test(path) ? path.slice(".changeset/".length) : null;
const isChangeset = (path: string) => {
  const name = noteDirectoryName(path);
  return name !== null && isNoteName(name);
};

async function manifestVersion(cwd: string, commit: string, path: string): Promise<string | undefined> {
  const text = await git(cwd, "show", `${commit}:${path}`).catch(() => null);
  return text === null ? undefined : JSON.parse(text).version;
}

/** Changes only the version step may make: consumed notes, versions, changelogs. */
async function releaseEdits(cwd: string, from: string, to: string, diff: Change[]): Promise<string[]> {
  const found: string[] = [];
  for (const { status, path } of diff) {
    if (isChangeset(path) && status !== "A") found.push(`${path} (${status === "D" ? "removed" : "edited"} existing release note)`);
    else if (/(^|\/)CHANGELOG\.md$/.test(path)) found.push(`${path} (changelog)`);
    else if (/(^|\/)package\.json$/.test(path) && status === "M"
      && await manifestVersion(cwd, from, path) !== await manifestVersion(cwd, to, path)) {
      found.push(`${path} (version field)`);
    }
  }
  return found;
}

/**
 * Whether `head` is exactly the commit the version step produces on top of
 * its parent, a commit already on the base branch. The branch name is not
 * trusted: the version step is rerun in a scratch checkout and the trees
 * compared.
 */
async function isGeneratedRelease(cwd: string, mergeBase: string, head: string): Promise<string | null> {
  const parents = (await git(cwd, "rev-list", "--parents", "-n", "1", head)).split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== mergeBase) {
    return "a release commit must be a single commit directly on top of the base branch";
  }
  const scratch = await mkdtemp(join(tmpdir(), "critiqs-release-"));
  const checkout = join(scratch, "checkout");
  try {
    // Check out Git LFS files as their stored pointers: the version step never
    // reads them, and CI's checkout keeps no credentials to download them.
    await git(cwd, "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false",
      "worktree", "add", "--detach", checkout, mergeBase);
    if (await version(checkout) === null) return "the base commit has no release notes to consume";
    await git(checkout, "add", "-A");
    const expected = await git(checkout, "write-tree");
    if (expected !== await git(cwd, "rev-parse", `${head}^{tree}`)) {
      const differing = await git(cwd, "diff", "--name-only", expected, `${head}^{tree}`);
      return `it differs from what the version step generates:\n    ${differing.split("\n").join("\n    ")}`;
    }
    return null;
  } finally {
    await git(cwd, "worktree", "remove", "--force", checkout).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

export type CheckResult = { ok: boolean; kind: "release" | "notes"; messages: string[] };

const listed = (lines: string[]) => [...lines.slice(0, 10).map((line) => `  ${line}`), ...(lines.length > 10 ? [`  and ${lines.length - 10} more`] : [])];

/** The release metadata rules every pull request must meet. */
export async function check(cwd: string, base: string, head = "HEAD"): Promise<CheckResult> {
  const mergeBase = await git(cwd, "merge-base", base, head);
  const diff = await changes(cwd, mergeBase, head);
  const edits = await releaseEdits(cwd, mergeBase, head, diff);

  if (edits.length > 0) {
    const problem = await isGeneratedRelease(cwd, mergeBase, head);
    if (problem === null) {
      const released = await releasePackages(commitTree(cwd, head));
      return { ok: true, kind: "release", messages: [`Verified generated release of Critiqs ${sharedVersion(released)}: ${released.map((pkg) => pkg.name).join(", ")}.`] };
    }
    return {
      ok: false, kind: "release", messages: [
        "Only the generated release pull request may change versions, changelogs, or existing release notes:",
        ...edits.map((edit) => `  ${edit}`),
        `Not a generated release: ${problem}.`,
      ],
    };
  }

  const errors: string[] = [];
  const notes: string[] = [];
  let releases = 0;
  // A pull request may add a package to the group and name it in its note.
  const group = await releasePackages(commitTree(cwd, head));
  const names = group.map((pkg) => pkg.name);
  const current = highestVersion(await releasePackages(commitTree(cwd, mergeBase)));
  for (const { status, path } of diff) {
    if (!path.startsWith(".changeset/")) continue;
    if (path === ".changeset/config.json" || path === ".changeset/README.md") continue;
    const name = noteDirectoryName(path);
    if (name !== null && name.endsWith(".md") && !isNoteName(name)) {
      errors.push(`${JSON.stringify(path)}: Changesets does not read this file name, so it would release nothing. Rename it, for example to .changeset/<short-description>.md (not hidden, README.md, AGENTS.md, CLAUDE.md, or GEMINI.md).`);
      continue;
    }
    if (!isChangeset(path) || status !== "A") {
      errors.push(`${JSON.stringify(path)}: only new release notes (.changeset/<name>.md) may be added here.`);
      continue;
    }
    let parsed;
    try {
      parsed = parseChangesetFile(await git(cwd, "show", `${head}:${path}`));
    } catch (error) {
      errors.push(`${path}: ${(error as Error).message.split("\n")[0]}`);
      continue;
    }
    if (!parsed.summary) errors.push(`${path}: write a summary: the change for a release, or why no release is needed.`);
    for (const { name, type } of parsed.releases) {
      if (!names.includes(name)) {
        errors.push(`${path}: "${name}" is not released; name the Critiqs packages the change ships in (${names.join(", ")}). Private workspaces ship inside them.`);
      } else if (!BUMPS.includes(type)) {
        errors.push(`${path}: "${type}" is not a release type; use patch, minor, or major, or leave the frontmatter empty for no release.`);
      } else if (type === "major" && Bun.semver.order(current, "1.0.0") < 0) {
        errors.push(`${path}: Critiqs is ${current}; before 1.0.0 an approved breaking change is a minor release (see docs/releasing.md), and 1.0.0 is the owner's decision.`);
      } else {
        releases++;
        notes.push(`${path}: ${name} ${type}`);
      }
    }
    if (parsed.releases.length === 0) notes.push(`${path}: no release`);
  }
  const read = (commit: string, path: string) => git(cwd, "show", `${commit}:${path}`).catch(() => null);
  const { dependenciesOnly, shipped, packages } = await shippedChanges(cwd, mergeBase, head, diff, new Map(group.map((pkg) => [pkg.dir, pkg.name])), read);
  if (notes.length === 0 && errors.length === 0) {
    // A dependency update that changes nothing a package ships, such as an
    // action's version or a test tool's, releases nothing and needs no note.
    if (dependenciesOnly && shipped.length === 0) {
      return { ok: true, kind: "notes", messages: ["No release note needed: the pull request only updates dependencies, and none ships in a Critiqs package."] };
    }
    errors.push('Add a release note (docs/releasing.md): `bun run changeset` for a patch, minor, or major release of the Critiqs packages the change ships in, or `bun run changeset add --empty -m "<why>"` when nothing ships.');
    if (dependenciesOnly) {
      errors.push(`These dependency updates ship in ${packages.join(", ")}, so they need a patch note naming those packages, such as \`bun run changeset add --patch ${packages.join(",")} -m "Update <dependency> to <version>."\`:`,
        ...listed(shipped));
    }
  }
  if (shipped.length > 0 && releases === 0 && errors.length === 0) {
    errors.push("These files ship in Critiqs packages, so a no-release note does not cover them; add a patch, minor, or major note naming those packages:", ...listed(shipped));
  }
  return { ok: errors.length === 0, kind: "notes", messages: errors.length > 0 ? errors : notes };
}

/** The release pull request's description: each package's new changelog entry. */
export async function prBody(cwd: string): Promise<string> {
  const packages = await releasePackages(workingTree(cwd));
  const next = sharedVersion(packages);
  const sections: string[] = [];
  for (const pkg of packages) {
    const changelog = await Bun.file(join(cwd, pkg.dir, "CHANGELOG.md")).text().catch(() => "");
    const [heading = "", ...body] = (changelog.split(/^## /m)[1] ?? "").split("\n");
    const entry = heading.trim() === next ? body.join("\n").trim() : "";
    sections.push(`## ${pkg.name}`, "", entry || "No changes of its own; released at the shared version.", "");
  }
  return [
    `Generated by the Release workflow from the release notes on \`main\`. Merging it releases Critiqs ${next}: ${packages.map((pkg) => `\`${pkg.name}\``).join(", ")}.`,
    "",
    "Publishing to npm, RubyGems, and PyPI stays a separate, owner-approved step. See [releasing](docs/releasing.md).",
    "",
    ...sections,
  ].join("\n").trimEnd();
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const cwd = process.cwd();
  if (command === "check") {
    const base = option("base");
    if (!base) throw new Error("Usage: bun scripts/release.ts check --base <ref> [--head <ref>]");
    const result = await check(cwd, base, option("head"));
    for (const message of result.messages) (result.ok ? console.log : console.error)(message);
    if (!result.ok) process.exit(1);
  } else if (command === "version") {
    const next = await version(cwd);
    console.log(next === null ? "No release notes to consume." : `Versioned Critiqs ${next}.`);
  } else if (command === "shared-version") {
    console.log(sharedVersion(await releasePackages(workingTree(cwd))));
  } else if (command === "pr-body") {
    console.log(await prBody(cwd));
  } else {
    throw new Error("Usage: bun scripts/release.ts check|version|shared-version|pr-body");
  }
}
