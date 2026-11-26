// Packages the extension for the Chrome Web Store: the store's build
// (CRITIQS_STORE=1: Critiqs Cloud, no development key) zipped as
// release/critiqs-extension-<version>.zip, with the manifest at the zip's
// root as the store asks. The same files make the same zip byte for byte, so
// a reviewer can rebuild it and compare. Publishing stays by hand: upload the
// zip in the Chrome Web Store's developer dashboard, with the listing text and
// permission justifications in store/listing.md.
import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const directory = fileURLToPath(new URL("../", import.meta.url));
// CRITIQS_RELEASE_DIR puts it elsewhere, as the tests do.
const release = process.env.CRITIQS_RELEASE_DIR ?? join(directory, "release");
const built = join(release, "store");
await rm(built, { recursive: true, force: true });
const env: Record<string, string | undefined> = { ...process.env, CRITIQS_STORE: "1", CRITIQS_EXTENSION_OUT: built };
delete env.CRITIQS_TEST;
delete env.CRITIQS_BACKEND;
const build = Bun.spawn(["bun", "scripts/build.ts"], { cwd: directory, env, stderr: "inherit" });
if ((await build.exited) !== 0) throw new Error("The store's build failed.");

const manifest = await Bun.file(join(built, "manifest.json")).json();
if ("key" in manifest) throw new Error("The store's build still has the development key.");

/** Every file under `root`, by its path inside the zip, in a fixed order. */
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

/** A zip archive of `paths` under `root`, deflated, with a fixed date so the same files give the same bytes. */
async function zip(root: string, paths: string[]): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 1980-01-01 00:00, the earliest date a zip can hold.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const path of paths) {
    const data = new Uint8Array(await Bun.file(join(root, path)).arrayBuffer());
    const packed = deflateRawSync(data, { level: 9 });
    const name = new TextEncoder().encode(path);
    const sum = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names in UTF-8
    local.setUint16(8, 8, true); // deflate
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 8, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, sum, true);
    entry.setUint32(20, packed.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, packed);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + packed.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, paths.length, true);
  end.setUint16(10, paths.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

const paths = await files(built);
const out = join(release, `critiqs-extension-${manifest.version}.zip`);
await Bun.write(out, await zip(built, paths));
console.log(`${relative(process.cwd(), out)}: Critiqs ${manifest.version} for the Chrome Web Store, ${paths.length} files:`);
for (const path of paths) console.log(`  ${path}`);
