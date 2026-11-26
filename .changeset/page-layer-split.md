---
"critiqs": patch
"critiqs-react": patch
---

Critiqs's interface now runs as two parts inside the package: a page layer that picks elements, draws pins, locates targets, captures the view, and calls `getContext` and `restoreContext`, and a panel with the toolbar, sidebar, threads, sign-in, and backend connection. Installed, both run in your page as before, so nothing changes in how you add or configure Critiqs or in what reviewers see. This prepares the browser extension and review links, which will run the two parts in separate documents.
