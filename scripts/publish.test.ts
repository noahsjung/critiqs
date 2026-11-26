// Runs the publish checks against scratch workspaces shaped like this one,
// with two npm packages, a gem, and a PyPI project. Builds and `npm publish
// --dry-run` run for real; registries are stand-ins, and nothing is uploaded.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactProblems, main, packageProblems, parseArtifact, type Effects } from "./publish.ts";
import type { Registry, ReleasePackage } from "./release.ts";

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

/** Stand-in registries holding `existing` ("registry name@version"), and a runner that records every command and refuses a real publish. */
function effects(existing: string[] = []) {
  const commands: string[] = [];
  const asked: string[] = [];
  const value: Effects = {
    async published(registry: Registry, name: string, version: string) {
      asked.push(`${registry} ${name}@${version}`);
      return existing.includes(`${registry} ${name}@${version}`);
    },
    async exec(command: string[], cwd: string) {
      commands.push(`${cwd.slice(cwd.indexOf("/packages/") + 1)}: ${command.join(" ")}`);
      if (command[0] === "npm" && !command.includes("--dry-run")) throw new Error("tests never publish");
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
    for (const args of [["verify"], ["verify", "--version", "0.4.0", "--registry", "maven"], ["publish", "--registry", "pypi", "--version", "0.4.0"], ["stage", "--registry", "npm", "--version", "0.4.0", "--out", "x"], ["stage", "--registry", "pypi", "--version", "0.4.0"], ["ship", "--version", "0.4.0"]]) {
      expect((await run(dir, args)).status).toBe(2);
    }
  });
});

describe("publish to npm", () => {
  test("dry-runs npm publish for each package, critiqs first", async () => {
    const dir = await workspace();
    const result = await run(dir, ["publish", "--registry", "npm", "--version", "0.4.0", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.commands).toEqual([
      "packages/critiqs: npm publish --access public --dry-run",
      "packages/react: npm publish --access public --dry-run",
    ]);
    expect(result.out).toContain("Checked (dry run) critiqs@0.4.0.\nChecked (dry run) critiqs-react@0.4.0.");
  });

  test("a rerun after a partial publish publishes only what is missing", async () => {
    const dir = await workspace();
    const result = await run(dir, ["publish", "--registry", "npm", "--version", "0.4.0", "--dry-run"], ["npm critiqs@0.4.0"]);
    expect(result.status).toBe(0);
    expect(result.commands).toEqual(["packages/react: npm publish --access public --dry-run"]);
  });

  test("refuses a dependency npm would publish unresolved, or one off the shared version", async () => {
    const dir = await workspace("0.4.0", { "packages/react/package.json": json(npmManifest("critiqs-react", "0.4.0", { dependencies: { critiqs: "workspace:*" } })) });
    const result = await run(dir, ["publish", "--registry", "npm", "--version", "0.4.0", "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.err).toContain('critiqs-react: dependencies.critiqs is "workspace:*", which npm would publish as written.');
    expect(result.commands).toEqual([]);
  });
});

describe("stage for RubyGems and PyPI", () => {
  for (const [registry, existing, expected] of [
    ["rubygems", "rubygems critiqs-rails@0.4.0", ["critiqs-rails-0.4.0.gem"]],
    ["pypi", "pypi django-critiqs@0.4.0", ["django_critiqs-0.4.0-py3-none-any.whl", "django_critiqs-0.4.0.tar.gz"]],
  ] as const) {
    test(`stages ${registry} files for upload, and nothing once ${registry} has the version`, async () => {
      const dir = await workspace();
      await Bun.write(join(dir, "out/leftover.gem"), "old");
      const first = await run(dir, ["stage", "--registry", registry, "--version", "0.4.0", "--out", "out"]);
      expect(first.status).toBe(0);
      expect((await readdir(join(dir, "out"))).sort()).toEqual([...expected]);
      expect(first.commands).toHaveLength(1);
      const rerun = await run(dir, ["stage", "--registry", registry, "--version", "0.4.0", "--out", "out"], [existing]);
      expect(rerun.status).toBe(0);
      expect(await readdir(join(dir, "out"))).toEqual([]);
      expect(rerun.out).toContain("already published, skipped");
    });
  }
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

const workflow = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/publish.yml")).text()) as any;

describe("Publish workflow", () => {
  const steps = (job: string) => workflow.jobs[job].steps as any[];
  const runs = (job: string) => steps(job).flatMap((step) => step.run ? [step.run as string] : []);

  test("only a maintainer starts it, on main, and nothing is checked with publishing rights", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.verify.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.verify.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.environment).toBeUndefined();
    expect(runs("verify")).toEqual(expect.arrayContaining(['bun scripts/publish.ts verify --version "$VERSION"', "bun run typecheck", "bun run test", "bun run check:consumers"]));
    // Gem and Python builds vendor the shared bundle, so it is built before verify runs them.
    expect(runs("verify").indexOf("bun run build")).toBeLessThan(runs("verify").indexOf('bun scripts/publish.ts verify --version "$VERSION"'));
  });

  test("each registry publishes in its own job, after approval in its own environment, with trusted publishing", () => {
    for (const [job, needs] of [["npm", ["verify"]], ["rubygems", ["npm"]], ["pypi", ["npm"]]] as const) {
      expect(workflow.jobs[job]).toMatchObject({ needs, environment: job, permissions: { contents: "read", "id-token": "write" } });
      for (const step of steps(job)) {
        expect(JSON.stringify(step)).not.toMatch(/secrets\./);
        if (step.uses?.startsWith("actions/checkout")) expect(step.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
      }
    }
    expect(runs("npm")).toContain('bun scripts/publish.ts publish --registry npm --version "$VERSION"');
    expect(runs("rubygems")).toContain('bun scripts/publish.ts stage --registry rubygems --version "$VERSION" --out rubygems-dist');
    expect(runs("pypi")).toContain('bun scripts/publish.ts stage --registry pypi --version "$VERSION" --out pypi-dist');
    const credentials = steps("rubygems").find((step) => step.uses?.startsWith("rubygems/configure-rubygems-credentials@"));
    const upload = steps("pypi").find((step) => step.uses?.startsWith("pypa/gh-action-pypi-publish@"));
    expect(credentials.if).toBe("hashFiles('rubygems-dist/*.gem') != ''");
    expect(upload.if).toBe("hashFiles('pypi-dist/*') != ''");
    expect(upload.with).toMatchObject({ "packages-dir": "pypi-dist/", "skip-existing": true });
  });
});
