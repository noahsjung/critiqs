---
"critiqs-react": minor
"critiqs": minor
---

Privacy hardening for project setup, review links, thread links, and extension discovery:

- Hide project existence and names from signed-in outsiders on `/setup/<id>` (`onboarding:projectSetup` / `projectSetup` returns `not-found` for non-members) and `/review-links/<id>` (loads project metadata only after the owner-only review-links query succeeds).
- Move thread-page links from `/t/<key>` to `/t#<key>` so thread keys stay out of web-host request logs (legacy `/t/<key>` links continue to open and parse).
- Restrict browser extension project discovery (`findProjectsForOrigin`) to organizations the signed-in person belongs to, and stop recording opened projects from installed components and review links (keeping `recordProjectOpened` / `reviewLinks:recordOpened` as wire-compatible no-ops).
