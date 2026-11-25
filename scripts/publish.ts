// Checks that critiqs-react may be published from this checkout, before a
// maintainer (or the manual Publish workflow) runs `npm publish`. It publishes
// nothing itself. The procedure is in docs/releasing.md.
//
//   bun scripts/publish.ts verify --version <version>
import { parseChangesetFile } from "@changesets/parse";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNoteName, RELEASE_PACKAGE } from "./release.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  publishConfig?: { access?: string };
  files?: string[];
}

/**
 * Why this manifest and checkout may not be published as `version`; empty
 * when they may. `pendingReleases` counts release notes not yet versioned:
 * publishing then would ship unreleased changes under an older version.
 * `published` lists the versions already on the registry.
 */
export function publishProblems(manifest: Manifest, { version, pendingReleases, published }: { version: string; pendingReleases: number; published: string[] }): string[] {
  const problems: string[] = [];
  if (manifest.name !== RELEASE_PACKAGE) problems.push(`The package is ${manifest.name}, not ${RELEASE_PACKAGE}.`);
  if (manifest.version !== version) problems.push(`packages/react/package.json is version ${manifest.version}, not ${version}.`);
  if (manifest.private === true) problems.push("The package is private.");
  if (manifest.license !== "MIT") problems.push("The package must name its MIT license.");
  if (manifest.publishConfig?.access !== "public") problems.push('publishConfig.access must be "public".');
  if (!manifest.files?.includes("LICENSE")) problems.push("The package's files must include LICENSE.");
  if (pendingReleases > 0) {
    problems.push(`${pendingReleases} release note(s) wait to be versioned: merge the release pull request first, so the published code matches its changelog.`);
  }
  if (published.includes(version)) problems.push(`${RELEASE_PACKAGE}@${version} is already published; npm never replaces a version.`);
  return problems;
}

async function pendingReleases(): Promise<number> {
  let releases = 0;
  for (const name of (await readdir(join(root, ".changeset"))).filter(isNoteName)) {
    releases += parseChangesetFile(await Bun.file(join(root, ".changeset", name)).text()).releases.length;
  }
  return releases;
}

/** Versions on the public registry; none when the package was never published. */
async function publishedVersions(): Promise<string[]> {
  const child = Bun.spawn(["npm", "view", RELEASE_PACKAGE, "versions", "--json", "--registry", "https://registry.npmjs.org/"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) {
    if (/E404|404 Not Found/.test(stdout + stderr)) return [];
    throw new Error(`npm view failed (${status}):\n${stderr}`);
  }
  const versions = JSON.parse(stdout) as string | string[];
  return Array.isArray(versions) ? versions : [versions];
}

if (import.meta.main) {
  const [command, flag, version] = process.argv.slice(2);
  if (command !== "verify" || flag !== "--version" || !version) {
    console.error("Usage: bun scripts/publish.ts verify --version <version>");
    process.exit(2);
  }
  const manifest = (await Bun.file(join(root, "packages/react/package.json")).json()) as Manifest;
  const problems = publishProblems(manifest, { version, pendingReleases: await pendingReleases(), published: await publishedVersions() });
  if (problems.length > 0) {
    console.error(`${RELEASE_PACKAGE}@${version} can't be published from here:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${RELEASE_PACKAGE}@${version} can be published from this checkout.`);
}
