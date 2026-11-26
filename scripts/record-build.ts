// Preloaded into every Bun process of a package's build by
// bundled-dependencies.ts (through BUN_OPTIONS), it appends one JSON line to
// $CRITIQS_BUILD_LOG for each bundle Bun builds (the bundler's own list of
// input files, and a hash of each output file) and each command the build
// starts. It changes nothing the build produces.
import { appendFileSync } from "node:fs";

const log = process.env.CRITIQS_BUILD_LOG;
if (log) {
  const write = (entry: object) => appendFileSync(log, `${JSON.stringify({ cwd: process.cwd(), ...entry })}\n`);
  const build = Bun.build;
  Bun.build = (async (config: Bun.BuildConfig) => {
    const result = await build({ ...config, metafile: true });
    const outputs = await Promise.all(result.outputs.map(async (output) => new Bun.CryptoHasher("sha256").update(await output.arrayBuffer()).digest("hex")));
    write({ inputs: result.metafile ? Object.keys(result.metafile.inputs) : null, outputs });
    return result;
  }) as typeof Bun.build;
  const commandOf = (args: unknown[]) => (Array.isArray(args[0]) ? args[0] : (args[0] as { cmd?: string[] })?.cmd ?? []) as string[];
  const spawn = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    write({ command: commandOf(args) });
    return spawn(...args);
  }) as typeof Bun.spawn;
  const spawnSync = Bun.spawnSync;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    write({ command: commandOf(args) });
    return spawnSync(...args);
  }) as typeof Bun.spawnSync;
}
