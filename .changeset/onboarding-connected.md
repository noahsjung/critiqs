---
"critiqs-react": minor
"critiqs": minor
---

Onboarding can say **Connected**. Critiqs, loading on the prototype with a project ID, tells a backend that reports `connections` in its configuration, once per browser and before anyone signs in, by posting the project ID to `/critiqs/connected`. The backend keeps the first time and the page's origin. The extension's side panel never reports. Onboarding's setup screen and the developer's setup page wait for it, then say Connected with where and when. Setup pages return it as `connected`. Deploy the matching backend. The self-hosted SQLite store adds two columns on start (schema version 19).
