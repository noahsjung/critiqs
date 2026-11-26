# Critiqs for Vue

Reviewers comment directly on a running prototype, discuss feedback, and find
its original context as the prototype changes. Critiqs brings its own toolbar,
sidebar, sign-in, and styles. This package is a Vue 3 component for it; it
works in any Vue 3.3 or later app, such as a Vite app made with
`npm create vue@latest`. For Nuxt, use [`critiqs-nuxt`](https://www.npmjs.com/package/critiqs-nuxt).

## Set up

```sh
npm install critiqs-vue          # or: pnpm add, yarn add, bun add
```

Add `<Critiqs>` once, in the root component (`src/App.vue` in a create-vue
app). It renders nothing where you put it: Critiqs appears above the app.

```vue
<script setup lang="ts">
import { Critiqs } from 'critiqs-vue'
const critiqsProjectId = import.meta.env.VITE_CRITIQS_PROJECT_ID
</script>

<template>
  <RouterView />
  <Critiqs :project-id="critiqsProjectId" require-project-id />
</template>
```

```sh
# .env.local (this computer only; create-vue's .gitignore already ignores *.local)
VITE_CRITIQS_PROJECT_ID=<project ID>
```

With `require-project-id`, Critiqs appears only where the variable holds a
valid project ID. A build without it adds nothing to the page, contacts no
backend, and never downloads Critiqs: the component loads it on demand.
Vite writes `VITE_` variables into the app when it builds, so set
`VITE_CRITIQS_PROJECT_ID` in each deployment's build settings and rebuild after
changing it.

To share one project across every copy instead, write the ID into the
component: `<Critiqs project-id="<project ID>" />`.

## Properties

Each property means what `CritiqsOptions` in the shared
[`critiqs`](https://www.npmjs.com/package/critiqs) package documents.

| Property | Type | |
| --- | --- | --- |
| `project-id` | string | The Critiqs project for this prototype. |
| `require-project-id` | boolean | Show Critiqs only where `project-id` is a valid project ID. |
| `backend` | string | A team's own backend URL. Defaults to Critiqs Cloud. |
| `version` | string | Prototype version, such as a release or commit, recorded with each message. |
| `get-context` | `() => HostContext` | Reports the current screen, view state, and demo persona. |
| `restore-context` | `(request: RestoreRequest) => …` | Shows a thread's view again: navigate, open tabs and dialogs. Replaces the router's default. |
| `router` | boolean | Vue Router integration (see Routes). On by default; `:router="false"` turns it off. |

Changing a property updates Critiqs, including passing a new function;
unmounting the component removes Critiqs from the page.

## Routes

In an app with Vue Router, Critiqs follows the router on its own:

- **Each navigation reports the route.** The screen is the route's pattern
  without its leading slash, and its parameters are view state named
  `route.<name>`. On `/users/42`, matched by `/users/:id`, a new thread
  records the screen `users/:id` and `{ "route.id": "42" }`, so every
  user's page is one screen and the thread still names user 42. Custom
  parameter patterns are dropped (`/users/:id(\d+)` is `users/:id`); the
  root route is the screen `/`.
- **Opening a thread shows its route again.** Critiqs builds the path from
  the screen and parameters (`/users/42`) and calls `router.push`, unless the
  app is already there. It waits for the navigation to finish, and leaves the
  page as it is when a navigation guard stops it, such as one protecting
  unsaved work. A guard that redirects elsewhere counts as not showing the
  thread. If Critiqs moves on (another thread opens) while a guard still holds
  the navigation, that navigation is cancelled.
- **Your own callbacks still win.** A `get-context` function's keys replace
  the route's, key by key, so it can name a finer screen or add view state
  such as an open tab; the route fills in the rest. A `restore-context`
  function replaces navigating with the router.
- **A screen the router can't show** leaves the page as it is: a custom
  screen from `get-context`, a route the app no longer has (a catch-all
  route doesn't count as a match), or a pattern with two parameters in one
  segment (`/blog/:slug-:id`), which can't be built back into a path.
- **Turning it off:** `<Critiqs :router="false" … />`. Without Vue Router,
  there is nothing to turn off: threads record the URL path, as in any app.

The same integration is available on its own from `critiqs-vue/router`, for
apps that start Critiqs themselves with `mountCritiqs` (critiqs-nuxt uses
it):

```ts
import { mountCritiqs } from 'critiqs'
import { followRouter, routerRestore } from 'critiqs-vue/router'

const instance = mountCritiqs({ projectId, restoreContext: routerRestore(router) })
const stop = followRouter(router, instance) // call stop() to stop reporting routes
```

## Masking

Elements with the `data-critiqs-mask` attribute (`MASK_ATTRIBUTE`, exported
from `critiqs-vue`) are covered in captures, such as fields showing personal
data.

## Server rendering

The component loads and starts Critiqs only in the browser, after it mounts,
so it is safe in apps rendered on the server.

## License

MIT
