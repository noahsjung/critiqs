# Technical direction

Initial stack choices with a proposed implementation approach. Product behavior
in [first-release scope](first-release.md) takes priority. Product terms are
defined in the [glossary](glossary.md). Choices marked **Proposed, built in the
pilot** are implemented in this repository but not yet agreed. Choices marked
**Proposed** are not built.

## Stack

| Technology | Role and status |
| --- | --- |
| React | Initial package and reviewer interface. The library is separate from the host app. |
| Bun | Selected development runtime and package manager for Critiqs: runs development tools and installs dependencies. |
| TypeScript | Language for the library and the code connecting its parts; used throughout the pilot implementation. |
| Convex | Selected backend for Critiqs Cloud, and for teams that run Critiqs on their own Convex deployment. Stores feedback and capture metadata (and optionally capture files), keeps the sidebar live, and runs scheduled work such as notification email. |
| Cloudflare R2 | Optional private screenshot storage for Convex deployments; Convex keeps access checks and image metadata. |
| Resend | Selected email delivery for Critiqs Cloud: sign-in codes and mention notifications. Self-hosted teams supply their own key. |
| SQLite | Selected backend for embedded self-hosting, inside the host app's own server (`critiqs-react/server`). Built after Critiqs Cloud. |
| AI SDK | Model calls for automatic tag grouping, search, and insights, with explicit provider instances (OpenAI, Anthropic, Google, OpenRouter through the OpenAI-compatible provider, Vercel AI Gateway, OpenAI-compatible). Runs only on servers: Convex Node actions and the self-hosted server. |
| WorkOS AuthKit | No longer used for sign-in. Agreed for later: enterprise sign-in (SSO) such as Okta, on Critiqs Cloud only, when a customer needs it ([Sign-in and organizations](#sign-in-and-organizations)). |
| Autumn | Agreed, not built: Critiqs Cloud's billing on Stripe. Holds the plans, prices, checkout, and the `ai_credits` meter. Unused elsewhere. |

Supabase and other Postgres hosts are not planned; they can be added later as
another backend if teams ask. Supported React/browser versions and routing
support remain open. The package builds browser ES modules and public
TypeScript declarations, with React and React DOM as peer dependencies.

## Ways to run Critiqs

**Agreed:** Critiqs offers two ways to run it. Both should take as few steps as
possible: install the package and, at most, enter the keys a service needs.

- **Critiqs Cloud** (paid convenience, with a free tier). Critiqs runs the backend,
  sign-in, and email. Teams install the package and set up a project; they
  configure no services. Plans differ by limits (see
  [Plans and limits](#plans-and-limits)).
- **Self-hosted** (open source). Teams run the same Critiqs server code on
  storage they control, with no Critiqs service involved:
  - **Team-owned Convex:** Critiqs's Convex functions deployed to the team's own
    Convex deployment. First release.
  - **Embedded SQLite:** Critiqs's server mounted in the host app's own
    long-running Node or Bun server, storing feedback in a SQLite file and
    captures on disk. Follows Critiqs Cloud.

Embedded SQLite needs a server process and a disk that survives restarts.
Static sites with no server, and serverless hosts with temporary file systems
such as Vercel and Netlify, cannot keep a SQLite file; they use Critiqs Cloud or
a team-owned Convex deployment. One SQLite file serves one server: an app running
on several machines would split its feedback and should use Convex instead. Every
copy of a prototype (local, preview, deployed) must reach the same backend so a
project keeps one set of feedback.

**Agreed:** Critiqs's code is released under the MIT license ([LICENSE](../LICENSE)),
so teams can embed and self-host it freely, and `critiqs-react` is published
publicly on npm.

**Agreed (2026-11-23), not built:** Critiqs Cloud sells hosting, reliability,
and administration. Its billing code lives in `packages/backend` and ships
publicly, so self-hosters receive it too. It does nothing unless a deployment
sets `CRITIQS_BILLING=autumn` and an Autumn secret key
([Plans and limits](#plans-and-limits)). This replaces the earlier proposal to
keep billing code separate from the open-source packages.

## Library and project services

Keep element location, context matching, thread data, and export logic independent
of React where practical. React supplies the interface and integration with the
host app's navigation and view state. Adapters are the code connecting Critiqs
to sign-in, shared feedback, and captured files. The framework-independent logic
lives in `@critiqs/core`, the server rules in `@critiqs/server`, the Convex
functions and sign-in service in `@critiqs/backend`, and the component and
`critiqs init` command in `critiqs-react` (provisional npm name).

**Proposed, built:** one set of server rules across backends, so Convex and
SQLite behave the same:

- **Shared server logic** (`@critiqs/server`): authorization, validation, and
  later plan limits, mention handling, and which notifications to send.
  Expressed as domain operations, such as listing a project's threads or
  appending a reply, over a small storage interface. Not a general database
  layer. The feedback functions (projects, threads, messages, reactions, read
  state, captures, export) are thin Convex wrappers: Convex checks argument
  shapes, then calls the shared operation. The sign-in rules (address checks,
  codes, digests, limits, names, and the sign-in email) are in the package
  too; the sign-in popup's attempt and session state stays in the Convex
  sign-in service.
- **Backend adapters:** Convex and SQLite implement that interface. Each
  adapter owns its transactions, indexes, file storage, and background jobs. A
  reply, its thread's new timestamp, and the author's read state save together.
  The SQLite adapter works with Bun's or Node's SQLite and serializes operations
  on one database.
- **Client transport (built):** the component talks to a Critiqs client interface rather
  than to Convex directly. The Convex transport keeps live updates; an HTTP
  transport for SQLite checks for changes every few seconds and right after the
  reviewer's own changes. The interface uses Critiqs's own types, not types
  generated by Convex.
- **Contract tests (built):** the same behavioral tests run against the Convex
  and SQLite adapters.
- **Name lengths (built):** a project's name has at most 200 characters,
  counted in UTF-16 code units after trimming, as a browser's `maxlength`
  counts them. 200 matches the onboarding name field. The limit keeps reads
  of many projects inside Convex's 16 MiB read limit: names near 1 MB made 19
  projects too much for one read. A display name chosen in Critiqs's sign-in
  has at most 60 characters. An organization's name has at most 80 when
  renamed, and a home organization created from now on is named within 80
  ("<name>'s organization", its name part cut and marked "…" when too long);
  existing organizations keep their names. A host app's own sign-in in embedded SQLite
  supplies its names unchanged; SQLite has no read limit.
- **Longer names from before the limit (built):** they keep their first 187
  code units, cut between characters, followed by "… " and 11 letters and
  digits computed from the whole name (`shortenProjectName`), so two long
  names that share their start stay different, and a shortened name never
  equals one that fits. SQLite's schema version 12 does this on start,
  finding names by their bytes, since SQLite's `length` stops at a NUL. On
  Convex, run `npx convex run projects:shortenLongNames` once after
  deploying; it pages through projects and can run again safely. Until it
  runs, those projects keep working with their whole names. SQLite reads the
  names a few at a time, in the database's own text encoding. `critiqs init`
  shortens a suggested name the same way and looks for a project by either
  form, so it finds the project before and after the backfill, and refuses a
  `--name` over 200 characters before creating anything. Until the backfill
  runs, very long names also fill setup's pages of projects, so someone with
  over a hundred such projects can reach setup's page limit and be asked to
  try again; the backfill ends this. **Not compatible:**
  an older `critiqs init` whose suggested name is over 200 characters can't
  create its project, and after the backfill can't find it; pass `--name`, or
  connect the project by its ID. This needs the owner's approval.

## Installation

**Agreed:** installing Critiqs is a drop-in. The host app adds the package and one
component; the component brings its own sign-in, backend connection, and styles,
isolated from the host app's (for example in a shadow DOM). It renders the toolbar,
sidebar, and pins above the host app. An unconfigured component shows project setup
in the sidebar. Optional properties, such as the
prototype version or functions to record and restore view state, add context.

**Proposed, built in the pilot:** `<Critiqs projectId backend version getContext
restoreContext />`. `getContext` reports the screen, view state, and demo persona;
without it the screen is the URL path. `restoreContext` receives the thread's
screen, view state, record key, scope, and an abort signal that fires when the
reviewer moves on; it may return `false` to decline, for example to protect
unsaved work, or a promise that settles once slower content has loaded.
Critiqs calls it unless `getContext` already reports the thread's screen and
view state, then waits up to three seconds for `getContext` to report them and
for the target to appear. Keys a thread lacks entirely, because it was saved
before the host reported them, are left to `restoreContext` once it has run;
keys it has, null included, must match. Hosts report each key whenever its part
of the app is shown, with null when nothing is open. Elements the app keeps in the page but hides, such
as inactive tabs, do not count as shown targets, and neither do matching
elements in another view. `backend` names a team's own Convex deployment;
Critiqs Cloud is not published yet, so the pilot passes its local deployment.
Elements marked `data-critiqs-mask` are covered in captures. Automatic captures
fail safely for a directly marked canvas, video or iframe, whose renderer
replacement loses that marker; mark a containing element to cover its region.
Automatic captures
copy each element's standard computed styles, not the custom properties design
systems define, and keep the page responsive while copying it. A capture fails,
and the comment saves with an offer to attach a screenshot, when it runs past
ten seconds, when the copied page can't be drawn, or when `getContext` reports
another screen or view state once copying ends.

**Agreed:** setup binds the project to the prototype through a project ID in the
host app's configuration, copied from setup or written by a `critiqs init` command.
Until the ID is configured, the component keeps the newly created project in browser
storage for the person who set it up.
**Agreed, built:** in Vite and Next.js apps the configuration is the app's
public environment variable (`VITE_CRITIQS_PROJECT_ID`,
`NEXT_PUBLIC_CRITIQS_PROJECT_ID`, or a name with the app's suffix in a
workspace), read by the host integration that `critiqs init` writes; the
package itself never reads framework variables. `requireProjectId` turns the
browser-storage fallback off and keeps Critiqs off the page until a valid ID is
configured, so each deployment and each app chooses its own project. These
values are built into the app, so a build promoted unchanged across
environments passes its runtime configuration to `projectId` instead. Comparable products that install inside the
app (Vercel Toolbar, Liveblocks, Marker.io, BugHerd) also use a project ID; see
competitor research. Only the developer setting up
Critiqs handles the ID; reviewers such as product managers and designers never see
or enter it.

**Agreed, built:** setup is equally simple for people and coding agents. The
CLI, the MCP server, and the agent instructions ship in `critiqs-react`; run the
CLI with `npx critiqs-react` (the package's one command, `critiqs`). The
command line is enough; the MCP server is optional.

**Proposed, built:** the component works in any React 18 or 19 app. Its
browser entry starts with `"use client"`, so frameworks with React Server
Components, such as Next.js's App Router, render it as a client component
while the layout that imports it stays on the server; other apps ignore the
directive. It renders nothing on the server. Real Vite (React 18 and 19) and
Next.js (App Router and Pages Router) builds are checked by
`bun run check:consumers`.

- `critiqs init` uses Critiqs Cloud unless told otherwise, and names the
  project after the app's package unless `--name` is given, so the main path
  asks nothing. When the code has no `<Critiqs />`, it adds the component and
  its import where the app renders: inside a React root's `render` call
  (`createRoot`, `ReactDOM.render`, `hydrateRoot`), inside `<body>` in a
  Next.js root layout, or beside `<Component>` in a Next.js custom App, or
  beside an element named with `--entry <file> --mount <Element>`. It edits
  one file, planned in full before anything is created; it refuses, with a
  preview or the line to add by hand, when there are several roots, when
  Critiqs is already used under another name, or when the name clashes.
  It then signs the developer in, creates the project, and writes its ID.
  Sign-in uses Critiqs's usual sign-in window, opened from a page the command
  serves on this computer; the command's session ends once the project exists.
- Setup is safe to repeat. A project the code already names is kept (unless
  `--new-project`); after sign-in, the developer's own project with the same
  name is reused rather than duplicated, so a retry after an interrupted run
  creates nothing new. `--review-url` sets the review address of a project
  the code names, after sign-in, only for its owner; nothing else changes it.
- Init ends with readiness in stages: the code, the project, trying it
  locally, and reviewers elsewhere, which warns about a missing review address
  or one that only opens on one computer or private network, such as a
  Tailscale (`.ts.net`) address.
- `critiqs init --remote` signs in from another device (below), and is chosen
  automatically over SSH or without a desktop when the sign-in service offers
  it. `--json` prints init's and doctor's results for scripts and agents.
- For the team's own Convex, init deploys Critiqs's functions, which the package
  carries with the shared server rules bundled in, and also writes `backend`.
  It asks only for a production deploy key (`CONVEX_DEPLOY_KEY`), plus a Resend
  key and sender if the team wants mention emails. Keys go to Convex through
  standard input, never command arguments. The deployment trusts Critiqs Cloud's
  sign-in. A self-hosted Convex backend works too, through
  `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`.
- `critiqs init <projectId>` writes an existing project's ID.
- `critiqs doctor` checks that the setup works, not only that it connects. It
  checks the component and its settings, the backend's and sign-in service's
  versions, the project and its review address, sign-in, and email. It also
  flags mention emails left waiting, which means scheduled sending isn't
  running, and a last email that failed. Each backend reports this at
  `/critiqs/health`, which reveals no feedback and no address, only whether a
  review address exists and whether it is local or private, and nothing about a
  project limited to its organization, which doctor then says it can't check.
  Each check names its
  stage and whether it read configuration or something the backend observed;
  doctor sends no email, uploads no screenshot, and posts no comment, and
  reports optional features that are off, such as AI, as information.
- `critiqs mcp` is an MCP server with the same steps as tools
  (`critiqs_setup_start`, `critiqs_setup_finish`, `critiqs_write_project_id`,
  `critiqs_doctor`), including remote approval and structured results. Keys
  come from its environment, never from tool arguments. `AGENT_SETUP.md` in
  the package tells coding agents each step, using the command line first.

## Hosting and access

**Agreed:** projects use Critiqs Cloud by default; a team may instead self-host.
Connecting a team-owned Convex deployment requires Critiqs's server functions, not
just a service URL.

**Agreed:** anyone can register. By default, any signed-in reviewer using the
prototype can see and take part in its feedback. Reviewers need no invitation
and join no member list. The prototype carries the project ID, which is not a
secret: someone who signs in and obtains the ID can read its feedback without
opening the prototype. The company guards access to the prototype. Project
settings and usage are limited to project owners. Projects belong to
organizations, and billing is limited to an organization's admins
([Sign-in and organizations](#sign-in-and-organizations)). Restricting a
project to a verified company email domain, and enterprise sign-in such as
Okta, come later.

**Built (2026-11-25):** who can review. Each project has a review access
setting (`reviewAccess`, labeled **Who can review** in Project setup), which
only its owners change (`setReviewAccess`):

| Setting | What the project ID grants someone signed in |
| --- | --- |
| `anyone` (the default, and every existing project) | Everything a reviewer does: reading and exporting threads, search, downloading captures and page copies, mockups and Critiqs AI, listing participants, commenting, replying, reacting, resolving, tagging. |
| `organization` | Nothing, unless they are a member of the project's organization. People with a pending invite join when they sign in, so they get access then. |

- **One check.** `requireProject` in `@critiqs/server` checks the setting
  (`canReview`) for every operation on a project, on both the Convex backend
  and the self-hosted server. `requireThread` and `requireMessage` resolve a
  thread or message to its project and pass through it, and Convex's page
  copies, mockups, and captures (served over HTTP) resolve to their project
  the same way, so no direct ID reaches a resource around the check. Someone
  refused gets `forbidden`: "This project is limited to members of its
  organization." A deleted thread is reported deleted only to those who may
  review the project.
- **Emails and mentions.** People who can't review a project aren't suggested
  for mentions and aren't emailed about it, including emails owed before it
  was limited.
- **Reported.** Projects carry `reviewAccess`, and `/critiqs/config` reports
  `reviewAccess: true`. A component from before the setting never shows the
  row; one that meets a backend without it sees no `reviewAccess` and shows
  none either.
- **Stored.** Convex: an optional field, absent meaning `anyone`. SQLite:
  `review_access`, added by migration 14 with default `'anyone'`.
- **Access that ends mid-way.** Work that runs across several transactions
  checks access again where it would hand data on, not only when it starts:
  - The email worker checks that the recipient may still review the project
    while it reads each page of the discussion, before it reads the capture,
    and right before it gives every kind of email (new, prepared, or legacy)
    to the mail service (`deliveryAllowed`). A refused delivery is skipped,
    which discards its prepared email.
  - Search (`authorizeSearch`) and a mockup turn (`recheckMockupTurn`) check
    at provider dispatch: a request carries the check as `beforeSend`, and
    the AI SDK's fetch runs it before each attempt it sends, retries
    included, so the check also follows any wait for a credit hold. A refusal
    sends nothing more, releases the hold, and ends the work
    (`accessCheck`), instead of becoming a notice.
  - A project's connection test, of its saved settings or a draft, checks the
    same way before it sends, and again before it returns any result; it
    records a result only if the person testing still manages the project. A
    project's model list is returned only to someone who still manages it
    (`recheckAiManager`).
  - An upload is checked again where it is saved: in the SQLite transaction
    that stores the image, and when an R2 or Convex upload is finished. A
    refused R2 object stays `uploading` until cleanup deletes it; a refused
    Convex file is deleted at once.
  - A Convex download (`/capture`, `/mockup/snapshot`) checks access before
    it fetches the file and again once storage has answered, right before it
    returns the response, and returns the file only if the thread or copy
    still uses it. Access that ended, or a thread deleted, while storage
    answered returns nothing.
- **Health.** `/critiqs/health` keeps the deployment's own diagnostics
  public, but for a project limited to its organization it reports the
  project (`found`, its review address) only to a member who sends their
  sign-in with the request. Anyone else gets nothing about that project, so
  `critiqs doctor`, which doesn't sign in, says it can't check such a project
  rather than failing. An ID that matches no project still reports `missing`,
  so the absence of `project` does tell someone holding a real ID that it
  exists; nothing else about it is told.

**Built (2026-11-25):** who may change what. Anyone who may review a project
resolves and reopens threads (F3), tags and reattaches them, attaches a
screenshot where capture failed, and reads and changes mockups. Only a
thread's author or the project's owners delete it; only a message's author
edits it, and Critiqs AI's messages can't be edited; only a mockup's creator
or the project's owners delete the mockup; only the project's owners
organize tag groups and change the project's settings. Reactions, read
state, and notification choices are each person's own.

- Only a mockup's creator starts its thread, whoever else may review or
  manage the project; once that thread is deleted, the next is still theirs.
  Someone else starting it would own the proposal and could keep its creator
  from deleting the mockup. The older mockup list (`mockups.list`) still
  shows mockups without a thread.
- Deleting a mockup deletes its threads, so the thread rule applies to each
  of them first: a creator who doesn't manage the project can't delete a
  mockup whose thread someone else started, as threads from before the rule
  above can be, and nothing is removed. The thread's author or the project's
  owners delete that thread first.
- Linking a thread to a mockup checks the thread against the mockup's
  project before anything else, so a thread in another project, deleted,
  limited to its organization, or not there at all, gets the same refusal.
- A thread reports `canDelete` to the person reading it, and the thread
  window offers **Delete thread** only when it is true. Older backends don't
  report it, and the window offers it as before. The window closes only once
  the deletion succeeds, so a refusal shows beside the thread.

**Built (2026-11-25):** thread pages. Each thread can have a page on
Critiqs's website with its capture, discussion, reply box, and **Open in
prototype**, so a shared link works on phones and for people without the
extension. The backend serves it on Convex and the self-hosted server, and
the website (`apps/web`) shows it at `/t/<key>` for Convex.

- **Who may open one.** Someone signed in, with a verified address, who may
  review the project (`canReview`, so **Who can review** applies first) and
  who either belongs to the project's organization or is already in the
  thread: started it, replied in it, or was mentioned in it
  (`canOpenThreadPage`). Who is in a thread comes from its followers, the
  record reply emails keep, in one indexed read: the check never reads the
  discussion, which can be more than one Convex transaction may read. For a
  thread from before that record, sharing it queues the email worker's scan
  of its discussion, a page per step, emailing no one; until it finishes
  (within a minute or so), only whoever started it, and the organization's
  members, get in. In a project limited to its organization, someone in the
  thread who leaves the organization is refused.
- **One answer.** Anyone else, signed in or not, gets `not-found`: "This
  thread doesn't exist, or you can't open it.", the same as for a key that
  opens nothing. A deleted thread is reported deleted only to those who could
  open its page.
- **Its link carries a page key, never the thread ID.** `threadPageLink` in
  `@critiqs/core` builds `<website>/t/<key>` from the website's configured
  address. A key is 128 random bits (22 base64url characters), stored on the
  thread (`pageKey`, unique). A thread ID can't go in a link that may be
  forwarded: in a project anyone may review, an ID alone lets components from
  0.3.x and earlier read the thread and its project ID (`threads:get`), its
  capture, and reply. New threads get a key; an older thread gets one the
  first time someone shares it (`threads:pageKey`, `threadPageKey`), which
  anyone who may review the thread may do, or the first time it is emailed
  (below). The key opens only the page, so it grants nothing the rule above
  doesn't.
- **Where links go.** On a Convex deployment with `CRITIQS_WEB_URL` set,
  mention and reply emails, and **Copy link** in the thread window, link to
  the thread's page there instead of the prototype. `/critiqs/config`
  reports that address as `website`, beside `threadPages`. Without it (a
  team's own deployment unless it sets one, and every self-hosted server,
  whose `webUrl` is only for setup emails), they link to the prototype as
  before.
  - **Emails.** The email's one link, **Open the comment**, opens the page,
    and comments carry no links of their own, since the page shows the whole
    thread. An email whose thread is older than thread pages first makes its
    key, in a step of its own (`makeDeliveryPageKey`, one thread per
    transaction), which queues the scan of who is in the thread as **Share**
    does. The email links to the page only once its recipient can open it
    (`canOpenThreadPage`): the people emailed are in the thread (mentioned, or
    followers, which reply emails need), but in a thread from before people
    in threads were recorded, they get in only once that scan has run (the
    worker runs it, a page of the discussion per step, before each run's
    emails, within minutes), so the email waits for it: it goes back in line
    at once and is tried again a minute later (`deferred`), and waiting uses
    none of its attempts at the mail service. Past an hour from when it was
    first owed, something has stopped the scan, so the email stops waiting.
    Anyone the page still wouldn't let in then, or once the thread's people
    are recorded, gets the prototype's link, as before, rather than a link
    that wouldn't open. An email already prepared is sent unchanged under its key,
    as every retry is, since the mail service may have received it.
  - **Only an origin.** The website serves pages at `/t/<key>` on its own
    origin, so a `CRITIQS_WEB_URL` with a path (such as
    `https://critiqs.example/reviews`) turns no page links on; setup emails
    still use it as before.
  - **Copy link.** The thread window asks for the key (`threads:pageKey`) and
    copies `<website>/t/<key>`. It hands the clipboard the link while it is
    still on its way, so browsers that copy only during the click, such as
    Safari, still copy it. A refused key says why and copies nothing; a
    browser that refuses to copy gets the link shown instead of "copied". **Copy link to message** still opens the prototype
    at that message, since a page shows the whole thread. The Chrome
    extension's panel is the same panel, so it follows.
- **Keeping keys out of logs.** A key opens the page for anyone the page lets
  in, so it shouldn't sit in records many people can read.
  - The website asks for the page's image with the key in a header
    (`X-Critiqs-Thread-Page` on `/capture`), not the address, which request
    logs record; both backends still accept `?threadPage=<key>`. A backend
    from before the header answers it `400 Missing threadId`, and its CORS
    answer doesn't allow the header, so deploy the backend before the
    website.
  - The website's HTML sets `<meta name="referrer" content="strict-origin">`,
    so its own requests, such as for its scripts, carry only its origin, never
    `/t/<key>`.
  - The website app logs no addresses, and `threads:page` and replies pass the
    key as a function argument, which Convex doesn't log.
  - The page's own request, `GET /t/<key>`, still reaches the website's host,
    and no code can keep it out of that host's request log. Where the website
    is hosted on Vercel: send no log drain from the website's project, or
    filter `/t/` paths out of it at the destination; keep its log retention
    at the plan's default; don't turn on Web Analytics or Speed Insights for
    it, which record page paths, unless their `beforeSend` replaces
    `/t/<key>` with `/t`; and let only the people who run it see its logs.
    Keeping the key out of the request entirely would mean a link that holds
    it after `#`, a change to `threadPageLink` that is not made.
- **Reading.** `threads:page` (Convex, paginated like `threads:get`) and the
  self-hosted `threadPage` call return the thread as `threads:get` does, plus
  the project's name, its review address, and the anchor's page and screen
  for **Open in prototype** (`ThreadPageDetail`). The image downloads from
  `/capture` with the key in the `X-Critiqs-Thread-Page` header (or
  `?threadPage=<key>`), checked like the page before storage is read and
  again once it has answered, as `/capture?threadId=` is.
- **Replying.** From the page, replies go through `threads:reply` (`reply`)
  with `threadPage: true`, which applies the page's rule instead of the
  project's, and gives someone signed out the page's one answer; without it,
  the installed component's replies keep the project's rule.
- **Records nothing.** Opening a thread page writes no read state and adds no
  one to the thread or project. It never counts as opening the project for
  the extension's address lookup: no thread page operation may record an
  opened project.
- **Reported.** `/critiqs/config` reports `threadPages: true`. Convex: an
  optional `pageKey` with the `by_page_key` index. SQLite: `page_key`, added
  by migration 15 with a unique index.
- **The website's page** (`apps/web/src/ui/ThreadPage.tsx`). Signed out, it
  asks the person to sign in, with the website's usual sign-in. Signed in, it
  first runs `users:sync`, as the installed panel does, which accepts the
  invitations sent to the person's address, so someone just invited to the
  project's organization gets in; the page's own reads stay read-only. Then
  `not-found`, `forbidden`, and a key of the wrong form (never sent) show one
  page, "This comment isn't available", which says to sign in with another
  address or ask to be added, and never whether the thread exists. A deleted
  thread says so, as the backend tells only those who could open it.
  Otherwise it shows the capture (through `/capture`, key in a header), the
  discussion live, with names, times, mentions, and hashtags as the panel
  draws them (its `MessageBody`, `Avatar`, and time format, imported from
  `packages/react/src` as the rest of `apps/web` is), the thread's tags, its
  resolved state, a reply box (`threadPage: true`), and **Copy link**, which
  copies the page's own address. The reply box is a plain text box: hashtags
  tag the thread as usual, but `@` doesn't suggest people, since the panel's
  suggestions list everyone in the project, and the page shows only the
  thread. The browser tab's title names no project, since browsers keep
  titles in history.
- **Open in prototype.** It opens the page the thread was left on at the
  project's review address (`buildLink`: the review address's origin, the
  saved page's path), with `?critiqs=<threadId>` so installed Critiqs opens
  the thread there, in a new tab without a referrer. Only someone who may
  open the page sees it, and the ID gives a prototype link nothing beyond
  the prototype itself: in a project anyone may review, the prototype
  carries the project ID, which already opens its threads; limited to its
  organization, `requireThread` refuses outsiders. A saved page address that
  can't be read opens the review address itself, as email links do. Without
  a review address it isn't offered, and the page says the comment was left on its saved
  address.
- **Where pages are served.** A page link names no deployment, so the website
  at the configured address must reach the backend that holds the thread.
  Critiqs Cloud's website serves Critiqs Cloud's threads. Not decided yet:
  team-owned Convex deployments (their own page host, or a deployment named
  in the link), and the self-hosted server, whose API accepts only its own
  site's requests, so its pages must come from that server itself, with
  `threadPageLink` given that server's address.
- **Still open: thread IDs elsewhere.** In a project anyone may review,
  `threads:get` and the other thread operations still accept a thread ID
  alone, because released components (0.3.x) send nothing else. A thread ID
  in a copied prototype link (`?critiqs=`) or today's email links still
  reaches the thread and its project ID that way. Closing it means those
  operations also require the project ID, which breaks released components
  for reviewers who are neither members nor in the thread; that needs the
  owner's decision and a deprecation policy.

**Agreed:** reviewers sign in with their email address and a one-time code
Critiqs sends them; there is no password. Registration happens on first sign-in.
A verified email proves control of that address, not a person's name or role.

| Way to run | Sign-in | Email delivery |
| --- | --- | --- |
| Critiqs Cloud | Email code from Critiqs, in Critiqs's sign-in popup | Critiqs's Resend account |
| Team-owned Convex | Email code, or the host app's own sign-in | The team's Resend key |
| Embedded SQLite | Email code, or the host app's own sign-in | The team's Resend key |
| Local development | Email code shown in the sign-in window, only on the developer's own computer | None |

Using the host app's sign-in needs no email service: the host's server tells
Critiqs who the reviewer is. Mention notifications still need a verified email
address and an email key.

**Proposed, built:** sign-in details. The rules (address checks, codes, keyed
digests, send limits, names, and the email itself) live in `@critiqs/server`, so a
self-hosted server can reuse them; the popup's attempt state is in the Convex
sign-in service.

- **Codes, not links.** Six digits from a cryptographic source, entered in the
  popup that requested them, valid for 10 minutes and once. Email security
  scanners can open sign-in links and use them up; a code can be read on another
  device. Links can come later.
- **Abuse limits.** Five wrong guesses per sign-in window, across every code it
  sends; then the window is locked. A window sends at most three codes; an
  address receives at most five codes in 15 minutes across windows; the
  deployment sends at most 300 an hour. Requesting a new code cancels the old one
  without resetting the guess limit. Convex HTTP actions see no trusted client
  address, so there is no per-network-address limit.
- **No account discovery.** The code page reads the same whether or not the
  address has signed in before. A new reviewer chooses a display name only after
  their code matches.
- **Stored safely.** Only a keyed HMAC digest of each code is stored, bound to
  its attempt, address, and send. The key derives from the signing key, so
  deployments need no extra secret.
- **Email.** Sent through Resend with `RESEND_API_KEY` and `CRITIQS_EMAIL_FROM`;
  the message names the site asking. A send that fails is reported in the
  window and shows no code.
- **Stable reviewer IDs.** Each reviewer gets a permanent Critiqs ID, independent of
  the sign-in method, so changing sign-in methods never splits authorship, read
  state, or owned projects. Built: the sign-in service links each verified email
  to one ID, which tokens carry as their subject. Proposed: host-app identities
  link to the same kind of ID.
- **Profile versions (built).** Tokens carry the version of the reviewer's
  profile, which each rename increases. A deployment ignores names from tokens
  with an older version, or with none once it has recorded one, so an older
  session cannot put back a previous name.
- **Display names (built).** Reviewers choose a display name at registration and
  can change it from the account menu. Critiqs does not fall back to showing
  their email address.

**Proposed, built in the pilot:** Critiqs Cloud's sign-in service runs as HTTP
routes on Critiqs's Convex deployment. Because Critiqs runs inside host apps on
domains it does not control, it signs in through its own popup and issues its own
tokens, avoiding the host's domain and third-party cookies.

- **Popup.** A cookie binds each popup to the browser that started it, so a
  forwarded window or a leaked attempt key cannot finish elsewhere. The consent
  page carries its own token. The component accepts tokens only from the popup
  it opened.
- **Consent.** The first sign-in from a new site asks the reviewer to allow it,
  so another site cannot embed the component to obtain their access. Critiqs's
  own panel origins (below) are never asked and record no site grant.
- **Tokens.** After verification and consent, Critiqs issues a 15-minute ES256
  token with the reviewer's verified email and the allowed site. The popup
  posts it only to that site.
- **Refresh.** A refresh token, stored hashed, works only from the same site,
  for 30 days from its last use and never more than 90 days after sign-in. Every successful refresh replaces it atomically;
  expired or wrong-site tokens cannot refresh the session. The client
  chooses the replacement (32 random bytes, base64url) and saves it before
  sending it as `nextRefreshToken`; older clients send none and the service
  chooses. The service remembers each replaced token until its session's
  absolute end (90 days after sign-in at most). Sending a replaced token again together with
  the replacement it was switched to, before the replacement is used, repeats
  the refresh without replacing anything (it renews the session like any
  refresh): so a refresh whose answer was lost (the page closed, the network
  dropped, the process stopped) finishes on the next try, as long as the
  session hasn't expired meanwhile (30 days unused). Any other use of a replaced token means
  someone else holds it, and the session ends. Signing out with a replaced
  token ends its session too, and clients sign out both the saved token and a
  saved replacement, so a sign-out that crosses a refresh still ends the
  session. A client cleaning up after a refresh answered late signs out with
  `onlyIfCurrent`, which ends a session only by its current token, so it
  can't end a session another tab has renewed since. The component also builds its Convex client
  with `initialAuthTokenReuse`, so a page load uses a still-valid access token
  instead of refreshing at once. The component serializes same-site refreshes with
  Web Locks, or an atomic IndexedDB claim for each refresh token. A claim
  is taken over after 30 seconds only when the saved replacement is there,
  since sending that saved pair again is safe from any tab; otherwise other
  tabs preserve their stored session for a later retry. An in-flight refresh
  that completes after sign-out revokes its replacement while it is current.
- **Start limits.** Transactional one-minute counters allow 20 popup sign-in
  starts per requesting origin, Critiqs's own included, and 200 starts of any
  kind across the deployment; panel starts count differently (see **Panel
  start limits** below). Rejected starts return HTTP 429 and `Retry-After`,
  create no attempt, and do not trust client-supplied IP headers. Scheduled
  cleanup removes expired counters in bounded batches.
- **Trust.** Every deployment trusts `CRITIQS_AUTH_ISSUER`, the sign-in
  service's address. Critiqs Cloud names itself; team-owned Convex deployments
  either name Critiqs Cloud's issuer or run their own sign-in.
- **Allowed sites.** Sites must use HTTPS unless they run on the reviewer's
  computer. A `chrome-extension://` origin is accepted only for an extension
  ID listed in `CRITIQS_EXTENSION_IDS`.
- **Local development.** With `CRITIQS_DEV_SIGN_IN=enabled` and a local issuer,
  the sign-in window shows the code instead of emailing it. It never runs on a
  shared address.

The component keeps tokens in the host site's local storage, so a script running
on that site can read them. Refresh rotation and sign-in start limits are
covered by local tests. If a browser has neither Web Locks nor IndexedDB,
Critiqs preserves the stored session and declines refresh rather than race
another tab. Browser support is still an open choice.

**Agreed (2026-11-25), not built in a panel yet:** every reviewer who reviews
without installing verifies their email inside Critiqs's panel (email, code,
and a display name on a first sign-in), with no popup. Review links ask at the
first comment; the extension asks when Critiqs first opens on a page.

**Proposed, built:** the sign-in service behind that, for Critiqs's own panels
only. No panel uses it yet.

- **Panel origins.** `CRITIQS_WEB_ORIGINS` lists Critiqs's website origins
  (a review link's panel) and `CRITIQS_EXTENSION_IDS` the extension IDs whose
  side panel (`chrome-extension://<id>`) may sign in, separated by commas or
  spaces. Each must match exactly: a website origin must be a bare `https:`
  origin, or `http:` on this computer, and an ID 32 letters from a to p.
  Patterns, paths, and other entries are ignored. With neither set, no panel
  can sign in.
- **Routes.** `POST /auth/panel/email` with `{ email }` starts an attempt,
  sends a code, and answers with the attempt key; with `{ email, attempt }` it
  sends a new code for the same attempt. `POST /auth/panel/code` with
  `{ attempt, code }` answers with the session's tokens for a returning
  reviewer, or `{ "status": "needs-name" }` for a new one, who then sends
  `POST /auth/panel/name` with `{ attempt, name }` and receives the tokens.
  The tokens are the same as a site's: a 15-minute access token naming the
  panel's origin, a refresh token, and when the session ends. Errors are JSON
  with an `error` code (such as `wrong-code` with `guessesLeft`, `expired`,
  `locked`, or `rate-limited` with `retryAfter`) and a `message` to show.
- **CORS.** Only those exact origins get CORS headers, and requests from any
  other origin, or with none, are refused with 403 before anything happens:
  no attempt, no code, no counter. Nothing uses cookies or credentials.
- **Attempts.** The panel holds an attempt token (32 random bytes) and sends it
  in the request body instead of a cookie, so it works from another site.
  Only digests of it are stored, and the email service sees neither it nor a
  digest that could stand in for it. Each attempt is bound to the token and
  the origin that started it, so it can't be continued from another origin.
  Panel and popup attempts never continue each other.
- **Same rules as the popup.** Codes, digests, the 30-minute attempt, the
  10-minute code, five wrong codes per attempt across its codes, three codes
  per attempt, five codes per address in 15 minutes (counted together with
  popup sign-ins), 300 an hour per deployment, and 200 starts a minute
  across the deployment. Starts count differently (see **Panel start
  limits**). A
  malformed code uses up no try. A
  name is chosen only after the code matches. Request bodies over 4 KB are
  refused before they are read in full.
- **No consent.** The panel origins are Critiqs's own, so they never see the
  allow page and need no site grant; that holds for a popup from those origins
  too. A session started that way, with no grant behind it, renews and renames
  only while its origin is still listed. Removing an origin ends its sessions:
  at their next use, or at the hourly cleanup, whichever comes first, so
  adding the origin back later doesn't revive them. To end them at once, run
  `npx convex run signIn:endPanelSessions '{"origin":"<origin>"}'`. Sessions
  backed by a site grant stay. Every other origin's grant rule is unchanged.
- **Sessions.** `/auth/refresh`, `/auth/profile`, and `/auth/sign-out` accept
  an allowed extension's origin, and, as for every site, only from the origin
  that signed in. `/auth/sign-out` exposes `Critiqs-Session-Ended` to the
  calling page.
- **Email.** The code email names the website's origin, or "pages with
  Critiqs's browser extension", and says to type the code only into the
  Critiqs panel where the reviewer asked for it.
- **Client.** `panelSignIn(signInUrl)` in `@critiqs/core` calls these routes
  and the session routes, with no framework and no stored state: the panel
  keeps the attempt key and the tokens. It is in `@critiqs/core` so that
  `critiqs-react`, the planned `critiqs` package, and the extension can share
  it. A browser hides a refused origin's answer, so the client reports it as a
  network error.
- **Capability.** `/critiqs/config` reports `panelSignIn: true` for the
  deployment's own sign-in service. A deployment's `signInUrl` may name an
  older service, so before offering the form a panel asks the sign-in service
  itself: `POST /auth/panel/status` answers `{ "ready": true }` only to a
  listed origin, and only where codes can be sent (the client's
  `available()`). It is a POST because browsers send `Origin` with every POST,
  even from the sign-in service's own origin.
- **Not in embedded SQLite.** The self-hosted server has its own email-code
  sign-in, which keeps reviewers signed in with a cookie on the prototype's
  own site and refuses API calls from other origins. It issues no tokens, so a
  panel on another origin couldn't use a sign-in there; panels sign in with
  Critiqs Cloud or a Convex deployment.
- **Panel start limits.** Every panel start counts toward the deployment's
  200 a minute, but not toward a per-origin allowance: everyone uses
  Critiqs's website and extension, and a script can claim their origin with a
  forged `Origin` header, so a shared allowance would let anyone lock every
  user out. A panel starts with an email address, so its start is refused
  while that address can't receive another code (five in 15 minutes, counted
  with popup sign-ins), or the deployment can't send one (300 an hour). The
  start reads the same counters its code then uses, so the limits agree, and
  a refused start stores and counts nothing. The check and the send are two
  steps, so another sign-in that takes the address's or the deployment's
  last code between them still leaves an attempt whose code is refused, and
  its start counted. When several limits refuse, `Retry-After` is the
  longest wait; the message names no wait, so the panel shows that one. The popup starts before an
  address is known, so it keeps each origin's 20 a minute, Critiqs's own
  included; Critiqs's website and extension sign in with the panel routes.
  Nothing counts by network address: Convex reports a client IP to functions,
  but documents no guarantee that a client can't set it through forwarding
  headers (the open-source backend takes it from `X-Forwarded-For` first),
  and `X-Forwarded-For` or `X-Real-IP` from the request is ignored. The
  deployment sends at most 300 codes an hour, five a minute on average;
  200 starts a minute leaves room for bursts well above that, and caps the
  attempts a script can store. Someone flooding starts can still use up that
  ceiling for a minute at a time, as before.

**Proposed, built:** approving setup from another device, following RFC 8628's
device flow, as routes beside the sign-in service on the same Convex
deployment. The popup and its tokens are unchanged, so older packages work as
before.

- **Start.** Setup posts to `/auth/device/start` and receives a device secret
  (32 random bytes), a setup code of eight letters from 20 consonants (such as
  `BCDF-GHJK`, about 34 bits), and the `/auth/device` address. It shows the
  code and the address; the secret never appears in any address or output.
  The address it shows and opens is always the sign-in service's own origin
  with the fixed path `/auth/device`, built by the command line; it ignores
  the address in the answer, so a service can't send the person, or the
  computer's browser launcher, anywhere else. The browser opens it with no
  shell: `rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS,
  and `xdg-open` elsewhere, each given the address as one argument, and only
  for an `http` or `https` address.
- **Approve.** In any browser, the person opens `/auth/device`, types the
  code, signs in with an email code as usual, and approves or denies on a
  page naming the account and, when the command line says, the backend it is
  for and where that backend serves screenshots and page copies (`backend`
  and `site` on `/auth/device/start`, as origins; older command lines don't
  send them, and older services ignore them). The start answer repeats the
  `backend` and `site` the page will name, and so does the answer that carries
  the tokens, so the command line can tell a service that shows them from an
  older one that doesn't. A cookie binds these pages to that browser, as
  with the sign-in window. An approval is never remembered like an allowed
  site and never starts a session for a site.
- **Receive.** Setup polls `/auth/device/token` with its secret every five
  seconds; early polls are told to slow down. Once approved, the poll that
  receives the answer uses the grant up in the same transaction and gets a
  15-minute access token for the approver, without a refresh token. Denied,
  expired, used, or unknown grants answer with RFC 8628's errors. Requests that
  carry the device secret, a token, or a refresh token follow no redirect: a
  307 or 308 would repeat the body to another address, so the command line
  refuses it and says which address answered with one.
- **Stored safely, limited.** Only hashes of the secret and the code (keyed by
  the signing key) are stored, and grants expire after ten minutes, then are
  removed by the hourly cleanup. A minute's limits apply across the
  deployment: 60 grant starts, and 30 codes that match no waiting grant, so
  codes can't be guessed. Convex HTTP actions see no trusted client address.
- **Capability.** The sign-in service's `/critiqs/config` reports
  `deviceSignIn: true`; setup refuses remote approval clearly, with what to do
  instead, when a service doesn't, and the backend protocol is unchanged.

**Proposed, built:** coding agents read a project's feedback (`critiqs_comments`,
`critiqs_thread`, and `critiqs_screenshot` in `critiqs mcp`) as the person who
signed their computer in once with `critiqs sign-in`, or the `critiqs_sign_in`
tool, instead of approving every session.

- **Kept sign-in.** `critiqs sign-in` starts the same device approval with
  `{ "keepSignedIn": true }`. Its pages say the command line or agent will stay
  signed in and can read and change feedback in every project the person can
  open, and for how long. The poll that receives the approval also starts a
  session owned by the sign-in service's own origin and gets its refresh token,
  so the session lasts as a site's does: 30 days without use, 90 at most, until
  `critiqs sign-out` ends it. Setup's approvals are unchanged and start no
  session. `/critiqs/config` reports `deviceSessions: true`; older services
  are refused before any code is shown. There is no other way to keep a
  computer signed in: the site sign-in window's consent doesn't say the
  access lasts, and a site allowed before isn't asked again. `--browser` only
  opens the approval page on the computer.
- **On the computer.** The refresh token and current access token are kept in
  `sign-in.v2.json` under the user's configuration folder (or
  `CRITIQS_CONFIG_DIR`), readable only by the user, one entry per sign-in
  service; they never reach the agent's conversation. A lock beside the file
  lets one process at a time read and write it, since each renewal replaces
  the refresh token. Node has no advisory file lock without a native module,
  so the lock is a directory, `<file>.lock`, made with `mkdir`, which only one
  process can do; its `owner` file holds a token unique to the holder, who
  touches it every 5 seconds as a heartbeat. A lock whose heartbeat is 30
  seconds old was left by a process that died. Waiters take one over one at a
  time, each holding a second directory (`<file>.lock.break`) while it checks
  the heartbeat again and renames the lock aside before removing it, so a
  lock taken meanwhile, being fresh, is left alone. Before every write the
  holder checks that its token is still in the lock; if another process took
  it over, the holder writes nothing and writes again under a fresh lock;
  requests under the lock time out well before another process may take it
  over. A renewal saves its chosen replacement in the file before sending it,
  as the component does, so a renewal whose answer was lost finishes on the
  next one, and a renewal another process finished with the same replacement
  is kept, with any replacement that process saved since for its next
  renewal. An answer whose access token expired before it arrived is saved
  but not used; the caller is asked to try again. A renewal's new refresh
  token is never dropped: it replaces the sign-in it renewed, or, if that
  sign-in was replaced meanwhile, is kept aside (`recovered`) and ended with
  `onlyIfCurrent` after the lock is released, so it can't end a session
  another process renewed since and no one waits for it; it stays aside for
  signing out to end until the service answers. Earlier versions' locks are files at the
  same name, waited for and taken over the same way; earlier versions can't
  remove a directory, so they wait. A session that ended is removed, and the
  agent is told to sign in again. Signing out cancels a sign-in still waiting
  for approval, ends both the saved token and a saved replacement, and
  forgets the computer's sign-in only once the service answers, including a
  sign-in another process renewed to that replacement meanwhile. It never
  reports a clean sign-out while a session it couldn't end stays saved, or
  while another process changed the sign-in meanwhile: it says what is left
  and fails;
  `/auth/sign-out` adds `Critiqs-Session-Ended`, so a session it didn't find
  is reported (for example one a sign-in from an older version left behind
  after a lost renewal; it ends after 30 days without use). Not the operating system's keychain: Linux machines without a desktop
  have none.
- **Bound to backends.** Each entry records the backends it was approved for,
  each with where it serves screenshots and page copies (its Convex HTTP
  actions, `site`), as origins: scheme, host, and port. The command line and
  MCP server send its tokens to no other address, even a backend whose
  `/critiqs/config` names the same sign-in service, and say how to sign in for
  it instead: the origin on its own, and a command with the origin in single
  quotes (`npx critiqs-react sign-in --backend '<origin>'`). A later sign-in
  to the same service by the same person adds its backend; by someone else, it
  starts over. A renewal another process made meanwhile is held to the same
  check.
  - **What the approval page names.** The `site` of a Convex Cloud deployment
    (`<name>.convex.cloud`) is its `<name>.convex.site`. Any other backend's
    `site` is the next port on the same host, which may not be what its
    operator runs, so the approval page names it beside the backend. The
    sign-in service must repeat both the backend and the `site`, as the exact
    origins asked for, before a code is shown, and again with the tokens.
    Otherwise nothing is kept, and a session the approval started is ended: a
    service that names other addresses is refused, as is one that names only
    one of the two, or something that isn't an origin, and so is a service
    that confirmed at the start but names nothing with the tokens. An older
    service that names nothing at the start can't show the person what they
    approve, and is refused too, with one exception: Critiqs Cloud's backend
    and site, through Critiqs Cloud's own sign-in service, still work with an
    older service, as long as anything it does name with the tokens matches.
    Setup's remote approval (`init --remote`) is held to the same checks
    before its token is used. `critiqs sign-in` asks the person to check that
    the page names the backend; in Critiqs Cloud's exception, whose page
    doesn't, it asks them to check the page's address instead.
  - **The file's format.** Entries with bindings are saved as `version: 2` in
    `sign-in.v2.json`. Versions of the package that wrote version 1 keep
    reading and writing `sign-in.json` beside it, so they can't write over the
    current sign-ins. The first time a current version runs, under the lock of
    each file, it moves every entry from `sign-in.json`: the one from Critiqs
    Cloud's sign-in service is bound to Critiqs Cloud, and others are bound to
    nothing, kept only so signing out can end them. It then leaves
    `sign-in.json` signed out, empty but valid for older versions, so they ask
    to sign in again instead of sending its tokens to a backend no one
    approved. `sign-in.v2.json` marks the move pending until `sign-in.json` is
    signed out, so a move cut off between the two writes, by a crash or a
    failed write, is done again in full by the next command, which goes on
    only once it succeeds. An older version that signs in again afterwards
    writes a new version 1 sign-in, which the current version leaves to it,
    except a Critiqs Cloud sign-in from Critiqs Cloud's sign-in service when
    `sign-in.v2.json` has none and it was made after the last Critiqs Cloud
    sign-out there (`cloudSignedOutAt`): that one moves, bound to Critiqs
    Cloud, and one already copied by a move cut off before removing it is
    removed. Signing out of Critiqs Cloud also ends and removes an older
    version's Critiqs Cloud sign-in, so the next command can't switch to it. Such
    an older version still sends its own sign-ins wherever it did before;
    only upgrading or removing it (a pinned `npx critiqs-react@<older>`, or an
    MCP server still running from before) closes that.
  - **Transport.** Tokens travel only over HTTPS, or plain http to this
    computer: exactly `localhost`, which Node resolves to a loopback address,
    and the literal loopback addresses `127.0.0.0/8` and `[::1]`. Other names,
    `.localhost` ones included, depend on name resolution and are refused.
    Requests that carry a token follow no redirect.
- **Reading.** The tools call the backend's existing queries (`threads:list`,
  `threads:exportThreads`, `threads:get`, `threads:listReactions`,
  `projects:get`) and `/capture`, a few threads at a time, and filter on the
  computer: by status, tag, screen, and time from the thread list first, then
  by author, time, and text on whole discussions. Messages now carry
  `authorId`, the author's permanent ID in that backend, so a filter can tell
  apart two people with the same name; a name two people share is refused with
  their IDs. Embedded SQLite isn't supported yet: its API accepts only its own
  site's requests.

**Planned, not built:** deployment-specific token audiences, as defense in
depth beside the command line's backend binding. Every Critiqs token now
carries `aud: "critiqs"`, so any deployment trusting an issuer accepts any of
its tokens.

- **Design.** The sign-in service issues `aud: ["critiqs", "<backend origin>"]`
  when the request names a backend: the component's sign-in window and
  refreshes would name the backend it uses, as device approvals already do
  (`backend` on `/auth/device/start`). Each backend also accepts tokens whose
  audience is its own origin, as a second `customJwt` provider in
  `auth.config.ts`.
- **Why not yet.** Backends can't require their own audience while older
  packages, which don't name a backend, still sign people in: their tokens
  carry only `"critiqs"`. Team-owned Convex deployments that trust Critiqs
  Cloud's issuer upgrade on their own schedule. The command line would also
  need one access token per backend instead of one per sign-in service.
- **Rollout.** (1) Check that Convex's `customJwt` accepts an audience list
  containing `applicationID`, against a deployed backend. (2) The sign-in
  service issues the audience list when a backend is named; older backends
  still match `"critiqs"`. (3) Packages name their backend on every token
  request, and the command line keeps tokens per backend. (4) Backends add the
  provider for their own origin and report how many tokens arrive without it.
  (5) After the support window for packages that don't name a backend (see
  [Versioning and compatibility](#versioning-and-compatibility)), backends
  drop the `"critiqs"` provider; team-owned deployments do so when they next
  deploy.

**Built:** embedded SQLite runs on the prototype's own site
(`createCritiqsHandler` from `critiqs-react/server`, mounted at a path such as
`/critiqs`, which the component's `backend` names). There is no consent page. The
sign-in window is the server's own email, code, and name pages, so the component
holds no tokens. Reviewers stay signed in for 90 days with an `HttpOnly`,
`SameSite=Lax` session cookie, which is `Secure` over HTTPS, including behind a
proxy that sets `X-Forwarded-Proto`. Only hashes of session tokens and sign-in
keys are stored. Codes use the same digests and limits as Critiqs Cloud, and a
cookie binds each sign-in to the browser that started it. API calls carry a
custom `X-Critiqs-Request` header and are refused when their `Origin` names
another host. Browsers send custom headers cross-site only after a CORS
preflight, which the server never allows. A host-app identity comes only from
the server-side `identify(request)` callback, which checks the host's own
session; Critiqs never trusts names or emails sent from the browser. Sign-in
codes and mention emails go through the team's Resend key. Without one,
`developmentSignIn` shows codes on screen, only for connections whose address
the host's server reports as this computer; the Host header is never trusted
for this. A new code clears any earlier verification, and five wrong codes end
the sign-in, counted in the same transaction as each guess. Every API call's
arguments are checked against the same shapes Convex validates. Request bodies
are read up to a limit (1 MB for calls, 10 MB for images) and refused beyond
it. Captures must be PNG, JPEG, WebP, or GIF, on every backend, and are served
with a sandboxing content security policy.

The component asks the server whether anything changed every three seconds,
while the page is visible, and right after the reviewer's own changes. Then it
reloads what it shows. Captures and screenshots are stored in the SQLite file.
Mention emails are sent every minute by the server process. The schema
migrates forward on start (`PRAGMA user_version`), and the server refuses a
database from a newer version.

**Backups:** the database is one file plus its write-ahead log. Back it up while
the server runs with SQLite's online backup, such as
`sqlite3 critiqs.sqlite ".backup critiqs-backup.sqlite"`, rather than copying the
file. Restore by stopping the server and replacing the file.

**Address check on a self-hosted server:** onboarding's check of a
prototype's address fetches whatever address a signed-in person types. It
refuses private and local addresses and ports other than 80 and 443, but it
can't see where the host's own network routes a public address. Run the
server with outbound traffic limited to the public internet, or turn the check
off with `createCritiqsHandler({ addressCheck: false })`, which `/critiqs/config`
reports as `addressCheck: false`. Critiqs Cloud keeps the check on.

**Proposed, built in the pilot:** Critiqs renders in its own React root inside a
shadow root, so its events, contexts, and styles stay separate from the host
app's. In Comment mode pointer and keyboard events are stopped before the
prototype's own handlers, and keys typed into Critiqs's fields stop at its shadow
root. Keyboard listeners the host registers in the capture phase on `window` or
`document` still see keys before Critiqs can stop them.

Provider secrets stay on the server; browser configuration contains public settings.
Synchronizing multiple stores is outside the first release.

**Proposed, built:** address lists and the project lookup for the planned
browser extension, which has no project ID in the page. Nothing in the
interface sets a list yet; the owner's settings come with the extension.

- **Address lists.** A project's owners set up to 20 addresses
  (`setProjectAddresses`): origins, or patterns with one `*` in the leftmost
  label, such as `https://*-acme.vercel.app`, never directly in front of a
  top-level name such as `.com`. Each must use HTTPS, or HTTP on this
  computer or a private network, with no path, parameters, or credentials.
  Case, a default port, a trailing slash, and a host's final dot are
  normalized away, and an address is at most 200 characters as typed and
  once normalized (`parseProjectAddress` in `@critiqs/core`). Lists aren't unique across
  Critiqs, and saving one never says whether another project lists the same
  origin. The list is separate from the review address.
- **Opened projects.** The installed component records, once per page load,
  that the signed-in reviewer opened its project (`recordProjectOpened`).
  Recording again writes nothing unless a day has passed. Review links will
  record the same way; thread pages never do.
- **Lookup** (`findProjectsForOrigin`). It requires sign-in and searches only
  projects in organizations the person belongs to and projects they opened.
  An exact origin wins over a pattern. It returns one project, several to
  choose from, or none; an origin on this computer, a private network, or a
  local name such as `.local` always returns its matches as choices. A match
  outside the person's scope answers exactly as an origin no project lists.
  The extension, not the backend, remembers which project a person chose for
  such an origin, because the same `localhost` address is a different app on
  each computer.
- **Bounds.** One lookup searches up to 100 organizations and the 100
  projects the person opened most recently, reads up to 50 exact and 100
  pattern addresses per organization, checks at most 50 matching projects
  in full, and offers up to 20 choices, so it stays within a Convex
  transaction's reads. When a read stops at its limit, a single match is
  offered as a choice rather than shown, since another may be missing.
- **Known limit.** The backend can't tell an install from any other caller,
  so someone who already has a project's ID, such as from a forwarded thread,
  can record it as opened. Today that ID already gives them its feedback and
  review address; recording it also lets them confirm whether that project
  lists an origin they guess. Once projects can limit who reviews them, the
  lookup applies that check too.
- **Changing one address.** `addProjectAddress` and `removeProjectAddress`
  change one address in one transaction, so two people adding at once keep
  both. Adding validates as the whole list does, an address already listed
  changes nothing, and the 20-address cap applies. Owners only, as for the
  whole list.
- **Projects a person can add a site to** (`manageableProjects`). Every
  project in an organization the person is an admin of, and the projects
  they created while still a member: exactly who `projectAccess` lets change
  a list. Admins are included because they already manage every project in
  their organization (its settings, tags, usage, and "Who can review"). At
  most 200 projects by name, with `complete: false` when there may be more.
  A project from before organizations is listed only for its creator until
  the backfill moves it into an organization, though an admin of the
  creator's home organization may already change it.
- **Retried creates.** `createProject` takes an optional `idempotencyKey` (8
  to 100 letters, digits, `-` or `_`; clients use a random UUID). A retry with
  the same key by the same person within a day returns the project the first
  call created, without counting against the plan again; another person's
  identical key is a separate request, and a create without a key behaves as
  before. The day covers lost responses, reopened panels, and pages reloaded
  while a create was pending. Keys past a day are removed as the person
  creates more projects.
- **Interface.** Additive calls under protocol 5; `/critiqs/config` reports
  `addressLists`, and the component records opened projects only where it
  does. It reports `addressEdits` for adding and removing one address and
  the manageable list, and `createKeys` for `idempotencyKey`; clients send
  those only where reported, since an older backend refuses arguments it
  doesn't know.

## Sign-in and organizations

**Agreed (2026-11-23), not built.**

- **Sign-in stays Critiqs's own** email-code sign-in, described above.
- **Organizations are Critiqs's own records**, built in Convex, with the same
  records in the SQLite store. An organization (`OrganizationRecord`) has a
  name, its creator, and optionally its plan, overage cap, and extra storage
  units. A membership (`MembershipRecord`) gives a person the role `admin` or
  `member`. An invite (`InviteRecord`) holds the normalized email address and
  role until it is accepted.
- **Projects and people.** Each project gains `organizationId`. Each person
  gains `homeOrganizationId`, the organization that pays for their own
  Critiqs AI.
- **One permission check.** `projectAccess(store, project, userId)` returns
  `"manage"` for an admin of the project's organization, or for the project's
  creator while still a member, and `null` otherwise. It replaces every check
  that compares a project's creator with the signed-in person.
- **Invites** go by email. Accepting one uses email-code sign-in.
- **Existing data.** Each person who has projects gets their own
  organization. Their projects move into it, and it takes their current plan.
- **Later:** a verified company domain, and an enterprise sign-in (SSO)
  connection through WorkOS, on Critiqs Cloud only, when a customer needs
  Okta. Organization records leave room for both.
- **No Clerk.** Critiqs must sign people in on any prototype's domain with
  nothing added to the host app, which its own popup and tokens already do.
  Self-hosted deployments must run with no outside sign-in service. Clerk
  charges for each monthly active user, while Pro allows unlimited reviewers.

## Private R2 screenshot storage

**Agreed:** screenshots may live in a private Cloudflare R2 bucket while Convex
continues storing comments, threads, identities, access rules, and image metadata.
The React component and host application need no storage credentials.

**Built, awaiting live bucket verification:** set these on the Convex deployment:

| Setting | Value |
| --- | --- |
| `CRITIQS_CAPTURE_STORAGE` | `r2` (`convex`, the default, retains native file storage) |
| `CRITIQS_R2_ACCOUNT_ID` | Cloudflare account ID |
| `CRITIQS_R2_BUCKET` | Private bucket, such as `critiqs-captures` |
| `CRITIQS_R2_ACCESS_KEY_ID` | R2 S3 access key restricted to that bucket |
| `CRITIQS_R2_SECRET_ACCESS_KEY` | Its secret access key |

Create a private Standard storage bucket with public access disabled. Create an
R2 API token with **Object Read & Write** permission restricted to that bucket.
Use the Convex dashboard, or `bunx convex env set NAME` with its private stdin
input, to set credentials. Do not place these keys in the host app or its Vite
configuration. Deploy matching protocol-4 backend functions and component before
enabling R2. `critiqs doctor` reports whether screenshot storage is configured;
this does not prove the credentials work or the bucket exists.

Uploads pass through Critiqs's authenticated Convex HTTP route, which claims a
one-use reservation bound to its reviewer and project before reading bytes.
It enforces the image MIME allowlist and a 10 MB streamed-body limit, writes a
server-generated object key to R2 with S3 signing, then marks the Convex metadata
ready. Only ready images can be attached. Attachment, plan usage charging, and
the metadata's attached state commit together. Reservations cannot be replayed
to replace saved evidence. A reviewer may have at most 20 unfinished uploads.

Downloads continue through `/capture`, checking the current reviewer's access
to the thread on every request. R2 credentials, object locations, and signed
provider requests remain server-side. No public bucket, R2 browser CORS rule,
Cloudflare Worker, or browser-visible presigned download URL is needed. Proxying
through Convex still consumes Convex action and bandwidth resources.

A scheduled job claims unused uploads after one hour and removes their objects.
Failures retry; deletion tombstones repeat removal for a day to cover uncertain
or delayed writes. Attached images, including those belonging to soft-deleted
threads, are retained. Existing Convex-stored images remain readable without
migration. Each R2 image records its bucket, so changing the bucket for new
uploads does not redirect old images; retain credentials that can read the old
bucket. Switching Cloudflare accounts needs a separate migration.

With R2 selected, incomplete configuration or failed storage requests report an
error and never silently save the image in Convex. As before, failed automatic
capture can still save a comment and allow a screenshot to be supplied later.
Embedded SQLite storage keeps its existing database-file behavior.

## Plans and limits

**Agreed:** Critiqs Cloud has plans, including a free plan, that differ by limits
such as registered reviewers or comments. Their numbers must be easy to change
later. The plans themselves were agreed on 2026-11-23 and are described under
[Free, Plus, and Pro](#free-plus-and-pro) below.

**Built:** plans are configuration, not code (`packages/server/src/limits.ts`).
A plan belongs to an account, the person who sets up projects, and covers every
project it owns. Each limit names what it counts (projects per account; threads,
comments, reviewers, stored image bytes, mention emails, or Critiqs AI credits
per project; a person's own Critiqs AI credits per person), its
period (all time, or the UTC calendar month or day), and its maximum. A metric
may have several limits, such as per day and per month; all of them apply.

Usage is counted for every metric and period whether or not the current plan
limits it, so moving to another plan, or changing a plan's limits, applies to
usage so far. It is counted in the same transaction as the change it limits, so
concurrent or retried requests cannot exceed it, and a refused change counts
nothing. Periods follow the server's clock, not message order. Reaching a limit
refuses the change with a message naming the plan, except mention emails: past
that allowance, mentions still post and highlight, but send no email. A reviewer
counts once per period however much they post. Images are counted when attached
to a thread, since an upload's size is only known then; a project already at its
image limit gets no new uploads. Deleting a thread hides it but keeps its data,
so its usage stays counted.

Plans are off unless a deployment turns them on: Critiqs Cloud sets
`CRITIQS_PLANS=enabled`, so team-owned deployments and self-hosting have no plan
limits or usage counters, only the operational limits in
[Open choices](#open-choices). Critiqs Cloud starts with built-in Free and Team
plans whose numbers are placeholders. Operators replace or add plans without a
deploy (`npx convex run plans:set`), list them (`plans:list`), and move an
account to another plan, naming it or one of its projects (`plans:assign`).
Project owners see their usage in setup; the panel asks for the current UTC day,
so it moves to a new day or month on its own. Limits on sign-in email stay
separate, so a project at its limit never blocks sign-in. Payment is not built
yet; see [Billing with Autumn](#billing-with-autumn).

Critiqs AI requests count in credits, each costing its model's credits (a
search is two requests). When the project pays, they count against the
project owner's plan under `aiRequests`, per project. When a person pays for
their own Critiqs AI, they count against that person's plan under
`personalAiRequests`, per person, and never show in a project's usage; each
person sees their own credits used against their plan in Your AI
(`aiSettings:myUsage`, or `personalAiUsage` on a self-hosted server). The
project's usage lists its credits as "Critiqs AI credits". The
built-in Free plan allows 50 personal credits a day and Team 500
(placeholders); saving personal Critiqs AI on a plan that allows 0 is refused.
A person who saved nothing has Critiqs AI on their own plan, used where each
person pays ([Simpler setup](ai-connections.md#simpler-setup-agreed-2026-11-23)).
Where the deployment sets `CRITIQS_UPGRADE_URL` to an https page, both usage
answers carry it as `upgradeUrl`, and the interface links to it as **Upgrade**.
On deployments that take payment (`billing`), **Upgrade** opens the
organization's **Plan and billing** page instead, and shows only while the
organization has a higher plan to move to (not on Pro).
Own providers count nothing against plans.

### Free, Plus, and Pro

**Agreed (2026-11-23), not built.** These replace the built-in Free and Team
plans above. Plan ids are `free` ("Free"), `plus` ("Plus"), and `pro` ("Pro").
An account assigned `team` moves to `plus`. Prices and what customers see are
in [first release](first-release.md#plans-and-payment).

Plans belong to organizations, not people
([Sign-in and organizations](#sign-in-and-organizations)). `planFor(store,
organizationId)` finds an organization's plan. Some metrics count per
organization and others per project:

| Metric | Counted per | Period | Free | Plus | Pro |
| --- | --- | --- | --- | --- | --- |
| `aiCredits` | Organization | Month | 200 | 2,000, then overage | 10,000, then overage |
| `projects` | Organization | All time | 1 | 10 | No limit |
| `captureBytes` | Organization | All time | 500 MB | 10 GB | 100 GB, plus 100 GB per add-on unit |
| `reviewers` | Project | Month | 5 | 25 | No limit |
| `messages` | Project | Month | 500 | 5,000 | No limit |
| `mentionEmails` | Project | Day | 100 | No limit | No limit |

`threads` still counts per project, and none of the three plans limits it.
"No limit" means the plan has no limit entry for that metric. Operational
limits against abuse, such as the sign-in email limits, still apply.

- **`aiCredits`** counts Critiqs AI credits per organization per month. It
  replaces `aiRequests` and `personalAiRequests` for charging. Those names stay
  in the protocol for older clients. When the project pays, credits count
  against the project's organization. When a person pays, they count against
  the person's home organization.
- **Overage.** A limit may carry `overage: { defaultCap }`. Usage may then go
  past the limit's maximum up to the maximum plus the cap, and the part past
  the maximum is billed. An organization's `overageCap` overrides the default:
  absent uses the plan's default, `null` removes the cap. Plus and Pro start
  with a cap equal to their monthly credits; Free has no overage.
- **AI charging.** Before a request, Critiqs refuses it only when no credits
  are left. After it, Critiqs counts the credits the request really cost.
  That count never refuses work already done, so one request can end slightly
  past the cap.
- **Alerts.** Crossing the plan's monthly credits, or the cap, sends one email
  per organization per month to its admins.
- **Storage add-on.** A Pro organization's `extraStorageUnits` adds 100 GB of
  image storage per unit, at $10 a month each.
- **Existing projects.** A Free organization over its project limit keeps its
  projects; only new ones are refused.

### Billing with Autumn

**Agreed (2026-11-23), not built.** Autumn, on Stripe, holds the plans,
their prices, checkout, the billing portal, and the `ai_credits` meter. Critiqs
keeps enforcing every limit itself, in the same transaction as the change, as
it does today. Each number has one owner: limits live in Critiqs's plan
configuration, and prices live in Autumn.

- The billing code lives in `packages/backend` and does nothing unless the
  deployment sets `CRITIQS_BILLING=autumn` and `AUTUMN_SECRET_KEY`. It ships
  publicly, so self-hosters receive it, turned off.
- The Autumn customer id is the Critiqs organization id. Critiqs reports to the
  `ai_credits` meter the exact credits each request cost.
- Autumn's webhook (checked with `AUTUMN_WEBHOOK_SECRET`) tells Critiqs which
  plan an organization has paid for. Critiqs also reconciles plans with Autumn
  on a schedule.
- Paid plans renew at the start of each month in Autumn, as Critiqs's
  monthly periods do.

## Threads and identity

Project, thread, and message IDs stay independent of element IDs and URLs.
The server verifies authorship and enforces [F2–F4](first-release.md), including
access to captures. Demo personas are stored only as context, never as the author.
Protected captures need permission checks when served; Convex file URLs alone
do not enforce reviewer access. Captures are therefore served through an HTTP
endpoint that checks the reviewer's token first.

**Proposed, built in the pilot:** reply and message timestamps are strictly
increasing within a thread, and replying marks the thread read only if the author
had already seen every earlier message.

**Proposed deletion:** hide the thread and record who deleted it and when,
without immediately erasing its history. Built: only the thread's author or the
project's owners may delete it. How long deleted data is kept and whether it
can be restored remain open.

For read/unread, store each reviewer's last viewed message and a manual unread
override. Do not mark unseen replies read. This record does not change anyone
else's read state or the thread's status.

Feedback collections reference threads rather than merging their histories.
Exports include discussions, links, tags, version, target, and relevant context;
exclude credentials and unrelated app data. **Proposed, built in the pilot:** a
collection is a selection made in the sidebar and exported at once (up to 200
threads); collections are not saved.

**Built:** project setup, the sidebar's threads, discussion messages, reactions,
and exports use indexed cursor pagination, with at most 40 items per request
and bounded scan/response budgets. The component automatically loads successive
live pages before applying existing filters or displaying a complete discussion.
A live boundary change discards obsolete downstream pages. Only rendered
messages advance personal read state; loading a page alone does not mark it read.
Exports load one selected thread's discussion in bounded pages and publish no
partial collection if a page fails. Deleted threads are omitted in full.
Pagination does not change the pilot's proposed 500-message and 200-thread
limits.

## Mentions and notifications

**Agreed:** reviewers can mention people in a comment, and Critiqs emails the
people mentioned.

**Proposed, built:** the rules are in `@critiqs/server` and run on Convex and
SQLite; Convex sends the emails.

- **Who can be mentioned:** people who have commented in the project. This is a
  list of participants, not a member list, and grants no access.
- **What others see:** suggestions show display names and avatars only, never
  email addresses, and are limited to the current project.
- **Who is notified:** a message stores the reviewers selected from
  suggestions, alongside the text. Critiqs never guesses recipients from typed
  names. The server checks each recipient belongs to the project; edits notify
  only newly added recipients.
- **How recipients are stored:** each mention keeps the reviewer's ID and the
  name as written, so it still reads and works after they rename.
- **Reliable delivery:** the message and the emails it owes save together. Each
  email gathers one reviewer's mentions in one thread for a minute; once a send
  is attempted, its content and its short idempotency key are fixed, retries
  send exactly that email, and later mentions start a new one. A background job
  (every minute on Convex) claims emails under its own token, so a stalled job
  can't overwrite another's work; it retries failures after growing pauses and
  gives up after six attempts, counting attempts as it claims. Before every
  attempt, including retries, it checks again that the thread exists, the
  reviewer still wants these emails, at least one message still mentions them,
  and, for a retry, that their address hasn't changed; otherwise the email is
  skipped. Without an email key, owed
  emails are skipped rather than kept waiting. Finished emails are removed after
  30 days. Existing commenters become mentionable through a one-time backfill
  (built into SQLite's migration; `notifications:backfillParticipants` on
  Convex).
- **Reply emails (agreed, built):** a reply also emails everyone else who was
  in its thread when it was written: whoever started it, replied in it, or was
  mentioned in it, with no limit on how many. People it mentions also get
  their mention email, which the email reports instead while the mention
  stands; its author is never told. Each thread records who is in it and how
  many messages it had when they joined (`threadFollowers`); a reply is told
  to people who joined before its number. Message counts, not clock times,
  order these, so an edit and a reply in the same millisecond still order
  correctly. Saving a reply queues a job (`replyEmailJobs`) that the email
  worker, every minute and before sending, advances a step per transaction: a
  page of 100 people, or, for a thread from before reply emails, a page of its
  messages to record anyone not yet recorded at their first message. Each step makes one paginated read, as a Convex transaction allows.
  Reply emails are due a minute after the reply, like mentions, and gather into
  the same email as mentions for that reviewer and thread; a message can be
  owed as both, and each kind is checked on its own when sending and on every
  retry, against the reviewer's choices at that time. Every notice counts
  toward an email's 50; past that, a new email starts. An email reporting a mention reads
  "mentioned you"; one reporting only replies reads "replied in a thread
  you're in". Reply emails are on unless a reviewer turns them off ("Email me
  about new replies in threads I'm in"); muting a project mutes both kinds.
- **Agent replies (agreed, built):** `critiqs_reply` in `critiqs mcp` posts a
  reply as the signed-in reviewer with `via: "agent"`, which the thread window,
  the export, the reading tools, and emails show as "via coding agent". It
  mentions people by author ID, or by display name through
  `projects:participantsNamed`, which finds everyone else with exactly that
  name among up to 1,000 participants, so a shared name is refused rather than
  guessed. It adds each `@Name` to the text, and its reply emails go out like
  any reply. `/critiqs/config` reports
  `agentReplies: true`; the tool refuses older backends before posting.
- **Preferences:** each email offers mute (this project) and unsubscribe (all
  of Critiqs's emails: mentions and replies) links. Each link carries a token signed with a key the
  deployment generates for itself, so it needs no setup; it authorizes only that
  change for that reviewer, and a confirmation page comes first so mail scanners
  that open links change nothing. The account menu's "Email notifications…"
  changes the same choices.
- **Where links go:** a background job has no current page to link to, and a
  comment may have been left on a copy only its author can open, so each
  project has one review address that its owner sets. Every email link is that
  address exactly, with its path (such as a deployment's prefix), its own
  parameters, and its hash route, plus the message's link parameter; the page
  a comment was left on is not used, and its saved evidence is unchanged.
  Opening the link loads that page, and the component then opens the message
  and restores its screen and view from the saved context (see
  [shareable links](#shareable-links)). Each message in the email links to
  itself. Emails contain no sign-in credentials.
- **Setting the review address:** setup offers an optional field, with a button
  to use the current page; it never saves an address on its own. Only the
  project's owner changes it later, in Project setup or with `critiqs init
  --review-url`; commenting and reusing a project never change it. A change
  applies to emails sent afterwards. Addresses must use HTTPS, or HTTP on this
  computer, and are at most 2,000 characters. Setup, `critiqs init`, and
  `/critiqs/health` say when an address opens only on one computer or private
  network: `localhost` and other local names, private and link-local IP
  addresses, and Tailscale (`*.ts.net`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`).
  This informs without refusing: private deployments are supported. An address
  not recognized as private isn't thereby known to be reachable. Existing
  projects keep their address; upgrading the package and backend changes no
  saved address.
- **What an email shows:** enough to understand the thread before opening it.
  The subject names who mentioned the reviewer and the thread's first comment.
  The email shows the thread's status, tags, and comment count; its saved
  capture or attached screenshot, or why there is none; and every comment of
  the discussion in order, including those that don't mention the reviewer,
  with authors, UTC times, a link to each, and the reviewer's mentions marked.
  Text is escaped. A review address saved before the current limits, too long
  to repeat in every link, drops only its parameters and hash, keeping its
  path; it never links to the site's root outside the app.
- **Preparing and storing an email:** the worker reads the discussion a page
  per transaction, so no step reads more than Convex allows however large the
  messages are, and checks between pages that no message was added or edited;
  if one was, it starts again. It stores the finished request for the mail
  service as a private file and records it on the delivery only if the thread
  is still unchanged; the delivery keeps just that file and the address.
  Every retry sends that file under the same idempotency key, so the request
  is identical even if the capture later becomes unreadable. If storage can't
  be read, the attempt fails and is retried; nothing else is sent under that
  key. The file is removed once the delivery finishes.
- **Size:** an email may be as large as Resend accepts: 40 MB, counting
  every part as the mail service encodes it (Base64 in 76-character lines),
  and the request itself. Every comment always stays in the HTML part; the
  longest thread, 500 comments of 10,000 characters, takes about 28 MB
  encoded. Only when the whole discussion, its plain-text copy, and the
  capture would exceed the limit does the plain-text part say the HTML part
  has the discussion instead of repeating it; if still too large, the email
  says the capture didn't fit beside the discussion. 320 such comments and a
  10 MiB capture fit together. Names the email repeats (project, reviewer,
  authors) are shortened past 200 characters.
- **Worker runtime:** on Convex the worker is a Node action
  (`notificationEmails.ts`), whose 512 MiB of memory holds the largest
  emails; building one measured at most about 170 MiB under Node, beyond the
  default runtime's 64 MiB.
- **Images in email:** captures need a signed-in reviewer to view, and Convex
  storage links open for anyone who has them, so emails never link to a
  capture. The worker reads the image from its own storage and attaches it
  inline (`cid:`), checked to be a PNG, JPEG, WebP, or GIF. If it is missing or
  isn't such an image, the email says so instead of showing a broken image.
  Some webmail clients may not show inline images; real clients are untested
  until Critiqs's sending domain is set up.

Team-owned deployments send notifications with their own Resend key. Sending
them through Critiqs Cloud would need deployment credentials, recipient opt-in,
fixed templates, and quotas to prevent abuse; it is not planned.

## Tags and tag groups

**Agreed:** reviewers tag threads with hashtags written in comments, alongside
the project's tags; related tags gather into shared groups that filters use.
The plan, status, and checks are in [tags, tag groups, and AI](tags-and-ai.md).

**Proposed, built:**

- **Hashtags.** A hashtag starts at the start of the text, after whitespace, or
  after opening punctuation, begins with a letter, and continues with letters,
  numbers, marks, `_`, or `-`, up to 50 characters; trailing `_` and `-` are
  dropped. So `#wording` and `#fff` are tags, while `#123`, `C#`, `&#39;`, and
  `/page#top` are not. Text is stored exactly as written.
  New-comment, reply and edit inputs show the hashtags being typed as padded
  pills inside the input, without a fixed row of preset tag choices. The input
  is an editable box whose content stays plain text: pills wrap the hashtag's
  own characters, so posted text never gains padding characters, and the box
  keeps its own undo and redo because redrawing pills clears a browser's. Existing project tags remain
  available in `#` suggestions and filters.
- **Matching.** Tags match by a key: NFKC, lowercase, spaces and underscores as
  hyphens. `#UX-copy-change` is the preset "UX copy change"; `#UXCopy` is a
  different tag, since words are never split. Each tag shows the first
  spelling seen.
- **Derived on the server.** Every new message, reply, and edit stores its
  hashtags (up to 30 different ones) and updates its thread's counts (up to 200
  different hashtags), in the same transaction, on Convex and SQLite. Text
  beyond either limit is refused with the reason and nothing is saved, so no
  hashtag it shows is silently left out; the composer's preview says so before
  posting. A hashtag an edit stops using frees its place, so at the limit an
  edit can swap one for another. Messages from before tags were derived are
  read when upgrading, keeping their first 30 hashtags and their text as
  written. A thread's tags are its explicit tags, then hashtags its messages
  use. Removing a hashtag from every message removes the tag.
- **Explicit tags.** Explicit tags may be presets or free tags in a tag's
  format, up to 50 per thread. A tag chosen explicitly stays explicit even when
  the text also writes it. Otherwise, tags a thread's text already writes are
  left out of its explicit tags, so a client that sends back the whole tag list,
  as older components do, neither repeats nor drops them; removing a written tag
  means editing the text. That list may hold up to 250 tags, 50 explicit and
  200 written; the 50-tag limit applies to what remains explicit. `ProjectInfo.tags` stays the project's presets.
- **Registry.** Each project records its tags: first spelling, last use, groups,
  and how they were grouped (waiting, automatically, starter, by a person, or
  not). Suggestions list them most recently used first.
- **Groups.** Only the project's owner creates, renames, merges, and deletes
  groups and sets a tag's groups; a tag may belong to several, for ambiguous
  terms. A person's choice, including "no group", is final: automatic grouping
  never changes it, and every such change starts a new epoch so a grouping run
  already under way can't apply over it. The owner can hand a tag back to
  automatic grouping. Copy & wording is a starter group for `copy`, `wording`,
  `text`, `microcopy`, `ux-copy`, and `ux-copy-change`, applied without AI.
- **Filters.** Choosing a group filters by its tags; the filter summary lists
  the tags each group includes, and a thread with several of them appears once.
- **Automatic grouping.** A background job, every minute on Convex and in the
  self-hosted server, claims one project's waiting tags under its own token and
  three-minute lease, asks the project's model to place them in existing groups
  or propose new ones, and applies the answer only to tags still waiting, still
  held by that run, unchanged by any person, and under unchanged AI settings.
  Answers naming tags or groups it wasn't given are ignored; at most five new
  groups a run. Failures retry after 1 minute, 5 minutes, 30 minutes, 2 hours,
  and 12 hours, then stop, leaving tags ungrouped. Without AI, waiting tags are
  marked ungrouped and wait again once the owner connects AI. Posting never
  waits for grouping.
- **Existing feedback.** SQLite's schema version 6 reads hashtags from every
  existing message and records every thread's tags. Convex keeps new fields
  optional; run `npx convex run tags:backfill` once after deploying, which pages
  through messages and threads and can run again safely.

## AI connections

**Agreed:** a project connects to AI in exactly one of two ways: Critiqs-managed
AI, or its own provider. A setting can turn AI off for a project; that keeps
basic search and manual grouping. Each person may also connect their own AI,
and the project's owners pick whose connection people's requests use; see
[personal and project AI connections](ai-connections.md).

**Proposed, built:**

- **Critiqs-managed AI** is configured by a deployment's operator for every
  project and person, and is Critiqs Cloud's default once its operator sets it.
  It offers a list of models (`CRITIQS_MANAGED_AI_MODELS`), each with an id,
  a label people see, the provider's model name, which people never see, and
  its cost in credits; the first is the default. Without the list, the single
  `CRITIQS_MANAGED_AI_MODEL` is "Critiqs AI" (`default`), costing 1 credit. A
  list that isn't valid turns Critiqs-managed AI off, and health and
  `critiqs doctor` say why. Each request costs its model's credits; see
  [Plans and limits](#plans-and-limits).
- **Which connection:** `chooseConnection` decides before any key is
  decrypted. Background work (automatic grouping) uses the project's
  connection. A person's search, mockup turn, or other request follows the
  project's **AI usage rule**: `project` uses the project's connection;
  `personal` the person's own, or refuses with error code `setup-ai` ("Set up
  your AI to use this."), where search falls back to basic search with
  `noticeCode: "setup-ai"`; `either` (the default, and what a project with no
  saved rule has) the person's own when it is turned on and ready, otherwise
  the project's. A project whose AI is turned off uses no connection, not
  even people's own, so its feedback reaches no provider. It also decides the
  **payer**: the project for its Critiqs-managed AI, the person for theirs,
  and nobody for an own provider. A request may name one of the chosen
  connection's models (an own provider's picked models, or a Critiqs AI
  model's id, limited to the project's allowed models when the project
  pays); any other is refused. A failed request never falls back to another
  connection.
- **Personal settings** (Your AI) have the same connection fields as a
  project's, one record per person, seen and changed only by that person.
- **Own provider:** OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI
  Gateway, or an OpenAI-compatible endpoint, with its models and, where
  allowed, an address. OpenRouter is the OpenAI-compatible connection at
  `https://openrouter.ai/api/v1`, an address Critiqs sets and owners can't
  change, treated as the provider's own. Settings views list the providers a
  backend accepts (`deployment.providers`), so the component never offers
  one an older backend would refuse.
  Each request goes straight to the chosen provider through an explicit AI SDK
  provider instance; settings are never read from the environment, and the
  Gateway is used only when chosen. A failed request reports its error and
  never falls back to managed AI or another provider.
- **Who:** only the project's owner (its creator today; its organization's
  admins too once organizations are built) sees or changes its settings, including
  its usage rule, its Critiqs AI model, and which Critiqs AI models its
  connection may use (all when none are chosen). Every AI request checks
  access before any model call.
- **Keys** entered in Critiqs are encrypted with AES-256-GCM under the
  operator's encryption key, bound to their project (`project:<id>`) or, for a
  person's own key, to that person (`user:<id>`), and only the ciphertext
  and the last four characters are stored. They are decrypted only where model
  calls run and never returned to browsers. Without an encryption key, saving a
  key is refused with the setting to add. Changing the provider or address
  without a new key removes the saved key, so it's never sent elsewhere.
- **Endpoints** an owner enters must use HTTPS, match the operator's list of
  allowed endpoints, carry no credentials, and not name private, loopback, or
  link-local addresses unless the operator allows local endpoints. Requests
  never follow redirects and must stay under the configured address. The
  backend makes these requests: an address on a reviewer's computer, such as
  `localhost`, means the server's own machine, not the browser's.
- **Connection test:** a short structured request through the same path
  grouping and search use, sorting failures into key, model, structured
  output, network, rate limit, or configuration, without the provider's
  response, which can echo keys. Owners, and people for their own settings,
  can test before saving; both kinds share one per-minute limit per person. A
  test of Critiqs-managed AI, saved or draft, costs its model's credits to
  whoever would pay; a test of an own provider doesn't.
- **Model lists:** owners, and people for their own settings, can list the
  models a provider offers their key (`ai:listModels`,
  `ai:listPersonalModels`; `listAiModels`, `listPersonalAiModels` on a
  self-hosted server), saved or as a draft whose typed key is used for that
  request only. The request goes from the backend under the same endpoint
  rules as model calls, with a 15-second timeout and an 8 MB limit; only
  model ids and display names are kept, at most 500. Failures are sorted like
  connection tests, without the provider's response. Ten lists a minute per
  person.
- **Model choice:** `aiSettings:myChoice` (`aiChoice` on a self-hosted
  server) tells the signed-in person which connection the project's rule
  gives them and the models they may name, without keys or addresses. Mockup
  mode offers a model only when there are several, and names it on each
  request. `/critiqs/config` reports `modelLists: true` where these calls
  exist.
- **Bounds:** model requests time out after 30 seconds, answers are schema
  checked and size limited, and prompts quote reviewers' text as data.
- **What reaches the provider:** for grouping, tag names and existing group
  names; for search, the question, the project's tag and group names, and the
  matching threads' comments with their authors' display names, status,
  screen, and tags; for a mockup, the mockup thread's messages, the text of
  existing threads added to it, its current changes, and a description of the
  page copy's elements (tags, classes, text, and some computed styles) with
  masked regions left out. Never email addresses, keys, captures, or other projects.

**Agreed (2026-11-23), not built:** credits per token instead of per request.
One credit is one cent of what the customer pays, and a request costs
`ceil(api_cost_usd × 200)` credits, at least 1: twice the provider's price for
the tokens it used, rounded up. Critiqs uses the cost the gateway reports when the
provider returns one. Otherwise it uses the model's prices from
`CRITIQS_MANAGED_AI_MODELS`, in US dollars per million input tokens and per
million output tokens. The reference list prices are Claude Opus 5.5 at $4
and $20, Claude Haiku 5.5 at $0.10 and $0.50, Gemini 4 Neon at $3 and $15, and
GPT-6.2 Sol at $2 and $10. The cost shown beside a model is an estimate.
Credits count under `aiCredits` against the paying organization
([Free, Plus, and Pro](#free-plus-and-pro)).

| Setting (Convex deployment) | Purpose |
| --- | --- |
| `CRITIQS_MANAGED_AI=enabled`, `CRITIQS_MANAGED_AI_PROVIDER`, `CRITIQS_MANAGED_AI_API_KEY`, optional `CRITIQS_MANAGED_AI_BASE_URL` | Critiqs-managed AI, for Critiqs Cloud |
| `CRITIQS_MANAGED_AI_MODELS` | Critiqs-managed AI's models, a JSON list of `{ "id", "label", "model", "credits" }` (1 to 20; credits a whole number from 1 to 1000), first is the default; sharing the provider, key, and address above |
| `CRITIQS_MANAGED_AI_MODEL` | Without `CRITIQS_MANAGED_AI_MODELS`: one model, `default`, labelled "Critiqs AI", costing 1 credit |
| `CRITIQS_UPGRADE_URL` | With plans: the https page where people upgrade, linked as **Upgrade** |
| `CRITIQS_BILLING=autumn` | Agreed, not built: turns on Critiqs Cloud billing through Autumn ([Billing with Autumn](#billing-with-autumn)). Without it, billing code does nothing |
| `AUTUMN_SECRET_KEY` | Agreed, not built: Autumn's secret key, needed with `CRITIQS_BILLING=autumn` |
| `AUTUMN_WEBHOOK_SECRET` | Agreed, not built: checks that webhook calls come from Autumn |
| `CRITIQS_AI_PROVIDER`, `CRITIQS_AI_MODEL`, optional `CRITIQS_AI_API_KEY`, `CRITIQS_AI_BASE_URL` | A provider for every project that saves none (team-owned deployments) |
| `CRITIQS_AI_ENCRYPTION_KEY` | At least 32 random characters (`openssl rand -base64 32`); lets owners save their own keys |
| `CRITIQS_AI_ALLOWED_ENDPOINTS` | Comma-separated endpoint addresses owners may enter |
| `CRITIQS_AI_LOCAL_ENDPOINTS=enabled` | Lets listed endpoints use `http://` or private addresses |

The self-hosted server takes the same choices as `createCritiqsHandler({ ai:
{ provider, model, apiKey, baseURL, encryptionKey, allowedEndpoints,
allowLocalEndpoints } })`, read from its own environment; its own `baseURL` may
be a local address such as an Ollama server. It has no Critiqs-managed AI;
people there connect their own keys. `/critiqs/config`, `/critiqs/health`, and
`critiqs doctor` report which AI is available, never a key or address.
`/critiqs/config` reports `personalAi: true` on backends with personal
settings and usage rules: Convex's `aiSettings:getPersonal`,
`aiSettings:removePersonal`, `ai:savePersonalSettings`,
`ai:testPersonalSettings`, and `aiSettings:myUsage`, and the self-hosted
calls `personalAiSettings`, `savePersonalAiSettings`,
`testPersonalAiConnection`, `removePersonalAiSettings`, and
`personalAiUsage`. The component shows no usage where the usage call is
missing. Project settings calls accept `rule`,
`managedModel`, `models`, and `allowedModels`, and `ai:mockupReply` a
`model`; all optional, and left out they keep their saved values, so older
clients keep working.

## Search and insights

**Agreed:** reviewers search a project's feedback in plain language, with
insights that cite the threads they come from. No embeddings.

**Proposed, built:**

- **Interpret.** With AI, the project's model turns the question into words,
  tags, groups, status, dates, and a screen, checked against the project's own
  tags and groups. `#tags` typed in the question always count.
- **Retrieve.** The backend finds messages containing the words (including
  replies) through Convex's search index or SQLite's full-text index, and
  threads with the tags or groups' tags through thread-tag records, within
  fixed budgets, then applies the status, screen, and dates. The sidebar's
  scope applies unless the question names a status or screen. Up to 50 threads
  are shown; more matches are reported as such. Deleted threads and other
  projects never appear.
- **Insights.** The model summarizes up to 24,000 characters of the results in
  up to five findings, each citing threads by label. Citations of threads it
  wasn't given are dropped, as are findings left without one. No counts are
  taken from the model.
- **Before answering,** every result is checked again: the reviewer still has
  access, and each thread exists in the project and isn't deleted.
- **Basic search.** Without AI, or when the model fails, the same retrieval
  runs on the question's own words and `#tags`, labeled "AI unavailable: basic
  search" with the reason. Every result and source opens its thread.
- **Limits:** questions up to 500 characters, 20 searches a minute per reviewer.

## Thread window

**Agreed:** comments follow Figma's layout. The sidebar always lists all threads.
Selecting a thread in the sidebar, or its pin, moves to the target and opens a
small thread window beside the pin, showing the whole discussion and a reply box.

**Proposed, built:**

- **The clicked pin.** A shared thread can show several pins; the window opens
  beside the one selected, and opening it does not scroll to a different one.
- **Unavailable targets.** When a target is hidden, removed, outside the view, or
  on another record, the window opens beside the sidebar with the saved capture
  and context, and never borrows another record's pin.
- **Placement.** The window measures itself, the sidebar, and the toolbar, which
  can sit at the top or bottom, and stays within the visible area with its reply
  box reachable.
- **Restoring views.** Selecting a thread in the sidebar, opening a link, or
  choosing Show in prototype goes to the screen and view state where the thread
  was left, even when a matching element is shown in the current view; a pin
  opens the thread beside that pin without changing views. The window docks
  beside the sidebar until the saved view is shown. A newer selection, closing
  the window, or signing out cancels an earlier restore. After restoring,
  Critiqs checks that the host reports the saved screen and view state and
  locates the target again before attaching the window; otherwise it explains
  what is missing beside the saved context. The open thread keeps its pin
  under any status filter.
- **Interaction.** The window keeps focus inside Critiqs's shadow root, returns
  focus to the pin when closed, and closes with Escape after any open menu.
  Clicking outside closes it but keeps an unsent reply.
- **Read state.** Only a visible window marks messages read.
- **Narrow screens.** On phones the window becomes a panel from the bottom of the
  screen, above the thread list, and stays usable with the on-screen keyboard.

## Locating a comment

An anchor records:

- **Screen:** the logical page, such as user details.
- **View state:** the tab, dialog, step, or filters needed to reveal the element.
- **Target:** an ID for its meaning, such as `user-details.department`, a key
  identifying the record where needed, and backup clues such as labels and
  surrounding structure.
- **Scope:** shared across compatible records, or specific to one record.
- **Original evidence:** image with marked location, URL, context, browser view
  size, capture time, and prototype version.

Shared feedback can restore a tab while keeping the current record. Record-specific
feedback may require navigating to its original record, if access allows.

Generated IDs distinguish elements within a captured view; they do not guarantee
continuity after a redesign. Use Critiqs-specific labels on elements (data attributes)
without replacing the app's HTML IDs. **Proposed:** `data-critiqs-id` holds the
purpose ID and `data-critiqs-record` the record key on a containing element. Stable purpose IDs identify important
elements; record keys distinguish repeated ones. Changing a `div` to a button
need not change its purpose. Linking elements to their source code can come later.
Do not depend on undocumented React internals.

## Capturing and restoring context

Start with basic element location and capture. For complex views, the host app
provides functions to record and restore relevant state. Critiqs cannot reliably
infer every app state on its own.

Restore one view at a time using the app's navigation and state functions under
the current reviewer's access. Respect unsaved work, wait for content, reveal rows
that render only when scrolled into view, then locate the target. Pins move with
layout changes. Do not replay arbitrary clicks that might submit forms or change data.

If matching is uncertain, show saved context instead of guessing a nearby element.
Reattachment changes the current target while keeping the original evidence.
Record the prototype version for each message; label missing versions unknown.
Extra captures on replies can be optional.

Automatic images made from the browser's page structure (DOM) may miss styling,
embedded content, or drawn graphics. Actual screen capture requires browser
permission. Choose a capture method in the pilot; show failures and allow
supplied screenshots. Historical
page snapshots come later and do not recreate working React state.

**Proposed, built in the pilot:** capture renders the page from the DOM with
`modern-screenshot`, crops it to the reviewer's visible view, and outlines the
target. Critiqs's own interface is left out: every mounted Critiqs, not only
the one saving the comment, is skipped while the page is copied, so nothing on
screen is hidden or changed. Images already saved are left as they are. The pilot shows that dimmed
backdrops behind dialogs can be missing. Failures save the comment with the
reason and offer an attached screenshot. Uploaded images must be used by a
thread within an hour and only once.

**Proposed:** record only explicitly allowed context and hide sensitive regions
in captures. Historical evidence must respect project access rules.

## Mockup mode

**Proposed, built on Convex:** [Mockup mode](first-release.md#mockup-mode)
changes a frozen copy of the page, never the running prototype. Changing live
elements would fight the host's React, which re-renders over outside changes
and can fail when elements it owns are removed.

- **Page copy.** The component clones the document, leaves out every mounted
  Critiqs, scripts, and `on…` attributes, covers `data-critiqs-mask` regions,
  keeps form values, draws canvases as images, and numbers every element with
  `data-critiqs-node`. It collects the page's stylesheets as CSS text,
  including rules added through the CSS object model and adopted style sheets,
  and keeps cross-origin sheets as links, so the copy reflows at other widths
  as the page would. Layout chosen in scripts doesn't change; a new copy is
  taken at that width instead. Content the app hasn't rendered, such as rows
  outside a virtualized list, isn't in the copy. In code a page copy is a
  `snapshot`.
- **Showing it.** The copy is shown in an `<iframe sandbox="allow-same-origin">`
  covering the page: no script in it runs, and the prototype's own styles can't
  reach it.
- **One mockup per thread.** Each mockup thread is its own proposal, so
  starting one first saves the frozen page as a new mockup, named after the
  message, then creates the thread on it. Comments added beforehand go to
  `mockups:create` as `linkedThreadIds`, which checks them with the same rule
  as `mockups:link` (the project's feedback threads, not deleted, at most 20)
  before storing anything and links them in the same step, so a refused link
  leaves no mockup behind and Critiqs AI reads them with the first request.
  The comment picker stops at 20. `threads:create` refuses a second thread on
  a mockup. Mockups made before
  this rule may have several threads; each is listed, and they share the
  mockup's copies and versions. A thread's requests change every copy of its
  mockup.
- **The panel.** Its state is one reducer value: the list, over a fresh
  freeze of the page, or one thread, with the copy and version shown. The
  freeze reads the host's context (screen, view state, persona), the address,
  and the page's record in the same moment as the page, and a new mockup
  saves those details, not the ones at Send, so its copy and details always
  describe one page. A thread on another page waits in the list for the
  reviewer's answer; cancelling after the prototype was asked to go there
  freezes the page again, since the prototype may show the other page now.
  The list reads `mockups:listPage` twice with Convex's `usePaginatedQuery`,
  20 mockups at first and 20 more per **Show more**, each mockup with its
  threads' summaries: this page's mockups (index on `source.screen`), so many
  newer mockups elsewhere never push a page's own out, and every other
  page's (the project's index, leaving that screen out with a filter inside
  `paginate`). A mockup is listed only once its thread exists: `listedAt` is
  set when its thread starts, moves with `updatedAt`, and is cleared when
  the thread is deleted, and both indexes are on `listedAt`, so pages never
  hold mockups without threads. Every message in a mockup thread, Critiqs
  AI's included, moves its mockup's `listedAt` to the message, and the panel
  sorts rows by `listedAt` too, so pages and rows agree. Convex keeps each
  live page's range, splits pages that grow too large, and keeps loaded
  pages as mockups change. Other pages' reads skip this page's mockups
  without a limit, so a screen with many thousands of mockups makes them
  slower, up to Convex's per-query read limit. "This page" ends with its
  **Show more**, and the other pages, still grouped by page, end with one;
  each says Loading… while more load and goes away once Convex says the list
  is exhausted. A page filled exactly to the end doesn't say it's the last,
  so one final **Show more** may add nothing before it goes away. A page that
  fails throws; this page's part and the other pages' part each sit in their
  own error boundary, which shows "Couldn't load … · Try again" and reads
  that part afresh, so one failing leaves the other and the panel in place.
  While a thread is open the list stays mounted, hidden, so going back keeps
  its loaded threads and scroll position; menus and dialogs left open in the
  hidden list don't block keys in the thread.
  `backfillListedAt` lists mockups whose thread came before `listedAt`.
  `mockups:list`, the project's 100 newest mockups and up to 300 of a given
  screen's in one query, stays for coding agents and older components. A
  mockup remembers the page's record when the page showed exactly one
  `data-critiqs-record`, such as a record's details. A thread is on its page only when the screen
  matches and, for a mockup with a record, the page shows that record; only
  then do Hold to compare and Take a copy work. Going to another page, or to
  another record of the same screen, calls the host's `restoreContext` with
  the mockup's screen, view state, and that record (record scope; shared
  scope when there is none), then waits up to three seconds for `getContext`
  to report the screen and view state and for the page to show the record.
  Without `restoreContext`, or when it refuses or the page doesn't appear,
  the thread opens on its own copy and says comparing with the live page
  isn't available. Versions no message carries, such as restores, show in
  the conversation at their time with the same card as Critiqs AI's replies,
  so the latest version is always marked.
- **Changes.** A version stores, for each copy, the whole list of changes from
  the original copy: CSS rules for the mockup's own stylesheet (media queries
  allowed), text, attributes, and inserting, replacing, or removing elements,
  addressed by `data-critiqs-node`. Viewing a version applies its list to the
  copy; restoring copies an earlier list into a new version. Inserted HTML is
  cleaned of scripts, frames, event attributes, and `javascript:` addresses
  before it's stored and again before it's shown.
- **Critiqs AI.** After a message in a mockup thread, the component sends the
  copy's description, focused on the visible part, to a Convex action. It
  checks access, a per-person rate limit, and the AI allowance, asks the
  project's model for a reply and changes (structured output, 120-second
  limit), checks and size-limits the changes, then saves the reply, marked
  `via: "ai"`, and the version together. If the version moved meanwhile, the
  answer is refused rather than dropping someone's change. When the request
  reaches past the visible part, the component asks again for the rest of the
  page, adding a version each time.
- **Uploads.** Files uploaded to the deployment's own Convex storage, page
  copies and (without R2) captures, are reserved first, like R2's
  `captureFiles`: `generateUploadUrl` records who may upload, to which
  project, for which purpose (`uploads`: `capture` or `pageCopy`), and returns
  the deployment's own route (`/capture/upload` or `/mockup/upload`,
  `?uploadId=`), which the component calls with the reviewer's sign-in. The
  route checks the reservation and the file's type before reading it, stores
  it, and records it on the reservation if the uploader may still add to the
  project. A file is attachable only by its uploader, in that project, for
  that purpose, and once across captures and page copies. Files stored before
  reservations have none: their existing captures and copies keep loading,
  but they can't be attached anew. Deleting a mockup deletes a copy's file
  only if no thread's capture or other copy uses it, and a refused request
  deletes only the caller's own unattached page-copy upload.

  Components released before reservations post page copies without the
  reviewer's sign-in, so each address also carries an upload grant
  (`&grant=`): a random secret for that reservation alone, stored only as its
  SHA-256. A request without a sign-in needs the grant; one with a sign-in
  must be the uploader's and carry the grant too. The grant works once and
  within 10 minutes, and the file it stores is attachable only by its
  uploader, so a leaked address lets nobody else attach anything. Returning
  Convex's own storage upload address to older components instead was
  rejected: nothing binds the file it stores to the reservation, so any
  storage ID could later be claimed, and its bytes would escape the limits
  below. A file stored through an address an older backend gave just before
  the deploy has no reservation; attaching it is refused with `reupload`,
  and the component uploads the file again and retries once. Older
  components show the refusal ("Upload the page copy again."), and trying
  again works.

  A person has at most 20 unfinished uploads: reserved or uploading in the
  last 10 minutes, or stored and not yet attached. A project's unfinished
  uploads hold at most 200 MB, the per-file limit times those 20 places: a
  reservation counts the most its purpose allows, and a stored file its size.
  Every 10 minutes, cleanup (`uploads.cleanUp`) removes expired reservations
  and, in one transaction, deletes files nothing attached within an hour with
  their reservations; a file that something uses after all is marked
  attached and kept. A stored file is attachable only within that hour. A
  file whose route stopped between storing it and recording it on its
  reservation has nothing pointing to it, and cleanup doesn't find it.
- **Storage and access.** Page copies are stored as files in the deployment's
  Convex storage and read only through the `/mockup/snapshot` route, which
  checks project access as the capture route does and streams the file as
  text, so a copy of up to 10 MB never passes through a function's return
  value. A mockup holds up to six copies, and their bytes count toward the
  project's image storage. Starting a mockup and adding a copy are actions, so
  a refused upload can be deleted; a refusing mutation would undo its own
  delete. Mockups, versions, and their links to threads are tables. A version
  stores at most 900 KB of changes, under Convex's 1 MiB document limit, and a
  mockup at most 8 MB across its versions, so reading it whole stays within
  one query. Mockup threads are threads with a `mockup` field; the thread
  list, search, export, and coding agents' feedback tools leave them out, so
  older components never show them. Critiqs AI's messages email nobody, add
  nobody to the thread, and can't be edited.
- **Coding agents (proposed, built).** `critiqs_mockups` and `critiqs_mockup`
  in `critiqs mcp` read mockups as the person who signed the computer in,
  through the same `mockups:list`, `mockups:get`, `mockups:threads`, and
  `threads:get` functions and `/mockup/snapshot` route as the component, with
  the same access checks; the list includes each copy's ID and width and
  each mockup's threads with their first messages. For
  each change that names an element, the tool reads the copy's HTML and
  returns that element's start tag, text, and nearest `data-critiqs-id`,
  found by scanning the HTML rather than parsing it with a DOM library, so
  the command line keeps no dependencies. The scan relies on copies being a
  browser's own serialization: double-quoted attributes and an end tag for
  every element that isn't void. It skips comments and the raw text of
  elements such as `style`, and counts a declarative shadow root's text as
  the host's. Elements an earlier change added aren't in the copy and are
  reported as such. The tools refuse backends without `mockups: true`
  before reading anything.
- **Compatibility.** The backend interface only grows, and the protocol stays
  5. `/critiqs/config` reports `mockups: true`; components hide Mockup mode
  without it, so the embedded SQLite server, which doesn't build mockups yet,
  keeps working unchanged.

## Shareable links

Links identify the thread or reply, rather than packing app state or
credentials. Preserve the app's existing URL parameters and routing. After sign-in,
open the requested message and use stored context to restore its view.

**Proposed, built in the pilot:** a link copied in the prototype is the
thread's saved page on the current prototype's origin, with one added
parameter: `?critiqs=<thread>` or `?critiqs=<thread>.<message>`. Email links
use the project's review address instead (see
[mentions and notifications](#mentions-and-notifications)). The component
removes the parameter after opening the message; a reviewer who isn't signed
in signs in first.

If an old route disappears, route mapping or a link through the app's root must
keep the thread reachable. A true short-link service and runnable historical
versions are optional later work.

## Open choices

The pilot implements a proposal for each of these; each still needs agreement:

- **Capture method:** DOM rendering, cropped to the visible view (above).
- **Default scope:** record-specific when the element belongs to a record, so
  feedback is never shown on another record. The composer offers "This record"
  and "All records".
- **Unread:** edits, reactions, and status changes do not make a thread unread.
- **Element IDs:** `data-critiqs-id` and `data-critiqs-record`. A selection uses the
  nearest element with a purpose ID.
- **Toolbar:** draggable sideways and collapsible. It moves to the top when it
  would cover the target. `C` toggles Comment mode; `V` returns to Browse mode,
  cancelling reattachment and keeping a new comment's text for `C`; Escape
  closes what is innermost. Ctrl or Cmd with `\` (or `|`) hides all of Critiqs,
  even while typing, and shows it again; hidden, Critiqs stays mounted but
  handles no page input, takes no focus, and marks nothing read, and the hidden
  state isn't kept across reloads. The account menu lists these shortcuts.
- **Storage limits:** images up to 10 MB, 500 messages per thread, and 200
  threads per export.

Agreed since the pilot: Critiqs Cloud's plans and their limits
([Free, Plus, and Pro](#free-plus-and-pro)).

Still open: how long deleted data is kept and whether it can be restored, who
may delete individual replies, supported routers, editing a project's preset tags, which provider and model Critiqs-managed
AI uses, and sidebar details against the Figma reference.

## Rename and deployment compatibility

The unreleased package now uses Critiqs throughout: `critiqs-react`, `<Critiqs />`,
the `critiqs` command, `CRITIQS_*` settings, and `/critiqs/config` and
`/critiqs/health`. The rename introduced protocol 3; protocol 4 additionally supports authenticated
R2 uploads and opaque capture IDs. Deploy the current matching interface. Deploy
matching backend functions and set the renamed environment variables before
using the new component with an existing deployment. Browser sessions, project
setup storage, and share links use the new `critiqs` names too, so reviewers
sign in again and developers configure the project's ID in their host app.
Existing pilot data is test data and is not migrated.

## Versioning and compatibility

**Agreed:** applications using an older Critiqs version keep working. Follow
these rules for any change to the package's public interface, the backend's
interface, or a release. Three versions are distinct:

- **Package version:** `critiqs-react`'s npm version. Its public interface is
  the component and its properties, exported types, `critiqs-react/server`,
  the `critiqs` command and MCP tools, and `CRITIQS_*` settings.
- **Backend protocol:** the number a backend reports at `/critiqs/config`,
  currently 5 (`BACKEND_PROTOCOL`). Protocol 5 adds tags, groups, search, and
  AI settings and keeps every protocol 4 call and argument; sign-in is
  unchanged, so the component accepts a protocol 4 sign-in service
  (`SIGN_IN_PROTOCOL`).
- **Prototype version:** the host app's build recorded with each message
  (see the [glossary](glossary.md)), unrelated to both.

**Agreed:** package versions follow standard [Semantic Versioning](https://semver.org/).
A stable version is MAJOR.MINOR.PATCH:

- **Patch** (1.4.2 to 1.4.3): backward-compatible fixes only.
- **Minor** (1.4.3 to 1.5.0): backward-compatible additions, such as a new
  optional property or command, or deprecating something without removing it.
  The patch number resets to 0.
- **Major** (1.5.0 to 2.0.0): any incompatible public change, such as removing
  or renaming a property, command, or setting, making an optional property
  required, or changing behavior host apps rely on. Minor and patch reset to 0.

npm's `^1.4.2` accepts any later 1.x release, including 1.5.0
([npm semantic versioning](https://docs.npmjs.com/about-semantic-versioning/)),
so a minor or patch release must never contain a breaking change. A launch may
have its own marketing name, but the name never decides the version: a
compatible fixes-only release is a patch, compatible features are a minor
release, and any incompatible public change is a major release.

**Current status:** the package is below 1.0.0 and ready to publish publicly
(the owner approved); it is not on npm yet.
Under Semantic Versioning, 0.x is initial development whose public interface
is not yet promised stable, and `^0.1.0` accepts only 0.1.x. That describes
the version number, not Critiqs's obligation: host apps already using Critiqs
keep working, and neither 0.x nor being unpublished permits breaking them. A
breaking change needs owner approval and explicit migration and coordination
with those apps, even before publication or 1.0.0. The rename above was a
pilot-specific exception, because its data was test data. When to publish,
and when to release 1.0.0, are the owner's decisions.

**Agreed:** older clients and backends. Publishing a release changes no
installed package; each app keeps its version until its developers upgrade. A
backend changes for every app using it when deployed: Critiqs Cloud serves all
prototypes, and copies of one prototype (local, preview, deployed) on different
package versions can share a self-hosted backend.

- A backend deployment keeps serving every supported older package version.
  Add to the backend interface rather than changing what those clients call.
- A new major package version does not by itself allow removing the backend
  interface older versions use. When an incompatible change is required, serve
  a versioned interface alongside the older supported one, and publish
  migration instructions for host developers.
- Remove an older interface only under a deprecation and support-window policy
  decided and documented here first. No duration is set yet, and support is
  not promised forever.
- Stored feedback survives upgrades through compatible migrations, as the
  SQLite store already migrates forward on start.

**Built:** the component refuses a backend whose protocol is below its own
(`config.protocol >= BACKEND_PROTOCOL`). That proves only that a backend is new
enough for the component, not that a newer backend still serves older ones.

**Built:** every pull request declares its release type in a release note,
and a generated release pull request calculates the version and changelog
from those notes ([releasing](releasing.md)). CI checks each note's form; reviewers
check that its type matches the change.

**Required before the first stable release, not built:** tests that run each
supported older package version against the current Convex and SQLite
backends, and the deprecation and support-window policy.

## Remaining before release

The pilot's data is test data and is not migrated.

1. **Contracts.** Built: permanent reviewer IDs and display names, Critiqs's own
   client types in place of Convex's generated types, and the client transport
   interface.
2. **Shared server logic.** Built for feedback: those rules run in
   `@critiqs/server`, and the same contract tests pass on Convex and on a SQLite
   store. Sign-in rules joined them in step 3.
3. **Email sign-in.** Built: email codes through Resend replace WorkOS,
   sessions end 90 days after sign-in, and the sign-in rules are shared.
4. **Thread window, mentions, and notifications.** Built.
5. **Critiqs Cloud.** Built: plans and limits, and Critiqs Cloud
   (`https://brazen-snail-591.convex.cloud`) as the component's default
   (`HOSTED_BACKEND_URL`). Agreed, not built: organizations, the Free,
   Plus, and Pro plans, per-token Critiqs AI credits, and billing through
   Autumn ([Plans and limits](#plans-and-limits)). Live billing also needs
   Stripe connected in Autumn, with the live Autumn keys set on the
   deployment. Remaining, each after owner approval: deploy the
   current backend there (it still runs an earlier one), with
   `CRITIQS_PLANS=enabled`, Resend's key, and a verified sending domain; then
   publish the npm package with the manual Publish workflow
   ([releasing](releasing.md#publishing-to-npm)). The owner approved public
   publication under the MIT license, and the name was unused on npm when
   checked. The release candidate builds ES modules and declarations, includes
   the Node `critiqs` CLI, and is checked with `npm pack --dry-run`, isolated
   React 18 and 19 consumers, and Vite and Next.js builds in CI. Private
   workspace code is bundled, so those packages do not need separate
   publication. Long lists are paginated.
6. **Setup tooling.** Built: `critiqs init` for Critiqs Cloud and team-owned
   Convex, `critiqs doctor`, the MCP server, and agent instructions. Deploying to
   a real Convex Cloud deployment with a deploy key is untested; the same
   deploy was tested against a local Convex backend.

Before release, verify real email-code sign-in, site consent, refresh rotation,
and sign-out on an HTTPS prototype, then repeat the two-reviewer pilot against
Critiqs Cloud. Local tests do not establish this.

After Critiqs Cloud, built: embedded SQLite (`critiqs-react/server`), with the
HTTP transport, captures in the database file, Critiqs's email-code sign-in or
the host app's own, migrations, and backup guidance. `examples/self-host` runs
the pilot this way.

## Technical references

[Resend email API](https://resend.com/docs/api-reference/emails/send-email),
[Bun](https://bun.sh/docs),
[Resend domains](https://resend.com/docs/dashboard/domains/introduction),
[Convex transactions](https://docs.convex.dev/database/advanced/occ),
[Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions),
[Convex self-hosting](https://docs.convex.dev/self-hosting),
[SQLite write-ahead logging](https://www.sqlite.org/wal.html),
[SQLite on Vercel](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel),
[OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[Convex file storage](https://docs.convex.dev/file-storage/overview),
[React IDs](https://react.dev/reference/react/useId),
[DOM capture limits](https://html2canvas.hertzen.com/documentation),
[modern-screenshot](https://github.com/qq15725/modern-screenshot),
[Convex custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt),
and [browser screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
