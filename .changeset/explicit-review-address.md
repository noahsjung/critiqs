---
"critiqs-react": minor
---

Mention emails now open the project's review address exactly, including its path, parameters, and hash route, instead of the page a comment was left on, so a comment left on a local or private copy no longer sends reviewers there. After sign-in, Critiqs opens the comment and restores its screen through `restoreContext`; prototypes without `restoreContext` show the comment beside its saved context. Project setup asks for the review address (optional) instead of saving the setup page by itself, and setup, `critiqs init`, `critiqs doctor`, and `/critiqs/health` now flag private addresses such as Tailscale (`.ts.net`, `100.64.0.0/10`). Existing projects keep their address; to change it, the project's owner edits it in Project setup or runs `critiqs init --review-url`. Deploy the matching backend so emails use the new links.
