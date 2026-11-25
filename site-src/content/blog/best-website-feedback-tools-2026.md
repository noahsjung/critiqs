---
title: Best website feedback tools for product teams in 2026
description: Compare six website feedback tools in 2026, including Critiqs, Pastel, BugHerd, Marker.io, MarkUp.io, and Vercel Toolbar, with verified pricing and MCP support.
date: 2026-11-24
tags: [comparison, tools, visual-feedback, staging-review, bugherd, marker]
---

The best website feedback tool depends on your stack and where feedback needs to live. URL proxies like Pastel and MarkUp.io work on any website with no code install, script widgets like BugHerd and Marker.io feed agency boards and issue trackers, Vercel Toolbar covers teams hosted on Vercel, and an in-app React component like Critiqs captures dynamic app state, runs AI page mockups, and self-hosts under the MIT license.

Matching architecture to workflow matters more than feature checklists. A proxy struggles when a comment belongs inside a hidden tab or a specific customer record, while a React package cannot help an agency reviewing a WordPress site. This guide compares six widely used tools using official pages checked on November 24, 2026.

## Four architectures for website feedback tools

1. **URL proxy tools (Pastel, MarkUp.io hosted).** Paste a URL and share a hosted review link. No code install, works on almost any site, less aware of hidden SPA state.
2. **Embedded script widgets (BugHerd, Marker.io).** Add a JavaScript snippet or browser extension on staging. Works on any web stack and captures technical browser details such as CSS selectors, console logs, or session replay.
3. **Platform toolbars (Vercel Toolbar).** Built into preview deployments on one host. Zero setup there, but tied to that host and its user accounts.
4. **In-app components (Critiqs).** Installed as a component inside your app. Scoped to its framework (React 18 and 19 for Critiqs), but able to read and restore app views, merge staging and preview threads under one project ID, and self-host.

## Quick comparison (checked November 24, 2026)

| Tool | How it runs | Permanent free tier | Starting paid price | MCP support | Self-host |
| --- | --- | --- | --- | --- | --- |
| Critiqs | React 18/19 component (`<Critiqs />`) | Yes (1 project, 5 reviewers/mo) | Plus $10/mo beta ($20 regular) | Yes (`npx critiqs-react mcp`) | Yes (MIT) |
| Pastel | URL proxy canvas or file upload | Yes (1 user, 1 canvas) | Pro $35/mo ($29/mo yearly) | Yes (`api.usepastel.com/mcp`) | No |
| BugHerd | JS snippet, extension, or WP plugin | No (free trial) | Standard $50/mo ($42/mo yearly) | Yes (`mcp.bugherd.com/mcp`) | No |
| Marker.io | JS snippet, npm SDK, or extension | No (15-day trial) | Starter $59/mo ($39/mo yearly) | Yes (Marker.io MCP) | No |
| MarkUp.io | URL proxy, extension, or SDK | No (14-day trial) | Pro $79/mo ($990/yr) | Not listed on pricing page | No |
| Vercel Toolbar | Built into Vercel previews | Hobby $0 (personal use) | Pro $20/mo per deploying seat | CLI JSON export | No |

## Critiqs: best for React product teams, stateful apps, and self-hosting

Critiqs is an MIT-licensed React package (`critiqs-react`) that adds `<Critiqs />` to staging, pull request preview, and QA builds. Product, design, QA, and clients open the build in a browser, sign in with an email address and a one-time code, and pin comments directly to elements.

Each thread saves an outlined element capture plus page, viewport, browser, and optional build version. Optional `getContext` and `restoreContext` callbacks let Critiqs reopen the exact tab, dialog, or customer record when a teammate opens the thread later. One [project ID](/docs/projects) links staging, preview, and QA builds into one thread list, and `requireProjectId` keeps production builds clean.

Critiqs also offers [Mockup mode](/docs/mockup-mode), where reviewers ask Critiqs AI for layout, spacing, color, or wording changes on a frozen HTML and CSS copy with saved versions and **Hold to compare**, plus an [MCP server](/docs/mcp) so Claude Code, Codex, and Cursor read threads, captures, and mockup diffs and reply marked "via coding agent".

**Pricing:** Free ($0: 1 project, 5 monthly reviewers, 500 monthly comments, 200 AI credits); Plus ($10/month beta, $20 regular: 10 projects, 25 reviewers/month); Pro ($50/month beta, $100 regular: unlimited projects and reviewers); Self-hosted ($0, MIT license on your own Convex deployment). See [Critiqs pricing](/#pricing).

**Limits:** React 18 and 19 apps only. Needs the component installed in your code, so it cannot review non-React sites, PDFs, or videos.

## Pastel: best for no-install reviews on any website or file

Pastel turns any pasted URL or uploaded HTML, ZIP, image, PDF, or video into a review canvas with unlimited guest reviewers. Guests enter a name and email with no account or extension. Pastel includes inline copy editing, responsive presets, feedback deadlines, and a toggle to pause commenting, plus an MCP server (`https://api.usepastel.com/mcp`) and CLI (`@usepastel/cli`) for AI coding agents.

**Pricing:** Free ($0, 1 user, 1 canvas); Pro ($35/month monthly, $29/month yearly, 2 users, 3 canvases); Team ($119/month monthly, $99/month yearly, 5 users, +$24 per extra user, unlimited canvases, webhooks, and Trello, Asana, Jira, ClickUp, Monday, and Zapier integrations); Enterprise ($450/month billed yearly, 10+ users, SAML SSO, SOC 2 report).

**Limits:** Hosted cloud only. Canvases track URLs rather than a shared cross-environment project ID, and proxy review does not restore hidden SPA tabs or dialogs. See [Critiqs vs Pastel](/blog/critiqs-vs-pastel) for a full comparison.

## BugHerd: best for agencies that want a built-in Kanban board

BugHerd maps pinned website comments onto a Kanban board (Backlog, Todo, Doing, Done, Archive). It installs via a JavaScript snippet, browser extension, or WordPress plugin and supports websites, Figma designs, PDFs, and images. Each task records a screenshot, CSS selector, URL, browser, OS, and resolution, with video feedback, suggested text edits, and BugHerd MCP (`https://mcp.bugherd.com/mcp`) included starting on Standard.

**Pricing:** No free plan (free trial available). Standard is $50/month ($42/month yearly) for 5 members and 10 GB storage. Studio is $80/month ($67/month yearly) for 10 members and 25 GB storage. Premium is $150/month ($125/month yearly) for 25 members, 50 GB storage, custom branding, private team comments, and Jira, Asana, Linear, ClickUp, and Monday.com integrations. Extra members cost $8/month ($6.60/month yearly). Client users and projects are unlimited.

**Limits:** Pins group by page URL. Single-page apps that switch views without changing the URL must set `window.BugHerdConfig.location` so pins do not mix across screens.

## Marker.io: best for QA bug reporting into Jira and Linear

Marker.io centers on a screenshot-annotation and bug-report form rather than persistent live pins. Reporters click the feedback widget, mark up a screenshot, submit a form, and discuss the ticket on a dedicated Issue Page synced with your tracker. Higher tiers add console logs, network requests, and session replay. Marker.io also offers Marker.io MCP, early-access AI rewrite and translation tools, and automated monitoring for 10 pages per plan.

**Pricing:** No free plan (15-day trial). Starter is $59/month ($39/month yearly) for 3 members with GitHub, GitLab, Linear, Trello, Asana, ClickUp, and Notion integrations. Team is $199/month ($149/month yearly) for 15 members and adds session replay, console and network logs, and Jira sync. Eligible agencies can apply for the Agency plan at $129/month ($99/month yearly) for 15 members and 50 client projects. Business is custom yearly pricing with SAML SSO and data masking. Reporters are unlimited and free.

**Limits:** Form-based issue reporting feels heavier than pin-based threads during fast copy and design reviews.

## MarkUp.io: best for high-volume creative teams across file types

MarkUp.io reviews websites, images, PDFs, and videos with unlimited users on every plan, priced by monthly MarkUp allowance. Teams paste a URL, install the Chrome extension (required for automatic screenshots on hosted website reviews), or integrate `@ceros-dev/markup-sdk` with an RSA key pair and allowed origins.

**Pricing:** No permanent free plan (14-day trial). Pro starts at $79/month ($990/year) for 50 to 100 MarkUps/month and 100 to 200 GB storage. Business starts at $499/month ($4,990/year) for 200 to 600 MarkUps/month, custom branding, vanity domains, and higher SDK limits. Enterprise is custom pricing. Extra MarkUps cost $4.00 each in batches of 10.

**Limits:** Starting at $79/month with no free tier is expensive for small product teams reviewing one or two web apps, and SDK setup requires key-pair management.

## Vercel Toolbar Comments: best if every reviewer uses Vercel

Vercel Toolbar turns on automatically on Vercel preview deployments. Team members pin comments or highlight text, link threads to Slack, and create GitHub or Jira issues.

**Pricing:** No separate fee beyond Vercel hosting. Hobby is $0/month for personal, non-commercial use. Pro is $20/month per deploying seat and includes free viewer seats for collaborators.

**Limits:** Every commenter needs a Vercel account, screenshots from the toolbar require the Vercel browser extension, and non-Vercel or local use requires `@vercel/toolbar` plus `vercel link`.

## How to pick the right tool

- **React product team reviewing staging, previews, and QA:** start with [Critiqs](/docs/install).
- **Non-React sites, PDFs, or no code access:** choose Pastel (or MarkUp.io for unlimited internal seats).
- **Agency Kanban bug tracking:** choose BugHerd.
- **Session replay and console logs into Jira:** choose Marker.io (Team or Agency).
- **All reviewers already on Vercel:** use Vercel Toolbar.

## Frequently asked questions

### Which website feedback tools have a permanent free plan in 2026?

Critiqs (1 project, 5 monthly reviewers, 500 monthly comments, plus free MIT self-hosting) and Pastel (1 user, 1 canvas, unlimited guest reviewers) offer permanent free tiers. Vercel Toolbar is free on Vercel Hobby for personal, non-commercial projects. BugHerd, Marker.io, and MarkUp.io offer time-limited trials.

### Which visual feedback tools include an MCP server for coding agents?

As of November 2026, Critiqs, Pastel, BugHerd, and Marker.io all provide MCP servers for coding agents like Claude Code and Cursor. Critiqs also exposes Mockup mode HTML and CSS diffs with `data-critiqs-id` references and marks replies "via coding agent".

### Why do URL-based tools struggle on React single-page apps?

URL-based proxies and scripts assume one URL equals one screen. In React apps, one URL often renders multiple tabs, modals, or records. Without app-provided view context, pins from one view can appear on the wrong screen or disappear when a dialog closes.

### Do reviewers need a browser extension to capture screenshots?

Not with Critiqs, Pastel, BugHerd (script install), or Marker.io (script or npm install). Hosted MarkUp.io website reviews and Vercel Toolbar both depend on a browser extension for automatic screenshots.
