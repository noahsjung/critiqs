# Install Critiqs

> Install critiqs-react in a React 18 or 19 app, run critiqs init for Vite or Next.js, configure requireProjectId, and verify your setup.

Critiqs works in any React 18 or 19 application, including Vite, Next.js (App Router or Pages Router), Remix, and Create React App. React and React DOM are its only peer dependencies. The setup CLI requires Node.js 20 or later.

## 1. Install the package

Install `critiqs-react` with your project's package manager:

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

Run `init` in the folder that contains your app's `package.json`:

```sh
# npm
npx critiqs-react init

# pnpm
pnpm exec critiqs init

# Yarn
yarn critiqs init

# Bun
bunx critiqs-react init
```

The `init` command adds `<Critiqs />` where your app renders, signs you in with a one-time email code, creates a project on Critiqs Cloud, and wires up its project ID. Critiqs Cloud runs storage, sign-in, and email, so you enter no API keys.

> **Note:** Over SSH, in a container, or on a machine without a desktop browser, `init` switches to remote approval (or pass `--remote`). It prints a URL and a short setup code such as `BCDF-GHJK`. Open that URL on any device, enter the code, sign in with your email, and click **Approve**.

Running `init` again is safe. It keeps any project ID your code already configures and reuses your project if an earlier run was interrupted. Pass `--new-project` only if you want a separate project.

To connect an existing project ID without signing in, pass the ID directly:

```sh
npx critiqs-react init <projectId>
```

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
npx critiqs-react init --entry src/Shell.tsx --mount Outlet
```

In a monorepo workspace, run `init` once per app with `--dir apps/<app>`. See [Projects and project IDs](/docs/projects).

## Keep Critiqs out of production with requireProjectId

Adding `requireProjectId` ensures Critiqs renders only when `projectId` holds a valid project ID:

- **Unset variable (production):** `<Critiqs />` adds nothing to the DOM and makes no network requests.
- **Invalid or unknown ID:** Visitors see nothing. Critiqs logs a warning to the browser console explaining what is wrong.
- **No browser fallback:** Critiqs never falls back to a project remembered in `localStorage`, so two apps on the same domain cannot pick up each other's project.

Vite and Next.js inline `VITE_*` and `NEXT_PUBLIC_*` values at build time. Set the variable in your staging, preview, and QA build settings, leave it unset in production, and rebuild after changing a value.

## 3. Check that it works

Run `doctor` to check the component, backend connection, project, review address, and email configuration:

```sh
npx critiqs-react doctor
```

Each check reports whether it inspected configuration or observed live backend activity. Because `doctor` never sends an email, uploads a capture, or posts a comment, finish by testing the real flow:

1. Start or restart your dev server and open the app in a browser.
2. Click **Sign in** on the Critiqs toolbar and sign in with your email code.
3. Press `C`, click an element on the page, and post a test comment.
4. Commit your source code changes (not `.env.local`), set the project ID variable in your staging or preview build settings, and deploy.
5. Record the deployed review address so notification emails link to it:

```sh
npx critiqs-react init --review-url https://staging.example.com
```
