// Builds real React applications against the packed critiqs-react, after
// `critiqs init` adds the component to each: a Vite single-page app on React
// 18 and on React 19, and Next.js with the App Router (a server layout) and
// with the Pages Router. Init wires each to its framework's public project ID
// variable and sets it in .env.local; each is built for production, and some
// again with another deployment's value or none. The Next.js App Router app is
// also served and fetched.
//
// Then a workspace with two Vite apps (one loading .env files from the
// workspace root) is set up one app at a time, built, and served on one origin
// with Critiqs's own SQLite server, and Chrome checks in the browser that each
// app shows only its own project's feedback, and that a copy built without a
// project ID, or with a malformed one, adds nothing to the page and makes no
// Critiqs requests, even with a project remembered on that origin. Set
// CHROME_PATH to choose the browser, and CRITIQS_EVIDENCE_DIR to keep
// screenshots. Needs the npm registry; run with `bun run check:consumers`
// after `bun run build`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageDir = join(root, "packages/react");
const scratch = await mkdtemp(join(tmpdir(), "critiqs-consumers-"));
const PROJECT = "j12345678901234567890123456789012";
/** Another deployment's project. */
const OTHER = "k12345678901234567890123456789012";
const CLI = ["node", "node_modules/critiqs-react/bin/critiqs.mjs"];
const timings: Record<string, number> = {};

async function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}) in ${cwd}:\n${stdout}\n${stderr}`);
  return stdout;
}

async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
}

/**
 * Writes an app, installs it with the packed package, and runs `critiqs init`
 * twice: the first wires the component to `variable` and sets it in
 * .env.local; the second must change nothing.
 */
async function app(name: string, files: Record<string, string>, dependencies: string[], entry: string, variable: string, access: string) {
  const dir = join(scratch, name);
  await mkdir(dir);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
  await timed(`${name}: npm install`, () => run(["npm", "install", "--no-audit", "--no-fund", tarball, ...dependencies], dir));
  const before = await Bun.file(join(dir, entry)).text();
  await timed(`${name}: critiqs init`, () => run([...CLI, "init", PROJECT], dir));
  const after = await Bun.file(join(dir, entry)).text();
  assert(after.includes(`<Critiqs projectId={${access}.${variable}} requireProjectId />`), `${name}: init didn't add Critiqs to ${entry}:\n${after}`);
  assert(after.includes('import { Critiqs } from "critiqs-react"') || after.includes("import { Critiqs } from 'critiqs-react'"), `${name}: no import`);
  assert(!after.includes("use client") || before.includes("use client"), `${name}: init must not make the file a client component`);
  assert((await Bun.file(join(dir, ".env.local")).text()).includes(`${variable}=${PROJECT}`), `${name}: init didn't set ${variable} in .env.local`);
  assert((await Bun.file(join(dir, ".env.example")).text()).includes(`${variable}=\n`), `${name}: init didn't list ${variable} in .env.example`);
  const again = await run([...CLI, "init", PROJECT], dir);
  assert(again.includes("already uses this project ID"), `${name}: a second init changed something: ${again}`);
  assert.equal(await Bun.file(join(dir, entry)).text(), after);
  return dir;
}

/** The text of a folder's JavaScript files. */
async function scripts(dir: string, pattern: string) {
  const files = Array.from(new Bun.Glob(pattern).scanSync({ cwd: dir }));
  return (await Promise.all(files.map((file) => Bun.file(join(dir, file)).text()))).join("\n");
}

const VITE_FILES = {
  "package.json": JSON.stringify({ private: true, type: "module", scripts: { build: "vite build" } }),
  "index.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
  "vite.config.js": 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n',
  "src/App.jsx": "export default function App() {\n  return <main>Prototype</main>;\n}\n",
  "src/main.jsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
};

const NEXT_APP_FILES = {
  "package.json": JSON.stringify({ private: true, scripts: { build: "next build", start: "next start" } }),
  "next.config.mjs": "export default {};\n",
  "app/layout.jsx": `export const metadata = { title: "Prototype" };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n`,
  // A server component page, so the build proves the layout stays on the server.
  "app/page.jsx": `export default async function Page() {\n  const rendered = await Promise.resolve("on the server");\n  return <main>Prototype rendered {rendered}</main>;\n}\n`,
};

const NEXT_PAGES_FILES = {
  "package.json": JSON.stringify({ private: true, scripts: { build: "next build" } }),
  "next.config.mjs": "export default {};\n",
  "pages/_app.jsx": `export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`,
  "pages/index.jsx": `export default function Home() {\n  return <main>Prototype</main>;\n}\n`,
};

/** The browser to drive: CHROME_PATH, or a usual Chrome or Chromium location. */
function chrome(): string {
  const found = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => path !== undefined && path !== "" && existsSync(path));
  if (found === undefined) throw new Error("The workspace check needs Chrome or Chromium: set CHROME_PATH to its executable.");
  return found;
}

const viteApp = (name: string, base: string, config = "") => ({
  [`apps/${name}/package.json`]: JSON.stringify({ name: `@acme/${name}`, private: true, type: "module", dependencies: { "critiqs-react": `file:${tarball}`, react: "^19", "react-dom": "^19" }, devDependencies: { vite: "^8", "@vitejs/plugin-react": "^6" } }),
  [`apps/${name}/index.html`]: `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
  [`apps/${name}/vite.config.js`]: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ base: "${base}", plugins: [react()]${config} });\n`,
  [`apps/${name}/src/App.jsx`]: `export default function App() {\n  return <main><h1>${name}</h1><button>Continue</button></main>;\n}\n`,
  // Critiqs already placed by hand with the team's own server; init connects it.
  [`apps/${name}/src/main.jsx`]: `import { createRoot } from "react-dom/client";\nimport { Critiqs } from "critiqs-react";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<><App /><Critiqs backend="/critiqs" /></>);\n`,
});

/**
 * Two Vite apps in one npm workspace, served on one origin with Critiqs's own
 * server: admin at /, loading .env files from the workspace root, and shop
 * at /shop/ with its own. Each is set up with its own project; shop is
 * also built without a project ID and with a malformed one.
 */
async function workspace() {
  const ws = join(scratch, "workspace");
  const files = {
    "package.json": JSON.stringify({ name: "acme-platform", private: true, workspaces: ["apps/*"] }),
    ...viteApp("admin", "/", ', envDir: "../.."'),
    ...viteApp("shop", "/shop/"),
  };
  for (const [path, text] of Object.entries(files)) await Bun.write(join(ws, path), text);
  await run(["npm", "install", "--no-audit", "--no-fund"], ws);
  await run(["npm", "install", "--no-audit", "--no-fund", "--no-save", "playwright-core@1"], ws);

  // Critiqs's own server, with the host app's sign-in, from the packed package.
  const { createCritiqsHandler } = await import(join(ws, "node_modules/critiqs-react/dist/server/index.js"));
  const critiqs = await createCritiqsHandler({ database: join(ws, "critiqs.sqlite"), identify: () => ({ id: "1", name: "Pat", email: "pat@example.com" }) });
  const call = async (name: string, args: unknown) => {
    const response = await critiqs.fetch(new Request(`http://localhost/critiqs/api/${name}`, { method: "POST", headers: { "X-Critiqs-Request": "1" }, body: JSON.stringify(args) }));
    const result = await response.json();
    if (!response.ok) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result.value;
  };
  const comment = (projectId: string, body: string) =>
    call("createThread", {
      projectId,
      anchor: {
        screen: "/",
        viewState: {},
        scope: "shared",
        target: { purposeId: null, recordKey: null, clues: { tagName: "button", role: null, label: "Continue", path: "main:1>button:1" } },
        evidence: { url: "http://localhost/", viewport: { width: 1280, height: 800 }, marker: null, capturedAt: Date.now(), revision: null, persona: null, userAgent: null },
      },
      body,
      tags: [],
      capture: { status: "failed", failureReason: "Created by the consumer check" },
    });
  const adminProject: string = await call("createProject", { name: "acme-platform/admin" });
  const shopProject: string = await call("createProject", { name: "acme-platform/shop" });
  await comment(adminProject, "Admin feedback only");
  await comment(shopProject, "Shop feedback only");

  try {
    // At the workspace root, init names each app and changes nothing.
    const refused = Bun.spawnSync([...CLI, "init", adminProject], { cwd: ws, stdout: "pipe", stderr: "pipe" });
    assert.equal(refused.exitCode, 1, "workspace: init at the root should refuse");
    assert(refused.stdout.toString().includes(`--dir apps/admin\n  npx critiqs-react init ${adminProject} --dir apps/shop`), `workspace: ${refused.stdout}`);
    assert(!existsSync(join(ws, ".env.local")), "workspace: init at the root wrote a setting");

    await run([...CLI, "init", adminProject, "--dir", "apps/admin"], ws);
    const shopBefore = await Bun.file(join(ws, "apps/shop/src/main.jsx")).text();
    assert(!shopBefore.includes("projectId"), "workspace: setting up admin changed shop");
    await run([...CLI, "init", shopProject, "--dir", "apps/shop"], ws);
    const adminSource = await Bun.file(join(ws, "apps/admin/src/main.jsx")).text();
    assert(adminSource.includes('<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID_ADMIN} requireProjectId backend="/critiqs" />'), adminSource);
    assert((await Bun.file(join(ws, ".env.local")).text()).includes(`VITE_CRITIQS_PROJECT_ID_ADMIN=${adminProject}`), "workspace: admin's setting isn't in the root .env.local");
    assert((await Bun.file(join(ws, "apps/shop/.env.local")).text()).includes(`VITE_CRITIQS_PROJECT_ID_SHOP=${shopProject}`), "workspace: shop's setting isn't in its .env.local");
    // A generic variable shared by the whole build doesn't configure either app.
    const shared = { ...process.env, VITE_CRITIQS_PROJECT_ID: adminProject };
    await run(["npx", "vite", "build"], join(ws, "apps/admin"), shared);
    await run(["npx", "vite", "build"], join(ws, "apps/shop"), shared);
    await run(["npx", "vite", "build", "--base", "/shop-off/", "--outDir", "dist-off"], join(ws, "apps/shop"), { ...shared, VITE_CRITIQS_PROJECT_ID_SHOP: "" });
    await run(["npx", "vite", "build", "--base", "/shop-bad/", "--outDir", "dist-bad"], join(ws, "apps/shop"), { ...shared, VITE_CRITIQS_PROJECT_ID_SHOP: "not-a-project-id" });
    assert(!(await scripts(join(ws, "apps/shop"), "dist/assets/*.js")).includes(adminProject), "workspace: shop's build has admin's project");

    const sites: [string, string][] = [
      ["/shop-off/", join(ws, "apps/shop/dist-off")],
      ["/shop-bad/", join(ws, "apps/shop/dist-bad")],
      ["/shop/", join(ws, "apps/shop/dist")],
      ["/", join(ws, "apps/admin/dist")],
    ];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/critiqs" || pathname.startsWith("/critiqs/")) return critiqs.fetch(request, { remoteAddress: "127.0.0.1" });
        const [base, dir] = sites.find(([prefix]) => pathname.startsWith(prefix))!;
        const file = Bun.file(join(dir, pathname.slice(base.length) || "index.html"));
        return new Response((await file.exists()) && !pathname.includes("..") ? file : Bun.file(join(dir, "index.html")));
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const { chromium } = await import(join(ws, "node_modules/playwright-core/index.mjs"));
    const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
    const evidence = process.env.CRITIQS_EVIDENCE_DIR;
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      // The sidebar starts open, and a project another app on this origin set up in the browser is remembered.
      await context.addInitScript(([key, project]: [string, string]) => {
        localStorage.setItem("critiqs:sidebar-open", "true");
        localStorage.setItem(key, JSON.stringify(project));
      }, [`critiqs:project:${origin}/critiqs`, adminProject]);
      const visit = async (path: string) => {
        const page = await context.newPage();
        const requests: string[] = [];
        const warnings: string[] = [];
        page.on("request", (request: any) => {
          if (new URL(request.url()).pathname.startsWith("/critiqs")) requests.push(`${request.url()} ${request.postData() ?? ""}`);
        });
        page.on("console", (message: any) => message.type() === "warning" && warnings.push(message.text()));
        await page.goto(`${origin}${path}`);
        await page.waitForSelector("main h1");
        return { page, requests, warnings };
      };
      // The comments list is Comment mode's sidebar; Browse mode's shows the project.
      const showComments = (page: any) => page.locator('critiqs-root [aria-label="Comment mode"]').click({ timeout: 15_000 });

      for (const [path, own, other, project, foreign] of [
        ["/", "Admin feedback only", "Shop feedback only", adminProject, shopProject],
        ["/shop/", "Shop feedback only", "Admin feedback only", shopProject, adminProject],
      ] as const) {
        const { page, requests } = await visit(path);
        await showComments(page);
        await page.getByText(own).waitFor({ timeout: 15_000 });
        assert.equal(await page.getByText(other).count(), 0, `workspace: ${path} shows another app's feedback`);
        assert(requests.some((request) => request.includes(project)), `workspace: ${path} didn't ask for its own project`);
        assert(!requests.some((request) => request.includes(foreign)), `workspace: ${path} asked for another app's project`);
        if (evidence) await page.screenshot({ path: join(evidence, `workspace-${path === "/" ? "admin" : "shop"}.png`) });
        await page.close();
      }
      for (const path of ["/shop-off/", "/shop-bad/"]) {
        const { page, requests, warnings } = await visit(path);
        await page.waitForTimeout(1500);
        assert.equal(await page.evaluate(() => document.querySelectorAll("critiqs-root").length), 0, `workspace: ${path} added Critiqs to the page`);
        assert.deepEqual(requests, [], `workspace: ${path} made Critiqs requests`);
        assert.equal(warnings.some((warning) => warning.includes("is not a Critiqs project ID")), path === "/shop-bad/", `workspace: ${path} console: ${warnings.join("\n")}`);
        if (evidence) await page.screenshot({ path: join(evidence, `workspace-${path.slice(1, -1)}.png`) });
        await page.close();
      }
      // Turning one app off leaves the other working in the same browser.
      const { page } = await visit("/");
      await showComments(page);
      await page.getByText("Admin feedback only").waitFor({ timeout: 15_000 });
      await page.close();
    } finally {
      await browser.close();
      server.stop(true);
    }
  } finally {
    critiqs.close();
  }
}

let tarball = "";
try {
  const [packed] = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", scratch], packageDir));
  tarball = join(scratch, packed.filename);

  for (const react of ["18", "19"]) {
    const name = `vite-react${react}`;
    const dir = await app(name, VITE_FILES, [`react@${react}`, `react-dom@${react}`, "vite@8", "@vitejs/plugin-react@6"], "src/main.jsx", "VITE_CRITIQS_PROJECT_ID", "import.meta.env");
    await timed(`${name}: production build`, () => run(["npx", "vite", "build"], dir));
    const code = await scripts(dir, "dist/assets/*.js");
    assert(code.includes("critiqs-root"), `${name}: the build doesn't contain Critiqs`);
    assert(code.includes(PROJECT), `${name}: the build doesn't contain the project ID`);
    if (react === "19") {
      // Another deployment builds the same commit with its own value, or none, without editing the source.
      await timed(`${name}: build for another deployment`, () => run(["npx", "vite", "build"], dir, { ...process.env, VITE_CRITIQS_PROJECT_ID: OTHER }));
      const other = await scripts(dir, "dist/assets/*.js");
      assert(other.includes(OTHER) && !other.includes(PROJECT), `${name}: a deployment's own value didn't replace this computer's`);
      await timed(`${name}: build with Critiqs off`, () => run(["npx", "vite", "build"], dir, { ...process.env, VITE_CRITIQS_PROJECT_ID: "" }));
      assert(!(await scripts(dir, "dist/assets/*.js")).includes(PROJECT), `${name}: a deployment without a value still has this computer's`);
    }
  }

  const nextApp = await app("next-app-router", NEXT_APP_FILES, ["next@16", "react@19", "react-dom@19"], "app/layout.jsx", "NEXT_PUBLIC_CRITIQS_PROJECT_ID", "process.env");
  await timed("next-app-router: production build", () => run(["npx", "next", "build"], nextApp, { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }));
  // Serve it and fetch the page: rendered on the server, with Critiqs as a client component.
  const port = 4300 + Math.floor(Math.random() * 500);
  // Next's own script, not npx, so stopping it stops the server.
  const server = Bun.spawn(["node", "node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: nextApp,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let html = "";
    for (let attempt = 0; attempt < 100 && html === ""; attempt++) {
      await Bun.sleep(200);
      html = await fetch(`http://127.0.0.1:${port}/`).then((response) => (response.ok ? response.text() : ""), () => "");
    }
    // React separates adjacent text with a comment.
    assert(html.replaceAll("<!-- -->", "").includes("Prototype rendered on the server"), "next-app-router: the page wasn't served");
    assert(html.includes(PROJECT), "next-app-router: Critiqs wasn't passed to the client");
  } finally {
    server.kill();
    await server.exited;
  }

  const nextPages = await app("next-pages-router", NEXT_PAGES_FILES, ["next@16", "react@19", "react-dom@19"], "pages/_app.jsx", "NEXT_PUBLIC_CRITIQS_PROJECT_ID", "process.env");
  // A deployment's build settings win over this computer's .env.local.
  await timed("next-pages-router: production build for another deployment", () =>
    run(["npx", "next", "build"], nextPages, { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_CRITIQS_PROJECT_ID: OTHER }),
  );
  const pagesCode = await scripts(nextPages, ".next/static/chunks/**/*.js");
  assert(pagesCode.includes(OTHER) && !pagesCode.includes(PROJECT), "next-pages-router: the deployment's own project ID wasn't built in");

  await timed("workspace: two apps in one browser", () => workspace());

  console.log(
    "Consumer builds passed: Vite with React 18 and 19, Next.js App Router (built and served) and Pages Router, each set up by critiqs init with its project ID variable and unchanged by a second run; " +
      "builds for another deployment and with Critiqs off; and a two-app workspace, set up one app at a time, checked in Chrome.",
  );
  console.log(JSON.stringify({ timingsMs: timings }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
