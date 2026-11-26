# critiqs

Critiqs for any web app: people comment directly on an interactive
prototype, discuss feedback, and find its original context as the prototype
changes.

This is the shared package. Most apps install the package for their
framework, which builds on this one:

| Framework | Package |
| --- | --- |
| React, Next.js | [`critiqs-react`](https://www.npmjs.com/package/critiqs-react) |
| Vue | `critiqs-vue` |
| Nuxt | `critiqs-nuxt` |
| Svelte, SvelteKit | `critiqs-svelte` |
| Angular | `critiqs-angular` |
| Astro | `critiqs-astro` |
| Solid | `critiqs-solid` |
| Ruby on Rails | the `critiqs-rails` gem |
| Django | `django-critiqs` on PyPI |
| Flask | `flask-critiqs` on PyPI |

Use `critiqs` directly in any other app, or in a page with no build at all.

## Set up with the CLI

```sh
npx critiqs init
```

Run it in the app's folder. It finds the app's framework, adds Critiqs where
the app renders, signs you in, creates a project on Critiqs Cloud, and
connects the app to it. When the app doesn't list its framework's Critiqs
package yet, it says which one to install. `npx critiqs init <projectId>`
connects a project you already have, and `npx critiqs doctor` checks the
setup; `npx critiqs --help` lists every option. Coding agents can follow
[AGENT_SETUP.md](AGENT_SETUP.md), and `npx critiqs mcp` offers the same steps
to them as MCP tools. `critiqs/server` runs Critiqs inside your app's own Node
or Bun server instead of Critiqs Cloud; see the `critiqs-react` README.

## With a script tag

The quickest way in, for any site. Add one tag, replacing `X.Y.Z` with the
exact version of `critiqs` on npm:

```html
<script
  src="https://cdn.jsdelivr.net/npm/critiqs@X.Y.Z/dist/critiqs.js"
  data-project-id="YOUR_PROJECT_ID"
  async
></script>
```

jsDelivr and unpkg serve every published version of this package, so there
is nothing to host. Always name an exact version, never `latest`: a floating
version would change Critiqs on your site without your say. To serve it
yourself, copy `node_modules/critiqs/dist/critiqs.js`.

With `data-project-id`, the script adds Critiqs to the page, but only when
the value is a valid project ID: an empty or malformed one (such as a server
variable left unset in a deployment) adds nothing and contacts no backend.
`data-backend` and `data-version` set the settings below. Without
`data-project-id`, it adds nothing until you call `window.Critiqs.update({
projectId })`.

Report the view the reviewer is on, such as after your page changes tabs:

```js
window.Critiqs.setContext({ screen: "users/:id", viewState: { tab: "billing" } });
```

The script fires `critiqs:ready` on `document` once `window.Critiqs` exists.
To report the view from the start, set `window.Critiqs = { context: { screen:
"users/:id" } }` before the script tag.

In apps that swap pages without reloading them, such as with Turbo, use
the element below instead: it adds and removes Critiqs with each page.

## With an element

Load the element bundle and add `<critiqs-app>` once. It renders nothing in
place; Critiqs draws its toolbar, sidebar, and pins above the page in its own
shadow root.

```html
<critiqs-app project-id="YOUR_PROJECT_ID" require-project-id></critiqs-app>
<script type="module" src="/critiqs/element.js"></script>
```

Serve `node_modules/critiqs/dist/element.js` from your site; it carries
everything it needs.

Attributes:

- `project-id`: the Critiqs project for this prototype. Without one, the
  sidebar shows project setup, unless `require-project-id` is set.
- `require-project-id`: show Critiqs only where `project-id` is a valid
  project ID, such as one a server reads from each deployment's environment.
  Without one, Critiqs adds nothing to the page and contacts no backend.
- `backend`: a team's own backend. Defaults to Critiqs Cloud.
- `version`: the prototype's version, such as a release label or Git commit,
  recorded with each message.

`getContext` and `restoreContext` are functions, so set them as properties
from a script:

```js
const critiqs = document.querySelector("critiqs-app");
critiqs.getContext = () => ({ screen: location.pathname });
critiqs.setContext({ screen: "checkout", viewState: { step: "payment" } });
```

## From JavaScript

```js
import { mountCritiqs } from "critiqs";

const critiqs = mountCritiqs({ projectId: "YOUR_PROJECT_ID", requireProjectId: true });
critiqs.update({ projectId: "YOUR_PROJECT_ID", requireProjectId: true, version: "1.4.2" });
critiqs.setContext({ screen: "users/:id" });
critiqs.destroy();
```

`mountCritiqs` runs only in the browser. Call it once the page has loaded,
such as in a component's mounted hook, and call `destroy` when the component
goes away. `update` replaces every setting, as a component re-rendered with
new properties would.

Settings:

- `projectId`, `requireProjectId`, `backend`, `version`: as the attributes
  above.
- `getContext()`: reports the current screen, view state, and demo persona,
  so each thread names the view it was left on.
- `restoreContext(request)`: shows a thread's view again, such as by
  navigating and opening a tab. Return `false` when the view can't be shown.

`setContext(context)` pushes the current view instead of being asked for it,
for pages without a component tree to read it from, or from router events.
Each call replaces what was pushed before; `{}` clears it. When `getContext`
is also set, each key it reports wins over the pushed one, and pushed keys
fill in the rest. The screen defaults to the URL path.

`routeContext(pattern, params)` and `routePath({ screen, viewState })`
report a router's routes and build them back: the pattern is the screen
(`/users/:id` is `users/:id`) and parameters are view state (`route.id`).
Import them from `critiqs/router`, which carries none of Critiqs's interface,
so an app can report routes before Critiqs loads.

Elements with the `data-critiqs-mask` attribute (`MASK_ATTRIBUTE`) are covered
in screenshots, and `data-critiqs-id` gives an element a stable name for
comments.

## License

MIT. The self-hosted server (`critiqs/server`) includes data from the
[Public Suffix List](https://publicsuffix.org/list/), under the
[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/); its source form is
at that address and in this repository's `packages/server/src/public-suffixes.ts`.
