// Angular setup: adds `provideCritiqs({ … })` to the providers of the app's
// config (`src/app/app.config.ts`, as `ng new` creates it), or updates the one
// already there. A small scanner reads the TypeScript: it skips comments,
// strings, templates, and regexes and matches brackets, which is all these
// edits need; anything it can't follow is refused with manual instructions.
import { readdirSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { dependsOn, describeProjectId, readText } from "./shared.mjs";

const PACKAGE = "critiqs-angular";
const CONFIG = "app/app.config.ts";
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "out-tsc", "coverage", "tmp"]);
/** `ng new` writes a Prettier config with this width; longer calls are split across lines. */
const PRINT_WIDTH = 100;

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const angular = {
  id: "angular",
  name: "Angular",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "@angular/core"),
  // Angular's application builder reads no environment variables into app
  // code: `define` in angular.json and `environment.ts` file replacements are
  // fixed when written, not set by each deployment. So the ID goes in the code.
  env: () => null,
  find: (root) => findCalls(root).map(({ file, source, call }) => usageOf(file, source, call)),
  plan,
  manual,
};

// ---------------------------------------------------------------------------
// Reading TypeScript

/**
 * The source with every comment, string, template, and regex body blanked to
 * spaces (newlines kept), so searches and bracket matching see only code and
 * indices stay the same as the source's.
 */
function codeMask(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let previous = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && (c === "`" || source[j] !== "\n")) j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      previous = c;
      i = j + 1;
    } else if (c === "/" && (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j++;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j++;
      }
      blank(i + 1, j);
      previous = "/";
      i = j + 1;
    } else {
      if (!/\s/.test(c)) previous = /[\p{ID_Continue}$]/u.test(c) ? "a" : c;
      i++;
    }
  }
  return out.join("");
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

/** The index just past the bracket that closes the one at `open`, or -1. */
function closing(mask, open) {
  const stack = [];
  for (let i = open; i < mask.length; i++) {
    const c = mask[i];
    if (c in OPEN) stack.push(OPEN[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** The comma-separated parts between `start` and `end` at bracket depth 0, trimmed, as [start, end) ranges. */
function parts(mask, start, end) {
  const ranges = [];
  let from = start;
  let depth = 0;
  const push = (to) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(mask[a])) a++;
    while (b > a && /\s/.test(mask[b - 1])) b--;
    if (a < b) ranges.push([a, b]);
  };
  for (let i = start; i < end; i++) {
    const c = mask[i];
    if (c in OPEN) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(end);
  return ranges;
}

const lineAt = (source, index) => source.slice(0, index).split("\n").length;
const lineStart = (source, index) => source.lastIndexOf("\n", index - 1) + 1;
/** The whitespace that starts the line holding `index`. */
const indentAt = (source, index) => /^[ \t]*/.exec(source.slice(lineStart(source, index)))[0];

/** A string literal's text, or null for anything else (including escapes and `${}`). */
function stringValue(text) {
  const match = /^(['"`])([^\\]*)\1$/s.exec(text);
  if (match === null || match[2].includes(match[1]) || (match[1] === "`" && match[2].includes("${"))) return null;
  return match[2];
}

const IDENTIFIER = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$]*`;

/**
 * The file's imports of `provideCritiqs` from critiqs-angular: its local name
 * (`provideCritiqs`, or an alias) or a namespace (`* as critiqs`), with the
 * import's range. Empty when the file doesn't import it.
 */
function importsOf(source, mask) {
  const imports = [];
  const pattern = new RegExp(String.raw`(?<![\p{ID_Continue}$.])import\s+(type\s+)?(?:\{([^}]*)\}|\*\s*as\s+(${IDENTIFIER}))\s*from\s*(['"])`, "gu");
  for (const match of mask.matchAll(pattern)) {
    if (match[1] !== undefined) continue;
    const quote = match.index + match[0].length - 1;
    const end = closingQuote(source, quote);
    if (stringValue(source.slice(quote, end)) !== PACKAGE) continue;
    const range = [match.index, end];
    if (match[3] !== undefined) {
      imports.push({ local: match[3], namespace: true, range });
      continue;
    }
    for (const specifier of match[2].split(",")) {
      const named = new RegExp(String.raw`^\s*provideCritiqs(?:\s+as\s+(${IDENTIFIER}))?\s*$`, "u").exec(specifier);
      if (named !== null) imports.push({ local: named[1] ?? "provideCritiqs", namespace: false, range });
    }
  }
  return imports;
}

/**
 * The file's re-exports of critiqs-angular that include `provideCritiqs`
 * (`export { provideCritiqs as withFeedback } from …`, `export * from …`), as
 * indices. Code elsewhere then calls it under a name setup doesn't follow.
 */
function reexportsOf(source, mask) {
  const indices = [];
  const pattern = new RegExp(String.raw`(?<![\p{ID_Continue}$.])export\s+(type\s+)?(?:\{([^}]*)\}|\*(?:\s*as\s+${IDENTIFIER})?)\s*from\s*(['"])`, "gu");
  for (const match of mask.matchAll(pattern)) {
    if (match[1] !== undefined) continue;
    const quote = match.index + match[0].length - 1;
    if (stringValue(source.slice(quote, closingQuote(source, quote))) !== PACKAGE) continue;
    if (match[2] === undefined || match[2].split(",").some((specifier) => /^\s*provideCritiqs(?![\p{ID_Continue}$])/u.test(specifier))) indices.push(match.index);
  }
  return indices;
}

/** How code in this file calls `provideCritiqs`: `provideCritiqs` or its alias, or `critiqs.provideCritiqs` through a namespace import. */
const calleesOf = (source, mask) => importsOf(source, mask).map(({ local, namespace }) => (namespace ? `${local}.provideCritiqs` : local));

const closingQuote = (source, quote) => source.indexOf(source[quote], quote + 1) + 1;

/** The index of the `(` that calls what ends at `index` (`?.(` too), or null when it isn't called there. */
function callAfter(mask, index) {
  const call = /^\s*(?:\?\.\s*)?\(/.exec(mask.slice(index));
  return call === null ? null : index + call[0].length - 1;
}

/**
 * What a namespace import's name at `index` reaches: the `(` of a
 * `provideCritiqs` call (`critiqs.provideCritiqs(`, `critiqs?.provideCritiqs(`,
 * `critiqs['provideCritiqs'](`), undefined for another member (its types), or
 * null when setup can't tell (the namespace passed on or destructured, a
 * computed member, `provideCritiqs` not called).
 */
function namespaceCall(source, mask, index) {
  const dot = new RegExp(String.raw`^\s*\??\.\s*(${IDENTIFIER})`, "u").exec(mask.slice(index));
  if (dot !== null) return dot[1] === "provideCritiqs" ? callAfter(mask, index + dot[0].length) : undefined;
  const bracket = /^\s*(?:\?\.\s*)?\[/.exec(mask.slice(index));
  if (bracket === null) return null;
  const open = index + bracket[0].length - 1;
  const close = closing(mask, open);
  const key = close === -1 ? null : stringValue(source.slice(open + 1, close - 1).trim());
  if (key === null) return null;
  return key === "provideCritiqs" ? callAfter(mask, close) : undefined;
}

/**
 * A settings object setup can edit: the call's argument when it is an object
 * literal, or the object an arrow function returns, `() => ({ … })`.
 */
function settingsObject(mask, start, end) {
  if (mask[start] === "{") return closing(mask, start) === end ? start : null;
  const arrow = /^\(\s*\)\s*=>\s*\(\s*\{/.exec(mask.slice(start, end));
  if (arrow === null) return null;
  const paren = start + arrow[0].lastIndexOf("(");
  const open = start + arrow[0].length - 1;
  const close = closing(mask, open);
  return close !== -1 && closing(mask, paren) === end && /^\s*\)$/.test(mask.slice(close, end)) ? open : null;
}

/** An object literal's properties: name, value range, and whether a spread comes after it. */
function properties(source, mask, open) {
  const close = closing(mask, open);
  const ranges = parts(mask, open + 1, close - 1);
  const props = [];
  let lastSpread = -1;
  ranges.forEach(([a, b], index) => {
    const text = source.slice(a, b);
    if (text.startsWith("...")) {
      lastSpread = index;
      return;
    }
    const named = /^(?:(['"])([\p{ID_Start}$_][\p{ID_Continue}$]*)\1|([\p{ID_Start}$_][\p{ID_Continue}$]*))\s*(:)?/u.exec(text);
    if (named === null) return;
    const name = named[2] ?? named[3];
    if (named[4] === undefined) {
      // Shorthand (`{ projectId }`) or a method: code setup doesn't edit.
      props.push({ name, start: a, end: b, valueStart: a, index, shorthand: true });
      return;
    }
    let valueStart = a + named[0].length;
    while (valueStart < b && /\s/.test(mask[valueStart])) valueStart++;
    props.push({ name, start: a, end: b, valueStart, index, shorthand: false });
  });
  for (const prop of props) prop.overridden = prop.index < lastSpread;
  return { open, close, ranges, props };
}

/**
 * Every `provideCritiqs(…)` call in one file, in source order, plus every
 * other use of its import, which setup can't read (`unreadable`) and so
 * counts as a call it can't edit.
 */
function callsIn(source) {
  if (!source.includes(PACKAGE)) return [];
  const mask = codeMask(source);
  const imports = importsOf(source, mask);
  const calls = [];
  for (const index of reexportsOf(source, mask)) {
    const text = source.slice(lineStart(source, index)).split("\n")[0].trim();
    calls.push({ index, line: lineAt(source, index), object: null, argument: text, empty: false, unreadable: true });
  }
  for (const { local, namespace } of imports) {
    const uses = new RegExp(String.raw`(?<![\p{ID_Continue}$.])${local.replace(/\$/g, "\\$")}(?![\p{ID_Continue}$])`, "gu");
    for (const use of mask.matchAll(uses)) {
      if (imports.some(({ range: [start, end] }) => use.index >= start && use.index < end)) continue;
      const after = use.index + local.length;
      const open = namespace ? namespaceCall(source, mask, after) : callAfter(mask, after);
      if (open === undefined) continue;
      const line = lineAt(source, use.index);
      if (open === null) {
        const text = source.slice(lineStart(source, use.index)).split("\n")[0].trim();
        calls.push({ index: use.index, line, object: null, argument: text, empty: false, unreadable: true });
        continue;
      }
      const close = closing(mask, open);
      if (close === -1) {
        calls.push({ index: use.index, line, object: null, argument: "", empty: false });
        continue;
      }
      const [argument] = parts(mask, open + 1, close - 1);
      const object = argument === undefined ? null : settingsObject(mask, argument[0], argument[1]);
      calls.push({
        index: use.index,
        line,
        object: object === null ? null : properties(source, mask, object),
        argument: argument === undefined ? "" : source.slice(argument[0], argument[1]),
        empty: argument === undefined,
      });
    }
  }
  return calls.sort((a, b) => a.index - b.index);
}

/** Source files under `root`, skipping dependencies, build output, tests, and dot-directories. */
function sourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.(d|spec|test)\.m?ts$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function findCalls(root) {
  return sourceFiles(root).flatMap((file) => {
    const source = readText(file) ?? "";
    return callsIn(source).map((call) => ({ file, source, call }));
  });
}

/** How one property reads, as a `SettingRead`. */
function readSetting(source, prop) {
  if (prop === undefined) return null;
  const text = source.slice(prop.valueStart, prop.end);
  const value = stringValue(text);
  return value === null ? { kind: "expression", text } : { kind: "literal", value };
}

/** @returns {import("./types.d.mts").Usage} */
function usageOf(file, source, call) {
  if (call.object === null) {
    const unknown = call.empty ? null : { kind: "expression", text: call.argument };
    return { file, line: call.line, projectId: unknown, backend: unknown, requireProjectId: false };
  }
  const prop = (name) => call.object.props.find((candidate) => candidate.name === name);
  const required = prop("requireProjectId");
  return {
    file,
    line: call.line,
    projectId: readSetting(source, prop("projectId")),
    backend: readSetting(source, prop("backend")),
    requireProjectId: required !== undefined && !required.shorthand && source.slice(required.valueStart, required.end) === "true",
  };
}

// ---------------------------------------------------------------------------
// Writing settings

/** The quote character the file's imports use; `ng new` writes single quotes. */
const quoteOf = (source) => /^import\s[^'"]*(['"])/m.exec(source)?.[1] ?? "'";

/** Each setting's code, in the order setup writes them. */
function settingTexts(settings, quote) {
  const literal = (value) => `${quote}${value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
  /** @type {[string, string][]} */
  const texts = [["projectId", "literal" in settings.projectId ? literal(settings.projectId.literal) : settings.projectId.env.expression]];
  if (settings.requireProjectId || "env" in settings.projectId) texts.push(["requireProjectId", "true"]);
  if (settings.backend !== undefined) texts.push(["backend", literal(settings.backend)]);
  return texts;
}

/** `provideCritiqs({ … })`, on one line when it fits, otherwise one setting per line. */
function callText(texts, indent, unit, callee = "provideCritiqs") {
  const inline = `${callee}({ ${texts.map(([name, value]) => `${name}: ${value}`).join(", ")} })`;
  if (indent.length + inline.length + 1 <= PRINT_WIDTH) return inline;
  return `${callee}({\n${texts.map(([name, value]) => `${indent}${unit}${name}: ${value},\n`).join("")}${indent}})`;
}

/** The file's indentation step, from its first indented line. */
const unitOf = (source) => /^([ \t]+)\S/m.exec(source)?.[1] ?? "  ";

/** Applies [start, end, text] edits to `source`, last first. */
function splice(source, edits) {
  return [...edits].sort((a, b) => b[0] - a[0]).reduce((text, [start, end, insert]) => text.slice(0, start) + insert + text.slice(end), source);
}

/** Text that adds `items` after the last of `ranges` inside brackets at [open, close), matching the layout. */
function appendItems(source, open, close, ranges, items, unit) {
  const multiline = source.slice(open, close).includes("\n");
  if (ranges.length === 0) {
    const pad = source[open] === "{" ? " " : "";
    if (!multiline) return [[open + 1, close - 1, `${pad}${items.join(", ")}${pad}`]];
    const indent = indentAt(source, open);
    return [[open + 1, close - 1, `\n${items.map((item) => `${indent}${unit}${item}`).join(",\n")}\n${indent}`]];
  }
  const last = ranges[ranges.length - 1];
  if (!multiline) return [[last[1], last[1], items.map((item) => `, ${item}`).join("")]];
  const indent = itemIndent(source, open, ranges, unit);
  return [[last[1], last[1], items.map((item) => `,\n${indent}${item}`).join("")]];
}

/** The indentation of items in a multi-line list: its last item's line, or one step in from the opening bracket's line. */
function itemIndent(source, open, ranges, unit) {
  const last = ranges[ranges.length - 1];
  if (last === undefined || lineStart(source, last[0]) === lineStart(source, open)) return `${indentAt(source, open)}${unit}`;
  return indentAt(source, last[0]);
}

/** The lines that differ between two versions of a file, with `-` and `+`. */
function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [...a.slice(start, a.length - end).map((line) => `- ${line}`), ...b.slice(start, b.length - end).map((line) => `+ ${line}`)].join("\n");
}

/** Whether `source` holds exactly one call, and it says what `settings` asks. */
function readsBack(source, settings) {
  const [call, ...extra] = callsIn(source);
  if (call === undefined || extra.length > 0 || call.object === null) return null;
  const texts = Object.fromEntries(settingTexts(settings, quoteOf(source)));
  const ok = call.object.props.every((prop) => !(prop.name in texts) || !prop.overridden) &&
    Object.entries(texts).every(([name, text]) => {
      const prop = call.object.props.find((candidate) => candidate.name === name);
      if (prop === undefined) return false;
      const written = source.slice(prop.valueStart, prop.end);
      if (name === "requireProjectId") return !prop.shorthand && written === "true";
      return written === text || (stringValue(written) !== null && stringValue(written) === stringValue(text));
    });
  return ok ? call : null;
}

// ---------------------------------------------------------------------------
// Planning

/** @type {import("./types.d.mts").FrameworkAdapter["plan"]} */
function plan(root, settings, options) {
  const where = (file, line) => `${relative(root, file) || file}:${line}`;
  const entry = options.entry === null ? null : resolve(root, options.entry);
  if (entry !== null && readText(entry) === null) {
    return refuse("manual", `${options.entry} is not a file in ${root}, so nothing was changed. Name the file with the app's providers, relative to the app.`, settings);
  }
  // With --entry, another app in the workspace keeps its own Critiqs. A call whose app can't be told (no angular.json, or
  // outside every app's folder, as in a shared library) might be the entry's app's own, so it counts.
  const app = entry === null ? null : appOf(root, entry);
  const all = findCalls(root);
  const found = app === null ? all : all.filter(({ file }) => file === entry || [null, app].includes(appOf(root, file)));
  const inEntry = found.filter(({ file }) => file === entry);
  if (entry !== null && inEntry.length === 0 && found.length > 0) {
    return refuse(
      "ambiguous",
      `${app === null ? "This checkout already has" : `${options.entry}'s app already has`} provideCritiqs(…) at ${found.map(({ file, call }) => where(file, call.line)).join(", ")}${app === null ? `, and setup can't tell whether it is ${options.entry}'s app (no angular.json names the app holding ${options.entry})` : ""}, so nothing was changed. Run setup with that file as --entry, or move the call to ${options.entry}.`,
      settings,
    );
  }
  if (found.length > 1) {
    return refuse(
      "ambiguous",
      `Found ${found.length} provideCritiqs(…) calls, so nothing was changed:\n${found.map(({ file, call }) => `  ${where(file, call.line)}`).join("\n")}\n\nKeep one, in the app's providers, and give it these settings.`,
      settings,
    );
  }
  if (found.length === 1) return planUpdate(found[0], settings, where);
  return planInstall(root, settings, entry, where);
}

function refuse(reason, why, settings) {
  return { ok: false, reason, message: `${why}\n\n${manual(settings)}` };
}

function planUpdate({ file, source, call }, settings, where) {
  const at = where(file, call.line);
  if (call.unreadable) {
    return refuse("unreadable", `${at} uses provideCritiqs from critiqs-angular in a way setup can't read (${call.argument}), so nothing was changed. Call provideCritiqs({ … }) directly in the app's providers, or set its settings yourself.`, settings);
  }
  if (call.object === null) {
    return refuse("expression", `${at} passes provideCritiqs settings that setup can't edit (it edits an object literal, { … }, or () => ({ … })), so nothing was changed. Set them yourself.`, settings);
  }
  const quote = quoteOf(source);
  const unit = unitOf(source);
  const edits = [];
  const added = [];
  const changed = [];
  for (const [name, text] of settingTexts(settings, quote)) {
    const prop = call.object.props.find((candidate) => candidate.name === name);
    if (prop === undefined) {
      added.push(`${name}: ${text}`);
      changed.push(name);
      continue;
    }
    if (prop.overridden) {
      return refuse("expression", `${where(file, lineAt(source, prop.start))} sets ${name} before a spread (...) that could override it, so nothing was changed. Move ${name} after the spread.`, settings);
    }
    const written = source.slice(prop.valueStart, prop.end);
    if (name === "requireProjectId") {
      if (prop.shorthand || (written !== "true" && written !== "false")) {
        return refuse("expression", `${where(file, lineAt(source, prop.start))} sets requireProjectId from code, so nothing was changed. Set it to true.`, settings);
      }
      if (written === "false") {
        edits.push([prop.valueStart, prop.end, "true"]);
        changed.push(name);
      }
      continue;
    }
    if (written === text) continue;
    const current = stringValue(written);
    const wanted = stringValue(text);
    if (prop.shorthand || current === null || wanted === null) {
      return refuse("expression", `${where(file, lineAt(source, prop.start))} sets ${name} from code, so nothing was changed. Set it to ${text}.`, settings);
    }
    if (current === wanted) continue;
    edits.push([prop.valueStart, prop.end, text]);
    changed.push(name);
  }
  const { open, close, ranges } = call.object;
  if (added.length > 0) edits.push(...appendItems(source, open, close, ranges, added, unit));
  const updated = splice(source, edits);
  if (changed.length === 0) return { ok: true, action: "unchanged", writes: [], file, line: call.line, changed, preview: "", next: [] };
  const check = readsBack(updated, settings);
  if (check === null) return refuse("unreadable", `Couldn't safely edit ${at}, so nothing was changed.`, settings);
  return {
    ok: true,
    action: "update",
    writes: [{ file, original: source, source: updated }],
    file,
    line: check.line,
    changed,
    preview: changedLines(source, updated),
    next: [],
  };
}

/** The applications in angular.json, each with its absolute source folder; empty without a workspace file. */
function applications(root) {
  let workspace = null;
  try {
    workspace = JSON.parse(readText(join(root, "angular.json")) ?? "null");
  } catch {}
  return Object.entries(workspace?.projects ?? {})
    .filter(([, project]) => (project?.projectType ?? "application") === "application")
    .map(([name, project]) => ({ name, source: resolve(root, project.sourceRoot ?? join(project.root ?? "", "src")), root: resolve(root, project.root ?? "") }));
}

/** The app config `ng new` would write for each application in angular.json. */
function configCandidates(root) {
  const projects = applications(root);
  const sources = projects.length === 0 ? [resolve(root, "src")] : projects.map((project) => project.source);
  return [...new Set(sources.map((dir) => join(dir, CONFIG)))];
}

/** The name of the application whose folder holds `file`, the deepest one; null when none does or there's no angular.json. */
function appOf(root, file) {
  let best = null;
  for (const project of applications(root)) {
    for (const dir of [project.source, project.root]) {
      const inside = relative(dir, file);
      if (inside.startsWith("..") || isAbsolute(inside)) continue;
      if (best === null || dir.length > best.length) best = { name: project.name, length: dir.length };
    }
  }
  return best?.name ?? null;
}

function planInstall(root, settings, entry, where) {
  let file;
  if (entry !== null) {
    file = entry;
  } else {
    const candidates = configCandidates(root);
    const present = candidates.filter((candidate) => readText(candidate) !== null);
    if (present.length > 1) {
      return refuse("ambiguous", `This workspace has ${present.length} app configs, so nothing was changed:\n${present.map((path) => `  ${relative(root, path)}`).join("\n")}\n\nChoose one with --entry <file>.`, settings);
    }
    if (present.length === 0) {
      return refuse(
        "manual",
        `Setup didn't find ${relative(root, candidates[0])}, the app config that ng new creates, so nothing was changed. Apps bootstrapped with an NgModule, or configured elsewhere, are set up by hand.`,
        settings,
      );
    }
    file = present[0];
  }
  const source = readText(file);
  const mask = codeMask(source);
  const at = (index) => where(file, lineAt(source, index));
  const arrays = [...mask.matchAll(/(?<![\p{ID_Continue}$.])providers\s*:\s*\[/gu)];
  if (arrays.length !== 1) {
    return refuse(
      arrays.length === 0 ? "manual" : "ambiguous",
      arrays.length === 0
        ? `${relative(root, file)} has no providers: [ … ] list setup can edit, so nothing was changed.`
        : `${relative(root, file)} has ${arrays.length} providers lists (${arrays.map((match) => at(match.index)).join(", ")}), so nothing was changed.`,
      settings,
    );
  }
  if (/@Component\s*\(/.test(mask)) {
    return refuse("manual", `${at(arrays[0].index)} is a component's providers list; Critiqs goes in the app's providers (app.config.ts or the root NgModule), so nothing was changed.`, settings);
  }
  const callees = calleesOf(source, mask);
  if (/(?<![\p{ID_Continue}$.])provideCritiqs(?![\p{ID_Continue}$])/u.test(mask) && !callees.includes("provideCritiqs")) {
    return refuse("unreadable", `${relative(root, file)} already uses the name provideCritiqs for something else, so nothing was changed.`, settings);
  }
  const open = arrays[0].index + arrays[0][0].length - 1;
  const close = closing(mask, open);
  if (close === -1) return refuse("unreadable", `Couldn't read the providers list at ${at(open)}, so nothing was changed.`, settings);
  const unit = unitOf(source);
  const ranges = parts(mask, open + 1, close - 1);
  const multiline = source.slice(open, close).includes("\n");
  const indent = multiline ? itemIndent(source, open, ranges, unit) : indentAt(source, open);
  const texts = settingTexts(settings, quoteOf(source));
  // An import already there names the call; otherwise the import goes above the providers, so it is added second, to the edited text.
  const listed = splice(source, appendItems(source, open, close, ranges, [callText(texts, indent, unit, callees[0])], unit));
  const updated = callees.length === 0 ? splice(listed, [importEdit(listed, codeMask(listed), quoteOf(source))]) : listed;
  const check = readsBack(updated, settings);
  if (check === null) return refuse("unreadable", `Couldn't safely edit ${relative(root, file)}, so nothing was changed.`, settings);
  return {
    ok: true,
    action: "install",
    writes: [{ file, original: source, source: updated }],
    file,
    line: check.line,
    changed: texts.map(([name]) => name),
    preview: [changedLines(source, listed), ...(listed === updated ? [] : [changedLines(listed, updated)])].join("\n"),
    next: [],
  };
}

/** Adds the import after the file's last import declaration, or at the top. */
function importEdit(source, mask, quote) {
  let end = -1;
  let semicolon = true;
  for (const match of mask.matchAll(/^import\s[^;'"]*?(['"])\s*\1[ \t]*(;?)/gm)) {
    end = match.index + match[0].length;
    semicolon = match[2] === ";";
  }
  const line = `import { provideCritiqs } from ${quote}${PACKAGE}${quote}${semicolon ? ";" : ""}`;
  return end === -1 ? [0, 0, `${line}\n\n`] : [end, end, `\n${line}`];
}

// ---------------------------------------------------------------------------
// By hand

/** @type {import("./types.d.mts").FrameworkAdapter["manual"]} */
function manual(settings) {
  const call = callText(settingTexts(settings, "'"), "    ", "  ");
  return [
    `Add Critiqs to the app's providers in src/app/app.config.ts (project ID ${describeProjectId(settings)}):`,
    "",
    `  import { provideCritiqs } from '${PACKAGE}';`,
    "",
    "  export const appConfig: ApplicationConfig = {",
    "    providers: [",
    "      // …the app's other providers",
    `      ${call.replaceAll("\n", "\n  ")},`,
    "    ],",
    "  };",
    "",
    "In an app bootstrapped with an NgModule, add the same provideCritiqs(…) call to the providers of the root module (AppModule, often src/app/app.module.ts).",
    "Critiqs runs only in the browser, so server rendering is unaffected. With Angular Router it reports each route and shows a thread by navigating to its route; the critiqs-angular README covers routes, restoreContext, and settings that change.",
  ].join("\n");
}
