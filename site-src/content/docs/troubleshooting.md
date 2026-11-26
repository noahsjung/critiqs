---
title: Troubleshooting
description: Fix common Critiqs issues with missing toolbars, unreachable backends, sign-in pop-ups, CSP headers, MCP sign-in, and captures.
section: Reference
order: 1
---

Start by running `doctor` in your app folder:

```sh
npx critiqs doctor
```

If your app lives in a monorepo, pass `--dir apps/<app>`. If your Vite app uses a custom `envDir`, pass `--project-env-file <relative path>`. Doctor checks Critiqs in your code, backend reachability and version, local project ID, review address, sign-in, screenshot storage, AI, and mention emails.

## Critiqs does not appear on the page

When Critiqs has `requireProjectId`, it renders nothing and makes no requests when the project ID is unset or malformed. If a well-formed ID does not exist on the backend, Critiqs contacts the backend to check it, logs a warning, and keeps the UI hidden.

1. Open your browser developer console and look for a warning starting with `Critiqs:`.
2. Check that your project ID variable is set: `VITE_CRITIQS_PROJECT_ID` for Vite apps (React, Vue, Svelte, Solid), `NEXT_PUBLIC_CRITIQS_PROJECT_ID` for Next.js, `NUXT_PUBLIC_CRITIQS_PROJECT_ID` for Nuxt, `PUBLIC_CRITIQS_PROJECT_ID` for SvelteKit and Astro, `CRITIQS_PROJECT_ID` for Rails, Django, and Flask, or the app-suffixed variable in a monorepo such as `VITE_CRITIQS_PROJECT_ID_ADMIN`.
3. Restart your dev server after changing `.env.local`.
4. For staging or preview deployments, set the variable in the host's **build settings** and trigger a new build: Vite, Next.js, and Astro inline the value at build time, not at runtime. For Nuxt, SvelteKit, Rails, Django, and Flask, set it in the server's environment and restart.
5. If you build once and promote the same bundle across environments, pass the ID from your own runtime config to `projectId` and keep `requireProjectId`.

## Backend not reachable or version mismatch

- **`Critiqs Cloud isn't ready for this version`** or **`runs an older version`**: your installed Critiqs package requires a newer backend protocol than the deployment serves. On a team-owned Convex deployment, deploy the matching backend functions. On Critiqs Cloud, wait for the hosted backend update or check for a matching package release.
- **Unreachable backend**: run `npx critiqs doctor` and check whether `/critiqs/config` and `/critiqs/health` succeed from your browser's Network tab. Confirm the backend setting matches your Convex `.convex.cloud` URL (omit it to use Critiqs Cloud). The setting each package reads is in [Install Critiqs](/docs/install) and each package's README: `backend="…"` on the component for React, Vue, Svelte, and Solid; the `critiqs` options in Nuxt, Astro, and Angular; `critiqs_tag(backend: …)` in Rails; `CRITIQS = {"BACKEND": …}` in Django's settings; `CRITIQS_BACKEND` in Flask's config; and `data-backend` on the script tag.
- **Project not found on backend**: the `projectId` does not exist on the configured backend. Check that you are not pointing a Critiqs Cloud project ID at a team-owned Convex backend (or the reverse).

## Sign-in issues

- **Nothing happens when clicking Sign in (`Your browser blocked the sign-in window`)**: allow pop-ups for your staging or preview site and click **Sign in** again.
- **Site refused by sign-in service**: allowed sites must use `https://`, except when running locally on your computer (`localhost`).
- **Sign-in code expired or window locked**: email codes expire after 10 minutes and work once. Five wrong guesses lock the sign-in window. Close it and open a fresh sign-in window. Rate limits also apply (at most 3 codes per window, 5 per email address in 15 minutes).
- **No browser available during `critiqs init` or `critiqs sign-in`**: pass `--remote` to print an approval URL and short setup code (such as `BCDF-GHJK`) that you can approve from a phone or laptop within 10 minutes.
- **Self-hosted deployment cannot sign anyone in**: check `CRITIQS_AUTH_ISSUER`. If running your own sign-in service, verify `CRITIQS_AUTH_PRIVATE_KEY`, `RESEND_API_KEY`, and `CRITIQS_EMAIL_FROM` are set on the Convex deployment.

## Content Security Policy (CSP)

If your host app sends a strict `Content-Security-Policy` header, allow Critiqs's connections, shadow-root styles, captures, and Mockup mode frame:

- `connect-src`: your Critiqs backend origin (`https://*.convex.cloud`, `wss://*.convex.cloud`, and `https://*.convex.site`, or your specific Convex deployment domains) and the sign-in service origin.
- `style-src`: Critiqs injects a `<style>` tag inside its shadow root, which requires `'unsafe-inline'` if your policy blocks inline styles.
- `img-src`: allow `data:`, `blob:`, and your backend's `.convex.site` origin for `/capture`.
- `frame-src` / `child-src`: Mockup mode renders frozen page copies inside a sandboxed `<iframe>`.

> **Note:** This list comes from what Critiqs loads and connects to. Test your policy on a staging build before you rely on it.

## MCP server errors

| Message | Fix |
| --- | --- |
| `This computer isn't signed in to Critiqs` or `sign-in ended` | Run `npx critiqs sign-in` (or have the agent call `critiqs_sign_in` and `critiqs_sign_in_finish`). Sessions expire after 30 days unused or 90 days total. |
| `Another Critiqs process is using this computer's sign-in` | Two local processes refreshed the token at the same time. Retry in a few seconds (abandoned locks clear after 30 seconds). |
| `people are named ...` | Two participants share that display name. Pass one of the returned `authorId` values instead. |
| `No one named ... has commented in this project` | Only project participants can be mentioned. Pick a name or `authorId` from `critiqs_thread`. |
| `can't post agent replies yet` or `has no mockups yet` | The backend runs an older version than your Critiqs package. Upgrade the backend deployment. |
| `didn't confirm signing out` | The sign-in service was unreachable, so your local sign-in was kept. Run `npx critiqs sign-out` again once it is reachable. |
| `didn't confirm ending an earlier session` | Your sign-in ended, but the sign-in service didn't answer for a session this computer kept from an interrupted renewal, so its token stays saved. Run `npx critiqs sign-out` again once the service is reachable. |
| `changed this computer's sign-in while it was signing out` | Another Critiqs process renewed the sign-in, or signed in again, during sign-out. Run `npx critiqs sign-out` again. |
| `Deploying to the team's own Convex needs CONVEX_DEPLOY_KEY` | Inject `CONVEX_DEPLOY_KEY` into the MCP server's process environment from a secret store or shell environment (not in a committed config file, chat messages, or tool arguments), or run `npx critiqs init --own-convex` in a terminal using its hidden prompt. |

## `critiqs init` setup messages

| Message | Fix |
| --- | --- |
| `Init didn't find where the app renders` | Pass `--entry <file>` (and `--mount <Element>`), or add Critiqs manually as your framework's package README shows and rerun `npx critiqs init`. |
| `Found several places the app could render Critiqs` | Pass `--entry <file>`, or run `init` inside one app folder with `--dir`. |
| `... is a workspace with N apps` | Run one of the printed `npx critiqs init --dir <app>` commands for each app. |
| `sets envDir in a way init can't follow` | Pass `--project-env-file <path to .env.local>` relative to `--dir`, and pass the same flag to `doctor`. |
| `sets envPrefix` | Wire `<Critiqs projectId={import.meta.env.<PREFIX_NAME>} requireProjectId />` manually, then rerun `init`. |
| `sets projectId from code` | `init` does not overwrite computed expressions. Put the printed project ID where your code reads it. |
| `The code already uses project ...` | Nothing changed. Pass `--review-url <url>` to update email links, or `--new-project` only if you want a new project. |
| `Couldn't write .env.local` after creating the project | Add the printed `NAME=<projectId>` line to `.env.local` manually; the project and component are already created. |

## Mention and reply emails

- **Emails do not open the deployed build (or doctor warns about a missing or local review address):** Run `npx critiqs init --review-url https://<your-staging-url>` or update **Review address** in **Project setup**. Addresses like `localhost` or `.ts.net` only open on one computer or private network.
- **No emails arrive on a self-hosted Convex deployment:** Check that `RESEND_API_KEY` and `CRITIQS_EMAIL_FROM` are set on the backend and that the sender domain is verified in Resend. Run `npx critiqs doctor` to see whether the last email failed or scheduled sending is overdue.
- **One reviewer stopped getting emails:** Check **Email notifications…** in their avatar menu or the Project panel. Muting a project turns off both mention and reply emails for that project.

## Automatic captures fail

Automatic DOM captures time out after 10 seconds, fail if the screen or view state changes mid-capture, or fail if a `<canvas>`, `<video>`, or `<iframe>` has `data-critiqs-mask` placed directly on it.

- Move `data-critiqs-mask` to a wrapper element around canvas, video, or iframe content.
- Even when automatic capture fails, Critiqs saves the comment with the reason and offers **Attach a screenshot** inside the thread.
