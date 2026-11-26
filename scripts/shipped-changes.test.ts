// The release notes gate against this repository's real packages, lockfile,
// and workflows: each case is one commit on top of HEAD, made in Git's object
// store without touching the working tree or any branch, then checked the way
// CI checks a pull request. A case names what the gate must answer:
//   free  - passes with no note (a dependency update nothing ships);
//   note  - needs a note, and a no-release note is enough;
//   patch - ships in a Critiqs package: refused with no note, and refused
//           beside a no-release note.
// The cases are the ways an update could reach users without a note: the
// lockfile, manifests, workflows, and files the gate never classified.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "./release.ts";

setDefaultTimeout(60_000);
const root = new URL("../", import.meta.url).pathname;
const scratch = await mkdtemp(join(tmpdir(), "critiqs-shipped-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
async function git(args: string[], { env = {}, input }: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: root, env: { ...process.env, ...identity, ...env }, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed (${status}):\n${stderr}`);
  return stdout;
}
const id = async (args: string[], options?: Parameters<typeof git>[1]) => (await git(args, options)).trim();

const head = await id(["rev-parse", "HEAD"]);
const show = (path: string) => git(["show", `${head}:${path}`]);
let commits = 0;

type Edit = string | null | ((text: string) => string);
/** A commit on top of HEAD with these files replaced, edited, or (null) removed. */
async function commit(edits: Record<string, Edit>): Promise<string> {
  const env = { GIT_INDEX_FILE: join(scratch, `index-${commits++}`) };
  await git(["read-tree", head], { env });
  for (const [path, edit] of Object.entries(edits)) {
    if (edit === null) {
      await git(["update-index", "--force-remove", "--", path], { env });
      continue;
    }
    const text = typeof edit === "string" ? edit : edit(await show(path));
    const blob = await id(["hash-object", "-w", "--stdin"], { input: text });
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
  }
  return id(["commit-tree", await id(["write-tree"], { env }), "-p", head, "-m", "case"], { env });
}

/** Replaces `from` with `to` exactly once, so a case fails loudly when the repository no longer has that shape. */
const swap = (from: string | RegExp, to: string) => (text: string) => {
  const count = typeof from === "string" ? text.split(from).length - 1 : [...text.matchAll(new RegExp(from.source, `${from.flags}g`))].length;
  if (count !== 1) throw new Error(`expected one ${from} in the file, found ${count}`);
  return text.replace(from, to);
};
const all = (...edits: ((text: string) => string)[]) => (text: string) => edits.reduce((value, edit) => edit(value), text);

/** bun.lock: `name`'s resolved entry with its version, registry, or integrity changed. */
const lockEntry = (name: string) => new RegExp(`^(    "${name.replace(/[/@.]/g, "\\$&")}": \\["${name.replace(/[/@.]/g, "\\$&")}@)([^"]+)(", ")([^"]*)(", .*"sha512-)([^"]+)("\\],)$`, "m");
const bumpLock = (name: string) => swap(lockEntry(name), "$1$2-next$3$4$5$6$7");
const reHashLock = (name: string) => swap(lockEntry(name), "$1$2$3$4$5AAAA$6$7");
const moveLock = (name: string) => swap(lockEntry(name), "$1$2$3https://registry.example.com/$5$6$7");
const manifestEdit = (edit: (manifest: Record<string, any>) => void) => (text: string) => {
  const manifest = JSON.parse(text);
  edit(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

const noRelease = { ".changeset/case-no-release.md": "---\n---\n\nNothing ships.\n" };
const patch = (...names: string[]) => ({ ".changeset/case-patch.md": `---\n${names.map((name) => `"${name}": patch`).join("\n")}\n---\n\nUpdate.\n` });
/** The workflow line that pins `action`, in `file`. */
const usesLine = async (file: string, action: string) => (await show(file)).match(new RegExp(`^.*uses: ${action}@[0-9a-f]{40}.*$`, "m"))![0];
const otherSha = "0123456789abcdef0123456789abcdef01234567";

type Expect = "free" | "note" | "patch";
const cases: [string, Record<string, Edit>, Expect, string[]?][] = [
  // Item 1: a lockfile change to code a package bundles, though users also install it.
  ["bun.lock: convex's version only (critiqs bundles convex into dist)", { "bun.lock": bumpLock("convex") }, "patch", ["critiqs"]],
  ["bun.lock: convex's integrity hash only", { "bun.lock": reHashLock("convex") }, "patch", ["critiqs"]],
  ["bun.lock: convex's registry only", { "bun.lock": moveLock("convex") }, "patch", ["critiqs"]],
  // The reviewer's other lockfile cases.
  ["bun.lock: scheduler, bundled with react-dom", { "bun.lock": bumpLock("scheduler") }, "patch", ["critiqs"]],
  ["bun.lock: eventsource-parser, deep under the AI SDK", { "bun.lock": bumpLock("eventsource-parser") }, "patch", ["critiqs"]],
  ["bun.lock: @ai-sdk/provider-utils, deep under the AI SDK", { "bun.lock": bumpLock("@ai-sdk/provider-utils") }, "patch", ["critiqs"]],
  ["bun.lock: typescript, which the builds run", { "bun.lock": bumpLock("typescript") }, "patch", ["critiqs-angular"]],
  ["bun.lock: @sveltejs/package, the Svelte build", { "bun.lock": bumpLock("@sveltejs/package") }, "patch", ["critiqs-svelte"]],
  ["bun.lock: react's registry", { "bun.lock": moveLock("react") }, "patch", ["critiqs"]],
  ["bun.lock: react's integrity", { "bun.lock": reHashLock("react") }, "patch", ["critiqs"]],
  ["bun.lock: esbuild, which convex's own command uses on the user's machine", { "bun.lock": bumpLock("esbuild") }, "free"],
  // Manifests.
  ["a bundled workspace's range: workspace:* → workspace:^", { "packages/critiqs/package.json": manifestEdit((m) => { m.devDependencies["@critiqs/server"] = "workspace:^"; }) }, "patch"],
  ["a peer range of critiqs-vue", { "packages/vue/package.json": manifestEdit((m) => { m.peerDependencies.vue = "^3.4.0"; }) }, "patch", ["critiqs-vue"]],
  ["a new optional dependency of critiqs-angular", { "packages/angular/package.json": manifestEdit((m) => { m.optionalDependencies = { "left-pad": "^1.3.0" }; }) }, "patch", ["critiqs-angular"]],
  ["a new peer dependency of the private @critiqs/server", { "packages/server/package.json": manifestEdit((m) => { m.peerDependencies = { "left-pad": "^1.3.0" }; }) }, "patch", ["critiqs"]],
  ["convex moved from critiqs's dependencies to its devDependencies", { "packages/critiqs/package.json": manifestEdit((m) => { m.devDependencies.convex = m.dependencies.convex; delete m.dependencies.convex; }) }, "patch", ["critiqs"]],
  ["critiqs's convex range widened, not bumped", { "packages/critiqs/package.json": manifestEdit((m) => { m.dependencies.convex = ">=1.46.0"; }) }, "patch", ["critiqs"]],
  ["the backend's convex range, which critiqs bundles though its users install convex", { "packages/backend/package.json": manifestEdit((m) => { m.dependencies.convex = "^1.51.0"; }) }, "patch", ["critiqs"]],
  ["root overrides only", { "package.json": manifestEdit((m) => { m.overrides = { react: "19.3.1" }; }) }, "note"],
  ["root resolutions only", { "package.json": manifestEdit((m) => { m.resolutions = { react: "19.3.1" }; }) }, "note"],
  ["root overrides with the lockfile change they make", { "package.json": manifestEdit((m) => { m.overrides = { convex: "1.51.0" }; }), "bun.lock": bumpLock("convex") }, "patch", ["critiqs"]],
  ["a patch to bundled code: patch file, root patchedDependencies, and bun.lock", { "patches/react.patch": "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-a\n+b\n", "package.json": manifestEdit((m) => { m.patchedDependencies = { "react@19.3.0": "patches/react.patch" }; }), "bun.lock": swap(/^  "workspaces": \{/m, '  "patchedDependencies": {\n    "react@19.3.0": "patches/react.patch",\n  },\n  "workspaces": {') }, "patch", ["critiqs"]],
  ["bun.lock's patchedDependencies only, with no patch file", { "bun.lock": swap(/^  "workspaces": \{/m, '  "patchedDependencies": {\n    "react@19.3.0": "patches/react.patch",\n  },\n  "workspaces": {') }, "patch", ["critiqs"]],
  ["bun.lock's trustedDependencies, which lets an install script run", { "bun.lock": swap(/^  "workspaces": \{/m, '  "trustedDependencies": ["esbuild"],\n  "workspaces": {') }, "note"],
  ["bun.lock's overrides only", { "bun.lock": swap(/^  "workspaces": \{/m, '  "overrides": {\n    "react": "19.3.1",\n  },\n  "workspaces": {') }, "note"],
  ["bun.lock's record of critiqs's convex range only", { "bun.lock": swap(/("packages\/critiqs": \{[\s\S]*?"convex": )"[^"]+"/, '$1"^1.51.0"') }, "patch", ["critiqs"]],
  ["bun.lock's record of a workspace's name", { "bun.lock": swap('"name": "critiqs",', '"name": "critiqs-renamed",') }, "note"],
  ["bun.lock that can't be read", { "bun.lock": (text) => `${text}\n}}}` }, "patch"],
  ["critiqs's files list, with a types bump", { "packages/critiqs/package.json": manifestEdit((m) => { m.files.push("src"); m.devDependencies["@types/react"] = "^19.9.0"; }) }, "patch"],
  ["critiqs's exports, with a types bump", { "packages/critiqs/package.json": manifestEdit((m) => { m.exports = { ...m.exports, "./x": "./dist/x.js" }; m.devDependencies["@types/react"] = "^19.9.0"; }) }, "patch"],
  ["critiqs's build script, with a types bump", { "packages/critiqs/package.json": manifestEdit((m) => { m.scripts.build = "bun scripts/build.ts --other"; m.devDependencies["@types/react"] = "^19.9.0"; }) }, "patch"],
  ["critiqs's engines, with a types bump", { "packages/critiqs/package.json": manifestEdit((m) => { m.engines = { node: ">=24" }; m.devDependencies["@types/react"] = "^19.9.0"; }) }, "patch"],
  ["the root postinstall script, with a typescript bump", { "package.json": manifestEdit((m) => { m.scripts.postinstall = "node evil.js"; }), "bun.lock": bumpLock("typescript") }, "patch", ["critiqs-angular"]],
  // The record of what each package bundles.
  ["convex left out of the record beside its update", { "scripts/bundled-dependencies.json": (text) => text.replace(/"convex",?\s*/g, ""), "bun.lock": bumpLock("convex") }, "patch", ["critiqs"]],
  ["the record removed beside an update of something nothing bundles", { "scripts/bundled-dependencies.json": null, "bun.lock": bumpLock("esbuild") }, "patch"],
  // New, removed, and other workspaces' dependencies.
  ["a new dependency under the AI SDK beside its update", { "bun.lock": all(swap(/("ai": \["ai@[^"]+", "", \{ "dependencies": \{ )/, '$1"brand-new-dependency": "1.0.0", '), swap(/^  "packages": \{\n/m, '  "packages": {\n    "brand-new-dependency": ["brand-new-dependency@1.0.0", "", {}, "sha512-AAAA"],\n')) }, "patch", ["critiqs"]],
  ["a dependency removed from react-dom", { "bun.lock": all(swap('"react-dom@19.3.0", "", { "dependencies": { "scheduler": "^0.28.0" }, ', '"react-dom@19.3.0", "", { '), swap(lockEntry("scheduler"), "")) }, "patch", ["critiqs"]],
  ["the website's react range and the react it resolves, which critiqs also bundles", { "apps/web/package.json": manifestEdit((m) => { m.dependencies.react = "^19.3.1"; }), "bun.lock": bumpLock("react") }, "patch", ["critiqs"]],
  ["a development tool added to the website", { "apps/web/package.json": manifestEdit((m) => { m.devDependencies["left-pad"] = "^1.3.0"; }), "bun.lock": all(swap(/("apps\/web": \{[\s\S]*?"devDependencies": \{\n)/, '$1        "left-pad": "^1.3.0",\n'), swap(/^  "packages": \{\n/m, '  "packages": {\n    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-AAAA"],\n')) }, "free"],
  ["@types/node in the backend's devDependencies", { "packages/backend/package.json": manifestEdit((m) => { m.devDependencies["@types/node"] = "^26.0.0"; }) }, "free"],
  ["@types/react in critiqs-react's devDependencies", { "packages/react/package.json": manifestEdit((m) => { m.devDependencies["@types/react"] = "^19.9.0"; }) }, "free"],
  ["site-src's own lockfile", { "site-src/bun.lock": (text) => `${text}\n` }, "free"],
  // Files the gate has never classified, beside an update that ships nothing.
  ["a new bunfig.toml beside a types bump", { "bunfig.toml": '[install]\nregistry = "https://registry.example.com/"\n', "packages/backend/package.json": manifestEdit((m) => { m.devDependencies["@types/node"] = "^26.0.0"; }) }, "note"],
  ["a new .npmrc beside a types bump", { ".npmrc": "registry=https://registry.example.com/\n", "packages/backend/package.json": manifestEdit((m) => { m.devDependencies["@types/node"] = "^26.0.0"; }) }, "note"],
  ["Dependabot's configuration beside a types bump", { ".github/dependabot.yml": "version: 2\nupdates: []\n", "packages/backend/package.json": manifestEdit((m) => { m.devDependencies["@types/node"] = "^26.0.0"; }) }, "note"],
  ["a new workflow", { ".github/workflows/other.yml": "name: Other\non: push\npermissions: {}\njobs: {}\n" }, "note"],
];

/** Workflow cases: each changes the line pinning an action in a workflow. */
const workflowCases: [string, string, (line: string) => string, Expect][] = [
  ["CI: the same action at another commit", ".github/workflows/ci.yml", (line) => line.replace(/@[0-9a-f]{40} # v[\d.]+/, `@${otherSha} # v9.9.9`), "free"],
  ["CI: the same action, only its version comment", ".github/workflows/ci.yml", (line) => line.replace(/ # v[\d.]+/, " # v4.4.1"), "free"],
  ["CI: another publisher's action at a commit", ".github/workflows/ci.yml", (line) => line.replace(/uses: [^/]+\//, "uses: someone-else/"), "note"],
  ["CI: another action in the same repository", ".github/workflows/ci.yml", (line) => line.replace(/uses: ([^@]+)@/, "uses: $1/sub@"), "note"],
  ["CI: a commit pin moved to a tag", ".github/workflows/ci.yml", (line) => line.replace(/@[0-9a-f]{40} # (v[\d.]+)/, "@$1"), "note"],
  ["CI: a Docker image instead", ".github/workflows/ci.yml", (line) => line.replace(/uses: .*$/, "uses: docker://example/uploader:latest"), "note"],
  ["CI: the pin bump with a command after it on the line", ".github/workflows/ci.yml", (line) => line.replace(/@[0-9a-f]{40} # v[\d.]+/, `@${otherSha} # v9.9.9 && curl example.com`), "note"],
  ["Publish: the same action at another commit", ".github/workflows/publish.yml", (line) => line.replace(/@[0-9a-f]{40} # v[\d.]+/, `@${otherSha} # v9.9.9`), "note"],
  ["Publish: another publisher's setup-bun", ".github/workflows/publish.yml", (line) => line.replace("oven-sh/", "someone-else/"), "note"],
  ["Release: the same action at another commit", ".github/workflows/release.yml", (line) => line.replace(/@[0-9a-f]{40} # v[\d.]+/, `@${otherSha} # v9.9.9`), "note"],
];

async function expectAnswer(name: string, edits: Record<string, Edit>, expected: Expect, packages: string[] = []) {
  const bare = await check(root, head, await commit(edits));
  const text = bare.messages.join("\n");
  if (expected === "free") {
    expect(text).toMatch(/No release note needed/);
    expect(bare.ok).toBe(true);
    return;
  }
  expect(bare.ok).toBe(false);
  expect(text).toMatch(/^Add a release note/);
  const withNoRelease = await check(root, head, await commit({ ...edits, ...noRelease }));
  if (expected === "note") {
    expect(text).not.toMatch(/ship in/);
    expect(withNoRelease.messages.join("\n")).toMatch(/case-no-release\.md: no release/);
    expect(withNoRelease.ok).toBe(true);
    return;
  }
  expect(withNoRelease.messages.join("\n")).toMatch(/no-release note does not cover/);
  expect(withNoRelease.ok).toBe(false);
  // A pull request of dependency updates only is told which packages they ship in; one with other changes too gets the shipped updates listed beside its no-release note.
  if (/These dependency updates ship in/.test(text)) for (const pkg of packages) expect(text).toMatch(new RegExp(`ship in [^\\n]*\\b${pkg}\\b`));
  else if (packages.length > 0) expect(withNoRelease.messages.join("\n")).toMatch(/does not cover them[^\n]*\n  (bun\.lock|packages\/)/);
  const withPatch = await check(root, head, await commit({ ...edits, ...patch("critiqs") }));
  expect(withPatch.messages.join("\n")).toMatch(/case-patch\.md: critiqs patch/);
  expect(withPatch.ok).toBe(true);
}

describe("the release notes gate on this repository", () => {
  for (const [name, edits, expected, packages] of cases) test(`${expected}: ${name}`, () => expectAnswer(name, edits, expected, packages));
  for (const [name, file, change, expected] of workflowCases) {
    test(`${expected}: ${name}`, async () => {
      const line = await usesLine(file, file.endsWith("publish.yml") ? "oven-sh/setup-bun" : "actions/checkout");
      // Dependabot changes every line that pins the action.
      await expectAnswer(name, { [file]: (text) => text.replaceAll(line, change(line)) }, expected);
    });
  }
  test("note: CI: two steps' actions swapped", async () => {
    const [checkout, bun] = [await usesLine(".github/workflows/ci.yml", "actions/checkout"), await usesLine(".github/workflows/ci.yml", "oven-sh/setup-bun")];
    const swapped = (text: string) => text.replaceAll(checkout, "\0").replaceAll(bun, checkout).replaceAll("\0", bun);
    await expectAnswer("swapped", { ".github/workflows/ci.yml": swapped }, "note");
  });

  // People's pull requests: judged as before.
  const people: [string, Record<string, Edit>, Expect][] = [
    ["shipped source", { "packages/critiqs/src/index.ts": (text) => `${text}\n// changed\n` }, "patch"],
    ["documentation", { "docs/releasing.md": (text) => `${text}\nMore.\n` }, "note"],
    ["a package's consumer check", { "packages/nuxt/scripts/check-consumer.ts": (text) => `${text}\n// changed\n` }, "note"],
    ["a package's build script", { "packages/critiqs/scripts/build.ts": (text) => `${text}\n// changed\n` }, "patch"],
    ["the gem's build script", { "packages/rails/scripts/gem.ts": (text) => `${text}\n// changed\n` }, "patch"],
    ["the website", { "apps/web/src/main.tsx": (text) => `${text}\n// changed\n` }, "note"],
    ["shipped source beside a dependency bump", { "packages/react/src/index.ts": (text) => `${text}\n// changed\n`, "bun.lock": bumpLock("esbuild") }, "patch"],
    ["a root release script", { "scripts/check-package.ts": (text) => `${text}\n// changed\n` }, "note"],
  ];
  for (const [name, edits, expected] of people) test(`${expected}: a person's change to ${name}`, () => expectAnswer(name, edits, expected));
});
