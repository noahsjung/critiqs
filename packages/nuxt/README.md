# Critiqs for Nuxt

Reviewers comment directly on a running prototype, discuss feedback, and find
its original context as the prototype changes. Critiqs brings its own toolbar,
sidebar, sign-in, and styles. This package is a Nuxt module for it, for Nuxt
4 apps.

## Set up

```sh
npm install critiqs-nuxt          # or: pnpm add, yarn add, bun add
```

Add the module to `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ['critiqs-nuxt'],
})
```

```sh
# .env (this computer only; create-nuxt's .gitignore already ignores it)
NUXT_PUBLIC_CRITIQS_PROJECT_ID=<project ID>
```

`nuxt dev` reads `.env`, not `.env.local`. The production server
(`node .output/server/index.mjs`) reads no `.env` file: set
`NUXT_PUBLIC_CRITIQS_PROJECT_ID` in each deployment's server environment. Nuxt
reads it when the server starts, so one build can serve several deployments,
each with its own project, and restarting applies a change. A static site
(`nuxt generate`) reads it when it is generated.

Critiqs requires a valid project ID by default: a deployment without one adds
nothing to the page, contacts no backend, and never downloads Critiqs.
Critiqs runs only in the browser, after the app mounts; server rendering never
loads it.

## Settings

Put settings under `critiqs` in `nuxt.config.ts`. Each is also a public
runtime config value, so a `NUXT_PUBLIC_CRITIQS_…` variable overrides it when
the server starts.

```ts
export default defineNuxtConfig({
  modules: ['critiqs-nuxt'],
  critiqs: {
    projectId: '<project ID>',        // NUXT_PUBLIC_CRITIQS_PROJECT_ID
    backend: 'https://…',             // NUXT_PUBLIC_CRITIQS_BACKEND; defaults to Critiqs Cloud
    version: process.env.COMMIT_SHA,  // NUXT_PUBLIC_CRITIQS_VERSION
    requireProjectId: true,           // NUXT_PUBLIC_CRITIQS_REQUIRE_PROJECT_ID
    router: true,                     // NUXT_PUBLIC_CRITIQS_ROUTER
  },
})
```

| Setting | Default | |
| --- | --- | --- |
| `projectId` | none | The Critiqs project. Writing it here shares one project across every deployment. |
| `requireProjectId` | `true` | Show Critiqs only where the project ID is valid. `false` shows project setup in the sidebar when there is none. |
| `backend` | Critiqs Cloud | A team's own backend URL. |
| `version` | none | Prototype version, such as a release or commit, recorded with each message. |
| `router` | `true` | Route integration (see Routes). |

## Routes

In an app with pages (`app/pages/`), Critiqs follows Nuxt's router:

- **Each navigation reports the route.** The screen is the page's route
  pattern without its leading slash, and its parameters are view state named
  `route.<name>`. On `/users/42`, from `pages/users/[id].vue`, a new thread
  records the screen `users/:id` and `{ "route.id": "42" }`, so every user's
  page is one screen and the thread still names user 42. A catch-all page
  (`[...slug].vue`) is `:slug*`; the home page is the screen `/`.
- **Opening a thread shows its route again.** Critiqs builds the path from
  the screen and parameters (`/users/42`) and calls `router.push`, unless the
  app is already there, and waits for the navigation to finish. When a route
  middleware stops it, the page stays as it is.
- **Turning it off:** `critiqs: { router: false }`. Apps without pages have no
  routes to report: threads record the URL path.

## Your own context and restore

Runtime config holds only text, so the app's own `getContext` and
`restoreContext` functions come from a plugin in the app, through the
`critiqs:options` hook. Critiqs calls it once in the browser, after the app
mounts and before Critiqs starts:

```ts
// app/plugins/critiqs.client.ts
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('critiqs:options', (options) => {
    // Its keys win over the route's; the route fills in the rest.
    options.getContext = () => ({ viewState: { tab: currentTab() } })
    // Replaces showing the thread's route with the router.
    options.restoreContext = async ({ screen, viewState, signal }) => {
      // Show the screen, then say whether it is showing.
      return true
    }
  })
})
```

Each function means what `CritiqsOptions` in the
[`critiqs`](https://www.npmjs.com/package/critiqs) package documents. Set
either one or both: without `restoreContext`, opening a thread still shows its
route with the router.

## License

MIT
