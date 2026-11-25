---
"critiqs-react": minor
---

Coding agents can read a project's feedback with its context. The MCP server (`npx critiqs-react mcp`) adds `critiqs_comments`, which returns threads with their whole discussions and the context to find them in the prototype and its code, filtered by status, author, time, tag, screen, or text; `critiqs_thread`, with mentions, reactions, and who last resolved or moved it; and `critiqs_screenshot`. A computer signs in once with `npx critiqs-react sign-in` (or the `critiqs_sign_in` tool), approving with a code from any device, and stays signed in for agents until `npx critiqs-react sign-out`, 30 days without use, or 90 days. Messages from the backend now include `authorId`, so feedback can be told apart by author even when two people share a name. Deploy the matching backend for code approvals that keep a computer signed in; older backends are refused with what to do instead.
