// Small runtime checks for messages that arrive from another document. Each
// check returns the value with its static type or throws a ProtocolError that
// names where the value went wrong.

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export type Check<T> = (value: unknown, path: string) => T;

const fail = (path: string, expected: string): never => {
  throw new ProtocolError(`${path || "message"} must be ${expected}.`);
};

/** Text up to `max` characters. */
export const text =
  (max = 4096): Check<string> =>
  (value, path) =>
    typeof value === "string" && value.length <= max ? value : fail(path, Number.isFinite(max) ? `text of at most ${max} characters` : "text");

/** The schemes a page Critiqs runs on can have: web pages, local files, and frames' `about:` documents. */
/** Schemes a page's address may have: the web's, and a local file's or a blank page's for installed Critiqs. */
export const PAGE_SCHEMES: readonly string[] = ["http:", "https:", "file:", "about:"];

/** A page's absolute address with one of `schemes`, never one that runs code (`javascript:`) or carries content (`data:`). */
export const webAddress =
  (max: number, schemes: readonly string[] = PAGE_SCHEMES): Check<string> =>
  (value, path) => {
    const address = text(max)(value, path);
    let parsed: URL | null = null;
    try {
      parsed = new URL(address);
    } catch {
      // Reported below.
    }
    return parsed !== null && schemes.includes(parsed.protocol) ? address : fail(path, `a page's ${schemes.map((scheme) => scheme.slice(0, -1)).join(", ")} address`);
  };

export const finite: Check<number> = (value, path) =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(path, "a finite number");

export const integer: Check<number> = (value, path) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(path, "a whole number");

export const boolean: Check<boolean> = (value, path) => (typeof value === "boolean" ? value : fail(path, "true or false"));

export const literal =
  <const T extends string | number>(expected: T): Check<T> =>
  (value, path) =>
    value === expected ? expected : fail(path, JSON.stringify(expected));

export const oneOf =
  <const T extends string>(values: readonly T[]): Check<T> =>
  (value, path) =>
    (values as readonly unknown[]).includes(value) ? (value as T) : fail(path, `one of ${values.join(", ")}`);

export const none: Check<null> = (value, path) => (value === null ? null : fail(path, "null"));

export const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (value, path) =>
    value === null ? null : check(value, path);

export const blob: Check<Blob> = (value, path) => (typeof Blob !== "undefined" && value instanceof Blob ? value : fail(path, "an image"));

export const array =
  <T>(check: Check<T>, max = 1_000_000): Check<T[]> =>
  (value, path) => {
    if (!Array.isArray(value) || value.length > max) return fail(path, `a list of at most ${max} entries`);
    return value.map((entry, index) => check(entry, `${path}[${index}]`));
  };

/** Whether a value is a plain object, as structured cloning and JSON produce. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An object of at most `max` entries, each key at most `maxKey` characters, each value checked. */
export const record =
  <T>(check: Check<T>, max = 1_000_000, maxKey = Number.POSITIVE_INFINITY): Check<Record<string, T>> =>
  (value, path) => {
    if (!isRecord(value)) return fail(path, "an object");
    const entries = Object.entries(value);
    if (entries.length > max) return fail(path, `an object of at most ${max} entries`);
    const result: Record<string, T> = Object.create(null);
    for (const [key, entry] of entries) {
      if (key.length > maxKey) return fail(path, `an object whose keys have at most ${maxKey} characters`);
      result[key] = check(entry, `${path}.${key.slice(0, 64)}`);
    }
    return result;
  };

type Shape<T> = { [K in keyof T]-?: Check<T[K]> };

/**
 * An object with exactly these keys. Every key is required, so a sender
 * can't leave one out by accident: optional values are sent as null.
 */
export const object =
  <T extends object>(shape: Shape<T>): Check<T> =>
  (value, path) => {
    if (!isRecord(value)) return fail(path, "an object");
    for (const key of Object.keys(value)) if (!Object.hasOwn(shape, key)) fail(`${path}.${key}`, "left out (unknown field)");
    const result = {} as T;
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "present");
      result[key] = shape[key](value[key], `${path}.${key}`);
    }
    return result;
  };

/** One of several object shapes, told apart by a field such as `status`. */
export const variants =
  <K extends string, T extends Record<K, string>>(key: K, shapes: { [V in T[K]]: Check<Extract<T, Record<K, V>>> }): Check<T> =>
  (value, path) => {
    if (!isRecord(value)) return fail(path, "an object");
    const tag = value[key];
    const check = typeof tag === "string" && Object.hasOwn(shapes, tag) ? (shapes as Record<string, Check<T>>)[tag] : undefined;
    return check === undefined ? fail(`${path}.${key}`, `one of ${Object.keys(shapes).join(", ")}`) : check(value, path);
  };
