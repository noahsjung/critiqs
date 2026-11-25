---
name: critiqs
description: Use when the user mentions Critiqs, review feedback, comments on a staging or preview build, or Critiqs mockups. Guides installing critiqs-react, connecting MCP, reading threads and mockups, implementing changes, and replying.
---

# Critiqs

Critiqs adds `<Critiqs />` from `critiqs-react` to a React 18 or 19 app so reviewers can comment on staging and preview builds and sketch visual changes in Mockup mode.

Never ask the user to paste API keys, deploy keys, tokens, or email sign-in codes into chat.

## 1. Check whether Critiqs is installed

Check `package.json` (or the relevant workspace app's `package.json`) for `critiqs-react` and check where `<Critiqs />` is rendered.

If Critiqs is not installed or configured yet, follow the setup guide (full instructions: https://critiqs.app/docs/install):

1. Install `critiqs-react` with the repo's package manager (`npm install`, `pnpm add`, `yarn add`, or `bun add`).
2. Run `npx critiqs-react init --json` in the app folder (pass `--dir apps/<app>` in a monorepo; each app gets its own project). Alternatively call `critiqs_setup_start` through MCP, and call `critiqs_setup_finish` only when an approval or sign-in is pending (do not call `critiqs_setup_finish` if `critiqs_setup_start` returns `connected` for an already configured project).
   - If there is no local browser, use `--remote` (or `signIn: "remote"`). Pass the printed URL and short setup code (for example `BCDF-GHJK`) to the user exactly and ask them to approve it in a browser.
   - If the user already has a project ID, run `npx critiqs-react init <projectId>` (or `critiqs_write_project_id`).
3. When `init --json` (or `critiqs_setup_finish`) returns `stages`, report every item (`Code`, `Project`, `Try it locally`, `Deployments`, `Reviewers elsewhere`). If setup returns `connected` instead, report its doctor checks. Remind the user to commit the code change, not `.env.local`, and to set the project ID env var only in staging/preview build settings.
4. Run `npx critiqs-react doctor --json` (or `critiqs_doctor`). Do not claim email, capture upload, or commenting is proven until a person leaves a real comment.
5. Once deployed, record the staging URL with `npx critiqs-react init --review-url https://<deployed-address>` so email links open it.

## 2. Connect MCP and sign in

Critiqs's stdio MCP server runs with `npx critiqs-react mcp`. If the `critiqs_*` tools are unavailable, ask the user to add this MCP server config.

For Claude Code (`.mcp.json`) or Cursor (`.cursor/mcp.json`):

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

For Codex (`.codex/config.toml`):

```toml
[mcp_servers.critiqs]
command = "npx"
args = ["critiqs-react", "mcp"]
```

If the app uses a team-owned Convex deployment (`<Critiqs backend="..." />`), pass that backend URL as `backend` in every tool call that accepts it: `critiqs_sign_in`, `critiqs_sign_out`, `critiqs_comments`, `critiqs_thread`, `critiqs_screenshot`, `critiqs_mockups`, `critiqs_mockup`, and `critiqs_reply`. Each call resolves its backend on its own and defaults to Critiqs Cloud.

If a read call reports that this computer is not signed in:

1. Call `critiqs_sign_in` (passing `backend` for a team-owned Convex deployment), or tell the user to run `npx critiqs-react sign-in` (or `npx critiqs-react sign-in --backend <url>` for a team-owned deployment).
2. If `critiqs_sign_in` reports that this computer is already signed in, stop there and do not call `critiqs_sign_in_finish`.
3. Only when `critiqs_sign_in` returns a pending approval URL and setup code: give them to the user verbatim (never ask for the email code they receive), then call `critiqs_sign_in_finish` until it confirms the signed-in account. The sign-in is saved locally for future sessions.

## 3. Read open threads and fix the code

Find the app's `projectId` from its `.env.local` (or `<Critiqs projectId="..." />`) and check whether `<Critiqs />` sets a `backend` URL.

1. Call `critiqs_comments` with `projectId` (and `backend` when using a team-owned Convex deployment; defaults to `status: "open"`). Use `tag`, `screen`, `author`, `since`, `until`, or `text` when narrowing scope.
2. For each thread you will work on, call `critiqs_thread` (with `backend` if non-Cloud) to read the full discussion, mentions, reactions, and screenshot status.
3. Call `critiqs_screenshot` (with `backend` if non-Cloud) to inspect what the reviewer saw with the target outlined. If an image exceeds 5 MB, pass `file` to save it locally.
4. Locate the target in the codebase using:
   - `context.target.purposeId` (the component's `data-critiqs-id` attribute)
   - `context.screen`, `context.viewState`, `context.target.recordKey`, `context.target.label`, and `context.page.url`
   - the capture image
5. Implement the fix cleanly in the host app's real components and verify it with the repo's checks/tests.

## 4. Reply in the thread

After the fix is implemented and verified, call `critiqs_reply`:

- `thread`: the thread ID or Critiqs link
- `body`: concise plain text stating only what you actually changed and verified, and what the reviewer should check
- `revision`: the commit SHA or build label when available
- `mention`: optional display names or `authorId` values from `critiqs_thread` (use `authorId` if two people share a name)
- `backend`: the app's backend URL when using a team-owned Convex deployment

Critiqs posts the reply as the signed-in user marked "via coding agent" and emails participants in the thread. Do not resolve the thread yourself; leave resolving to a person after they verify the next build.

## 5. Read and build mockups

Mockups are visual proposals reviewers created with Critiqs AI on frozen page copies.

1. Call `critiqs_mockups` with `projectId` (and `backend` if non-Cloud; optional `screen` or `text` filter) to find the mockup ID.
2. Call `critiqs_mockup` with `mockup` (and `backend` if non-Cloud; defaults to the latest version; pass `saveCopies` to write original HTML and `edits-v<N>.json` into a scratch folder if needed).
3. Inspect:
   - `copies[].edits`: ordered CSS, text, attribute, insert, replace, and remove changes. Node-targeted changes include `original` (start tag, text, and nearest `data-critiqs-id` as `purposeId`), or `original: null` with `addedByChange: true` when an earlier change added the node; changes without a node omit `original`
   - `threads`: the mockup conversation explaining the intent
   - `linkedThreads`: related feedback threads (read in full with `critiqs_thread`)
4. Build the change in the app's own React components and styles. Never copy and paste the frozen page copy's HTML.
5. Reply on any `linkedThreads` with `critiqs_reply` (with `backend` if non-Cloud) once the change is verified.

## Tools reference

- Setup: `critiqs_setup_start`, `critiqs_setup_finish`, `critiqs_write_project_id`, `critiqs_doctor`
- Auth: `critiqs_sign_in`, `critiqs_sign_in_finish`, `critiqs_sign_out`
- Feedback: `critiqs_comments`, `critiqs_thread`, `critiqs_screenshot`, `critiqs_reply`
- Mockups: `critiqs_mockups`, `critiqs_mockup`
