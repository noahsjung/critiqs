// Flask setup: adds `Critiqs(app)` where the app is created with
// `Flask(__name__)`, `app.config["CRITIQS_…"]` lines for the settings the
// person chose, and {{ critiqs() }} to the base template every page extends.
// The project ID comes from the CRITIQS_PROJECT_ID environment variable on
// each request unless the config names one.
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  addImport,
  chooseBase,
  codeOnly,
  envAdvice,
  finishPlan,
  importsOs,
  indent,
  lineAt,
  matchBracket,
  placeTemplateTag,
  preferredQuote,
  projectIdValue,
  pyString,
  readable,
  readSetting,
  satisfies,
  templateFiles,
  valueText,
  walk,
} from "./django.mjs";
import { readText } from "./shared.mjs";

const VARIABLE = "CRITIQS_PROJECT_ID";
const CALL = /\{\{-?\s*critiqs\([^)]*\)\s*-?\}\}/g;
const CREATES_APP = /\bFlask\(\s*__name__\b/;
const ASSIGNS_APP = /^([ \t]*)(\w+)\s*(?::[^=\n]+)?=\s*Flask\(\s*__name__\b/gm;
const CONFIG_LINE = /^[ \t]*\w+\.config\[\s*(["'])(CRITIQS_\w+)\1\s*\]\s*=\s*(.*?)[ \t]*(?:#.*)?$/gm;
const KEYS = { PROJECT_ID: "CRITIQS_PROJECT_ID", REQUIRE_PROJECT_ID: "CRITIQS_REQUIRE_PROJECT_ID", BACKEND: "CRITIQS_BACKEND" };

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const flask = {
  id: "flask",
  name: "Flask",
  install: { ecosystem: "pypi", package: "flask-critiqs" },
  detect: (root) => listsPackage(root, "flask") || appFiles(root, 2).length > 0,
  env: (root, suffix) => ({
    variable: `${VARIABLE}${suffix}`,
    expression: `os.environ.get("${VARIABLE}${suffix}")`,
    readsAt: "runtime",
    // flask-critiqs depends on python-dotenv, so `flask run` and app.run() load
    // .env; a deployment's WSGI server doesn't.
    localFile: ".env",
    deploymentAdvice:
      `Set ${VARIABLE}${suffix} in each deployment's environment to that deployment's project ID; Flask reads it on each request, so restart the server after changing it. ` +
      "Leave it unset where Critiqs shouldn't appear.",
  }),
  find(root) {
    const files = appFiles(root);
    const config = files.length === 1 ? readConfig(readText(files[0]) ?? "") : new Map();
    const search = files.length === 1 ? templateFolder(files[0]) : { folders: files.flatMap((file) => templateFolder(file).folders), only: false };
    return findCalls(root, withBlueprints(root, search, blueprints(root)), config);
  },
  plan(root, settings, options) {
    const refuse = (reason, problem) => ({ ok: false, reason, message: `${problem}\n\n${flask.manual(settings)}` });
    const entry = options.entry === null ? null : resolve(root, options.entry);
    if (entry !== null && readText(entry) === null) return refuse("manual", `${options.entry} is not a file in this app.`);

    const files = entry?.endsWith(".py") ? [entry] : appFiles(root);
    if (files.length === 0) return refuse("manual", "Setup didn't find where the app is created with Flask(__name__), so nothing was changed.");
    if (files.length > 1) return refuse("ambiguous", `Found ${files.length} files that create a Flask app, so nothing was changed:\n${files.map((f) => `  ${f}`).join("\n")}\nChoose one with --entry <file>.`);
    const [file] = files;
    const original = readText(file);
    // A module beside the app that imports the extension (say extensions.py with `critiqs = Critiqs()`) may register it.
    const elsewhere = pythonFiles(root).filter((path) => path !== file && /\bflask_critiqs\b/.test(readText(path) ?? ""));
    const app = addExtension(original, desiredFlask(settings), elsewhere);
    if ("problem" in app) return refuse(app.reason, `${file}: ${app.problem}, so nothing was changed.`);

    const search = templateFolder(file);
    // Existing calls may be in a blueprint's own template folder too, under a page that extends the app's base.
    const known = blueprints(root);
    const unreadable = known.find((blueprint) => blueprint.folder === null);
    if (unreadable !== undefined) return refuse("ambiguous", `${unreadable.file} makes a Blueprint whose template_folder setup can't read, so it can't tell whether a page there already renders {{ critiqs() }}, and nothing was changed.`);
    const usages = findCalls(root, withBlueprints(root, search, known), readConfig(original));
    const appCode = codeOnly(original);
    const stray = usages.find(
      (usage) =>
        !search.folders.some((folder) => usage.file.startsWith(folder + sep)) &&
        known.some((blueprint) => usage.file.startsWith(blueprint.folder + sep) && !registers(appCode, blueprint.name)),
    );
    if (stray !== undefined) {
      return refuse("ambiguous", `{{ critiqs() }} is in ${stray.file}:${stray.line}, in a blueprint's templates, and setup can't tell whether ${file} registers that blueprint, so nothing was changed.`);
    }
    if (usages.length > 1) {
      return refuse("ambiguous", `Found ${usages.length} {{ critiqs() }} calls, so nothing was changed:\n${usages.map((u) => `  ${u.file}:${u.line}`).join("\n")}\nKeep one, in the template every page extends.`);
    }
    if (usages.length === 1 && entry !== null && !entry.endsWith(".py") && entry !== usages[0].file) {
      return refuse("ambiguous", `Critiqs is already in ${usages[0].file}:${usages[0].line}, so setup didn't add a second {{ critiqs() }} to ${options.entry}.`);
    }
    const chosen =
      entry !== null && !entry.endsWith(".py")
        ? { template: { file: entry, source: readText(entry) } }
        : usages.length === 1
          ? { template: { file: usages[0].file, source: readText(usages[0].file) } }
          : chooseBase(templateFiles(root, search.folders, search.only), join(search.folders[0] ?? join(dirname(file), "templates"), "base.html"));
    if ("problem" in chosen) return refuse(chosen.reason, chosen.problem);
    const { template } = chosen;
    const placed = placeTemplateTag(template.source, "{{ critiqs() }}", CALL, (source) => source);
    if (placed === null) return refuse("unreadable", `${template.file} has more than one </body>, or extends another template, so setup can't tell where {{ critiqs() }} goes and nothing was changed.`);

    const writes = [
      { file, original, source: app.source },
      { file: template.file, original: template.source, source: placed.source },
    ].filter((write) => write.source !== write.original);
    return finishPlan({
      writes,
      file: template.file,
      line: placed.line,
      before: usages[0],
      after: flaskSettings(readConfig(app.source)),
      settings,
      // Setup names installing the package, from the app's requirements, and what each deployment sets.
      next: [],
    });
  },
  manual(settings) {
    const config = Object.entries(desiredFlask(settings))
      .filter(([, want]) => want !== undefined && want.remove === undefined)
      .map(([key, want]) => `app.config["${key}"] = ${valueText(want, '"')}`);
    return [
      "To add Critiqs to this Flask app by hand:",
      "1. Install the package in the app's environment and add it to your requirements: pip install flask-critiqs",
      "2. Where the app is created, add the extension:",
      "",
      indent(["from flask_critiqs import Critiqs", "", "app = Flask(__name__)", ...config, "Critiqs(app)"].join("\n"), "     "),
      "",
      "   In an app factory, do the same inside create_app().",
      "3. In the template every page extends (usually templates/base.html), render it just before </body>:",
      "",
      "     {{ critiqs() }}",
      "     </body>",
      "",
      ...envAdvice(settings, "Flask"),
      "Or name the file for setup to edit with --entry <app file or template>.",
    ].join("\n");
  },
};

/** What the CRITIQS_ config should say, as for Django's CRITIQS dict. */
function desiredFlask(settings) {
  return {
    [KEYS.PROJECT_ID]: projectIdValue(settings),
    [KEYS.REQUIRE_PROJECT_ID]: settings.requireProjectId ? { remove: ["True"] } : { text: "False" },
    [KEYS.BACKEND]: settings.backend === undefined ? undefined : { string: settings.backend },
  };
}

function flaskSettings(config) {
  return {
    projectId: config.has(KEYS.PROJECT_ID) ? readSetting(config.get(KEYS.PROJECT_ID).value) : { kind: "env", variable: VARIABLE },
    backend: config.has(KEYS.BACKEND) ? readSetting(config.get(KEYS.BACKEND).value) : null,
    requireProjectId: config.get(KEYS.REQUIRE_PROJECT_ID)?.value !== "False",
  };
}

/** The {{ critiqs() }} calls in the templates `search` covers (see templateFolder). */
function findCalls(root, search, config) {
  return templateFiles(root, search.folders, search.only).flatMap((template) =>
    [...template.source.matchAll(CALL)].map((match) => ({ file: template.file, line: lineAt(template.source, match.index), ...flaskSettings(config) })),
  );
}

/**
 * Where the app in `file` loads templates from, as `{ folders, only }`: its
 * Flask(…, template_folder="…") alone (`only`), so a stale template elsewhere
 * is never chosen; else templates beside it, plus any other `templates`
 * folder, as blueprints use.
 */
function templateFolder(file) {
  const source = readText(file) ?? "";
  const created = ASSIGNS_APP_ONE.exec(source) ?? CREATES_APP.exec(source);
  if (created === null) return { folders: [], only: false };
  const open = source.indexOf("(", created.index + created[0].indexOf("Flask"));
  const close = matchBracket(source, open);
  const named = /\btemplate_folder\s*=\s*["']([^"']+)["']/.exec(source.slice(open, close === -1 ? undefined : close))?.[1];
  const standard = resolve(dirname(file), "templates");
  const folder = named === undefined ? standard : resolve(dirname(file), named);
  return { folders: [folder], only: folder !== standard };
}

/**
 * The Python files' `name = Blueprint(…, template_folder="…")` calls, as
 * `{ file, name, folder }`: the folder resolved beside the file, or null when
 * it isn't a plain string.
 */
function blueprints(root) {
  return pythonFiles(root).flatMap((file) => {
    const source = readText(file) ?? "";
    const code = codeOnly(source);
    return [...code.matchAll(/^[ \t]*(\w+)[ \t]*(?::[^=\n]+)?=[ \t]*(?:\w+\.)*Blueprint\(/gm)].flatMap((match) => {
      const open = match.index + match[0].length - 1;
      const close = matchBracket(source, open);
      const args = source.slice(open, close === -1 ? undefined : close);
      if (!/\btemplate_folder\s*=/.test(code.slice(open, close === -1 ? undefined : close))) return [];
      const named = /\btemplate_folder\s*=\s*["']([^"'\\]+)["']\s*[,)]/.exec(`${args})`)?.[1];
      return [{ file, name: match[1], folder: named === undefined ? null : resolve(dirname(file), named) }];
    });
  });
}

/** `search` with the blueprints' readable template folders added. */
function withBlueprints(root, search, known) {
  const extra = known.map((blueprint) => blueprint.folder).filter((folder) => folder !== null && !search.folders.includes(folder));
  return { folders: [...search.folders, ...extra], only: search.only };
}

/** Whether the app's code (comments and strings blanked) registers the blueprint `name`, as app.register_blueprint(name) or (module.name). */
function registers(code, name) {
  return new RegExp(`\\.register_blueprint\\(\\s*(?:\\w+\\.)*${name}\\s*[,)]`).test(code);
}

/** `app.config["CRITIQS_…"] = value` lines, by key: the value's code and where it and its line are. */
function readConfig(source) {
  const config = new Map();
  for (const match of source.matchAll(CONFIG_LINE)) {
    const valueStart = match.index + match[0].indexOf(match[3], match[0].indexOf("="));
    config.set(match[2], { value: match[3], valueStart, valueEnd: valueStart + match[3].length, lineStart: match.index, lineEnd: match.index + match[0].length });
  }
  return config;
}

/**
 * Adds the import, the config lines `desired` asks for, and `Critiqs(app)`
 * after the one `app = Flask(__name__…)`. `{ source, call }`, or
 * `{ reason, problem }` when the file can't be edited safely.
 */
function addExtension(source, desired, elsewhere) {
  const created = [...source.matchAll(ASSIGNS_APP)];
  if (created.length !== 1) {
    return { reason: created.length === 0 ? "manual" : "ambiguous", problem: created.length === 0 ? "the Flask app isn't assigned to a name setup can add Critiqs(app) after" : "it creates more than one Flask app" };
  }
  const [{ index, 0: text, 1: lineIndent, 2: name }] = created;
  const open = index + text.lastIndexOf("(");
  const close = matchBracket(source, open);
  if (close === -1) return { reason: "unreadable", problem: "setup couldn't read the Flask(…) call" };
  const call = source.slice(open, close + 1);
  // Any other mention of a setting is one setup can't read, such as app.config.update(CRITIQS_BACKEND=…).
  const unread = source.replace(CONFIG_LINE, "");
  for (const key of Object.values(KEYS)) {
    if (new RegExp(`\\b${key}\\b`).test(unread)) return { reason: "expression", problem: `it sets ${key} in a way setup can't read` };
  }
  const quote = preferredQuote(source);
  const afterCall = () => {
    const match = ASSIGNS_APP_ONE.exec(source);
    const end = source.indexOf("\n", matchBracket(source, match.index + match[0].lastIndexOf("(")));
    return end === -1 ? source.length : end + 1;
  };
  // New lines go after the Flask(…) statement and any CRITIQS_ config lines right below it.
  const insertionPoint = () => {
    let at = afterCall();
    for (;;) {
      const lineEnd = source.indexOf("\n", at);
      const line = source.slice(at, lineEnd === -1 ? undefined : lineEnd);
      if (lineEnd === -1 || !/^[ \t]*\w+\.config\[\s*["']CRITIQS_/.test(line)) return at;
      at = lineEnd + 1;
    }
  };
  if (!source.endsWith("\n")) source += "\n";
  for (const [key, want] of Object.entries(desired)) {
    if (want === undefined) continue;
    const existing = readConfig(source).get(key);
    if (satisfies(existing?.value, want)) continue;
    if (existing !== undefined && !readable(existing.value)) return { reason: "expression", problem: `it sets ${key} with code setup can't read` };
    if (existing !== undefined && want.remove !== undefined) source = source.slice(0, existing.lineStart) + source.slice(source.indexOf("\n", existing.lineEnd) + 1);
    else if (existing !== undefined) {
      const valueQuote = /^["']/.exec(existing.value)?.[0] ?? quote;
      source = source.slice(0, existing.valueStart) + valueText(want, valueQuote) + source.slice(existing.valueEnd);
    } else {
      const at = insertionPoint();
      source = `${source.slice(0, at)}${lineIndent}${name}.config[${pyString(key, quote)}] = ${valueText(want, quote)}\n${source.slice(at)}`;
    }
    if (want.needsOs && !importsOs(source)) source = addImport(source, "import os");
  }
  // Registered when the file constructs the extension with the app, or calls init_app(app) on an instance of it,
  // never in a comment or a string; otherwise setup registers it, by the names the file already binds.
  const code = codeOnly(source);
  const at = insertionPoint();
  const bound = bindings(code);
  const classes = bound.filter((b) => b.kind === "class");
  const withApp = `\\s*(?:app\\s*=\\s*)?${name}\\s*[,)]`;
  if (classes.length > 0 && new RegExp(`(?<![\\w.])(?:${classes.map((b) => escape(b.expression)).join("|")})\\(${withApp}`).test(code)) return { source, call };
  const instances = [...localInstances(code, classes), ...importedInstances(bound, elsewhere)];
  if (instances.length > 0 && new RegExp(`(?<![\\w.])(?:${[...new Set(instances.map((i) => i.name))].join("|")})\\.init_app\\(${withApp}`).test(code)) return { source, call };
  const others = elsewhere.filter((path) => !instances.some((instance) => instance.file === path));
  if (others.length > 0) {
    return { reason: "ambiguous", problem: `${others.join(", ")} also uses flask_critiqs, and setup can't tell whether this app already registers the extension` };
  }
  if (instances.length > 0) {
    // An instance made without the app gets init_app(app) where both are in scope.
    const names = [...new Set(instances.map((i) => i.name))];
    const [instance] = instances;
    if (names.length > 1 || instances.length > 1) return { reason: "ambiguous", problem: `it makes more than one Critiqs extension (${names.join(", ")}), and setup can't tell which to register` };
    const appLine = ASSIGNS_APP_ONE.exec(source).index;
    let place = null;
    if (instance.at < at && visibleAt(code, instance, at, lineIndent)) place = at;
    else if (instance.at > appLine && instance.indent === lineIndent && sameBlock(code, appLine, instance.at, lineIndent)) place = instance.end;
    if (place === null) return { reason: "ambiguous", problem: `it makes the extension ${instance.name} where setup can't call ${instance.name}.init_app(${name}) after the app is created` };
    return { source: `${source.slice(0, place)}${lineIndent}${instance.name}.init_app(${name})\n${source.slice(place)}`, call };
  }
  const usable = classes.find((b) => b.at < at && visibleAt(code, b, at, lineIndent));
  source = `${source.slice(0, at)}${lineIndent}${usable?.expression ?? "Critiqs"}(${name})\n${source.slice(at)}`;
  if (usable === undefined) source = addImport(source, "from flask_critiqs import Critiqs");
  return { source, call };
}
const ASSIGNS_APP_ONE = new RegExp(ASSIGNS_APP.source, "m");

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineStartOf = (code, index) => code.lastIndexOf("\n", index - 1) + 1;
const nextLine = (code, index) => {
  const end = code.indexOf("\n", index);
  return end === -1 ? code.length : end + 1;
};

/**
 * What the import statements in `code` (comments and strings blanked) bind,
 * each with where its statement starts (`at`), the line after it (`end`) and
 * its indentation: `{ kind: "class", expression }` for the Critiqs class, as
 * the code calls it (Critiqs, an alias, or flask_critiqs.Critiqs), and
 * `{ kind: "name", name, module, imported }` for any other name.
 */
function bindings(code) {
  const found = [];
  for (const match of code.matchAll(/^([ \t]*)from[ \t]+([.\w]+)[ \t]+import[ \t]*/gm)) {
    const [, indent, module] = match;
    const start = match.index + match[0].length;
    let list;
    let last;
    if (code[start] === "(") {
      last = matchBracket(code, start);
      if (last === -1) continue;
      list = code.slice(start + 1, last);
    } else {
      // A line ending in \ continues the statement.
      for (last = start; ; ) {
        const end = nextLine(code, last);
        if (end === code.length || !/\\\r?\n$/.test(code.slice(last, end))) {
          last = end - 1;
          break;
        }
        last = end;
      }
      list = code.slice(start, last + 1).replace(/\\\r?\n/g, " ");
    }
    const place = { at: match.index, end: nextLine(code, last), indent };
    for (const item of list.split(",")) {
      const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
      if (named === null) continue;
      const [, imported, alias = imported] = named;
      if (module !== "flask_critiqs") found.push({ ...place, kind: "name", name: alias, module, imported });
      else if (imported === "Critiqs") found.push({ ...place, kind: "class", expression: alias });
    }
  }
  for (const match of code.matchAll(/^([ \t]*)import[ \t]+([^\n]+)/gm)) {
    for (const item of match[2].split(",")) {
      const named = /^\s*flask_critiqs(?:\s+as\s+(\w+))?\s*$/.exec(item);
      if (named !== null) found.push({ at: match.index, end: nextLine(code, match.index), indent: match[1], kind: "class", expression: `${named[1] ?? "flask_critiqs"}.Critiqs` });
    }
  }
  return found;
}

/** `name = Critiqs()` in `code`, by any of the `classes` bindings' expressions: instances made without an app. */
function localInstances(code, classes) {
  if (classes.length === 0) return [];
  const made = new RegExp(`^([ \\t]*)(\\w+)[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:${classes.map((b) => escape(b.expression)).join("|")})\\(\\s*\\)[ \\t]*\\r?$`, "gm");
  return [...code.matchAll(made)].map((match) => ({ name: match[2], indent: match[1], at: match.index, end: nextLine(code, match.index), file: null }));
}

/** Names imported from one of the `elsewhere` modules that makes them there, at module level, with `name = Critiqs()`. */
function importedInstances(bound, elsewhere) {
  return bound
    .filter((b) => b.kind === "name")
    .flatMap((b) => {
      const module = b.module.split(".").filter(Boolean).pop();
      if (module === undefined) return [];
      return elsewhere
        .filter((path) => basename(path) === `${module}.py` || (basename(path) === "__init__.py" && basename(dirname(path)) === module))
        .filter((path) => {
          const code = codeOnly(readText(path) ?? "");
          return localInstances(code, bindings(code).filter((c) => c.kind === "class")).some((i) => i.indent === "" && i.name === b.imported);
        })
        .map((path) => ({ name: b.name, indent: b.indent, at: b.at, end: b.end, file: path }));
    });
}

/** Whether what `b` binds, at module level or earlier in the app's own block, is in scope at `at`. */
function visibleAt(code, b, at, appIndent) {
  return b.indent === "" || (b.indent === appIndent && sameBlock(code, b.at, at, appIndent));
}

/** Whether every line after the one at `from`, up to the one at `to`, stays inside a block indented by `indent`. */
function sameBlock(code, from, to, indent) {
  const start = nextLine(code, from);
  if (start >= to) return true;
  return code
    .slice(start, lineStartOf(code, to))
    .split("\n")
    .every((line) => line.trim() === "" || /^[ \t]*/.exec(line)[0].length >= indent.length);
}

/** Python files outside tests. */
function pythonFiles(root, depth = 4) {
  return walk(
    root,
    (path) => path.endsWith(".py") && !/^(?:test_.*|.*_test|conftest)\.py$/.test(basename(path)) && !relative(root, path).split(sep).some((part) => part === "tests" || part === "test"),
    depth,
  );
}

/** Python files that create a Flask app, outside tests. */
function appFiles(root, depth = 4) {
  return pythonFiles(root, depth).filter((path) => CREATES_APP.test(readText(path) ?? ""));
}

/** Whether the app's requirements files, pyproject.toml, or Pipfile list the PyPI package `name`. */
function listsPackage(root, name) {
  const requirement = new RegExp(`^\\s*${name}\\s*(?:\\[[^\\]]*\\]\\s*)?(?:[<>=!~;@#]|$)`, "im");
  const requirementFiles = [
    ...walk(root, (path) => /^requirements[\w.-]*\.(?:txt|in)$/.test(basename(path)), 0),
    ...walk(join(root, "requirements"), (path) => /\.(?:txt|in)$/.test(path), 0),
  ];
  if (requirementFiles.some((file) => requirement.test(readText(file) ?? ""))) return true;
  const quoted = new RegExp(`["']${name}\\s*(?:\\[[^\\]]*\\]\\s*)?(?:[<>=!~;@"']|$)`, "im");
  const keyed = new RegExp(`^\\s*["']?${name}["']?\\s*=`, "im");
  const pyproject = readText(join(root, "pyproject.toml")) ?? "";
  const pipfile = readText(join(root, "Pipfile")) ?? "";
  return quoted.test(pyproject) || keyed.test(pyproject) || keyed.test(pipfile);
}
