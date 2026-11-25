---
"critiqs-react": minor
---

Backends now have organizations: each project belongs to one, whose admins and the project's creator manage it, and projects report their `organization` to people in it. Backends report an `organizations` capability with a list of the signed-in person's organizations. Existing projects move into their creator's own organization with the same plan and limits, so nothing changes for host apps or reviewers. Self-hosted SQLite databases migrate to schema 9 on start; after deploying the matching Convex backend, run `npx convex run organizations:backfill` once.
