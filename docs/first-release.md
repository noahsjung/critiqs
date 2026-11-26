# First release and roadmap

Working scope: intended behavior. What the pilot implementation covers is in
[Implementation status](#implementation-status). Later directions have no
committed dates. See the [product brief](brief.md),
[technical direction](technical-direction.md), and [glossary](glossary.md).

## First-release scope

| ID | Intended behavior |
| --- | --- |
| F1 | Install a React package in a controlled host app by adding one component, with no other configuration. Before the project is set up, the sidebar shows project setup instead of comments. A toolbar at the bottom center switches between Browse mode, which allows normal interaction, and Comment mode, which lets reviewers select an element. |
| F2 | Identify reviewers through sign-in with an email address and a one-time code; no password and no outside sign-in provider. Anyone can register on first sign-in. Show authors' chosen display names and timestamps. Authors can edit their own comments and replies. |
| F3 | Share threads, replies, and simple reactions. Anyone with project access can resolve, reopen, or delete a thread. |
| F4 | Use Open, Resolved, and Deleted only. Resolved also serves as archive. Show open threads by default; a filter reveals resolved threads. |
| F5 | Keep read/unread personal. Opening a thread's content marks it read; new replies make it unread until viewed. Allow Mark unread. Seeing a pin or list entry alone does not mark it read. |
| F6 | Save the original image, context, and prototype version when supplied. If capture fails, explain the failure, save the comment anyway, and allow an attached screenshot. |
| F7 | Support shared feedback across matching records and feedback specific to one record. Never place a record-specific pin on a different record. |
| F8 | Keep threads the reviewer may see findable when targets are hidden, changed, or removed. Selecting a thread in the sidebar or its pin restores its view where supported and opens the thread window beside the pin, with the whole discussion and a reply box. Otherwise the window shows saved context beside the sidebar. |
| F9 | Provide a sidebar that always lists threads, with context groups, date sorting, and filters for unread, open/resolved, tags, and current screen/all screens. Keep threads from earlier versions. |
| F10 | Give every thread and reply a shareable link. After sign-in and access checks, open the requested message and restore its context where possible. Saved context is the fallback. |
| F11 | Support project tags, initially Bug, UX copy change, Design change request, and User feedback, and free hashtags written in comments, such as `#wording`. Typing `#` suggests the project's tags; draft and posted tags look distinct from each other and from mentions, and selecting a posted tag filters by it. Shared tag groups, such as Copy & wording, gather related tags for filtering. Collect selected threads and export readable Markdown and structured JSON. Preserve each discussion. |
| F12 | Store shared feedback in Critiqs Cloud by default, or in the team's own Convex deployment, with captures in private R2 or Convex file storage. Any signed-in reviewer using the prototype has project access and sees all of its feedback; the company guards access to the prototype itself. |
| F13 | Let reviewers mention people who have commented in the project, in a new comment, a reply, or an edit, and email the people mentioned with a link to the message. The email shows the thread's saved capture or attached screenshot and the whole discussion, so recipients understand it before opening it. Suggestions show names, not email addresses. Reviewers can mute or unsubscribe. |
| F14 | Offer Critiqs Cloud plans to organizations: Free, Plus, and Pro, with limits such as AI credits, projects, reviewers, or comments that can change without code changes, and payment by card through checkout. See [Plans and payment](#plans-and-payment). |
| F15 | Set up Critiqs Cloud or a team-owned Convex deployment with `critiqs init`, entering only the keys a service needs. An MCP server and agent instructions let coding agents do the same. |
| F16 | Group new tags automatically in the background, answer plain-language searches over a project's feedback with links to the threads found, and summarize them in insights that cite actual threads. A project uses Critiqs-managed AI or its own provider (OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI Gateway, or an OpenAI-compatible endpoint), set by its owner. Without AI, search matches words and tags and says so, and grouping is manual; commenting never depends on AI. |

## Installation and project setup

A developer adds the package and one Critiqs component to the prototype. Nothing
else is required: no sign-in provider, backend client, or style setup in the host app.
Critiqs Cloud provides the backend, sign-in, and email; teams that self-host enter
only the keys their services need (see
[ways to run Critiqs](technical-direction.md#ways-to-run-critiqs)).

When someone opens the prototype before its project is set up, the sidebar shows
project setup instead of comments. The agreed flow:

1. The developer adds the Critiqs component without a project ID, or runs
   `critiqs init`, which adds it where the app renders.
2. Opening the prototype shows project setup in the sidebar.
3. The developer signs in and names the project; Critiqs creates it.
4. Setup shows a one-line snippet containing the project ID, with a copy button.
   Alternatively, a `critiqs init` command writes the ID into the app's configuration.
5. Setup also remembers the new project in that browser, so the developer can
   comment immediately, before changing any code.
6. Once the ID is configured and deployed, every copy of the prototype with that
   ID (local, preview, and deployed) shows the same project's comments.

**Agreed:** each app and each deployment chooses its project. One repository
may be deployed from different branches or environments, with different
projects or none, and a monorepo may hold several apps, each with its own
project. In Vite and Next.js apps, `critiqs init` makes the component read the
app's public environment variable and sets it on the developer's computer;
each deployment sets its own in its build settings. With `requireProjectId`,
Critiqs appears only where a valid project ID is configured: a copy without one
adds nothing to the page, contacts no backend, and never uses a project
remembered in the browser, and a wrong or unreachable configuration is
reported to developers, not shown to visitors. A component without
`requireProjectId` keeps the browser setup above.

The project ID identifies the project; it is not a secret. Only the developer
setting up Critiqs handles it: reviewers such as product managers and designers sign
up and comment without ever seeing it. Critiqs does not identify
projects by the prototype's address, which differs between local, preview, and
deployed copies. For the same reason, mention emails open one page for every
copy: the project's review address, such as the deployed prototype. Setup asks
for it, optionally, and never saves the page setup runs on by itself; it warns
when an address opens only on one computer or private network, such as a
`localhost` or Tailscale (`.ts.net`) address, without refusing it. Only the
project's owners set or change it, in Project setup or with `critiqs init
--review-url`; a change applies to emails sent afterwards, not to links in
emails already sent. Project settings and usage are limited to project owners.
Billing belongs to the project's organization and is limited to its admins.

Teams that self-host on their own Convex deployment do that administrative work
once, with Critiqs's tooling; using Critiqs stays the same.

## Toolbar

A small floating toolbar at the bottom center of the prototype is Critiqs's main
control, similar to the Vercel Toolbar. It lets
reviewers:

- switch between Browse mode, Comment mode, and Mockup mode (the button says
  **Mockup**; signed out, it asks to sign in, as Comment mode does);
- show or hide the sidebar, with an unread indicator;
- sign in and out and see who they are signed in as;
- reach project setup while the project is not yet set up.

It stays out of the way of the prototype: reviewers can collapse or move it, and it
never covers a target being commented on. Keyboard shortcuts:

- **C** toggles Comment mode.
- **M** toggles Mockup mode, outside text fields.
- **V** returns to Browse mode, outside text fields. It cancels reattachment,
  and a new comment's text is kept: C brings it back beside its element.
- **Escape** closes the innermost thing: a menu or dialog, a new comment, a
  replacement being chosen, an open thread, then the side panel. In Mockup
  mode: a request on an element, then the panel, which reopens on the same
  thread. It never changes the mode; C, V and M do.
- **O**, held in Mockup mode, shows the live page instead of the copy, as
  **Hold to compare** does.
- **Ctrl or Cmd + `\`** (or `|`) hides all of Critiqs, even while typing, so the
  prototype can be used and seen without it; the same keys show it again, with
  drafts, open windows, and dialogs as they were. Hidden isn't kept across reloads.

Exact contents and styling remain open.

## Project access

In the first release, any signed-in reviewer using the prototype can see and take
part in all of its feedback. The company controls who can reach the prototype,
so reviewers need no invitation and join no member list. People sign up
themselves. Sign-in still identifies each author.

**Agreed (2026-11-23), not built:** projects belong to organizations. An
organization holds the people who build prototypes and pay for Critiqs Cloud,
not its reviewers:

- **Admins** manage billing, the plan, the organization's settings, and its
  members. They manage every project in it and get its alert emails.
- **Members** create projects and use them, and manage the projects they
  created.

Admins invite people by email. Accepting an invitation uses the same
email-code sign-in. Each person who already has projects gets their own
organization, which holds those projects and their current plan. Organizations
leave room for a verified company domain and an enterprise sign-in connection,
which come later.

## Comment placement

When selecting a component inside a record, the composer offers
**This component**, selected by default, and **Matching components**, with no
title above them. Each choice has its own information button on its right,
which explains it on hover, keyboard focus, or tap without changing the choice:
**This component** is feedback for the component here only, such as a button's
spacing or placement; **Matching components** is one shared discussion for the
same component wherever the app shows it for other records, such as that
button's label everywhere it appears. Matching pins open one discussion, and
scope does not change who can read it. The app identifies matches; visual
similarity alone does not make components match. Escape dismisses help before
the draft.

## Sidebar and hidden views

Use Figma's comment entries, avatars, threads, unread indicators, and resolve,
sort, and filter controls as the design reference. Exact styling remains open.
As in Figma, the sidebar always lists the threads, and a thread's discussion
opens in a small window beside its pin rather than replacing the list. Details
are in [technical direction](technical-direction.md#thread-window).

Use the [competitor references](brief.md) to guide in-scope interaction details:
click-to-comment, pins that open threads, replies and reactions, review controls,
and captured context. Reuse good patterns with similar or the same behavior,
while preserving Critiqs's access rules and dynamic-view handling.

The proposed groups are:

- **Current view:** threads with live targets in the active view.
- **Other views on this screen:** threads for another tab, closed dialog,
  different record, or unavailable target. Show the context and target status.
- **Other screens:** threads on another screen. Included by default; selecting
  the current screen narrows the list to this screen.

Groups change with the app's view; they are not thread statuses. Pins appear only
where a target can be located reliably. Hidden threads remain in the sidebar.

For example, selecting a thread from tab B asks the host app to select tab B and
open any required dialog, then scrolls to and highlights the element and opens the
thread window beside its pin. This needs the host app's cooperation. If
restoration fails, explain why and keep the window open beside the sidebar with
the saved image and context, or context details if no image exists.

**Agreed default:** open threads across all screens, including read and unread
threads, sorted by newest conversation activity within each group. Reading does
not change that order. Other date orders and unread-first sorting remain options.

A direct link opens a resolved thread despite the default filter. A deleted
thread's link reports it unavailable.

## Mockup mode

Beyond the first release's scope. During a review, the person sharing their
screen can show a proposed change without editing code. Mockup mode, the
toolbar's **Mockup** button, freezes the current page, as far down as it has
rendered, into a page copy that covers the prototype, so clicks no longer
navigate. The panel on the right, where Comment mode lists threads, has two
levels:

- **Mockup threads.** Every page's mockup threads in one list: this page's
  first, then each other page's, grouped by page. Each row shows its page and
  view state, its first message, who started it, its latest version, and when
  it last changed. **New thread** opens an empty thread over the page's
  copy: ask for a change to the page, select an element of the copy to ask
  about it, or add comments with **+ Add existing comment**. The thread is saved with
  its first message; going back before that saves nothing. A thread on this
  page opens directly;
  one on another page first asks "Go to *page*?" and has the prototype open
  that page, as Show in prototype does for a comment. Where the prototype
  can't open it, the thread still opens on its own copy, and says comparing
  with the live page isn't available.
- **A thread.** Its conversation with Critiqs AI, which answers and changes
  the thread's copy. Each Critiqs AI reply carries the version it made, to
  view or restore; restoring adds a version, which shows in the conversation
  with who restored what. While an earlier version is shown, the panel says
  so, with **Back to latest**. **Hold to compare**, or holding **O**, shows
  the live page beneath the copy, when the prototype shows the thread's page
  (and record). The AI works on the visible part of the page first, then
  continues below.

**Each thread is its own mockup**, a proposal for one page with its own page
copies and versions; threads never change each other's copies. A new mockup is
named after its thread's first message.

- **Copies.** The copy reflows when the window is resized, as the page's own
  stylesheets do. Where the app changes its layout in scripts instead, a copy
  can be taken at the current width, on the thread's own page; a thread with
  several copies shows them as width tabs, and its requests change all of
  them. A new copy starts from the live page, without earlier changes; asking
  again in the thread brings them to it.
- **Comments.** **+ Add existing comment**, above either message box, picks one of the
  project's comments, this page's first, searchable by text, up to 20 per
  mockup. Critiqs AI reads it with the thread, and it shows as a chip beside
  the button, where it can be removed. With comments added, a message needs no
  text: it is sent as "Make the changes these comments ask for." The comment's thread window offers **Open mockup**.

Mockups are saved as they change, and anyone in the project can open one and
continue it. Mockup threads stay out of the normal thread list, and a link to
one opens it in Mockup mode.

Coding agents read mockups to build them for real: `critiqs_mockups` lists a
project's mockups with their threads, and `critiqs_mockup` returns a version's
changes to each copy, with the original element each one changes, and the
threads behind them.

Mockup mode needs a Convex backend; elsewhere the toolbar leaves it out.
Critiqs AI's changes need the project's AI: without it, a mockup thread says
so, and the project's owner can connect it in AI settings. Details are in
[technical direction](technical-direction.md#mockup-mode).

## Plans and payment

**Agreed (2026-11-23), not built.** Critiqs Cloud has three plans. Each
organization has one, and its admins choose it and pay for it by card through
checkout. Self-hosted deployments have no plans.

| | Free | Plus, $20 a month | Pro, $100 a month |
| --- | --- | --- | --- |
| Critiqs AI credits a month, per organization | 200 | 2,000 | 10,000 |
| More credits | Refused | $1 per 100, up to the overage cap | $1 per 100, up to the overage cap |
| Overage cap at the start | None | 2,000 credits ($20) | 10,000 credits ($100) |
| Projects, per organization | 1 | 10 | No limit |
| Reviewers a month, per project | 5 | 25 | No limit |
| Comments a month, per project | 500 | 5,000 | No limit |
| Image storage, per organization | 500 MB | 10 GB | 100 GB, plus $10 a month for each extra 100 GB |
| Mention emails a day, per project | 100 | No limit | No limit |

- **Credits.** One credit is one cent of what the customer pays. A Critiqs AI
  request costs twice the provider's price for the tokens it used, rounded up
  to whole credits. The cost shown beside a model is an estimate.
- **Overage cap.** Admins can raise, lower, or remove it. They get an email
  when the plan's monthly credits run out and another when the cap is reached.
- **No limit** still sits under operational limits against abuse, such as the
  sign-in email limits.
- **Existing projects.** A Free organization that already has more projects
  than Free allows keeps them; only new projects are refused.

## Changes to the prototype

Keep the original image, context, and version when a new version is deployed.
A changed or removed element does not automatically resolve its thread.
Reattaching a thread to a replacement retains its original evidence. An old
version need not remain runnable for its feedback to remain readable.

## Later directions

- Restrict a project to reviewers with a verified email at the same company domain.
- Enterprise sign-in (SSO), such as Okta, as a Critiqs Cloud add-on through
  WorkOS, when a customer needs it.
- Additional storage, such as Postgres hosts including Supabase, if teams ask.
- Additional storage integrations, such as GitHub Issues/Discussions, sign-in
  integrations, project configuration, and tools to switch services.
- A browser extension and standalone URL-based review. Opening arbitrary sites
  requires a separate approach to browser access and embedding. Frameworks
  beyond React are in progress: a shared `critiqs` package with a package per
  framework, all released at one version
  ([what is released](releasing.md#what-is-released)).
- Scrollable historical page snapshots and element/source tracking to help
  locate threads after redesigns.
- Richer attachments and reactions; separate archiving only if needed.

Jira and Figma integrations are possibilities to validate, not scheduled scope.

## Pilot scenarios

Use a small React example to check first-time project setup; hidden tabs/dialogs;
shared and record-specific feedback; rows rendered only when scrolled into view;
removed targets; two reviewers' independent unread state; reply links; signed-out
access; capture failure; attempts to edit another author's text; and feedback
export. The [pilot app](../examples/pilot) supports each check: a header switch
simulates prototype version 2, which renames the department label, turns Revoke
access into a link, and removes the list's department column.

## Implementation status

Built in this repository and exercised against a local Convex deployment with
development sign-in. Not yet released: Critiqs Cloud's deployment exists but still runs an
earlier backend, which the component refuses until the current one is deployed,
and the npm package, approved for public release under the MIT license, is not
published yet. Local development shows sign-in codes in the sign-in window
instead of emailing them. Pilot data is
test data and will not be migrated. Choices the pilot
made for open questions are listed in [technical direction](technical-direction.md#open-choices).

| ID | Status |
| --- | --- |
| F1 | Built: one component, setup in the sidebar, Browse/Comment toolbar, in any React 18 or 19 app; its entry is a client component for server-component frameworks such as Next.js's App Router. The package (`critiqs-react`, MIT) has an ES module/declaration build and Node CLI and is ready to publish; not published. Vite and Next.js builds are checked. The pilot still names its local backend. |
| F2 | Built: email-code sign-in through Resend, registration with a chosen display name, permanent reviewer IDs, refresh rotation, and sign-in limits, all covered by local tests. Real email delivery through Critiqs's Resend account is untested until its domain is set up. |
| F3–F5 | Built: replies, reactions, author-only editing, shared status, personal read state, Mark unread. |
| F6 | Built: DOM capture with the target outlined, leaving out every mounted Critiqs, responsive and bounded to ten seconds on large design systems; failures, including an undrawable page or a view that changed while copying, save the comment and offer an attached screenshot. Convex deployments can store screenshot bytes in private R2, preserving metadata, access checks, and existing Convex captures. Live R2 verification awaits bucket access and deployment. |
| F7–F8 | Built: record-specific pins stay on their record; hidden threads stay listed with their status; views restore through the host, and Critiqs checks that the host reports the saved screen and view state before showing the target, never a matching element in another view; a thread opens in a window beside its pin, or beside the sidebar when its target can't be shown. Reattachment keeps original evidence. |
| F9 | Built: the sidebar always lists threads, with context groups, newest-activity order, and status, unread, tag, and screen filters. Indexed thread pages automatically load before filtering; older threads keep their version. Pagination is tested locally. |
| F10 | Built: links to threads and replies open after sign-in; discussion and reaction pages load without losing message IDs or personal read state. Deleted threads report unavailable. |
| F11 | Built: the four default tags plus free tags and hashtags, derived on the server from every new message, reply, and edit on Convex and SQLite; typing `#` opens suggestions, with inline draft highlighting and filled posted tags; shared tag groups organized by the project's owner, with Copy & wording as a starter group, and group filters. Existing feedback gains its hashtags through SQLite's migration or Convex's `tags:backfill`. Selected threads export as Markdown or JSON with full discussions loaded in bounded pages; a failed page blocks the entire export. Editing a project's preset tags is not built. |
| F12 | Built for any Convex deployment, and beyond the first release's scope, for self-hosting on SQLite inside the host app's server (`critiqs-react/server`). The component defaults to Critiqs Cloud's deployment, which still runs an earlier backend until the current one is deployed with approval; `critiqs init --own-convex` deploys to a team's own Convex. |
| F13 | Built: mention suggestions from project participants, highlighted mentions, mention emails through Resend with retries, mute and unsubscribe links, and the project's review address. Beyond the first release's scope, replies also email everyone in their thread (a setting turns this off), and coding agents can reply as the signed-in reviewer, marked "via coding agent". Emails embed the thread's capture as an inline attachment and show its whole discussion. Real inbox delivery, and how each mail client shows the inline image, are untested until Critiqs's sending domain is set up. |
| F14 | Built: configurable plans and limits, counted transactionally, with usage shown to project owners in setup. Agreed (2026-11-23), not built: organizations, the Free, Plus, and Pro plans, per-token Critiqs AI credits with an overage cap and alert emails, the storage add-on, and payment through Autumn on Stripe. |
| F15 | Built: `critiqs init` adds the component where a React, Next.js App Router, or Pages Router app renders, creates or reuses a project on Critiqs Cloud (the default, with no questions), an existing backend, or the team's own Convex, writes its settings, and reports readiness, including missing review addresses and ones that only open on one computer or private network; sign-in from another device with a setup code; `critiqs doctor`, which separates configuration from observed behavior; JSON output; the optional `critiqs mcp` server; and `AGENT_SETUP.md`. Beyond the first release's scope, coding agents read feedback with its context through `critiqs_comments`, `critiqs_thread`, and `critiqs_screenshot`, after the computer signs in once with `critiqs sign-in`. Tested against local backends and real Vite and Next.js builds; deploying with a real Convex deploy key, Critiqs Cloud sign-in, remote approval on Cloud, and the two-reviewer pilot over HTTPS are untested until Cloud runs the current backend. |
| F16 | Built: automatic grouping, natural-language search with cited insights and labeled basic search, owner AI settings with both connection modes, encrypted keys, an endpoint allowlist, and a connection test, on Convex and SQLite. Tested against local stand-ins for each provider's API; real providers' answers, and Critiqs-managed AI, are untested until an operator configures credentials. See [tags, tag groups, and AI](tags-and-ai.md). |
| Mockup mode | Built beyond the first release's scope, on Convex: one panel listing every page's mockup threads, each its own mockup with page copies at several widths and versions with restore, answered by Critiqs AI; opening another page's thread asks to go there; comments added with "+ Add existing comment"; Hold to compare. Tested against a local Convex deployment with a stand-in model; answers from real providers depend on the project's AI connection. |
