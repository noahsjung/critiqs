# Setting up Critiqs: instructions for coding agents

Critiqs lets reviewers comment directly on a running React prototype. It is one
component, `<Critiqs />`, from the `critiqs-react` package, and works in any
React 18 or 19 app: Vite, Create React App, Next.js (App Router or Pages
Router), server-rendered apps, and custom setups. The command line is enough;
the MCP server (step 5) is optional.

The setup CLI supports Node.js 20 or later. For the optional embedded SQLite
server use Node.js 22.13 or later, or Bun. Node.js 20 can build the browser
integration and run setup, but cannot run the built-in SQLite server.

Never ask the person to paste keys, tokens, or sign-in codes into the
conversation. Critiqs Cloud, the default, needs none. AI is optional: don't set
it up unless asked.

## 1. Install the package

Use the project's own package manager, as its lockfile shows:

```sh
npm install critiqs-react      # pnpm add / yarn add / bun add critiqs-react
```

Run the commands below in the app's folder (the one with its `package.json`),
or pass `--dir <folder>`. Use `npx critiqs-react …` (or `pnpm exec`, `yarn`,
`bunx`); the command inside the package is named `critiqs`.

**Monorepos:** each app gets its own project. Run init once per app with
`--dir apps/<app>`; at the workspace root, init lists the apps with these exact
commands and changes nothing. Ask the person which apps should have Critiqs;
never connect two apps to one project unless they ask for that.

## 2. Add the component and create the project

```sh
npx critiqs-react init --json
```

Init adds `<Critiqs />` and its import where the app renders: beside `<App />`
in a `createRoot(…).render(…)` or `ReactDOM.render(…)` call, inside `<body>` in
a Next.js `app/layout.tsx` (the layout stays a server component; the package
declares the client boundary), beside `<Component {...pageProps} />` in
`pages/_app.tsx`, or beside the element `hydrateRoot` receives. For other
structures, name the file and element:
`npx critiqs-react init --entry src/Shell.tsx --mount Outlet`. Preview with
`npx critiqs-react init <projectId> --dry-run` when the project already exists.

Then init signs the person in and creates the project:

- **Browser on this computer:** init opens a sign-in page. Tell the person to
  sign in there with their email.
- **No browser here** (SSH, a container, a cloud agent): pass `--remote`, or
  let init choose it. It prints an address and a code such as `BCDF-GHJK`. Give
  both to the person exactly and ask them to open the address on any device,
  enter the code, sign in, and choose Approve. The code expires after 10
  minutes. Never ask them to send you the email code.

With `--json`, standard output is one JSON object; progress, including the
address and code, goes to standard error. The result's `stages` say where
setup stands: `Code`, `Project`, `Try it locally`, and `Reviewers elsewhere`,
each `pass`, `warn`, `fail`, or `next`. Report them to the person, including
any `warn` (such as a missing review address) and every `next` step they must
take themselves (run the dev server, deploy).

In a Vite or Next.js app, init makes the component read the app's public
variable, `<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />`
(`process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID` in Next.js; workspace apps get a
name with the app's suffix, such as `VITE_CRITIQS_PROJECT_ID_ADMIN`), sets it
in the app's `.env.local`, and lists it empty in `.env.example`. The result's
`env` names the variable and file, and the `Deployments` stage says what to
do: commit the code change but not `.env.local`, and tell the person to set the
variable in the build settings of each deployment that should show Critiqs,
leaving it unset where Critiqs shouldn't appear. The value is built into the
app, so changing it needs a rebuild. Other builds get the ID written into the
component; commit it. The project ID is public configuration, not a secret.

Running init again is safe: it keeps the project the code names (a literal ID,
or the variable's value in `.env` files), and after an interrupted run it
reuses the person's project with the same name. Only pass `--new-project` when
the person wants another project. Init never edits code that computes the ID,
or a wrapper the person wrote; it prints what to set instead.

If the person already has a project ID, connect it instead:
`npx critiqs-react init <projectId>` (no sign-in needed). It sets the variable
when the component reads one.

## 3. Check the setup

```sh
npx critiqs-react doctor --json
```

`ok` is false when any check `fail`s. Each check has a `stage` (`code`,
`service`, `project`, `reviewers`, `optional`) and a `basis`: `configuration`
means the settings are in place; `observed` means the backend has actually
done it (such as sending a mention email). Doctor never sends email, uploads a
screenshot, or posts a comment, so don't report those as proven; the first real
comment proves them. `info` (AI off) is not a problem. For an environment-backed
ID, doctor checks the value in this computer's `.env` files against the
backend; it can't see a deployment's build settings, and says so in the
`Deployments` check.
If setup used `--project-env-file`, pass the same file to doctor, for example
`npx critiqs-react doctor --project-env-file config/.env.local --json` (or `envFile`
on `critiqs_doctor`). If the environment directory cannot be determined,
doctor reports that uncertainty instead of saying the app is disabled.

Once the prototype is deployed, record its address, including any path, so
mention emails from every copy open it:
`npx critiqs-react init --review-url https://<deployed address>`. Don't guess
it from a local, private, or Tailscale address; ask the person if unsure. Then ask
the person to open the deployed prototype and leave a comment.

## 4. When something fails

| Output | Do this |
| --- | --- |
| `Init didn't find where the app renders` | Find the file that renders the app's root and rerun with `--entry <file>` (and `--mount <Element>`), or add `<Critiqs />` there by hand and rerun init. |
| `Found several places the app could render Critiqs` | Ask which app this is; rerun with `--entry`, or in that app's folder. |
| `is a workspace with … apps` | Ask which apps should have Critiqs; run the printed `--dir` command for each. |
| `sets envDir in a way init can't follow` | Find the `.env.local` the app's Vite config loads and rerun with `--project-env-file <file>`, relative to the app. |
| `sets envPrefix` | Give `<Critiqs />` `projectId={import.meta.env.<name with the app's prefix>} requireProjectId`, then rerun init. |
| `Couldn't write .env.local` after the project was created | Add the printed `NAME=<project ID>` line to that file; the project and component already exist. |
| `uses Critiqs under another name` | Critiqs is already mounted there; set the printed properties on it by hand. |
| `sets projectId from code` | The code computes the ID (a wrapper or fallback); init leaves it alone. Put the printed ID where that code reads it, without making it secret. |
| `doesn't support approving setup from another device yet` | Run init where a browser can open, using the chosen backend, or create the project in the matching prototype's Critiqs sidebar and update its existing component's projectId while keeping its backend. |
| `Setup was denied` or `The setup code expired` | Run init again; nothing was created. |
| Source became unreadable or unwritable after approval | Keep the returned project ID and backend. Restore access, then apply the complete snippet at its indicated entry/mount, and the `.env` line it names. Update an existing component; do not use an ID-only command that would lose the selected backend. |
| `The code already uses project …` | Nothing changed. Use `--review-url` to set its address, or `--new-project` only if asked. |
| `Critiqs Cloud isn't ready for this version` | The hosted backend is older than the package; tell the person. Don't switch backends without asking. |

## 5. Optional: the MCP server

`critiqs mcp` offers the same steps as tools. Add it to the agent's MCP
configuration, with any keys in its environment rather than in tool calls:

```json
{
  "mcpServers": {
    "critiqs": { "command": "npx", "args": ["critiqs-react", "mcp"] }
  }
}
```

- `critiqs_setup_start` (`signIn`: `"auto"`, `"browser"`, or `"remote"`;
  `entry`, `mount`, `name`, `reviewUrl`, `newProject`, `dir`, `envFile`; `target`:
  `"cloud"` by default, `"own-convex"`, or an existing backend's URL). Returns
  the address, and for remote approval the code, to give the person.
- `critiqs_setup_finish`: waits for sign-in or approval, then reuses or
  creates the project and writes its ID. Call again while it reports waiting.
  Its `structuredContent.stages` and `env` match init's.
- `critiqs_write_project_id` (`projectId`, `dir`, `entry`, `mount`, `envFile`, `dryRun`).
- `critiqs_doctor` (`dir`, `backend`, `envFile`); `structuredContent` matches
  `doctor --json`.

## 6. Optional: more context, own backend, and AI

These are separate from basic setup; skip them unless the person asks.

- **Context:** `version`, `getContext`, and `restoreContext` properties record
  and restore the prototype's view state; see the package README.
- **The team's own Convex deployment:** `npx critiqs-react init --own-convex`.
  It needs `CONVEX_DEPLOY_KEY`, a production deploy key the person sets in the
  environment themselves; `RESEND_API_KEY` and `CRITIQS_EMAIL_FROM` are
  optional and turn on mention emails. It also writes
  `backend="https://<deployment>.convex.cloud"`.
- **Inside the app's own Node or Bun server:** `critiqs-react/server` runs
  Critiqs on SQLite; see the package README. Pass the mounted path as
  `backend` (for example `backend="/critiqs"`), create the project in the
  Critiqs sidebar, and write its ID with `npx critiqs-react init <projectId>`.
  `npx critiqs-react doctor --backend http://localhost:<port>/critiqs` checks it.
- **AI:** works without any setup in the host app. On the team's own Convex
  deployment, the person can set `CRITIQS_AI_ENCRYPTION_KEY` (32 or more random
  characters, such as from `openssl rand -base64 32`) with `npx convex env set
  CRITIQS_AI_ENCRYPTION_KEY`, typing the value at its prompt, so project owners
  can connect a provider in the Critiqs sidebar. After upgrading a deployment
  that already has feedback, run `npx convex run tags:backfill` once.

## 7. Reading feedback

To act on reviewers' feedback, read it with the MCP server's tools. They work
with Critiqs Cloud and Convex deployments, not yet with Critiqs inside the
app's own server.

1. **Sign the computer in once.** The first reading call says the computer
   isn't signed in. Call `critiqs_sign_in` (`signIn`: `"auto"`, `"browser"` to
   also open the approval page on this computer, or `"remote"`; `backend` when
   not on Critiqs Cloud). Give the person the address and code exactly, as in
   setup, then call `critiqs_sign_in_finish` until it reports who signed in.
   People can instead run `npx critiqs-react sign-in`. The sign-in is kept on the
   computer, readable only by its user, and is reused by later sessions until
   `critiqs_sign_out` (or `npx critiqs-react sign-out`), 30 days without use,
   or 90 days. Never ask for the code the person receives by email.
2. **`critiqs_comments`** (`projectId`, required; `status`: `"open"` by
   default, `"resolved"`, or `"all"`; `author`: a display name or an author ID;
   `since` and `until`: a date such as `2026-10-01`, a date and time, or an age
   such as `7d`; `tag`; `screen`; `text`; `limit`, 50 by default). Returns
   matching threads, newest activity first, each with its whole discussion
   and context: `context.target.purposeId` is the element's `data-critiqs-id`
   in the code, with the screen, view state, record, scope, page address,
   window size, demo persona, build revision, and `movedTo` when a thread was
   reattached. With author, time, or text filters, a thread matches when any of
   its messages does, and each message's `matches` says which. `truncated`
   says when more matched than `limit`.
3. **`critiqs_thread`** (`thread`: an ID or a Critiqs link) adds mentions,
   reactions, who last resolved or reopened the thread and who moved it, and
   its screenshot's state.
4. **`critiqs_screenshot`** (`thread`; `file` to save it) returns what the
   reviewer saw, with the commented element outlined. Images over 5 MB need
   `file`.
5. **`critiqs_reply`** (`thread`, `body`; `mention`: display names or author
   IDs from `critiqs_thread`; `revision`, such as the commit) posts a reply as
   the signed-in person, shown as "Name · via coding agent". Use it once the
   work is done, to say what changed and ask the right people to check it.
   Everyone else in the thread is emailed about it (unless they turned that
   off); people you mention get a mention email. Write only what you actually
   did and verified.
6. **`critiqs_mockups`** (`projectId`, required; `screen`; `text` in the
   title; `limit`, 50 by default) lists the project's mockups, most recently
   changed first: proposed changes reviewers made with Critiqs AI on frozen
   copies of a page. Each has the page it was made from (address, screen,
   view state, build revision, demo persona), its version and thread counts,
   its page copies' IDs and widths, and its mockup threads: each one's ID,
   status, first message, author, and last activity. A mockup made in the
   Mockup panel has one thread, whose first message says what it is for.
7. **`critiqs_mockup`** (`mockup`, required; `version`, the latest by
   default, or `0` for the original copies; `saveCopies`, a folder) returns
   what to build. For each page copy, `edits` lists every change from the
   original copy in order: CSS rules, text, attributes, and inserted,
   replaced, or removed elements, each naming an element by its
   `data-critiqs-node` number. A change's `original` is that element as the
   copy has it: its start tag without the number, its text, and the nearest
   `data-critiqs-id` (`purposeId`), to find the component in the code.
   `original` is null with `addedByChange` when an earlier change in the list
   added the element. It also returns the version history, the mockup
   threads with their whole discussions (Critiqs AI's replies have
   `via: "ai"`, `askedBy`, and the `mockupVersion` they saved), and the
   linked feedback threads, which `critiqs_thread` reads in full. With
   `saveCopies`, each copy's original HTML is written to
   `<folder>/<mockupId>/<copyId>.html` and the version's changes to
   `edits-v<N>.json` beside them. Build the change in the app's own
   components; don't paste the copy's HTML.

| Message | What to do |
| --- | --- |
| `isn't signed in` or `sign-in ended` | Call `critiqs_sign_in` and have the person approve. |
| `people are named` | Use one of the listed author IDs. |
| `No one named … has commented in this project` | Mention only people who have commented there, by the names or author IDs `critiqs_thread` shows. |
| `can't post agent replies yet` | The backend is older than the package; tell the person. Its operator deploys the current backend. |
| `has no mockups yet` | The backend is older than the package; tell the person. Its operator deploys the current backend. |
| `runs an older version that can't keep this computer signed in` | The backend is older than the package; tell the person. Its operator deploys the current backend. |
| `didn't confirm signing out` | The computer is still signed in; try again when the backend is reachable. |

## What not to do

- Don't add a second `<Critiqs />`, or wrap the app in Critiqs providers or
  `"use client"` boundaries; the package handles its own.
- Don't put keys in source files, tool arguments, the conversation, or the
  prototype's browser code or build settings: AI and email keys belong on the
  backend only.
- Don't identify projects by the prototype's URL. The project ID decides
  which feedback a copy (local, preview, deployed) shows; a preview never
  changes the project's review address unless someone runs `--review-url` for
  it.
- Don't commit `.env.local`, copy one app's project ID into another app's
  variable, or set one generic `VITE_CRITIQS_PROJECT_ID` for a build that
  builds several apps.
