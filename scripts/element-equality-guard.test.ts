import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const GUARD = join(import.meta.dir, "element-equality-guard.ts");
// Joins once its own branch adds the import; nothing else may be missing.
const NOT_YET = new Set(["packages/extension"]);

test("every workspace whose tests run in a DOM loads the element guard first", async () => {
  const missing: string[] = [];
  for await (const bunfig of new Glob("{packages,apps}/*/bunfig.toml").scan(ROOT)) {
    const workspace = bunfig.slice(0, -"/bunfig.toml".length);
    const preloads = [...(await readFile(join(ROOT, bunfig), "utf8")).matchAll(/"(\.\/[^"]+)"/g)].map((match) => match[1]!);
    const sources = await Promise.all(preloads.map((path) => readFile(join(ROOT, workspace, path), "utf8")));
    const loadsDom = sources.some((source) => source.includes("GlobalRegistrator"));
    const loadsGuard = sources.some((source) => source.includes('import "../../../scripts/element-equality-guard.ts";'));
    if (loadsDom && !loadsGuard && !NOT_YET.has(workspace)) missing.push(workspace);
  }
  expect(missing).toEqual([]);
});

/** Runs `body` as a test file with the guard preloaded; its output and exit code. */
async function runWithGuard(body: string, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "element-guard-"));
  try {
    await writeFile(join(dir, "case.test.ts"), `import { expect, test } from "bun:test";\n${body}\n`);
    const run = Bun.spawnSync(["bun", "test", "--preload", GUARD, "./case.test.ts"], { cwd: dir, env: { ...process.env, ...env } });
    return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NODE = `const node = { nodeType: 1, nodeName: "BUTTON", parentNode: null };`;

test("an equality matcher given an element fails at once with a short message, even if it would pass", async () => {
  for (const assertion of [
    "expect([node]).toEqual([node]);",
    "expect(node).not.toEqual(null);",
    "expect({ found: node }).toStrictEqual({ found: node });",
    "expect({ found: node, other: 1 }).toMatchObject({ other: 1 });",
    "expect([1]).toEqual([node]);",
    'expect([{ kids: new Map([["a", node]]) }]).toContainEqual({ kids: new Map() });',
    'expect({ $$typeof: Symbol.for("react.transitional.element") }).toEqual({});',
  ]) {
    const { code, output } = await runWithGuard(`${NODE}\ntest("case", () => { ${assertion} });`);
    expect([assertion, code]).toEqual([assertion, 1]);
    expect(output).toMatch(/(toEqual|toStrictEqual|toMatchObject|toContainEqual) was given (a DOM node \(BUTTON\)|a React element)/);
    expect(output.length).toBeLessThan(4000);
  }
});

test("other equality assertions behave as before", async () => {
  const passing = await runWithGuard(`test("case", async () => {
    expect([1, { a: "x" }]).toEqual([1, { a: "x" }]);
    expect({ a: 1 }).not.toEqual({ a: 2 });
    expect({ a: 1, b: 2 }).toMatchObject({ a: expect.any(Number) });
    expect([{ a: 1 }]).toContainEqual({ a: 1 });
    expect({ a: undefined }).not.toStrictEqual({});
    await expect(Promise.resolve([1])).resolves.toEqual([1]);
  });`);
  expect([passing.code, passing.output]).toEqual([0, expect.stringContaining("1 pass")]);

  const failing = await runWithGuard(`test("case", () => { expect({ a: 1 }).toEqual({ a: 2 }); });`);
  expect(failing.code).toBe(1);
  expect(failing.output).toContain('"a": 2');
});

test("in report mode it lists the assertion and lets it run", async () => {
  const { code, output } = await runWithGuard(`${NODE}\ntest("case", () => { expect([node]).toEqual([node]); });`, { CRITIQS_ELEMENT_GUARD: "report" });
  expect(code).toBe(0);
  expect(output).toMatch(/\[element-equality\] .*case\.test\.ts:\d+:\d+.* toEqual a DOM node \(BUTTON\)/);
});
