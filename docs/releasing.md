# Releasing

How `critiqs-react`'s version is calculated and released. Which change needs
which version, and what must stay compatible, is decided in
[versioning and compatibility](technical-direction.md#versioning-and-compatibility);
this page is the procedure.

**Built:** release notes on every pull request, a CI check of those notes, a
Release workflow that keeps one release pull request up to date with the
calculated version, changelog, and `bun.lock`, and a manual Publish workflow
that publishes a released version to npm. [Changesets](https://changesets.dev)
does the calculation.
**Not built:** tests of older package versions against current backends, and
a deprecation and support-window policy. These remain required before the
first stable release.

## What is released

`critiqs-react` (`packages/react`) is the only release unit. It bundles the
private workspaces `@critiqs/core`, `@critiqs/server`, and `@critiqs/backend`,
so a change that ships from any of them is a `critiqs-react` release.
Those workspaces, the examples, and the repository root are never versioned or
published (`ignore` in [`.changeset/config.json`](../.changeset/config.json)).
`critiqs-react` is public, under the MIT license, with `publishConfig.access`
set to `public`; versioning it never publishes it.

The backend protocol (`BACKEND_PROTOCOL`) is a separate number and is not
calculated here. A release note does not change it.

## Every pull request adds a release note

Add a file to `.changeset/` in the same pull request. Choose the release type
from what the change does to host apps, read from the diff, never from commit
or pull request titles:

| Change | Note |
| --- | --- |
| Backward-compatible fix to shipped behavior | `patch` |
| Backward-compatible addition, or deprecation without removal | `minor` |
| Incompatible public change, from 1.0.0 on | `major` |
| Nothing ships: documentation, tests, examples, CI, or release tooling | no release, with the reason |

```sh
bun run changeset add --patch critiqs-react -m "Fix the toolbar covering the sidebar."
bun run changeset add --minor critiqs-react -m "Add the optional onOpen property."
bun run changeset add --empty -m "Documentation only: no shipped file changes."
```

Running `bun run changeset` without options asks interactively. The summary
becomes the changelog entry, so write it for host developers: what changed for
them, and for a breaking change, how to migrate.

**Before 1.0.0** a release note may not be `major`: 1.0.0 is the owner's
decision. Under Semantic Versioning, `^0.2.0` accepts only 0.2.x, so a
breaking change is released as a `minor` note. It still needs the owner's
approval and migration instructions first; 0.x permits breaking no host app.

Several notes in one pull request are fine; the largest type wins. Do not edit
or remove another pull request's note, and do not change any `version` field
or `CHANGELOG.md` yourself.

Reviewers check that the declared type matches the diff. CI checks the form of
the note, not whether the type is right.

## What CI checks

The `release-notes` job in [CI](../.github/workflows/ci.yml) runs
`bun scripts/release.ts check` on the pull request's own commits, from the
merge base with its target branch. It fails when:

- no release note was added, or a note is malformed, has no summary, names a
  package other than `critiqs-react`, or uses a type other than patch, minor,
  or major (`major` only from 1.0.0);
- a file that ships in `critiqs-react` changed (anything under
  `packages/core`, `server`, `backend`, or `react` except tests) and the only
  notes are no-release notes;
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
`changeset version` (versions, `packages/react/CHANGELOG.md`, consumed notes)
and refreshes `bun.lock` with `bun install --lockfile-only`. It then
force-pushes that single commit to `changeset-release/main` and opens or
updates the one pull request titled "Release Critiqs: critiqs-react
_version_" from this repository's branch; a fork's pull request from a branch
with the same name is left alone.

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
that version to npm is a separate step a maintainer starts.

## Publishing to npm

The owner approved publishing `critiqs-react` publicly under the MIT license.
Nothing publishes automatically: pull requests, pushes, and the Release
workflow never do.

1. Merge the release pull request, so `main` records the version and no
   release note waits.
2. Start the [Publish workflow](../.github/workflows/publish.yml) on `main`,
   naming that version. It waits for approval in the `npm` environment, then
   runs `bun scripts/publish.ts verify --version <version>`, which refuses a
   version other than `main`'s, unversioned release notes (they would ship
   under an older version), a private or unlicensed manifest, or a version npm
   already has. It runs every check, including `check:consumers`, and then
   `npm publish --access public`.
3. Check the package page on npm, and install it in a new app.

The workflow uses npm trusted publishing: npm accepts the workflow's OpenID
Connect identity, so no npm token is stored. Before its first run, a
maintainer:

- creates the `npm` environment in the repository's settings, with required
  reviewers and `main` as its only deployment branch;
- publishes the very first version by hand, since npm can trust a workflow
  only for a package that exists: on a clean checkout of `main`, run
  `bun install --frozen-lockfile`, `bun run check`,
  `bun scripts/publish.ts verify --version <version>`, and then
  `npm publish --access public` in `packages/react` with their own npm account
  and two-factor authentication;
- adds this repository and `publish.yml`, with environment `npm`, as the
  package's trusted publisher in its npm settings, and then disallows
  token-based publishing there.

Trusted publishing adds provenance automatically when the source repository
and package are both public. This repository may remain private while the npm
package is public; npm does not support provenance for private source repositories,
so the workflow does not force `--provenance`.
See [npm's trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/).

A published version can't be replaced. To withdraw a broken one, deprecate it
(`npm deprecate critiqs-react@<version> "<reason>"`) and release a fix.

## Limits

- The repository's plan does not allow branch protection or rulesets, so a
  failing check does not block merging. Whoever merges must see every check
  pass on the pull request's latest commit.
- The check runs from the pull request's own code. Review changes to
  `scripts/release.ts`, `.changeset/config.json`, and the workflows closely.
- Workflows start only once they are on `main`: the Release and Publish
  workflows and the `workflow_dispatch` trigger for CI take effect after the
  pull request that adds them is merged.
- The workflow needs the repository's Actions setting "Allow GitHub Actions to
  create and approve pull requests". It requests only the permissions it
  needs; the default workflow token stays read-only.
- Changesets 3 documents npm, pnpm, and Yarn. With Bun, the version step runs
  the Changesets CLI under Node (22.11 or later), and Bun owns installs and
  `bun.lock`; `bun run test:release` exercises this with the real CLI.
