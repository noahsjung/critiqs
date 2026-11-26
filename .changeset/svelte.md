---
"critiqs-svelte": minor
"critiqs": minor
---

Svelte and SvelteKit apps can add Critiqs with `critiqs-svelte`: `<Critiqs />` from `critiqs-svelte` (Svelte with Vite) or `critiqs-svelte/kit` (SvelteKit, which also names threads by route and goes back to them with `goto`) runs only in the browser, and `npx critiqs init` adds it to `src/App.svelte` or `src/routes/+layout.svelte`, reading the project ID from `VITE_CRITIQS_PROJECT_ID` or `PUBLIC_CRITIQS_PROJECT_ID`.
