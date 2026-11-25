---
"critiqs-react": minor
---

Add the building blocks for tickets from comments: ticket types and ticket text in the core, encrypted storage for people's tracker accounts and threads' ticket links on the Convex backend, and a `tickets` list on Convex thread answers, empty until tickets can be linked. Older components ignore the new field. The component doesn't show tickets yet, the backend offers no way to connect a tracker, and the self-hosted SQLite server is unchanged.
