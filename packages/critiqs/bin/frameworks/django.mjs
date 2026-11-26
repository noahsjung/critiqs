// Django setup: adds "django_critiqs" to INSTALLED_APPS in the settings module
// manage.py names, the CRITIQS settings the person chose, and
// {% load critiqs %} … {% critiqs %} to the base template every page extends.
// The project ID comes from the CRITIQS_PROJECT_ID environment variable on
// each request unless the settings name one.
//
// The Python and template helpers at the end are shared with flask.mjs.
import { readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { describeProjectId, readText } from "./shared.mjs";

const VARIABLE = "CRITIQS_PROJECT_ID";
const APP = "django_critiqs";
const README = "https://github.com/noahsjung/critiqs/tree/main/packages/django#readme";
const TAG = /\{%-?\s*critiqs(?:\s[^%]*)?-?%\}/g;
const LOAD = /\{%-?\s*load\s+(?:[\w.]+\s+)*critiqs(?:\s+[\w.]+)*\s*-?%\}/;

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const django = {
  id: "django",
  name: "Django",
  install: { ecosystem: "pypi", package: "django-critiqs" },
  detect: (root) => readText(join(root, "manage.py"))?.includes("django") === true,
  env: (root, suffix) => ({
    variable: `${VARIABLE}${suffix}`,
    expression: `os.environ.get("${VARIABLE}${suffix}")`,
    readsAt: "runtime",
    // Django loads no .env file. manage.py, which starts the development server
    // (and not a deployment's WSGI or ASGI server), gets a default beside Django's own.
    localFile: "manage.py",
    deploymentAdvice:
      `Set ${VARIABLE}${suffix} in each deployment's environment to that deployment's project ID; Django reads it on each request, so restart the server after changing it. ` +
      "Leave it unset where Critiqs shouldn't appear.",
  }),
  find(root) {
    const settings = settingsFile(root);
    const config = settings === null || "problem" in settings ? new Map() : readDict(settings.source, "CRITIQS");
    return templateFiles(root, templateDirs(root, settings)).flatMap((template) =>
      [...template.source.matchAll(TAG)].map((match) => ({
        file: template.file,
        line: lineAt(template.source, match.index),
        ...djangoSettings(config),
      })),
    );
  },
  plan(root, settings, options) {
    const refuse = (reason, problem) => ({ ok: false, reason, message: `${problem}\n\n${django.manual(settings)}` });
    const entry = options.entry === null ? null : resolve(root, options.entry);
    if (entry !== null && readText(entry) === null) return refuse("manual", `${options.entry} is not a file in this app.`);

    const found = entry?.endsWith(".py") ? { file: entry, source: readText(entry) } : settingsFile(root);
    if (found === null) return refuse("manual", "manage.py doesn't name a settings module setup can find (DJANGO_SETTINGS_MODULE), so nothing was changed.");
    if ("problem" in found) return refuse("manual", found.problem);
    const apps = addInstalledApp(found.source);
    if ("problem" in apps) return refuse("unreadable", `${found.file}: ${apps.problem}, so nothing was changed.`);
    const configured = writeDictSettings(apps.source, "CRITIQS", desiredDjango(settings), { comment: ["Critiqs", README] });
    if ("problem" in configured) return refuse(configured.reason, `${found.file}: ${configured.problem}, so nothing was changed.`);
    const settingsSource = configured.needsOs ? addImport(configured.source, "import os") : configured.source;

    const usages = django.find(root);
    if (usages.length > 1) {
      return refuse("ambiguous", `Found ${usages.length} {% critiqs %} tags, so nothing was changed:\n${usages.map((u) => `  ${u.file}:${u.line}`).join("\n")}\nKeep one, in the template every page extends.`);
    }
    if (usages.length === 1 && entry !== null && !entry.endsWith(".py") && entry !== usages[0].file) {
      return refuse("ambiguous", `Critiqs is already in ${usages[0].file}:${usages[0].line}, so setup didn't add a second {% critiqs %} to ${options.entry}.`);
    }
    const chosen =
      entry !== null && !entry.endsWith(".py")
        ? { template: { file: entry, source: readText(entry) } }
        : usages.length === 1
          ? { template: { file: usages[0].file, source: readText(usages[0].file) } }
          : chooseBase(templateFiles(root, templateDirs(root, found)), join(root, "templates", "base.html"));
    if ("problem" in chosen) return refuse(chosen.reason, chosen.problem);
    const { template } = chosen;
    const placed = placeTemplateTag(template.source, "{% critiqs %}", TAG, (source) => (LOAD.test(source) ? source : addDjangoLoad(source)));
    if (placed === null) return refuse("unreadable", `${template.file} has more than one </body>, or extends another template, so setup can't tell where {% critiqs %} goes and nothing was changed.`);

    const writes = [
      { file: found.file, original: found.source, source: settingsSource },
      { file: template.file, original: template.source, source: placed.source },
    ].filter((write) => write.source !== write.original);
    const before = usages[0];
    const after = djangoSettings(readDict(settingsSource, "CRITIQS"));
    return finishPlan({ writes, file: template.file, line: placed.line, before, after, settings, next: djangoNext() });
  },
  manual(settings) {
    const config = dictBlock("CRITIQS", desiredEntries(desiredDjango(settings), '"'), '"');
    return [
      "To add Critiqs to this Django app by hand:",
      "1. Install the package in the app's environment and add it to your requirements: pip install django-critiqs",
      `2. In the settings module manage.py names, add "${APP}" to INSTALLED_APPS${config === null ? "." : ", and add:"}`,
      ...(config === null ? [] : ["", indent(config, "     "), ""]),
      "3. In the template every page extends (usually templates/base.html), load the tag at the top and render it just before </body>:",
      "",
      "     {% load critiqs %}",
      "     …",
      "     {% critiqs %}",
      "     </body>",
      "",
      ...envAdvice(settings, "Django"),
      "Or name the template for setup to edit with --entry <template>.",
    ].join("\n");
  },
};

/** What the CRITIQS dict should say: a Python expression per key, null to remove it, undefined to leave it. */
function desiredDjango(settings) {
  return {
    PROJECT_ID: projectIdValue(settings),
    REQUIRE_PROJECT_ID: settings.requireProjectId ? { remove: ["True"] } : { text: "False" },
    BACKEND: settings.backend === undefined ? undefined : { string: settings.backend },
  };
}

/** The CRITIQS dict as setup reads it: settings as the code gives them. */
function djangoSettings(config) {
  return {
    projectId: config.has("PROJECT_ID") ? readSetting(config.get("PROJECT_ID")) : { kind: "env", variable: VARIABLE },
    backend: config.has("BACKEND") ? readSetting(config.get("BACKEND")) : null,
    requireProjectId: config.get("REQUIRE_PROJECT_ID") !== "False",
  };
}

// Setup names installing the package itself, from the app's requirements, and
// what each deployment sets with the variable, so these are only Django's own.
function djangoNext() {
  return ["Run python manage.py collectstatic when you deploy, so Critiqs's script (critiqs/element.js) is served."];
}

/** The settings module manage.py names, as `{ file, source }`, a `{ problem }`, or null. */
function settingsFile(root) {
  const module = /DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/.exec(readText(join(root, "manage.py")) ?? "")?.[1];
  if (module === undefined) return null;
  const base = join(root, ...module.split("."));
  for (const file of [`${base}.py`, join(base, "__init__.py")]) {
    const source = readText(file);
    if (source !== null) return { file, source };
  }
  return { problem: `manage.py names the settings module ${module}, but neither ${relative(root, base)}.py nor ${relative(root, base)}/__init__.py exists, so nothing was changed.` };
}

/**
 * The folders `TEMPLATES[...]["DIRS"]` lists in the settings, where Django
 * also looks for templates: each entry written as a path from `BASE_DIR`
 * (`BASE_DIR / "a" / "b"`, `os.path.join(BASE_DIR, "a", "b")`) or as a
 * string. Entries setup can't read are left out, as before.
 */
export function templateDirs(root, settings) {
  if (settings === null || "problem" in settings || settings.source === null) return [];
  const { source, file } = settings;
  const templates = findAssignment(source, "TEMPLATES");
  if (templates === null || "expression" in templates) return [];
  const baseDir = baseDirOf(source, file);
  const dirs = [];
  // Comments blanked out, so a commented-out DIRS isn't read.
  const text = withoutComments(source);
  const key = /["']DIRS["'][ \t]*:[ \t]*/g;
  key.lastIndex = templates.open;
  for (let match; (match = key.exec(text)) !== null && match.index < templates.close; ) {
    const open = match.index + match[0].length;
    if (!"[(".includes(source[open])) continue;
    const close = matchBracket(source, open);
    if (close === -1) continue;
    for (const item of splitItems(source, open, close)) {
      const dir = templateDir(item.text.trim(), baseDir, root);
      if (dir !== null) dirs.push(dir);
    }
  }
  return dirs;
}

const PY_STRING = /^(["'])([^"'\\]*)\1$/;

/** One `DIRS` entry as a folder, or null when it isn't written in a form setup reads. */
function templateDir(text, baseDir, root) {
  const literal = PY_STRING.exec(text);
  if (literal !== null) return resolve(root, literal[2]);
  if (baseDir === null) return null;
  const parts = (list) => (list.every((part) => PY_STRING.test(part)) ? list.map((part) => PY_STRING.exec(part)[2]) : null);
  const divided = text.split(/\s*\/\s*/);
  if (divided[0] === "BASE_DIR" && divided.length > 1) {
    const names = parts(divided.slice(1));
    return names === null ? null : join(baseDir, ...names);
  }
  const joined = /^os\.path\.join\(\s*BASE_DIR\s*,([^()]*)\)$/.exec(text);
  if (joined !== null) {
    const names = parts(joined[1].split(",").map((part) => part.trim()).filter((part) => part !== ""));
    return names === null ? null : join(baseDir, ...names);
  }
  return null;
}

/** The folder `BASE_DIR` names, when the settings set it the way Django's template does, or null. */
function baseDirOf(source, file) {
  const line = /^BASE_DIR[ \t]*=[ \t]*(.+)$/m.exec(source)?.[1]?.trim() ?? null;
  if (line === null) return null;
  const pathlib = /^Path\(__file__\)\.resolve\(\)((?:\.parent)+)$/.exec(line);
  const ospath = /^((?:os\.path\.dirname\()+)os\.path\.abspath\(__file__\)(\)+)$/.exec(line);
  const calls = ospath === null ? 0 : ospath[1].split("(").length - 1;
  const levels = pathlib !== null ? pathlib[1].split(".parent").length - 1 : ospath !== null && ospath[2].length === calls ? calls : 0;
  if (levels === 0) return null;
  let dir = file;
  for (let i = 0; i < levels; i++) dir = dirname(dir);
  return dir;
}

/** Adds APP to the INSTALLED_APPS list or tuple, keeping its layout. */
function addInstalledApp(source) {
  if (new RegExp(`["']${APP}(?:\\.apps\\.\\w+)?["']`).test(withoutComments(source))) return { source };
  const list = findAssignment(source, "INSTALLED_APPS");
  if (list === null || "expression" in list || !"[(".includes(source[list.open])) return { problem: "INSTALLED_APPS isn't a list or tuple setup can edit" };
  const items = splitItems(source, list.open, list.close);
  const quote = /^["']/.exec(items[0]?.text ?? "")?.[0] ?? '"';
  return { source: insertItem(source, list, items, `${quote}${APP}${quote}`) };
}

// ---------------------------------------------------------------------------
// Shared with flask.mjs: plans, settings and environment

/** The project ID setting: a string, an `os.environ.get(...)` expression, or removed when it's the default variable. */
export function projectIdValue(settings) {
  if ("literal" in settings.projectId) return { string: settings.projectId.literal };
  const { variable } = settings.projectId.env;
  return variable === VARIABLE ? { remove: [], read: { kind: "env", variable } } : { text: `os.environ.get("${variable}")`, needsOs: true, read: { kind: "env", variable } };
}

/** Sentences about the environment variable, for manual instructions and next steps. */
export function envAdvice(settings, framework) {
  if ("literal" in settings.projectId) return [];
  const { variable } = settings.projectId.env;
  return [
    `Set ${variable} in each deployment's environment to that deployment's project ID; ${framework} reads it on each request, so restart the server after changing it. ` +
      "Critiqs renders nothing where it is unset.",
  ];
}

/** The result of a plan from its writes and the settings before and after. */
export function finishPlan({ writes, file, line, before, after, settings, next }) {
  writes = writes.map((write) => ({ ...write, source: keepLineEndings(write.original ?? "", write.source) }));
  const names = ["projectId", ...(settings.backend === undefined ? [] : ["backend"]), "requireProjectId"];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = before === undefined ? names : names.filter((name) => !same(before[name], after[name]));
  const preview = writes.flatMap((write) => [`${write.file}:`, ...changedLines(write.original ?? "", write.source)]);
  return {
    ok: true,
    action: writes.length === 0 ? "unchanged" : before === undefined ? "install" : "update",
    writes,
    file,
    line,
    changed: writes.length === 0 ? [] : changed,
    preview: preview.join("\n"),
    next: writes.length === 0 ? [] : next,
  };
}

/** `source` with CRLF line endings throughout when `original` uses only CRLF, so lines setup adds match the file's. */
function keepLineEndings(original, source) {
  return original.includes("\r\n") && !/(?:^|[^\r])\n/.test(original) ? source.replace(/\r?\n/g, "\r\n") : source;
}

/** The lines `after` adds and removes from `before`, one hunk per edit, without context. */
export function changedLines(before, after) {
  const split = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").map((line) => line.replace(/\r$/, ""));
  const a = split(before);
  const b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  /** Each line of the middle as kept ("="), added ("+") or removed ("-"), then the common end. */
  const ops = [];
  if (x.length * y.length > 1_000_000) ops.push(...x.map((text) => ({ op: "-", text })), ...y.map((text) => ({ op: "+", text })));
  else {
    // Longest common subsequence of the differing middle, so separate edits show separately.
    const common = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) common[i][j] = x[i] === y[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
    for (let i = 0, j = 0; i < x.length || j < y.length; ) {
      if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ op: "=", text: (i++, y[j++]) });
      else if (j < y.length && (i === x.length || common[i][j + 1] >= common[i + 1][j])) ops.push({ op: "+", text: y[j++] });
      else ops.push({ op: "-", text: x[i++] });
    }
  }
  ops.push(...b.slice(b.length - end).map((text) => ({ op: "=", text })));
  // Slide each run of only added or only removed lines down while the line after it repeats its first,
  // as git does, so a block appended after a matching line (a new dict after one that ends in "}") shows whole.
  for (let s = 0; s < ops.length; s++) {
    if (ops[s].op === "=") continue;
    let e = s;
    while (e < ops.length && ops[e].op === ops[s].op) e++;
    if (e < ops.length && ops[e].op === "=" && ops[e].text === ops[s].text && (s === 0 || ops[s - 1].op === "=")) {
      [ops[s], ops[e]] = [ops[e], ops[s]];
    }
  }
  return ops.filter(({ op }) => op !== "=").map(({ op, text }) => `${op} ${text}`);
}

export function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function indent(text, prefix) {
  return text.split("\n").map((line) => (line === "" ? line : prefix + line)).join("\n");
}

// ---------------------------------------------------------------------------
// Shared with flask.mjs: reading and editing Python source

/** A Python string literal for `value`. */
export function pyString(value, quote = '"') {
  return quote + value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`) + quote;
}

/** A setting as Python code gives it: a string, an environment variable, or other code. */
export function readSetting(text) {
  const string = /^[uU]?(["'])((?:(?!\1)[^\\\n])*)\1$/.exec(text);
  if (string !== null) return { kind: "literal", value: string[2] };
  const env = /^os\.(?:environ\.get|getenv)\(\s*(["'])(\w+)\1\s*\)$|^os\.environ\[\s*(["'])(\w+)\3\s*\]$/.exec(text);
  if (env !== null) return { kind: "env", variable: env[2] ?? env[4] };
  if (text === "None") return null;
  return { kind: "expression", text };
}

/** Whether `text`, the code a setting has now (undefined when absent), already gives what `want` asks for. */
export function satisfies(text, want) {
  if (want.remove !== undefined && (text === undefined || want.remove.includes(text))) return true;
  if (text === undefined) return false;
  if (want.string !== undefined) return JSON.stringify(readSetting(text)) === JSON.stringify({ kind: "literal", value: want.string });
  if (want.read !== undefined) return JSON.stringify(readSetting(text)) === JSON.stringify(want.read);
  return text === want.text;
}

export function valueText(want, quote) {
  return want.string !== undefined ? pyString(want.string, quote) : want.text;
}

/** The entries a new dict gets: every wanted value that isn't a removal. */
function desiredEntries(desired, quote) {
  return Object.entries(desired).filter(([, want]) => want !== undefined && want.remove === undefined).map(([key, want]) => [key, valueText(want, quote)]);
}

function dictBlock(name, entries, quote) {
  if (entries.length === 0) return null;
  return [`${name} = {`, ...entries.map(([key, value]) => `    ${pyString(key, quote)}: ${value},`), "}"].join("\n");
}

/** The quote character a Python file mostly uses. */
export function preferredQuote(source) {
  return (source.match(/'/g)?.length ?? 0) > (source.match(/"/g)?.length ?? 0) ? "'" : '"';
}

/**
 * Makes the module-level dict `name` give each `desired` key, keeping its
 * other entries and layout, or adds the dict at the end of the file. Returns
 * `{ source, needsOs }`, or `{ problem, reason }` when it can't edit safely.
 */
export function writeDictSettings(source, name, desired, { comment }) {
  const quote = preferredQuote(source);
  let needsOs = false;
  for (const [key, want] of Object.entries(desired)) {
    if (want === undefined) continue;
    const dict = findAssignment(source, name, { whole: true });
    if (dict === null) {
      if (want.remove !== undefined) continue;
      const block = dictBlock(name, [[key, valueText(want, quote)]], quote);
      source = `${source.replace(/\s*$/, "")}\n\n\n${comment.map((line) => `# ${line}`).join("\n")}\n\n${block}\n`;
      needsOs ||= want.needsOs === true;
      continue;
    }
    if ("expression" in dict || source[dict.open] !== "{") return { reason: "expression", problem: `${name} isn't written as one {…} dict setup can edit` };
    const entries = readEntries(source, dict);
    if (entries === null) return { reason: "expression", problem: `${name} has entries setup can't read` };
    const entry = entries.find((e) => e.key === key);
    if (satisfies(entry?.value, want)) continue;
    if (entry !== undefined && !readable(entry.value)) return { reason: "expression", problem: `${name}'s ${key} is code setup can't read` };
    needsOs ||= want.needsOs === true;
    if (entry !== undefined && want.remove !== undefined) source = removeItem(source, dict, entry);
    else if (entry !== undefined) {
      const entryQuote = /^["']/.exec(entry.value)?.[0] ?? /^["']/.exec(entry.text)?.[0] ?? quote;
      source = source.slice(0, entry.valueStart) + valueText(want, entryQuote) + source.slice(entry.end);
    }
    else {
      const keyQuote = /^["']/.exec(entries[0]?.text ?? "")?.[0] ?? quote;
      source = insertItem(source, dict, splitItems(source, dict.open, dict.close), `${pyString(key, keyQuote)}: ${valueText(want, quote)}`);
    }
  }
  return { source, needsOs: needsOs && !importsOs(source) };
}

/** Whether setup can read what a setting's code gives, so it may replace or remove it. */
export function readable(text) {
  return /^(?:True|False)$/.test(text) || readSetting(text)?.kind !== "expression";
}

/** Whether the module binds the name `os` with a top-level `import os` (or `import os.path`); `from os import …` and `import os as …` don't. */
export function importsOs(source) {
  return [...source.matchAll(/^import[ \t]+([^\n#]+)/gm)].some((match) => match[1].split(",").some((part) => /^os(?:\.\w+)*$/.test(part.trim())));
}

/** The module-level dict `name` as a map from key to value code; empty when absent or unreadable. */
export function readDict(source, name) {
  const dict = findAssignment(source, name, { whole: true });
  if (dict === null || "expression" in dict || source[dict.open] !== "{") return new Map();
  return new Map((readEntries(source, dict) ?? []).map((entry) => [entry.key, entry.value]));
}

function readEntries(source, dict) {
  const entries = [];
  for (const item of splitItems(source, dict.open, dict.close)) {
    const match = /^[uU]?(["'])(\w+)\1\s*:\s*/.exec(item.text);
    if (match === null) return null;
    entries.push({ ...item, key: match[2], valueStart: item.start + match[0].length, value: item.text.slice(match[0].length) });
  }
  return entries;
}

/**
 * The module-level assignment `name = …` (or `name: type = …`): null when the
 * code never mentions `name`, `{ open, close }` for the bracket its value
 * starts with, or `{ expression }` when the value is other code. With `whole`,
 * the value must be that one bracketed literal and the code's only mention of
 * `name`, so nothing else (an assignment inside an `if`, `|=`, a later
 * `name[…] = …`) changes it.
 */
export function findAssignment(source, name, { whole = false } = {}) {
  const code = codeOnly(source);
  const match = new RegExp(`^${name}[ \\t]*(?::[^=\\n]+)?=(?!=)[ \\t]*`, "m").exec(code);
  const mentions = code.match(new RegExp(`(?<![\\w.])${name}\\b`, "g"))?.length ?? 0;
  if (match === null) return mentions === 0 ? null : { expression: true };
  const open = match.index + match[0].length;
  const close = "[({".includes(source[open]) ? matchBracket(source, open) : -1;
  if (close === -1) return { expression: true };
  if (whole && (mentions > 1 || !/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.test(source.slice(close + 1)))) return { expression: true };
  return { open, close };
}

/** `source` with each comment and string blanked out, keeping every index and line break. */
export function codeOnly(source) {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const skipped = skipPython(source, i);
    if (skipped === i) out += source[i++];
    else {
      out += source.slice(i, skipped).replace(/[^\r\n]/g, " ");
      i = skipped;
    }
  }
  return out;
}

/** `source` with each comment blanked out, strings kept. */
function withoutComments(source) {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const skipped = skipPython(source, i);
    if (skipped === i) out += source[i++];
    else {
      out += source[i] === "#" ? " ".repeat(skipped - i) : source.slice(i, skipped);
      i = skipped;
    }
  }
  return out;
}

/** Skips a string or comment starting at `i`, returning the index after it, or `i` when there is none. */
function skipPython(source, i) {
  const c = source[i];
  if (c === "#") {
    const end = source.indexOf("\n", i);
    return end === -1 ? source.length : end;
  }
  if (c !== '"' && c !== "'") return i;
  const triple = source.startsWith(c.repeat(3), i);
  const closing = triple ? c.repeat(3) : c;
  let j = i + closing.length;
  while (j < source.length) {
    if (source[j] === "\\") j += 2;
    else if (source.startsWith(closing, j)) return j + closing.length;
    else if (!triple && source[j] === "\n") return j;
    else j++;
  }
  return source.length;
}

/** The index of the bracket that closes the one at `open`, or -1. */
export function matchBracket(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; ) {
    const skipped = skipPython(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if ("([{".includes(source[i])) depth++;
    else if (")]}".includes(source[i]) && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** The comma-separated items between brackets, as `{ start, end, text, comma }` without surrounding space or comments. */
export function splitItems(source, open, close) {
  const items = [];
  let depth = 0;
  let start = -1;
  let end = -1;
  const finish = (comma) => {
    if (start !== -1) items.push({ start, end, text: source.slice(start, end), comma });
    start = -1;
  };
  for (let i = open + 1; i < close; ) {
    const skipped = skipPython(source, i);
    if (skipped !== i) {
      if (source[i] !== "#") {
        if (start === -1) start = i;
        end = skipped;
      }
      i = skipped;
      continue;
    }
    const c = source[i];
    if (depth === 0 && c === ",") finish(i);
    else if (!/\s/.test(c)) {
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      if (start === -1) start = i;
      end = i + 1;
    }
    i++;
  }
  finish(-1);
  return items;
}

function lineStart(source, index) {
  return source.lastIndexOf("\n", index - 1) + 1;
}

/** Adds `text` as the last item of a bracketed list, on its own line when the list is laid out one item per line. */
function insertItem(source, list, items, text) {
  const last = items.at(-1);
  const closeLine = lineStart(source, list.close);
  if (/^[ \t]*$/.test(source.slice(closeLine, list.close))) {
    const itemIndent = last === undefined ? `${source.slice(closeLine, list.close)}    ` : /^[ \t]*/.exec(source.slice(lineStart(source, last.start)))[0];
    const withComma = last === undefined || last.comma !== -1 ? source : source.slice(0, last.end) + "," + source.slice(last.end);
    const at = closeLine + (withComma.length - source.length);
    return `${withComma.slice(0, at)}${itemIndent}${text},\n${withComma.slice(at)}`;
  }
  const separator = last === undefined ? "" : last.comma === -1 ? ", " : " ";
  // An empty tuple's one item needs its comma: ("app",), not ("app").
  const comma = last === undefined && source[list.open] === "(" ? "," : "";
  return source.slice(0, list.close) + separator + text + comma + source.slice(list.close);
}

/** Removes one item, with its whole line when it has a line to itself. */
function removeItem(source, list, item) {
  const after = item.comma === -1 ? item.end : item.comma + 1;
  const start = lineStart(source, item.start);
  const lineEnd = source.indexOf("\n", after);
  if (/^[ \t]*$/.test(source.slice(start, item.start)) && /^[ \t]*(#[^\r]*)?\r?$/.test(source.slice(after, lineEnd === -1 ? undefined : lineEnd)) && lineEnd !== -1) {
    return source.slice(0, start) + source.slice(lineEnd + 1);
  }
  const trailing = /^\s*/.exec(source.slice(after))[0].length;
  return source.slice(0, item.start) + source.slice(after + (item.comma === -1 ? 0 : trailing));
}

/** Adds an import statement after the module's leading imports, or at the top. */
export function addImport(source, statement) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let at = -1;
  for (let i = 0; i < source.length; ) {
    let end = lineEnd(source, i);
    // Lines are read without the \r of a CRLF line ending.
    const line = source.slice(i, end).replace(/\r$/, "");
    if (/^(?:import|from)\s/.test(line)) {
      // The statement runs on past a ( until its ), and past a line ending in \.
      for (let from = i; ; ) {
        const code = source.slice(from, commentStart(source, from, end)).replace(/\r$/, "");
        const paren = code.indexOf("(");
        if (paren !== -1) {
          const close = matchBracket(source, from + paren);
          if (close !== -1) end = lineEnd(source, close);
          break;
        }
        if (!code.endsWith("\\") || end >= source.length) break;
        from = end + 1;
        end = lineEnd(source, from);
      }
      at = end;
    } else if (at === -1 && /^[rRuU]?("""|''')/.test(line)) {
      end = skipPython(source, line.search(/["']/) + i);
    } else if (at !== -1 && /^[^\s#]/.test(line)) break;
    i = end + 1;
  }
  if (at === -1) return `${statement}${eol}${source}`;
  if (source[at] === "\n" && source[at - 1] === "\r") at--;
  return `${source.slice(0, at)}${eol}${statement}${source.slice(at)}`;
}

function lineEnd(source, index) {
  const end = source.indexOf("\n", index);
  return end === -1 ? source.length : end;
}

/** Where the comment on the line from `from` to `end` starts, outside strings, or `end`. */
function commentStart(source, from, end) {
  for (let i = from; i < end; ) {
    if (source[i] === "#") return i;
    const skipped = skipPython(source, i);
    i = skipped === i ? i + 1 : skipped;
  }
  return end;
}

// ---------------------------------------------------------------------------
// Shared with flask.mjs: templates

const SKIP = new Set(["node_modules", "__pycache__", "venv", "env", "site-packages", "dist", "build", "staticfiles", "media", "htmlcov"]);
const TEMPLATE_EXTENSIONS = new Set([".html", ".htm", ".jinja", ".jinja2", ".j2"]);

/** Files under `root` matching `keep`, skipping virtual environments, dependencies, and hidden folders. */
export function walk(root, keep, depth = 8) {
  const found = [];
  const visit = (dir, level) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {}
    if (entries.some((e) => e.name === "pyvenv.cfg")) return;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (level < depth && !e.name.startsWith(".") && !SKIP.has(e.name)) visit(path, level + 1);
      } else if (e.isFile() && keep(path)) found.push(path);
    }
  };
  visit(root, 0);
  return found;
}

/**
 * Template files in any `templates` folder or in one of `folders`, with the
 * name a view loads them by; with `only`, just those in `folders`, for an app
 * that loads templates from nowhere else.
 */
export function templateFiles(root, folders = [], only = false) {
  const folderOf = (file) => folders.find((folder) => file.startsWith(folder + sep));
  const searched = (path) => folderOf(path) !== undefined || (!only && path.split(sep).includes("templates"));
  return walk(root, (path) => TEMPLATE_EXTENSIONS.has(extname(path)) && searched(path)).map((file) => {
    const folder = folderOf(file);
    const parts = relative(root, file).split(sep);
    const name = folder !== undefined ? relative(folder, file).split(sep).join("/") : parts.slice(parts.lastIndexOf("templates") + 1).join("/");
    return { file, name, source: readText(file) ?? "" };
  });
}

/**
 * The template every page extends: `preferred` when it exists, else the one
 * most templates extend. `{ template }`, or `{ reason, problem }`.
 */
export function chooseBase(templates, preferred) {
  const top = templates.find((t) => t.file === preferred);
  if (top !== undefined) return { template: top };
  const counts = new Map();
  for (const t of templates) {
    for (const m of t.source.matchAll(/\{%-?\s*extends\s+(["'])([^"']+)\1/g)) counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
  }
  const most = Math.max(0, ...counts.values());
  const names = [...counts].filter(([, count]) => count === most).map(([name]) => name);
  const candidates = templates.filter((t) => names.includes(t.name));
  if (candidates.length === 1) return { template: candidates[0] };
  if (candidates.length > 1) {
    return {
      reason: "ambiguous",
      problem: `Several templates could be the one every page extends, so nothing was changed:\n${candidates.map((t) => `  ${t.file}`).join("\n")}\nChoose one with --entry <template>.`,
    };
  }
  return { reason: "manual", problem: `Setup didn't find a base template that other templates extend (such as ${basename(dirname(preferred))}/base.html), so nothing was changed.` };
}

/**
 * Puts `tag` just before the template's one </body>, on its own line when
 * </body> has one, or at the end of a base template without one, unless
 * `existing` already appears. `prepare` makes other
 * edits first (such as Django's {% load %}). `{ source, line }` or null.
 */
export function placeTemplateTag(source, tag, existing, prepare) {
  const pattern = new RegExp(existing.source, existing.flags.replace("g", ""));
  if (pattern.test(source)) {
    const prepared = prepare(source);
    return { source: prepared, line: lineAt(prepared, prepared.search(pattern)) };
  }
  const prepared = prepare(source);
  const bodies = [...prepared.matchAll(/<\/body\s*>/gi)];
  // A base template may leave out <body> (as Flask's tutorial does): its end is the page's end.
  if (bodies.length === 0 && !/\{%-?\s*extends\s/.test(prepared)) {
    const trimmed = prepared.replace(/\s*$/, "\n");
    return { source: `${trimmed}${tag}\n`, line: lineAt(trimmed, trimmed.length) };
  }
  if (bodies.length !== 1) return null;
  const at = bodies[0].index;
  const start = lineStart(prepared, at);
  const before = prepared.slice(start, at);
  if (!/^[ \t]*$/.test(before)) return { source: prepared.slice(0, at) + tag + prepared.slice(at), line: lineAt(prepared, at) };
  const previous = prepared.slice(0, start).split("\n").slice(0, -1).reverse().find((line) => line.trim() !== "") ?? "";
  const previousIndent = /^[ \t]*/.exec(previous)[0];
  const tagIndent = previousIndent.length >= before.length ? previousIndent : before;
  return { source: `${prepared.slice(0, start)}${tagIndent}${tag}\n${prepared.slice(start)}`, line: lineAt(prepared, start) };
}

/** Adds {% load critiqs %} after {% extends %} or the leading {% load %} lines, or as the first line. */
function addDjangoLoad(source) {
  const lines = source.split("\n");
  let after = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\{%-?\s*(?:extends|load)\s/.test(line)) after = i;
    else if (line !== "" && !/^\{#.*#\}$/.test(line)) break;
  }
  lines.splice(after + 1, 0, "{% load critiqs %}");
  return lines.join("\n");
}
