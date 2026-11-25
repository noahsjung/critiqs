---
"critiqs-react": minor
---

Coding agents can read mockups to build them in the code. The MCP server (`npx critiqs-react mcp`) adds `critiqs_mockups`, which lists a project's mockups, filtered by screen or title, with the page each was made from and its page copies' widths; and `critiqs_mockup`, which returns one version's changes to each page copy (the latest by default), each with the original element's start tag, text, and nearest `data-critiqs-id`, plus the version history, the mockup threads with Critiqs AI's replies marked, and the linked feedback threads. With `saveCopies`, it writes each copy's original HTML and the version's changes to a folder. `critiqs_thread` now marks Critiqs AI's replies with `via: "ai"`, who asked, and the version they saved. Deploy the matching backend: its mockup list now includes each page copy's ID and width. Backends that don't report `mockups` are refused with what to do instead.
