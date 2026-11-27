# critiqs-rails

[Critiqs](https://github.com/noahsjung/critiqs) for Ruby on Rails apps:
reviewers comment on your running prototype, discuss feedback, and find the
screen and state each comment was made in.

Requires Ruby 3.3 or later and Rails 7.1 or later with Propshaft or Sprockets
(every `rails new` app has one).

## Set up

Add the gem and the tag:

```sh
bundle add critiqs-rails
bin/rails generate critiqs:install
```

The generator adds `<%= critiqs_tag %>` just before `</body>` in
`app/views/layouts/application.html.erb`. Or run `npx critiqs init`, which
does both. Both edit only what they can read the way Rails does (a whole
`<%= critiqs_tag ... %>` tag, whose arguments they change in place, and the
page's own `</body>` rather than one inside ERB code, a comment, a script, a
`<textarea>`, the `<title>` or an attribute value) and otherwise print the
steps to finish by hand. When a view already calls `critiqs_tag`, such as a
partial the layout renders, neither adds a second.

Keep `gem "critiqs-rails"` at the top level of the Gemfile, outside any
`group` or condition and without `require: false`: the layout calls
`critiqs_tag` in every environment, so production needs the gem even where
Critiqs stays hidden. Neither the generator nor `critiqs init` adds the tag
while the Gemfile might keep the gem from production (a group, `platforms`,
`require: false`, or a condition such as `if`, `install_if` or `env`, even one
this computer meets now, however the declaration is split across lines).

Then set your project's ID in each environment that should show Critiqs, and
restart the server:

```sh
CRITIQS_PROJECT_ID=j1234… bin/rails server
```

Where `CRITIQS_PROJECT_ID` is unset, the tag renders nothing: production can
run without Critiqs while a review deployment shows it. `npx critiqs init`
sets it for development: in `.env` when the app uses dotenv (or, when a plain
`ENV["CRITIQS_PROJECT_ID"] = "…"` line in `config/environments/development.rb`
would override `.env`, in that line), and otherwise as a default at the end of
`config/environments/development.rb`, which an environment variable still
overrides. It rewrites a line you wrote only when the line sets one string,
with nothing but a comment after it and no condition around it; it leaves any
other line as it is, puts its own value where Rails reads it first, and says
which value the app uses:

```ruby
ENV["CRITIQS_PROJECT_ID"] ||= "<project ID>"
```

## `critiqs_tag`

```erb
<%= critiqs_tag %>
<%= critiqs_tag(project_id: "j1234…", backend: "https://your-team.example/critiqs", version: ENV["GIT_SHA"]) %>
```

| Option | Default | Meaning |
| --- | --- | --- |
| `project_id` | `ENV["CRITIQS_PROJECT_ID"]`, read on each render | The Critiqs project. |
| `require_project_id` | `true` | Show Critiqs only where `project_id` is set; without one, render nothing. Pass `false` to show project setup instead. |
| `backend` | Critiqs Cloud | Your team's own Critiqs backend URL. |
| `version` | none | The prototype's version, such as a release or commit, recorded with each message. |
| `screen` | the matched route's pattern | The screen threads on this page belong to; see [Routes](#routes). `false` uses the URL path. |
| Other options | | HTML attributes for the `<critiqs-app>` element, such as `id`. |

The tag renders a `<critiqs-app>` element carrying the page's route in its
`data-critiqs-context` attribute, and two `<script type="module">` tags: one
loads Critiqs, the other a few lines from this gem that hand the route to
Critiqs whenever the attribute changes. Both come from your asset pipeline,
fingerprinted and precompiled like your own assets. Apps with import maps need
no pin.

Critiqs draws above your page in its own shadow root and reads the page only
through the DOM. To report more of the view than the route, such as an open
tab, or to show a thread's view again without a page load, set `getContext`
and `restoreContext` on the element from your JavaScript; the
[critiqs package](https://github.com/noahsjung/critiqs/tree/main/packages/critiqs)
describes them and how they combine with the reported route.

## Routes

Each page reports the route Rails matched, so every thread on any user's page
belongs to one screen:

| Route | Page | Screen | View state |
| --- | --- | --- | --- |
| `get "users/:id"` | `/users/42` | `users/:id` | `{ "route.id": "42" }` |
| `root "pages#home"` | `/` | `/` | `{}` |
| `get "docs/*path"` | `/docs/a/b` | `docs/:path*` | `{ "route.path": "a/b" }` |

`critiqs_tag(screen: "user-details")` names the screen yourself and keeps the
route's parameters; `critiqs_tag(screen: false)` reports nothing, so Critiqs
uses the URL path.

An optional parameter, `get "posts(/:page)"`, becomes `posts/:page?`. A route
with any other optional part, such as `get "posts(/page/:page)"`, reports the
URL path instead, since no one screen rebuilds both `/posts` and
`/posts/page/2`. So does a parameter inside a path segment, such as
`get "release-:version"`, since a screen fills in only whole segments.

Opening a thread saved on another page doesn't change the page by itself:
the sidebar shows the context the thread was saved with (its screen and
view state). To go to the thread's page, set `restoreContext` on the
`<critiqs-app>` element from your JavaScript; `routePath` from the critiqs
package's `critiqs/router` turns the screen and view state back into a path
such as `/users/42`, or null when it can't, for `Turbo.visit` or
`location.assign`.

## Turbo and Content Security Policy

Critiqs works with Turbo Drive: each visit reports the new page's route, Back
and Turbo's page cache keep one Critiqs, and so do frame visits. A page
refresh that Turbo morphs (`turbo_refreshes_with method: :morph`, or a
broadcast refresh) reports the screen the refreshed page names, such as
`critiqs_tag(screen: @screen)` with a new `@screen`. A
`<turbo-frame>` visit that advances the URL (`data-turbo-action="advance"`)
renders only the frame, so the page keeps reporting the route it was loaded
with until the next visit that renders the layout.

Critiqs renders no inline script. When the app sets a nonce generator
(`content_security_policy_nonce_generator` with `script-src` in
`content_security_policy_nonce_directives`), both module scripts carry the
request's nonce; without one, a `script-src` with `'self'` loads them from
your asset host. With Turbo, use a nonce that stays the same for
the session, as Rails's generated initializer suggests, or Turbo visits can't
run any page scripts. Critiqs's styles are a constructed stylesheet in its
shadow root, so a `style-src` that allows only nonces, as Rails suggests,
still shows Critiqs.

## License

MIT
