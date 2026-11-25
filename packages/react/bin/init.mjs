/**
 * `critiqs init`: writes a project ID into the prototype's single `<Critiqs />`
 * component. Dependency-free so it runs under Node and Bun without a build.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { applyEnv, describeApp, envVariableOf, planEnv, workspaceMembers, workspacePatterns } from "./env.mjs";

/** Convex document IDs (lowercase letters and digits, about 32 characters), or a self-hosted server's (`p_` and 32 hex digits). */
export const PROJECT_ID_PATTERN = /^([a-z0-9]{16,64}|p_[0-9a-f]{32})$/;

export const SOURCE_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".mts", ".mjs"]);
export const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage"]);

/** Extensions where `<` can start JSX; in .ts and .mts it is a type assertion or generic. */
const JSX_EXTENSIONS = new Set([".tsx", ".jsx", ".js"]);

export const HELP = `Usage: critiqs init <projectId> [--dir <path>] [--entry <file>] [--mount <Element>] [--project-env-file <file>] [--dry-run]

Connects the prototype's <Critiqs /> component to a project. Without one, adds
it where the app renders: a React root (createRoot(…).render), a Next.js root
layout, or a Next.js custom App. In Vite and Next.js apps the component reads
the project ID from the app's environment variable, and init sets it in
.env.local; otherwise init writes the ID into the component. Copy the project
ID from project setup in the Critiqs sidebar.

Options:
  --dir <path>        The app's folder (default: current folder)
  --entry <file>      The file where the app renders, relative to --dir
  --mount <Element>   The element to add <Critiqs /> beside, such as App
  --project-env-file <file>   The .env file to set the project ID in, relative to --dir (default: .env.local)
  --dry-run           Show the change without writing it
  -h, --help          Show this help`;

export function isValidProjectId(id) {
  return PROJECT_ID_PATTERN.test(id);
}

/** Source files under `root`, skipping dependencies, build output, dot-directories, and symlinks. */
export function findSourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.d\.m?ts$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$‌‍]/u;
const WHITESPACE = /\s/;
/** Previous tokens after which `/` starts a regex and `<` may start JSX. */
const EXPRESSION_PUNCTUATION = new Set([..."(,=:[!&|?{};+-*%<>~^}"]);
const EXPRESSION_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await", "default", "extends",
]);

/**
 * Finds JSX elements and comments in a source file. A small lexer skips strings,
 * templates, regexes, and comments; JSX is parsed recursively and abandoned when it
 * does not close, so a `<` that was a comparison or TypeScript generic is re-read as code.
 *
 * Returns `elements` named `tagName` (in source order) with their attributes, and
 * `comments` and string/template `literals` as [start, end) ranges.
 */
export function scanSource(source, { jsx = true, tagName = "Critiqs" } = {}) {
  const s = source;
  const n = s.length;
  const elements = [];
  /** Every JSX element, with where its children close, for placing a new element. */
  const all = [];
  const comments = [];
  const literals = [];
  /** How many elements enclose the one being parsed. */
  let depth = 0;

  const skipComment = (i) => {
    if (s[i] !== "/") return -1;
    let end;
    if (s[i + 1] === "/") {
      end = s.indexOf("\n", i);
      if (end === -1) end = n;
    } else if (s[i + 1] === "*") {
      end = s.indexOf("*/", i + 2);
      end = end === -1 ? n : end + 2;
    } else {
      return -1;
    }
    comments.push([i, end]);
    return end;
  };

  const skipTrivia = (i) => {
    for (;;) {
      while (i < n && WHITESPACE.test(s[i])) i++;
      const end = skipComment(i);
      if (end === -1) return i;
      i = end;
    }
  };

  const skipString = (i) => {
    const quote = s[i];
    for (i++; i < n && s[i] !== quote && s[i] !== "\n"; i++) {
      if (s[i] === "\\") i++;
    }
    return Math.min(i + 1, n);
  };

  const skipTemplate = (i) => {
    for (i++; i < n; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === "`") return i + 1;
      else if (s[i] === "$" && s[i + 1] === "{") {
        const end = skipCode(i + 2, true);
        if (end === -1) return -1;
        i = end;
      }
    }
    return -1;
  };

  const skipRegex = (i) => {
    let inClass = false;
    for (let j = i + 1; j < n; j++) {
      const c = s[j];
      if (c === "\n") return -1;
      if (c === "\\") j++;
      else if (inClass) inClass = c !== "]";
      else if (c === "[") inClass = true;
      else if (c === "/") {
        for (j++; j < n && ID_PART.test(s[j]); j++);
        return j;
      }
    }
    return -1;
  };

  /** Skips code up to the closing `}` (returning its index) or the end of the file. -1 if a brace never closes. */
  const skipCode = (i, inBraces) => {
    const fail = inBraces ? -1 : n;
    let prev = "";
    while (i < n) {
      const c = s[i];
      if (WHITESPACE.test(c)) {
        i++;
        continue;
      }
      const commentEnd = skipComment(i);
      if (commentEnd !== -1) {
        i = commentEnd;
        continue;
      }
      const expressionStart = prev === "" || prev === "keyword" || EXPRESSION_PUNCTUATION.has(prev);
      if (c === "}") {
        if (inBraces) return i;
        prev = c;
        i++;
      } else if (c === "{") {
        const end = skipCode(i + 1, true);
        if (end === -1) return fail;
        prev = "}";
        i = end + 1;
      } else if (c === '"' || c === "'") {
        prev = "value";
        const end = skipString(i);
        literals.push([i, end]);
        i = end;
      } else if (c === "`") {
        const end = skipTemplate(i);
        if (end === -1) return fail;
        literals.push([i, end]);
        prev = "value";
        i = end;
      } else if (c === "/" && expressionStart && skipRegex(i) !== -1) {
        prev = "value";
        i = skipRegex(i);
      } else if (c === "<" && jsx && expressionStart && (ID_START.test(s[i + 1] ?? "") || s[i + 1] === ">")) {
        const end = parseElement(i);
        prev = end === -1 ? c : "value";
        i = end === -1 ? i + 1 : end;
      } else if (ID_PART.test(c)) {
        let j = i + 1;
        while (j < n && ID_PART.test(s[j])) j++;
        prev = EXPRESSION_KEYWORDS.has(s.slice(i, j)) ? "keyword" : "word";
        i = j;
      } else {
        prev = c;
        i++;
      }
    }
    return fail;
  };

  /** Element, attribute, or closing-tag name: identifiers joined by `.`, `:`, or `-`. */
  const readName = (i) => {
    if (i >= n || !ID_START.test(s[i])) return i;
    let j = i + 1;
    while (j < n && (ID_PART.test(s[j]) || s[j] === "-" || s[j] === "." || s[j] === ":")) j++;
    return j;
  };

  /** Parses a JSX element starting at `<`; returns the index after it, or -1 (discarding anything found inside). */
  const parseElement = (start) => {
    const elementMark = elements.length;
    const allMark = all.length;
    const commentMark = comments.length;
    const literalMark = literals.length;
    depth++;
    const end = parseElementBody(start);
    depth--;
    if (end === -1) {
      elements.length = elementMark;
      all.length = allMark;
      comments.length = commentMark;
      literals.length = literalMark;
    }
    return end;
  };

  const parseElementBody = (start) => {
    let i = skipTrivia(start + 1);
    const nameStart = i;
    const nameEnd = readName(i);
    const name = s.slice(nameStart, nameEnd);
    if (name === "" && s[i] !== ">") return -1;
    i = nameEnd;

    const attributes = [];
    let spreadEnd = null;
    let selfClosing = false;
    for (;;) {
      i = skipTrivia(i);
      if (i >= n) return -1;
      if (s[i] === "/") {
        if (s[i + 1] !== ">") return -1;
        selfClosing = true;
        i += 2;
        break;
      }
      if (s[i] === ">") {
        i++;
        break;
      }
      if (s[i] === "{") {
        const end = skipCode(i + 1, true);
        if (end === -1) return -1;
        i = end + 1;
        spreadEnd = i;
        continue;
      }
      const attributeEnd = readName(i);
      if (attributeEnd === i) return -1;
      const attribute = { name: s.slice(i, attributeEnd), start: i, nameEnd: attributeEnd, value: null };
      i = skipTrivia(attributeEnd);
      if (s[i] === "=") {
        i = skipTrivia(i + 1);
        const valueStart = i;
        if (s[i] === '"' || s[i] === "'") {
          const close = s.indexOf(s[i], i + 1);
          if (close === -1) return -1;
          i = close + 1;
          literals.push([valueStart, i]);
          attribute.value = { kind: "string", start: valueStart, end: i };
        } else if (s[i] === "{") {
          const end = skipCode(i + 1, true);
          if (end === -1) return -1;
          i = end + 1;
          attribute.value = { kind: "expression", start: valueStart, end: i };
        } else if (s[i] === "<") {
          const end = parseElement(i);
          if (end === -1) return -1;
          i = end;
          attribute.value = { kind: "element", start: valueStart, end: i };
        } else {
          return -1;
        }
      }
      attributes.push(attribute);
    }

    if (name === tagName && nameStart === start + 1) {
      elements.push({ start, nameEnd, end: i, line: lineAt(s, start), attributes, spreadEnd });
    }
    // Filled in once the closing tag is found; `close` stays null for `<X />`.
    const record = { name, start, openEnd: i, end: i, depth: depth - 1, close: null };
    all.push(record);
    if (selfClosing) return i;

    // Children: raw text, `{expressions}`, nested elements, then the matching closing tag.
    for (;;) {
      const textStart = i;
      while (i < n && s[i] !== "<" && s[i] !== "{") i++;
      if (i >= n) return -1;
      // JSX text is content, not code, so an import written in it does not count.
      if (i > textStart) literals.push([textStart, i]);
      if (s[i] === "{") {
        const end = skipCode(i + 1, true);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      const afterOpen = skipTrivia(i + 1);
      if (s[afterOpen] === "/") {
        const closeStart = skipTrivia(afterOpen + 1);
        const closeEnd = readName(closeStart);
        if (s.slice(closeStart, closeEnd) !== name) return -1;
        const gt = skipTrivia(closeEnd);
        if (s[gt] !== ">") return -1;
        record.close = { start: i, end: gt + 1 };
        record.end = gt + 1;
        return gt + 1;
      }
      const end = parseElement(i);
      if (end === -1) return -1;
      i = end;
    }
  };

  skipCode(0, false);
  return { elements, all, comments, literals };
}

/** 1-based line number of a character index. */
export function lineAt(source, index) {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < index; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

const IMPORT_PATTERN =
  /\bimport\s+(?:[\p{ID_Start}$_][\p{ID_Continue}$]*\s*,\s*)?\{([^}]*)\}\s*from\s*(["'])critiqs-react\2/gu;

/**
 * Whether the source imports `Critiqs` by name from "critiqs-react": an import
 * declaration starting its own line, outside comments and strings.
 */
export function importsCritiqs(source, excluded) {
  if (excluded === undefined) {
    const { comments, literals } = scanSource(source, { jsx: false });
    excluded = [...comments, ...literals];
  }
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const index = match.index ?? 0;
    if (excluded.some(([start, end]) => index >= start && index < end)) continue;
    if (!/(^|\n)[ \t\uFEFF]*$/.test(source.slice(Math.max(0, source.lastIndexOf("\n", index - 1)), index))) continue;
    const names = (match[1] ?? "").split(",").map((specifier) => specifier.trim());
    if (names.some((name) => name === "Critiqs" || /^Critiqs\s+as\s+Critiqs$/.test(name))) return true;
  }
  return false;
}

/** `<Critiqs>` elements in a file that imports Critiqs; empty otherwise. */
export function findCritiqsElements(source, { jsx = true } = {}) {
  const { elements, comments, literals } = scanSource(source, { jsx });
  return importsCritiqs(source, [...comments, ...literals]) ? elements : [];
}

const LITERAL_EXPRESSION = /^(\s*)(["'`])([^"'`\\\r\n]*)\2\s*$/;

/** The [start, end) range of a string literal's contents in a `projectId` value, or null for code. */
function literalRange(source, value) {
  if (value.kind === "string") return [value.start + 1, value.end - 1];
  if (value.kind !== "expression") return null;
  const match = LITERAL_EXPRESSION.exec(source.slice(value.start + 1, value.end - 1));
  if (match === null) return null;
  const [, space = "", quote, text = ""] = match;
  if (quote === "`" && text.includes("${")) return null;
  const start = value.start + 1 + space.length + 1;
  return [start, start + text.length];
}

/**
 * A property's value as init writes it: a string literal, `{ expression }` for
 * code such as `import.meta.env.VITE_CRITIQS_PROJECT_ID`, or `true` for a bare
 * attribute such as `requireProjectId`.
 */
function propText(name, value) {
  if (value === true) return ` ${name}`;
  if (typeof value === "object" && value !== null) return ` ${name}={${value.expression}}`;
  return ` ${name}="${value}"`;
}

/** The code inside an attribute's `{…}`, trimmed. */
const expressionText = (source, value) => source.slice(value.start + 1, value.end - 1).trim();

/**
 * How to set a property, such as `projectId`, on one element:
 * - insert: no such attribute; adds one right after the tag name.
 * - replace: a string literal value; replaces only its contents.
 * - unchanged: already this value. A bare attribute (`true`) that is present
 *   in any form is left as the author wrote it.
 * - expression: the value comes from other code, which init does not edit.
 * - spread: the property comes before spread props that could override it, so init does not edit.
 * With spread props and no such property, it is inserted after the last spread, where it wins.
 * `source` is the edited file for insert and replace; `line` is where the change is.
 */
export function planProp(source, element, name, value) {
  const attribute = element.attributes.find((candidate) => candidate.name === name);
  if (attribute !== undefined && element.spreadEnd !== null && attribute.start < element.spreadEnd) {
    return { action: "spread", line: lineAt(source, attribute.start) };
  }
  const splice = (index, removeEnd, text) => ({
    source: source.slice(0, index) + text + source.slice(removeEnd),
    line: lineAt(source, index),
  });
  if (attribute === undefined) {
    const at = element.spreadEnd ?? element.nameEnd;
    return { action: "insert", ...splice(at, at, propText(name, value)) };
  }
  const line = lineAt(source, attribute.start);
  if (value === true) return { action: "unchanged", line };
  if (typeof value === "object" && value !== null) {
    const same = attribute.value?.kind === "expression" && expressionText(source, attribute.value) === value.expression;
    return { action: same ? "unchanged" : "expression", line };
  }
  if (attribute.value === null) {
    return { action: "replace", ...splice(attribute.nameEnd, attribute.nameEnd, `="${value}"`) };
  }
  const range = literalRange(source, attribute.value);
  if (range === null) return { action: "expression", line };
  if (source.slice(range[0], range[1]) === value) return { action: "unchanged", line };
  return { action: "replace", ...splice(range[0], range[1], value) };
}

/** Whether an element has a property with this value, in the sense of `planProp`'s "unchanged". */
function hasProp(source, element, name, value) {
  const attribute = element.attributes.find((candidate) => candidate.name === name);
  if (attribute === undefined) return false;
  if (value === true) return true;
  if (typeof value === "object" && value !== null) return attribute.value?.kind === "expression" && expressionText(source, attribute.value) === value.expression;
  return readProp(source, element, name)?.value === value;
}

/** How to set `projectId` on one element; see `planProp`. */
export function planProjectId(source, element, projectId) {
  return planProp(source, element, "projectId", projectId);
}

/**
 * A string property's value on one element: a literal's text, `expression`
 * (with its code as `text`) when code sets it, or null when it is absent.
 */
export function readProp(source, element, name) {
  const attribute = element.attributes.find((candidate) => candidate.name === name);
  if (attribute === undefined) return null;
  if (attribute.value === null) return { kind: "literal", value: "" };
  const range = literalRange(source, attribute.value);
  if (range !== null) return { kind: "literal", value: source.slice(range[0], range[1]) };
  return attribute.value.kind === "expression" ? { kind: "expression", text: expressionText(source, attribute.value) } : { kind: "expression" };
}

/** Every `<Critiqs>` element under `root`, with its file and source. */
export function findCritiqsUsages(root) {
  const usages = [];
  for (const file of findSourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("critiqs-react")) continue;
    const jsx = JSX_EXTENSIONS.has(extname(file));
    for (const element of findCritiqsElements(source, { jsx })) usages.push({ file, source, element });
  }
  return usages;
}


// ---------------------------------------------------------------------------
// Adding <Critiqs /> where the app renders

/** A Next.js App Router root layout: Critiqs goes inside `<body>`. */
const NEXT_APP_LAYOUT = /^(src\/)?app\/layout\.(tsx|jsx|js)$/;
/** A Next.js Pages Router custom App: Critiqs goes beside `<Component {...pageProps} />`. */
const NEXT_PAGES_APP = /^(src\/)?pages\/_app\.(tsx|jsx|js)$/;
/** Tests, stories, and fixtures render React too, but they aren't the app. */
const NOT_APP_CODE = /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures|tests?|e2e|cypress|playwright|stories|\.storybook)\/|\.(test|spec|stories|story)\.[a-z]+$/;
const REACT_DOM_IMPORT = /(?:\bfrom\s*|\brequire\s*\(\s*)(["'])react-dom(?:\/client)?\1/g;
/** Code right before the element React's root renders: `root.render(`, `ReactDOM.render(`, `hydrate(`. */
const RENDER_CALL = /(?:^|[^\w$])(?:render|hydrate)\s*\(\s*$/;
/** `hydrateRoot(container, ` right before the element. */
const HYDRATE_ROOT_CALL = /\bhydrateRoot\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*,\s*$/;
/** Ways of using Critiqs that init can't follow: under another name, as a namespace, re-exported, or loaded at run time. */
const OTHER_CRITIQS_USE = [
  /\bCritiqs\s+as\s+(?!Critiqs\b)[\p{ID_Start}$_]/gu,
  /\*\s*as\s+[\p{ID_Start}$_][\p{ID_Continue}$]*\s+from\s*(["'])critiqs-react\1/gu,
  /\bexport\s*\{[^}]*\bCritiqs\b[^}]*\}\s*from\s*(["'])critiqs-react\1/g,
  /\b(?:require|import)\s*\(\s*(["'])critiqs-react\1\s*\)/g,
];
const IMPORT_DECLARATION = /^[ \t]*import\b(?!\s*[(.])[^"'`;]*?(["'])[^"'\n]*\1[ \t]*;?/gm;
const LEADING = /^﻿?(?:#![^\n]*\n)?(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|(["'])use [\w ]+\1;?))*[ \t]*\n?/;

/** Where each kind of place is described to people. */
export const MOUNT_KINDS = {
  "next-app": "Next.js root layout",
  "next-pages": "Next.js custom App",
  "react-root": "React root",
  chosen: "chosen element",
};

const posix = (path) => path.split(sep).join("/");
const outside = (index, ranges) => !ranges.some(([start, end]) => index >= start && index < end);
const matchesOutside = (source, pattern, ranges) => [...source.matchAll(pattern)].some((match) => outside(match.index ?? 0, ranges));

/**
 * Elements in one file that `<Critiqs />` can go beside, by what the file is:
 * a Next.js root layout's `<body>`, a Next.js custom App's `<Component>`, or
 * the element a React root renders (`createRoot(…).render(<App />)`,
 * `ReactDOM.render`, `hydrateRoot`). `mount` names the element instead.
 * `path` is relative to the app's folder, with `/`.
 */
export function mountPointsIn(source, path, { mount = null, explicit = false } = {}) {
  if (!JSX_EXTENSIONS.has(extname(path))) return [];
  const { all, comments, literals } = scanSource(source);
  const point = (kind) => (element) => ({ kind, element, line: lineAt(source, element.start) });
  if (mount !== null) return all.filter((element) => element.name === mount).map(point("chosen"));
  if (NEXT_APP_LAYOUT.test(path)) return all.filter((element) => element.name === "body" && element.close !== null).map(point("next-app"));
  if (NEXT_PAGES_APP.test(path)) return all.filter((element) => element.name === "Component").map(point("next-pages"));
  if (!explicit && NOT_APP_CODE.test(path)) return [];
  if (!matchesOutside(source, REACT_DOM_IMPORT, [...comments, ...literals])) return [];
  return all
    .filter((element) => {
      if (element.depth !== 0) return false;
      const before = source.slice(Math.max(0, element.start - 400), element.start);
      return RENDER_CALL.test(before) || HYDRATE_ROOT_CALL.test(before);
    })
    .map(point("react-root"));
}

/** Places under `root` where `<Critiqs />` can go; `entry` limits the search to one file. */
export function findMountPoints(root, { entry = null, mount = null } = {}) {
  const files = entry === null ? findSourceFiles(root) : [resolve(root, entry)];
  const points = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const point of mountPointsIn(source, posix(relative(root, file)), { mount, explicit: entry !== null })) {
      points.push({ file, source, ...point });
    }
  }
  return points;
}

/** ` name="value"` (or `name={code}`, or a bare `name`) for each property, in order. */
export function propsText(props) {
  return Object.entries(props)
    .map(([name, value]) => propText(name, value))
    .join("");
}

/** Add a sibling unless the chosen mount is a known container (the root body or a fragment). */
function placeElement(source, element, tag, container = false) {
  if (element.close === null || (!container && element.name !== "")) {
    const end = element.close?.end ?? element.end;
    const original = source.slice(element.start, end);
    return { source: `${source.slice(0, element.start)}<>${original}${tag}</>${source.slice(end)}`, at: element.start };
  }
  const closeAt = element.close.start;
  const lineStart = source.lastIndexOf("\n", closeAt - 1) + 1;
  const closeIndent = source.slice(lineStart, closeAt);
  if (!/^[ \t]*$/.test(closeIndent)) return { source: source.slice(0, closeAt) + tag + source.slice(closeAt), at: closeAt };
  // On its own line, indented like the other children.
  const children = source.slice(element.openEnd, lineStart);
  const childIndent = /\n([ \t]*)\S/.exec(children)?.[1] ?? `${closeIndent}${closeIndent.includes("\t") ? "\t" : "  "}`;
  return { source: `${source.slice(0, lineStart)}${childIndent}${tag}\n${source.slice(lineStart)}`, at: lineStart };
}

/** Insert before an existing import, leaving its attributes and complete declaration intact. */
function placeImport(source) {
  const { comments, literals } = scanSource(source);
  const excluded = [...comments, ...literals];
  let last = null;
  for (const match of source.matchAll(IMPORT_DECLARATION)) {
    if (outside(match.index ?? 0, excluded)) last = match;
  }
  if (last !== null) {
    const start = last.index ?? 0;
    const semicolon = last[0].trimEnd().endsWith(";") ? ";" : "";
    return source.slice(0, start) + `import { Critiqs } from ${last[1]}critiqs-react${last[1]}${semicolon}\n` + source.slice(start);
  }
  const end = LEADING.exec(source)?.[0].length ?? 0;
  const lead = source.slice(0, end);
  const rest = source.slice(end);
  const separator = lead === "" || lead.endsWith("\n") ? "" : "\n";
  return `${lead}${separator}import { Critiqs } from "critiqs-react";\n${rest.startsWith("\n") ? "" : "\n"}${rest}`;
}

/** The lines that differ between two versions of a file, with `-` and `+`, for a preview. */
export function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [
    ...a.slice(start, a.length - end).map((line) => `- ${line}`),
    ...b.slice(start, b.length - end).map((line) => `+ ${line}`),
  ];
}

/**
 * Plans adding `<Critiqs />` with `props` to the one place under `root` where
 * the app renders, importing it from "critiqs-react". Writes nothing.
 * Refuses, with a reason, when Critiqs is used in a way init can't follow,
 * when there is no recognizable place or several, or when `Critiqs` already
 * names something else in that file.
 */
export function planInstall(root, props, { entry = null, mount = null } = {}) {
  for (const file of findSourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("critiqs-react")) continue;
    const { comments, literals } = scanSource(source, { jsx: JSX_EXTENSIONS.has(extname(file)) });
    if (OTHER_CRITIQS_USE.some((pattern) => matchesOutside(source, pattern, [...comments, ...literals]))) {
      return { ok: false, reason: "other-use", file };
    }
  }
  if (entry !== null) {
    let isFile = false;
    try {
      isFile = statSync(resolve(root, entry)).isFile();
    } catch {}
    if (!isFile) return { ok: false, reason: "no-entry", entry };
  }
  const points = findMountPoints(root, { entry, mount });
  if (points.length === 0) return { ok: false, reason: "no-root", entry, mount };
  if (points.length > 1) return { ok: false, reason: "several-roots", points };
  const [point] = points;
  const { comments, literals } = scanSource(point.source);
  const imported = importsCritiqs(point.source, [...comments, ...literals]);
  if (!imported && matchesOutside(point.source, /(?<![\p{ID_Continue}$.])Critiqs(?![\p{ID_Continue}$])/gu, [...comments, ...literals])) {
    return { ok: false, reason: "name-taken", file: point.file, line: point.line };
  }
  const placed = placeElement(point.source, point.element, `<Critiqs${propsText(props)} />`, point.kind === "next-app");
  const source = imported ? placed.source : placeImport(placed.source);
  // The result must read back as exactly one Critiqs, with these settings.
  const [added, ...extra] = findCritiqsElements(source);
  if (added === undefined || extra.length > 0 || Object.entries(props).some(([name, value]) => !hasProp(source, added, name, value))) {
    return { ok: false, reason: "unreadable", file: point.file, line: point.line };
  }
  // One preview per edit, so a reader sees exactly what each adds.
  const preview = [...changedLines(point.source, placed.source), ...(imported ? [] : changedLines(placed.source, source))];
  return { ok: true, file: point.file, original: point.source, source, kind: point.kind, line: added.line, imported: !imported, preview };
}

/**
 * Plans setting string properties, such as `projectId` and `backend`, on the
 * prototype's one `<Critiqs />`; with none, plans adding it where the app
 * renders (`planInstall`). Writes nothing; `applyPlan` writes the one file.
 * Every property is set, or the plan refuses with a reason.
 */
export function planComponent(root, props, { entry = null, mount = null } = {}) {
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {}
  if (!isDirectory) return { ok: false, reason: "not-folder" };
  const usages = findCritiqsUsages(root);
  if (usages.length > 1) return { ok: false, reason: "several", usages };
  if (usages.length === 0) {
    const install = planInstall(root, props, { entry, mount });
    return install.ok ? { ...install, action: "install", changed: Object.keys(props) } : install;
  }
  const [{ file, element }] = usages;
  let source = usages[0].source;
  let current = element;
  const changed = [];
  // Each new property goes right after the tag name, so add them last first to keep their order.
  for (const [name, value] of Object.entries(props).reverse()) {
    const plan = planProp(source, current, name, value);
    if (plan.action === "expression" || plan.action === "spread") return { ok: false, reason: plan.action, file, line: plan.line, name, value };
    if (plan.action === "unchanged") continue;
    source = plan.source;
    changed.push(name);
    // Later properties are planned against the edited source.
    const next = findCritiqsElements(source, { jsx: JSX_EXTENSIONS.has(extname(file)) });
    if (next.length !== 1) return { ok: false, reason: "unreadable", file, line: element.line };
    current = next[0];
  }
  changed.reverse();
  return {
    ok: true,
    action: changed.length === 0 ? "unchanged" : "update",
    file,
    original: usages[0].source,
    source,
    line: element.line,
    changed,
  };
}

/** Writes a plan's file, if it changes anything. */
export function applyPlan(plan) {
  if (plan.ok && plan.source !== plan.original) writeFileSync(plan.file, plan.source);
}

/** How to add Critiqs by hand, for when init can't. */
export function manualInstructions(props) {
  return [
    `Add it where the app renders, imported with import { Critiqs } from "critiqs-react":`,
    "",
    `  <Critiqs${propsText(props)} />`,
    "",
    "- A single-page app (Vite, Create React App, and others): next to <App /> in the file that calls createRoot(…).render(…).",
    "- Next.js App Router: inside <body> in app/layout.tsx.",
    "- Next.js Pages Router: next to <Component {...pageProps} /> in pages/_app.tsx.",
    "- Anything else: in the component every page renders.",
    "Or name the file for init to edit: --entry <file>, and the element to add it beside: --mount <Element>.",
  ].join("\n");
}

/** Why a plan refused, as complete sentences with what to do. `where` shows a file and line. */
export function refusal(plan, props, where, folder) {
  switch (plan.reason) {
    case "not-folder":
      return `${folder} is not a folder.`;
    case "several":
      return (
        `Found ${plan.usages.length} <Critiqs /> components, so nothing was changed:\n` +
        `${plan.usages.map(({ file, element }) => `  ${where(file, element.line)}`).join("\n")}\n\n` +
        `Keep one, where the app renders, and set on it:${propsText(props)}`
      );
    case "expression":
      return `${where(plan.file, plan.line)} sets ${plan.name} from code, so nothing was changed. Set it to: ${typeof plan.value === "object" ? `{${plan.value.expression}}` : plan.value}`;
    case "spread":
      return `${where(plan.file, plan.line)} sets ${plan.name} before spread props that could override it, so nothing was changed. Move${propText(plan.name, plan.value)} after the spread.`;
    case "other-use":
      return (
        `${where(plan.file, 1).replace(/:1$/, "")} uses Critiqs under another name or loads it another way, so init didn't add a second one. ` +
        `Set these properties on that component yourself:${propsText(props)}`
      );
    case "no-entry":
      return `${plan.entry} is not a file in ${folder}. Name the file where the app renders, relative to that folder.`;
    case "no-root":
      return (
        `No <Critiqs /> component found in ${folder}.\n` +
        (plan.mount !== null
          ? `There is no <${plan.mount}> element ${plan.entry === null ? "there" : `in ${plan.entry}`}, so nothing was changed.\n`
          : plan.entry !== null
            ? `${plan.entry} doesn't render a React root, Next.js layout, or custom App init recognizes, so nothing was changed. Name the element to add it beside with --mount <Element>.\n`
            : "Init didn't find where the app renders, so nothing was changed.\n") +
        manualInstructions(props)
      );
    case "several-roots":
      return (
        `Found ${plan.points.length} places the app could render Critiqs, so nothing was changed:\n` +
        `${plan.points.map((point) => `  ${where(point.file, point.line)} (${MOUNT_KINDS[point.kind]}${point.kind === "chosen" ? `, <${point.element.name}>` : ""})`).join("\n")}\n\n` +
        "Choose one with --entry <file> (and --mount <Element> if that file has several), or add it yourself:\n\n" +
        `  <Critiqs${propsText(props)} />`
      );
    case "name-taken":
      return `${where(plan.file, plan.line)} already uses the name Critiqs for something else, so nothing was changed. ${manualInstructions(props)}`;
    default:
      return `Couldn't safely edit ${where(plan.file, plan.line)}, so nothing was changed. ${manualInstructions(props)}`;
  }
}

// ---------------------------------------------------------------------------
// Connecting through the app's environment

/**
 * How the code names the project:
 * - "env": the component reads one public environment variable of the app's
 *   framework (Vite or Next.js), and init sets it in a `.env` file on this
 *   computer. Each deployment sets its own, so each can use its own project,
 *   and a copy without one shows nothing. `addFlag` adds `requireProjectId`
 *   when init writes the expression; existing wiring is kept as written.
 * - "literal": init writes the ID into the component, as for components that
 *   already name one and builds whose public settings init doesn't know.
 * `problem` says why init can't wire this app safely, and what to do.
 */
export function chooseWiring(root, { envFile = null } = {}) {
  const app = describeApp(root, { envFile });
  const literal = { mode: "literal", app };
  let usages = [];
  try {
    usages = findCritiqsUsages(root);
  } catch {}
  if (usages.length > 1) return literal;
  const current = usages.length === 1 ? readProp(usages[0].source, usages[0].element, "projectId") : null;
  if (current?.kind === "literal") return literal;
  if (current?.kind === "expression") {
    const variable = envVariableOf(current.text, app);
    return variable === null ? literal : { mode: "env", app, variable, addFlag: false, problem: app.problem };
  }
  if (app.framework === null) return literal;
  if (app.customPrefix) {
    return {
      mode: "env",
      app,
      problem:
        "This app's Vite config sets envPrefix, so init can't tell which variable names reach the browser, and nothing was changed. " +
        "Give <Critiqs /> projectId={import.meta.env.<a name with your prefix>} requireProjectId, then run init again to set it.",
    };
  }
  return { mode: "env", app, variable: app.variable, addFlag: true, problem: app.problem };
}

/** The component's properties for a connection: the ID, or the expression that reads it, then `backend` when given. */
export function connectionProps(wiring, projectId, backend) {
  const withBackend = backend === undefined || backend === null ? {} : { backend };
  if (wiring.mode !== "env") return { projectId, ...withBackend };
  return { projectId: { expression: `${wiring.app.access}.${wiring.variable}` }, ...(wiring.addFlag ? { requireProjectId: true } : {}), ...withBackend };
}

/** What each deployment does with an environment-backed project ID. */
export function deploymentAdvice(wiring) {
  const reads = wiring.app.framework === "next" ? "Next.js" : "Vite";
  return (
    `Set ${wiring.variable} in each deployment's build settings to that deployment's project ID (${reads} reads it when the app is built, so rebuild after changing it), ` +
    "and leave it unset where Critiqs shouldn't appear."
  );
}

/**
 * When `root` declares a workspace: its packages where an app renders or
 * already uses Critiqs, which each get their own project. null for a folder
 * that declares no workspace.
 */
export function workspaceApps(root) {
  const patterns = workspacePatterns(root);
  if (patterns === null) return null;
  return workspaceMembers(root, patterns).filter((dir) => {
    try {
      return findCritiqsUsages(dir).length > 0 || findMountPoints(dir).length > 0;
    } catch {
      return false;
    }
  });
}

/** Why init doesn't choose an app in a workspace, with the exact commands for each. */
export function workspaceRefusal(apps, folder, show, command) {
  return (
    `${folder.charAt(0).toUpperCase()}${folder.slice(1)} is a workspace with ${apps.length === 1 ? "an app" : `${apps.length} apps`}, so nothing was changed: each app gets its own Critiqs project and settings. ` +
    `Run init for one app:\n${apps.map((dir) => `  ${command} --dir ${show(dir)}`).join("\n")}`
  );
}

/** Parses `init <projectId> [--dir <path>] [--entry <file>] [--mount <Element>] [--project-env-file <file>] [--dry-run]`; returns options or an error message. */
export function parseArguments(argv) {
  const options = { help: false, command: null, projectId: null, dir: ".", entry: null, mount: null, envFile: null, dryRun: false };
  const positional = [];
  const keys = { "--dir": "dir", "--entry": "entry", "--mount": "mount", "--project-env-file": "envFile", "--env-file": "envFile" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const flag = Object.keys(keys).find((name) => arg === name || arg.startsWith(`${name}=`));
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (flag !== undefined) {
      const value = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
      if (value === undefined || value === "") return { error: flag === "--dir" ? "--dir needs a folder path." : `${flag} needs a value.` };
      options[keys[flag]] = value;
    } else if (arg.startsWith("-")) return { error: `Unknown option ${arg}.` };
    else positional.push(arg);
  }
  options.command = positional[0] ?? null;
  options.projectId = positional[1] ?? null;
  if (options.help) return options;
  if (options.command !== "init") {
    return { error: options.command === null ? "Missing command." : `Unknown command ${options.command}.` };
  }
  if (options.projectId === null) return { error: "Missing project ID." };
  if (positional.length > 2) return { error: `Unexpected argument ${positional[2]}.` };
  if (options.mount !== null && !/^[\p{ID_Start}$_][\p{ID_Continue}$.\-:]*$/u.test(options.mount)) return { error: "--mount needs an element name, such as App." };
  return options;
}

/**
 * Runs the CLI and returns its exit code: 0 when the project ID is set, 1 when it
 * could not be set automatically, 2 for usage errors. `print` receives each message.
 * With no `<Critiqs />` yet, it adds one where the app renders.
 */
export function runInit(argv, { cwd = process.cwd(), print = console.log } = {}) {
  const options = parseArguments(argv);
  if ("error" in options) {
    print(`${options.error}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    print(HELP);
    return 0;
  }

  const projectId = options.projectId;
  if (!isValidProjectId(projectId)) {
    print(
      `"${projectId}" is not a Critiqs project ID. Copy it from project setup in the Critiqs sidebar: ` +
        "16 to 64 lowercase letters and digits, or p_ and 32 for a self-hosted server.",
    );
    return 2;
  }

  const root = resolve(cwd, options.dir);
  const where = (file, line) => `${relative(cwd, file) || file}:${line}`;
  const show = (path) => relative(cwd, path) || ".";
  const folder = relative(cwd, root) || "this folder";
  const apps = workspaceApps(root);
  if (apps !== null && apps.length > 0) {
    print(workspaceRefusal(apps, folder, show, `npx critiqs-react init ${projectId}`));
    return 1;
  }
  const wiring = chooseWiring(root, { envFile: options.envFile });
  if (wiring.problem) {
    print(wiring.problem);
    return 1;
  }
  const props = connectionProps(wiring, projectId);
  const plan = planComponent(root, props, { entry: options.entry, mount: options.mount });
  if (!plan.ok) {
    print(
      plan.reason === "expression" && wiring.mode === "literal"
        ? `${where(plan.file, plan.line)} sets projectId from code, so it was not changed.\nSet it to the project ID: ${projectId}`
        : plan.reason === "spread" && wiring.mode === "literal"
          ? `${where(plan.file, plan.line)} sets projectId before spread props that could override it, so it was not changed.\nMove projectId="${projectId}" after the spread.`
          : refusal(plan, props, where, folder),
    );
    return plan.reason === "not-folder" || plan.reason === "no-entry" ? 2 : 1;
  }
  let env = null;
  if (wiring.mode === "env") {
    try {
      env = planEnv(wiring.app, wiring.variable, projectId);
    } catch {
      print(`Couldn't read this app's .env files, so nothing was changed. Restore access, or set ${wiring.variable}=${projectId} in the .env.local file the app loads.`);
      return 1;
    }
  }
  const dry = options.dryRun ? " (dry run, nothing written)" : "";
  if (plan.action === "unchanged" && (env === null || !env.changed)) {
    print(`${where(plan.file, plan.line)} already uses this project ID${env === null ? "" : ` (${env.name} in ${show(env.file)})`}.`);
    return 0;
  }
  if (plan.action === "install") {
    const preview = plan.preview.map((line) => `  ${line}`).join("\n");
    print(
      `${options.dryRun ? "Would add" : "Added"} <Critiqs /> to ${where(plan.file, plan.line)} (${MOUNT_KINDS[plan.kind]})` +
        `${plan.imported ? ", importing it from critiqs-react" : ""}${dry}:\n${preview}`,
    );
  } else if (plan.action === "update" && wiring.mode === "env") {
    print(`${options.dryRun ? "Would connect" : "Connected"} <Critiqs /> in ${where(plan.file, plan.line)} to ${wiring.variable}${wiring.addFlag ? "; it stays hidden wherever that isn't set" : ""}${dry}.`);
  } else if (plan.action === "update") {
    print(`${options.dryRun ? "Would set" : "Set"} the project ID in ${where(plan.file, plan.line)}${dry}.`);
  }
  if (!options.dryRun) applyPlan(plan);
  if (env === null) return 0;
  if (env.changed) {
    if (!options.dryRun) {
      try {
        applyEnv(env);
      } catch {
        print(`Couldn't write ${show(env.file)}. Add this line to it yourself:\n  ${env.name}=${projectId}`);
        return 1;
      }
    }
    print(`${options.dryRun ? "Would set" : "Set"} ${env.name}=${projectId} in ${show(env.file)} for this computer${dry}.`);
  }
  print(deploymentAdvice(wiring));
  return 0;
}
