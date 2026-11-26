// Nuxt setup: `critiqs-nuxt` in nuxt.config's `modules`, with its settings
// under `critiqs`. The module puts them in public runtime config, so
// NUXT_PUBLIC_CRITIQS_PROJECT_ID sets the project ID when the server starts,
// and the config needs no project ID at all. nuxt.config is read with a small
// scanner of object literals; anything it can't follow, it refuses with
// complete instructions.
import { isAbsolute, join, relative } from "node:path";
import { dependsOn, describeProjectId, readText } from "./shared.mjs";
import { changedLines, lineAt, maskScript, vue } from "./vue.mjs";

const PACKAGE = "critiqs-nuxt";
const CONFIGS = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.mts"];
/** The variable Nuxt maps to `runtimeConfig.public.critiqs.projectId` on its own. */
const VARIABLE = "NUXT_PUBLIC_CRITIQS_PROJECT_ID";

// ---------------------------------------------------------------------------
// Reading object and array literals

/** Skips whitespace and comments from `i`. */
function skipTrivia(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) i = src.includes("\n", i) ? src.indexOf("\n", i) : src.length;
    else if (src.startsWith("/*", i)) i = src.includes("*/", i + 2) ? src.indexOf("*/", i + 2) + 2 : src.length;
    else return i;
  }
}

/** The index just past the string or template literal starting at `i`. */
function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") i += 2;
    else if (quote === "`" && src.startsWith("${", i)) i = skipValue(src, i + 2, "}") + 1;
    else i++;
  }
  return i + 1;
}

/**
 * The index of the first `,` at this nesting level or of `close`, from `i`:
 * the end of one value. Brackets, strings, and comments are skipped whole.
 */
function skipValue(src, i, close) {
  const stack = [];
  while (i < src.length) {
    const char = src[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(src, i);
      continue;
    }
    if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      i = skipTrivia(src, i);
      continue;
    }
    if (stack.length === 0 && (char === "," || char === close)) return i;
    if (char === "{" || char === "[" || char === "(") stack.push({ "{": "}", "[": "]", "(": ")" }[char]);
    else if (char === "}" || char === "]" || char === ")") {
      if (stack.pop() !== char) return -1;
    }
    i++;
  }
  return -1;
}

/** The end of a value's own text, before trailing whitespace. */
function trimEnd(src, start, end) {
  while (end > start && /\s/.test(src[end - 1])) end--;
  return end;
}

/** The end of the code from `start` to `end`: past its last character outside comments. */
function codeEnd(src, start, end) {
  let last = start;
  let i = start;
  while (i < end) {
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") last = i = skipString(src, i);
    else if (src.startsWith("//", i) || src.startsWith("/*", i)) i = skipTrivia(src, i);
    else if (/\s/.test(src[i])) i++;
    else last = ++i;
  }
  return last;
}

/**
 * The comments from `from` to `to`, which hold only trivia and commas: those
 * before the first line break trail the code before them; the rest lead what
 * follows. `trailEnd` is the end of the last trailing comment, or -1.
 */
function commentsBetween(src, from, to) {
  const trail = [];
  const lead = [];
  let trailEnd = -1;
  let broken = false;
  let i = from;
  while (i < to) {
    if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      const end = src.startsWith("//", i) ? (src.includes("\n", i) ? Math.min(src.indexOf("\n", i), to) : to) : Math.min(src.indexOf("*/", i + 2) + 2, to);
      if (broken) lead.push(src.slice(i, end));
      else {
        trail.push(src.slice(i, end));
        trailEnd = end;
      }
      i = end;
    } else {
      if (src[i] === "\n") broken = true;
      i++;
    }
  }
  return { trail, lead, trailEnd };
}

/** `src` with comments and what literals hold blanked (`maskScript`), for the last file read. */
let lastMasked = { src: "", masked: "" };
function masked(src) {
  if (lastMasked.src !== src) lastMasked = { src, masked: maskScript(src).masked };
  return lastMasked.masked;
}

/**
 * The entries of the object or array literal whose `{` or `[` is at `open`.
 * Each entry has its key (objects), `start`, `valueStart`, `valueEnd` (the end
 * of its code, before any comment), `comma` (the index of its comma, or -1),
 * `trailEnd` (where the comments on its line, past its comma, end), and its
 * comments: `lead` on the lines before it and `trail` on its line. `tail` holds
 * the comments after the last entry. Null when it can't be read.
 */
function parseLiteral(src, open) {
  // Its structure is read from the code alone, so a bracket or quote in a string, comment, or regular expression is never taken for one.
  const code = masked(src);
  const close = src[open] === "{" ? "}" : "]";
  const entries = [];
  let i = skipTrivia(code, open + 1);
  // Comments before the first entry, on the opening line or after it, lead it.
  const opening = commentsBetween(src, open + 1, i);
  let lead = [...opening.trail, ...opening.lead];
  while (i < src.length && code[i] !== close) {
    const entry = { key: null, start: i, valueStart: i, valueEnd: i, comma: -1, trailEnd: i, lead, trail: [] };
    if (close === "}") {
      const key = /^(?:([A-Za-z_$][\w$]*)|(["'])([^"']*)\2)/.exec(src.slice(i));
      if (src.startsWith("...", i)) entry.key = "...";
      else if (key === null) entry.key = "";
      else {
        entry.key = key[1] ?? key[3];
        const after = skipTrivia(code, i + key[0].length);
        // `key: value`; a shorthand `key,` keeps the name as its value.
        if (code[after] === ":") i = skipTrivia(code, after + 1);
        else if (code[after] !== "," && code[after] !== "}") entry.key = "";
      }
      entry.valueStart = i;
    }
    const stop = skipValue(code, i, close);
    if (stop === -1) return null;
    entry.valueEnd = codeEnd(code, entry.valueStart, stop);
    if (code[stop] === ",") entry.comma = stop;
    const next = skipTrivia(code, entry.comma === -1 ? stop : stop + 1);
    const comments = commentsBetween(src, entry.valueEnd, next);
    entry.trail = comments.trail;
    entry.trailEnd = comments.trailEnd !== -1 ? comments.trailEnd : entry.comma !== -1 ? entry.comma + 1 : entry.valueEnd;
    lead = comments.lead;
    i = next;
    entries.push(entry);
  }
  return i < src.length ? { open, close: i, entries, tail: lead } : null;
}

/** A string literal's value, or null when `text` is anything else. */
function stringValue(text) {
  const match = /^(["'`])([^"'`\\$]*)\1$/.exec(text.trim());
  return match === null ? null : match[2];
}

/**
 * The configuration object nuxt.config exports by default: the object in
 * `export default defineNuxtConfig({…})` or `export default {…}`, or in the
 * one `const config = defineNuxtConfig({…})` that `export default config`
 * names. Null when it exports anything else.
 */
function configObject(src) {
  const text = masked(src);
  let call = /\bexport\s+default\s+defineNuxtConfig\s*\(\s*\{/.exec(text) ?? /\bexport\s+default\s*\{/.exec(text);
  const name = call === null ? /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/m.exec(text)?.[1] : undefined;
  if (name !== undefined) {
    const declared = [...text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*defineNuxtConfig\\s*\\(\\s*\\{`, "g"))];
    if (declared.length === 1) call = declared[0];
  }
  return call === null ? null : parseLiteral(src, call.index + call[0].length - 1);
}

/** How the file writes things: quote, indentation unit, and whether the last entry keeps a comma. */
function styleOf(src, object) {
  const quote = /(["'])/.exec(src.slice(object.open, object.close))?.[1] ?? "'";
  const first = object.entries[0];
  const indent = first === undefined ? "  " : (/\n([^\S\n]*)$/.exec(src.slice(0, first.start))?.[1] ?? "  ");
  const last = object.entries.at(-1);
  return { quote, indent: indent === "" ? "  " : indent, trailing: last !== undefined && last.comma !== -1, multiline: src.slice(object.open, object.close).includes("\n") };
}

const quoted = (value, quote) => `${quote}${value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;

/** The edits that append `texts` as the literal's last entries, in its layout. */
function appendEntries(src, literal, texts, style, indent) {
  const last = literal.entries.at(-1);
  const multiline = src.slice(literal.open, literal.close).includes("\n");
  const separator = multiline ? `\n${indent}` : " ";
  if (last === undefined) {
    // After any comments the empty literal holds.
    const at = trimEnd(src, literal.open + 1, literal.close);
    if (multiline) {
      const closing = /\n([^\S\n]*)$/.exec(src.slice(0, literal.close))?.[1] ?? "";
      return [[at, literal.close, `\n${indent}${texts.join(`,\n${indent}`)}${style.trailing ? "," : ""}\n${closing}`]];
    }
    return [[at, literal.close, src[literal.open] === "{" ? ` ${texts.join(", ")} ` : texts.join(", ")]];
  }
  if (last.comma !== -1) return [[last.trailEnd, last.trailEnd, texts.map((text) => `${separator}${text},`).join("")]];
  const added = texts.map((text, index) => `${index > 0 ? "," : ""}${separator}${text}`).join("");
  if (last.trailEnd === last.valueEnd) return [[last.valueEnd, last.valueEnd, `,${added}`]];
  // The comma after the code, the new entries after the comment on its line.
  return [
    [last.valueEnd, last.valueEnd, ","],
    [last.trailEnd, last.trailEnd, added],
  ];
}

// ---------------------------------------------------------------------------
// What the config says and should say

/** nuxt.config's path, honouring the person's choice. */
function configFile(root, entry) {
  if (entry !== null) return isAbsolute(entry) ? entry : join(root, entry);
  for (const name of CONFIGS) if (readText(join(root, name)) !== null) return join(root, name);
  return null;
}

/** How one `critiqs` setting reads, from its value text; absent keys come from the module's defaults. */
function readSetting(name, text) {
  if (text === undefined) return name === "projectId" ? { kind: "env", variable: VARIABLE } : null;
  const value = stringValue(text);
  if (value !== null) return { kind: "literal", value };
  const env = /^process\.env\.(\w+)$/.exec(text.trim()) ?? /^process\.env\[(["'])(\w+)\1\]$/.exec(text.trim());
  if (env !== null) return { kind: "env", variable: env[2] ?? env[1] };
  return { kind: "expression", text: text.trim() };
}

/** Whether an entry of a literal is a spread or a computed key, which could set any key. */
const opaque = (entry) => entry.key === "" || entry.key === "...";

/**
 * How the config could set `runtimeConfig.public.critiqs`, which wins over
 * the module's settings (keys quoted or not): `runtime` at its `critiqs`
 * entry, `runtimeCode` where the runtime config or its `public` is set from
 * code, or null when it doesn't.
 */
function publicCritiqs(src, runtime) {
  const fromCode = { error: "runtimeCode", at: runtime.start };
  if (src[runtime.valueStart] !== "{") return fromCode;
  const object = parseLiteral(src, runtime.valueStart);
  if (object === null || object.entries.some(opaque)) return fromCode;
  const shared = object.entries.find((e) => e.key === "public");
  if (shared === undefined) return null;
  if (src[shared.valueStart] !== "{") return { error: "runtimeCode", at: shared.start };
  const inner = parseLiteral(src, shared.valueStart);
  if (inner === null || inner.entries.some(opaque)) return { error: "runtimeCode", at: shared.start };
  const critiqs = inner.entries.find((e) => e.key === "critiqs");
  return critiqs === undefined ? null : { error: "runtime", at: critiqs.start };
}

/** Whether the file imports critiqs-nuxt itself, so modules may list it under any name. */
function importsModule(src) {
  const code = masked(src);
  return [...src.matchAll(/\bimport\s+[^;"'`]*?\bfrom\s*(["'])critiqs-nuxt\1/g)].some((match) => code.startsWith("import", match.index));
}

/** Reads the module and its settings from the config. */
function readConfig(src) {
  const config = configObject(src);
  // A spread or computed key could set anything, modules included.
  if (config === null || config.entries.some(opaque)) return { error: "unreadable" };
  const modulesEntry = config.entries.find((e) => e.key === "modules");
  let modules = null;
  let listed = null;
  /** `['critiqs-nuxt', { … }]`: listed with its options inline, which setup reads but doesn't edit. */
  let tuple = null;
  if (modulesEntry !== undefined) {
    if (src[modulesEntry.valueStart] !== "[") return { error: "modules", at: modulesEntry.start };
    modules = parseLiteral(src, modulesEntry.valueStart);
    if (modules === null) return { error: "unreadable" };
    for (const element of modules.entries) {
      const text = src.slice(element.valueStart, element.valueEnd);
      if (stringValue(text) === PACKAGE) listed = element;
      else if (text.startsWith("[") && text.includes(PACKAGE)) tuple = element;
      // A spread could hold the module already; any other mention is code setup can't follow.
      else if (text.startsWith("...")) return { error: "modulesSpread", at: element.start };
      else if (text.includes(PACKAGE)) return { error: "modules", at: element.start };
    }
  }
  if (listed === null && tuple === null && importsModule(src)) return { error: "imported", at: modulesEntry?.start };
  const critiqsEntry = config.entries.find((e) => e.key === "critiqs");
  let critiqs = null;
  const values = {};
  if (critiqsEntry !== undefined) {
    if (src[critiqsEntry.valueStart] !== "{") return { error: "critiqs", at: critiqsEntry.start };
    critiqs = parseLiteral(src, critiqsEntry.valueStart);
    if (critiqs === null) return { error: "unreadable" };
    // A spread or computed key could set any setting, so what's in effect is unknown.
    if (critiqs.entries.some(opaque)) return { error: "spread", at: critiqsEntry.start };
    for (const entry of critiqs.entries) values[entry.key] = src.slice(entry.valueStart, entry.valueEnd);
  }
  const runtime = config.entries.find((e) => e.key === "runtimeConfig");
  const overrides = runtime === undefined ? null : publicCritiqs(src, runtime);
  if (overrides !== null) return overrides;
  if (tuple !== null) {
    const [name, options] = parseLiteral(src, tuple.valueStart)?.entries ?? [];
    const inline = options !== undefined && src[options.valueStart] === "{" ? parseLiteral(src, options.valueStart) : null;
    if (name === undefined || stringValue(src.slice(name.valueStart, name.valueEnd)) !== PACKAGE) tuple = null;
    else for (const entry of inline?.entries ?? []) if (entry.key) values[entry.key] = src.slice(entry.valueStart, entry.valueEnd);
  }
  return { config, modulesEntry, modules, listed, tuple, critiqsEntry, critiqs, values };
}

/** The `critiqs` entries setup wants, as [key, value text]. */
function wantedSettings(settings, quote) {
  const wanted = [];
  if ("literal" in settings.projectId) wanted.push(["projectId", quoted(settings.projectId.literal, quote)]);
  else if (settings.projectId.env.variable !== VARIABLE) wanted.push(["projectId", `process.env.${settings.projectId.env.variable}`]);
  if ("literal" in settings.projectId && !settings.requireProjectId) wanted.push(["requireProjectId", "false"]);
  if (settings.backend !== undefined) wanted.push(["backend", quoted(settings.backend, quote)]);
  return wanted;
}

/** Whether the current value text already means the wanted one; `requireProjectId: true` is the default written out. */
function same(name, current, wanted) {
  if (name === "requireProjectId") return (current?.trim() ?? "true") === (wanted ?? "true");
  if (current === undefined || wanted === undefined) return current === wanted;
  const a = readSetting(name, current);
  const b = readSetting(name, wanted);
  return a?.kind === b?.kind && (a.kind === "literal" ? a.value === b.value : a.kind === "env" ? a.variable === b.variable : a.text === b.text);
}

/**
 * A `critiqs: {…}` entry with these entries (`text`, and the comments that
 * `lead` and `trail` it) and `tail` comments, kept on one line when it has one
 * entry and no comments.
 */
function critiqsText(entries, tail, style, indent) {
  const commented = tail.length > 0 || entries.some((entry) => entry.lead.length > 0 || entry.trail.length > 0);
  if (entries.length === 1 && !commented) return `critiqs: { ${entries[0].text} }`;
  const inner = `${indent}${indent}`;
  const lines = entries.flatMap((entry, index) => [
    ...entry.lead.map((comment) => `${inner}${comment}`),
    `${inner}${entry.text}${index < entries.length - 1 || style.trailing ? "," : ""}${entry.trail.length > 0 ? ` ${entry.trail.join(" ")}` : ""}`,
  ]);
  return `critiqs: {\n${[...lines, ...tail.map((comment) => `${inner}${comment}`)].join("\n")}\n${indent}}`;
}

function where(root, file, line) {
  return `${relative(root, file) || file}:${line}`;
}

function refuse(reason, message) {
  return { ok: false, reason, message };
}

function steps(settings, file) {
  const env = "env" in settings.projectId ? settings.projectId.env : null;
  const entries = wantedSettings(settings, "'");
  return [
    `To add Critiqs by hand, in ${file}, add '${PACKAGE}' to modules${entries.length > 0 ? " and its settings under critiqs" : ""}:`,
    "  export default defineNuxtConfig({",
    `    modules: ['${PACKAGE}'],`,
    ...(entries.length > 0 ? [`    critiqs: { ${entries.map(([key, value]) => `${key}: ${value}`).join(", ")} },`] : []),
    "  })",
    ...(env === null ? [] : [`Then set ${env.variable}=<project ID> in .env for nuxt dev, and where each deployment ${env.readsAt === "runtime" ? "runs its server" : "builds"}.`]),
  ].join("\n");
}

/** The settings a new setup puts in effect, some through the module's defaults. */
function installed(settings) {
  const env = "env" in settings.projectId;
  return ["projectId", ...(settings.requireProjectId || env ? ["requireProjectId"] : []), ...(settings.backend === undefined ? [] : ["backend"])];
}

function nextSteps(settings) {
  return "env" in settings.projectId ? [`Restart nuxt dev so it reads ${settings.projectId.env.variable} from .env.`] : [];
}

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const nuxt = {
  id: "nuxt",
  name: "Nuxt",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "nuxt"),
  env(root, suffix) {
    const variable = `${VARIABLE}${suffix}`;
    // Nuxt maps NUXT_PUBLIC_CRITIQS_PROJECT_ID to runtime config by itself, when
    // the server starts; another name is read by nuxt.config when it builds.
    return suffix === ""
      ? {
          variable,
          expression: "useRuntimeConfig().public.critiqs.projectId",
          readsAt: "runtime",
          localFile: ".env",
          deploymentAdvice: `Set ${variable} where each deployment's server runs; Nuxt reads it when the server starts, so restarting applies a change. A static site (nuxt generate) reads it when it is generated.`,
        }
      : {
          variable,
          expression: `process.env.${variable}`,
          readsAt: "build",
          localFile: ".env",
          deploymentAdvice: `Set ${variable} in each deployment's build settings; nuxt.config reads it when the app builds, so a change takes effect on the next build.`,
        };
  },
  find(root) {
    const usages = vue.find(root);
    const file = configFile(root, null);
    const src = file === null ? null : readText(file);
    if (src === null) return usages;
    const read = readConfig(src);
    const listed = read.listed ?? read.tuple;
    if (read.error !== undefined || listed === null) return usages;
    return [
      {
        file,
        line: lineAt(src, listed.start),
        projectId: readSetting("projectId", read.values.projectId),
        backend: readSetting("backend", read.values.backend),
        requireProjectId: read.values.requireProjectId === undefined || read.values.requireProjectId.trim() !== "false",
      },
      ...usages,
    ];
  },
  plan(root, settings, options) {
    const components = vue.find(root);
    if (components.length > 0) {
      return refuse(
        "ambiguous",
        `This app already adds Critiqs with <Critiqs> from critiqs-vue (${components.map((u) => where(root, u.file, u.line)).join(", ")}), so nothing was changed. Remove it to use critiqs-nuxt instead, then run setup again.`,
      );
    }
    const file = configFile(root, options.entry);
    const src = file === null ? null : readText(file);
    if (src === null) return refuse("manual", `${options.entry === null ? "This app has no nuxt.config" : `Couldn't read ${options.entry}`}, so nothing was changed. ${steps(settings, "nuxt.config.ts")}`);
    const name = relative(root, file);
    const read = readConfig(src);
    if (read.error === undefined && read.tuple !== null) {
      read.error = "tuple";
      read.at = read.tuple.start;
    }
    if (read.error !== undefined) {
      const at = read.at === undefined ? name : where(root, file, lineAt(src, read.at));
      const why = {
        unreadable: `Couldn't read the configuration in ${name}`,
        modules: `${at} sets modules from code`,
        tuple: `${at} gives ${PACKAGE} its options inline`,
        critiqs: `${at} sets critiqs from code`,
        spread: `${at} spreads other settings into critiqs`,
        runtime: `${at} sets runtimeConfig.public.critiqs, which overrides the module's settings`,
        runtimeCode: `${at} sets runtimeConfig from code, which could override the module's settings`,
        modulesSpread: `${at} spreads other modules into modules, which could already list ${PACKAGE}`,
        imported: `${name} imports ${PACKAGE}, so modules may already list it under another name`,
      }[read.error];
      return refuse(read.error === "unreadable" ? "unreadable" : "expression", `${why}, so nothing was changed. ${steps(settings, name)}`);
    }
    const style = styleOf(src, read.config);
    const indent = style.indent;
    const edits = [];
    const changed = [];
    /** New entries at the end of the config, in order. */
    const appended = [];

    // The module, listed once.
    if (read.listed === null) {
      const text = quoted(PACKAGE, style.quote);
      if (read.modules === null) appended.push(`modules: [${text}]`);
      else {
        const first = read.modules.entries[0];
        const elementIndent = first === undefined ? `${indent}${indent}` : (/\n([^\S\n]*)$/.exec(src.slice(0, first.start))?.[1] ?? indent);
        edits.push(...appendEntries(src, read.modules, [text], styleOf(src, read.modules), elementIndent));
      }
    }

    // Its settings: Critiqs's own block, rewritten when it changes, keeping other keys as written.
    const wanted = wantedSettings(settings, style.quote);
    const wantedMap = new Map(wanted);
    for (const key of ["projectId", "requireProjectId", "backend"]) {
      const current = read.values[key];
      const next = wantedMap.get(key);
      if (same(key, current, next)) continue;
      if (current !== undefined && readSetting(key, current)?.kind === "expression" && key !== "requireProjectId") {
        return refuse("expression", `${where(root, file, lineAt(src, read.critiqsEntry.valueStart))} sets critiqs.${key} from code, so nothing was changed. ${steps(settings, name)}`);
      }
      if (key === "requireProjectId" && current !== undefined && !["true", "false"].includes(current.trim())) {
        return refuse("expression", `${where(root, file, lineAt(src, read.critiqsEntry.valueStart))} sets critiqs.requireProjectId from code, so nothing was changed. ${steps(settings, name)}`);
      }
      changed.push(key);
    }
    if (changed.length > 0) {
      // Settings that already say what's wanted stay as written; the developer's other keys follow.
      const own = ["projectId", "requireProjectId", "backend"];
      // Each entry keeps its comments, a changed one included.
      const written = (read.critiqs?.entries ?? []).map((e) => ({ key: e.key, text: src.slice(e.start, e.valueEnd), lead: e.lead, trail: e.trail }));
      const entries = [];
      // A removed setting's comments stay, leading the entry after it (or closing the block).
      let orphaned = [];
      const add = (entry) => {
        entries.push(orphaned.length === 0 ? entry : { ...entry, lead: [...orphaned, ...entry.lead] });
        orphaned = [];
      };
      for (const key of own) {
        const existing = written.filter((e) => e.key === key);
        if (!changed.includes(key)) existing.forEach(add);
        else if (wantedMap.has(key)) add({ lead: [], trail: [], ...existing[0], text: `${key}: ${wantedMap.get(key)}` });
        else orphaned.push(...existing.flatMap((e) => [...e.lead, ...e.trail]));
      }
      written.filter((e) => !own.includes(e.key)).forEach(add);
      if (read.critiqsEntry === undefined) {
        if (entries.length > 0) appended.push(critiqsText(entries, [], style, indent));
      } else if (entries.length === 0 && appended.length > 0) {
        // The block's place goes to what would have been appended, so no edit lands beside a removed entry.
        edits.push([read.critiqsEntry.start, read.critiqsEntry.valueEnd, appended.splice(0).join(`,${style.multiline ? `\n${indent}` : " "}`)]);
      } else if (entries.length === 0) {
        // Nothing left to say: remove the block, and its comma or the one before it.
        const index = read.config.entries.indexOf(read.critiqsEntry);
        const previous = read.config.entries[index - 1];
        let start = read.critiqsEntry.start;
        while (start > 0 && /\s/.test(src[start - 1])) start--;
        const end = read.critiqsEntry.comma !== -1 ? read.critiqsEntry.comma + 1 : read.critiqsEntry.valueEnd;
        edits.push(read.critiqsEntry.comma === -1 && previous !== undefined ? [previous.comma, end, ""] : [start, end, ""]);
      } else {
        edits.push([read.critiqsEntry.start, read.critiqsEntry.valueEnd, critiqsText(entries, [...orphaned, ...read.critiqs.tail], style, indent)]);
      }
    }

    if (appended.length > 0) edits.push(...appendEntries(src, read.config, appended, style, indent));
    if (edits.length === 0) {
      return { ok: true, action: "unchanged", writes: [], file, line: lineAt(src, read.listed.start), changed: [], preview: "", next: [] };
    }
    let updated = src;
    for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0])) updated = updated.slice(0, start) + text + updated.slice(end);
    const after = readConfig(updated);
    return {
      ok: true,
      action: read.listed === null ? "install" : "update",
      writes: [{ file, original: src, source: updated }],
      file,
      line: after.listed ? lineAt(updated, after.listed.start) : 1,
      changed: read.listed === null ? installed(settings) : changed,
      preview: changedLines(src, updated).join("\n"),
      next: nextSteps(settings),
    };
  },
  manual: (settings) =>
    `Add Critiqs to this Nuxt app with project ID ${describeProjectId(settings)}.\n` + `0. Install the package: npm install ${PACKAGE}\n` + steps(settings, "nuxt.config.ts"),
};
