---
"critiqs-react": minor
---

Add **Your trackers…** to the avatar menu, beside **Your AI…**, on backends that report `tickets` in `/critiqs/config`. Each person connects their own Linear account, through Linear's sign-in in a window served by the backend or with a pasted Linear API key, chooses whether their new tickets say they came from Critiqs (on by default), and can disconnect it. The Convex backend reports `tickets` once its operator sets `CRITIQS_AI_ENCRYPTION_KEY`, which now also encrypts tracker tokens; Linear sign-in needs `CRITIQS_LINEAR_CLIENT_ID` and `CRITIQS_LINEAR_CLIENT_SECRET`. The self-hosted SQLite server doesn't offer tickets. Creating and linking tickets come in a later release.
