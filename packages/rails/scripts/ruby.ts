// Runs Ruby for the gem's scripts: the computer's own Ruby when it has one
// (CI installs Ruby 3.4), otherwise the official ruby:3.4 Docker image, with
// the repository and any scratch folders mounted at their own paths so every
// path means the same inside and out. Gems persist in a Docker volume between
// runs.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, run } from "../../../scripts/consumer-kit.ts";

export const GEM_DIR = fileURLToPath(new URL("../", import.meta.url));
const IMAGE = "ruby:3.4";
const GEM_VOLUME = "critiqs-rails-gems";

export interface Ruby {
  /** Runs a command to completion, returning its output; throws with everything it printed. */
  run(command: string[], cwd: string, env?: Record<string, string>): Promise<string>;
  /** Where a server listening on `port` inside the Ruby environment is reachable from this computer. */
  url(port: number): Promise<string>;
  /** The address servers bind to, so this computer can reach them. */
  bind: string;
  stop(): Promise<void>;
}

/** The computer's Ruby when `ruby` and `bundle` are on PATH, else a Docker container. `mounts` are folders the commands use besides the repository. */
export async function ruby(mounts: string[] = [], { ports = [] as number[] } = {}): Promise<Ruby> {
  if (Bun.which("ruby") !== null && Bun.which("bundle") !== null) return hostRuby();
  return dockerRuby(mounts, ports);
}

function hostRuby(): Ruby {
  return {
    run: (command, cwd, env = {}) => run(command, cwd, { ...process.env, ...env }),
    url: async (port) => `http://127.0.0.1:${port}`,
    bind: "127.0.0.1",
    stop: async () => {},
  };
}

async function dockerRuby(mounts: string[], ports: number[]): Promise<Ruby> {
  if (Bun.which("docker") === null) throw new Error("critiqs-rails's scripts need Ruby 3.3 or later, or Docker to run the ruby:3.4 image.");
  const name = `critiqs-rails-${process.pid}-${Date.now()}`;
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const home = "/usr/local/bundle/home";
  const volumes = [ROOT, ...mounts].flatMap((dir) => ["-v", `${dir}:${dir}`]);
  const published = ports.flatMap((port) => ["-p", `127.0.0.1::${port}`]);
  await run(
    ["docker", "run", "-d", "--rm", "--name", name, "--user", `${uid}:${gid}`, "-e", `HOME=${home}`, "-v", `${GEM_VOLUME}:/usr/local/bundle`, ...volumes, ...published, IMAGE, "sleep", "infinity"],
    ROOT,
  );
  const exec = (command: string[], cwd: string, env: Record<string, string>) => [
    "docker", "exec", "-w", cwd,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    name, "sh", "-c", 'mkdir -p "$HOME" && exec "$@"', "sh", ...command,
  ];
  return {
    run: (command, cwd, env = {}) => run(exec(command, cwd, env), ROOT),
    async url(port) {
      const [address] = (await run(["docker", "port", name, String(port)], ROOT)).trim().split("\n");
      return `http://${address}`;
    },
    bind: "0.0.0.0",
    async stop() {
      await run(["docker", "rm", "-f", name], ROOT).catch(() => {});
    },
  };
}

/** Builds the critiqs package and copies its `critiqs/element` bundle into the gem's assets, so the gem never carries an older build. */
export async function vendorElement(): Promise<void> {
  const built = join(ROOT, "packages/critiqs/dist/element.js");
  await run(["bun", "run", "build"], join(ROOT, "packages/critiqs"));
  await mkdir(join(GEM_DIR, "app/assets/javascripts/critiqs"), { recursive: true });
  await copyFile(built, join(GEM_DIR, "app/assets/javascripts/critiqs/element.js"));
}

/** The gem's version: package.json's, which the release group sets. */
export async function gemVersion(): Promise<string> {
  return (await Bun.file(join(GEM_DIR, "package.json")).json()).version;
}

/** Builds release/critiqs-rails-<version>.gem, the only file there, with the current bundle inside; returns its path. */
export async function buildGem(env: Ruby): Promise<string> {
  await vendorElement();
  const gem = join(GEM_DIR, `release/critiqs-rails-${await gemVersion()}.gem`);
  await rm(join(GEM_DIR, "release"), { recursive: true, force: true });
  await mkdir(join(GEM_DIR, "release"), { recursive: true });
  await env.run(["gem", "build", "critiqs-rails.gemspec", "--output", gem], GEM_DIR);
  return gem;
}
