/**
 * `critiqs init <projectId>`: connects the app to an existing Critiqs project,
 * adding Critiqs where the app renders when the code has none, through the
 * app's framework adapter. Dependency-free so it runs under Node and Bun
 * without a build.
 */
import { relative, resolve } from "node:path";
import { chooseWiring, isFile, isFolder, shown, UNRECOGNIZED, workspaceApps, workspaceRefusal, writeConnection } from "./app.mjs";
import { isCodeFile } from "./env.mjs";

/** Convex document IDs (lowercase letters and digits, about 32 characters), or a self-hosted server's (`p_` and 32 hex digits). */
export const PROJECT_ID_PATTERN = /^([a-z0-9]{16,64}|p_[0-9a-f]{32})$/;

export const HELP = `Usage: critiqs init <projectId> [--dir <path>] [--entry <file>] [--mount <Element>] [--project-env-file <file>] [--dry-run]

Connects the app's Critiqs to a project. Without Critiqs in the code yet, adds
it where the app renders, with the app's framework package (critiqs-react,
critiqs-vue, …). Where the framework has a public environment variable (such
as VITE_CRITIQS_PROJECT_ID), Critiqs reads the project ID from it and init
sets it in the app's .env file; otherwise init writes the ID into the code.
Copy the project ID from project setup in the Critiqs sidebar.

Options:
  --dir <path>        The app's folder (default: current folder)
  --entry <file>      The file where the app renders, relative to --dir
  --mount <Element>   The element in that file to add Critiqs beside, such as App
  --project-env-file <file>   The .env file to set the project ID in, relative to --dir (default: the framework's, such as .env.local)
  --dry-run           Show the change without writing it
  -h, --help          Show this help`;

export function isValidProjectId(id) {
  return PROJECT_ID_PATTERN.test(id);
}

/** Parses `init <projectId> [--dir <path>] [--entry <file>] [--mount <Element>] [--project-env-file <file>] [--dry-run]`; returns options or an error message. */
export function parseArguments(argv) {
  const options = { help: false, command: null, projectId: null, dir: ".", entry: null, mount: null, envFile: null, dryRun: false };
  const positional = [];
  const keys = { "--dir": "dir", "--entry": "entry", "--mount": "mount", "--project-env-file": "envFile", "--env-file": "envFile" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const flag = Object.keys(keys).find((name) => arg === name || arg.startsWith(`${name}=`));
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (flag !== undefined) {
      const value = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
      if (value === undefined || value === "") return { error: flag === "--dir" ? "--dir needs a folder path." : `${flag} needs a value.` };
      options[keys[flag]] = value;
    } else if (arg.startsWith("-")) return { error: `Unknown option ${arg}.` };
    else positional.push(arg);
  }
  options.command = positional[0] ?? null;
  options.projectId = positional[1] ?? null;
  if (options.help) return options;
  if (options.command !== "init") {
    return { error: options.command === null ? "Missing command." : `Unknown command ${options.command}.` };
  }
  if (options.projectId === null) return { error: "Missing project ID." };
  if (positional.length > 2) return { error: `Unexpected argument ${positional[2]}.` };
  if (options.mount !== null && !/^[\p{ID_Start}$_][\p{ID_Continue}$.\-:]*$/u.test(options.mount)) return { error: "--mount needs an element name, such as App." };
  return options;
}

/**
 * Runs the CLI and returns its exit code: 0 when the project ID is set, 1 when it
 * could not be set automatically, 2 for usage errors. `print` receives each message.
 * Without Critiqs in the code yet, it adds it where the app renders. `env` is
 * the shell's environment, which frameworks that load no `.env` file read.
 */
export function runInit(argv, { cwd = process.cwd(), print = console.log, env: shell = process.env } = {}) {
  const options = parseArguments(argv);
  if ("error" in options) {
    print(`${options.error}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    print(HELP);
    return 0;
  }

  const projectId = options.projectId;
  if (!isValidProjectId(projectId)) {
    print(
      `"${projectId}" is not a Critiqs project ID. Copy it from project setup in the Critiqs sidebar: ` +
        "16 to 64 lowercase letters and digits, or p_ and 32 for a self-hosted server.",
    );
    return 2;
  }

  const root = resolve(cwd, options.dir);
  const show = (path) => relative(cwd, path) || ".";
  const folder = relative(cwd, root) || "this folder";
  if (!isFolder(root)) {
    print(`${shown(cwd, root)} is not a folder.`);
    return 2;
  }
  const apps = workspaceApps(root);
  if (apps !== null && apps.length > 0) {
    print(workspaceRefusal(apps, folder, show, `npx critiqs init ${projectId}`));
    return 1;
  }
  const wiring = chooseWiring(root, { envFile: options.envFile, cwd, entry: options.entry, mount: options.mount });
  // The entry only says where to add Critiqs, so code that has it already doesn't need one.
  if (options.entry !== null && wiring.usages.length === 0 && !isFile(resolve(root, options.entry))) {
    print(`${options.entry} is not a file in ${folder}. Name the file where the app renders, relative to that folder.`);
    return 2;
  }
  if (wiring.problem) {
    print(wiring.problem);
    return 1;
  }
  const result = writeConnection({ root, cwd, wiring, projectId, dryRun: options.dryRun, entry: options.entry, mount: options.mount, shell });
  if (!result.ok) {
    print(`${result.message}${result.reason === "manual" && !wiring.detected ? `\n${UNRECOGNIZED}` : ""}`);
    return 1;
  }
  const at = `${shown(cwd, result.file)}:${result.line}`;
  const dry = options.dryRun ? " (dry run, nothing written)" : "";
  const env = result.env;
  const steps = result.next.map((step) => `Next: ${step.replace(/\.$/, "")}.`);
  // In use only when this computer's setting was read and holds this ID; the code naming the variable isn't enough.
  if (result.action === "unchanged" && !env?.changed) {
    print(`${at} already uses this project ID${env === undefined ? "" : ` (${env.name} in ${env.file === null ? "this shell's environment" : show(env.file)})`}.`);
    if (env?.unloaded) print(`Warning: ${env.unloaded}`);
    for (const step of steps) print(step);
    return 0;
  }
  if (result.action === "install") {
    print(`${options.dryRun ? "Would add" : "Added"} Critiqs to ${at}${dry}:\n${result.preview.split("\n").map((line) => `  ${line}`).join("\n")}`);
  } else if (result.action === "update" && wiring.mode === "env") {
    print(`${options.dryRun ? "Would connect" : "Connected"} Critiqs in ${at} to ${env.name}${result.changed.includes("requireProjectId") ? "; it stays hidden wherever that isn't set" : ""}${dry}.`);
  } else if (result.action === "update") {
    print(`${options.dryRun ? "Would set" : "Set"} the project ID in ${at}${dry}.`);
  }
  if (env !== undefined) {
    const line = `${env.name}=${projectId}`;
    if (env.file === null) print(`Set ${line} in the environment the app runs with on this computer.`);
    else if (env.changed) print(`${options.dryRun ? "Would set" : "Set"} ${line} in ${show(env.file)} for ${isCodeFile(env.file) ? "development" : "this computer"}${dry}.`);
    if (env.unloaded) print(`Warning: ${env.unloaded}`);
    print(env.advice);
  }
  for (const step of steps) print(step);
  return 0;
}
