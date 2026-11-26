/**
 * What setup needs to know about an app, whatever its framework, to give it a
 * Critiqs project through its environment: the workspace it belongs to, a
 * name for its project and its variable, and this computer's `.env` files.
 * The framework's adapter names the variable and the files it loads
 * (`EnvConvention`); setup writes the value, and each deployment sets its
 * own, so only correctly configured copies of the app show Critiqs.
 * Dependency-free so it runs under Node and Bun without a build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const posix = (path) => path.split(sep).join("/");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspaces

/** The package patterns a folder's workspace declares (npm, Yarn, Bun, or pnpm), or null when it declares none. */
export function workspacePatterns(dir) {
  const manifest = readJson(join(dir, "package.json"));
  const declared = Array.isArray(manifest?.workspaces) ? manifest.workspaces : Array.isArray(manifest?.workspaces?.packages) ? manifest.workspaces.packages : null;
  let pnpm = null;
  try {
    const yaml = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
    const block = /^packages:\s*\n((?:[ \t]+[^\n]*\n?|\s*\n)*)/m.exec(yaml)?.[1] ?? "";
    pnpm = [...block.matchAll(/^[ \t]+-[ \t]*(["']?)([^"'#\n]+?)\1[ \t]*(?:#.*)?$/gm)].map((match) => match[2]);
  } catch {}
  if (declared === null && pnpm === null) return null;
  return [...(declared ?? []), ...(pnpm ?? [])].filter((pattern) => typeof pattern === "string");
}

/** The package folders a workspace's patterns match: `dir/*`, `dir/**`, and literal folders, excluding `!` patterns. */
export function workspaceMembers(workspaceRoot, patterns = workspacePatterns(workspaceRoot) ?? []) {
  const found = new Set();
  const segment = (part) => new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`);
  const children = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  };
  const expand = (dir, parts, depth) => {
    if (parts.length === 0) {
      if (existsSync(join(dir, "package.json"))) found.add(resolve(dir));
      return;
    }
    const [part, ...rest] = parts;
    if (part === "**") {
      expand(dir, rest, depth);
      if (depth < 6) for (const child of children(dir)) expand(join(dir, child), parts, depth + 1);
    } else if (/[*?]/.test(part)) {
      const pattern = segment(part);
      for (const child of children(dir)) if (pattern.test(child)) expand(join(dir, child), rest, depth);
    } else if (part !== "" && part !== ".") {
      expand(join(dir, part), rest, depth);
    } else {
      expand(dir, rest, depth);
    }
  };
  const excluded = new Set();
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const parts = posix(pattern.replace(/^!/, "").replace(/^\.\//, "").replace(/\/+$/, "")).split("/");
    if (negated) {
      const before = new Set(found);
      found.clear();
      expand(workspaceRoot, parts, 0);
      for (const dir of found) excluded.add(dir);
      found.clear();
      for (const dir of before) found.add(dir);
    } else {
      expand(workspaceRoot, parts, 0);
    }
  }
  return [...found].filter((dir) => !excluded.has(dir) && dir !== resolve(workspaceRoot)).sort();
}

/** The workspace an app folder belongs to: the nearest enclosing folder declaring workspaces, within its repository. */
export function findWorkspace(root) {
  const start = resolve(root);
  if (existsSync(join(start, ".git"))) return null;
  for (let dir = dirname(start); ; dir = dirname(dir)) {
    const patterns = workspacePatterns(dir);
    if (patterns !== null) return { root: dir, patterns };
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return null;
  }
}

const packageName = (dir) => {
  const name = readJson(join(dir, "package.json"))?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
};
const shortName = (dir) => packageName(dir)?.replace(/^@[^/]+\//, "") ?? basename(resolve(dir));

/**
 * The app's name within its workspace: its package name without a scope, or
 * its folder's, unless another workspace package has the same one; then its
 * path from the workspace root, which is unique.
 */
function workspaceLabel(root, workspace, members = workspaceMembers(workspace.root, workspace.patterns)) {
  const own = shortName(root);
  const others = members.filter((dir) => dir !== resolve(root));
  if (!others.some((dir) => shortName(dir).toLowerCase() === own.toLowerCase())) return own;
  return posix(relative(workspace.root, root));
}

const variableSuffix = (label) => label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Resolve collisions after normalization, including paths such as apps/a-b and apps/a_b. */
function workspaceSuffix(root, workspace, members) {
  const entries = [...new Set([...members, resolve(root)])].map((dir) => ({
    dir,
    suffix: variableSuffix(workspaceLabel(dir, workspace, members)),
  }));
  const names = entries.map(({ dir, suffix }) => ({
    dir,
    suffix: entries.some((entry) => entry.dir !== dir && entry.suffix === suffix)
      ? `${suffix}_${createHash("sha256").update(posix(relative(workspace.root, dir))).digest("hex").slice(0, 12).toUpperCase()}`
      : suffix,
  }));
  const own = names.find((entry) => entry.dir === resolve(root));
  // A generated name could also match another package's literal name. Refuse rather than overwrite it.
  return names.some((entry) => entry.dir !== own.dir && entry.suffix === own.suffix) ? null : own.suffix;
}

/**
 * The app as setup names it:
 * - `projectName`: its package name, or its folder's; in a workspace also
 *   the workspace's, and the app's path when another package shares its name;
 * - `suffix`: added to its framework's variable name, such as `_ADMIN`, so in
 *   a workspace a value shared across it (a root `.env`, or a build job's
 *   settings) can't configure every app with one project. "" outside a
 *   workspace; null when two apps' names would give the same one;
 * - `envFile`: the `.env` file the person chose for it, if any.
 */
export function describeApp(root, { envFile = null } = {}) {
  const workspace = findWorkspace(root);
  const members = workspace === null ? [] : workspaceMembers(workspace.root, workspace.patterns);
  const label = workspace === null ? null : workspaceLabel(root, workspace, members);
  const workspaceName = workspace === null ? null : shortName(workspace.root);
  const suffix = workspace === null ? "" : workspaceSuffix(root, workspace, members);
  return {
    root: resolve(root),
    workspace: workspace === null ? null : { root: workspace.root, name: workspaceName, label },
    projectName: workspace === null ? shortName(root) : `${workspaceName}/${label}`,
    suffix: suffix === null || suffix === "" ? suffix : `_${suffix}`,
    envFile: envFile === null ? null : resolve(root, envFile),
  };
}

// ---------------------------------------------------------------------------
// .env files

const DEFINITION = /^[ \t]*(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=(.*)$/;

/** A `.env` value as frameworks read it: quotes removed, or an unquoted value without its trailing comment. */
function envValue(raw) {
  const text = raw.trim();
  const quoted = /^(["'`])(.*)\1/.exec(text);
  if (quoted !== null) return quoted[2];
  return text.replace(/\s+#.*$/, "").trim();
}

/** A `.env` file that exists but can't be read: what it sets is unknown, not empty. `file` is its absolute path. */
export class UnreadableEnvFile extends Error {
  constructor(file, cause) {
    super(`Couldn't read ${file}.`, { cause });
    this.file = file;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new UnreadableEnvFile(path, error);
  }
}

/**
 * This computer's `.env` files for an app whose framework reads its project
 * ID from `convention.variable`: `files`, those it loads, highest precedence
 * first (with the person's chosen file before all of them), and `local`, the
 * file setup writes, chosen so its value is the one the framework uses: the
 * chosen one; or else the file that sets the variable first, when it is a
 * `.local` file; or else the framework's `localFile`, unless a file read
 * before it sets the variable; then the `.local` file read before that one
 * (Vite reads `.env.development` before `.env.local`, so that is
 * `.env.development.local`). `local` is null for frameworks that load no
 * `.env` file. `label` names the app in comments. Reads only to choose
 * `local`, and never throws: a file it can't read isn't chosen, and `planEnv`
 * and `readEnvValue` refuse it.
 */
export function envTarget(root, convention, { envFile = null, label = null } = {}) {
  const loads = (convention.loads ?? (convention.localFile === null ? [] : [convention.localFile])).map((file) => resolve(root, file));
  const chosen = envFile === null ? null : resolve(root, envFile);
  const files = chosen === null ? loads : [chosen, ...loads.filter((file) => file !== chosen)];
  const sets = (file) => {
    try {
      return definitions(readText(file), convention.variable, syntaxOf(file)) > 0;
    } catch {
      return false;
    }
  };
  const own = convention.localFile === null ? null : resolve(root, convention.localFile);
  const isLocal = (file) => file.endsWith(".local");
  const winner = loads.findIndex(sets);
  let local = chosen ?? own;
  if (chosen === null && own !== null && winner !== -1) {
    const ownAt = loads.indexOf(own);
    if (isLocal(loads[winner])) local = loads[winner];
    else if (ownAt > winner) local = loads.slice(0, winner).find(isLocal) ?? loads[winner];
  }
  return { files, local, label };
}

/** Where this computer's `.env` files set a variable: the value and file that win, or null. Throws `UnreadableEnvFile` for a file it reads and can't. */
export function readEnvValue(target, name) {
  for (const file of target.files) {
    const text = readText(file);
    if (text === null) continue;
    let value = null;
    const syntax = syntaxOf(file);
    for (const line of text.split(/\r?\n/)) {
      const definition = syntax.parse(line);
      // In a .env file the last definition wins; in code the first default does.
      if (definition?.name === name && (value === null || !syntax.code)) value = definition.value;
    }
    if (value !== null) return { value, file };
  }
  return null;
}

/** How many times a file's text defines a variable. */
const definitions = (text, name, syntax = DOTENV) => (text ?? "").split(/\r?\n/).filter((line) => syntax.parse(line)?.name === name).length;

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PYTHON_DEFINITION = new RegExp(`^([ \\t]*)os\\.environ\\.setdefault\\([ \\t]*(["'])(${NAME})\\2[ \\t]*,[ \\t]*(["'])(.*?)\\4[ \\t]*\\)`);
// `ENV[...] ||= "…"`, or a plain `ENV[...] = "…"` someone wrote by hand, which wins even over the environment.
const RUBY_DEFINITION = new RegExp(`^([ \\t]*)ENV\\[[ \\t]*(["'])(${NAME})\\2[ \\t]*\\][ \\t]*(?:\\|\\|)?=[ \\t]*(["'])(.*?)\\4`);
const DJANGO_SETTINGS_LINE = /^([ \t]*)os\.environ\.setdefault\([ \t]*["']DJANGO_SETTINGS_MODULE["']/;

/**
 * How a file setup writes a variable into states it: a `.env` file's
 * `NAME=value` lines, or, for a server framework that loads no `.env` file,
 * the code its development server runs: a default in Python
 * (`os.environ.setdefault`, Django's `manage.py`) or Ruby (`ENV[...] ||=`,
 * Rails's `config/environments/development.rb`). In code the environment
 * still wins, as it does over a `.env` file. `insert` places a new
 * definition, with its comment, in a file's lines.
 */
const DOTENV = {
  code: false,
  parse: (line) => {
    const match = DEFINITION.exec(line);
    return match === null ? null : { name: match[2], value: envValue(match[3]) };
  },
  replace: (line, name, value) => `${DEFINITION.exec(line)[1] ?? ""}${name}=${value}`,
  insert: (lines, name, value, comment) => [...lines, ...(comment === null ? [] : [`# ${comment}`]), `${name}=${value}`],
};
/**
 * In code, setup rewrites a definition only when it sets one string and nothing else: at most a comment after it,
 * and no conditional block around it. Anything else someone wrote (a condition, an expression, a block) is left as
 * it is, and setup's own default goes just before it, so it is read first. `definitions` says, for each definition,
 * whether setup may rewrite it and whether it only fills a variable nothing set before (a default), so the
 * value set before it stays in effect.
 */
const codeSyntax = ({ pattern, statement, place, blocks, isDefault }) => ({
  code: true,
  parse: (line) => {
    const match = pattern.exec(line);
    return match === null ? null : { name: match[3], value: match[5] };
  },
  // Only a definition `definitions` calls editable is replaced, so what follows its value is at most a comment, which stays.
  replace: (line, name, value) => {
    const match = pattern.exec(line);
    return `${match[1]}${statement(name, value)}${line.slice(match[0].length)}`;
  },
  insert: (lines, name, value, comment) => {
    const { at, indent, extra } = place(lines);
    return [...lines.slice(0, at), ...extra, ...(comment === null ? [] : [`${indent}# ${comment}`]), `${indent}${statement(name, value)}`, ...lines.slice(at)];
  },
  insertBefore: (lines, at, name, value, comment) => {
    const indent = /^[ \t]*/.exec(lines[at])[0];
    return [...lines.slice(0, at), ...(comment === null ? [] : [`${indent}# ${comment}`]), `${indent}${statement(name, value)}`, ...lines.slice(at)];
  },
  definitions: (lines, name) =>
    lines.flatMap((line, index) => {
      const match = pattern.exec(line);
      if (match === null || match[3] !== name) return [];
      const around = blocks(lines, index).filter((block) => block.conditional);
      const rest = line.slice(match[0].length);
      return [
        {
          index,
          // The first line to put a default before: this one, or the outermost conditional block around it.
          before: around[0]?.index ?? index,
          text: line.trim(),
          editable: /^[ \t]*(?:#.*)?$/.test(rest) && around.length === 0,
          default: isDefault(match[0], rest, name) || around.some((block) => isDefault("", block.text, name)),
        },
      ];
    }),
});

/** The blocks around line `index` of Python code, outermost first, found by indentation. */
function pythonBlocks(lines, index) {
  const found = [];
  let indent = /^[ \t]*/.exec(lines[index])[0].length;
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    const text = lines[i].trim();
    if (text === "" || text.startsWith("#")) continue;
    const own = /^[ \t]*/.exec(lines[i])[0].length;
    if (own >= indent) continue;
    found.unshift({ index: i, text, conditional: /^(?:if|elif|else|while|for|try|except|finally|with|match|case)\b/.test(text) });
    indent = own;
  }
  return found;
}

/** The blocks open at line `index` of Ruby code, outermost first: `do` blocks, and statements `end` closes. */
function rubyBlocks(lines, index) {
  const open = [];
  for (let i = 0; i < index; i++) {
    const text = lines[i].replace(/#.*$/, "").trim();
    if (text === "") continue;
    if (/^end\b/.test(text)) {
      open.pop();
      continue;
    }
    const keyword = /^(if|unless|case|while|until|for|begin|def|class|module)\b/.exec(text)?.[1];
    // A statement that opens and closes on one line (`if a then b end`) leaves nothing open.
    if ((keyword !== undefined && !/\bend$/.test(text)) || /\bdo(?:[ \t]*\|[^|]*\|)?$/.test(text)) {
      open.push({ index: i, text, conditional: ["if", "unless", "case", "while", "until", "for"].includes(keyword) });
    }
  }
  return open;
}

/** Whether a Ruby condition (a line's `unless …` modifier, or a block's opening line) holds only while `name` is unset. */
const rubyUnset = (text, name) =>
  new RegExp(
    `^[ \\t]*(?:unless[ \\t]+ENV(?:\\[[ \\t]*(["'])${name}\\1[ \\t]*\\]|\\.(?:key\\?|has_key\\?|include\\?|member\\?)\\([ \\t]*(["'])${name}\\2[ \\t]*\\))|if[ \\t]+ENV\\[[ \\t]*(["'])${name}\\3[ \\t]*\\]\\.nil\\?)[ \\t]*(?:then[ \\t]*)?(?:#.*)?$`,
  ).test(text);

const PYTHON = codeSyntax({
  pattern: PYTHON_DEFINITION,
  statement: (name, value) => `os.environ.setdefault(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
  place: (lines) => {
    // Beside Django's own default, in main(), so it is set before the command runs; or else after the module's last import.
    const django = lines.findIndex((line) => DJANGO_SETTINGS_LINE.test(line));
    if (django !== -1) return { at: django + 1, indent: DJANGO_SETTINGS_LINE.exec(lines[django])[1], extra: [] };
    const imports = lines.flatMap((line, i) => (/^(?:import|from)\s/.test(line) ? [i] : []));
    const hasOs = lines.some((line) => /^import os(?:\s|$|,)/.test(line));
    const at = imports.length > 0 ? imports.at(-1) + 1 : lines[0]?.startsWith("#!") ? 1 : 0;
    return { at, indent: "", extra: hasOs ? [] : ["import os"] };
  },
  blocks: pythonBlocks,
  // setdefault never replaces a value.
  isDefault: () => true,
});
const RUBY_SYNTAX = codeSyntax({
  pattern: RUBY_DEFINITION,
  statement: (name, value) => `ENV[${JSON.stringify(name)}] ||= ${JSON.stringify(value)}`,
  place: (lines) => {
    const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    return { at: end, indent: "", extra: lines[end - 1] === undefined || lines[end - 1].trim() === "" ? [] : [""] };
  },
  blocks: rubyBlocks,
  isDefault: (assignment, rest, name) => /\|\|=/.test(assignment) || rubyUnset(rest, name),
});
const RUBY = {
  ...RUBY_SYNTAX,
  // A definition gets the new value and keeps its own operator (a plain `=` stays plain) and its comment.
  replace: (line, name, value) => {
    const match = RUBY_DEFINITION.exec(line);
    return `${match[1]}ENV[${JSON.stringify(name)}] ${/\|\|=/.test(match[0]) ? "||=" : "="} ${JSON.stringify(value)}${line.slice(match[0].length)}`;
  },
};

/** The syntax a file states variables in, by its extension: `.py` and `.rb` files are code, anything else a `.env` file. */
function syntaxOf(file) {
  return file.endsWith(".py") ? PYTHON : file.endsWith(".rb") ? RUBY : DOTENV;
}

/** Whether setup writes `file`'s setting as code the development server runs, rather than as a `.env` line. */
export const isCodeFile = (file) => syntaxOf(file).code;

/**
 * Each line of code `text` (the file `file`, by default as it is on disk) that defines `name`: its line number and
 * text, whether setup may rewrite it (see `codeSyntax`), and whether it only fills a variable nothing set before.
 */
export function codeDefinitions(file, name, text = readText(file)) {
  if (!isCodeFile(file) || text === null) return [];
  return syntaxOf(file)
    .definitions(text.split(/\r?\n/), name)
    .map(({ index, text: line, editable, default: fills }) => ({ line: index + 1, text: line, editable, default: fills }));
}

/** Sets `name` to `value` in one file's text, replacing its definitions and keeping every other line as it is. */
function setInText(text, name, value, comment, syntax = DOTENV) {
  const eol = text?.includes("\r\n") ? "\r\n" : "\n";
  if (text === null || text === "") return `${syntax.insert([], name, value, comment).join(eol)}${eol}`;
  const lines = text.split(/\r?\n/);
  if (syntax.code) {
    const found = syntax.definitions(lines, name);
    const editable = new Set(found.filter((definition) => definition.editable).map((definition) => definition.index));
    if (editable.size > 0) return lines.map((line, i) => (editable.has(i) ? syntax.replace(line, name, value) : line)).join(eol);
    if (found.length > 0) return syntax.insertBefore(lines, found[0].before, name, value, comment).join(eol);
    return syntax.insert(lines, name, value, comment).join(eol);
  }
  let found = false;
  const updated = lines.map((line) => {
    if (syntax.parse(line)?.name !== name) return line;
    found = true;
    return syntax.replace(line, name, value);
  });
  if (found) return updated.join(eol);
  const separator = text.endsWith("\n") ? "" : eol;
  return `${text}${separator}${syntax.insert([], name, value, comment).join(eol)}${eol}`;
}

/**
 * Plans this computer's setting: `name=value` in the target's local file,
 * plus an empty entry in the `.env.example` beside it for the next developer
 * and each deployment. Writes nothing. Throws `UnreadableEnvFile` when a
 * file the framework loads can't be read, since it could set the variable
 * and win over the value setup writes.
 */
export function planEnv(target, name, value) {
  for (const file of target.files) readText(file);
  const local = target.local;
  const original = readText(local);
  const syntax = syntaxOf(local);
  const comment = syntax.code
    ? `Critiqs project for ${target.label ?? "this app"} in development; the environment wins. Each deployment sets its own.`
    : `Critiqs project for ${target.label ?? "this app"} on this computer. Each deployment sets its own.`;
  const source = setInText(original, name, value, comment, syntax);
  // Code is shared through the repository, so it needs no example for the next developer.
  if (syntax.code) return { name, value, file: local, original, source, changed: source !== original, example: null };
  const exampleFile = join(dirname(local), ".env.example");
  let exampleOriginal;
  try {
    exampleOriginal = readText(exampleFile);
  } catch {
    // No framework loads the example, which is only a convenience: one setup can't read stays as it is.
    exampleOriginal = undefined;
  }
  const listed = exampleOriginal === undefined || definitions(exampleOriginal, name) > 0;
  const example = listed
    ? null
    : {
        file: exampleFile,
        original: exampleOriginal,
        source: setInText(exampleOriginal, name, "", `Critiqs project ID for ${target.label ?? "this app"}. Set it in each deployment that should show Critiqs; leave it unset to keep Critiqs off.`),
      };
  return { name, value, file: local, original, source, changed: source !== original, example };
}

/** Throws unless `file` can be written: the file itself, or its folder when it doesn't exist yet. */
export function checkWritable(file) {
  accessSync(existsSync(file) ? file : dirname(file), constants.W_OK);
  if (!isDirectory(dirname(file))) throw new Error(`${dirname(file)} is not a folder.`);
}

/** Writes an env plan's local file, then its example; the example is a convenience, so only the first can fail the plan. */
export function applyEnv(plan) {
  if (plan.changed) writeFileSync(plan.file, plan.source);
  let example = null;
  if (plan.example !== null) {
    try {
      writeFileSync(plan.example.file, plan.example.source);
      example = plan.example.file;
    } catch {}
  }
  return { example };
}

/** Whether Git ignores a file (true), tracks or would commit it (false), or can't tell (null). */
export function gitIgnored(file) {
  try {
    const result = spawnSync("git", ["check-ignore", "-q", basename(file)], { cwd: dirname(file), stdio: "ignore" });
    return result.status === 0 ? true : result.status === 1 ? false : null;
  } catch {
    return null;
  }
}
