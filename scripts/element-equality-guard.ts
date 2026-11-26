// Imported first by the test setup of every workspace whose tests render into a DOM (the file each bunfig.toml preloads).
//
// When `expect(a).toEqual(b)` fails and `a` or `b` holds a rendered element (a DOM node, the window, or a
// React element), bun prints a diff of everything the element links to: the whole tree, React's fibers and
// the fake browser window behind it, at about 170 MB a second, until the machine runs out of memory. So an
// equality matcher given an element fails at once, with a short message, whether or not it would pass.
// Assert what the element shows instead: its text, an attribute, `element === other` as a boolean, or a count.
//
// CRITIQS_ELEMENT_GUARD=report logs each such assertion (file and line) to stderr instead of failing it.
import { expect } from "bun:test";

const MATCHERS = ["toEqual", "toStrictEqual", "toMatchObject", "toContainEqual"] as const;
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

/** The first rendered thing inside `value`, looking through arrays, plain objects, maps and sets; null when there is none. */
export function findRendered(value: unknown, seen = new Set<object>(), depth = 0): string | null {
  if (value === null || typeof value !== "object" || seen.has(value) || depth > 8) return null;
  seen.add(value);
  const kind = renderedKind(value);
  if (kind !== null) return kind;
  let children: Iterable<unknown>;
  if (Array.isArray(value)) children = value;
  else if (value instanceof Map) children = [...value.keys(), ...value.values()];
  else if (value instanceof Set) children = value;
  else {
    const prototype = Object.getPrototypeOf(value);
    // Class instances other than these (dates, errors, matchers like expect.any) are left alone.
    if (prototype !== Object.prototype && prototype !== null) return null;
    children = Object.values(value);
  }
  for (const child of children) {
    const found = findRendered(child, seen, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** The test file and line that made the assertion. */
function caller(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const frame = frames.find((line) => !line.includes("element-equality-guard") && /\.(test|spec)\.[cm]?[jt]sx?:|\/test\//.test(line));
  return (frame ?? frames[2] ?? "").trim().replace(/^at\s+/, "");
}

const reportOnly = process.env.CRITIQS_ELEMENT_GUARD === "report";
type Matcher = (this: unknown, expected: unknown) => void;
const builtIn = Object.getPrototypeOf(expect(0)) as Record<(typeof MATCHERS)[number], Matcher>;
const originals = Object.fromEntries(MATCHERS.map((name) => [name, builtIn[name]])) as Record<(typeof MATCHERS)[number], Matcher>;

// `expect.extend` replaces the built-in matchers and, unlike them, is handed the received value.
expect.extend(
  Object.fromEntries(
    MATCHERS.map((name) => [
      name,
      function (this: { isNot: boolean }, actual: unknown, expected: unknown) {
        const kind = findRendered(actual) ?? findRendered(expected);
        if (kind !== null) {
          const message = `${name} was given ${kind}. When it fails, bun prints the element's whole page and runs out of memory. Assert its text, an attribute, a count, or \`a === b\` as a boolean instead.`;
          if (!reportOnly) return { pass: this.isNot, message: () => message };
          console.error(`[element-equality] ${caller()} ${name} ${kind}`);
        }
        const assertion = expect(actual);
        try {
          originals[name].call(this.isNot ? assertion.not : assertion, expected);
          return { pass: !this.isNot, message: () => "" };
        } catch (error) {
          return { pass: this.isNot, message: () => (error instanceof Error ? error.message : String(error)) };
        }
      },
    ]),
  ),
);
