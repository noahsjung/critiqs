// Solid setup: adds <Critiqs /> from critiqs-solid to the app's root
// component (src/App.tsx in a Vite app made with `npm create solid`,
// src/app.tsx in SolidStart), or updates the one already there. Apps with
// Solid Router get it from critiqs-solid/router, which reports routes.
// Reads only.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
// The JSX reader React's setup uses; Solid's JSX has the same syntax.
import { changedLines, configFile, ENV_FILES, findSourceFiles, lineAt, scanSource } from "./jsx.mjs";
import { dependsOn, readText } from "./shared.mjs";

const PACKAGE = "critiqs-solid";
/** The entry that also reports Solid Router's routes and navigates to a thread's. */
const ROUTER_ENTRY = "critiqs-solid/router";
/** The modules `<Critiqs>` comes from. */
const MODULES = new Set([PACKAGE, ROUTER_ENTRY]);
/** Where setup imports Critiqs from in this app. */
const entryFor = (root) => (dependsOn(root, "@solidjs/router") ? ROUTER_ENTRY : PACKAGE);
/** Extensions where `<` can start JSX; in .ts it is a type assertion or generic. */
const JSX_EXTENSIONS = new Set([".tsx", ".jsx", ".js"]);
/** Vite, which SolidStart also builds with, inlines `VITE_` variables. */
const VITE_PACKAGES = ["vite", "@solidjs/start", "@solidjs/vite-plugin", "vite-plugin-solid"];
/** Solid Router's router components (`Router`, `HashRouter`, `MemoryRouter`, …) end in Router; each renders its layout from a function (`root={…}` or its children), and its children are routes. */
const ROUTER = /Router$/;
/** Where a relative import can lead, as Vite resolves it. */
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const LITERAL = /^(["'`])([^"'`\\\r\n]*)\1$/;
const ENV_READ = /^import\.meta\.env\.([A-Za-z_$][\w$]*)$/;
const NAME = "[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200c\\u200d]*";
/** Words before `(…) {` that start a statement rather than a function. */
const CONTROL = new Set(["if", "for", "while", "switch", "with", "return", "typeof", "await", "yield", "new", "in", "of"]);
/** What can continue an expression on the next line, so a string before it isn't a directive on its own. */
const CONTINUES = /^(?:[.[(`+\-*/%,?:=<>&|^]|in\b|instanceof\b)/;

const isStart = (root) => dependsOn(root, "@solidjs/start");
const shown = (root, file) => relative(root, file).split(sep).join("/");
const within = (index, ranges) => ranges.some(([start, end]) => index >= start && index < end);

// ---------------------------------------------------------------------------
// Reading a file: imports, the component it exports, and what names `Critiqs`

/**
 * What setup reads of one file. `code` is the source with comments and the
 * contents of strings, templates, and JSX text blanked (line breaks kept), so
 * keywords and brackets are matched at the same indices without meeting them
 * in prose. `pairs` maps each bracket to its partner and `inner[i]` is the
 * innermost bracket around index `i` (-1 at the top level); `balanced` is
 * false when brackets don't pair up, such as around a regular expression
 * holding one.
 */
function readFile(source, jsx = true) {
  const { elements, all, comments, literals } = scanSource(source, { jsx });
  const chars = source.split("");
  const blank = (start, end, keepQuotes) => {
    for (let i = start; i < end; i++) {
      if (keepQuotes && (i === start || i === end - 1)) continue;
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };
  if (source.startsWith("﻿")) chars[0] = " ";
  if (source.startsWith("#!", chars[0] === " " ? 1 : 0)) blank(0, source.indexOf("\n") === -1 ? source.length : source.indexOf("\n"), false);
  for (const [start, end] of comments) blank(start, end, false);
  for (const [start, end] of literals) blank(start, end, /["'`]/.test(source[start] ?? ""));
  const code = chars.join("");

  const pairs = new Map();
  const inner = new Int32Array(code.length + 1).fill(-1);
  const stack = [];
  let balanced = true;
  for (let i = 0; i < code.length; i++) {
    inner[i] = stack.at(-1) ?? -1;
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const open = stack.at(-1);
      if (open === undefined || code[open] !== { ")": "(", "]": "[", "}": "{" }[c]) {
        balanced = false;
        continue;
      }
      stack.pop();
      pairs.set(open, i);
      pairs.set(i, open);
    }
  }
  if (stack.length > 0) balanced = false;
  inner[code.length] = -1;
  const file = { source, code, elements, all, comments, literals, pairs, inner, balanced, imports: [] };
  file.imports = readImports(file);
  return file;
}

const nextIndex = (code, i) => {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
};
const prevIndex = (code, i) => {
  i--;
  while (i >= 0 && /\s/.test(code[i])) i--;
  return i;
};
/** The identifier or keyword that ends right before index `i`, skipping spaces, or null. */
const wordBefore = (code, i) => new RegExp(`(${NAME})\\s*$`, "u").exec(code.slice(Math.max(0, i - 64), i))?.[1] ?? null;

const SPECIFIER = new RegExp(`^(type\\s+)?(${NAME}|(["'])[^]*\\3)(?:\\s+as\\s+(${NAME}))?$`, "u");
const IMPORT = new RegExp(`import\\s*(type\\s+)?(?:(${NAME})\\s*,?\\s*)?(?:\\{([^{}]*)\\}|\\*\\s*as\\s+(${NAME}))?\\s*(?:from\\s*)?(["'])`, "uy");
const EXPORT_FROM = new RegExp(`export\\s*(?:type\\s+)?(?:\\{([^{}]*)\\}|\\*(?:\\s*as\\s+${NAME})?)\\s*from\\s*(["'])`, "uy");
const STATEMENT_END = /[ \t]*(?:(?:with|assert)\s*\{[^{}]*\}[ \t]*)?;?/y;

function specifiers(text, typeOnly) {
  return text
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== "")
    .map((specifier) => {
      const match = SPECIFIER.exec(specifier);
      const imported = match === null || match[3] !== undefined ? null : match[2];
      return { imported, local: match?.[4] ?? imported, typeOnly: typeOnly || match?.[1] !== undefined };
    });
}

/**
 * The file's top-level `import … from` and `export … from` declarations: the
 * module, each name it binds (`imported` as `local`; `default` for a default
 * import), and where the statement starts and ends. Comments inside are
 * already blanked, so `Critiqs as /* note *\/ Feedback` reads as an alias.
 */
function readImports(file) {
  const { source, code, inner } = file;
  const found = [];
  for (const match of code.matchAll(/\b(import|export)\b/g)) {
    const start = match.index ?? 0;
    if (inner[start] !== -1 || code[prevIndex(code, start)] === ".") continue;
    const pattern = match[1] === "import" ? IMPORT : EXPORT_FROM;
    pattern.lastIndex = start;
    const parts = pattern.exec(code);
    if (parts === null) continue;
    const quote = start + parts[0].length - 1;
    const close = code.indexOf(code[quote], quote + 1);
    if (close === -1) continue;
    STATEMENT_END.lastIndex = close + 1;
    STATEMENT_END.exec(code);
    const declaration = { kind: match[1], start, end: STATEMENT_END.lastIndex, module: source.slice(quote + 1, close), quote: code[quote], bindings: [], namespace: false };
    if (match[1] === "import") {
      const typeOnly = parts[1] !== undefined;
      if (parts[2] !== undefined) declaration.bindings.push({ imported: "default", local: parts[2], typeOnly });
      if (parts[3] !== undefined) declaration.bindings.push(...specifiers(parts[3], typeOnly));
      declaration.namespace = parts[4] !== undefined;
    }
    found.push(declaration);
  }
  return found;
}

/** Whether the file imports `Critiqs` under its own name from critiqs-solid or critiqs-solid/router. */
const importsCritiqs = (file) =>
  file.imports.some((declaration) => declaration.kind === "import" && MODULES.has(declaration.module) && declaration.bindings.some((binding) => binding.imported === "Critiqs" && binding.local === "Critiqs" && !binding.typeOnly));

/** Whether the file uses critiqs-solid in a way setup can't follow: under another name, as a namespace, re-exported, or loaded at run time. */
function usesCritiqsOtherwise(file) {
  for (const declaration of file.imports) {
    if (!MODULES.has(declaration.module)) continue;
    if (declaration.kind === "export" || declaration.namespace) return true;
    if (declaration.bindings.some((binding) => binding.imported === "Critiqs" && binding.local !== "Critiqs")) return true;
  }
  for (const match of file.code.matchAll(/\b(?:require|import)\s*\(\s*(["'`])/g)) {
    const quote = (match.index ?? 0) + match[0].length - 1;
    const close = file.code.indexOf(match[1], quote + 1);
    if (close !== -1 && MODULES.has(file.source.slice(quote + 1, close))) return true;
  }
  return false;
}

/** Where an expression starting at `i` ends: the first `;`, `,`, or closing bracket outside the brackets it opens. */
function expressionEnd(file, i) {
  const { code, pairs } = file;
  while (i < code.length) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = (pairs.get(i) ?? code.length - 1) + 1;
    else if (c === ")" || c === "]" || c === "}" || c === ";" || c === ",") return i;
    else i++;
  }
  return i;
}

/** The [start, end) range of an arrow function's body, given the index of its `=>`. */
function arrowBody(file, arrow) {
  const body = nextIndex(file.code, arrow + 2);
  return [body, file.code[body] === "{" ? (file.pairs.get(body) ?? file.code.length - 1) + 1 : expressionEnd(file, body)];
}

/** Where `<…>` type parameters or arguments opening at `i` end, or -1. An arrow's `=>` inside doesn't close them. */
function angleEnd(file, i) {
  const { code, pairs } = file;
  let depth = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = pairs.get(i) ?? code.length;
    else if (c === "=" && code[i + 1] === ">") i++;
    else if (c === "<") depth++;
    else if (c === ">" && --depth === 0) return i + 1;
    else if (c === ";" || c === ")" || c === "]" || c === "}") return -1;
  }
  return -1;
}

const TYPE_PREFIX = /(?:keyof|typeof|readonly|unique|infer|asserts|new|abstract)(?![\p{ID_Continue}$])/uy;
const TYPE_NAME = new RegExp(`-?(?:${NAME}|\\d[\\w.]*)(?:\\s*\\.\\s*${NAME})*`, "uy");
const TYPE_JOIN = /(?:is|extends)(?![\p{ID_Continue}$])/uy;

/**
 * Where a TypeScript type starting at `i` ends: a return type such as `{
 * element: ReturnType<typeof X> }`, `Promise<A | B>`, `(a: A) => B`, or `x is
 * T`. Its object, tuple, and parameter brackets are skipped whole, so the `{`
 * of an object type isn't read as the function's body.
 */
function typeEnd(file, i) {
  const { code, pairs } = file;
  const skip = (at) => (pairs.get(at) ?? code.length - 1) + 1;
  let conditional = 0;
  for (;;) {
    i = nextIndex(code, i);
    if (code[i] === "|" || code[i] === "&") {
      i++;
      continue;
    }
    TYPE_PREFIX.lastIndex = i;
    if (TYPE_PREFIX.exec(code) !== null) {
      i = TYPE_PREFIX.lastIndex;
      continue;
    }
    const c = code[i];
    if (c === "{" || c === "[") i = skip(i);
    else if (c === "(") {
      i = skip(i);
      const arrow = nextIndex(code, i);
      if (code.startsWith("=>", arrow)) {
        i = arrow + 2;
        continue;
      }
    } else if (c === "<") {
      // A generic function type: `<T>(value: T) => T`.
      const end = angleEnd(file, i);
      if (end === -1) return i;
      i = end;
      continue;
    } else if (c === '"' || c === "'" || c === "`") {
      const close = code.indexOf(c, i + 1);
      if (close === -1) return i;
      i = close + 1;
    } else {
      TYPE_NAME.lastIndex = i;
      if (TYPE_NAME.exec(code) === null) return i;
      i = TYPE_NAME.lastIndex;
      const args = nextIndex(code, i);
      if (code[args] === "<") i = Math.max(i, angleEnd(file, args));
    }
    for (let k = nextIndex(code, i); code[k] === "["; k = nextIndex(code, i)) i = skip(k);
    const k = nextIndex(code, i);
    TYPE_JOIN.lastIndex = k;
    if (code[k] === "|" || code[k] === "&" || code[k] === "?" || (code[k] === ":" && conditional > 0)) {
      if (code[k] === "?") conditional++;
      if (code[k] === ":") conditional--;
      i = k + 1;
    } else if (TYPE_JOIN.exec(code) !== null) {
      i = TYPE_JOIN.lastIndex;
    } else {
      return i;
    }
  }
}

/** After a parameter list closing at `close`: the index of `=>` or of the body's `{`, skipping a return type, or -1. */
function afterParameters(file, close) {
  const { code } = file;
  let i = nextIndex(code, close + 1);
  if (code[i] === ":") i = nextIndex(code, typeEnd(file, i + 1));
  return code.startsWith("=>", i) || code[i] === "{" ? i : -1;
}

/** The range a function's parameters, opening with `(` at `open`, are bound in; null when the brackets aren't a parameter list. */
function parameterScope(file, open) {
  const { code, pairs } = file;
  const close = pairs.get(open);
  if (close === undefined) return null;
  const next = afterParameters(file, close);
  if (next === -1) return null;
  if (code[next] === "=") return [open, arrowBody(file, next)[1]];
  // `name(…) {` is a function, method, or catch clause unless `name` starts a statement such as `if`; `name<T>(…) {` has type parameters.
  const word = wordBefore(code, open);
  const before = code[prevIndex(code, open)];
  if (word === null ? before !== "*" && before !== "]" && before !== ">" : CONTROL.has(word)) return null;
  return [open, (pairs.get(next) ?? code.length - 1) + 1];
}

/** The block a declaration at `i` belongs to, or the whole file at the top level. */
function blockScope(file, i) {
  for (let open = file.inner[i]; open !== -1; open = file.inner[open]) {
    if (file.code[open] === "{") return [open, (file.pairs.get(open) ?? file.code.length - 1) + 1];
  }
  return [0, file.code.length];
}

const DECLARES = /^(?:const|let|var|using)$/;
const WORD_CHAR = /[\p{ID_Continue}$\u200c\u200d]/u;

/**
 * The `const`, `let`, `var`, or `using` whose declaration list the code at `i`
 * is in, after a comma (`const n = 1, Critiqs = …`), or null. Searches back
 * through the brackets `i` is in, skipping nested ones, to a `;` or the
 * bracket's start. A comma statement after a declaration that has no
 * semicolon reads as part of it, which errs toward a binding.
 */
function declarationKeyword(file, i) {
  const { code, inner, pairs } = file;
  const level = inner[i];
  for (let j = i - 1; j > level; j--) {
    const c = code[j];
    if (c === ")" || c === "]" || c === "}") j = pairs.get(j) ?? j;
    else if (c === ";") return null;
    else if (WORD_CHAR.test(c) && !WORD_CHAR.test(code[j - 1] ?? "")) {
      const word = new RegExp(`^${NAME}`, "u").exec(code.slice(j, j + 64))?.[0] ?? "";
      if (DECLARES.test(word) && code[prevIndex(code, j)] !== ".") return word;
    }
  }
  return null;
}

/** The range a declaration made with `keyword` at `i` binds in: a `var` is seen by its whole function, so it counts for the whole file. */
const declarationScope = (file, i, keyword) => (keyword === "var" ? [0, file.code.length] : blockScope(file, i));

/**
 * Where `name` is bound by the file's own code rather than a module import:
 * a function's parameter (`function App({ Critiqs })`, `(Critiqs) => …`), a
 * declaration (`const Critiqs = …`, `const { Critiqs } = props`, `let n = 1,
 * Critiqs = …`), or a catch clause. Each is the range of code that reads the
 * local binding. Where the reading is unsure it errs toward a larger range,
 * so setup refuses rather than edits an element that isn't critiqs-solid's.
 */
function localBindings(file, name) {
  const { code, inner } = file;
  const scopes = [];
  const occurrence = new RegExp(`(?<![\\p{ID_Continue}$.])${name}(?![\\p{ID_Continue}$])`, "gu");
  for (const match of code.matchAll(occurrence)) {
    const at = match.index ?? 0;
    const p = prevIndex(code, at);
    const n = nextIndex(code, at + name.length);
    const prev = code[p];
    // A JSX tag (`<Critiqs`, `</Critiqs`) reads the name; it doesn't bind it.
    if (prev === "<" || (prev === "/" && code[prevIndex(code, p)] === "<")) continue;
    const word = wordBefore(code, at);
    if (word !== null && (DECLARES.test(word) || word === "function" || word === "class")) {
      scopes.push(declarationScope(file, at, word));
      continue;
    }
    const listed = prev === "," ? declarationKeyword(file, at) : null;
    if (listed !== null) {
      scopes.push(declarationScope(file, at, listed));
      continue;
    }
    if (code.startsWith("=>", n)) {
      scopes.push([at, arrowBody(file, n)[1]]);
      continue;
    }
    // A default value, an assignment, a comparison, or a ternary branch reads it.
    if (prev === "=" || prev === "?" || prev === "!") continue;
    let open = inner[at];
    if (open === -1) continue;
    // `{ Critiqs: … }` is a property name; `(props: Critiqs)` a type.
    if (code[open] === "{" && code[n] === ":" && code[n + 1] !== ":") continue;
    if (code[open] === "(" && prev === ":") continue;
    // Climb out of destructuring patterns to the parameter list or declaration they belong to.
    let scope = null;
    while (open !== -1 && (code[open] === "{" || code[open] === "[")) {
      const before = prevIndex(code, open);
      const word = wordBefore(code, open);
      const keyword = word !== null && DECLARES.test(word) ? word : code[before] === "," ? declarationKeyword(file, open) : null;
      if (keyword !== null) {
        scope = declarationScope(file, open, keyword);
        break;
      }
      if (!"([{,:".includes(code[before] ?? "") && !code.startsWith("...", before - 2)) break;
      open = inner[open];
    }
    if (scope === null && open !== -1 && code[open] === "(") scope = parameterScope(file, open);
    if (scope !== null) scopes.push(scope);
  }
  return scopes;
}

/**
 * A function starting at `i` (after spaces), or null when none starts there:
 * its [start, end) `range`, and its `body`, the block from its `{` or the
 * expression an arrow returns. Type parameters and a return type are skipped.
 */
function functionAt(file, i) {
  const { code, pairs } = file;
  i = nextIndex(code, i);
  const declared = new RegExp(`(?:async\\s+)?function\\b\\s*\\*?\\s*(?:${NAME})?\\s*`, "uy");
  declared.lastIndex = i;
  if (declared.exec(code) !== null) {
    let open = declared.lastIndex;
    if (code[open] === "<") open = nextIndex(code, angleEnd(file, open));
    if (code[open] !== "(") return null;
    const next = afterParameters(file, pairs.get(open) ?? code.length);
    if (next === -1 || code[next] !== "{") return null;
    const end = (pairs.get(next) ?? code.length - 1) + 1;
    return { range: [i, end], body: [next, end] };
  }
  let at = i;
  const async = /async(?![\p{ID_Continue}$])\s*/uy;
  async.lastIndex = at;
  if (async.exec(code) !== null) at = async.lastIndex;
  if (code[at] === "<") {
    const end = angleEnd(file, at);
    if (end === -1) return null;
    at = nextIndex(code, end);
  }
  let next;
  if (code[at] === "(") next = afterParameters(file, pairs.get(at) ?? code.length);
  else {
    const single = new RegExp(`${NAME}\\s*(?==>)`, "uy");
    single.lastIndex = at;
    next = single.exec(code) === null ? -1 : single.lastIndex;
  }
  if (next === -1 || !code.startsWith("=>", next)) return null;
  const body = arrowBody(file, next);
  return { range: [i, body[1]], body };
}

/** The top-level function or function-valued declaration named `name`, or null. */
function declaredFunction(file, name) {
  const { code, inner } = file;
  const declaration = new RegExp(`\\b(?:function\\s*\\*?\\s*${name}\\b|(?:const|let|var)\\s+${name}\\b[^=;]*=(?!=))`, "gu");
  for (const match of code.matchAll(declaration)) {
    const at = match.index ?? 0;
    if (inner[at] !== -1) continue;
    return match[0].startsWith("function") ? functionAt(file, at) : functionAt(file, at + match[0].length);
  }
  return null;
}

/**
 * The function of the component the file renders (see `functionAt`): its default
 * export (`export default function App`, `export default App`, an arrow, or
 * `export { App as default }`), or, with no default export, the one component
 * it exports. A string says why there is none.
 */
function exportedComponent(file) {
  const { code, inner } = file;
  const topLevel = (pattern) => [...code.matchAll(pattern)].filter((match) => inner[match.index ?? 0] === -1);
  const [byDefault] = topLevel(/\bexport\s+default\b\s*/g);
  if (byDefault !== undefined) {
    const at = (byDefault.index ?? 0) + byDefault[0].length;
    const named = new RegExp(`(${NAME})\\s*(?:;|$)`, "uym");
    named.lastIndex = at;
    const name = named.exec(code)?.[1];
    if (name !== undefined && !["function", "async", "class"].includes(name)) return declaredFunction(file, name) ?? `its default export, ${name}, isn't a function this file defines`;
    return functionAt(file, at) ?? "its default export isn't a function";
  }
  const [alias] = topLevel(new RegExp(`\\bexport\\s*\\{[^{}]*?(?<![\\p{ID_Continue}$])(${NAME})\\s+as\\s+default\\b`, "gu"));
  if (alias !== undefined) return declaredFunction(file, alias[1]) ?? `its default export, ${alias[1]}, isn't a function this file defines`;
  const exported = topLevel(new RegExp(`\\bexport\\s+(?:(?:async\\s+)?function\\s*\\*?\\s*|(?:const|let|var)\\s+)(${NAME})`, "gu"));
  if (exported.length !== 1) return exported.length === 0 ? "it exports no component" : `it exports ${exported.length} components and none as default`;
  return declaredFunction(file, exported[0][1]) ?? `${exported[0][1]} isn't a function`;
}

/** A relative module's file, as Vite resolves it: the path, the path with a source extension (`./router` is `./router.ts`), or its index file. */
function moduleFile(from, specifier) {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, ...MODULE_EXTENSIONS.map((extension) => `${stem}${extension}`), ...MODULE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/** Whether the file's top-level `name` is made by Solid Router's `createRouter`, imported under any name: `const name = createRouter(…)`. */
function makesRouter(file, name) {
  const makers = file.imports
    .filter((declaration) => declaration.kind === "import" && declaration.module === "@solidjs/router")
    .flatMap((declaration) => declaration.bindings.filter((binding) => binding.imported === "createRouter" && !binding.typeOnly).map((binding) => binding.local));
  if (makers.length === 0) return false;
  const made = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=;]*)?=\\s*(?:${makers.join("|")})\\s*\\(`, "gu");
  return [...file.code.matchAll(made)].some((match) => file.inner[match.index ?? 0] === -1);
}

/** The top-level name the file exports as `exported`: `export const Router = …`, or `export { routing as Router }`; null when it doesn't. */
function exportedLocal(file, exported) {
  const { code, inner } = file;
  const topLevel = (pattern) => [...code.matchAll(pattern)].filter((match) => inner[match.index ?? 0] === -1);
  if (topLevel(new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${exported}(?![\\p{ID_Continue}$])`, "gu")).length > 0) return exported;
  for (const match of topLevel(/\bexport\s*\{([^{}]*)\}/g)) {
    const from = /^\s*from\b/.test(code.slice((match.index ?? 0) + match[0].length));
    if (from) continue;
    for (const { imported, local } of specifiers(match[1], false)) {
      if (imported !== null && local === exported) return imported;
    }
  }
  return null;
}

/**
 * Whether an element named `name` in the file at `path` is a Solid Router
 * router: one of its `…Router` components imported under any name, or a
 * router made with its `createRouter`, in this file or in a relative module
 * that exports it (the Solid 2 starter's `src/router.ts`). Null when setup
 * can't tell: a `…Router` it can't trace to Solid Router.
 */
function isRouter(file, path, name) {
  // A fragment, an intrinsic element, or a member such as `<Lib.Router>`, which no import or declaration names alone.
  if (!new RegExp(`^${NAME}$`, "u").test(name) || /^[a-z]/.test(name)) return ROUTER.test(name) ? null : false;
  for (const declaration of file.imports) {
    if (declaration.kind !== "import") continue;
    const binding = declaration.bindings.find((candidate) => candidate.local === name && !candidate.typeOnly);
    if (binding === undefined) continue;
    const { imported } = binding;
    if (declaration.module === "@solidjs/router") return imported !== null && imported !== "default" && ROUTER.test(imported);
    if (declaration.module.startsWith(".") && imported !== null && imported !== "default") {
      const target = moduleFile(path, declaration.module);
      const source = target === null ? null : readText(target);
      if (source !== null) {
        const other = readFile(source, JSX_EXTENSIONS.has(extname(target)));
        const local = exportedLocal(other, imported);
        if (local !== null && makesRouter(other, local)) return true;
      }
    }
    return ROUTER.test(name) || ROUTER.test(imported ?? "") ? null : false;
  }
  if (makesRouter(file, name)) return true;
  return ROUTER.test(name) ? null : false;
}

/**
 * The functions defined inside the component `[start, end)`, other than the
 * component itself, as [start, end) ranges: arrows, function declarations and
 * expressions, and methods. JSX in one of them is rendered only if that
 * function is called.
 */
function nestedFunctions(file, [start, end]) {
  const { code } = file;
  const ranges = [];
  for (let i = start; i < end; i++) {
    if (code[i] === "(") {
      const scope = parameterScope(file, i);
      if (scope !== null) ranges.push(scope);
    } else if (code.startsWith("=>", i) && code[prevIndex(code, i)] !== ")") {
      ranges.push([i, arrowBody(file, i)[1]]);
    }
  }
  return ranges.filter(([, rangeEnd]) => rangeEnd < end);
}

/** The `{…}` range of a JSX element's `root` attribute, or null when it has none. Attribute values are code, so `root=` inside one sits deeper in brackets than the tag. */
function rootAttribute(file, element) {
  const { code, inner, pairs } = file;
  const tag = code.slice(element.start, element.openEnd);
  for (const match of tag.matchAll(/(?<![\p{ID_Continue}$.-])root\s*=\s*\{/gu)) {
    const at = element.start + (match.index ?? 0);
    if (inner[at] !== inner[element.start]) continue;
    const open = at + match[0].length - 1;
    return [open, (pairs.get(open) ?? code.length - 1) + 1];
  }
  return null;
}

/** The functions an element renders its children from: `{(props) => …}` written directly among its children. */
function functionChildren(file, element) {
  const { code, pairs, inner } = file;
  if (element.close === null) return [];
  const children = file.all.filter((child) => child.depth === element.depth + 1 && child.start >= element.openEnd && child.end <= element.close.start).map((child) => [child.start, child.end]);
  const level = inner[element.start];
  const found = [];
  for (let i = element.openEnd; i < element.close.start; i++) {
    if (code[i] !== "{" || inner[i] !== level || within(i, children)) continue;
    const close = pairs.get(i) ?? code.length;
    const fn = functionAt(file, i + 1);
    if (fn !== null && nextIndex(code, fn.range[1]) === close) found.push(fn);
    i = close;
  }
  return found;
}

/**
 * The JSX element a function returns: its arrow's expression, or the
 * expression of the one `return` in its own body (not one in a function it
 * defines), when that is an element (in parentheses or not) and nothing
 * else. A string says why there is none.
 */
function returnedElement(file, fn) {
  const { code } = file;
  let [start, end] = fn.body;
  if (code[start] === "{") {
    const nested = nestedFunctions(file, fn.range);
    const returns = [...code.slice(start, end).matchAll(/(?<![\p{ID_Continue}$.])return(?![\p{ID_Continue}$])/gu)].map((match) => start + (match.index ?? 0)).filter((at) => !within(at, nested));
    if (returns.length !== 1) return returns.length === 0 ? "it returns no JSX" : `it returns in ${returns.length} places`;
    start = returns[0] + "return".length;
    end = expressionEnd(file, start);
  }
  let i = nextIndex(code, start);
  let parens = 0;
  while (code[i] === "(") {
    parens++;
    i = nextIndex(code, i + 1);
  }
  const element = file.all.find((candidate) => candidate.start === i);
  if (element === undefined) return "it returns no JSX";
  let j = nextIndex(code, element.end);
  for (; parens > 0 && code[j] === ")"; parens--) j = nextIndex(code, j + 1);
  if (parens > 0 || (j < end && code[j] !== ";")) return "it returns more than a JSX element";
  return element;
}

/**
 * The function a router renders its layout from: the one in its `root`
 * property (SolidStart's `root={props => (…)}`) or its one function child
 * (Solid 2's `{(props) => (…)}`), never another property such as
 * `fallback`; null when there is none.
 */
function layoutFunction(file, router) {
  const root = rootAttribute(file, router);
  if (root !== null) {
    const fn = functionAt(file, root[0] + 1);
    return fn !== null && nextIndex(file.code, fn.range[1]) === root[1] - 1 ? fn : null;
  }
  const children = functionChildren(file, router);
  return children.length === 1 ? children[0] : null;
}

/** Why setup can't add a child to `element`, or null: it renders its children from a function, or takes a router's `root` layout, so a new child would break it or land among routes. */
function unsureParent(file, element) {
  if (functionChildren(file, element).length > 0) return `its <${element.name || "fragment"}> renders its children from a function, so setup can't tell where a child would go`;
  if (rootAttribute(file, element) !== null) return `its <${element.name}> takes a root layout as a router does, but setup can't tell whether it is Solid Router's`;
  return null;
}

/**
 * The element in the exported component that Critiqs goes inside, at `path`:
 * within the JSX element the component returns. When that tree renders a
 * Solid Router router (`<Router>`, `<main><Router>`, under any name, or one
 * made with `createRouter`), it is the element the router's layout function
 * returns, so Critiqs is inside the router and not among its routes or
 * beside its layout function. Otherwise it is the returned element. A string
 * says why there is none.
 */
function container(file, component, path) {
  const top = returnedElement(file, component);
  if (typeof top === "string") return top;
  const rendered = file.all.filter((element) => element.start >= top.start && element.end <= top.end);
  const functions = nestedFunctions(file, component.range);
  /** Whether the element at `at` is rendered by the code at `from`, with no function defined between them. */
  const direct = (at, from) => !functions.some(([fnStart, fnEnd]) => fnStart > from && fnStart <= at && at < fnEnd);
  const routers = [];
  for (const element of rendered) {
    const router = isRouter(file, path, element.name);
    if (router === null) return `setup can't tell whether its <${element.name}> is Solid Router's router`;
    if (router) routers.push(element);
  }
  if (routers.length === 0) return unsureParent(file, top) ?? top;
  if (routers.length > 1) return `it renders ${routers.length} routers`;
  const [router] = routers;
  if (!direct(router.start, top.start)) return `its <${router.name}> is inside a function, which setup can't follow`;
  const layout = layoutFunction(file, router);
  if (layout === null) return `its <${router.name}> renders no layout setup can find`;
  const element = returnedElement(file, layout);
  if (typeof element === "string") return `its <${router.name}> layout ${element.replace(/^it /, "")}`;
  return unsureParent(file, element) ?? element;
}

// ---------------------------------------------------------------------------
// Finding and editing <Critiqs>

/** `<Critiqs>` elements in one file that name critiqs-solid's component: it is imported, and no parameter or declaration around the element takes the name. */
function elementsIn(path, source) {
  if (!source.includes(PACKAGE)) return [];
  const file = readFile(source, JSX_EXTENSIONS.has(extname(path)));
  if (!importsCritiqs(file)) return [];
  const local = localBindings(file, "Critiqs");
  return file.elements.filter((element) => !within(element.start, local));
}

function findElements(root) {
  const found = [];
  for (const file of findSourceFiles(root)) {
    const source = readText(file);
    if (source === null) continue;
    for (const element of elementsIn(file, source)) found.push({ file, source, element });
  }
  return found;
}

/** An attribute's value as setup reads it; see `SettingRead`. A bare attribute reads as the literal "". */
function readAttribute(source, attribute) {
  if (attribute === undefined) return null;
  const { value } = attribute;
  if (value === null) return { kind: "literal", value: "" };
  if (value.kind === "string") return { kind: "literal", value: source.slice(value.start + 1, value.end - 1) };
  const text = source.slice(value.start + 1, value.end - 1).trim();
  const literal = LITERAL.exec(text);
  if (literal !== null && !(literal[1] === "`" && text.includes("${"))) return { kind: "literal", value: literal[2] };
  const env = ENV_READ.exec(text);
  if (env !== null) return { kind: "env", variable: env[1] };
  return { kind: "expression", text };
}

/** `requireProjectId`, `requireProjectId={true}`, or `{false}`; null for code setup can't know. */
function readFlag(source, attribute) {
  if (attribute === undefined) return false;
  if (attribute.value === null) return true;
  const text = attribute.value.kind === "expression" ? source.slice(attribute.value.start + 1, attribute.value.end - 1).trim() : null;
  return text === "true" ? true : text === "false" ? false : null;
}

const attributeEnd = (attribute) => attribute.value?.end ?? attribute.nameEnd;

/**
 * What setup writes for each setting, in order: the attribute's source, or
 * null to remove it. A backend that isn't given is left as the code has it.
 */
function wanted(settings) {
  const id = settings.projectId;
  return [
    ["projectId", "literal" in id ? `projectId="${id.literal}"` : `projectId={${id.env.expression}}`, (read) => ("literal" in id ? read?.kind === "literal" && read.value === id.literal : read?.kind === "env" && read.variable === id.env.variable)],
    ["requireProjectId", settings.requireProjectId ? "requireProjectId" : null, null],
    ...(settings.backend === undefined ? [] : [["backend", `backend="${settings.backend}"`, (read) => read?.kind === "literal" && read.value === settings.backend]]),
  ];
}

const attributesText = (settings) =>
  wanted(settings)
    .map(([, text]) => (text === null ? "" : ` ${text}`))
    .join("");

/**
 * Edits one `<Critiqs>` so it says `settings`. Returns the new source and the
 * settings it changed, or a refusal naming the attribute code sets. Spread
 * props (`{...props}`) may set any setting, so one written before them, or
 * one setup would leave out after them, is unknown; a setting setup adds goes
 * after them, where it wins.
 */
function updateElement(source, element, settings) {
  const splices = [];
  const changed = [];
  const additions = [];
  for (const [name, text, same] of wanted(settings)) {
    const attribute = element.attributes.find((candidate) => candidate.name === name);
    const overridable = element.spreadEnd !== null && (attribute === undefined ? text === null : attribute.start < element.spreadEnd);
    const line = lineAt(source, attribute?.start ?? element.start);
    if (name === "requireProjectId") {
      const flag = readFlag(source, attribute);
      if (overridable || flag === null) return { ok: false, name, line };
      if (flag === (text !== null)) continue;
      changed.push(name);
      if (attribute === undefined) additions.push(text);
      else if (text === null) splices.push([source.slice(0, attribute.start).trimEnd().length, attributeEnd(attribute), ""]);
      else splices.push([attribute.start, attributeEnd(attribute), text]);
      continue;
    }
    const read = readAttribute(source, attribute);
    if (read?.kind === "expression" || overridable) return { ok: false, name, line };
    if (same(read)) continue;
    changed.push(name);
    if (attribute === undefined) additions.push(text);
    else splices.push([attribute.start, attributeEnd(attribute), text]);
  }
  if (additions.length > 0) {
    // After the last attribute or spread, on its own line when the attributes are one per line.
    const last = element.attributes.at(-1);
    const at = Math.max(element.nameEnd, element.spreadEnd ?? 0, last === undefined ? 0 : attributeEnd(last));
    const before = last === undefined ? "" : source.slice(0, last.start);
    const indent = /\n([ \t]*)$/.exec(before)?.[1];
    const separator = indent === undefined ? " " : `\n${indent}`;
    splices.push([at, at, additions.map((text) => `${separator}${text}`).join("")]);
  }
  let edited = source;
  for (const [start, end, text] of splices.sort((a, b) => b[0] - a[0])) edited = edited.slice(0, start) + text + edited.slice(end);
  return { ok: true, source: edited, changed };
}

/** The `src/` root component setup adds Critiqs to: `app.tsx` in SolidStart, `App.tsx` otherwise. Matched by exact name. */
function rootComponents(root) {
  const names = isStart(root) ? ["app.tsx", "app.jsx", "app.js"] : ["App.tsx", "App.jsx", "App.js"];
  let entries = [];
  try {
    entries = readdirSync(join(root, "src"));
  } catch {}
  return names.filter((name) => entries.includes(name)).map((name) => join(root, "src", name));
}

/** Adds `tag` as the element's last child, on its own line like its other children; wraps a childless element in a fragment. */
function placeChild(source, element, tag) {
  if (element.close === null) {
    const original = source.slice(element.start, element.end);
    return `${source.slice(0, element.start)}<>${original}${tag}</>${source.slice(element.end)}`;
  }
  const closeAt = element.close.start;
  const lineStart = source.lastIndexOf("\n", closeAt - 1) + 1;
  const closeIndent = source.slice(lineStart, closeAt);
  if (!/^[ \t]*$/.test(closeIndent) || lineStart <= element.openEnd) return source.slice(0, closeAt) + tag + source.slice(closeAt);
  const children = source.slice(element.openEnd, lineStart);
  const childIndent = /\n([ \t]*)\S/.exec(children)?.[1] ?? `${closeIndent}${closeIndent.includes("\t") ? "\t" : "  "}`;
  return `${source.slice(0, lineStart)}${childIndent}${tag}\n${source.slice(lineStart)}`;
}

/**
 * Where the file's directive prologue ends (`"use client";`), or null when it
 * has none. A string followed by more of an expression (`"use
 * strict".toString()`) is a statement of its own, not a directive.
 */
function directivesEnd(file) {
  const { code, literals } = file;
  let end = null;
  let i = nextIndex(code, 0);
  for (;;) {
    const literal = literals.find(([start]) => start === i);
    if (literal === undefined || !/["']/.test(code[i])) return end;
    let j = literal[1];
    while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
    if (code[j] === ";") {
      end = j + 1;
    } else {
      const k = nextIndex(code, j);
      if ((code[j] !== "\n" && j < code.length) || CONTINUES.test(code.slice(k, k + 10))) return end;
      end = literal[1];
    }
    i = nextIndex(code, end);
  }
}

/**
 * Adds the import from `entry` at a statement boundary: before the file's
 * last import, in its quote and semicolon style, so a stylesheet import stays
 * last; with no imports, after the directive prologue, or else before the
 * first statement, below any leading comments.
 */
function placeImport(source, entry) {
  const file = readFile(source);
  const last = file.imports.filter((declaration) => declaration.kind === "import").at(-1);
  if (last !== undefined) {
    const semicolon = file.code.slice(last.start, last.end).trimEnd().endsWith(";") ? ";" : "";
    const statement = `import { Critiqs } from ${last.quote}${entry}${last.quote}`;
    const lineStart = source.lastIndexOf("\n", last.start - 1) + 1;
    if (file.code.slice(lineStart, last.start).trim() === "") return `${source.slice(0, lineStart)}${statement}${semicolon}\n${source.slice(lineStart)}`;
    // Another statement shares the line, so this one ends with a semicolon of its own.
    return `${source.slice(0, last.start)}${statement}; ${source.slice(last.start)}`;
  }
  const directives = directivesEnd(file);
  let at;
  if (directives === null) {
    const first = nextIndex(file.code, 0);
    at = source.lastIndexOf("\n", first - 1) + 1;
  } else {
    const lineEnd = file.code.indexOf("\n", directives);
    at = lineEnd !== -1 && file.code.slice(directives, lineEnd).trim() === "" ? lineEnd + 1 : directives;
  }
  const lead = source.slice(0, at);
  const rest = source.slice(at);
  const separator = lead === "" || lead.endsWith("\n") ? "" : "\n";
  return `${lead}${separator}import { Critiqs } from "${entry}";\n${rest.startsWith("\n") || rest === "" ? "" : "\n"}${rest}`;
}

/** Whether the file now has exactly one `<Critiqs>` that reads back as `settings`. */
function readsBack(file, source, settings) {
  const elements = elementsIn(file, source);
  if (elements.length !== 1) return false;
  const again = updateElement(source, elements[0], settings);
  return again.ok && again.changed.length === 0;
}

function refuse(reason, why, settings) {
  return { ok: false, reason, message: `${why}\n\n${solid.manual(settings)}` };
}

/** Whether `file`, or a folder between it and `root`, is a symbolic link. */
function linked(root, file) {
  try {
    return realpathSync(file) !== join(realpathSync(root), relative(root, file));
  } catch {
    return false;
  }
}

/**
 * The file named by --entry, or the app's one root component; a refusal when
 * there isn't one. Setup looks for an existing Critiqs only in the app's own
 * files, not through symbolic links, so a file it reaches through one is
 * refused: setup wouldn't find the Critiqs it added there to update it.
 */
function chosenFile(root, entry, settings) {
  let file;
  if (entry !== null) {
    file = resolve(root, entry);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {}
    if (!isFile) return refuse("manual", `${entry} isn't a file in this app.`, settings);
  } else {
    const candidates = rootComponents(root);
    if (candidates.length > 1) return refuse("ambiguous", `This app has several root components (${candidates.map((path) => shown(root, path)).join(", ")}), so setup can't tell which one renders every page. Choose one with --entry, or add Critiqs by hand.`, settings);
    if (candidates.length === 0) return refuse("manual", `Setup didn't find the app's root component (${isStart(root) ? "src/app.tsx" : "src/App.tsx"}). Name the file every page renders with --entry, or add Critiqs by hand.`, settings);
    file = candidates[0];
  }
  if (linked(root, file)) {
    return refuse("manual", `${shown(root, file)} is reached through a symbolic link, and setup doesn't follow links when it looks for Critiqs, so it couldn't find Critiqs there again to update it. Name the file the link points to with --entry if it is inside this app, or add Critiqs by hand.`, settings);
  }
  return file;
}

function planInstall(root, settings, entry) {
  for (const path of findSourceFiles(root)) {
    const source = readText(path);
    if (source === null || !source.includes(PACKAGE)) continue;
    if (usesCritiqsOtherwise(readFile(source, JSX_EXTENSIONS.has(extname(path))))) {
      return refuse("manual", `${shown(root, path)} uses critiqs-solid in a way setup can't follow (renamed, as a namespace, re-exported, or loaded at run time), so setup leaves the code to you.`, settings);
    }
  }
  const path = chosenFile(root, entry, settings);
  if (typeof path !== "string") return path;
  const where = shown(root, path);
  const original = readText(path);
  if (original === null) return refuse("unreadable", `Setup couldn't read ${where}.`, settings);
  if (!JSX_EXTENSIONS.has(extname(path))) return refuse("manual", `${where} isn't a JSX file (.tsx, .jsx, or .js), so setup can't add a component to it.`, settings);
  const file = readFile(original);
  if (!file.balanced) return refuse("unreadable", `Setup couldn't match the brackets in ${where}, so it can't tell where the component renders.`, settings);
  const imported = importsCritiqs(file);
  if (!imported && new RegExp(`(?<![\\p{ID_Continue}$.])Critiqs(?![\\p{ID_Continue}$])`, "u").test(file.code)) {
    return refuse("manual", `${where} already uses the name Critiqs for something else, so setup can't import the component under that name.`, settings);
  }
  const component = exportedComponent(file);
  if (typeof component === "string") return refuse("manual", `Setup can't tell which component ${where} renders: ${component}.`, settings);
  const target = container(file, component, path);
  if (typeof target === "string") return refuse("manual", `Setup can't tell where ${where} renders every page: ${target}.`, settings);
  if (within(target.start, localBindings(file, "Critiqs"))) {
    return refuse("manual", `In ${where}, the name Critiqs at line ${lineAt(original, target.start)} means the component's own parameter or variable, not critiqs-solid's, so setup can't add it there.`, settings);
  }
  const placed = placeChild(original, target, `<Critiqs${attributesText(settings)} />`);
  const source = imported ? placed : placeImport(placed, entryFor(root));
  if (!readsBack(path, source, settings)) return refuse("unreadable", `Setup couldn't add Critiqs to ${where} in a way it could read back.`, settings);
  const [added] = elementsIn(path, source);
  return {
    ok: true,
    action: "install",
    writes: [{ file: path, original, source }],
    file: path,
    line: added.line,
    changed: wanted(settings)
      .filter(([, text]) => text !== null)
      .map(([name]) => name),
    preview: [...changedLines(original, placed), ...(imported ? [] : changedLines(placed, source))].join("\n"),
    next: [],
  };
}

function readsVariable(root) {
  try {
    return solid.find(root).some((usage) => usage.projectId?.kind === "env");
  } catch {
    return false;
  }
}

/**
 * Why setup can't tell where this app's Vite reads the project ID, or null.
 * `envDir` moves the `.env` files Vite loads, unless the person named the
 * file with --project-env-file; `envPrefix` changes which names reach the
 * browser, unless the app's Critiqs already reads a variable it chose.
 * SolidStart 1 gives Vite its settings in app.config.
 */
function viteEnvProblem(root, envFile) {
  for (const config of [configFile(root, "vite"), configFile(root, "app")]) {
    if (config === null) continue;
    const where = shown(root, config);
    const text = readText(config);
    if (text === null) return `Setup couldn't read ${where}, so it can't tell which .env file Vite loads, and nothing was changed. Restore access to it, then run setup again.`;
    if (envFile === null && /\benvDir\b/.test(text)) {
      return `${where} sets envDir, so setup can't tell which .env file Vite loads, and nothing was changed. Run setup again with --project-env-file <the .env.local file Vite loads, relative to the app>.`;
    }
    if (/\benvPrefix\b/.test(text) && !readsVariable(root)) {
      return `${where} sets envPrefix, so setup can't tell which variable names reach the browser, and nothing was changed. Give <Critiqs /> projectId={import.meta.env.<a name with your prefix>} requireProjectId, then run setup again to set it.`;
    }
  }
  return null;
}

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const solid = {
  id: "solid",
  name: "Solid",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "solid-js"),
  env(root, suffix, { envFile = null } = {}) {
    if (!VITE_PACKAGES.some((name) => dependsOn(root, name))) return null;
    const variable = `VITE_CRITIQS_PROJECT_ID${suffix}`;
    return {
      variable,
      expression: `import.meta.env.${variable}`,
      readsAt: "build",
      localFile: ".env.local",
      loads: ENV_FILES,
      deploymentAdvice: `Each deployment that should show Critiqs sets ${variable} in its build environment. Vite writes the value into the app when it builds, so a change takes effect on the next build.`,
      problem: viteEnvProblem(root, envFile),
    };
  },
  find(root) {
    return findElements(root).map(({ file, source, element }) => {
      // Spread props may set a property unless it comes after them, so its value is then unknown.
      const read = (name) => {
        const attribute = element.attributes.find((candidate) => candidate.name === name);
        if (element.spreadEnd !== null && (attribute === undefined || attribute.start < element.spreadEnd)) return { kind: "expression", text: "" };
        return readAttribute(source, attribute);
      };
      return {
        file,
        line: element.line,
        projectId: read("projectId"),
        backend: read("backend"),
        requireProjectId: readFlag(source, element.attributes.find((candidate) => candidate.name === "requireProjectId")) === true,
      };
    });
  },
  plan(root, settings, options) {
    const found = findElements(root);
    if (found.length > 1) {
      const places = found.map(({ file, element }) => `${shown(root, file)}:${element.line}`).join(", ");
      return refuse("ambiguous", `This app renders Critiqs in ${found.length} places (${places}). Keep the one in the component every page renders, remove the others, and run setup again.`, settings);
    }
    if (found.length === 0) return planInstall(root, settings, options.entry);
    const [{ file, source: original, element }] = found;
    if (options.entry !== null && resolve(root, options.entry) !== file) {
      return refuse(
        "ambiguous",
        `Critiqs is already in ${shown(root, file)}:${element.line}, not in ${options.entry}, which --entry names. Move it to ${options.entry} by hand, or run setup without --entry to update the one in ${shown(root, file)}.`,
        settings,
      );
    }
    const result = updateElement(original, element, settings);
    if (!result.ok) {
      return refuse("expression", `In ${shown(root, file)} at line ${result.line}, code sets Critiqs's ${result.name}, so setup leaves it as it is. Change it by hand to match the settings below.`, settings);
    }
    if (result.changed.length > 0 && !readsBack(file, result.source, settings)) {
      return refuse("unreadable", `Setup couldn't update Critiqs in ${shown(root, file)} in a way it could read back.`, settings);
    }
    return {
      ok: true,
      action: result.changed.length === 0 ? "unchanged" : "update",
      writes: result.changed.length === 0 ? [] : [{ file, original, source: result.source }],
      file,
      line: element.line,
      changed: result.changed,
      preview: changedLines(original, result.source).join("\n"),
      next: [],
    };
  },
  manual(settings) {
    const env = "env" in settings.projectId ? settings.projectId.env : null;
    return [
      "To add Critiqs to this Solid app by hand:",
      "",
      `1. Install it: npm install ${PACKAGE}`,
      "2. Open the component every page renders: src/App.tsx in a Vite app (npm create solid), src/app.tsx in SolidStart.",
      `3. Import it with the other imports: import { Critiqs } from "${PACKAGE}"; in an app with Solid Router, import it from "${ROUTER_ENTRY}" instead, so threads name routes such as users/:id and opening one navigates there.`,
      "4. Render it once, inside the element that component returns. When it renders a <Router>, put it inside the layout the router renders (SolidStart: the element in <Router root={props => (…)}>), not among the routes:",
      "",
      `     <Critiqs${attributesText(settings)} />`,
      ...(env === null
        ? []
        : ["", `5. Set ${env.variable} to the project ID from project setup in the Critiqs sidebar, in ${env.localFile} for this computer. ${env.deploymentAdvice}`]),
    ].join("\n");
  },
};
