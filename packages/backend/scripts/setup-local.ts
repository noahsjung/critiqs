// Prepares a local Convex deployment (`bunx convex dev`) to act as Critiqs's
// sign-in service with development sign-in, so the whole flow runs locally
// without WorkOS. Never run this against a shared deployment.
import { utimes } from "node:fs/promises";
import { $ } from "bun";

const env = await Bun.file(new URL("../.env.local", import.meta.url)).text().catch(() => "");
const local = (url: string | undefined): url is string => url !== undefined && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
const deploymentUrl = /^CONVEX_URL=(.+)$/m.exec(env)?.[1]?.trim();
const siteUrl = /^CONVEX_SITE_URL=(.+)$/m.exec(env)?.[1]?.trim();
if (!local(deploymentUrl) || !local(siteUrl)) {
  console.error("Run `bunx convex dev` first; this script only configures a local deployment.");
  process.exit(1);
}

// A deployment `convex dev` has only just configured may not answer yet.
const deadline = Date.now() + 60_000;
while (!(await fetch(`${deploymentUrl}/version`).then((r) => r.ok, () => false))) {
  if (Date.now() > deadline) {
    console.error(`The local deployment at ${deploymentUrl} didn't answer within 60 seconds. Keep \`bunx convex dev\` running, then run this again.`);
    process.exit(1);
  }
  await Bun.sleep(500);
}

/**
 * Runs `convex env <args>`. While `convex dev` pushes, the deployment can turn
 * a change away with a 503 (OptimisticConcurrencyControlFailure); that is
 * tried again, up to 10 times. Any other failure ends the script.
 */
async function convexEnv(...args: string[]): Promise<string> {
  // Names the command without its value: the value can be the signing key.
  const command = `convex env ${args.slice(0, 2).join(" ")}`;
  for (let attempt = 1; ; attempt++) {
    const result = await $`bunx convex env ${args}`.nothrow().quiet();
    if (result.exitCode === 0) return result.stdout.toString().trim();
    const output = `${result.stdout}${result.stderr}`.trim();
    if (attempt === 10 || !/OptimisticConcurrencyControlFailure|\b503\b/.test(output)) {
      console.error(`\`${command}\` failed${attempt > 1 ? ` ${attempt} times` : ""}:\n${output}`);
      process.exit(1);
    }
    await Bun.sleep(1_000);
  }
}

// `env get` prints nothing for a variable that isn't set; a failure ends the
// script above, so it never replaces a working key.
if ((await convexEnv("get", "CRITIQS_AUTH_PRIVATE_KEY")) === "") {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
  await convexEnv("set", "CRITIQS_AUTH_PRIVATE_KEY", jwk);
  console.log("Generated a local signing key.");
}
await convexEnv("set", "CRITIQS_AUTH_ISSUER", siteUrl);
await convexEnv("set", "CRITIQS_DEV_SIGN_IN", "enabled");

// `convex dev` retries a push that failed for want of these settings only
// when they change after it starts watching them, so settings that land just
// after the failure go unseen and it waits for a file change. Give it one: it
// pushes again, with the settings, whatever state it is in.
const now = new Date();
await utimes(new URL("../convex/auth.config.ts", import.meta.url), now, now);
console.log(`Local sign-in is ready at ${siteUrl}/auth/start once \`convex dev\` prints "Convex functions ready" (development sign-in enabled).`);
