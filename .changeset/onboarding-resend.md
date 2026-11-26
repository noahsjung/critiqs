---
"critiqs-react": minor
---

A project's owners can send a developer the setup steps again, 24 hours after the last email went out, at most twice. `sendDeveloperSetup` takes `resend`; each resend is a new email that counts against the person's, inbox's, and deployment's limits and respects the suppression list. Too soon or past the two resends refuses the address as a `limit` (`wait` or `resends`). `developerSends` returns `resendAt`, and backends report `developerResends`. The Critiqs website offers **Send again** once the time comes. Deploy the matching backend. The self-hosted SQLite store adds a column on start (schema version 20). Presses of Send or Send again at once now send one email on both backends: each email is claimed in the store before it goes out, so a self-hosted mail service that ignores idempotency keys no longer sends duplicates.
