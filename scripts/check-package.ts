import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sharedDir = join(root, "packages/critiqs");
const reactDir = join(root, "packages/react");
const scratch = await mkdtemp(join(tmpdir(), "critiqs-package-"));

async function run(command: string[], cwd = scratch, env = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (status !== 0) throw new Error(`${command[0]} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout;
}

/** Fails when the packed package contains something that looks like a credential or a local path. */
async function scanForSecrets(dir: string) {
  const patterns: [string, RegExp][] = [
    ["a Resend key", /\bre_[A-Za-z0-9_]{20,}/],
    ["an OpenAI-style key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
    ["a Convex deploy key", /\b(?:prod|preview|dev):[a-z0-9-]+\|[A-Za-z0-9+/=]{20,}/],
    ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----|"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/],
    ["an AWS or R2 access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
    ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
    ["a local home path", /\/(?:home|Users)\/[a-z][\w.-]*\//],
  ];
  for (const file of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })) {
    const text = await Bun.file(join(dir, file)).text();
    for (const [what, pattern] of patterns) assert(!pattern.test(text), `${file} contains what looks like ${what}`);
  }
}

/**
 * In an isolated consumer: Critiqs mounts in production React and refuses an
 * older backend (no network needed), and renders nothing on the server.
 */
async function reactConsumerChecks(dir: string, reactMajor = "19.") {
  await Bun.write(join(dir, "mount.mjs"), `import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
const React = await import("react");
assert(React.version.startsWith(${JSON.stringify(reactMajor)}), "Expected React " + ${JSON.stringify(reactMajor)} + ", found " + React.version);
const { createRoot } = await import("react-dom/client");
const { Critiqs } = await import("critiqs-react");
const container = document.createElement("div");
document.body.appendChild(container);
let failure;
const root = createRoot(container, { onUncaughtError(error) { failure = error; } });
// A local backend from before the current protocol, so the check needs no network:
// Critiqs should mount, reach it, and refuse it. A backend's site is on the next port.
const { createServer } = await import("node:http");
let requests = 0;
const site = createServer((request, response) => {
  requests++;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ signInUrl: "http://127.0.0.1:1" }));
});
await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
const backend = \`http://127.0.0.1:\${site.address().port - 1}\`;
try {
  // Required but missing or malformed: nothing on the page, and no requests.
  for (const projectId of [undefined, "", "not-a-project"]) {
    root.render(React.createElement(Critiqs, { backend, projectId, requireProjectId: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(document.querySelector("critiqs-root"), null, "Critiqs mounted without a valid required project ID");
  }
  assert.equal(requests, 0, "Critiqs contacted a backend without a valid required project ID");
  root.render(React.createElement(Critiqs, { backend }));
  for (let attempt = 0; attempt < 100 && !document.querySelector("critiqs-root")?.shadowRoot?.textContent.includes("runs an older version") && !failure; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (failure) throw failure;
  assert(document.querySelector("critiqs-root")?.shadowRoot?.textContent.includes("runs an older version"), "Critiqs did not mount and refuse an older backend");
} finally {
  root.unmount();
  site.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  GlobalRegistrator.unregister();
}
`);
  await run(["node", "mount.mjs"], dir, { ...process.env, NODE_ENV: "production" });
  // Server rendering, without a DOM: the component renders nothing until it mounts in the browser.
  await run(["node", "--input-type=module", "-e", `
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { Critiqs } = await import("critiqs-react");
    const html = renderToString(React.createElement("main", null, "App", React.createElement(Critiqs, { projectId: "j12345678901234567890123456789012" }), React.createElement(Critiqs, { projectId: "j12345678901234567890123456789012", requireProjectId: true })));
    if (html !== "<main>App</main>") { console.error(html); process.exit(1); }
  `], dir, { ...process.env, NODE_ENV: "production" });
}

/** The files `npm pack` would publish, after checking each expected file is there and nothing else is. */
async function packedFiles(dir: string, expected: string[], allowed: RegExp): Promise<string[]> {
  const [dryRun] = JSON.parse(await run(["npm", "pack", "--dry-run", "--json"], dir));
  const files: string[] = dryRun.files.map((file: { path: string }) => file.path);
  for (const name of expected) assert(files.includes(name), `${dryRun.name}: missing ${name}`);
  const unexpected = files.filter((path) => !allowed.test(path));
  assert.deepEqual(unexpected, [], `${dryRun.name}: unexpected tarball contents`);
  return files;
}

/** Ready for the public registry: no private flag, a license, public access, and the runtime it needs. */
async function checkManifest(dir: string, name: string) {
  const installed = await Bun.file(join(dir, `node_modules/${name}/package.json`)).json();
  assert.equal(installed.private, undefined);
  assert.equal(installed.license, "MIT");
  assert.deepEqual(installed.publishConfig, { access: "public" });
  assert.equal(installed.engines.node, ">=20");
  assert(!Object.keys(installed.dependencies ?? {}).some((dependency) => dependency.startsWith("@critiqs/")), `${name} depends on a private workspace package`);
  assert.equal(await Bun.file(join(dir, `node_modules/${name}/LICENSE`)).text(), await Bun.file(join(root, "LICENSE")).text());
  await scanForSecrets(join(dir, `node_modules/${name}`));
  return installed;
}

try {
  // The shared package carries the CLI, the backend it deploys, and the self-hosting server.
  const sharedFiles = await packedFiles(sharedDir, [
    "LICENSE", "README.md", "AGENT_SETUP.md", "dist/index.js", "dist/index.d.ts", "dist/element.js", "dist/element.d.ts",
    "bin/critiqs.mjs", "bin/cli.mjs", "bin/cli.d.mts", "bin/init.mjs", "bin/env.mjs", "bin/setup.mjs", "bin/mcp.mjs", "bin/agent.mjs", "bin/markup.mjs",
    "bin/frameworks/index.mjs", "bin/frameworks/react.mjs", "bin/frameworks/next.mjs",
    "dist/backend/convex/http.ts", "dist/backend/convex/lib/vendor/critiqs_server.js", "dist/backend/convex/lib/vendor/aws4fetch.js", "dist/backend/convex/lib/vendor/critiqs_ai.js", "dist/backend/convex/ai.ts",
    "dist/server/index.js", "dist/server/index.d.ts",
  ], /^(dist\/|bin\/|README\.md$|AGENT_SETUP\.md$|LICENSE$|package\.json$)/);
  // critiqs-react is the component, with the command and server from critiqs under its own name.
  const reactFiles = await packedFiles(reactDir, [
    "LICENSE", "README.md", "AGENT_SETUP.md", "dist/index.js", "dist/index.d.ts", "dist/host.d.ts", "dist/core/types.d.ts", "dist/server/index.js", "dist/server/index.d.ts", "bin/critiqs.mjs",
  ], /^(dist\/(index\.js|[\w-]+\.d\.ts|core\/types\.d\.ts|server\/index\.(js|d\.ts))$|bin\/critiqs\.mjs$|README\.md$|AGENT_SETUP\.md$|LICENSE$|package\.json$)/);
  const files = [...sharedFiles, ...reactFiles];
  const [sharedPacked] = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", scratch], sharedDir));
  const [reactPacked] = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", scratch], reactDir));
  // critiqs isn't on the registry yet, so each consumer installs the packed one beside critiqs-react,
  // which satisfies critiqs-react's exact dependency on it.
  const tarballs = [join(scratch, sharedPacked.filename), join(scratch, reactPacked.filename)];
  // React 18 too: an isolated consumer that mounts it and renders it on the server.
  const react18 = join(scratch, "react18");
  await mkdir(react18);
  await Bun.write(join(react18, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs, "react@18", "react-dom@18", "@happy-dom/global-registrator@20"], react18);
  await reactConsumerChecks(react18, "18.");
  await Bun.write(join(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs, "react@19", "react-dom@19", "@types/react@19", "@types/node@22", "@happy-dom/global-registrator@20"]);
  const installed = await checkManifest(scratch, "critiqs-react");
  const shared = await checkManifest(scratch, "critiqs");
  // One version of the shared package, the exact one critiqs-react was released with.
  assert.equal(installed.dependencies.critiqs, shared.version);
  assert(!(await Bun.file(join(scratch, "node_modules/critiqs-react/node_modules/critiqs/package.json")).exists()), "critiqs-react installed a second copy of critiqs");
  // Agents read the guide in the package they installed, including where critiqs isn't placed beside it (pnpm).
  const guide = await Bun.file(join(scratch, "node_modules/critiqs/AGENT_SETUP.md")).text();
  assert(guide.includes("## 1. Run setup"), "critiqs's AGENT_SETUP.md is the setup guide");
  assert((await Bun.file(join(scratch, "node_modules/critiqs-react/AGENT_SETUP.md")).text()).endsWith(guide), "critiqs-react's AGENT_SETUP.md must carry critiqs's guide, not point to it");
  assert.deepEqual(shared.bin, { critiqs: "./bin/critiqs.mjs" });
  assert.deepEqual(installed.bin, { critiqs: "./bin/critiqs.mjs" });
  // Node 20 supports setup. The optional built-in SQLite server has its own
  // documented minimum and must explain that boundary on Node 20.
  // Both packages' commands run the shared CLI: critiqs-react's delegates to critiqs's.
  for (const cli of ["node_modules/critiqs/bin/critiqs.mjs", "node_modules/critiqs-react/bin/critiqs.mjs"]) {
    const help = await run(["npm", "exec", "--yes", "--package=node@20.0.0", "--", "node", cli, "--help"]);
    assert(help.includes("critiqs init <projectId>"), `${cli} --help: ${help}`);
  }
  // As people and agents type them: npx critiqs, npx critiqs-react, and the linked critiqs command.
  for (const command of [["npx", "--no-install", "critiqs", "--help"], ["npx", "--no-install", "critiqs-react", "--help"], ["node_modules/.bin/critiqs", "--help"]]) {
    assert((await run(command)).includes("critiqs init <projectId>"), `${command.join(" ")} doesn't run the CLI`);
  }
  await run(["npm", "exec", "--yes", "--package=node@20.0.0", "--", "node", "--input-type=module", "-e", `
    const { createCritiqsHandler } = await import("critiqs-react/server");
    try {
      const handler = await createCritiqsHandler({ database: ":memory:", identify: () => null });
      handler.close();
      process.exit(2);
    } catch (error) {
      if (!error.message.includes("SQLite server requires Node.js 22.13")) throw error;
    }
  `]);
  await run(["npm", "exec", "--yes", "--package=node@22.13.0", "--", "node", "--no-warnings", "--input-type=module", "-e", `
    const { createCritiqsHandler } = await import("critiqs-react/server");
    const handler = await createCritiqsHandler({ database: ":memory:", identify: () => null });
    handler.close();
  `]);
  // Server-component frameworks render <Critiqs /> as a client component.
  assert((await Bun.file(join(scratch, "node_modules/critiqs-react/dist/index.js")).text()).startsWith('"use client";\n'), "The browser entry must start with \"use client\"");
  assert.equal(installed.peerDependencies.react, ">=18");
  assert.equal(installed.peerDependencies["react-dom"], ">=18");
  await run(["node", "--input-type=module", "-e", 'const m = await import("critiqs-react"); if (typeof m.Critiqs !== "function" || m.MASK_ATTRIBUTE !== "data-critiqs-mask") process.exit(1)']);
  await reactConsumerChecks(scratch);

  await Bun.write(join(scratch, "consumer.tsx"), `import { Critiqs, MASK_ATTRIBUTE, type CritiqsProps, type HostContext, type RestoreRequest, type Scope, type ViewState } from "critiqs-react";
const scope: Scope = "record";
const view: ViewState = { tab: "details" };
const props: CritiqsProps = { getContext: (): HostContext => ({ viewState: view }), restoreContext: (request: RestoreRequest) => request.scope === scope };
export const prototype = <Critiqs {...props} />;
declare const configured: string | undefined;
export const controlled = <Critiqs projectId={configured} requireProjectId />;
export const mask: "data-critiqs-mask" = MASK_ATTRIBUTE;
`);
  for (const resolution of ["Bundler", "NodeNext"]) {
    await run([join(root, "node_modules/.bin/tsc"), "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck", "false", "--jsx", "react-jsx", "--target", "ES2022", "--module", resolution === "Bundler" ? "ESNext" : "NodeNext", "--moduleResolution", resolution, "consumer.tsx"]);
  }
  await mkdir(join(scratch, "src"));
  const source = 'import { Critiqs } from "critiqs-react";\nexport const App = () => <Critiqs />;\n';
  await Bun.write(join(scratch, "src/App.tsx"), source);
  const output = await run(["node", "node_modules/critiqs-react/bin/critiqs.mjs", "init", "j12345678901234567890123456789012", "--dir", "src", "--dry-run"]);
  assert(output.includes("Would set the project ID"));
  assert.equal(await Bun.file(join(scratch, "src/App.tsx")).text(), source);
  await run(["npx", "--no-install", "critiqs", "init", "j12345678901234567890123456789012", "--dir", "src"]);
  assert((await Bun.file(join(scratch, "src/App.tsx")).text()).includes('projectId="j12345678901234567890123456789012"'));
  // With no component yet, init adds it to the app's React root, once.
  await mkdir(join(scratch, "spa/src"), { recursive: true });
  await Bun.write(join(scratch, "spa/src/main.tsx"), 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(["node", "node_modules/critiqs-react/bin/critiqs.mjs", "init", "j12345678901234567890123456789012", "--dir", "spa"]);
  }
  assert.equal(
    await Bun.file(join(scratch, "spa/src/main.tsx")).text(),
    'import { createRoot } from "react-dom/client";\nimport { Critiqs } from "critiqs-react";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<><App /><Critiqs projectId="j12345678901234567890123456789012" /></>);\n',
  );
  // An option named --env-file is consumed by Node itself before the CLI starts.
  // Exercise the unambiguous public option through the packed Node CLI, not just runCli().
  await mkdir(join(scratch, "custom-env/config"), { recursive: true });
  await Bun.write(join(scratch, "custom-env/package.json"), JSON.stringify({ name: "custom-env", devDependencies: { vite: "8" } }));
  await Bun.write(join(scratch, "custom-env/vite.config.mjs"), 'export default { envDir: process.env.APP_ENV_DIR };');
  await Bun.write(join(scratch, "custom-env/main.jsx"), 'import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")).render(<App />);');
  for (const node of [["node"], ["npm", "exec", "--yes", "--package=node@20.0.0", "--", "node"]]) {
    await run([...node, "node_modules/critiqs-react/bin/critiqs.mjs", "init", "j12345678901234567890123456789012", "--dir", "custom-env", "--project-env-file", "config/.env.local"]);
  }
  assert((await Bun.file(join(scratch, "custom-env/config/.env.local")).text()).includes("VITE_CRITIQS_PROJECT_ID=j12345678901234567890123456789012"));
  assert((await Bun.file(join(scratch, "custom-env/main.jsx")).text()).includes("projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId"));
  // critiqs-react/server is critiqs/server under the name host apps already import.
  await run(["node", "--input-type=module", "-e", 'const a = await import("critiqs/server"); const b = await import("critiqs-react/server"); if (a.createCritiqsHandler !== b.createCritiqsHandler || a.toNodeListener !== b.toNodeListener) process.exit(1)']);
  // Self-hosting: the server runs under Node with node:sqlite, and its types check.
  await run(["node", "--no-warnings", "--input-type=module", "-e", `
    const { createCritiqsHandler } = await import("critiqs-react/server");
    const critiqs = await createCritiqsHandler({ database: ":memory:", developmentSignIn: true });
    const config = await (await critiqs.fetch(new Request("http://localhost/critiqs/critiqs/config"))).json();
    const refused = await critiqs.fetch(new Request("http://localhost/critiqs/api/createProject", { method: "POST", body: "{}" }));
    critiqs.close();
    if (config.transport !== "http" || config.protocol !== 5 || refused.status !== 403) process.exit(1);
  `]);
  // AI provider code never reaches the browser bundle.
  const browser = await Bun.file(join(scratch, "node_modules/critiqs-react/dist/index.js")).text();
  for (const marker of ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "ai-gateway.vercel.sh", "@ai-sdk/"]) {
    assert(!browser.includes(marker), `The browser bundle contains AI provider code (${marker})`);
  }
  // Self-hosting with AI under Node: search runs through the AI SDK, loaded on first use, to a local OpenAI-compatible stand-in.
  await run(["node", "--no-warnings", "--input-type=module", "-e", `
    const { createServer } = await import("node:http");
    const asked = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const system = JSON.parse(body).messages.find((message) => message.role === "system").content;
        asked.push({ path: request.url, authorization: request.headers.authorization });
        const answer = system.includes("turn a question")
          ? { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" }
          : { findings: [{ title: "Labels", detail: "Reviewers want clearer labels.", threads: ["T1"] }] };
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const { createCritiqsHandler } = await import("critiqs-react/server");
    const critiqs = await createCritiqsHandler({
      database: ":memory:",
      identify: () => ({ id: "1", name: "Pat", email: "pat@example.com" }),
      ai: { provider: "compatible", model: "m", apiKey: "local-key", baseURL: "http://127.0.0.1:" + provider.address().port + "/v1" },
    });
    const call = async (name, args) => (await (await critiqs.fetch(new Request("http://localhost/critiqs/api/" + name, { method: "POST", headers: { "X-Critiqs-Request": "1" }, body: JSON.stringify(args) }))).json()).value;
    const projectId = await call("createProject", { name: "P" });
    const anchor = { screen: "s", viewState: {}, scope: "shared", target: { purposeId: null, recordKey: null, clues: { tagName: "div", role: null, label: null, path: "" } }, evidence: { url: "http://localhost/", viewport: { width: 1, height: 1 }, marker: null, capturedAt: 1, revision: null, persona: null, userAgent: null } };
    const threadId = await call("createThread", { projectId, anchor, body: "The label is unclear #wording", tags: [], capture: { status: "failed", failureReason: "x" } });
    const found = await call("search", { projectId, question: "labels?", scope: { status: "all", screen: null } });
    critiqs.close();
    provider.close();
    if (found.mode !== "ai" || found.results[0]?.threadId !== threadId || found.insights[0]?.threadIds[0] !== threadId) process.exit(2);
    if (asked.length !== 2 || asked.some((request) => request.path !== "/v1/chat/completions" || request.authorization !== "Bearer local-key")) process.exit(3);
  `]);
  for (const from of ["critiqs/server", "critiqs-react/server"]) {
    await Bun.write(join(scratch, "server.ts"), `import { createCritiqsHandler, toNodeListener, type HostUser } from "${from}";
const user: HostUser = { id: "1", name: "Pat", email: "pat@example.com" };
const handler = await createCritiqsHandler({ database: "critiqs.sqlite", identify: () => user });
export const listener = toNodeListener(handler);
`);
    for (const resolution of ["Bundler", "NodeNext"] as const) {
      await run([join(root, "node_modules/.bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "false", "--types", "node", "--target", "ES2022", "--module", resolution === "Bundler" ? "ESNext" : "NodeNext", "--moduleResolution", resolution, "server.ts"]);
    }
  }
  // The bundled backend functions load without the private workspace packages.
  await run(["node", "--input-type=module", "-e", 'const m = await import(process.cwd() + "/node_modules/critiqs/dist/backend/convex/lib/vendor/critiqs_server.js"); if (typeof m.operations?.createProject !== "function") process.exit(1)']);
  // The deployed backend's Node actions load the AI SDK bundled beside them.
  await run(["node", "--input-type=module", "-e", 'const m = await import(process.cwd() + "/node_modules/critiqs/dist/backend/convex/lib/vendor/critiqs_ai.js"); if (typeof m.createStructuredModel !== "function") process.exit(1)']);
  // The deployed backend includes its signer without a private workspace install.
  await run(["node", "--input-type=module", "-e", 'const m = await import(process.cwd() + "/node_modules/critiqs/dist/backend/convex/lib/vendor/aws4fetch.js"); if (typeof m.AwsClient !== "function") process.exit(1)']);
  // The MCP server answers an agent's first messages.
  // The MCP server answers through the command AGENT_SETUP.md configures for agents.
  const mcp = Bun.spawn(["npx", "--no-install", "critiqs-react", "mcp"], {
    cwd: scratch,
    stdin: new Blob([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    ]),
    stdout: "pipe",
  });
  const replies = (await new Response(mcp.stdout).text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(await mcp.exited, 0);
  assert.equal(replies[0].result.serverInfo.name, "critiqs");
  assert.deepEqual(replies[1].result.tools.map((tool: { name: string }) => tool.name), [
    "critiqs_setup_start",
    "critiqs_setup_finish",
    "critiqs_write_project_id",
    "critiqs_doctor",
    "critiqs_comments",
    "critiqs_thread",
    "critiqs_screenshot",
    "critiqs_reply",
    "critiqs_mockups",
    "critiqs_mockup",
    "critiqs_sign_in",
    "critiqs_sign_in_finish",
    "critiqs_sign_out",
  ]);
  console.log(`Package smoke passed: critiqs and critiqs-react, ${files.length} files; MIT license and public publishing settings, no secrets; isolated npm install, ESM import, production React 18 and 19 mounts and server rendering, "use client" boundary, Bundler/NodeNext declarations, Node CLI through npx critiqs and npx critiqs-react, MCP server, bundled backend with AI actions, self-hosted server with AI search under Node, no provider code in the browser bundle.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
