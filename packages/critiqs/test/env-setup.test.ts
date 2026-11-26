// Setup that connects each app, and each deployment, to its own project
// through the app's public environment variable.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCommand, runCli } from "../bin/cli.mjs";
import { chooseWiring, envTargetOf, readUsage } from "../bin/app.mjs";
import { planEnv, readEnvValue, workspaceMembers } from "../bin/env.mjs";
import { runInit } from "../bin/init.mjs";
import { createTools } from "../bin/mcp.mjs";
import { shortenProjectName as coreShorten } from "@critiqs/core";
import { beginSetup, CLOUD_BACKEND_URL, defaultProjectName, doctor, doctorReport, readiness, SetupError, shortenProjectName } from "../bin/setup.mjs";

const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const OTHER = "p_0123456789abcdef0123456789abcdef";
const RESTRICTED = "kd71q5kzssedhq0rp6myv7zdf58gbb2r";
const VITE_MAIN = `import { createRoot } from "react-dom/client";\nimport App from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`;
const NEXT_LAYOUT = `export default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n`;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder with these files; a `.git` folder makes it a repository root. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "critiqs-env-"));
  folders.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const vite = (name = "billing", extra: Record<string, string> = {}) =>
  tree({ "package.json": JSON.stringify({ name, devDependencies: { vite: "^8.0.0" } }), "src/main.tsx": VITE_MAIN, ...extra });
/** A Bun/npm workspace with two Vite apps, the first loading `.env` files from the workspace root. */
const workspace = (names = ["@acme/admin", "@acme/shop"]) =>
  tree({
    "package.json": JSON.stringify({ name: "acme-platform", private: true, workspaces: ["apps/*", "packages/*"] }),
    "apps/admin/package.json": JSON.stringify({ name: names[0], devDependencies: { vite: "^8.0.0" } }),
    "apps/admin/vite.config.ts": 'import { resolve } from "node:path";\nexport default { envDir: resolve(__dirname, "../..") };\n',
    "apps/admin/src/main.tsx": VITE_MAIN,
    "apps/shop/package.json": JSON.stringify({ name: names[1], devDependencies: { vite: "^8.0.0" } }),
    "apps/shop/src/main.tsx": VITE_MAIN,
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
    "packages/ui/src/Button.tsx": "export const Button = () => <button />;\n",
  });

const quiet = { print: () => {} };
const output = () => {
  const lines: string[] = [];
  return { lines, print: (line: string) => void lines.push(line) };
};

/** A fake Critiqs Cloud that approves sign-in from another device and creates `created`. */
function cloud({ mine = [] as { _id: string; name: string; reviewUrl: string | null }[], created = PROJECT } = {}) {
  const calls: { url: string; body: any }[] = [];
  let shown = {};
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5, deviceSignIn: true });
    if (url.includes("/critiqs/health")) {
      const asked = new URL(url).searchParams.get("projectId");
      return Response.json({ protocol: 5, signIn: "email", email: true, mentionEmails: {}, ...(asked === null || asked === RESTRICTED ? {} : { project: asked === PROJECT ? "found" : "missing" }) });
    }
    // A current sign-in service repeats the backend and site its approval page names, at the start and with the tokens.
    if (url.endsWith("/auth/device/start")) {
      shown = { backend: body.backend, site: body.site };
      return Response.json({ deviceCode: "secret", userCode: "BCDF-GHJK", verificationUrl: "https://brazen-snail-591.convex.site/auth/device", expiresIn: 600, interval: 5, ...shown });
    }
    if (url.endsWith("/auth/device/token")) return Response.json({ accessToken: "access", reviewer: { name: "Dana", email: "dana@example.com" }, ...shown });
    if (url.endsWith("/api/query")) return Response.json({ status: "success", value: { page: mine, isDone: true, continueCursor: "" } });
    if (url.endsWith("/api/mutation")) return Response.json({ status: "success", value: body.path === "projects:create" ? created : null });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const noWait = async () => {};
/** How setup wires an app, with its variable and this computer's .env files. */
const wiringOf = (root: string, envFile: string | null = null) => {
  const wiring = chooseWiring(root, { envFile });
  return { ...wiring, variable: wiring.mode === "env" ? wiring.env.variable : null, target: envTargetOf(wiring) };
};
const signIn = { signIn: "remote" as const, sleep: noWait };

async function begin(args: Parameters<typeof beginSetup>[0]) {
  const setup = await beginSetup(args);
  if (setup.connected !== undefined) throw new Error("Expected setup to sign in.");
  return setup;
}

// ---------------------------------------------------------------------------
// Long names

test("a suggested name longer than a project's name can be is shortened as the backend shortens older names", () => {
  const long = (suffix: string) => `${"a".repeat(200)}-${suffix}`;
  const root = workspace([long("web"), long("admin")]);
  const first = defaultProjectName(join(root, "apps/admin"));
  const second = defaultProjectName(join(root, "apps/shop"));
  expect(first).toBe(coreShorten(`acme-platform/${long("web")}`));
  expect(second).toBe(coreShorten(`acme-platform/${long("admin")}`));
  expect(first.length).toBeLessThanOrEqual(200);
  // Two apps whose names share their start still get their own projects.
  expect(first).not.toBe(second);
  // Names that fit are unchanged.
  expect(defaultProjectName(vite())).toBe("billing");
});

test("init's copy of the name shortening matches the backend's", () => {
  for (const name of ["Admin", "x".repeat(200), "x".repeat(201), "x".repeat(5_000), `${"x".repeat(186)}😀tail${"y".repeat(20)}`, "😀".repeat(150), `${"x".repeat(180)}      ${"y".repeat(30)}`]) {
    expect(shortenProjectName(name)).toBe(coreShorten(name));
  }
});

// Which variable, and where

test("each framework gets its public variable; workspace apps get their own names and project names", () => {
  expect(wiringOf(vite())).toMatchObject({ mode: "env", variable: "VITE_CRITIQS_PROJECT_ID", env: { expression: "import.meta.env.VITE_CRITIQS_PROJECT_ID" }, app: { workspace: null, projectName: "billing" } });
  const next = tree({ "package.json": JSON.stringify({ name: "@acme/site", dependencies: { next: "16" } }), "app/layout.jsx": NEXT_LAYOUT });
  expect(wiringOf(next)).toMatchObject({ mode: "env", variable: "NEXT_PUBLIC_CRITIQS_PROJECT_ID", env: { expression: "process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID" }, app: { projectName: "site" } });
  expect(wiringOf(next).adapter.id).toBe("next");
  const plain = tree({ "package.json": "{}", "src/main.tsx": VITE_MAIN });
  expect(wiringOf(plain)).toMatchObject({ mode: "literal", variable: null });

  const root = workspace();
  expect(workspaceMembers(root)).toEqual(["apps/admin", "apps/shop", "packages/ui"].map((path) => join(root, path)));
  const admin = wiringOf(join(root, "apps/admin"));
  const shop = wiringOf(join(root, "apps/shop"));
  expect(admin).toMatchObject({ variable: "VITE_CRITIQS_PROJECT_ID_ADMIN", target: { local: join(root, ".env.local") }, app: { projectName: "acme-platform/admin" } });
  expect(shop).toMatchObject({ variable: "VITE_CRITIQS_PROJECT_ID_SHOP", target: { local: join(root, "apps/shop/.env.local") }, app: { projectName: "acme-platform/shop" } });
  expect(defaultProjectName(join(root, "apps/admin"))).toBe("acme-platform/admin");

  // Package names that only differ by scope stay apart by their paths.
  const same = workspace(["@admin/web", "@shop/web"]);
  expect(wiringOf(join(same, "apps/admin"))).toMatchObject({ variable: "VITE_CRITIQS_PROJECT_ID_APPS_ADMIN", app: { projectName: "acme-platform/apps/admin" } });
  expect(wiringOf(join(same, "apps/shop"))).toMatchObject({ variable: "VITE_CRITIQS_PROJECT_ID_APPS_SHOP", app: { projectName: "acme-platform/apps/shop" } });
});

test("Vite's envDir is followed when it is a literal path, and refused with a way forward otherwise", () => {
  for (const config of ['export default { envDir: "../shared" };', "export default { envDir: fileURLToPath(new URL('../shared', import.meta.url)) };", 'export default { envDir: path.join(__dirname, "..", "shared") };']) {
    const root = vite("billing", { "vite.config.ts": config });
    expect(wiringOf(root)).toMatchObject({ target: { local: join(dirname(root), "shared/.env.local") }, problem: null });
  }
  const computed = vite("billing", { "vite.config.ts": "export default { envDir: process.env.ENV_DIR };" });
  expect(wiringOf(computed).problem).toContain("--project-env-file");
  expect(wiringOf(computed, "config/.env.local")).toMatchObject({ problem: null, target: { local: join(computed, "config/.env.local") } });
  const prefixed = vite("billing", { "vite.config.ts": 'export default { envPrefix: "APP_" };', "src/main.tsx": VITE_MAIN });
  const out = output();
  expect(runInit(["init", PROJECT, "--dir", prefixed], out)).toBe(1);
  expect(out.lines.join("\n")).toContain("sets envPrefix");
  expect(read(prefixed, "src/main.tsx")).toBe(VITE_MAIN);
});

test("workspace names and paths that normalize alike keep separate settings in a shared env directory", () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "example", workspaces: ["apps/*"] }),
    ...Object.fromEntries(["a-b", "a_b"].flatMap((name) => [
      [`apps/${name}/package.json`, JSON.stringify({ name: `@scope/${name}`, devDependencies: { vite: "8" } })],
      [`apps/${name}/vite.config.ts`, 'export default { envDir: "../.." };'],
      [`apps/${name}/src/main.tsx`, VITE_MAIN],
    ])),
  });
  const first = wiringOf(join(root, "apps/a-b"));
  const second = wiringOf(join(root, "apps/a_b"));
  expect(first.variable).not.toBe(second.variable);
  expect(runInit(["init", PROJECT, "--dir", first.app.root], quiet)).toBe(0);
  expect(runInit(["init", OTHER, "--dir", second.app.root], quiet)).toBe(0);
  expect(readEnvValue(first.target!, first.variable!)).toMatchObject({ value: PROJECT });
  expect(readEnvValue(second.target!, second.variable!)).toMatchObject({ value: OTHER });
  const before: [string, string, string] = [read(root, ".env.local"), read(first.app.root, "src/main.tsx"), read(second.app.root, "src/main.tsx")];
  expect(runInit(["init", PROJECT, "--dir", first.app.root], quiet)).toBe(0);
  expect(runInit(["init", OTHER, "--dir", second.app.root], quiet)).toBe(0);
  expect([read(root, ".env.local"), read(first.app.root, "src/main.tsx"), read(second.app.root, "src/main.tsx")]).toEqual(before);

  // A package could literally name itself after a generated suffix. Refuse that final collision.
  const third = join(root, "apps/third");
  mkdirSync(join(third, "src"), { recursive: true });
  writeFileSync(join(third, "package.json"), JSON.stringify({ name: first.variable!.replace("VITE_CRITIQS_PROJECT_ID_", "").toLowerCase(), devDependencies: { vite: "8" } }));
  writeFileSync(join(third, "src/main.tsx"), VITE_MAIN);
  expect(wiringOf(third).problem).toContain("same Critiqs environment variable");
  expect(runInit(["init", PROJECT, "--dir", third], quiet)).toBe(1);
  expect(read(root, ".env.local")).toBe(before[0]);
  expect(read(third, "src/main.tsx")).toBe(VITE_MAIN);
});

test("the .env writer keeps every other line and value, and reads what frameworks read", () => {
  const root = vite("billing", {
    ".env": "VITE_CRITIQS_PROJECT_ID=from-committed-file\n",
    ".env.local": 'API_URL="https://api.example" # the API\r\nexport VITE_CRITIQS_PROJECT_ID = old\r\nSECRET=keep-me\r\n',
  });
  const target = wiringOf(root).target!;
  expect(readEnvValue(target, "API_URL")).toEqual({ value: "https://api.example", file: join(root, ".env.local") });
  expect(readEnvValue(target, "VITE_CRITIQS_PROJECT_ID")).toEqual({ value: "old", file: join(root, ".env.local") });
  const plan = planEnv(target, "VITE_CRITIQS_PROJECT_ID", PROJECT);
  expect(plan.source).toBe(`API_URL="https://api.example" # the API\r\nexport VITE_CRITIQS_PROJECT_ID=${PROJECT}\r\nSECRET=keep-me\r\n`);
  expect(plan.example?.source).toContain("VITE_CRITIQS_PROJECT_ID=\n");

  // A higher-precedence local file that already sets it is the one changed.
  const dev = vite("billing", { ".env.development.local": "VITE_CRITIQS_PROJECT_ID=x\n", ".env.example": "OTHER=\nVITE_CRITIQS_PROJECT_ID=\n" });
  const devPlan = planEnv(wiringOf(dev).target!, "VITE_CRITIQS_PROJECT_ID", PROJECT);
  expect(devPlan.file).toBe(join(dev, ".env.development.local"));
  expect(devPlan.example).toBeNull();
});

// ---------------------------------------------------------------------------
// critiqs init <projectId>

test("ID-only init wires Vite and Next.js apps to their variable, sets it locally, and is repeatable", () => {
  const app = vite();
  const out = output();
  expect(runInit(["init", PROJECT, "--dir", app], out)).toBe(0);
  expect(read(app, "src/main.tsx")).toContain("render(<><App /><Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId /></>)");
  expect(read(app, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}`);
  expect(read(app, ".env.example")).toContain("VITE_CRITIQS_PROJECT_ID=\n");
  expect(out.lines.join("\n")).toContain("each deployment's build settings");
  const source = read(app, "src/main.tsx");
  const again = output();
  expect(runInit(["init", PROJECT, "--dir", app], again)).toBe(0);
  expect(again.lines.join("\n")).toContain("already uses this project ID (VITE_CRITIQS_PROJECT_ID in");
  expect(read(app, "src/main.tsx")).toBe(source);
  // Connecting another project changes only this computer's setting.
  expect(runInit(["init", OTHER, "--dir", app], quiet)).toBe(0);
  expect(read(app, "src/main.tsx")).toBe(source);
  expect(read(app, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${OTHER}`);
  expect(read(app, ".env.local")).not.toContain(PROJECT);

  const next = tree({ "package.json": JSON.stringify({ dependencies: { next: "16" } }), "app/layout.jsx": NEXT_LAYOUT });
  expect(runInit(["init", PROJECT, "--dir", next], quiet)).toBe(0);
  expect(read(next, "app/layout.jsx")).toContain("        <Critiqs projectId={process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />\n");
  expect(read(next, ".env.local")).toContain(`NEXT_PUBLIC_CRITIQS_PROJECT_ID=${PROJECT}`);
  const pages = tree({ "package.json": JSON.stringify({ dependencies: { next: "16" } }), "pages/_app.jsx": "export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n" });
  expect(runInit(["init", PROJECT, "--dir", pages, "--dry-run"], quiet)).toBe(0);
  expect(existsSync(join(pages, ".env.local"))).toBe(false);
  expect(runInit(["init", PROJECT, "--dir", pages], quiet)).toBe(0);
  expect(read(pages, "pages/_app.jsx")).toContain("<><Component {...pageProps} /><Critiqs projectId={process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID} requireProjectId /></>");
});

test("existing components keep their author's choices: literal IDs, own wiring, computed values, and props", () => {
  const literal = vite("billing", { "src/main.tsx": `import { Critiqs } from "critiqs-react";\nexport const A = () => <Critiqs projectId="${OTHER}" backend="https://team.convex.cloud" />;\n` });
  expect(runInit(["init", PROJECT, "--dir", literal], quiet)).toBe(0);
  expect(read(literal, "src/main.tsx")).toContain(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
  expect(existsSync(join(literal, ".env.local"))).toBe(false);

  // An author's own variable, without requireProjectId, is set as it is.
  const own = vite("billing", { "src/main.tsx": `import { Critiqs } from "critiqs-react";\nexport const A = () => <Critiqs version="v2" projectId={import.meta.env.VITE_REVIEW_PROJECT} />;\n` });
  const ownSource = read(own, "src/main.tsx");
  expect(runInit(["init", PROJECT, "--dir", own], quiet)).toBe(0);
  expect(read(own, "src/main.tsx")).toBe(ownSource);
  expect(read(own, ".env.local")).toBe(`# Critiqs project for this app on this computer. Each deployment sets its own.\nVITE_REVIEW_PROJECT=${PROJECT}\n`);

  for (const component of [
    "<Critiqs projectId={import.meta.env.VITE_ID || fallback} />",
    "<Critiqs projectId={config.critiqsProject} />",
    "<Critiqs projectId={process.env.NEXT_PUBLIC_ID} />",
    "<Critiqs projectId={import.meta.env.SECRET_ID} />",
  ]) {
    const computed = vite("billing", { "src/main.tsx": `import { Critiqs } from "critiqs-react";\nexport const A = () => ${component};\n` });
    const out = output();
    expect(runInit(["init", PROJECT, "--dir", computed], out)).toBe(1);
    expect(out.lines.join("\n")).toContain("sets projectId from code");
    expect(read(computed, "src/main.tsx")).toContain(component);
    expect(existsSync(join(computed, ".env.local"))).toBe(false);
  }

  // A hand-placed <Critiqs /> keeps its props and becomes environment-controlled.
  const placed = vite("billing", { "src/main.tsx": `import { Critiqs } from "critiqs-react";\nexport const A = () => <Critiqs {...hostProps} version="v1" />;\n` });
  expect(runInit(["init", PROJECT, "--dir", placed], quiet)).toBe(0);
  expect(read(placed, "src/main.tsx")).toContain("<Critiqs {...hostProps} projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId version=\"v1\" />");
});

test("at a workspace root, init and doctor name each app instead of choosing one", async () => {
  const root = workspace();
  const out = output();
  expect(runInit(["init", PROJECT], { cwd: root, print: out.print })).toBe(1);
  expect(out.lines.join("\n")).toContain(`This folder is a workspace with 2 apps, so nothing was changed`);
  expect(out.lines.join("\n")).toContain(`npx critiqs init ${PROJECT} --dir apps/admin\n  npx critiqs init ${PROJECT} --dir apps/shop`);
  expect(out.lines.join("\n")).not.toContain("packages/ui");
  for (const path of ["apps/admin/src/main.tsx", "apps/shop/src/main.tsx"]) expect(read(root, path)).toBe(VITE_MAIN);
  expect(existsSync(join(root, ".env.local"))).toBe(false);

  const backend = cloud();
  await expect(beginSetup({ root, cwd: root, fetchFn: backend.fetchFn, ...signIn })).rejects.toThrow("npx critiqs init --dir apps/shop");
  expect(backend.calls).toEqual([]);
  const checks = await doctor({ root, cwd: root, fetchFn: backend.fetchFn });
  expect(checks).toEqual([expect.objectContaining({ status: "fail", name: "Component", detail: expect.stringContaining("npx critiqs doctor --dir apps/admin") })]);
  expect(backend.calls).toEqual([]);
});

test("two apps in one workspace get separate projects, variables, and files, and one doesn't touch the other", () => {
  const root = workspace();
  expect(runInit(["init", PROJECT, "--dir", join(root, "apps/admin")], quiet)).toBe(0);
  expect(read(root, "apps/shop/src/main.tsx")).toBe(VITE_MAIN);
  expect(runInit(["init", OTHER, "--dir", join(root, "apps/shop")], quiet)).toBe(0);
  expect(read(root, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID_ADMIN=${PROJECT}`);
  expect(read(root, ".env.local")).not.toContain("SHOP");
  expect(read(root, "apps/shop/.env.local")).toContain(`VITE_CRITIQS_PROJECT_ID_SHOP=${OTHER}`);
  expect(read(root, "apps/admin/src/main.tsx")).toContain("import.meta.env.VITE_CRITIQS_PROJECT_ID_ADMIN");
  expect(read(root, "apps/shop/src/main.tsx")).toContain("import.meta.env.VITE_CRITIQS_PROJECT_ID_SHOP");
  // A generic variable shared by the whole workspace doesn't configure either app.
  writeFileSync(join(root, ".env"), `VITE_CRITIQS_PROJECT_ID=${PROJECT}\n`);
  expect(readEnvValue(wiringOf(join(root, "apps/shop")).target!, "VITE_CRITIQS_PROJECT_ID_SHOP")?.value).toBe(OTHER);
});

// ---------------------------------------------------------------------------
// critiqs init: creating or connecting a project

test("setup checks the component and .env file before signing in, then writes both", async () => {
  const app = vite();
  const backend = cloud();
  const setup = await begin({ root: app, cwd: app, fetchFn: backend.fetchFn, ...signIn });
  const result = await setup.finish();
  expect(result).toMatchObject({ projectId: PROJECT, projectName: "billing", written: { ok: true, env: { name: "VITE_CRITIQS_PROJECT_ID", file: join(app, ".env.local") } } });
  expect(read(app, "src/main.tsx")).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />");
  expect(read(app, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}`);
  expect(readiness(result).map((stage) => [stage.name, stage.status])).toEqual([
    ["Code", "pass"],
    ["Project", "pass"],
    ["Finish setup", "next"],
    ["Try it locally", "next"],
    ["Deployments", "next"],
    ["Reviewers elsewhere", "warn"],
  ]);
  // The app doesn't list the framework's package yet, so setup names it.
  expect(readiness(result).find((stage) => stage.name === "Finish setup")?.detail).toBe("Install critiqs-react with the app's package manager: npm install critiqs-react.");

  // Running again finds the project through the variable, without the network.
  const noFetch = (async () => {
    throw new Error("A connected app must not use the network");
  }) as unknown as typeof fetch;
  expect(await beginSetup({ root: app, fetchFn: noFetch })).toEqual({
    connected: { projectId: PROJECT, backendUrl: CLOUD_BACKEND_URL, env: { name: "VITE_CRITIQS_PROJECT_ID", file: join(app, ".env.local") } },
    backendUrl: CLOUD_BACKEND_URL,
  });
  await expect(beginSetup({ root: app, target: "https://team.convex.cloud", fetchFn: noFetch })).rejects.toThrow("Pass --new-project to replace it");
});

test("a missing or malformed setting is not a connection: setup reuses or creates a project and fixes only that line", async () => {
  const app = vite("billing", {
    "src/main.tsx": `import { Critiqs } from "critiqs-react";\nexport const A = () => <Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId backend="https://team.convex.cloud" />;\n`,
    ".env.local": "KEEP=1\nVITE_CRITIQS_PROJECT_ID=not-an-id\n",
  });
  chmodSync(join(app, "src/main.tsx"), 0o444);
  const backend = cloud({ mine: [{ _id: OTHER, name: "billing", reviewUrl: null }] });
  try {
    const result = await (await begin({ root: app, fetchFn: backend.fetchFn, ...signIn })).finish();
    expect(result).toMatchObject({ projectId: OTHER, reused: true, backendUrl: "https://team.convex.cloud", written: { ok: true } });
  } finally {
    chmodSync(join(app, "src/main.tsx"), 0o644);
  }
  expect(read(app, ".env.local")).toBe(`KEEP=1\nVITE_CRITIQS_PROJECT_ID=${OTHER}\n`);
  // The backend the code names is kept; nothing was created on Critiqs Cloud.
  expect(backend.calls.some((call) => call.url.startsWith(CLOUD_BACKEND_URL))).toBe(false);
  expect(backend.calls.some((call) => call.body?.path === "projects:create")).toBe(false);
});

test("workspace apps reuse only their own project by name", async () => {
  const root = workspace(["@admin/web", "@shop/web"]);
  const backend = cloud({ mine: [{ _id: OTHER, name: "web", reviewUrl: null }, { _id: "a".repeat(32), name: "acme-platform/apps/shop", reviewUrl: null }] });
  const result = await (await begin({ root: join(root, "apps/admin"), fetchFn: backend.fetchFn, ...signIn })).finish();
  expect(result).toMatchObject({ projectId: PROJECT, reused: false, projectName: "acme-platform/apps/admin" });
  expect(backend.calls.find((call) => call.body?.path === "projects:create")?.body.args.name).toBe("acme-platform/apps/admin");
});

test("an unwritable .env file is refused before sign-in; a late failure keeps the project and says what to add", async () => {
  const app = vite("billing", { ".env.local": "KEEP=1\n" });
  const backend = cloud();
  chmodSync(join(app, ".env.local"), 0o444);
  try {
    await expect(beginSetup({ root: app, fetchFn: backend.fetchFn, ...signIn })).rejects.toThrow("no project was created");
    expect(backend.calls).toEqual([]);
    expect(read(app, "src/main.tsx")).toBe(VITE_MAIN);
  } finally {
    chmodSync(join(app, ".env.local"), 0o644);
  }

  const pending = await begin({ root: app, target: "https://team.convex.cloud", fetchFn: backend.fetchFn, ...signIn });
  chmodSync(join(app, ".env.local"), 0o444);
  let result;
  try {
    result = await pending.finish();
  } finally {
    chmodSync(join(app, ".env.local"), 0o644);
  }
  expect(result).toMatchObject({ projectId: PROJECT, backendUrl: "https://team.convex.cloud", written: { ok: false } });
  expect(result.written.message).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}`);
  expect(read(app, ".env.local")).toBe("KEEP=1\n");
  expect(readiness(result)[0]).toMatchObject({ status: "fail", detail: expect.stringContaining(`The project ${PROJECT} already exists on https://team.convex.cloud`) });
  // The component was written, so a retry reconnects through the variable without creating another project.
  expect(read(app, "src/main.tsx")).toContain('backend="https://team.convex.cloud"');
  expect(runInit(["init", PROJECT, "--dir", app], quiet)).toBe(0);
  expect(await beginSetup({ root: app, fetchFn: backend.fetchFn })).toMatchObject({ connected: { projectId: PROJECT, backendUrl: "https://team.convex.cloud" } });
});

test("a late unreadable source keeps the project and gives the complete component and setting", async () => {
  const app = vite();
  const backend = cloud();
  const pending = await begin({ root: app, target: "https://team.convex.cloud", entry: "src/main.tsx", mount: "App", fetchFn: backend.fetchFn, ...signIn });
  chmodSync(join(app, "src/main.tsx"), 0o000);
  let result;
  try {
    result = await pending.finish();
  } finally {
    chmodSync(join(app, "src/main.tsx"), 0o644);
  }
  expect(result).toMatchObject({ projectId: PROJECT, written: { ok: false } });
  expect(result.written.message).toContain("src/main.tsx beside <App>");
  expect(result.written.message).toContain('<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId backend="https://team.convex.cloud" />');
  expect(result.written.message).toContain(`add VITE_CRITIQS_PROJECT_ID=${PROJECT} to .env.local`);
  expect(read(app, "src/main.tsx")).toBe(VITE_MAIN);
  expect(existsSync(join(app, ".env.local"))).toBe(false);
});

test("two projects with the app's name give one component and each project's setting to choose from", async () => {
  const app = vite();
  const backend = cloud({ mine: [{ _id: PROJECT, name: "billing", reviewUrl: null }, { _id: OTHER, name: "billing", reviewUrl: null }] });
  const error = await (await begin({ root: app, fetchFn: backend.fetchFn, ...signIn })).finish().catch((failure: Error) => failure);
  expect((error as Error).message).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />");
  expect((error as Error).message).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}\nVITE_CRITIQS_PROJECT_ID=${OTHER}`);
  expect(read(app, "src/main.tsx")).toBe(VITE_MAIN);
  expect(existsSync(join(app, ".env.local"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Checking, agents, and the command line

test("doctor reads the local setting, checks it with the backend, and says what it can't see", async () => {
  const component = (required: boolean) =>
    `import { Critiqs } from "critiqs-react";\nexport const A = () => <Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID}${required ? " requireProjectId" : ""} />;\n`;
  const backend = cloud();
  const project = async (files: Record<string, string>, required = true, env = {}) => {
    const checks = await doctor({ root: vite("billing", { "src/main.tsx": component(required), ...files }), fetchFn: backend.fetchFn, env });
    return { project: checks.find((check) => check.name === "Project"), deployments: checks.find((check) => check.name === "Deployments") };
  };
  const found = await project({ ".env.local": `VITE_CRITIQS_PROJECT_ID=${PROJECT}\n` });
  expect(found.project).toMatchObject({ status: "pass", basis: "observed", detail: `${PROJECT} (VITE_CRITIQS_PROJECT_ID in .env.local) exists on this backend.` });
  expect(found.deployments).toMatchObject({ status: "info", basis: "configuration", detail: expect.stringContaining("which doctor can't see; where it's unset, Critiqs stays hidden") });
  expect((await project({ ".env.local": `VITE_CRITIQS_PROJECT_ID=${OTHER}\n` })).project).toMatchObject({ status: "fail", basis: "observed", detail: expect.stringContaining("doesn't exist on this backend") });
  // A project limited to its organization isn't described to doctor, which doesn't sign in.
  expect((await project({ ".env.local": `VITE_CRITIQS_PROJECT_ID=${RESTRICTED}\n` })).project).toMatchObject({
    status: "warn",
    basis: "observed",
    detail: expect.stringContaining("the backend describes projects limited to their organization only to signed-in members"),
  });
  expect((await project({})).project).toMatchObject({ status: "warn", detail: expect.stringContaining("which no .env file here sets, so Critiqs stays hidden") });
  expect((await project({ ".env.local": "VITE_CRITIQS_PROJECT_ID=VITE_CRITIQS_PROJECT_ID\n" })).project).toMatchObject({ status: "fail", detail: expect.stringContaining("not a Critiqs project ID") });
  const committed = await project({ ".env": `VITE_CRITIQS_PROJECT_ID=${PROJECT}\n` }, false, { VITE_CRITIQS_PROJECT_ID: OTHER });
  const advice = committed.deployments?.detail ?? "";
  expect(committed.deployments?.status).toBe("warn");
  expect(advice).toContain("which is usually committed");
  expect(advice).toContain("This shell also sets VITE_CRITIQS_PROJECT_ID");
  expect(advice).toContain("Turn on requireProjectId");
  expect(readUsage(vite("billing", { "src/main.tsx": component(true) }))).toMatchObject({ usage: { requireProjectId: true, projectId: { kind: "env", variable: "VITE_CRITIQS_PROJECT_ID" } } });
});

test("MCP tools and the command line take the .env file and report the variable", async () => {
  expect(parseCommand(["init", "--project-env-file", "config/.env.local"])).toMatchObject({ envFile: "config/.env.local" });
  expect(parseCommand(["init", PROJECT, "--project-env-file=.env.dev.local"])).toMatchObject({ projectId: PROJECT, envFile: ".env.dev.local" });

  const app = vite("billing", { "vite.config.ts": "export default { envDir: process.env.ENV_DIR };", "config/.gitkeep": "" });
  const backend = cloud();
  const tools = createTools({ cwd: app, fetchFn: backend.fetchFn, open: () => {}, sleep: noWait });
  const refused = await tools.call("critiqs_setup_start", { signIn: "remote" });
  expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("--project-env-file") }] });
  expect(backend.calls).toEqual([]);
  const started = await tools.call("critiqs_setup_start", { signIn: "remote", envFile: "config/.env.local" });
  expect(started.isError).toBeUndefined();
  const finished = await tools.call("critiqs_setup_finish", {});
  expect(finished.structuredContent).toMatchObject({ ok: true, projectId: PROJECT, env: { name: "VITE_CRITIQS_PROJECT_ID", file: join(app, "config/.env.local") } });
  expect(read(app, "config/.env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}`);
  const diagnosed = await tools.call("critiqs_doctor", { envFile: "config/.env.local" });
  expect(diagnosed.structuredContent?.checks).toContainEqual(expect.objectContaining({ name: "Project", status: "pass", detail: expect.stringContaining(PROJECT) }));
  const reconnected = await tools.call("critiqs_setup_start", { envFile: "config/.env.local" });
  expect(reconnected.structuredContent).toMatchObject({ connected: { projectId: PROJECT }, ok: true });
  const written = await tools.call("critiqs_write_project_id", { projectId: OTHER, envFile: "config/.env.local" });
  expect(written.isError).toBeUndefined();
  expect(read(app, "config/.env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${OTHER}`);
  tools.close();
});

test("doctor and connected init keep a custom env file, and unresolved envDir is reported as unknown", async () => {
  const app = vite("billing", { "vite.config.ts": "export default { envDir: process.env.ENV_DIR };", "config/.gitkeep": "" });
  expect(runInit(["init", PROJECT, "--dir", app, "--project-env-file", "config/.env.local"], quiet)).toBe(0);
  const backend = cloud();
  const unknown = await doctor({ root: app, fetchFn: backend.fetchFn });
  const unknownProject = unknown.find((item) => item.name === "Project");
  expect(unknownProject?.status).toBe("warn");
  expect(unknownProject?.detail).toContain("--project-env-file");
  expect(unknownProject?.detail).not.toContain("stays hidden");
  const known = await doctor({ root: app, envFile: "config/.env.local", fetchFn: backend.fetchFn });
  expect(known.find((item) => item.name === "Project")).toMatchObject({ status: "pass", detail: expect.stringContaining("config/.env.local") });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = backend.fetchFn;
  try {
    for (const args of [["doctor", "--json"], ["init", "--json"]]) {
      const out = output();
      expect(await runCli([...args, "--project-env-file", "config/.env.local"], { cwd: app, print: out.print })).toBe(0);
      expect(JSON.parse(out.lines.at(-1)!)).toMatchObject({ ok: true, checks: expect.arrayContaining([expect.objectContaining({ name: "Project", status: "pass" })]) });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// ---------------------------------------------------------------------------
// Recovering from what setup can't read, and saying where to run what's left

test("an unreadable .env file is a structured refusal or warning, never a crash", async () => {
  const app = vite();
  mkdirSync(join(app, ".env.local"));
  // ID-only init refuses with what to do, and writes nothing.
  const out = output();
  expect(runInit(["init", PROJECT, "--dir", app], { cwd: app, print: out.print })).toBe(1);
  expect(out.lines.join("\n")).toContain(`Couldn't read .env.local, a .env file this app loads, so nothing was changed: it could set VITE_CRITIQS_PROJECT_ID to another project. Make it readable, then run setup again. Or add Critiqs where the app renders, and set VITE_CRITIQS_PROJECT_ID=${PROJECT} in .env.local.`);
  expect(read(app, "src/main.tsx")).toBe(VITE_MAIN);
  // The setup flow stops before anyone signs in.
  const noFetch = (async () => {
    throw new Error("Setup must stop before using the network");
  }) as unknown as typeof fetch;
  const refused = beginSetup({ root: app, fetchFn: noFetch, ...signIn });
  await expect(refused).rejects.toBeInstanceOf(SetupError);
  await expect(refused).rejects.toThrow("Couldn't read .env.local, a .env file this app loads");
  // Doctor warns that it can't read the local value, and its report is still JSON.
  writeFileSync(join(app, "src/main.tsx"), `import { Critiqs } from "critiqs-react";\nexport const A = () => <Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />;\n`);
  const report = doctorReport(await doctor({ root: app, fetchFn: cloud().fetchFn, env: {} }));
  expect(report.checks.find((check) => check.name === "Project")).toMatchObject({ status: "warn", detail: expect.stringContaining("reads VITE_CRITIQS_PROJECT_ID, but doctor can't determine its local value: Couldn't read .env.local.") });
  expect(JSON.parse(JSON.stringify(report))).toMatchObject({ ok: true });
});

test("a stale --entry doesn't stop init from updating the one Critiqs the code has", async () => {
  const app = vite("billing", { "src/main.tsx": `import { Critiqs } from "critiqs-react";\n${VITE_MAIN.replace("<App />", `<><App /><Critiqs projectId="${OTHER}" /></>`)}` });
  const out = output();
  expect(runInit(["init", PROJECT, "--dir", app, "--entry", "src/old-main.tsx"], out)).toBe(0);
  expect(read(app, "src/main.tsx")).toContain(`<Critiqs projectId="${PROJECT}" />`);
  // The setup flow doesn't need it either, when the code reads a variable this computer doesn't set yet.
  const reading = vite("billing", { "src/main.tsx": `import { Critiqs } from "critiqs-react";\n${VITE_MAIN.replace("<App />", "<><App /><Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId /></>")}` });
  const setup = await begin({ root: reading, entry: "src/old-main.tsx", fetchFn: cloud().fetchFn, ...signIn });
  setup.cancel();
  // Where Critiqs has to be added, a missing entry is still a usage error.
  const fresh = output();
  expect(runInit(["init", PROJECT, "--dir", vite(), "--entry", "src/old-main.tsx"], fresh)).toBe(2);
  expect(fresh.lines.join("\n")).toContain("src/old-main.tsx is not a file");
});

test("from a workspace root, the install step names the app for the workspace's package manager", () => {
  const managers: [Record<string, string>, string][] = [
    [{ "package-lock.json": "{}" }, "npm install critiqs-react --workspace @acme/shop"],
    [{ "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages:\n  - apps/*\n" }, "pnpm --filter ./apps/shop add critiqs-react"],
    [{ "yarn.lock": "" }, "yarn workspace @acme/shop add critiqs-react"],
    [{ "bun.lock": "" }, "bun add critiqs-react --cwd apps/shop"],
  ];
  for (const [lockfile, command] of managers) {
    const root = workspace();
    for (const [path, text] of Object.entries(lockfile)) writeFileSync(join(root, path), text);
    const out = output();
    expect(runInit(["init", PROJECT, "--dir", "apps/shop"], { cwd: root, print: out.print })).toBe(0);
    expect(out.lines).toContain(`Next: Install critiqs-react with the app's package manager: ${command}.`);
  }
  // Run in the app's own folder, the plain command installs there.
  const root = workspace();
  writeFileSync(join(root, "package-lock.json"), "{}");
  const out = output();
  expect(runInit(["init", PROJECT], { cwd: join(root, "apps/shop"), print: out.print })).toBe(0);
  expect(out.lines).toContain("Next: Install critiqs-react with the app's package manager: npm install critiqs-react.");
});

test("an unreadable .env file that loads before the one init writes is refused by name; nothing is written", async () => {
  // Vite loads .env.development.local before .env.local. If init can't read it, it can't tell which project Vite will use.
  const app = vite("billing", { ".env.development.local": `VITE_CRITIQS_PROJECT_ID=${OTHER}\n` });
  chmodSync(join(app, ".env.development.local"), 0o000);
  try {
    const out = output();
    expect(runInit(["init", PROJECT, "--dir", app], { cwd: app, print: out.print })).toBe(1);
    const message = out.lines.join("\n");
    expect(message).toStartWith("Couldn't read .env.development.local, a .env file this app loads, so nothing was changed");
    expect(message).toContain(`set VITE_CRITIQS_PROJECT_ID=${PROJECT} in .env.development.local if it sets VITE_CRITIQS_PROJECT_ID, otherwise in .env.local`);
    expect(existsSync(join(app, ".env.local"))).toBe(false);
    expect(existsSync(join(app, ".env.example"))).toBe(false);
    expect(read(app, "src/main.tsx")).toBe(VITE_MAIN);
    // The setup flow stops at the same file before anyone signs in.
    const noFetch = (async () => {
      throw new Error("Setup must stop before using the network");
    }) as unknown as typeof fetch;
    await expect(beginSetup({ root: app, fetchFn: noFetch, ...signIn })).rejects.toThrow("Couldn't read .env.development.local");
  } finally {
    chmodSync(join(app, ".env.development.local"), 0o644);
  }
  // .env.example isn't loaded, and only lists the variable for the next developer, so one setup can't read is left alone.
  const listed = vite("billing", { ".env.example": "KEEP=\n" });
  chmodSync(join(listed, ".env.example"), 0o000);
  try {
    expect(runInit(["init", PROJECT, "--dir", listed], quiet)).toBe(0);
  } finally {
    chmodSync(join(listed, ".env.example"), 0o644);
  }
  expect(read(listed, ".env.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}\n`);
  expect(read(listed, ".env.example")).toBe("KEEP=\n");
  // Readable again, the file that loads first keeps the setting, so the app uses the new project.
  expect(runInit(["init", PROJECT, "--dir", app], quiet)).toBe(0);
  expect(read(app, ".env.development.local")).toBe(`VITE_CRITIQS_PROJECT_ID=${PROJECT}\n`);
});

test("without a lockfile, the install step follows packageManager, then the workspace file, then npm", () => {
  const pnpmWorkspace = (manifest: Record<string, unknown>) =>
    tree({
      "package.json": JSON.stringify(manifest),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/shop/package.json": JSON.stringify({ name: "@acme/shop", devDependencies: { vite: "^8.0.0" } }),
      "apps/shop/src/main.tsx": VITE_MAIN,
    });
  const step = (root: string) => {
    const out = output();
    expect(runInit(["init", PROJECT, "--dir", "apps/shop"], { cwd: root, print: out.print })).toBe(0);
    return out.lines.find((line) => line.startsWith("Next: Install"));
  };
  expect(step(pnpmWorkspace({ name: "acme", private: true, packageManager: "pnpm@12.8.1" }))).toBe("Next: Install critiqs-react with the app's package manager: pnpm --filter ./apps/shop add critiqs-react.");
  expect(step(pnpmWorkspace({ name: "acme", private: true }))).toBe("Next: Install critiqs-react with the app's package manager: pnpm --filter ./apps/shop add critiqs-react.");
  const yarn = workspace();
  writeFileSync(join(yarn, "package.json"), JSON.stringify({ name: "acme-platform", private: true, workspaces: ["apps/*", "packages/*"], packageManager: "yarn@4.12.0" }));
  expect(step(yarn)).toBe("Next: Install critiqs-react with the app's package manager: yarn workspace @acme/shop add critiqs-react.");
  // A lockfile shows what the workspace really uses.
  writeFileSync(join(yarn, "package-lock.json"), "{}");
  expect(step(yarn)).toBe("Next: Install critiqs-react with the app's package manager: npm install critiqs-react --workspace @acme/shop.");
  expect(step(workspace())).toBe("Next: Install critiqs-react with the app's package manager: npm install critiqs-react --workspace @acme/shop.");
});

test("paths in printed commands are quoted when they have spaces", () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*"] }),
    "bun.lock": "",
    "apps/client app/package.json": JSON.stringify({ name: "@acme/client", devDependencies: { vite: "^8.0.0" } }),
    "apps/client app/src/main.tsx": VITE_MAIN,
  });
  const refused = output();
  expect(runInit(["init", PROJECT], { cwd: root, print: refused.print })).toBe(1);
  expect(refused.lines.join("\n")).toContain(`  npx critiqs init ${PROJECT} --dir "apps/client app"`);
  const out = output();
  expect(runInit(["init", PROJECT, "--dir", "apps/client app"], { cwd: root, print: out.print })).toBe(0);
  expect(out.lines).toContain('Next: Install critiqs-react with the app\'s package manager: bun add critiqs-react --cwd "apps/client app".');
});

test("a React Vite app's ID in .env.development, which Vite reads before .env.local, is overridden from .env.development.local", () => {
  const app = vite("billing", { ".env.development": `VITE_CRITIQS_PROJECT_ID=${OTHER}\n`, ".env.local": "KEEP=1\n" });
  expect(wiringOf(app).target).toMatchObject({ files: [".env.development.local", ".env.development", ".env.local", ".env"].map((file) => join(app, file)), local: join(app, ".env.development.local") });
  expect(runInit(["init", PROJECT, "--dir", app], quiet)).toBe(0);
  expect(read(app, ".env.development.local")).toContain(`VITE_CRITIQS_PROJECT_ID=${PROJECT}\n`);
  expect(read(app, ".env.local")).toBe("KEEP=1\n");
  expect(readEnvValue(wiringOf(app).target!, "VITE_CRITIQS_PROJECT_ID")).toEqual({ value: PROJECT, file: join(app, ".env.development.local") });
  // Next.js reads .env.local before .env.development, so .env.local is still the file there.
  const next = tree({ "package.json": JSON.stringify({ name: "web", dependencies: { next: "^16.0.0", react: "^19.3.0", "react-dom": "^19.3.0" } }), "app/layout.tsx": NEXT_LAYOUT, ".env.development": `NEXT_PUBLIC_CRITIQS_PROJECT_ID=${OTHER}\n` });
  expect(wiringOf(next).target?.local).toBe(join(next, ".env.local"));
});

test("workspace apps that share a package name each get a command that installs into that app alone", () => {
  const shared = (lockfile: Record<string, string>) => {
    const root = workspace(["@acme/client", "@acme/client"]);
    for (const [path, text] of Object.entries(lockfile)) writeFileSync(join(root, path), text);
    return root;
  };
  const step = (cwd: string, dir: string) => {
    const out = output();
    expect(runInit(["init", PROJECT, "--dir", dir], { cwd, print: out.print })).toBe(0);
    return out.lines.find((line) => line.startsWith("Next: Install"));
  };
  const pnpm = { "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n" };
  // pnpm's directory selector names one folder, relative to where it runs.
  const fromRoot = shared(pnpm);
  expect(step(fromRoot, "apps/shop")).toBe("Next: Install critiqs-react with the app's package manager: pnpm --filter ./apps/shop add critiqs-react.");
  const fromOther = shared(pnpm);
  expect(step(join(fromOther, "apps/admin"), "../shop")).toBe("Next: Install critiqs-react with the app's package manager: pnpm --filter ../shop add critiqs-react.");
  // npm refuses duplicate workspace names, so the command names the folder and says what npm needs first.
  expect(step(shared({ "package-lock.json": "{}" }), "apps/shop")).toBe(
    "Next: Install critiqs-react with the app's package manager: npm install critiqs-react --workspace ./apps/shop (npm needs each workspace package to have its own name first: apps/admin is also @acme/client).",
  );
  // Yarn names workspaces only by package name, so the command runs in the app's folder instead.
  expect(step(shared({ "yarn.lock": "" }), "apps/shop")).toBe("Next: Install critiqs-react with the app's package manager, in apps/shop: yarn add critiqs-react.");
});

test("from inside the app's own folders, pnpm's selector climbs to the app", () => {
  const root = workspace();
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  const out = output();
  expect(runInit(["init", PROJECT, "--dir", ".."], { cwd: join(root, "apps/shop/src"), print: out.print })).toBe(0);
  expect(out.lines).toContain("Next: Install critiqs-react with the app's package manager: pnpm --filter .. add critiqs-react.");
});

test("in Python and Ruby a default is read and replaced in place; Python places a new one after Django's or the last import, Ruby at the end", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-code-env-"));
  const at = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return { files: [join(dir, name)], local: join(dir, name), label: null };
  };
  const script = at("run.py", "#!/usr/bin/env python\nimport sys\n\nmain(sys.argv)\n");
  const added = planEnv(script, "CRITIQS_PROJECT_ID", PROJECT);
  expect(added).toMatchObject({ changed: true, example: null });
  expect(added.source).toBe(
    "#!/usr/bin/env python\nimport sys\nimport os\n# Critiqs project for this app in development; the environment wins. Each deployment sets its own.\n" +
      `os.environ.setdefault("CRITIQS_PROJECT_ID", "${PROJECT}")\n\nmain(sys.argv)\n`,
  );
  // Either quote style is read and replaced, keeping the indentation; the first default is the one Python keeps.
  const indented = at("manage.py", `def main():\n    os.environ.setdefault('CRITIQS_PROJECT_ID', 'old')\n    os.environ.setdefault("CRITIQS_PROJECT_ID", "later")\n`);
  expect(readEnvValue(indented, "CRITIQS_PROJECT_ID")).toEqual({ value: "old", file: indented.local });
  expect(planEnv(indented, "CRITIQS_PROJECT_ID", PROJECT).source).toBe(`def main():\n    os.environ.setdefault("CRITIQS_PROJECT_ID", "${PROJECT}")\n    os.environ.setdefault("CRITIQS_PROJECT_ID", "${PROJECT}")\n`);

  const ruby = at("development.rb", "Rails.application.configure do\nend");
  expect(planEnv(ruby, "CRITIQS_PROJECT_ID", PROJECT).source).toBe(
    `Rails.application.configure do\nend\n\n# Critiqs project for this app in development; the environment wins. Each deployment sets its own.\nENV["CRITIQS_PROJECT_ID"] ||= "${PROJECT}"`,
  );
  const set = at("set.rb", `ENV['CRITIQS_PROJECT_ID'] ||= 'old' # set by hand\n`);
  expect(readEnvValue(set, "CRITIQS_PROJECT_ID")?.value).toBe("old");
  expect(planEnv(set, "CRITIQS_PROJECT_ID", PROJECT).source).toBe(`ENV["CRITIQS_PROJECT_ID"] ||= "${PROJECT}"\n`);
  // A plain assignment written by hand is read too, and gets the new value as a plain assignment.
  const plain = at("plain.rb", `Rails.application.configure do\nend\n  ENV['CRITIQS_PROJECT_ID'] = 'old'\n`);
  expect(readEnvValue(plain, "CRITIQS_PROJECT_ID")?.value).toBe("old");
  expect(planEnv(plain, "CRITIQS_PROJECT_ID", PROJECT).source).toBe(`Rails.application.configure do\nend\n  ENV["CRITIQS_PROJECT_ID"] = "${PROJECT}"\n`);
  // A comparison isn't a definition.
  expect(readEnvValue(at("compare.rb", `puts 1 if ENV["CRITIQS_PROJECT_ID"] == "old"\n`), "CRITIQS_PROJECT_ID")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
