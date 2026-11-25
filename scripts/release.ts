// Release notes gate and version step for critiqs-react. The procedure and
// its rules are in docs/releasing.md.
//
//   bun scripts/release.ts check --base <ref> [--head <ref>]
//   bun scripts/release.ts version
//   bun scripts/release.ts pr-body
import { parseChangesetFile } from "@changesets/parse";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_PACKAGE = "critiqs-react";
const RELEASE_MANIFEST = "packages/react/package.json";
const RELEASE_CHANGELOG = "packages/react/CHANGELOG.md";
const BUMPS = ["patch", "minor", "major"];
// Files bundled into critiqs-react: the package and the private workspaces it
// bundles. Tests do not ship.
const SHIPPED = /^packages\/(core|server|backend|react)\//;
const TEST = /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$/;

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
async function pendingReleases(cwd: string): Promise<number> {
  const names = await readdir(join(cwd, ".changeset")).catch(() => []);
  let releases = 0;
  for (const name of names.filter(isNoteName)) {
    releases += parseChangesetFile(await Bun.file(join(cwd, ".changeset", name)).text()).releases.length;
  }
  return releases;
}

/**
 * Consumes pending changesets with the Changesets CLI and refreshes bun.lock.
 * Returns the new critiqs-react version, or null when no pending note
 * releases anything; no-release notes wait to be consumed with the next
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
  return (await Bun.file(join(cwd, RELEASE_MANIFEST)).json()).version;
}

type Change = { status: string; path: string };

/** Changed paths, exactly as stored: NUL-separated, so no name is quoted or escaped. */
async function changes(cwd: string, from: string, to: string): Promise<Change[]> {
  const fields = (await run(["git", "diff", "--name-status", "--no-renames", "-z", from, to], cwd)).split("\0");
  const found: Change[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) found.push({ status: fields[index], path: fields[index + 1] });
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

/** The release metadata rules every pull request must meet. */
export async function check(cwd: string, base: string, head = "HEAD"): Promise<CheckResult> {
  const mergeBase = await git(cwd, "merge-base", base, head);
  const diff = await changes(cwd, mergeBase, head);
  const edits = await releaseEdits(cwd, mergeBase, head, diff);

  if (edits.length > 0) {
    const problem = await isGeneratedRelease(cwd, mergeBase, head);
    if (problem === null) {
      return { ok: true, kind: "release", messages: [`Verified generated release of ${RELEASE_PACKAGE} ${await manifestVersion(cwd, head, RELEASE_MANIFEST)}.`] };
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
  const current = await manifestVersion(cwd, mergeBase, RELEASE_MANIFEST) ?? "0.0.0";
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
      if (name !== RELEASE_PACKAGE) {
        errors.push(`${path}: "${name}" is not released; name "${RELEASE_PACKAGE}", which bundles the private workspaces.`);
      } else if (!BUMPS.includes(type)) {
        errors.push(`${path}: "${type}" is not a release type; use patch, minor, or major, or leave the frontmatter empty for no release.`);
      } else if (type === "major" && Bun.semver.order(current, "1.0.0") < 0) {
        errors.push(`${path}: ${RELEASE_PACKAGE} is ${current}; before 1.0.0 an approved breaking change is a minor release (see docs/releasing.md), and 1.0.0 is the owner's decision.`);
      } else {
        releases++;
        notes.push(`${path}: ${RELEASE_PACKAGE} ${type}`);
      }
    }
    if (parsed.releases.length === 0) notes.push(`${path}: no release`);
  }
  if (notes.length === 0 && errors.length === 0) {
    errors.push('Add a release note (docs/releasing.md): `bun run changeset` for a patch, minor, or major release of critiqs-react, or `bun run changeset add --empty -m "<why>"` when nothing ships.');
  }
  const shipped = diff.filter(({ path }) => SHIPPED.test(path) && !TEST.test(path)).map(({ path }) => path);
  if (shipped.length > 0 && releases === 0 && errors.length === 0) {
    errors.push(`These files ship in ${RELEASE_PACKAGE}, so a no-release note does not cover them; add a patch, minor, or major note:`,
      ...shipped.slice(0, 10).map((path) => `  ${path}`), ...(shipped.length > 10 ? [`  and ${shipped.length - 10} more`] : []));
  }
  return { ok: errors.length === 0, kind: "notes", messages: errors.length > 0 ? errors : notes };
}

/** The release pull request's description: the new changelog entry. */
export async function prBody(cwd: string): Promise<string> {
  const changelog = await Bun.file(join(cwd, RELEASE_CHANGELOG)).text();
  const entry = changelog.split(/^## /m)[1] ?? "";
  return [
    `Generated by the Release workflow from the release notes on \`main\`. Merging it releases \`${RELEASE_PACKAGE}\` ${entry.split("\n")[0]}.`,
    "",
    "Publishing to npm stays a separate, owner-approved step. See [releasing](docs/releasing.md).",
    "",
    `## ${entry.trim()}`,
  ].join("\n");
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
    console.log(next === null ? "No release notes to consume." : `Versioned ${RELEASE_PACKAGE} ${next}.`);
  } else if (command === "pr-body") {
    console.log(await prBody(cwd));
  } else {
    throw new Error("Usage: bun scripts/release.ts check|version|pr-body");
  }
}
