---
"critiqs-react": patch
---

The Convex backend's generated `api` types list `lib/email` again, as `convex dev` writes them. Type declarations only; nothing changes when the backend runs. A backend test now fails when that file falls behind the functions in `convex/`.
