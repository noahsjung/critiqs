# Install Critiqs

> Install the Critiqs package for any of 12 frameworks, from React and Vue to Rails and Django, run npx critiqs init, and verify your setup.

Critiqs has a package for each of 12 frameworks: React 18 or 19 (Vite, Next.js App Router or Pages Router, Remix, Create React App), Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Ruby on Rails, Django, and Flask. One setup command, `npx critiqs init`, finds the framework and adds Critiqs for all of them. The setup command requires Node.js 20 or later, also for Rails, Django, and Flask apps.

A site with no Critiqs package, such as WordPress or Laravel, can add Critiqs with [one script tag](https://github.com/noahsjung/critiqs/tree/main/packages/critiqs#with-a-script-tag).

## 1. Install the package

Install your framework's package in the app's folder:

| Framework | Install |
| --- | --- |
| React, Next.js | `npm install critiqs-react` |
| Vue | `npm install critiqs-vue` |
| Nuxt | `npm install critiqs-nuxt` |
| Svelte, SvelteKit | `npm install critiqs-svelte` |
| Angular | `npm install critiqs-angular` |
| Astro | `npm install critiqs-astro` |
| Solid, SolidStart | `npm install critiqs-solid` |
| Ruby on Rails | `bundle add critiqs-rails` |
| Django | `pip install django-critiqs` |
| Flask | `pip install flask-critiqs` |

Use your project's own package manager for the npm packages. For React:

```sh
# npm
npm install critiqs-react

# pnpm
pnpm add critiqs-react

# Yarn
yarn add critiqs-react

# Bun
bun add critiqs-react
```

## 2. Run setup

Run `init` in the app's folder (the one with its `package.json`, `Gemfile`, or `manage.py`):

```sh
# npm, or any app without a JavaScript package manager
npx critiqs init

# pnpm
pnpm exec critiqs init

# Yarn
yarn critiqs init

# Bun
bunx critiqs init
```

The `init` command finds your framework, adds Critiqs where your app renders, signs you in with a one-time email code, creates a project on Critiqs Cloud, and wires up its project ID. Critiqs Cloud runs storage, sign-in, and email, so you enter no API keys.

> **Note:** Over SSH, in a container, or on a machine without a desktop browser, `init` switches to remote approval (or pass `--remote`). It prints a URL and a short setup code such as `BCDF-GHJK`. Open that URL on any device, enter the code, sign in with your email, and click **Approve**.

Running `init` again is safe. It keeps any project ID your code already configures and reuses your project if an earlier run was interrupted. Pass `--new-project` only if you want a separate project.

To connect an existing project ID without signing in, pass the ID directly:

```sh
npx critiqs init <projectId>
```

## What init changes, by framework

| Framework | Where Critiqs goes | Where the project ID goes on your computer |
| --- | --- | --- |
| React (Vite) | `<Critiqs />` beside `<App />` in the entry file | `VITE_CRITIQS_PROJECT_ID` in `.env.local` |
| Next.js | `<Critiqs />` in `app/layout.tsx` or `pages/_app.tsx` | `NEXT_PUBLIC_CRITIQS_PROJECT_ID` in `.env.local` |
| Vue | `<Critiqs />` in `src/App.vue` | `VITE_CRITIQS_PROJECT_ID` in `.env.local` |
| Nuxt | `critiqs-nuxt` in the `modules` of `nuxt.config` | `NUXT_PUBLIC_CRITIQS_PROJECT_ID` in `.env` |
| Svelte | `<Critiqs />` in the root component | `VITE_CRITIQS_PROJECT_ID` in `.env.local` |
| SvelteKit | Critiqs in the root `+layout.svelte` | `PUBLIC_CRITIQS_PROJECT_ID` in `.env.local` |
| Angular | `provideCritiqs({ projectId })` in `src/app/app.config.ts` | In that call (Angular has no public environment variables) |
| Astro | The `critiqs()` integration in `astro.config` | `PUBLIC_CRITIQS_PROJECT_ID` in `.env` |
| Solid | `<Critiqs />` in `src/App.tsx` | `VITE_CRITIQS_PROJECT_ID` in `.env.local` |
| Ruby on Rails | `<%= critiqs_tag %>` before `</body>` in the application layout | `CRITIQS_PROJECT_ID` in `.env` with dotenv (unless a hand-written plain `ENV["CRITIQS_PROJECT_ID"] = …` line in `config/environments/development.rb` overrides it; then that line), otherwise `ENV["CRITIQS_PROJECT_ID"] \|\|= …` there |
| Django | `django_critiqs` in `INSTALLED_APPS`, `{% critiqs %}` in the base template | `os.environ.setdefault("CRITIQS_PROJECT_ID", …)` in `manage.py`, which starts the development server |
| Flask | `Critiqs(app)` where the app is created, `{{ critiqs() }}` in the base template | `CRITIQS_PROJECT_ID` in `.env`, which flask-critiqs reads under `flask run` (that key only) |

Each deployment sets the same variable to its own project ID. Rails, Django, and Flask read it when the server handles a request; a production server (Puma, Gunicorn, uWSGI, Waitress) doesn't run `manage.py` or the development configuration, and flask-critiqs reads `.env` only under Flask's development server, so it shows Critiqs only where the variable is set. An environment variable you set yourself always wins over what init wrote. Each package's README covers its options: [critiqs-rails](https://github.com/noahsjung/critiqs/tree/main/packages/rails#readme), [django-critiqs](https://github.com/noahsjung/critiqs/tree/main/packages/django#readme), [flask-critiqs](https://github.com/noahsjung/critiqs/tree/main/packages/flask#readme), and the [other packages](https://github.com/noahsjung/critiqs/tree/main/packages).

The rest of this section shows the React code init writes.

## Vite and Next.js setup

In Vite and Next.js apps, `init` wires `<Critiqs />` to a public environment variable, adds `requireProjectId`, writes the project ID to `.env.local`, and adds an empty entry to `.env.example`.

### Vite

Init adds `<Critiqs />` beside `<App />` in your entry file (where `createRoot` or `ReactDOM.render` runs):

```tsx
import { Critiqs } from "critiqs-react";

root.render(
	<>
		<App />
		<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />
	</>
);
```

Your `.env.local` file (do not commit this file) receives:

```sh
VITE_CRITIQS_PROJECT_ID=<project ID>
```

### Next.js App Router

Init adds `<Critiqs />` inside `<body>` in `app/layout.tsx`:

```tsx
import { Critiqs } from "critiqs-react";

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>
				{children}
				<Critiqs projectId={process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />
			</body>
		</html>
	);
}
```

Your layout stays a Server Component. The `critiqs-react` package declares `"use client"` on `<Critiqs />` and renders nothing on the server, so hydration is unaffected.

### Next.js Pages Router

Init adds `<Critiqs />` beside `<Component {...pageProps} />` in `pages/_app.tsx`:

```tsx
import { Critiqs } from "critiqs-react";

export default function App({ Component, pageProps }: AppProps) {
	return (
		<>
			<Component {...pageProps} />
			<Critiqs projectId={process.env.NEXT_PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />
		</>
	);
}
```

### Other React setups

If your app has a custom entry file or multiple roots, pass `--entry` and `--mount`:

```sh
npx critiqs init --entry src/Shell.tsx --mount Outlet
```

In a monorepo workspace, run `init` once per app with `--dir apps/<app>`. See [Projects and project IDs](/docs/projects).

## Keep Critiqs out of production with requireProjectId

When the project ID comes from an environment variable, init turns on `requireProjectId` (Rails, Django, and Flask have it on by default), so Critiqs renders only when the variable holds a valid project ID:

- **Unset variable (production):** Critiqs adds nothing to the page and makes no network requests.
- **Invalid or unknown ID:** Visitors see nothing. Critiqs logs a warning to the browser console explaining what is wrong.
- **No browser fallback:** Critiqs never falls back to a project remembered in `localStorage`, so two apps on the same domain cannot pick up each other's project.

Vite, Next.js, and Astro inline `VITE_*`, `NEXT_PUBLIC_*`, and `PUBLIC_*` values at build time: set the variable in your staging, preview, and QA build settings, leave it unset in production, and rebuild after changing a value. Nuxt, SvelteKit, Rails, Django, and Flask read it where the server runs: set it in each deployment's environment and restart.

## 3. Check that it works

Run `doctor` to check Critiqs in the code, the backend connection, project, review address, and email configuration:

```sh
npx critiqs doctor
```

Each check reports whether it inspected configuration or observed live backend activity. Because `doctor` never sends an email, uploads a capture, or posts a comment, finish by testing the real flow:

1. Start or restart your dev server and open the app in a browser.
2. Click **Sign in** on the Critiqs toolbar and sign in with your email code.
3. Press `C`, click an element on the page, and post a test comment.
4. Commit your source code changes (not `.env.local` or `.env`), set the project ID variable in your staging or preview build settings or environment, and deploy.
5. Record the deployed review address so notification emails link to it:

```sh
npx critiqs init --review-url https://staging.example.com
```
