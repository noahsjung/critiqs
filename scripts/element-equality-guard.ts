// Imported first by the test setup of every workspace whose tests render into a DOM (the file each bunfig.toml preloads).
//
// When an assertion fails, bun prints what it was given. Given a rendered element, or anything that holds one (an
// event holds its target and the window), it prints everything the element links to: the whole tree, React's fibers
// and the fake browser window behind it. That takes seconds and hundreds of kilobytes at best; at worst it grows at
// about 170 MB a second until the machine runs out of memory. This file stops both, for every matcher bun has
// (`scripts/element-equality-guard.test.ts` fails one assertion per matcher on a real element and checks the list):
//
// 1. A DOM node prints as a short tag, such as `<button id="save">Save</button>`, and the window as `[window]`.
//    Every matcher that prints its values plainly (`toBe`, `toBeNull`, `toContain`, `toThrow`, ...) uses that form.
// 2. The matchers in `DIFFS` print a diff instead, which ignores the short form. Given an element anywhere in what
//    they would print, they fail at once with a short message, whether or not they would pass. Assert what the
//    element shows instead: its text, an attribute, `element === other` as a boolean, a count, or one mock argument.
//    (`toHaveProperty` prints a diff only when it is given a value to compare.)
// 3. `toMatchInlineSnapshot` serializes its value the same way, but bun refuses one called from a wrapper like this,
//    so it can't be checked and is refused outright. Use `toMatchSnapshot`, which is checked like the diffs.
//
// CRITIQS_ELEMENT_GUARD=report logs each assertion that would be refused (file and line) to stderr instead.
import { beforeAll, beforeEach, expect } from "bun:test";

/** Bun's matchers whose failure message is a diff of everything they were given (their mock's calls, for a mock). */
export const DIFFS = [
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toContainEqual",
  "toHaveProperty",
  "toHaveBeenCalledWith",
  "toBeCalledWith",
  "toHaveBeenLastCalledWith",
  "lastCalledWith",
  "toHaveBeenNthCalledWith",
  "nthCalledWith",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "lastReturnedWith",
  "toHaveNthReturnedWith",
  "nthReturnedWith",
  "toMatchSnapshot",
] as const;
type Diff = (typeof DIFFS)[number];
/** Matchers that are refused whatever they are given (see 3 above). */
export const REFUSED = ["toMatchInlineSnapshot"] as const;

const REACT_ELEMENTS = new Set([Symbol.for("react.element"), Symbol.for("react.transitional.element"), Symbol.for("react.portal")]);

/** What kind of rendered thing `value` is, or null when it is none. */
function renderedKind(value: object): string | null {
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.nodeType === "number" && typeof candidate.nodeName === "string") return `a DOM node (${candidate.nodeName})`;
  if ("document" in candidate && "location" in candidate && candidate.window === value) return "the window";
  if (typeof candidate.$$typeof === "symbol" && REACT_ELEMENTS.has(candidate.$$typeof)) return "a React element";
  if (candidate.__v_isVNode === true) return "a Vue node";
  return null;
}

/**
 * The first rendered thing inside `value`, or null when there is none. It looks through arrays, maps, sets and the
 * own fields of any object, class instances included (an event holds its target in one), the way bun's diff does.
 */
export function findRendered(value: unknown, seen = new Set<object>(), depth = 0): string | null {
  if (value === null || typeof value !== "object" || seen.has(value) || depth > 8) return null;
  seen.add(value);
  const kind = renderedKind(value);
  if (kind !== null) return kind;
  let children: unknown[];
  try {
    if (Array.isArray(value)) children = value;
    else if (value instanceof Map) children = [...value.keys(), ...value.values()];
    else if (value instanceof Set) children = [...value];
    else {
      // Data fields only: reading an accessor would run its code.
      children = Reflect.ownKeys(value).flatMap((key) => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field !== undefined && "value" in field ? [field.value] : [];
      });
    }
  } catch {
    return null; // a revoked proxy, for example; bun can't print it either
  }
  for (const child of children) {
    const found = findRendered(child, seen, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** What a diff of this assertion would print: the value, and for a mock its calls and results. */
function printed(actual: unknown, expected: unknown[]): unknown[] {
  const mock = (actual as { mock?: { calls?: unknown; results?: unknown } } | null)?.mock;
  return typeof actual === "function" && mock ? [mock.calls, mock.results, expected] : [actual, expected];
}

const SHORT = Bun.inspect.custom;
const isWindow = (value: object) => renderedKind(value) === "the window";

/** A DOM node as one short line: its opening tag and the start of its text. */
function shortNode(this: Node): string {
  const node = this as Node & Partial<Element>;
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length)}…` : value);
  if (node.nodeType === 1 && node.localName) {
    const attributes = [...(node.attributes ?? [])].slice(0, 4).map((attribute) => ` ${attribute.name}="${clip(attribute.value, 30)}"`);
    return `<${node.localName}${attributes.join("")}>${clip(text, 40)}</${node.localName}>`;
  }
  if (node.nodeType === 3) return `#text ${JSON.stringify(clip(text, 40))}`;
  if (node.nodeType === 8) return `<!--${clip(text, 40)}-->`;
  return node.nodeName;
}

/** Gives DOM nodes and the window their short printed form, once the test setup has made them. */
export function installShortForm(): void {
  const scope = globalThis as { Node?: unknown; window?: unknown };
  if (typeof scope.Node === "function" && !Object.hasOwn(scope.Node.prototype, SHORT)) {
    Object.defineProperty(scope.Node.prototype, SHORT, { value: shortNode, configurable: true });
  }
  const view = scope.window;
  if (view && typeof view === "object" && isWindow(view) && !Object.hasOwn(view, SHORT)) {
    Object.defineProperty(view, SHORT, { value: () => "[window]", configurable: true });
  }
}
installShortForm();
// The setup file creates the DOM after importing this file, so the short form is (re)applied before tests run.
beforeAll(installShortForm);
beforeEach(installShortForm);

/** The test file and line that made the assertion. */
function caller(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const frame = frames.find((line) => !line.includes("element-equality-guard") && /\.(test|spec)\.[cm]?[jt]sx?:|\/test\//.test(line));
  return (frame ?? frames[2] ?? "").trim().replace(/^at\s+/, "");
}

const reportOnly = process.env.CRITIQS_ELEMENT_GUARD === "report";
type Matcher = (this: unknown, ...expected: unknown[]) => unknown;
const builtIn = Object.getPrototypeOf(expect(0)) as Record<Diff, Matcher>;
const originals = Object.fromEntries(DIFFS.map((name) => [name, builtIn[name]])) as Record<Diff, Matcher>;

// `expect.extend` replaces the built-in matchers and, unlike them, is handed the received value.
expect.extend({
  ...Object.fromEntries(
    REFUSED.map((name) => [
      name,
      function (this: { isNot: boolean }) {
        return { pass: this.isNot, message: () => `${name} isn't available in tests that render into a DOM: given an element it prints the whole page, and bun won't let the element guard check it. Use toMatchSnapshot.` };
      },
    ]),
  ),
  ...Object.fromEntries(
    DIFFS.map((name) => [
      name,
      function (this: { isNot: boolean }, actual: unknown, ...expected: unknown[]) {
        const kind = name === "toHaveProperty" && expected.length < 2 ? null : findRendered(printed(actual, expected));
        if (kind !== null) {
          const where = typeof actual === "function" ? " (in the mock's calls or results, or what it was asked for)" : "";
          const message = `${name} was given ${kind}${where}. When it fails, bun prints the element's whole page and runs out of memory. Assert its text, an attribute, a count, \`a === b\` as a boolean, or one mock argument (\`fn.mock.calls[0][0] === element\`) instead.`;
          if (!reportOnly) return { pass: this.isNot, message: () => message };
          console.error(`[element-equality] ${caller()} ${name} ${kind}`);
        }
        const assertion = expect(actual);
        try {
          originals[name].apply(this.isNot ? assertion.not : assertion, expected);
          return { pass: !this.isNot, message: () => "" };
        } catch (error) {
          return { pass: this.isNot, message: () => (error instanceof Error ? error.message : String(error)) };
        }
      },
    ]),
  ),
});
