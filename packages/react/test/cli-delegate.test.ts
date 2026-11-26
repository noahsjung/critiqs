import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../bin/critiqs.mjs");

test("npx critiqs-react runs the shared critiqs command", () => {
  const help = Bun.spawnSync(["node", cli, "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("critiqs init <projectId>");
  const unknown = Bun.spawnSync(["node", cli, "deploy"]);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stdout.toString()).toContain("Unknown command deploy.");
});

test("its MCP server is the shared one, so agents configured with npx critiqs-react mcp keep working", () => {
  // A Buffer, since the DOM this package's tests load replaces Blob.
  const messages = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`;
  const mcp = Bun.spawnSync(["node", cli, "mcp"], { stdin: Buffer.from(messages) });
  const [initialized, listed] = mcp.stdout.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(mcp.exitCode).toBe(0);
  expect(initialized.result.serverInfo.name).toBe("critiqs");
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("critiqs_setup_start");
});
