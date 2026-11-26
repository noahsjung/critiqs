---
"critiqs": minor
"critiqs-react": minor
---

`npx critiqs init` sets up Critiqs in any supported framework: it finds the app's framework, adds Critiqs where the app renders, and names the framework's package to install. It updates the Critiqs the code already has, even under another name, instead of adding a second, and in a Vite app it writes the project ID to the `.env` file Vite reads first. The `critiqs` command, its MCP server, and `critiqs/server` now come from the shared `critiqs` package; `npx critiqs-react <command>`, `npx critiqs-react mcp`, and `critiqs-react/server` keep working unchanged.
