import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProxyAssets } from "../src/server.ts";

// Builds the two scripts the proxy puts in every page: the runtime shim and
// the page layer (with React, as the page layer needs it). Each is named by a
// hash of its contents, so a frame host can cache it for as long as it lives.

const root = fileURLToPath(new URL("../runtime/", import.meta.url));

async function build(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${root}${entry}`],
    target: "browser",
    format: "iife",
    minify: true,
    jsx: { runtime: "automatic", development: false },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new AggregateError(result.logs, `${entry} didn't build.`);
  return await result.outputs[0]!.text();
}

export async function buildAssets(): Promise<ProxyAssets> {
  const [runtime, layer] = await Promise.all([build("shim.ts"), build("layer.ts")]);
  const named = (name: string, body: string) => ({ file: `${name}.${createHash("sha256").update(body).digest("hex").slice(0, 16)}.js`, body });
  return { runtime: named("runtime", runtime), layer: named("layer", layer) };
}

if (import.meta.main) {
  const assets = await buildAssets();
  for (const asset of [assets.runtime, assets.layer]) console.log(`${asset.file}\t${asset.body.length} bytes`);
}
