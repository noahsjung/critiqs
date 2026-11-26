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
    for (const file of ["worker.js", "page.js", "panel.js"]) {
      const code = await Bun.file(join(out, file)).text();
      // Chrome refuses a content script holding a Unicode noncharacter as "isn't UTF-8 encoded".
      expect(/[﷐-﷯￾￿]/.test(code)).toBe(false);
      // Test hooks stay out of real builds.
      expect(code.includes("critiqsTest")).toBe(false);
    }
    expect(await Bun.file(join(out, "panel.html")).exists()).toBe(true);
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
