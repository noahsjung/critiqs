# Connect a coding agent with MCP

> Configure the Critiqs MCP server for your coding agent, sign in once on your computer, and read threads, captures, and mockups.

Critiqs ships a stdio Model Context Protocol (MCP) server inside `critiqs-react`. Run it with `npx critiqs-react mcp` so your coding agent can list open threads, inspect captures, read mockups, and post replies marked "via coding agent".

> **Note:** The MCP feedback tools work with Critiqs Cloud and team-owned Convex deployments. Node.js 20 or later is required.

## Add the MCP server to your client

Critiqs uses the standard stdio MCP transport with command `npx` and arguments `["critiqs-react", "mcp"]`.

### Claude Code

Add Critiqs to `.mcp.json` in your repository root:

```json
{
  "mcpServers": {
    "critiqs": {
      "command": "npx",
      "args": ["critiqs-react", "mcp"]
    }
  }
}
```

### Codex

Add Critiqs to `.codex/config.toml` in your repository (or your user-level Codex config):

```toml
[mcp_servers.critiqs]
command = "npx"
args = ["critiqs-react", "mcp"]
```

### Cursor

Add Critiqs to `.cursor/mcp.json` in your repository (or your global Cursor MCP settings):

```json
{
  "mcpServers": {
    "critiqs": {
      "command": "npx",
      "args": ["critiqs-react", "mcp"]
    }
  }
}
```

### VS Code, Copilot, Windsurf, and other MCP clients

Use the generic stdio configuration for any client that reads an MCP JSON file:

```json
{
  "mcpServers": {
    "critiqs": {
      "command": "npx",
      "args": ["critiqs-react", "mcp"]
    }
  }
}
```

VS Code and GitHub Copilot read `.vscode/mcp.json` in the repository, with the servers under `servers`:

```json
{
  "servers": {
    "critiqs": {
      "type": "stdio",
      "command": "npx",
      "args": ["critiqs-react", "mcp"]
    }
  }
}
```

Windsurf reads `~/.codeium/windsurf/mcp_config.json`, with the same `mcpServers` block as above.

> **Note:** If you deploy to your team's own Convex backend through MCP (`target: "own-convex"`), inject `CONVEX_DEPLOY_KEY` into the MCP server's process environment from a secret store or your shell environment instead of writing a literal key into a repository config file. Never paste API keys or deploy keys into chat or tool arguments. Alternatively, run `npx critiqs-react init --own-convex` in a terminal and enter the key at its hidden prompt.

## Sign in once on your computer

Reading feedback and replying require a saved sign-in on the computer running the MCP server. You sign in once and every future agent session on that computer reuses it.

1. Run the sign-in command in a terminal:

   ```sh
   npx critiqs-react sign-in
   ```

   If you use a team-owned Convex deployment instead of Critiqs Cloud, pass `--backend https://<deployment>.convex.cloud`.

2. Open the printed approval address in a browser on this computer or any other device, enter the short setup code (such as `BCDF-GHJK`), sign in with your email, and choose **Approve**. The code expires after 10 minutes.
3. Alternatively, skip the terminal command and ask your agent to call `critiqs_sign_in` followed by `critiqs_sign_in_finish`. Give the approval in your browser, and never paste an email sign-in code into the chat.

Your session is stored in `sign-in.v2.json`, readable only by your user account:

- macOS and Linux: `$XDG_CONFIG_HOME/critiqs/sign-in.v2.json` (defaults to `~/.config/critiqs/sign-in.v2.json`)
- Windows: `%APPDATA%\critiqs\sign-in.v2.json`
- Custom folder: set `CRITIQS_CONFIG_DIR`

Earlier versions of `critiqs-react` used `sign-in.json` in the same folder. The first time a newer version runs, it moves that file's Critiqs Cloud sign-in over and leaves `sign-in.json` signed out. Signing out of Critiqs Cloud signs out both.

The sign-in lasts until you run `npx critiqs-react sign-out` (or call `critiqs_sign_out`), 30 days without use, or 90 days total.

## MCP tools reference

All 13 tools below are served by `npx critiqs-react mcp`. Pass `backend` only when your project runs on a deployment other than Critiqs Cloud.

### Reading feedback and mockups

| Tool | Main inputs | What it returns |
| --- | --- | --- |
| `critiqs_comments` | `projectId` (required), `status` (`"open"`, `"resolved"`, `"all"`), `author`, `since`, `until`, `tag`, `screen`, `text`, `limit` (1 to 500, default 50), `backend` | Matching threads newest activity first, each with its full discussion (`authorId`, timestamps, `via`, `matches` when message filters ran), `truncated` flag, and full context (`screen`, `viewState`, `scope`, `target.purposeId` from `data-critiqs-id`, `recordKey`, page URL, viewport, demo persona, build revision, and `movedTo`). |
| `critiqs_thread` | `thread` (required: thread ID or `?critiqs=...` link), `backend` | One thread's full discussion with each message's mentions, reactions, `mine`, and `linked` (when given a message link), plus who last resolved, reopened, or moved it, its screenshot status, and full context. |
| `critiqs_screenshot` | `thread` (required), `file` (optional relative path), `backend` | The capture image with the commented element outlined, plus page URL, viewport size, marked coordinates, and capture timestamp. Images over 5 MB must be saved to disk with `file`. |
| `critiqs_mockups` | `projectId` (required), `screen`, `text`, `limit` (1 to 100, default 50), `backend` | Project mockups most recently changed first, with each mockup's ID, title, source page (`url`, `screen`, `viewState`, `revision`, `persona`), version and thread counts, page copies (`id`, `width`), and mockup thread summaries. |
| `critiqs_mockup` | `mockup` (required), `version` (default latest; `0` for original copies), `saveCopies` (optional relative folder), `backend` | Source page, page copies, version history, mockup threads (with Critiqs AI replies marked `via: "ai"`), linked feedback threads, and every ordered change (`css`, `text`, `attribute`, `insert`, `replace`, `remove`). Changes targeting a node include `original` (start tag, text, and nearest `data-critiqs-id` as `purposeId`), or `original: null` with `addedByChange: true` when an earlier change added that node; changes with no node have no `original` field. With `saveCopies`, writes `<folder>/<mockupId>/<copyId>.html` and `edits-v<N>.json`. |

### Replying in threads

| Tool | Main inputs | What it returns |
| --- | --- | --- |
| `critiqs_reply` | `thread` (required), `body` (required, up to 10,000 characters), `mention` (display names or author IDs), `revision` (commit or build label), `backend` | The new reply's `messageId`, `link`, `mentioned` recipients, and `via: "agent"`. Posted as `<Your name> · via coding agent`. Emails everyone else in the thread (unless they turned reply emails off) and sends mention emails to people in `mention`. |

### Signing in and out

| Tool | Main inputs | What it returns |
| --- | --- | --- |
| `critiqs_sign_in` | `signIn` (`"auto"`, `"browser"`, `"remote"`), `force`, `backend` | The approval URL and short setup code (or reports who is already signed in unless `force: true`). |
| `critiqs_sign_in_finish` | `waitSeconds` (1 to 50, default 45) | Waits for browser approval, saves the session on this computer, and returns the signed-in account and expiry date. Call again while it reports waiting. |
| `critiqs_sign_out` | `backend` | Ends this computer's session with the sign-in service and deletes the saved entry. |

### Project setup and diagnostics

| Tool | Main inputs | What it returns |
| --- | --- | --- |
| `critiqs_setup_start` | `dir`, `target` (`"cloud"`, `"own-convex"`, or backend URL), `name`, `reviewUrl`, `signIn`, `entry`, `mount`, `newProject`, `envFile` | Plans component placement, deploys to your own Convex if requested, and returns the sign-in URL (and setup code for remote approval). |
| `critiqs_setup_finish` | `waitSeconds` (1 to 50, default 45) | Waits for sign-in, creates or reuses the project, writes the component and ID, and returns structured `stages` and `env` matching `critiqs init --json`. |
| `critiqs_write_project_id` | `projectId` (required), `dir`, `dryRun`, `entry`, `mount`, `envFile` | Connects `<Critiqs />` to an existing project without signing in. |
| `critiqs_doctor` | `dir`, `envFile`, `backend` | Runs all setup checks and returns structured results matching `critiqs doctor --json`. |

## Typical agent workflow

1. **List open feedback.** Ask your agent to call `critiqs_comments` with your project ID (defaults to `status: "open"`). Filter by `tag`, `screen`, `author`, or `since` to focus on one area.
2. **Inspect a thread.** Have the agent call `critiqs_thread` for full discussion details and `critiqs_screenshot` to see the exact element outlined on screen.
3. **Locate and fix the code.** The agent uses `context.target.purposeId` (your element's `data-critiqs-id`), `context.screen`, `context.viewState`, and the capture to find the component, make the edit, and run tests. For visual proposals in Mockup mode, it calls `critiqs_mockups` and `critiqs_mockup` and implements the edits in your real React components rather than copying frozen HTML.
4. **Reply in the thread.** Once the fix is verified, the agent calls `critiqs_reply` with a short summary of what changed, the build or commit in `revision`, and optional `mention` recipients. Critiqs labels the reply "via coding agent".
5. **Resolve after review.** Leave the thread open so a reviewer can confirm the change on the next staging or preview build and resolve it.

## Next steps

- Install the [Critiqs agent skill](/docs/agent-skill) so your agent follows this workflow automatically.
- See the [command line reference](/docs/cli) for all CLI commands and flags.
- Hand off threads without MCP using [export](/docs/export).
- Check [troubleshooting](/docs/troubleshooting) if sign-in or MCP tool calls fail.
