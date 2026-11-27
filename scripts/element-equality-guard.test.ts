import { expect, test } from "bun:test";
import { DIFFS, REFUSED } from "./element-equality-guard.ts";
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

const REGISTRATOR = Bun.resolveSync("@happy-dom/global-registrator", join(ROOT, "packages/core"));
// A page of 200 buttons, a click event on one (it holds its target and the window), and a mock called with one.
const PAGE = `const host = document.createElement("div");
host.innerHTML = Array.from({ length: 200 }, (_, i) => \`<button id="b\${i}" class="b">Button \${i}</button>\`).join("");
document.body.append(host);
const [btn, other] = [...host.querySelectorAll("button")] as [HTMLButtonElement, HTMLButtonElement];
let event: Event | undefined;
btn.addEventListener("click", (e) => (event = e));
btn.click();
const fn = mock((..._args: unknown[]) => btn);
fn(btn);
fn(event);`;

/** Runs `body` as a test file in a DOM set up the way each workspace's setup file does it: the guard first. */
async function runInDom(body: string) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "element-guard-dom-"));
  try {
    await writeFile(join(dir, "setup.ts"), `import ${JSON.stringify(GUARD)};\nimport { GlobalRegistrator } from ${JSON.stringify(REGISTRATOR)};\nGlobalRegistrator.register();\n`);
    await writeFile(join(dir, "case.test.ts"), `import { expect, mock, test } from "bun:test";\n${PAGE}\n${body}\n`);
    const started = performance.now();
    // Without the guard one of these runs away at about 170 MB a second; stop it rather than wait.
    const run = Bun.spawnSync(["bun", "test", "--preload", "./setup.ts", "./case.test.ts"], {
      cwd: dir,
      env: { ...process.env, CI: "true" },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString(), ms: performance.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// One failing assertion for each of bun's matchers, given an element as the value, the expected value, a mock's
// argument or return value, an event, a thrown value, or a promise's result.
const FAILING: [matcher: string, assertion: string][] = [
  ["toBe", "expect(btn).toBe(other)"],
  ["toBe", "expect(1).toBe(btn)"],
  ["toBe", "expect(btn).not.toBe(btn)"],
  ["toBe", "expect({ el: btn }).toBe(other)"],
  ["toBe", "expect(window).toBe(other)"],
  ["toBe", "expect(event).toBe(other)"],
  ["toBe", "await expect(Promise.resolve(btn)).resolves.toBe(other)"],
  ["toBe", "await expect(Promise.reject(btn)).rejects.toBe(other)"],
  ["toEqual", "expect([btn]).toEqual([other])"],
  ["toStrictEqual", "expect(btn).toStrictEqual(other)"],
  ["toMatchObject", "expect({ a: btn }).toMatchObject({ a: other })"],
  ["toContainEqual", "expect([btn]).toContainEqual(other)"],
  ["toEqualIgnoringWhitespace", 'expect(btn).toEqualIgnoringWhitespace("x")'],
  ["toBeNull", "expect(btn).toBeNull()"],
  ["toBeNull", "expect(event).toBeNull()"],
  ["toBeUndefined", "expect(btn).toBeUndefined()"],
  ["toBeDefined", "expect(btn).not.toBeDefined()"],
  ["toBeFalsy", "expect(btn).toBeFalsy()"],
  ["toBeTruthy", "expect(btn).not.toBeTruthy()"],
  ["toBeNil", "expect(btn).toBeNil()"],
  ["toBeTrue", "expect(btn).toBeTrue()"],
  ["toBeFalse", "expect(btn).toBeFalse()"],
  ["toBeNaN", "expect(btn).toBeNaN()"],
  ["toBeArray", "expect(btn).toBeArray()"],
  ["toBeArrayOfSize", "expect(btn).toBeArrayOfSize(1)"],
  ["toBeBoolean", "expect(btn).toBeBoolean()"],
  ["toBeDate", "expect(btn).toBeDate()"],
  ["toBeValidDate", "expect(btn).toBeValidDate()"],
  ["toBeEmpty", "expect(btn).toBeEmpty()"],
  ["toBeEmptyObject", "expect({ a: btn }).toBeEmptyObject()"],
  ["toBeObject", "expect(btn).not.toBeObject()"],
  ["toBeEven", "expect(btn).toBeEven()"],
  ["toBeOdd", "expect(btn).toBeOdd()"],
  ["toBeFinite", "expect(btn).toBeFinite()"],
  ["toBeFunction", "expect(btn).toBeFunction()"],
  ["toBeInteger", "expect(btn).toBeInteger()"],
  ["toBeNegative", "expect(btn).toBeNegative()"],
  ["toBePositive", "expect(btn).toBePositive()"],
  ["toBeNumber", "expect(btn).toBeNumber()"],
  ["toBeString", "expect(btn).toBeString()"],
  ["toBeSymbol", "expect(btn).toBeSymbol()"],
  ["toBeTypeOf", 'expect(btn).toBeTypeOf("string")'],
  ["toBeInstanceOf", "expect(btn).toBeInstanceOf(Map)"],
  ["toBeOneOf", "expect(btn).toBeOneOf([other])"],
  ["toBeOneOf", "expect(1).toBeOneOf([btn])"],
  ["toBeCloseTo", "expect(btn).toBeCloseTo(1)"],
  ["toBeGreaterThan", "expect(btn).toBeGreaterThan(1)"],
  ["toBeGreaterThanOrEqual", "expect(btn).toBeGreaterThanOrEqual(1)"],
  ["toBeLessThan", "expect(btn).toBeLessThan(1)"],
  ["toBeLessThanOrEqual", "expect(btn).toBeLessThanOrEqual(1)"],
  ["toBeWithin", "expect(btn).toBeWithin(1, 2)"],
  ["toContain", "expect([btn]).toContain(other)"],
  ["toContain", "expect([1]).toContain(btn)"],
  ["toContainKey", 'expect(btn).toContainKey("zzz")'],
  ["toContainKeys", 'expect(btn).toContainKeys(["zzz"])'],
  ["toContainAllKeys", 'expect(btn).toContainAllKeys(["zzz"])'],
  ["toContainAnyKeys", 'expect(btn).toContainAnyKeys(["zzz"])'],
  ["toContainValue", "expect({ a: btn }).toContainValue(other)"],
  ["toContainValues", "expect({ a: btn }).toContainValues([other])"],
  ["toContainAllValues", "expect({ a: btn }).toContainAllValues([other])"],
  ["toContainAnyValues", "expect({ a: btn }).toContainAnyValues([other])"],
  ["toHaveLength", "expect(btn).toHaveLength(5)"],
  ["toHaveProperty", 'expect(btn).toHaveProperty("zzz")'],
  ["toHaveProperty", 'expect({ a: btn }).toHaveProperty("a", other)'],
  ["toMatch", "expect(btn).toMatch(/x/)"],
  ["toStartWith", 'expect(btn).toStartWith("x")'],
  ["toEndWith", 'expect(btn).toEndWith("x")'],
  ["toInclude", 'expect(btn).toInclude("x")'],
  ["toIncludeRepeated", 'expect(btn).toIncludeRepeated("x", 2)'],
  ["toSatisfy", "expect(btn).toSatisfy(() => false)"],
  ["toThrow", "expect(btn).toThrow()"],
  ["toThrow", 'expect(() => { throw btn; }).toThrow("x")'],
  ["toThrow", "expect(() => { throw btn; }).not.toThrow()"],
  ["toThrowError", 'expect(() => { throw btn; }).toThrowError("x")'],
  ["toHaveBeenCalled", "expect(btn).toHaveBeenCalled()"],
  ["toHaveBeenCalled", "expect(fn).not.toHaveBeenCalled()"],
  ["toHaveBeenCalledOnce", "expect(fn).toHaveBeenCalledOnce()"],
  ["toHaveBeenCalledTimes", "expect(fn).toHaveBeenCalledTimes(5)"],
  ["toBeCalled", "expect(fn).not.toBeCalled()"],
  ["toBeCalledTimes", "expect(fn).toBeCalledTimes(5)"],
  ["toHaveBeenCalledWith", "expect(fn).toHaveBeenCalledWith(other)"],
  ["toHaveBeenCalledWith", "const g = mock(() => {}); g(1); expect(g).toHaveBeenCalledWith(btn)"],
  ["toHaveBeenCalledWith", "expect(fn).not.toHaveBeenCalledWith(btn)"],
  ["toBeCalledWith", "expect(fn).toBeCalledWith(other)"],
  ["toHaveBeenLastCalledWith", "expect(fn).toHaveBeenLastCalledWith(other)"],
  ["lastCalledWith", "expect(fn).lastCalledWith(other)"],
  ["toHaveBeenNthCalledWith", "expect(fn).toHaveBeenNthCalledWith(1, other)"],
  ["nthCalledWith", "expect(fn).nthCalledWith(1, other)"],
  ["toHaveReturned", "expect(fn).not.toHaveReturned()"],
  ["toReturn", "expect(fn).not.toReturn()"],
  ["toHaveReturnedTimes", "expect(fn).toHaveReturnedTimes(5)"],
  ["toHaveReturnedWith", "expect(fn).toHaveReturnedWith(other)"],
  ["toHaveLastReturnedWith", "expect(fn).toHaveLastReturnedWith(other)"],
  ["lastReturnedWith", "expect(fn).lastReturnedWith(other)"],
  ["toHaveNthReturnedWith", "expect(fn).toHaveNthReturnedWith(1, other)"],
  ["nthReturnedWith", "expect(fn).nthReturnedWith(1, other)"],
  ["toMatchSnapshot", "expect(btn).toMatchSnapshot()"],
  ["toMatchInlineSnapshot", "expect(btn).toMatchInlineSnapshot(`\"x\"`)"],
  ["toThrowErrorMatchingSnapshot", "expect(() => { throw btn; }).toThrowErrorMatchingSnapshot()"],
  ["toThrowErrorMatchingInlineSnapshot", "expect(() => { throw btn; }).toThrowErrorMatchingInlineSnapshot(`\"x\"`)"],
  ["fail", 'expect(btn).fail("short")'],
  ["pass", 'expect(btn).not.pass("short")'],
];

test("every matcher bun has, failing on an element, fails at once with a short message", async () => {
  const prototype = Object.getPrototypeOf(expect(0));
  // Its methods; `not`, `resolves` and `rejects` are accessors.
  const matchers = Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor" && typeof Object.getOwnPropertyDescriptor(prototype, name)!.value === "function");
  // A matcher a newer bun adds needs a case here (and, if it prints a diff, a place in DIFFS).
  expect(matchers.filter((name) => !FAILING.some(([matcher]) => matcher === name))).toEqual([]);

  const { code, output, ms } = await runInDom(FAILING.map(([matcher, assertion], i) => `test(${JSON.stringify(`${i} ${matcher}`)}, async () => { ${assertion}; });`).join("\n"));
  expect([code, output.match(/^ \d+ pass\n \d+ fail$/m)?.[0]]).toEqual([1, ` 0 pass\n ${FAILING.length} fail`]);
  // Each test's report ends with its "(fail)" line; without the guard some reach hundreds of megabytes.
  // On GitHub's runners bun repeats each failure as an "::error" annotation line, which doubles a report
  // (a plain event prints about 2.3 KB, so 4.5 KB there). The bound only has to tell kilobytes from megabytes.
  const reports = output.split(/^\(fail\) .*$/m).slice(0, FAILING.length);
  const sizes = reports.map((report, i) => [FAILING[i]![1], report.replace(/^::error .*$/gm, "").length] as const);
  expect(sizes.filter(([, size]) => size > 16_000)).toEqual([]);
  for (const [i, [matcher]] of FAILING.entries()) {
    const refused = (DIFFS as readonly string[]).includes(matcher) || (REFUSED as readonly string[]).includes(matcher);
    if (refused && !(matcher === "toHaveProperty" && FAILING[i]![1].includes('"zzz"'))) expect([i, reports[i]]).toEqual([i, expect.stringMatching(/was given|isn't available/)]);
  }
  expect(ms).toBeLessThan(20_000);
}, 60_000);

test("in a DOM, assertions on elements that hold still pass, and elements print short", async () => {
  const { code, output } = await runInDom(`test("case", async () => {
    expect(btn).toBe(btn);
    expect(btn).not.toBe(other);
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect([btn]).toContain(btn);
    expect(btn).toHaveProperty("id");
    expect(btn).toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]![0] === btn).toBe(true);
    await expect(Promise.resolve(btn)).resolves.toBe(btn);
    expect(() => { throw btn; }).toThrow();
    expect(Bun.inspect(btn)).toBe('<button id="b0" class="b">Button 0</button>');
    expect(Bun.inspect(btn.firstChild)).toBe('#text "Button 0"');
    expect(Bun.inspect(window)).toBe("[window]");
    const plain = mock(() => 1);
    plain("a");
    expect(plain).toHaveBeenCalledWith("a");
    expect(plain).toHaveReturnedWith(1);
  });`);
  expect([code, output]).toEqual([0, expect.stringContaining(" 1 pass")]);
}, 60_000);
