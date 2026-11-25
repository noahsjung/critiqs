# Critiqs project instructions

Read the [README](README.md), [product brief](docs/brief.md),
[first-release scope](docs/first-release.md), [technical direction](docs/technical-direction.md),
and [glossary](docs/glossary.md) before changing the project.

Build interface from the [design system](docs/design-system.md): its
components, tokens, and writing rules.

Use the product glossary consistently and keep agreed behavior separate from
proposals. Project direction belongs in the documents above; keep this file
limited to durable, Critiqs-specific instructions.

Before changing the package's public interface, the backend interface, or a
release version, follow
[versioning and compatibility](docs/technical-direction.md#versioning-and-compatibility).

Every pull request adds a release note in `.changeset/`, following
[releasing](docs/releasing.md): `patch`, `minor`, or `major` for
`critiqs-react` (which bundles `packages/core`, `server`, and `backend`),
chosen from what the diff does to host apps, or a no-release note that says
why nothing ships. Do not edit other notes, `version` fields, or changelogs;
the generated release pull request does that, and a person merges it.
