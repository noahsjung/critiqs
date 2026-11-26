/**
 * How setup sees one app, whatever its framework: the framework's setup
 * adapter, how the app's code names its Critiqs project, and connecting it to
 * a project by writing the adapter's plan and this computer's `.env` value.
 * `critiqs init`, the setup flow, doctor, and the MCP tools all go through
 * here. Dependency-free so it runs under Node and Bun without a build.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEnv, checkWritable, describeApp, envTarget, findWorkspace, gitIgnored, isCodeFile, planEnv, readEnvValue, UnreadableEnvFile, workspaceMembers, workspacePatterns } from "./env.mjs";
import { detectApp, FRAMEWORKS } from "./frameworks/index.mjs";
import { ENV_FILES as VITE_ENV_FILES, IGNORED_DIRECTORIES, usesVite } from "./frameworks/jsx.mjs";
import { react } from "./frameworks/react.mjs";
import { dependsOn, readPackageJson, readText } from "./frameworks/shared.mjs";

/** A path as people read it: relative inside the current folder, absolute outside it. */
export function shown(cwd, path) {
  const near = relative(cwd, path);
  return near === "" ? "this folder" : near.startsWith("..") ? path : near;
}

export function isFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The package a framework's Critiqs comes from, as people name it. */
export function packageOf(adapter) {
  const { install } = adapter;
  return install.ecosystem === "npm" ? install.packages.join(", ") : install.ecosystem === "rubygems" ? `the ${install.gem} gem` : install.package;
}

/**
 * Which setup adapters could connect the app in `root` (`candidates`, most
 * likely first, each with the Critiqs setups it sees), and the Critiqs setups
 * its code already has (`usages`). Critiqs already in the code decides,
 * whatever the app's framework: a React island in an Astro app keeps its
 * critiqs-react, which setup updates instead of adding critiqs-astro beside
 * it. Every adapter looks, and only one that sees every Critiqs in the code
 * may connect the app (Next.js and React see the same <Critiqs />, Nuxt and
 * Vue the same <Critiqs> from critiqs-vue); when none does, different
 * framework packages each set it up, and `problem` says so, because setup
 * doesn't choose between them. With no Critiqs, the app's framework's adapter
 * adds it, or React's when setup recognizes no framework (`framework` null),
 * since setup treated every app as React before it knew others; with an
 * `entry`, so may another framework the app uses, such as React's for a
 * React root in an Astro app. Candidates are frameworks the app uses, the
 * app's own first, then any other adapter that sees every Critiqs in the code
 * (Vue's, for a Nuxt app's <Critiqs> from critiqs-vue when its manifest
 * doesn't list vue). `adapter` is the first. `error` is why the app's
 * framework's adapter couldn't read its code, when it couldn't. Several
 * config files for one framework (astro.config.mjs and astro.config.ts) are a
 * `problem` too: the framework uses one, and an adapter reading the other
 * could miss the Critiqs it runs.
 */
export function locateApp(root, cwd = root, { entry = null } = {}) {
  const framework = detectApp(root);
  const fallback = framework ?? react;
  const configs = severalConfigs(root);
  if (configs !== null) return { adapter: fallback, candidates: [{ adapter: fallback, usages: [] }], framework, usages: [], problem: configs };
  const adapters = [...new Set([...FRAMEWORKS, react])];
  const found = new Map();
  for (const adapter of adapters) {
    try {
      const usages = adapter.find(root);
      if (usages.length > 0) found.set(adapter, usages);
    } catch (error) {
      // Another framework's adapter needn't read this app's files; the app's own must.
      if (adapter === fallback) return { adapter: fallback, candidates: [{ adapter: fallback, usages: [] }], framework, usages: [], problem: null, error };
    }
  }
  // The app's framework (or React's, when setup recognizes none), then the other frameworks it uses.
  const uses = [fallback, ...adapters.filter((adapter) => adapter !== fallback && adapter.detect(root))];
  const ranked = (list) => list.map((adapter) => ({ adapter, usages: found.get(adapter) ?? [] }));
  // Each Critiqs in the code, and the adapters that see it.
  const places = new Map();
  for (const [adapter, usages] of found) {
    for (const usage of usages) {
      const place = `${usage.file}:${usage.line}`;
      if (!places.has(place)) places.set(place, { usage, adapters: [] });
      places.get(place).adapters.push(adapter);
    }
  }
  if (places.size === 0) return { adapter: fallback, candidates: ranked(entry === null ? [fallback] : uses), framework, usages: [], problem: null };
  const complete = [...found.keys()].filter((adapter) => [...places.values()].every((place) => place.adapters.includes(adapter)));
  if (complete.length > 0) {
    // Each adapter reads settings its own way (Next.js doesn't read Vite's variables), so frameworks the app uses come first;
    // then the others that see every Critiqs, a library before the framework built on it (the registry lists frameworks first).
    const fitting = uses.filter((adapter) => complete.includes(adapter));
    const others = complete.filter((adapter) => !uses.includes(adapter)).reverse();
    const candidates = ranked([...fitting, ...others]);
    return { adapter: candidates[0].adapter, candidates, framework, usages: candidates[0].usages, problem: null };
  }
  const list = [...places.values()].map(({ usage, adapters }) => `  ${[...new Set(adapters.map(packageOf))].join(" or ")} at ${shown(cwd, usage.file)}:${usage.line}`);
  return {
    adapter: fallback,
    candidates: [{ adapter: fallback, usages: [] }],
    framework,
    usages: [...places.values()].map(({ usage }) => usage),
    problem: `Critiqs is set up with more than one framework package, so nothing was changed:\n${list.join("\n")}\nKeep one, where the app renders, then run setup again.`,
  };
}

/** Frameworks whose config file can hold a Critiqs integration (Astro's integrations, Nuxt's modules), and the extensions their config files take. */
const CONFIG_NAMES = ["astro", "nuxt"];
const CONFIG_EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"];

/** Why setup can't tell which config file a framework uses, when the app has several for one framework; null otherwise. */
function severalConfigs(root) {
  const groups = CONFIG_NAMES.map((name) => ({ name, files: CONFIG_EXTENSIONS.map((extension) => `${name}.config.${extension}`).filter((file) => isFile(join(root, file))) })).filter(
    ({ files }) => files.length > 1,
  );
  if (groups.length === 0) return null;
  const list = groups.map(({ name, files }) => `${name} config files (${files.join(", ")})`).join(" and ");
  return `This app has several ${list}, and setup can't tell which one the framework uses, so nothing was changed. Remove the ones the app doesn't use, then run setup again.`;
}

/** Code files that can import packages: scripts, and Vue, Svelte, and Astro components. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
/** A Critiqs package or module, such as critiqs-react, critiqs-vue/router, or critiqs/element. */
const CRITIQS_MODULE = /^critiqs(?:-[a-z0-9-]+)?(?:\/[\w./-]*)?$/;
/** Modules that never put Critiqs on a page: the self-hosted server and the command line. */
const OFF_PAGE_MODULE = /^critiqs(?:-[a-z0-9-]+)?\/(?:server|cli)(?:\/|$)/;
/** Names Critiqs packages export that don't start Critiqs: a constant, and route helpers. */
const INERT_NAMES = new Set(["MASK_ATTRIBUTE", "DEFAULT_PROJECT_ID_VARIABLE", "ROUTE_PARAM_PREFIX", "routePattern", "routeContext", "routePath"]);
const STATIC_IMPORT = /^[ \t]*(import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*(["'])([^"'\n]+)\4/gm;
const BARE_IMPORT = /^[ \t]*import\s*(["'])([^"'\n]+)\1/gm;
const LOADED = /\b(?:require|import)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/** Whether an import or export clause, such as `{ Critiqs as Review }` or `* as critiqs`, binds anything besides types and inert names. */
function bindsCritiqs(clause) {
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
  // A default or namespace import, or `export *`, could be Critiqs itself.
  if (outside !== "") return true;
  return (braces?.[1] ?? "")
    .split(",")
    .map((specifier) => specifier.trim())
    .some((specifier) => specifier !== "" && !/^type\s/.test(specifier) && !INERT_NAMES.has(/^[\p{ID_Start}$_][\p{ID_Continue}$]*/u.exec(specifier)?.[0] ?? ""));
}

/**
 * The app's files whose code loads a Critiqs package in a way that could put
 * Critiqs on the page (a component, a namespace, a re-export, a side-effect or
 * run-time import), each with the packages it loads. Type imports, inert
 * names such as MASK_ATTRIBUTE, and the server and command-line modules don't
 * count. Skips dependencies, build output, and dot folders, as adapters do.
 */
export function critiqsImports(root) {
  const loads = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile() || !CODE_FILE.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) continue;
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("critiqs")) continue;
      const code = text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|^[ \t]*\/\/.*$/gm, "");
      const modules = new Set();
      const counts = (module) => CRITIQS_MODULE.test(module) && !OFF_PAGE_MODULE.test(module);
      for (const match of code.matchAll(STATIC_IMPORT)) if (counts(match[5]) && match[2] === undefined && bindsCritiqs(match[3])) modules.add(match[5]);
      for (const match of code.matchAll(BARE_IMPORT)) if (counts(match[2])) modules.add(match[2]);
      for (const match of code.matchAll(LOADED)) if (counts(match[2])) modules.add(match[2]);
      if (modules.size > 0) loads.push({ file: path, modules: [...modules] });
    }
  };
  visit(resolve(root));
  return loads;
}

/** The entry to pass to an adapter: none when the code already has Critiqs and the named file doesn't exist, since it only says where to add it. */
function usableEntry(root, usages, entry) {
  return entry !== null && usages.length > 0 && !isFile(resolve(root, entry)) ? null : entry;
}

/** For an app whose framework setup didn't recognize: what else it can do. */
export const UNRECOGNIZED =
  `Setup didn't recognize this app's framework, so it looked for a React app. It also sets up ${FRAMEWORKS.filter((adapter) => adapter !== react)
    .map((adapter) => adapter.name)
    .join(", ")} apps; ` + "in a page without a build, add the <critiqs-app> element from the critiqs package (see its README).";

/** A project ID that is only ever planned, never written. */
const PLACEHOLDER = "p".repeat(32);

const COLLISION =
  "Workspace apps would use the same Critiqs environment variable. Choose distinct package names or wire distinct public project-ID variables before running init.";

/** The same convention, reading a variable the code already uses instead of the one setup would name. */
function renamed(env, variable) {
  if (variable === env.variable) return env;
  const swap = (text) => text.split(env.variable).join(variable);
  return { ...env, variable, expression: swap(env.expression), deploymentAdvice: swap(env.deploymentAdvice) };
}

/**
 * How the app's code names its project:
 * - "env": Critiqs reads the framework's public variable (`env`), and setup
 *   sets it in a `.env` file on this computer when the framework loads one.
 *   Each deployment sets its own, so each can use its own project, and a copy
 *   without one shows nothing.
 * - "literal": setup writes the ID into the code, as for code that already
 *   names one, several Critiqs setups, and frameworks with no public variable.
 * Code that sets the ID some other way, such as from a computed value, is the
 * adapter's to judge: its plan refuses what it can't follow, and sets a
 * missing ID after spread props, where it wins.
 * `problem` says why setup can't wire this app safely, and what to do.
 * When several adapters could connect the app (see `locateApp`), the first
 * whose plan can, with `entry` and `mount`, is used: Vue's updates a Nuxt
 * app's <Critiqs> from critiqs-vue, which Nuxt's would ask to remove. An
 * adapter's refusal stands for every later one that installs the same
 * package: that is the same Critiqs through the library the framework builds
 * on (Svelte's under SvelteKit, React's under Next.js), which would wire it
 * with settings the framework doesn't read. When none can, the first is, and
 * its plan's refusal is what setup shows.
 */
export function chooseWiring(root, { envFile = null, cwd = root, entry = null, mount = null } = {}) {
  const located = locateApp(root, cwd, { entry });
  const app = describeApp(root, { envFile });
  const detected = located.framework !== null;
  if (located.problem !== null) return { mode: "literal", adapter: located.adapter, detected, app, envFile, usages: located.usages, problem: located.problem };
  const wirings = located.candidates.map(({ adapter, usages }) => wire(root, adapter, { detected, app, envFile, usages }));
  if (wirings.length === 1) return wirings[0];
  const placed = { entry: usableEntry(root, located.usages, entry), mount, cwd };
  const connects = (wiring) => {
    if (wiring.problem !== null) return false;
    try {
      return wiring.adapter.plan(root, connectionSettings(wiring, PLACEHOLDER), placed).ok;
    } catch {
      return false;
    }
  };
  const refused = [];
  for (const wiring of wirings) {
    if (refused.some((adapter) => sharesPackage(adapter, wiring.adapter))) continue;
    if (connects(wiring)) return wiring;
    refused.push(wiring.adapter);
  }
  return wirings[0];
}

/** The packages an adapter installs, named with their ecosystem. */
const packagesOf = ({ install }) => (install.ecosystem === "npm" ? install.packages.map((name) => `npm:${name}`) : [install.ecosystem === "rubygems" ? `gem:${install.gem}` : `pypi:${install.package}`]);
const sharesPackage = (a, b) => packagesOf(a).some((name) => packagesOf(b).includes(name));

/** Vite's `.env` files, highest precedence first, as it loads them in development. */
const VITE_LOADS = VITE_ENV_FILES;

/**
 * A convention as setup reads it. One that writes Vite's `.env.local`, for a
 * VITE_ variable or an app built with Vite, without saying which files it
 * loads gets Vite's, from the same folder: a value in a file Vite reads first
 * is then found, written over, or refused when unreadable, instead of hidden
 * behind a new one in `.env.local`.
 */
function withLoads(root, env) {
  if (env === null || env.loads !== undefined || env.localFile === null || basename(env.localFile) !== ".env.local") return env;
  if (!env.variable.startsWith("VITE_") && !usesVite(root)) return env;
  const folder = dirname(env.localFile);
  return { ...env, loads: VITE_LOADS.map((file) => (folder === "." ? file : `${folder}/${file}`)) };
}

/** How `adapter` would wire the app, given the Critiqs setups it sees. */
function wire(root, adapter, base) {
  const { app, envFile, usages } = base;
  const current = usages.length === 1 ? usages[0].projectId : null;
  if (usages.length > 1 || current?.kind === "literal") return { mode: "literal", adapter, ...base, problem: null };
  const env = withLoads(root, adapter.env(root, app.suffix ?? "", { envFile }));
  if (env === null) return { mode: "literal", adapter, ...base, problem: null };
  // Wiring the code already has is kept: its variable, as written.
  return { mode: "env", adapter, ...base, env: current?.kind === "env" ? renamed(env, current.variable) : env, problem: app.suffix === null ? COLLISION : (env.problem ?? null) };
}

/** What setup asks the adapter to write: `projectId`, or the variable that holds it, and `backend` unless it is Critiqs Cloud (undefined). */
export function connectionSettings(wiring, projectId, backend) {
  return {
    projectId: wiring.mode === "env" ? { env: wiring.env } : { literal: projectId },
    requireProjectId: wiring.mode === "env",
    ...(backend === undefined || backend === null ? {} : { backend }),
  };
}

/** This computer's `.env` files for an environment-backed connection (see `envTarget`); null for one written into the code. */
export function envTargetOf(wiring) {
  if (wiring.mode !== "env") return null;
  return envTarget(wiring.app.root, wiring.env, { envFile: wiring.envFile, label: wiring.app.workspace?.label ?? null });
}

/**
 * The project ID this computer gives an environment-backed connection, as the
 * app would read it: `{ value, file }` from the `.env` files its framework
 * loads, or for a framework that loads none, `{ value, file: null }` from the
 * shell's environment. null when unset. Throws when a `.env` file can't be read.
 */
export function readLocalValue(wiring, shell = process.env) {
  const target = envTargetOf(wiring);
  if (target.files.length > 0) return readEnvValue(target, wiring.env.variable);
  const value = shell[wiring.env.variable];
  return typeof value === "string" ? { value, file: null } : null;
}

// ---------------------------------------------------------------------------
// What the person still has to do

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * The npm package manager the app uses: the nearest lockfile's, up to its
 * repository's root; without one, the nearest package.json `packageManager`;
 * then pnpm for a pnpm workspace; otherwise npm.
 */
function packageManager(root) {
  const folders = [];
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    folders.push(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  for (const dir of folders) {
    const lockfile = LOCKFILES.find(([file]) => existsSync(join(dir, file)));
    if (lockfile !== undefined) return lockfile[1];
  }
  for (const dir of folders) {
    const declared = readPackageJson(dir)?.packageManager;
    const name = typeof declared === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(declared)?.[1] : undefined;
    if (name !== undefined) return name;
  }
  return folders.some((dir) => existsSync(join(dir, "pnpm-workspace.yaml"))) ? "pnpm" : "npm";
}

/** A path as a shell reads it: as it is when that's safe, otherwise in double quotes. */
export function quoted(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

const isInside = (folder, path) => {
  const near = relative(folder, path);
  return near === "" || (!near.startsWith("..") && !isAbsolute(near));
};

/**
 * The command that adds npm `packages` to the app in `root`, for a person in
 * `cwd`: the plain command in the app's folder; from elsewhere in its
 * workspace, the package manager's own way to name the app; otherwise the
 * plain command and the folder to run it in (`where`). pnpm names the app's
 * folder, which no other package shares, relative to where it runs (its name
 * may not be unique: pnpm allows two packages with one name). npm and Yarn
 * name the package, which also matches only that folder, unless another
 * workspace package has the same name: npm then names the folder (npm
 * refuses such a workspace, so `note` says to rename first), and Yarn, which
 * can only name packages, runs in the app's folder.
 */
function addPackages(root, packages, cwd) {
  const manager = packageManager(root);
  const list = packages.join(" ");
  const plain = manager === "npm" ? `npm install ${list}` : `${manager} add ${list}`;
  if (resolve(cwd) === resolve(root)) return { command: plain, where: null };
  if (manager === "bun") return { command: `bun add ${list} --cwd ${quoted(shown(cwd, root))}`, where: null };
  const name = readPackageJson(root)?.name;
  const workspace = findWorkspace(root);
  if (workspace === null || typeof name !== "string" || name.trim() === "") return { command: plain, where: root };
  const where = isInside(workspace.root, resolve(cwd)) ? null : workspace.root;
  const near = relative(where ?? resolve(cwd), resolve(root)).split(sep).join("/");
  const folder = quoted(/^\.\.(\/|$)/.test(near) ? near : `./${near}`);
  if (manager === "pnpm") return { command: `pnpm --filter ${folder} add ${list}`, where };
  const namesakes = workspaceMembers(workspace.root, workspace.patterns).filter((dir) => dir !== resolve(root) && readPackageJson(dir)?.name?.trim?.() === name.trim());
  if (namesakes.length === 0) return { command: manager === "npm" ? `npm install ${list} --workspace ${name}` : `yarn workspace ${name} add ${list}`, where };
  if (manager === "yarn") return { command: plain, where: root };
  const others = namesakes.map((dir) => shown(cwd, dir));
  return {
    command: `npm install ${list} --workspace ${folder}`,
    where,
    note: `npm needs each workspace package to have its own name first: ${others.join(", ")} ${others.length === 1 ? "is" : "are"} also ${name}`,
  };
}

/**
 * Installing the framework's Critiqs package, when the app doesn't list it
 * yet, as a command that works where the person ran setup (`cwd`); null when
 * the app lists it, or has no manifest to add it to.
 */
export function installStep(adapter, root, cwd = root) {
  const { install } = adapter;
  const elsewhere = resolve(cwd) === resolve(root) ? "" : `, in ${shown(cwd, root)}`;
  if (install.ecosystem === "npm") {
    if (readPackageJson(root) === null) return null;
    const missing = install.packages.filter((name) => !dependsOn(root, name));
    if (missing.length === 0) return null;
    const { command, where, note } = addPackages(root, missing, cwd);
    return `Install ${missing.join(" and ")} with the app's package manager${where === null ? "" : `, in ${shown(cwd, where)}`}: ${command}${note === undefined ? "" : ` (${note})`}`;
  }
  if (install.ecosystem === "rubygems") {
    const gemfile = readText(join(root, "Gemfile"));
    if (gemfile === null || new RegExp(`^\\s*gem\\s+["']${install.gem}["']`, "m").test(gemfile)) return null;
    return `Add the ${install.gem} gem${elsewhere}: bundle add ${install.gem}`;
  }
  const manifests = ["requirements.txt", "pyproject.toml", "Pipfile"].map((file) => readText(join(root, file)));
  if (manifests.every((text) => text === null) || manifests.some((text) => text?.toLowerCase().includes(install.package.toLowerCase()))) return null;
  return `Install ${install.package} and add it to the app's requirements${elsewhere}: pip install ${install.package}`;
}

/** Steps only the person can take after setup writes the code: installing the package, then the adapter's own. */
function nextSteps(adapter, root, plan, cwd) {
  const install = installStep(adapter, root, cwd);
  return [...(install === null ? [] : [install]), ...(plan?.next ?? [])];
}

// ---------------------------------------------------------------------------
// Writing a connection

/**
 * Connects the app to a project the way `wiring` says: the adapter's plan
 * for the code, then for an environment-backed ID its setting in this
 * computer's `.env` file. The code is written first, so a failure leaves
 * either nothing or code whose setting is still to add; every failure says
 * exactly what remains, with complete instructions. A framework that loads
 * no `.env` file reads the ID from the environment its server runs with:
 * setup can't set that, so it reports whether `shell` already gives this ID.
 */
export function writeConnection({ root, cwd = root, wiring, projectId, backend, dryRun = false, entry: named = null, mount = null, shell = process.env }) {
  const { adapter } = wiring;
  const entry = usableEntry(root, wiring.usages, named);
  const settings = connectionSettings(wiring, projectId, backend);
  const placement = entry === null ? "where the app renders" : `in ${shown(cwd, resolve(root, entry))}${mount === null ? "" : ` beside <${mount}>`}`;
  const line = wiring.mode === "env" ? `${wiring.env.variable}=${projectId}` : null;
  let env = null;
  let inShell = false;
  if (wiring.mode === "env") {
    const target = envTargetOf(wiring);
    try {
      if (target.local !== null) env = planEnv(target, wiring.env.variable, projectId);
      else inShell = readLocalValue(wiring, shell)?.value === projectId;
    } catch (error) {
      if (!(error instanceof UnreadableEnvFile)) throw error;
      // A file the app loads that setup can't read could set the variable and win, so setup can't tell which project the app would use.
      const file = shown(cwd, error.file);
      const fallback = target.local === null ? "in the environment the app runs with" : `in ${shown(cwd, target.local)}`;
      const where = error.file === target.local ? fallback : `in ${file} if it sets ${wiring.env.variable}, otherwise ${fallback}`;
      return {
        ok: false,
        reason: "unreadable-env",
        file: error.file,
        message: `Couldn't read ${file}, a .env file this app loads, so nothing was changed: it could set ${wiring.env.variable} to another project. Make it readable, then run setup again. Or add Critiqs ${placement}, and set ${line} ${where}. Update an existing Critiqs setup instead of adding a second one:\n${adapter.manual(settings)}`,
      };
    }
  }
  // A framework that loads no .env file (its own file is code its server runs) ignores a chosen .env file unless the app loads it.
  const ownFile = wiring.env?.localFile ?? null;
  const unloaded =
    env !== null && wiring.envFile !== null && ownFile !== null && isCodeFile(ownFile) && !isCodeFile(env.file)
      ? `${adapter.name} doesn't load ${shown(cwd, env.file)} by itself, so the app reads ${wiring.env.variable} from it only if its own code loads that file (with a dotenv library, for example). ` +
        `Otherwise run init again without --project-env-file: it sets a development default in ${ownFile}.`
      : null;
  const setting =
    wiring.mode === "env" ? { env: { name: wiring.env.variable, file: env?.file ?? null, advice: wiring.env.deploymentAdvice, ...(unloaded === null ? {} : { unloaded }) } } : {};
  const remaining = line === null ? "" : env === null ? `, and set ${line} in the environment the app runs with` : `, and add ${line} to ${shown(cwd, env.file)}`;
  let plan;
  try {
    plan = adapter.plan(root, settings, { entry, mount, cwd });
    if (!plan.ok) return { ok: false, reason: plan.reason, message: `${plan.message}${remaining === "" ? "" : `\nThen ${remaining.replace(/^, and /, "")}.`}`, ...setting };
    // Critiqs the adapters couldn't read is still Critiqs: adding another would run two. A file the plan edits is one its adapter read.
    const read = new Set([...wiring.usages.map((usage) => usage.file), ...plan.writes.map((write) => write.file)]);
    const unread = plan.action === "install" ? critiqsImports(root).filter(({ file }) => !read.has(file)) : [];
    if (unread.length > 0) {
      const files = unread.map(({ file }) => shown(cwd, file));
      const modules = [...new Set(unread.flatMap(({ modules }) => modules))];
      return {
        ok: false,
        reason: "ambiguous",
        message:
          `${files.join(", ")} already ${files.length === 1 ? "loads" : "load"} ${modules.join(" and ")} in a way setup can't read, so nothing was changed: adding Critiqs ${placement} would run a second one. ` +
          `Give that Critiqs project ${projectId} yourself, or remove it and run setup again.`,
        ...setting,
      };
    }
    if (!dryRun) {
      for (const write of plan.writes) checkWritable(write.file);
      for (const write of plan.writes) writeFileSync(write.file, write.source);
    }
  } catch {
    return {
      ok: false,
      message: `Couldn't read or write the app's source. Restore file access, then add Critiqs ${placement} with this complete connection${remaining}. Update an existing Critiqs setup instead of adding a second one:\n${adapter.manual(settings)}`,
      ...setting,
    };
  }
  const at = `${shown(cwd, plan.file)}:${plan.line}`;
  const dry = dryRun ? " (dry run, nothing written)" : "";
  const code = {
    ok: true,
    action: plan.action,
    file: plan.file,
    line: plan.line,
    changed: plan.changed,
    installed: plan.action === "install",
    preview: plan.preview,
    writes: plan.writes,
    next: nextSteps(adapter, root, plan, cwd),
    message:
      plan.action === "unchanged"
        ? `${at} already has these settings.`
        : plan.action === "install"
          ? `${dryRun ? "Would add" : "Added"} Critiqs with ${plan.changed.join(" and ")} to ${at}${dry}.`
          : `${dryRun ? "Would set" : "Set"} ${plan.changed.join(" and ")} in ${at}${dry}.`,
  };
  if (wiring.mode !== "env") return code;
  // A framework that loads no .env file reads the variable from the environment its server runs with; `changed` says it still needs setting there.
  if (env === null) {
    return {
      ...code,
      env: { ...setting.env, changed: !inShell },
      message: `${code.message} ${inShell ? `This shell's environment sets ${line}.` : `Set ${line} in the environment the app runs with on this computer.`}`,
    };
  }
  const file = shown(cwd, env.file);
  if (dryRun) {
    try {
      if (env.changed) checkWritable(env.file);
    } catch {
      return { ok: false, message: `Can't write ${file}. Check its permissions (or choose another file with --project-env-file), then run setup again.`, ...setting };
    }
    return { ...code, env: { ...setting.env, changed: env.changed }, message: `${code.message} Would set ${line} in ${file}.` };
  }
  if (env.changed) {
    try {
      applyEnv(env);
    } catch {
      return { ...code, ok: false, ...setting, message: `${code.message} Couldn't write ${file}: add this line to it yourself, keeping the code as it is:\n  ${line}` };
    }
  }
  // Code the development server runs, such as Django's manage.py, belongs in the repository.
  if (isCodeFile(env.file)) {
    return { ...code, env: { ...setting.env, changed: env.changed }, message: `${code.message} ${env.changed ? "Set" : "Kept"} ${line} in ${file} for development.` };
  }
  const ignored = gitIgnored(env.file);
  const keepOut = ignored === false ? ` Keep ${file} out of Git (add it to .gitignore): it holds this computer's setting, and each deployment sets its own.` : "";
  return {
    ...code,
    env: { ...setting.env, changed: env.changed, ignored },
    message: `${code.message} ${env.changed ? "Set" : "Kept"} ${line} in ${file} for this computer.${keepOut}${unloaded === null ? "" : ` ${unloaded}`}`,
  };
}

// ---------------------------------------------------------------------------
// Reading the code

/** The app's one Critiqs setup (a `Usage`), or a message saying why there isn't one; `missing` when the code has none. */
export function readUsage(root, cwd = root) {
  if (!isFolder(root)) return { error: `${shown(cwd, root)} is not a folder.` };
  const { usages, problem, error } = locateApp(root, cwd);
  if (error !== undefined) throw error;
  if (problem !== null) return { error: problem };
  if (usages.length === 0) return { error: `Critiqs isn't set up in ${shown(cwd, root)} yet.`, missing: true };
  if (usages.length > 1) {
    const list = usages.map(({ file, line }) => `${shown(cwd, file)}:${line}`).join(", ");
    return { error: `Critiqs is set up in ${usages.length} places (${list}), so nothing was changed. Keep one, where the app renders.` };
  }
  return { usage: usages[0] };
}

// ---------------------------------------------------------------------------
// Workspaces

/**
 * When `root` declares a workspace: its packages that are apps setup can
 * set up (Critiqs is already there, or setup finds where to add it), which
 * each get their own project. null for a folder that declares no workspace.
 */
export function workspaceApps(root) {
  const patterns = workspacePatterns(root);
  if (patterns === null) return null;
  return workspaceMembers(root, patterns).filter((dir) => {
    try {
      const { adapter, usages, problem, error } = locateApp(dir);
      if (error !== undefined) return false;
      if (usages.length > 0 || problem !== null) return true;
      const probe = adapter.plan(dir, { projectId: { literal: PLACEHOLDER }, requireProjectId: false }, { entry: null });
      return probe.ok || probe.reason !== "manual";
    } catch {
      return false;
    }
  });
}

/** Why setup doesn't choose an app in a workspace, with the exact commands for each. */
export function workspaceRefusal(apps, folder, show, command) {
  return (
    `${folder.charAt(0).toUpperCase()}${folder.slice(1)} is a workspace with ${apps.length === 1 ? "an app" : `${apps.length} apps`}, so nothing was changed: each app gets its own Critiqs project and settings. ` +
    `Run init for one app:\n${apps.map((dir) => `  ${command} --dir ${quoted(show(dir))}`).join("\n")}`
  );
}
