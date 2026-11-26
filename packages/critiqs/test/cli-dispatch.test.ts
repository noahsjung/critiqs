// The setup CLI reaches every framework through its adapter: init, the setup
// flow, doctor, and workspaces apply `plan.writes`, set the `.env` value when
// `env` names a local file, and print `plan.next` and the package to install.
// Small fake adapters stand in for real frameworks.
import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EnvConvention, FrameworkAdapter, Plan, PlanOptions, Settings } from "../bin/frameworks/types.d.mts";

const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const OTHER = "k57a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";

/** Every plan call, to check what the CLI asked for. */
const planned: { id: string; settings: Settings; options: PlanOptions }[] = [];

const depends = (root: string, name: string) => {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return name in { ...manifest.dependencies, ...manifest.devDependencies };
  } catch {
    return false;
  }
};

/**
 * A framework whose apps render from `src/main.js` and get Critiqs from a
 * `src/critiqs.js` file setup creates, plus a line in main.js that imports it.
 */
function fake(id: "vue" | "rails", { env, install }: { env: (root: string, suffix: string) => EnvConvention | null; install: FrameworkAdapter["install"] }): FrameworkAdapter {
  const text = (settings: Settings) =>
    `mount({ projectId: ${"literal" in settings.projectId ? JSON.stringify(settings.projectId.literal) : settings.projectId.env.expression}${settings.requireProjectId ? ", requireProjectId: true" : ""}${settings.backend ? `, backend: ${JSON.stringify(settings.backend)}` : ""} });\n`;
  const adapter: FrameworkAdapter = {
    id,
    name: id === "vue" ? "Vue" : "Ruby on Rails",
    install,
    detect: (root) => depends(root, `fake-${id}`),
    env,
    find(root) {
      const file = join(root, "src/critiqs.js");
      if (!existsSync(file)) return [];
      const source = readFileSync(file, "utf8");
      const literal = /projectId: "([^"]+)"/.exec(source)?.[1];
      const variable = /projectId: (?:import\.meta\.env\.|ENV\.)(\w+)/.exec(source)?.[1];
      return [
        {
          file,
          line: 1,
          projectId: literal !== undefined ? { kind: "literal", value: literal } : variable !== undefined ? { kind: "env", variable } : null,
          backend: null,
          requireProjectId: source.includes("requireProjectId"),
        },
      ];
    },
    plan(root, settings, options): Plan {
      planned.push({ id, settings, options });
      const entry = join(root, options.entry ?? "src/main.js");
      if (!existsSync(entry)) return { ok: false, reason: "manual", message: `Add Critiqs to the ${id} app by hand:\n${adapter.manual(settings)}` };
      const file = join(root, "src/critiqs.js");
      const original = existsSync(file) ? readFileSync(file, "utf8") : null;
      const source = text(settings);
      const main = readFileSync(entry, "utf8");
      const writes = [
        ...(original === source ? [] : [{ file, original, source }]),
        ...(main.includes('import "./critiqs.js"') ? [] : [{ file: entry, original: main, source: `import "./critiqs.js";\n${main}` }]),
      ];
      return {
        ok: true,
        action: original === null ? "install" : writes.length === 0 ? "unchanged" : "update",
        writes,
        file,
        line: 1,
        changed: original === source ? [] : ["projectId"],
        preview: `+ ${source.trim()}`,
        next: id === "rails" ? ["Restart the Rails server."] : [],
      };
    },
    manual: (settings) => `In src/critiqs.js: ${text(settings).trim()}`,
  };
  return adapter;
}

const vue = fake("vue", {
  install: { ecosystem: "npm", packages: ["critiqs-vue"] },
  env: (root, suffix) => ({
    variable: `VITE_CRITIQS_PROJECT_ID${suffix}`,
    expression: `import.meta.env.VITE_CRITIQS_PROJECT_ID${suffix}`,
    readsAt: "build",
    localFile: ".env.local",
    deploymentAdvice: `Set VITE_CRITIQS_PROJECT_ID${suffix} in each deployment's build settings.`,
  }),
});
const rails = fake("rails", {
  install: { ecosystem: "rubygems", gem: "critiqs-rails" },
  env: () => ({ variable: "CRITIQS_PROJECT_ID", expression: "ENV.CRITIQS_PROJECT_ID", readsAt: "runtime", localFile: null, deploymentAdvice: "Set CRITIQS_PROJECT_ID in each deployment's environment." }),
});
/** A framework with no public variable: the ID is written into the code. */
const plain = { ...fake("vue", { install: { ecosystem: "npm", packages: ["critiqs-vue"] }, env: () => null }), detect: (root: string) => depends(root, "fake-plain") };

mock.module("../bin/frameworks/index.mjs", () => ({
  FRAMEWORKS: [vue, rails, plain],
  detectApp: (root: string) => [vue, rails, plain].find((adapter) => adapter.detect(root)) ?? null,
}));
const { runInit } = await import("../bin/init.mjs");
const { runCli } = await import("../bin/cli.mjs");
const { beginSetup, doctor } = await import("../bin/setup.mjs");
const { workspaceApps } = await import("../bin/app.mjs");

const folders: string[] = [];
afterEach(() => {
  planned.length = 0;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder with these files; a `.git` folder makes it a repository root. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-dispatch-"));
  folders.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
/** Runs `init` in `root` with this shell environment. */
const initIn = (env: Record<string, string>, root: string, ...args: string[]) => {
  const lines: string[] = [];
  const code = runInit(["init", ...args], { cwd: root, print: (line) => void lines.push(line), env });
  return { code, output: lines.join("\n") };
};
const init = (root: string, ...args: string[]) => initIn({}, root, ...args);
const MAIN = 'createApp(App).mount("#app");\n';

test("init applies a framework's plan, sets its .env value, and names its package", () => {
  const root = tree({ "package.json": JSON.stringify({ name: "shop", dependencies: { "fake-vue": "1" } }), "pnpm-lock.yaml": "", "src/main.js": MAIN });
  const first = init(root, PROJECT);
  expect(first.code).toBe(0);
  expect(planned[0]).toMatchObject({ id: "vue", settings: { projectId: { env: { variable: "VITE_CRITIQS_PROJECT_ID" } }, requireProjectId: true }, options: { entry: null, cwd: root } });
  expect(read(root, "src/critiqs.js")).toBe("mount({ projectId: import.meta.env.VITE_CRITIQS_PROJECT_ID, requireProjectId: true });\n");
  expect(read(root, "src/main.js")).toBe(`import "./critiqs.js";\n${MAIN}`);
  expect(read(root, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}`);
  expect(read(root, ".env.example")).toContain("VITE_CRITIQS_PROJECT_ID=\n");
  expect(first.output).toContain("Added Critiqs to src/critiqs.js:1:\n  + mount(");
  expect(first.output).toContain(`Set VITE_CRITIQS_PROJECT_ID=${PROJECT} in .env.local for this computer.`);
  expect(first.output).toContain("Set VITE_CRITIQS_PROJECT_ID in each deployment's build settings.");
  expect(first.output).toContain("Next: Install critiqs-vue with the app's package manager: pnpm add critiqs-vue.");

  // A second run changes nothing; once the package is installed, setup stops naming it.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop", dependencies: { "fake-vue": "1", "critiqs-vue": "0.3.0" } }));
  const before: [string, string, string] = [read(root, "src/critiqs.js"), read(root, "src/main.js"), read(root, ".env.local")];
  expect(init(root, PROJECT)).toEqual({ code: 0, output: `src/critiqs.js:1 already uses this project ID (VITE_CRITIQS_PROJECT_ID in .env.local).` });
  expect([read(root, "src/critiqs.js"), read(root, "src/main.js"), read(root, ".env.local")]).toEqual(before);

  // Another project replaces only this computer's value.
  expect(init(root, OTHER).code).toBe(0);
  expect(read(root, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${OTHER}`);
  expect(read(root, "src/critiqs.js")).toBe(before[0]);
});

test("a framework that loads no .env file is told where the variable goes, with its own next steps", () => {
  const root = tree({ "package.json": JSON.stringify({ dependencies: { "fake-rails": "1" } }), Gemfile: 'source "https://rubygems.org"\ngem "rails"\n', "src/main.js": MAIN });
  const { code, output } = init(root, PROJECT);
  expect(code).toBe(0);
  expect(read(root, "src/critiqs.js")).toContain("projectId: ENV.CRITIQS_PROJECT_ID");
  expect(existsSync(join(root, ".env.local"))).toBe(false);
  expect(output).toContain(`Set CRITIQS_PROJECT_ID=${PROJECT} in the environment the app runs with on this computer.`);
  expect(output).toContain("Next: Add the critiqs-rails gem: bundle add critiqs-rails.\nNext: Restart the Rails server.");
});

test("without a public variable the ID is written into the code; options reach the adapter", () => {
  const root = tree({ "package.json": JSON.stringify({ dependencies: { "fake-plain": "1", "critiqs-vue": "0.3.0" } }), "src/app.js": MAIN });
  expect(init(root, PROJECT, "--entry", "src/missing.js")).toMatchObject({ code: 2, output: expect.stringContaining("src/missing.js is not a file") });
  expect(planned).toEqual([]);
  const { code, output } = init(root, PROJECT, "--entry", "src/app.js", "--dry-run");
  expect(code).toBe(0);
  expect(planned[0]).toMatchObject({ settings: { projectId: { literal: PROJECT }, requireProjectId: false }, options: { entry: "src/app.js", mount: null } });
  expect(output).toBe(`Would add Critiqs to src/critiqs.js:1 (dry run, nothing written):\n  + mount({ projectId: "${PROJECT}" });`);
  expect(existsSync(join(root, "src/critiqs.js"))).toBe(false);
  expect(init(root, PROJECT, "--entry", "src/app.js").code).toBe(0);
  expect(read(root, "src/critiqs.js")).toBe(`mount({ projectId: "${PROJECT}" });\n`);
});

test("an adapter's refusal is shown with nothing written", () => {
  const root = tree({ "package.json": JSON.stringify({ dependencies: { "fake-vue": "1" } }) });
  const { code, output } = init(root, PROJECT);
  expect(code).toBe(1);
  expect(output).toBe(`Add Critiqs to the vue app by hand:\nIn src/critiqs.js: mount({ projectId: import.meta.env.VITE_CRITIQS_PROJECT_ID, requireProjectId: true });\nThen add VITE_CRITIQS_PROJECT_ID=${PROJECT} to .env.local.`);
  expect(existsSync(join(root, ".env.local"))).toBe(false);
});

test("an app setup doesn't recognize is set up as React, and the refusal says what else setup knows", () => {
  const root = tree({ "package.json": JSON.stringify({ name: "site" }), "index.html": "<!doctype html><title>Site</title>\n" });
  const { code, output } = init(root, PROJECT);
  expect(code).toBe(1);
  expect(output).toContain("No <Critiqs /> component found");
  expect(output).toContain("Setup didn't recognize this app's framework, so it looked for a React app. It also sets up Vue, Ruby on Rails");
  expect(output).toContain("<critiqs-app>");
});

test("doctor reads the variable a framework's code uses from the .env file it loads", async () => {
  const root = tree({ "package.json": JSON.stringify({ dependencies: { "fake-vue": "1", "critiqs-vue": "0.3.0" } }), "src/main.js": MAIN });
  expect(init(root, PROJECT).code).toBe(0);
  const fetchFn = (async (url: string) => {
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5 });
    const asked = new URL(url).searchParams.get("projectId");
    return Response.json({ protocol: 5, signIn: "email", email: true, mentionEmails: {}, ...(asked === null ? {} : { project: asked === PROJECT ? "found" : "missing" }) });
  }) as unknown as typeof fetch;
  const checks = await doctor({ root, fetchFn, env: {} });
  expect(checks.find((check) => check.name === "Component")?.detail).toBe("Critiqs is set up at src/critiqs.js:1.");
  expect(checks.find((check) => check.name === "Project")).toMatchObject({ status: "pass", detail: `${PROJECT} (VITE_CRITIQS_PROJECT_ID in .env.local) exists on this backend.` });
});

test("the setup flow checks the framework's plan before sign-in and writes it with the new project", async () => {
  const root = tree({ "package.json": JSON.stringify({ name: "shop", dependencies: { "fake-plain": "1" } }), "src/main.js": MAIN });
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://team.convex.site", protocol: 5, deviceSignIn: true });
    if (url.endsWith("/auth/device/start")) return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: "https://team.convex.site/auth/device", expiresIn: 600, interval: 5 });
    if (url.endsWith("/auth/device/token")) return Response.json({ accessToken: "access" });
    if (url.endsWith("/api/query")) return Response.json({ status: "success", value: { page: [], isDone: true, continueCursor: "" } });
    if (url.endsWith("/api/mutation")) return Response.json({ status: "success", value: body.path === "projects:create" ? PROJECT : null });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const setup = await beginSetup({ root, target: "https://team.convex.cloud", signIn: "remote", fetchFn, sleep: async () => {} });
  if (setup.connected !== undefined) throw new Error("Expected setup to sign in.");
  // Checked with a stand-in ID before anyone signs in, and nothing written yet.
  expect(planned.map((call) => call.settings)).toEqual([{ projectId: { literal: "p".repeat(32) }, requireProjectId: false, backend: "https://team.convex.cloud" }]);
  expect(existsSync(join(root, "src/critiqs.js"))).toBe(false);
  const result = await setup.finish();
  expect(read(root, "src/critiqs.js")).toBe(`mount({ projectId: "${PROJECT}", backend: "https://team.convex.cloud" });\n`);
  expect(result.written).toMatchObject({ ok: true, installed: true, next: ["Install critiqs-vue with the app's package manager: npm install critiqs-vue"] });
});

test("in a workspace, the apps are the packages whose framework setup can set up", () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "acme", workspaces: ["apps/*", "packages/*"] }),
    "apps/shop/package.json": JSON.stringify({ name: "shop", dependencies: { "fake-vue": "1" } }),
    "apps/shop/src/main.js": MAIN,
    "apps/admin/package.json": JSON.stringify({ name: "admin", dependencies: { "fake-rails": "1" } }),
    "apps/admin/src/main.js": MAIN,
    // The fake adapter can't place Critiqs here, so it isn't an app.
    "packages/ui/package.json": JSON.stringify({ name: "ui", dependencies: { "fake-vue": "1" } }),
  });
  expect(workspaceApps(root)).toEqual([resolve(root, "apps/admin"), resolve(root, "apps/shop")]);
  const { code, output } = init(root, PROJECT);
  expect(code).toBe(1);
  expect(output).toContain(`npx critiqs init ${PROJECT} --dir apps/admin\n  npx critiqs init ${PROJECT} --dir apps/shop`);
  // Each app gets its own variable.
  expect(init(root, PROJECT, "--dir", "apps/shop").code).toBe(0);
  expect(read(root, "apps/shop/src/critiqs.js")).toContain("import.meta.env.VITE_CRITIQS_PROJECT_ID_SHOP");
});

test("where a framework loads no .env file, init reads the shell as doctor does, and claims only an ID it read", async () => {
  const root = tree({ "package.json": JSON.stringify({ name: "admin", dependencies: { "fake-rails": "1" } }), Gemfile: 'gem "rails"\ngem "critiqs-rails"\n', "src/main.js": MAIN });
  expect(init(root, PROJECT).code).toBe(0);
  const code = read(root, "src/critiqs.js");
  expect(code).toContain("projectId: ENV.CRITIQS_PROJECT_ID");

  // The code reads CRITIQS_PROJECT_ID; unset, or set to another project, the ID is the person's to set, not one in use.
  for (const shell of [{}, { CRITIQS_PROJECT_ID: PROJECT }] as Record<string, string>[]) {
    const { code: exit, output } = initIn(shell, root, OTHER);
    expect(exit).toBe(0);
    expect(output).not.toContain("already uses");
    expect(output).toContain(`Set CRITIQS_PROJECT_ID=${OTHER} in the environment the app runs with on this computer.`);
  }
  // Set to this project, it is.
  expect(initIn({ CRITIQS_PROJECT_ID: OTHER }, root, OTHER).output).toBe("src/critiqs.js:1 already uses this project ID (CRITIQS_PROJECT_ID in this shell's environment).\nNext: Restart the Rails server.");
  expect(read(root, "src/critiqs.js")).toBe(code);

  // Plain init keeps the project the shell names without signing in, and doctor agrees.
  const health = (async (url: string) => {
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5 });
    if (!url.includes("/critiqs/health")) return new Response("Not found", { status: 404 });
    const asked = new URL(url).searchParams.get("projectId");
    return Response.json({ protocol: 5, signIn: "email", email: true, mentionEmails: {}, ...(asked === null ? {} : { project: asked === PROJECT ? "found" : "missing" }) });
  }) as unknown as typeof fetch;
  const noFetch = (async () => {
    throw new Error("A project the shell names needs no network.");
  }) as unknown as typeof fetch;
  const shell = { CRITIQS_PROJECT_ID: PROJECT };
  expect(await beginSetup({ root, fetchFn: noFetch, env: shell })).toEqual({
    connected: { projectId: PROJECT, backendUrl: "https://brazen-snail-591.convex.cloud", env: { name: "CRITIQS_PROJECT_ID", file: null } },
    backendUrl: "https://brazen-snail-591.convex.cloud",
  });
  const checks = await doctor({ root, fetchFn: health, env: shell });
  expect(checks.find((check) => check.name === "Project")).toMatchObject({ status: "pass", detail: `${PROJECT} (CRITIQS_PROJECT_ID in this shell's environment) exists on this backend.` });

  // The command line says where it found the project.
  const previous = { fetch: globalThis.fetch, id: process.env.CRITIQS_PROJECT_ID };
  globalThis.fetch = health;
  process.env.CRITIQS_PROJECT_ID = PROJECT;
  try {
    const lines: string[] = [];
    expect(await runCli(["init", "--remote"], { cwd: root, print: (line) => void lines.push(line) })).toBe(0);
    expect(lines[0]).toBe(`The code already uses project ${PROJECT} (CRITIQS_PROJECT_ID in this shell's environment) on Critiqs Cloud, so nothing was created. Checking it…`);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.id === undefined) delete process.env.CRITIQS_PROJECT_ID;
    else process.env.CRITIQS_PROJECT_ID = previous.id;
  }
});
