import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

const manifest = await Bun.file(new URL("../static/manifest.json", import.meta.url)).json();

/** The ID Chrome gives an extension with this manifest key, as `CRITIQS_EXTENSION_IDS` lists it. */
export const DEVELOPMENT_ID = "pfdpnmmiemejphfghkalofichdcoandg";

test("installing asks for no site access: only the click's access, the side panel, scripts, and storage", () => {
  expect(manifest.manifest_version).toBe(3);
  expect([...manifest.permissions].sort()).toEqual(["activeTab", "scripting", "sidePanel", "storage"]);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  // Sites are asked for one at a time, when the person turns on "Show comments here automatically".
  expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
});

test("the icon doesn't open the side panel by itself, which would keep Chrome from granting the page", () => {
  expect(manifest.side_panel).toBeUndefined();
  expect(manifest.background).toEqual({ service_worker: "worker.js" });
  expect(manifest.action.default_popup).toBeUndefined();
});

test("the manifest key gives the development build a stable ID", () => {
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  const id = digest.slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  expect(id).toBe(DEVELOPMENT_ID);
});

test("Chrome before 121 isn't supported: the screenshot check reads Tab.lastAccessed, which it lacks", () => {
  expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(121);
});
