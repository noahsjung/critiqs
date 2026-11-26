import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsage } from "../../critiqs/bin/app.mjs";
import { beginSetup, listMyProjects } from "../../critiqs/bin/setup.mjs";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { reviewer, setup } from "./harness";

const TEAM = "https://team.convex.cloud";
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function app() {
  const root = mkdtempSync(join(tmpdir(), "critiqs-setup-contract-"));
  folders.push(root);
  writeFileSync(join(root, "main.jsx"), 'import { createRoot } from "react-dom/client";\nfunction App() { return <main>Host</main>; }\ncreateRoot(document.body).render(<App />);\n');
  return root;
}

/** Auth approval is synthetic; every project query/mutation uses the actual Convex function and validators. */
function bridge() {
  const client = setup({ limits: true }).withIdentity(reviewer("Dana"));
  const calls: { path: string; args: any }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/critiqs/config")) return Response.json({ protocol: 5, signInUrl: "https://team.convex.site", deviceSignIn: true });
    if (url.endsWith("/auth/device/start")) return Response.json({ deviceCode: "synthetic-device", userCode: "BCDF-GHJK", verificationUrl: "https://team.convex.site/auth/device", expiresIn: 600, interval: 5 });
    if (url.endsWith("/auth/device/token")) return Response.json({ accessToken: "synthetic-access", expiresAt: Date.now() + 900_000 });
    const { path, args } = JSON.parse(String(init?.body));
    calls.push({ path, args });
    try {
      let value;
      if (path === "projects:listMine") value = await client.query(api.projects.listMine, args);
      else if (path === "projects:create") value = await client.mutation(api.projects.create, args);
      else if (path === "users:sync") value = await client.mutation(api.users.sync, args);
      else throw new Error(`Unexpected setup operation ${path}`);
      return Response.json({ status: "success", value });
    } catch (error) {
      return Response.json({ status: "error", errorMessage: String(error) });
    }
  }) as typeof fetch;
  return { client, calls, fetchFn };
}

test("setup discovers and reconnects a synchronized reviewer's project through the real backend", async () => {
  const { client, calls, fetchFn } = bridge();
  await client.mutation(api.users.sync, {});
  const existing = await client.mutation(api.projects.create, { name: "Billing" });
  const root = app();
  const pending = await beginSetup({ root, target: TEAM, name: "Billing", signIn: "remote", fetchFn, sleep: async () => {} });
  if (pending.connected) throw new Error("Fresh host should perform setup");
  const result = await pending.finish();
  expect(result).toMatchObject({ projectId: existing, reused: true, backendUrl: TEAM, written: { ok: true } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ path: "projects:listMine", args: { paginationOpts: { numItems: 40, cursor: null } } });
  expect(readFileSync(join(root, "main.jsx"), "utf8")).toContain(`projectId="${existing}" backend="${TEAM}"`);
});

test("new setup for an established reviewer creates exactly one project using real queries and mutations", async () => {
  const { client, calls, fetchFn } = bridge();
  await client.mutation(api.users.sync, {});
  await client.mutation(api.projects.create, { name: "Existing" });
  const pending = await beginSetup({ root: app(), target: TEAM, name: "Another app", signIn: "remote", fetchFn, sleep: async () => {} });
  if (pending.connected) throw new Error("Fresh host should perform setup");
  const result = await pending.finish();
  expect(result).toMatchObject({ reused: false, written: { ok: true } });
  expect(calls.map((call) => call.path)).toEqual(["projects:listMine", "users:sync", "projects:create"]);
  const saved = await client.query(api.projects.get, { projectId: result.projectId as Id<"projects"> });
  expect(saved.name).toBe("Another app");
});

test("CLI discovery completes more than five real backend pages", async () => {
  const { client, calls, fetchFn } = bridge();
  for (let i = 0; i < 201; i++) await client.mutation(api.projects.create, { name: `App ${i}` });
  const projects = await listMyProjects({ backendUrl: TEAM, accessToken: "synthetic-access", fetchFn });
  expect(projects).toHaveLength(201);
  expect(new Set(projects.map((project) => project._id)).size).toBe(201);
  expect(calls).toHaveLength(6);
  expect(calls.every((call) => call.args.paginationOpts.numItems === 40)).toBe(true);
});

test("ambiguous-name recovery instructions preserve the chosen backend when followed", async () => {
  const { client, calls, fetchFn } = bridge();
  const first = await client.mutation(api.projects.create, { name: "Billing" });
  const second = await client.mutation(api.projects.create, { name: "Billing" });
  const root = app();
  const source = readFileSync(join(root, "main.jsx"), "utf8");
  const pending = await beginSetup({ root, target: TEAM, name: "Billing", entry: "main.jsx", mount: "App", signIn: "remote", fetchFn, sleep: async () => {} });
  if (pending.connected) throw new Error("Fresh host should perform setup");
  let message = "";
  try { await pending.finish(); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("2 projects named");
  expect(message).toContain("main.jsx beside <App>");
  expect(message).not.toContain("init <projectId>");
  const snippets = message.match(/<Critiqs projectId="[^"]+" backend="[^"]+" \/>/g) ?? [];
  expect(snippets).toHaveLength(2);
  expect(snippets.every((snippet) => snippet.includes(`backend="${TEAM}"`))).toBe(true);
  expect(new Set(snippets.map((snippet) => /projectId="([^"]+)"/.exec(snippet)![1]))).toEqual(new Set([first, second]));
  expect(readFileSync(join(root, "main.jsx"), "utf8")).toBe(source);
  expect(calls.map((call) => call.path)).toEqual(["projects:listMine"]);
  // Follow one actual returned snippet, including the advised import and placement.
  writeFileSync(join(root, "main.jsx"), 'import { Critiqs } from "critiqs-react";\n' + source.replace("<App />", `<><App />${snippets[0]}</>`));
  expect(readUsage(root)).toMatchObject({ usage: { backend: { kind: "literal", value: TEAM }, projectId: { kind: "literal", value: expect.stringMatching(new RegExp(`^(${first}|${second})$`)) } } });
});
