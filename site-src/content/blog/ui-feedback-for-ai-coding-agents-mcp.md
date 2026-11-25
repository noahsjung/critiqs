---
title: How to give UI feedback to AI coding agents with MCP
description: Connect on-page visual feedback and AI mockups to Claude Code, Codex, and Cursor using the Model Context Protocol so agents fix UI bugs accurately.
date: 2026-11-24
tags: [mcp, ai-coding-agents, claude-code, cursor, codex, visual-feedback]
---

To give UI feedback to an AI coding agent with MCP, connect your agent (such as Claude Code, Codex, or Cursor) to an MCP server that exposes live review threads, element anchors, screen context, and captures directly from your staging or preview build. Instead of manually copying Slack messages and screenshots into prompts, the agent pulls structured threads, implements the fix in your components, and replies to reviewers when the update is ready.

Coding agents write React components quickly, but frontend review still hits a manual bottleneck. A designer or product manager leaves ten comments across staging, a developer translates each note into a prompt, hunts down the right component file, and messages everyone back after pushing. Connecting visual review straight to the agent over the Model Context Protocol (MCP) removes that translation layer.

## Why pasting screenshots into coding agent prompts breaks down

Giving an agent a cropped screenshot and a paraphrased note ("the seat label looks cramped on mobile") leaves out four facts the agent needs to edit the right file cleanly:

1. **Which component rendered the element.** Two buttons on different tabs can look identical in a screenshot while living in separate components.
2. **Which view state and record were active.** A bug inside a closed modal, a filtered table, or a specific customer record takes time to trace when the prompt only mentions a page name.
3. **The full discussion.** A review thread often starts with one idea from product, gets refined by design, and ends with a decision in reply four. Pasting only the first message makes the agent build the wrong version.
4. **The visual target.** Words like "quieter button" or "tighter spacing" leave the agent guessing at padding, borders, and copy unless a concrete visual proposal is attached.

An MCP server solves this by handing the agent structured thread data, component identifiers, saved captures, and (with Critiqs Mockup mode) the exact HTML and CSS changes a reviewer already approved visually.

## How the Critiqs MCP server works

[Critiqs](/docs/install) mounts `<Critiqs />` inside your React 18 or 19 staging, preview, and QA builds. As product managers, designers, QA testers, and clients comment on elements or create design proposals in [Mockup mode](/docs/mockup-mode), Critiqs stores each thread with its capture, page, view state, and build revision.

The `critiqs-react` package includes an MCP server (`npx critiqs-react mcp`) that works with Critiqs Cloud and self-hosted Convex deployments. Add it to your coding agent's MCP configuration:

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

Sign the computer in once by running `npx critiqs-react sign-in` (or let the agent call `critiqs_sign_in`, which prints a browser approval address and short setup code). Your sign-in stays on that computer, readable only by your user account, until you sign out, leave it unused for 30 days, or reach 90 days. You never paste an API key or email sign-in code into the agent chat.

Full setup instructions live in the [MCP documentation](/docs/mcp).

## The MCP tools your agent uses to inspect and fix UI feedback

Once connected, your agent has six feedback and mockup tools:

- **`critiqs_comments`**: lists threads for a `projectId`, filtered by `status` (`open`, `resolved`, or `all`), `author`, `since` and `until` dates, `tag`, `screen`, or `text`. Each thread comes back with its full discussion and context: `context.target.purposeId` (the element's `data-critiqs-id` in your code), logical screen, view state, record, scope, page address, window size, demo persona, and build revision.
- **`critiqs_thread`**: fetches one thread by ID or shareable Critiqs link, adding mentions, reactions, the latest status (who last resolved or reopened it, and when), who moved it, and screenshot status.
- **`critiqs_screenshot`**: returns the saved capture of what the reviewer saw, with the commented element outlined (or saves it to a local file path).
- **`critiqs_mockups`**: lists [Mockup mode](/docs/mockup-mode) proposals for a project, including the page, view state, version count, viewport widths, and mockup thread summary.
- **`critiqs_mockup`**: returns the exact ordered list of edits from a mockup version (CSS rules, text changes, attribute changes, and inserted, replaced, or removed elements), paired with each original element's start tag, text, and nearest `data-critiqs-id`, plus the mockup discussion and linked comment threads.
- **`critiqs_reply`**: posts a reply back to a thread as your signed-in reviewer account, clearly labeled **"via coding agent"**, with optional mentions and commit revision.

## A practical loop from review comment to verified fix

Here is what the workflow looks like in Claude Code, Codex, or Cursor once the MCP server is configured.

### 1. Pull open threads for the screen you are working on

Prompt your agent with the project and scope:

> Check open Critiqs comments for project `<projectId>` tagged `Bug` or `UX copy change` on the customer details screen. Inspect the screenshots and map each one to the React component before editing.

The agent calls `critiqs_comments` and `critiqs_screenshot`. Because each thread includes the screen, active tab, record, and `data-critiqs-id` when present, the agent locates the right component without guessing across the whole repo.

### 2. Inspect Mockup mode proposals as structured diffs

When a designer used Mockup mode to adjust layout, spacing, or button styling on a frozen copy of the page, ask the agent to read the mockup:

> Read the latest version of the customer header mockup in Critiqs and apply those visual changes using our existing design-system components.

The agent calls `critiqs_mockups` and `critiqs_mockup`. Instead of eyeballing a screenshot and inventing arbitrary Tailwind classes or inline CSS, it reads the exact sequence of CSS and DOM changes relative to the original element and translates them cleanly into your real React components.

### 3. Implement, test, and reply in the thread

After the agent edits the code and runs your checks, ask it to report back on the threads it fixed:

> Reply on each fixed Critiqs thread with what changed, include the commit hash, and mention Priya so she can check the updated preview.

Calling `critiqs_reply` posts a comment shown as `Your Name · via coding agent`. Everyone in the thread receives their normal reply email (unless they muted notifications), and mentioned reviewers get a mention email pointing straight to the [project's review address](/docs/projects). Nothing is silently resolved behind a reviewer's back: humans still verify the updated build and resolve the thread.

## Tips for getting reliable results from coding agents

- **Add `data-critiqs-id` to key UI regions.** When important components carry stable `data-critiqs-id` attributes, `critiqs_comments` and `critiqs_mockup` hand the agent an exact search string that jumps straight to the right JSX file.
- **Tell the agent to rebuild in your components, never paste frozen HTML.** Mockup copies are static snapshots without React state or event handlers. Instruct your agent to translate mockup diffs into your app's own components and tokens.
- **Keep replies factual.** Ask your agent to mention only changes it actually made and verified.
- **Use Markdown or JSON export when MCP is unavailable.** If a teammate uses an editor without MCP, or wants to drop three threads into an issue tracker, select the threads in the Critiqs sidebar and export them as Markdown or JSON with the full conversation preserved.

## Frequently asked questions

### Which coding agents work with the Critiqs MCP server?

Any coding agent or client that supports standard stdio MCP servers works with `npx critiqs-react mcp`, including Claude Code, Codex, and Cursor.

### Does Critiqs MCP work with self-hosted setups?

Yes, if you self-host Critiqs on your own Convex deployment (MIT license). The MCP reading and reply tools work with both Critiqs Cloud and team-owned Convex deployments.

### Can a coding agent also set up Critiqs in my React app?

Yes. Beyond reading feedback, `npx critiqs-react mcp` includes setup and diagnostic tools (`critiqs_setup_start`, `critiqs_setup_finish`, `critiqs_write_project_id`, and `critiqs_doctor`), and the package ships an `AGENT_SETUP.md` guide so an agent can install `<Critiqs />` and verify configuration.

### Do reviewers know when a reply was written by a coding agent?

Yes. Every reply posted through `critiqs_reply` appears under the signed-in person's name with a **"via coding agent"** label, so teammates always know what came from an agent versus a manual reply.
