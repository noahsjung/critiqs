---
"critiqs-react": minor
"critiqs": minor
---

Onboarding can say **Connected**. Critiqs, loading on the prototype with a project ID, tells a backend that reports `connections` in its configuration, at most once an hour per browser and before anyone signs in, by posting the project ID to `/critiqs/connected`. The backend reads at most 200 bytes, counts a report only from the project's review address or an address its list matches, and keeps the latest one, at most once every ten minutes. The extension's side panel and a developer's own computer don't count. Onboarding's setup screen and the developer's setup page wait for it, then say Connected with where and when, and the project's owners can clear it (`clearConnected`). Setup pages return it as `connected`. Deploy the matching backend. The self-hosted SQLite store adds two columns on start (schema version 19) and marks projects that already have threads connected at their first thread; on Convex, run `npx convex run onboarding:backfillConnected` once after deploying.
