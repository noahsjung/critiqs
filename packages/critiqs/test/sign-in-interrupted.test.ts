import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { accessTokenFor } from "../bin/agent.mjs";

// Moving sign-ins out of the version 1 file (`sign-in.json`) writes two files.
// A move cut off between them, by a crash or a failed write, must not leave
// the version 1 file's sign-ins usable by older versions: the next run
// finishes it. These run the cut-off step in a real process under Node, which
// can stand in for `node:fs` inside bin/agent.mjs.

const AGENT = resolve(import.meta.dir, "../bin/agent.mjs");
const run = promisify(execFile);
const CLOUD = "https://brazen-snail-591.convex.cloud";
const CLOUD_SIGN_IN = "https://brazen-snail-591.convex.site";
const TEAM = "https://team.convex.cloud";
const TEAM_SITE = "https://team.convex.site";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "critiqs-sign-in-interrupted-"));
  folders.push(made);
  const config = join(made, "config");
  mkdirSync(config);
  return config;
};

const entry = (refreshToken: string, more: Record<string, unknown> = {}) => ({
  origin: "https://x.example",
  refreshToken,
  accessToken: `access-${refreshToken}`,
  accessExpiresAt: Date.now() + 600_000,
  reviewer: { name: "Dana", email: "dana@example.com" },
  signedInAt: 1_000,
  ...more,
});
const write = (config: string, name: string, contents: unknown) => writeFileSync(join(config, name), JSON.stringify(contents));
const read = (config: string, name: string) => JSON.parse(readFileSync(join(config, name), "utf8"));
/** What an older version finds: its sign-ins, by sign-in service. */
const olderFinds = (config: string) => Object.keys(read(config, "sign-in.json").services);

/**
 * Asks for a Critiqs Cloud token in a Node process whose first write to the
 * version 1 file `crashes` (the process exits) or `fails` (throws), and
 * reports the outcome of each of `attempts` tries.
 */
async function interrupted(config: string, how: "crashes" | "fails", attempts = 1) {
  const script = join(config, "..", "interrupted.mjs");
  writeFileSync(
    script,
    `
import { createRequire, syncBuiltinESMExports } from "node:module";
const fs = createRequire(import.meta.url)("node:fs");
const [agentPath, config, how, attempts] = process.argv.slice(2);
const legacy = config + "/sign-in.json";
const realRename = fs.renameSync;
let cut = false;
fs.renameSync = function (from, to, ...more) {
  if (!cut && String(to) === legacy) {
    cut = true;
    if (how === "crashes") process.exit(3);
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  }
  return realRename.call(this, from, to, ...more);
};
syncBuiltinESMExports();
const { accessTokenFor } = await import(agentPath);
const outcomes = [];
for (let attempt = 0; attempt < Number(attempts); attempt++) {
  try {
    outcomes.push(await accessTokenFor("${CLOUD_SIGN_IN}", { backendUrl: "${CLOUD}", env: { CRITIQS_CONFIG_DIR: config }, fetchFn: async () => { throw new Error("no requests"); } }));
  } catch (error) {
    outcomes.push("error: " + error.message);
  }
}
console.log(JSON.stringify(outcomes));
`,
  );
  try {
    const { stdout } = await run("node", [script, AGENT, config, how, String(attempts)], { encoding: "utf8", timeout: 30_000 });
    return { exit: 0, outcomes: JSON.parse(stdout) as string[] };
  } catch (error) {
    return { exit: (error as { code?: number }).code ?? -1, outcomes: [] };
  }
}

/** The locks a crashed process left, as they are once they count as abandoned. */
function ageLeftLocks(config: string) {
  const longAgo = new Date(Date.now() - 60_000);
  const locks = readdirSync(config).filter((name) => name.endsWith(".lock"));
  for (const name of locks) {
    const lock = join(config, name);
    if (statSync(lock).isDirectory()) for (const inside of readdirSync(lock)) utimesSync(join(lock, inside), longAgo, longAgo);
    utimesSync(lock, longAgo, longAgo);
  }
  return locks.sort();
}

const env = (config: string) => ({ CRITIQS_CONFIG_DIR: config });
const noRequests = (async () => {
  throw new Error("no requests");
}) as unknown as typeof fetch;

test("a first move cut off by a crash after copying is done again in full by the next run, leaving the version 1 file signed out", async () => {
  const config = folder();
  write(config, "sign-in.json", { version: 1, services: { [CLOUD_SIGN_IN]: entry("cloud-r"), [TEAM_SITE]: entry("team-r") } });
  expect(await interrupted(config, "crashes")).toEqual({ exit: 3, outcomes: [] });
  // Cut off: the sign-ins were copied, and the version 1 file still holds them.
  expect(olderFinds(config).sort()).toEqual([CLOUD_SIGN_IN, TEAM_SITE]);
  expect(ageLeftLocks(config)).toEqual(["sign-in.json.lock", "sign-in.v2.json.lock"]);

  expect(await accessTokenFor(CLOUD_SIGN_IN, { backendUrl: CLOUD, env: env(config), fetchFn: noRequests })).toBe("access-cloud-r");
  expect(olderFinds(config)).toEqual([]);
  expect(read(config, "sign-in.v2.json").services[TEAM_SITE]).toMatchObject({ refreshToken: "team-r", bindings: [] });
  await expect(accessTokenFor(TEAM_SITE, { backendUrl: TEAM, env: env(config), fetchFn: noRequests })).rejects.toThrow("isn't approved for the backend");
  expect(readdirSync(config).filter((name) => name.includes(".lock"))).toEqual([]);
});

test("a first move whose write to the version 1 file fails stops with an error, and the next try finishes it", async () => {
  const config = folder();
  write(config, "sign-in.json", { version: 1, services: { [CLOUD_SIGN_IN]: entry("cloud-r"), [TEAM_SITE]: entry("team-r") } });
  const { exit, outcomes } = await interrupted(config, "fails", 2);
  expect(exit).toBe(0);
  expect(outcomes[0]).toStartWith("error: Couldn't sign out the earlier sign-in file");
  expect(outcomes[1]).toBe("access-cloud-r");
  expect(olderFinds(config)).toEqual([]);
});

test("a Critiqs Cloud sign-in moved from the version 1 file by a run cut off by a crash is removed there by the next run", async () => {
  const config = folder();
  // Moved before; since then, an older version signed in to Critiqs Cloud and to the team's service.
  write(config, "sign-in.v2.json", { version: 2, services: {} });
  write(config, "sign-in.json", { version: 1, services: { [CLOUD_SIGN_IN]: entry("cloud-r"), [TEAM_SITE]: entry("team-r") } });
  expect(await interrupted(config, "crashes")).toEqual({ exit: 3, outcomes: [] });
  expect(read(config, "sign-in.v2.json").services[CLOUD_SIGN_IN]).toMatchObject({ refreshToken: "cloud-r" });
  expect(olderFinds(config).sort()).toEqual([CLOUD_SIGN_IN, TEAM_SITE]);
  expect(ageLeftLocks(config)).toEqual(["sign-in.json.lock", "sign-in.v2.json.lock"]);

  expect(await accessTokenFor(CLOUD_SIGN_IN, { backendUrl: CLOUD, env: env(config), fetchFn: noRequests })).toBe("access-cloud-r");
  // The two versions no longer share one refresh token; the team's sign-in stays with the older version.
  expect(olderFinds(config)).toEqual([TEAM_SITE]);
  expect(readdirSync(config).filter((name) => name.includes(".lock"))).toEqual([]);
});
