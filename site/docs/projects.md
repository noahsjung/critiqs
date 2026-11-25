# Projects and project IDs

> Share one feedback list across staging, preview, and QA builds using a single project ID, and configure monorepos and review addresses.

A Critiqs project is the shared feedback space for one application. Its project ID connects every build of that app to the same list of threads, tags, and mockups.

## Share one project ID across staging, preview, and QA

Give your staging, pull request preview, and QA builds the same project ID. Every comment left on any of those builds lands in one list, along with the page address, screen, and prototype build version where it was left.

A developer working locally can also use the same project ID in `.env.local` to see open threads while fixing them, and then verify the fix on staging without losing the discussion history.

| Environment | Setting | Result |
| --- | --- | --- |
| Local development | `VITE_CRITIQS_PROJECT_ID=<id>` in `.env.local` | Reads and posts to the project locally |
| Pull request previews | Same `<id>` in preview build settings | Feedback lands in the same list |
| Staging and QA builds | Same `<id>` in staging and QA build settings | Feedback lands in the same list |
| Separate review track | A different project ID | Keeps its own separate thread list |
| Production for customers | Variable left unset (with `requireProjectId`) | No Critiqs UI or network requests |

> **Note:** Critiqs never identifies a project by its URL. The `projectId` prop determines which project a build connects to. Opening a preview link with the same project ID never changes the project's review address.

### Build-time versus runtime configuration

Vite and Next.js replace `VITE_*` and `NEXT_PUBLIC_*` environment variables when the app builds. Changing a variable in your hosting provider requires a new build.

Critiqs does not check `NODE_ENV`, so a production-mode build deployed to staging still shows Critiqs as long as the project ID variable is set. If your team builds one bundle and promotes the same files across staging and production, read the project ID from your own runtime configuration and pass it to `projectId`, keeping `requireProjectId`.

## Connect an existing project

To connect another checkout or developer machine to an existing project without creating a new one:

1. Open the app in **Browse mode**, open the side panel, and click **Copy** under **Project ID** (or copy it from **Project setup**).
2. Run `init` with that project ID:

```sh
npx critiqs-react init <projectId>
```

When `<Critiqs />` reads an environment variable, `init <projectId>` writes the ID to `.env.local` without requiring sign-in.

## One project per app in a monorepo

In an npm, pnpm, Yarn, or Bun workspace, give each app its own Critiqs project. Run `init` once per app with `--dir`:

```sh
npx critiqs-react init --dir apps/web
npx critiqs-react init --dir apps/admin
```

Init gives each workspace app its own environment variable name based on the app name, such as `VITE_CRITIQS_PROJECT_ID_WEB` and `NEXT_PUBLIC_CRITIQS_PROJECT_ID_ADMIN`. That prevents a shared workspace `.env` file or a single CI job from pointing multiple apps at the same project.

If you run `npx critiqs-react init` at the workspace root, it lists the detected apps and prints the `--dir` command for each one without editing files. If a Vite app uses a custom `envDir` that `init` cannot resolve statically, pass `--project-env-file <path>` to both `init` and `doctor`.

## Set the review address

Every project has one **Review address** that mention and reply emails link to. Because a comment might be left on `localhost` or a short-lived pull request preview, Critiqs does not guess the email link from where the comment was posted.

Organization admins and the person who created the project (while they remain a member of the organization) can set or change the review address. Set it from the command line, including any base path:

```sh
npx critiqs-react init --review-url https://staging.example.com/app/
```

You can also set or update it in the app: open the **Project** panel in **Browse mode**, click **Project setup**, and click **Add the address** or **Change** under **Review address**. Changes apply to emails sent from that point forward.

> **Note:** If the review address points to `localhost` or a private network address (such as a `.ts.net` address), Critiqs displays a warning because reviewers outside that machine or network cannot open email links.

## Access and what the project ID protects

A project ID is public configuration, not a secret. Anyone who signs in with a verified email while using a build that carries the project ID can read threads, post comments, and participate in that project. There is no invitation list or member roster.

Control who can review by controlling who can reach your staging, preview, or QA build (for example, through your hosting provider's preview authentication, VPN, or app login). Project settings, **Review address**, **Tags and AI**, and the **\<plan name\> plan** usage block are restricted to organization admins and the person who created the project while they remain a member of the organization.
