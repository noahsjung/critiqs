# Critiqs

Critiqs lets people comment directly on an interactive prototype, discuss feedback,
and find its original context as the prototype changes.

The first release is a React package installed in an application the team controls.
The library lives in a separate repository and uses Bun for development.
Convex stores shared feedback: Critiqs Cloud by default, or a team's own Convex deployment. Screenshots can be stored in a private Cloudflare R2
bucket, with Convex retaining their metadata and access checks, or in native
Convex file storage. Teams can also self-host Critiqs inside their app's own
Node or Bun server, storing feedback in a SQLite file
([ways to run Critiqs](docs/technical-direction.md#ways-to-run-critiqs)).

## Project documents

1. [Product brief](docs/brief.md): purpose, problem, users, and principles.
2. [First release and roadmap](docs/first-release.md): intended behavior and later directions.
3. [Technical direction](docs/technical-direction.md): proposed approach, stack, and open choices.
4. [Glossary](docs/glossary.md): shared product terms.
5. [Releasing](docs/releasing.md): release notes on every pull request and the generated release pull request.
6. [Tags, tag groups, and AI](docs/tags-and-ai.md): plan and status for hashtags, tag groups, AI search and insights, and shortcuts.
7. [Verifying setup](docs/setup-verification.md): automated checks of installation in React apps, and the live checks that need people.

These are working definitions. Proposed choices remain open.

## Repository

The first release is built and ready to publish as `critiqs-react` under the
[MIT license](LICENSE); it is not on npm yet, and Critiqs Cloud still runs an
earlier backend. [First-release status](docs/first-release.md#implementation-status)
lists what works and what remains.

| Path | Contents |
| --- | --- |
| `packages/core` | Framework-independent logic: anchors, target location, read state, sidebar grouping, links, export, and the backend contract. |
| `packages/server` | Critiqs's server rules over a storage interface, with a SQLite store and contract tests every backend passes. |
| `packages/backend` | Convex schema, server functions, and Critiqs's sign-in service, shared by Critiqs Cloud and team-owned deployments. |
| `packages/react` | The `<Critiqs />` component (toolbar, sidebar, pins, commenting, setup) and the `critiqs init` command. |
| `examples/pilot` | Small React host app for the [pilot scenarios](docs/first-release.md#pilot-scenarios). |
| `site` | The [critiqs.app](https://critiqs.app) landing page: static HTML, CSS, and JavaScript with no build step, deployed by Vercel from `main` (pull requests get preview links). |
| `site-src` | The sample app and script that record the landing page's clips from the real Critiqs UI ([how to run it](site-src/README.md)). |

```sh
bun install
bun run check                        # typecheck and test every package
bun run check:package                # pack and install the release candidate in isolated React 18 and 19 consumers
bun run check:consumers              # build Vite and Next.js apps set up by critiqs init (needs the npm registry)
bun run measure:setup                # time the developer's setup steps, from install to a saved comment
```

Use Bun 1.4.2 or later (CI uses 1.4.2); older versions rewrite `bun.lock`.

The React package is `critiqs-react`. `bun run build` emits its browser ES
module (marked `"use client"`), public type declarations, the Node CLI, and
the backend it can deploy. Every pull request adds a release note
(`bun run changeset`); a generated release pull request calculates the
version, and a maintainer publishes it to npm with the manual Publish workflow
([releasing](docs/releasing.md)).

### Run the pilot locally

A local Convex deployment acts as both backend and sign-in service. Its sign-in
window shows each code instead of emailing it:

```sh
cd packages/backend
bunx convex dev                      # choose a local deployment; keep it running
bun run setup:local                  # in another terminal: signing key, issuer, development sign-in

cd ../../examples/pilot
echo "VITE_CRITIQS_BACKEND=http://127.0.0.1:3210" > .env.local
bun run dev
```

Until `setup:local` runs, `convex dev` reports that `CRITIQS_AUTH_ISSUER` is not
set; it retries once the settings exist. Open the pilot, choose **Set up Critiqs**, sign in, and create a project. To share
it with other browsers, add `VITE_CRITIQS_PROJECT_ID=<project ID>` to
`examples/pilot/.env.local` and restart the dev server.

A deployment that runs the sign-in service sets `CRITIQS_AUTH_PRIVATE_KEY` (an
ES256 private JWK), `CRITIQS_AUTH_ISSUER` (its own `.convex.site` URL),
`RESEND_API_KEY`, and `CRITIQS_EMAIL_FROM` (an address on a domain verified in
Resend, such as `Critiqs <sign-in@example.com>`). A team's own deployment that
trusts Critiqs Cloud's sign-in sets only `CRITIQS_AUTH_ISSUER`, to Critiqs Cloud's
sign-in service.

For private R2 screenshot storage, see [R2 setup](docs/technical-direction.md#private-r2-screenshot-storage). R2 credentials stay on the Convex backend; host applications need no storage secrets.

Contributor guidance is in [AGENTS.md](AGENTS.md).
