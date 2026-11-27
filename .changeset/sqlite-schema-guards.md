---
"critiqs-react": patch
---

The self-hosted server's SQLite store now exports its table ID prefixes to its own tests, which check that every migration has a schema version and every table a distinct ID prefix. Nothing changes for host apps.
