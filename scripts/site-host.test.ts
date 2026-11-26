// site/vercel.json's ignoreCommand decides whether Vercel builds the site for a commit: exit 0 skips the build, anything else builds.
// Vercel refuses the whole file, and so every deployment, when the command is longer than 256 characters.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const { ignoreCommand } = (await Bun.file(join(ROOT, "site/vercel.json")).json()) as { ignoreCommand: string };

test("the site's ignoreCommand fits Vercel's limit of 256 characters", () => {
  expect(ignoreCommand.length).toBeLessThanOrEqual(256);
});

test("the site's ignoreCommand skips a build only when the last deployed commit is known and nothing the site is built from changed", () => {
  const repo = mkdtempSync(join(tmpdir(), "site-host-"));
  try {
    const git = (...args: string[]) => {
      const done = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
      if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
      return done.stdout.toString().trim();
    };
    const commit = (file: string, text: string) => {
      mkdirSync(join(repo, file, ".."), { recursive: true });
      writeFileSync(join(repo, file), text);
      git("add", "-A");
      git("commit", "-q", "-m", file);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q");
    const first = commit("site/index.html", "one");
    const docs = commit("docs/notes.md", "nothing the site is built from");
    const app = commit("apps/web/src/main.tsx", "the onboarding app");
    const page = commit("site/index.html", "two");
    // Vercel runs the command in the project's root directory, site/.
    const run = (previous: string | undefined, current: string) =>
      Bun.spawnSync(["bash", "-c", ignoreCommand], {
        cwd: join(repo, "site"),
        env: { PATH: process.env.PATH ?? "", VERCEL_GIT_COMMIT_SHA: current, ...(previous === undefined ? {} : { VERCEL_GIT_PREVIOUS_SHA: previous }) },
      }).exitCode;
    const builds = (previous: string | undefined, at: string) => {
      git("checkout", "-q", at);
      return run(previous, at) !== 0;
    };
    expect(builds(first, docs)).toBe(false);
    expect(builds(docs, app)).toBe(true);
    expect(builds(app, page)).toBe(true);
    expect(builds(first, page)).toBe(true);
    // No earlier deployment, the same commit deployed again, and an earlier commit this clone doesn't have: build.
    expect(builds(undefined, docs)).toBe(true);
    expect(builds(docs, docs)).toBe(true);
    expect(builds("0123456789012345678901234567890123456789", docs)).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
