# Contributing to Critiqs

Thanks for helping. This page covers setup, the checks to run, release notes,
and what a pull request needs. Project direction lives in the documents
listed in the [README](README.md#project-documents); read the
[glossary](docs/glossary.md) before naming things, and build interface from
the [design system](docs/design-system.md).

Found a security problem? Don't open an issue; follow [SECURITY.md](SECURITY.md).

## Setup

Use [Bun](https://bun.sh) 1.4.2 or later; older versions rewrite `bun.lock`.
CI also uses Node.js 24, which the release tooling and consumer checks need
(Node.js 22.11 or later works). The Rails and Python packages' tests also need
Ruby 3.4 and Python 3.13, as CI uses.

```sh
git clone https://github.com/noahsjung/critiqs.git
cd critiqs
bun install
```

Use Bun for installs and scripts, and commit `bun.lock` changes with the
manifest changes that cause them. Don't add another package manager's
lockfile.

To run the pilot app against a local backend, follow
[Run the pilot locally](README.md#run-the-pilot-locally).

## Checks

Run the full check before opening a pull request:

```sh
bun run check            # build, typecheck, and test every package, the release tooling, and the packed packages
```

`bun run check` is `bun run typecheck` followed by `bun run test`. The test
step includes `check:package`, which packs `critiqs` and `critiqs-react` and
installs them in scratch React 18 and 19 apps under your system's temporary directory. If that
directory is small or held in memory, point `TMPDIR` at a directory on disk
outside the repository:

```sh
mkdir -p "$HOME/.cache/critiqs-check-tmp"
TMPDIR="$HOME/.cache/critiqs-check-tmp" bun run check
```

Two more checks run in CI:

```sh
bun run build && bun run check:consumers   # real apps of every framework, set up by critiqs init; needs the registries and Chrome
cd site-src && bun install && bun build-pages.mjs --check   # site/ matches site-src/content
```

Run `check:consumers` (with the same `TMPDIR` note) when you change a
package's build, exports, or the `critiqs init` command. To check one
framework's app, run `bun run check:consumer` in its package folder.

The package and consumer checks pack or build the packages themselves. To
check files you already packed with `bun scripts/publish.ts pack`, set
`CRITIQS_PACKED` to that folder, as the Publish workflow does so that it
publishes the files it checked:
`CRITIQS_PACKED="$PWD/.local/release" bun scripts/check-package.ts`.

## Release notes

Every pull request adds a release note in `.changeset/`, as described in
[releasing](docs/releasing.md), naming each Critiqs package the change ships
in (`critiqs`, `critiqs-react`, and the other `critiqs-*` packages; a change
to `packages/core`, `server`, or `backend` names the packages that bundle it).
All Critiqs packages ship at one shared version. Choose the type from what the
diff does to host apps:

| Change | Note |
| --- | --- |
| Backward-compatible fix to shipped behavior | `patch` |
| Backward-compatible addition, or deprecation without removal | `minor` |
| Nothing ships: documentation, tests, examples, CI, or release tooling | no release, with the reason |

```sh
bun run changeset add --patch critiqs-react -m "Fix the toolbar covering the sidebar."
bun run changeset add --minor critiqs,critiqs-react -m "Add the optional onOpen property."
bun run changeset add --empty -m "Documentation only: no shipped file changes."
```

The summary becomes the changelog entry, so write it for host developers.
Before 1.0.0 there are no `major` notes; a breaking change is a `minor` note
and needs the maintainers' agreement and migration steps first (see
[versioning and compatibility](docs/technical-direction.md#versioning-and-compatibility)).

Don't edit other notes, `version` fields, or `CHANGELOG.md`; the generated
release pull request does that. CI's `release-notes` job checks the note's
form.

### Dependabot pull requests

Dependabot opens weekly dependency updates without a release note, so their
`release-notes` check fails until a maintainer pushes one to the pull
request's branch:

- a `patch` note naming the packages the updated dependency ships in, such
  as `bun run changeset add --patch critiqs-react -m "Update convex to 1.47.0."`;
- otherwise a short no-release note, such as
  `bun run changeset add --empty -m "Dependency update for development tools only: nothing ships."`

The check treats any file under `packages/` other than tests as shipped, so
an update that changes a `package.json` there needs a `patch` note even when
only a development dependency moved.

## Pull requests

- **Small and focused.** One change per pull request. Split large work into a
  series of pull requests that each pass the checks on their own. Open an
  issue first for a large or public-interface change, so we can agree on the
  direction before you build it.
- **Tests.** Add or update tests for behavior you change, and say in the pull
  request which checks you ran and what they reported.
- **Before and after images for UI.** Any visible change needs screenshots
  (or a short video) of the interface before and after, in the pull request.
- **Compatibility.** Say whether the backend interface changed and, if it
  did, how older package versions keep working.
- **Release note.** Include the `.changeset/` note above.

A maintainer reviews every pull request. CI must pass on the latest commit
before it is merged.

## Docs and the site

| What | Where | How to update |
| --- | --- | --- |
| Project documents (direction, release process) | [`docs/`](docs) | Edit the Markdown. |
| Package READMEs shown on npm, RubyGems, and PyPI | `packages/<package>/README.md`, such as [`packages/react/README.md`](packages/react/README.md) | Edit the Markdown. |
| Public docs and blog at [critiqs.app/docs](https://critiqs.app/docs) | [`site-src/content/`](site-src/content) | Edit the Markdown, then regenerate `site/`. |
| Landing page | [`site/`](site) | Static HTML, CSS, and JavaScript; edit directly. |
| Landing page clips and stills | [`site-src/`](site-src) | Re-record them ([how](site-src/README.md)). |

Regenerate the docs and blog after editing `site-src/content/`, and commit
what it writes; `site/docs/`, `site/blog/`, and the sitemap and feeds are
generated, so don't edit them by hand:

```sh
cd site-src
bun install
bun build-pages.mjs            # write the pages
bun build-pages.mjs --check    # exit 1 if site/ is out of date (CI runs this)
```

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
Report a problem privately, as its
[enforcement section](CODE_OF_CONDUCT.md#enforcement) describes, not in a
public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT license](LICENSE).
