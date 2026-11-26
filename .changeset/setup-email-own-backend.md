---
"critiqs-react": patch
---

A developer setup email sent from a team's own backend now says where to add that backend, in the form the project's framework package reads, as the setup page already does. Emails from Critiqs Cloud are unchanged. `HOSTED_BACKEND_URL` now lives in `@critiqs/core`; critiqs-react still exports it.
