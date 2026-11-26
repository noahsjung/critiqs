# Releasing

How the Critiqs packages' shared version is calculated and released. Which
change needs which version, and what must stay compatible, is decided in
[versioning and compatibility](technical-direction.md#versioning-and-compatibility);
this page is the procedure.

**Built:** release notes on every pull request, a CI check of those notes, a
Release workflow that keeps one release pull request up to date with the
calculated version, changelogs, and `bun.lock`, and a manual Publish workflow
that publishes a released version to npm, RubyGems, and PyPI.
[Changesets](https://changesets.dev) does the calculation.
**Not built:** tests of older package versions against current backends, and
a deprecation and support-window policy. These remain required before the
first stable release.

## What is released

Every workspace package whose name matches the fixed group in
[`.changeset/config.json`](../.changeset/config.json), `critiqs` or
`critiqs-*`, is released, and they all share **one version**: a release note
for any of them moves every one to the same new version. The scripts read the
set from the workspace each time; no list of packages is kept anywhere else.

| Workspace package | Folder | Published as |
| --- | --- | --- |
| `critiqs` | `packages/critiqs` | npm `critiqs`, the shared package the others build on |
| `critiqs-react` | `packages/react` | npm `critiqs-react` (0.3.0 is on npm) |
| `critiqs-vue`, `critiqs-nuxt`, `critiqs-svelte`, `critiqs-angular`, `critiqs-astro`, `critiqs-solid` | `packages/<framework>` | npm, same name |
| `critiqs-rails` | `packages/rails` | RubyGems `critiqs-rails` |
| Django and Flask packages | `packages/django`, `packages/flask` | PyPI `django-critiqs`, `flask-critiqs` |

Framework packages other than `critiqs` and `critiqs-react` are added as each
lands. Where a package is published depends on its manifest:

- **npm:** a public package (no `"private": true`), under the MIT license, with
  `publishConfig.access` set to `public` and `LICENSE` in `files`. A
  dependency on another released package uses the exact shared version (for
  example `"critiqs": "0.3.0"`); Changesets keeps it in step.
- **RubyGems or PyPI:** a private package with
  `"critiqsRelease": { "registry": "rubygems" }` (or `"pypi"`) and a
  `release:build` script. That script builds the gem, or the wheel and source
  distribution, into `<package>/release/`, taking the version from the
  package's `package.json`. The registry name is read from the built file
  names, so the Django package can be named `django-critiqs` on PyPI. Publishing
  empties `release/` before each build. Use plain `MAJOR.MINOR.PATCH`
  versions: RubyGems and PyPI spell prerelease versions differently from npm.

The private workspaces `@critiqs/core`, `@critiqs/server`, and
`@critiqs/backend` ship inside the packages that bundle them (`critiqs-react`
bundles all three; `critiqs` bundles `@critiqs/core`). They, the examples,
and the repository root are never versioned or published (`ignore` in the
Changesets configuration). Versioning never publishes anything.

The backend protocol (`BACKEND_PROTOCOL`) is a separate number and is not
calculated here. A release note does not change it.

## Every pull request adds a release note

Add a file to `.changeset/` in the same pull request, naming each package the
change ships in. A change to a bundled private workspace names the packages
that bundle it. Every package ships at the shared version either way; the names
decide whose changelog gets the entry. Choose the release type from what the
change does to host apps, read from the diff, never from commit or pull request
titles:

| Change | Note |
| --- | --- |
| Backward-compatible fix to shipped behavior | `patch` |
| Backward-compatible addition, or deprecation without removal | `minor` |
| Incompatible public change, from 1.0.0 on | `major` |
| Nothing ships: documentation, tests, examples, CI, or release tooling | no release, with the reason |

```sh
bun run changeset add --patch critiqs-react -m "Fix the toolbar covering the sidebar."
bun run changeset add --minor critiqs,critiqs-react -m "Add the optional onOpen setting."
bun run changeset add --empty -m "Documentation only: no shipped file changes."
```

Running `bun run changeset` without options asks interactively. The summary
becomes the changelog entry, so write it for host developers: what changed for
them, and for a breaking change, how to migrate.

**Before 1.0.0** a release note may not be `major`: 1.0.0 is the owner's
decision. Under Semantic Versioning, `^0.2.0` accepts only 0.2.x, so a
breaking change is released as a `minor` note. It still needs the owner's
approval and migration instructions first; 0.x permits breaking no host app.

Several notes in one pull request are fine; the largest type across all notes
sets the shared version. Do not edit
or remove another pull request's note, and do not change any `version` field
or `CHANGELOG.md` yourself.

Reviewers check that the declared type matches the diff. CI checks the form of
the note, not whether the type is right.

## What CI checks

The `release-notes` job in [CI](../.github/workflows/ci.yml) runs
`bun scripts/release.ts check` on the pull request's own commits, from the
merge base with its target branch. It fails when:

- no release note was added, or a note is malformed, has no summary, names a
  package outside the release group (a private workspace, a registry name such
  as `django-critiqs`, or anything else), or uses a type other than patch,
  minor, or major (`major` only from 1.0.0);
- a file that ships changed (anything under `packages/` except tests) and the
  only notes are no-release notes;
- an existing note was edited or removed, a `version` field changed, a
  `CHANGELOG.md` changed, or another file was added to `.changeset/`, unless
  the pull request is a verified release pull request (below);
- a note's file name is one the Changesets CLI skips: hidden names, any
  capitalization of `README.md`, `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.

Paths are read exactly as Git stores them, so unusual file names get the same
rules.

A release pull request is verified by content, not by its branch name: it
must be a single commit directly on top of a commit already on the target
branch, and rerunning the version step on that commit in a scratch checkout
must produce exactly the same files.

## The release pull request

The [Release workflow](../.github/workflows/release.yml) runs on each push to
`main`, one run at a time. When `main` has release notes that release
something, it runs `bun scripts/release.ts version`, which runs
`changeset version` (every released package's version and `CHANGELOG.md`,
dependencies between them, consumed notes), refreshes `bun.lock` with
`bun install --lockfile-only`, and checks that every package ended at the same
version. It then force-pushes that single commit to `changeset-release/main`
and opens or updates the one pull request titled "Release Critiqs _version_"
from this repository's branch, listing each package's changelog entry; a
fork's pull request from a branch with the same name is left alone.

- A rerun for an unchanged `main` pushes nothing. When nothing is left to
  release, it closes an open release pull request; after a release is merged,
  it does nothing. No-release notes wait and are removed with the next release.
- Pushes with the workflow's token start no workflows, and pull request events
  it causes wait for approval, so it starts CI on the release branch with
  `workflow_dispatch` whenever no such run exists yet for the branch's
  commit, including after an earlier attempt failed partway. Those checks run
  on the release commit itself. A failed CI run is not rerun automatically.
  An "approval required" `pull_request` run may also appear; it can be
  approved or ignored.
- Do not push to `changeset-release/main`; the next run replaces it, and
  hand edits fail the release check.
- A person reviews and merges the release pull request. The workflow never
  merges or approves, and it publishes and deploys nothing.

Merging the release pull request records the version on `main`. Publishing
that version is a separate step a maintainer starts.

## Publishing

The owner approved publishing the Critiqs packages publicly under the MIT
license. Nothing publishes automatically: pull requests, pushes, and the
Release workflow never do.

1. Merge the release pull request, so `main` records the version and no
   release note waits.
2. Start the [Publish workflow](../.github/workflows/publish.yml) on `main`,
   naming that version. Its jobs run in order:
   - **verify**, with no publishing rights:
     `bun scripts/publish.ts verify --version <version>` refuses a version
     other than `main`'s, unversioned release notes (they would ship under an
     older version), a package in the group with no registry, an npm manifest
     that is unlicensed, not public, or depends on another Critiqs package at
     a different version, and gem or Python files built at a different
     version. It lists each package as "to publish" or "already published,
     skipped". Then every check runs, including `check:consumers`.
   - **npm**, after approval in the `npm` environment: `npm publish --access
     public` in each package npm doesn't have yet, each after the Critiqs
     packages it depends on (`critiqs` first).
   - **rubygems** and **pypi**, after npm, each after approval in its own
     environment: the packages are built, files the registry doesn't have yet
     are staged, and `gem push` (with a short-lived key from
     `rubygems/configure-rubygems-credentials`) or
     `pypa/gh-action-pypi-publish` uploads them.
3. Check each package page, and install the packages in a new app.

Each job skips what its registry already has, so after a partial failure,
start the workflow again with the same version: only what is missing is
published. To see what a run would do, run the same commands locally on a
clean checkout of `main`:

```sh
bun scripts/publish.ts verify --version <version>
bun scripts/publish.ts publish --registry npm --version <version> --dry-run
bun scripts/publish.ts stage --registry rubygems --version <version> --out .local/rubygems
bun scripts/publish.ts stage --registry pypi --version <version> --out .local/pypi
```

`--dry-run` runs `npm publish --dry-run`, and `stage` only builds and copies
files, so none of these upload anything.

### Trusted publishing setup

Every registry accepts the workflow's OpenID Connect identity, so no token is
stored. The owner sets each one up before the packages it covers are first
published:

- **Environments:** create `npm`, `rubygems`, and `pypi` in the repository's
  settings, each with required reviewers and `main` as its only deployment
  branch.
- **npm, for each npm package:** npm can trust a workflow only for a package
  that exists, so publish its first version by hand: on a clean checkout of
  `main`, run `bun install --frozen-lockfile`, `bun run check`,
  `bun scripts/publish.ts verify --version <version>`, and then
  `npm publish --access public` in the package's folder, `critiqs` before the
  others, with the owner's npm account and two-factor authentication. Then add
  this repository, workflow `publish.yml`, and environment `npm` as the
  package's trusted publisher in its npm settings, and disallow token-based
  publishing there. `critiqs-react` was first published this way.
- **RubyGems:** add a trusted publisher for `critiqs-rails` (repository
  `noahsjung/Critiqs`, workflow `publish.yml`, environment `rubygems`). Before
  the gem exists, add it as a pending trusted publisher in the account's
  RubyGems settings and set the repository variable `RUBYGEMS_OWNER` to the
  owning account's ID; the workflow's first push then creates the gem.
- **PyPI:** add a trusted publisher for `django-critiqs` and `flask-critiqs`
  (owner `noahsjung`, repository `Critiqs`, workflow `publish.yml`,
  environment `pypi`). Before a project exists, add it as a pending publisher
  in the account's PyPI publishing settings; the first upload creates it.

npm adds provenance automatically when the source repository and package are
both public, and does not support it for private source repositories, so the
workflow does not force `--provenance`. For the same reason the PyPI upload
turns off attestations until the repository is public. See
[npm's trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/),
[RubyGems trusted publishing](https://guides.rubygems.org/trusted-publishing/),
and [PyPI trusted publishers](https://docs.pypi.org/trusted-publishers/).

A published version can't be replaced on any registry. To withdraw a broken
one, deprecate it on npm (`npm deprecate <package>@<version> "<reason>"`), yank
it on RubyGems (`gem yank`) or PyPI, and release a fix.

## Adding a package

1. Name the workspace package `critiqs-<name>` so the fixed group picks it up,
   and start it at the current shared version. A PyPI project can have a
   different registry name (`django-critiqs`); the workspace name still
   matches the group.
2. For npm, make it public as above, with an exact dependency on `critiqs`.
   For RubyGems or PyPI, keep it private and add `critiqsRelease` and
   `release:build`.
3. Its first release note names it, for example `minor` for `critiqs-<name>`.
4. Before the first publish that includes it, the owner sets up its registry
   as described in [Trusted publishing setup](#trusted-publishing-setup): a
   first manual publish for an npm package, or a pending publisher on RubyGems
   or PyPI.

## Limits

- The repository's plan does not allow branch protection or rulesets, so a
  failing check does not block merging. Whoever merges must see every check
  pass on the pull request's latest commit.
- The check runs from the pull request's own code. Review changes to
  `scripts/release.ts`, `scripts/publish.ts`, `.changeset/config.json`, and
  the workflows closely.
- Workflows start only once they are on `main`: the Release and Publish
  workflows and the `workflow_dispatch` trigger for CI take effect after the
  pull request that adds them is merged.
- The workflow needs the repository's Actions setting "Allow GitHub Actions to
  create and approve pull requests". It requests only the permissions it
  needs; the default workflow token stays read-only.
- Changesets 3 documents npm, pnpm, and Yarn. With Bun, the version step runs
  the Changesets CLI under Node (22.11 or later), and Bun owns installs and
  `bun.lock`; `bun run test:release` exercises this with the real CLI.
