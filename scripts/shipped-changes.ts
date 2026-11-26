// Which of a pull request's changes ship in a Critiqs package, for the release
// notes gate in release.ts. A file under packages/ ships, except tests and
// check scripts. A change to a dependency's version ships only when a
// package's users install that range or a package's build puts the code in:
//
// - a `dependencies`, `peerDependencies`, or `optionalDependencies` range of a
//   package under packages/ (users install it; a private workspace's are
//   bundled by the packages that use it);
// - a `devDependencies` range that a package's code imports and doesn't leave
//   to its users (builds bundle what they import: `critiqs` bundles React), or
//   whose command a package's build runs (`tsc`, `svelte-package`);
// - a version bun.lock resolves for any of those, or for what they in turn
//   depend on, except what a package's users install themselves.
//
// Only released packages ship: a private workspace ships inside the released
// packages that bundle it. Anything else a dependency update touches ships
// nothing: type packages and test tools, workspaces outside packages/ and
// private ones no released package bundles, other lockfiles (site-src's), and
// the actions workflows use.

type Change = { status: string; path: string };
type Read = (commit: string, path: string) => Promise<string | null>;
type Field = (typeof FIELDS)[number];
type Manifest = { name?: string; scripts?: Record<string, string> } & Partial<Record<Field, Record<string, string>>>;
/** bun.lock's `packages`: key → [name@version, registry, { dependencies, … }, integrity]. */
type LockEntry = [string, string?, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalPeers?: string[]; bin?: Record<string, string> | string }?, string?];
type Lock = Record<string, LockEntry>;

const SHIPPED = /^packages\//;
const TEST = /(^|\/)(test|tests|__tests__|spec)\/|\.test\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_(test|spec)\.rb$|^packages\/[^/]+\/scripts\/check-[^/]*\.ts$/;
/** Whether a file is part of what a package ships or is built from: under packages/, and not a test or check script. */
export const shipsFile = (path: string) => SHIPPED.test(path) && !TEST.test(path);

const FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const;
const RUNTIME = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const BUILD_SCRIPTS = ["build", "prepack", "prepare", "release:build"];
const CODE = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "svelte", "vue", "astro"].map((extension) => `packages/*.${extension}`);
const IMPORT = `(from|import|require)[[:space:]]*\\(?[[:space:]]*["'][^"'./][^"']*["']`;

export interface ShippedChanges {
  /** Every change is a dependency's version: a package.json dependency range, a bun.lock entry, or an action a workflow uses. */
  dependenciesOnly: boolean;
  /** What ships, one line each: a path, or `<path>: <dependency> <before> → <after>`. */
  shipped: string[];
  /** The released packages the shipped dependency updates reach. */
  packages: string[];
}

/** A workspace under packages/ and what its build takes in. */
interface Workspace {
  name: string;
  /** Ranges its users install: never bundled into it. */
  external: Set<string>;
  /** The private workspaces whose code it bundles, itself included. */
  members: Set<string>;
  /** Dependency names whose resolved code ends up in its build, by bun.lock. */
  reach: Set<string>;
}

const nameOf = (spec: string) => spec.slice(0, spec.indexOf("@", 1));
const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

/**
 * Classifies a diff from `from` to `to`. `released` maps each released
 * package's workspace folder to its name.
 */
export async function shippedChanges(cwd: string, from: string, to: string, diff: Change[], released: Map<string, string>, read: Read): Promise<ShippedChanges> {
  const shipped: string[] = [];
  const reached = new Set<string>();
  const reach = (dirs: string[]) => { for (const dir of dirs) reached.add(released.get(dir)!); };
  let dependenciesOnly = diff.length > 0;
  let graph: Promise<Awaited<ReturnType<typeof workspaces>>> | undefined;
  const load = () => graph ??= workspaces(cwd, from, to, read);

  for (const { status, path } of diff) {
    if (status === "M" && WORKFLOW.test(path) && sameApartFromActions(await read(from, path), await read(to, path))) continue;
    // Lockfiles of projects outside packages/, such as site-src's, resolve nothing a package ships.
    if (status === "M" && path.endsWith("bun.lock") && path !== "bun.lock" && !SHIPPED.test(path)) continue;
    if (status === "M" && path === "bun.lock") {
      const { lock, all } = await load();
      for (const [name, versions] of changedEntries(lock.from, lock.to)) {
        const into = [...all].filter(([dir, workspace]) => released.has(dir) && workspace.reach.has(name)).map(([dir]) => dir);
        if (into.length === 0) continue;
        shipped.push(`bun.lock: ${name} ${versions}`);
        reach(into);
      }
      continue;
    }
    // A workspace's manifest under packages/, or any manifest outside it.
    if (status === "M" && /(^|\/)package\.json$/.test(path) && (!shipsFile(path) || /^packages\/[^/]+\/package\.json$/.test(path))) {
      const entries = dependencyEntries(await read(from, path), await read(to, path));
      if (entries !== null) {
        if (!shipsFile(path)) continue;
        const { all, imported, tools } = await load();
        const dir = path.slice(0, -"/package.json".length);
        for (const { field, name, versions } of entries) {
          // The workspaces whose builds or users this range reaches.
          const into = [...all].filter(([other, workspace]) => released.has(other) && workspace.members.has(dir) && (
            field === "devDependencies"
              ? tools.get(dir)?.has(name) || (imported.has(name) && !workspace.external.has(name))
              : other === dir || !workspace.external.has(name)
          )).map(([other]) => other);
          if (into.length === 0) continue;
          shipped.push(`${path}: ${name} ${versions}`);
          reach(into);
        }
        continue;
      }
    }
    dependenciesOnly = false;
    if (shipsFile(path)) shipped.push(path);
  }
  return { dependenciesOnly, shipped, packages: [...reached].sort() };
}

/** Whether two workflow files differ only in the actions their `uses:` lines name. */
function sameApartFromActions(before: string | null, after: string | null): boolean {
  const strip = (text: string) => text.replace(/^(\s*(?:-\s+)?uses:\s*).*$/gm, "$1");
  return before !== null && after !== null && strip(before) === strip(after);
}

/** The dependency ranges that differ, or null when anything else in the manifest changed too. */
function dependencyEntries(before: string | null, after: string | null) {
  if (before === null || after === null) return null;
  const [a, b] = [JSON.parse(before) as Manifest, JSON.parse(after) as Manifest];
  const rest = (manifest: Manifest) => Object.fromEntries(Object.entries(manifest).filter(([key]) => !(FIELDS as readonly string[]).includes(key)));
  if (!Bun.deepEquals(rest(a), rest(b))) return null;
  const entries: { field: Field; name: string; versions: string }[] = [];
  for (const field of FIELDS) {
    const [old, next] = [a[field] ?? {}, b[field] ?? {}];
    for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (old[name] !== next[name]) entries.push({ field, name, versions: `${old[name] ?? "(none)"} → ${next[name] ?? "(none)"}` });
    }
  }
  return entries;
}

/** Package names whose resolved entries in bun.lock differ, with their versions before and after. */
function changedEntries(before: Lock, after: Lock): Map<string, string> {
  const versions = (lock: Lock, name: string) => [...new Set(Object.values(lock).filter(([spec]) => nameOf(spec) === name).map(([spec]) => spec.slice(name.length + 1)))].sort().join(", ") || "(none)";
  const names = new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    for (const entry of [before[key], after[key]]) if (entry) names.add(nameOf(entry[0]));
  }
  return new Map([...names].sort().map((name) => [name, `${versions(before, name)} → ${versions(after, name)}`]));
}

/**
 * The workspaces under packages/, read at both commits, with what each one's
 * build takes in; the dependencies code under packages/ imports; and the
 * build tools each workspace's scripts run.
 */
async function workspaces(cwd: string, from: string, to: string, read: Read) {
  const lock = { from: await readLock(read, from), to: await readLock(read, to) };
  const byName = new Map<string, LockEntry[]>();
  for (const entry of [...Object.values(lock.from), ...Object.values(lock.to)]) byName.set(nameOf(entry[0]), [...byName.get(nameOf(entry[0])) ?? [], entry]);

  // Both commits' manifests, merged, so a range on either side counts.
  const manifests = new Map<string, Manifest>();
  for (const commit of [from, to]) {
    const paths = (await run(["git", "ls-tree", "-r", "-z", "--name-only", commit, "--", "packages/"], cwd)).split("\0").filter((path) => /^packages\/[^/]+\/package\.json$/.test(path));
    for (const path of paths) {
      const manifest = JSON.parse(await read(commit, path) ?? "{}") as Manifest;
      const dir = path.slice(0, -"/package.json".length);
      const known = manifests.get(dir) ?? {};
      for (const field of [...FIELDS, "scripts"] as const) known[field] = { ...known[field], ...manifest[field] };
      manifests.set(dir, { ...known, name: manifest.name });
    }
  }

  // Dependencies imported by any shipped file under packages/, at either commit.
  const imported = new Set<string>();
  for (const commit of [from, to]) {
    const found = await run(["git", "grep", "-z", "-I", "-o", "-E", IMPORT, commit, "--", ...CODE], cwd).catch(() => "");
    for (const line of found.split("\n")) {
      const [location, match] = line.split("\0");
      if (location && match && shipsFile(location.slice(location.indexOf(":") + 1))) imported.add(packageOf(match.replace(/^.*["']([^"']+)["']$/, "$1")));
    }
  }

  // Build tools: dependencies whose command a workspace's build scripts run.
  const bins = (name: string) => byName.get(name)!.flatMap(([, , info]) => typeof info?.bin === "string" ? [name.split("/").pop()!] : Object.keys(info?.bin ?? {}));
  const tools = new Map<string, Set<string>>();
  for (const [dir, { scripts }] of manifests) {
    const words = new Set(BUILD_SCRIPTS.flatMap((script) => scripts?.[script]?.split(/\s+|&&|\|\|/) ?? []));
    tools.set(dir, new Set([...byName.keys()].filter((name) => bins(name).some((bin) => words.has(bin)))));
  }

  const dirOf = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
  const runtime = (manifest: Manifest) => new Set(RUNTIME.flatMap((field) => Object.keys(manifest[field] ?? {})));
  const all = new Map<string, Workspace>();
  for (const [dir, manifest] of manifests) {
    const external = runtime(manifest);
    // The private workspaces it bundles: those it names with workspace:, and theirs.
    const members = new Set([dir]);
    for (const member of members) {
      const used = manifests.get(member)!;
      for (const field of FIELDS) for (const [name, range] of Object.entries(used[field] ?? {})) if (range.startsWith("workspace:") && dirOf.has(name)) members.add(dirOf.get(name)!);
    }
    // Bundled: what its members import or need at run time, minus what its users install; then what those depend on.
    const bundled = [...members].flatMap((member) => {
      const used = manifests.get(member)!;
      const needs = member === dir ? [] : [...runtime(used)];
      return [...needs, ...Object.keys(used.devDependencies ?? {}).filter((name) => imported.has(name))];
    }).filter((name) => !external.has(name) && !dirOf.has(name));
    const built = [...members].flatMap((member) => [...tools.get(member) ?? []]);
    all.set(dir, { name: manifest.name ?? dir, external, members, reach: new Set([...closure(bundled, byName, external), ...closure(built, byName, new Set())]) });
  }
  return { lock, all, imported, tools };
}

/** Every package name `roots` depend on through bun.lock, leaving out `skip` and what only it needs. */
function closure(roots: string[], byName: Map<string, LockEntry[]>, skip: Set<string>): Set<string> {
  const found = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (found.has(name) || skip.has(name)) continue;
    found.add(name);
    for (const [, , info] of byName.get(name) ?? []) {
      const optionalPeers = new Set(info?.optionalPeers ?? []);
      queue.push(...Object.keys(info?.dependencies ?? {}), ...Object.keys(info?.optionalDependencies ?? {}), ...Object.keys(info?.peerDependencies ?? {}).filter((peer) => !optionalPeers.has(peer)));
    }
  }
  return found;
}

async function readLock(read: Read, commit: string): Promise<Lock> {
  const text = await read(commit, "bun.lock");
  return text === null ? {} : (Bun.JSONC.parse(text) as { packages?: Lock }).packages ?? {};
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout;
}
