---
"critiqs": minor
"critiqs-react": minor
---

A thread's linked tickets now travel with it. Mention and reply emails name each ticket under the thread's status (tracker, key, status, and address; only a web address becomes a link). A status Critiqs can no longer check reads "last known" in emails, exports, and `critiqs_thread`, as in the thread window. The Markdown export adds a "Ticket:" line per ticket to each thread's context (or "Tickets: none"), and the JSON export adds an optional `tickets` array (`tracker`, `key`, `title`, `status`, `lastKnown`, `url`) to each thread, keeping schema version 1. The `critiqs` CLI's MCP tool `critiqs_thread` adds `tickets` (key, title, status, `lastKnown`, address, who linked it and when). The backend's export pages carry `thread.tickets`, and emails read them, only where the backend has tickets; the self-hosted SQLite server is unchanged. Deploy the matching backend for emails and exports to include them.
