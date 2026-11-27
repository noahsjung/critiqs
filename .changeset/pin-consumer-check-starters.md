---
---

Consumer checks only: the Nuxt check leaves out vue-router 5.5.2, which breaks the server of every Nuxt app with pages, the React consumer check pins playwright-core like the others, and the Astro check pins create-astro and its template instead of taking the latest.
