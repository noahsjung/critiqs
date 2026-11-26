// The release files the package and consumer checks run against. The
// Publish workflow packs every package once (`bun scripts/publish.ts pack`)
// and sets CRITIQS_PACKED to that folder, so each check installs the exact
// files that are then published. Without CRITIQS_PACKED, each check packs or
// builds its own, as in CI and local runs.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmTarballName, parseArtifact } from "./publish.ts";
import type { Registry } from "./release.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * The packed file of `name` at `version` in CRITIQS_PACKED: the npm tarball,
 * the gem, or the wheel. Null when CRITIQS_PACKED is unset; throws when it is
 * set and holds no such file, so a check never falls back to building its own.
 */
export function packedFile(registry: Registry, name: string, version: string, env: Record<string, string | undefined> = process.env): string | null {
  const packed = env.CRITIQS_PACKED;
  if (packed === undefined || packed === "") return null;
  const dir = join(resolve(packed), registry);
  const files = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [];
  const matches = (file: string) => {
    if (registry === "npm") return file === npmTarballName(name, version);
    if (registry === "rubygems") return file === `${name}-${version}.gem`;
    const artifact = parseArtifact("pypi", file);
    return file.endsWith(".whl") && artifact?.name === name && artifact.version === version;
  };
  const found = files.filter(matches);
  if (found.length !== 1 || !statSync(join(dir, found[0]!)).isFile()) {
    throw new Error(`CRITIQS_PACKED: ${dir} holds no single ${registry} file for ${name} ${version} (found ${found.length}).`);
  }
  return join(dir, found[0]!);
}

/**
 * The tarball of the workspace package in `packageDir` (such as
 * `packages/react`) that a check installs: the packed one in CRITIQS_PACKED
 * when it is set, unchanged; otherwise `npm pack` packs it into `scratch`,
 * running the package's `prepack` build.
 */
export async function packageTarball(
  packageDir: string,
  scratch: string,
  run: (command: string[], cwd: string) => Promise<string>,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const dir = resolve(ROOT, packageDir);
  const { name, version } = await Bun.file(join(dir, "package.json")).json();
  const packed = packedFile("npm", name, version, env);
  if (packed !== null) return packed;
  const [result] = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", scratch], dir));
  return join(scratch, result.filename);
}

/** The files in a packed npm tarball, relative to its `package/` folder. */
export async function tarballFiles(tarball: string, run: (command: string[], cwd: string) => Promise<string>, cwd: string): Promise<string[]> {
  return (await run(["tar", "-tzf", tarball], cwd)).split("\n").filter((entry) => entry && !entry.endsWith("/")).map((entry) => {
    if (!entry.startsWith("package/")) throw new Error(`Unexpected entry ${entry} in ${tarball}`);
    return entry.slice("package/".length);
  });
}
