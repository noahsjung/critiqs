// Astro setup: adds `critiqs()` from critiqs-astro to astro.config's
// `integrations`, or updates the one already there. The integration adds
// Critiqs to every page; a project ID set per deployment comes from
// PUBLIC_CRITIQS_PROJECT_ID, which Astro writes into the site when it builds.
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dependsOn, describeProjectId, readText } from "./shared.mjs";

/** The config files Astro loads. */
const CONFIG_FILES = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts", "astro.config.cjs", "astro.config.cts"];
/** The variable critiqs-astro reads when its options name none; keep in step with packages/astro. */
const DEFAULT_VARIABLE = "PUBLIC_CRITIQS_PROJECT_ID";
const PACKAGE = "critiqs-astro";
/** The integration's options setup writes; any others are left as they are. */
const MANAGED = ["projectId", "projectIdVariable", "requireProjectId", "backend"];

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const astro = {
  id: "astro",
  name: "Astro",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "astro"),
  env: (root, suffix) => {
    const variable = `${DEFAULT_VARIABLE}${suffix}`;
    const { file, problem } = envFile(root, variable);
    const convention = {
      variable,
      expression: `import.meta.env.${variable}`,
      readsAt: "build",
      localFile: file,
      deploymentAdvice: `Set ${variable} in each deployment's build environment. Astro writes it into the site when it builds, so a change takes effect with the next build.`,
      loads: envFiles("development"),
      problem,
    };
    return convention;
  },
  find(root) {
    // Astro loads the first config file in CONFIG_FILES order; report what that one sets up,
    // so an app with a stray second config still shows its working integration.
    const configs = configFiles(root, null);
    const config = configs.length > 0 ? readConfig(configs[0]) : null;
    if (config === null || "error" in config) return [];
    return config.calls.map((call) => ({ file: config.file, line: lineAt(config.source, call.start), ...readSettings(config, call) }));
  },
  plan(root, settings, options) {
    const target = desired(settings);
    if ("error" in target) return refuse("manual", target.error, settings);
    const problem = "env" in settings.projectId ? envFile(root, settings.projectId.env.variable).problem : null;
    if (problem !== null) return refuse("ambiguous", problem, settings);
    const configs = configFiles(root, options.entry);
    if (configs.length > 1) {
      const names = configs.map((file) => relative(root, file)).join(", ");
      return refuse("ambiguous", `This app has several Astro config files (${names}), so setup can't tell which one Astro loads. Remove the extras, or choose one with --entry.`, settings);
    }
    if (configs.length === 0 && options.entry !== null) return refuse("unreadable", `${options.entry} doesn't exist in this app.`, settings);

    if (configs.length === 0) {
      const file = join(root, "astro.config.mjs");
      const source = newConfig(target);
      return { ok: true, action: "install", writes: [{ file, original: null, source }], file, line: lineAt(source, source.indexOf("critiqs(")), changed: installed(target), preview: preview(source, "critiqs"), next: [] };
    }

    const config = readConfig(configs[0]);
    if (config === null) return refuse("unreadable", `Setup couldn't read ${configs[0]}.`, settings);
    if ("error" in config) return refuse(config.reason, `Setup can't edit ${configs[0]} safely: ${config.error}`, settings);
    if (config.calls.length > 1) {
      const lines = config.calls.map((call) => lineAt(config.source, call.start)).join(", ");
      return refuse("ambiguous", `${config.file} calls ${config.name}() ${config.calls.length} times (lines ${lines}). Keep one, then run setup again.`, settings);
    }
    const existing = config.calls[0];
    const edited = existing === undefined ? addCall(config, target) : updateCall(config, existing, target);
    if ("error" in edited) return refuse(edited.reason, `Setup can't edit ${config.file} safely: ${edited.error}`, settings);
    const action = existing === undefined ? "install" : edited.source === config.source ? "unchanged" : "update";
    return {
      ok: true,
      action,
      writes: action === "unchanged" ? [] : [{ file: config.file, original: config.source, source: edited.source }],
      file: config.file,
      line: lineAt(edited.source, edited.at),
      changed: edited.changed,
      preview: preview(edited.source, config.name),
      next: [],
    };
  },
  manual(settings) {
    const target = desired(settings);
    const call = "error" in target ? `critiqs({ projectId: '${describeProjectId(settings)}' })` : callText(target, "'", "critiqs");
    const lines = [
      "Add Critiqs to this Astro app by hand:",
      "",
      `1. Install the integration: npm install ${PACKAGE}`,
      "2. In astro.config.mjs (or your astro.config file), import it and add it to `integrations`,",
      "   keeping any integrations already in the list:",
      "",
      "     import { defineConfig } from 'astro/config';",
      `     import critiqs from '${PACKAGE}';`,
      "",
      "     export default defineConfig({",
      `       integrations: [${call}],`,
      "     });",
    ];
    if ("env" in settings.projectId) {
      const { variable, localFile } = settings.projectId.env;
      lines.push(
        "",
        `3. Set ${variable} to your project ID in ${localFile ?? ".env"} for this computer, and in each deployment's build environment.`,
        "   Astro writes it into the site when it builds; a build without it shows no Critiqs.",
      );
    }
    return lines.join("\n");
  },
};

/** The Astro config files in `root`, or the one `entry` names. */
function configFiles(root, entry) {
  if (entry !== null) {
    const file = resolve(root, entry);
    return existsSync(file) ? [file] : [];
  }
  return CONFIG_FILES.map((name) => join(root, name)).filter((file) => existsSync(file));
}

/** The modes Astro runs in on this computer: `astro dev`, and `astro build` and `astro preview`. */
const MODES = ["development", "production"];

/** The `.env` files Astro (through Vite) loads in `mode`, highest precedence first. */
function envFiles(mode) {
  return [`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"];
}

/**
 * The file setup writes this computer's project ID to: the one that sets
 * `variable` in every mode, or `.env` (which Astro's starter keeps out of
 * Git) when none does. When a mode's own file sets it, a value written
 * anywhere else wouldn't take effect in that mode, and `problem` says so.
 */
function envFile(root, variable) {
  const winners = MODES.map((mode) => envFiles(mode).find((file) => setsVariable(readText(join(root, file)), variable)) ?? null);
  const own = [...new Set(winners.filter((file) => file !== null && file !== ".env" && file !== ".env.local"))];
  if (own.length === 0) return { file: winners.find((file) => file !== null) ?? ".env", problem: null };
  const files = own.join(" and ");
  const problem =
    `${variable} is already set in ${files}, which Astro reads before .env and .env.local ${own.length === 1 ? "in that mode" : "in those modes"}, so a project ID set anywhere else wouldn't take effect there. ` +
    `Remove ${variable} from ${files} and run setup again, or set it to your project ID there yourself.`;
  return { file: own[0], problem };
}

/** Whether `.env` text defines `variable`, as Vite's dotenv reads it (`NAME=value`, `export NAME=value`). */
function setsVariable(text, variable) {
  return (text ?? "").split(/\r?\n/).some((line) => /^\s*(?:export\s+)?([\w.-]+)\s*(?:=|:\s)/.exec(line)?.[1] === variable);
}

function refuse(reason, why, settings) {
  return { ok: false, reason, message: `${why}\n\n${astro.manual(settings)}` };
}

/**
 * What the integration's options should mean. `projectId` and
 * `projectIdVariable` are its own option names; null leaves the option out.
 */
function desired(settings) {
  const backend = settings.backend ?? null;
  if ("literal" in settings.projectId) {
    return { fromEnv: false, projectId: settings.projectId.literal, projectIdVariable: null, requireProjectId: settings.requireProjectId, backend };
  }
  const { variable } = settings.projectId.env;
  if (!/^PUBLIC_[A-Za-z0-9_]+$/.test(variable)) {
    return { error: `Astro gives the browser only variables that start with PUBLIC_, so ${variable} can't hold the project ID.` };
  }
  return { fromEnv: true, projectId: null, projectIdVariable: variable === DEFAULT_VARIABLE ? null : variable, requireProjectId: true, backend };
}

/** The settings a new call sets. */
function installed(target) {
  return ["projectId", "requireProjectId", ...(target.backend === null ? [] : ["backend"])];
}

/** The options a new call writes, leaving out what the integration does by default. */
function optionEntries(target, quote) {
  const entries = [];
  if (target.projectId !== null) entries.push(["projectId", quoted(target.projectId, quote)]);
  if (target.projectIdVariable !== null) entries.push(["projectIdVariable", quoted(target.projectIdVariable, quote)]);
  // The integration requires a project ID read from the environment, and not one written in the config, unless told otherwise.
  if (target.requireProjectId !== target.fromEnv) entries.push(["requireProjectId", String(target.requireProjectId)]);
  if (target.backend !== null) entries.push(["backend", quoted(target.backend, quote)]);
  return entries;
}

function callText(target, quote, name) {
  return `${name}(${objectText(optionEntries(target, quote).map(([key, value]) => ({ key, value })), null)})`;
}

function quoted(value, quote) {
  return quote === "'" ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'` : JSON.stringify(value);
}

function newConfig(target) {
  return `// @ts-check\nimport { defineConfig } from 'astro/config';\nimport critiqs from '${PACKAGE}';\n\n// https://astro.build/config\nexport default defineConfig({\n  integrations: [${callText(target, "'", "critiqs")}],\n});\n`;
}

// ---- Reading the config ----------------------------------------------------

/** The code before a `/` that starts a regular expression rather than dividing: an operator, an opening bracket, or a keyword. */
const BEFORE_REGEX = /(?:[(,=:[!&|?{};~^%*+\-<>]|(?<![\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await))$/;

/**
 * Two copies of `source`, the same length, for finding code by position:
 * `code` with comments blanked, and `masked` with the contents of strings and
 * regular expressions blanked as well, so brackets, quotes and commas inside
 * them don't count. Template literals are blanked whole. Newlines are kept.
 * `comments` lists each comment's start and end.
 */
function mask(source) {
  let code = "";
  let masked = "";
  const comments = [];
  for (let i = 0; i < source.length; ) {
    const char = source[i];
    if (char === "/" && source[i + 1] !== "/" && source[i + 1] !== "*" && (masked.trim() === "" || BEFORE_REGEX.test(masked.trimEnd().slice(-12)))) {
      // A regular expression: up to the `/` outside a character class, then its flags.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      if (source[j] === "/") while (j + 1 < source.length && /[a-z]/i.test(source[j + 1])) j += 1;
      const text = source.slice(i, j + 1);
      code += text;
      masked += "/" + text.slice(1).replace(/[^\n]/g, "_");
      i = j + 1;
    } else if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const end = source[i + 1] === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 2;
      const stop = end <= i + 1 ? source.length : end;
      const blank = source.slice(i, stop).replace(/[^\n]/g, " ");
      code += blank;
      masked += blank;
      comments.push({ start: i, end: stop });
      i = stop;
    } else if (char === "'" || char === '"' || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char) j += source[j] === "\\" ? 2 : 1;
      const text = source.slice(i, j + 1);
      code += text;
      masked += char + text.slice(1, -1).replace(/[^\n]/g, "_") + (j < source.length ? char : "");
      i = j + 1;
    } else {
      code += char;
      masked += char;
      i += 1;
    }
  }
  return { code, masked, comments };
}

/** The index of the bracket that closes the one at `open` in masked text, or -1. */
function closing(masked, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < masked.length; i++) {
    const char = masked[i];
    if (char in pairs) stack.push(pairs[char]);
    else if (char === ")" || char === "]" || char === "}") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * The comma-separated items between the brackets at `open` and `close`,
 * without a trailing comma's empty item. Each is trimmed of the spaces and
 * comments around it, and a stretch holding only comments is no item.
 */
function items(source, masked, open, close) {
  const found = [];
  let depth = 0;
  let start = open + 1;
  const push = (end) => {
    const text = masked.slice(start, end);
    const from = start + text.length - text.trimStart().length;
    const to = start + text.trimEnd().length;
    if (from < to) found.push({ start: from, end: to, text: source.slice(from, to) });
  };
  for (let i = open + 1; i < close; i++) {
    const char = masked[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(close);
  return found;
}

/**
 * The config as setup can edit it: the object `export default` gives (bare
 * or through defineConfig), the integration's local name, and its calls.
 */
function readConfig(file) {
  const source = readText(file);
  if (source === null) return null;
  const { code, masked, comments } = mask(source);
  const quote = /^import\s[^'"]*(['"])/m.exec(code)?.[1] ?? "'";
  const semicolon = !/^import\s[^;]*?from\s*['"][^'"\n]*['"][ \t]*\r?$/m.test(code);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";

  const exported = /\bexport\s+default\s+(?:defineConfig\s*\(\s*)?\{/.exec(masked);
  if (exported === null) return { error: "it doesn't export its settings as `export default defineConfig({ … })`.", reason: "unreadable" };
  const open = exported.index + exported[0].length - 1;
  const close = closing(masked, open);
  if (close === -1) return { error: "its brackets don't balance.", reason: "unreadable" };

  const imported = new RegExp(`^import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]${PACKAGE}['"];?[ \\t]*\\r?$`, "m").exec(code);
  if (imported === null && code.includes(PACKAGE)) {
    return { error: `it uses ${PACKAGE} in a way setup doesn't recognize; import it as \`import critiqs from '${PACKAGE}'\`.`, reason: "unreadable" };
  }
  const name = imported?.[1] ?? "critiqs";
  if (imported === null && new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(masked)) {
    return { error: `the name ${name} is already used, so setup can't import ${PACKAGE} under it.`, reason: "unreadable" };
  }
  const calls = [];
  if (imported !== null) {
    for (const match of masked.matchAll(new RegExp(`(?<![\\w$.])${name.replaceAll("$", "\\$")}\\s*\\(`, "g"))) {
      const callOpen = match.index + match[0].length - 1;
      calls.push({ start: match.index, open: callOpen, close: closing(masked, callOpen) });
    }
  }
  return { file, source, masked, comments, quote, semicolon, eol, object: { open, close }, name, imported, calls };
}

/** A call's options as properties with their value text, or why setup can't read them. */
function callOptions(config, call) {
  const { source, masked } = config;
  const { open, close } = call;
  if (close === -1) return { error: `a ${config.name}() call's brackets don't balance.`, reason: "unreadable" };
  const args = items(source, masked, open, close);
  if (args.length === 0) return { properties: [], object: null };
  const object = { open: args[0].start, close: args[0].end - 1 };
  if (args.length > 1 || masked[object.open] !== "{" || closing(masked, object.open) !== object.close) {
    return { error: `${config.name}() gets its options from code setup can't read; give them as an object, such as critiqs({ projectId: '…' }).`, reason: "expression" };
  }
  if (mask(source.slice(open, close)).comments.length > 0) return { error: `${config.name}()'s options have comments, which setup leaves to you.`, reason: "expression" };
  const properties = [];
  for (const item of items(source, masked, object.open, object.close)) {
    const property = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(item.text);
    if (property === null) return { error: `${config.name}() has an option setup can't read: ${item.text.split("\n")[0]}.`, reason: "expression" };
    properties.push({ key: property[1], value: property[2] });
  }
  return { properties, object };
}

/** A string literal's value, or null when the text is anything else. */
function stringValue(text) {
  const match = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(text ?? "");
  if (match === null || (match[1] === "`" && match[2].includes("${"))) return null;
  return match[2].replace(/\\(.)/g, "$1");
}

/** What a call's options mean, as setup describes settings. */
function readSettings(config, call) {
  const options = callOptions(config, call);
  if ("error" in options) return { projectId: { kind: "expression", text: config.source.slice(call.start, call.close + 1) }, backend: null, requireProjectId: false };
  const values = new Map(options.properties.map(({ key, value }) => [key, value]));
  const read = (text) => (text === undefined ? null : stringValue(text) !== null ? { kind: "literal", value: stringValue(text) } : { kind: "expression", text });
  const variableText = values.get("projectIdVariable");
  const variable = variableText === undefined ? DEFAULT_VARIABLE : stringValue(variableText);
  const fromEnv = !values.has("projectId");
  const projectId = !fromEnv ? read(values.get("projectId")) : variable !== null ? { kind: "env", variable } : { kind: "expression", text: variableText };
  const required = values.get("requireProjectId");
  return { projectId, backend: read(values.get("backend")), requireProjectId: required === undefined ? fromEnv : required === "true" };
}

// ---- Editing the config ----------------------------------------------------

/**
 * The `integrations` property Astro gets from the config object: the last
 * one, unless a spread or a computed name after it may set its own. `others`
 * are the earlier ones it replaces; `property` is undefined when there is none.
 */
function effectiveIntegrations(config) {
  const { source, masked, object } = config;
  const properties = items(source, masked, object.open, object.close);
  const names = properties.map((property) => propertyName(property.text));
  const index = names.lastIndexOf("integrations");
  if (names.slice(index + 1).some((name) => name === null || name === "...")) {
    const why = index === -1 ? "it spreads other settings into its config, or names one with code, which may set `integrations`; setup can't tell which list Astro uses." : "settings spread into its config after `integrations`, or named with code there, may replace that list.";
    return { error: why, reason: "expression" };
  }
  return { property: properties[index], others: properties.filter((_, each) => each !== index && names[each] === "integrations") };
}

/** Rewrites the options of the call already in the config, changing only what differs from `target`. */
function updateCall(config, call, target) {
  // Only the call in the list Astro uses: an edit to one a later setting replaces would change nothing.
  const list = effectiveIntegrations(config);
  if ("error" in list) return list;
  const line = lineAt(config.source, call.start);
  const inObject = call.start > config.object.open && call.start < config.object.close;
  if (inObject && (list.property === undefined || call.start < list.property.start || call.close >= list.property.end)) {
    const why = list.others.some((other) => other.start <= call.start && call.close < other.end) ? "a later `integrations` replaces the list holding it" : "it isn't in `integrations`";
    return { error: `Astro doesn't use the ${config.name}() call on line ${line}: ${why}. Move it into the last \`integrations\` list, then run setup again.`, reason: "expression" };
  }
  if (!inObject && list.others.length > 0) {
    return { error: `the config sets \`integrations\` more than once, so setup can't tell whether Astro uses the list holding the ${config.name}() call on line ${line}. Keep one \`integrations\`, then run setup again.`, reason: "expression" };
  }
  const options = callOptions(config, call);
  if ("error" in options) return options;
  const current = new Map(options.properties.map(({ key, value }) => [key, value]));
  for (const key of MANAGED) {
    const text = current.get(key);
    const readable = text === undefined || (key === "backend" && target.backend === null) || (key === "requireProjectId" ? text === "true" || text === "false" : stringValue(text) !== null);
    if (!readable) return { error: `${config.name}() sets ${key} with code (${text.split("\n")[0]}), which setup leaves to you.`, reason: "expression" };
  }
  const has = (key) => current.has(key);
  const value = (key) => stringValue(current.get(key));
  const quote = (text) => quoted(text, config.quote);
  // Each managed option's new value text: undefined keeps it as it is, null removes it.
  const variable = (has("projectIdVariable") ? value("projectIdVariable") : DEFAULT_VARIABLE) === (target.projectIdVariable ?? DEFAULT_VARIABLE);
  const required = (has("requireProjectId") ? current.get("requireProjectId") === "true" : target.fromEnv) === target.requireProjectId;
  const next = {
    projectId: target.projectId === null ? (has("projectId") ? null : undefined) : value("projectId") === target.projectId ? undefined : quote(target.projectId),
    projectIdVariable: !target.fromEnv ? (has("projectIdVariable") ? null : undefined) : variable ? undefined : target.projectIdVariable === null ? null : quote(target.projectIdVariable),
    requireProjectId: required ? undefined : target.requireProjectId === target.fromEnv ? null : String(target.requireProjectId),
    // Settings without a backend leave the one there, such as a team's own server.
    backend: target.backend === null || value("backend") === target.backend ? undefined : quote(target.backend),
  };
  const changed = [...new Set(MANAGED.filter((key) => next[key] !== undefined).map((key) => (key === "projectIdVariable" ? "projectId" : key)))];
  if (changed.length === 0) return { source: config.source, at: call.start, changed };

  const properties = options.properties
    .filter(({ key }) => next[key] !== null)
    .map(({ key, value }) => ({ key, value: next[key] ?? value }));
  for (const key of MANAGED) if (!has(key) && typeof next[key] === "string") properties.push({ key, value: next[key] });
  const { source } = config;
  // With no option left, the argument goes with any comma and line breaks around it: critiqs({ projectId: '…' },) becomes critiqs().
  const [start, end] = options.object === null || properties.length === 0 ? [call.open + 1, call.close] : [options.object.open, options.object.close + 1];
  const text = objectText(properties, options.object === null ? null : { text: source.slice(start, end), indent: lineIndent(source, call.start), eol: config.eol });
  return { source: source.slice(0, start) + text + source.slice(end), at: call.start, changed };
}

/** Options as an object in the layout the original uses: on one line, or one option per line. */
function objectText(properties, original) {
  if (properties.length === 0) return "";
  if (original === null || !original.text.includes("\n")) return `{ ${properties.map(({ key, value }) => `${key}: ${value}`).join(", ")} }`;
  const inner = /\n([ \t]*)\S/.exec(original.text)[1];
  const trailing = /,\s*}$/.test(original.text);
  const lines = properties.map(({ key, value }, index) => `${inner}${key}: ${value}${index < properties.length - 1 || trailing ? "," : ""}`);
  return `{${original.eol}${lines.join(original.eol)}${original.eol}${original.indent}}`;
}

/** Adds the import and a call to `integrations`, making the list when there is none. */
function addCall(config, target) {
  const { masked, object } = config;
  const call = callText(target, config.quote, config.name);
  const list = effectiveIntegrations(config);
  if ("error" in list) return list;
  const integrations = list.property;
  let edit;
  if (integrations !== undefined) {
    const opening = /^(?:[\w$]+|(['"])[^'"]*\1)\s*:\s*\[/.exec(masked.slice(integrations.start, integrations.end));
    const open = opening === null ? -1 : integrations.start + opening[0].length - 1;
    if (open === -1 || closing(masked, open) !== integrations.end - 1) {
      return { error: "its `integrations` isn't a list written in the config, so setup can't add critiqs() to it.", reason: "unreadable" };
    }
    edit = appendItem(config, open, integrations.end - 1, call, call);
  } else {
    edit = appendItem(config, object.open, object.close, `integrations: [${call}]`, call);
  }
  let updated = edit.source;
  let at = edit.at;
  if (config.imported === null) {
    const statement = `import ${config.name} from ${quoted(PACKAGE, config.quote)}${config.semicolon ? ";" : ""}`;
    const { masked: current, comments } = mask(updated);
    const imports = [...current.matchAll(/^(?:import\s[^;]*?from\s*['"][^'"\n]*['"]|import\s*['"][^'"\n]*['"]);?(?=[ \t]*\r?\n)/gm)];
    const last = imports[imports.length - 1];
    // After the last import's line, or straight after its code when a comment runs on past that line.
    const codeEnd = last === undefined ? 0 : last.index + last[0].length;
    const next = last === undefined ? 0 : afterLine(updated, current, comments, codeEnd);
    const [insertAt, line] = next === null ? [codeEnd, `${config.eol}${statement}`] : [next, `${statement}${config.eol}`];
    updated = updated.slice(0, insertAt) + line + updated.slice(insertAt);
    if (insertAt <= at) at += line.length;
  }
  return { source: updated, at, changed: installed(target) };
}

/**
 * Adds `text` as the last item between the brackets at `open` and `close`,
 * in their layout: inline, or on its own line with the items' indent and
 * trailing comma. Comments stay where they are, a comment after the last
 * item staying on its line. `at` is where `call` lands.
 */
function appendItem(config, open, close, text, call) {
  const { source, masked, eol } = config;
  const list = items(source, masked, open, close);
  const body = source.slice(open + 1, close);
  const insert = (index, inserted) => ({ source: source.slice(0, index) + inserted + source.slice(index), at: index + inserted.indexOf(call) });
  if (list.length === 0) {
    // An empty list takes the item inline; an empty object opens onto its own lines, as formatters write it. Comments in it come first.
    const kept = body.trimEnd();
    if (source[open] === "[" && !body.includes("\n")) {
      const inserted = `${kept}${kept === "" ? "" : " "}${text}`;
      return { source: source.slice(0, open + 1) + inserted + source.slice(close), at: open + 1 + inserted.lastIndexOf(call) };
    }
    const indent = lineIndent(source, open);
    const inserted = `${kept}${eol}${indent}${/^\t/m.test(source) ? "\t" : "  "}${text},${eol}${indent}`;
    return { source: source.slice(0, open + 1) + inserted + source.slice(close), at: open + 1 + inserted.lastIndexOf(call) };
  }
  const last = list[list.length - 1];
  const after = masked.slice(last.end, close);
  const trailing = after.trimStart().startsWith(",");
  const end = trailing ? last.end + after.indexOf(",") + 1 : last.end;
  const indent = /\n([ \t]*)\S/.exec(body)?.[1];
  if (indent === undefined) return insert(end, trailing ? ` ${text},` : `, ${text}`);
  // One item per line: the new line goes after the last item's line, past any comment that ends it, or straight after its code.
  const next = afterLine(source, masked, config.comments, end);
  if (next === null || next > close) {
    return insert(end, trailing ? `${eol}${indent}${text},` : `,${eol}${indent}${text}`);
  }
  const line = `${indent}${text}${trailing ? "," : ""}${eol}`;
  if (trailing) return insert(next, line);
  const withComma = source.slice(0, end) + "," + source.slice(end, next) + line + source.slice(next);
  return { source: withComma, at: next + 1 + line.indexOf(call) };
}

/**
 * The start of the line after the code that ends at `end`, when the rest of
 * that line holds only spaces and comments that close on it; otherwise null,
 * since text put there would land inside a comment or after other code.
 */
function afterLine(source, masked, comments, end) {
  const lineEnd = source.indexOf("\n", end);
  if (lineEnd === -1 || masked.slice(end, lineEnd).trim() !== "") return null;
  if (comments.some((comment) => comment.start < lineEnd && lineEnd < comment.end)) return null;
  return lineEnd + 1;
}

/** An object property's name, quoted or not; "..." for a spread; null when code computes it. */
function propertyName(text) {
  if (text.startsWith("...")) return "...";
  const match = /^(?:[A-Za-z_$][\w$]*|\d+|(['"])(?:\\.|(?!\1)[^\\\n])*\1)(?=\s*(?:[:(]|$))/.exec(text);
  if (match === null) return null;
  return match[1] === undefined ? match[0] : stringValue(match[0]);
}

function lineIndent(source, index) {
  return /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", index) + 1))[0];
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** The import and the lines with the call, for the person to review. */
function preview(source, name) {
  return source
    .split(/\r?\n/)
    .filter((line) => line.includes(PACKAGE) || new RegExp(`(?<![\\w$.])${name.replaceAll("$", "\\$")}\\s*\\(`).test(line))
    .join("\n");
}
