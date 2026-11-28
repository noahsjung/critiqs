---
"critiqs-react": minor
---

Implement Atlassian's Personal Data Reporting API (`POST /app/report-accounts/`, scope `report:personal-data`) for Jira Cloud OAuth 2.0 integrations, including scheduled cycle-aware reporting, profile refresh on `updated`, and account erasure on `closed`. Deployments using Jira OAuth must enable the **Personal data reporting API** (`report:personal-data`) permission in their Atlassian Developer Console.
