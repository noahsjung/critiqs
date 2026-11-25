// Prepares a local Convex deployment (`bunx convex dev`) to act as Critiqs's
// sign-in service with development sign-in, so the whole flow runs locally
// without WorkOS. Never run this against a shared deployment.
import { $ } from "bun";

const env = await Bun.file(new URL("../.env.local", import.meta.url)).text().catch(() => "");
const siteUrl = /^CONVEX_SITE_URL=(.+)$/m.exec(env)?.[1]?.trim();
if (siteUrl === undefined || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(siteUrl)) {
  console.error("Run `bunx convex dev` first; this script only configures a local deployment.");
  process.exit(1);
}

const current = (await $`bunx convex env get CRITIQS_AUTH_PRIVATE_KEY`.nothrow().quiet()).stdout.toString().trim();
if (current === "") {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
  await $`bunx convex env set CRITIQS_AUTH_PRIVATE_KEY ${jwk}`.quiet();
  console.log("Generated a local signing key.");
}
await $`bunx convex env set CRITIQS_AUTH_ISSUER ${siteUrl}`.quiet();
await $`bunx convex env set CRITIQS_DEV_SIGN_IN enabled`.quiet();
console.log(`Local sign-in is ready at ${siteUrl}/auth/start (development sign-in enabled).`);
