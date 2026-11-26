// Svelte setup: <Critiqs /> from critiqs-svelte in the app's root component
// (src/App.svelte in a Vite app). Components are read with the app's own
// Svelte compiler, so setup sees exactly what Svelte sees and edits only the
// spans it means to. The editing here is shared with SvelteKit setup, which
// differs only in where Critiqs goes and how a project ID reaches the browser.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { dependsOn, describeProjectId, readText } from "./shared.mjs";

export const PACKAGE = "critiqs-svelte";
/** The modules <Critiqs> comes from: the package, and its SvelteKit entry with the router. */
export const KIT_MODULE = `${PACKAGE}/kit`;
const MODULES = new Set([PACKAGE, KIT_MODULE]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "public", "static"]);
const NOT_APP_CODE = /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures|tests?|e2e|stories|\.storybook)\/|\.(test|spec|stories|story)\.[a-z]+$/;
const CONFIG_EXTENSIONS = ["ts", "mts", "js", "mjs", "cts", "cjs"];

const posix = (path) => path.split(sep).join("/");
/** A path as the person sees it: relative to the app, with forward slashes. */
export const shown = (root, file) => posix(relative(root, file));
export const lineAt = (source, index) => source.slice(0, index).split("\n").length;

/** The first `<name>.config.*` file in `root`, or null. */
export function configFile(root, name) {
  for (const extension of CONFIG_EXTENSIONS) {
    const path = join(root, `${name}.config.${extension}`);
    if (readText(path) !== null) return path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading components

/** The app's own Svelte compiler (5 or later), or why setup can't read its components. */
export function loadCompiler(root) {
  let compiler;
  try {
    compiler = createRequire(join(resolve(root), "package.json"))("svelte/compiler");
  } catch {
    return { problem: "Svelte isn't installed in this app yet, so setup can't read its components. Install the app's dependencies (such as npm install), then run setup again." };
  }
  const major = Number(String(compiler.VERSION).split(".")[0]);
  if (!(major >= 5)) {
    return { problem: `critiqs-svelte needs Svelte 5 or later, and this app has Svelte ${compiler.VERSION}. Upgrade it (npx sv migrate svelte-5), then run setup again.` };
  }
  return { compiler };
}

/** Every node of a Svelte AST, depth first. */
function* walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
  } else if (node !== null && typeof node === "object") {
    if (typeof node.type === "string") yield node;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "metadata" && value !== null && typeof value === "object") yield* walk(value);
    }
  }
}

/**
 * A component as setup reads it, or null when Svelte can't parse it:
 * - `imports`: every import in its `<script>` blocks, with each value
 *   binding's imported and local names (`*` for a namespace, `default` for a
 *   default) and every local name, types included (`locals`). Svelte erases
 *   type-only imports (`import type { … }`, `import { type … }`), so they bind
 *   no value;
 * - `critiqs`: the local name `Critiqs` from critiqs-svelte has here, if imported;
 * - `elements`: each `<Critiqs>` it renders, with its attributes.
 */
export function parseComponent(compiler, file, source) {
  let ast;
  try {
    ast = compiler.parse(source, { modern: true, filename: file });
  } catch {
    return null;
  }
  const imports = [];
  for (const script of [ast.module, ast.instance]) {
    for (const node of script?.content.body ?? []) {
      if (node.type !== "ImportDeclaration") continue;
      const typeOnly = node.importKind === "type";
      const bindings = node.specifiers
        .filter((specifier) => !typeOnly && specifier.importKind !== "type")
        .map((specifier) => ({
          imported: specifier.type === "ImportSpecifier" ? (specifier.imported.name ?? specifier.imported.value) : specifier.type === "ImportDefaultSpecifier" ? "default" : "*",
          local: specifier.local.name,
        }));
      const locals = node.specifiers.map((specifier) => specifier.local.name);
      imports.push({ from: node.source.value, quote: source[node.source.start], start: node.start, end: node.end, bindings, locals, typeOnly });
    }
  }
  const critiqs = imports.filter((entry) => MODULES.has(entry.from) && !entry.typeOnly).flatMap((entry) => entry.bindings).find((binding) => binding.imported === "Critiqs")?.local ?? null;
  const elements = [];
  if (critiqs !== null) {
    for (const node of walk(ast.fragment)) {
      if (node.type === "Component" && node.name === critiqs) elements.push(readElement(source, node));
    }
  }
  return { file, source, ast, imports, critiqs, elements };
}

function readElement(source, node) {
  const attributes = [];
  let spreadEnd = null;
  for (const attribute of node.attributes) {
    if (attribute.type === "SpreadAttribute") spreadEnd = attribute.end;
    if (attribute.type === "Attribute") attributes.push({ name: attribute.name, start: attribute.start, end: attribute.end, value: attribute.value });
  }
  return { start: node.start, end: node.end, line: lineAt(source, node.start), nameEnd: node.start + 1 + node.name.length, attributes, spreadEnd, last: node.attributes.at(-1) ?? null };
}

/**
 * What an attribute's value is: a `literal` string (quoted text, or `{"…"}`),
 * an `expression` with its code, or `true` for a bare attribute.
 */
function attributeValue(source, attribute) {
  const { value } = attribute;
  if (value === true) return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "literal", value: "" };
    if (value.length === 1 && value[0].type === "Text") return { kind: "literal", value: value[0].data };
    return { kind: "expression", text: source.slice(value[0].start, value.at(-1).end) };
  }
  const expression = value.expression;
  if (expression.type === "Literal" && typeof expression.value === "string") return { kind: "literal", value: expression.value };
  return { kind: "expression", text: source.slice(expression.start, expression.end), node: expression };
}

/**
 * The public variable an expression reads, when it is exactly one:
 * `import.meta.env.NAME` (Vite), `NAME` imported from `$app/env/public` or
 * `$env/static/public`, or `env.NAME` with `env` from `$env/dynamic/public`
 * (SvelteKit), also as `browser ? env.NAME : undefined` with `browser` from
 * `$app/environment`. null for any other code.
 */
export function variableRead(parsed, text) {
  const trimmed = text.trim();
  const vite = /^import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (vite !== null) return vite[1];
  const named = /^[A-Za-z_$][\w$]*$/.test(trimmed) ? importedAs(parsed, ["$app/env/public", "$env/static/public"], trimmed) : null;
  if (named !== null && named !== "*" && named !== "default") return named;
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (member !== null && importedAs(parsed, ["$env/dynamic/public"], member[1]) === "env") return member[2];
  const guarded = /^([A-Za-z_$][\w$]*)\s*\?\s*([A-Za-z_$][\w$]*\.[A-Za-z_][A-Za-z0-9_]*)\s*:\s*undefined$/.exec(trimmed);
  if (guarded !== null && importedAs(parsed, ["$app/environment"], guarded[1]) === "browser") return variableRead(parsed, guarded[2]);
  return null;
}

/** What `local` was imported as from one of `modules`, or null. */
function importedAs(parsed, modules, local) {
  for (const entry of parsed.imports) {
    if (!modules.includes(entry.from)) continue;
    const binding = entry.bindings.find((candidate) => candidate.local === local);
    if (binding !== undefined) return binding.imported;
  }
  return null;
}

/** A string setting on one element, as the `Usage` type reads it. */
function readSetting(parsed, element, name) {
  const attribute = element.attributes.find((candidate) => candidate.name === name);
  if (attribute === undefined) return null;
  const value = attributeValue(parsed.source, attribute);
  if (value === true) return { kind: "literal", value: "" };
  if (value.kind === "literal") return value;
  const variable = variableRead(parsed, value.text);
  return variable === null ? { kind: "expression", text: value.text } : { kind: "env", variable };
}

/**
 * A boolean attribute as written: true when bare or `{true}`, false when absent
 * or `{false}`, and null for anything else (`{isProd}`, quoted text), whose
 * value setup can't know.
 */
function booleanValue(source, attribute) {
  if (attribute === undefined) return false;
  const value = attributeValue(source, attribute);
  if (value === true) return true;
  const text = value.kind === "expression" ? value.text.trim() : null;
  return text === "true" ? true : text === "false" ? false : null;
}

/** Whether `requireProjectId` is surely set: bare or `{true}`. */
function readsRequired(parsed, element) {
  return booleanValue(parsed.source, element.attributes.find((candidate) => candidate.name === "requireProjectId")) === true;
}

/** Every `.svelte` file under `root` that is app code, sorted. */
function componentFiles(root) {
  const found = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (extname(entry.name) === ".svelte" && !NOT_APP_CODE.test(shown(root, path))) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found.sort();
}

/**
 * Critiqs in the app's components: each `<Critiqs>` element (`usages`), files
 * that load critiqs-svelte but render it in a way setup can't follow
 * (`otherUses`), and files that mention it but don't parse (`unreadable`).
 */
export function scanApp(root, compiler) {
  const usages = [];
  const otherUses = [];
  const unreadable = [];
  for (const file of componentFiles(root)) {
    const source = readText(file);
    if (source === null || !source.includes(PACKAGE)) continue;
    const parsed = parseComponent(compiler, file, source);
    if (parsed === null) unreadable.push(file);
    else if (parsed.elements.length === 0) {
      if (parsed.imports.some((entry) => MODULES.has(entry.from) && !entry.typeOnly)) otherUses.push(file);
    } else for (const element of parsed.elements) usages.push({ parsed, element });
  }
  return { usages, otherUses, unreadable };
}

/** Critiqs in the app's code, as the `Usage` type describes it; empty when its components can't be read. */
export function findUsages(root) {
  const { compiler } = loadCompiler(root);
  if (compiler === undefined) return [];
  return scanApp(root, compiler).usages.map(({ parsed, element }) => ({
    file: parsed.file,
    line: element.line,
    projectId: readSetting(parsed, element, "projectId"),
    backend: readSetting(parsed, element, "backend"),
    requireProjectId: readsRequired(parsed, element),
  }));
}

// ---------------------------------------------------------------------------
// Editing components

/** The file's indentation unit: a tab, or the smallest run of leading spaces. */
function indentUnit(source) {
  const indents = [...source.matchAll(/^([ \t]+)\S/gm)].map((match) => match[1]);
  if (indents.length === 0 || indents.some((indent) => indent.startsWith("\t"))) return "\t";
  return " ".repeat(Math.min(...indents.map((indent) => indent.length)));
}

const lineIndent = (source, index) => /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", index - 1) + 1))[0];

/** An attribute as written: bare for `true`, quoted text, or `{code}`; text that Svelte would read as code is written as a JavaScript string. */
export function attributeText(name, value) {
  if (value === true) return name;
  if (typeof value === "object") return `${name}={${value.code}}`;
  return /["{}&]/.test(value) ? `${name}={${JSON.stringify(value)}}` : `${name}="${value}"`;
}

/**
 * The attributes setup wants on <Critiqs>, in order: `projectId` as text or
 * code, `requireProjectId` when set, and `backend` when given.
 */
export function wantedAttributes(settings, binding) {
  const wanted = [["projectId", "literal" in settings.projectId ? settings.projectId.literal : { code: binding.code, variable: settings.projectId.env.variable, exact: binding.exact === true }]];
  if (settings.requireProjectId || "env" in settings.projectId) wanted.push(["requireProjectId", true]);
  if (settings.backend !== undefined) wanted.push(["backend", settings.backend]);
  return wanted;
}

/** Whether two pieces of code are the same apart from whitespace. */
const sameCode = (a, b) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

/** Applies non-overlapping edits `{ start, end, text }` to `source`. */
function applyEdits(source, edits) {
  let result = source;
  for (const { start, end, text } of [...edits].sort((a, b) => b.start - a.start)) result = result.slice(0, start) + text + result.slice(end);
  return result;
}

/**
 * Edits that give one existing <Critiqs> the wanted attributes, or a refusal
 * when one is set from code setup can't follow or a spread could override it.
 * Attributes setup doesn't want are left as the author wrote them.
 */
function attributeEdits(parsed, element, wanted, where) {
  const { source } = parsed;
  const edits = [];
  const changed = [];
  const added = [];
  for (const [name, value] of wanted) {
    const attribute = element.attributes.find((candidate) => candidate.name === name);
    if (attribute === undefined) {
      added.push(attributeText(name, value));
      changed.push(name);
      continue;
    }
    if (element.spreadEnd !== null && attribute.start < element.spreadEnd) {
      return { refusal: { ok: false, reason: "ambiguous", message: `${where} sets ${name} before spread props that could override it, so nothing was changed. Move ${attributeText(name, value)} after the spread.` } };
    }
    const current = attributeValue(source, attribute);
    if (value === true) {
      const set = booleanValue(source, attribute);
      if (set === null) {
        const text = current.kind === "expression" ? `{${current.text}}` : JSON.stringify(current.value);
        return { refusal: { ok: false, reason: "expression", message: `${where} sets ${name} to ${text}, which setup can't read as true or false, so nothing was changed. Write it as a bare ${name}.` } };
      }
      if (set === false) {
        edits.push({ start: attribute.start, end: attribute.end, text: name });
        changed.push(name);
      }
      continue;
    }
    if (typeof value === "object") {
      if (current !== true && current.kind === "expression") {
        const reads = variableRead(parsed, current.text) === value.variable;
        // A binding with `exact` needs its own form of the read (SvelteKit 2 reads in the browser only), so another form is rewritten.
        if (value.exact ? sameCode(current.text, value.code) : reads) continue;
        if (!reads) return { refusal: { ok: false, reason: "expression", message: `${where} sets ${name} from code (${current.text}), so nothing was changed. Set it to ${attributeText(name, value)}.` } };
      }
    } else {
      if (current !== true && current.kind === "literal" && current.value === value) continue;
      if (current !== true && current.kind === "expression") {
        return { refusal: { ok: false, reason: "expression", message: `${where} sets ${name} from code (${current.text}), so nothing was changed. Set it to ${attributeText(name, value)}.` } };
      }
    }
    edits.push({ start: attribute.start, end: attribute.end, text: attributeText(name, value) });
    changed.push(name);
  }
  if (added.length > 0) {
    // After the last attribute, so new settings win over spreads; one per line when the author writes them that way.
    const at = element.last?.end ?? element.nameEnd;
    const first = element.attributes[0] ?? element.last;
    const between = first === null ? "" : source.slice(element.nameEnd, first.start);
    const separator = between.includes("\n") ? `\n${lineIndent(source, first.start)}` : " ";
    edits.push({ start: at, end: at, text: added.map((text) => `${separator}${text}`).join("") });
  }
  return { edits, changed };
}

/**
 * An edit adding import declarations to the component's instance `<script>`:
 * after its last import, matching their quotes and semicolons, or a new
 * `<script>` at the top of the file.
 */
function importEdit(parsed, lines) {
  if (lines.length === 0) return null;
  const { source, ast } = parsed;
  const last = parsed.imports.at(-1);
  const quote = last?.quote ?? "'";
  const semicolon = last === undefined || source[last.end - 1] === ";" ? ";" : "";
  const statements = lines.map(({ names, from }) => `import ${names} from ${quote}${from}${quote}${semicolon}`);
  const instance = ast.instance;
  if (instance) {
    const instanceImports = parsed.imports.filter((entry) => entry.start >= instance.content.start && entry.end <= instance.content.end);
    const after = instanceImports.at(-1);
    if (after !== undefined) {
      const indent = lineIndent(source, after.start);
      // After a comment that ends the import's line (`import x from 'y' // why`), so it stays on that line.
      const rest = /^[ \t]*(\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*)?(?=\n)/.exec(source.slice(after.end));
      const at = after.end + (rest?.[1] === undefined ? 0 : rest[0].length);
      return { start: at, end: at, text: statements.map((statement) => `\n${indent}${statement}`).join("") };
    }
    const content = source.slice(instance.content.start, instance.content.end);
    const indent = /\n([ \t]*)\S/.exec(content)?.[1] ?? indentUnit(source);
    // Code on the `<script>` line (`<script>let n = 0</script>`) moves to a line of its own after the imports.
    const sameLine = content.trim() !== "" && !/^[ \t]*\n/.test(content);
    const tail = content.trim() === "" ? "\n" : sameLine ? `\n${indent}` : "";
    const end = instance.content.start + (sameLine ? /^[ \t]*/.exec(content)[0].length : 0);
    return { start: instance.content.start, end, text: statements.map((statement) => `\n${indent}${statement}`).join("") + tail };
  }
  const unit = indentUnit(source);
  const block = `<script>\n${statements.map((statement) => `${unit}${statement}`).join("\n")}\n</script>\n\n`;
  const at = ast.module ? ast.module.end : 0;
  return { start: at, end: at, text: ast.module ? `\n\n${block.trimEnd()}` : block };
}

/** Where a new element goes: after the component's last markup, before a trailing `<style>`. */
function elementEdit(parsed, text) {
  const { source, ast } = parsed;
  const markup = ast.fragment.nodes.filter((node) => !(node.type === "Text" && node.data.trim() === ""));
  const last = markup.at(-1);
  if (last !== undefined) return { start: last.end, end: last.end, text: `\n${text}` };
  const scripts = [ast.module, ast.instance].filter(Boolean);
  const at = scripts.length === 0 ? source.length : Math.max(...scripts.map((script) => script.end));
  return { start: at, end: at, text: at === 0 ? `${text}\n` : `\n\n${text}${at === source.length ? "\n" : ""}` };
}

/**
 * Whether `name` already means something in the component's scripts other
 * than a value imported from `module`: another import's local name (a type's
 * too), or the name anywhere in code outside import declarations.
 */
function nameTaken(parsed, name, module) {
  if (parsed.imports.some((entry) => entry.from === module && entry.bindings.some((binding) => binding.local === name))) return false;
  if (parsed.imports.some((entry) => entry.locals.includes(name))) return true;
  const pattern = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
  const code = (script) => {
    let text = parsed.source.slice(script.content.start, script.content.end);
    for (const entry of parsed.imports) {
      if (entry.start < script.content.start || entry.end > script.content.end) continue;
      const [start, end] = [entry.start - script.content.start, entry.end - script.content.start];
      text = text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
    }
    return text;
  };
  return [parsed.ast.module, parsed.ast.instance].some((script) => script && pattern.test(code(script)));
}

/** The lines that differ between two versions of a file, with `-` and `+`, for a preview. */
export function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [...a.slice(start, a.length - end).map((line) => `- ${line}`), ...b.slice(start, b.length - end).map((line) => `+ ${line}`)];
}

/**
 * Plans <Critiqs /> with `settings` in a Svelte app, shared by Svelte and
 * SvelteKit setup. `flavor` says what differs:
 * - `entry(root, compiler)`: where Critiqs goes, `{ file, source }` (`source`
 *   null for a file to create, with `template` its starting text), or `{ problem }`;
 * - `binding(parsed, env)`: the code that reads an environment-backed project
 *   ID, `{ code, imports: [{ name, from }] }`;
 * - `extraWrites(root, settings, compiler)`: other files the setting needs,
 *   `{ writes }` or a refusal;
 * - `module`: where a new import of Critiqs comes from (default critiqs-svelte);
 * - `manual(settings)`: the instructions a refusal ends with.
 */
export function planSvelte(root, settings, options, flavor) {
  const manual = flavor.manual(settings);
  const refuse = (reason, message) => ({ ok: false, reason, message: `${message}\n\n${manual}` });
  const loaded = loadCompiler(root);
  if (loaded.compiler === undefined) return refuse("unreadable", loaded.problem);
  const { compiler } = loaded;
  const scan = scanApp(root, compiler);
  if (scan.unreadable.length > 0) {
    return refuse("unreadable", `Svelte couldn't parse ${scan.unreadable.map((file) => shown(root, file)).join(", ")}, which uses ${PACKAGE}, so nothing was changed. Fix the file, then run setup again.`);
  }
  if (scan.usages.length > 1) {
    const list = scan.usages.map(({ parsed, element }) => `  ${shown(root, parsed.file)}:${element.line}`).join("\n");
    return refuse("ambiguous", `Found ${scan.usages.length} <Critiqs /> components, so nothing was changed:\n${list}\nKeep one, in the component every page renders.`);
  }
  const chosen = options.entry === null ? null : resolve(root, options.entry);
  if (scan.usages.length === 0 && scan.otherUses.length > 0) {
    return refuse("ambiguous", `${scan.otherUses.map((file) => shown(root, file)).join(", ")} loads ${PACKAGE} but doesn't render <Critiqs /> in a way setup can follow, so nothing was changed. Set these on that component yourself.`);
  }
  if (scan.usages.length === 1 && chosen !== null && scan.usages[0].parsed.file !== chosen) {
    const { parsed, element } = scan.usages[0];
    return refuse("ambiguous", `Critiqs is already in ${shown(root, parsed.file)}:${element.line}, not ${options.entry}, so nothing was changed. Run setup without an entry to update it, or move it there yourself.`);
  }

  let target;
  let original;
  if (scan.usages.length === 1) {
    target = scan.usages[0].parsed;
    original = target.source;
  } else {
    const entry = flavor.entry(root, compiler, chosen);
    if (entry.problem !== undefined) return refuse("manual", entry.problem);
    original = entry.source;
    target = parseComponent(compiler, entry.file, entry.source ?? entry.template);
    if (target === null) return refuse("unreadable", `Svelte couldn't parse ${shown(root, entry.file)}, so nothing was changed.`);
  }
  // Windows line endings: edit the text with \n, and write it back with \r\n.
  const crlf = target.source.includes("\r\n");
  if (crlf) target = parseComponent(compiler, target.file, target.source.replaceAll("\r\n", "\n"));
  const where = `${shown(root, target.file)}:${target.elements[0]?.line ?? 1}`;

  const imports = [];
  let binding = { code: "", imports: [] };
  if ("env" in settings.projectId) {
    binding = flavor.binding(target, settings.projectId.env);
    if (binding.problem !== undefined) return refuse("manual", `${shown(root, target.file)}: ${binding.problem}`);
    for (const { name, from } of binding.imports) {
      if (target.imports.some((entry) => entry.from === from && entry.bindings.some((candidate) => candidate.imported === name))) continue;
      if (nameTaken(target, name, from)) return refuse("manual", `${shown(root, target.file)} already uses the name ${name} for something else, so nothing was changed.`);
      imports.push({ names: `{ ${name} }`, from });
    }
  }
  const wanted = wantedAttributes(settings, binding);

  let edits;
  let changed;
  const element = target.elements[0];
  if (element !== undefined) {
    const planned = attributeEdits(target, element, wanted, where);
    if (planned.refusal !== undefined) return { ...planned.refusal, message: `${planned.refusal.message}\n\n${manual}` };
    ({ edits, changed } = planned);
    // The code that reads the project ID needs its imports only when setup writes it.
    if (!changed.includes("projectId")) imports.length = 0;
  } else {
    const module = flavor.module ?? PACKAGE;
    if (target.critiqs === null && nameTaken(target, "Critiqs", module)) {
      return refuse("manual", `${shown(root, target.file)} already uses the name Critiqs for something else, so nothing was changed.`);
    }
    if (target.critiqs === null) imports.unshift({ names: "{ Critiqs }", from: module });
    const tag = `<${target.critiqs ?? "Critiqs"} ${wanted.map(([name, value]) => attributeText(name, value)).join(" ")} />`;
    edits = [elementEdit(target, tag)];
    changed = wanted.map(([name]) => name);
  }
  const importChange = importEdit(target, imports);
  if (importChange !== null) edits.push(importChange);
  const before = target.source;
  const after = applyEdits(before, edits);

  // The result must read back as exactly one Critiqs, with these settings.
  const check = parseComponent(compiler, target.file, after);
  const result = check?.elements.length === 1 ? check.elements[0] : null;
  const reads = result === null ? null : readSetting(check, result, "projectId");
  const expected = "literal" in settings.projectId ? { kind: "literal", value: settings.projectId.literal } : { kind: "env", variable: settings.projectId.env.variable };
  if (
    result === null ||
    reads?.kind !== expected.kind ||
    (reads.kind === "literal" ? reads.value !== expected.value : reads.variable !== expected.variable) ||
    (wanted.some(([name]) => name === "requireProjectId") && !readsRequired(check, result)) ||
    (settings.backend !== undefined && readSetting(check, result, "backend")?.value !== settings.backend)
  ) {
    return refuse("unreadable", `Couldn't safely edit ${where}, so nothing was changed.`);
  }

  const extra = flavor.extraWrites?.(root, settings, compiler) ?? { writes: [] };
  if (extra.refusal !== undefined) return { ...extra.refusal, message: `${extra.refusal.message}\n\n${manual}` };
  const output = after === before && original !== null ? original : crlf ? after.replaceAll("\n", "\r\n") : after;
  const writes = [...(output === original ? [] : [{ file: target.file, original, source: output }]), ...extra.writes];
  if (extra.writes.length > 0 && !changed.includes("projectId")) changed.push("projectId");
  const preview = [
    ...(output === original ? [] : changedLines(original ?? "", output)),
    ...extra.writes.flatMap((write) => [`${shown(root, write.file)}:`, ...changedLines(write.original ?? "", write.source)]),
  ];
  return {
    ok: true,
    action: writes.length === 0 ? "unchanged" : element === undefined ? "install" : "update",
    writes,
    file: target.file,
    line: result.line,
    changed: writes.length === 0 ? [] : changed,
    preview: preview.join("\n"),
    next: [],
  };
}

// ---------------------------------------------------------------------------
// Svelte with Vite

/**
 * Where a Vite app's `.env` files live and whether `VITE_` names reach the
 * browser: null when its config sets `envPrefix`, or `root` or `envDir` other
 * than as a plain string. Like Vite's resolveConfig, `envDir` is relative to
 * `root`, which defaults to the folder Vite runs in (the app's).
 */
function viteEnvDir(root) {
  const file = configFile(root, "vite");
  const text = file === null ? "" : (readText(file) ?? "");
  if (/\benvPrefix\b/.test(text)) return null;
  const literal = (name) => {
    const mentions = text.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
    if (mentions.length === 0) return "";
    const value = new RegExp(`\\b${name}\\s*:\\s*(["'])([^"'\\n]*)\\1`).exec(text);
    return mentions.length === 1 && value !== null ? value[2] : null;
  };
  const viteRoot = literal("root");
  const envDir = literal("envDir");
  return viteRoot === null || envDir === null ? null : resolve(root, viteRoot, envDir);
}

/** The component a Vite app mounts: src/App.svelte, or the one its index.html script passes to `mount` or `hydrate`. */
function viteRoot(root) {
  const app = join(root, "src", "App.svelte");
  if (readText(app) !== null) return app;
  const html = readText(join(root, "index.html")) ?? "";
  const script = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/.exec(html)?.[1];
  if (script === undefined) return null;
  const main = resolve(root, script.replace(/^\//, ""));
  const code = readText(main) ?? "";
  const mounted = /\b(?:mount|hydrate)\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(code)?.[1] ?? /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/.exec(code)?.[1];
  if (mounted === undefined) return null;
  const imported = new RegExp(`import\\s+${mounted.replace(/\$/g, "\\$")}\\s+from\\s*(["'])([^"']+\\.svelte)\\1`).exec(code)?.[2];
  return imported === undefined ? null : resolve(dirname(main), imported);
}

/** Resolves `options.entry`: an existing `.svelte` file, or why it can't be used. */
export function chosenEntry(root, chosen) {
  const source = extname(chosen) === ".svelte" ? readText(chosen) : null;
  return source === null ? { problem: `${shown(root, chosen)} is not a Svelte component in this app. Name the component every page renders, relative to the app.` } : { file: chosen, source };
}

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const svelte = {
  id: "svelte",
  name: "Svelte",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "svelte"),
  env(root, suffix) {
    // Rollup, webpack and esbuild builds have no public variable convention.
    if (!dependsOn(root, "vite") && configFile(root, "vite") === null) return null;
    const dir = viteEnvDir(root);
    if (dir === null) return null;
    const variable = `VITE_CRITIQS_PROJECT_ID${suffix}`;
    return {
      variable,
      expression: `import.meta.env.${variable}`,
      readsAt: "build",
      localFile: shown(root, join(dir, ".env.local")),
      deploymentAdvice: `Set ${variable} in each deployment's build settings to that deployment's project ID; Vite reads it when the app is built, so rebuild after changing it. Leave it unset where Critiqs shouldn't appear.`,
    };
  },
  find: (root) => findUsages(root),
  plan(root, settings, options) {
    return planSvelte(root, settings, options, {
      manual: svelte.manual,
      entry(appRoot, compiler, chosen) {
        if (chosen !== null) return chosenEntry(appRoot, chosen);
        const file = viteRoot(appRoot);
        const source = file === null ? null : readText(file);
        if (source === null) return { problem: "Setup didn't find the component this app mounts (src/App.svelte), so nothing was changed. Name it with an entry, relative to the app." };
        return { file, source };
      },
      binding: (_parsed, env) => ({ code: env.expression, imports: [] }),
    });
  },
  manual(settings) {
    const attributes = wantedAttributes(settings, { code: "literal" in settings.projectId ? "" : settings.projectId.env.expression }).map(([name, value]) => attributeText(name, value));
    return [
      `To add Critiqs by hand, install ${PACKAGE} (npm install ${PACKAGE}) and add it to the component the app mounts, usually src/App.svelte:`,
      "",
      "  <script>",
      `    import { Critiqs } from '${PACKAGE}';`,
      "  </script>",
      "",
      `  <Critiqs ${attributes.join(" ")} />`,
      ...("env" in settings.projectId
        ? ["", `Then set ${settings.projectId.env.variable}=<project ID> in ${settings.projectId.env.localFile ?? ".env.local"} for this computer, and in each deployment's build settings.`]
        : []),
      "",
      `Project ID: ${describeProjectId(settings)}.`,
    ].join("\n");
  },
};
