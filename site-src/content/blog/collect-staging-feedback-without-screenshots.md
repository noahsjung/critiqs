---
title: How to collect feedback on a staging site without screenshots
description: Replace cropped screenshots and scattered Slack threads with on-page staging reviews that capture the element, view state, and build automatically.
date: 2026-11-24
tags: [staging-review, workflow, client-feedback, visual-feedback]
---

To collect feedback on a staging site without screenshots, put a commenting layer directly on your staging build so reviewers click the exact element they mean and leave a thread in place. The tool captures the screen, page, viewport, and build automatically, removing the back-and-forth questions about which customer, tab, or deployment a cropped screenshot came from.

Most teams still review staging builds by taking screenshots, pasting them into Slack or Teams, and writing paragraphs to explain where the bug sits. That process wastes engineering time on reconstruction and leaves half the feedback buried in chat history, emails, and spreadsheets. Here is how to replace it with an on-page review workflow that works for product managers, designers, QA, and clients.

## Why screenshot-based staging reviews break down

A cropped screenshot removes the exact details a developer needs to act on it. When someone posts an image in `#product-review` saying "the department label looks wrong here," three follow-up messages almost always follow:

- Which customer or test account were you signed in as?
- Which tab or modal was open?
- Was this on staging, a pull request preview, or yesterday's build?

By the time everyone answers, another thread has started in email, a QA tester has logged row 41 in a spreadsheet, and a stakeholder has sent a direct message during a demo. Even worse, a screenshot goes stale the moment a developer pushes a fix. Nobody knows whether the comment in chat still applies to the current staging build or was resolved two deploys ago.

## How to set up an on-page staging review workflow

Replacing screenshots takes four concrete decisions before you send out the next staging link.

### 1. Decide how reviewers reach staging

Keep staging behind your normal access boundary (VPN, basic auth, preview protection, or staging login) and avoid adding extra friction on top of it. Non-developers should not need Git, Node.js, a Jira seat, or a browser extension just to leave a comment on a button.

With [Critiqs](/docs/install), reviewers open the staging URL in any browser and sign in with their email address and a one-time code. Their first sign-in creates their account, and there is nothing to install. Because the company already controls who can reach the staging site, you do not have to maintain a second invitation list inside the feedback tool.

### 2. Turn comments on for staging and off for production

Never ship a review widget to real customers by accident. Tie activation to your deployment environment rather than `NODE_ENV`, because staging and preview builds usually run in production mode for realistic bundle and performance testing.

In a React app using Critiqs, running `npx critiqs-react init` wires `<Critiqs />` to a public environment variable (`VITE_CRITIQS_PROJECT_ID` in Vite or `NEXT_PUBLIC_CRITIQS_PROJECT_ID` in Next.js) with the `requireProjectId` prop:

```tsx
import { Critiqs } from "critiqs-react";

<Critiqs
	projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID}
	requireProjectId
/>
```

Set that variable in your staging, preview, and QA build settings, and leave it unset in production. Without a project ID, Critiqs renders nothing into the page and contacts no backend.

### 3. Capture view state, not only URLs

On a static marketing site, the URL tells you what the reviewer saw. On a modern web app, `/customers/harbor-logistics` might contain an Overview tab, a Team tab, a Billing tab, and three modal dialogs.

If your feedback tool only records the URL, reviewers still end up typing "go to the Team tab and open Edit Seat Limit" into every comment. In Critiqs, you can pass optional `version`, `getContext`, and `restoreContext` props to `<Critiqs />`. Every thread then stores the logical screen, active tab or dialog, record key, and build revision alongside its automatic DOM capture. Clicking a thread in the sidebar later asks your app to reopen that exact view and scrolls to the pinned element.

If a comment is about sensitive test data on screen, mark that container with `data-critiqs-mask` so captures cover it automatically.

### 4. Keep one feedback list across environments

Staging is rarely the only place people test a release. A designer checks a pull request preview on Tuesday, a QA engineer tests staging on Wednesday, and a product manager checks a QA build on Thursday.

If each URL creates a separate bucket of comments, feedback splits again. Pointing staging, pull request previews, and QA at the same [Critiqs project ID](/docs/projects) merges every thread into one sidebar list, tagged with the build where it was left. Mention and reply emails open one configured review address so links never point a teammate at a dead `localhost` port.

## Ground rules that keep a staging review focused

Tools remove capture friction, but clear review rules keep the thread list useful:

1. **Name what is in scope.** Tell reviewers before they open the link whether you want copy, layout, and bug checks or only functional sign-off.
2. **Use one channel.** Put every note on the page itself. If someone drops a staging bug in Slack, ask them to pin it on the build (or pin it once and link the thread) so status stays accurate.
3. **Tag threads for triage.** In Critiqs, reviewers can apply project tags (Bug, UX copy change, Design change request, User feedback) or write hashtags like `#wording` inline. Triage can then filter by tag or tag group.
4. **Show visual tweaks instead of writing paragraphs.** When a layout or wording comment is hard to explain in text, reviewers in [Mockup mode](/docs/mockup-mode) can describe the tweak to Critiqs AI on a frozen copy of the page and attach the versioned result straight to the feedback.
5. **Resolve only when verified on a build.** Keep thread statuses simple: Open while work is pending, Resolved once the fix is checked on the updated build. Personal unread state stays separate from shared status so reading a comment never hides it from the rest of the team.

## Turning staging threads into fixes

Once the review round wraps up, developers should not have to copy comments one by one into another document.

In Critiqs, you have two direct paths into implementation:

- **Export selected threads.** Pick the open threads for a task and export them as readable Markdown (for a pull request or issue description) or structured JSON, keeping every reply and context detail intact.
- **Hand threads to a coding agent.** Connect Claude Code, Codex, or Cursor to the [Critiqs MCP server](/docs/mcp) with `npx critiqs-react mcp`. The agent reads open threads, fetches captures, implements the fixes, and replies in the thread marked "via coding agent" so the original reviewer gets an email and can verify the next build.

## Frequently asked questions

### What happens if the UI changes after someone leaves a staging comment?

If Critiqs can still locate the element in the updated build, the pin follows it. If the element moved behind another tab or was removed in a redesign, the thread stays visible in the sidebar with its original capture, view context, and build version so nothing is lost.

### Do clients need a developer account or password to review a staging site?

No. With Critiqs, clients open the staging URL you share, click the toolbar, and sign in with their email address and a one-time code. They do not need GitHub access, a tracker account, a password, or a browser extension.

### Does collecting feedback on staging work for non-React websites?

The workflow principles (on-page pins, environment gating, one central channel, and tag-based triage) apply to any website. Critiqs itself is built specifically for React 18 and 19 apps. If your staging site runs on WordPress, Webflow, or another stack, tools like Pastel, BugHerd, or Marker.io cover non-React sites. See our [comparison of website feedback tools in 2026](/blog/best-website-feedback-tools-2026).

### How much does on-page staging review cost to start?

Critiqs Cloud has a [Free plan](/#pricing) covering 1 project, 5 monthly reviewers, 500 monthly comments, 200 AI credits, and 500 MB of captures. Teams that want feedback stored on their own infrastructure can self-host Critiqs for $0 under the MIT license.
