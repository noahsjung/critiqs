// Ruby on Rails setup: the critiqs-rails gem in the Gemfile and its
// `<%= critiqs_tag %>` helper in the application layout's <body>. The helper
// reads CRITIQS_PROJECT_ID on each render by default and requires it, so the
// usual call has no arguments. Setup edits only ERB it reads the way Rails
// does: a whole `<%= critiqs_tag ... %>` tag, or a new one before the page's
// </body> outside ERB code, comments and scripts.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describeProjectId, readText } from "./shared.mjs";

const DEVELOPMENT = "config/environments/development.rb";
const GEM = "critiqs-rails";
const LAYOUT = "app/views/layouts/application.html.erb";
const DEFAULT_VARIABLE = "CRITIQS_PROJECT_ID";
const VIEW_FILE = /\.(?:erb|haml|slim)$/;

const gemDeclared = (gemfile, name) => gemDeclarations(gemfile, name).length > 0;

// Blocks that keep a gem in Bundler's default group, so every environment loads it.
const DEFAULT_GROUP_BLOCK = /^(?:source|git|github|path)\b|^group\b[^#]*:default\b/;

/**
 * Where the Gemfile declares `name`, with the line of each declaration that
 * production might not load: one in a group (a `group` block, `group:` or
 * `groups:`), with `require: false`, for some platforms only, or under a
 * block or condition setup can't judge (`platforms`, `install_if`, `if`).
 * A `gem` statement goes on past a line that ends in a comma, an operator
 * or a backslash, or leaves a bracket open, as Ruby reads it, across blank
 * and comment-only lines; its name may be on a later line (`gem(` alone).
 * Bundler loads the rest in every environment.
 */
function gemDeclarations(gemfile, name) {
  const declarations = [];
  const blocks = [];
  const lines = gemfile.split(/\r?\n/);
  const named = new RegExp(`^gem[\\s\\\\(]*["']${name.replace(/[-.]/g, "\\$&")}["']`);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.replace(/^\s+/, "");
    if (line.startsWith("#")) continue;
    if (/^gem\b(?![?!:])/.test(codeOf(raw))) {
      const first = index + 1;
      let statement = codeOf(raw);
      let text = textOf(raw);
      while (continues(statement) && index + 1 < lines.length) {
        const next = lines[++index];
        if (codeOf(next) === "") continue;
        statement += ` ${codeOf(next)}`;
        text += ` ${textOf(next)}`;
      }
      if (named.test(text)) declarations.push({ line: first, limit: limitOf(statement, blocks) });
    } else if (/^end\b/.test(line)) blocks.pop();
    else if (/\bdo\s*(\|[^|]*\|)?\s*(#.*)?$/.test(line) || /^(?:if|unless|case|while|until|begin)\b/.test(line)) blocks.push(line);
  }
  return declarations;
}

/** A Gemfile line's code: comments and string contents blanked, so only its own words are left. */
const codeOf = (line) => (rubySkeleton(line) ?? line.replace(/#.*$/, "")).trim();
/** A Gemfile line without its comment, strings kept. */
function textOf(line) {
  const skeleton = rubySkeleton(line);
  return (skeleton === null ? line.replace(/#.*$/, "") : line.slice(0, skeleton.trimEnd().length)).trim();
}

/** Whether a statement goes on to the next line: it ends in a comma or an operator, or leaves a bracket open. */
function continues(code) {
  if (/[,\\(\[{|&+]$/.test(code)) return true;
  let depth = 0;
  for (const c of code) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return depth > 0;
}

/** What keeps a `gem` statement from loading in every environment, or null. `blocks` are the lines that opened the blocks around it. */
function limitOf(gem, blocks) {
  if (/\bgroups?:|:groups?\s*=>/.test(gem)) return "in a group";
  if (/\brequire:\s*false\b|:require\s*=>\s*false\b/.test(gem)) return "with require: false";
  if (/\bplatforms?:|:platforms?\s*=>/.test(gem)) return "for some platforms only";
  if (/\binstall_if\b|\b(?:if|unless)\b/.test(gem)) return "under a condition";
  const scoped = blocks.find((block) => !DEFAULT_GROUP_BLOCK.test(block));
  return scoped === undefined ? null : `inside \`${scoped.split(/\s+do\b/)[0].trim()}\``;
}

// ---------------------------------------------------------------------------
// Reading critiqs_tag calls

/** Every view file under app/views, sorted for stable output. */
function viewFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && VIEW_FILE.test(entry.name)) files.push(path);
    }
  };
  walk(join(root, "app/views"));
  return files.sort();
}

// Ruby as setup reads it: strings (with #{} interpolation) and comments are
// blanked out of a same-length skeleton, so the commas, brackets and
// keywords left in it are the code's own.

/**
 * `code` with each string's contents and each comment blanked, same length
 * and lines, or null where setup can't follow it: an unclosed string, a
 * heredoc or a %-literal.
 */
function rubySkeleton(code) {
  let out = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(code, i);
      if (end === -1) return null;
      out += c + code.slice(i + 1, end).replace(/[^\r\n]/g, "_") + c;
      i = end + 1;
    } else if (c === "#") {
      const newline = code.indexOf("\n", i);
      const end = newline === -1 ? code.length : newline;
      out += code.slice(i, end).replace(/[^\r]/g, " ");
      i = end;
    } else if (/^<<[~-]?["'`A-Za-z_]/.test(code.slice(i, i + 4)) || (c === "%" && /^%[qQwWiIrsx]?[^\w\s=]/.test(code.slice(i, i + 3)) && (i === 0 || /[\s(,[{:=]/.test(code[i - 1])))) {
      return null;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The index of the quote that closes the string opening at `i`, or -1. `#{...}` in a double-quoted string holds code, with its own strings. */
function stringEnd(code, i) {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === "\\") j++;
    else if (code[j] === quote) return j;
    else if (quote !== "'" && code[j] === "#" && code[j + 1] === "{") {
      j = interpolationEnd(code, j + 2);
      if (j === -1) return -1;
    }
  }
  return -1;
}

/** The index of the `}` that ends the interpolated code starting at `i`, or -1. */
function interpolationEnd(code, i) {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === '"' || c === "'" || c === "`") {
      j = stringEnd(code, j);
      if (j === -1) return -1;
    } else if (c === "{") depth++;
    else if (c === "}" && depth-- === 0) return j;
  }
  return -1;
}

// A keyword at index `lastIndex` of a skeleton, not part of a name, method call or `key:`.
const keywordAt = (words) => new RegExp(`(?<![\\w.:?!@$])(?:${words})(?![\\w?!:])`, "y");
// A trailing modifier ends the call: `critiqs_tag ... if Rails.env.staging?` calls it only then.
const MODIFIER = keywordAt("if|unless|rescue|while|until");
// Code that keeps going past the call, which setup won't edit around.
const MORE_CODE = keywordAt("and|or|not|do|then|end");
const matchesAt = (pattern, text, index) => {
  pattern.lastIndex = index;
  return pattern.test(text);
};

/**
 * A `critiqs_tag` call as setup reads it, from code that is one whole call,
 * maybe followed by a trailing modifier, which stays outside it. Positions
 * are indexes into `code`; each argument spans its own code, without the
 * comma after it or a comment. `close` is the `)` of a parenthesised call.
 * A backslash that continues the line is whitespace to the call, so
 * arguments end before it; `skeleton` keeps it, so edits keep it last on its
 * line. Returns null for code setup can't read: other code around the call,
 * an argument that isn't a keyword (positional or splat), or Ruby it can't
 * follow.
 */
function parseCall(code) {
  const kept = rubySkeleton(code);
  if (kept === null || !/^critiqs_tag\b/.test(kept)) return null;
  const skeleton = kept.replace(/\\(?=\r?\n)/g, " ");
  const nameEnd = "critiqs_tag".length;
  let open = null;
  let close = null;
  let to = skeleton.length;
  if (skeleton[nameEnd] === "(") {
    open = nameEnd;
    let depth = 0;
    for (let i = open; i < skeleton.length && close === null; i++) {
      if ("([{".includes(skeleton[i])) depth++;
      else if (")]}".includes(skeleton[i]) && --depth === 0) close = i;
    }
    if (close === null) return null;
    const rest = skeleton.slice(close + 1);
    const lead = /^\s*/.exec(rest)[0].length;
    if (rest.trim() !== "" && !(lead > 0 && matchesAt(MODIFIER, rest, lead))) return null;
    to = close;
  } else if (nameEnd < skeleton.length && !/\s/.test(skeleton[nameEnd])) {
    return null;
  }

  const parts = [];
  let depth = 0;
  let start = open === null ? nameEnd : open + 1;
  for (let i = start; i < to; i++) {
    const c = skeleton[i];
    if (depth === 0 && /\s/.test(skeleton[i - 1] ?? "")) {
      if (open === null && matchesAt(MODIFIER, skeleton, i)) {
        to = i;
        break;
      }
      if (matchesAt(MORE_CODE, skeleton, i)) return null;
    }
    if (c === ";") return null;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth < 0) return null;
    else if (c === "," && depth === 0) {
      parts.push({ start, end: i, comma: i });
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push({ start, end: to, comma: null });

  const args = [];
  let trailingComma = false;
  for (const [index, part] of parts.entries()) {
    const text = skeleton.slice(part.start, part.end);
    if (text.trim() === "") {
      const last = index === parts.length - 1;
      if (last && index === 0) break;
      if (last && open !== null) {
        trailingComma = true;
        break;
      }
      return null;
    }
    const argStart = part.start + /^\s*/.exec(text)[0].length;
    const argEnd = part.start + text.trimEnd().length;
    const key = /^([a-z_]+):\s+|^:([a-z_]+)\s*=>\s*/.exec(skeleton.slice(argStart, argEnd));
    if (key === null) return null;
    args.push({ key: key[1] ?? key[2], start: argStart, end: argEnd, comma: part.comma, value: readValue(code.slice(argStart + key[0].length, argEnd)) });
  }
  return { skeleton: kept, nameEnd, open, close, args, trailingComma };
}

/** A Ruby value as setup reads it. */
function readValue(text) {
  const t = text.trim();
  let m = /^"((?:[^"\\#]|\\.|#(?!\{))*)"$/.exec(t) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(t);
  if (m) return { kind: "literal", value: m[1].replace(/\\(.)/g, "$1") };
  m = /^ENV\s*\[\s*["']([A-Za-z_]\w*)["']\s*\]$/.exec(t) ?? /^ENV\.fetch\(\s*["']([A-Za-z_]\w*)["']\s*(?:,\s*nil\s*)?\)$/.exec(t);
  if (m) return { kind: "env", variable: m[1] };
  if (t === "nil") return null;
  if (t === "true" || t === "false") return { kind: "boolean", value: t === "true" };
  return { kind: "expression", text: t };
}

// ERB as Rails's Erubi reads it: a tag runs from `<%` to the first `%>`,
// whatever the Ruby inside says. `<%#` is a comment and `<%%` writes `<%`.
const ERB_TAG = /<%(={1,2}|-|#|%)?([\s\S]*?)[-=]?%>/g;

/** The ERB tags in a template; `unclosed` when a `<%` has no `%>`, which setup won't edit around. */
function erbTags(source) {
  const tags = [...source.matchAll(ERB_TAG)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    indicator: m[1] ?? "",
    code: { start: m.index + 2 + (m[1] ?? "").length, text: m[2] },
  }));
  return { tags, unclosed: source.replace(ERB_TAG, "").includes("<%") };
}

/**
 * The template with ERB tags, HTML comments, quoted attribute values and the
 * contents of script, style, textarea and title blanked out, same length and
 * lines, so what's left is the page's markup.
 */
function markupOnly(source, tags) {
  const blank = (text) => text.replace(/[^\r\n]/g, " ");
  const blankValues = (tag) => tag.replace(/"[^"]*"|'[^']*'/g, (value) => value[0] + blank(value.slice(1, -1)) + value[0]);
  let markup = source;
  for (const tag of tags) markup = markup.slice(0, tag.start) + blank(source.slice(tag.start, tag.end)) + markup.slice(tag.end);
  return markup.replace(
    /<!--[\s\S]*?(?:-->|$)|(<(script|style|textarea|title)\b(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(?=<\/\2\s*>|$)|<[a-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>/gi,
    (match, open, _name, body) => (open !== undefined ? blankValues(open) + blank(body) : match.startsWith("<!--") ? blank(match) : blankValues(match)),
  );
}

/**
 * Each `critiqs_tag` call in an ERB view: where its code is, and its keyword
 * arguments, or `args: null` when setup can't read it: a positional argument,
 * a splat, a call inside other code, or a tag that doesn't output.
 */
function erbCalls(source) {
  const calls = [];
  for (const tag of erbTags(source).tags) {
    if (tag.indicator === "#" || tag.indicator === "%" || !/\bcritiqs_tag\b/.test(tag.code.text)) continue;
    const lead = /^\s*/.exec(tag.code.text)[0].length;
    const code = tag.code.text.trim();
    const start = tag.code.start + lead;
    const end = start + code.length;
    const args = tag.indicator.startsWith("=") ? (parseCall(code)?.args ?? null) : null;
    calls.push({ start, end, args });
  }
  return calls;
}

/** Calls in a Haml or Slim view, which setup reports but doesn't edit: `= critiqs_tag ...` to the end of its line. */
function lineCalls(source) {
  return [...source.matchAll(/\bcritiqs_tag\b.*/g)].map((m) => {
    const code = m[0].trimEnd();
    return { start: m.index, end: m.index + code.length, args: parseCall(code)?.args ?? null };
  });
}

const callsIn = (file, source) => (file.endsWith(".erb") ? erbCalls(source) : lineCalls(source));

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

/** What a call means for each setting, with the helper's defaults filled in. */
function readSettings(args) {
  const get = (key) => args.find((arg) => arg.key === key);
  const projectId = get("project_id");
  const require = get("require_project_id");
  const backend = get("backend");
  return {
    projectId: projectId === undefined ? { kind: "env", variable: DEFAULT_VARIABLE } : projectId.value,
    requireProjectId: require === undefined ? { kind: "boolean", value: true } : require.value,
    backend: backend === undefined ? null : backend.value,
  };
}

// ---------------------------------------------------------------------------
// Writing

// Escapes `%>` too: inside an ERB tag it would end the tag, whatever the string says.
const rubyString = (value) => `"${value.replace(/[\\"]/g, "\\$&").replace(/#(?=[{$@])/g, "\\#").replaceAll("%>", "%\\>")}"`;

/** The value each setting should have, as a SettingRead-like value, and how to write it; `null` text means the helper's default covers it. */
function desiredSettings(settings) {
  const projectId =
    "literal" in settings.projectId
      ? { value: { kind: "literal", value: settings.projectId.literal }, text: `project_id: ${rubyString(settings.projectId.literal)}` }
      : {
          value: { kind: "env", variable: settings.projectId.env.variable },
          text: settings.projectId.env.variable === DEFAULT_VARIABLE ? null : `project_id: ${settings.projectId.env.expression}`,
        };
  const require = "env" in settings.projectId || settings.requireProjectId;
  return {
    project_id: { name: "projectId", ...projectId },
    require_project_id: { name: "requireProjectId", value: { kind: "boolean", value: require }, text: require ? null : "require_project_id: false" },
    ...(settings.backend === undefined ? {} : { backend: { name: "backend", value: { kind: "literal", value: settings.backend }, text: `backend: ${rubyString(settings.backend)}` } }),
  };
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const describeValue = (value) =>
  value === null ? "nil" : value.kind === "literal" ? rubyString(value.value) : value.kind === "env" ? `ENV["${value.variable}"]` : value.kind === "boolean" ? String(value.value) : value.text;

const callText = (args) => (args.length === 0 ? "critiqs_tag" : `critiqs_tag(${args.join(", ")})`);

// Editing a call in place. Setup never joins lines, so comments keep their place.

const splice = (code, start, end, text = "") => code.slice(0, start) + text + code.slice(end);
const lineStartOf = (code, index) => code.lastIndexOf("\n", index - 1) + 1;
/** Whether only whitespace comes before `index` on its line. */
const startsLine = (code, index) => /^[ \t]*$/.test(code.slice(lineStartOf(code, index), index));
/** Where the line holding `index` ends, before its line break. */
function lineEndOf(code, index) {
  const newline = code.indexOf("\n", index);
  if (newline === -1) return code.length;
  return code[newline - 1] === "\r" ? newline - 1 : newline;
}
/** Where the line break before `index`'s line starts. */
const breakBefore = (code, index) => {
  const lineStart = lineStartOf(code, index);
  return code[lineStart - 2] === "\r" ? lineStart - 2 : lineStart - 1;
};

/** The call with `text` added as its last argument: on a line of its own when the last argument has one, else after it. */
function addArgument(code, call, text) {
  const { args } = call;
  if (args.length === 0) {
    if (call.open === null) return splice(code, call.nameEnd, call.nameEnd, `(${text})`);
    const inner = code.slice(call.open + 1, call.close);
    return inner.trim() === "" ? splice(code, call.open + 1, call.close, text) : splice(code, call.open + 1, call.open + 1, `${text} `);
  }
  const last = args.at(-1);
  if (!startsLine(code, last.start)) {
    return call.trailingComma ? splice(code, last.comma + 1, last.comma + 1, ` ${text},`) : splice(code, last.end, last.end, `, ${text}`);
  }
  const line = `${code.includes("\r\n") ? "\r\n" : "\n"}${code.slice(lineStartOf(code, last.start), last.start)}${text}`;
  const after = call.trailingComma ? last.comma + 1 : last.end;
  const lineEnd = lineEndOf(code, after);
  // Only whitespace or a comment follows on the line: the new argument goes on the next line, the comment stays put.
  const restOfLine = call.skeleton.slice(after, lineEnd).trim() === "";
  if (call.trailingComma) return splice(code, restOfLine ? lineEnd : after, restOfLine ? lineEnd : after, `${line},`);
  if (restOfLine) return splice(splice(code, lineEnd, lineEnd, line), last.end, last.end, ",");
  return splice(code, last.end, last.end, `,${line}`);
}

/** The call without its argument at `index`, with the comma that went with it, and its line when it had one. */
function dropArgument(code, call, index) {
  const { args, trailingComma } = call;
  const arg = args[index];
  if (index < args.length - 1) return splice(code, arg.start, args[index + 1].start);
  let cut = trailingComma ? arg.comma + 1 : arg.end;
  if (index === 0) {
    if (call.open === null) return splice(code, call.nameEnd, cut);
    const inner = code.slice(call.open + 1, arg.start) + code.slice(cut, call.close);
    return inner.trim() === "" ? splice(code, call.open, call.close + 1) : splice(code, arg.start, cut);
  }
  const previous = args[index - 1];
  if (!startsLine(code, arg.start)) return splice(code, trailingComma ? previous.comma + 1 : previous.comma, cut);
  const lineEnd = lineEndOf(code, cut);
  if (call.skeleton.slice(cut, lineEnd).trim() === "") cut = lineEnd;
  const lines = splice(code, breakBefore(code, arg.start), cut);
  // The comma before it ends the arguments now; a trailing comma stays.
  return trailingComma ? lines : splice(lines, previous.comma, previous.comma + 1);
}

/**
 * The call's code with each setting as wanted: arguments already right stay
 * as written, others are replaced in place or dropped when the helper's
 * default says the same, and missing ones are added after the last.
 * `expression` names a setting the code computes and setup would have to
 * change. One setting at a time, reading the call again after each edit.
 */
function rewriteCall(code, settings) {
  const desired = desiredSettings(settings);
  const changed = [];
  for (let edits = 0; edits <= Object.keys(desired).length; edits++) {
    const call = parseCall(code);
    if (call === null) return null;
    const current = readSettings(call.args);
    const currentOf = { project_id: current.projectId, require_project_id: current.requireProjectId, backend: current.backend };
    const pending = Object.entries(desired).find(([key, want]) => !sameValue(currentOf[key], want.value));
    if (pending === undefined) return { code, changed };
    const [key, want] = pending;
    if (currentOf[key]?.kind === "expression") return { expression: { key, have: currentOf[key], want } };
    if (!changed.includes(want.name)) changed.push(want.name);
    const index = call.args.findIndex((arg) => arg.key === key);
    if (index === -1) code = addArgument(code, call, want.text);
    else if (want.text === null) code = dropArgument(code, call, index);
    else code = splice(code, call.args[index].start, call.args[index].end, want.text);
  }
  return null;
}

/** The layout with `<%= critiqs_tag %>` added before </body>, or null when the page's markup doesn't have exactly one. */
function insertTag(source, tags, tag) {
  const closings = [...markupOnly(source, tags).matchAll(/<\/body\s*>/gi)];
  if (closings.length !== 1) return null;
  const at = closings[0].index;
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const indent = source.slice(lineStart, at);
  if (!/^[ \t]*$/.test(indent)) return { source: source.slice(0, at) + tag + source.slice(at), index: at };
  const before = source.slice(0, lineStart).split(/\r?\n/).reverse().find((line) => line.trim() !== "") ?? "";
  const previous = /^[ \t]*/.exec(before)[0];
  const child = previous.length > indent.length ? previous : `${indent}${indent.includes("\t") ? "\t" : "  "}`;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return { source: `${source.slice(0, lineStart)}${child}${tag}${newline}${source.slice(lineStart)}`, index: lineStart + child.length };
}

/** The Gemfile with critiqs-rails added at the end, as `bundle add` does. */
function addGem(gemfile) {
  const newline = gemfile.includes("\r\n") ? "\r\n" : "\n";
  const body = gemfile === "" || gemfile.endsWith("\n") ? gemfile : gemfile + newline;
  return `${body}${body === "" ? "" : newline}gem "${GEM}"${newline}`;
}

function manualSteps(settings) {
  const desired = desiredSettings(settings);
  const tag = `<%= ${callText(Object.values(desired).flatMap((d) => (d.text === null ? [] : [d.text])))} %>`;
  const steps = [
    `1. Add \`gem "${GEM}"\` to the Gemfile, outside any group so every environment loads it, and run \`bundle install\`.`,
    `2. In ${LAYOUT} (or the layout every page uses), add \`${tag}\` on its own line just before \`</body>\`.`,
  ];
  if ("env" in settings.projectId) {
    steps.push(`3. ${railsEnv(settings.projectId.env.variable, null).deploymentAdvice}`);
  }
  return { tag, steps };
}

function railsEnv(variable, localFile) {
  return {
    variable,
    expression: `ENV["${variable}"]`,
    readsAt: "runtime",
    localFile,
    deploymentAdvice: `Set ${variable} in each deployment's environment to that deployment's project ID; Rails reads it when the app renders, so restart the app after changing it (no asset rebuild needed). Leave it unset where Critiqs shouldn't appear.`,
  };
}

// ---------------------------------------------------------------------------

/** The critiqs_tag calls in one view file, as Usages. */
function usagesIn(file) {
  const source = readText(file);
  if (source === null) return [];
  return callsIn(file, source).map((call) => {
    const settings = call.args === null ? null : readSettings(call.args);
    const asRead = (value) => (value === null || value.kind === "boolean" ? null : value);
    return {
      file,
      line: lineOf(source, call.start),
      projectId: settings === null ? { kind: "expression", text: source.slice(call.start, call.end) } : asRead(settings.projectId),
      backend: settings === null ? null : asRead(settings.backend),
      requireProjectId: settings === null ? false : settings.requireProjectId.kind === "boolean" && settings.requireProjectId.value,
    };
  });
}

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const rails = {
  id: "rails",
  name: "Ruby on Rails",
  install: { ecosystem: "rubygems", gem: GEM },
  detect: (root) => gemDeclared(readText(join(root, "Gemfile")) ?? "", "rails"),

  env(root, suffix) {
    // Rails loads no .env file itself; dotenv does when the app uses it. Otherwise
    // setup writes a default into the development environment's configuration,
    // which only `rails server` in development runs.
    const gemfile = readText(join(root, "Gemfile")) ?? "";
    const dotenv = gemDeclared(gemfile, "dotenv-rails") || gemDeclared(gemfile, "dotenv");
    const development = readText(join(root, DEVELOPMENT)) === null ? null : DEVELOPMENT;
    return railsEnv(`${DEFAULT_VARIABLE}${suffix}`, dotenv ? ".env" : development);
  },

  find: (root) => viewFiles(root).flatMap(usagesIn),

  plan(root, settings, options) {
    const chosen = options.entry === null ? null : join(root, options.entry);
    const found = rails.find(root);
    // A chosen layout outside app/views is read on every run too, so a second run finds what the first added.
    const usages = chosen === null || found.some((usage) => usage.file === chosen) ? found : [...found, ...usagesIn(chosen)];
    const where = (usage) => `${relative(root, usage.file)}:${usage.line}`;
    const { tag, steps } = manualSteps(settings);
    const byHand = `To finish by hand:\n${steps.join("\n")}`;
    if (usages.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: `critiqs_tag appears ${usages.length} times (${usages.map(where).join(", ")}), so nothing was changed. Keep one, in the layout every page uses, and set it to \`${tag}\`.`,
      };
    }
    const target = chosen ?? usages[0]?.file ?? join(root, LAYOUT);
    if (usages.length === 1 && usages[0].file !== target) {
      return {
        ok: false,
        reason: "ambiguous",
        message: `Critiqs is already set up at ${where(usages[0])}, not in ${relative(root, target)}, so nothing was changed. Move that critiqs_tag call there, or run setup without choosing a file, then set it to \`${tag}\`.`,
      };
    }

    const gemfilePath = join(root, "Gemfile");
    const gemfile = readText(gemfilePath);
    if (gemfile === null) return { ok: false, reason: "unreadable", message: `Setup couldn't read the Gemfile, so nothing was changed. ${byHand}` };
    const declarations = gemDeclarations(gemfile, GEM);
    const limited = declarations.find((declaration) => declaration.limit !== null);
    if (limited !== undefined) {
      return {
        ok: false,
        reason: "manual",
        message: `The Gemfile declares ${GEM} ${limited.limit} (line ${limited.line}), so production may not load critiqs_tag and pages using it would fail; nothing was changed. Declare \`gem "${GEM}"\` at the top level of the Gemfile instead, with no group, condition or require: false. ${byHand}`,
      };
    }
    const writes = [];
    const next = [];
    if (declarations.length === 0) {
      writes.push({ file: gemfilePath, original: gemfile, source: addGem(gemfile) });
      next.push("Run bundle install.");
    }

    const source = readText(target);
    if (source === null) {
      return { ok: false, reason: "manual", message: `Setup couldn't find ${relative(root, target)}, so nothing was changed. ${byHand}` };
    }
    const erb = target.endsWith(".erb");
    const { tags, unclosed } = erb ? erbTags(source) : { tags: [], unclosed: false };
    if (unclosed) {
      return { ok: false, reason: "unreadable", message: `${relative(root, target)} has an ERB tag (<%) that never closes, so setup can't edit it safely and nothing was changed. ${byHand}` };
    }

    let layout;
    let index;
    let changed;
    let action;
    if (usages.length === 1) {
      const call = callsIn(target, source).find((c) => lineOf(source, c.start) === usages[0].line);
      if (call?.args == null) {
        return {
          ok: false,
          reason: "unreadable",
          message: `${where(usages[0])} calls critiqs_tag in a way setup can't read (it edits only a whole \`<%= critiqs_tag ... %>\` tag with keyword arguments), so nothing was changed. Set it to \`${tag}\`.`,
        };
      }
      const rewrite = rewriteCall(source.slice(call.start, call.end), settings);
      if (rewrite === null) {
        return { ok: false, reason: "unreadable", message: `Setup couldn't rewrite the critiqs_tag call at ${where(usages[0])}, so nothing was changed. Set it to \`${tag}\`.` };
      }
      if (rewrite.expression) {
        const { key, have, want } = rewrite.expression;
        return {
          ok: false,
          reason: "expression",
          message: `${where(usages[0])} sets ${key} from code (${describeValue(have)}), so nothing was changed. Set it to ${describeValue(want.value)}: \`${tag}\`.`,
        };
      }
      changed = rewrite.changed;
      if (changed.length > 0 && !erb) {
        return { ok: false, reason: "manual", message: `Setup edits only ERB views, so nothing was changed in ${where(usages[0])}. Set that call to \`${tag}\`.` };
      }
      index = call.start;
      layout = changed.length === 0 ? source : source.slice(0, call.start) + rewrite.code + source.slice(call.end);
      action = changed.length > 0 || writes.length > 0 ? "update" : "unchanged";
    } else {
      if (!erb) {
        return { ok: false, reason: "manual", message: `Setup adds Critiqs only to ERB layouts, so nothing was changed in ${relative(root, target)}. ${byHand}` };
      }
      const inserted = insertTag(source, tags, tag);
      if (inserted === null) {
        return {
          ok: false,
          reason: "manual",
          message: `${relative(root, target)} doesn't have exactly one </body> in its markup (outside ERB code, comments and scripts), so setup can't tell where Critiqs goes and nothing was changed. ${byHand}`,
        };
      }
      ({ source: layout, index } = inserted);
      changed = Object.values(desiredSettings(settings)).map((d) => d.name);
      action = "install";
    }
    if (layout !== source) writes.push({ file: target, original: source, source: layout });
    const line = lineOf(layout, index);
    return {
      ok: true,
      action,
      writes,
      file: target,
      line,
      changed,
      preview: layout.split(/\r?\n/)[line - 1].trim(),
      next,
    };
  },

  manual(settings) {
    const { steps } = manualSteps(settings);
    return [`Add Critiqs to this Ruby on Rails app (project ID: ${describeProjectId(settings)}):`, ...steps].join("\n");
  },
};
