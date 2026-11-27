---
"critiqs-react": patch
---

For a project on a team's own backend, the setup steps now show each framework the setting its Critiqs package reads: `backend="…"` on the component for React, Vue, Svelte and Solid, the `critiqs` option in Nuxt's and Astro's config, `provideCritiqs` in Angular, `critiqs_tag(backend: …)` in Rails, `CRITIQS = {"BACKEND": …}` in Django's settings, `CRITIQS_BACKEND` in Flask's config, and `data-backend` on the script tag for stacks with no package, which had no backend step before.
