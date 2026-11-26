// The support window's rule and the registry answers it reads, without the network.
import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PackageSupport, publishedVersions, supportCheck, supportedPackages, supportedVersions, type Published } from "./support-window.ts";

const at = (date: string) => new Date(`${date}T00:00:00Z`);
const release = (version: string, date: string, withdrawn = false): Published => ({ version, time: at(date), withdrawn });

describe("supportedVersions", () => {
  test("the newest line is supported, by its newest patch", () => {
    expect(supportedVersions([release("0.3.0", "2026-10-30"), release("0.3.1", "2026-11-10")], at("2030-01-01")))
      .toEqual([{ version: "0.3.1", line: "0.3", until: null }]);
  });

  test("an older line stays supported for 12 months after the next line's first release", () => {
    const published = [release("0.3.0", "2026-10-30"), release("0.3.2", "2026-12-01"), release("0.4.0", "2027-02-15"), release("0.4.1", "2027-03-01")];
    expect(supportedVersions(published, at("2028-02-14"))).toEqual([
      { version: "0.3.2", line: "0.3", until: at("2028-02-15") },
      { version: "0.4.1", line: "0.4", until: null },
    ]);
    expect(supportedVersions(published, at("2028-02-15")).map((s) => s.version)).toEqual(["0.4.1"]);
  });

  test("lines are ordered by number, and a later backport doesn't restart the window", () => {
    const published = [release("1.0.0", "2027-01-01"), release("2.0.0", "2027-06-01"), release("1.0.1", "2027-09-01"), release("1.1.0", "2027-03-01")];
    // 1.0 is replaced by 1.1 (March 2027), 1.1 by 2.0 (June 2027).
    expect(supportedVersions(published, at("2028-04-01"))).toEqual([
      { version: "1.1.0", line: "1.1", until: at("2028-06-01") },
      { version: "2.0.0", line: "2.0", until: null },
    ]);
  });

  test("prereleases, name reservations, and withdrawn versions are never supported", () => {
    const published = [release("0.0.0-stage", "2026-10-30"), release("0.0.1-reserved.0", "2026-11-25"), release("0.5.0", "2027-01-01", true)];
    expect(supportedVersions(published, at("2027-02-01"))).toEqual([]);
    // A withdrawn newest release leaves the line's previous release as the supported one.
    expect(supportedVersions([release("0.5.0", "2027-01-01"), release("0.5.1", "2027-01-02", true)], at("2027-02-01")).map((s) => s.version)).toEqual(["0.5.0"]);
  });

  test("the window's length is a parameter", () => {
    const published = [release("0.3.0", "2026-10-30"), release("0.4.0", "2027-01-01")];
    expect(supportedVersions(published, at("2027-06-01"), 6).map((s) => s.version)).toEqual(["0.3.0", "0.4.0"]);
    expect(supportedVersions(published, at("2027-07-01"), 6).map((s) => s.version)).toEqual(["0.4.0"]);
  });
});

/** A fetch that answers from a table of URLs, and 404 for anything else. */
const registry = (answers: Record<string, unknown>) => (async (url: string | URL | Request) => {
  const body = answers[String(url)];
  return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
}) as typeof fetch;

describe("publishedVersions", () => {
  test("npm: versions with their publish time; a deprecated one is withdrawn", async () => {
    const fetcher = registry({
      "https://registry.npmjs.org/critiqs-react": {
        versions: { "0.0.0-stage": {}, "0.3.0": {}, "0.3.1": { deprecated: "Broken capture, use 0.3.2" } },
        time: { created: "2026-10-30T04:28:21Z", "0.0.0-stage": "2026-10-30T04:28:21Z", "0.3.0": "2026-10-30T04:32:31Z", "0.3.1": "2026-11-02T00:00:00Z" },
      },
    });
    expect(await publishedVersions("npm", "critiqs-react", fetcher)).toEqual([
      { version: "0.0.0-stage", time: new Date("2026-10-30T04:28:21Z"), withdrawn: false },
      { version: "0.3.0", time: new Date("2026-10-30T04:32:31Z"), withdrawn: false },
      { version: "0.3.1", time: new Date("2026-11-02T00:00:00Z"), withdrawn: true },
    ]);
  });

  test("RubyGems: only the plain ruby platform; a yanked one is withdrawn", async () => {
    const fetcher = registry({
      "https://rubygems.org/api/v1/versions/critiqs-rails.json": [
        { number: "0.4.0", created_at: "2027-01-01T00:00:00Z", platform: "ruby" },
        { number: "0.4.0", created_at: "2027-01-01T00:00:00Z", platform: "java" },
        { number: "0.3.0", created_at: "2026-12-01T00:00:00Z", platform: "ruby", yanked: true },
      ],
    });
    expect((await publishedVersions("rubygems", "critiqs-rails", fetcher)).map((p) => [p.version, p.withdrawn])).toEqual([["0.4.0", false], ["0.3.0", true]]);
  });

  test("PyPI: the first upload's time; a release whose files are all yanked is withdrawn; an empty release is skipped", async () => {
    const fetcher = registry({
      "https://pypi.org/pypi/django-critiqs/json": {
        releases: {
          "0.4.0": [{ upload_time_iso_8601: "2027-01-02T00:00:00Z", yanked: false }, { upload_time_iso_8601: "2027-01-01T00:00:00Z", yanked: false }],
          "0.4.1": [{ upload_time_iso_8601: "2027-02-01T00:00:00Z", yanked: true }],
          "0.4.2": [],
        },
      },
    });
    expect(await publishedVersions("pypi", "django-critiqs", fetcher)).toEqual([
      { version: "0.4.0", time: new Date("2027-01-01T00:00:00Z"), withdrawn: false },
      { version: "0.4.1", time: new Date("2027-02-01T00:00:00Z"), withdrawn: true },
    ]);
  });

  test("a package never published has no versions; another error stops the check", async () => {
    expect(await publishedVersions("npm", "critiqs-nothing", registry({}))).toEqual([]);
    const down = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    await expect(publishedVersions("npm", "critiqs-react", down)).rejects.toThrow("npm answered 503");
  });
});

test("every released package is looked up under its registry name", async () => {
  const asked: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const packages = await supportedPackages(new URL("../", import.meta.url).pathname, new Date(), fetcher);
  expect(packages.map((p) => p.registryName)).toContain("django-critiqs");
  expect(asked).toContain("https://registry.npmjs.org/critiqs-react");
  expect(asked).toContain("https://rubygems.org/api/v1/versions/critiqs-rails.json");
  expect(asked).toContain("https://pypi.org/pypi/flask-critiqs/json");
  expect(packages.every((p) => p.supported.length === 0)).toBe(true);
  // critiqs-react's changelog records 0.3.0, so a registry that answers 404 for it can't be right: the check refuses to pass.
  expect(packages.find((p) => p.pkg.name === "critiqs-react")?.released).toBe("0.3.0");
  expect(supportCheck(packages).problems).toEqual([
    "critiqs-react: its CHANGELOG.md records 0.3.0 as released, but npm lists nothing (it answered as if the package was never published) for critiqs-react.",
  ]);
});

describe("supportCheck", () => {
  const pkg = (name: string, released: string | null, published: Published[], now = at("2027-01-01")): PackageSupport => ({
    pkg: { name, dir: `packages/${name}`, version: "0.3.0", registry: "npm", manifest: {} },
    registryName: name,
    released,
    published,
    supported: supportedVersions(published, now),
  });

  test("a released version the registry doesn't list fails the check, whether it lists nothing or only prereleases", () => {
    expect(supportCheck([pkg("critiqs-react", "0.3.0", [release("0.0.0-stage", "2026-10-30")]), pkg("critiqs", null, [])])).toEqual({
      problems: ["critiqs-react: its CHANGELOG.md records 0.3.0 as released, but npm lists 0.0.0-stage for critiqs-react."],
      nothingToTest: null,
    });
  });

  test("nothing to test only when the policy says so: nothing released yet, or every released version withdrawn", () => {
    expect(supportCheck([pkg("critiqs", null, [release("0.0.1-reserved.0", "2026-11-25")])])).toEqual({
      problems: [],
      nothingToTest: "nothing in the release group has been released yet (no CHANGELOG.md records a stable version).",
    });
    expect(supportCheck([pkg("critiqs-react", "0.3.0", [release("0.3.0", "2026-10-30", true)])])).toEqual({
      problems: [],
      nothingToTest: "every released version is withdrawn on its registry: critiqs-react@0.3.0.",
    });
  });

  test("a supported version means there is something to test", () => {
    expect(supportCheck([pkg("critiqs-react", "0.3.0", [release("0.3.0", "2026-10-30")])])).toEqual({ problems: [], nothingToTest: null });
  });
});

describe("the release group", () => {
  const repo = new URL("../", import.meta.url).pathname;
  /** This repository's package manifests and changelogs, with the release group in `.changeset/config.json` replaced. */
  async function treeWithGroup(group: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "release-group-"));
    await cp(join(repo, "package.json"), join(root, "package.json"));
    for (const dir of await readdir(join(repo, "packages"))) {
      for (const file of await readdir(join(repo, "packages", dir)).catch(() => [] as string[])) {
        if (/^(package\.json|CHANGELOG\.md|pyproject\.toml|.*\.gemspec)$/.test(file)) await cp(join(repo, "packages", dir, file), join(root, "packages", dir, file));
      }
    }
    await Bun.write(join(root, ".changeset/config.json"), JSON.stringify({ fixed: [group] }));
    return root;
  }
  // Every registry answers that it knows nothing: the group, not the registries, must fail the check.
  const unknown = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;

  test("a name in the group that matches no package fails the check and names it, instead of testing nothing", async () => {
    for (const [group, named] of [
      [["critiqs", "critiqs-*x"], '"critiqs-*x"'],
      [["critiqs", "critiqs-*", "critiqs-reakt"], '"critiqs-reakt"'],
    ] as const) {
      const root = await treeWithGroup([...group]);
      try {
        const outcome = await supportedPackages(root, new Date(), unknown).then(() => "passed", (error: Error) => error.message);
        expect(outcome).toContain(named);
      } finally {
        await rm(root, { recursive: true });
      }
    }
  });

  test("a published package left out of the group fails the check and names it", async () => {
    const root = await treeWithGroup(["critiqs", "critiqs-vue", "critiqs-nuxt"]);
    try {
      const outcome = await supportedPackages(root, new Date(), unknown).then(() => "passed", (error: Error) => error.message);
      expect(outcome).toContain("critiqs-react");
      expect(outcome).not.toContain("critiqs-vue,");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("this repository's group names every published package and nothing else", async () => {
    const root = await treeWithGroup(["critiqs", "critiqs-*"]);
    try {
      expect((await supportedPackages(root, new Date(), unknown)).length).toBeGreaterThan(5);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
