// This Python package's tasks, run through bun like every other package's
// scripts: `test` runs pytest, and `release` builds the sdist and wheel into
// release/. Each uses a virtual environment in .local/venv, made with python3
// (or $PYTHON).
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const ELEMENT = join(PACKAGE, "../critiqs/dist/element.js");

/** Runs a command with its output shown, throwing when it fails. */
export async function exec(command: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  // pip and build keep their temporary files in TMPDIR; default it to .local/tmp.
  const tmp = env.TMPDIR || join(PACKAGE, ".local/tmp");
  await mkdir(tmp, { recursive: true });
  const child = Bun.spawn(command, { cwd, env: { ...env, TMPDIR: tmp }, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed in ${cwd}.`);
}

/** A virtual environment at `dir` with `requirements` installed (pip arguments); returns its python. */
export async function venv(dir: string, requirements: string[]): Promise<string> {
  const python = join(dir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) await exec([process.env.PYTHON ?? "python3", "-m", "venv", dir], PACKAGE);
  await exec([python, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", ...requirements], PACKAGE);
  return python;
}

/** Whether Critiqs's browser bundle is missing or older than the sources it's built from. */
function bundleIsStale(): boolean {
  if (!existsSync(ELEMENT)) return true;
  const built = statSync(ELEMENT).mtimeMs;
  const sources = ["critiqs/src", "react/src", "core/src"].map((dir) => join(PACKAGE, "..", dir));
  return sources.some((dir) => readdirSync(dir, { recursive: true }).some((file) => statSync(join(dir, String(file))).mtimeMs > built));
}

/**
 * Builds the sdist, then the wheel from it, into release/, building Critiqs's
 * browser bundle first when it is missing or out of date. Checks that the wheel carries this
 * package.json's version and the bundle, and that the sdist leaves out the
 * repository's .gitignore, and returns the wheel's path.
 */
export async function release(): Promise<string> {
  if (bundleIsStale()) await exec(["bun", "run", "build"], join(PACKAGE, "../critiqs"));
  const python = await venv(join(PACKAGE, ".local/venv"), ["build"]);
  const out = join(PACKAGE, "release");
  await rm(out, { recursive: true, force: true });
  await exec([python, "-m", "build", "--outdir", out, PACKAGE], PACKAGE);
  const wheel = readdirSync(out).find((file) => file.endsWith(".whl"));
  const sdist = readdirSync(out).find((file) => file.endsWith(".tar.gz"));
  if (wheel === undefined || sdist === undefined) throw new Error(`No wheel and sdist in ${out}.`);
  const { version } = await Bun.file(join(PACKAGE, "package.json")).json();
  const check = `
import sys, tarfile, zipfile
wheel, sdist, element, version = sys.argv[1:]
with tarfile.open(sdist) as archive:
    ignores = [name for name in archive.getnames() if name.endswith("/.gitignore")]
    assert not ignores, f"the sdist carries the repository's .gitignore: {ignores}"
with zipfile.ZipFile(wheel) as archive:
    bundled = [name for name in archive.namelist() if name.endswith("/static/critiqs/element.js") or name.endswith("_critiqs/static/element.js")]
    assert len(bundled) == 1, f"the wheel has no single element.js: {bundled}"
    assert archive.read(bundled[0]) == open(element, "rb").read(), "the wheel's element.js isn't the one just built"
    metadata = next(name for name in archive.namelist() if name.endswith(".dist-info/METADATA"))
    assert f"\\nVersion: {version}\\n" in archive.read(metadata).decode(), f"the wheel's version isn't {version}"
print(f"{wheel.rsplit('/', 1)[-1]}: version {version}, {bundled[0]}")
`;
  await exec([python, "-I", "-c", check, join(out, wheel), join(out, sdist), ELEMENT, version], PACKAGE);
  return join(out, wheel);
}

if (import.meta.main) {
  const [task, ...rest] = process.argv.slice(2);
  if (task === "test") {
    const python = await venv(join(PACKAGE, ".local/venv"), ["--editable", ".[test]"]);
    await exec([python, "-m", "pytest", ...rest], PACKAGE);
  } else if (task === "release") {
    await release();
  } else {
    throw new Error("Usage: bun scripts/tasks.ts test|release");
  }
}
