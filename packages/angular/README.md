# critiqs-angular

Critiqs for Angular apps. Add one provider and reviewers can comment on your
prototype, discuss feedback, and find the screen each comment was made on.

Works with standalone Angular apps from Angular 20 on, zoneless (the default
for new apps) or with zone.js, with or without server-side rendering.

## Install

```sh
npm install critiqs-angular
```

## Add Critiqs

Add `provideCritiqs` to the providers in `src/app/app.config.ts`:

```ts
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideCritiqs } from 'critiqs-angular';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideCritiqs({ projectId: 'your-project-id' }),
  ],
};
```

Without a `projectId`, the Critiqs sidebar walks you through creating a
project. Copy its ID into `projectId`.

In an app bootstrapped with an NgModule, add the same `provideCritiqs(…)` call
to the `providers` of the root module (`AppModule`).

## Settings

`provideCritiqs` takes the settings of the shared
[`critiqs`](https://www.npmjs.com/package/critiqs) package:

| Setting | What it does |
| --- | --- |
| `projectId` | The Critiqs project for this prototype. |
| `requireProjectId` | Show Critiqs only where `projectId` is a valid project ID. Without one, Critiqs adds nothing to the page and contacts no backend. |
| `backend` | Your team's own Critiqs backend. Defaults to Critiqs Cloud. |
| `version` | The prototype's version, such as a Git commit, recorded with each message. |
| `getContext` | Reports the current screen, view state, and demo persona. |
| `restoreContext` | Shows a thread's view again: navigate, select tabs, open dialogs. |
| `router` | `false` turns off [route reporting and the default restore](#routes). |

### Settings that use services, or change

Pass a function instead of an object. It runs in an injection context, so it
can call `inject()`, and it runs again whenever a signal it reads changes:

```ts
import { inject } from '@angular/core';
import { DemoSession } from './demo-session';

provideCritiqs(() => {
  const session = inject(DemoSession);
  return {
    projectId: 'your-project-id',
    getContext: () => ({ persona: session.persona() }),
  };
});
```

A signal of settings works too: `provideCritiqs(critiqsSettings)`.

### A project ID for each deployment

Angular reads no environment variables into app code, so give each deployment
its project ID through the app's own build configuration, such as
`environment.ts` files with `fileReplacements`, and set
`requireProjectId: true` so builds without an ID show nothing:

```ts
provideCritiqs({ projectId: environment.critiqsProjectId, requireProjectId: true })
```

## Routes

In an app with Angular Router (`provideRouter` or `RouterModule.forRoot`),
Critiqs follows the router on its own:

- **Each navigation reports its route.** The screen is the route's pattern,
  the `path`s of the activated routes from the root down to the page, without
  the leading slash: `/users/42` on the route `users/:id` is the screen
  `users/:id`, and the home page is `/`. The route's parameters become view
  state named `route.<name>`, here `{ "route.id": "42" }`. Every user's page
  is one screen, and each thread still names the record it was left on.
  Matrix parameters, query parameters, and the fragment aren't reported, and
  only the primary outlet counts, not named outlets. A page shown by a `**`
  wildcard route or a route with a custom `matcher` has no pattern to report,
  so its screen is the URL path.
- **Opening a thread navigates to its route.** Critiqs builds the path back
  from the screen and parameters (`/users/42`) and calls
  `router.navigateByUrl` inside Angular's zone, then waits for the navigation
  to finish and checks that the page now shows that route. If the app is
  already on that route with those parameters, nothing happens. Critiqs only
  navigates to a route in the app's own routes whose pattern is the thread's
  screen, so threads on a route the app no longer has, on a screen your
  `getContext` named (`billing-settings`), or from before route reporting
  don't open the app's "not found" page. When a route only loads its child
  routes on navigation (`loadChildren`), or a guard or redirect sends the
  navigation elsewhere, Critiqs finds out only by navigating. So it first
  navigates without changing the address bar (`skipLocationChange`). If the
  page shows the thread's route, the address bar then records it as one new
  history entry. If not, Critiqs navigates back to where the reviewer was,
  again without changing the address bar, so the address bar and history
  never moved. If a guard on the reviewer's own page refuses that way back,
  the address bar still shows the reviewer's page. Once the reviewer moves on
  (another thread, Back) or the app starts another navigation, Critiqs stops:
  it never navigates back over a newer navigation.

Your own settings still win:

- With `restoreContext`, Critiqs calls yours instead of navigating.
- With `getContext`, each key it reports (`screen`, `persona`) replaces the
  route's, and the route fills in the rest. `viewState` merges key by key: the
  keys you report (`{ tab: "billing" }`) sit beside the route's `route.<name>`
  parameters, and a key with the same name replaces the route's. A
  `screen` you report that isn't one of the app's route patterns can't be
  navigated to, so add a `restoreContext` if those threads should open.

To turn route reporting and the default restore off, set `router: false`:

```ts
provideCritiqs({ projectId: 'your-project-id', router: false })
```

Apps without Angular Router work as before: the screen is the URL path.

## How it runs

- **Only in the browser.** On the server (SSR, prerendering) `provideCritiqs`
  does nothing, so server-rendered pages never contain Critiqs.
- **Loaded after the app starts.** Critiqs is its own chunk, so it doesn't
  add to the app's initial bundle.
- **Outside Angular's zone.** In zone.js apps, Critiqs's own timers and
  events never trigger change detection. `restoreContext` runs inside the
  zone, so the navigation it starts updates the app.
- **Removed with the app.** Destroying the application removes Critiqs and
  everything it added to the page.

Critiqs draws its interface in a shadow root on the page's `<body>`, so the
app's styles don't change it and its styles don't change the app.

## License

MIT
