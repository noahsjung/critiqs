# Setup page

The developer's setup page for a project or a developer send, at `/setup/<id>`: the steps to add Critiqs and
whether it has connected.

## Sub-features

- `steps`: the install command and, for a self-hosted backend, the `backend` property to add.
- `copy`: Copy command and Copy for a coding agent.

## How to get to it (user POV)

From the link in the setup email a developer receives, or `/setup/<project ID>` on the website.

## Driving it with walk.sh

Not driven yet. To add it: after **onboarding-project-created**, take the project ID from the init command,
open `/setup/<id>` in a second context, and check the same command shows. Prove it once before listing it as
driven in the README.

## Gotchas

- Setup emails need a mail service; with none, `/critiqs/config` reports `developerEmails: false`.
