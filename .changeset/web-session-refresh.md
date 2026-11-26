---
---

No release: the change is in `apps/web`, the Critiqs website's app, a private workspace that isn't shipped in critiqs-react. Its pages (`/start`, `/setup/<id>`, `/t/<key>`) now build their Convex client with `convexClient()`, so loading a page doesn't refresh a sign-in that is still good.
