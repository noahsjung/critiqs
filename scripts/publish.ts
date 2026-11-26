// Verifies and packs every Critiqs package at the version recorded on main,
// for the Publish workflow to check and then publish unchanged. npm packages
// are packed with `npm pack`; RubyGems and PyPI packages are built with their
// `release:build` script. `pack` writes every file once into one folder, with
// a SHA256SUMS file listing each file's sha256 and `npm/order` listing the
// npm tarballs in publish order (each after the Critiqs packages it depends
// on, `critiqs` first). The workflow's publishing jobs check those sha256s
// and skip a version a registry already has, so a partly failed publish can
// be rerun. The procedure is in docs/releasing.md.
//
//   bun scripts/publish.ts verify --version <version> [--registry npm|rubygems|pypi]
//   bun scripts/publish.ts pack --version <version> --out <dir>
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pendingReleases, releasePackages, workingTree, type Registry, type ReleasePackage } from "./release.ts";

export const REGISTRIES: Registry[] = ["npm", "rubygems", "pypi"];
const REGISTRY_NAMES: Record<Registry, string> = { npm: "npm", rubygems: "RubyGems", pypi: "PyPI" };

/** A file `release:build` wrote to `<package>/release/`, with the name and version it uploads as. */
export interface Artifact {
  path: string;
  name: string;
  version: string;
}

/** One package's place in a publish: what it uploads as, and whether its registry already has it. */
export interface Planned {
  pkg: ReleasePackage;
  registry: Registry;
  /** The name on the registry: the npm name, the gem name, or the normalized PyPI project name. */
  registryName: string;
  artifacts: Artifact[];
  published: boolean;
}

/** What publishing needs from outside this checkout; tests pass stand-ins. */
export interface Effects {
  published(registry: Registry, name: string, version: string): Promise<boolean>;
  exec(command: string[], cwd: string): Promise<void>;
}

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

/** Why this package's manifest may not be published as `version`; empty when it may. */
export function packageProblems(pkg: ReleasePackage, version: string, released: string[]): string[] {
  const problems: string[] = [];
  const { manifest } = pkg;
  if (pkg.version !== version) problems.push(`${pkg.dir}/package.json is version ${pkg.version}, not ${version}.`);
  if (pkg.registry === null) {
    problems.push(`${pkg.name} is in the release group but names no registry: make it public to publish it to npm, or keep it private with "critiqsRelease": { "registry": "rubygems" | "pypi" } and a release:build script.`);
  }
  if (pkg.registry !== "npm") return problems;
  if (manifest.license !== "MIT") problems.push(`${pkg.name} must name its MIT license.`);
  if (manifest.publishConfig?.access !== "public") problems.push(`${pkg.name}: publishConfig.access must be "public".`);
  if (!manifest.files?.includes("LICENSE")) problems.push(`${pkg.name}: files must include LICENSE.`);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) problems.push(`${pkg.name}: ${field}.${name} is "${range}", which npm would publish as written.`);
      else if (released.includes(name) && range !== version) problems.push(`${pkg.name}: ${field}.${name} is "${range}", not the shared version ${version}.`);
    }
  }
  return problems;
}

const normalizePyPIName = (name: string) => name.replace(/[-_.]+/g, "-").toLowerCase();

/** The registry name and version a built file uploads as, read from its file name; null for a file that registry doesn't take. */
export function parseArtifact(registry: "rubygems" | "pypi", file: string): { name: string; version: string } | null {
  const match = registry === "rubygems"
    ? /^(.+)-(\d[^-]*)\.gem$/.exec(file)
    : /^([^-]+)-(\d[^-]*)(?:-[^-]+){3,4}\.whl$/.exec(file) ?? /^(.+)-(\d[^-]*)\.tar\.gz$/.exec(file);
  if (!match) return null;
  const [, name = "", version = ""] = match;
  return { name: registry === "pypi" ? normalizePyPIName(name) : name, version };
}

/** Why the files `release:build` wrote may not be uploaded as `version`; empty when they may. */
export function artifactProblems(pkg: ReleasePackage, files: string[], version: string): string[] {
  const registry = pkg.registry as "rubygems" | "pypi";
  const where = `${pkg.dir}/release/`;
  if (files.length === 0) return [`${pkg.name}: release:build wrote nothing to ${where}.`];
  const problems: string[] = [];
  const parsed = files.map((file) => ({ file, artifact: parseArtifact(registry, file) }));
  for (const { file, artifact } of parsed) {
    if (!artifact) problems.push(`${pkg.name}: ${where}${file} is not a ${registry === "rubygems" ? "gem (.gem)" : "wheel (.whl) or source distribution (.tar.gz)"}.`);
    else if (artifact.version !== version) problems.push(`${pkg.name}: ${where}${file} is version ${artifact.version}, not ${version}; release:build must take the version from package.json.`);
  }
  if (registry === "rubygems" && files.length > 1) problems.push(`${pkg.name}: release:build must write exactly one gem to ${where}, not ${files.length} files.`);
  const names = new Set(parsed.flatMap(({ artifact }) => artifact ? [artifact.name] : []));
  if (names.size > 1) problems.push(`${pkg.name}: ${where} holds more than one ${REGISTRY_NAMES[registry]} project (${[...names].join(", ")}).`);
  return problems;
}

/**
 * Checks every released package for the selected registries, builds the
 * RubyGems and PyPI ones, and asks each registry whether it already has the
 * version. Problems mean nothing may be published.
 */
export async function plan(cwd: string, version: string, registries: Registry[], effects: Effects): Promise<{ problems: string[]; planned: Planned[] }> {
  const problems: string[] = [];
  const pending = await pendingReleases(cwd);
  if (pending > 0) {
    problems.push(`${pending} release note(s) wait to be versioned: merge the release pull request first, so the published code matches its changelog.`);
  }
  const packages = await releasePackages(workingTree(cwd));
  if (packages.length === 0) problems.push("No released packages found: no workspace package matches the Changesets fixed group.");
  const released = packages.map((pkg) => pkg.name);
  const planned: Planned[] = [];
  for (const pkg of packages) {
    const own = packageProblems(pkg, version, released);
    problems.push(...own);
    if (pkg.registry === null || !registries.includes(pkg.registry) || own.length > 0) continue;
    let artifacts: Artifact[] = [];
    if (pkg.registry !== "npm") {
      const out = join(cwd, pkg.dir, "release");
      await rm(out, { recursive: true, force: true });
      await effects.exec(["bun", "run", "release:build"], join(cwd, pkg.dir));
      const files = (await readdir(out).catch(() => [] as string[])).sort();
      const built = artifactProblems(pkg, files, version);
      problems.push(...built);
      if (built.length > 0) continue;
      artifacts = files.map((file) => ({ path: join(out, file), ...parseArtifact(pkg.registry as "rubygems" | "pypi", file)! }));
    }
    const registryName = artifacts[0]?.name ?? pkg.name;
    planned.push({ pkg, registry: pkg.registry, registryName, artifacts, published: await effects.published(pkg.registry, registryName, version) });
  }
  return { problems, planned };
}

const describe = ({ registry, registryName, published }: Planned, version: string) =>
  `${registryName}@${version} (${REGISTRY_NAMES[registry]}): ${published ? `already published, skipped` : "to publish"}`;

/** The file name `npm pack` gives a package's tarball. */
export const npmTarballName = (name: string, version: string) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** `<sha256>  <path>` lines, as `sha256sum --check` reads them, for every file under `dir`, sorted by path. */
export async function checksums(dir: string): Promise<string> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
  const lines = await Promise.all(files.map(async (file) => `${new Bun.CryptoHasher("sha256").update(await Bun.file(join(dir, file)).arrayBuffer()).digest("hex")}  ${file}\n`));
  return lines.join("");
}

/**
 * Packs every planned package into `dir`: npm tarballs in `npm/`, in publish
 * order in `npm/order`; the gem in `rubygems/`; wheels and source
 * distributions in `pypi/`; and SHA256SUMS last. Packages a registry already
 * has are packed too, since the others are checked against them.
 */
async function pack(cwd: string, dir: string, version: string, planned: Planned[], effects: Effects, log: (line: string) => void): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  for (const registry of REGISTRIES) await mkdir(join(dir, registry), { recursive: true });
  const order: string[] = [];
  const problems: string[] = [];
  for (const { pkg, artifacts } of planned) {
    if (pkg.registry === "npm") {
      const file = npmTarballName(pkg.name, version);
      await effects.exec(["npm", "pack", "--pack-destination", join(dir, "npm")], join(cwd, pkg.dir));
      if (!existsSync(join(dir, "npm", file))) problems.push(`${pkg.name}: npm pack didn't write npm/${file}.`);
      order.push(file);
      log(`Packed npm/${file}.`);
    } else {
      for (const artifact of artifacts) {
        await copyFile(artifact.path, join(dir, pkg.registry!, basename(artifact.path)));
        log(`Packed ${pkg.registry}/${basename(artifact.path)}.`);
      }
    }
  }
  const packed = (await readdir(join(dir, "npm"))).sort();
  if (packed.join("\n") !== [...order].sort().join("\n")) problems.push(`npm/ holds ${packed.join(", ")}, not the packed ${order.join(", ")}.`);
  if (problems.length > 0) return problems;
  await Bun.write(join(dir, "npm/order"), order.map((file) => `${file}\n`).join(""));
  await Bun.write(join(dir, "SHA256SUMS"), await checksums(dir));
  return [];
}

/** Runs one command; returns its exit status. */
export async function main(args: string[], cwd: string, effects: Effects, log = console.log, error = console.error): Promise<number> {
  const [command, ...rest] = args;
  const option = (name: string) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const version = option("version");
  const registry = option("registry") as Registry | undefined;
  const out = option("out");
  const usage = () => {
    error([
      "Usage: bun scripts/publish.ts verify --version <version> [--registry npm|rubygems|pypi]",
      "       bun scripts/publish.ts pack --version <version> --out <dir>",
    ].join("\n"));
    return 2;
  };
  if (!version || (registry !== undefined && !REGISTRIES.includes(registry))) return usage();
  if (command === "pack" && (!out || registry !== undefined)) return usage();
  if (command === undefined || !["verify", "pack"].includes(command)) return usage();

  const { problems, planned } = await plan(cwd, version, registry ? [registry] : REGISTRIES, effects);
  const refuse = (problems: string[]) => {
    error(`Critiqs ${version} can't be published from here:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  };
  if (problems.length > 0) return refuse(problems);
  for (const entry of planned) log(describe(entry, version));
  const todo = planned.filter((entry) => !entry.published);

  if (command === "verify") {
    log(todo.length === 0 ? `Every package is already published at ${version}; nothing to do.` : `Critiqs ${version} can be published from this checkout.`);
    return 0;
  }
  const packProblems = await pack(cwd, resolve(cwd, out!), version, planned, effects, log);
  if (packProblems.length > 0) return refuse(packProblems);
  log(`Packed ${planned.length} packages into ${out}, with SHA256SUMS.`);
  return 0;
}

async function capture(command: string[], cwd?: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, status };
}

/** Whether a public registry has this version; a project that was never published has none. */
async function published(registry: Registry, name: string, version: string): Promise<boolean> {
  if (registry === "npm") {
    const { stdout, stderr, status } = await capture(["npm", "view", name, "versions", "--json", "--registry", "https://registry.npmjs.org/"]);
    if (status !== 0) {
      if (/E404|404 Not Found/.test(stdout + stderr)) return false;
      throw new Error(`npm view ${name} failed (${status}):\n${stderr}`);
    }
    if (stdout.trim() === "") return false;
    const versions = JSON.parse(stdout) as string | string[];
    return (Array.isArray(versions) ? versions : [versions]).includes(version);
  }
  const url = registry === "rubygems"
    ? `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`
    : `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const response = await fetch(url, { redirect: "follow" });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`${REGISTRY_NAMES[registry]} answered ${response.status} for ${url}.`);
  return true;
}

async function exec(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}) in ${cwd}.`);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.cwd(), { published, exec }));
}
