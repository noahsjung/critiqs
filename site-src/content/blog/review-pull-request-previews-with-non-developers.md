---
title: How to review a pull request preview with non-developers
description: Let product managers, designers, QA, and clients review pull request previews in a browser without Git, local builds, or GitHub accounts.
date: 2026-11-24
tags: [pull-request-previews, staging-review, collaboration, react]
---

To review a pull request preview with non-developers, deploy every branch to a shareable preview URL and add an on-page commenting layer that works in a normal browser with no Git setup or GitHub account. Product managers, designers, QA testers, and clients open the link, click the elements they want changed, and leave threaded feedback that developers can read right alongside the branch.

Pull request previews already exist on platforms like Vercel, Netlify, Cloudflare Pages, and custom CI pipelines, yet non-developers still get locked out of pre-merge review. Either they wait until the change hits staging, or they end up sending screenshots in Slack while engineers ask which commit they checked. Fixing that gap turns branch previews into the primary place product and design sign off before code merges.

## Why non-developers skip pull request reviews today

Asking a product manager, designer, or client to review a branch usually stalls on setup steps that have nothing to do with the UI:

- Getting repository access or a GitHub, Jira, or Linear seat.
- Installing Git and Node.js, cloning the repository, and running the app locally.
- Tracking down `.env` secrets from an engineer just to make login or sample data work.
- Learning how to leave comments on a GitHub diff when what they actually want to comment on is a button, table cell, or empty state.

When the preview URL itself is shareable, half the barrier disappears. The other half stays until reviewers can comment directly on the running page without installing an extension or switching back to a chat window.

## Step 1: give every pull request a working preview URL

Start by making sure your CI or hosting platform deploys a live URL for every open pull request and posts that link back on the PR. Two details prevent most "it does not work for me" messages from non-developers:

1. **Seed usable preview data.** A preview pointing at an empty database forces reviewers to create fake accounts and records before they can see the feature. Use seeded preview data or a demo persona switcher so reviewers land directly on realistic screens.
2. **Keep authentication lightweight for internal and client reviewers.** If your preview sits behind password protection or team SSO, verify that designers, PMs, and invited clients can actually open the link without hitting an admin wall.

## Step 2: mount commenting only on preview, staging, and QA builds

Next, give reviewers a way to leave notes directly on the preview page without risking anything showing up in production.

In a React 18 or 19 app, [Critiqs](/docs/install) handles this with one component (`<Critiqs />`) and two commands:

```sh
npm install critiqs-react
npx critiqs-react init
```

In Vite and Next.js apps, `init` configures `<Critiqs />` to read a public environment variable (`VITE_CRITIQS_PROJECT_ID` or `NEXT_PUBLIC_CRITIQS_PROJECT_ID`) and adds `requireProjectId`. You put that variable into your preview, staging, and QA build settings and leave it empty in production. Production builds add nothing to the page and make no network calls to Critiqs.

For reviewers, the checklist drops to one step: open the preview link in any browser. When they post their first comment, they sign in with their email address and a one-time code. No password, no browser extension, and no separate account provisioning are required.

## Step 3: connect preview, staging, and QA under one project ID

A common trap with branch previews is losing comments every time a pull request deploys a new URL or merges into staging. If a tool ties feedback strictly to a preview hostname, the comment a designer left on `pr-482.preview.example.com` disappears when QA checks `staging.example.com`.

Critiqs identifies feedback by project ID instead of hostname. When your pull request previews, staging environment, and QA build share the same [Critiqs project ID](/docs/projects), every thread lands in one list, tagged with the build it came from.

Set one stable review address with `npx critiqs-react init --review-url https://staging.example.com` (or in Project setup) so notification emails always open a reliable build instead of a dead local address. If you pass the optional `version` prop (for example, a commit SHA, pull request number, or release label), every thread records the exact build the reviewer saw.

## Step 4: make hidden tabs, dialogs, and records reproducible

Modern product work rarely sits on a static landing page. A pull request might change a modal inside a Settings tab, an error banner on a specific customer record, or a single column inside a scrolled table.

When you pass optional `getContext` and `restoreContext` callbacks to `<Critiqs />` and mark record containers with `data-critiqs-record`, `getContext` reports the logical screen, view state (such as the active tab or open dialog), and demo persona, while `data-critiqs-record` supplies the record key alongside an automatic capture of the screen with the target element outlined. When a developer opens that thread from the sidebar on their own preview or local dev server, Critiqs passes the saved screen, view state, and record key to `restoreContext` so the app can restore that view and open the discussion beside the pin.

Reviewers can also choose whether their note applies to **This component** (just this record) or **Matching components** (the same component across every record), so a pin about Harbor Logistics' billing row does not show up on another customer's page by mistake.

## Step 5: let non-developers show visual changes in Mockup mode

During pre-merge review, designers and PMs often spot small layout, copy, or visual hierarchy issues that take three paragraphs to describe: "spell out Ops as Operations, show seats as a progress bar, and make the Upgrade button a quieter outline style."

In Critiqs, reviewers can click **Mockup** in the toolbar to freeze the current preview page into a static HTML and CSS copy. They type the change in plain words (or attach existing comments with **+ Add existing comment**), and Critiqs AI updates the frozen copy without touching the live app or repository. Each iteration saves as a version in the thread, and **Hold to compare** (holding `O`) flashes the real preview underneath. Developers see the exact proposal before writing a line of code. See the [Mockup mode guide](/docs/mockup-mode) for how it works.

## Step 6: close the loop back to the pull request

Before merging, engineering needs a clear list of every unresolved thread on the branch.

- **Filter and export for the PR.** Open the Critiqs sidebar, filter to open threads or a specific tag (such as Bug or UX copy change), select the threads that belong to the pull request, and export them as Markdown or JSON.
- **Let a coding agent fix and reply on UI threads.** If you work with Claude Code, Codex, or Cursor, connect the [Critiqs MCP server](/docs/mcp) (`npx critiqs-react mcp`). Your agent reads the open threads, captures, and mockup diffs, applies the changes on your branch, and posts a reply marked "via coding agent" so the designer or PM gets notified by email to check the updated preview. Critiqs MCP does not include a resolve tool, so agents reply and humans resolve after checking the fix.
- **Verify on the next preview push.** Once CI deploys the updated commit, reviewers open the same preview link, check the fix, and resolve the thread. Unread indicators stay personal per reviewer, so one person reading a reply never hides it from the rest of the team.

## Frequently asked questions

### What if our team already uses Vercel Toolbar on preview deployments?

If everyone who reviews your previews already has a Vercel account, Vercel Toolbar is built straight into Vercel previews at no extra cost. Critiqs is useful when external clients, PMs, or stakeholders do not have Vercel accounts, when you host previews outside Vercel, when you need automatic captures without a browser extension, or when you want view-state restoration, AI Mockup mode, and MIT self-hosting.

### What happens to preview comments after a pull request merges?

Because Critiqs stores threads against the project ID rather than a temporary preview hostname, threads stay available in staging and QA builds that use the same project ID. Each thread keeps its original capture, view context, and build version even if an element changes or is removed later.

### Can non-developers accidentally break the staging or preview app?

No. Comment mode only places pins and captures evidence. Even in Mockup mode, Critiqs AI edits a frozen HTML and CSS copy in the browser with scripts removed; the live app and codebase stay untouched until a developer or coding agent implements the change.

### How many reviewers can test a pull request preview on Critiqs?

On Critiqs Cloud, the [Free plan](/#pricing) includes 5 monthly reviewers per project, Plus ($10/month beta, normally $20/month) includes 25 monthly reviewers per project, and Pro ($50/month beta, normally $100/month) has no limit on reviewers. Self-hosting under the MIT license also has no reviewer limits.
