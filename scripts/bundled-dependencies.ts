// What each released package's published files are built from, for the
// release notes gate (shipped-changes.ts), recorded in
// scripts/bundled-dependencies.json:
//
// - bundles: every npm package whose code ends up in the package's files;
// - runs: the npm packages whose commands the package's build runs.
//
// Both come from the package's real build, run exactly as publishing runs it
// (`npm pack` for npm, `release:build` for RubyGems and PyPI), with
// record-build.ts preloaded into every Bun process: the bundler's own list of
// input files for every bundle the build makes, and every command it starts.
// The packed files are then read back: a file that is a bundle some build
// made carries that bundle's inputs (the gem and the Python packages copy
// critiqs's browser bundle), and a file that is a copy of a file in
// node_modules counts that package. `check` fails when a package's files take
// in anything the record leaves out, so `bun run test` keeps the record true.
//
//   bun scripts/bundled-dependencies.ts check
//   bun scripts/bundled-dependencies.ts write
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmTarballName } from "./publish.ts";
import { releasePackages, workingTree, type ReleasePackage } from "./release.ts";
import { RECORD } from "./shipped-changes.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RECORDER = fileURLToPath(new URL("./record-build.ts", import.meta.url));
const ABOUT = "Written by `bun scripts/bundled-dependencies.ts write` from each released package's real build: `bundles` lists the npm packages whose code is in its published files, `runs` the npm packages whose commands its build runs. The release notes gate reads it; `bun run test` fails when a build takes in something it leaves out.";

export interface Recorded {
  bundles: string[];
  runs: string[];
}
/** The size from which a packed file that equals a file in node_modules counts as a copy of that package's code. */
const MEANINGFUL = 64;
type Entry = { cwd: string; inputs?: string[] | null; outputs?: string[]; command?: string[] };

/** The npm package a file under node_modules belongs to, by the last node_modules folder in its path. */
export function packageOfPath(path: string): string | null {
  const parts = path.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length || parts[at + 1]!.startsWith(".")) return null;
  return parts[at + 1]!.startsWith("@") ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1]!;
}

async function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}) in ${cwd}:\n${stdout}\n${stderr}`);
  return stdout;
}

/** The npm package that provides command `word` to a process in `cwd`: node_modules/.bin from there up to the root. */
function commandPackage(word: string, cwd: string): string | null {
  if (word === "" || word.includes("/")) return null;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules/.bin", word);
    if (existsSync(bin)) return packageOfPath(realpathSync(bin));
    if (dir === dirname(dir) || !dir.startsWith(ROOT.replace(/\/$/, ""))) return null;
  }
}

/** The command a process started: `tsc` for `bun run tsc -p …`, `bunx x`, or `npx x`. */
function commandWord(command: string[]): string {
  const first = command[0]?.split("/").pop() ?? "";
  if (["bun", "npm", "pnpm"].includes(first) && ["run", "x", "exec"].includes(command[1] ?? "")) return command[2] ?? "";
  if (first === "bunx" || first === "npx") return command.slice(1).find((word) => !word.startsWith("-")) ?? "";
  return first;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** Unpacks an npm tarball, gem, sdist, or wheel into `into`, returning the files it holds. */
async function unpack(file: string, into: string): Promise<string[]> {
  await mkdir(into, { recursive: true });
  if (file.endsWith(".whl")) {
    await run(["python3", "-I", "-m", "zipfile", "-e", file, into], into);
  } else if (file.endsWith(".gem")) {
    await run(["tar", "-xf", file, "data.tar.gz"], into);
    await mkdir(join(into, "data"), { recursive: true });
    await run(["tar", "-xzf", join(into, "data.tar.gz"), "-C", join(into, "data")], into);
    await rm(join(into, "data.tar.gz"));
  } else {
    await run(["tar", "-xzf", file, "-C", into], into);
  }
  return filesUnder(into);
}

/** Every real file in node_modules, by size, to find packed files that are copies of one. */
function nodeModulesBySize(): Map<number, string[]> {
  const bySize = new Map<number, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const { size } = statSync(path);
        if (size >= MEANINGFUL) bySize.set(size, [...bySize.get(size) ?? [], path]);
      }
    }
  };
  for (const top of [join(ROOT, "node_modules"), ...readdirSync(join(ROOT, "packages")).map((dir) => join(ROOT, "packages", dir, "node_modules"))]) {
    // Symbolic links lead to workspaces or to the same store; each real file is walked once from the root store.
    if (existsSync(top) && !lstatSync(top).isSymbolicLink()) walk(top);
  }
  return bySize;
}

/**
 * Builds and packs every released package with the recorder, and returns what
 * each one's files take in. Leaves the packages' build output as a normal
 * build does.
 */
export async function derive(packages: ReleasePackage[]): Promise<Map<string, Recorded>> {
  const scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "critiqs-bundled-"));
  // The workspaces' own code is judged as files under packages/, not as a dependency.
  const workspaceNames = new Set<string>();
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const manifest = join(ROOT, "packages", dir, "package.json");
    if (existsSync(manifest)) workspaceNames.add(JSON.parse(readFileSync(manifest, "utf8")).name);
  }
  try {
    const logs = new Map<string, Entry[]>();
    const artifacts = new Map<string, string[]>();
    for (const pkg of packages) {
      const log = join(scratch, `${pkg.name}.log`);
      const env = { ...process.env, CRITIQS_BUILD_LOG: log, BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ""} --preload=${RECORDER}`.trim(), CRITIQS_PACKED: "" };
      const dir = join(ROOT, pkg.dir);
      if (pkg.registry === "npm") {
        const out = join(scratch, "npm");
        await mkdir(out, { recursive: true });
        await run(["npm", "pack", "--pack-destination", out], dir, env);
        artifacts.set(pkg.name, [join(out, npmTarballName(pkg.name, pkg.version))]);
      } else if (pkg.registry !== null) {
        await rm(join(dir, "release"), { recursive: true, force: true });
        await run(["bun", "run", "release:build"], dir, env);
        artifacts.set(pkg.name, (await readdir(join(dir, "release"))).map((file) => join(dir, "release", file)));
      } else {
        throw new Error(`${pkg.name} names no registry, so what it publishes can't be built.`);
      }
      const text = existsSync(log) ? await Bun.file(log).text() : "";
      logs.set(pkg.name, text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry));
    }

    // Each bundle any build made, by the hash of each of its output files.
    const bundleInputs = new Map<string, Set<string>>();
    const namesOf = (entry: Entry) => {
      if (entry.inputs === null) throw new Error(`A bundle built in ${entry.cwd} came without the bundler's list of inputs.`);
      return (entry.inputs ?? []).map((input) => packageOfPath(resolve(entry.cwd, input))).filter((name): name is string => name !== null && !workspaceNames.has(name));
    };
    for (const entries of logs.values()) for (const entry of entries) for (const hash of entry.outputs ?? []) bundleInputs.set(hash, new Set([...bundleInputs.get(hash) ?? [], ...namesOf(entry)]));

    const bySize = nodeModulesBySize();
    const derived = new Map<string, Recorded>();
    for (const pkg of packages) {
      const bundles = new Set<string>();
      const runs = new Set<string>();
      for (const entry of logs.get(pkg.name)!) {
        for (const name of namesOf(entry)) bundles.add(name);
        if (entry.command) {
          const name = commandPackage(commandWord(entry.command), entry.cwd);
          if (name !== null && !workspaceNames.has(name)) runs.add(name);
        }
      }
      for (const [index, artifact] of artifacts.get(pkg.name)!.entries()) {
        const into = join(scratch, "unpacked", pkg.name, String(index));
        for (const file of await unpack(artifact, into)) {
          const bytes = readFileSync(join(into, file));
          const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
          for (const name of bundleInputs.get(hash) ?? []) bundles.add(name);
          // A file this short holds no package's code, only something like `export {};`, which many packages also have.
          if (bytes.length < MEANINGFUL) continue;
          for (const candidate of bySize.get(bytes.length) ?? []) {
            const name = packageOfPath(candidate);
            if (name !== null && !workspaceNames.has(name) && readFileSync(candidate).equals(bytes)) bundles.add(name);
          }
        }
      }
      derived.set(pkg.name, { bundles: [...bundles].sort(), runs: [...runs].sort() });
    }
    return derived;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What the record leaves out of what each package's files take in; empty when it covers everything. */
export function missing(record: Record<string, Partial<Recorded> | undefined>, derived: Map<string, Recorded>): string[] {
  const problems: string[] = [];
  for (const [name, found] of derived) {
    for (const kind of ["bundles", "runs"] as const) {
      const listed = new Set(record[name]?.[kind] ?? []);
      const left = found[kind].filter((dependency) => !listed.has(dependency));
      if (left.length > 0) problems.push(`${name} ${kind} ${left.join(", ")}, which ${RECORD} leaves out.`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "check" && command !== "write") throw new Error("Usage: bun scripts/bundled-dependencies.ts check|write");
  const packages = await releasePackages(workingTree(ROOT));
  const derived = await derive(packages);
  const path = join(ROOT, RECORD);
  if (command === "write") {
    await Bun.write(path, `${JSON.stringify({ about: ABOUT, packages: Object.fromEntries(derived) }, null, 2)}\n`);
    console.log(`Wrote ${RECORD} for ${packages.map((pkg) => pkg.name).join(", ")}.`);
  } else {
    const record = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).packages ?? {}) : {};
    const problems = missing(record, derived);
    for (const [name, found] of derived) console.log(`${name}: bundles ${found.bundles.length} (${found.bundles.join(", ") || "none"}); runs ${found.runs.join(", ") || "nothing"}`);
    if (problems.length > 0) {
      console.error([...problems, `Run \`bun scripts/bundled-dependencies.ts write\` and commit ${RECORD}; the release notes gate then counts these as shipped.`].join("\n"));
      process.exit(1);
    }
    const extra = [...derived].filter(([name, found]) => JSON.stringify(record[name]) !== JSON.stringify(found)).map(([name]) => name);
    console.log(extra.length > 0 ? `${RECORD} covers every package, and lists more than the builds took in for ${extra.join(", ")}; \`write\` would narrow it.` : `${RECORD} matches every package's build.`);
  }
}
