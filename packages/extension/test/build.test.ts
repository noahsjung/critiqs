import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The unpacked extension as `bun run build` makes it.

async function build(env: Record<string, string> = {}) {
  const out = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "critiqs-extension-build-"));
  const built = Bun.spawn(["bun", "scripts/build.ts"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, CRITIQS_TEST: "", ...env, CRITIQS_EXTENSION_OUT: out }, stderr: "pipe" });
  expect(await built.exited).toBe(0);
  return out;
}

test("a real build asks for no site at install, and its scripts are files Chrome accepts", async () => {
  const out = await build();
  try {
    const manifest = await Bun.file(join(out, "manifest.json")).json();
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.name).toBe("Critiqs");
    for (const file of ["worker.js", "page.js", "panel.js", "mockup.js"]) {
      const code = await Bun.file(join(out, file)).text();
      // Chrome refuses a content script holding a Unicode noncharacter as "isn't UTF-8 encoded".
      expect(/[﷐-﷯￾￿]/.test(code)).toBe(false);
      // Test hooks stay out of real builds.
      expect(code.includes("critiqsTest")).toBe(false);
    }
    expect(await Bun.file(join(out, "panel.html")).exists()).toBe(true);
    expect(await Bun.file(join(out, "mockup.html")).exists()).toBe(true);
    // Only the files Chrome loads: no folders the bundler left behind.
    expect((await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: out }))).filter((file) => !file.startsWith("icons/")).sort()).toEqual(["manifest.json", "mockup.html", "mockup.js", "page.js", "panel.html", "panel.js", "worker.js"]);
    expect(await Bun.file(join(out, "icons/128.png")).exists()).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 60_000);

test("only a test build grants sites at install, and names itself so", async () => {
  const out = await build({ CRITIQS_TEST: "1", CRITIQS_TEST_HOSTS: "https://*.critiqs.test/*" });
  try {
    const manifest = await Bun.file(join(out, "manifest.json")).json();
    expect(manifest.host_permissions).toEqual(["https://*.critiqs.test/*"]);
    expect(manifest.name).toBe("Critiqs (test build)");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 60_000);

const sharedVersion = (await Bun.file(join(import.meta.dir, "../../critiqs/package.json")).json()).version as string;

test("every build takes the Critiqs packages' shared version; the development build keeps its key", async () => {
  expect((await Bun.file(join(import.meta.dir, "../static/manifest.json")).json()).version).toBeUndefined();
  const out = await build();
  try {
    const manifest = await Bun.file(join(out, "manifest.json")).json();
    expect(manifest.version).toBe(sharedVersion);
    expect(typeof manifest.key).toBe("string");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 60_000);

test("the Chrome Web Store's build has no development key and refuses a test build or another backend", async () => {
  const out = await build({ CRITIQS_STORE: "1" });
  try {
    const manifest = await Bun.file(join(out, "manifest.json")).json();
    expect(manifest.key).toBeUndefined();
    expect(manifest.name).toBe("Critiqs");
    expect(manifest.version).toBe(sharedVersion);
    expect(manifest.host_permissions).toBeUndefined();
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  for (const env of [{ CRITIQS_TEST: "1" }, { CRITIQS_BACKEND: "http://127.0.0.1:3210" }]) {
    const refused = Bun.spawn(["bun", "scripts/build.ts"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, CRITIQS_STORE: "1", ...env, CRITIQS_EXTENSION_OUT: join(process.env.TMPDIR ?? tmpdir(), "critiqs-refused") }, stderr: "pipe" });
    expect(await refused.exited).not.toBe(0);
  }
}, 60_000);

test("bun run package zips the store's build with the manifest at the root, the same bytes each time", async () => {
  const release = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "critiqs-extension-release-"));
  try {
    const pack = async () => {
      const packed = Bun.spawn(["bun", "scripts/package.ts"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, CRITIQS_RELEASE_DIR: release }, stdout: "pipe", stderr: "pipe" });
      expect(await packed.exited).toBe(0);
      return new Uint8Array(await Bun.file(join(release, `critiqs-extension-${sharedVersion}.zip`)).arrayBuffer());
    };
    const first = await pack();
    expect(Buffer.from(await pack()).equals(Buffer.from(first))).toBe(true);
    const listed = Bun.spawnSync(["unzip", "-Z1", join(release, `critiqs-extension-${sharedVersion}.zip`)]).stdout.toString().trim().split("\n").sort();
    expect(listed).toEqual(["icons/128.png", "icons/16.png", "icons/32.png", "icons/48.png", "manifest.json", "mockup.html", "mockup.js", "page.js", "panel.html", "panel.js", "worker.js"]);
    const manifest = JSON.parse(Bun.spawnSync(["unzip", "-p", join(release, `critiqs-extension-${sharedVersion}.zip`), "manifest.json"]).stdout.toString());
    expect(manifest.key).toBeUndefined();
    expect(manifest.version).toBe(sharedVersion);
  } finally {
    await rm(release, { recursive: true, force: true });
  }
}, 120_000);
