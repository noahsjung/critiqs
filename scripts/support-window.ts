// Which published Critiqs package versions are still supported, under the
// support window in docs/technical-direction.md ("Support window"), read from
// the registries each time. `bun scripts/check-older-packages.ts` tests every
// version this returns against the current backends.
//
//   bun scripts/support-window.ts        prints the supported versions as JSON
import { join } from "node:path";
import { releasePackages, workingTree, type Registry, type ReleasePackage } from "./release.ts";

/**
 * Months an older release line stays supported after the line that replaces
 * it is first published. Proposed in the docs; change it there and here
 * together.
 */
export const SUPPORT_MONTHS = 12;

/** One published version as a registry reports it. */
export interface Published {
  version: string;
  /** When the registry received it. */
  time: Date;
  /** npm's deprecation message, RubyGems' or PyPI's yank; such a version is withdrawn. */
  withdrawn: boolean;
}

/** A supported version, with why it is supported (for the check's log). */
export interface Supported {
  version: string;
  line: string;
  /** null while the line is the newest one. */
  until: Date | null;
}

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** The release line: MAJOR.MINOR. Before 1.0.0 a minor release may break, so 0.x lines are separate too. */
const lineOf = (version: string) => version.split(".").slice(0, 2).join(".");

function compare(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => STABLE.exec(v)!.slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * The supported versions of one package: the newest stable release of each
 * supported line. The newest line is supported; an older line until
 * SUPPORT_MONTHS after the next line's first stable release. Prereleases
 * (anything with a `-`, such as a name reservation) and withdrawn versions are
 * never supported.
 */
export function supportedVersions(published: Published[], now: Date, months = SUPPORT_MONTHS): Supported[] {
  const stable = published.filter((p) => STABLE.test(p.version) && !p.withdrawn).sort((a, b) => compare(a.version, b.version));
  const lines = [...new Set(stable.map((p) => lineOf(p.version)))];
  const supported: Supported[] = [];
  lines.forEach((line, index) => {
    const releases = stable.filter((p) => lineOf(p.version) === line);
    const next = lines[index + 1];
    // The next line's first release by time, not by number: a backport can be published later.
    const replaced = next === undefined ? null : new Date(Math.min(...stable.filter((p) => lineOf(p.version) === next).map((p) => p.time.getTime())));
    const until = replaced === null ? null : addMonths(replaced, months);
    if (until === null || now < until) supported.push({ version: releases.at(-1)!.version, line, until });
  });
  return supported;
}

/** The name a package is published under on its registry: the npm name, the gemspec's, or pyproject's. */
export async function registryName(root: string, pkg: ReleasePackage): Promise<string> {
  if (pkg.registry === "npm") return pkg.name;
  if (pkg.registry === "rubygems") {
    for await (const file of new Bun.Glob("*.gemspec").scan({ cwd: join(root, pkg.dir) })) {
      const name = /\.name\s*=\s*["']([^"']+)["']/.exec(await Bun.file(join(root, pkg.dir, file)).text())?.[1];
      if (name) return name;
    }
  }
  if (pkg.registry === "pypi") {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(await Bun.file(join(root, pkg.dir, "pyproject.toml")).text().catch(() => ""))?.[1];
    if (name) return name;
  }
  throw new Error(`${pkg.name}: can't tell its name on ${pkg.registry ?? "any registry"}.`);
}

/** Every version a registry has of a package; none when it was never published. */
export async function publishedVersions(registry: Registry, name: string, fetcher: typeof fetch = fetch): Promise<Published[]> {
  const url = {
    npm: `https://registry.npmjs.org/${name.replace("/", "%2f")}`,
    rubygems: `https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`,
    pypi: `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
  }[registry];
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${registry} answered ${response.status} for ${url}.`);
  const body = await response.json() as Record<string, any>;
  if (registry === "npm") {
    return Object.entries(body.versions ?? {}).map(([version, manifest]) => ({
      version, time: new Date(body.time[version]), withdrawn: typeof (manifest as { deprecated?: unknown }).deprecated === "string",
    }));
  }
  if (registry === "rubygems") {
    return (body as unknown as { number: string; created_at: string; platform: string; yanked?: boolean }[])
      .filter((gem) => gem.platform === "ruby")
      .map((gem) => ({ version: gem.number, time: new Date(gem.created_at), withdrawn: gem.yanked === true }));
  }
  return Object.entries(body.releases ?? {}).flatMap(([version, files]) => {
    const list = files as { upload_time_iso_8601: string; yanked: boolean }[];
    if (list.length === 0) return [];
    return [{ version, time: new Date(Math.min(...list.map((f) => Date.parse(f.upload_time_iso_8601)))), withdrawn: list.every((f) => f.yanked) }];
  });
}

/** A released package's supported published versions, for every package in the release group. */
export interface PackageSupport {
  pkg: ReleasePackage;
  registryName: string;
  /** The newest stable version its CHANGELOG.md records, which the release workflow writes when it releases one; null before its first release. */
  released: string | null;
  published: Published[];
  supported: Supported[];
}

/** The newest stable version a package's CHANGELOG.md records, or null when it records none. */
export async function releasedVersion(root: string, pkg: ReleasePackage): Promise<string | null> {
  const changelog = await Bun.file(join(root, pkg.dir, "CHANGELOG.md")).text().catch(() => "");
  return /^## (\d+\.\d+\.\d+)\s*$/m.exec(changelog)?.[1] ?? null;
}

export async function supportedPackages(root: string, now = new Date(), fetcher: typeof fetch = fetch): Promise<PackageSupport[]> {
  const result: PackageSupport[] = [];
  for (const pkg of await releasePackages(workingTree(root))) {
    if (pkg.registry === null) continue;
    const name = await registryName(root, pkg);
    const published = await publishedVersions(pkg.registry, name, fetcher);
    result.push({ pkg, registryName: name, released: await releasedVersion(root, pkg), published, supported: supportedVersions(published, now) });
  }
  return result;
}

/**
 * What the registries' answers mean for the check, told apart by what this
 * repository records as released. `problems`: a package whose changelog
 * records a release the registry doesn't list (a 404, or only prereleases),
 * so the answer is wrong or incomplete and the check can't trust it.
 * `nothingToTest`: why no version is supported when that is the support
 * policy's own answer: nothing in the release group was released yet, or
 * every released version was withdrawn on its registry (deprecated or
 * yanked, a deliberate act the log lists). Null when something is supported.
 */
export function supportCheck(packages: PackageSupport[]): { problems: string[]; nothingToTest: string | null } {
  const problems: string[] = [];
  for (const { pkg, registryName: name, released, published } of packages) {
    if (released === null || published.some((p) => p.version === released)) continue;
    const listed = published.length === 0 ? "nothing (it answered as if the package was never published)" : published.map((p) => p.version).join(", ");
    problems.push(`${pkg.name}: its CHANGELOG.md records ${released} as released, but ${pkg.registry} lists ${listed} for ${name}.`);
  }
  if (problems.length > 0 || packages.some((p) => p.supported.length > 0)) return { problems, nothingToTest: null };
  const released = packages.filter((p) => p.released !== null);
  if (released.length === 0) return { problems, nothingToTest: "nothing in the release group has been released yet (no CHANGELOG.md records a stable version)." };
  const withdrawn = released.flatMap((p) => p.published.filter((v) => v.withdrawn && /^\d+\.\d+\.\d+$/.test(v.version)).map((v) => `${p.registryName}@${v.version}`));
  return { problems, nothingToTest: `every released version is withdrawn on its registry: ${withdrawn.join(", ")}.` };
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url).pathname;
  const packages = await supportedPackages(root);
  console.log(JSON.stringify(packages.map(({ pkg, registryName, published, supported }) => ({
    package: pkg.name, registry: pkg.registry, registryName,
    published: published.map((p) => p.version), supported,
  })), null, 2));
}
