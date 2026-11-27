// Which of a pull request's changes ship in a Critiqs package, for the release
// notes gate in release.ts. A file under packages/ ships, except tests and
// check scripts. A change to a dependency's version ships when a package's
// users install that range, or a package's build puts the code in or runs it:
//
// - a `dependencies`, `peerDependencies`, or `optionalDependencies` range of a
//   package under packages/ (users install it; a private workspace's are
//   bundled by the packages that use it);
// - anything a package's build bundles, at any depth, as its last real build
//   recorded in scripts/bundled-dependencies.json (bundled-dependencies.ts
//   writes it from the bundler's own list of inputs, and `bun run test` fails
//   when a build bundles something the record leaves out);
// - the commands a package's build runs (`tsc`, `svelte-package`), every
//   package that provides one of those commands, and what they depend on;
// - a version bun.lock resolves for any of those.
//
// Only released packages ship: a private workspace ships inside the released
// packages that bundle it. What the gate can't tell apart counts against the
// pull request: a package missing from the record counts every update as
// shipped in it, and a lockfile it can't read, or a lockfile change other than
// resolved versions and ranges, needs a note. Workflows: an action's new pin
// needs no note only when the action stays the same and the workflow can't
// publish, push, or read secrets.

type Change = { status: string; path: string };
type Read = (commit: string, path: string) => Promise<string | null>;
type Field = (typeof FIELDS)[number];
type Manifest = { name?: string; scripts?: Record<string, string> } & Partial<Record<Field, Record<string, string>>>;
/** bun.lock's `packages`: key → [name@version, registry, { dependencies, … }, integrity]. */
type LockEntry = [string, string?, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalPeers?: string[]; bin?: Record<string, string> | string }?, string?];
interface Lock {
  workspaces?: Record<string, Manifest>;
  packages?: Record<string, LockEntry>;
  patchedDependencies?: Record<string, string>;
  [key: string]: unknown;
}
/** What a package's build takes in, by package name; `null` when the record doesn't say. */
type Knowledge = Set<string> | null;

// Every package under packages/ is a released package or a private workspace bundled into one, except the
// browser extension, which no Critiqs package bundles: it ships through the Chrome Web Store.
const SHIPPED = /^packages\/(?!extension\/)/;
const TEST = /(^|\/)(test|tests|__tests__|spec)\/|\.test\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_(test|spec)\.rb$|^packages\/[^/]+\/scripts\/check-[^/]*\.ts$/;
/** Whether a file is part of what a package ships or is built from: under packages/, and not a test or check script. */
export const shipsFile = (path: string) => SHIPPED.test(path) && !TEST.test(path);

/** The record of what each released package's build bundles and runs. */
export const RECORD = "scripts/bundled-dependencies.json";
const FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const;
const RUNTIME = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const BUILD_SCRIPTS = ["build", "prepack", "prepare", "release:build"];
/** bun.lock's top-level keys that hold only resolved versions and the workspaces' ranges. */
const LOCK_VERSIONS = new Set(["workspaces", "packages"]);

export interface ShippedChanges {
  /** Every change is a dependency's version: a package.json dependency range, a bun.lock entry, or an action's pin in a workflow. */
  dependenciesOnly: boolean;
  /** What ships, one line each: a path, or `<path>: <dependency> <before> → <after>`. */
  shipped: string[];
  /** The released packages the shipped dependency updates reach. */
  packages: string[];
  /** Why a change that looks like a dependency update still needs a note, one line each. */
  reasons: string[];
}

const nameOf = (spec: string) => spec.slice(0, spec.indexOf("@", 1));

/**
 * Classifies a diff from `from` to `to`. `released` maps each released
 * package's workspace folder to its name.
 */
export async function shippedChanges(cwd: string, from: string, to: string, diff: Change[], released: Map<string, string>, read: Read): Promise<ShippedChanges> {
  const shipped: string[] = [];
  const reasons: string[] = [];
  const reached = new Set<string>();
  let dependenciesOnly = diff.length > 0;
  let graph: Promise<Graph> | undefined;
  const load = () => graph ??= workspaces(cwd, from, to, released, read);
  /** Records a dependency update that ships in the released packages in `dirs`. */
  const ships = (line: string, dirs: string[]) => {
    if (dirs.length === 0) return;
    shipped.push(line);
    for (const dir of dirs) reached.add(released.get(dir)!);
  };

  for (const { status, path } of diff) {
    if (status === "M" && WORKFLOW.test(path)) {
      const [before, after] = [await read(from, path), await read(to, path)];
      if (sameApartFromActionPins(before, after)) {
        if (!canWriteOrPublish(before!) && !canWriteOrPublish(after!)) continue;
        reasons.push(`${path} moves actions to new commits in a workflow that can publish, push, or read secrets; a person checks the update and adds a note.`);
      }
    }
    // Lockfiles of projects outside packages/, such as site-src's, resolve nothing a package ships.
    if (status === "M" && path.endsWith("bun.lock") && path !== "bun.lock" && !SHIPPED.test(path)) continue;
    if (status === "M" && path === "bun.lock") {
      const g = await load();
      if (g.lock === null) {
        reasons.push("bun.lock can't be read at both commits, so what it resolves can't be told apart.");
        dependenciesOnly = false;
        shipped.push("bun.lock (can't be read)");
        continue;
      }
      const [before, after] = [g.lock.from, g.lock.to];
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (LOCK_VERSIONS.has(key) || Bun.deepEquals(before[key], after[key])) continue;
        dependenciesOnly = false;
        reasons.push(`bun.lock changes its ${key}, which is not a dependency's version.`);
      }
      // A patch to a dependency's code ships wherever that code does.
      const [patchesBefore, patchesAfter] = [before.patchedDependencies ?? {}, after.patchedDependencies ?? {}];
      for (const key of new Set([...Object.keys(patchesBefore), ...Object.keys(patchesAfter)])) {
        if (patchesBefore[key] !== patchesAfter[key]) ships(`bun.lock: patch for ${key}`, g.lockReach(nameOf(key)));
      }
      for (const [name, versions] of changedEntries(before.packages ?? {}, after.packages ?? {})) {
        // A workspace's own entry says where its code comes from, not a dependency's version.
        if (g.isWorkspace(name) || versions.includes("workspace:")) {
          dependenciesOnly = false;
          reasons.push(`bun.lock changes where the workspace ${name} comes from.`);
          ships(`bun.lock: ${name} ${versions}`, g.bundling(name));
        } else {
          ships(`bun.lock: ${name} ${versions}`, g.lockReach(name));
        }
      }
      // The workspaces' ranges as bun.lock records them, judged like their manifests.
      const [spacesBefore, spacesAfter] = [before.workspaces ?? {}, after.workspaces ?? {}];
      for (const dir of new Set([...Object.keys(spacesBefore), ...Object.keys(spacesAfter)])) {
        const entries = dependencyEntries(spacesBefore[dir], spacesAfter[dir], g.isWorkspace);
        if (entries === null) {
          dependenciesOnly = false;
          reasons.push(`bun.lock changes the workspace ${JSON.stringify(dir)} beyond its dependency ranges.`);
          continue;
        }
        if (!SHIPPED.test(`${dir}/`)) continue;
        for (const entry of entries) ships(`bun.lock: ${dir}: ${entry.name} ${entry.versions}`, g.rangeReach(dir, entry.field, entry.name));
      }
      continue;
    }
    // A workspace's manifest under packages/, or any manifest outside it.
    if (status === "M" && /(^|\/)package\.json$/.test(path) && (!shipsFile(path) || /^packages\/[^/]+\/package\.json$/.test(path))) {
      const g = await load();
      const entries = dependencyEntries(parse(await read(from, path)), parse(await read(to, path)), g.isWorkspace);
      if (entries !== null) {
        if (!shipsFile(path)) continue;
        const dir = path.slice(0, -"/package.json".length);
        for (const { field, name, versions } of entries) ships(`${path}: ${name} ${versions}`, g.rangeReach(dir, field, name));
        continue;
      }
    }
    dependenciesOnly = false;
    if (shipsFile(path)) shipped.push(path);
  }
  if (graph !== undefined) reasons.push(...(await graph).unknown);
  // bun.lock repeats each workspace's ranges; list a range once when its manifest says the same.
  const listed = shipped.filter((line) => {
    const match = /^bun\.lock: (packages\/[^:]+): (.*)$/.exec(line);
    return match === null || !shipped.includes(`${match[1]}/package.json: ${match[2]}`);
  });
  return { dependenciesOnly, shipped: listed, packages: [...reached].sort(), reasons };
}

/**
 * A `uses:` line pinned to a full commit, with an optional version comment:
 * the action (owner, repository, path) is kept, the pin and comment are not.
 */
const PIN = /^([ \t]*(?:-[ \t]+)?uses:[ \t]*)([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@[0-9a-f]{40}(?:[ \t]+#[ \t]*v?\d+(?:\.\d+)*(?:-[\w.]+)?)?[ \t]*$/gm;
/** Whether two workflow files differ only in the commits their actions are pinned to, and those actions' version comments. */
function sameApartFromActionPins(before: string | null, after: string | null): boolean {
  const unpinned = (text: string) => text.replace(PIN, "$1$2@");
  return before !== null && after !== null && unpinned(before) === unpinned(after);
}

/**
 * Whether a workflow can publish, push, or use secrets: a permission set to
 * write, a secret, a privileged trigger, or no top-level `permissions:` (the
 * token then gets the repository's default, which may write).
 */
function canWriteOrPublish(text: string): boolean {
  return !/^permissions:/m.test(text) || /write-all|^[ \t]*[\w-]+:[ \t]*write\b|\bsecrets\.|\bpull_request_target\b|\bworkflow_run\b/m.test(text);
}

function parse(text: string | null): Manifest | undefined {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * The dependency ranges that differ, or null when anything else changed: the
 * manifest's other fields, a range naming a workspace, or a manifest added,
 * removed, or unreadable.
 */
function dependencyEntries(before: Manifest | undefined, after: Manifest | undefined, isWorkspace: (name: string) => boolean) {
  if (before === undefined || after === undefined) return null;
  const rest = (manifest: Manifest) => Object.fromEntries(Object.entries(manifest).filter(([key]) => !(FIELDS as readonly string[]).includes(key)));
  if (!Bun.deepEquals(rest(before), rest(after))) return null;
  const entries: { field: Field; name: string; versions: string }[] = [];
  for (const field of FIELDS) {
    const [old, next] = [before[field] ?? {}, after[field] ?? {}];
    for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (old[name] === next[name]) continue;
      if (isWorkspace(name) || `${old[name]}${next[name]}`.includes("workspace:")) return null;
      entries.push({ field, name, versions: `${old[name] ?? "(none)"} → ${next[name] ?? "(none)"}` });
    }
  }
  return entries;
}

/** Package names whose resolved entries in bun.lock differ, with their versions before and after. */
function changedEntries(before: Record<string, LockEntry>, after: Record<string, LockEntry>): Map<string, string> {
  const versions = (lock: Record<string, LockEntry>, name: string) => [...new Set(Object.values(lock).filter(([spec]) => nameOf(spec) === name).map(([spec]) => spec.slice(name.length + 1)))].sort().join(", ") || "(none)";
  const names = new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Bun.deepEquals(before[key], after[key])) continue;
    for (const entry of [before[key], after[key]]) if (entry) names.add(nameOf(entry[0]));
  }
  return new Map([...names].sort().map((name) => [name, `${versions(before, name)} → ${versions(after, name)}`]));
}

interface Graph {
  /** Both commits' root bun.lock, or null when either can't be read. */
  lock: { from: Lock; to: Lock } | null;
  isWorkspace(name: string): boolean;
  /** The released packages whose files a bun.lock change to `name` can change. */
  lockReach(name: string): string[];
  /** The released packages that bundle the workspace package `name`, itself included. */
  bundling(name: string): string[];
  /** The released packages a range in the workspace `dir`'s `field` reaches. */
  rangeReach(dir: string, field: Field, name: string): string[];
  /** Why the gate counted every update as shipped in a package. */
  unknown: string[];
}

/** The workspaces under packages/, read at both commits, with what each released one's build takes in. */
async function workspaces(cwd: string, from: string, to: string, released: Map<string, string>, read: Read): Promise<Graph> {
  const lock = await readLock(read, from, to);
  const byName = new Map<string, LockEntry[]>();
  for (const entry of [...Object.values(lock?.from.packages ?? {}), ...Object.values(lock?.to.packages ?? {})]) byName.set(nameOf(entry[0]), [...byName.get(nameOf(entry[0])) ?? [], entry]);

  // Both commits' manifests, merged, so a range on either side counts.
  const manifests = new Map<string, Manifest>();
  for (const commit of [from, to]) {
    const paths = (await run(["git", "ls-tree", "-r", "-z", "--name-only", commit, "--", "packages/"], cwd)).split("\0").filter((path) => /^packages\/[^/]+\/package\.json$/.test(path));
    for (const path of paths) {
      const manifest = parse(await read(commit, path)) ?? {};
      const dir = path.slice(0, -"/package.json".length);
      const known = manifests.get(dir) ?? {};
      for (const field of [...FIELDS, "scripts"] as const) known[field] = { ...known[field], ...manifest[field] };
      manifests.set(dir, { ...known, name: manifest.name ?? known.name });
    }
  }
  const dirOf = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
  const runtime = (manifest: Manifest) => new Set(RUNTIME.flatMap((field) => Object.keys(manifest[field] ?? {})));

  // The commands a workspace's package.json build scripts run.
  const bins = (name: string) => (byName.get(name) ?? []).flatMap(([, , info]) => typeof info?.bin === "string" ? [name.split("/").pop()!] : Object.keys(info?.bin ?? {}));
  /** Every package that provides one of these commands, at either commit. */
  const providers = (words: Set<string>) => [...byName.keys()].filter((name) => bins(name).some((bin) => words.has(bin)));
  const tools = new Map<string, Set<string>>();
  for (const [dir, { scripts }] of manifests) {
    tools.set(dir, new Set(providers(new Set(BUILD_SCRIPTS.flatMap((script) => scripts?.[script]?.split(/\s+|&&|\|\|/) ?? [])))));
  }

  // What each released package's build bundles and runs, by the record at both commits.
  const records = [await readRecord(read, from), await readRecord(read, to)];
  const unknown: string[] = [];
  const recorded = (name: string, kind: "bundles" | "runs"): Knowledge => {
    const found = records.map((record) => record?.[name]?.[kind]);
    if (found.some((list) => !Array.isArray(list))) return null;
    return new Set(found.flat() as string[]);
  };

  const packages = new Map<string, { external: Set<string>; members: Set<string>; bundles: Knowledge; reach: Knowledge }>();
  for (const [dir, name] of released) {
    const manifest = manifests.get(dir) ?? {};
    // The private workspaces it bundles: those it names with workspace:, and theirs.
    const members = new Set([dir]);
    for (const member of members) {
      for (const field of FIELDS) for (const [dependency, range] of Object.entries(manifests.get(member)?.[field] ?? {})) if (range.startsWith("workspace:") && dirOf.has(dependency)) members.add(dirOf.get(dependency)!);
    }
    const bundles = recorded(name, "bundles");
    const runs = recorded(name, "runs");
    if (bundles === null || runs === null) unknown.push(`${RECORD} doesn't say what ${name} bundles at both commits, so every dependency update counts as shipped in it.`);
    const built = [...members].flatMap((member) => [...tools.get(member) ?? []]);
    // The commands its build runs, and every package that provides one of them.
    const commands = runs === null ? [] : providers(new Set([...runs].flatMap(bins)));
    const reach = bundles === null || runs === null ? null : new Set([...bundles, ...closure([...built, ...runs, ...commands], byName)]);
    packages.set(dir, { external: runtime(manifest), members, bundles, reach });
  }
  const has = (known: Knowledge, name: string) => known === null || known.has(name);

  return {
    lock,
    isWorkspace: (name) => dirOf.has(name),
    lockReach: (name) => [...packages].filter(([, pkg]) => has(pkg.reach, name)).map(([dir]) => dir),
    bundling: (name) => [...packages].filter(([, pkg]) => dirOf.has(name) && pkg.members.has(dirOf.get(name)!)).map(([dir]) => dir),
    rangeReach: (dir, field, name) => [...packages].filter(([other, pkg]) => pkg.members.has(dir) && (
      field === "devDependencies"
        ? tools.get(dir)?.has(name) || has(pkg.reach, name)
        : other === dir || has(pkg.bundles, name) || !pkg.external.has(name)
    )).map(([other]) => other),
    unknown,
  };
}

/** Every package name `roots` depend on through bun.lock. */
function closure(roots: string[], byName: Map<string, LockEntry[]>): Set<string> {
  const found = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (found.has(name)) continue;
    found.add(name);
    for (const [, , info] of byName.get(name) ?? []) {
      const optionalPeers = new Set(info?.optionalPeers ?? []);
      queue.push(...Object.keys(info?.dependencies ?? {}), ...Object.keys(info?.optionalDependencies ?? {}), ...Object.keys(info?.peerDependencies ?? {}).filter((peer) => !optionalPeers.has(peer)));
    }
  }
  return found;
}

/**
 * bun.lock at both commits, read strictly: bun.lock is JSON with trailing
 * commas, so anything else, such as text after the object, makes it unreadable.
 */
async function readLock(read: Read, from: string, to: string): Promise<{ from: Lock; to: Lock } | null> {
  const strict = (text: string | null): Lock | null => {
    if (text === null) return {};
    try {
      const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
      return typeof lock === "object" && lock !== null && !Array.isArray(lock) ? lock as Lock : null;
    } catch {
      return null;
    }
  };
  const [before, after] = [strict(await read(from, "bun.lock")), strict(await read(to, "bun.lock"))];
  return before === null || after === null ? null : { from: before, to: after };
}

type RecordFile = { [name: string]: { bundles?: unknown; runs?: unknown } | undefined };
async function readRecord(read: Read, commit: string): Promise<RecordFile | null> {
  try {
    const record = JSON.parse(await read(commit, RECORD) ?? "null")?.packages;
    return typeof record === "object" && record !== null ? record as RecordFile : null;
  } catch {
    return null;
  }
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout;
}
