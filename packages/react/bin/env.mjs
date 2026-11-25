/**
 * How a React app reads its Critiqs project ID from its environment: the
 * framework that builds it, the variable's name, the `.env` files it loads,
 * and the workspace it belongs to. Init writes the variable; each deployment
 * sets its own, so only correctly configured copies of the app show Critiqs.
 * Dependency-free so it runs under Node and Bun without a build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Frameworks whose public environment variables reach the browser build, and how code reads them. */
export const FRAMEWORKS = {
  next: { name: "Next.js", access: "process.env", prefix: "NEXT_PUBLIC_" },
  vite: { name: "Vite", access: "import.meta.env", prefix: "VITE_" },
};

/** The `.env` files frameworks load during development, highest precedence first. */
export const ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];
/** Of those, the ones that stay on one computer. */
const LOCAL_FILES = new Set([".env.development.local", ".env.local"]);

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

const CONFIG_EXTENSIONS = ["ts", "mts", "js", "mjs", "cts", "cjs"];
const configFile = (root, name) => CONFIG_EXTENSIONS.map((extension) => join(root, `${name}.config.${extension}`)).find((path) => existsSync(path)) ?? null;

/** "next", "vite", or null for a build init doesn't know how to give public settings to. */
export function detectFramework(root) {
  const manifest = readJson(join(root, "package.json")) ?? {};
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  if ("next" in dependencies || configFile(root, "next") !== null) return "next";
  if ("vite" in dependencies || configFile(root, "vite") !== null) return "vite";
  return null;
}

/**
 * Where a Vite app loads `.env` files: its own folder, or the `envDir` its
 * config names as a literal path or `resolve(__dirname, "…")`. `known` is false
 * when `envDir` is computed some other way, which init can't follow.
 */
function viteSettings(root) {
  const file = configFile(root, "vite");
  if (file === null) return { envDir: root, known: true, customPrefix: false };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { envDir: root, known: false, customPrefix: false, config: file };
  }
  const customPrefix = /\benvPrefix\b/.test(text);
  const mentions = text.match(/\benvDir\b/g) ?? [];
  if (mentions.length === 0) return { envDir: root, known: true, customPrefix, config: file };
  const base = dirname(file);
  const literal = /\benvDir\s*:\s*(["'`])([^"'`$\n]*)\1/.exec(text);
  const resolved = /\benvDir\s*:\s*(?:path\.)?(?:resolve|join)\(\s*(?:__dirname|import\.meta\.dirname)\s*((?:,\s*(["'])[^"'\n]*\2\s*)*),?\s*\)/.exec(text);
  const fromUrl = /\benvDir\s*:\s*fileURLToPath\(\s*new\s+URL\(\s*(["'])([^"'\n]*)\1\s*,\s*import\.meta\.url\s*\)\s*\)/.exec(text);
  if (mentions.length === 1 && literal !== null) return { envDir: resolve(base, literal[2]), known: true, customPrefix, config: file };
  if (mentions.length === 1 && resolved !== null) {
    const parts = [...resolved[1].matchAll(/(["'])([^"'\n]*)\1/g)].map((match) => match[2]);
    return { envDir: resolve(base, ...parts), known: true, customPrefix, config: file };
  }
  if (mentions.length === 1 && fromUrl !== null) return { envDir: resolve(base, fromUrl[2]), known: true, customPrefix, config: file };
  return { envDir: root, known: false, customPrefix, config: file };
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
 * Everything init needs to give one app its project ID through the
 * environment, without reading anything the app computes at run time:
 * - `framework`: "next", "vite", or null (init then writes the ID into the code);
 * - `variable`: the name init gives the setting. In a workspace it names the
 *   app, so a value shared across the workspace (a root `.env`, or a build
 *   job's settings) can't configure every app with one project;
 * - `envDir` and `envFile`: where the setting is written for this computer;
 * - `problem`: why init can't choose these safely, with what to do instead.
 */
export function describeApp(root, { envFile = null } = {}) {
  const framework = detectFramework(root);
  const workspace = findWorkspace(root);
  const members = workspace === null ? [] : workspaceMembers(workspace.root, workspace.patterns);
  const label = workspace === null ? null : workspaceLabel(root, workspace, members);
  const workspaceName = workspace === null ? null : shortName(workspace.root);
  const app = {
    root: resolve(root),
    framework,
    workspace: workspace === null ? null : { root: workspace.root, name: workspaceName, label },
    projectName: workspace === null ? shortName(root) : `${workspaceName}/${label}`,
    envDir: resolve(root),
    envFile: envFile === null ? null : resolve(root, envFile),
    sharedEnv: false,
    variable: null,
    access: null,
    problem: null,
  };
  if (framework === null) return app;
  const { access, prefix } = FRAMEWORKS[framework];
  app.access = access;
  const suffix = workspace === null ? "" : workspaceSuffix(root, workspace, members);
  if (suffix === null) {
    app.problem = "Workspace apps would use the same Critiqs environment variable. Choose distinct package names or wire distinct public project-ID variables before running init.";
    return app;
  }
  app.variable = `${prefix}CRITIQS_PROJECT_ID${label === null ? "" : `_${suffix}`}`;
  if (framework === "vite") {
    const vite = viteSettings(root);
    app.envDir = vite.envDir;
    app.customPrefix = vite.customPrefix;
    if (!vite.known && app.envFile === null) {
      app.problem =
        `${posix(relative(root, vite.config ?? root)) || "vite.config"} sets envDir in a way init can't follow, so it doesn't know which .env file this app loads. ` +
        "Run init again with --project-env-file <the .env.local file Vite loads, relative to the app>, and nothing else changes.";
    }
  }
  app.sharedEnv = app.envDir !== app.root;
  return app;
}

/**
 * The variable an expression reads, when it is exactly one public setting of
 * the app's framework: `import.meta.env.VITE_…` in Vite, or
 * `process.env.NEXT_PUBLIC_…` in Next.js. Anything else is code init doesn't
 * evaluate.
 */
export function envVariableOf(text, app) {
  if (typeof text !== "string" || app.framework === null) return null;
  const match = /^\s*(import\.meta\.env|process\.env)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text);
  if (match === null || match[1] !== FRAMEWORKS[app.framework].access) return null;
  // Vite exposes only its prefix, unless the app changed it (then the author chose the name).
  if (!match[2].startsWith(FRAMEWORKS[app.framework].prefix) && !(app.framework === "vite" && app.customPrefix)) return null;
  return match[2];
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

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** The `.env` files to read for this app on this computer, highest precedence first. */
export function envFiles(app) {
  const files = ENV_FILES.map((name) => join(app.envDir, name));
  return app.envFile === null ? files : [app.envFile, ...files.filter((file) => file !== app.envFile)];
}

/** Where this computer's `.env` files set a variable: the value and file that win, or null. */
export function readEnvValue(app, name) {
  for (const file of envFiles(app)) {
    const text = readText(file);
    if (text === null) continue;
    let value = null;
    for (const line of text.split(/\r?\n/)) {
      const match = DEFINITION.exec(line);
      // The last definition in a file wins.
      if (match !== null && match[2] === name) value = envValue(match[3]);
    }
    if (value !== null) return { value, file };
  }
  return null;
}

/** How many times a file's text defines a variable. */
const definitions = (text, name) => (text ?? "").split(/\r?\n/).filter((line) => DEFINITION.exec(line)?.[2] === name).length;

/** Sets `name=value` in one file's text, replacing its definitions and keeping every other line as it is. */
function setInText(text, name, value, comment) {
  const eol = text?.includes("\r\n") ? "\r\n" : "\n";
  if (text === null || text === "") return `${comment === null ? "" : `# ${comment}${eol}`}${name}=${value}${eol}`;
  const lines = text.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    const match = DEFINITION.exec(line);
    if (match === null || match[2] !== name) return line;
    found = true;
    return `${match[1] ?? ""}${name}=${value}`;
  });
  if (found) return updated.join(eol);
  const separator = text.endsWith("\n") ? "" : eol;
  return `${text}${separator}${comment === null ? "" : `# ${comment}${eol}`}${name}=${value}${eol}`;
}

/**
 * Plans this computer's setting: `name=value` in the local `.env` file that
 * already sets it with the highest precedence, or else the app's `.env.local`
 * (or `--project-env-file`), plus an empty entry in the `.env.example` beside it for
 * the next developer and each deployment. Writes nothing.
 */
export function planEnv(app, name, value) {
  const local =
    app.envFile ??
    ENV_FILES.filter((file) => LOCAL_FILES.has(file))
      .map((file) => join(app.envDir, file))
      .find((file) => definitions(readText(file), name) > 0) ??
    join(app.envDir, ".env.local");
  const original = readText(local);
  const source = setInText(original, name, value, `Critiqs project for ${app.workspace?.label ?? "this app"} on this computer. Each deployment sets its own.`);
  const exampleFile = join(dirname(local), ".env.example");
  const exampleOriginal = readText(exampleFile);
  const listed = definitions(exampleOriginal, name) > 0;
  const example = listed
    ? null
    : {
        file: exampleFile,
        original: exampleOriginal,
        source: setInText(exampleOriginal, name, "", `Critiqs project ID for ${app.workspace?.label ?? "this app"}. Set it in each deployment that should show Critiqs; leave it unset to keep Critiqs off.`),
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
