# critiqs-svelte

Critiqs for Svelte 5 and SvelteKit: comment on an interactive prototype,
discuss feedback, and find its context. `<Critiqs />` adds Critiqs's toolbar,
sidebar, and pins above your app while it is mounted. It renders nothing in
place, runs only in the browser, and loads Critiqs only once it is used, so
server rendering and prerendering are unaffected.

## Set up

```sh
npx critiqs init
```

Setup finds your app's root component and adds Critiqs there. To add it by
hand, install the package:

```sh
npm install critiqs-svelte
```

### Svelte with Vite

In `src/App.svelte`:

```svelte
<script>
  import { Critiqs } from 'critiqs-svelte';
</script>

<!-- your app -->

<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />
```

Put `VITE_CRITIQS_PROJECT_ID=<your project ID>` in `.env.local`. Vite reads
it when it builds, so set it in each deployment's build settings and rebuild
after changing it.

### SvelteKit

In `src/routes/+layout.svelte`, the layout every page renders, import it from
`critiqs-svelte/kit`, which adds SvelteKit's router (see [Routes](#routes)):

```svelte
<script lang="ts">
  import { Critiqs } from 'critiqs-svelte/kit';
  import { PUBLIC_CRITIQS_PROJECT_ID } from '$app/env/public';

  let { children } = $props();
</script>

{@render children()}
<Critiqs projectId={PUBLIC_CRITIQS_PROJECT_ID} requireProjectId />
```

SvelteKit 3 reads only the variables `src/env.ts` declares. Declare the
project ID as public and optional, so a deployment without it builds and shows
no Critiqs:

```ts
import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
  PUBLIC_CRITIQS_PROJECT_ID: {
    public: true,
    schema: (value) => value,
    description: "This deployment's Critiqs project ID. Critiqs stays hidden where it is unset."
  }
});
```

On SvelteKit 2, read it in the browser from `$env/dynamic/public` instead,
with no `src/env.ts`. SvelteKit 2 fails a prerendered page that reads it
while rendering, and Critiqs renders nothing on the server anyway:

```svelte
<script>
  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';
</script>

<Critiqs projectId={browser ? env.PUBLIC_CRITIQS_PROJECT_ID : undefined} requireProjectId />
```

`critiqs-svelte/kit` needs SvelteKit 2.26 or later; on older versions import
`critiqs-svelte`, which works without route support.

Put `PUBLIC_CRITIQS_PROJECT_ID=<your project ID>` in `.env.local` for
development. Each deployment sets it in its environment: a SvelteKit server
reads it when it starts, and a prerendered or static site when it is built.

Without a project ID setting, leave out `requireProjectId` and the sidebar
offers project setup instead.

## Settings

| Property | Meaning |
|---|---|
| `projectId` | The Critiqs project for this prototype. |
| `requireProjectId` | Show Critiqs only where `projectId` is a valid project ID, such as one read from a deployment's environment. Without one, Critiqs renders nothing and contacts no backend. |
| `backend` | A team's own Critiqs backend URL. Defaults to Critiqs's hosted service. |
| `version` | Prototype version, such as a release label or Git commit, recorded with each message. |
| `getContext` | Returns the current `screen`, `viewState`, and demo `persona`. |
| `restoreContext` | Shows a thread's view again: navigate, select tabs, open dialogs. Return `false` when it can't. |
| `router` | `critiqs-svelte/kit`: `false` turns route support off. `critiqs-svelte`: your own router, see [Routes](#routes). |

Changing a property updates Critiqs in place; unmounting the component removes
it. Mark elements to cover in screenshots with `MASK_ATTRIBUTE`
(`data-critiqs-mask`).

## Routes

With `critiqs-svelte/kit`, Critiqs follows SvelteKit's router. On every
navigation it reports the route, so a thread names the page by its route
rather than its address: on `src/routes/users/[id]`, the screen is
`users/:id` and the view state has `route.id: "42"`. Route groups and
matchers are left out, `[[lang]]` becomes `:lang?`, and `[...path]` becomes
`:path*`. A typed matcher's value, such as the number `42`, is stored as
text. Your
`getContext`, if you give one, adds to this: its keys win.

When a reviewer opens a thread from another page, Critiqs builds the
thread's address from its route (`/users/42`) and goes there with `goto`,
under your base path, unless that page is already showing. A thread whose
screen isn't one of your routes (a `screen` your `getContext` named, such as
`user-details`, even where a catch-all route would match its address) stays
where it is, and so does one whose page loads into an error page or a
redirect, or that a `beforeNavigate` guard cancels: Critiqs is told the view
couldn't be shown. While another navigation is under way, the thread stays
where it is too. If the reviewer closes the thread after SvelteKit has
started loading its page, Critiqs goes back to the page they were on, unless
the app has navigated since.
Give your own `restoreContext` to replace this, such as to open a tab or
dialog as well.

To turn route support off, set `router={false}`.

Plain Svelte apps have no standard router, so `critiqs-svelte` reports the
URL path as the screen. With your own router, pass it as `router`: the
current route's `pattern` in `:name` form (`/users/:id`, or null when none
matched), its `params`, and `navigate(path, request)`, which resolves once the
navigation has settled and throws when the path is none of your routes
(`request` is the thread's, with its `screen` and an abort `signal`). A
restore counts only when `pattern` and `params` then show the thread's route.

## License

MIT
