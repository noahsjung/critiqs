/**
 * The `critiqs` command: `init` sets up Critiqs for a prototype in any
 * framework setup knows, `doctor` checks the setup works, `sign-in` lets
 * coding agents on this computer read feedback, and `mcp` offers these steps
 * to coding agents. `npx critiqs-react <command>` runs this too.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { relative } from "node:path";
import { beginSignIn, signInStatus, signOutComputer } from "./agent.mjs";
import { workspaceApps } from "./app.mjs";
import { runInit } from "./init.mjs";
import { beginSetup, CLOUD_BACKEND_URL, DOCTOR_NOTE, doctor, doctorReport, openBrowser, readiness, SetupError } from "./setup.mjs";

export const USAGE = `Usage:
  critiqs init                 Add Critiqs to the prototype and connect it to a new Critiqs Cloud project
  critiqs init <projectId>     Write an existing project's ID into the prototype
  critiqs doctor               Check that the prototype's Critiqs setup works
  critiqs sign-in              Sign this computer in, so coding agents here can read feedback
  critiqs sign-out             End this computer's sign-in
  critiqs mcp                  Run the MCP server that lets coding agents do the same

Init finds the app's framework (React, Next.js, Vue, Nuxt, Svelte, SvelteKit,
Angular, Astro, Solid, Ruby on Rails, Django, or Flask), adds the Critiqs
component or tag where the app renders when the code has none, and keeps a
project the code already names. Critiqs Cloud is the default: there are no
keys to enter. Where the framework has a public environment variable (such as
VITE_CRITIQS_PROJECT_ID), Critiqs reads its project ID from it and init sets
it in the app's .env file; each deployment sets its own, and copies without
one show nothing. Init names the framework's Critiqs package to install
(critiqs-react, critiqs-vue, the critiqs-rails gem, …). In a workspace, run
init once per app with --dir.

Options for init:
  --name <name>               Project name (default: the app's package name)
  --review-url <url>          The prototype's deployed address, where mention emails link
  --entry <file>              The file where the app renders, relative to --dir
  --mount <Element>           The element in that file to add Critiqs beside, such as App
  --remote                    Approve sign-in from a browser on any device, with a short code
  --browser                   Sign in through a browser on this computer
                              (default: --browser, or --remote over SSH or without a desktop)
  --new-project               Create a new project even if the code or your account has one
  --dir <path>                The app's folder (default: current folder)
  --project-env-file <file>   The .env file init writes or doctor checks, relative to --dir
                              (default: the framework's, such as .env.local)
  --dry-run                   With a project ID, show the change without writing it
  --json                      Print the result as JSON, for scripts and coding agents

Optional: keep feedback on your own backend instead of Critiqs Cloud
  --own-convex                Deploy Critiqs to your team's own Convex deployment
  --backend <url>             Use a Critiqs backend that is already deployed
  --cloud                     Critiqs Cloud (the default)

Keys, read from the environment or asked for (own Convex only):
  CONVEX_DEPLOY_KEY           A production deploy key from your Convex project's settings
  RESEND_API_KEY, CRITIQS_EMAIL_FROM
                              Optional: send mention emails through your Resend account

Options for doctor:
  --backend <url>             Check this backend instead of the one the code names
  --dir <path>                The app's folder (default: current folder)
  --json                      Print the checks as JSON

Options for sign-in and sign-out:
  --remote, --browser         Approve with a code from any device; --browser also opens the page here
  --backend <url>             A backend other than Critiqs Cloud
Sign-in lasts until sign-out, 30 days without use, or 90 days. Agents read
feedback with the MCP server's critiqs_comments, critiqs_thread, and
critiqs_screenshot tools, and mockups with critiqs_mockups and critiqs_mockup.`;

/** Parses the command line; returns options or an error message. */
export function parseCommand(argv) {
  const options = {
    command: null,
    projectId: null,
    dir: ".",
    dryRun: false,
    target: null,
    name: null,
    reviewUrl: null,
    help: false,
    entry: null,
    mount: null,
    signIn: null,
    newProject: false,
    json: false,
    envFile: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = (flag) => {
      const next = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (next === undefined || next === "") throw new Error(`${flag} needs a value.`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") options.help = true;
      else if (arg === "--dry-run") options.dryRun = true;
      else if (arg === "--cloud") options.target = "cloud";
      else if (arg === "--own-convex") options.target = "own-convex";
      else if (arg === "--backend" || arg.startsWith("--backend=")) options.target = value("--backend");
      else if (arg === "--name" || arg.startsWith("--name=")) options.name = value("--name");
      else if (arg === "--review-url" || arg.startsWith("--review-url=")) options.reviewUrl = value("--review-url");
      else if (arg === "--dir" || arg.startsWith("--dir=")) options.dir = value("--dir");
      else if (arg === "--entry" || arg.startsWith("--entry=")) options.entry = value("--entry");
      else if (arg === "--mount" || arg.startsWith("--mount=")) options.mount = value("--mount");
      else if (arg === "--project-env-file" || arg.startsWith("--project-env-file=")) options.envFile = value("--project-env-file");
      else if (arg === "--env-file" || arg.startsWith("--env-file=")) options.envFile = value("--env-file");
      else if (arg === "--remote" || arg === "--browser") {
        if (options.signIn !== null && options.signIn !== arg.slice(2)) throw new Error("Choose either --remote or --browser.");
        options.signIn = arg.slice(2);
      } else if (arg === "--new-project") options.newProject = true;
      else if (arg === "--json") options.json = true;
      else if (arg.startsWith("-")) return { error: `Unknown option ${arg}.` };
      else positional.push(arg);
    } catch (error) {
      return { error: error.message };
    }
  }
  options.command = positional[0] ?? null;
  options.projectId = positional[1] ?? null;
  if (options.help) return options;
  if (!["init", "doctor", "mcp", "sign-in", "sign-out"].includes(options.command ?? "")) {
    return { error: options.command === null ? "Missing command." : `Unknown command ${options.command}.` };
  }
  if (positional.length > (options.command === "init" ? 2 : 1)) return { error: `Unexpected argument ${positional.at(-1)}.` };
  if (options.target !== null && options.target !== "cloud" && options.target !== "own-convex") {
    try {
      new URL(options.target);
    } catch {
      return { error: "--backend needs a URL such as https://<deployment>.convex.cloud." };
    }
  }
  return options;
}

/** Asks questions on the terminal; hidden answers aren't echoed. */
function terminal() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (text) => {
    if (!muted || text.includes("\n")) write?.(muted ? "\n" : text);
  };
  return {
    ask: (question, { hidden = false } = {}) =>
      new Promise((answer) => {
        rl.question(question, (text) => {
          muted = false;
          answer(text.trim());
        });
        muted = hidden;
      }),
    close: () => rl.close(),
  };
}

const SYMBOL = { pass: "✓", warn: "!", fail: "✗", info: "-", next: "→" };

/** In a workspace, asks which app to set up; null when the answer isn't one of them. */
async function chooseApp(io, apps, cwd) {
  const names = apps.map((dir) => relative(cwd, dir) || ".");
  const answer = await io.ask(`This is a workspace; each app gets its own Critiqs project. Which app?\n${names.map((name, index) => `  ${index + 1}. ${name}`).join("\n")}\nNumber: `);
  const index = Number(answer) - 1;
  return Number.isInteger(index) && index >= 0 && index < apps.length ? apps[index] : null;
}

async function runSetup(options, { cwd, print }) {
  let root = resolve(cwd, options.dir);
  // JSON goes to standard output alone; progress goes to standard error.
  const say = options.json ? (message) => console.error(message) : print;
  const interactive = process.stdin.isTTY === true && !options.json;
  const io = interactive ? terminal() : null;
  try {
    // A person at a terminal picks the app; otherwise setup refuses with the exact --dir for each.
    const apps = io === null ? null : workspaceApps(root);
    if (apps !== null && apps.length > 0) {
      const chosen = await chooseApp(io, apps, cwd);
      if (chosen === null) throw new SetupError("No app was chosen, so nothing was changed. Run init again in the app's folder, or pass --dir <app folder>.");
      root = chosen;
    }
    const target = options.target ?? "cloud";
    const keys = {};
    if (target === "own-convex") {
      if (!process.env.CONVEX_DEPLOY_KEY && !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
        if (io === null) throw new SetupError("Set CONVEX_DEPLOY_KEY to a production deploy key from your Convex project's settings.");
        keys.convexDeployKey = await io.ask("Convex production deploy key (from your Convex project's settings): ", { hidden: true });
      }
      if (!process.env.RESEND_API_KEY && io !== null) {
        const resendApiKey = await io.ask("Resend API key for mention emails (optional, Enter to skip): ", { hidden: true });
        if (resendApiKey !== "") {
          keys.resendApiKey = resendApiKey;
          keys.emailFrom = process.env.CRITIQS_EMAIL_FROM ?? (await io.ask("Send mention emails from (such as Critiqs <critiqs@example.com>): "));
        }
      }
    }
    const setup = await beginSetup({
      root,
      cwd,
      // An explicit choice only; otherwise a project the code names is kept wherever it is.
      target: options.target,
      name: options.name ?? undefined,
      reviewUrl: options.reviewUrl ?? undefined,
      keys,
      log: say,
      entry: options.entry,
      mount: options.mount,
      newProject: options.newProject,
      signIn: options.signIn ?? "auto",
      envFile: options.envFile,
    });
    if (setup.connected) {
      const where = setup.backendUrl === CLOUD_BACKEND_URL ? "Critiqs Cloud" : setup.backendUrl;
      const { env } = setup.connected;
      const from = env ? ` (${env.name} in ${env.file === null ? "this shell's environment" : relative(cwd, env.file) || env.file})` : "";
      say(`The code already uses project ${setup.connected.projectId}${from} on ${where}, so nothing was created. Checking it…`);
      const report = doctorReport(await doctor({ root, cwd, envFile: options.envFile }));
      if (options.json) print(JSON.stringify({ ok: report.ok, connected: setup.connected, ...report }, null, 2));
      else printChecks(report.checks, print);
      say("Pass --new-project to replace it with a new project, or --review-url to set where mention emails link.");
      return report.ok ? 0 : 1;
    }
    if (setup.method === "remote") {
      say(
        `\nApprove this setup from a browser on any device:\n  1. Open ${setup.url}\n  2. Enter the code ${setup.userCode}\n  3. Sign in with your email and choose Approve.\n` +
          "The code works for 10 minutes. Waiting…",
      );
    } else {
      say(`\nSign in to finish setup. Opening ${setup.url}\nIf no browser opens, open that address on this computer, or run again with --remote to approve from another device.`);
      openBrowser(setup.url);
    }
    const result = await setup.finish();
    if (result.approvedBy) say(`Approved by ${result.approvedBy.name} (${result.approvedBy.email}).`);
    const stages = readiness(result);
    if (options.json) {
      const env = result.written.env ? { name: result.written.env.name, file: result.written.env.file } : null;
      print(JSON.stringify({ ok: result.written.ok, projectId: result.projectId, projectName: result.projectName, backendUrl: result.backendUrl, reused: result.reused, env, stages }, null, 2));
    } else {
      print("");
      printChecks(stages, print);
      if (result.written.preview) print(result.written.preview.split("\n").map((line) => `    ${line}`).join("\n"));
      if (result.written.ok) print("\nRun npx critiqs doctor any time to check the setup.");
    }
    return result.written.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    if (options.json) print(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else print(error.message);
    return 1;
  } finally {
    io?.close();
  }
}

/** Signs this computer in for reading feedback; 0 when signed in. */
async function runSignIn(options, { print, env = process.env } = {}) {
  try {
    const status = await signInStatus({ backendUrl: options.backendUrl, env });
    if (status.saved !== null) print(`This computer was signed in as ${status.saved.reviewer?.name ?? "someone"}; signing in again replaces it.`);
    const pending = await beginSignIn({ backendUrl: options.backendUrl, method: options.signIn ?? "auto", env });
    print(`\nApprove this computer from a browser on this or any device:\n  1. Open ${pending.url}\n  2. Enter the code ${pending.userCode}\n  3. Sign in with your email and choose Approve.\n`);
    if (pending.method === "browser") openBrowser(pending.url);
    const { reviewer, endsAt } = await pending.finish();
    print(
      `Signed in as ${reviewer?.name ?? "you"}${reviewer?.email ? ` (${reviewer.email})` : ""}. Coding agents on this computer can now read feedback through critiqs mcp.\n` +
        `This lasts until critiqs sign-out, 30 days without use${endsAt ? `, or ${new Date(endsAt).toISOString().slice(0, 10)}` : ", or 90 days"}.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof SetupError) {
      print(error.message);
      return 1;
    }
    throw error;
  }
}

async function runSignOut(options, { print, env = process.env } = {}) {
  try {
    const result = await signOutComputer({ backendUrl: options.backendUrl, env });
    const who = result?.reviewer?.name ? ` ${result.reviewer.name}` : "";
    print(
      result === null
        ? "This computer wasn't signed in to Critiqs."
        : result.found
          ? `Signed out${who}.`
          : `Forgot this computer's sign-in${who}. The service had no session for it: it had already ended, or an interrupted renewal replaced it, and that one ends after 30 days without use.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof SetupError) {
      print(error.message);
      return 1;
    }
    throw error;
  }
}

function printChecks(checks, print) {
  for (const check of checks) print(`${SYMBOL[check.status] ?? "-"} ${check.name}: ${check.detail}`);
}

async function runDoctor(options, { cwd, print }) {
  if (options.target === "cloud" || options.target === "own-convex") {
    print(`doctor checks the backend the prototype names; use --backend <url> to check another.\n\n${USAGE}`);
    return 2;
  }
  const report = doctorReport(await doctor({ root: resolve(cwd, options.dir), cwd, backendUrl: options.target ?? undefined, envFile: options.envFile }));
  if (options.json) print(JSON.stringify(report, null, 2));
  else {
    printChecks(report.checks, print);
    print(`\n${DOCTOR_NOTE}`);
  }
  return report.ok ? 0 : 1;
}

/** Runs the CLI; resolves to its exit code: 0 done, 1 not done, 2 usage error. */
export async function runCli(argv, { cwd = process.cwd(), print = console.log } = {}) {
  const options = parseCommand(argv);
  if ("error" in options) {
    print(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    print(USAGE);
    return 0;
  }
  if (options.command === "mcp") {
    const { serveMcp } = await import("./mcp.mjs");
    await serveMcp({ cwd });
    return 0;
  }
  if (options.command === "doctor") return await runDoctor(options, { cwd, print });
  if (options.command === "sign-in" || options.command === "sign-out") {
    if (options.target === "own-convex") {
      print(`${options.command} needs a deployed backend: use --backend <url>.\n\n${USAGE}`);
      return 2;
    }
    const backendUrl = options.target === null || options.target === "cloud" ? undefined : options.target;
    return options.command === "sign-in" ? await runSignIn({ ...options, backendUrl }, { print }) : await runSignOut({ backendUrl }, { print });
  }
  if (options.projectId !== null) {
    if (options.target !== null || options.name !== null || options.reviewUrl !== null || options.signIn !== null || options.newProject || options.json) {
      print(`An existing project's ID is written as it is; --cloud, --own-convex, --backend, --name, --review-url, --remote, --browser, --new-project, and --json are for creating or connecting a project.\n\n${USAGE}`);
      return 2;
    }
    return runInit(
      [
        "init",
        options.projectId,
        "--dir",
        options.dir,
        ...(options.entry !== null ? ["--entry", options.entry] : []),
        ...(options.mount !== null ? ["--mount", options.mount] : []),
        ...(options.envFile !== null ? ["--project-env-file", options.envFile] : []),
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
      { cwd, print },
    );
  }
  return await runSetup(options, { cwd, print });
}
