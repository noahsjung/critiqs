---
"critiqs-react": patch
---

The Convex backend can store mockups (page copies, versions, and links to existing threads) and lets Critiqs AI answer in mockup threads, saving each change as a version; `/critiqs/config` reports `mockups: true`. Nothing changes for host apps until the component uses it. Existing clients never see mockup threads: the thread list, search, export, and coding agents' feedback tools leave them out. The self-hosted SQLite server refuses mockup threads and doesn't report `mockups`. Deploy the matching backend before a component that uses Mockup mode.
