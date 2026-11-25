---
title: Frequently asked questions
description: Short answers to common questions about installing Critiqs, reviewers, Mockup mode, coding agents, pricing, and self-hosting.
section: Reference
order: 2
---

## Which apps and frameworks does Critiqs support?

Any React 18 or 19 app, including Vite, Next.js (App Router and Pages Router), Remix, Create React App, and custom React setups. `react` and `react-dom` are its only peer dependencies. The setup CLI and MCP server require Node.js 20 or later. See [Install Critiqs](/docs/install).

## Will our production users see Critiqs?

No, as long as you keep `requireProjectId` on `<Critiqs />` and leave the project ID environment variable unset in production builds. When the project ID is unset or malformed, Critiqs renders nothing on the page and contacts no server. A well-formed ID that does not exist on the backend contacts the backend to check it, logs a warning in the browser console, and still keeps the UI hidden. See [Best practices](/docs/best-practices).

## Do reviewers need a browser extension, account, or password?

No. Reviewers open your staging or preview link in any browser, click **Sign in** on the toolbar, and sign in with their email address and a one-time six-digit code. Their first sign-in creates their account, and their display name (never their email address) appears on comments. See [Comments](/docs/comments).

## Do reviewers need to join our organization?

No. Organizations are for the team members who create projects, manage settings, and pay for Critiqs Cloud. Anyone who can reach your staging or preview build can sign in and comment without an organization invite. See [Organizations and roles](/docs/organizations).

## Is the project ID a secret?

No. The project ID is public configuration that identifies which project a build talks to. Because anyone who has a project ID and signs in can view its feedback, guard access to your staging or preview build itself. See [Projects](/docs/projects) and [Best practices](/docs/best-practices).

## What happens to comments when the UI changes?

If Critiqs can still locate the element (especially with `data-critiqs-id`), the pin follows it. If the element moved behind another tab, changed, or was removed, the thread stays findable in the sidebar with its saved capture, context, and build version, and you can reattach it to a replacement element. See [Threads](/docs/threads) and [Captures](/docs/captures).

## Does Mockup mode edit our source code?

No. Mockup mode freezes a static copy of the current page in a sandboxed iframe, and Critiqs AI only edits that copy's HTML and CSS. Your running app and codebase stay untouched until a developer or coding agent builds the change. See [Mockup mode](/docs/mockup-mode).

## Does Critiqs require AI?

No. Commenting, threads, mentions, tags, manual tag groups, Basic search, and exports never require AI. Critiqs AI (or your own OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI Gateway, or OpenAI-compatible API key) powers Mockup mode, natural-language search with insights, and automatic tag grouping. See [AI models and credits](/docs/ai-models-and-credits) and [Your AI](/docs/your-ai).

## How do coding agents read feedback and mockups?

Connect the built-in MCP server (`npx critiqs-react mcp`) and install the Critiqs agent skill. Your agent can list open threads, inspect captures, read Mockup mode edits, and post replies marked "via coding agent". You can also export selected threads as Markdown or JSON from the sidebar. See [MCP](/docs/mcp), [Agent skill](/docs/agent-skill), and [Export threads](/docs/export).

## Where is feedback stored, and can we self-host?

Feedback is stored on Critiqs Cloud by default. Teams that keep feedback on their own infrastructure can deploy Critiqs's MIT-licensed backend to their own Convex deployment (with optional private Cloudflare R2 storage for captures). See [Self-hosting on your own Convex](/docs/self-hosting) and [Backends](/docs/backends).

## How much does Critiqs cost?

Critiqs Cloud starts free ($0) with 1 project, 5 reviewers/month, 500 comments/month, 200 monthly AI credits, and 500 MB of captures. During beta, Plus is $10/month (regularly $20) and Pro is $50/month (regularly $100). Self-hosting on your own Convex is $0 under the MIT license. See [Plans and limits](/docs/plans-and-limits).

## Does Critiqs interfere with our app's CSS or keyboard shortcuts?

Critiqs renders inside its own shadow root with isolated styles, and stops key events typed in its fields from bubbling to your app. Keyboard listeners registered in the capture phase on `window` or `document` can still see keys first. Press `Ctrl + \` or `Cmd + \` to hide all of Critiqs temporarily. See [Shortcuts](/docs/shortcuts) and [Troubleshooting](/docs/troubleshooting).
