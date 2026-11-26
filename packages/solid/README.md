# Critiqs for Solid

Reviewers comment directly on a running prototype, discuss feedback, and find
its original context as the prototype changes. Critiqs brings its own toolbar,
sidebar, sign-in, and styles. This package adds it to a Solid app: a Vite app
made with `npm create solid`, Solid 2's own server rendering, or SolidStart.
It works with Solid 1.9 and Solid 2; `solid-js` is a peer dependency.

## Set up

```sh
npm install critiqs-solid          # or: pnpm add, yarn add, bun add
```

Render `<Critiqs />` once, in the component every page renders. In an app
with Solid Router, import it from `critiqs-solid/router` so threads name
routes (see [Routes](#routes)); otherwise from `critiqs-solid`.

- A Vite app (`npm create solid`): inside the element `src/App.tsx` returns.
  When it returns a `<Router>`, put it inside the layout the router renders.
- SolidStart: inside the layout passed to `<Router root={…}>` in `src/app.tsx`.

```tsx
import { Critiqs } from "critiqs-solid"; // with Solid Router: "critiqs-solid/router"

export default function App() {
  return (
    <main>
      {/* your app */}
      <Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />
    </main>
  );
}
```

```sh
# .env.local (this computer only)
VITE_CRITIQS_PROJECT_ID=<project ID>
```

Copy the project ID from project setup in the Critiqs sidebar; it is public
configuration, not a secret. With `requireProjectId`, Critiqs appears only
where the variable holds a valid project ID: a copy built without it adds
nothing to the page and contacts no backend. Each deployment that should show
Critiqs sets `VITE_CRITIQS_PROJECT_ID` in its build settings; Vite writes the
value into the app when it builds. To give every copy the same project, write
the ID instead: `<Critiqs projectId="<project ID>" />`.

## Settings

`<Critiqs />` takes the shared `critiqs` package's settings as properties:
`projectId`, `requireProjectId`, `backend` (a team's own backend),
`version`, `getContext`, and `restoreContext`. See the
[`critiqs` package](https://github.com/noahsjung/critiqs/tree/main/packages/critiqs)
for what each one does. Changing a property updates Critiqs; removing the
component removes Critiqs from the page.

## Routes

`critiqs-solid/router` works with Solid Router 1 and 2 (SolidStart uses
Solid Router). Rendered inside the router, such as in SolidStart's
`<Router root={…}>` layout, it reports each route as you navigate:

- The screen is the route's pattern without its leading slash, so every
  user's page is one screen: `/users/42` is `users/:id`, and the home page is
  `/`. A rest route (`*rest`, from a SolidStart `[...rest].tsx` file) is
  `files/:rest*`.
- The route's parameters are view state, decoded as the app reads them:
  `route.id` is `42`, and `/items/caf%C3%A9%20menu` gives `café menu`. A rest
  route keeps each segment apart, so `/files/one%2Ftwo/leaf` opens again on
  the same two segments, `one/two` and `leaf`.
- A router with a `base` (`<Router base="/demo">`) reports patterns without
  it: `/demo/users/42` is still `users/:id`.

When a reviewer opens a thread left on another route, Critiqs builds its path
from the screen and parameters (`/users/42`) and navigates there with the
router's `navigate`, under the router's base, then waits up to three seconds
for the route to load. A thread already on the shown route doesn't navigate.
Critiqs says the view can't be shown, rather than waiting, when the screen
isn't a route pattern, when the route has changed so the path now leads to
another route (such as a catch-all page) or none, when a `useBeforeLeave`
guard keeps the page, when the route is still loading after three seconds,
or when the reviewer moves on first. In the last two cases Critiqs only stops
waiting: the router may still finish loading the route and show it. Critiqs
never navigates again to undo it, so it can't undo a navigation your app made
itself or add a history entry.

Your own settings still win. A `restoreContext` you pass replaces the
navigation. A `getContext` you pass is combined with the route: each key it
reports wins over the route's, and the route fills in the rest. To turn route
reporting and navigation off, pass `router={false}`. Outside a router, or with
a router older than Solid Router 1, `critiqs-solid/router` works as
`critiqs-solid` does.

## Server rendering

Critiqs runs only in the browser. When SolidStart or Solid renders a page on
the server, `<Critiqs />` renders nothing there and never loads Critiqs. The
browser loads Critiqs in its own chunk after the page first renders, so the
app's first load doesn't wait for it.

## License

MIT
