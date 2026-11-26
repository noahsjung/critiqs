// `bun scripts/gem.ts test`: the gem's minitest suite, after the setup
// adapter's tests, whose layouts it compiles with Rails's own ERB handler.
// `bun scripts/gem.ts build`: release/critiqs-rails-<version>.gem, for the
// release workflow to publish.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, run } from "../../../scripts/consumer-kit.ts";
import { buildGem, GEM_DIR, ruby, vendorElement } from "./ruby.ts";

const task = process.argv[2];
if (task !== "test" && task !== "build") throw new Error("Usage: bun scripts/gem.ts test|build");

if (task === "test") {
  const layouts = join(GEM_DIR, "tmp/adapter-layouts");
  await rm(layouts, { recursive: true, force: true });
  await run(["bun", "test", "test/frameworks-rails.test.ts"], join(ROOT, "packages/critiqs"), { ...process.env, CRITIQS_ERB_OUT: layouts });
}

const env = await ruby();
try {
  if (task === "test") {
    await vendorElement();
    await env.run(["bundle", "install", "--quiet"], GEM_DIR);
    process.stdout.write(await env.run(["bundle", "exec", "rake", "test"], GEM_DIR));
  } else {
    console.log(`Built ${await buildGem(env)}`);
  }
} finally {
  await env.stop();
}
