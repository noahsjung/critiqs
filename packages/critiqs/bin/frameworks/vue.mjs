// Vue setup: `<Critiqs />` from critiqs-vue in the root component (src/App.vue
// in a create-vue app), reading the project ID from Vite's public variables.
// Single-file components are read with a small scanner rather than Vue's
// compiler, so setup needs no Vue packages; anything it can't follow, it
// refuses with complete instructions.
import { readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { dependsOn, describeProjectId, readText } from "./shared.mjs";

const PACKAGE = "critiqs-vue";
const ENTRY = "src/App.vue";
/** The script setup binding that holds a project ID read from the environment. */
const BINDING = "critiqsProjectId";
/** The name setup imports Critiqs under when the component already uses `Critiqs` for something else. */
const ALIAS = "CritiqsFeedback";
/** Folders that never hold the app's own components. */
const SKIP = new Set(["node_modules", "dist", "build", "coverage", "public", ".output", ".nuxt", ".git"]);

// ---------------------------------------------------------------------------
// Reading single-file components

/** 1-based line of `index` in `source`. */
export function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * The component's root `<template>` and its `<script setup>` and `<script>`
 * blocks, as offsets into `source`. Block tags start at the beginning of a
 * line, as Vue's tooling writes them. Returns null when the template's
 * nesting can't be followed.
 */
export function readBlocks(source) {
  const open = /^<template(\s[^>]*)?>/m.exec(source);
  let template = null;
  if (open !== null) {
    const start = open.index + open[0].length;
    const tags = /<template\b[^>]*>|<\/template\s*>/g;
    tags.lastIndex = start;
    let depth = 1;
    let match;
    while ((match = tags.exec(source)) !== null) {
      depth += match[0].startsWith("</") ? -1 : 1;
      if (depth === 0) break;
    }
    if (match === null) return null;
    template = { open: open.index, start, end: match.index, attrs: open[1] ?? "" };
  }
  const scripts = [];
  for (const script of source.matchAll(/^<script(\s[^>]*)?>/gm)) {
    const start = script.index + script[0].length;
    const end = source.indexOf("</script>", start);
    if (end === -1) return null;
    const attrs = script[1] ?? "";
    scripts.push({ open: script.index, start, end, attrs, setup: /\bsetup\b/.test(attrs) });
  }
  return { template, scriptSetup: scripts.find((s) => s.setup) ?? null, script: scripts.find((s) => !s.setup) ?? null };
}

/** `project-id`, `:projectId`, `v-bind:project-id` → `projectId`, bound or not. */
function settingName(attribute) {
  const bound = attribute.startsWith(":") || attribute.startsWith("v-bind:");
  const name = attribute.replace(/^(?::|v-bind:)/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return { name, bound };
}

/** `MyFeedback` → `my-feedback`: the other way a template can name a component. */
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * Every opening tag named one of `names` (or its kebab-case form) in `source`
 * from `from` to `to`, with its attributes. Quoted values may hold `>`, as
 * bound expressions often do.
 */
export function readTags(source, from = 0, to = source.length, names = ["Critiqs"]) {
  const tags = [];
  if (names.length === 0) return tags;
  const alternatives = [...new Set(names.flatMap((name) => [name, kebab(name)]))].map((name) => name.replace(/\$/g, "\\$"));
  const start = new RegExp(`<(${alternatives.join("|")})(?=[\\s/>])`, "g");
  start.lastIndex = from;
  let match;
  while ((match = start.exec(source)) !== null && match.index < to) {
    const attrs = [];
    let i = match.index + match[0].length;
    let end = -1;
    while (i < source.length) {
      const char = source[i];
      if (/\s/.test(char)) {
        i++;
        continue;
      }
      if (char === ">" || source.startsWith("/>", i)) {
        end = i + (char === ">" ? 1 : 2);
        break;
      }
      const name = /^[^\s=/>"']+/.exec(source.slice(i))?.[0];
      if (name === undefined) break;
      const attr = { raw: name, start: i, end: i + name.length, value: null, ...settingName(name) };
      i += name.length;
      const equals = /^\s*=\s*(["'])/.exec(source.slice(i));
      if (equals !== null) {
        const quote = equals[1];
        const valueStart = i + equals[0].length;
        const valueEnd = source.indexOf(quote, valueStart);
        if (valueEnd === -1) break;
        attr.value = source.slice(valueStart, valueEnd);
        attr.end = i = valueEnd + 1;
      }
      attrs.push(attr);
    }
    if (end === -1) return null;
    tags.push({ name: match[1], start: match.index, end, attrs, selfClosing: source[end - 2] === "/" });
    start.lastIndex = end;
  }
  return tags;
}

/** `const <name> = import.meta.env.<VARIABLE>` in a script setup block: the variable, or null. */
function envBinding(script, name) {
  if (script === null || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  return new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*import\\.meta\\.env\\.(\\w+)`).exec(script)?.[1] ?? null;
}

/**
 * The project ID binding's declaration exactly as setup writes it, a whole
 * line and a whole statement (`const critiqsProjectId =
 * import.meta.env.VITE_…`, perhaps with a semicolon), as offsets in `script`;
 * null when it says anything more, such as a fallback on the next line.
 */
function ownDeclaration(script) {
  const line = new RegExp(`^[^\\S\\n]*const\\s+${BINDING}\\s*=\\s*import\\.meta\\.env\\.\\w+[^\\S\\n]*(;?)[^\\S\\n]*(?:\\n|$)`, "m").exec(script);
  if (line === null) return null;
  const end = line.index + line[0].length;
  // Without a semicolon, the next line must start a statement of its own rather than continue this one.
  const next = /^\s*(\S*)/.exec(script.slice(end))[1];
  const ends = line[1] === ";" || next === "" || (/^[\w$@}'"]/.test(next) && !/^(?:in|instanceof|as|satisfies)(?![\w$])/.test(next));
  return ends ? { start: line.index, end } : null;
}

/** How a tag gives one setting. */
function readSetting(tag, name, scriptText) {
  const attr = tag.attrs.find((a) => a.name === name);
  if (attr === undefined) return null;
  if (!attr.bound) return attr.value === null ? { kind: "expression", text: "true" } : { kind: "literal", value: attr.value };
  const text = (attr.value ?? "").trim();
  const quoted = /^(["'`])([^"'`\\$]*)\1$/.exec(text);
  if (quoted !== null) return { kind: "literal", value: quoted[2] };
  const direct = /^import\.meta\.env\.(\w+)$/.exec(text);
  if (direct !== null) return { kind: "env", variable: direct[1] };
  const variable = envBinding(scriptText, text);
  return variable === null ? { kind: "expression", text } : { kind: "env", variable };
}

function readRequire(tag) {
  const attr = tag.attrs.find((a) => a.name === "requireProjectId");
  if (attr === undefined) return false;
  if (!attr.bound) return attr.value === null || attr.value === "" || attr.value === "require-project-id" || attr.value === "requireProjectId";
  return attr.value?.trim() === "true";
}

/** The `.vue` files under `root`, skipping dependencies and build output. */
export function vueFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".vue")) found.push(join(dir, entry.name));
    }
  };
  walk(root);
  return found.sort();
}

const blank = (text) => text.replace(/[^\n]/g, " ");

/** Keywords after which a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * JavaScript or TypeScript `src` read for its code, at the same offsets:
 * `code` has comments blanked; `masked` also blanks what string, template, and
 * regular expression literals hold, keeping their delimiters and the code in
 * a template's `${…}`. So a search of `masked` finds only code, and a quote
 * in `masked` always opens or closes a string.
 */
export function maskScript(src) {
  const code = src.split("");
  const masked = src.split("");
  const clear = (chars, from, to) => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
  /** Code from `i`; inside a template's `${`, up to its closing `}`, whose index it returns. */
  const scan = (i, inTemplate) => {
    let depth = 0;
    // The last token, to tell a regular expression from division: "" at the start, a word, or a character.
    let last = "";
    while (i < src.length) {
      const char = src[i];
      if (src.startsWith("//", i) || src.startsWith("/*", i)) {
        const close = char === "/" && src[i + 1] === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
        const end = close === -1 ? src.length : src[i + 1] === "/" ? close : close + 2;
        clear(code, i, end);
        clear(masked, i, end);
        i = end;
      } else if (char === '"' || char === "'") {
        let k = i + 1;
        while (k < src.length && src[k] !== char && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
        clear(masked, i + 1, Math.min(k, src.length));
        i = k + 1;
        last = "a";
      } else if (char === "`") {
        let k = i + 1;
        while (k < src.length && src[k] !== "`") {
          if (src.startsWith("${", k)) k = scan(k + 2, true) + 1;
          else {
            const step = src[k] === "\\" ? 2 : 1;
            clear(masked, k, k + step);
            k += step;
          }
        }
        i = k + 1;
        last = "a";
      } else if (char === "/" && (last === "" || BEFORE_REGEX.has(last) || /^[^\w$)\]}]$/.test(last))) {
        // A regular expression: up to the `/` outside a character class, then its flags.
        let k = i + 1;
        let inClass = false;
        while (k < src.length && src[k] !== "\n" && (inClass || src[k] !== "/")) {
          if (src[k] === "[") inClass = true;
          else if (src[k] === "]") inClass = false;
          k += src[k] === "\\" ? 2 : 1;
        }
        if (src[k] !== "/") {
          // Not a regular expression after all (an unclosed one is a syntax error anyway).
          last = char;
          i++;
          continue;
        }
        clear(masked, i + 1, k);
        i = k + 1;
        while (i < src.length && /[a-z]/.test(src[i])) i++;
        last = "a";
      } else if (/\s/.test(char)) i++;
      else if (/[\w$]/.test(char)) {
        const word = /^[\w$]+/.exec(src.slice(i, i + 64))[0];
        last = word;
        i += word.length;
      } else {
        if (inTemplate && char === "{") depth++;
        if (inTemplate && char === "}" && depth-- === 0) return i;
        last = char;
        i++;
      }
    }
    return i;
  };
  scan(0, false);
  return { code: code.join(""), masked: masked.join("") };
}

/**
 * A component as setup reads it, at the same offsets as `source` (which edits
 * apply to): `code` has HTML comments (outside script and style blocks) and
 * script comments blanked, so a commented-out tag or import is never read;
 * `masked` also blanks what the scripts' strings, templates, and regular
 * expressions hold, so an `import` written inside one is never taken for
 * code. `scripts` and `maskedScripts` are the script blocks' text from each.
 * Null when its blocks can't be followed.
 */
function readComponent(source) {
  const markup = source.replace(/<!--[\s\S]*?(?:-->|(?![\s\S]))|^<(script|style)\b[\s\S]*?<\/\1\s*>/gm, (match, block) => (block ? match : blank(match)));
  const blocks = readBlocks(markup);
  if (blocks === null) return null;
  let code = markup;
  let masked = markup;
  for (const block of [blocks.scriptSetup, blocks.script]) {
    if (block === null) continue;
    const read = maskScript(markup.slice(block.start, block.end));
    code = code.slice(0, block.start) + read.code + code.slice(block.end);
    masked = masked.slice(0, block.start) + read.masked + masked.slice(block.end);
  }
  const join = (text) => [blocks.scriptSetup, blocks.script].filter((block) => block !== null).map((block) => text.slice(block.start, block.end)).join("\n");
  return { source, code, masked, blocks, scripts: join(code), maskedScripts: join(masked), setupScript: blocks.scriptSetup ? masked.slice(blocks.scriptSetup.start, blocks.scriptSetup.end) : null };
}

/** One import declaration from critiqs-vue; its clause holds no quotes, so a match never spans an earlier import. */
const PACKAGE_IMPORT = /\bimport\s+(?!type\s)([^;"'`]*?)\s*from\s*(["'])critiqs-vue\2/g;

/** The component's real imports from critiqs-vue (not text in a string) in `scripts`, with their clauses. */
function packageImports(component) {
  return [...component.scripts.matchAll(PACKAGE_IMPORT)].filter((match) => component.maskedScripts.startsWith("import", match.index));
}

/** The names a component's scripts give critiqs-vue's Critiqs: `Critiqs`, or `Feedback` for `{ Critiqs as Feedback }`. */
function boundNames(component) {
  const names = [];
  for (const [, clause] of packageImports(component)) {
    for (const specifier of /\{([^}]*)\}/.exec(clause)?.[1].split(",") ?? []) {
      const local = /^\s*Critiqs(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
      if (local !== null) names.push(local[1] ?? "Critiqs");
    }
  }
  return names;
}

/** Whether the scripts' code uses `name` for anything but critiqs-vue's import. */
function declares(component, name) {
  let code = component.maskedScripts;
  for (const match of packageImports(component)) code = code.slice(0, match.index) + blank(match[0]) + code.slice(match.index + match[0].length);
  return new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(code);
}

/**
 * The tag names that are critiqs-vue's Critiqs in a component: the names its
 * imports bind, and an unbound `Critiqs` (registered globally) unless the app
 * has a Critiqs.vue of its own that it could be.
 */
function ourTagNames(component, ownCritiqs) {
  const names = boundNames(component);
  if (!names.includes("Critiqs") && !ownCritiqs && !declares(component, "Critiqs")) names.push("Critiqs");
  return names;
}

/** Every critiqs-vue `<Critiqs>` in the app's `.vue` files, read for setup. */
export function findComponents(root) {
  const usages = [];
  const files = vueFiles(root);
  const ownCritiqs = files.some((file) => basename(file) === "Critiqs.vue");
  for (const file of files) {
    const source = readText(file);
    if (source === null || !/critiqs/i.test(source)) continue;
    const component = readComponent(source);
    if (component === null || component.blocks.template === null) {
      const at = source.search(/<Critiqs[\s/>]|["']critiqs-vue["']/);
      if (at !== -1) usages.push({ file, source, component, tag: null, line: lineAt(source, at) });
      continue;
    }
    const { start, end } = component.blocks.template;
    const tags = readTags(component.code, start, end, ourTagNames(component, ownCritiqs));
    if (tags === null) {
      usages.push({ file, source, component, tag: null, line: lineAt(source, start) });
      continue;
    }
    for (const tag of tags) usages.push({ file, source, component, tag, line: lineAt(source, tag.start) });
  }
  return usages;
}

function toUsage({ file, component, tag, line }) {
  if (tag === null) return { file, line, projectId: null, backend: null, requireProjectId: false };
  const script = component.setupScript;
  return { file, line, projectId: readSetting(tag, "projectId", script), backend: readSetting(tag, "backend", script), requireProjectId: readRequire(tag) };
}

// ---------------------------------------------------------------------------
// Writing

/** The lines that differ between two versions of a file, with `-` and `+`, for a preview. */
export function changedLines(before, after) {
  const a = (before ?? "").split("\n");
  const b = after.split("\n");
  // Longest common subsequence of lines; files setup edits are small.
  const common = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || common[i + 1][j] >= common[i][j + 1])) lines.push(`- ${a[i++]}`);
    else lines.push(`+ ${b[j++]}`);
  }
  return lines;
}

/** Where `offset` in the source lands after `edits`, none of which spans it. */
function moved(edits, offset) {
  return offset + edits.filter(([start]) => start <= offset).reduce((sum, [start, end, text]) => sum + text.length - (end - start), 0);
}

/** Applies [start, end, text] replacements, which must not overlap. */
function applyEdits(source, edits) {
  let out = source;
  for (const [start, end, text] of [...edits].sort((x, y) => y[0] - x[0])) out = out.slice(0, start) + text + out.slice(end);
  return out;
}

const escapeAttr = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The attributes setup writes for these settings, in order. */
function wantedAttrs(settings) {
  const attrs = [];
  if ("literal" in settings.projectId) attrs.push(["projectId", `project-id="${escapeAttr(settings.projectId.literal)}"`]);
  else attrs.push(["projectId", `:project-id="${BINDING}"`]);
  if (settings.requireProjectId || "env" in settings.projectId) attrs.push(["requireProjectId", "require-project-id"]);
  if (settings.backend !== undefined) attrs.push(["backend", `backend="${escapeAttr(settings.backend)}"`]);
  return attrs;
}

export function componentMarkup(settings, name = "Critiqs") {
  return `<${name} ${wantedAttrs(settings).map(([, text]) => text).join(" ")} />`;
}

/** The import statement for Critiqs under `name`. */
const importLine = (name, quote = "'", semi = "") => `import { ${name === "Critiqs" ? "Critiqs" : `Critiqs as ${name}`} } from ${quote}${PACKAGE}${quote}${semi}`;

/** The code style of a script block's imports: quote and semicolon. */
function scriptStyle(script) {
  const first = /^import\s.*?from\s+(["'])[^"']*\1(;?)/m.exec(script ?? "");
  return first === null ? { quote: "'", semi: "" } : { quote: first[1], semi: first[2] };
}

/** Where a new import goes in a script block: after its last import statement, or at its start. */
function importPoint(source, block) {
  const text = source.slice(block.start, block.end);
  let point = 0;
  for (const statement of text.matchAll(/^import\s[\s\S]*?(?:from\s+)?(["'])[^"'\n]*\1;?[^\S\n]*$/gm)) point = statement.index + statement[0].length;
  return block.start + point;
}

/**
 * Script setup edits that import Critiqs and, with `variable`, read it into
 * the project ID binding; `tagBinds` says the `<Critiqs>` tag reads that
 * binding. Reads the component's `masked` code; edits its `source`.
 */
function scriptEdits(component, { addImport, variable, dropBinding, tsProject, tagBinds }) {
  const { source, masked, blocks } = component;
  const edits = [];
  const block = blocks.scriptSetup;
  if (variable !== null && envBinding(component.setupScript, BINDING) === null && declares(component, BINDING)) return { error: "binding" };
  if (block === null) {
    if (!addImport && variable === null) return { edits };
    if (blocks.script !== null) return { error: "options" };
    const lines = [];
    if (addImport) lines.push(importLine("Critiqs"));
    if (variable !== null) lines.push(`const ${BINDING} = import.meta.env.${variable}`);
    const open = blocks.template?.open ?? 0;
    edits.push([open, open, `<script setup${tsProject ? ' lang="ts"' : ""}>\n${lines.join("\n")}\n</script>\n\n`]);
    return { edits };
  }
  const text = masked.slice(block.start, block.end);
  const { quote, semi } = scriptStyle(text);
  const current = envBinding(text, BINDING);
  // Setup's own binding, as it writes it, used by nothing but its declaration and the tag: setup may change or remove it.
  const declaration = ownDeclaration(text);
  const uses = masked.match(new RegExp(`(?<![\\w$])${BINDING}(?![\\w$])`, "g"))?.length ?? 0;
  const ownOnly = declaration !== null && uses === (tagBinds ? 2 : 1);
  const lines = [];
  if (addImport) lines.push(importLine("Critiqs", quote, semi));
  if (variable !== null && current === null) lines.push(`const ${BINDING} = import.meta.env.${variable}${semi}`);
  if (variable !== null && current !== null && current !== variable) {
    // Any other use reads the variable too, and would change with it.
    if (!ownOnly) return { error: "shared" };
    const at = text.indexOf(`import.meta.env.${current}`, declaration.start);
    edits.push([block.start + at, block.start + at + `import.meta.env.${current}`.length, `import.meta.env.${variable}`]);
  }
  if (dropBinding && ownOnly) edits.push([block.start + declaration.start, block.start + declaration.end, ""]);
  if (lines.length > 0) {
    const at = importPoint(masked, block);
    const empty = source.slice(block.start, block.end).trim() === "";
    if (empty) edits.push([block.start, block.end, `\n${lines.join("\n")}\n`]);
    else if (at === block.start) edits.push([at, at, `${source[at] === "\n" ? "\n" : ""}${lines.join("\n")}${source[at] === "\n" ? "" : "\n"}`]);
    else edits.push([at, at, `\n${lines.join("\n")}`]);
  }
  return { edits };
}

/** Edits to one `<Critiqs>` tag that make it say `settings`, or a refusal. */
function tagEdits(source, tag, settings, script) {
  const edits = [];
  const changed = [];
  const multiline = source.slice(tag.start, tag.end).includes("\n");
  const indent = multiline ? (/\n([^\S\n]*)\S/.exec(source.slice(tag.start, tag.end))?.[1] ?? "  ") : "";
  const additions = [];
  const wanted = new Map(wantedAttrs(settings));
  if (tag.attrs.some((a) => a.raw === "v-bind" || a.raw.startsWith("v-bind="))) return { error: { reason: "unreadable", line: lineAt(source, tag.start) } };
  for (const name of ["projectId", "requireProjectId", "backend"]) {
    const attrs = tag.attrs.filter((a) => a.name === name);
    if (attrs.length > 1) return { error: { reason: "unreadable", line: lineAt(source, tag.start) } };
    const attr = attrs[0];
    const text = wanted.get(name);
    if (attr === undefined) {
      if (text !== undefined) {
        additions.push(text);
        changed.push(name);
      }
      continue;
    }
    if (name === "requireProjectId") {
      const on = readRequire(tag);
      if (text !== undefined && on) continue;
      if (attr.bound && !["true", "false"].includes(attr.value?.trim() ?? "")) return { error: { reason: "expression", name, line: lineAt(source, attr.start) } };
      if (text === undefined && !on) continue;
    } else {
      const current = readSetting(tag, name, script);
      const desired = name === "projectId"
        ? ("literal" in settings.projectId ? { kind: "literal", value: settings.projectId.literal } : { kind: "env", variable: settings.projectId.env.variable })
        : settings.backend === undefined ? null : { kind: "literal", value: settings.backend };
      if (current?.kind === "expression") return { error: { reason: "expression", name, line: lineAt(source, attr.start) } };
      if (desired !== null && current?.kind === desired.kind && (desired.kind === "literal" ? current.value === desired.value : current.variable === desired.variable)) continue;
    }
    changed.push(name);
    if (text === undefined) {
      let from = attr.start;
      while (from > tag.start && /[^\S]/.test(source[from - 1])) from--;
      edits.push([from, attr.end, ""]);
    } else edits.push([attr.start, attr.end, text]);
  }
  if (additions.length > 0) {
    // After the last attribute, on its own line when the tag puts each attribute on one.
    const last = tag.attrs.at(-1);
    const at = last === undefined ? tag.start + 1 + tag.name.length : last.end;
    edits.push([at, at, additions.map((text) => (multiline ? `\n${indent}${text}` : ` ${text}`)).join("")]);
  }
  return { edits, changed };
}

function where(root, file, line) {
  return `${relative(root, file) || file}:${line}`;
}

/** Plans `settings` into the one existing component, or a refusal. */
function planUpdate(root, usage, settings) {
  const { file, source, component, tag } = usage;
  if (tag === null) return refuse("unreadable", `Couldn't read the <Critiqs> component in ${where(root, file, usage.line)}, so nothing was changed. ${steps(settings, relative(root, file))}`);
  const script = component.setupScript;
  const result = tagEdits(source, tag, settings, script);
  if (result.error !== undefined) return refuseTag(root, file, result.error, settings, tag.name);
  const env = "env" in settings.projectId ? settings.projectId.env.variable : null;
  const current = readSetting(tag, "projectId", script);
  // The project ID's binding is setup's own; any other is the developer's and stays.
  const ownBinding = tag.attrs.some((a) => a.name === "projectId" && a.bound && a.value?.trim() === BINDING);
  const needsBinding = env !== null && !(current?.kind === "env" && current.variable === env && !ownBinding);
  const scripted = scriptEdits(component, {
    addImport: false,
    variable: needsBinding ? env : null,
    dropBinding: env === null && ownBinding,
    tsProject: false,
    tagBinds: ownBinding,
  });
  if (scripted.error !== undefined) return refuseScript(root, file, scripted.error, settings, tag.name);
  const edits = [...result.edits, ...scripted.edits];
  const updated = applyEdits(source, edits);
  if (updated === source) return { ok: true, action: "unchanged", writes: [], file, line: usage.line, changed: [], preview: "", next: [] };
  return {
    ok: true,
    action: "update",
    writes: [{ file, original: source, source: updated }],
    file,
    line: lineAt(updated, moved(edits, tag.start)),
    changed: result.changed.length > 0 ? result.changed : ["projectId"],
    preview: changedLines(source, updated).join("\n"),
    next: nextSteps(settings),
  };
}

function refuse(reason, message) {
  return { ok: false, reason, message };
}

function refuseTag(root, file, error, settings, name) {
  const at = where(root, file, error.line);
  if (error.reason === "expression") {
    return refuse("expression", `${at} sets ${error.name} from code, so nothing was changed. Set the <${name}> component to: ${componentMarkup(settings, name)}${"env" in settings.projectId ? `, with ${BINDING} read in <script setup>: const ${BINDING} = ${settings.projectId.env.expression}` : ""}`);
  }
  return refuse("unreadable", `Couldn't safely edit the <${name}> component at ${at}, so nothing was changed. ${steps(settings, relative(root, file), name)}`);
}

/** A refusal for a script setup can't edit: an Options API component, or a project ID binding name already in use. */
function refuseScript(root, file, error, settings, name) {
  const shown = relative(root, file);
  if (error === "shared") {
    const { expression } = settings.projectId.env;
    return refuse("expression", `${shown} uses ${BINDING} for more than <${name}>'s project ID, so setup won't change the variable it reads, and nothing was changed. Give <${name}> the project ID from ${expression} yourself (for example, :project-id="projectIdFromEnv" with const projectIdFromEnv = ${expression}), adding require-project-id.`);
  }
  if (error === "binding") {
    const { expression } = settings.projectId.env;
    return refuse("unreadable", `${shown} already declares ${BINDING} for something else, so setup can't read the project ID into it, and nothing was changed. Give <${name}> the project ID from ${expression} yourself (for example, :project-id="projectIdFromEnv" with const projectIdFromEnv = ${expression}), adding require-project-id.`);
  }
  return refuse("unreadable", `${shown} uses the Options API (<script> without setup), so setup can't import Critiqs or read the project ID there, and nothing was changed. ${steps(settings, shown, name)}`);
}

function nextSteps(settings) {
  return "env" in settings.projectId ? [`Restart the Vite dev server so it reads ${settings.projectId.env.variable}.`] : [];
}

/** Hand instructions for a file, naming it; `name` is the component's name there. */
function steps(settings, file, name = "Critiqs") {
  const env = "env" in settings.projectId ? settings.projectId.env : null;
  return [
    `To add Critiqs by hand, in ${file}:`,
    `1. In <script setup>, add: ${importLine(name)}`,
    ...(env === null ? [] : [`   and: const ${BINDING} = ${env.expression}`]),
    `2. At the end of <template>, add: ${componentMarkup(settings, name)}`,
    ...(env === null ? [] : [`3. Set ${env.variable}=<project ID> in ${env.localFile ?? ".env.local"} for this computer, and in each deployment's build settings.`]),
  ].join("\n");
}

/**
 * The folder a Vite app loads `.env` files from: its `envDir`, resolved from
 * its `root` as Vite resolves it, each from a plain string or left unset (the
 * project folder, where Vite runs, is the default root). Null when its config
 * sets `envPrefix` (which names reach the browser, setup can't tell) or sets
 * `root` or `envDir` some other way.
 */
function viteEnvDir(root) {
  const file = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"].map((name) => join(root, name)).find((path) => readText(path) !== null);
  const text = file === undefined ? "" : readText(file);
  if (/\benvPrefix\b/.test(text)) return null;
  /**
   * A plain string option: undefined when unset, null when set some other way.
   * `mention` finds every place the config could set it.
   */
  const option = (name, mention) => {
    const mentions = text.match(mention) ?? [];
    if (mentions.length === 0) return undefined;
    const literal = new RegExp(`\\b${name}\\s*:\\s*(["'])([^"'\\n]*)\\1`).exec(text);
    return mentions.length === 1 && literal !== null ? literal[2] : null;
  };
  // `root` is a common word, so only a key (`root:`, or shorthand `{ root }`) counts; any envDir does.
  const viteRoot = option("root", /\broot\s*:|[{,]\s*root\s*[,}]/g);
  const envDir = option("envDir", /\benvDir\b/g);
  if (viteRoot === null || envDir === null) return null;
  const base = resolve(root, viteRoot ?? ".");
  return envDir === undefined ? base : resolve(base, envDir);
}

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const vue = {
  id: "vue",
  name: "Vue",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "vue"),
  env(root, suffix) {
    const dir = dependsOn(root, "vite") ? viteEnvDir(root) : null;
    if (dir === null) return null;
    const variable = `VITE_CRITIQS_PROJECT_ID${suffix}`;
    return {
      variable,
      expression: `import.meta.env.${variable}`,
      readsAt: "build",
      localFile: relative(root, join(dir, ".env.local")),
      deploymentAdvice: `Set ${variable} in each deployment's build settings; Vite writes it into the app when it builds, so a change takes effect on the next build.`,
    };
  },
  find: (root) => findComponents(root).map(toUsage),
  plan(root, settings, options) {
    const usages = findComponents(root);
    if (usages.length > 1) {
      return refuse(
        "ambiguous",
        `Found ${usages.length} <Critiqs> components, so nothing was changed:\n${usages.map((u) => `  ${where(root, u.file, u.line)}`).join("\n")}\nKeep one, in the root component, then run setup again.`,
      );
    }
    const entry = options.entry ?? ENTRY;
    const file = isAbsolute(entry) ? entry : join(root, entry);
    if (usages.length === 1 && options.entry !== null && usages[0].file !== file) {
      return refuse("ambiguous", `Critiqs is already in ${where(root, usages[0].file, usages[0].line)}, not ${options.entry}, so nothing was changed. Run setup without an entry to update it there, or move it yourself.`);
    }
    if (usages.length === 1) return planUpdate(root, usages[0], settings);

    const source = readText(file);
    if (source === null || !file.endsWith(".vue")) {
      return refuse("manual", `${options.entry === null ? `This app has no ${ENTRY}` : `${entry} isn't a .vue file setup can read`}, so nothing was changed. Choose the root component with --entry <file.vue>. ${steps(settings, "the root component (the one main.ts passes to createApp)")}`);
    }
    const component = readComponent(source);
    const blocks = component?.blocks;
    const relativeFile = relative(root, file);
    if (component === null || blocks.template === null || /\blang\s*=\s*["'](?!html)/.test(blocks.template.attrs)) {
      return refuse("unreadable", `Couldn't read the <template> in ${relativeFile}, so nothing was changed. ${steps(settings, relativeFile)}`);
    }
    // An imported name is used as it is; otherwise `Critiqs` must be free, in the scripts and as a tag of the app's own.
    const bound = boundNames(component);
    const name = bound[0] ?? "Critiqs";
    if (bound.length === 0 && (declares(component, "Critiqs") || readTags(component.code, blocks.template.start, blocks.template.end)?.length !== 0)) {
      return refuse("unreadable", `${relativeFile} already uses the name Critiqs for something else, so nothing was changed. ${steps(settings, relativeFile, ALIAS)}`);
    }
    const env = "env" in settings.projectId ? settings.projectId.env.variable : null;
    const scripted = scriptEdits(component, { addImport: bound.length === 0, variable: env, dropBinding: false, tsProject: readText(join(root, "tsconfig.json")) !== null, tagBinds: false });
    if (scripted.error !== undefined) return refuseScript(root, file, scripted.error, settings, name);
    // At the end of the template, indented like its first element.
    const { start, end } = blocks.template;
    const indent = /\n([^\S\n]*)\S/.exec(source.slice(start, end))?.[1] ?? "  ";
    const before = source.slice(start, end).replace(/[^\S\n]*$/, "");
    const tagStart = start + before.length;
    const tag = `${before.endsWith("\n") ? "" : "\n"}${indent}${componentMarkup(settings, name)}\n`;
    const edits = [...scripted.edits, [tagStart, end, tag]];
    const updated = applyEdits(source, edits);
    return {
      ok: true,
      action: "install",
      writes: [{ file, original: source, source: updated }],
      file,
      // The line just above </template>.
      line: lineAt(updated, moved(edits, end)) - 1,
      changed: wantedAttrs(settings).map(([name]) => name),
      preview: changedLines(source, updated).join("\n"),
      next: nextSteps(settings),
    };
  },
  manual: (settings) =>
    `Add Critiqs to this Vue app's root component with project ID ${describeProjectId(settings)}.\n` +
    `0. Install the package: npm install ${PACKAGE}\n` +
    steps(settings, `the root component (${ENTRY} in a create-vue app)`),
};
