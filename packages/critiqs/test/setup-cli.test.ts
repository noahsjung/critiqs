import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand } from "../bin/cli.mjs";
import { chooseWiring, readUsage, writeConnection } from "../bin/app.mjs";
import { findCritiqsUsages } from "../bin/frameworks/jsx.mjs";
import { runInit } from "../bin/init.mjs";
import { createTools, handleMessage, serveMcp, TOOLS } from "../bin/mcp.mjs";
import { PassThrough } from "node:stream";
import {
  beginSetup,
  BACKEND_PROTOCOL,
  CLOUD_BACKEND_URL,
  convexEnv,
  doctor,
  doctorReport,
  isHeadless,
  isLocalAddress,
  listMyProjects,
  readiness,
  resolveBackend,
  SIGN_IN_PROTOCOL,
  startBrowserSignIn,
  startRemoteSignIn,
  targetDeployment,
} from "../bin/setup.mjs";
import { HOSTED_BACKEND_URL, BACKEND_PROTOCOL as COMPONENT_PROTOCOL, SIGN_IN_PROTOCOL as COMPONENT_SIGN_IN_PROTOCOL } from "../../react/src/deployment.ts";
import { isPrivateReviewAddress } from "@critiqs/core";
import { OTHER_ADDRESSES, PRIVATE_ADDRESSES } from "../../core/test/review-addresses.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function app(component = "<Critiqs />") {
  const root = mkdtempSync(join(tmpdir(), "critiqs-cli-"));
  folders.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/prototype" }));
  writeFileSync(join(root, "src", "App.tsx"), `import { Critiqs } from "critiqs-react";\nexport const App = () => ${component};\n`);
  return root;
}
const appSource = (root: string) => readFileSync(join(root, "src", "App.tsx"), "utf8");

const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";

/** Starts setup that signs in, as opposed to keeping a project the code already names. */
async function begin(args: Parameters<typeof beginSetup>[0]) {
  const setup = await beginSetup(args);
  if (setup.connected !== undefined) throw new Error("Expected setup to sign in.");
  return setup;
}

/** A fake backend at https://team.convex.cloud. */
function backend(health: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return (async (url: string) => {
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://team.convex.site", protocol: 5, ...config });
    if (url.includes("/critiqs/health")) {
      const asked = new URL(url).searchParams.get("projectId");
      return Response.json({
        protocol: 5,
        signIn: "email",
        email: true,
        plans: false,
        mentionEmails: { overdue: false, waitingSince: null, last: { status: "sent", at: 1 } },
        ...(asked === null ? {} : { project: asked === PROJECT ? "found" : "missing" }),
        ...health,
      });
    }
    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
}

test("the CLI and the component agree on Critiqs Cloud and the backend version", () => {
  expect(CLOUD_BACKEND_URL).toBe(HOSTED_BACKEND_URL);
  expect(BACKEND_PROTOCOL).toBe(COMPONENT_PROTOCOL);
  expect(SIGN_IN_PROTOCOL).toBe(COMPONENT_SIGN_IN_PROTOCOL);
});

test("parses commands", () => {
  expect(parseCommand(["init"])).toMatchObject({ command: "init", projectId: null, target: null });
  expect(parseCommand(["init", "--own-convex", "--name", "Billing"])).toMatchObject({ target: "own-convex", name: "Billing" });
  expect(parseCommand(["init", "--backend=https://team.convex.cloud"])).toMatchObject({ target: "https://team.convex.cloud" });
  expect(parseCommand(["init", PROJECT, "--dry-run"])).toMatchObject({ projectId: PROJECT, dryRun: true });
  expect(parseCommand(["doctor", "--dir", "app"])).toMatchObject({ command: "doctor", dir: "app" });
  expect(parseCommand(["init", "--backend", "team"])).toEqual({ error: "--backend needs a URL such as https://<deployment>.convex.cloud." });
  expect(parseCommand(["init", "--name"])).toEqual({ error: "--name needs a value." });
  expect(parseCommand(["deploy"])).toEqual({ error: "Unknown command deploy." });
  expect(parseCommand(["doctor", "extra"])).toEqual({ error: "Unexpected argument extra." });
});

test("writes the project ID and backend into the component, in that order, or nothing", () => {
  const root = app("<Critiqs version=\"v1\" />");
  const connect = (dir: string, backend?: string, dryRun = false) => writeConnection({ root: dir, wiring: chooseWiring(dir), projectId: PROJECT, backend, dryRun });
  const dry = connect(root, "https://team.convex.cloud", true);
  expect(dry).toMatchObject({ ok: true, changed: ["projectId", "backend"] });
  expect(appSource(root)).toContain('<Critiqs version="v1" />');
  connect(root, "https://team.convex.cloud");
  expect(appSource(root)).toContain(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" version="v1" />`);
  expect(connect(root).changed).toEqual([]);

  const coded = app("<Critiqs projectId={process.env.ID} />");
  const refused = connect(coded, "https://team.convex.cloud");
  expect(refused.ok).toBe(false);
  expect(refused.message).toContain("sets projectId from code, so nothing was changed");
  expect(appSource(coded)).toContain("<Critiqs projectId={process.env.ID} />");
});

test("refuses backends and sign-in services older than this package", async () => {
  await expect(resolveBackend("https://team.convex.cloud", { fetchFn: backend({}, { protocol: undefined }) })).rejects.toThrow(
    "runs an older version",
  );
  const external = (async (url: string) =>
    url.startsWith("https://team")
      ? Response.json({ signInUrl: "https://old.convex.site", protocol: 5 })
      : Response.json({ signInUrl: "https://old.convex.site" })) as unknown as typeof fetch;
  await expect(resolveBackend("https://team.convex.cloud", { fetchFn: external })).rejects.toThrow("isn't ready for this version");
});

test("doctor checks the component, backend, project, sign-in, and email", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
  const healthy = await doctor({ root, fetchFn: backend() });
  expect(healthy.map((check) => [check.name, check.status])).toEqual([
    ["Component", "pass"],
    ["Backend", "pass"],
    ["Project", "pass"],
    ["Sign-in", "pass"],
    ["Email", "pass"],
  ]);
  const now = Date.now();
  const stuck = await doctor({ root, now, fetchFn: backend({ mentionEmails: { overdue: true, waitingSince: now - 30 * 60_000, last: null } }) });
  expect(stuck.at(-1)).toEqual({
    stage: "service",
    basis: "observed",
    status: "fail",
    name: "Email",
    detail: "Mention emails have waited 30 minutes, so scheduled sending isn't running. Check the deployment's scheduled functions.",
  });
  const failed = await doctor({ root, fetchFn: backend({ mentionEmails: { overdue: false, waitingSince: null, last: { status: "failed", at: 1 } } }) });
  expect(failed.at(-1)?.detail).toContain("The last mention email failed");

  const missing = app(`<Critiqs projectId="${"a".repeat(32)}" backend="https://team.convex.cloud" />`);
  expect((await doctor({ root: missing, fetchFn: backend() })).find((check) => check.name === "Project")?.status).toBe("fail");
  const none = app();
  const unset = await doctor({ root: none, backendUrl: "https://team.convex.cloud", fetchFn: backend({ email: false }) });
  expect(unset.find((check) => check.name === "Project")?.detail).toContain("has no project ID. Run npx critiqs init");
  expect(unset.at(-1)?.status).toBe("warn");
});

test("own Convex deploys need a production deploy key or a self-hosted backend", () => {
  expect(targetDeployment({ CONVEX_DEPLOY_KEY: "prod:happy-otter-123|secret" }).backendUrl).toBe("https://happy-otter-123.convex.cloud");
  expect(targetDeployment({ CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210/", CONVEX_SELF_HOSTED_ADMIN_KEY: "admin" }).backendUrl).toBe(
    "http://127.0.0.1:3210",
  );
  expect(() => targetDeployment({ CONVEX_DEPLOY_KEY: "preview:team:proj|secret" })).toThrow("must be a production deploy key");
  expect(() => targetDeployment({})).toThrow("Set CONVEX_DEPLOY_KEY");
});

/** A plain HTTP request; the test DOM's fetch applies browser cross-origin rules. */
function http(url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolveRequest, reject) => {
    // A fresh connection each time: sign-in pages reuse one port, and a pooled socket may belong to a closed one.
    const outgoing = request(url, { method: body === undefined ? "GET" : "POST", agent: false }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, text }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("the sign-in page hands tokens only to its own secret address", async () => {
  const signIn = await startBrowserSignIn({ signInUrl: "https://team.convex.site", port: 0 });
  expect((await http(signIn.url)).text).toContain("Sign in to Critiqs");
  const origin = new URL(signIn.url).origin;
  expect((await http(`${origin}/`)).status).toBe(404);
  expect((await http(`${origin}/done/wrong`, "{}")).status).toBe(404);
  const key = new URL(signIn.url).pathname.slice(1);
  expect((await http(`${origin}/done/${key}`, JSON.stringify({ accessToken: 1 }))).status).toBe(400);
  expect((await http(`${origin}/done/${key}`, JSON.stringify({ accessToken: "a", refreshToken: "r" }))).status).toBe(204);
  expect(await signIn.tokens).toEqual({ accessToken: "a", refreshToken: "r" });
});

test("the MCP server lists its tools and answers protocol messages", async () => {
  const tools = createTools({ cwd: app(), env: {}, open: () => {} });
  const init = await handleMessage({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, tools, "0.1.0");
  expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "critiqs" } } });
  expect(await handleMessage({ method: "notifications/initialized" }, tools, "0.1.0")).toBeNull();
  expect(((await handleMessage({ id: 2, method: "tools/list" }, tools, "0.1.0")) as any).result.tools).toBe(TOOLS);
  expect(await handleMessage({ id: 3, method: "resources/list" }, tools, "0.1.0")).toMatchObject({ error: { code: -32601 } });
});

test("MCP tools write a project ID, and never take keys as arguments", async () => {
  const root = app();
  const tools = createTools({ cwd: root, env: {}, open: () => {} });
  const written = await tools.call("critiqs_write_project_id", { projectId: PROJECT });
  expect(written.isError).toBeUndefined();
  expect(appSource(root)).toContain(`<Critiqs projectId="${PROJECT}" />`);
  const own = await tools.call("critiqs_setup_start", { target: "own-convex" });
  expect(own.isError).toBe(true);
  expect(own.content[0]!.text).toContain("in this MCP server's environment");
  expect((await tools.call("critiqs_setup_finish", {})).content[0]!.text).toContain("No setup is waiting");
});

// Regressions from review

test("deploys refuse ambiguous Convex credentials and pass the CLI only the chosen ones", () => {
  expect(() => targetDeployment({ CONVEX_DEPLOY_KEY: "prod:a|b", CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210", CONVEX_SELF_HOSTED_ADMIN_KEY: "k" })).toThrow(
    "not both",
  );
  const target = targetDeployment({ CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210", CONVEX_SELF_HOSTED_ADMIN_KEY: "k" });
  const env = convexEnv(target, { PATH: "/bin", CONVEX_DEPLOYMENT: "dev:other", CONVEX_URL: "https://other.convex.cloud" });
  expect(env).toEqual({ PATH: "/bin", CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210", CONVEX_SELF_HOSTED_ADMIN_KEY: "k" });
});

/** A fake Critiqs Cloud that records the calls setup makes. */
function cloud() {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, headers: new Headers(init?.headers), body });
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5 });
    if (url.endsWith("/api/query")) return Response.json({ status: "success", value: { page: [], isDone: true, continueCursor: "" } });
    if (url.endsWith("/api/mutation")) return Response.json({ status: "success", value: body.path === "projects:create" ? PROJECT : "Dana" });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

async function signInThrough(url: string) {
  const origin = new URL(url).origin;
  const key = new URL(url).pathname.slice(1);
  await http(`${origin}/done/${key}`, JSON.stringify({ accessToken: "access", refreshToken: "refresh" }));
}

test("Cloud setup replaces a backend the code names, records the review address, and ends its session", async () => {
  const root = app('<Critiqs backend="https://old.convex.cloud" />');
  const { calls, fetchFn } = cloud();
  const setup = await begin({ root, target: "cloud", name: "Billing", reviewUrl: "https://proto.example/", fetchFn });
  await signInThrough(setup.url);
  const result = await setup.finish();
  expect(appSource(root)).toContain(`<Critiqs projectId="${PROJECT}" backend="${CLOUD_BACKEND_URL}" />`);
  expect(calls.find((call) => call.body?.path === "projects:create")?.body.args).toEqual({ name: "Billing", reviewUrl: "https://proto.example/" });
  const signOut = calls.find((call) => call.url.endsWith("/auth/sign-out"))!;
  expect(signOut.headers.get("Origin")).toBe(new URL(setup.url).origin);
  expect(signOut.body).toEqual({ refreshToken: "refresh" });
  expect(result.reviewAddress).toBe("https://proto.example/");
});

test("setup refuses before anyone signs in when it couldn't write the result", async () => {
  const { calls, fetchFn } = cloud();
  await expect(beginSetup({ root: app("<Critiqs backend={process.env.BACKEND} />"), target: "cloud", fetchFn })).rejects.toThrow(
    "sets backend from code",
  );
  await expect(beginSetup({ root: app(), target: "cloud", reviewUrl: "ftp://proto", fetchFn })).rejects.toThrow("review address");
  expect(calls).toEqual([]);
});

test("a second MCP setup start replaces the first, even when both start at once", async () => {
  const root = app();
  const { fetchFn } = cloud();
  const opened: string[] = [];
  const tools = createTools({ cwd: root, env: {}, open: (url) => opened.push(url), fetchFn });
  await Promise.all([tools.call("critiqs_setup_start", { target: "cloud" }), tools.call("critiqs_setup_start", { target: "cloud" })]);
  expect(opened).toHaveLength(2);
  // The first sign-in page stopped (its port may now serve the second, which doesn't know its address); the second serves.
  expect(await http(opened[0]!).then((response) => response.status, () => "closed")).not.toBe(200);
  expect((await http(opened[1]!)).status).toBe(200);
  await signInThrough(opened[1]!);
  const done = await tools.call("critiqs_setup_finish", { waitSeconds: 5 });
  expect(done.content[0]!.text).toContain(`Created the Critiqs project "prototype" (${PROJECT})`);
  expect(done.content[0]!.text).toContain("has no review address");
  tools.close();
});

test("the MCP server answers malformed requests and keeps serving", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  output.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n").map((line) => JSON.parse(line))));
  const served = serveMcp({ cwd: app(), input, output });
  input.write("null\n[1]\nnot json\n");
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
  await served;
  expect(lines.map((line) => line.error?.code ?? line.result)).toEqual([-32600, -32600, -32700, {}]);
});

test("doctor checks the sign-in service a backend trusts, and a missing review address", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
  const team = (signInHealth: Record<string, unknown> | null) =>
    (async (url: string) => {
      if (url === "https://team.convex.site/critiqs/config") return Response.json({ signInUrl: "https://cloud.convex.site", protocol: 5 });
      if (url === "https://cloud.convex.site/critiqs/config") return Response.json({ signInUrl: "https://cloud.convex.site", protocol: 4 });
      if (url.startsWith("https://team.convex.site/critiqs/health")) {
        return Response.json({ protocol: 5, signIn: "external", email: false, project: "found", reviewAddress: false, mentionEmails: {} });
      }
      if (url === "https://cloud.convex.site/critiqs/health" && signInHealth !== null) return Response.json(signInHealth);
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;
  const broken = await doctor({ root, fetchFn: team({ protocol: 4, signIn: "unavailable" }) });
  expect(broken.find((check) => check.name === "Sign-in")).toEqual({
    stage: "service",
    basis: "configuration",
    status: "fail",
    name: "Sign-in",
    detail: "Critiqs's sign-in service at https://cloud.convex.site can't sign anyone in. It needs CRITIQS_AUTH_PRIVATE_KEY, RESEND_API_KEY, and CRITIQS_EMAIL_FROM.",
  });
  expect(broken.find((check) => check.name === "Review address")).toMatchObject({ status: "warn", stage: "reviewers", detail: expect.stringContaining("has no review address") });
  const gone = await doctor({ root, fetchFn: team(null) });
  expect(gone.find((check) => check.name === "Sign-in")?.detail).toBe("Can't reach Critiqs's sign-in service at https://cloud.convex.site.");
  const fine = await doctor({ root, fetchFn: team({ protocol: 4, signIn: "email" }) });
  expect(fine.find((check) => check.name === "Sign-in")?.status).toBe("pass");
});

test("with spread props, Cloud setup names Cloud after them, and doctor doesn't guess", async () => {
  const root = app("<Critiqs {...settings} />");
  const { fetchFn } = cloud();
  const setup = await begin({ root, target: "cloud", fetchFn });
  await signInThrough(setup.url);
  await setup.finish();
  expect(appSource(root)).toContain(`<Critiqs {...settings} projectId="${PROJECT}" backend="${CLOUD_BACKEND_URL}" />`);
  const checks = await doctor({ root: app("<Critiqs {...settings} />"), fetchFn: backend() });
  expect(checks.find((check) => check.name === "Backend")?.detail).toContain("sets backend from code");
  expect(checks.find((check) => check.name === "Project")?.detail).toContain("sets its project ID from code");
});

test("the Convex deploy token alias never reaches the Convex CLI", () => {
  expect(() => targetDeployment({ CONVEX_DEPLOYMENT_TOKEN: "prod:a|b" })).toThrow("Set CONVEX_DEPLOY_KEY rather than");
  const target = targetDeployment({ CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210", CONVEX_SELF_HOSTED_ADMIN_KEY: "k" });
  expect(convexEnv(target, { CONVEX_DEPLOYMENT_TOKEN: "prod:other|x" }).CONVEX_DEPLOYMENT_TOKEN).toBeUndefined();
});

test("doctor explains how to check Critiqs inside the app's own server", async () => {
  const checks = await doctor({ root: app('<Critiqs backend="/critiqs" />'), fetchFn: backend() });
  expect(checks.at(-1)?.detail).toContain("run doctor with --backend http://localhost:<port>/critiqs");
});

test("doctor flags incomplete R2 configuration without exposing credential values", async () => {
  const root = app(`<Critiqs backend="https://team.convex.cloud" projectId="${PROJECT}" />`);
  const checks = await doctor({ root, fetchFn: backend({ captures: { provider: "r2", configured: false } }) });
  expect(checks.find(check => check.name === "Screenshots")).toMatchObject({ status: "fail" });
});

test("doctor reports which AI the backend offers, never a key", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
  const withAi = (ai: Record<string, unknown> | undefined) =>
    (async (url: string) => {
      if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://team.convex.site", protocol: 5 });
      return Response.json({ protocol: 5, signIn: "email", email: true, project: "found", reviewAddress: true, mentionEmails: {}, ai });
    }) as unknown as typeof fetch;
  const off = await doctor({ root, fetchFn: withAi({ managed: false, defaultProvider: null, keysStorable: false }) });
  // AI is optional: off is information, never a warning or failure.
  expect(off.find((check) => check.name === "AI")).toMatchObject({ status: "info", stage: "optional", detail: expect.stringContaining("CRITIQS_AI_ENCRYPTION_KEY") });
  const managed = await doctor({ root, fetchFn: withAi({ managed: true, defaultProvider: null, keysStorable: true }) });
  expect(managed.find((check) => check.name === "AI")).toMatchObject({ status: "pass", detail: expect.stringContaining("Critiqs-managed AI") });
  // An older backend reports no AI; doctor says nothing about it.
  expect((await doctor({ root, fetchFn: withAi(undefined) })).some((check) => check.name === "AI")).toBe(false);
});

// Setup that adds the component, keeps or reuses projects, and signs in from another device

/** A Vite-style app with no Critiqs yet. */
function viteApp() {
  const root = mkdtempSync(join(tmpdir(), "critiqs-cli-"));
  folders.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "billing" }));
  writeFileSync(join(root, "src", "main.tsx"), `import { createRoot } from "react-dom/client";\nimport App from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`);
  return root;
}
const mainSource = (root: string) => readFileSync(join(root, "src", "main.tsx"), "utf8");

test.each(["fresh", "mounted", "different backend"])("following HTTP recovery keeps one component in a %s app", async (kind) => {
  const backendUrl = "http://localhost:9090/critiqs";
  const root = kind === "fresh" ? viteApp() : app(`<Critiqs version="v1" backend="${kind === "mounted" ? backendUrl : "http://localhost:8080/critiqs"}" />`);
  const file = join(root, "src", kind === "fresh" ? "main.tsx" : "App.tsx");
  const before = readFileSync(file, "utf8");
  const requests: string[] = [];
  let advice = "";
  try {
    await beginSetup({
      root,
      ...(kind === "mounted" ? {} : { target: backendUrl }),
      fetchFn: (async (url: string) => {
        requests.push(url);
        return Response.json({ protocol: 5, transport: "http", signIn: "host" });
      }) as unknown as typeof fetch,
    });
  } catch (error) {
    advice = (error as Error).message;
  }
  expect(requests).toEqual([`${backendUrl}/critiqs/config`]);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(advice).toContain(`the backend setting "${backendUrl}": on the existing one, or if the app has none, add Critiqs once with only that setting (React: critiqs-react)`);
  expect(advice).toContain("then run npx critiqs init <projectId> to write its ID, keeping the backend");

  // Follow the emitted instructions: update an existing component, or add
  // one with only the backend when absent, then set the sidebar's ID.
  const backendSetting = advice.match(/the backend setting ("[^"]+")/)![1]!;
  let followed = before;
  if (kind === "fresh") {
    followed = `import { Critiqs } from "critiqs-react";\n${before.replace("render(<App />)", `render(<><App /><Critiqs backend=${backendSetting} /></>)`)}`;
  } else {
    followed = before.replace(/backend="[^"]+"/, `backend=${backendSetting}`);
  }
  followed = followed.replace(/<Critiqs\b/, `<Critiqs projectId="${PROJECT}"`);
  writeFileSync(file, followed);
  new Bun.Transpiler({ loader: "tsx" }).transformSync(followed);
  expect(findCritiqsUsages(root)).toHaveLength(1);
  expect(readUsage(root)).toMatchObject({ usage: { projectId: { value: PROJECT }, backend: { value: backendUrl } } });
  if (kind !== "fresh") expect(followed).toContain('version="v1"');
  expect(runInit(["init", PROJECT], { cwd: root, print: () => {} })).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(followed);
  const noFetch = (async () => { throw new Error("Connected retry must not use the network"); }) as unknown as typeof fetch;
  expect(await beginSetup({ root, fetchFn: noFetch })).toMatchObject({
    connected: { projectId: PROJECT, backendUrl },
  });
});

/**
 * A fake Critiqs Cloud whose sign-in service approves setup from another
 * device: polls answer pending, then slow down, then `outcome`.
 */
function remoteCloud(outcome: "approve" | "deny" | "expire" = "approve", { device = true, mine = [] as { _id: string; name: string; reviewUrl: string | null }[] } = {}) {
  const calls: { url: string; body: any }[] = [];
  let polls = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5, ...(device ? { deviceSignIn: true } : {}) });
    if (url.endsWith("/auth/device/start")) {
      return Response.json({ deviceCode: "device-secret-never-shown", userCode: "BCDF-GHJK", verificationUrl: "https://brazen-snail-591.convex.site/auth/device", expiresIn: 600, interval: 5 });
    }
    if (url.endsWith("/auth/device/token")) {
      polls++;
      if (polls === 1) return Response.json({ error: "authorization_pending", interval: 5 }, { status: 400 });
      if (polls === 2) return Response.json({ error: "slow_down", interval: 10 }, { status: 400 });
      if (outcome === "deny") return Response.json({ error: "access_denied" }, { status: 400 });
      if (outcome === "expire") return Response.json({ error: "expired_token" }, { status: 400 });
      return Response.json({ accessToken: "access", expiresAt: 1, reviewer: { name: "Dana", email: "dana@example.com" } });
    }
    if (url.endsWith("/api/query")) return Response.json({ status: "success", value: { page: mine, isDone: true, continueCursor: "" } });
    if (url.endsWith("/api/mutation")) return Response.json({ status: "success", value: body.path === "projects:create" ? PROJECT : null });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn, polls: () => polls };
}

const noWait = async () => {};

test("remote setup adds Critiqs to the app's root after approval from another device, and never shows the device secret", async () => {
  const root = viteApp();
  const { calls, fetchFn } = remoteCloud();
  const logged: string[] = [];
  const setup = await begin({ root, target: "cloud", signIn: "remote", fetchFn, sleep: noWait, log: (line) => logged.push(line) });
  expect(setup).toMatchObject({ method: "remote", url: "https://brazen-snail-591.convex.site/auth/device", userCode: "BCDF-GHJK" });
  expect(JSON.stringify(setup)).not.toContain("device-secret-never-shown");
  const result = await setup.finish();
  expect(result.approvedBy).toEqual({ name: "Dana", email: "dana@example.com" });
  expect(mainSource(root)).toBe(
    `import { createRoot } from "react-dom/client";\nimport { Critiqs } from "critiqs-react";\nimport App from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<><App /><Critiqs projectId="${PROJECT}" /></>);\n`,
  );
  expect(result.written).toMatchObject({ ok: true, installed: true });
  // The secret goes only in the body of the poll, and there's no session to end.
  expect(calls.filter((call) => JSON.stringify(call).includes("device-secret-never-shown")).every((call) => call.url.endsWith("/auth/device/token"))).toBe(true);
  expect(calls.some((call) => call.url.endsWith("/auth/sign-out"))).toBe(false);
  expect(logged.join("\n")).not.toContain("device-secret-never-shown");
  expect(readiness(result).map((stage) => [stage.name, stage.status])).toEqual([
    ["Code", "pass"],
    ["Project", "pass"],
    ["Finish setup", "next"],
    ["Try it locally", "next"],
    ["Reviewers elsewhere", "warn"],
  ]);
});

test("remote setup reports denial, expiry, and a sign-in service that can't approve remotely", async () => {
  for (const [outcome, message] of [["deny", "denied in the browser"], ["expire", "expired before it was approved"]] as const) {
    const setup = await begin({ root: viteApp(), target: "cloud", signIn: "remote", fetchFn: remoteCloud(outcome).fetchFn, sleep: noWait });
    await expect(setup.finish()).rejects.toThrow(message);
  }
  await expect(beginSetup({ root: viteApp(), target: "cloud", signIn: "remote", fetchFn: remoteCloud("approve", { device: false }).fetchFn })).rejects.toThrow(
    "doesn't support approving setup from another device yet",
  );
});

test("remote approval slows down when asked, and gives up when its code expires", async () => {
  const { fetchFn } = remoteCloud();
  const slept: number[] = [];
  const signIn = await startRemoteSignIn({ signInUrl: "https://brazen-snail-591.convex.site", fetchFn, sleep: async (ms: number) => void slept.push(ms) });
  await signIn.tokens;
  expect(slept).toEqual([5000, 5000, 10000]);
  let clock = 0;
  const late = await startRemoteSignIn({
    signInUrl: "https://brazen-snail-591.convex.site",
    fetchFn: remoteCloud().fetchFn,
    now: () => clock,
    sleep: async () => void (clock += 11 * 60_000),
  });
  await expect(late.tokens).rejects.toThrow("expired");
});

test("automatic sign-in uses remote approval only without a local browser", () => {
  expect(isHeadless({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }, "darwin")).toBe(true);
  expect(isHeadless({}, "linux")).toBe(true);
  expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
  expect(isHeadless({}, "darwin")).toBe(false);
});

test("a retry reuses the person's project with that name instead of creating another", async () => {
  const root = viteApp();
  const { calls, fetchFn } = remoteCloud("approve", { mine: [{ _id: PROJECT, name: "billing", reviewUrl: "https://billing.example/" }] });
  const result = await (await begin({ root, target: "cloud", signIn: "remote", fetchFn, sleep: noWait })).finish();
  expect(result).toMatchObject({ projectId: PROJECT, reused: true, reviewAddress: "https://billing.example/" });
  expect(calls.some((call) => call.body?.path === "projects:create")).toBe(false);
  expect(mainSource(root)).toContain(`<Critiqs projectId="${PROJECT}" />`);

  // Two projects with the name are ambiguous: nothing is created or written.
  const twice = remoteCloud("approve", { mine: [{ _id: PROJECT, name: "billing", reviewUrl: null }, { _id: "a".repeat(32), name: "billing", reviewUrl: null }] });
  const other = viteApp();
  await expect((await begin({ root: other, target: "cloud", signIn: "remote", fetchFn: twice.fetchFn, sleep: noWait })).finish()).rejects.toThrow(
    "You already have 2 projects named",
  );
  expect(mainSource(other)).not.toContain("Critiqs");
  // --new-project always creates.
  const fresh = remoteCloud("approve", { mine: [{ _id: "b".repeat(32), name: "billing", reviewUrl: null }] });
  expect((await (await begin({ root: viteApp(), target: "cloud", signIn: "remote", newProject: true, fetchFn: fresh.fetchFn, sleep: noWait })).finish()).reused).toBe(false);
});

test("setup keeps a project the code already names, without signing in", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" />`);
  const { calls, fetchFn } = remoteCloud();
  expect(await beginSetup({ root, target: null as unknown as string, fetchFn })).toEqual({
    connected: { projectId: PROJECT, backendUrl: CLOUD_BACKEND_URL },
    backendUrl: CLOUD_BACKEND_URL,
  });
  expect(calls).toEqual([]);
  await expect(beginSetup({ root, target: "https://team.convex.cloud", fetchFn })).rejects.toThrow("Pass --new-project to replace it");
  expect(appSource(root)).toContain(`<Critiqs projectId="${PROJECT}" />`);
});

test("relative backends and settings after spreads stay connected without Cloud requests", async () => {
  for (const component of [
    `<Critiqs projectId="${PROJECT}" backend="/critiqs" />`,
    `<Critiqs {...hostProps} projectId="${PROJECT}" backend="https://team.convex.cloud" />`,
  ]) {
    const root = app(component);
    const original = appSource(root);
    const { calls, fetchFn } = remoteCloud();
    const result = await beginSetup({ root, fetchFn });
    expect(result.connected?.projectId).toBe(PROJECT);
    expect(result.backendUrl).toBe(component.includes('backend="/critiqs"') ? "/critiqs" : "https://team.convex.cloud");
    expect(calls).toEqual([]);
    expect(appSource(root)).toBe(original);
  }
  const root = app(`<Critiqs projectId="${PROJECT}" backend="/critiqs" />`);
  const { calls, fetchFn } = remoteCloud();
  await expect(beginSetup({ root, reviewUrl: "https://prototype.example/", fetchFn })).rejects.toThrow("Critiqs sidebar");
  await expect(beginSetup({ root, newProject: true, fetchFn })).rejects.toThrow("No Cloud project was created");
  expect(calls).toEqual([]);
});

test("a new project preserves the existing backend unless hosting was explicitly changed", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
  const { calls, fetchFn } = remoteCloud();
  const result = await (await begin({ root, newProject: true, signIn: "remote", fetchFn, sleep: noWait })).finish();
  expect(result.backendUrl).toBe("https://team.convex.cloud");
  expect(calls[0]?.url).toBe("https://team.convex.site/critiqs/config");
  expect(appSource(root)).toContain('backend="https://team.convex.cloud"');
});

test("failed project discovery never creates a duplicate or edits the host app", async () => {
  const root = viteApp();
  const original = mainSource(root);
  const backend = remoteCloud();
  const fetchFn = (async (url: string, options?: RequestInit) =>
    url.endsWith("/api/query") ? Response.json({ status: "error", errorMessage: "Unavailable" }) : backend.fetchFn(url, options)) as typeof fetch;
  await expect((await begin({ root, signIn: "remote", fetchFn, sleep: noWait })).finish()).rejects.toThrow("Couldn't check your existing projects");
  expect(backend.calls.some((call) => call.body?.path === "projects:create")).toBe(false);
  expect(mainSource(root)).toBe(original);
});

test("discovery follows a sixth page and refuses unfinished or repeating scans", async () => {
  const root = viteApp();
  const backend = remoteCloud();
  let count = 0;
  const fetchFn = (async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/query")) {
      count++;
      return Response.json({ status: "success", value: { page: count === 6 ? [{ _id: PROJECT, name: "billing", reviewUrl: null }] : [], isDone: count === 6, continueCursor: `page-${count}` } });
    }
    return backend.fetchFn(url, options);
  }) as typeof fetch;
  const result = await (await begin({ root, signIn: "remote", fetchFn, sleep: noWait })).finish();
  expect(count).toBe(6);
  expect(result.reused).toBe(true);
  expect(backend.calls.some((call) => call.body?.path === "projects:create")).toBe(false);

  const unfinished = viteApp();
  const original = mainSource(unfinished);
  let pages = 0;
  const incomplete = (async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/query")) return Response.json({ status: "success", value: { page: [], isDone: false, continueCursor: `page-${++pages}` } });
    return backend.fetchFn(url, options);
  }) as typeof fetch;
  await expect((await begin({ root: unfinished, signIn: "remote", fetchFn: incomplete, sleep: noWait })).finish()).rejects.toThrow("Couldn't check your existing projects");
  expect(pages).toBe(100);
  expect(mainSource(unfinished)).toBe(original);
  expect(backend.calls.some((call) => call.body?.path === "projects:create")).toBe(false);

  const repeated = (async () => Response.json({ status: "success", value: { page: [], isDone: false, continueCursor: "same" } })) as unknown as typeof fetch;
  await expect(listMyProjects({ backendUrl: CLOUD_BACKEND_URL, accessToken: "access", fetchFn: repeated })).rejects.toThrow("cursor didn't advance");
});

test("late unreadable source retains the project and a complete backend-aware recovery snippet", async () => {
  for (const mode of [0o444, 0o000]) {
    const root = viteApp();
    const file = join(root, "src/main.tsx");
    const original = mainSource(root);
    const { fetchFn } = remoteCloud();
    const pending = await begin({ root, target: "https://team.convex.cloud", entry: "src/main.tsx", mount: "App", signIn: "remote", fetchFn, sleep: noWait });
    chmodSync(file, mode);
    let result;
    try {
      result = await pending.finish();
      expect(result).toMatchObject({ projectId: PROJECT, backendUrl: "https://team.convex.cloud", written: { ok: false } });
    } finally {
      chmodSync(file, 0o644);
    }
    expect(mainSource(root)).toBe(original);
    expect(result!.written.message).toContain("src/main.tsx beside <App>");
    const snippet = /<Critiqs [^\n]+? \/>/.exec(result!.written.message)?.[0];
    expect(snippet).toBe(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
    // Follow the actual returned manual instructions: preserve both connection values.
    writeFileSync(file, 'import { Critiqs } from "critiqs-react";\n' + original.replace("<App />", `<><App />${snippet}</>`));
    expect(readUsage(root)).toMatchObject({ usage: { projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: "https://team.convex.cloud" } } });
  }
});

test("read-only source is refused before sign-in and late write failures retain the created project ID", async () => {
  const root = viteApp();
  const file = join(root, "src/main.tsx");
  const original = mainSource(root);
  const backend = remoteCloud();
  chmodSync(file, 0o444);
  try {
    await expect(beginSetup({ root, signIn: "remote", fetchFn: backend.fetchFn })).rejects.toThrow("no project was created");
    expect(backend.calls).toEqual([]);
  } finally {
    chmodSync(file, 0o644);
  }
  const setup = await begin({ root, signIn: "remote", fetchFn: backend.fetchFn, sleep: noWait });
  chmodSync(file, 0o444);
  try {
    const result = await setup.finish();
    expect(result.projectId).toBe(PROJECT);
    expect(result.written).toMatchObject({ ok: false, message: expect.stringContaining(`projectId="${PROJECT}"`) });
    expect(mainSource(root)).toBe(original);
  } finally {
    chmodSync(file, 0o644);
  }
});

test("the command line classifies review addresses as the package and its backends do", () => {
  for (const address of [...PRIVATE_ADDRESSES, ...OTHER_ADDRESSES]) {
    expect([address, isLocalAddress(address)]).toEqual([address, isPrivateReviewAddress(address)]);
  }
});

test("setup refuses before anyone signs in when the app has no recognizable root", async () => {
  const root = mkdtempSync(join(tmpdir(), "critiqs-cli-"));
  folders.push(root);
  writeFileSync(join(root, "widget.tsx"), "export const Widget = () => <div />;\n");
  const { calls, fetchFn } = remoteCloud();
  const failure = beginSetup({ root, target: "cloud", signIn: "remote", fetchFn });
  await expect(failure).rejects.toThrow("Init didn't find where the app renders");
  await expect(failure).rejects.toThrow("<Critiqs projectId=\"<the new project ID>\" />");
  expect(calls).toEqual([]);
});

test("readiness catches a missing or local-only review address", () => {
  const base = { written: { ok: true, message: "Set projectId." }, projectId: PROJECT, projectName: "Billing", backendUrl: CLOUD_BACKEND_URL };
  const reviewers = (reviewAddress: string | null) => readiness({ ...base, reviewAddress }).find((stage) => stage.name === "Reviewers elsewhere")!;
  expect(reviewers(null)).toMatchObject({ status: "warn", detail: expect.stringContaining("no review address") });
  expect(reviewers("http://localhost:5173/")).toMatchObject({ status: "warn", detail: expect.stringContaining("only opens on this computer") });
  expect(reviewers("http://192.168.1.20:3000/")).toMatchObject({ status: "warn" });
  expect(reviewers("https://devbox.tail1234.ts.net/")).toMatchObject({ status: "warn", detail: expect.stringContaining("Tailscale") });
  expect(reviewers("https://billing.example/")).toMatchObject({ status: "next", detail: expect.stringContaining("https://billing.example/") });
  const failed = readiness({ ...base, reviewAddress: null, written: { ok: false, message: "Couldn't edit." } });
  expect(failed[0]).toMatchObject({ status: "fail", detail: expect.stringContaining(`The project ${PROJECT} already exists on ${CLOUD_BACKEND_URL}`) });
});

test("doctor flags a local-only review address and says what it didn't exercise", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" backend="https://team.convex.cloud" />`);
  const checks = await doctor({ root, fetchFn: backend({ reviewAddress: true, reviewAddressLocal: true, mentionEmails: { overdue: false, waitingSince: null, last: null } }) });
  expect(checks.find((check) => check.name === "Review address")).toMatchObject({ status: "warn", stage: "reviewers" });
  expect(checks.find((check) => check.name === "Email")).toMatchObject({ status: "pass", basis: "configuration", detail: expect.stringContaining("delivery isn't proven") });
  const report = doctorReport(checks);
  expect(report.ok).toBe(true);
  expect(report.note).toContain("doesn't send a sign-in code or email, upload a screenshot, or post a comment");
});

test("MCP remote setup hands over an address and a code, never the device secret", async () => {
  const root = viteApp();
  const { fetchFn } = remoteCloud();
  const tools = createTools({ cwd: root, env: {}, open: () => {}, fetchFn, sleep: noWait });
  const started = await tools.call("critiqs_setup_start", { signIn: "remote" });
  expect(started.content[0]!.text).toContain("https://brazen-snail-591.convex.site/auth/device");
  expect(started.content[0]!.text).toContain("BCDF-GHJK");
  expect(started.content[0]!.text).not.toContain("device-secret-never-shown");
  const done = await tools.call("critiqs_setup_finish", { waitSeconds: 5 });
  expect(done.content[0]!.text).toContain(`Created the Critiqs project "billing" (${PROJECT})`);
  expect((done as any).structuredContent.stages[0]).toMatchObject({ name: "Code", status: "pass" });
  tools.close();
});

test("on Critiqs Cloud, AI that is off asks nothing of the app's developer", async () => {
  const root = app(`<Critiqs projectId="${PROJECT}" />`);
  const fetchFn = (async (url: string) => {
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5 });
    return Response.json({ protocol: 5, signIn: "email", email: true, project: "found", mentionEmails: {}, ai: { managed: false, defaultProvider: null, keysStorable: false } });
  }) as unknown as typeof fetch;
  const ai = (await doctor({ root, fetchFn })).find((check) => check.name === "AI");
  expect(ai?.status).toBe("info");
  expect(ai?.detail).toContain("nothing to set up in your app");
  expect(ai?.detail.includes("CRITIQS_AI_ENCRYPTION_KEY")).toBe(false);
});
