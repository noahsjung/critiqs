// Measures, step by step, how long a developer's part of setup takes on this
// computer, from installing the packed critiqs-react to a reviewer's comment
// saved and read back:
//
//   1. install the package into a new Vite React app;
//   2. create a project on a backend (Critiqs's self-hosted server on a SQLite
//      file, with the host app's sign-in, so nothing waits on email);
//   3. `critiqs init <projectId>` adds <Critiqs /> to the app's root;
//   4. build the app for production;
//   5. a reviewer's comment is saved, and read back after the server restarts.
//
// It doesn't measure what needs people or services: email sign-in codes
// arriving, browser sign-in and consent, deploying the prototype, or a second
// reviewer on another computer. Those are listed as not measured in the
// report, which is printed and, with a path, also written as JSON:
//
//   bun run build && bun scripts/measure-setup.ts [report.json]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "critiqs-measure-"));
const steps: { step: string; ms: number }[] = [];

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout;
}

async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  steps.push({ step: name, ms: Math.round(performance.now() - started) });
  return result;
}

/** Runs a Node script in the app that talks to the self-hosted server on `critiqs.sqlite`; returns its JSON output. */
async function server(app: string, body: string): Promise<any> {
  await Bun.write(join(app, "server-step.mjs"), `
    const { createCritiqsHandler } = await import("critiqs-react/server");
    const critiqs = await createCritiqsHandler({ database: "critiqs.sqlite", identify: () => ({ id: "1", name: "Pat", email: "pat@example.com" }) });
    const call = async (name, args) => {
      const response = await critiqs.fetch(new Request("http://localhost/critiqs/api/" + name, { method: "POST", headers: { "X-Critiqs-Request": "1" }, body: JSON.stringify(args) }));
      const result = await response.json();
      if (!response.ok) throw new Error(name + ": " + JSON.stringify(result));
      return result.value;
    };
    const output = await (async () => { ${body} })();
    critiqs.close();
    console.log(JSON.stringify(output));
  `);
  return JSON.parse((await run(["node", "--no-warnings", "server-step.mjs"], app)).trim());
}

const started = performance.now();
try {
  const [packed] = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", scratch], join(root, "packages/react")));
  const app = join(scratch, "app");
  await Bun.write(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await Bun.write(join(app, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n');
  await Bun.write(join(app, "vite.config.js"), 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n');
  await Bun.write(join(app, "src/App.jsx"), "export default function App() {\n  return <main>Prototype</main>;\n}\n");
  await Bun.write(join(app, "src/main.jsx"), 'import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n');

  await step("Install critiqs-react (and the app's React and Vite)", () =>
    run(["npm", "install", "--no-audit", "--no-fund", join(scratch, packed.filename), "react@19", "react-dom@19", "vite@8", "@vitejs/plugin-react@6"], app),
  );
  const projectId: string = await step("Create a project", () => server(app, 'return await call("createProject", { name: "Prototype" });'));
  const init = await step("critiqs init adds <Critiqs /> with the project ID", () => run(["node", "node_modules/critiqs-react/bin/critiqs.mjs", "init", projectId], app));
  assert(init.includes("Added <Critiqs /> to src/main.jsx"), init);
  await step("Production build", () => run(["npx", "vite", "build"], app));
  const threadId: string = await step("A reviewer's comment is saved", () =>
    server(
      app,
      `return await call("createThread", {
        projectId: ${JSON.stringify(projectId)},
        anchor: { screen: "/", viewState: {}, scope: "shared", target: { purposeId: null, recordKey: null, clues: { tagName: "main", role: null, label: "Prototype", path: "main:1" } },
          evidence: { url: "http://localhost:5173/", viewport: { width: 1280, height: 800 }, marker: null, capturedAt: Date.now(), revision: null, persona: null, userAgent: null } },
        body: "The heading needs a clearer label #wording",
        tags: [],
        capture: { status: "failed", failureReason: "Measured without a browser" },
      });`,
    ),
  );
  const threads = await step("The comment is read back after the server restarts", () => server(app, `return await call("threads", { projectId: ${JSON.stringify(projectId)} });`));
  assert(JSON.stringify(threads).includes(threadId), "The saved comment wasn't read back");

  const report = {
    measured: steps,
    totalMs: Math.round(performance.now() - started),
    // Install time depends on the network and on what npm already has cached.
    environment: { node: (await run(["node", "--version"], app)).trim(), bun: Bun.version, platform: process.platform },
    backend: "Critiqs's self-hosted server on a SQLite file, with the host app's sign-in",
    notMeasured: [
      "Email sign-in: a code arriving through Critiqs Cloud's email provider, and typing it",
      "Browser steps: opening the prototype, site consent, choosing an element, and writing the comment",
      "Deploying the prototype, and Critiqs Cloud running a backend for this version",
      "A second reviewer on another computer reading the comment over HTTPS",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[2]) await Bun.write(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
