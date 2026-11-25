---
title: "Critiqs vs Pastel: which website feedback tool fits your team"
description: Compare Critiqs and Pastel on setup, React state capture, AI mockups, MCP coding agents, self-hosting, and 2026 pricing to pick the right review tool.
date: 2026-11-24
tags: [comparison, pastel, staging-review, react, visual-feedback]
---

Pastel and Critiqs solve website review from two different starting points. Pastel proxies any live URL or uploaded file with comments layered on top and no code install, which fits agencies and non-React websites. Critiqs is a React component (`<Critiqs />`) installed in your staging, preview, and QA builds, which lets it restore dynamic tabs and records, share one thread list across environments, run AI page mockups, and self-host under the MIT license.

If you review marketing sites, WordPress builds, Webflow pages, PDFs, or client sites where you do not control the code, Pastel is the better fit. If you build a React 18 or 19 app and want feedback pinned inside real app states across staging and pull request previews, Critiqs is built for that workflow.

## How Pastel and Critiqs work under the hood

The main difference between the two tools is where the feedback layer runs.

Pastel uses a proxy canvas. You paste a website URL into Pastel, and Pastel displays the live site through its own review link with commenting controls on top. You can also upload HTML files, ZIP archives, images, PDFs, and videos. Because nothing is installed in the host site, you can review almost any URL immediately.

Critiqs runs inside your React app. You install `critiqs-react` and render `<Critiqs />` in your staging, preview, and QA builds. Living inside the running app lets Critiqs see the live DOM and talk to your app about which screen, tab, dialog, or customer record is active. The tradeoff is clear: Critiqs only supports React 18 and 19 apps (Vite, Next.js, Remix, and similar setups), and you must have access to the codebase.

## Setup and rollout

Pastel needs no code changes. Create a canvas in the Pastel dashboard, paste a URL, and share the link. On a login-protected site, a reviewer switches to Browse mode to sign in, then switches back to Comment mode.

Critiqs installs with two commands:

```sh
npm install critiqs-react
npx critiqs-react init
```

The `init` command adds `<Critiqs />` to your app entry, opens sign-in, creates a project on Critiqs Cloud, and wires an environment variable with `requireProjectId`. In Vite and Next.js apps, leaving that variable unset in production means Critiqs renders nothing and contacts no server. See the [install guide](/docs/install) for setup details.

## Who can comment

Neither tool requires a browser extension or a password.

In Pastel, guest reviewers are unlimited on every plan. Clients open the shared canvas link, enter their name and email on their first comment, and leave feedback with no account. Paid seats cover team users who create canvases, manage labels and assignments, write private team-only comments, and run integrations.

In Critiqs, reviewers open your staging or preview URL in any browser and sign in with an email address and a one-time code. Anyone who can reach your staging build can join without a separate invite list. On Critiqs Cloud, plans count monthly reviewers per project (5 on Free, 25 on Plus, unlimited on Pro and self-hosted).

## Context saved with each comment

Pastel saves a screenshot, page URL, browser details, and screen size with each comment. It includes a responsive tester with device presets, and clicking a comment restores its recorded width. If an element is deleted later, the comment stays in the sidebar with its original screenshot.

Critiqs pins each comment to an element and saves a capture with that element outlined, plus the page, viewport, browser, and optional build version. Optional `getContext` and `restoreContext` callbacks let Critiqs save and reopen the exact tab, dialog, or customer record when someone picks a thread later. Reviewers can also scope a note to **This component** (one record) or **Matching components** (the same component across records). If an element disappears in a newer build, the thread remains in the sidebar with its original capture and context.

## Environments and shared project feedback

In Pastel, feedback belongs to a canvas tied to a URL, and you add versions on that canvas to separate feedback rounds. That model works well when a client reviews one staging domain through version 1, version 2, and version 3.

In Critiqs, feedback follows a project ID rather than a hostname. Give your staging build, pull request previews, and QA environment the same [project ID](/docs/projects), and every comment lands in one shared thread list tagged with the build it came from.

## Design changes and AI mockups

Pastel offers inline copy editing on a website canvas so reviewers can propose text changes directly on the page.

Critiqs adds [Mockup mode](/docs/mockup-mode). Clicking **Mockup** freezes the current page into a static copy of its HTML and stylesheets (no scripts run, and the live app stays untouched). Reviewers describe wording, spacing, color, or layout edits in plain words, or attach existing comment threads for Critiqs AI to read. Critiqs AI updates the frozen copy and saves each change as a numbered version. Reviewers can restore any version or press **Hold to compare** (or hold `O`) to view the live page underneath.

## Coding agent handoff and MCP

Both tools support the Model Context Protocol (MCP) for coding agents such as Claude Code, Codex, and Cursor.

Pastel offers a hosted MCP server (`https://api.usepastel.com/mcp`) and a CLI (`@usepastel/cli`). Agents can list canvases, read comments with element and screenshot guidance, reply, mark comments resolved, and upload local HTML files directly into a canvas.

Critiqs ships an MCP server via `npx critiqs-react mcp` for Critiqs Cloud and self-hosted Convex deployments. Once signed in, an agent uses `critiqs_comments`, `critiqs_thread`, `critiqs_screenshot`, `critiqs_mockups`, `critiqs_mockup`, and `critiqs_reply`. Replies from an agent appear marked "via coding agent", and `critiqs_mockup` hands the agent ordered CSS and HTML edits paired with the nearest `data-critiqs-id`. Teams can also export selected threads as Markdown or JSON. See the [MCP guide](/docs/mcp).

## Self-hosting and data control

Pastel is hosted cloud software. Its Enterprise plan adds a SOC 2 report, SAML SSO, and custom legal terms, with no self-hosted option.

Critiqs is MIT-licensed. Teams that need feedback and captures on their own infrastructure can run `npx critiqs-react init --own-convex` to deploy on their own Convex backend with no usage limits. By default, that setup still uses Critiqs Cloud's sign-in service; follow the extra sign-in setup in the [self-hosting guide](/docs/self-hosting) to run with no Critiqs service involved.

## Side-by-side comparison (checked November 24, 2026)

Pastel facts come from [usepastel.com/plans](https://usepastel.com/plans) and [usepastel.com/agents](https://usepastel.com/agents). Critiqs prices come from [critiqs.app/#pricing](/#pricing) (beta pricing active November 24, 2026).

| Dimension | Critiqs | Pastel |
| --- | --- | --- |
| Architecture | React 18/19 component (`<Critiqs />`) | Proxied URL canvas or file upload |
| Supported targets | React 18 and 19 web apps | Any URL, HTML/ZIP, images, PDFs, videos |
| Reviewer sign-in | Email plus one-time code | Guest name and email, no account |
| App state capture | Optional `getContext` and `restoreContext` | URL, screenshot, browser, viewport |
| Multi-environment list | One project ID across staging, preview, QA | One canvas per URL with version rounds |
| Visual proposals | AI Mockup mode (HTML/CSS copy, versions) | Inline copy editing on canvas |
| Coding agent MCP | `npx critiqs-react mcp`, Markdown/JSON export | `api.usepastel.com/mcp` and `@usepastel/cli` |
| PM integrations | Export and MCP | Trello, Asana, Jira, ClickUp, Monday, Zapier, webhooks (Team+) |
| Self-hosting | Free, MIT license, on your own Convex | Hosted cloud only |
| Free tier | $0: 1 project, 5 reviewers/mo, 500 comments/mo | $0: 1 user, 1 canvas, unlimited guests |
| Mid tier | Plus: $10/mo beta ($20 regular), 10 projects, 25 reviewers/mo | Pro: $35/mo ($29/mo yearly), 2 users, 3 canvases |
| Team tier | Pro: $50/mo beta ($100 regular), unlimited projects/reviewers | Team: $119/mo ($99/mo yearly), 5 users (+$24/user), unlimited canvases |
| Enterprise | Self-host free under MIT | $450/mo yearly ($5,400/yr), 10+ users, SSO, SOC 2 |

## When Pastel is the better choice

Choose Pastel if you:

- Review non-React sites (Webflow, WordPress, Shopify, static marketing pages) or cannot edit the site's code.
- Review PDFs, images, and videos alongside websites in one tool.
- Run an agency process that needs pause-commenting toggles, review deadlines with reminders, private team-only notes, and direct Jira, Asana, Trello, ClickUp, or Monday.com sync.

## When Critiqs is the better choice

Choose Critiqs if you:

- Build a React 18 or 19 app with dynamic tabs, modals, and customer records.
- Want staging, pull request previews, and QA builds sharing one thread list under one project ID.
- Want reviewers to try layout and styling changes in AI Mockup mode and pass structured diffs to developers or coding agents.
- Need MIT-licensed self-hosting on your own infrastructure.

## Frequently asked questions

### Can Critiqs review a website without installing the React package?

No. Critiqs requires installing `critiqs-react` and rendering `<Critiqs />` in a React 18 or 19 build. It is not a URL proxy. For no-install reviews on any URL, Pastel is built for that job.

### Does Pastel work with Claude Code and Cursor too?

Yes. Pastel runs a hosted MCP server (`https://api.usepastel.com/mcp`) and a CLI (`@usepastel/cli`) for Claude, Claude Code, Codex, and Cursor. The main difference is the source context: Pastel reads proxied canvas comments, while Critiqs reads in-app React threads with view state, `data-critiqs-id` anchors, and Mockup mode diffs.

### How does pricing compare for a five-person team?

Five team users on Pastel require the Team plan at $119/month billed monthly ($99/month yearly), which includes unlimited canvases, unlimited guest reviewers, and PM integrations. On Critiqs Cloud, Plus covers 10 projects and 25 monthly reviewers per project for $10/month at beta pricing ($20/month regular), and MIT self-hosting is $0.

### Will Critiqs appear for production visitors?

Only where you set a project ID. In Vite and Next.js apps, `npx critiqs-react init` adds `requireProjectId`, so a production build with no project ID renders nothing and contacts no server.
