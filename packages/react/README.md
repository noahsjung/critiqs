# Critiqs for React

Reviewers comment directly on a running prototype, discuss feedback, and find
its original context as the prototype changes. Critiqs brings its own toolbar,
sidebar, sign-in, and styles. It works in any React 18 or 19 app: Vite, Create
React App, Next.js (App Router or Pages Router), Remix, or your own setup.
React and React DOM are peer dependencies; nothing else is required.

The browser package and setup CLI support Node.js 20 or later. The optional
`critiqs-react/server` SQLite server needs Node.js 22.13 or later, or Bun;
Node.js 20 does not include the built-in SQLite module.

## Set up in two commands

```sh
npm install critiqs-react          # or: pnpm add, yarn add, bun add
npx critiqs-react init
```

`npx critiqs-react init` runs Critiqs's setup command, `critiqs`, from the
shared `critiqs` package that `critiqs-react` installs (`npx critiqs init` is
the same command). It adds `<Critiqs />` where your app renders, signs you in through
your browser, creates a project on Critiqs Cloud, and connects the app to it.
Critiqs Cloud runs storage, sign-in, and email, so there are no keys to enter.
The project ID is public configuration, not a secret; reviewers never see or
enter it.

The result is one import and one component. In a Vite or Next.js app, the
component reads the project ID from the app's public environment variable, and
init sets that variable in `.env.local` on your computer:

```tsx
import { Critiqs } from "critiqs-react";

<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />
// Next.js: projectId={process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID}
```

```sh
# .env.local (this computer only; init adds an empty entry to .env.example)
VITE_CRITIQS_PROJECT_ID=<project ID>
```

With `requireProjectId`, Critiqs appears only where the variable holds a
valid project ID: a copy built without it adds nothing to the page and
contacts no backend. In other builds, init writes the ID into the component
instead (`<Critiqs projectId="<project ID>" />`), and every copy shares that
project.

Init finishes with where setup stands: the code, the project, trying it
locally, deployments, and what reviewers on other computers still need. Then:

1. Start (or restart) your dev server, open the prototype, and sign in from
   the Critiqs toolbar to leave a comment.
2. Commit the code change (not `.env.local`). In each deployment that should
   show Critiqs, set the variable in its build settings, and record the
   deployed address, including any path such as `/my-prototype/`, so mention
   emails from every copy open it:
   `npx critiqs-react init --review-url https://<deployed address>`.
3. `npx critiqs-react doctor` checks the setup at any time.

### Each app and deployment chooses its project

The project ID is an environment setting, so the same commit can be deployed
from different branches or environments with different projects, or with
none:

| Deployment | Setting | Result |
| --- | --- | --- |
| Your computer | `.env.local`, written by init | Your project |
| A preview or staging deployment | `VITE_CRITIQS_PROJECT_ID=<staging project>` in its build settings | Its own feedback |
| Production for customers | unset | No Critiqs at all |
| Another deployment that shares feedback | the same ID | Shared feedback |

- **Built in, not read at run time.** Vite and Next.js copy `VITE_…` and
  `NEXT_PUBLIC_…` values into the browser build when the app is built, so set
  them in each deployment's build settings and rebuild after changing one.
  Production-mode builds work the same way; Critiqs doesn't look at
  `NODE_ENV`. If you build once and promote the same files through several
  environments, read the ID from your own runtime configuration and pass it
  to `projectId` yourself, keeping `requireProjectId`.
- **Wrong or unreachable settings stay out of sight.** A value that isn't a
  project ID, a project the backend doesn't know, or a backend that can't be
  reached shows visitors nothing; the browser console says what's wrong, and
  `npx critiqs-react doctor` checks this computer's setting against the
  backend. Doctor can't see a deployment's build settings.
- **Nothing is remembered in the browser.** With `requireProjectId`, Critiqs
  never falls back to a project set up in the sidebar, so two apps on one site
  (say `/` and `/admin/`) can't pick up each other's project.
- **Other builds.** Any React app can do the same by hand: pass its own public
  setting as `projectId` and add `requireProjectId`. Without
  `requireProjectId`, a component with no project ID shows project setup in its
  sidebar, as before.

### Monorepos: one project per app

In a workspace (npm, Yarn, pnpm, or Bun), run init once for each app with
`--dir`. Each app gets its own project and its own variable, named after the
app (`VITE_CRITIQS_PROJECT_ID_ADMIN`, `NEXT_PUBLIC_CRITIQS_PROJECT_ID_WEB`),
so a value shared by the whole workspace, such as a root `.env` or one build
job that builds every app, can't connect them all to one project. Projects are
named after the workspace and the app (`acme/admin`), and an app whose package
name another workspace package shares is named by its path.
Names that become the same environment-variable name (such as `a-b` and
`a_b`) receive a stable suffix from the app's path, so shared environment
files keep separate project settings.

```sh
npx critiqs-react init --dir apps/admin
npx critiqs-react init --dir apps/web
```

Run at the workspace root, init lists the apps and these commands and changes
nothing (at a terminal, it asks which app). Init writes only the chosen app's
files: its entry, and the `.env.local` and `.env.example` it loads. A Vite app
whose config sets `envDir` to a literal path or `resolve(__dirname, "…")`
gets its setting in that folder; for anything else, name the file with
`--project-env-file`, and pass the same option to `doctor` when checking it. Init adds
Critiqs to the app's entry, where it calls
`createRoot`, so another app that imports this app's components doesn't bring
its Critiqs along.

### Where init adds Critiqs

| App | Where | You can also add it yourself |
| --- | --- | --- |
| Vite, Create React App, and other single-page apps | beside `<App />` in the file that calls `createRoot(…).render(…)` or `ReactDOM.render(…)` | `root.render(<><App /><Critiqs /></>)` |
| Next.js App Router | inside `<body>` in `app/layout.tsx`. The layout stays a server component: the package marks `<Critiqs />` as a client component | `<body>{children}<Critiqs /></body>` |
| Next.js Pages Router | beside `<Component {...pageProps} />` in `pages/_app.tsx` | `<><Component {...pageProps} /><Critiqs /></>` |
| Server-rendered apps (`hydrateRoot`), Remix, and others | beside the element `hydrateRoot` receives, or the component every page renders | `<Critiqs />` renders nothing on the server, so hydration is unaffected |
| Anything else | name the file and element: `npx critiqs-react init --entry src/Shell.tsx --mount Outlet` | |

Init edits one source file, and only when it can tell exactly where: it
previews the change with `--dry-run`, and it refuses, changing nothing, when
there are several roots, when Critiqs is already loaded another way
(re-exported, as a namespace, or at run time), or when the name `Critiqs`
means something else there. It then prints the line to add by hand. A
`<Critiqs />` imported under another name is updated like any other. It checks
the source and `.env` files can be written before you sign in. Running init
again keeps the project the code already names, through a literal ID or the
variable's value in your `.env` files; a missing or malformed value doesn't
count, so init connects one. It keeps your other `.env` lines and values, a
component's other properties, and wiring you wrote yourself
(`projectId={import.meta.env.VITE_MY_PROJECT}` is set as it is; other code is
left alone). A retry after an interrupted run reuses your project with the
same name rather than creating another. `--new-project` creates a new one.

### Signing in from another device

On a remote machine, in a container, or with a coding agent, there may be no
browser to open. `npx critiqs-react init --remote` (automatic over SSH or without a
desktop) prints an address and a short code instead:

```
Approve this setup from a browser on any device:
  1. Open https://<sign-in service>/auth/device
  2. Enter the code BCDF-GHJK
  3. Sign in with your email and choose Approve.
```

Setup waits while you approve on your phone or laptop. The code works for 10
minutes and once; setup receives a 15-minute access token, only to create or
connect the project, and no lasting session. If the sign-in service doesn't
offer this yet, init says so: run it where a browser can open, or create the
project in the matching prototype's Critiqs sidebar and set its public
`projectId` on the existing component, keeping its `backend` property.

### If something goes wrong

| Message | What to do |
| --- | --- |
| Init didn't find where the app renders | Run with `--entry <file>` (and `--mount <Element>`), or add `<Critiqs />` by hand and run `npx critiqs-react init` again. |
| Found several places the app could render Critiqs | Choose one with `--entry`; in a monorepo, run init in the app's folder or pass `--dir`. |
| … is a workspace with 2 apps | Run one of the printed `init --dir <app>` commands for each app. |
| Sets projectId from code | Init doesn't edit computed values. Set the printed ID where your code reads it. |
| Sets envDir in a way init can't follow | Pass `--project-env-file <the .env.local file Vite loads>`, relative to the app. |
| Sets envPrefix | Give `<Critiqs />` `projectId={import.meta.env.<a name with your prefix>} requireProjectId`, then run init again. |
| Couldn't write `.env.local` after the project was created | Add the printed `NAME=<project ID>` line to that file yourself; the project and component are already in place. |
| Sign-in took too long, or Setup was denied | Run init again; nothing was created. |
| Source became unreadable or unwritable during setup | The result keeps the created project ID and backend. Restore file access and apply the complete component snippet shown, at the indicated entry/mount, and the `.env` line it names. Preserve its backend and update an existing component rather than adding another. |
| The code already uses project … | Nothing was changed. Use `--new-project` to replace it, or `--review-url` to set its review address. |
| No review address, or one that only opens on this computer or a private network (such as Tailscale) | If reviewers use a deployed copy, run `npx critiqs-react init --review-url https://<deployed address>`, or change it in the Critiqs sidebar's Project setup. |
| Critiqs Cloud isn't ready for this version | The hosted service runs an older backend; wait for it, or use your own Convex deployment. |

`npx critiqs-react doctor` checks the component, the backend and its version,
sign-in, the project, its review address, and email. Each check says whether
it read configuration or something the backend has actually done; doctor never
sends an email, uploads a screenshot, or posts a comment, so the first real
comment is what proves those work. AI is optional and doctor reports it as
information. `--json` prints init's and doctor's results for scripts and coding
agents. Coding agents can follow [AGENT_SETUP.md](../critiqs/AGENT_SETUP.md); an optional
MCP server (`npx critiqs-react mcp`) offers the same steps.

Coding agents can also read a project's feedback with its context, to act on
it: run `npx critiqs-react sign-in` once on the computer (or let the agent call
`critiqs_sign_in`), then the MCP server's `critiqs_comments`, `critiqs_thread`,
and `critiqs_screenshot` tools read threads, filtered by status, author, time,
tag, screen, or text, and `critiqs_reply` posts a reply as you, marked "via
coding agent", to ask people to check a fix. `critiqs_mockups` and
`critiqs_mockup` read mockups: each change Critiqs AI made to a page copy,
with the original element's markup and `data-critiqs-id` to find it in the
code, and the discussion behind it. The sign-in lasts until `npx critiqs-react sign-out`, 30
days without use, or 90 days. It is sent only to the backends it was approved
for, and to where each serves screenshots and page copies; the approval page
names them. For a backend other than Critiqs Cloud, sign in with
`npx critiqs-react sign-in --backend '<origin>'`, which needs that backend's
sign-in service to run the current Critiqs backend. A version of this package
from before this change, on the same computer, asks to sign in again. See [AGENT_SETUP.md](../critiqs/AGENT_SETUP.md#7-reading-feedback).

### Keeping feedback on your own backend

Critiqs Cloud is the default. To keep feedback on your team's own Convex
deployment instead, run `npx critiqs-react init --own-convex`: it deploys
Critiqs's functions there and asks only for a production Convex deploy key
(`CONVEX_DEPLOY_KEY`), plus a Resend key if you want mention emails, then also
writes `backend="https://<deployment>.convex.cloud"`. `--backend <url>` uses a
Critiqs backend that is already deployed. To run Critiqs inside your own Node or
Bun server instead, see [self-hosting](#self-hosting-inside-your-apps-server).

## Optional: more context for feedback

Optional properties record the prototype version and let the host app report
and restore context: `version`, `getContext`, and `restoreContext`. The package
exports their TypeScript types: `CritiqsProps`, `HostContext`, `RestoreRequest`,
`Scope`, and `ViewState`. Elements marked `data-critiqs-mask` are covered in captures.
For canvas, video or iframe content, mark a containing element: directly marked
media fail automatic capture safely because the renderer replaces their nodes
without retaining the privacy marker. The comment still saves with the reason.

Opening a thread from the list or a link, or choosing **Show in prototype**,
shows its target in the screen and view state where it was left. Unless that
view is already shown, Critiqs calls `restoreContext`, then waits up to three
seconds for `getContext` to report the thread's screen and view state and for
the target to appear; a matching element in another view doesn't count. Return
a promise to wait for slower content first, or `false` to decline, for example
to keep unsaved work. Report each key whenever its part of the app is shown,
with null when nothing is open; once `restoreContext` has run, a key an older
thread lacks is left to it. Report only state that `restoreContext` can set again;
if it keeps the current record for shared feedback, keep that record's ID out
of the view state.
Captures leave out every mounted Critiqs, including its pins and windows.

## Tags, search, and AI

Reviewers tag threads with the project's tags or by writing hashtags such as
`#wording` in comments; typing `#` suggests the project's tags. The project's
owner gathers related tags into shared groups (the Tags and AI button in the
sidebar), which everyone can filter by. The sidebar's search field finds
threads by words and `#tags`.

With AI, new tags are grouped automatically, searches can be plain questions,
and results come with insights that cite their threads. A project uses
Critiqs-managed AI where the deployment offers it, or its owner connects the
project's own OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI
Gateway, or OpenAI-compatible provider in the same dialog, in three steps:
the provider, the key, and the models to offer, from the provider's list or
typed by name. Critiqs AI may offer several models, each costing its credits
per request; the owner picks the project's model and which models it allows. In Mockup mode, a **Model**
menu beside Send chooses among the models a person's AI offers, when there
are several.

Everyone has Critiqs AI where the deployment offers it, with nothing to set
up. **Your AI** in the avatar menu chooses its model by name, shows the
credits used against the plan with **Upgrade** where the deployment names an
upgrade page, and sets up the person's own API key in three steps instead. The
owner's **Who pays** decides which one the requests people start use:
**Project pays, personal allowed** (the default: the project pays unless
someone chooses their own), **Project pays**, or **Each person pays** (Critiqs
AI on each person's own plan, or their own key). Automatic grouping always
uses the project's AI. Your AI is offered on backends that keep it.

Keys go to the backend once, are stored encrypted, and never return to
browsers. AI is optional: without
it, commenting, replies, mentions, and tags work as usual, search is labeled
basic, and grouping is manual. Nobody installing the component is asked for an
AI key.

On your own Convex deployment, set `CRITIQS_AI_ENCRYPTION_KEY` (32 or more
random characters, such as from `openssl rand -base64 32`) so owners can save
keys, and optionally `CRITIQS_AI_PROVIDER`, `CRITIQS_AI_MODEL`, and
`CRITIQS_AI_API_KEY` for a provider every project uses by default.
`CRITIQS_AI_ALLOWED_ENDPOINTS` lists custom endpoint addresses owners may
enter. The same encryption key lets each person connect their own Linear
account in **Your trackers…**, in the avatar menu, with a Linear API key; with
`CRITIQS_LINEAR_CLIENT_ID` and `CRITIQS_LINEAR_CLIENT_SECRET` from your own
Linear OAuth app, whose callback is
`https://<deployment>.convex.site/trackers/linear/callback`, they sign in to
Linear instead. GitHub Issues works the same way: people paste a fine-grained
personal access token, or, with `CRITIQS_GITHUB_CLIENT_ID`,
`CRITIQS_GITHUB_CLIENT_SECRET`, and `CRITIQS_GITHUB_APP_SLUG` from your own
GitHub App (callback
`https://<deployment>.convex.site/trackers/github/callback`), sign in through
it. After upgrading an existing deployment, run
`npx convex run tags:backfill` once so earlier comments gain their hashtags,
and `npx convex run projects:shortenLongNames` once so project names from
before the 200-character limit are shortened to fit it.

The sidebar follows the mode. In Browse mode it shows the project: its open
and unread threads, who has access, your email notifications, and the project
ID. On a backend that keeps organizations' members, admins of the project's
organization add people by email, remove members, withdraw invites, and choose
who can comment from Who has access. In Comment mode it shows the threads.

Keyboard shortcuts: **C** Comment mode, **V** Browse mode, **M** Mockup mode,
**Escape** closes what is innermost, ending with the side panel, without
changing the mode, and **Ctrl or Cmd + `\`** hides or shows all of Critiqs.

### For a deployment's operator: Critiqs-managed AI

Critiqs-managed AI is configured once, on the backend, for every project; it
needs no change in host apps. On the Convex deployment, set these from your
own terminal, typing each value into the command's standard input rather than
on the command line, for example `npx convex env set CRITIQS_MANAGED_AI_API_KEY`:

| Setting | Value |
| --- | --- |
| `CRITIQS_MANAGED_AI` | `enabled` |
| `CRITIQS_MANAGED_AI_PROVIDER` | `openai`, `anthropic`, `google`, `openrouter`, `gateway`, or `compatible` |
| `CRITIQS_MANAGED_AI_MODELS` | The models on offer, as JSON: `[{"id":"claude-opus-5-5","label":"Claude Opus 5.5","model":"<provider's name>","price":{"input":4,"output":20}}, …]`; people choose them by `label`, and the first is the default. A model with a `price` (US dollars per million input and output tokens) charges each request by its tokens; a model with `credits` instead charges that flat amount per request |
| `CRITIQS_MANAGED_AI_MODEL` | Instead of `CRITIQS_MANAGED_AI_MODELS`: one model, the provider's name for it, shown as "Critiqs AI" and costing 1 credit a request |
| `CRITIQS_MANAGED_AI_PRICE` | Optional, with `CRITIQS_MANAGED_AI_MODEL`: its price as JSON, such as `{"input":4,"output":20}`, so requests are charged by their tokens |
| `CRITIQS_MANAGED_AI_API_KEY` | The provider key (optional only for `compatible`) |
| `CRITIQS_MANAGED_AI_BASE_URL` | Optional: the endpoint for `compatible` |
| `CRITIQS_UPGRADE_URL` | Optional, with plans: the https page where people upgrade, linked as **Upgrade** (with billing, **Upgrade** opens **Plan and billing** instead) |

Models from several makers share one provider, key, and address, so offer them
through a gateway that serves them all, such as Vercel AI Gateway
(`gateway`) or OpenRouter. For example, with the gateway's names for each
model and their list prices:

```json
[
  { "id": "claude-opus-5-5", "label": "Claude Opus 5.5", "model": "anthropic/claude-opus-5.5", "price": { "input": 4, "output": 20 } },
  { "id": "claude-haiku-5-5", "label": "Claude Haiku 5.5", "model": "anthropic/claude-haiku-5.5", "price": { "input": 0.1, "output": 0.5 } },
  { "id": "gemini-4-neon", "label": "Gemini 4 Neon", "model": "google/gemini-4-neon", "price": { "input": 3, "output": 15 } },
  { "id": "gpt-6-2-sol", "label": "GPT-6.2 Sol", "model": "openai/gpt-6.2-sol", "price": { "input": 2, "output": 10 } }
]
```

Check each `model` against the gateway's model list before deploying.

A priced request costs twice its API cost, in credits of 1 cent: `ceil(cost in
dollars × 200)`, at least 1. The cost is what OpenRouter or Vercel AI Gateway
reports charging (with a key of one's own there, the provider's charge
included), or otherwise the request's input tokens (cached ones included) and
output tokens (reasoning included) at the model's price. Before asking the
model, a request holds the most it could cost (each byte of its text as an
input token, and its longest answer) and starts only if that fits in what its
payer's organization may still spend this month, extra credits up to its cap
included, counting other requests still in flight. Once the model
answers, the request is counted at its real cost; one that fails costs
nothing. A hold lasts at most 10 minutes, so a request that never finishes
doesn't block its payer. People see each priced model's cost as "about N
credits": what a request of 2,000 input and 1,000 output tokens costs, such as
about 6 credits for Claude Opus 5.5 above.

Managed AI stays off until the provider, models, and key are all set. Check it
with `npx critiqs-react doctor` (or the backend's `/critiqs/health`, whose
`ai.managed` is `true`, or whose `ai.managedProblem` says what's wrong); like
every health check, that reads configuration without calling the model.

### For Critiqs Cloud's operator: payment through Autumn

Critiqs Cloud takes payment for its plans through [Autumn](https://useautumn.com),
which runs Stripe. Other deployments leave this off: without these settings
nothing calls Autumn, the webhook route answers 404, and `/critiqs/config`
doesn't report `billing`. Billing needs plans on (`CRITIQS_PLANS=enabled`).
Set these on the Convex deployment, typing secret values into standard input
as above:

| Setting | Value |
| --- | --- |
| `CRITIQS_BILLING` | `autumn` |
| `AUTUMN_SECRET_KEY` | Autumn's secret key: `am_sk_test_…` for its sandbox, `am_sk_live_…` for real payments |
| `AUTUMN_WEBHOOK_SECRET` | The `whsec_…` secret Autumn shows once when you add the webhook below |
| `AUTUMN_API_URL` | Optional: another Autumn address, such as a local stand-in for testing |

In Autumn's dashboard (Developer, then Webhooks), add an endpoint at
`https://<deployment>.convex.site/critiqs/billing/autumn` for `billing.updated`,
in the same environment as the key. Each verified message makes Critiqs read
the organization's subscription from Autumn again before it answers, so
messages that arrive twice, late, or out of order change nothing more. When
Autumn can't be read, the webhook answers 503 and Autumn sends it again later.
`/critiqs/health` reports `billing` with the key's environment and whether the
webhook secret is set, never the keys.

Autumn's catalog needs the plans `free` (enabled for every new customer), `plus`,
and `pro`, the add-on `storage_100gb` granting 100 `extra_storage_gb`, and the
metered feature `ai_credits`. An organization is Autumn's customer, with the
organization's ID, its name, and the email of the admin who first opened
billing. Prices live in Autumn; what each plan allows stays in Critiqs's plans
(`plans:set`), and the page shows each plan's limits from there, through
`billing:status`'s `plans`, so changing a plan's limits changes the page.
Until the backend has read Autumn's prices, changes that would charge the card
on file (between Plus and Pro, adding storage) are paused; buying on Stripe
Checkout, which shows the price, going back to Free, and removing storage
still work.

People use it from **Plan and billing** in the avatar menu, which every
**Upgrade** button opens on such deployments, on the organization whose plan
it shows: the person's home organization from **Your AI**, the project's
elsewhere, closing the dialog it was in. Members of an organization see
its plan, renewal or end date, credits and images used, and the cap on extra
credits; its admins upgrade, switch, go back to Free, keep a plan they had
cancelled, set the cap, add or remove Pro's extra storage, and open Stripe's
portal. A change that charges the card on file or ends something says what it
does and costs before it is made, naming the organization. Stripe returns to
the same page, which waits for the payment to arrive and allows no other
change meanwhile. Dates are the days Autumn's periods end, in UTC.

- **Plans.** An admin buying Plus or Pro with nothing billed pays on Stripe
  Checkout, even with a card on file. Each change names the plan the page
  showed as billed (`from`); when Autumn bills another by then, as when a
  payment arrived meanwhile, it is refused and nothing is charged. Between Plus
  and Pro with a card on file, Autumn charges an upgrade at once,
  prorated, and moves a downgrade to the end of the period. Going back to Free
  cancels at the end of the period. A renewal that fails (`past_due`) keeps the
  paid plan; when Stripe gives up, the organization is on Free. Free after a
  downgrade to Plus was scheduled drops the downgrade and ends the paid plan
  with its period. A changed plan starts from its default cap on extra credits.
  Stripe sends people back only to the site they signed in from.
- **Storage.** Pro organizations can buy a 100 GB storage add-on. Autumn makes
  each attach its own subscription, so add-ons attached elsewhere (such as
  Autumn's dashboard) stack: two grant 200 GB. Critiqs grants 100 GB for each
  active add-on and shows those that renew. Removing storage cancels one at the
  end of its period; leaving Pro cancels all of them with Pro, and keeping Pro
  before then restores those, but not one the admin removed.
- **Usage.** Each Critiqs AI charge to an organization on Plus or Pro is
  queued in the same transaction and reported to Autumn's `ai_credits` at
  once, then each minute until Autumn has it, with the time it was used, in
  full past the plan's included credits (Critiqs enforces the cap), and with
  its own idempotency key, so retries never count twice. Autumn counts usage
  in the billing period current when the report arrives, whatever its time
  says, so usage still being sent when the month turns over (UTC, when plans
  renew) is billed in the new month, and usage held up by an Autumn outage is
  billed in the month it gets through. Autumn remembers a key for 24 hours,
  so a report already tried but not sent within 20 hours of use is never
  sent again: it is kept as `failed` in the `billingUsage` table and logged.
  A report never tried is still sent, however old.
  `npx convex run billing:failedUsage` lists the failed reports with their
  credits per organization, which were never billed.
- **Plans an operator assigns** (`plans:assign`) stay until the organization's
  Autumn subscription next changes. `billing:status` reports the plan whose
  limits apply as `plan` and the billed one as `subscription.plan`, so such a
  plan has no `subscription`: the page says Critiqs set it, and buying a plan
  starts a subscription on Checkout that replaces it.

A daily check reads every organization with an Autumn customer or a paid plan
from Autumn again, catching anything a lost webhook missed. Run it at any time,
for example after first setting the webhook, with
`npx convex run billing:reconcile`, or for one organization with
`npx convex run billing:sync '{"organizationId":"..."}'`.

## Screenshot storage on Convex

Convex deployments can store screenshots in a private Cloudflare R2 bucket,
keeping comments, image metadata, and access checks in Convex. Configure
`CRITIQS_CAPTURE_STORAGE=r2` and `CRITIQS_R2_ACCOUNT_ID`, `CRITIQS_R2_BUCKET`,
`CRITIQS_R2_ACCESS_KEY_ID`, and `CRITIQS_R2_SECRET_ACCESS_KEY` on the backend.
Deploy matching protocol-4 functions and package. Keep the bucket private and
restrict its API token to that bucket. The host app needs no R2 keys or code
changes. Existing Convex captures remain readable; incomplete R2 setup fails
explicitly. `critiqs doctor` checks configuration; a real upload verifies access.

## Self-hosting inside your app's server

If your prototype has its own long-running Node or Bun server with a disk that
survives restarts, Critiqs can run inside it and keep feedback in a SQLite file.
No Critiqs service is involved. Static hosts and serverless platforms such as
Vercel can't keep the file; use Critiqs Cloud or your own Convex there.
`critiqs-react/server` is the shared package's `critiqs/server`; either import
works.

```ts
import { createCritiqsHandler, toNodeListener } from "critiqs-react/server";

const critiqs = await createCritiqsHandler({
  database: "critiqs.sqlite",
  email: { resendApiKey: process.env.RESEND_API_KEY!, from: "Critiqs <critiqs@example.com>" },
});

// Bun, or any server built on web requests:
Bun.serve({
  fetch: (request, server) =>
    new URL(request.url).pathname.startsWith("/critiqs")
      ? critiqs.fetch(request, { remoteAddress: server.requestIP(request)?.address })
      : app(request),
});
// Node: http.createServer(toNodeListener(critiqs)) for requests under /critiqs.
```

Then point the component at it: `<Critiqs backend="/critiqs" projectId="…" />`.
Reviewers sign in with an emailed code. To use your app's own sign-in instead,
pass `identify: (request) => ({ id, name, email })` for whoever the request's
session belongs to, or null. While developing without a Resend key,
`developmentSignIn: true` shows codes on screen, only for connections from this
computer (pass `remoteAddress` as above; the Node listener does it for you).
Captures must be PNG, JPEG, WebP, or GIF.

For AI, pass `ai`, read from your server's environment:

```ts
const critiqs = await createCritiqsHandler({
  database: "critiqs.sqlite",
  ai: {
    // A provider for every project; omit for none. A local Ollama: provider "compatible", baseURL "http://localhost:11434/v1".
    provider: "openai",
    model: process.env.CRITIQS_AI_MODEL!,
    apiKey: process.env.OPENAI_API_KEY,
    // Lets project owners connect their own provider in Critiqs, with keys stored encrypted.
    encryptionKey: process.env.CRITIQS_AI_ENCRYPTION_KEY,
    allowedEndpoints: ["https://llm.example.com/v1"],
  },
});
```

Model requests and providers' model lists come from this server, so
`localhost` means this server's machine. Existing feedback gains its hashtags when the database upgrades on start.
Back up the database with SQLite's online backup
(`sqlite3 critiqs.sqlite ".backup backup.sqlite"`).

The first-release API and interaction choices remain provisional. See the
[project documentation](https://github.com/noahsjung/critiqs/tree/main/docs)
for agreed behavior, proposed choices, and own-backend setup.

Critiqs is released under the [MIT license](LICENSE).
