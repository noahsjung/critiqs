---
"critiqs-react": minor
---

Backends can now keep each person's own AI connection ("Your AI") beside a project's, and a project's owner can choose who pays for AI: the project, each person, or the project with personal AI allowed (the default, which keeps today's behavior). Critiqs-managed AI can offer several models, each costing its own number of credits, and an owner can limit which ones the project's connection uses. Backends report this with `personalAi` in their configuration; the interface for it comes in a later release, and existing projects and older components keep working unchanged.
