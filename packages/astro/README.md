# critiqs-astro

Critiqs for Astro: people comment directly on an interactive prototype,
discuss feedback, and find its original context as the prototype changes.

This package is an Astro integration. It adds Critiqs to every page of the
site from a script that runs only in the browser; nothing runs on the server
and pages render exactly as before.

## Install

```sh
npm install critiqs-astro
```

Add `critiqs()` to `integrations` in `astro.config.mjs`, keeping any
integrations already in the list:

```js
import { defineConfig } from 'astro/config';
import critiqs from 'critiqs-astro';

export default defineConfig({
  integrations: [critiqs()],
});
```

With no options, Critiqs reads the project ID from the public variable
`PUBLIC_CRITIQS_PROJECT_ID`. Set it in `.env` for your computer (Astro's
starter keeps `.env` out of Git) and in each deployment's build environment:

```sh
PUBLIC_CRITIQS_PROJECT_ID=YOUR_PROJECT_ID
```

Astro writes the value into the site when it builds, so a change takes effect
with the next build. A build without the variable, or with a value that isn't
a project ID, adds nothing to its pages and contacts no backend.

## Options

```js
critiqs({ projectId: 'YOUR_PROJECT_ID', backend: 'https://critiqs.example.com' })
```

- `projectId`: the Critiqs project, written into the config. Without it,
  Critiqs reads `projectIdVariable`.
- `projectIdVariable`: the variable that holds the project ID. Defaults to
  `PUBLIC_CRITIQS_PROJECT_ID`; it must start with `PUBLIC_`, since Astro gives
  the browser only those.
- `requireProjectId`: show Critiqs only where the project ID is a valid
  project ID. Defaults to true when the ID comes from a variable and false when
  `projectId` is written in the config, where Critiqs without a project shows
  project setup.
- `backend`: a team's own backend. Defaults to Critiqs Cloud.
- `version`: the prototype's version, such as a release label or Git commit,
  recorded with each message.
- `router`: report routes and open a thread's page (below). Defaults to true.

A mistake in these options stops `astro dev` and `astro build` with a message
naming it.

## Routes

Each page reports its route as the screen, so a thread names the page it was
left on whatever record it showed. A thread on `/items/42`, served by
`src/pages/items/[id].astro`, has the screen `items/:id` and the view state
`route.id: "42"`; `src/pages/docs/[...slug].astro` gives `docs/:slug*`, and
the home page is `/`. Astro's routes come with the script when the site
builds, and the browser matches the current URL against them in Astro's own
order, on the first page and after every navigation. A URL no route matches,
such as a 404 page, keeps the URL path as its screen.

To show a thread on another page, Critiqs builds that page's path from the
screen and the `route.` values and goes there: with `navigate()` from
`astro:transitions/client` on a site with `<ClientRouter />`, and with a page
load otherwise. A page whose file name mixes parameters and text
(`[slug].html.astro`, `[lang]-[version].astro`) is built from its route. A
screen this site has no route for isn't opened, and restore reports that it
couldn't show the thread when the navigation ends on another page, such as
after a redirect, or on the 404 page shown at that URL because the page no
longer exists (an item removed from `getStaticPaths`). To tell them apart,
the integration adds a middleware that marks each page with the route Astro
rendered it from (`<meta name="critiqs-astro-route" content="/items/[id]">`).

To turn this off, pass `router: false`; the screen is then the URL path, and
nothing navigates unless you give `restoreContext` (below).

## View transitions

With `<ClientRouter />`, Astro swaps each page's whole `<body>` on
navigation. Critiqs is carried into the new body, as `transition:persist` does
for a page's own elements, so its sidebar, sign-in, and drafts stay as they
were and the page has one Critiqs throughout.

## Reporting more of the view

`getContext` and `restoreContext` are functions, so they can't go in
`astro.config`. Give them from a script in your layout with
`configureCritiqs`, which works whether it runs before or after Critiqs
starts:

```astro
<script>
  import { configureCritiqs } from 'critiqs-astro/client';

  configureCritiqs({
    getContext: () => ({ viewState: { tab: document.querySelector('[aria-selected="true"]')?.id ?? null } }),
  });
</script>
```

- What `getContext` reports wins over the route, key by key; the route fills
  in the rest.
- A `restoreContext` you give replaces the one that opens a thread's page.
  Return `false` when the view can't be shown. To open the page first and
  then show the rest of the view, call `restoreRoute(request)` from
  `critiqs-astro/client` in it: it resolves once the page is shown, or gives
  `false` when this site has no page for the thread's screen or the
  navigation ended somewhere else.

Each call replaces both functions.

Elements with the `data-critiqs-mask` attribute are covered in screenshots,
and `data-critiqs-id` gives an element a stable name for comments.

## Requirements

Astro 5 or later.

## License

MIT
