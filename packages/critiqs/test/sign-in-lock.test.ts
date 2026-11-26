import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// The lock beside the sign-in file keeps two processes from spending the same
// refresh token. These run real processes under Node, which can stand in for
// `node:fs` inside bin/agent.mjs.

const AGENT = resolve(import.meta.dir, "../bin/agent.mjs");
const run = promisify(execFile);

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "critiqs-sign-in-lock-"));
  folders.push(made);
  return made;
};

/** A process that renews one expired sign-in, with an abandoned lock beside it, reporting what happened. */
const PRELUDE = `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const [agentPath, config, ...rest] = process.argv.slice(2);
const { accessTokenFor, credentialsFile } = await import(agentPath);
const env = { CRITIQS_CONFIG_DIR: config };
const file = credentialsFile(env);
const lock = file + ".lock";
const SITE = "https://team.convex.site";
const BACKEND = "https://team.convex.cloud";
const entry = { origin: SITE, bindings: [{ backend: BACKEND, site: SITE }], refreshToken: "r1", accessToken: "old", accessExpiresAt: 0 };
`;

async function node(script: string, config: string, ...args: string[]) {
  const path = join(config, "..", `${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, script);
  try {
    return (await run("node", [path, AGENT, config, ...args], { encoding: "utf8", timeout: 30_000 })).stdout;
  } finally {
    rmSync(path, { force: true });
  }
}

test("a waiter taking over an abandoned lock never removes the lock another waiter took meanwhile", async () => {
  const config = join(folder(), "config");
  const output = await node(
    `${PRELUDE}
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ version: 2, services: { [SITE]: entry } }));
fs.writeFileSync(lock, "abandoned");
const longAgo = new Date(Date.now() - 60_000);
fs.utimesSync(lock, longAgo, longAgo);
const events = [];
let otherHolds = false;
const realStat = fs.statSync;
let raced = false;
fs.statSync = function (path, ...options) {
  const result = realStat.call(this, path, ...options);
  if (!raced && String(path) === lock) {
    raced = true;
    // Right after this waiter saw the abandoned lock, another waiter removed it and took the lock.
    fs.rmSync(lock);
    fs.writeFileSync(lock, "other-waiter");
    otherHolds = true;
    setTimeout(() => {
      let found = null;
      try { found = fs.readFileSync(lock, "utf8"); } catch {}
      events.push("other waiter finishes, finding the lock " + (found === "other-waiter" ? "still its own" : "gone or replaced"));
      if (found === "other-waiter") fs.rmSync(lock);
      otherHolds = false;
    }, 400);
  }
  return result;
};
syncBuiltinESMExports();
const fetchFn = async () => {
  events.push(otherHolds ? "renewed while the other waiter held the lock" : "renewed");
  return Response.json({ accessToken: "new", refreshToken: "r2", expiresAt: Date.now() + 900_000 });
};
const token = await accessTokenFor(SITE, { backendUrl: BACKEND, env, fetchFn });
await new Promise((done) => setTimeout(done, 450));
console.log(JSON.stringify({ token, events }));
`,
    config,
  );
  expect(JSON.parse(output)).toEqual({ token: "new", events: ["other waiter finishes, finding the lock still its own", "renewed"] });
  expect(readdirSync(config).filter((name) => name.includes(".lock"))).toEqual([]);
});

/**
 * Three waiters, after a fourth died holding the lock: the first moves the
 * lock aside a moment after this process took it, believing it still the
 * abandoned one, and the third takes the now empty lock. This process, still
 * renewing, must not write while the third holds the lock, and must not lose
 * the refresh token it was given. The other two are played here through
 * `node:fs`, in whichever form this process made the lock.
 */
const THREE_WAITERS = `${PRELUDE}
const [third] = rest;
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ version: 2, services: { [SITE]: entry } }));
const events = [];
let thirdHolds = false;
const realRename = fs.renameSync;
fs.renameSync = function (from, to, ...more) {
  if (String(to) === file) events.push(thirdHolds ? "wrote while the third waiter held the lock" : "wrote");
  return realRename.call(this, from, to, ...more);
};
syncBuiltinESMExports();
const read = (path) => { try { return fs.readFileSync(path, "utf8"); } catch { return null; } };
const fetchFn = async () => {
  // The first waiter moves this process's lock aside, and the third takes the lock.
  const aside = lock + ".first-waiter";
  realRename(lock, aside);
  const directory = fs.statSync(aside).isDirectory();
  if (directory) { fs.mkdirSync(lock); fs.writeFileSync(lock + "/owner", "third-waiter"); }
  else fs.writeFileSync(lock, "third-waiter");
  fs.rmSync(aside, { recursive: true, force: true });
  thirdHolds = true;
  const ownerFile = directory ? lock + "/owner" : lock;
  setTimeout(() => {
    const still = read(ownerFile) === "third-waiter";
    if (third === "replaces") {
      // The third waiter signed in again meanwhile, replacing the sign-in this process was renewing.
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      stored.services[SITE] = { ...entry, refreshToken: "r-third", accessToken: "third", accessExpiresAt: Date.now() + 900_000 };
      fs.writeFileSync(file + ".third", JSON.stringify(stored));
      realRename(file + ".third", file);
    }
    events.push("third waiter finishes, finding the lock " + (still ? "still its own" : "gone or replaced"));
    if (still) fs.rmSync(lock, { recursive: true, force: true });
    thirdHolds = false;
  }, 400);
  return Response.json({ accessToken: "new", refreshToken: "r2", expiresAt: Date.now() + 900_000 });
};
let token;
try { token = await accessTokenFor(SITE, { backendUrl: BACKEND, env, fetchFn }); } catch (error) { token = "error: " + error.message; }
await new Promise((done) => setTimeout(done, 450));
const stored = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(JSON.stringify({ token, events, refreshToken: stored.services[SITE]?.refreshToken, recovered: stored.recovered ?? [] }));
`;

test("a holder whose lock was moved aside and taken by a third waiter writes only after that one is done, keeping its new refresh token", async () => {
  const config = join(folder(), "config");
  const output = JSON.parse(await node(THREE_WAITERS, config, "reads"));
  expect(output).toEqual({ token: "new", events: ["third waiter finishes, finding the lock still its own", "wrote"], refreshToken: "r2", recovered: [] });
  expect(readdirSync(config).filter((name) => name.includes(".lock"))).toEqual([]);
});

test("a holder whose sign-in was replaced while another process held its lock keeps its new refresh token aside, so signing out can end it", async () => {
  const config = join(folder(), "config");
  const output = JSON.parse(await node(THREE_WAITERS, config, "replaces"));
  expect(output).toEqual({
    token: "third",
    events: ["third waiter finishes, finding the lock still its own", "wrote"],
    refreshToken: "r-third",
    recovered: [{ signInUrl: "https://team.convex.site", origin: "https://team.convex.site", refreshToken: "r2" }],
  });
});

test("concurrent waiters on an abandoned lock take turns, one at a time", async () => {
  const config = join(folder(), "config");
  const log = join(config, "..", "turns.log");
  const setup = `${PRELUDE}
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ version: 2, services: { [SITE]: entry } }));
fs.writeFileSync(lock, "abandoned");
const longAgo = new Date(Date.now() - 60_000);
fs.utimesSync(lock, longAgo, longAgo);
`;
  await node(setup, config);
  const waiter = `${PRELUDE}
const [log, start] = rest;
// All waiters begin together, so they find the abandoned lock at once.
await new Promise((done) => setTimeout(done, Math.max(0, Number(start) - Date.now())));
const fetchFn = async () => {
  fs.appendFileSync(log, "in " + process.pid + "\\n");
  await new Promise((done) => setTimeout(done, 15));
  fs.appendFileSync(log, "out " + process.pid + "\\n");
  // Always nearly used up, so each call renews under the lock.
  return Response.json({ accessToken: "a" + process.pid, refreshToken: "r" + process.pid, expiresAt: Date.now() + 1_000 });
};
for (let turn = 0; turn < 4; turn++) await accessTokenFor(SITE, { backendUrl: BACKEND, env, fetchFn });
`;
  const start = String(Date.now() + 1_500);
  await Promise.all(Array.from({ length: 6 }, () => node(waiter, config, log, start)));
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines).toHaveLength(6 * 4 * 2);
  for (let index = 0; index < lines.length; index += 2) {
    const [entered, left] = [lines[index]!.split(" "), lines[index + 1]!.split(" ")];
    expect([entered[0], left[0], left[1]]).toEqual(["in", "out", entered[1]]);
  }
  // Nothing is left behind: no lock, and nothing moved aside.
  expect(readdirSync(config).filter((name) => name.includes(".lock"))).toEqual([]);
});
