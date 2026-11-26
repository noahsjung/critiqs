---
title: Command line reference
description: Reference for every critiqs-react CLI command, flag, environment variable, and exit code.
section: Agents
order: 4
---

The `critiqs-react` package includes the `critiqs` command line tool for setting up projects, checking configuration, signing your computer in for coding agents, and running the [MCP server](/docs/mcp).

Run it with your package manager (Node.js 20 or later required):

```sh
npx critiqs-react <command> [options]
# Also works with: pnpm exec critiqs, yarn critiqs, bunx critiqs-react
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded |
| `1` | Command did not finish or a `doctor` check failed |
| `2` | Invalid command or flag combination |

## Commands

### `critiqs init`

Adds `<Critiqs />` where your React app renders (a React root, a Next.js App Router layout, or a Next.js Pages Router `_app`), signs you in, creates or reuses a Critiqs project, and writes its project ID.

```sh
npx critiqs-react init [options]
```

In Vite and Next.js apps, `init` wires `<Critiqs />` to a public environment variable with `requireProjectId`, writes the ID to `.env.local`, and adds an empty entry to `.env.example`. In other setups, it writes the literal `projectId` into the component. Running `init` again keeps the existing project unless you pass `--new-project`.

In a monorepo workspace, run `init` once per app with `--dir apps/<app>`. At the workspace root, interactive terminals ask which app to set up; non-interactive runs list each app's `--dir` command and change nothing.

| Flag | Description |
| --- | --- |
| `--name <name>` | Project name (defaults to the app's package name, or `<workspace>/<app>` in a monorepo). |
| `--review-url <url>` | Deployed address where mention and reply emails link, including any base path. |
| `--entry <file>` | Source file where your app renders, relative to `--dir`. |
| `--mount <Element>` | Element inside `--entry` to place `<Critiqs />` beside, such as `App` or `Outlet`. |
| `--remote` | Approve sign-in from a browser on any device with a short setup code. Automatic over SSH or without a desktop. |
| `--browser` | Open sign-in in a browser on this computer (default when a desktop is available). |
| `--new-project` | Create a new project even if the code or your account already has one. |
| `--dir <path>` | App folder to inspect and update (defaults to current folder). |
| `--project-env-file <file>` | `.env` file to write, relative to `--dir` (default `.env.local`). Also accepted as `--env-file`. |
| `--json` | Print one JSON result to stdout and send progress (including remote setup codes) to stderr. |
| `--cloud` | Use Critiqs Cloud (the default). |
| `--own-convex` | Deploy Critiqs's functions to your team's own Convex deployment and write `backend`. See [self-hosting](/docs/self-hosting). |
| `--backend <url>` | Connect to an already deployed Critiqs backend URL. |

Environment variables read with `--own-convex` (never passed as CLI arguments):

- `CONVEX_DEPLOY_KEY`: production deploy key from your Convex project settings (starts with `prod:`)
- `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`: for a self-hosted Convex backend (do not combine with `CONVEX_DEPLOY_KEY`)
- `RESEND_API_KEY` and `CRITIQS_EMAIL_FROM`: optional, for mention and reply emails
- `CRITIQS_SIGN_IN_URL`: optional custom sign-in service URL (defaults to Critiqs Cloud's sign-in service)

### `critiqs init <projectId>`

Connects your app to an existing project ID without signing in.

```sh
npx critiqs-react init <projectId> [--dir <path>] [--entry <file>] [--mount <Element>] [--project-env-file <file>] [--dry-run]
```

| Flag | Description |
| --- | --- |
| `--dry-run` | Print the planned component or `.env` change without modifying any files. |
| `--dir <path>` | App folder (defaults to current folder). |
| `--entry <file>` | File where the app renders, relative to `--dir`. |
| `--mount <Element>` | Element to place `<Critiqs />` beside. |
| `--project-env-file <file>` | `.env` file to write, relative to `--dir`. |

> **Note:** Flags for creating projects (`--cloud`, `--own-convex`, `--backend`, `--name`, `--review-url`, `--remote`, `--browser`, `--new-project`, `--json`) cannot be combined with a `<projectId>` argument.

### `critiqs doctor`

Checks your local Critiqs setup: the component, backend reachability and protocol version, local project ID, deployment notes, review address, sign-in configuration, screenshot storage, optional AI status, and mention email status.

```sh
npx critiqs-react doctor [options]
```

| Flag | Description |
| --- | --- |
| `--backend <url>` | Check a specific backend URL instead of the one in your code. |
| `--dir <path>` | App folder to check (defaults to current folder). |
| `--project-env-file <file>` | `.env` file to inspect, relative to `--dir` (default `.env.local`). |
| `--json` | Print the check report as JSON (`ok`, `checks`, `note`). |

Each check reports a `basis`:

- `configuration`: the settings are present.
- `observed`: the backend reported live or stored runtime state (for example, answering `/critiqs/health`, finding the project, or checking the stored delivery status of past mention emails).

Doctor never sends an email, uploads a capture, or posts a comment, and it cannot read environment variables stored in a remote hosting provider's build settings.

### `critiqs sign-in`

Signs your computer in once so coding agents running locally can read feedback, inspect mockups, and post replies through `critiqs mcp`.

```sh
npx critiqs-react sign-in [--remote | --browser] [--backend <url>]
```

| Flag | Description |
| --- | --- |
| `--remote` | Print the approval URL and setup code without opening a browser locally. |
| `--browser` | Print the URL and code and open the approval page in your local browser. |
| `--backend <url>` | Sign in to a backend other than Critiqs Cloud. |

Credentials are saved in `sign-in.v2.json` under `$CRITIQS_CONFIG_DIR`, `$XDG_CONFIG_HOME/critiqs` (`~/.config/critiqs`), or `%APPDATA%\critiqs`. Sign-in lasts until `critiqs sign-out`, 30 days without use, or 90 days total.

### `critiqs sign-out`

Ends this computer's saved sign-in with the sign-in service and deletes the local session entry. Signing out of Critiqs Cloud also signs out a Critiqs Cloud sign-in that an earlier version of `critiqs-react` saved on this computer.

```sh
npx critiqs-react sign-out [--backend <url>]
```

| Flag | Description |
| --- | --- |
| `--backend <url>` | Sign out from a backend other than Critiqs Cloud. |

### `critiqs mcp`

Starts the stdio MCP server for coding agents. See [Connect a coding agent with MCP](/docs/mcp) for client configuration and the full tool list.

```sh
npx critiqs-react mcp
```

### Help

Print usage and options at any time:

```sh
npx critiqs-react --help
```
