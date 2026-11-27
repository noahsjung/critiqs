// Runs the release gate and the real Changesets CLI against scratch Git
// repositories shaped like this workspace.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, isNoteName, prBody, releasePackages, version, workingTree } from "./release.ts";

setDefaultTimeout(60_000);
const root = new URL("../", import.meta.url).pathname;
const scratch = await mkdtemp(join(tmpdir(), "critiqs-release-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function sh(cwd: string, ...command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout.trim();
}

/** Lets a scratch checkout run the Changesets packages installed here. */
async function linkChangesets(dir: string) {
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await symlink(join(root, "node_modules/@changesets"), join(dir, "node_modules/@changesets"));
}

/** Whether the disk under `dir` tells apart names that differ only in case (Linux; not macOS's default). */
async function caseSensitive(dir: string): Promise<boolean> {
  const probe = join(dir, "Case-Probe");
  await Bun.write(probe, "");
  const sensitive = !(await Bun.file(join(dir, "case-probe")).exists());
  await rm(probe);
  return sensitive;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
let fixtures = 0;

/** The released packages of the fixture: two on npm, a gem, and a PyPI project. */
const manifests = (version: string) => ({
  "packages/critiqs/package.json": { name: "critiqs", version, license: "MIT", publishConfig: { access: "public" }, devDependencies: { "@critiqs/core": "workspace:*" } },
  "packages/react/package.json": { name: "critiqs-react", version, license: "MIT", publishConfig: { access: "public" }, dependencies: { critiqs: version }, devDependencies: { "@critiqs/core": "workspace:*" } },
  "packages/rails/package.json": { name: "critiqs-rails", version, private: true, critiqsRelease: { registry: "rubygems" }, scripts: { "release:build": "bun build.ts" } },
  "packages/django/package.json": { name: "critiqs-django", version, private: true, critiqsRelease: { registry: "pypi" }, scripts: { "release:build": "bun build.ts" } },
});
const released = ["critiqs", "critiqs-django", "critiqs-rails", "critiqs-react"];
const manifestOf = (name: string) => Object.entries(manifests("0")).find(([, manifest]) => manifest.name === name)![0];

/**
 * A Git repository with the workspace's package layout and release
 * configuration, on `main`. Without `readme`, `.changeset/README.md` is left
 * out, so another-case name such as `readme.md` is a file of its own even on
 * a case-insensitive disk (macOS's default), where it would otherwise be
 * the same file as README.md.
 */
async function fixture(startVersion = "0.1.0", { readme = true } = {}) {
  const dir = join(scratch, `repo-${fixtures++}`);
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n",
    "package.json": json({ name: "fixture", private: true, workspaces: ["packages/*", "examples/*"] }),
    ...Object.fromEntries(Object.entries(manifests(startVersion)).map(([path, manifest]) => [path, json(manifest)])),
    "packages/critiqs/src/index.ts": "export const m = 1;\n",
    "packages/react/src/index.ts": "export const a = 1;\n",
    "packages/react/test/index.test.ts": "// test\n",
    "packages/rails/lib/critiqs.rb": "module Critiqs; end\n",
    "packages/rails/test/critiqs_test.rb": "# test\n",
    "packages/django/django_critiqs/__init__.py": "\n",
    "packages/django/tests/test_tags.py": "# test\n",
    "packages/core/package.json": json({ name: "@critiqs/core", version: "0.0.0", private: true }),
    "packages/core/src/index.ts": "export const b = 1;\n",
    "examples/pilot/package.json": json({ name: "@critiqs/example-pilot", version: "0.0.0", private: true, dependencies: { "critiqs-react": "workspace:*" } }),
    "docs/guide.md": "# Guide\n",
    ".changeset/config.json": await Bun.file(join(root, ".changeset/config.json")).text(),
    ...(readme ? { ".changeset/README.md": "# Release notes\n" } : {}),
    "scripts/release.ts": await Bun.file(join(root, "scripts/release.ts")).text(),
  };
  for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
  await linkChangesets(dir);
  await sh(dir, "git", "init", "-q", "-b", "main");
  await sh(dir, "bun", "install", "--lockfile-only");
  await sh(dir, "git", "add", "-A");
  await sh(dir, "git", "commit", "-qm", "Initial");

  const repo = {
    dir,
    async commit(changes: Record<string, string | null>, message = "Change") {
      for (const [path, text] of Object.entries(changes)) {
        if (text === null) await rm(join(dir, path));
        else await Bun.write(join(dir, path), text);
      }
      await sh(dir, "git", "add", "-A");
      await sh(dir, "git", "commit", "-qm", message);
    },
    branch: (name: string, from = "main") => sh(dir, "git", "checkout", "-q", "-B", name, from),
    check: (base = "main") => check(dir, base, "HEAD"),
    read: (path: string) => Bun.file(join(dir, path)).text(),
    manifest: async (path: string) => JSON.parse(await Bun.file(join(dir, path)).text()),
    /** Merges notes to main, then makes the release commit as the Release workflow does. */
    async release(notes: Record<string, string>) {
      await repo.branch("main");
      await repo.commit(notes, "Feature");
      await repo.branch("changeset-release/main");
      const next = await version(dir);
      await sh(dir, "git", "add", "-A");
      await sh(dir, "git", "commit", "-qm", `Release Critiqs ${next}`);
      return next;
    },
  };
  return repo;
}

const note = (releases: Record<string, string>, summary: string) =>
  `---\n${Object.entries(releases).map(([name, type]) => `"${name}": ${type}`).join("\n")}\n---\n\n${summary}\n`;

describe("version step (real Changesets CLI)", () => {
  for (const [type, expected] of [["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"]]) {
    test(`a ${type} note for one package moves every package from 1.2.3 to ${expected}`, async () => {
      const repo = await fixture("1.2.3");
      await repo.commit({ ".changeset/a.md": note({ "critiqs-react": type }, `A ${type} change.`) });
      expect(await version(repo.dir)).toBe(expected);
      for (const name of released) {
        expect((await repo.manifest(manifestOf(name))).version).toBe(expected);
        expect(await repo.read(manifestOf(name).replace("package.json", "CHANGELOG.md"))).toContain(`## ${expected}`);
      }
      expect(await repo.read("packages/react/CHANGELOG.md")).toContain(`A ${type} change.`);
      expect(await repo.read("packages/critiqs/CHANGELOG.md")).not.toContain(`A ${type} change.`);
      // critiqs-react's exact dependency on critiqs follows the shared version.
      expect((await repo.manifest("packages/react/package.json")).dependencies).toEqual({ critiqs: expected });
      expect(await repo.read("bun.lock")).toContain(`"version": "${expected}"`);
      expect(await Bun.file(join(repo.dir, ".changeset/a.md")).exists()).toBe(false);
    });
  }

  test("notes for a gem and a PyPI package land in their own changelogs at the shared version", async () => {
    const repo = await fixture("0.3.0");
    await repo.commit({
      ".changeset/rails.md": note({ "critiqs-rails": "minor" }, "Add the Rails helper."),
      ".changeset/python.md": note({ "critiqs-django": "patch", critiqs: "patch" }, "Fix the Django template tag."),
    });
    expect(await version(repo.dir)).toBe("0.4.0");
    for (const name of released) expect((await repo.manifest(manifestOf(name))).version).toBe("0.4.0");
    expect(await repo.read("packages/rails/CHANGELOG.md")).toContain("Add the Rails helper.");
    expect(await repo.read("packages/django/CHANGELOG.md")).toContain("Fix the Django template tag.");
    expect(await repo.read("packages/critiqs/CHANGELOG.md")).toContain("Fix the Django template tag.");
    // The private packages stay private: they publish to their own registries, never npm.
    expect((await repo.manifest("packages/rails/package.json")).private).toBe(true);
    const body = await prBody(repo.dir);
    expect(body).toContain("Merging it releases Critiqs 0.4.0: `critiqs`, `critiqs-django`, `critiqs-rails`, `critiqs-react`.");
    expect(body).toMatch(/## critiqs-rails\n\n### Minor Changes\n\n- [0-9a-f]+: Add the Rails helper\./);
    expect(body.indexOf("## critiqs\n")).toBeLessThan(body.indexOf("## critiqs-django\n"));
  });

  test("a package added to the group joins the shared version", async () => {
    const repo = await fixture("0.3.0");
    await repo.commit({
      "packages/vue/package.json": json({ name: "critiqs-vue", version: "0.3.0", license: "MIT", publishConfig: { access: "public" }, dependencies: { critiqs: "0.3.0" } }),
      ".changeset/vue.md": note({ "critiqs-vue": "minor", critiqs: "minor" }, "Add Critiqs for Vue."),
    });
    expect(await version(repo.dir)).toBe("0.4.0");
    expect((await repo.manifest("packages/vue/package.json")).version).toBe("0.4.0");
    expect((await repo.manifest("packages/rails/package.json")).version).toBe("0.4.0");
  });

  test("mixed notes take the largest bump, keep every summary, and leave private workspaces unversioned", async () => {
    const repo = await fixture("0.1.0");
    await repo.commit({
      ".changeset/fix.md": note({ "critiqs-react": "patch" }, "Fix the toolbar."),
      ".changeset/feature.md": note({ "critiqs-react": "minor" }, "Add an optional property."),
      ".changeset/docs.md": "---\n---\n\nDocumentation only.\n",
    });
    expect(await version(repo.dir)).toBe("0.2.0");
    const changelog = await repo.read("packages/react/CHANGELOG.md");
    expect(changelog).toContain("### Minor Changes");
    expect(changelog).toContain("Add an optional property.");
    expect(changelog).toContain("### Patch Changes");
    expect(changelog).toContain("Fix the toolbar.");
    expect((await repo.manifest("packages/core/package.json")).version).toBe("0.0.0");
    expect((await repo.manifest("examples/pilot/package.json")).version).toBe("0.0.0");
    // The public package keeps its publishing settings; versioning publishes nothing.
    expect(await repo.manifest("packages/react/package.json")).toMatchObject({ license: "MIT", publishConfig: { access: "public" } });
    expect((await repo.manifest("packages/react/package.json")).private).toBeUndefined();
    for (const name of released) expect((await repo.manifest(manifestOf(name))).version).toBe("0.2.0");
    expect(await Bun.file(join(repo.dir, "packages/core/CHANGELOG.md")).exists()).toBe(false);
    expect(await Bun.file(join(repo.dir, ".changeset/docs.md")).exists()).toBe(false);
    await sh(repo.dir, "bun", "install", "--frozen-lockfile");
    await sh(repo.dir, "git", "add", "-A");
    const tree = await sh(repo.dir, "git", "write-tree");
    expect(await version(repo.dir)).toBeNull();
    await sh(repo.dir, "git", "add", "-A");
    expect(await sh(repo.dir, "git", "write-tree")).toBe(tree);
  });

  test("only no-release notes, or none, release nothing and change nothing", async () => {
    const repo = await fixture();
    expect(await version(repo.dir)).toBeNull();
    await repo.commit({ ".changeset/docs.md": "---\n---\n\nDocumentation only.\n" });
    expect(await version(repo.dir)).toBeNull();
    expect(await sh(repo.dir, "git", "status", "--porcelain")).toBe("");
  });
});

describe("pull request gate", () => {
  const cases: [string, Record<string, string | null>, boolean, RegExp][] = [
    ["a missing note", { "docs/guide.md": "# Changed\n" }, false, /Add a release note/],
    ["a reasoned no-release note for documentation", { "docs/guide.md": "# Changed\n", ".changeset/docs.md": "---\n---\n\nDocumentation only.\n" }, true, /no release/],
    ["a no-release note for test-only changes", { "packages/react/test/index.test.ts": "// more\n", ".changeset/t.md": "---\n---\n\nTests only.\n" }, true, /no release/],
    ["a patch note for shipped code", { "packages/core/src/index.ts": "export const b = 2;\n", ".changeset/f.md": note({ "critiqs-react": "patch" }, "Fix b.") }, true, /critiqs-react patch/],
    ["a note naming the shared package", { "packages/critiqs/src/index.ts": "export const m = 2;\n", ".changeset/f.md": note({ critiqs: "minor" }, "Add m.") }, true, /f\.md: critiqs minor/],
    ["a note naming the gem", { "packages/rails/lib/critiqs.rb": "module Critiqs; VERSION = 1; end\n", ".changeset/f.md": note({ "critiqs-rails": "patch" }, "Fix.") }, true, /critiqs-rails patch/],
    ["a note naming several packages", { ".changeset/f.md": note({ "critiqs-django": "minor", critiqs: "minor" }, "Add.") }, true, /critiqs-django minor\n.*critiqs minor/],
    ["a no-release note for a package's consumer check", { "packages/react/scripts/check-consumer.ts": "// pinned\n", ".changeset/t.md": "---\n---\n\nConsumer check only.\n" }, true, /no release/],
    ["a forged skip for a package's build script", { "packages/react/scripts/build.ts": "// changed\n", ".changeset/f.md": "---\n---\n\nNothing to see.\n" }, false, /packages\/react\/scripts\/build\.ts/],
    ["a forged skip for source in a folder named scripts", { "packages/core/src/scripts/check-x.ts": "export {};\n", ".changeset/f.md": "---\n---\n\nNothing to see.\n" }, false, /packages\/core\/src\/scripts\/check-x\.ts/],
    ["a no-release note for gem and Python tests", { "packages/rails/test/critiqs_test.rb": "# more\n", "packages/django/tests/test_tags.py": "# more\n", ".changeset/t.md": "---\n---\n\nTests only.\n" }, true, /no release/],
    ["a forged skip for shipped code in a bundled workspace", { "packages/core/src/index.ts": "export const b = 2;\n", ".changeset/f.md": "---\n---\n\nNothing to see.\n" }, false, /ship in Critiqs packages/],
    ["a forged skip for shipped Python code", { "packages/django/django_critiqs/__init__.py": "x = 1\n", ".changeset/f.md": "---\n---\n\nNothing to see.\n" }, false, /packages\/django\/django_critiqs\/__init__\.py/],
    ["a no-release note without a reason", { "docs/guide.md": "# Changed\n", ".changeset/docs.md": "---\n---\n" }, false, /write a summary/],
    ["a note naming a bundled private workspace", { ".changeset/f.md": note({ "@critiqs/core": "minor" }, "Core.") }, false, /"@critiqs\/core" is not released; name the Critiqs packages the change ships in \(critiqs, critiqs-django, critiqs-rails, critiqs-react\)/],
    ["a note naming an unknown package", { ".changeset/f.md": note({ "left-pad": "patch" }, "X.") }, false, /"left-pad" is not released/],
    ["a note naming the PyPI project instead of the workspace package", { ".changeset/f.md": note({ "django-critiqs": "patch" }, "X.") }, false, /"django-critiqs" is not released/],
    ["a note naming a new package added in the same pull request", { "packages/vue/package.json": json({ name: "critiqs-vue", version: "0.1.0", license: "MIT", publishConfig: { access: "public" } }), ".changeset/f.md": note({ "critiqs-vue": "minor" }, "Add Vue.") }, true, /critiqs-vue minor/],
    ["a malformed note", { ".changeset/f.md": "no frontmatter at all\n" }, false, /missing or invalid frontmatter/],
    ["an invalid release type", { ".changeset/f.md": note({ "critiqs-react": "huge" }, "X.") }, false, /invalid version type/],
    ["the Changesets \"none\" type", { ".changeset/f.md": note({ "critiqs-react": "none" }, "X.") }, false, /not a release type/],
    ["a major note before 1.0.0", { ".changeset/f.md": note({ "critiqs-react": "major" }, "Break.") }, false, /before 1\.0\.0/],
    ["an unexpected file in .changeset", { ".changeset/notes.txt": "x\n", ".changeset/f.md": note({ "critiqs-react": "patch" }, "X.") }, false, /only new release notes/],
    ["a manual version edit", { "packages/react/package.json": json({ ...manifests("0.2.0")["packages/react/package.json"], dependencies: { critiqs: "0.1.0" } }), ".changeset/f.md": note({ "critiqs-react": "minor" }, "X.") }, false, /version field/],
    ["a manual gem version edit", { "packages/rails/package.json": json(manifests("0.2.0")["packages/rails/package.json"]), ".changeset/f.md": note({ "critiqs-rails": "minor" }, "X.") }, false, /packages\/rails\/package.json \(version field\)/],
    ["a manual private workspace version edit", { "packages/core/package.json": json({ name: "@critiqs/core", version: "1.0.0", private: true }), ".changeset/f.md": "---\n---\n\nX.\n" }, false, /packages\/core\/package.json \(version field\)/],
    ["a manual changelog edit", { "packages/react/CHANGELOG.md": "# critiqs-react\n", ".changeset/f.md": note({ "critiqs-react": "patch" }, "X.") }, false, /changelog/],
    ["a manual Python changelog edit", { "packages/django/CHANGELOG.md": "# critiqs-django\n", ".changeset/f.md": note({ "critiqs-django": "patch" }, "X.") }, false, /packages\/django\/CHANGELOG.md \(changelog\)/],
  ];
  for (const [name, changes, ok, message] of cases) {
    test(`${ok ? "accepts" : "rejects"} ${name}`, async () => {
      const repo = await fixture();
      await repo.branch("feature");
      await repo.commit(changes);
      const result = await repo.check();
      expect(result.ok).toBe(ok);
      expect(result.messages.join("\n")).toMatch(message);
    });
  }

  test("accepts a major note from 1.0.0 on", async () => {
    const repo = await fixture("1.0.0");
    await repo.branch("feature");
    await repo.commit({ ".changeset/f.md": note({ "critiqs-react": "major" }, "Remove a property.") });
    expect((await repo.check()).ok).toBe(true);
  });

  test("rejects editing or removing another pull request's note", async () => {
    const repo = await fixture();
    await repo.commit({ ".changeset/theirs.md": note({ "critiqs-react": "patch" }, "Theirs.") });
    for (const change of [note({ "critiqs-react": "major" }, "Theirs."), null]) {
      await repo.branch("feature");
      await repo.commit({ ".changeset/theirs.md": change, ".changeset/mine.md": note({ "critiqs-react": "patch" }, "Mine.") });
      const result = await repo.check();
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toMatch(/theirs\.md \((edited|removed) existing release note\)/);
    }
  });

  test("judges a branch only by its own changes after merging the base", async () => {
    const repo = await fixture();
    await repo.branch("feature");
    await repo.commit({ ".changeset/mine.md": "---\n---\n\nDocs.\n", "docs/guide.md": "# Mine\n" });
    await repo.branch("main");
    await repo.release({ ".changeset/other.md": note({ "critiqs-react": "minor" }, "Other.") });
    await sh(repo.dir, "git", "checkout", "-q", "main");
    await sh(repo.dir, "git", "merge", "-q", "--ff-only", "changeset-release/main");
    await sh(repo.dir, "git", "checkout", "-q", "feature");
    await sh(repo.dir, "git", "merge", "-q", "--no-edit", "main");
    expect(await repo.check()).toMatchObject({ ok: true, kind: "notes" });
  });
});

describe("note file names the Changesets CLI skips", () => {
  const skipped = [".hidden.md", "README.md", "readme.md", "Readme.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"];
  const read = ["agents.md", "plain.md", "naïve note.md"];
  /** Another case of README.md: a different file only where the disk is case-sensitive, so tested without the fixture's README.md. */
  const otherCaseReadme = (name: string) => name !== "README.md" && name.toLowerCase() === "readme.md";

  test("match the installed CLI: it consumes exactly the names the gate accepts", async () => {
    // Names that differ only in case (README.md, readme.md; AGENTS.md, agents.md) are one file on a
    // case-insensitive disk, so each checkout gets names that are distinct in any case.
    const groups: string[][] = [];
    for (const name of [...skipped, ...read]) {
      const group = groups.find((names) => !names.some((other) => other.toLowerCase() === name.toLowerCase()));
      if (group === undefined) groups.push([name]);
      else group.push(name);
    }
    expect(groups.length).toBeGreaterThan(1);
    // Every checkout has a note the CLI reads, so each run shows it read the folder and skipped the rest.
    for (const names of groups) if (!names.some((name) => read.includes(name))) names.push("plain.md");
    // Where the disk tells them apart (Linux, as in CI), also all names in one folder, so a name read
    // or skipped only beside another case of itself (agents.md beside AGENTS.md) is caught too.
    if (await caseSensitive(scratch)) groups.unshift([...skipped, ...read]);
    for (const names of groups) {
      const repo = await fixture("0.1.0", { readme: !names.some(otherCaseReadme) });
      await repo.commit(Object.fromEntries(names.map((name) => [`.changeset/${name}`, note({ "critiqs-react": "patch" }, `From ${name}.`)])));
      // Each name is a file of its own. Some disks (HFS+) return names decomposed, so compare them composed.
      const written = (await readdir(join(repo.dir, ".changeset"))).map((name) => name.normalize("NFC"));
      expect(written.filter((name) => names.includes(name)).sort()).toEqual([...names].sort());
      expect(await version(repo.dir)).toBe("0.1.1");
      const changelog = await repo.read("packages/react/CHANGELOG.md");
      for (const name of names) {
        expect(isNoteName(name)).toBe(read.includes(name));
        expect(changelog.includes(`From ${name}.`)).toBe(read.includes(name));
        expect(await Bun.file(join(repo.dir, ".changeset", name)).exists()).toBe(!read.includes(name));
      }
    }
  });

  for (const name of skipped.filter((name) => name !== "README.md")) {
    test(`rejects a release note named ${name}`, async () => {
      const repo = await fixture("0.1.0", { readme: !otherCaseReadme(name) });
      await repo.branch("feature");
      await repo.commit({ "packages/core/src/index.ts": "export const b = 2;\n", [`.changeset/${name}`]: note({ "critiqs-react": "minor" }, "Feature.") });
      const result = await repo.check();
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toMatch(/Changesets does not read this file name.*Rename it/);
    });
  }

  test("rejects a skipped name beside a read note", async () => {
    const repo = await fixture();
    await repo.branch("feature");
    await repo.commit({ ".changeset/fix.md": note({ "critiqs-react": "patch" }, "Fix."), ".changeset/AGENTS.md": note({ "critiqs-react": "minor" }, "Feature.") });
    const result = await repo.check();
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain('".changeset/AGENTS.md": Changesets does not read');
  });

  test("a skipped file already on main releases nothing", async () => {
    const repo = await fixture();
    await repo.commit({ ".changeset/AGENTS.md": note({ "critiqs-react": "minor" }, "Never read.") });
    expect(await version(repo.dir)).toBeNull();
    expect(await sh(repo.dir, "git", "status", "--porcelain")).toBe("");
  });
});

test("no released package publishes the check scripts the gate counts as tests", async () => {
  const published: string[] = [];
  for (const pkg of await releasePackages(workingTree(root))) {
    if (pkg.registry === "npm") published.push(...pkg.manifest.files!.map((entry) => `${pkg.name}: ${entry}`));
    else {
      // The gem's spec.files and the Python sdist's include list.
      const source = await Bun.file(join(root, pkg.dir, pkg.registry === "rubygems" ? `${pkg.name}.gemspec` : "pyproject.toml")).text();
      const lists = [...source.matchAll(/^\s*(?:spec\.files = Dir|include = )\[([^\]]*)\]/gm)].map((match) => match[1]!);
      expect(lists.length, pkg.name).toBeGreaterThan(0);
      published.push(...lists.flatMap((list) => list.split(",").map((entry) => `${pkg.name}: ${entry.trim().replaceAll('"', "")}`)));
    }
  }
  expect(published.length).toBeGreaterThan(20);
  expect(published.filter((entry) => /: \/?(scripts|\*)/.test(entry))).toEqual([]);
});

describe("unusual paths", () => {
  const noRelease = { ".changeset/docs.md": "---\n---\n\nDocumentation only.\n" };
  for (const path of ["packages/backend/convex/café.ts", "packages/react/src/ spaced name .ts", "packages/core/src/tab\tand\nnewline.ts", "packages/core/src/\"quoted\".ts"]) {
    test(`a no-release note does not cover shipped ${JSON.stringify(path)}`, async () => {
      const repo = await fixture();
      await repo.branch("feature");
      await repo.commit({ [path]: "export const c = 1;\n", ...noRelease });
      const result = await repo.check();
      expect(result.ok).toBe(false);
      expect(result.messages).toContain(`  ${path}`);
    });
  }

  test("accepts a new note with a non-ASCII name and rejects editing one", async () => {
    const repo = await fixture();
    await repo.branch("feature");
    await repo.commit({ ".changeset/thé.md": note({ "critiqs-react": "patch" }, "Fix.") });
    expect(await repo.check()).toMatchObject({ ok: true, messages: [".changeset/thé.md: critiqs-react patch"] });
    await sh(repo.dir, "git", "checkout", "-q", "main");
    await sh(repo.dir, "git", "merge", "-q", "feature");
    await repo.branch("edit");
    await repo.commit({ ".changeset/thé.md": note({ "critiqs-react": "minor" }, "Fix."), ".changeset/mine.md": note({ "critiqs-react": "patch" }, "Mine.") });
    const result = await repo.check();
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain(".changeset/thé.md (edited existing release note)");
  });
});

describe("release pull request verification", () => {
  test("accepts the generated release commit, also after main moves on", async () => {
    const repo = await fixture();
    expect(await repo.release({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") })).toBe("0.2.0");
    expect(await repo.check()).toMatchObject({ ok: true, kind: "release" });
    await repo.branch("advanced", "main");
    await repo.commit({ "docs/guide.md": "# Later\n" });
    await sh(repo.dir, "git", "checkout", "-q", "changeset-release/main");
    expect(await repo.check("advanced")).toMatchObject({ ok: true, kind: "release" });
    expect((await sh(repo.dir, "git", "worktree", "list")).split("\n")).toHaveLength(1);
  });

  test("rejects a release commit with any hand edit, whatever the branch is called", async () => {
    const repo = await fixture();
    await repo.release({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    await Bun.write(join(repo.dir, "packages/react/src/index.ts"), "export const a = 'sneaky';\n");
    await sh(repo.dir, "git", "commit", "-qa", "--amend", "--no-edit");
    const result = await repo.check();
    expect(result).toMatchObject({ ok: false, kind: "release" });
    expect(result.messages.join("\n")).toContain("packages/react/src/index.ts");
  });

  test("rejects a hand-picked version", async () => {
    const repo = await fixture();
    await repo.release({ ".changeset/a.md": note({ "critiqs-react": "patch" }, "Fix.") });
    const manifest = await repo.manifest("packages/react/package.json");
    await Bun.write(join(repo.dir, "packages/react/package.json"), json({ ...manifest, version: "1.0.0" }));
    await sh(repo.dir, "git", "commit", "-qa", "--amend", "--no-edit");
    expect(await repo.check()).toMatchObject({ ok: false, kind: "release" });
  });

  test("rejects a release commit stacked on another commit", async () => {
    const repo = await fixture();
    await repo.release({ ".changeset/a.md": note({ "critiqs-react": "patch" }, "Fix.") });
    await repo.commit({ "docs/guide.md": "# Extra\n" });
    const result = await repo.check();
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/single commit directly on top/);
  });
});

const lfsPointer = (oid: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(64)}\nsize 4096\n`;

describe("release pull request verification with Git LFS files", () => {
  // Git LFS configured as on the CI runner, where its smudge step fails
  // because the checkout keeps no credentials. This machine's own Git
  // configuration is set aside.
  const isolated = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((key) => [key, process.env[key]] as const);
  beforeAll(async () => {
    const config = join(scratch, "lfs.gitconfig");
    await Bun.write(config, `[filter "lfs"]\n\tclean = cat\n\tsmudge = "echo 'Git credentials not found' >&2; exit 1"\n\trequired = true\n`);
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
  });
  afterAll(() => {
    for (const [key, value] of isolated) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A fixture with a Git LFS screenshot whose content cannot be downloaded. */
  async function lfsFixture(attributes = "") {
    const repo = await fixture();
    await repo.commit({
      ".gitattributes": `docs/research/**/*.png filter=lfs diff=lfs merge=lfs -text\n${attributes}`,
      "docs/research/shot.png": lfsPointer("a"),
    });
    return repo;
  }

  /** Runs the gate as CI does, with its scratch checkouts in a fresh temporary directory, and checks it left nothing behind. */
  async function checkAndCleanUp(dir: string) {
    const temp = await mkdtemp(join(scratch, "tmp-"));
    const child = Bun.spawn(["bun", join(root, "scripts/release.ts"), "check", "--base", "main", "--head", "HEAD"], {
      cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: temp },
    });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect((await readdir(temp)).filter((name) => name.startsWith("critiqs-release-"))).toEqual([]);
    expect((await sh(dir, "git", "worktree", "list")).split("\n")).toHaveLength(1);
    return { status, output: stdout + stderr };
  }

  test("accepts the generated release without downloading LFS content", async () => {
    const repo = await lfsFixture();
    // The fixture fails like CI: a plain scratch checkout cannot smudge the screenshot.
    await expect(sh(repo.dir, "git", "worktree", "add", "--detach", join(scratch, `plain-${fixtures}`), "main"))
      .rejects.toThrow(/smudge filter lfs failed/);
    await repo.release({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    expect(await checkAndCleanUp(repo.dir)).toEqual({ status: 0, output: "Verified generated release of Critiqs 0.2.0: critiqs, critiqs-django, critiqs-rails, critiqs-react.\n" });
  });

  test("still rejects a release commit that changes an LFS file", async () => {
    const repo = await lfsFixture();
    await repo.release({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    await Bun.write(join(repo.dir, "docs/research/shot.png"), lfsPointer("b"));
    await sh(repo.dir, "git", "commit", "-qa", "--amend", "--no-edit");
    const { status, output } = await checkAndCleanUp(repo.dir);
    expect(status).toBe(1);
    expect(output).toContain("Not a generated release: it differs from what the version step generates:\n    docs/research/shot.png");
  });

  test("leaves other required filters in force, and cleans up when the scratch checkout fails", async () => {
    const repo = await lfsFixture("docs/secret.txt filter=vault\n");
    for (const [key, value] of [["filter.vault.clean", "cat"], ["filter.vault.smudge", "exit 1"], ["filter.vault.required", "true"]]) {
      await sh(repo.dir, "git", "config", key, value);
    }
    await repo.commit({ "docs/secret.txt": "sealed\n" });
    await repo.release({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    const { status, output } = await checkAndCleanUp(repo.dir);
    expect(status).toBe(1);
    expect(output).toContain("smudge filter vault failed");
  });
});

const workflow = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/release.yml")).text()) as any;
const ci = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/ci.yml")).text()) as any;

describe("Release workflow", () => {
  const job = workflow.jobs["release-pull-request"];
  const step = (name: string) => job.steps.find((step: any) => step.name === name).run as string;
  type PullRequest = { number: number; isCrossRepository: boolean };

  /**
   * Runs the workflow's own shell steps on a fresh clone of `origin`, with a
   * stand-in for `gh` that records calls, keeps open pull requests, records
   * the release branch commit of each dispatched CI run, and can fail once.
   */
  async function setup() {
    const repo = await fixture();
    const name = repo.dir.split("/").pop();
    const origin = join(repo.dir, "..", `${name}-origin.git`);
    await sh(repo.dir, "git", "clone", "-q", "--bare", repo.dir, origin);
    await sh(repo.dir, "git", "remote", "add", "origin", origin);
    const bin = join(origin, "..", `${name}-bin`);
    const state = { log: join(bin, "gh.log"), prs: join(bin, "prs.json"), runs: join(bin, "runs"), fail: join(bin, "fail") };
    await Bun.write(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${state.log}"
if [ "$(cat "${state.fail}")" = "$1 $2" ]; then : > "${state.fail}"; echo "injected $1 $2 failure" >&2; exit 1; fi
prs="${state.prs}"
case "$1 $2" in
  "pr list") cat "$prs" ;;
  "pr create") jq -c '. + [{"number": 7, "isCrossRepository": false}]' "$prs" > "$prs.new"; mv "$prs.new" "$prs" ;;
  "pr close") jq -c --argjson n "$3" 'map(select(.number != $n))' "$prs" > "$prs.new"; mv "$prs.new" "$prs" ;;
  "workflow run") git -C "${origin}" rev-parse refs/heads/changeset-release/main >> "${state.runs}" ;;
  "run list")
    while [ $# -gt 0 ]; do if [ "$1" = --commit ]; then commit=$2; fi; shift; done
    jq -R -s -c --arg commit "$commit" 'split("\\n") | map(select(. == $commit) | {databaseId: 1})' "${state.runs}" ;;
esac
`);
    await chmod(join(bin, "gh"), 0o755);
    for (const file of [state.runs, state.fail]) await Bun.write(file, "");
    await Bun.write(state.prs, "[]");
    let attempts = 0;
    return {
      repo, origin,
      setPullRequests: (prs: PullRequest[]) => Bun.write(state.prs, JSON.stringify(prs)),
      pullRequests: async () => JSON.parse(await Bun.file(state.prs).text()) as PullRequest[],
      failNext: (call: string) => Bun.write(state.fail, call),
      dispatched: async () => (await Bun.file(state.runs).text()).split("\n").filter(Boolean),
      branchHead: () => sh(origin, "git", "rev-parse", "--verify", "-q", "refs/heads/changeset-release/main").catch(() => ""),
      async push(changes: Record<string, string>) {
        await repo.commit(changes);
        await sh(repo.dir, "git", "push", "-q", "origin", "main");
      },
      /** One workflow run; returns its `gh` calls, each as its first words. */
      async run({ fails = false, path = "" } = {}): Promise<string[]> {
        await Bun.write(state.log, "");
        const work = join(bin, `work-${attempts++}`);
        await sh(bin, "git", "clone", "-q", "--branch", "main", origin, work);
        await linkChangesets(work);
        const env = { ...process.env, ...job.env, GH_TOKEN: "unused", RUNNER_TEMP: bin, PATH: `${path ? `${path}:` : ""}${bin}:${process.env.PATH}` };
        let failed = false;
        for (const name of ["Version", "Open or update the release pull request"]) {
          const child = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step(name)], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
          const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          if (status !== 0) {
            if (!fails) throw new Error(`${name} failed (${status}):\n${stdout}\n${stderr}`);
            expect(stderr).toContain("injected");
            failed = true;
            break;
          }
        }
        expect(failed).toBe(fails);
        return (await Bun.file(state.log).text()).trim().split("\n").filter(Boolean).map((line) => {
          const words = line.split(" ");
          return words.slice(0, ["pr edit", "pr close"].includes(words.slice(0, 2).join(" ")) ? 3 : 2).join(" ");
        });
      },
    };
  }

  test("opens one release pull request, reruns without changes, and refreshes when main moves", async () => {
    const { repo, origin, run, push, branchHead, dispatched } = await setup();
    await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });

    expect(await run()).toEqual(["pr list", "pr create", "run list", "workflow run"]);
    const first = await branchHead();
    expect(await sh(origin, "git", "log", "-1", "--format=%s", first)).toBe("Release Critiqs 0.2.0");
    await sh(repo.dir, "git", "fetch", "-q", "origin");
    expect(await check(repo.dir, "origin/main", "origin/changeset-release/main")).toMatchObject({ ok: true, kind: "release" });

    // A rerun for the same main pushes nothing and starts no second CI run.
    expect(await run()).toEqual(["pr list", "pr edit 7", "run list"]);
    expect(await branchHead()).toBe(first);

    // Another merged note regenerates the release on the new main.
    await push({ ".changeset/b.md": note({ "critiqs-react": "patch" }, "Fix.") });
    expect(await run()).toEqual(["pr list", "pr edit 7", "run list", "workflow run"]);
    const second = await branchHead();
    expect(second).not.toBe(first);
    expect(await dispatched()).toEqual([first, second]);
    await sh(repo.dir, "git", "fetch", "-q", "origin");
    expect(await check(repo.dir, "origin/main", "origin/changeset-release/main")).toMatchObject({ ok: true, kind: "release" });
  });

  for (const failing of ["pr create", "workflow run"]) {
    test(`starts CI for the pushed release commit when a retry follows a failed ${failing}`, async () => {
      const { run, push, branchHead, dispatched, failNext, pullRequests } = await setup();
      await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
      await failNext(failing);
      await run({ fails: true });
      const pushed = await branchHead();
      expect(pushed).not.toBe("");
      expect(await dispatched()).toEqual([]);

      // The retry regenerates an identical release (a new local commit with
      // the same tree and parent), keeps the remote commit, and starts CI for it.
      const retry = await run();
      expect(retry).toContain("workflow run");
      expect(retry).toContain(failing === "pr create" ? "pr create" : "pr edit 7");
      expect(await branchHead()).toBe(pushed);
      expect(await dispatched()).toEqual([pushed]);
      expect(await pullRequests()).toEqual([{ number: 7, isCrossRepository: false }]);

      expect(await run()).toEqual(["pr list", "pr edit 7", "run list"]);
      expect(await dispatched()).toEqual([pushed]);
    });
  }

  /** A `git` that runs `script` first when called as `git <command>`, then the real git. */
  async function gitShim(origin: string, command: string, script: string) {
    const shim = await mkdtemp(join(origin, "..", `git-${command}-`));
    const realGit = `${await sh(origin, "git", "--exec-path")}/git`;
    await Bun.write(join(shim, "git"), `#!/usr/bin/env bash\nif [ "$1" = ${command} ]; then\n${script}\nfi\nexec "${realGit}" "$@"\n`);
    await chmod(join(shim, "git"), 0o755);
    return shim;
  }

  test("stops, leaving the release pull request open, when git status fails", async () => {
    const { origin, run, push, setPullRequests, pullRequests } = await setup();
    await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    await setPullRequests([{ number: 7, isCrossRepository: false }]);
    // A git whose status fails must not read as "nothing to release" and close the pull request.
    const shim = await gitShim(origin, "status", `echo "injected status failure" >&2; exit 128`);
    expect(await run({ fails: true, path: shim })).toEqual(["pr list"]);
    expect(await pullRequests()).toEqual([{ number: 7, isCrossRepository: false }]);
  });

  test("creates a missing release branch, refusing to overwrite one that appeared meanwhile", async () => {
    const { origin, run, push, branchHead } = await setup();
    await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    const main = await sh(origin, "git", "rev-parse", "main");
    // The branch is created by someone else after the workflow saw it missing.
    const race = await gitShim(origin, "push", `git -C "${origin}" update-ref refs/heads/changeset-release/main ${main}; echo "injected race" >&2`);
    expect(await run({ fails: true, path: race })).toEqual(["pr list"]);
    expect(await branchHead()).toBe(main);
  });

  for (const command of ["ls-remote", "fetch"]) {
    test(`stops without pushing when git ${command} can't read the release branch`, async () => {
      const { origin, run, push, branchHead, setPullRequests } = await setup();
      await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
      await run();
      await setPullRequests([{ number: 7, isCrossRepository: false }]);
      const released = await branchHead();
      // A new note would normally replace the branch; a read failure must not look like "no branch" and force-push.
      await push({ ".changeset/b.md": note({ "critiqs-react": "patch" }, "Fix.") });
      const failing = await gitShim(origin, command, `echo "fatal: injected ${command} failure" >&2; exit 128`);
      expect(await run({ fails: true, path: failing })).toEqual(["pr list"]);
      expect(await branchHead()).toBe(released);
    });
  }

  test("replaces the release branch only if it is still the commit it read", async () => {
    const { origin, run, push, branchHead, setPullRequests } = await setup();
    await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    await run();
    await setPullRequests([{ number: 7, isCrossRepository: false }]);
    await push({ ".changeset/b.md": note({ "critiqs-react": "patch" }, "Fix.") });
    const main = await sh(origin, "git", "rev-parse", "main");
    // Someone pushes to the branch after the workflow read it, before it pushes.
    const race = await gitShim(origin, "push", `git -C "${origin}" update-ref refs/heads/changeset-release/main ${main}; echo "injected race" >&2`);
    expect(await run({ fails: true, path: race })).toEqual(["pr list"]);
    expect(await branchHead()).toBe(main);

    // Without a race, the same release replaces the branch.
    expect(await run()).toEqual(["pr list", "pr edit 7", "run list", "workflow run"]);
    expect(await branchHead()).not.toBe(main);
  });

  test("ignores a fork's pull request from a branch with the same name", async () => {
    const { run, push, setPullRequests, pullRequests } = await setup();
    await setPullRequests([{ number: 42, isCrossRepository: true }]);
    await push({ ".changeset/a.md": note({ "critiqs-react": "minor" }, "Feature.") });
    expect(await run()).toEqual(["pr list", "pr create", "run list", "workflow run"]);
    expect(await run()).toEqual(["pr list", "pr edit 7", "run list"]);
    expect(await pullRequests()).toEqual([{ number: 42, isCrossRepository: true }, { number: 7, isCrossRepository: false }]);
  });

  test("does nothing after the release is merged, and does not loop", async () => {
    const { repo, run, push, branchHead, setPullRequests } = await setup();
    await push({ ".changeset/a.md": note({ "critiqs-react": "patch" }, "Fix.") });
    await run();
    // A person merges the release pull request.
    await sh(repo.dir, "git", "fetch", "-q", "origin");
    await sh(repo.dir, "git", "merge", "-q", "--ff-only", "origin/changeset-release/main");
    await sh(repo.dir, "git", "push", "-q", "origin", "main");
    await setPullRequests([]);
    const released = await branchHead();
    expect(await run()).toEqual(["pr list"]);
    expect(await run()).toEqual(["pr list"]);
    expect(await branchHead()).toBe(released);
    expect((await repo.manifest("packages/react/package.json")).version).toBe("0.1.1");
  });

  test("leaves no-release notes waiting and closes only its own release pull request when nothing is left", async () => {
    const { run, push, setPullRequests, pullRequests } = await setup();
    await push({ ".changeset/docs.md": "---\n---\n\nDocumentation only.\n" });
    expect(await run()).toEqual(["pr list"]);
    await setPullRequests([{ number: 42, isCrossRepository: true }, { number: 7, isCrossRepository: false }]);
    expect(await run()).toEqual(["pr list", "pr close 7"]);
    expect(await pullRequests()).toEqual([{ number: 42, isCrossRepository: true }]);
    expect(await run()).toEqual(["pr list"]);
  });

  test("grants write access only to the main-branch job", async () => {
    expect(workflow.permissions).toEqual({});
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" });
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(Object.keys(ci.on)).not.toContain("pull_request_target");
    for (const ciJob of Object.values<any>(ci.jobs)) expect(ciJob.permissions).toBeUndefined();
  });
});

describe("release order", () => {
  test("each package comes after the Critiqs packages it depends on", async () => {
    const files: Record<string, unknown> = {
      "package.json": { workspaces: ["packages/*"] },
      ".changeset/config.json": { fixed: [["critiqs", "critiqs-*"]] },
      "packages/nuxt/package.json": { name: "critiqs-nuxt", version: "1.0.0", dependencies: { critiqs: "1.0.0", "critiqs-vue": "1.0.0" } },
      "packages/vue/package.json": { name: "critiqs-vue", version: "1.0.0", dependencies: { critiqs: "1.0.0" } },
      "packages/angular/package.json": { name: "critiqs-angular", version: "1.0.0", dependencies: { critiqs: "1.0.0" } },
      "packages/critiqs/package.json": { name: "critiqs", version: "1.0.0" },
      // An optional dependency is still installed when present, so it is published first too.
      "packages/astro/package.json": { name: "critiqs-astro", version: "1.0.0", optionalDependencies: { "critiqs-solid": "1.0.0" } },
      "packages/solid/package.json": { name: "critiqs-solid", version: "1.0.0", peerDependencies: { critiqs: "1.0.0" } },
    };
    const tree = {
      read: async (path: string) => (path in files ? JSON.stringify(files[path]) : null),
      match: async () => Object.keys(files).filter((path) => path.startsWith("packages/")),
    };
    expect((await releasePackages(tree)).map((pkg) => pkg.name)).toEqual(["critiqs", "critiqs-angular", "critiqs-solid", "critiqs-astro", "critiqs-vue", "critiqs-nuxt"]);
  });
});
