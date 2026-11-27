---
---

Release tooling only: the release-notes check lets a pull request that only updates dependencies pass without a note when no Critiqs package ships the update, and names the packages when one does. What each package bundles comes from its real build, recorded in scripts/bundled-dependencies.json and checked by `bun run test`.
