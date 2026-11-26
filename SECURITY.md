# Security policy

## Supported versions

Security fixes go into the latest minor release of the Critiqs packages, such
as [`critiqs-react`](https://www.npmjs.com/package/critiqs-react); every
package shares one version. Before 1.0.0,
older minor versions are not patched: upgrade to the latest minor to receive
a fix.

| Version | Supported |
| --- | --- |
| Latest `0.x` minor | Yes |
| Older minors | No |

Critiqs Cloud always runs a backend maintained from this repository; there is
nothing for you to upgrade there.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting:

**[Report a vulnerability](https://github.com/noahsjung/critiqs/security/advisories/new)**

Do not open a public issue, pull request, or discussion for a security
problem. Include what you can of:

- the affected part (see scope below) and version or commit;
- the steps to reproduce it, or a proof of concept;
- what an attacker could do with it;
- any fix or mitigation you suggest.

The same form takes private code of conduct reports, titled "Conduct
report:"; see the [code of conduct](CODE_OF_CONDUCT.md#enforcement).

## Scope

In scope:

- **The packages:** `critiqs-react` and the other Critiqs packages as
  published on npm, RubyGems, and PyPI, including the `<Critiqs />` component
  and the `critiqs-react/server` and `critiqs/server` entry points.
- **The backend:** the Convex schema and functions, the sign-in service, and
  the self-hosted server and SQLite store (`packages/backend`,
  `packages/server`, `packages/core`).
- **The CLI:** the `critiqs` command (`critiqs init`, sign-in, setup).
- **MCP:** the stdio MCP server started with `npx critiqs-react mcp`.
- **Critiqs Cloud:** the hosted backend and sign-in service at critiqs.app.

Out of scope:

- vulnerabilities in a host app that uses Critiqs, unless Critiqs causes them;
- denial of service by volume, spam, or social engineering;
- findings from automated scanners without a demonstrated impact;
- testing against Critiqs Cloud that touches other people's data or degrades
  the service. Use your own projects, or run a local backend
  ([README](README.md#run-the-pilot-locally)).

## What to expect

- An acknowledgement within 3 business days.
- An initial assessment, with severity and next steps, within 10 business
  days.
- Updates at least every two weeks while a fix is in progress.
- A fix released as a new version of the Critiqs packages (and deployed to Critiqs
  Cloud where it applies), then a published GitHub security advisory that
  credits you unless you ask otherwise.

Please give us a reasonable time to release a fix before disclosing details
publicly. We aim to resolve confirmed issues within 90 days.

## How the packages are built

The Critiqs packages are built from this repository. The first regular
release of `critiqs-react`, 0.3.0, and the earlier `0.0.0-stage` pre-release
were published by a maintainer by hand from a checkout of `main`, as npm
requires before it can trust a workflow; so is the first version of each
other npm package. Later versions are published with the manual
[Publish workflow](.github/workflows/publish.yml), from the exact `main`
commit that records the version: one job with no publishing rights checks and
packs every package once, and the npm, RubyGems, and PyPI jobs publish those
same files, checked by sha256, using each registry's trusted publishing with
no stored token ([releasing](docs/releasing.md#publishing)). Because this
repository and the packages are public, npm attaches provenance and PyPI
attestations to those versions, linking each one to the workflow run and
commit that built it.
