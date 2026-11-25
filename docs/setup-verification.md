# Verifying setup

How to check that a developer can add Critiqs to a React app and that
reviewers can then comment. Automated checks run on any computer; the rest
needs people, a deployed prototype, and a Critiqs Cloud backend that runs the
current version. Record what was run, on which commit, and what wasn't.

## Automated

| Command | What it shows |
| --- | --- |
| `bun run check` | Typecheck and every package's tests, including the installer's edits and refusals, environment variables, `.env` files and workspace apps, setup reuse, readiness, doctor, `requireProjectId` (no page changes or requests without a valid ID, cleanup when it goes away, quiet failures), remote approval (approval, waiting, denial, expiry, replay, another browser, rate limits), the release notes gate, and the packed package (`check:package`). |
| `bun run check:package` | The packed package in isolated npm consumers: React 18 and 19 mounts in production, server rendering, the `"use client"` entry, declarations, the CLI and MCP server, the license, and no credentials or local paths. |
| `bun run check:consumers` | After `bun run build`: Vite apps on React 18 and 19, and Next.js App Router and Pages Router apps, each set up by `critiqs init` with its project ID variable, unchanged by a second run, and built for production, some also for another deployment's project and with none; the App Router build is also served. Then a two-app npm workspace is set up one app at a time, served on one origin with Critiqs's SQLite server, and checked in Chrome: each app shows only its own feedback, and copies built without a project ID or with a malformed one add nothing and make no Critiqs requests, even with a project remembered on that origin. Needs the npm registry and Chrome or Chromium (`CHROME_PATH`); `CRITIQS_EVIDENCE_DIR` keeps screenshots. |
| `bun run measure:setup [report.json]` | After `bun run build`: times the developer's steps from installing the package to a saved comment read back after a restart, on a self-hosted SQLite server with the host app's sign-in, and lists what it can't measure. |

## With people and live services

These need the current backend deployed to Critiqs Cloud, which needs the
owner's approval, and Critiqs's email domain set up in Resend.

1. **Email sign-in.** In a new Vite or Next.js app, run
   `npx critiqs-react init` and sign in with a real address. Note how long the
   code takes to arrive. `npx critiqs-react doctor` should pass every check
   except, until one is sent, mention email delivery.
2. **Remote approval.** On a computer without a browser (for example over
   SSH), run `npx critiqs-react init --remote`. On a phone, open the printed
   address, enter the code, sign in, and approve. Then repeat and deny, and
   repeat and let the code expire: setup must report each, and create nothing.
3. **Two reviewers over HTTPS.** Deploy the app with its project ID (for an
   environment-backed ID, set the variable in the deployment's build settings,
   and deploy a second copy without it, which must show no Critiqs) to an
   HTTPS address and run `npx critiqs-react init --review-url <address>`.
   Reviewer A comments on an element in a hidden tab and mentions reviewer B.
   Reviewer B, on another computer, follows the email's link, sees the saved
   context, replies, and A sees the reply. Check site consent, refresh after
   15 minutes, and sign-out.
4. **Timing.** For a first-time developer, record each step's start and end:
   install, init up to the sign-in page, the email code's arrival, project
   created, first local comment, deploy, and reviewer B's first comment. Keep
   waits for email and deployment separate from the developer's own steps;
   don't claim a total that wasn't measured.

`measure:setup` is the local, repeatable part of step 4; the rest stays
pending until it is run with people.
